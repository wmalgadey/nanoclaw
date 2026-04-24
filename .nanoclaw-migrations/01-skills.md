# Section 1 — Applied Upstream Skills

## Applied Skills

| Skill | Branch | Notes |
|-------|--------|-------|
| `channel-formatting` | `upstream/skill/channel-formatting` | Already merged in v1. In v2 this is superseded by `telegram-markdown-sanitize.ts` and the Chat SDK bridge's own formatting. See Section 3 for details. |

## How to reapply

```bash
# In the v2 worktree
git merge upstream/skill/channel-formatting --no-edit
```

**Important:** After merging, check whether `src/text-styles.ts` and `src/router.ts`
conflict with v2's `src/channels/telegram-markdown-sanitize.ts`. The v2 Telegram
channel already handles Markdown sanitization for Telegram specifically. The
channel-formatting skill's `parseTextStyles()` may still be useful for other
channels (WhatsApp, Slack) — keep it, but verify there is no double-transformation
for Telegram.

## Skills NOT applied (available but not installed)

These were not merged in v1 and do not need to be reapplied:
`apple-container`, `compact`, `emacs`, `native-credential-proxy`, `ollama-tool`, `wiki`
