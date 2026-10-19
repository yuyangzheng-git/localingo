"""web-translator: local EN -> Simplified Chinese webpage translation engine."""

from __future__ import annotations

import os

from .server import DEFAULT_PORT, TOKEN_FILE, _token, app

__all__ = ["app", "main"]


def main() -> None:
    import uvicorn

    port = int(os.environ.get("WEB_TRANSLATOR_PORT", DEFAULT_PORT))
    token = _token()
    print(f"Starting web-translator server on http://127.0.0.1:{port}")
    print("The model loads lazily on the first /translate request.")
    if not os.environ.get("WEB_TRANSLATOR_TOKEN"):
        print(f"Auth token (stored in {TOKEN_FILE}) — paste it into the extension popup:")
    else:
        print("Auth token (from WEB_TRANSLATOR_TOKEN) — paste it into the extension popup:")
    print(f"  {token}")
    uvicorn.run(app, host="127.0.0.1", port=port)
