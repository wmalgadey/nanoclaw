#!/usr/bin/env bash
# Generates a Claude Code /insights HTML report and saves it to data/insights-latest.html
# Run via cron weekly (e.g. Sunday 08:00). Skips if currently rate-limited.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(dirname "$SCRIPT_DIR")/data"
OUT="$DATA_DIR/insights-latest.html"
STATUS_FILE="$DATA_DIR/claude-status.json"
CLAUDE=/home/linuxbrew/.linuxbrew/bin/claude

# Skip if currently rate-limited
if [ -f "$STATUS_FILE" ]; then
  STATE=$(python3 -c "import json; print(json.load(open('$STATUS_FILE')).get('state','ok'))" 2>/dev/null || echo ok)
  if [ "$STATE" = "limited" ]; then
    echo "Rate-limited, skipping insights generation" >&2
    exit 0
  fi
fi

# /insights writes an HTML file; capture stdout (some versions print the path, others dump HTML)
RESULT=$("$CLAUDE" -p "/insights" 2>&1 || true)

if echo "$RESULT" | grep -qi "out of extra usage"; then
  echo "Rate-limited during insights generation, aborting" >&2
  exit 0
fi

# If it looks like HTML, write it directly
if echo "$RESULT" | grep -qi "<!DOCTYPE\|<html"; then
  echo "$RESULT" > "$OUT"
else
  # /insights writes to ~/.claude/usage-data/report.html and prints a file:// URL
  CANDIDATE=$(echo "$RESULT" | grep -oP 'file://\K[^\s]+' | head -1)
  if [ -z "$CANDIDATE" ]; then
    CANDIDATE=$(echo "$RESULT" | grep -oP '(?<=Saved to |saved to |written to )[^\s]+' | head -1)
  fi
  if [ -n "$CANDIDATE" ] && [ -f "$CANDIDATE" ]; then
    cp "$CANDIDATE" "$OUT"
  else
    # Fallback: check the known default path
    DEFAULT="$HOME/.claude/usage-data/report.html"
    if [ -f "$DEFAULT" ]; then
      cp "$DEFAULT" "$OUT"
    else
      printf '<pre>%s</pre>' "$RESULT" > "$OUT"
    fi
  fi
fi

# Stamp the generation time in the file name as well (symlink style)
DATED="$DATA_DIR/insights-$(date +%Y-%m-%d).html"
cp "$OUT" "$DATED"
echo "Insights saved to $OUT" >&2
