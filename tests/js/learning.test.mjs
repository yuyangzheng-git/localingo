// Core learning modules: text helpers, dictionary lookup/import, store, scheduler,
// backup and export. Run: node --test tests/js/
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { lookup, sensesOf } from "../../extension/learning/dict.js";
import { IdbDictionary, importPackage, removeDictionary } from "../../extension/learning/dict-idb.js";
import { ankiTsv } from "../../extension/learning/export.js";
import { LEVEL_DAYS, nextState, newState, replay } from "../../extension/learning/scheduler.js";
import { LearningStore, MAX_ENCOUNTERS, ValidationError } from "../../extension/learning/store.js";
import { classifySelection, cleanSourceUrl, guessLemmas, sentenceAround } from "../../extension/learning/text.js";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

// --- fixtures -----------------------------------------------------------------

const ENTRIES = [
  { k: "study", w: "study", ph: "'stʌdi", en: [["n", "applying the mind to learning"], ["v", "consider in detail"]], zh: [["n", "学习, 研究"], ["vt", "学习, 研究"]], x: { s: "studies", d: "studied" }, tags: ["zk"] },
  { k: "studies", w: "studies", en: [["n", "a detailed critical inspection"]], zh: [["n", "研究（study的复数）"]], lemma: [["study", "s3"]] },
  { k: "saw", w: "saw", en: [["n", "hand tool having a toothed blade"], ["v", "cut with a saw"]], zh: [["n", "锯子"], ["", "see的过去式"]], lemma: [["see", "p"]] },
  { k: "see", w: "see", en: [["v", "perceive by sight"]], zh: [["vt", "看见"]], x: { p: "saw", d: "seen" } },
  { k: "bank", w: "bank", en: [["n", "sloping land beside water"], ["n", "a financial institution"]], zh: [["n", "银行, 堤, 岸"]] },
  { k: "account", w: "account", en: [["n", "a statement of transactions"]], zh: [["n", "账户"]], x: { d: "accounted", p: "accounted", 3: "accounts" } },
  { k: "account for", w: "account for", zh: [["", "解释……的原因；占"]] },
  { k: "take", w: "take", en: [["v", "carry out"]], zh: [["vt", "拿"]], x: { p: "took", d: "taken" } },
  { k: "take into account", w: "take into account", zh: [["", "考虑"]] },
  { k: "ai", w: "ai", en: [["n", "a three-toed sloth"]], zh: [["n", "三趾树懒"]] },
  { k: "ai", w: "AI", zh: [["", "[计] 人工智能"]] },
];
const FORMS = [
  { k: "accounted", of: [["account", "d"], ["account", "p"]] },
  { k: "accounts", of: [["account", "3"]] },
  { k: "took", of: [["take", "p"]] },
];
const MANIFEST = { type: "package", schema_version: 1, package_id: "ecdict-test", source_id: "ecdict", source_version: "abc123", license: "MIT", license_text: "MIT…", entries: ENTRIES.length, forms: FORMS.length };

function packageBuffer(manifest = MANIFEST, entries = ENTRIES, forms = FORMS) {
  const lines = [manifest, ...entries.map((e) => ({ type: "entry", ...e })), ...forms.map((f) => ({ type: "form", ...f }))];
  const gz = gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n")));
  return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
}

function memorySource(info = MANIFEST) {
  const byKey = new Map();
  for (const e of ENTRIES) byKey.set(e.k, [...(byKey.get(e.k) || []), e]);
  const forms = new Map(FORMS.map((f) => [f.k, f]));
  return {
    info: async () => info,
    getEntries: async (keys) => new Map(keys.filter((k) => byKey.has(k)).map((k) => [k, byKey.get(k)])),
    getForms: async (keys) => new Map(keys.filter((k) => forms.has(k)).map((k) => [k, forms.get(k)])),
  };
}

let dbCounter = 0;
function freshStore(clock = { t: Date.UTC(2026, 9, 20, 1, 0, 0) }) {
  const store = new LearningStore({ dbName: `test-learn-${++dbCounter}`, now: () => clock.t, timeZone: "Australia/Sydney" });
  return { store, clock };
}

const savePayload = (over = {}) => ({
  idempotency_key: `k-${Math.random()}`,
  headword: "bank",
  kind: "word",
  sense: { id: "ecdict:bank:en1", pos: "n", definition_en: "a financial institution", gloss_zh: "银行, 堤, 岸" },
  source: { id: "ecdict", version: "abc123" },
  context: { surface: "banks", sentence: "Banks raised rates again.", url: "https://news.example/a?token=secret#p2", title: "News" },
  ...over,
});

// --- text ---------------------------------------------------------------------

test("classifySelection distinguishes words, phrases, sentences and non-English", () => {
  assert.equal(classifySelection("  “studies,” ").kind, "word");
  assert.equal(classifySelection("studies").text, "studies");
  assert.equal(classifySelection("take into account").kind, "phrase");
  assert.equal(classifySelection("The report accounts for the gap.").kind, "sentence");
  assert.equal(classifySelection("一个中文词").kind, "chinese");
  assert.equal(classifySelection("getElementById").kind, "code");
  assert.equal(classifySelection("https://example.com/x").kind, "code");
  assert.equal(classifySelection("user@example.com").kind, "code");
  assert.equal(classifySelection("   ").kind, "empty");
  assert.equal(classifySelection("a".repeat(301)).kind, "too-long");
});

test("guessLemmas proposes base forms without claiming one", () => {
  assert.ok(guessLemmas("carried").includes("carry"));
  assert.ok(guessLemmas("running").includes("run"));
  assert.ok(guessLemmas("making").includes("make"));
  assert.ok(guessLemmas("boxes").includes("box"));
});

test("sentenceAround returns the sentence containing the selection", () => {
  const text = "First sentence here. The report accounts for the gap. Last one.";
  const start = text.indexOf("accounts");
  const r = sentenceAround(text, start, start + 8);
  assert.equal(r.sentence, "The report accounts for the gap.");
  assert.match(r.before, /First sentence here\.$/);
  assert.match(r.after, /^Last one\./);
});

test("cleanSourceUrl drops query, fragment and credentials", () => {
  assert.equal(cleanSourceUrl("https://u:p@news.example/a?token=secret#p2"), "https://news.example/a");
  assert.equal(cleanSourceUrl("https://news.example/a?id=3", { keepQuery: true }), "https://news.example/a?id=3");
  assert.equal(cleanSourceUrl("javascript:alert(1)"), "");
});

// --- dictionary -----------------------------------------------------------------

test("lookup: recorded base forms are candidates, not replacements (studies, saw)", async () => {
  const src = memorySource();
  const studies = await lookup("studies", src);
  assert.equal(studies.status, "ok");
  assert.deepEqual(studies.results.map((r) => [r.entry.w, r.relation]), [["studies", "exact"], ["study", "lemma"]]);
  const saw = await lookup("saw", src);
  assert.deepEqual(saw.results.map((r) => [r.entry.w, r.relation]), [["saw", "exact"], ["see", "lemma"]]);
  assert.match(saw.results[1].note, /过去式/);
});

test("lookup: inflected forms resolve through the form index", async () => {
  const r = await lookup("accounted", memorySource());
  assert.deepEqual(r.results.map((x) => [x.entry.w, x.relation]), [["account", "lemma"]]);
  assert.match(r.results[0].note, /过去分词|过去式/);
});

test("lookup: phrases match exactly or via the first word's base form", async () => {
  const src = memorySource();
  assert.equal((await lookup("take into account", src)).results[0].entry.w, "take into account");
  const took = await lookup("took into account", src);
  assert.equal(took.results[0].entry.w, "take into account");
  assert.equal(took.results[0].relation, "phrase-form");
  const accounts = await lookup("accounts for", src);
  assert.equal(accounts.results[0].entry.w, "account for");
  assert.deepEqual((await lookup("take into account", src)).results.length, 1, "phrase is not split into word results");
});

test("lookup: case-variant entries keep the surface casing first", async () => {
  const r = await lookup("AI", memorySource());
  assert.equal(r.results[0].entry.w, "AI");
  assert.equal(r.results.length, 2);
});

test("lookup: misses, unsupported input and a missing dictionary are explicit", async () => {
  assert.equal((await lookup("qwertyuiopx", memorySource())).status, "not-found");
  assert.equal((await lookup("This is a whole sentence.", memorySource())).status, "unsupported");
  assert.equal((await lookup("bank", memorySource(null))).status, "no-dictionary");
});

test("sensesOf keeps polysemous senses separate with the same-POS Chinese gloss", () => {
  const senses = sensesOf(ENTRIES.find((e) => e.k === "bank"));
  assert.equal(senses.length, 2);
  assert.notEqual(senses[0].id, senses[1].id);
  assert.equal(senses[1].definition_en, "a financial institution");
  assert.equal(senses[1].gloss_zh, "银行, 堤, 岸");
  const phrase = sensesOf(ENTRIES.find((e) => e.k === "account for"));
  assert.equal(phrase[0].gloss_zh, "解释……的原因；占");
  assert.equal(phrase[0].definition_en, null);
});

test("senses follow the Chinese gloss order and the inflection's part of speech", async () => {
  const see = { k: "see", w: "see", en: [["n", "the seat of a bishop"], ["v", "perceive by sight"]], zh: [["vt", "看见"], ["vi", "看"], ["n", "主教的职位"]] };
  assert.deepEqual(sensesOf(see).map((s) => s.pos), ["v", "n"]);
  assert.equal(sensesOf(see)[0].gloss_zh, "vt. 看见；vi. 看", "several lines of one part of speech keep labels");
  assert.equal(sensesOf(see)[1].gloss_zh, "主教的职位", "a single line has no repeated label");
  const saw = await lookup("saw", memorySource());
  assert.equal(saw.results[1].senses[0].pos, "v", "saw → see puts verb senses first");
});

test("IndexedDB dictionary: import, lookup, checksum guard, replace and remove", async () => {
  const dict = new IdbDictionary();
  assert.equal(await dict.info(), null);
  const progress = [];
  const m = await importPackage(packageBuffer(), { onProgress: (p) => progress.push(p.phase) });
  assert.equal(m.entries, ENTRIES.length);
  assert.ok(progress.includes("done"));
  const r = await lookup("accounted", dict);
  assert.equal(r.results[0].entry.w, "account");

  await assert.rejects(importPackage(packageBuffer(), { expectedSha256: "0".repeat(64) }), /校验失败/);
  assert.equal((await dict.info()).pkg, m.pkg, "failed import leaves the old dictionary active");

  const ac = new AbortController();
  ac.abort();
  const v2 = { ...MANIFEST, source_version: "def456" };
  await assert.rejects(importPackage(packageBuffer(v2), { signal: ac.signal }), /取消/);
  assert.equal((await dict.info()).pkg, m.pkg, "cancelled import leaves the old dictionary active");

  const m2 = await importPackage(packageBuffer(v2, ENTRIES.slice(0, 3), []));
  assert.notEqual(m2.pkg, m.pkg);
  assert.equal((await lookup("bank", dict)).status, "not-found", "old package records are gone after replacement");
  await removeDictionary();
  assert.equal((await lookup("bank", dict)).status, "no-dictionary");
});

// --- store ----------------------------------------------------------------------

test("saveItem is idempotent and dedupes by sense; new contexts are appended", async () => {
  const { store } = freshStore();
  const p = savePayload({ idempotency_key: "same" });
  const a = await store.saveItem(p);
  const b = await store.saveItem(p);
  assert.equal(a.result, "created");
  assert.equal(b.result, "already_exists");
  assert.equal(b.item_id, a.item_id);

  const c = await store.saveItem(savePayload({ context: { sentence: "The bank closed early.", url: "https://other.example/b", title: "B" } }));
  assert.equal(c.result, "updated");
  assert.equal(c.item_id, a.item_id);
  const detail = await store.getItem(a.item_id);
  assert.equal(detail.encounters.length, 2);
  assert.equal(detail.encounters.find((e) => e.source_title === "News").source_url, "https://news.example/a", "query/fragment stripped");

  // Same sentence on the same page doesn't pile up.
  await store.saveItem(savePayload());
  assert.equal((await store.getItem(a.item_id)).encounters.length, 2);

  // A different sense of the same spelling is its own item.
  const river = await store.saveItem(savePayload({ sense: { id: "ecdict:bank:en0", pos: "n", definition_en: "sloping land beside water", gloss_zh: "银行, 堤, 岸" } }));
  assert.equal(river.result, "created");
  assert.notEqual(river.item_id, a.item_id);
  assert.equal((await store.listItems()).total, 2);
});

test("encounters keep only the most recent distinct contexts", async () => {
  const { store, clock } = freshStore();
  let id;
  for (let i = 0; i < MAX_ENCOUNTERS + 5; i++) {
    clock.t += 1000;
    id = (await store.saveItem(savePayload({ context: { sentence: `Sentence ${i}.`, url: "https://x.example/" } }))).item_id;
  }
  const encs = (await store.getItem(id)).encounters;
  assert.equal(encs.length, MAX_ENCOUNTERS);
  assert.equal(encs[0].sentence, `Sentence ${MAX_ENCOUNTERS + 4}.`);
});

test("saveItem validates input and saves without context", async () => {
  const { store } = freshStore();
  await assert.rejects(store.saveItem(savePayload({ headword: "" })), ValidationError);
  await assert.rejects(store.saveItem(savePayload({ sense: { id: "x" } })), ValidationError);
  await assert.rejects(store.saveItem(savePayload({ tags: "not-an-array" })), ValidationError);
  const r = await store.saveItem(savePayload({ context: null }));
  const d = await store.getItem(r.item_id);
  assert.equal(d.encounters[0].sentence, null);
});

test("search, filters and facets", async () => {
  const { store } = freshStore();
  await store.saveItem(savePayload({ tags: ["finance"] }));
  await store.saveItem(savePayload({ headword: "account for", kind: "phrase", sense: { id: "ecdict:account for:zh0", pos: "", gloss_zh: "解释……的原因" }, context: { sentence: "This accounts for the gap.", url: "https://paper.example/x" } }));
  assert.equal((await store.listItems({ q: "原因" })).total, 1);
  assert.equal((await store.listItems({ tag: "finance" })).total, 1);
  assert.equal((await store.listItems({ site: "paper.example" })).total, 1);
  const f = await store.facets();
  assert.deepEqual(f.tags, [["finance", 1]]);
  assert.equal(f.sites.length, 2);
});

test("trash: delete, restore, refuse duplicate restore, purge leaves tombstones", async () => {
  const { store, clock } = freshStore();
  const { item_id } = await store.saveItem(savePayload());
  await store.deleteItem(item_id);
  assert.equal((await store.listItems()).total, 0);
  assert.equal((await store.listItems({ trash: true })).total, 1);
  await store.restoreItem(item_id);
  assert.equal((await store.listItems()).total, 1);

  await store.deleteItem(item_id);
  const again = await store.saveItem(savePayload());
  assert.notEqual(again.item_id, item_id);
  await assert.rejects(store.restoreItem(item_id), /已有相同词义/);

  clock.t += 31 * DAY;
  assert.equal((await store.listItems({ trash: true })).total, 0, "trash shows 30 days");
  assert.equal(await store.purgeTrash({ expiredOnly: true }), 1);
  const backup = await store.exportBackup();
  const tomb = backup.items.find((i) => i.id === item_id);
  assert.equal(tomb.purged, true);
  assert.equal(tomb.headword, undefined, "purged content is wiped");
});

// --- scheduler & review ---------------------------------------------------------

test("scheduler follows the simple-v1 table", () => {
  const t = 0;
  const s0 = newState();
  assert.deepEqual([nextState(s0, 1, t).stage, nextState(s0, 1, t).due_at], ["learning", 10 * MIN]);
  assert.deepEqual([nextState(s0, 2, t).stage, nextState(s0, 2, t).due_at], ["learning", DAY]);
  assert.deepEqual([nextState(s0, 3, t).stage, nextState(s0, 3, t).level, nextState(s0, 3, t).due_at], ["review", 0, DAY]);
  assert.deepEqual([nextState(s0, 4, t).level, nextState(s0, 4, t).due_at], [1, 3 * DAY]);

  const r2 = { ...newState(), stage: "review", level: 2 };
  assert.equal(nextState(r2, 2, t).due_at, Math.floor(LEVEL_DAYS[2] / 2) * DAY);
  assert.equal(nextState(r2, 2, t).level, 2);
  assert.deepEqual([nextState(r2, 3, t).level, nextState(r2, 3, t).due_at], [3, LEVEL_DAYS[3] * DAY]);
  assert.equal(nextState(r2, 4, t).level, 4);
  assert.equal(nextState({ ...r2, level: 5 }, 4, t).level, 5);
  const lapse = nextState(r2, 1, t);
  assert.deepEqual([lapse.stage, lapse.due_at, lapse.lapses], ["learning", 10 * MIN, 1]);
  // After relearning, "good" restarts from 1 day.
  assert.equal(nextState(lapse, 3, t).due_at, DAY);
  assert.equal(nextState({ ...newState(), stage: "review", level: 0 }, 2, t).due_at, DAY, "hard never below 1 day");
});

test("replay is order-independent of input and ignores tombstoned events", () => {
  const evs = [
    { id: "b", rating: 3, rated_at: 2 * DAY },
    { id: "a", rating: 3, rated_at: 0 },
    { id: "c", rating: 1, rated_at: 5 * DAY, deleted_at: 6 * DAY },
  ];
  const s = replay(evs);
  assert.equal(s.level, 1);
  assert.equal(s.due_at, 2 * DAY + 3 * DAY);
});

test("review: due first, daily new limit, idempotent rating, relearn after 10 minutes", async () => {
  const { store, clock } = freshStore();
  for (let i = 0; i < 7; i++) {
    clock.t += 1000;
    await store.saveItem(savePayload({ headword: `word${i}`, sense: { id: `s${i}`, pos: "n", gloss_zh: `义${i}` } }));
  }
  assert.equal((await store.reviewSummary({ dailyNew: 5 })).new_available, 5);

  const session = "s1";
  const seen = [];
  for (;;) {
    const next = await store.nextCard({ sessionId: session, dailyNew: 5 });
    if (!next.card) break;
    seen.push(next.item.headword);
    const rating = seen.length === 1 ? 1 : 3;
    const payload = { event_id: `e${seen.length}`, card_id: next.card.id, session_id: session, rating, shown_at: clock.t, revealed_at: clock.t };
    const first = await store.rate(payload);
    const dup = await store.rate(payload);
    assert.equal(dup.duplicate, true);
    assert.deepEqual(dup.state, first.state, "resend does not advance twice");
    clock.t += 1000;
  }
  assert.equal(seen.length, 5, "only 5 new cards per day");
  assert.equal((await store.reviewSummary({ dailyNew: 5 })).new_available, 0);

  clock.t += 10 * MIN;
  const relearn = await store.nextCard({ sessionId: session, dailyNew: 5 });
  assert.equal(relearn.item.headword, "word0", "forgotten card comes back after 10 minutes");
  await assert.rejects(store.rate({ event_id: "x", card_id: relearn.card.id, rating: 3 }), /先显示答案/);

  // Paused items leave the queue.
  await store.updateItem(relearn.item.id, { status: "paused" });
  assert.equal((await store.nextCard({ sessionId: session, dailyNew: 5 })).card, null);
});

test("session limit stops a session", async () => {
  const { store, clock } = freshStore();
  for (let i = 0; i < 3; i++) await store.saveItem(savePayload({ headword: `w${i}`, sense: { id: `x${i}`, pos: "n", gloss_zh: "义" } }));
  for (let i = 0; i < 2; i++) {
    const n = await store.nextCard({ sessionId: "s", sessionMax: 2 });
    await store.rate({ event_id: `e${i}`, card_id: n.card.id, session_id: "s", rating: 3, revealed_at: clock.t });
  }
  const done = await store.nextCard({ sessionId: "s", sessionMax: 2 });
  assert.equal(done.card, null);
  assert.equal(done.reason, "session-limit");
});

test("user gloss edits update the review answer, not the dictionary meaning", async () => {
  const { store } = freshStore();
  const { item_id } = await store.saveItem(savePayload());
  await store.updateItem(item_id, { user_gloss: "金融机构", note: "≠ 河岸" });
  const d = await store.getItem(item_id);
  assert.equal(d.item.meaning.gloss_zh, "银行, 堤, 岸");
  assert.equal(d.card.answer.user_gloss, "金融机构");
});

// --- backup, merge, export ------------------------------------------------------

test("backup round-trip is idempotent and previewable", async () => {
  const { store, clock } = freshStore();
  const { item_id } = await store.saveItem(savePayload());
  const n = await store.nextCard({ sessionId: "s" });
  await store.rate({ event_id: "e1", card_id: n.card.id, session_id: "s", rating: 3, revealed_at: clock.t });
  await store.saveSentence({ idempotency_key: "s1", text: "A sentence worth keeping.", url: "https://x.example/" });
  const backup = JSON.parse(JSON.stringify(await store.exportBackup()));
  assert.equal(JSON.stringify(backup).includes("token"), false);

  const { store: other } = freshStore();
  const preview = await other.previewBackup(backup);
  assert.equal(preview.items.added, 1);
  await other.importBackup(backup);
  await other.importBackup(backup);
  assert.equal((await other.listItems()).total, 1);
  assert.equal((await other.listSentences()).total, 1);
  const card = (await other.getItem(item_id)).card;
  assert.equal(card.state.stage, "review", "card state re-derived from imported events");
  await assert.rejects(other.importBackup({ format: "nope" }), ValidationError);
});

test("mergeRecords is last-writer-wins and keeps local newer edits", async () => {
  const { store, clock } = freshStore();
  const { item_id } = await store.saveItem(savePayload());
  const remote = (await store.exportBackup()).items[0];
  clock.t += 5000;
  await store.updateItem(item_id, { note: "local newer" });
  await store.mergeRecords({ items: [{ ...remote, note: "remote older" }] });
  assert.equal((await store.getItem(item_id)).item.note, "local newer");
  await store.mergeRecords({ items: [{ ...remote, note: "remote newest", updated_at: clock.t + 10000 }] });
  assert.equal((await store.getItem(item_id)).item.note, "remote newest");
});

test("Anki TSV escapes tabs, newlines and HTML and marks the target", () => {
  const tsv = ankiTsv([
    {
      id: "i1",
      headword: "account for",
      meaning: { gloss_zh: "解释\t原因", definition_en: null },
      user_gloss: null,
      tags: ["exam prep"],
      last_encounter: { surface_form: "accounts for", sentence: "It <b>accounts for</b>\nthe gap.", source_url: "https://x.example/a", source_title: "X & Y" },
    },
  ]);
  const lines = tsv.trim().split("\n");
  assert.equal(lines[0], "#separator:tab");
  const fields = lines.at(-1).split("\t");
  assert.equal(fields.length, 6);
  assert.equal(fields[2], "解释 原因");
  assert.match(fields[3], /&lt;b&gt;/);
  assert.match(fields[3], /<br>/);
  assert.match(fields[4], /X &amp; Y/);
  assert.equal(fields[5], "localingo exam_prep");
});
