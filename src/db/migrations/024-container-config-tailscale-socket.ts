import type { Migration } from './index.js';

/**
 * Per-agent-group opt-in for the Tailscale host-socket passthrough on
 * `container_configs`.
 *
 * 0 = off, matching pre-migration behavior for every existing row —
 * deliberately no backfill. 1 mounts the host's `/run/tailscale/tailscaled.sock`
 * into the group's containers at spawn (`buildMounts` in container-runner.ts),
 * so the agent's `tailscale` CLI drives the HOST daemon: no auth key, no
 * tailscaled, no NET_ADMIN inside the container.
 *
 * The flag existed on the `ContainerConfig` TYPE and was honored by the mount
 * builder since the feature landed, but nothing ever set it — no column, no
 * write path, and `materializeContainerJson` rewrites container.json from the
 * DB on every spawn, so a hand-edited file was wiped. This column is the
 * missing half.
 *
 * Mounting a host path is a filesystem-access boundary, so the write path
 * (`ncl groups config enable-tailscale`) is hostOnly — operator-only, never
 * reachable from inside a container, same as `config add-mount`.
 */
export const migration024: Migration = {
  version: 24,
  name: 'container-config-tailscale-socket',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN tailscale_socket INTEGER NOT NULL DEFAULT 0;`);
  },
};
