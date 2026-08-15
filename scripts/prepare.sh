#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

python3 scripts/extract_audio.py
python3 scripts/analyze_audio.py
python3 scripts/analyze_alignment.py
node scripts/encrypt_audio.mjs "$@"
