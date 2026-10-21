// Card actions for extension pages and the web app (the in-page card talks to the
// service worker instead; see content-learn.js).

import { lookup } from "../dict.js";

let saveCounter = 0;

/** Look up `query` and attach the saved items for the matched entries. */
export async function lookupWithSaved(env, query) {
  const result = await lookup(query, env.dictionary);
  const keys = [...new Set(result.results.map((r) => r.entry.k))];
  const saved = keys.length ? await env.store.itemsForLexemes(keys) : [];
  const info = await env.dictionary.info();
  return { lookup: result, saved, dictionaryVersion: info?.source_version || null };
}

/**
 * Handlers for renderLookupCard. `ctx` is the context to save with (or null);
 * `refresh()` re-renders after the saved state changes.
 */
export function cardHandlers(env, { context = null, refresh = () => {}, onLookup = () => {}, extra = {} } = {}) {
  const cardKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    async save(entry, sense, lk) {
      if (!(await env.sync.status()).configured) throw new Error("请先登录 LocaLingo 账号再收藏，查词不需要登录");
      const r = await env.store.saveItem({
        idempotency_key: `${cardKey}:${++saveCounter}:${sense.id}`,
        headword: entry.w,
        lexeme_key: entry.k,
        kind: lk.kind === "phrase" || entry.k.includes(" ") ? "phrase" : "word",
        sense,
        source: { id: "ecdict", version: (await env.dictionary.info())?.source_version || null },
        context,
      });
      env.notifyChange();
      refresh();
      return r;
    },
    async undo(res) {
      if (res.result === "created") {
        await env.store.deleteItem(res.item_id);
        await env.store.purgeTrash({ ids: [res.item_id] });
      } else if (res.result === "updated" && res.encounter_id) {
        await env.store.deleteEncounter(res.encounter_id);
      }
      env.notifyChange();
      refresh();
    },
    speak: (text) => env.speak(text),
    lookupWord: (w) => onLookup(w),
    ...extra,
  };
}
