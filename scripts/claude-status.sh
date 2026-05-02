#!/usr/bin/env bash
# Polls `claude /usage` and writes current rate-limit state to data/claude-status.json
# Run via cron every 10 minutes.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(dirname "$SCRIPT_DIR")/data"
OUT="$DATA_DIR/claude-status.json"
CLAUDE=/home/linuxbrew/.linuxbrew/bin/claude

STATUS=$("$CLAUDE" -p "/usage" 2>&1 || true)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if echo "$STATUS" | grep -qi "out of extra usage"; then
  RESET_MSG=$(echo "$STATUS" | grep -oi 'resets [^·\n]*' | head -1 | sed 's/resets //')
  printf '{"state":"limited","resetAt":"%s","message":"%s","timestamp":"%s"}\n' \
    "$RESET_MSG" \
    "$(echo "$STATUS" | tr '"' "'" | tr '\n' ' ' | head -c 200)" \
    "$TS" > "$OUT"
else
  printf '{"state":"ok","message":"%s","timestamp":"%s"}\n' \
    "$(echo "$STATUS" | tr '"' "'" | tr '\n' ' ' | head -c 200)" \
    "$TS" > "$OUT"
fi
