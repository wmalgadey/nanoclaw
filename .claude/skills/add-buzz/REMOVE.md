# Remove Buzz

Every step is idempotent — safe to re-run.

## 1. Remove the adapter

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './buzz.js';
```

Then delete the copied adapter, relay client, and test:

```bash
rm -f src/channels/buzz.ts src/channels/buzz-client.ts src/channels/buzz-registration.test.ts
```

## 2. Remove the packages

```bash
pnpm remove ws nostr-tools @types/ws
```

Check first that nothing else in the install pulls `ws` in as a direct
dependency — some channel adapters do.

## 3. Remove the configuration

```bash
rm -f data/buzz-config.json
```

Remove the relay URL and every `BUZZ_NSEC_*` line from `.env`.

## 4. Remove the wiring

Runtime rows the skill's apply didn't create, so remove them only if the Buzz
channel is going away for good — `bin/ncl wirings list` and
`bin/ncl messaging-groups list` show them:

```bash
bin/ncl wirings delete --id <wiring-id>
bin/ncl messaging-groups delete --id <messaging-group-id>
```

## 5. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
