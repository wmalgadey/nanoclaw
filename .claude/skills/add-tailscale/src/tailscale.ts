/**
 * Tailscale host-socket passthrough.
 *
 * An agent group that opts in gets the host's tailscaled control socket
 * bind-mounted into its containers, so the agent's `tailscale` CLI drives the
 * HOST daemon: no auth key, no `tailscaled`, and no `NET_ADMIN` inside the
 * container. The group still needs the `tailscale` apt package for the CLI
 * itself (`ncl groups config add-package --apt tailscale`), which is why this
 * module also owns the apt-repo lines that package needs.
 *
 * Everything the feature is lives here — the socket path, the mount
 * contribution, the Dockerfile repo step, and the two `ncl groups config`
 * verbs. Core only calls in.
 */
// Side-effect import: self-registers the tailscale_socket column migration
// via the module-migration seam. See db/migrations/tailscale-container-config-socket.ts.
import './db/migrations/tailscale-container-config-socket.js';

import fs from 'fs';

import { getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import type { CustomOperation } from './cli/crud.js';
import type { ContainerConfig } from './container-config.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

/** Where tailscaled listens on a standard Linux install. */
export const DEFAULT_TAILSCALE_SOCKET_PATH = '/run/tailscale/tailscaled.sock';

/**
 * The host socket to pass through. `TAILSCALE_SOCKET_PATH` in `.env` overrides
 * the default for installs whose daemon listens elsewhere; resolved per call so
 * an operator editing `.env` doesn't need a host restart to take effect.
 */
export function tailscaleSocketPath(): string {
  return (
    process.env.TAILSCALE_SOCKET_PATH ||
    readEnvFile(['TAILSCALE_SOCKET_PATH']).TAILSCALE_SOCKET_PATH ||
    DEFAULT_TAILSCALE_SOCKET_PATH
  );
}

/**
 * The group's Tailscale mount, or none. A missing host socket is not fatal —
 * the mount is skipped with a warning, so a group that opted in still spawns on
 * a host where tailscaled happens to be down.
 */
export function tailscaleMounts(containerConfig: ContainerConfig): VolumeMount[] {
  if (!containerConfig.tailscaleSocket) return [];

  const socketPath = tailscaleSocketPath();
  if (!fs.existsSync(socketPath)) {
    log.warn('tailscaleSocket requested but host socket not found — skipping', { path: socketPath });
    return [];
  }
  return [{ hostPath: socketPath, containerPath: DEFAULT_TAILSCALE_SOCKET_PATH, readonly: false }];
}

/**
 * Dockerfile lines that add Tailscale's apt repo, for a per-group image build
 * whose package list includes `tailscale`. Debian's own repos don't carry it,
 * so a plain `apt-get install tailscale` fails; this RUN step lands before the
 * install line. Empty string when the group isn't installing Tailscale.
 */
export function tailscaleAptRepo(aptPackages: readonly string[]): string {
  if (!aptPackages.includes('tailscale')) return '';
  return (
    'RUN ' +
    [
      'curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg',
      '  | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null',
      '&& curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list',
      '  | tee /etc/apt/sources.list.d/tailscale.list',
    ].join(' \\\n    ') +
    '\n'
  );
}

/**
 * `ncl groups config enable-tailscale` / `disable-tailscale`, spread into the
 * `groups` resource's custom operations.
 *
 * Both are `hostOnly`: mounting a host path is a filesystem-access boundary, so
 * this is operator-only and never runnable from inside a container — the same
 * reasoning as `config add-mount`.
 */
export const tailscaleVerbs: Record<string, CustomOperation> = {
  'config enable-tailscale': {
    access: 'approval',
    hostOnly: true,
    description:
      "Mount the host's tailscaled socket into a group's containers, so the agent's `tailscale` CLI drives the " +
      'HOST daemon (no auth key, no tailscaled, no NET_ADMIN in the container). OPERATOR-ONLY — mounting a host ' +
      'path is a filesystem-access boundary, same as `config add-mount`. The group also needs the `tailscale` apt ' +
      'package (`ncl groups config add-package --apt tailscale`). Requires `ncl groups restart` to take effect. ' +
      'Use --id <group-id>.',
    handler: async (args) => {
      const id = args.id as string;
      if (!id) throw new Error('--id is required');
      if (!(await getContainerConfig(id))) throw new Error(`No container config for group: ${id}`);

      await updateContainerConfigScalars(id, { tailscale_socket: 1 });

      // The mount builder skips a missing socket with a spawn-time log line;
      // surface it here instead, where the operator can act on it.
      const socketPath = tailscaleSocketPath();
      const warning = fs.existsSync(socketPath)
        ? undefined
        : `Host socket ${socketPath} does not exist — the mount will be skipped at spawn until tailscaled is running.`;

      return {
        tailscale_socket: true,
        note: `Run \`ncl groups restart --id ${id}\` for the mount to take effect.`,
        ...(warning ? { warning } : {}),
      };
    },
  },
  'config disable-tailscale': {
    access: 'approval',
    hostOnly: true,
    description:
      "Stop mounting the host's tailscaled socket into a group's containers. OPERATOR-ONLY. Requires " +
      '`ncl groups restart` to take effect. Use --id <group-id>.',
    handler: async (args) => {
      const id = args.id as string;
      if (!id) throw new Error('--id is required');
      if (!(await getContainerConfig(id))) throw new Error(`No container config for group: ${id}`);

      await updateContainerConfigScalars(id, { tailscale_socket: 0 });
      return {
        tailscale_socket: false,
        note: `Run \`ncl groups restart --id ${id}\` to apply.`,
      };
    },
  },
};
