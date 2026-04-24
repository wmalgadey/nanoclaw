# Section 5 — Host Source Changes

## 5.1 /new-session command

### Intent

Allow users (or the device owner) to manually clear the current conversation
session without restarting the agent. The next message starts fresh.

In v1:
- Command recognized by the host (`src/index.ts`) before forwarding to agent
- Clears the stored `sessionId` for the group
- Sends a `{type: "reset"}` IPC message to the running container so the
  agent-runner clears its in-memory state
- Main group: any sender can use it; `/new-session <folder>` lets the device
  owner reset another group's session
- Non-main groups: device owner only

### v2 implementation

**Before implementing:** Read how v2 sessions work (`docs/db-session.md` in
upstream v2). V2 uses `inbound.db` + `outbound.db` per session (not shared).
The reset mechanism is different — clearing a session likely means deleting or
archiving the session DBs and letting a new container start fresh.

**Steps:**
1. Find where v2 handles command messages (check `src/index.ts` or `src/router.ts`)
2. Add a `/new-session` handler that:
   - Verifies sender authorization (owner for non-main groups)
   - Marks the session for reset in the central DB
   - Stops the running container if active
   - The next inbound message will create a new session DB and start fresh
3. Send a confirmation message back to the chat

### v1 code for reference

```typescript
// In src/index.ts — command detection before routing:
if (message.content.trim() === '/new-session') {
  if (!isOwner && !isMainGroup) {
    await channel.sendMessage(chatJid, 'Only the device owner can reset sessions.');
    return;
  }
  await db.clearSession(groupName);
  // Signal running container to reset its state
  await ipc.sendToContainer(groupName, { type: 'reset' });
  await channel.sendMessage(chatJid, 'Session cleared. Next message starts fresh.');
  return;
}
```

### v1 agent-runner side (agent-runner/src/index.ts)

```typescript
// Handles {type: "reset"} from IPC queue:
case 'reset':
  sessionId = undefined;
  resumeAt = undefined;
  pendingReset = true;  // Applied before next Claude API call
  break;
```

## 5.2 CONTAINER_IMAGE env var support

### Intent

After `./container/build.sh` runs, it writes the new image tag (e.g.
`nanoclaw-agent:20260412-193045`) to `.env` as `CONTAINER_IMAGE`. The host
reads this so it always uses the most recently built image without manual edits.

### How to apply

In v2's `src/config.ts` or `src/env.ts`, add:

```typescript
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE ?? readEnvFile().CONTAINER_IMAGE ?? 'nanoclaw-agent:latest';
```

Then in `src/container-runner.ts`, use `CONTAINER_IMAGE` as the image argument
to `docker run` instead of a hardcoded `'nanoclaw-agent:latest'`.

## 5.3 channel-formatting in router

### Intent

Apply channel-native text formatting (Markdown → WhatsApp/Slack/Telegram native
syntax) at the routing layer so all channels get appropriate output without
each channel reimplementing it.

### v1 change to src/router.ts

```typescript
import { parseTextStyles } from './text-styles.js';

export function formatOutbound(rawText: string, channel?: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return channel ? parseTextStyles(text, channel as ChannelType) : text;
}
```

And in `src/index.ts`, pass the channel name when calling `formatOutbound`:

```typescript
const text = formatOutbound(rawText, channel.name); // was: formatOutbound(rawText)
```

### v2 note

V2's channel adapters may already handle their own formatting (Telegram's
`sanitizeTelegramLegacyMarkdown` runs inside the adapter). Check whether
`parseTextStyles()` from the channel-formatting skill is still needed for
channels not handled by the Chat SDK bridge (WhatsApp, Slack, etc.).
If yes, apply this change. If the skill's `text-styles.ts` conflicts with
Chat SDK's formatting, keep only the skill for non-Chat-SDK channels.
