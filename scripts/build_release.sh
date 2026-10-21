#!/bin/bash
# Build the downloads served by the LocaLingo server for the one-click installer:
#   data/release/localingo-extension.zip     Chrome extension (load unpacked)
#   data/release/localingo-translator.tar.gz local translation service (uv project)
#   data/release/install.sh                  scripts/install-macos.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="data/release"
mkdir -p "$OUT"
rm -f "$OUT/localingo-extension.zip" "$OUT/localingo-translator.tar.gz"

# The landing page files are only for the website.
(cd extension && zip -qr -X "../$OUT/localingo-extension.zip" . -x 'index.html' 'index.css' 'landing.js' '*.DS_Store')
COPYFILE_DISABLE=1 tar -czf "$OUT/localingo-translator.tar.gz" --exclude '__pycache__' pyproject.toml uv.lock README.md src/web_translator
cp scripts/install-macos.sh "$OUT/install.sh"
ls -l "$OUT"
