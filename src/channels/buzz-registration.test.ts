/**
 * Integration test for the buzz channel's self-registration import in the
 * `src/channels/index.ts` barrel. See telegram-registration.test.ts for the
 * full rationale — same shape, but buzz registers one adapter instance per
 * identity listed in `data/buzz-config.json` rather than a single static key.
 *
 * Behavior, not structural: imports the real barrel and asserts the registry
 * contains an instance per configured identity. If `data/buzz-config.json`
 * is absent (a bare, non-Buzz install), the module registers nothing and
 * this test is skipped rather than failed — the file is host-local config,
 * not something trunk ships.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

import { DATA_DIR } from '../config.js';
import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

const configPath = path.join(DATA_DIR, 'buzz-config.json');
const hasConfig = fs.existsSync(configPath);

describe.skipIf(!hasConfig)('buzz channel registration', () => {
  it('registers one adapter instance per configured identity', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      identities: Array<{ instance: string }>;
    };
    const registered = getRegisteredChannelNames();
    for (const identity of config.identities) {
      expect(registered).toContain(identity.instance);
    }
  });
});
