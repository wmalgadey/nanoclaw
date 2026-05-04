#!/usr/bin/env bash
# Generates a Claude Code /insights HTML report and saves it to data/insights-latest.html
# Run via cron weekly (e.g. Sunday 08:00). Skips if currently rate-limited.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(dirname "$SCRIPT_DIR")/data"
OUT="$DATA_DIR/insights-latest.html"
DIFF_OUT="$DATA_DIR/insights-diff.txt"
STATUS_FILE="$DATA_DIR/claude-status.json"
CLAUDE=/home/linuxbrew/.linuxbrew/bin/claude

# Archive current report under its own modification timestamp before overwriting
PREV=""
if [ -f "$OUT" ]; then
  PREV_TS=$(date -r "$OUT" +%Y-%m-%dT%H-%M 2>/dev/null \
    || stat -c %Y "$OUT" | xargs -I{} date -d @{} +%Y-%m-%dT%H-%M)
  PREV="$DATA_DIR/insights-$PREV_TS.html"
  if [ ! -f "$PREV" ]; then
    cp "$OUT" "$PREV"
    echo "Archived previous report as $PREV" >&2
  fi
fi

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

echo "Insights saved to $OUT" >&2

# Generate a text diff against the archived previous report
if [ -n "$PREV" ] && [ -f "$PREV" ]; then
  strip_html() { sed 's/<[^>]*>//g' "$1" | sed '/^[[:space:]]*$/d'; }
  diff <(strip_html "$PREV") <(strip_html "$OUT") > "$DIFF_OUT" 2>&1 || true
  CHANGED=$(grep -c '^[<>]' "$DIFF_OUT" 2>/dev/null || echo 0)
  echo "Diff written to $DIFF_OUT ($CHANGED changed lines vs $PREV)" >&2
fi
