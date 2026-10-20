// Dictionary lookup over an abstract source, shared by the extension (IndexedDB)
// and the hosted web app (server API). The source provides:
//   getEntries(keys) -> Map<key, entry[]>   (entries share a normalized key, e.g. "AI"/"ai")
//   getForms(keys)   -> Map<key, {k, of: [[lemmaKey, kind]]}>
//   info()           -> installed package manifest, or null when no dictionary is installed
//
// Nothing here generates meanings: every definition shown comes from a package entry,
// and guesses about base forms are labelled as guesses.

import { classifySelection, guessLemmas, normalizeKey } from "./text.js";

export const FORM_LABELS = {
  p: "过去式",
  d: "过去分词",
  i: "现在分词",
  3: "第三人称单数",
  r: "比较级",
  t: "最高级",
  s: "复数",
};

export const POS_LABELS = {
  n: "n.",
  v: "v.",
  vt: "vt.",
  vi: "vi.",
  adj: "adj.",
  adv: "adv.",
  prep: "prep.",
  conj: "conj.",
  pron: "pron.",
  int: "int.",
  num: "num.",
  art: "art.",
  aux: "aux.",
  abbr: "abbr.",
  pl: "pl.",
};

const POS_FAMILY = { vt: "v", vi: "v", pl: "n" };
const family = (pos) => POS_FAMILY[pos] || pos || "";

function describeForms(kinds) {
  return [...new Set(String(kinds).split(""))]
    .map((k) => FORM_LABELS[k])
    .filter(Boolean)
    .join("、");
}

/**
 * Turn an entry into selectable senses. English (WordNet-derived) definitions are
 * the sense units, each paired with the Chinese gloss of the same part of speech;
 * entries without English definitions use their Chinese lines as senses.
 */
export function sensesOf(entry, sourceId = "ecdict") {
  const zh = entry.zh || [];
  const en = entry.en || [];
  const zhFor = (pos) =>
    zh
      .filter(([p]) => p && family(p) === family(pos))
      .map(([p, t]) => (zh.length > 1 ? `${POS_LABELS[p] || p} ${t}` : t))
      .join("；") || null;
  if (en.length) {
    return en.map(([pos, text], i) => ({
      id: `${sourceId}:${entry.k}:en${i}`,
      pos: pos || "",
      definition_en: text,
      gloss_zh: zhFor(pos),
    }));
  }
  return zh.map(([pos, text], i) => ({
    id: `${sourceId}:${entry.k}:zh${i}`,
    pos: pos || "",
    definition_en: null,
    gloss_zh: text,
  }));
}

/** Chinese summary lines of an entry ("n. 银行, 堤, 岸"), for the card header. */
export function chineseSummary(entry) {
  return (entry.zh || []).map(([pos, text]) => (pos ? `${POS_LABELS[pos] || pos + "."} ${text}` : text));
}

/** Exam / frequency labels that the source actually recorded. */
export function sourceLabels(entry) {
  const tagNames = {
    zk: "中考",
    gk: "高考",
    cet4: "四级",
    cet6: "六级",
    ky: "考研",
    toefl: "托福",
    ielts: "雅思",
    gre: "GRE",
  };
  const out = (entry.tags || []).map((t) => tagNames[t] || t);
  if (entry.oxford) out.push("牛津 3000");
  if (entry.collins) out.push(`柯林斯 ${"★".repeat(entry.collins)}`);
  return out;
}

function orderByCase(entries, surface) {
  return [...entries].sort((a, b) => (b.w === surface) - (a.w === surface));
}

/**
 * Look up a selection. Returns
 * {
 *   status: "ok" | "not-found" | "no-dictionary" | "unsupported",
 *   kind, query, results: [{ entry, senses, relation, note }], words: [...]
 * }
 * relation: "exact" | "lemma" (recorded base form) | "phrase-form" | "guess"
 */
export async function lookup(rawQuery, source) {
  const cls = classifySelection(rawQuery);
  const base = { kind: cls.kind, query: cls.text, results: [], words: [] };
  if (cls.kind === "sentence" || cls.kind === "too-long" || cls.kind === "chinese" || cls.kind === "code" || cls.kind === "empty") {
    return { ...base, status: "unsupported" };
  }
  const info = await source.info();
  if (!info) return { ...base, status: "no-dictionary" };
  const sourceId = info.source_id || "ecdict";

  const key = normalizeKey(cls.text);
  const results = [];
  const seen = new Set();
  const push = (entry, relation, note = "") => {
    const id = `${entry.k}|${entry.w}`;
    if (seen.has(id)) return;
    seen.add(id);
    results.push({ entry, senses: sensesOf(entry, sourceId), relation, note });
  };

  if (cls.kind === "word") {
    const [entries, forms] = await Promise.all([source.getEntries([key]), source.getForms([key])]);
    const exact = orderByCase(entries.get(key) || [], cls.text);
    // Base forms recorded by the dictionary (entry "lemma" field, or the form index).
    const lemmaRefs = [];
    for (const e of exact) for (const [lemma, kinds] of e.lemma || []) lemmaRefs.push([normalizeKey(lemma), kinds]);
    for (const [lemma, kind] of forms.get(key)?.of || []) lemmaRefs.push([lemma, kind]);
    const lemmaKeys = [...new Set(lemmaRefs.map(([k]) => k))].filter((k) => k !== key);
    const lemmaEntries = lemmaKeys.length ? await source.getEntries(lemmaKeys) : new Map();
    for (const e of exact) push(e, "exact");
    for (const lk of lemmaKeys) {
      const kinds = lemmaRefs.filter(([k]) => k === lk).map(([, kind]) => kind).join("");
      for (const e of lemmaEntries.get(lk) || []) push(e, "lemma", `${cls.text} 是 ${e.w} 的${describeForms(kinds) || "变形"}`);
    }
    if (!results.length) {
      const guesses = guessLemmas(cls.text);
      if (guesses.length) {
        const guessed = await source.getEntries(guesses);
        for (const g of guesses) for (const e of guessed.get(g) || []) push(e, "guess", `按构词规则推测的原形，未经词典确认`);
      }
    }
    return { ...base, status: results.length ? "ok" : "not-found", results };
  }

  // Phrase: exact match first, then with the first word reduced to a recorded base
  // form ("accounts for" -> "account for", "took into account" -> "take into account").
  const tokens = key.split(" ");
  const entries = await source.getEntries([key]);
  for (const e of orderByCase(entries.get(key) || [], cls.text)) push(e, "exact");
  if (!results.length) {
    const first = tokens[0];
    const [firstEntries, firstForms] = await Promise.all([source.getEntries([first]), source.getForms([first])]);
    const lemmas = new Set();
    for (const e of firstEntries.get(first) || []) for (const [l] of e.lemma || []) lemmas.add(normalizeKey(l));
    for (const [l] of firstForms.get(first)?.of || []) lemmas.add(l);
    const candidates = [...lemmas].map((l) => [l, ...tokens.slice(1)].join(" "));
    if (candidates.length) {
      const found = await source.getEntries(candidates);
      for (const c of candidates) for (const e of found.get(c) || []) push(e, "phrase-form", `按词组原形 ${e.w} 查到`);
    }
  }
  return {
    ...base,
    status: results.length ? "ok" : "not-found",
    results,
    words: [...new Set(tokens)].filter((t) => /^[a-z][a-z'-]*$/.test(t)),
  };
}

/** Dictionary source backed by the LocaLingo server API (hosted web app). */
export class RemoteDictionary {
  constructor(api) {
    this.api = api; // { get(path) -> json }
    this._info = undefined;
  }
  async info() {
    if (this._info === undefined) {
      try {
        const data = await this.api.get("/api/dict/info");
        this._info = data.package || null;
      } catch {
        this._info = null;
      }
    }
    return this._info;
  }
  async _fetch(keys) {
    const qs = keys.map((k) => `k=${encodeURIComponent(k)}`).join("&");
    return this.api.get(`/api/dict/entries?${qs}`);
  }
  async getEntries(keys) {
    const data = await this._fetch(keys);
    return new Map(Object.entries(data.entries || {}));
  }
  async getForms(keys) {
    const data = await this._fetch(keys);
    return new Map(Object.entries(data.forms || {}));
  }
}
