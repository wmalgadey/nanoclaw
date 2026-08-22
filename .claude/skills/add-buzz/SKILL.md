---
name: add-buzz
description: Add the Buzz (Nostr relay) channel adapter. Locally authored — its source lives in this repo, not on the channels registry branch.
---

# Add Buzz Channel

Adds the Buzz channel adapter, which speaks to Nostr relays over a WebSocket and
maps relay events onto NanoClaw messaging groups.

Buzz is **locally authored**. Unlike the registry channels (`/add-telegram`,
`/add-slack`, ...), its adapter source is maintained directly in this repository
and has no copy on the `channels` branch. This skill therefore declares no
`nc:copy` fence: an update refresh re-pins the adapter's dependencies and
verifies its registration, but never overwrites `src/channels/buzz*.ts`.

Source files, all tracked in-tree:

- `src/channels/buzz.ts` — the adapter and its `registerChannelAdapter()` call
- `src/channels/buzz-client.ts` — relay WebSocket client
- `src/channels/buzz-registration.test.ts` — asserts the barrel registers `buzz`

### 1. Register the adapter

The channel barrel self-registers the adapter on import:

```nc:append to:src/channels/index.ts
import './buzz.js';
```

### 2. Install the adapter packages

Pinned to exact versions — the supply-chain policy rejects ranges and `latest`:

```nc:dep
ws@8.21.1
nostr-tools@2.24.0
```

`@types/ws` is a dev-only type package and stays in `devDependencies`; it is
deliberately not declared here, since a `nc:dep` fence installs into
`dependencies`.

### 3. Build and validate

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/buzz-registration.test.ts
```

`buzz-registration.test.ts` imports the real channel barrel and asserts the
registry contains `buzz`. It goes red if the import line above is deleted or
drifts, or if the barrel fails to evaluate.
