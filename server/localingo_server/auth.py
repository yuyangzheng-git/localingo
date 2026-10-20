"""Password hashing (scrypt), bearer tokens and login throttling."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque

from .db import Database

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1
MIN_PASSWORD = 10
USERNAME_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789._-")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(hash_b64)
        digest = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt_b64), n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
        return hmac.compare_digest(digest, expected)
    except (ValueError, TypeError):
        return False


def validate_username(username: str) -> str:
    name = username.strip().lower()
    if not 3 <= len(name) <= 32 or not set(name) <= USERNAME_CHARS:
        raise ValueError("用户名需为 3–32 位小写字母、数字或 . _ -")
    return name


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        raise ValueError(f"密码至少 {MIN_PASSWORD} 位")
    if len(password) > 256:
        raise ValueError("密码过长")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_user(db: Database, username: str, password: str) -> int:
    name = validate_username(username)
    validate_password(password)
    with db.tx() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
            raise ValueError("用户已存在")
        cur = conn.execute(
            "INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)",
            (name, hash_password(password), int(time.time() * 1000)),
        )
        conn.execute("INSERT INTO user_seq (user_id, value) VALUES (?, 0)", (cur.lastrowid,))
        return int(cur.lastrowid)


def set_password(db: Database, username: str, password: str) -> None:
    validate_password(password)
    with db.tx() as conn:
        row = conn.execute("SELECT id FROM users WHERE username = ?", (username.strip().lower(),)).fetchone()
        if not row:
            raise ValueError("用户不存在")
        conn.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (hash_password(password), row["id"]))
        conn.execute("DELETE FROM tokens WHERE user_id = ?", (row["id"],))  # sign out everywhere


def authenticate(db: Database, username: str, password: str) -> dict | None:
    rows = db.query("SELECT id, username, pw_hash FROM users WHERE username = ?", (username.strip().lower(),))
    if not rows:
        # Spend comparable time so response timing doesn't reveal which usernames exist.
        verify_password(password, "scrypt$16384$8$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
        return None
    row = rows[0]
    if not verify_password(password, row["pw_hash"]):
        return None
    return {"id": row["id"], "username": row["username"]}


def issue_token(db: Database, user_id: int, label: str, days: int) -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time() * 1000)
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO tokens (user_id, token_hash, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, token_hash(token), label[:80], now, now, now + days * 86_400_000),
        )
    return token


def user_for_token(db: Database, token: str) -> dict | None:
    now = int(time.time() * 1000)
    rows = db.query(
        "SELECT t.id AS tid, t.last_used_at, u.id, u.username FROM tokens t JOIN users u ON u.id = t.user_id "
        "WHERE t.token_hash = ? AND t.expires_at > ?",
        (token_hash(token), now),
    )
    if not rows:
        return None
    row = rows[0]
    if now - row["last_used_at"] > 3_600_000:  # coarse "last used", at most hourly writes
        with db.tx() as conn:
            conn.execute("UPDATE tokens SET last_used_at = ? WHERE id = ?", (now, row["tid"]))
    return {"id": row["id"], "username": row["username"], "token_id": row["tid"]}


def revoke_token(db: Database, token_id: int) -> None:
    with db.tx() as conn:
        conn.execute("DELETE FROM tokens WHERE id = ?", (token_id,))


class LoginThrottle:
    """At most `limit` failed logins per (client, username) within `window` seconds."""

    def __init__(self, limit: int = 8, window: float = 900):
        self.limit = limit
        self.window = window
        self.failures: dict[tuple[str, str], deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def _prune(self, key: tuple[str, str], now: float) -> deque:
        q = self.failures[key]
        while q and now - q[0] > self.window:
            q.popleft()
        return q

    def blocked(self, client: str, username: str) -> bool:
        with self.lock:
            return len(self._prune((client, username.lower()), time.monotonic())) >= self.limit

    def fail(self, client: str, username: str) -> None:
        with self.lock:
            self._prune((client, username.lower()), time.monotonic()).append(time.monotonic())

    def reset(self, client: str, username: str) -> None:
        with self.lock:
            self.failures.pop((client, username.lower()), None)
