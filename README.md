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

## LocaLingo Learn (0.4)

Read English, understand it in place, and keep what you learn
([PRD](docs/PRD_ENGLISH_LEARNING.md) · [what's implemented](docs/LEARN_0.4.md)):

- **Offline dictionary** — select a word or phrase → 查词. Lookups run against an
  ECDICT package stored in the extension (no network, no translation server); word
  forms come from the dictionary's own data (`studies → study`, `saw → see` shown as a
  candidate, never forced), phrases resolve from inflected forms
  (`took into account → take into account`). Sources are always shown.
- **学习阅读** — a reading mode that keeps the page in English; a small 「译」 at the
  end of each paragraph translates *only that paragraph* when you click it.
- **Vocabulary book with real contexts** — saving keeps the sense you chose, the
  sentence you saw it in and its source (query strings stripped); the same sense
  seen again adds a context instead of a duplicate; different senses stay separate.
- **Review** — recall first, then reveal; rate 忘记 / 困难 / 记得 / 很熟 on a
  transparent fixed ladder (`simple-v1`: 10 min, 1, 3, 7, 14, 30, 60 days), 5 new
  words a day by default, pause/limit any time.
- **Learning center & side panel** — search, filter, edit, trash (30 days), saved
  sentences, settings; a side panel for pinned lookups and this page's words.
- **Speech** — local English voices only, unless you opt into online voices.
- **Your data** — JSON backup/restore (idempotent), Anki TSV export, and optional
  **sync with your own server** ([server/](server/README.md), Docker), which also
  hosts the same learning center as a web app for reviewing on any device.

## Translation features

- **Current-page controls** — the popup shows the active article, live paragraph
  counts, and clear translating / reading / restore states. Failed paragraphs can
  be retried without removing successful translations.
- **Guided connection** — explicit Save & Connect, a five-second health timeout,
  local-address validation, and a separate warning for older server versions.
- **Bilingual** — article text, headings, and captions keep the original English,
  with Simplified Chinese appended below using the page's own typography.
- **Two display modes** — *bilingual* (Chinese below each paragraph) or *translation
  only* (the original is hidden; hover a paragraph to see it). Switch anytime from the
  popup; the page updates live.
- **Native look** — by default a translation is just another paragraph in the page's
  own font, size, weight and color (inside the link when the original is a link). Muted
  and dotted-underline styles are optional.
- **Follows live pages** — text that changes after translation (e.g. an AI chat
  streaming its answer) is re-translated once it stops changing, and content revealed
  by expanding a section is translated when it appears.
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
  floating card with the original, a loading state, and a copy button (Esc to close;
  follows light/dark mode).

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

## Install (one command)

On an Apple Silicon Mac with Chrome:

```bash
curl -fsSL http://101.35.6.63:8083/install.sh | bash
```

It installs the translation service into `~/Library/Application Support/LocaLingo`
(a LaunchAgent starts it at login), downloads the model once (via `hf-mirror.com` when
Hugging Face is unreachable), and puts the extension in `~/LocaLingo/chrome-extension`.
Load that folder once in `chrome://extensions` (Developer mode → Load unpacked). Re-run
the command to update; add `-s -- --uninstall` after `bash` to remove it. Logs:
`~/Library/Logs/LocaLingo/translator.log`.

The downloads are built with `scripts/build_release.sh` into `data/release/`, which the
LocaLingo server serves at `/install.sh` and `/download/…` (`LOCALINGO_RELEASE_DIR`).

## Setup (development)

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

Starts the server on `http://127.0.0.1:8765`. There is no token: it only translates
requests from Chrome extensions (see below). The model loads lazily on the first request (the
first translation is slow; later ones are fast). Keep the server running while you browse.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` directory.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `WEB_TRANSLATOR_MODEL` | `~/models/qwen3-1.7b-web-v3a-mlx`, else `ZachacyZ/qwen3-1.7b-web-v3a-merged` | Model id or local path to load (a custom Qwen3-1.7B translation fine-tune) |
| `WEB_TRANSLATOR_ADAPTER` | *(none)* | Local path to a LoRA adapter dir (`adapter_config.json` + safetensors) to load on top of the model |
| `WEB_TRANSLATOR_PORT` | `8765` | Server port |

The server binds to `127.0.0.1` only. `/translate` requires a `chrome-extension://`
`Origin` header (browsers always send it on a POST and web pages can't forge it) and a
loopback `Host` (blocks DNS rebinding), so other websites open in your browser can't
drive your local model. Programs running on your Mac can — as they could read a token
file.

## API

- `GET /health` — `{"status": "ok", "model": "...", "loaded": false, "authorized": true}`
  (`authorized` is always true; token-era servers answer false and the popup asks to update)
- `POST /translate` — body `{"texts": ["...", "..."]}` → `{"translations": ["...", "..."]}`
  (403 unless sent by a Chrome extension; at most 64 texts of up to 4000 characters each)

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

## Learning setup

1. **Dictionary.** Build the packages once (they are not in Git; ECDICT is MIT-licensed,
   see [docs/DICTIONARY.md](docs/DICTIONARY.md)):

   ```bash
   mkdir -p data/upstream && cd data/upstream
   curl -LO https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv
   curl -L -o ECDICT-LICENSE.txt https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/LICENSE
   cd ../.. && python3 scripts/build_dict.py data/upstream/ecdict.csv \
     --license data/upstream/ECDICT-LICENSE.txt --commit bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b
   ```

   The extension installs the base package by itself from the LocaLingo server right
   after installation (no account needed; progress in the popup and on 学习中心 → 查词).
   To install another package: 学习中心 → 查词 → 离线词典, or 从文件导入 →
   `data/dist/localingo-dict-ecdict-base-bc015ed.jsonl.gz` (≈8 MB, 149k entries, a few
   seconds).
2. **Account.** Translation and lookup run locally without an account. The vocabulary
   book, saved sentences and review need a LocaLingo account on the server at
   `http://101.35.6.63:8083` (set in `extension/learning/sync.js` as `ACCOUNT_SERVER`):
   open the learning center and sign in or register. The extension and the web app
   share the same account data.
3. **Shortcut (optional).** `chrome://extensions/shortcuts` → *Look up the selected word*.

New permissions in 0.4: `sidePanel` (learning side panel), `tts` (pronunciation with
local voices), `alarms` (periodic sync), `unlimitedStorage` (offline dictionary). 0.5
adds host access to the LocaLingo account server (`http://101.35.6.63:8083/*`) and
drops the optional access to arbitrary `https://` sync servers.

## Development

```bash
uv run pytest
npm install && npm test          # popup controller + learning core (Node, fake-indexeddb)
cd server && uv run pytest       # sync server
```

For an interactive UI fixture (mock translations, no real tokens or model calls):

```bash
node tests/browser/serve.mjs
```

Open `http://127.0.0.1:8791/tests/browser/preview.html`. For the learning features,
`http://127.0.0.1:8791/tests/browser/learn-harness.html` runs the real background
script and content scripts against a mocked `chrome.*` (it imports the dictionary
from `data/dist/`); `extension/learn.html?harness` and `extension/sidepanel.html?harness`
open the learning pages the same way (signed in to a fake account server; add
`&signedout` to start signed out). `tests/browser/login-harness.html` checks the
sign-in gate, `tests/browser/dict-harness.html` the automatic dictionary install (fresh
profile), and `tests/browser/chat-harness.html` checks a streaming AI chat page
(React-style node patching, mid-answer pauses, composer and dialogs). See
[the UI and interaction review](docs/UX_REVIEW.md) for implemented improvements,
known limitations, and the next priorities. Reload the unpacked extension after
updating it. A running older backend must be restarted from this project directory.

## Notes

- Code blocks (`<code>`, `<pre>`) and form fields are intentionally left untranslated.
- Short labels (< 2 chars) and text with no Latin letters (numbers, symbols, text
  that is already Chinese) are skipped.
- Inline links are flattened to plain text in v1: the 1.7B model doesn't reliably
  preserve placeholder markers through translation. Link/anchor preservation is
  planned for the later LoRA / larger-model pass.
