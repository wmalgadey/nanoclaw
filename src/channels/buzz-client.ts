/**
 * Minimal Nostr WebSocket client for the Buzz relay — NIP-42 auth, REQ
 * subscriptions, and event publishing. Template: `~/buzz/crates/buzz-ws-client/src/connection.rs`.
 *
 * Transport only: dedup, self-ignore, and channel/mention filtering live in
 * the adapter (buzz.ts). This class just gets signed events on and off the
 * wire and keeps the connection alive.
 */
import { EventEmitter } from 'node:events';

import { WebSocket } from 'ws';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import type { NostrEvent } from 'nostr-tools';

import { log } from '../log.js';

const AUTH_CHALLENGE_TIMEOUT_MS = 20_000;
const AUTH_OK_TIMEOUT_MS = 20_000;
const PUBLISH_OK_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

export interface OkResponse {
  accepted: boolean;
  message: string;
}

/** Kind:9 message tags builder — h (channel), optional NIP-10 e-tags, p mentions. */
export interface OutboundEventTemplate {
  kind: number;
  content: string;
  tags: string[][];
}

/** Decode a Buzz/Nostr secret key given as 64-char hex or nsec1... bech32. */
function decodeSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') {
      throw new Error('Buzz secret key: expected an nsec1... value');
    }
    return decoded.data;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  throw new Error('Buzz secret key must be 64-char hex or nsec1...');
}

interface Subscription {
  filters: Record<string, unknown>[];
  onEvent: (event: NostrEvent) => void;
}

export class BuzzRelayClient {
  readonly pubkey: string;
  private readonly secretKey: Uint8Array;
  private readonly relayUrl: string;
  private readonly label: string;
  private readonly emitter = new EventEmitter();
  private readonly subs = new Map<string, Subscription>();

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private backoffMs = 1000;
  private lastAuthChallenge: string | null = null;
  private lastEventTs = 0;

  constructor(relayUrl: string, secretKeyRaw: string, label: string) {
    this.relayUrl = relayUrl;
    this.secretKey = decodeSecretKey(secretKeyRaw);
    this.pubkey = getPublicKey(this.secretKey);
    this.label = label;
    // AUTH/OK waiters can pile up if the relay is slow; raise the default cap
    // rather than let Node warn about a "leak" on a busy multi-subscription client.
    this.emitter.setMaxListeners(50);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    await this.openAndAuthenticate();
    this.backoffMs = 1000;
  }

  /** Register (or replace) a subscription. Sends REQ immediately if connected. */
  subscribe(subId: string, filters: Record<string, unknown>[], onEvent: (event: NostrEvent) => void): void {
    this.subs.set(subId, { filters, onEvent });
    if (this.connected) this.sendReq(subId, filters);
  }

  /** Sign and publish an event as this identity. Returns the event id. */
  async publish(template: OutboundEventTemplate): Promise<string> {
    if (!this.ws || !this.connected) {
      throw new Error(`Buzz relay (${this.label}) is not connected`);
    }
    const event = finalizeEvent(
      {
        kind: template.kind,
        content: template.content,
        tags: template.tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      this.secretKey,
    );
    const okPromise = this.waitForOk(event.id, PUBLISH_OK_TIMEOUT_MS);
    this.sendRaw(['EVENT', event]);
    const ok = await okPromise;
    if (!ok.accepted) {
      throw new Error(`Buzz relay (${this.label}) rejected publish: ${ok.message}`);
    }
    return event.id;
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    try {
      this.ws?.close();
    } catch {
      // best-effort
    }
    this.ws = null;
  }

  private async openAndAuthenticate(): Promise<void> {
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;
    this.connected = false;

    ws.on('message', (data) => this.handleMessage(data.toString()));
    ws.on('close', () => this.handleClose());
    ws.on('error', (err) => {
      log.warn('Buzz relay socket error', { instance: this.label, err });
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Buzz relay connect timed out')), CONNECT_TIMEOUT_MS);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    await this.authenticate();
    this.connected = true;
  }

  private async authenticate(): Promise<void> {
    const challenge = await this.waitForAuthChallenge(AUTH_CHALLENGE_TIMEOUT_MS);
    const authEvent = finalizeEvent(
      {
        kind: 22242,
        content: '',
        tags: [
          ['challenge', challenge],
          ['relay', this.relayUrl],
        ],
        created_at: Math.floor(Date.now() / 1000),
      },
      this.secretKey,
    );
    const okPromise = this.waitForOk(authEvent.id, AUTH_OK_TIMEOUT_MS);
    this.sendRaw(['AUTH', authEvent]);
    const ok = await okPromise;
    if (!ok.accepted) {
      throw new Error(`Buzz relay (${this.label}) NIP-42 auth rejected: ${ok.message}`);
    }
    log.info('Buzz relay authenticated', { instance: this.label, pubkey: this.pubkey });
  }

  private handleClose(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    if (this.closed) return;
    if (wasConnected) {
      log.warn('Buzz relay connection lost, reconnecting', { instance: this.label });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => {
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    try {
      await this.openAndAuthenticate();
      this.backoffMs = 1000;
      this.resubscribeAll();
      log.info('Buzz relay reconnected', { instance: this.label });
    } catch (err) {
      log.warn('Buzz relay reconnect attempt failed, retrying', { instance: this.label, err });
      this.scheduleReconnect();
    }
  }

  private resubscribeAll(): void {
    const since = this.lastEventTs > 0 ? Math.max(0, this.lastEventTs - 60) : undefined;
    for (const [subId, sub] of this.subs) {
      const filters = since !== undefined ? sub.filters.map((f) => ({ ...f, since })) : sub.filters;
      this.sendReq(subId, filters);
    }
  }

  private sendReq(subId: string, filters: Record<string, unknown>[]): void {
    this.sendRaw(['REQ', subId, ...filters]);
  }

  private sendRaw(payload: unknown[]): void {
    if (!this.ws) throw new Error(`Buzz relay (${this.label}) socket not open`);
    this.ws.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let arr: unknown[];
    try {
      arr = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(arr) || typeof arr[0] !== 'string') return;

    switch (arr[0]) {
      case 'AUTH': {
        const challenge = arr[1];
        if (typeof challenge !== 'string') return;
        this.lastAuthChallenge = challenge;
        this.emitter.emit('auth', challenge);
        break;
      }
      case 'OK': {
        const eventId = arr[1];
        if (typeof eventId !== 'string') return;
        const accepted = Boolean(arr[2]);
        const message = typeof arr[3] === 'string' ? arr[3] : '';
        this.emitter.emit(`ok:${eventId}`, { accepted, message } satisfies OkResponse);
        break;
      }
      case 'EVENT': {
        const subId = arr[1];
        if (typeof subId !== 'string') return;
        this.dispatchEvent(subId, arr[2]);
        break;
      }
      case 'NOTICE':
        log.debug('Buzz relay NOTICE', { instance: this.label, message: arr[1] });
        break;
      case 'CLOSED':
        log.warn('Buzz relay closed a subscription', { instance: this.label, subId: arr[1], reason: arr[2] });
        break;
      // EOSE / COUNT: nothing to do — live delivery continues past end-of-backlog.
      default:
        break;
    }
  }

  private dispatchEvent(subId: string, rawEvent: unknown): void {
    const event = rawEvent as NostrEvent;
    if (typeof event?.created_at === 'number') {
      this.lastEventTs = Math.max(this.lastEventTs, event.created_at);
    }
    const sub = this.subs.get(subId);
    if (!sub) return;
    try {
      sub.onEvent(event);
    } catch (err) {
      log.error('Buzz relay onEvent handler threw', { instance: this.label, err });
    }
  }

  private waitForAuthChallenge(timeoutMs: number): Promise<string> {
    if (this.lastAuthChallenge) {
      const challenge = this.lastAuthChallenge;
      this.lastAuthChallenge = null;
      return Promise.resolve(challenge);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off('auth', onAuth);
        reject(new Error(`Buzz relay (${this.label}) did not send an AUTH challenge in time`));
      }, timeoutMs);
      const onAuth = (challenge: string) => {
        clearTimeout(timer);
        resolve(challenge);
      };
      this.emitter.once('auth', onAuth);
    });
  }

  private waitForOk(eventId: string, timeoutMs: number): Promise<OkResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off(`ok:${eventId}`, onOk);
        reject(new Error(`Buzz relay (${this.label}) did not acknowledge event ${eventId} in time`));
      }, timeoutMs);
      const onOk = (res: OkResponse) => {
        clearTimeout(timer);
        resolve(res);
      };
      this.emitter.once(`ok:${eventId}`, onOk);
    });
  }
}
