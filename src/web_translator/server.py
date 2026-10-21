"""FastAPI server exposing the MLX translator over a local HTTP endpoint."""

from __future__ import annotations

import re
import threading
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .translator import Translator

DEFAULT_PORT = 8765
EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

# Request limits — keep a single request from tying up the model for minutes.
MAX_TEXTS = 64
MAX_TEXT_CHARS = 4000

app = FastAPI(title="web-translator")

# No token: only Chrome extensions may translate. Browsers always send Origin on a
# POST, and a web page can't forge it, so /translate requires an extension origin.
# The Host check stops DNS-rebinding pages that resolve their own name to 127.0.0.1.
# (Local programs can call the server anyway — they could read any token file too.)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=EXTENSION_ORIGIN.pattern,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Auth-Token"],
)

_translator: Translator | None = None
# MLX generation is not thread-safe, and FastAPI runs sync routes in a thread
# pool, so serialize model loading and generation.
_model_lock = threading.Lock()


def _from_extension(request: Request) -> bool:
    host = urlsplit("//" + request.headers.get("host", "")).hostname
    return host in LOOPBACK_HOSTS and bool(EXTENSION_ORIGIN.match(request.headers.get("origin") or ""))


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
def health() -> dict:
    return {
        "status": "ok",
        "model": _translator.model_id if _translator else Translator().model_id,
        "loaded": bool(_translator and _translator.loaded),
        # Kept for older extensions: there is no token any more.
        "authorized": True,
    }


@app.post("/translate", response_model=TranslateResponse)
def translate(req: TranslateRequest, request: Request) -> TranslateResponse:
    if not _from_extension(request):
        raise HTTPException(status_code=403, detail="only the LocaLingo extension may translate")
    if any(len(t) > MAX_TEXT_CHARS for t in req.texts):
        raise HTTPException(status_code=413, detail=f"each text must be at most {MAX_TEXT_CHARS} characters")
    with _model_lock:
        return TranslateResponse(translations=_get_translator().translate_batch(req.texts))
