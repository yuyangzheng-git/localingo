"""web-translator: local EN -> Simplified Chinese webpage translation engine."""

from __future__ import annotations

import os

from .server import DEFAULT_PORT, app

__all__ = ["app", "main"]


def main() -> None:
    import uvicorn

    port = int(os.environ.get("WEB_TRANSLATOR_PORT", DEFAULT_PORT))
    print(f"Starting web-translator server on http://127.0.0.1:{port}")
    print("The model loads lazily on the first /translate request.")
    uvicorn.run(app, host="127.0.0.1", port=port)
