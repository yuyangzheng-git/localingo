"""Settings, read from environment variables (see server/README.md)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("LOCALINGO_DATA", REPO_ROOT / "data" / "server")))
    web_root: Path = field(default_factory=lambda: Path(os.environ.get("LOCALINGO_WEB_ROOT", REPO_ROOT / "extension")))
    dict_dir: Path = field(default_factory=lambda: Path(os.environ.get("LOCALINGO_DICT_DIR", REPO_ROOT / "data" / "dist")))
    dict_variant: str = field(default_factory=lambda: os.environ.get("LOCALINGO_DICT_VARIANT", "base"))
    allow_signup: bool = field(default_factory=lambda: _bool("LOCALINGO_ALLOW_SIGNUP"))
    admin_user: str = field(default_factory=lambda: os.environ.get("LOCALINGO_ADMIN_USER", ""))
    admin_password: str = field(default_factory=lambda: os.environ.get("LOCALINGO_ADMIN_PASSWORD", ""))
    # Extra CORS origins (comma separated). Chrome extensions are always allowed.
    cors_origins: list[str] = field(
        default_factory=lambda: [o.strip() for o in os.environ.get("LOCALINGO_CORS_ORIGINS", "").split(",") if o.strip()]
    )
    token_days: int = field(default_factory=lambda: int(os.environ.get("LOCALINGO_TOKEN_DAYS", "180")))
    # Empty = SQLite at data/localingo.db; set e.g. mysql://user:pass@host:3306/localingo for MySQL.
    mysql_url: str = field(default_factory=lambda: os.environ.get("LOCALINGO_MYSQL_URL", ""))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "localingo.db"

    @property
    def dict_db_path(self) -> Path:
        return self.data_dir / "dictionary.db"
