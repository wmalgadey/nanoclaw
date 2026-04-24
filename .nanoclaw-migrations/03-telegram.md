# Section 3 — Telegram Channel

## Strategy

**Do NOT port the v1 grammY-based implementation to v2.**

The upstream `channels` branch (`upstream/channels`) already contains a
production-quality v2 Telegram adapter (`src/channels/telegram.ts`) built on
`@chat-adapter/telegram` (Chat SDK bridge). It includes:

- Reply context extraction (`extractReplyContext()`)
- Telegram legacy Markdown sanitization (`telegram-markdown-sanitize.ts`)
- Pairing flow for secure chat registration
- Topic/thread support via the Chat SDK bridge
- Retry on cold-start network errors

**Our only missing feature vs upstream v2:** file downloads (photos, videos,
voice, audio, documents → saved to `group/attachments/`).

## How to apply

### Step 1: Merge the `channels` branch

```bash
# In v2 worktree
git merge upstream/channels --no-edit
```

This installs all channel adapters. The Telegram one is at
`src/channels/telegram.ts` and registered in `src/channels/index.ts`.

Set the bot token:
```bash
# In .env
TELEGRAM_BOT_TOKEN=<your-bot-token>
```

### Step 2: Verify topic (thread) support

The upstream v2 Telegram uses the Chat SDK bridge. Check whether
`@chat-adapter/telegram` passes `message_thread_id` through to outbound
delivery. If it does not, add it:

In `src/channels/telegram.ts`, find the `deliver()` method and ensure:
```typescript
// When threadId is set and the chat is a supergroup with topics:
await api.sendMessage(chatId, text, {
  message_thread_id: parseInt(threadId, 10),
  parse_mode: 'Markdown',
});
```

### Step 3: Add file download capability

The upstream v2 Telegram does not download file attachments from Telegram.
Our v1 implementation saved photos, videos, voice, audio, and documents to
`/workspace/group/attachments/` and included the path in the message content.

Add this to the v2 Telegram adapter after the adapter is set up:

**Where:** In `setup()` (or wherever the Chat SDK bot handlers are registered),
add a handler for media messages BEFORE the general text handler.

```typescript
// Helper — add inside telegram.ts
async function downloadTelegramFile(
  token: string,
  fileId: string,
  destDir: string,
  fallbackExt: string
): Promise<string | null> {
  try {
    const metaRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path?: string } };
    if (!meta.ok || !meta.result?.file_path) return null;

    const filePath = meta.result.file_path;
    const ext = filePath.split('.').pop() || fallbackExt;
    const filename = `${fileId}.${ext}`;
    const dest = path.join(destDir, filename);

    const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, buf);
    return `/workspace/group/attachments/${filename}`; // container-relative path
  } catch {
    return null;
  }
}
```

**Note on v2 group folders:** In v2, per-group paths are different from v1
(`groups/<name>/attachments/`). Check how v2 resolves the group folder for
a given `platformId` and use the equivalent path. The container-relative path
format should still work as long as the folder is mounted at `/workspace/group/`.

### Step 4: Verify channel-formatting integration

The v2 `telegram-markdown-sanitize.ts` handles Markdown conversion for Telegram.
The `channel-formatting` skill's `src/text-styles.ts` is broader (all channels).

Do NOT let both run on the same message for Telegram — pick one:
- If the Chat SDK bridge already applies `sanitizeTelegramLegacyMarkdown()`,
  do not also call `parseTextStyles(text, 'telegram')` from the skill.
- If you need the skill's WhatsApp/Slack formatting, keep `text-styles.ts` but
  guard it:
  ```typescript
  if (channel !== 'telegram') {
    text = parseTextStyles(text, channel);
  }
  // telegram is handled by telegram-markdown-sanitize.ts inside the adapter
  ```

### Step 5: Register in channels/index.ts

The `channels` branch merge should add the import. Verify `src/channels/index.ts`
contains:
```typescript
import './telegram.js';
```

## v1 → v2 API mapping

| v1 (grammY) | v2 (Chat SDK bridge) |
|-------------|---------------------|
| `ctx.chat.id` | `platformId` (passed by Chat SDK as `telegram:<chatId>`) |
| `ctx.message.message_thread_id` | `threadId` (passed by Chat SDK) |
| `ctx.message.reply_to_message` | Available in raw Chat SDK message; use `extractReplyContext()` |
| `bot.api.sendMessage()` | `adapter.deliver()` delegates to Chat SDK |
| `bot.api.sendChatAction('typing')` | `adapter.setTyping()` |

## Required package

```bash
pnpm add grammy   # NOT needed — v2 uses @chat-adapter/telegram
```

The `grammy` dependency from v1 `package.json` is **not needed** in v2.
Remove it if present.

## Bot commands (/chatid, /ping)

The v1 `/chatid` command was used to discover chat IDs for group registration.
V2 has a **pairing flow** (`telegram-pairing.ts`) that replaces this.
Follow the v2 pairing instructions to register groups instead of `/chatid`.

The `/ping` command can be added optionally — check if the Chat SDK bridge
supports raw command handlers; if not, it's not critical.
