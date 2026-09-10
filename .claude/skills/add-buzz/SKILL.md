---
name: add-buzz
description: Add the Buzz channel — a native Nostr-relay client that lets one or more agents each speak in a Buzz channel under their own identity. No Chat SDK bridge.
---

# Add Buzz Channel

Buzz is a Nostr-relay-based team chat. This skill adds a native channel adapter
that holds an authenticated WebSocket to the relay, receives `kind:9` messages
that @mention an agent, and publishes replies under that agent's own Nostr
identity.

Each participating agent gets its own keypair, registered as a relay member,
and its own adapter **instance** — so several agents can sit in the same Buzz
channel, each answering only its own mentions and each replying under its own
display name.

The adapter is native: it speaks the relay protocol directly (NIP-42 auth, `REQ`
subscriptions), with no Chat SDK bridge in between.

## Apply

Every step is idempotent — re-running the skill is safe.

### 1. Copy the adapter, its relay client, and its test

```nc:copy
src/channels/buzz.ts
src/channels/buzz-client.ts
src/channels/buzz-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './buzz.js';
```

### 3. Install the adapter packages

Pinned to exact versions — the supply-chain policy rejects ranges and `latest`:

```nc:dep
ws@8.21.1
nostr-tools@2.24.0
```

`ws` ships no types of its own, so the build needs `@types/ws` as a dev
dependency:

```nc:run
pnpm add -D @types/ws@8.18.1
```

### 4. Build and validate

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/buzz-registration.test.ts
```

`buzz-registration.test.ts` imports the real channel barrel and asserts the
registry contains an instance for every configured identity. It goes red if the
import line above is deleted or drifts, if the barrel fails to evaluate, or if
`ws` / `nostr-tools` aren't installed. On an install that has no
`data/buzz-config.json` yet the module registers nothing and the test skips —
the config file is host-local, not something the repo ships.

## Configure

The adapter reads two things: a non-secret instance map at
`data/buzz-config.json`, and one secret per identity in `.env`.

### 1. Create an identity per agent, on the relay host

Each agent needs a keypair that is a **member** of the relay (a closed relay
rejects AUTH from a non-member), and each must be joined to the channel the
agents will share. Using Buzz's own admin tooling: generate a keypair per agent,
add each public key as a member, create or pick the shared channel, join every
identity to it, and set a display-name profile per identity. Keep each secret
key — it goes in `.env` below — and note each public key and the channel UUID.

The operator also joins that channel from their Buzz client, and their own
public key is registered with NanoClaw so their messages arrive as a known
sender:

```bash
bin/ncl users create --id buzz:<operator-pubkey> --kind buzz --display-name <name>
bin/ncl roles grant --user-id buzz:<operator-pubkey> --role owner
```

### 2. Write the instance map

Copy `.claude/skills/add-buzz/buzz-config.example.json` to
`data/buzz-config.json` and fill it in — one entry per identity:

```json
{
  "relayUrl": "ws://buzz.example.ts.net",
  "identities": [
    {
      "instance": "buzz-marvin",
      "envKey": "BUZZ_NSEC_MARVIN",
      "displayName": "Marvin",
      "pubkey": "<64-hex-pubkey>",
      "channels": ["<channel-uuid>"]
    }
  ]
}
```

`instance` is the adapter-instance name used when wiring; `envKey` names the
`.env` key holding that identity's secret; `channels` lists the channel UUIDs it
subscribes to. `relayUrl` must be the **exact** URL the relay expects in the
NIP-42 `relay` tag — same scheme, same host, no trailing path or port it doesn't
use, or the relay rejects auth with a URL mismatch.

### 3. Add the secrets

One key per identity in `.env`, hex or `nsec`, named exactly as its `envKey`:

```
BUZZ_NSEC_MARVIN=<secret-key>
```

An identity whose key is missing registers nothing and stays disabled; the
others still connect.

### 4. Wire each identity to an agent group

One messaging group per identity (same channel UUID, different instance), then a
wiring to the agent group that should answer as that identity:

```bash
bin/ncl messaging-groups create --channel-type buzz --platform-id buzz:<channel-uuid> \
  --instance buzz-marvin --is-group 1 --unknown-sender-policy public --name "Buzz (Marvin)"
bin/ncl wirings create --messaging-group-id <messaging-group-id> --agent-group <agent-group> \
  --engage-mode mention --session-mode shared
```

Then restart the service and post `@<display-name> hello` in the Buzz channel.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Relay rejects auth with a URL mismatch | `relayUrl` doesn't match what the relay expects in the NIP-42 `relay` tag — scheme, host, and port must be exact. |
| `restricted: not a relay member` | The identity's public key was never added as a member, or was added after the adapter connected. |
| No instance appears in the logs at startup | `data/buzz-config.json` is missing or unparseable, or every identity's `envKey` is unset in `.env`. |
| One agent answers mentions meant for another | Two identities share an `instance` name, or a messaging group was created with the wrong `--instance`. |
| The agent replies to itself in a loop | An agent's own pubkey isn't listed as an identity in `buzz-config.json`, so its own messages aren't filtered out. |
| Messages arrive but nothing is routed | No wiring for that messaging group, or the wiring's engage mode never triggers — the adapter delivers only mentions. |
