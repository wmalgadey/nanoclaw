# CHANGELOG.UPSTREAM.md

Effective differences of this installation compared to `upstream/main`.
As of: 2026-04-16 · Version: **1.2.53** (locally customized)

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
- Use docker build kit for container build
- Multiple SSH keys supported: `SSH_KEY_PATHS` in `.env` is a comma-separated list of host key paths; each is baked into the image via numbered build secrets (`ssh_key_0`, `ssh_key_1`, …, up to 4). `ARG SSH_KEY_NAMES` is a colon-separated list of the resulting filenames inside `~/.ssh/`. Replaces the old single-key `SSH_KEY_PATH` / `ARG SSH_KEY_NAME` mechanism.
- `container/build.sh`: added `--no-cache` flag support (`./container/build.sh --no-cache`) to bypass Docker layer cache for `npm install -g` and other cached steps.

### Changes to systemd service

- Run npm build before agent start

### Changes to channels

- Add telegram support

### Plugins

- `src/plugins/blogwatcher.ts`: added — installs blogwatcher v0.0.2 binary into the container from `Hyaxia/blogwatcher` releases.
- `src/plugins/index.ts`: imports `blogwatcher.js` for self-registration.
- `container/skills/blogwatcher/SKILL.md`: added — agent instructions for using the blogwatcher CLI.

### Tailscale plugin

- `src/plugins/tailscale.ts`: added — installs tailscale v1.96.4 binaries; injects `TAILSCALE_AUTH_KEY` and `TAILSCALE_HOSTNAME` env vars into the container.
- `src/plugins/registry.ts`: added `stripComponents?: number` to `BinaryInstall` interface for archives with subdirectory structure.
- `container/plugins/tailscale-init.sh`: added — starts `tailscaled` in userspace networking mode and calls `tailscale up` when `TAILSCALE_AUTH_KEY` is set.
- `container/skills/tailscale/SKILL.md`: added — agent instructions for Tailscale VPN usage.

### Dockerfile fixes

- `container/Dockerfile`: fixed archive extraction in plugin installer — changed tar args from `['xz', '--strip-components=1', ...]` (missing file arg, wrong strip) to `['xzf', archivePath, ...]` (correct).
- `container/Dockerfile`: added per-plugin `stripComponents` support — when `>0`, all archive files are extracted with `--strip-components=N` without specific file selectors (required because tar file selectors must match full archive paths).

## Merged Branches / External Repos

### Merged: skill/channel-formatting (upstream)
Merged 2026-04-16. Adds per-channel text formatting (WhatsApp bold/italic/strikethrough syntax, Telegram MarkdownV2, plain text). Adds `src/text-styles.ts` and extends `src/router.ts` and `src/index.ts`. No conflicts.
