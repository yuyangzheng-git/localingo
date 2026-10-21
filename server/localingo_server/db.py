"""Account and sync storage: users, auth tokens and synced learning records.

Two backends behind one interface:

- SQLite (default): a single file, used by the tests and small installs.
- MySQL (when `mysql_url` is set, e.g. `mysql://user:pass@host:3306/localingo`):
  one database per install, managed by the shared server-wide MySQL instance.

SQL in the callers is written once with `?` placeholders and the small dialect
gaps are handled here: `?` is rewritten to `%s` for MySQL, rows come back as
dict-like objects either way, and statements that differ between the engines
(upserts, `RETURNING`) are written in their portable form by the callers.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

SCHEMA_SQLITE = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
-- One row per synced record. `seq` is a per-user change counter used as the pull cursor.
CREATE TABLE IF NOT EXISTS records (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    PRIMARY KEY (user_id, store, id)
);
CREATE INDEX IF NOT EXISTS records_user_seq ON records (user_id, seq);
CREATE TABLE IF NOT EXISTS user_seq (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    value INTEGER NOT NULL
);
"""

# utf8mb4_general_ci makes `username` comparisons case-insensitive, like COLLATE NOCASE.
SCHEMA_MYSQL = [
    """CREATE TABLE IF NOT EXISTS users (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        pw_hash VARCHAR(255) NOT NULL,
        created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci""",
    """CREATE TABLE IF NOT EXISTS tokens (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        token_hash VARCHAR(255) NOT NULL UNIQUE,
        label VARCHAR(255) NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL,
        last_used_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        CONSTRAINT fk_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci""",
    # One row per synced record. `seq` is a per-user change counter used as the pull cursor.
    """CREATE TABLE IF NOT EXISTS records (
        user_id BIGINT NOT NULL,
        store VARCHAR(64) NOT NULL,
        id VARCHAR(100) NOT NULL,
        seq BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        device_id VARCHAR(100) NOT NULL DEFAULT '',
        data MEDIUMTEXT NOT NULL,
        PRIMARY KEY (user_id, store, id),
        INDEX records_user_seq (user_id, seq),
        CONSTRAINT fk_records_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci""",
    """CREATE TABLE IF NOT EXISTS user_seq (
        user_id BIGINT PRIMARY KEY,
        value BIGINT NOT NULL,
        CONSTRAINT fk_user_seq_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci""",
]


class _SqliteConnection:
    """The sqlite3 connection already has the execute/fetchone shape we need."""

    dialect = "sqlite"

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.executescript(SCHEMA_SQLITE)

    def execute(self, sql: str, params: tuple = ()) -> Any:
        return self.conn.execute(sql, params)

    def commit(self) -> None:
        self.conn.execute("COMMIT")

    def rollback(self) -> None:
        self.conn.execute("ROLLBACK")

    def begin(self) -> None:
        self.conn.execute("BEGIN IMMEDIATE")

    def close(self) -> None:
        self.conn.close()


class _MysqlConnection:
    """PyMySQL wrapper: same execute/fetchone/lastrowid shape as the sqlite3 cursor.

    Callers write SQL with `?` placeholders and no literal `?` inside strings;
    they are rewritten to `%s` (the paramstyle PyMySQL expects) on the way in.
    """

    dialect = "mysql"

    def __init__(self, url: str):
        import pymysql  # imported lazily so SQLite-only installs need no driver

        parsed = urlparse(url)
        if parsed.scheme not in ("mysql", "mysql+pymysql"):
            raise ValueError(f"unsupported database url scheme: {parsed.scheme}")
        self.conn = pymysql.connect(
            host=parsed.hostname or "127.0.0.1",
            port=parsed.port or 3306,
            user=parsed.username or "",
            password=parsed.password or "",
            database=(parsed.path or "/").lstrip("/"),
            charset="utf8mb4",
            autocommit=True,  # transactions are opened explicitly, like the SQLite backend
            cursorclass=pymysql.cursors.DictCursor,
        )
        with self.conn.cursor() as cur:
            for stmt in SCHEMA_MYSQL:
                cur.execute(stmt)

    def execute(self, sql: str, params: tuple = ()) -> Any:
        cur = self.conn.cursor()
        cur.execute(sql.replace("?", "%s"), params)
        return cur

    def begin(self) -> None:
        self.conn.begin()

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        self.conn.close()


class Database:
    """One connection guarded by a lock (the server is low-traffic and personal)."""

    def __init__(self, path: Path | None = None, mysql_url: str = ""):
        self.backend = _MysqlConnection(mysql_url) if mysql_url else _SqliteConnection(path or Path(":memory:"))
        self.lock = threading.RLock()

    @property
    def dialect(self) -> str:
        return self.backend.dialect

    @contextmanager
    def tx(self) -> Iterator[Any]:
        with self.lock:
            self.backend.begin()
            try:
                yield self.backend
            except BaseException:
                self.backend.rollback()
                raise
            else:
                self.backend.commit()

    def query(self, sql: str, params: tuple = ()) -> list[Any]:
        with self.lock:
            return self.backend.execute(sql, params).fetchall()

    def close(self) -> None:
        with self.lock:
            self.backend.close()
