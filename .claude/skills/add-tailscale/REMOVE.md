# Remove Tailscale

Every step is idempotent — safe to re-run.

## 1. Turn it off for every group that has it on

Do this while the verbs still exist, so no group is left carrying a flag
nothing reads. List the groups, then disable each one that has it on
(`ncl groups config get --id <group-id>` shows `tailscale_socket`):

```bash
bin/ncl groups list
bin/ncl groups config disable-tailscale --id <group-id>
```

## 2. Remove the skill's files

```bash
rm -f src/tailscale.ts src/tailscale.test.ts \
  src/db/migrations/tailscale-container-config-socket.ts
```

## 3. Remove the reach-ins

Delete these lines (not comment them out):

- `src/modules/index.ts` — the `import '../tailscale.js';` line.
- `src/types.ts` — the `tailscale_socket?: number;` field on
  `ContainerConfigRow` and its doc comment.
- `src/db/container-configs.ts` — `'tailscale_socket',` from `SCALAR_COLUMNS`
  and `| 'tailscale_socket'` from the `updateContainerConfigScalars` union.
- `src/container-config.ts` — the `tailscaleSocket?: boolean;` field (with its
  doc comment) from `ContainerConfig`, and the
  `tailscaleSocket: row.tailscale_socket ? true : undefined,` line from
  `configFromDb`.
- `src/container-runner.ts` — the `./tailscale.js` import, the
  `mounts.push(...tailscaleMounts(containerConfig));` line and its comment in
  `buildMounts`, and the `dockerfile += tailscaleAptRepo(aptPackages);` line
  and its comment in `buildAgentGroupImage`.
- `src/cli/resources/groups.ts` — the `../../tailscale.js` import, the
  `tailscale_socket: !!row.tailscale_socket,` line in `presentConfig`, and
  `...tailscaleVerbs,` from `customOperations`.

## 4. Leave the column

`container_configs.tailscale_socket` stays. SQLite migrations only go forward,
and the column is `NOT NULL DEFAULT 0` — inert once nothing reads it. Reapplying
the skill re-registers `module:tailscale:container-config-socket`, which the
schema-version table already records as applied by name, so it is not re-run.

## 5. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```

Groups that had the mount keep their per-group image until it is rebuilt; the
`tailscale` CLI stays installed there but has no socket to talk to. Drop it with
`bin/ncl groups config remove-package --id <group-id> --apt tailscale` and a
`bin/ncl groups restart --id <group-id> --rebuild`.
