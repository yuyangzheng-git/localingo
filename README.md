# LocaLingo

[![MLX](https://img.shields.io/badge/MLX-Apple%20Silicon-orange)](https://github.com/ml-explore/mlx)
[![Python 3.12+](https://img.shields.io/badge/Python-3.12%2B-blue)](https://www.python.org/)
[![Model on HF](https://img.shields.io/badge/🤗%20Model-ZachacyZ%2Fqwen3--1.7b--web--v3a--merged-yellow)](https://huggingface.co/ZachacyZ/qwen3-1.7b-web-v3a-merged)
[![Model on ModelScope](https://img.shields.io/badge/魔搭-ModelScope-624aff)](https://modelscope.cn/models/ZacharyZhg/qwen3-1.7b-web-v3a-merged)

<p align="center">
  <img src="docs/images/hero.png" alt="LocaLingo — bilingual web translation, entirely on your Mac" width="100%">
</p>

A private Chrome extension that translates web pages **English → Simplified Chinese**,
bilingual paragraph by paragraph, entirely on your Mac — no API key, no cloud. A local
[MLX](https://github.com/ml-explore/mlx) model does the translation, so the page text
never leaves your machine.

> **Local** + **lingo** — translation that runs where the words are: on your machine.
> No account, no cloud, no API key. Just the page, turned bilingual.

<p align="center">
  <img src="docs/images/demo.png" alt="A web article with Simplified Chinese appended below each English paragraph" width="100%">
</p>

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
- **Batched requests** — visible paragraphs are sent to the model a few at a time,
  not one request per paragraph.
- **Persistent cache** — translations are saved per page (URL without `#hash`), so
  scroll-backs and page reloads don't re-translate; the oldest pages are evicted
  after 200.
- **Completion counter** — a toast reports `Translated N · cached N · failed N ·
  skipped N` so you know the page has finished.
- **Selection translation** — select text → right-click → *翻译成中文* shows a
  floating tooltip.

<p align="center">
  <img src="docs/images/selection.png" alt="Select text, right-click, and a floating translation tooltip appears" width="80%">
</p>

## How it works

<p align="center">
  <img src="docs/images/architecture.png" alt="Chrome extension → local FastAPI server → MLX fine-tuned Qwen3-1.7B model" width="100%">
</p>

The extension finds the page's content root (`main`/`article`), walks its block
elements, translates each one as a whole from its plain text, and appends the
Chinese below the untouched original. Navigation, controls, code, and
hidden/accessibility text are skipped.

## Setup

Requires Python 3.12+ and an Apple Silicon Mac, managed with [uv](https://docs.astral.sh/uv/).

```bash
uv sync
```

Get the model. The server uses `~/models/qwen3-1.7b-web-v3a-mlx` if it exists;
otherwise it downloads [ZachacyZ/qwen3-1.7b-web-v3a-merged](https://huggingface.co/ZachacyZ/qwen3-1.7b-web-v3a-merged)
from Hugging Face on first use (unquantized, ~3.4 GB). For faster, smaller 4-bit weights, convert it once:

```bash
uv run mlx_lm.convert --hf-path ZachacyZ/qwen3-1.7b-web-v3a-merged -q --q-bits 4 \
  --mlx-path ~/models/qwen3-1.7b-web-v3a-mlx
```

## Run the translation server

```bash
uv run web-translator
```

Starts the server on `http://127.0.0.1:8765` and prints an **auth token**. On first
run the token is generated randomly and saved to `~/.config/localingo/token`, so it
stays the same across restarts. The model loads lazily on the first request (the
first translation is slow; later ones are fast). Keep the server running while you browse.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` directory.
4. Click the extension icon and paste the token printed by the server into **Auth token**.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `WEB_TRANSLATOR_MODEL` | `~/models/qwen3-1.7b-web-v3a-mlx`, else `ZachacyZ/qwen3-1.7b-web-v3a-merged` | Model id or local path to load (a custom Qwen3-1.7B translation fine-tune) |
| `WEB_TRANSLATOR_ADAPTER` | *(none)* | Local path to a LoRA adapter dir (`adapter_config.json` + safetensors) to load on top of the model |
| `WEB_TRANSLATOR_PORT` | `8765` | Server port |
| `WEB_TRANSLATOR_TOKEN` | *(random, from the token file)* | Override the shared auth token (paste the same value into the popup) |
| `WEB_TRANSLATOR_TOKEN_FILE` | `~/.config/localingo/token` | Where the generated token is stored |

The server binds to `127.0.0.1` only. CORS only allows `chrome-extension://` origins, and
every `/translate` call needs the per-machine token, so other websites open in your
browser can't drive your local model.

## API

- `GET /health` — `{"status": "ok", "model": "...", "loaded": false, "authorized": false}`
  (`authorized` is true when a valid `X-Auth-Token` header is sent)
- `POST /translate` — body `{"texts": ["...", "..."]}` → `{"translations": ["...", "..."]}`
  (requires `X-Auth-Token` header; at most 64 texts of up to 4000 characters each)

## Model

The default model is a custom Qwen3-1.7B translation fine-tune, available as:

- **Hugging Face:** [ZachacyZ/qwen3-1.7b-web-v3a-merged](https://huggingface.co/ZachacyZ/qwen3-1.7b-web-v3a-merged)
- **ModelScope:** [ZacharyZhg/qwen3-1.7b-web-v3a-merged](https://modelscope.cn/models/ZacharyZhg/qwen3-1.7b-web-v3a-merged)

### Using your own ModelScope fine-tune

To bring in a new ModelScope model:

1. Download it:

   ```bash
   uv run --with modelscope modelscope download \
     --model <your-model-id> --local_dir ~/models/<your-model-id>
   ```

2. Convert to MLX (quantize with `-q` for speed):

   ```bash
   uv run mlx_lm.convert --hf-path ~/models/<your-model-id> -q --q-bits 4 \
     --mlx-path ~/models/<your-model-id>-mlx
   ```

3. Point the server at it:

   ```bash
   WEB_TRANSLATOR_MODEL=~/models/<your-model-id>-mlx uv run web-translator
   ```

A Qwen LoRA adapter can alternatively be loaded unmerged via
`WEB_TRANSLATOR_ADAPTER` (a local PEFT dir); see `translator.py`.

<p align="center">
  <img src="docs/images/privacy.png" alt="Your page text never leaves your Mac" width="80%">
</p>

## Development

```bash
uv run pytest
```

## Notes

- Code blocks (`<code>`, `<pre>`) and form fields are intentionally left untranslated.
- Short labels (< 2 chars) and text with no Latin letters (numbers, symbols, text
  that is already Chinese) are skipped.
- Inline links are flattened to plain text in v1: the 1.7B model doesn't reliably
  preserve placeholder markers through translation. Link/anchor preservation is
  planned for the later LoRA / larger-model pass.
