# CHANGELOG.UPSTREAM.md

Effective differences of this installation compared to `upstream/main`.
As of: 2026-03-22 · Version: **1.2.23** (locally customized)

---

## How to Maintain This File

This file is **not** a traditional release changelog. Its purpose is to record every deliberate deviation from the upstream repository — code changes, config overrides, merged branches, or external repo integrations — so that future updates can be applied without accidentally overwriting local customizations.

### When to update

- **Any time you make a local code change** that diverges from upstream — add or update an entry.
- **Before every `git commit` or `git push`** — verify that all new deviations are documented. Include the update in the same commit as the change.
- **When merging from upstream or another branch/repo** — remove or update entries that have been resolved by the merge, and add new ones if conflicts were resolved in favor of local behavior.

### How to write an entry

Each entry should answer three questions:

1. **What** changed — which file, setting, or feature.
2. **How** it differs from upstream — briefly describe the delta (a short code snippet is fine for non-obvious changes).
3. **Why** — the reason for the deviation (optional but strongly recommended for non-trivial changes).

Use the existing sections as a guide. Group entries under one of these headings:

| Section                              | Use for                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| **Code Differences**                 | Modified source files (`src/`, `setup/`, `container/`, etc.)         |
| **`.env`**                           | Environment variable overrides                                       |
| **Config Files**                     | Non-code config files outside the repo (e.g. `mount-allowlist.json`) |
| **Local Groups**                     | Group folders with their own git history or special setup            |
| **Merged Branches / External Repos** | Skill branches, forks, or external repos merged into this install    |

Add a new section heading if none of the above fit.

### Tracking merged branches and external repos

If you merge a `skill/*` branch, a fork, or an external repository into this install, document it like this:

```
## Merged: skill/add-telegram (upstream)
Merged 2026-03-15. Adds Telegram channel. No conflicts.
Local override: `src/channels/telegram.ts` — custom parse logic for `/cmd` prefix.
```

If upstream later absorbs the same feature, remove the entry or mark it as resolved.

### Removing entries

Delete an entry when:
- The deviation has been merged back upstream and you are now in sync.
- A merge from upstream fully replaced the local change and the local behavior is no longer needed.

Do not leave stale entries — they create confusion when preparing the next update.

---

## Code Differences

### Changes to container build

- Add current date and time to image tag
