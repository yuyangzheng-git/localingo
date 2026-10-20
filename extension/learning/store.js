// Learning data: vocabulary items, encounters (real contexts), review cards, review
// events and saved sentences. Lives in IndexedDB of whatever origin runs it — the
// extension (authoritative local copy) or the hosted web app (a synced copy).
//
// Every synced record carries: id, schema_version, created_at, updated_at,
// deleted_at (null or ms), device_id, and a local-only `dirty` flag (1 = not yet
// pushed). Review events are append-only; card scheduling state is derived from
// them (see scheduler.js).

import { openDb, req, transact } from "./idb.js";
import { SCHEDULER_VERSION, localDay, newState, nextState, replay } from "./scheduler.js";
import { cleanSourceUrl, normalizeKey } from "./text.js";

export const SCHEMA_VERSION = 1;
export const SYNCED_STORES = ["items", "encounters", "cards", "events", "sentences"];
export const MAX_ENCOUNTERS = 20;
export const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const LIMITS = { headword: 120, gloss: 2000, note: 4000, sentence: 1200, tag: 40, tags: 20, url: 2000, title: 300 };

export class ValidationError extends Error {}

function str(value, max, field, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw new ValidationError(`${field} 不能为空`);
    return "";
  }
  if (typeof value !== "string") throw new ValidationError(`${field} 必须是文本`);
  const v = value.trim();
  if (v.length > max) throw new ValidationError(`${field} 过长（最多 ${max} 字符）`);
  return v;
}

function tagsOf(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ValidationError("标签格式不正确");
  const out = [...new Set(value.map((t) => str(t, LIMITS.tag, "标签")).filter(Boolean))];
  if (out.length > LIMITS.tags) throw new ValidationError(`最多 ${LIMITS.tags} 个标签`);
  return out;
}

const uuid = () => crypto.randomUUID();

export function dedupeKey(lexemeKey, pos, senseRef) {
  return `${lexemeKey}|${pos || ""}|${senseRef || ""}`;
}

export class LearningStore {
  constructor({ dbName = "localingo-learn", now = () => Date.now(), timeZone } = {}) {
    this.dbName = dbName;
    this.now = now;
    this.timeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    this._db = null;
    this._device = null;
    this.listeners = new Set();
  }

  async db() {
    if (!this._db) {
      this._db = await openDb(this.dbName, 1, (db) => {
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("dedupe", "dedupe_key");
        items.createIndex("lexeme", "lexeme_key");
        const enc = db.createObjectStore("encounters", { keyPath: "id" });
        enc.createIndex("item", "item_id");
        enc.createIndex("idem", "idempotency_key");
        const cards = db.createObjectStore("cards", { keyPath: "id" });
        cards.createIndex("item", "item_id");
        const events = db.createObjectStore("events", { keyPath: "id" });
        events.createIndex("card", "card_id");
        const sentences = db.createObjectStore("sentences", { keyPath: "id" });
        sentences.createIndex("idem", "idempotency_key");
        for (const name of SYNCED_STORES) {
          const s = name === "items" ? items : name === "encounters" ? enc : name === "cards" ? cards : name === "events" ? events : sentences;
          s.createIndex("dirty", "dirty");
        }
        db.createObjectStore("meta", { keyPath: "key" });
      });
    }
    return this._db;
  }

  /** Delete this browser's copy of the learning database (web sign-out / account switch). */
  async destroy() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
    this._device = null;
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(this.dbName);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
      r.onblocked = () => resolve();
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(what) {
    for (const fn of this.listeners) {
      try {
        fn(what);
      } catch {
        // listener errors don't affect writes
      }
    }
  }

  async deviceId() {
    if (this._device) return this._device;
    const db = await this.db();
    this._device = await transact(db, "meta", "readwrite", async ({ meta }) => {
      const row = await req(meta.get("device"));
      if (row) return row.value;
      const id = uuid();
      meta.put({ key: "device", value: id });
      return id;
    });
    return this._device;
  }

  async getMeta(key) {
    const db = await this.db();
    const row = await transact(db, "meta", "readonly", ({ meta }) => req(meta.get(key)));
    return row ? row.value : undefined;
  }

  async setMeta(key, value) {
    const db = await this.db();
    await transact(db, "meta", "readwrite", ({ meta }) => {
      meta.put({ key, value });
    });
  }

  /** Stamp a record for writing: bump updated_at monotonically and mark dirty. */
  _stamp(record, device, prev) {
    const now = this.now();
    const updated = prev && prev.updated_at >= now ? prev.updated_at + 1 : now;
    return { schema_version: SCHEMA_VERSION, deleted_at: null, ...record, updated_at: updated, device_id: device, dirty: 1 };
  }

  // --- saving ---------------------------------------------------------------

  /**
   * Save a looked-up word/phrase with its chosen sense and context.
   * payload: { idempotency_key, headword, lexeme_key?, kind, sense: {id, pos, definition_en, gloss_zh},
   *            meaning_source?, source: {id, version}, context?: {surface, sentence, before, after, url, title},
   *            tags?, note? }
   * Returns { item_id, result: "created" | "updated" | "already_exists" }.
   */
  async saveItem(payload) {
    const idem = str(payload.idempotency_key, 100, "idempotency_key", { required: true });
    const headword = str(payload.headword, LIMITS.headword, "词头", { required: true });
    const lexemeKey = normalizeKey(payload.lexeme_key || headword);
    const kind = payload.kind === "phrase" ? "phrase" : "word";
    const sense = payload.sense || {};
    const pos = str(sense.pos, 12, "词性");
    const senseRef = str(sense.id, 200, "词义标识");
    const definitionEn = str(sense.definition_en, LIMITS.gloss, "英文释义");
    const glossZh = str(sense.gloss_zh, LIMITS.gloss, "中文释义");
    const meaningSource = ["dictionary", "user", "ai"].includes(payload.meaning_source) ? payload.meaning_source : senseRef ? "dictionary" : "user";
    if (!definitionEn && !glossZh) throw new ValidationError("需要至少一个释义");
    const ctx = payload.context || {};
    const context = {
      surface: str(ctx.surface, LIMITS.headword, "原词形"),
      sentence: str(ctx.sentence, LIMITS.sentence, "原句"),
      before: str(ctx.before, 200, "前文"),
      after: str(ctx.after, 200, "后文"),
      url: cleanSourceUrl(str(ctx.url, LIMITS.url, "来源链接"), { keepQuery: !!ctx.keep_query }),
      title: str(ctx.title, LIMITS.title, "来源标题"),
    };
    const tags = tagsOf(payload.tags);
    const note = str(payload.note, LIMITS.note, "笔记");
    const dedupe = dedupeKey(lexemeKey, pos, senseRef || `custom:${glossZh || definitionEn}`);

    const device = await this.deviceId();
    const db = await this.db();
    const now = this.now();
    const result = await transact(db, ["items", "encounters", "cards"], "readwrite", async ({ items, encounters, cards }) => {
      const prior = await req(encounters.index("idem").get(idem));
      if (prior) return { item_id: prior.item_id, encounter_id: prior.id, result: "already_exists" };

      const candidates = await req(items.index("dedupe").getAll(dedupe));
      let item = candidates.find((i) => !i.deleted_at) || null;
      let result = "updated";
      let encounterId = null;
      if (!item) {
        result = "created";
        item = this._stamp(
          {
            id: uuid(),
            lexeme_key: lexemeKey,
            headword,
            kind,
            pos,
            sense_ref: senseRef || null,
            dedupe_key: dedupe,
            meaning: { definition_en: definitionEn || null, gloss_zh: glossZh || null },
            meaning_source: meaningSource,
            user_confirmed: true,
            source_id: payload.source?.id || null,
            source_version: payload.source?.version || null,
            user_gloss: null,
            note,
            tags,
            status: "learning",
            created_at: now,
          },
          device,
        );
        items.put(item);
        cards.put(
          this._stamp(
            {
              id: uuid(),
              item_id: item.id,
              type: "context-meaning",
              scheduler_version: SCHEDULER_VERSION,
              answer: { pos, definition_en: definitionEn || null, gloss_zh: glossZh || null },
              state: newState(),
              created_at: now,
            },
            device,
          ),
        );
      } else if (tags.length || note) {
        const merged = { ...item, tags: [...new Set([...(item.tags || []), ...tags])], note: item.note || note };
        items.put(this._stamp(merged, device, item));
      }

      if (context.sentence || context.url) {
        const existing = (await req(encounters.index("item").getAll(item.id))).filter((e) => !e.deleted_at);
        const same = existing.find((e) => e.sentence === context.sentence && e.source_url === context.url);
        if (same) {
          // Same sentence on the same page: refresh, don't pile up.
          encounters.put(this._stamp({ ...same, seen_at: now, idempotency_key: idem }, device, same));
          encounterId = same.id;
          if (result === "updated") result = "already_exists";
        } else {
          encounterId = uuid();
          encounters.put(
            this._stamp(
              {
                id: encounterId,
                item_id: item.id,
                idempotency_key: idem,
                surface_form: context.surface || headword,
                sentence: context.sentence || null,
                quote_anchor: { before: context.before, after: context.after },
                source_url: context.url || null,
                source_title: context.title || null,
                seen_at: now,
                created_at: now,
              },
              device,
            ),
          );
          // Keep the most recent MAX_ENCOUNTERS distinct contexts.
          const extra = existing.sort((a, b) => b.seen_at - a.seen_at).slice(MAX_ENCOUNTERS - 1);
          for (const e of extra) encounters.put(this._stamp({ ...e, deleted_at: now }, device, e));
        }
      } else {
        // No context (standalone lookup): still record the idempotency key.
        encounterId = uuid();
        encounters.put(
          this._stamp(
            {
              id: encounterId,
              item_id: item.id,
              idempotency_key: idem,
              surface_form: context.surface || headword,
              sentence: null,
              quote_anchor: null,
              source_url: null,
              source_title: null,
              seen_at: now,
              created_at: now,
            },
            device,
          ),
        );
      }
      return { item_id: item.id, encounter_id: encounterId, result };
    });
    this._emit("items");
    return result;
  }

  async saveSentence(payload) {
    const idem = str(payload.idempotency_key, 100, "idempotency_key", { required: true });
    const text = str(payload.text, LIMITS.sentence, "句子", { required: true });
    const device = await this.deviceId();
    const db = await this.db();
    const now = this.now();
    const out = await transact(db, "sentences", "readwrite", async ({ sentences }) => {
      const prior = await req(sentences.index("idem").get(idem));
      if (prior) return { sentence_id: prior.id, result: "already_exists" };
      const url = cleanSourceUrl(str(payload.url, LIMITS.url, "来源链接"));
      const all = await req(sentences.getAll());
      const dup = all.find((s) => !s.deleted_at && s.text === text && s.source_url === (url || null));
      if (dup) return { sentence_id: dup.id, result: "already_exists" };
      const record = this._stamp(
        {
          id: uuid(),
          idempotency_key: idem,
          text,
          note: str(payload.note, LIMITS.note, "笔记"),
          tags: tagsOf(payload.tags),
          source_url: url || null,
          source_title: str(payload.title, LIMITS.title, "来源标题") || null,
          created_at: now,
        },
        device,
      );
      sentences.put(record);
      return { sentence_id: record.id, result: "created" };
    });
    this._emit("sentences");
    return out;
  }

  // --- reading --------------------------------------------------------------

  async _all(storeName) {
    const db = await this.db();
    return transact(db, storeName, "readonly", (s) => req(s[storeName].getAll()));
  }

  /** Saved (non-deleted) items for the given lexeme keys, with encounter counts. */
  async itemsForLexemes(keys) {
    const db = await this.db();
    return transact(db, ["items", "encounters"], "readonly", async ({ items, encounters }) => {
      const out = [];
      for (const k of keys) {
        for (const item of await req(items.index("lexeme").getAll(k))) {
          if (item.deleted_at) continue;
          const encs = (await req(encounters.index("item").getAll(item.id))).filter((e) => !e.deleted_at && e.sentence);
          out.push({ ...publicItem(item), encounter_count: encs.length, last_sentence: latest(encs)?.sentence || null });
        }
      }
      return out;
    });
  }

  async getItem(id) {
    const db = await this.db();
    return transact(db, ["items", "encounters", "cards", "events"], "readonly", async ({ items, encounters, cards, events }) => {
      const item = await req(items.get(id));
      if (!item) return null;
      const encs = (await req(encounters.index("item").getAll(id))).filter((e) => !e.deleted_at).sort((a, b) => b.seen_at - a.seen_at);
      const card = (await req(cards.index("item").getAll(id))).find((c) => !c.deleted_at) || null;
      const evs = card ? (await req(events.index("card").getAll(card.id))).filter((e) => !e.deleted_at) : [];
      return { item: publicItem(item), encounters: encs.map(publicRecord), card: card ? publicRecord(card) : null, review_count: evs.length };
    });
  }

  /**
   * List items. filter: { q, status, tag, site, due, trash, sort, offset, limit }.
   * Returns { items: [...], total, next_offset }.
   */
  async listItems(filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    const offset = Math.max(Number(filter.offset) || 0, 0);
    const now = this.now();
    const [items, encounters, cards] = await Promise.all([this._all("items"), this._all("encounters"), this._all("cards")]);
    const encByItem = new Map();
    for (const e of encounters) {
      if (e.deleted_at) continue;
      if (!encByItem.has(e.item_id)) encByItem.set(e.item_id, []);
      encByItem.get(e.item_id).push(e);
    }
    const cardByItem = new Map(cards.filter((c) => !c.deleted_at).map((c) => [c.item_id, c]));
    const q = normalizeKey(filter.q || "");
    let rows = items.filter((i) => (filter.trash ? i.deleted_at && !i.purged : !i.deleted_at));
    if (filter.trash) rows = rows.filter((i) => now - i.deleted_at < TRASH_DAYS * DAY);
    if (filter.status) rows = rows.filter((i) => i.status === filter.status);
    if (filter.tag) rows = rows.filter((i) => (i.tags || []).includes(filter.tag));
    if (filter.site) rows = rows.filter((i) => (encByItem.get(i.id) || []).some((e) => hostOf(e.source_url) === filter.site));
    if (filter.due) {
      rows = rows.filter((i) => {
        const c = cardByItem.get(i.id);
        return c && i.status !== "paused" && c.state.stage !== "new" && c.state.due_at <= now;
      });
    }
    if (q) {
      rows = rows.filter((i) => {
        const hay = [i.headword, i.meaning?.definition_en, i.meaning?.gloss_zh, i.user_gloss, i.note, ...(i.tags || [])]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    const sort = filter.sort || "recent";
    if (sort === "alpha") rows.sort((a, b) => a.headword.localeCompare(b.headword));
    else if (sort === "due") rows.sort((a, b) => (cardByItem.get(a.id)?.state.due_at ?? Infinity) - (cardByItem.get(b.id)?.state.due_at ?? Infinity));
    else rows.sort((a, b) => b.created_at - a.created_at);
    const page = rows.slice(offset, offset + limit).map((i) => {
      const encs = encByItem.get(i.id) || [];
      const card = cardByItem.get(i.id);
      return {
        ...publicItem(i),
        encounter_count: encs.length,
        last_encounter: latest(encs) ? publicRecord(latest(encs)) : null,
        card_state: card ? card.state : null,
      };
    });
    return { items: page, total: rows.length, next_offset: offset + limit < rows.length ? offset + limit : null };
  }

  async listSentences(filter = {}) {
    const q = (filter.q || "").toLowerCase();
    const now = this.now();
    let rows = (await this._all("sentences")).filter((s) => (filter.trash ? s.deleted_at && !s.purged && now - s.deleted_at < TRASH_DAYS * DAY : !s.deleted_at));
    if (q) rows = rows.filter((s) => `${s.text}\n${s.note}\n${(s.tags || []).join(" ")}`.toLowerCase().includes(q));
    rows.sort((a, b) => b.created_at - a.created_at);
    return { sentences: rows.map(publicRecord), total: rows.length };
  }

  /** Tags and source sites in use, for filters. */
  async facets() {
    const [items, encounters] = await Promise.all([this._all("items"), this._all("encounters")]);
    const live = items.filter((i) => !i.deleted_at);
    const liveIds = new Set(live.map((i) => i.id));
    const tags = new Map();
    for (const i of live) for (const t of i.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
    const sites = new Map();
    for (const e of encounters) {
      if (e.deleted_at || !liveIds.has(e.item_id)) continue;
      const h = hostOf(e.source_url);
      if (h) sites.set(h, (sites.get(h) || 0) + 1);
    }
    return { tags: [...tags].sort((a, b) => b[1] - a[1]), sites: [...sites].sort((a, b) => b[1] - a[1]) };
  }

  /** Items saved from one page (side panel "本页"). */
  async itemsForPage(url) {
    const clean = cleanSourceUrl(url);
    if (!clean) return [];
    const [items, encounters] = await Promise.all([this._all("items"), this._all("encounters")]);
    const ids = new Set(encounters.filter((e) => !e.deleted_at && e.source_url === clean).map((e) => e.item_id));
    return items.filter((i) => !i.deleted_at && ids.has(i.id)).map(publicItem);
  }

  // --- editing --------------------------------------------------------------

  async updateItem(id, patch) {
    const device = await this.deviceId();
    const db = await this.db();
    const clean = {};
    if ("note" in patch) clean.note = str(patch.note, LIMITS.note, "笔记");
    if ("tags" in patch) clean.tags = tagsOf(patch.tags);
    if ("status" in patch) {
      if (!["learning", "familiar", "paused"].includes(patch.status)) throw new ValidationError("未知的学习状态");
      clean.status = patch.status;
    }
    if ("user_gloss" in patch) clean.user_gloss = str(patch.user_gloss, LIMITS.gloss, "个人释义") || null;
    const out = await transact(db, ["items", "cards"], "readwrite", async ({ items, cards }) => {
      const item = await req(items.get(id));
      if (!item || item.deleted_at) throw new ValidationError("条目不存在或已删除");
      const next = this._stamp({ ...item, ...clean }, device, item);
      items.put(next);
      if ("user_gloss" in clean) {
        // The review answer follows the learner's own wording; the dictionary sense stays in `meaning`.
        for (const card of await req(cards.index("item").getAll(id))) {
          if (card.deleted_at) continue;
          cards.put(this._stamp({ ...card, answer: { ...card.answer, user_gloss: clean.user_gloss } }, device, card));
        }
      }
      return publicItem(next);
    });
    this._emit("items");
    return out;
  }

  /** Soft delete into the 30-day trash (item, its cards and encounters stay recoverable). */
  async deleteItem(id) {
    await this._setDeleted("items", id, true);
  }

  async restoreItem(id) {
    await this._setDeleted("items", id, false);
  }

  async deleteSentence(id) {
    await this._setDeleted("sentences", id, true);
  }

  async restoreSentence(id) {
    await this._setDeleted("sentences", id, false);
  }

  async updateSentence(id, patch) {
    const device = await this.deviceId();
    const db = await this.db();
    await transact(db, "sentences", "readwrite", async ({ sentences }) => {
      const s = await req(sentences.get(id));
      if (!s || s.deleted_at) throw new ValidationError("句子不存在或已删除");
      const next = { ...s };
      if ("note" in patch) next.note = str(patch.note, LIMITS.note, "笔记");
      if ("tags" in patch) next.tags = tagsOf(patch.tags);
      sentences.put(this._stamp(next, device, s));
    });
    this._emit("sentences");
  }

  async deleteEncounter(id) {
    const device = await this.deviceId();
    const db = await this.db();
    await transact(db, "encounters", "readwrite", async ({ encounters }) => {
      const e = await req(encounters.get(id));
      if (e && !e.deleted_at) encounters.put(this._stamp({ ...e, deleted_at: this.now() }, device, e));
    });
    this._emit("items");
  }

  async _setDeleted(storeName, id, deleted) {
    const device = await this.deviceId();
    const db = await this.db();
    const now = this.now();
    const stores = storeName === "items" ? ["items", "cards"] : [storeName];
    await transact(db, stores, "readwrite", async (s) => {
      const rec = await req(s[storeName].get(id));
      if (!rec || rec.purged) throw new ValidationError("记录不存在");
      if (!deleted && rec.deleted_at && now - rec.deleted_at >= TRASH_DAYS * DAY) throw new ValidationError("已超过 30 天，无法恢复");
      if (!deleted && !rec.deleted_at) return;
      if (!deleted && storeName === "items") {
        // A live item with the same sense may have been created meanwhile.
        const twins = await req(s.items.index("dedupe").getAll(rec.dedupe_key));
        if (twins.some((t) => t.id !== id && !t.deleted_at)) throw new ValidationError("生词本里已有相同词义的条目，无法恢复");
      }
      s[storeName].put(this._stamp({ ...rec, deleted_at: deleted ? now : null }, device, rec));
      if (storeName === "items") {
        for (const card of await req(s.cards.index("item").getAll(id))) {
          s.cards.put(this._stamp({ ...card, deleted_at: deleted ? now : null }, device, card));
        }
      }
    });
    this._emit(storeName);
  }

  /** Permanently clear trash entries (all, or older than TRASH_DAYS when `expiredOnly`). */
  async purgeTrash({ expiredOnly = false, ids = null } = {}) {
    const device = await this.deviceId();
    const db = await this.db();
    const now = this.now();
    let count = 0;
    await transact(db, ["items", "encounters", "cards", "events", "sentences"], "readwrite", async (s) => {
      for (const storeName of ["items", "sentences"]) {
        for (const rec of await req(s[storeName].getAll())) {
          if (!rec.deleted_at || rec.purged) continue;
          if (ids && !ids.includes(rec.id)) continue;
          if (expiredOnly && now - rec.deleted_at < TRASH_DAYS * DAY) continue;
          count++;
          // Keep a content-free tombstone so other devices learn about the deletion.
          s[storeName].put(this._stamp(tombstone(rec, now), device, rec));
          if (storeName !== "items") continue;
          for (const e of await req(s.encounters.index("item").getAll(rec.id))) s.encounters.put(this._stamp(tombstone(e, now), device, e));
          for (const c of await req(s.cards.index("item").getAll(rec.id))) {
            for (const ev of await req(s.events.index("card").getAll(c.id))) s.events.put(this._stamp(tombstone(ev, now), device, ev));
            s.cards.put(this._stamp(tombstone(c, now), device, c));
          }
        }
      }
    });
    if (count) this._emit("items");
    return count;
  }

  // --- review ---------------------------------------------------------------

  async _reviewData() {
    const [items, cards, events, encounters] = await Promise.all([this._all("items"), this._all("cards"), this._all("events"), this._all("encounters")]);
    const itemById = new Map(items.filter((i) => !i.deleted_at).map((i) => [i.id, i]));
    const liveCards = cards.filter((c) => !c.deleted_at && itemById.has(c.item_id) && itemById.get(c.item_id).status !== "paused");
    return { itemById, liveCards, events: events.filter((e) => !e.deleted_at), encounters };
  }

  _newIntroducedToday(events, now) {
    const today = localDay(now, this.timeZone);
    return new Set(events.filter((e) => e.prior_stage === "new" && localDay(e.rated_at, this.timeZone) === today).map((e) => e.card_id)).size;
  }

  /** Counts for badges: due reviews, new cards available today, totals. */
  async reviewSummary({ dailyNew = 5 } = {}) {
    const now = this.now();
    const { liveCards, events } = await this._reviewData();
    const due = liveCards.filter((c) => c.state.stage !== "new" && c.state.due_at <= now).length;
    const newCards = liveCards.filter((c) => c.state.stage === "new").length;
    const newLeft = Math.max(0, dailyNew - this._newIntroducedToday(events, now));
    const nextDue = liveCards.filter((c) => c.state.stage !== "new" && c.state.due_at > now).reduce((m, c) => Math.min(m, c.state.due_at), Infinity);
    return { due, new_available: Math.min(newCards, newLeft), new_total: newCards, today_total: due + Math.min(newCards, newLeft), next_due_at: Number.isFinite(nextDue) ? nextDue : null };
  }

  /**
   * Next card for a review session, or null when the session is done.
   * Due cards first (earliest first), then new cards within the daily limit.
   */
  async nextCard({ sessionId, dailyNew = 5, sessionMax = 20, exclude = [] } = {}) {
    const now = this.now();
    const { itemById, liveCards, events, encounters } = await this._reviewData();
    const ratedThisSession = events.filter((e) => e.session_id === sessionId).length;
    if (ratedThisSession >= sessionMax) return { card: null, reason: "session-limit", rated: ratedThisSession };
    const skip = new Set(exclude);
    const due = liveCards
      .filter((c) => c.state.stage !== "new" && c.state.due_at <= now && !skip.has(c.id))
      .sort((a, b) => a.state.due_at - b.state.due_at);
    let card = due[0];
    if (!card && this._newIntroducedToday(events, now) < dailyNew) {
      card = liveCards.filter((c) => c.state.stage === "new" && !skip.has(c.id)).sort((a, b) => a.created_at - b.created_at)[0];
    }
    if (!card) return { card: null, reason: "done", rated: ratedThisSession };
    const item = itemById.get(card.item_id);
    const encs = encounters.filter((e) => e.item_id === item.id && !e.deleted_at && e.sentence).sort((a, b) => b.seen_at - a.seen_at);
    return {
      card: publicRecord(card),
      item: publicItem(item),
      encounter: encs[0] ? publicRecord(encs[0]) : null,
      rated: ratedThisSession,
    };
  }

  /**
   * Record a rating. Idempotent on event_id: a double click or resend writes one
   * event and advances the schedule once.
   * payload: { event_id, card_id, session_id, rating, shown_at, revealed_at, typed_answer, hint_used }
   */
  async rate(payload) {
    const eventId = str(payload.event_id, 100, "event_id", { required: true });
    const rating = Number(payload.rating);
    if (![1, 2, 3, 4].includes(rating)) throw new ValidationError("评分无效");
    if (!payload.revealed_at) throw new ValidationError("请先显示答案再评分");
    const device = await this.deviceId();
    const db = await this.db();
    const now = this.now();
    const out = await transact(db, ["cards", "events"], "readwrite", async ({ cards, events }) => {
      const existing = await req(events.get(eventId));
      if (existing) {
        const card = await req(cards.get(existing.card_id));
        return { duplicate: true, state: card?.state || null };
      }
      const card = await req(cards.get(payload.card_id));
      if (!card || card.deleted_at) throw new ValidationError("卡片不存在或已删除");
      const prior = card.state || newState();
      const state = nextState(prior, rating, now);
      events.put(
        this._stamp(
          {
            id: eventId,
            card_id: card.id,
            session_id: str(payload.session_id, 100, "session_id") || null,
            rating,
            shown_at: Number(payload.shown_at) || null,
            revealed_at: Number(payload.revealed_at) || null,
            rated_at: now,
            typed_answer: !!payload.typed_answer,
            hint_used: !!payload.hint_used,
            prior_stage: prior.stage,
            prior_level: prior.level,
            next_stage: state.stage,
            next_level: state.level,
            next_due_at: state.due_at,
            scheduler_version: SCHEDULER_VERSION,
            created_at: now,
          },
          device,
        ),
      );
      cards.put(this._stamp({ ...card, state }, device, card));
      return { duplicate: false, state };
    });
    this._emit("review");
    return out;
  }

  /** Recompute card states from their events (after sync or import merged events). */
  async recomputeCards(cardIds) {
    if (!cardIds.length) return;
    const db = await this.db();
    await transact(db, ["cards", "events"], "readwrite", async ({ cards, events }) => {
      for (const id of new Set(cardIds)) {
        const card = await req(cards.get(id));
        if (!card) continue;
        const evs = await req(events.index("card").getAll(id));
        const state = replay(evs);
        if (JSON.stringify(state) !== JSON.stringify(card.state)) {
          // Derived field: not marked dirty, every device derives the same value.
          cards.put({ ...card, state });
        }
      }
    });
  }

  // --- sync & backup ----------------------------------------------------------

  /** Records not yet pushed, up to `limit` in total. */
  async dirtyRecords(limit = 500) {
    const db = await this.db();
    return transact(db, SYNCED_STORES, "readonly", async (s) => {
      const out = {};
      let left = limit;
      for (const name of SYNCED_STORES) {
        if (left <= 0) break;
        const rows = await req(s[name].index("dirty").getAll(1, left));
        if (rows.length) out[name] = rows;
        left -= rows.length;
      }
      return out;
    });
  }

  /** Clear the dirty flag of pushed records that haven't changed since. */
  async markPushed(pushed) {
    const db = await this.db();
    await transact(db, SYNCED_STORES, "readwrite", async (s) => {
      for (const [name, rows] of Object.entries(pushed)) {
        for (const r of rows) {
          const cur = await req(s[name].get(r.id));
          if (cur && cur.updated_at === r.updated_at && cur.dirty) s[name].put({ ...cur, dirty: 0 });
        }
      }
    });
  }

  /**
   * Merge records from the server or a backup. Last writer wins on updated_at
   * (ties broken by device id); events are immutable apart from tombstoning.
   * Returns counts per store.
   */
  async mergeRecords(changes, { markDirty = false } = {}) {
    const db = await this.db();
    const touchedCards = [];
    const counts = {};
    await transact(db, SYNCED_STORES, "readwrite", async (s) => {
      for (const name of SYNCED_STORES) {
        const rows = changes[name] || [];
        let n = 0;
        for (const incoming of rows) {
          if (!incoming || typeof incoming.id !== "string" || typeof incoming.updated_at !== "number") continue;
          const cur = await req(s[name].get(incoming.id));
          if (cur && !newer(incoming, cur)) continue;
          const record = { ...incoming, dirty: markDirty ? 1 : 0 };
          if (name === "cards" && cur) record.state = cur.state; // derived locally below
          s[name].put(record);
          n++;
          if (name === "events") touchedCards.push(incoming.card_id);
          if (name === "cards") touchedCards.push(incoming.id);
        }
        counts[name] = n;
      }
    });
    await this.recomputeCards(touchedCards);
    if (Object.values(counts).some(Boolean)) this._emit("sync");
    return counts;
  }

  /** Full JSON backup (no tokens, no dictionary). */
  async exportBackup() {
    const out = { format: "localingo-backup", schema_version: SCHEMA_VERSION, exported_at: new Date(this.now()).toISOString() };
    for (const name of SYNCED_STORES) out[name] = (await this._all(name)).map(({ dirty, ...r }) => r);
    return out;
  }

  /** Validate a backup and report what an import would do, without writing. */
  async previewBackup(data) {
    validateBackup(data);
    const summary = {};
    for (const name of SYNCED_STORES) {
      const existing = new Map((await this._all(name)).map((r) => [r.id, r]));
      let added = 0;
      let updated = 0;
      let unchanged = 0;
      for (const r of data[name] || []) {
        const cur = existing.get(r.id);
        if (!cur) added++;
        else if (newer(r, cur)) updated++;
        else unchanged++;
      }
      summary[name] = { added, updated, unchanged };
    }
    return summary;
  }

  async importBackup(data) {
    validateBackup(data);
    return this.mergeRecords(data, { markDirty: true });
  }
}

function newer(a, b) {
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at;
  return String(a.device_id || "") > String(b.device_id || "");
}

function tombstone(rec, now) {
  const keep = ["id", "schema_version", "created_at", "item_id", "card_id", "dedupe_key", "lexeme_key"];
  const out = Object.fromEntries(keep.filter((k) => k in rec).map((k) => [k, rec[k]]));
  return { ...out, deleted_at: rec.deleted_at || now, purged: true };
}

function validateBackup(data) {
  if (!data || typeof data !== "object" || data.format !== "localingo-backup") throw new ValidationError("不是 LocaLingo 备份文件");
  if (data.schema_version !== SCHEMA_VERSION) throw new ValidationError(`备份版本 ${data.schema_version} 不受支持`);
  for (const name of SYNCED_STORES) {
    if (data[name] != null && !Array.isArray(data[name])) throw new ValidationError(`备份中的 ${name} 格式不正确`);
    for (const r of data[name] || []) {
      if (!r || typeof r.id !== "string" || typeof r.updated_at !== "number") throw new ValidationError(`备份中的 ${name} 记录缺少 id 或时间`);
    }
  }
}

function latest(encs) {
  return encs.reduce((best, e) => (!best || e.seen_at > best.seen_at ? e : best), null);
}

function hostOf(url) {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

function publicRecord(r) {
  const { dirty, ...rest } = r;
  return rest;
}

function publicItem(i) {
  return publicRecord(i);
}
