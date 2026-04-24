# NanoClaw Migration Guide — v1.2.53 → v2

Generated: 2026-04-24
Base (merge-base): `eba94b721ab8c7476e97d6600ca7ee4c0e53249c`
HEAD at generation: `d299897` (v1.2.53)
Upstream HEAD: `8d85222` (v2.0.13)

---

## Migration Plan

This is a **Tier 3 (Complex)** migration: 435 upstream commits, 67 local commits, 46 changed files.

### Why clean-base replay (not merge)

v2 is an architectural rewrite. A merge would produce hundreds of conflicts in
every core file. The clean approach: check out fresh v2, re-apply our
customizations in order, validate.

### Order of operations

1. **Fresh v2 clone** in a sibling directory (`~/nanoclaw-v2`)
2. **Reapply upstream skills** — merge skill branches into v2
3. **Plugin system** — re-implement blogwatcher + tailscale plugins
4. **Telegram channel** — the upstream `channels` branch already has v2 Telegram;
   add our custom features (file downloads) on top
5. **Container build** — multi-SSH keys, datetime tags, no-cache flag
6. **Host source changes** — `/new-session` command, CONTAINER_IMAGE config
7. **Group CLAUDE.md files** — copy the Marvin persona and group configs
8. **Validate** — `pnpm install && pnpm build && pnpm test`
9. **Live test** — start from worktree, send a test message
10. **Swap** — move v2 to production

### Risk areas

| Area | Risk | Mitigation |
|------|------|------------|
| Telegram channel | v2 uses Chat SDK bridge (`@chat-adapter/telegram`), v1 used grammY directly | Use upstream v2 Telegram as base; add file-download feature on top |
| Plugin system | No plugin system in v2; container Dockerfile is restructured | Re-implement; may need Dockerfile changes |
| `/new-session` | v2 session model is different (inbound/outbound DB split) | Find v2 equivalent IPC mechanism before implementing |
| Group folders | v2 introduces agent_groups concept | Copy CLAUDE.md files; verify folder structure |

### Section files

- [01-skills.md](01-skills.md) — Applied upstream skills
- [02-plugins.md](02-plugins.md) — Custom plugin system (blogwatcher + tailscale)
- [03-telegram.md](03-telegram.md) — Telegram channel customizations
- [04-container-build.md](04-container-build.md) — Container build changes
- [05-host-src.md](05-host-src.md) — Host source changes
- [06-groups.md](06-groups.md) — Group persona and CLAUDE.md files
