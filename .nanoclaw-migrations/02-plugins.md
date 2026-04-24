# Section 2 — Custom Plugin System

## Intent

A declarative, TypeScript-first plugin system that installs third-party binaries
(blogwatcher, tailscale) into the agent container image and injects their env vars
at container runtime — without modifying the Dockerfile for each new plugin.

TypeScript is the single source of truth. `scripts/generate-plugin-manifest.ts`
runs before the Docker build and outputs JSON manifests that the Dockerfile reads.

## Files to create / carry over

| File | Purpose |
|------|---------|
| `src/plugins/registry.ts` | Plugin registry (Map-based, de-duplication) |
| `src/plugins/index.ts` | Barrel file triggering self-registration |
| `src/plugins/blogwatcher.ts` | Blogwatcher binary installer |
| `src/plugins/tailscale.ts` | Tailscale binary + env var injector |
| `scripts/generate-plugin-manifest.ts` | TS→JSON manifest generator |
| `container/plugins/tailscale-init.sh` | Container init for Tailscale daemon |
| `container/skills/blogwatcher/SKILL.md` | Agent instructions for blogwatcher CLI |
| `container/skills/tailscale/SKILL.md` | Agent instructions for Tailscale VPN |

**How to apply:** Copy these files verbatim from the v1 tree. They are
self-contained and do not depend on v1-only APIs.

## Plugin registry interface

```typescript
// src/plugins/registry.ts
export interface BinaryInstall {
  url?: string;            // Direct binary URL (wget + chmod +x)
  dest?: string;           // Destination path in container (e.g. /usr/local/bin/blogwatcher)
  archive?: string;        // .tgz archive URL
  extract?: string[];      // Filenames to extract from archive
  stripComponents?: number; // tar --strip-components=N (needed when archive has top-level dir)
}

export interface Plugin {
  name: string;
  containerEnvKeys?: string[];     // Env vars injected via docker --env-file
  binaryInstall?: BinaryInstall;
  containerDirectories?: string[]; // Pre-create dirs with node:node ownership
}

const registry = new Map<string, Plugin>();

export function registerPlugin(plugin: Plugin): void {
  registry.set(plugin.name, plugin);
}
export function getAllPlugins(): Plugin[] { return [...registry.values()]; }
export function getPluginContainerEnvKeys(): string[] {
  return [...registry.values()].flatMap((p) => p.containerEnvKeys ?? []);
}
export function getPluginContainerEnv(env: Record<string, string>): Record<string, string> {
  const keys = new Set(getPluginContainerEnvKeys());
  return Object.fromEntries(Object.entries(env).filter(([k]) => keys.has(k)));
}
```

## Blogwatcher plugin

```typescript
// src/plugins/blogwatcher.ts
import { registerPlugin } from './registry.js';
registerPlugin({
  name: 'blogwatcher',
  binaryInstall: {
    archive: 'https://github.com/Hyaxia/blogwatcher/releases/download/v0.0.2/blogwatcher_0.0.2_linux_amd64.tar.gz',
    extract: ['blogwatcher'],
    dest: '/usr/local/bin/blogwatcher',
  },
});
```

## Tailscale plugin

```typescript
// src/plugins/tailscale.ts
import { registerPlugin } from './registry.js';
registerPlugin({
  name: 'tailscale',
  containerEnvKeys: ['TAILSCALE_AUTH_KEY', 'TAILSCALE_HOSTNAME'],
  containerDirectories: ['/var/run/tailscale'],
  binaryInstall: {
    archive: 'https://pkgs.tailscale.com/stable/tailscale_1.96.4_amd64.tgz',
    extract: ['tailscale', 'tailscaled'],
    dest: '/usr/local/bin/',
    stripComponents: 1,
  },
});
```

## Manifest generator

```typescript
// scripts/generate-plugin-manifest.ts
// Import plugins to trigger registerPlugin() calls
import '../src/plugins/index.js';
import { getAllPlugins } from '../src/plugins/registry.js';
import fs from 'fs';

const plugins = getAllPlugins();

const binaries = plugins
  .filter((p) => p.binaryInstall)
  .map((p) => ({ name: p.name, ...p.binaryInstall }));

const directories = plugins
  .flatMap((p) => p.containerDirectories ?? [])
  .filter(Boolean);

fs.writeFileSync('container/plugins/binaries.json', JSON.stringify(binaries, null, 2));
fs.writeFileSync('container/plugins/directories.json', JSON.stringify(directories, null, 2));
console.log(`Generated ${binaries.length} plugin(s), ${directories.length} director(ies)`);
```

## Tailscale container init script

```bash
# container/plugins/tailscale-init.sh
if [ -n "${TAILSCALE_AUTH_KEY:-}" ]; then
  tailscaled \
    --state=mem: \
    --tun=userspace-networking \
    --socket=/tmp/tailscale.sock \
    &>/dev/null &
  sleep 1
  tailscale up \
    --authkey="$TAILSCALE_AUTH_KEY" \
    --hostname="${TAILSCALE_HOSTNAME:-nanoclaw-agent}" \
    --accept-routes \
    --timeout=10s \
    --socket=/tmp/tailscale.sock \
    2>&1 || true
fi
```

## Integration with container-runner.ts

In v2's `src/container-runner.ts` (or equivalent), add plugin env injection.
The v1 pattern: write plugin env vars to a temp file with mode 0o600, then
pass via `--env-file` to docker run (never via `-e` to avoid exposure in
process listing).

```typescript
// Add near the top of container-runner.ts
import './plugins/index.js';
import { getPluginContainerEnv } from './plugins/registry.js';

// In buildContainerArgs() or wherever docker run args are assembled:
const rawEnv = readEnvFile(); // your existing env-reading logic
const pluginEnv = getPluginContainerEnv(rawEnv);
if (Object.keys(pluginEnv).length > 0) {
  const tmpDir = fs.mkdtempSync(path.join(DATA_DIR, 'plugin-env-'));
  const envFilePath = path.join(tmpDir, 'env');
  const contents = Object.entries(pluginEnv)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n');
  fs.writeFileSync(envFilePath, contents, { mode: 0o600 });
  args.push('--env-file', envFilePath);
}
```

**Note on v2:** Check whether v2's container runner already has an env injection
mechanism. If so, integrate plugin env into that flow rather than adding a
parallel path.

## Integration with Dockerfile

Add a plugin installation stage after the main npm install:

```dockerfile
# syntax=docker/dockerfile:1

# Copy plugin manifests
COPY container/plugins/binaries.json /tmp/plugins.json
COPY container/plugins/directories.json /tmp/plugins-dirs.json
COPY container/plugins/ /app/plugins/

# Install plugin binaries
RUN node -e "
const { execFileSync } = require('child_process');
const fs = require('fs');
const plugins = JSON.parse(fs.readFileSync('/tmp/plugins.json', 'utf8'));
for (const p of plugins) {
  if (p.archive) {
    const archivePath = '/tmp/' + p.name + '.tgz';
    execFileSync('curl', ['-sSL', p.archive, '-o', archivePath]);
    const stripComponents = p.stripComponents ?? 0;
    const tarArgs = ['xzf', archivePath, '--strip-components=' + stripComponents, '-C', '/usr/local/bin/'];
    // When stripComponents > 0, do NOT add file selectors — they must match full archive path
    if (stripComponents === 0) { for (const f of p.extract) { tarArgs.push(f); } }
    execFileSync('tar', tarArgs, { stdio: 'inherit' });
    for (const f of p.extract) {
      execFileSync('chmod', ['+x', '/usr/local/bin/' + f]);
    }
  } else if (p.url) {
    execFileSync('curl', ['-sSL', p.url, '-o', p.dest]);
    execFileSync('chmod', ['+x', p.dest]);
  }
}
"

# Pre-create plugin directories
RUN node -e "
const fs = require('fs');
const { execFileSync } = require('child_process');
const dirs = JSON.parse(fs.readFileSync('/tmp/plugins-dirs.json', 'utf8'));
for (const d of dirs) {
  fs.mkdirSync(d, { recursive: true });
  execFileSync('chown', ['node:node', d]);
}
"
```

## Integration with entrypoint.sh

Source all `*-init.sh` files before the agent starts:

```bash
# In container/entrypoint.sh, before exec node ...
for f in /app/plugins/*-init.sh; do
  [ -f "$f" ] && . "$f"
done
```

## Build script: call manifest generator before docker build

```bash
# In container/build.sh, before the docker build call:
echo "Generating plugin manifest..."
(cd "$PROJECT_DIR" && npx tsx scripts/generate-plugin-manifest.ts)
```
