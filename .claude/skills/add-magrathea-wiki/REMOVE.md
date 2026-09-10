# Remove Magrathea Wiki

Every step is idempotent — safe to re-run. Steps delete what apply created.

## 1. Remove the container skill

```bash
rm -rf container/skills/wiki
```

The per-session entries under `data/v2-sessions/*/.claude-shared/skills/wiki`
are symlinks into the shared mount, and the spawn-time reconciler unlinks any
symlink whose skill no longer exists — so they clear themselves on the next
spawn. Anything left there is a real directory, not this skill's doing.

## 2. Remove the guard

```bash
rm -f src/wiki-skill-manifest.test.ts
```

## 3. Restart running containers

So sessions stop loading the removed skill:

```bash
docker ps --format '{{.Names}}' | grep '^nanoclaw-v2-' | xargs -r docker stop
```

## Not removed

The wiki itself — `groups/<folder>/llm-wiki/`, its sources, and the
`<!-- BEGIN karpathy-llm-wiki -->` section in the group's CLAUDE.md — is
runtime data this skill never created and never touches. Removing the schema
leaves the content intact and unmanaged; delete it by hand if that is what you
want.
