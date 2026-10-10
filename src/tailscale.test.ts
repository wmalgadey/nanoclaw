/**
 * The Tailscale host-socket passthrough, tested through the core seams it
 * reaches into rather than through its own helpers: the migration runs in the
 * real combined list, the flag survives the DB → `container.json` round trip,
 * the real `buildMounts` emits the mount, and the real `ncl` registry carries
 * the two verbs. Each case goes red if its reach-in is deleted or drifts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Composing the group's instructions needs the central DB and is not what is
// under test; every path it would write is created below instead.
vi.mock('./project-doc-compose.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./project-doc-compose.js')>()),
  composeGroupProjectDoc: vi.fn(),
}));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import './cli/commands/index.js'; // the real ncl barrel — triggers every resource's registration
import { lookup } from './cli/registry.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { configFromDb, type ContainerConfig } from './container-config.js';
import { buildMounts } from './container-runner.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import { DEFAULT_TAILSCALE_SOCKET_PATH, tailscaleAptRepo, tailscaleMounts } from './tailscale.js';
import type { AgentGroup, Session } from './types.js';

const GROUP: AgentGroup = {
  id: 'ag-tailscale',
  name: 'Tailscale',
  folder: 'tailscale-test',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

describe('tailscale_socket column', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await createAgentGroup(GROUP);
    await ensureContainerConfig(GROUP.id);
  });
  afterEach(async () => {
    await closeDb();
  });

  it('is created by the combined migration list and defaults off', async () => {
    expect((await getContainerConfig(GROUP.id))!.tailscale_socket).toBe(0);
    expect(configFromDb((await getContainerConfig(GROUP.id))!, GROUP).tailscaleSocket).toBeUndefined();
  });

  it('round-trips the opt-in through the DB into the materialized config', async () => {
    await updateContainerConfigScalars(GROUP.id, { tailscale_socket: 1 });
    expect(configFromDb((await getContainerConfig(GROUP.id))!, GROUP).tailscaleSocket).toBe(true);

    // Off stays absent rather than `false`, so container.json for a group that
    // never opted in reads exactly as it did before the column existed.
    await updateContainerConfigScalars(GROUP.id, { tailscale_socket: 0 });
    expect(configFromDb((await getContainerConfig(GROUP.id))!, GROUP).tailscaleSocket).toBeUndefined();
  });
});

describe('buildMounts', () => {
  const session = { id: 'sess-tailscale', agent_group_id: GROUP.id, agent_provider: null } as Session;
  const groupDir = path.resolve(GROUPS_DIR, GROUP.folder);
  const sessionDir = path.join(DATA_DIR, 'v2-sessions', GROUP.id, session.id);
  const base = {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: [],
  } as unknown as ContainerConfig;

  // A regular file stands in for the host socket: the mount builder gates on
  // existence, and a real AF_UNIX socket adds nothing the check can see.
  let fakeSocket: string;

  beforeAll(() => {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'v2-sessions', GROUP.id, '.claude-shared'), { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'plugins'), { recursive: true });
    fakeSocket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tailscale-')), 'tailscaled.sock');
    fs.writeFileSync(fakeSocket, '');
    process.env.TAILSCALE_SOCKET_PATH = fakeSocket;
  });

  afterAll(() => {
    delete process.env.TAILSCALE_SOCKET_PATH;
    fs.rmSync(path.dirname(fakeSocket), { recursive: true, force: true });
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'v2-sessions', GROUP.id), { recursive: true, force: true });
  });

  const mountsFor = (config: ContainerConfig) => buildMounts(GROUP, session, config, 'claude', {});
  const tailscaleMount = (mounts: Awaited<ReturnType<typeof mountsFor>>) =>
    mounts.find((m) => m.containerPath === DEFAULT_TAILSCALE_SOCKET_PATH);

  it('mounts the host socket for a group that opted in', async () => {
    const mount = tailscaleMount(await mountsFor({ ...base, tailscaleSocket: true }));
    expect(mount).toEqual({
      hostPath: fakeSocket,
      containerPath: DEFAULT_TAILSCALE_SOCKET_PATH,
      readonly: false,
    });
  });

  it('emits nothing for a group that did not', async () => {
    expect(tailscaleMount(await mountsFor(base))).toBeUndefined();
  });

  it('skips the mount rather than failing the spawn when the host socket is gone', () => {
    process.env.TAILSCALE_SOCKET_PATH = path.join(path.dirname(fakeSocket), 'absent.sock');
    try {
      expect(tailscaleMounts({ ...base, tailscaleSocket: true })).toEqual([]);
    } finally {
      process.env.TAILSCALE_SOCKET_PATH = fakeSocket;
    }
  });
});

describe('per-group image build', () => {
  it('adds Tailscale’s apt repo only when the group installs the package', () => {
    expect(tailscaleAptRepo(['curl'])).toBe('');
    const step = tailscaleAptRepo(['curl', 'tailscale']);
    expect(step.startsWith('RUN ')).toBe(true);
    expect(step).toContain('pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list');
    expect(step.endsWith('\n')).toBe(true);
  });

  it('is wired into the Dockerfile the image builder writes', () => {
    // `buildAgentGroupImage` shells the Docker daemon, so the wiring is checked
    // at the source: the repo step must be emitted from the apt branch, ahead
    // of the install line that would otherwise fail on Debian's own repos.
    const source = fs.readFileSync(path.join(import.meta.dirname, 'container-runner.ts'), 'utf-8');
    expect(source).toMatch(/dockerfile \+= tailscaleAptRepo\(aptPackages\)/);
    expect(source.indexOf('tailscaleAptRepo(aptPackages)')).toBeLessThan(source.indexOf('apt-get install -y'));
  });
});

describe('ncl verbs', () => {
  it('are registered on the real command registry', () => {
    for (const name of ['groups-config-enable-tailscale', 'groups-config-disable-tailscale']) {
      const command = lookup(name);
      expect(command, `${name} is not registered`).toBeDefined();
      // Mounting a host path is a filesystem-access boundary: operator-only,
      // never runnable from inside a container.
      expect(command!.hostOnly).toBe(true);
    }
  });
});
