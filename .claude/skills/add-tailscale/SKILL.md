---
name: add-tailscale
description: Give an agent group Tailscale access by passing the host's tailscaled socket into its containers — no auth key, no tailscaled, no NET_ADMIN in the container. Adds the `tailscale_socket` container-config flag, the mount, the apt-repo step the `tailscale` package needs, and the `ncl groups config enable-tailscale` / `disable-tailscale` verbs.
---

# Add Tailscale

An agent that can reach the operator's tailnet can talk to private hosts —
an internal Git server, a NAS, a home dashboard — without any of it being on
the public internet.

The container never joins the tailnet itself. The host's tailscaled control
socket is bind-mounted in, so the agent's `tailscale` CLI drives the **host**
daemon: no auth key inside the container, no second `tailscaled`, no
`NET_ADMIN` capability, and nothing to revoke per container. The host's
identity on the tailnet is the only one that exists.

It is off for every group until an operator turns it on, per group, with an
operator-only `ncl` verb — mounting a host path is a filesystem-access
boundary, the same reasoning as `ncl groups config add-mount`.

**Linux hosts.** The passthrough needs a host UNIX socket a container can bind
mount. On macOS the agent containers run inside Docker Desktop's Linux VM,
which cannot reach the macOS host's tailscaled socket; install this on a Linux
host, or on the Linux box you run the service on.

## What it adds

All the logic lives in one skill-owned file, `src/tailscale.ts`:

- `tailscaleMounts(containerConfig)` — the mount, or none. A missing host
  socket is skipped with a warning rather than failing the spawn.
- `tailscaleAptRepo(aptPackages)` — the Dockerfile step that adds Tailscale's
  apt repo, needed because Debian's own repos don't carry the package.
- `tailscaleVerbs` — the two `ncl groups config` verbs.

Core only calls in: one line per seam.

## Apply

Every step is idempotent — re-running the skill is safe.

### 1. Copy the module, its migration, and its test

```nc:copy
src/tailscale.ts
src/tailscale.test.ts
src/db/migrations/tailscale-container-config-socket.ts
```

The migration registers itself via `registerMigration` (the
`module:<module-id>:<migration-id>` seam in `src/db/migrations/index.ts`),
not a numbered core migration file — so there's no core migration count to
check or coordinate against. `src/tailscale.ts` already imports it for the
side effect; nothing else to wire for this file.

**The column appears at the first host boot, not from `pnpm run migrate`.**
A module migration reaches the runner only because its owning module registered
it, and the modules barrel is what triggers that — `src/index.ts` is the only
entry point that loads the barrel. `pnpm run migrate`, `setup/register.ts`,
`setup/pair-*.ts`, `setup/migrate-v2/*` and `scripts/init-*-agent.ts` all import
the migration list directly, so they register no module migrations and print
"Central DB migrations are current." without having run this one. Don't read
that as the step having worked.

That needs no fix, and don't build one: the only writer of the column is
`ncl groups config enable-tailscale`, which is served over the host's socket and
so unreachable before the host has booted, and the migration is idempotent
against an already-present column. Importing the barrel from a migration entry
point, or importing the migration from `src/db/migrations/index.ts`, would both
be edits to upstream files this skill does not own — and the second one throws at
startup, because ESM hoists the import above the module body and
`registerMigration` would touch `moduleMigrations` inside its temporal dead zone.

### 2. Register the module

In `src/modules/index.ts`, append the import as the last line of the
"Registry-based modules" block (importing `tailscale.ts` triggers the
migration's self-registration too):

```typescript
import '../tailscale.js';
```

Prose, not an `nc:append` — deliberately. The conformance suite
(`scripts/skill-conformance.test.ts`) applies every skill into a scratch tree
that only pre-creates the barrels a *trunk* skill writes to; the modules barrel
is this fork's reach-in, so a directive here has no file to append to and the
suite reports the step as bounced to an agent. Nothing in the fixture format can
seed a file, and seeding it in the scratch root would mean editing an upstream
test this skill doesn't own. So this insertion joins the other six as prose.

### 3. Type the column

In `src/types.ts`, add the field to `ContainerConfigRow`, above `updated_at`:

```typescript
  /**
   * 1 = mount the host's tailscaled socket into this group's containers.
   * Column is NOT NULL DEFAULT 0 (module:tailscale:container-config-socket);
   * optional on the TS type per the denied_at convention so fixtures that
   * build ContainerConfigRow objects don't need updating —
   * createContainerConfig leaves it to the DB default.
   */
  tailscale_socket?: number;
```

### 4. Make the column writable

In `src/db/container-configs.ts`, add `'tailscale_socket'` to the
`SCALAR_COLUMNS` set:

```typescript
  'tailscale_socket',
```

and to the `Pick<...>` union of `updateContainerConfigScalars`, after
`'timezone'`:

```typescript
      | 'tailscale_socket'
```

### 5. Materialize it into `container.json`

In `src/container-config.ts`, add the field to the `ContainerConfig` interface:

```typescript
  /**
   * Mount the host's tailscaled socket into the container, so the agent's
   * `tailscale` CLI drives the host daemon without needing its own auth key.
   * Consumed by `tailscaleMounts` in `src/tailscale.ts`.
   */
  tailscaleSocket?: boolean;
```

and the line to `configFromDb`, after `runtimeTier`. Off stays absent rather
than `false`, so `container.json` for a group that never opted in reads exactly
as it did before the column existed:

```typescript
    tailscaleSocket: row.tailscale_socket ? true : undefined,
```

### 6. Mount the socket

In `src/container-runner.ts`, import the helpers:

```typescript
import { tailscaleAptRepo, tailscaleMounts } from './tailscale.js';
```

and call the mount contribution at the end of `buildMounts`, after the
provider-contributed mounts and before `return mounts;`:

```typescript
  // Tailscale host-socket passthrough — gives the container access to Tailscale
  // peers via the host daemon without injecting an auth key into the container.
  mounts.push(...tailscaleMounts(containerConfig));
```

### 7. Add the apt repo to per-group image builds

Still in `src/container-runner.ts`, inside `buildAgentGroupImage`, add the repo
step to the apt branch so it lands before the install line:

```typescript
  if (aptPackages.length > 0) {
    // Packages Debian's own repos don't carry need their repo added first.
    dockerfile += tailscaleAptRepo(aptPackages);
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
```

### 8. Expose the `ncl` verbs

In `src/cli/resources/groups.ts`, import the verbs:

```typescript
import { tailscaleVerbs } from '../../tailscale.js';
```

show the flag in `presentConfig`, after `timezone`:

```typescript
    tailscale_socket: !!row.tailscale_socket,
```

and spread the verbs in as the last entry of the `groups` resource's
`customOperations`:

```typescript
    ...tailscaleVerbs,
```

### 9. Build and validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/tailscale.test.ts
```

`src/tailscale.test.ts` drives the real seams: it runs the combined migration
list against a test DB, round-trips the flag through `configFromDb`, calls the
real `buildMounts` and asserts the socket mount is emitted (and is absent for a
group that didn't opt in, and skipped when the host socket is gone), and looks
the two verbs up in the real `ncl` command registry. Each case goes red if its
reach-in is deleted or drifts; `pnpm run build` covers the typed ones.

## Turning it on for a group

Two things per group — the mount and the CLI — then a restart:

```bash
bin/ncl groups config add-package --id <group-id> --apt tailscale
bin/ncl groups config enable-tailscale --id <group-id>
bin/ncl groups restart --id <group-id> --rebuild
```

`--rebuild` is what installs the `tailscale` package into the group's image;
the enable flag alone only adds the mount. Verify from inside the container:

```bash
tailscale status
```

It reports the **host's** tailnet state, because that is whose daemon it is
talking to. `tailscale up` / `down` from the container would reconfigure the
host's connection — tell the agent to treat the CLI as read-plus-reach, not as
its own node.

To turn it off again: `bin/ncl groups config disable-tailscale --id <group-id>`,
then restart the group.

## Configuration

`TAILSCALE_SOCKET_PATH` in `.env` overrides the socket location for a host
whose daemon doesn't listen at `/run/tailscale/tailscaled.sock`. It is read per
spawn, so a change takes effect on the next container start. Inside the
container the socket always appears at the default path, so the CLI finds it
without configuration.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `enable-tailscale` warns that the host socket doesn't exist | tailscaled isn't running on the host, or listens elsewhere — check `systemctl status tailscaled`, then set `TAILSCALE_SOCKET_PATH`. |
| Host log: `tailscaleSocket requested but host socket not found — skipping` | Same cause, hit at spawn time. The container starts without the mount. |
| `tailscale: command not found` in the container | The apt package isn't in the group's image: `ncl groups config add-package --id <group-id> --apt tailscale`, then `ncl groups restart --id <group-id> --rebuild`. |
| `failed to connect to local tailscaled` | The mount is missing — confirm `tailscale_socket` is on (`ncl groups config get --id <group-id>`) and that the group was restarted after enabling. |
| The image build fails resolving the `tailscale` package | The apt-repo step from step 7 isn't wired, or the build cache is stale — prune the builder and rebuild. |
