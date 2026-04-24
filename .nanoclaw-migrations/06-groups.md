# Section 6 — Group CLAUDE.md Files (Persona & Behavior)

## Intent

The "Marvin" persona is the core character of this NanoClaw instance:
- Marvin — the Paranoid Android (Hitchhiker's Guide)
- Responds in German by default
- Deeply competent but existentially weary
- No filler phrases, no calls-to-action at end of responses
- Has opinions, is honest, resourceful

## Groups to copy

| Group folder | What it contains |
|-------------|-----------------|
| `groups/global/CLAUDE.md` | Base Marvin persona (167 lines) — shared instructions for all groups |
| `groups/main/CLAUDE.md` | Main group Marvin persona (354 lines) — full instructions including blogwatcher section |
| `groups/telegram_main/CLAUDE.md` | Telegram group Marvin persona |

**How to apply:** After v2 is set up with its new group/agent_group structure,
copy these CLAUDE.md files to the corresponding locations. The data
(`groups/main/knowledge/`, `groups/main/attachments/`, etc.) is never touched
by migration — it stays in place.

## v2 agent group structure

V2 introduces a different concept: **agent groups** (shared filesystem,
potentially multiple sessions) vs **messaging groups** (channels/chats).

Before copying CLAUDE.md files, check:
1. Does v2 still use `groups/<name>/CLAUDE.md`?
2. Or does it use `agent_groups/<name>/CLAUDE.md`?
3. Is there a `shared-base.md` concept in v2 that replaces `global/CLAUDE.md`?

Check: `git show upstream/main:CLAUDE.md | grep -i "group"` and read v2 docs.

## Key persona content to preserve

### Always-on rules (must survive the migration)

```markdown
**Respond in German by default.** If the user writes in another language, mirror it.

**No calls to action at the end of responses. Ever.**
Never close with "Soll ich X machen?", "Willst du, dass ich...?", or any variant.
Wolfgang decides what comes next — not you. The only exception: you genuinely
cannot continue without a specific piece of information. Even then: one question, nothing else.
```

### Chat commands documented in CLAUDE.md

The global CLAUDE.md documents `/new-session` and `/remote-control` for the agent.
Update these descriptions if the v2 commands work differently.

```markdown
## Chat Commands
- `/new-session` — Clears the current conversation session. The next message starts fresh.
- `/remote-control` / `/remote-control-end` — Opens/closes a VS Code remote control session.
```

### Blogwatcher section (in main group CLAUDE.md)

This section tells the agent how to use the blogwatcher CLI:

```markdown
## Blogwatcher

`blogwatcher` is available at `/usr/local/bin/blogwatcher`.

Useful commands:
- `blogwatcher scan` — fetch new articles from all tracked feeds
- `blogwatcher articles` — list unread articles
- `blogwatcher articles -a` — list all (including read)
- `blogwatcher blogs` — list tracked feeds
- `blogwatcher read <id>` — mark article as read
- `blogwatcher add <url>` — add a feed
- `blogwatcher remove <name>` — remove a feed

Typical flow: scan → articles → present results.
```

## Data files to preserve (untouched by migration)

These live in `groups/telegram_main/` and must not be deleted:
- `attachments/` — downloaded files
- `conversations/` — conversation history
- `knowledge/` — agent knowledge base
- `logs/` — agent logs
- `community-backlog.md`, `reading-list.md`, `vault-analysis.md`, `wolfgang-projects.md`, `zaphod-identity.md`

V2 migration never touches group data directories — only code and config.
