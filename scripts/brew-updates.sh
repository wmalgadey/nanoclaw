#!/usr/bin/env bash
# Checks for outdated brew packages and writes results to data/brew-outdated.json
# Run via cron daily (e.g. 06:00).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(dirname "$SCRIPT_DIR")/data"
OUT="$DATA_DIR/brew-outdated.json"
BREW=/home/linuxbrew/.linuxbrew/bin/brew

RESULT=$("$BREW" outdated --json 2>/dev/null || echo '{"formulae":[],"casks":[]}')
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Wrap with a timestamp
python3 -c "
import json, sys
d = json.loads(sys.argv[1])
d['timestamp'] = sys.argv[2]
print(json.dumps(d))
" "$RESULT" "$TS" > "$OUT"
