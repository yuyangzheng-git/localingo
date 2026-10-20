"""Server-side dictionary: loads a LocaLingo package (scripts/build_dict.py) into
SQLite and serves raw entries by key. The lookup algorithm itself lives in the
shared JavaScript module (extension/learning/dict.js), so the web app and the
extension resolve words identically."""

from __future__ import annotations

import gzip
import hashlib
import json
import sqlite3
import threading
from pathlib import Path

MAX_KEYS = 20


class Dictionary:
    def __init__(self, db_path: Path, dict_dir: Path, variant: str = "base"):
        self.db_path = db_path
        self.dict_dir = dict_dir
        self.variant = variant
        self.lock = threading.Lock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS entries (k TEXT NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS entries_k ON entries (k);
            CREATE TABLE IF NOT EXISTS forms (k TEXT PRIMARY KEY, data TEXT NOT NULL);
            """
        )

    # --- packages ---------------------------------------------------------------

    def packages(self) -> list[dict]:
        """Manifests of the package files available for download."""
        out = []
        if not self.dict_dir.is_dir():
            return out
        for path in sorted(self.dict_dir.glob("localingo-dict-*.json")):
            try:
                manifest = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if (self.dict_dir / manifest.get("file", "")).is_file():
                manifest.pop("license_text", None)
                out.append(manifest)
        return out

    def package_path(self, filename: str) -> Path | None:
        for manifest in self.packages():
            if manifest["file"] == filename:
                return self.dict_dir / filename
        return None

    def info(self) -> dict | None:
        with self.lock:
            row = self.conn.execute("SELECT value FROM meta WHERE key = 'active'").fetchone()
        return json.loads(row[0]) if row else None

    def ensure_loaded(self) -> dict | None:
        """Load the configured variant into SQLite if it isn't already the active one."""
        candidates = [m for m in self.packages() if m.get("variant") == self.variant]
        if not candidates:
            return self.info()
        manifest = candidates[-1]
        active = self.info()
        if active and active.get("sha256") == manifest["sha256"]:
            return active
        path = self.dict_dir / manifest["file"]
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != manifest["sha256"]:
            raise RuntimeError(f"dictionary package checksum mismatch: {path}")
        lines = gzip.decompress(data).decode("utf-8").splitlines()
        header = json.loads(lines[0])
        entries, forms = [], []
        for line in lines[1:]:
            rec = json.loads(line)
            if rec.get("type") == "entry":
                rec.pop("type")
                entries.append((rec["k"], json.dumps(rec, ensure_ascii=False, separators=(",", ":"))))
            elif rec.get("type") == "form":
                forms.append((rec["k"], json.dumps(rec["of"], ensure_ascii=False, separators=(",", ":"))))
        active = {k: v for k, v in header.items() if k not in ("type", "license_text")}
        active.update(sha256=manifest["sha256"], file=manifest["file"], pkg=f"{header['package_id']}@{header['source_version']}")
        with self.lock, self.conn:
            self.conn.execute("DELETE FROM entries")
            self.conn.execute("DELETE FROM forms")
            self.conn.executemany("INSERT INTO entries (k, data) VALUES (?, ?)", entries)
            self.conn.executemany("INSERT OR REPLACE INTO forms (k, data) VALUES (?, ?)", forms)
            self.conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('active', ?)", (json.dumps(active, ensure_ascii=False),))
        return active

    # --- lookup data ----------------------------------------------------------------

    def raw(self, keys: list[str]) -> dict:
        keys = [k for k in dict.fromkeys(keys) if k][:MAX_KEYS]
        entries: dict[str, list] = {}
        forms: dict[str, dict] = {}
        if not keys:
            return {"entries": entries, "forms": forms}
        marks = ",".join("?" * len(keys))
        with self.lock:
            for k, data in self.conn.execute(f"SELECT k, data FROM entries WHERE k IN ({marks})", keys):
                entries.setdefault(k, []).append(json.loads(data))
            for k, data in self.conn.execute(f"SELECT k, data FROM forms WHERE k IN ({marks})", keys):
                forms[k] = {"k": k, "of": json.loads(data)}
        return {"entries": entries, "forms": forms}
