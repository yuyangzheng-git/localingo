# LocaLingo

A private Chrome extension that translates web pages **English → Simplified Chinese**,
bilingual paragraph by paragraph, entirely on your Mac — no API key, no cloud. A local
[MLX](https://github.com/ml-explore/mlx) model does the translation, so the page text
never leaves your machine.

> **Local** + **lingo** — translation that runs where the words are: on your machine.
> No account, no cloud, no API key. Just the page, turned bilingual.

## Features

- **Bilingual** — article text, headings, and captions keep the original English,
  with the Simplified Chinese appended below in a subtle highlighted block.
- **Content only** — navigation, controls, hidden/accessibility text, SVG, code and
  form fields are left untouched, so a page's UI chrome is never mangled.
- **Whole-sentence translation** — each paragraph / heading / list item is translated
  as one unit from its plain text, so the model sees complete sentences with natural
  word order (never fragmented text nodes).
- **Translate as you scroll** — visible text translates first, then more as you
  scroll, with a per-paragraph loading spinner.
- **Persistent cache** — translations are saved per URL, so scroll-backs and page
  reloads don't re-translate.
- **Completion counter** — a toast reports `Translated N · cached N · failed N ·
  skipped N` so you know the page has finished.
- **Selection translation** — select text → right-click → *翻译成中文* shows a
  floating tooltip.

## How it works

```
Chrome extension (MV3)  ──HTTP──▶  local FastAPI server (uvicorn)
                                      └─ MLX Qwen3-1.7B-4bit model
```

The extension finds the page's content root (`main`/`article`), walks its block
elements, translates each one as a whole from its plain text, and appends the
Chinese below the untouched original. Navigation, controls, code, and
hidden/accessibility text are skipped.

## Setup

Requires Python 3.12+ and an Apple Silicon Mac, managed with [uv](https://docs.astral.sh/uv/).

```bash
uv sync
```

## Run the translation server

```bash
uv run web-translator
```

Starts the server on `http://127.0.0.1:8765`. The model loads lazily on the first
request (the first translation is slow; later ones are fast). Keep it running while
you browse — or set up the launchd agent so it starts at login.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` directory.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `WEB_TRANSLATOR_MODEL` | `mlx-community/Qwen3-1.7B-4bit` | Model id to load (e.g. a larger Qwen3 for better quality) |
| `WEB_TRANSLATOR_PORT` | `8765` | Server port |
| `WEB_TRANSLATOR_TOKEN` | `web-translator-local-token` | Shared auth token (must match the extension's `background.js`) |

The server binds to `127.0.0.1` only and requires the auth token, so other sites can't use it.

## API

- `GET /health` — `{"status": "ok", "model": "...", "loaded": false}`
- `POST /translate` — body `{"texts": ["...", "..."]}` → `{"translations": ["...", "..."]}`
  (requires `X-Auth-Token` header)

## Notes

- The default 1.7B model is small and fast, but translation quality is modest. Point
  `WEB_TRANSLATOR_MODEL` at a larger MLX model for better results.
- Code blocks (`<code>`, `<pre>`) and form fields are intentionally left untranslated.
- Short labels (< 2 chars) and pure numbers/symbols are skipped.
- Inline links are flattened to plain text in v1: the 1.7B model doesn't reliably
  preserve placeholder markers through translation. Link/anchor preservation is
  planned for the later LoRA / larger-model pass.
