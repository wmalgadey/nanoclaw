# Fork recipe

What this fork is, on top of upstream NanoClaw: three skills, no edits to
upstream files that aren't produced by applying one of them.

This file is the thing [`docs/skills-model.md`](docs/skills-model.md) calls the
recipe — "it's what lets you rebuild the fork from scratch on clean upstream,
and it's how you hand your whole fork to someone else."

## The skills

| Skill | What it adds | Reach-ins | Guard |
|---|---|---|---|
| [`add-tailscale`](.claude/skills/add-tailscale/SKILL.md) | Host tailscaled socket passed into a group's containers; `tailscale_socket` config flag; `ncl groups config enable-tailscale` / `disable-tailscale` | 9, across 6 upstream files | `src/tailscale.test.ts` (8 cases) + `tsc` |
| [`add-magrathea-wiki`](.claude/skills/add-magrathea-wiki/SKILL.md) | The tailored wiki schema as `container/skills/wiki/SKILL.md` | 0 — pure file add | `src/wiki-skill-manifest.test.ts` (4 cases) |
| [`add-buzz`](.claude/skills/add-buzz/SKILL.md) | Native Buzz (Nostr relay) channel adapter | 1 — barrel import | `src/channels/buzz-registration.test.ts` |

`add-buzz` is **not currently installed**. The adapter is disabled; the skill is
kept as a recipe entry so it can come back without rebuilding it.

Telegram is not in this table. It is an upstream channel installed from the
`channels` registry branch via `/add-telegram`, and its code in this tree is
byte-identical to `upstream/channels` — nothing here forks it.

## Updating: pull, don't rebuild

**The routine path is a pull.** From `docs/skills-model.md`:

> Most upgrades don't need to run it [the recipe].
> Normal upgrade: pull and fix what breaks. […] This stays cheap *because* the
> changes are small self-contained skills with tests: conflicts are rare, and
> when something does break, the failing test points at the exact skill and the
> fix is local.

So:

1. `/update-nanoclaw` — pulls upstream, runs the migration gates, verifies health.
2. `/update-skills` — refreshes the installed channel/provider payloads
   (Telegram) from the registry branch, non-interactively.
3. `pnpm run build && pnpm test` — the failing tests, if any, name the skill to fix.

**Do not hard-reset the tree to upstream as part of a routine update.**
`/update-skills` detects what is installed by reading the real barrels
(`detectInstalledSkills`, `scripts/update-skills.ts`). On a reset tree it finds
nothing, refreshes nothing, and Telegram has to be reinstalled through
`/add-telegram` — which is a first-install flow: it asks for the bot token even
when `.env` already has it, runs the BotFather walkthrough, and re-pairs. The
reset destroys the cheap path.

When a pull *does* conflict inside a file one of these skills reaches into,
resolve it by taking upstream's version of that file and re-applying the skill —
not by hand-merging. That is what the recipe is for.

**This branch tracks the applied install, not just the recipe.** The barrels
carry their imports, the Telegram payload and `src/tailscale.ts` are committed,
and `package.json` pins `@chat-adapter/telegram` — which is exactly what makes
the paragraph above true, because `detectInstalledSkills` reads those barrels. It
is also why an upstream rebase touches the reach-in files: resolve those the way
the paragraph above says. A branch holding only the skills would rebase cleanly
but would strand the install, and the first `/update-skills` on it would refresh
nothing. Done knowingly, on 2026-09-10.

## Rebuilding from scratch

On a clean checkout of upstream, apply in any order (they don't depend on each
other), then build once:

```
/add-tailscale
/add-magrathea-wiki
```

Then `pnpm run build && pnpm test`.

To see what a skill would do before running it — every step, and whether it is
mechanical or needs a human:

```bash
pnpm exec tsx scripts/skill-apply.ts .claude/skills/add-tailscale
```

That command is a planner and never writes; the engine's write path is driven
by the setup wizard and by the refresh in `scripts/update-skills.ts`.

`add-magrathea-wiki` and `add-buzz` plan clean end to end — every step
mechanical, no human input. `add-tailscale` cannot: steps 2-8 insert lines into
existing functions, and there is no directive for "insert into the middle of a
file". Only its copies and its build/test are directives; the seven insertions
need an agent reading the prose. That is the inherent floor of this model, not a
gap to be closed later.

Step 2 is prose for a second reason worth knowing before "improving" it: the
conformance suite applies every skill into a scratch tree that pre-creates only
the barrels a trunk skill writes to, so an `nc:append` at `src/modules/index.ts`
has no file to land in and turns the suite red. Seeding it there would be an
edit to an upstream test this fork does not own.

Telegram is a separate, interactive install (`/add-telegram`) — bot token,
BotFather, pairing.

## Not in git

State that survives any reset and is not this recipe's concern: `.env`,
`data/` (central DB, session DBs, OneCLI vault), `groups/*` (per-group
CLAUDE.md, workspaces, the wiki's own content under
`groups/magrathea/llm-wiki/`).
