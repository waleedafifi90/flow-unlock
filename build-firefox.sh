#!/usr/bin/env bash
# Mirrors the shared extension files into firefox/ so the Firefox build stays in
# sync with the Chrome one. Only firefox/manifest.json differs between browsers;
# everything else is copied verbatim. Run this after changing any shared file.
set -euo pipefail
cd "$(dirname "$0")"

SHARED=(background.js proxy-core.js slot-core.js engine.js bridge.js popup.html popup.js)

mkdir -p firefox/icons
for f in "${SHARED[@]}"; do
  cp "$f" "firefox/$f"
done
cp icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png firefox/icons/

echo "firefox/ is up to date (manifest.json left untouched)."
