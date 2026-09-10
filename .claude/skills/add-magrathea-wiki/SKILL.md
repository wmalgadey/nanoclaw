---
name: add-magrathea-wiki
description: Install the Magrathea LLM Wiki container skill — the ingest/query/lint schema for the Zettelkasten-backed knowledge base — into the shared container skills directory. Use to restore the wiki schema on a fresh checkout, or after resetting the tree to upstream.
---

# Add Magrathea Wiki

`/add-karpathy-llm-wiki` *designs* a wiki: it discusses the domain with the
operator and writes a tailored `container/skills/wiki/SKILL.md` in
conversation. That is the right tool for a wiki that doesn't exist yet, and the
wrong one for a wiki that does — a second run produces a different schema, and
the agents lose the conventions they were taught.

This skill carries one already-designed schema as a payload file and installs it
verbatim. Same result every time, no conversation.

**Scope.** Only the schema lives here. The wiki's content
(`groups/magrathea/llm-wiki/`), its sources, and the group's CLAUDE.md wiki
section are untracked runtime state under `groups/` — they survive a tree reset
on their own and this skill neither reads nor writes them.

## Apply

Every step is idempotent — re-running the skill is safe.

### 1. Install the container skill

`container/skills/` is bind-mounted read-only into every agent container at
`/app/skills`, so the file is live on the host with no image rebuild:

```nc:copy
container-skills/wiki/SKILL.md -> container/skills/wiki/SKILL.md
```

An existing `container/skills/wiki/SKILL.md` is left alone rather than
overwritten, so a schema tailored in place is never clobbered. See *Updating the
schema* below for how that edit gets back into the payload.

### 2. Copy and run the guard

```nc:copy
src/wiki-skill-manifest.test.ts
```

```nc:run effect:test
pnpm exec vitest run src/wiki-skill-manifest.test.ts
```

The schema is prose the agent reads, not code the build typechecks, so nothing
else would notice it going missing. The guard asserts the installed copy exists,
still declares `name: wiki`, and is byte-identical to the payload — and, so that
an upstream move of the extension point can't pass silently, that core still
resolves shared skills from `container/skills`.

### 3. Restart running containers

Each session's `.claude-shared/skills/` holds symlinks into `/app/skills`,
reconciled when a container spawns. An updated file is picked up through the
live mount, but a *newly added* skill only gets its symlink on the next spawn:

```nc:run effect:restart
docker ps --format '{{.Names}}' | grep '^nanoclaw-v2-' | xargs -r docker stop
```

They come back on the next message. For a single group,
`bin/ncl groups restart --id <group-id>` does the same thing.

## Updating the schema

The payload is the canonical copy. If you tailor
`container/skills/wiki/SKILL.md` in place — a new tag prefix, a changed
confidence formula — copy it back and commit, or the next replay reverts it:

```bash
cp container/skills/wiki/SKILL.md .claude/skills/add-magrathea-wiki/container-skills/wiki/SKILL.md
```

The guard from step 2 is what tells you this is pending: it goes red on exactly
that drift.

## Troubleshooting

| Symptom | Cause |
|---|---|
| The agent doesn't know the `/ingest`, `/query`, `/lint` workflow | The container was spawned before the skill was installed — stop it and send another message. |
| Host log: `Shared skill not symlinked: real entry occupies the path` | A real `wiki` directory sits in that session's `.claude-shared/skills/` and shadows the shared one — a stale pre-refactor copy. Delete it; the symlink is recreated on the next spawn. |
| The guard fails on byte-equality | The installed copy and the payload diverged — decide which one is current, then copy it over the other (see *Updating the schema*). |
| The wiki skill shows up in groups that have no wiki | `skills` defaults to `'all'`, which resolves every directory under `container/skills/`. Scoping it to one group means writing that group's `skills` column explicitly; there is no `ncl` flag for it. |
