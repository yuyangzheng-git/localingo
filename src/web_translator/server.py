"""FastAPI server exposing the MLX translator over a local HTTP endpoint."""

from __future__ import annotations

import os

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .translator import Translator

DEFAULT_TOKEN = "web-translator-local-token"
DEFAULT_PORT = 8765

app = FastAPI(title="web-translator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_translator: Translator | None = None


def _token() -> str:
    return os.environ.get("WEB_TRANSLATOR_TOKEN", DEFAULT_TOKEN)


def _get_translator() -> Translator:
    global _translator
    if _translator is None:
        _translator = Translator()
    if not _translator.loaded:
        _translator.load()
    return _translator


class TranslateRequest(BaseModel):
    texts: list[str]


class TranslateResponse(BaseModel):
    translations: list[str]


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": _translator.model_id if _translator else Translator().model_id,
        "loaded": bool(_translator and _translator.loaded),
    }


@app.post("/translate", response_model=TranslateResponse)
def translate(req: TranslateRequest, x_auth_token: str | None = Header(default=None)) -> TranslateResponse:
    if x_auth_token != _token():
        raise HTTPException(status_code=401, detail="invalid or missing token")
    return TranslateResponse(translations=_get_translator().translate_batch(req.texts))
