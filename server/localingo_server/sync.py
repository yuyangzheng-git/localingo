"""Sync protocol: last-writer-wins records with a per-user change cursor.

Clients push changed records ({store: [record]}) and pull everything with
seq > cursor. The server never interprets record contents beyond the fields it
needs (id, updated_at, device_id); validation keeps sizes bounded.
"""

from __future__ import annotations

import json

from .db import Database

STORES = ("items", "encounters", "cards", "events", "sentences")
MAX_PUSH_RECORDS = 1000
MAX_RECORD_BYTES = 64 * 1024
MAX_PULL = 1000


class SyncValidationError(ValueError):
    pass


def _newer(updated_at: int, device_id: str, cur_updated: int, cur_device: str) -> bool:
    if updated_at != cur_updated:
        return updated_at > cur_updated
    return device_id > cur_device


def push(db: Database, user_id: int, device_id: str, changes: dict) -> dict:
    if not isinstance(changes, dict):
        raise SyncValidationError("changes must be an object")
    total = 0
    prepared: list[tuple[str, str, int, str, str]] = []
    for store, rows in changes.items():
        if store not in STORES:
            raise SyncValidationError(f"unknown store: {store}")
        if not isinstance(rows, list):
            raise SyncValidationError(f"{store} must be a list")
        for record in rows:
            total += 1
            if total > MAX_PUSH_RECORDS:
                raise SyncValidationError(f"at most {MAX_PUSH_RECORDS} records per push")
            if not isinstance(record, dict):
                raise SyncValidationError("records must be objects")
            rid = record.get("id")
            updated = record.get("updated_at")
            if not isinstance(rid, str) or not 1 <= len(rid) <= 100:
                raise SyncValidationError("record id must be a string of 1–100 chars")
            if not isinstance(updated, int) or isinstance(updated, bool) or updated < 0:
                raise SyncValidationError("record updated_at must be a non-negative integer")
            record.pop("dirty", None)
            data = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
            if len(data.encode()) > MAX_RECORD_BYTES:
                raise SyncValidationError(f"record {rid} is too large")
            rec_device = str(record.get("device_id") or device_id)[:100]
            prepared.append((store, rid, updated, rec_device, data))

    accepted = 0
    with db.tx() as conn:
        for store, rid, updated, rec_device, data in prepared:
            cur = conn.execute(
                "SELECT updated_at, device_id FROM records WHERE user_id = ? AND store = ? AND id = ?",
                (user_id, store, rid),
            ).fetchone()
            if cur and not _newer(updated, rec_device, cur["updated_at"], cur["device_id"]):
                continue
            # Bump the change counter and read it back: portable across SQLite and MySQL,
            # and the surrounding transaction keeps the two steps atomic.
            conn.execute("UPDATE user_seq SET value = value + 1 WHERE user_id = ?", (user_id,))
            seq = conn.execute("SELECT value FROM user_seq WHERE user_id = ?", (user_id,)).fetchone()["value"]
            if cur:
                conn.execute(
                    "UPDATE records SET seq = ?, updated_at = ?, device_id = ?, data = ? "
                    "WHERE user_id = ? AND store = ? AND id = ?",
                    (seq, updated, rec_device, data, user_id, store, rid),
                )
            else:
                conn.execute(
                    "INSERT INTO records (user_id, store, id, seq, updated_at, device_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (user_id, store, rid, seq, updated, rec_device, data),
                )
            accepted += 1
        cursor = conn.execute("SELECT value FROM user_seq WHERE user_id = ?", (user_id,)).fetchone()["value"]
    return {"accepted": accepted, "received": total, "cursor": cursor}


def pull(db: Database, user_id: int, since: int, limit: int) -> dict:
    limit = max(1, min(limit, MAX_PULL))
    rows = db.query(
        "SELECT store, seq, data FROM records WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        (user_id, max(since, 0), limit + 1),
    )
    more = len(rows) > limit
    rows = rows[:limit]
    changes: dict[str, list] = {}
    for row in rows:
        changes.setdefault(row["store"], []).append(json.loads(row["data"]))
    if rows:
        return {"changes": changes, "cursor": rows[-1]["seq"], "more": more}
    current = db.query("SELECT value FROM user_seq WHERE user_id = ?", (user_id,))[0]["value"]
    if since > current:
        # The client's cursor is ahead of this server (restored from an older backup):
        # start over from the beginning so nothing is skipped.
        return {"changes": {}, "cursor": 0, "more": True, "reset": True}
    return {"changes": {}, "cursor": max(since, 0), "more": False}


def stats(db: Database, user_id: int) -> dict:
    rows = db.query("SELECT store, COUNT(*) AS n FROM records WHERE user_id = ? GROUP BY store", (user_id,))
    return {row["store"]: row["n"] for row in rows}


def delete_all(db: Database, user_id: int) -> None:
    with db.tx() as conn:
        conn.execute("DELETE FROM records WHERE user_id = ?", (user_id,))
