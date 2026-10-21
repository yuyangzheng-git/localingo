// Text helpers shared by the extension, the learning center and the hosted web app.
// Pure functions only (no DOM, no storage) so they run in pages, workers and Node tests.

export const MAX_QUERY_CHARS = 300;
export const MAX_PHRASE_WORDS = 8;

const EDGE_PUNCT = /^[\s"'“”‘’«»()[\]{}<>.,;:!?…—–-]+|[\s"'“”‘’«»()[\]{}<>.,;:!?…—–-]+$/gu;
const CJK = /[㐀-鿿豈-﫿]/u;
const URL_LIKE = /^(https?:\/\/|www\.)|^[\w.+-]+@[\w-]+\.[\w.]+$|\/|\\/i;
const WORD_TOKEN = /^[A-Za-z][A-Za-z'’-]*$/;

/** Lowercase, straighten apostrophes, collapse whitespace — the dictionary key. */
export function normalizeKey(text) {
  return String(text ?? "")
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Strip surrounding quotes/punctuation and collapse whitespace, keeping case. */
export function cleanSelection(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(EDGE_PUNCT, "")
    .replace(/[’‘]/g, "'")
    .trim();
}

function looksLikeCode(token) {
  return (
    /[a-z][A-Z]/.test(token) || // camelCase
    /_/.test(token) ||
    /[A-Za-z]\d|\d[A-Za-z]/.test(token) ||
    /^[.#$@]|[(){};=<>]/.test(token)
  );
}

/**
 * Decide what a selection is, which determines the offered actions.
 * kind: "word" | "phrase" | "sentence" | "too-long" | "chinese" | "code" | "empty"
 */
export function classifySelection(raw) {
  const original = String(raw ?? "");
  if (!original.trim()) return { kind: "empty", text: "" };
  if (original.length > MAX_QUERY_CHARS) return { kind: "too-long", text: original.trim() };
  const text = cleanSelection(original);
  if (!text) return { kind: "empty", text: "" };
  if (CJK.test(text)) return { kind: "chinese", text };
  const tokens = text.split(" ");
  if (tokens.length === 1) {
    if (URL_LIKE.test(text) || looksLikeCode(text) || text.length > 40) return { kind: "code", text };
    if (!WORD_TOKEN.test(text)) return { kind: "code", text };
    return { kind: "word", text };
  }
  if (URL_LIKE.test(text)) return { kind: "code", text };
  const sentenceEnd = /[.!?]["'”’)]?$/.test(original.trim());
  if (tokens.length <= MAX_PHRASE_WORDS && !sentenceEnd && tokens.every((t) => WORD_TOKEN.test(t))) {
    return { kind: "phrase", text };
  }
  return { kind: "sentence", text: original.replace(/\s+/g, " ").trim() };
}

/**
 * Candidate base forms for an inflected word, used ONLY when the dictionary has no
 * entry or recorded form for it. Results are labelled as guesses by the caller.
 */
export function guessLemmas(word) {
  const w = normalizeKey(word);
  const out = new Set();
  const add = (s) => {
    if (s && s.length >= 2 && s !== w) out.add(s);
  };
  if (w.endsWith("'s")) add(w.slice(0, -2));
  if (w.endsWith("s'")) add(w.slice(0, -1));
  if (w.endsWith("ies")) add(w.slice(0, -3) + "y");
  if (w.endsWith("es")) add(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) add(w.slice(0, -1));
  if (w.endsWith("ied")) add(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) {
    add(w.slice(0, -2));
    add(w.slice(0, -1));
    if (/([b-df-hj-np-tv-z])\1ed$/.test(w)) add(w.slice(0, -3));
  }
  if (w.endsWith("ing")) {
    add(w.slice(0, -3));
    add(w.slice(0, -3) + "e");
    if (/([b-df-hj-np-tv-z])\1ing$/.test(w)) add(w.slice(0, -4));
  }
  if (w.endsWith("ier")) add(w.slice(0, -3) + "y");
  if (w.endsWith("iest")) add(w.slice(0, -4) + "y");
  if (w.endsWith("er")) add(w.slice(0, -2));
  if (w.endsWith("est")) add(w.slice(0, -3));
  if (w.endsWith("ly")) add(w.slice(0, -2));
  if (w.includes("-")) for (const part of w.split("-")) add(part);
  return [...out];
}

/**
 * Find the sentence of `blockText` that contains [start, end), using
 * Intl.Segmenter when available. Returns { sentence, before, after } where
 * before/after are short neighbouring snippets used to re-locate the quote.
 */
export function sentenceAround(blockText, start, end = start) {
  const text = String(blockText ?? "");
  let sStart = 0;
  let sEnd = text.length;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    for (const { index, segment } of seg.segment(text)) {
      if (index <= start && start < index + segment.length) {
        sStart = index;
        sEnd = Math.max(index + segment.length, Math.min(end, text.length));
        break;
      }
    }
  } else {
    const left = text.slice(0, start).search(/[.!?]\s+[^.!?]*$/);
    if (left >= 0) sStart = left + 1;
    const right = text.slice(end).search(/[.!?](\s|$)/);
    if (right >= 0) sEnd = end + right + 1;
  }
  const sentence = text.slice(sStart, sEnd).replace(/\s+/g, " ").trim();
  return {
    sentence: sentence.length > 600 ? sentence.slice(0, 600) + "…" : sentence,
    before: text.slice(Math.max(0, sStart - 40), sStart).replace(/\s+/g, " ").trim(),
    after: text.slice(sEnd, sEnd + 40).replace(/\s+/g, " ").trim(),
  };
}

/** Remove query string and fragment unless the caller keeps them. */
export function cleanSourceUrl(url, { keepQuery = false } = {}) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return "";
    u.hash = "";
    if (!keepQuery) u.search = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "";
  }
}

/** Escape a value for an Anki TSV field with HTML enabled. */
export function ankiField(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, "<br>");
}

/** Wrap the first occurrence of `target` inside an already-escaped sentence with <b>. */
export function highlightTarget(sentence, target) {
  const s = ankiField(sentence);
  const t = ankiField(target);
  if (!t) return s;
  const i = s.toLowerCase().indexOf(t.toLowerCase());
  return i < 0 ? s : `${s.slice(0, i)}<b>${s.slice(i, i + t.length)}</b>${s.slice(i + t.length)}`;
}

const fnv = (str, seed) => {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};

/** A 64-bit hex fingerprint of `str` (not cryptographic; for idempotency keys). */
export function shortHash(str) {
  return fnv(str, 0x811c9dc5) + fnv(str, 0x9747b28c);
}

/** Keep an idempotency key within the store's 100 characters (stable for the same input). */
export function fitKey(key) {
  return key.length <= 100 ? key : `h:${shortHash(key)}:${key.length}`;
}

/**
 * Idempotency key for saving `text` from the page at `url`: the same page and
 * sentence always give the same key (saving twice is a no-op), and it stays far
 * below the store's 100-character limit however long the URL or sentence is.
 */
export function sentenceKey(url, text) {
  return `sentence:${shortHash(`${url}\n${text}`)}:${text.length}`;
}
