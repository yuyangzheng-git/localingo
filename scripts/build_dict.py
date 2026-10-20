"""Build LocaLingo dictionary packages from an ECDICT CSV.

Usage:
    uv run python scripts/build_dict.py data/upstream/ecdict.csv \
        --license data/upstream/ECDICT-LICENSE.txt --commit <upstream sha> --out data/dist

Produces, for each variant ("base" and "full"):
    localingo-dict-ecdict-<variant>-<version>.jsonl.gz   one JSON record per line
    localingo-dict-ecdict-<variant>-<version>.json       package manifest (source, checksum, license)

Record shapes (first line is the manifest copy, `{"type": "package", ...}`):
    {"type": "entry", "k": "bank", "w": "bank", "ph": "bæŋk",
     "en": [["n", "sloping land ..."], ...], "zh": [["n", "银行, 堤, 岸"], ["", "[医] 库"]],
     "tags": ["zk", "gk"], "collins": 1, "oxford": 1, "bnc": 406, "frq": 663,
     "x": {"s": "banks", "i": "banking"}, "lemma": [["study", "s3"]]}
    {"type": "form", "k": "accounted", "of": [["account", "d"], ["account", "p"]]}

Decisions (see docs/DICTIONARY.md):
- Lines marked "[网络]" (web-sourced glosses with no recorded origin) are dropped.
- Empty fields stay absent; nothing is filled in or generated.
- The base package keeps words with frequency / exam / Collins / Oxford data, their
  inflected forms, and short general-language phrases (not [医]/[化]/[计]… domain terms)
  built only from those words. The full package keeps every entry.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

BUILDER_VERSION = "1"
SOURCE_ID = "ecdict"
SOURCE_URL = "https://github.com/skywind3000/ECDICT"

EN_POS = re.compile(r"^(n|v|vt|vi|a|adj|s|r|adv|prep|conj|pron|int|interj|num|art|aux|abbr|pl)\.?\s+(.+)$")
ZH_POS = re.compile(r"^(n|v|vt|vi|a|adj|adv|prep|conj|pron|int|interj|num|art|aux|abbr|pl)\.\s*(.+)$")
POS_NORMAL = {"a": "adj", "s": "adj", "r": "adv", "interj": "int"}
PHRASE_TOKEN = re.compile(r"^[a-z][a-z'\-]*$")


def normalize_key(word: str) -> str:
    return " ".join(word.strip().lower().split())


def parse_lines(text: str, pattern: re.Pattern, drop_web: bool) -> list[list[str]]:
    out = []
    for raw in text.replace("\\n", "\n").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if drop_web and line.startswith("[网络]"):
            continue
        m = pattern.match(line)
        if m:
            pos = POS_NORMAL.get(m.group(1), m.group(1))
            out.append([pos, m.group(2).strip()])
        else:
            out.append(["", line])
    return out


def parse_exchange(text: str) -> tuple[dict[str, str], list[list[str]]]:
    forms: dict[str, str] = {}
    lemma: str | None = None
    lemma_types = ""
    for part in text.split("/"):
        if ":" not in part:
            continue
        kind, value = part.split(":", 1)
        value = value.strip()
        if not value:
            continue
        if kind == "0":
            lemma = value
        elif kind == "1":
            lemma_types = value
        else:
            forms[kind] = value
    return forms, ([[lemma, lemma_types]] if lemma else [])


def to_int(value: str) -> int:
    try:
        return int(value or 0)
    except ValueError:
        return 0


def make_entry(row: dict) -> dict | None:
    zh = parse_lines(row["translation"], ZH_POS, drop_web=True)
    en = parse_lines(row["definition"], EN_POS, drop_web=False)
    if not zh and not en:
        return None
    forms, lemma = parse_exchange(row["exchange"])
    entry: dict = {"type": "entry", "k": normalize_key(row["word"]), "w": row["word"].strip()}
    if row["phonetic"].strip():
        entry["ph"] = row["phonetic"].strip()
    if en:
        entry["en"] = en
    if zh:
        entry["zh"] = zh
    tags = row["tag"].split()
    if tags:
        entry["tags"] = tags
    for field in ("collins", "oxford", "bnc", "frq"):
        n = to_int(row[field])
        if n:
            entry[field] = n
    if forms:
        entry["x"] = forms
    if lemma:
        entry["lemma"] = lemma
    return entry


def is_core(entry: dict) -> bool:
    return any(entry.get(f) for f in ("frq", "bnc", "tags", "collins", "oxford"))


DOMAIN_LABEL = re.compile(r"^\[[^\]]+\]")


def is_general(entry: dict) -> bool:
    """A phrase for everyday reading: has a gloss that isn't a domain term ([医], [化], [计] ...)."""
    zh = entry.get("zh", [])
    return bool(zh) and any(not DOMAIN_LABEL.match(text) for _, text in zh)


def build(rows: list[dict], variant: str) -> list[dict]:
    entries = [e for e in (make_entry(r) for r in rows) if e]
    if variant == "full":
        selected = entries
    else:
        core = [e for e in entries if is_core(e)]
        core_keys = {e["k"] for e in core}
        # Inflected forms of core words, and lemmas of core forms.
        related = set()
        for e in core:
            related.update(normalize_key(v) for v in e.get("x", {}).values())
            related.update(normalize_key(l[0]) for l in e.get("lemma", []))
        vocab = core_keys | related
        selected = []
        for e in entries:
            k = e["k"]
            if k in core_keys or k in related:
                selected.append(e)
            elif " " in k and is_general(e):
                tokens = k.split(" ")
                if 2 <= len(tokens) <= 5 and all(PHRASE_TOKEN.match(t) and t in vocab for t in tokens):
                    selected.append(e)

    # Reverse form index: inflection -> lemma(s), for forms that are not their own entry.
    keys = {e["k"] for e in selected}
    form_map: dict[str, list[list[str]]] = {}
    for e in selected:
        for kind, value in e.get("x", {}).items():
            fk = normalize_key(value)
            if fk == e["k"]:
                continue
            refs = form_map.setdefault(fk, [])
            if [e["k"], kind] not in refs:
                refs.append([e["k"], kind])
    forms = [{"type": "form", "k": k, "of": v} for k, v in sorted(form_map.items()) if k not in keys]
    return selected + forms


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", type=Path)
    ap.add_argument("--license", type=Path, required=True)
    ap.add_argument("--commit", required=True, help="upstream ECDICT commit the CSV came from")
    ap.add_argument("--out", type=Path, default=Path("data/dist"))
    ap.add_argument("--variants", default="base,full")
    args = ap.parse_args()

    csv_bytes = args.csv.read_bytes()
    source_sha = hashlib.sha256(csv_bytes).hexdigest()
    license_text = args.license.read_text()
    with args.csv.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    args.out.mkdir(parents=True, exist_ok=True)
    version = args.commit[:7]
    for variant in args.variants.split(","):
        records = build(rows, variant)
        name = f"localingo-dict-{SOURCE_ID}-{variant}-{version}"
        manifest = {
            "type": "package",
            "schema_version": 1,
            "package_id": f"{SOURCE_ID}-{variant}",
            "source_id": SOURCE_ID,
            "source_url": SOURCE_URL,
            "source_version": args.commit,
            "source_file": args.csv.name,
            "source_sha256": source_sha,
            "license": "MIT",
            "license_text": license_text,
            "attribution": "ECDICT by Linwei (skywind3000). English definitions in ECDICT derive from WordNet "
            "(Princeton University); see https://wordnet.princeton.edu/license-and-commercial-use.",
            "notes": "Lines marked [网络] were dropped. Missing phonetics, examples or tags stay missing.",
            "builder_version": BUILDER_VERSION,
            "variant": variant,
            "entries": sum(1 for r in records if r["type"] == "entry"),
            "forms": sum(1 for r in records if r["type"] == "form"),
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        body = "\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in [manifest, *records])
        data = gzip.compress(body.encode("utf-8"), compresslevel=9, mtime=0)
        pkg_path = args.out / f"{name}.jsonl.gz"
        pkg_path.write_bytes(data)
        manifest_out = {k: v for k, v in manifest.items() if k != "type"}
        manifest_out.update(file=pkg_path.name, sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
        (args.out / f"{name}.json").write_text(json.dumps(manifest_out, ensure_ascii=False, indent=2) + "\n")
        print(f"{variant}: {manifest['entries']} entries, {manifest['forms']} forms, {len(data) / 1e6:.1f} MB -> {pkg_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
