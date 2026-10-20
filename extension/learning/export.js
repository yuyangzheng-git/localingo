// Exports: JSON backup file and Anki-compatible TSV (UTF-8, tab separated, HTML on).
// Anki reads the leading "#" header lines (separator, html, columns) on import.

import { ankiField, highlightTarget } from "./text.js";

export const ANKI_COLUMNS = ["LocaLingo ID", "Expression", "Meaning", "Sentence", "Source", "Tags"];

/**
 * Build the TSV text. `rows` come from LearningStore.listItems (with last_encounter);
 * `cloze` wraps the target expression in the sentence as {{c1::…}} instead of <b>.
 */
export function ankiTsv(rows, { cloze = false } = {}) {
  const lines = ["#separator:tab", "#html:true", `#columns:${ANKI_COLUMNS.join("\t")}`, "#tags column:6"];
  for (const r of rows) {
    const meaning = [r.user_gloss, r.meaning?.gloss_zh, r.meaning?.definition_en].filter(Boolean);
    const enc = r.last_encounter;
    const target = enc?.surface_form || r.headword;
    let sentence = enc?.sentence ? highlightTarget(enc.sentence, target) : "";
    if (cloze && sentence) sentence = sentence.replace(/<b>(.*?)<\/b>/, "{{c1::$1}}");
    const source = enc?.source_url ? `<a href="${ankiField(enc.source_url)}">${ankiField(enc.source_title || enc.source_url)}</a>` : "";
    const tags = ["localingo", ...(r.tags || [])].map((t) => t.replace(/\s+/g, "_")).join(" ");
    lines.push(
      [ankiField(r.id), ankiField(r.headword), meaning.map(ankiField).join("<br>"), sentence, source, ankiField(tags)].join("\t"),
    );
  }
  return lines.join("\n") + "\n";
}

export function backupFileName(now = new Date()) {
  const d = now.toISOString().slice(0, 10);
  return `localingo-backup-${d}.json`;
}

/** Trigger a download from a page context. */
export function downloadText(text, filename, type = "application/json") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
