/**
 * Buzz channel adapter — native Nostr client, no Chat SDK bridge.
 *
 * Buzz (buzz.xyz) is a Nostr-relay-based team chat: channels are
 * `kind:9` events tagged `["h", <channel-uuid>]`, and @mentions are
 * `["p", <pubkey>]` tags. Each nanoclaw agent that should participate gets
 * its own Nostr keypair — a Buzz "identity" — registered as a relay member.
 * One `instance` per identity, so N agents can each speak under their own
 * name in the same (or different) Buzz channels.
 *
 * Config: `data/buzz-config.json` lists the relay URL and each identity's
 * instance name, display name, pubkey, and subscribed channel UUIDs.
 * Secrets (nsec/hex) live in `.env`, one key per identity, referenced by
 * `envKey`. An identity whose env key is unset stays disabled — its
 * factory returns null, mirroring how telegram.ts handles a missing token.
 */
import fs from 'fs';
import path from 'path';

import type { NostrEvent } from 'nostr-tools';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { getUser } from '../modules/permissions/db/users.js';
import { BuzzRelayClient } from './buzz-client.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';

const PLATFORM_PREFIX = 'buzz:';
const MAX_SEEN_IDS = 500;

/**
 * Every inbound event already passed the relay's `#p:[our-pubkey]` filter,
 * so it's a mention by construction. Buzz channels are the group-chat unit
 * (no separate DM concept in this integration) — mention-gated engagement
 * keeps agents from replying to every message in a shared channel.
 */
const BUZZ_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

interface BuzzIdentityConfig {
  instance: string;
  envKey: string;
  displayName: string;
  pubkey: string;
  channels: string[];
}

interface BuzzConfigFile {
  relayUrl: string;
  identities: BuzzIdentityConfig[];
}

function loadBuzzConfig(): BuzzConfigFile | null {
  const configPath = path.join(DATA_DIR, 'buzz-config.json');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    log.debug('Buzz config not found, channel disabled', { configPath });
    return null;
  }
  try {
    return JSON.parse(raw) as BuzzConfigFile;
  } catch (err) {
    log.warn('Buzz config is not valid JSON, channel disabled', { configPath, err });
    return null;
  }
}

function extractChannelId(event: NostrEvent): string | null {
  const tag = event.tags.find((t) => t[0] === 'h');
  return tag?.[1] ?? null;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

/** Resolve a display name for an inbound sender: known identity, then the
 *  nanoclaw user registry, then a short pubkey. Async since central DB reads
 *  go through the DbDriver seam. */
async function resolveSenderName(config: BuzzConfigFile, pubkey: string): Promise<string> {
  const identity = config.identities.find((i) => i.pubkey === pubkey);
  if (identity) return identity.displayName;
  const user = await getUser(`${PLATFORM_PREFIX}${pubkey}`);
  if (user?.display_name) return user.display_name;
  return pubkey.slice(0, 8);
}

/** Small capped FIFO set — dedups reconnect-replayed events without growing forever. */
class SeenIds {
  private readonly set = new Set<string>();
  private readonly order: string[] = [];

  has(id: string): boolean {
    return this.set.has(id);
  }

  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.order.push(id);
    if (this.order.length > MAX_SEEN_IDS) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.set.delete(oldest);
    }
  }
}

function makeBuzzAdapter(
  identity: BuzzIdentityConfig,
  relayUrl: string,
  secret: string,
  managedPubkeys: Set<string>,
  config: BuzzConfigFile,
): ChannelAdapter {
  const client = new BuzzRelayClient(relayUrl, secret, identity.instance);
  const seen = new SeenIds();

  return {
    name: 'buzz',
    channelType: 'buzz',
    instance: identity.instance,
    supportsThreads: false,
    defaults: BUZZ_DEFAULTS,

    async setup(hostConfig: ChannelSetup): Promise<void> {
      await client.connect();
      for (const channelId of identity.channels) {
        client.subscribe(`ch-${channelId}`, [{ kinds: [9], '#h': [channelId], '#p': [identity.pubkey] }], (event) => {
          // Loop guard: never react to another managed identity's own posts.
          if (managedPubkeys.has(event.pubkey)) return;
          if (seen.has(event.id)) return;
          seen.add(event.id);

          const uuid = extractChannelId(event) ?? channelId;
          // Sender resolution hits the central DB, which is async behind
          // DbDriver. The relay client's callback is sync and ignores a
          // returned promise, so dispatch in a detached task and log its
          // failure here rather than surfacing an unhandled rejection.
          void (async () => {
            await hostConfig.onInbound(`${PLATFORM_PREFIX}${uuid}`, null, {
              id: event.id,
              kind: 'chat',
              timestamp: new Date(event.created_at * 1000).toISOString(),
              content: {
                text: event.content,
                sender: await resolveSenderName(config, event.pubkey),
                senderId: `${PLATFORM_PREFIX}${event.pubkey}`,
              },
              isMention: true,
              isGroup: true,
            });
          })().catch((err) => {
            log.error('Buzz inbound dispatch failed', { eventId: event.id, error: String(err) });
          });
        });
      }
    },

    async teardown(): Promise<void> {
      client.close();
    },

    isConnected(): boolean {
      return client.isConnected();
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!platformId.startsWith(PLATFORM_PREFIX)) return undefined;
      const text = extractText(message);
      if (text === null) return undefined;
      const uuid = platformId.slice(PLATFORM_PREFIX.length);
      return client.publish({ kind: 9, content: text, tags: [['h', uuid]] });
    },
  };
}

const buzzConfig = loadBuzzConfig();

if (buzzConfig) {
  const managedPubkeys = new Set(buzzConfig.identities.map((i) => i.pubkey));
  for (const identity of buzzConfig.identities) {
    registerChannelAdapter(identity.instance, {
      factory: () => {
        const env = readEnvFile([identity.envKey]);
        const secret = env[identity.envKey];
        if (!secret) return null;
        return makeBuzzAdapter(identity, buzzConfig.relayUrl, secret, managedPubkeys, buzzConfig);
      },
      defaults: BUZZ_DEFAULTS,
    });
  }
}
