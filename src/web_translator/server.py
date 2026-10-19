"""FastAPI server exposing the MLX translator over a local HTTP endpoint."""

from __future__ import annotations

import os
import secrets
import threading
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .translator import Translator

DEFAULT_PORT = 8765
TOKEN_FILE = Path(os.environ.get("WEB_TRANSLATOR_TOKEN_FILE", "~/.config/localingo/token")).expanduser()

# Request limits — keep a single request from tying up the model for minutes.
MAX_TEXTS = 64
MAX_TEXT_CHARS = 4000

app = FastAPI(title="web-translator")

# Only Chrome extensions may read responses cross-origin; ordinary web pages
# are rejected at the CORS preflight (the X-Auth-Token header forces one).
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Auth-Token"],
)

_translator: Translator | None = None
# MLX generation is not thread-safe, and FastAPI runs sync routes in a thread
# pool, so serialize model loading and generation.
_model_lock = threading.Lock()
_cached_token: str | None = None


def _token() -> str:
    """Return the shared auth token: env var, else a random per-machine token file."""
    global _cached_token
    env = os.environ.get("WEB_TRANSLATOR_TOKEN")
    if env:
        return env
    if _cached_token is None:
        if TOKEN_FILE.exists():
            _cached_token = TOKEN_FILE.read_text().strip()
        if not _cached_token:
            TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
            _cached_token = secrets.token_urlsafe(24)
            TOKEN_FILE.write_text(_cached_token + "\n")
            TOKEN_FILE.chmod(0o600)
    return _cached_token


def _check_token(x_auth_token: str | None) -> bool:
    return x_auth_token is not None and secrets.compare_digest(x_auth_token, _token())


def _get_translator() -> Translator:
    global _translator
    if _translator is None:
        _translator = Translator()
    if not _translator.loaded:
        _translator.load()
    return _translator


class TranslateRequest(BaseModel):
    texts: list[str] = Field(max_length=MAX_TEXTS)


class TranslateResponse(BaseModel):
    translations: list[str]


@app.get("/health")
def health(x_auth_token: str | None = Header(default=None)) -> dict:
    return {
        "status": "ok",
        "model": _translator.model_id if _translator else Translator().model_id,
        "loaded": bool(_translator and _translator.loaded),
        "authorized": _check_token(x_auth_token),
    }


@app.post("/translate", response_model=TranslateResponse)
def translate(req: TranslateRequest, x_auth_token: str | None = Header(default=None)) -> TranslateResponse:
    if not _check_token(x_auth_token):
        raise HTTPException(status_code=401, detail="invalid or missing token")
    if any(len(t) > MAX_TEXT_CHARS for t in req.texts):
        raise HTTPException(status_code=413, detail=f"each text must be at most {MAX_TEXT_CHARS} characters")
    with _model_lock:
        return TranslateResponse(translations=_get_translator().translate_batch(req.texts))
