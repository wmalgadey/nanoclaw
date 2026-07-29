# Buzz ↔ nanoclaw Integration — Implementierungsplan

## Context

Wolfgang betreibt auf diesem Host ein selbst-gehostetes **Buzz-Relay** (Nostr-basierter
Team-Chat, closed relay, erreichbar via Tailscale + einer lokalen ws-Loopback-Replica
`ws://buzz.crested-centauri.ts.net` → `127.0.0.1:80`, siehe `~/buzz`) und **nanoclaw v2**
(`~/nanoclaw2`), einen container-isolierten Multi-Channel-Claude-Assistenten. nanoclaw
bindet Chat-Plattformen über **Channel-Adapter** an (bisher Telegram + CLI).

**Ziel:** Buzz als weiteren nanoclaw-Channel anbinden, sodass die beiden existierenden
nanoclaw-Agenten je als eigene Buzz-Identität (eigenes Nostr-Keypair, als Relay-Mitglied
registriert — analog zum `buzz-agent`-Setup) in einem gemeinsamen Buzz-Channel ansprechbar
sind:

| nanoclaw agent_group | Ordner | Buzz-Anzeigename | Adapter-Instance |
|---|---|---|---|
| `ag-1777057932130-ylrix2` | `groups/dm-with-wolfgang/` | **Marvin** | `buzz-marvin` |
| `ag-1777444093166-1stdt2` | `groups/magrathea/` | **Magrathea** | `buzz-magrathea` |

**Entscheidungen (mit dem User abgestimmt):** ein **gemeinsamer neuer Buzz-Channel**
(z.B. `#nanoclaw`), Agenten per `@Marvin` / `@Magrathea` adressiert; **nativer WS-Client**
(NIP-42 + REQ-Subscription) für Echtzeit-Inbound. Claude-Auth der Agenten läuft
unverändert über nanoclaws bestehende Provider/OneCLI-Konfig (Abo) — kein API-Key nötig.

---

## Architektur

nanoclaw-Channel-Adapter laufen im **Host-Node-Prozess** (nicht im Container). Der neue
Buzz-Adapter hält pro Identität eine **persistente, NIP-42-authentifizierte WebSocket** zum
Relay, empfängt kind:9-Mentions per `REQ` und published Antworten als kind:9. Mehrere
Identitäten = mehrere **Adapter-Instances** (das `instance`-Feld; Delivery adressiert strikt
per Instance ohne Fallback → jeder Agent sendet über seinen eigenen Key).

```
Buzz #nanoclaw ──WS(NIP-42, REQ #p:pubkey)──▶ buzz-Adapter (instance buzz-marvin)
                                                   │ config.onInbound(...)
                                                   ▼
                              router → messaging_group(buzz, buzz:<uuid>, buzz-marvin)
                                                   │ wiring (engage=mention)
                                                   ▼
                              agent_group Marvin → Container (Claude/OneCLI) → outbound.db
                                                   │ deliver(platformId, msg)
                                                   ▼
              buzz-Adapter published kind:9 (h=<uuid>) als Marvin ──▶ Buzz #nanoclaw
```

`platformId = buzz:<channel-uuid>` kodiert den Buzz-Channel; `senderId = buzz:<pubkey>`.
Beide Identitäten abonnieren denselben Channel, aber jede nur mit `#p:[eigene-pubkey]` →
jede empfängt nur die an sie gerichteten Mentions.

---

## Referenzen (verifiziert)

- Adapter-Vertrag: `~/nanoclaw2/src/channels/adapter.ts` (`ChannelAdapter`, `ChannelSetup`,
  `InboundMessage`, `OutboundMessage`, `ChannelDefaults`, `ChannelRegistration`).
- **Vorlage (native):** `~/nanoclaw2/src/channels/cli.ts` — factory → `ChannelAdapter`,
  `setup(config)` startet Empfang, `config.onInbound(platformId, threadId, msg)` speist ein,
  `deliver(...)` sendet, `registerChannelAdapter(name, {factory, defaults})` am Modulende.
- Registry/Instance-Keying: `~/nanoclaw2/src/channels/channel-registry.ts` (Map keyed auf
  `adapter.instance ?? adapter.channelType`; `getChannelAdapterExact(instance)`).
- Defaults-Auflösung: `~/nanoclaw2/src/channels/channel-defaults.ts`.
- Barrel (Selbst-Registrierung): `~/nanoclaw2/src/channels/index.ts` (side-effect-Import).
- Credential-Lesen: `~/nanoclaw2/src/env.ts` `readEnvFile([keys])` (liest `.env`, nicht in
  `process.env`). Telegram-Vorbild: `src/channels/telegram.ts:214`.
- Buzz NIP-42-Handshake + Filter: `~/buzz/crates/buzz-ws-client/src/connection.rs`,
  `~/buzz/crates/buzz-ws-client/src/message.rs` (`build_auth_event`), Verifikation
  `~/buzz/crates/buzz-auth/src/nip42.rs`, erwarteter relay-Tag
  `~/buzz/crates/buzz-relay/src/api/bridge.rs:225` (`{scheme}://{host}`, scheme aus RELAY_URL).

---

## Schritt 1 — Buzz-seitige Registrierung (in `~/buzz`)

Zwei Keypaare erzeugen, als Mitglieder freischalten, gemeinsamen Channel anlegen, Profile
setzen. Alle Buzz-CLI-REST-Aufrufe mit `BUZZ_RELAY_URL=http://buzz.crested-centauri.ts.net`.
Binary: `~/buzz/target/release/buzz`.

```bash
cd ~/buzz/deploy/compose
C="docker compose -f compose.yml -f compose.tailscale.yml -f compose.agent.yml --env-file .env"

# 1a. Zwei Keypaare (Public+Secret je notieren)
$C exec relay buzz-admin generate-key    # → Marvin:   pub M_PUB, secret M_SEC
$C exec relay buzz-admin generate-key    # → Magrathea: pub G_PUB, secret G_SEC

# 1b. Als Relay-Mitglieder (sleep 1 gegen Roster-Timestamp-Kollision; NICHT parallel)
./run.sh add-member <M_PUB> --role member ; sleep 1
./run.sh add-member <G_PUB> --role member
./run.sh list-members    # beide müssen erscheinen

# 1c. Gemeinsamen Channel als Marvin anlegen (Ersteller = Mitglied) → CH_UUID notieren
BUZZ_RELAY_URL=http://buzz.crested-centauri.ts.net BUZZ_PRIVATE_KEY=<M_SEC> \
  ~/buzz/target/release/buzz channels create --name nanoclaw --type stream --visibility open \
  --description "nanoclaw agents: @Marvin, @Magrathea"

# 1d. Magrathea tritt bei
BUZZ_RELAY_URL=http://buzz.crested-centauri.ts.net BUZZ_PRIVATE_KEY=<G_SEC> \
  ~/buzz/target/release/buzz channels join --channel <CH_UUID>

# 1e. Profile (Anzeigenamen)
BUZZ_RELAY_URL=http://buzz.crested-centauri.ts.net BUZZ_PRIVATE_KEY=<M_SEC> \
  ~/buzz/target/release/buzz users set-profile --name "Marvin"  --about "nanoclaw · @Marvin"
BUZZ_RELAY_URL=http://buzz.crested-centauri.ts.net BUZZ_PRIVATE_KEY=<G_SEC> \
  ~/buzz/target/release/buzz users set-profile --name "Magrathea" --about "nanoclaw · @Magrathea"
```

Wolfgang tritt dem Channel `#nanoclaw` in der Desktop-App bei (zum Reden mit den Agenten).

**Voraussetzung:** Die ws-Loopback-Replica muss laufen — Stack immer mit beiden Schaltern
starten: `BUZZ_COMPOSE_TAILSCALE=true BUZZ_COMPOSE_AGENT=true ./run.sh start`.

---

## Schritt 2 — nanoclaw-Konfiguration

**Secrets → `~/nanoclaw2/.env`** (analog `TELEGRAM_BOT_TOKEN`):
```
BUZZ_RELAY_URL=ws://buzz.crested-centauri.ts.net
BUZZ_NSEC_MARVIN=<M_SEC>          # hex oder nsec
BUZZ_NSEC_MAGRATHEA=<G_SEC>
```

**Nicht-geheime Instance-Map → `~/nanoclaw2/data/buzz-config.json`** (analog
`data/telegram-pairings.json`; sagt dem Adapter, welche Instances es gibt, welchen Channel
sie abonnieren, und die pubkey↔Name-Zuordnung fürs Self-Ignore/Sender-Anzeige):
```json
{
  "relayUrl": "ws://buzz.crested-centauri.ts.net",
  "identities": [
    { "instance": "buzz-marvin",    "envKey": "BUZZ_NSEC_MARVIN",    "displayName": "Marvin",    "pubkey": "<M_PUB>", "channels": ["<CH_UUID>"] },
    { "instance": "buzz-magrathea", "envKey": "BUZZ_NSEC_MAGRATHEA", "displayName": "Magrathea", "pubkey": "<G_PUB>", "channels": ["<CH_UUID>"] }
  ]
}
```

**Wolfgangs Buzz-Owner-Identität als nanoclaw-User registrieren** (damit seine Mentions
sauber als bekannter Owner erkannt werden — `senderId = buzz:<owner-pubkey>`):
```bash
cd ~/nanoclaw2
bin/ncl users create --id buzz:7678d615ae62bf760e60f091070514702e028b84b4d43ca97aaba47492ce2567 \
  --kind buzz --display-name Wolfgang
bin/ncl roles grant --user-id buzz:7678d615ae62bf760e60f091070514702e028b84b4d43ca97aaba47492ce2567 --role owner
```

---

## Schritt 3 — Der Buzz-Channel-Adapter (Code)

### 3a. `~/nanoclaw2/src/channels/buzz-client.ts` (neuer nativer Nostr-WS-Client)

Kleine Klasse `BuzzRelayClient`, Vorlage: `~/buzz/crates/buzz-ws-client/src/connection.rs`.
Deps: `ws` + `nostr-tools` (Signieren/Serialisieren; `nip19.decode` für nsec, `finalizeEvent`,
`getPublicKey`, `verifyEvent`).

Methoden:
- `constructor(relayUrl: string, secretKey: Uint8Array)`.
- `connect()`: WS öffnen → auf `["AUTH", challenge]` warten → **kind:22242**-Event signieren
  mit Tags `["challenge", challenge]` und `["relay", relayUrl]` (relayUrl **exakt**
  `ws://buzz.crested-centauri.ts.net`, kein Port, ws-Schema — sonst `RelayUrlMismatch`),
  `created_at` innerhalb ±60s → `["AUTH", event]` senden → auf `["OK", id, true, ""]` warten.
  Timeouts: 20s Challenge, 20s Auth-OK.
- `subscribe(subId, filters[], onEvent)`: `["REQ", subId, ...filters]`; `["EVENT", subId, ev]`
  an `onEvent` dispatchen; `["EOSE",...]` markiert Live-Ende des Backlogs.
- `publish(event)`: signieren, `["EVENT", event]`, auf `["OK", id, true]` warten (30s).
- Reconnect mit exponentiellem Backoff; nach Reconnect `REQ` mit `since=<lastSeen-60>`
  erneut senden (verpasste Events nachziehen). Ping/Pong beachten.
- `close()`, `isConnected()`.

### 3b. `~/nanoclaw2/src/channels/buzz.ts` (Adapter, Vorlage `cli.ts`)

```
BUZZ_DEFAULTS: ChannelDefaults = {
  dm:    { engageMode: 'mention', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'platform',
}
```

- **Multi-Instance-Registrierung:** Modul liest `data/buzz-config.json` + `.env` (`readEnvFile`)
  auf Top-Level und ruft **pro Identität** `registerChannelAdapter(id.instance, { factory: () =>
  makeBuzzAdapter(id, relayUrl, secret), defaults: BUZZ_DEFAULTS })`. Fehlt der nsec einer
  Identität, factory → `null` (Instance deaktiviert). `makeBuzzAdapter` gibt ein
  `ChannelAdapter`-Objekt mit `channelType: 'buzz'`, `instance: id.instance`,
  `supportsThreads: false`, `defaults: BUZZ_DEFAULTS`.
  *(Registry-Keying gegen `channel-registry.ts:~274` verifizieren — Storage-Key = `instance`.)*
- **`setup(config)`:** `BuzzRelayClient` erzeugen, `connect()`, dann pro konfiguriertem
  Channel `subscribe(subId, [{ kinds:[9], "#h":[uuid], "#p":[id.pubkey] }], onEvent)`.
  In `onEvent(ev)`:
  - **Self-/Agent-Ignore:** überspringe `ev`, wenn `ev.pubkey` eine der verwalteten
    Identitäten ist (kein Loop) und wenn `ev.id` schon gesehen (Dedup-Set, gegen
    Reconnect-Replay).
  - Channel-UUID aus dem `h`-Tag von `ev` lesen → `platformId = "buzz:" + uuid`.
  - `config.onInbound(platformId, null, { id: ev.id, kind: 'chat',
    timestamp: new Date(ev.created_at*1000).toISOString(),
    content: { text: ev.content, sender: <Name via displayName-Cache/profile oder pubkey-kurz>,
    senderId: "buzz:" + ev.pubkey }, isMention: true, isGroup: true })`.
- **`deliver(platformId, _threadId, message)`:** `text = extractText(message)` (wie `cli.ts`);
  `uuid = platformId.slice("buzz:".length)`; kind:9-Event bauen mit `tags: [["h", uuid]]`,
  `content: text`, via `client.publish(...)` als diese Identität senden. Rückgabe: event id.
  *(Optional später: `#p`-Tag auf den ursprünglichen Sender + `["e", rootId]` für Threads.)*
- **`teardown()`:** `client.close()`. **`isConnected()`:** `client.isConnected()`.

### 3c. Barrel

`~/nanoclaw2/src/channels/index.ts` ergänzen:
```ts
import './buzz.js';
```

### 3d. Dependencies (pnpm-Supply-Chain beachten)

`minimumReleaseAge: 4320` (3 Tage) gilt → nur ausreichend alte, **exakt gepinnte** Versionen:
```bash
cd ~/nanoclaw2
pnpm add ws@<exakt> nostr-tools@<exakt>
pnpm add -D @types/ws@<exakt>
```
(Stabile Versionen von `ws`@8.x / `nostr-tools`@2.x erfüllen die 3-Tage-Regel; genaue
aktuelle Patch-Version beim Install pinnen, kein Range/`latest`.)

---

## Schritt 4 — nanoclaw-Wiring (`ncl`)

```bash
cd ~/nanoclaw2
# Messaging-Groups (gleiche Channel-UUID, unterschiedliche instance)
bin/ncl messaging-groups create --channel-type buzz --platform-id buzz:<CH_UUID> \
  --instance buzz-marvin    --is-group 1 --unknown-sender-policy public --name "Buzz #nanoclaw (Marvin)"
bin/ncl messaging-groups create --channel-type buzz --platform-id buzz:<CH_UUID> \
  --instance buzz-magrathea --is-group 1 --unknown-sender-policy public --name "Buzz #nanoclaw (Magrathea)"

# Wirings an die bestehenden agent_groups (engage=mention: nur auf @Mention reagieren)
bin/ncl wirings create --messaging-group-id <mg-marvin-id>    --agent-group dm-with-wolfgang \
  --engage-mode mention --session-mode shared
bin/ncl wirings create --messaging-group-id <mg-magrathea-id> --agent-group magrathea \
  --engage-mode mention --session-mode shared
```
(Die mg-IDs liefert `messaging-groups create` bzw. `bin/ncl messaging-groups list`.
Mutierende `ncl`-Verben laufen ggf. durch den Approval-Guard.)

---

## Schritt 5 — Build & Neustart

```bash
cd ~/nanoclaw2
pnpm run build
pnpm exec vitest run src/channels/buzz-registration.test.ts   # neuer Test (s.u.)
systemctl --user restart nanoclaw
```

**Registrierungs-Test** `~/nanoclaw2/src/channels/buzz-registration.test.ts` (Vorlage:
`telegram-registration.test.ts`): importiert das Barrel, setzt Test-`.env`+`buzz-config.json`,
und asserted, dass die Registry `buzz-marvin` und `buzz-magrathea` enthält.

---

## Verifikation (End-to-End)

1. **Adapter verbunden:** nach Neustart in `~/nanoclaw2/logs/nanoclaw.log` prüfen, dass beide
   Buzz-Instances verbunden + subscribed sind (kein `RelayUrlMismatch`, kein `restricted:
   not a relay member`). Bei Auth-Fehler: relay-Tag exakt `ws://buzz.crested-centauri.ts.net`
   und Mitgliedschaft (`~/buzz/deploy/compose/run.sh list-members`) prüfen.
2. **Marvin:** in der Buzz-Desktop-App in `#nanoclaw` `@Marvin hallo, stell dich vor` posten →
   Marvin-Container antwortet, Antwort erscheint in `#nanoclaw` als **Marvin**.
3. **Magrathea:** `@Magrathea ...` → nur Magrathea antwortet (kein Cross-Talk — jede Identität
   empfängt nur ihre `#p`-Mentions).
4. **Routing-Kette** bei Problemen: `logs/nanoclaw.log` (Router → Session), Session-DBs unter
   `data/v2-sessions/<agent-group>/<session>/` (`inbound.db`/`outbound.db`), und Buzz-Relay-Log
   `~/buzz/deploy/compose/run.sh logs relay`.

---

## Risiken / Hinweise

- **relay-Tag exakt** `ws://buzz.crested-centauri.ts.net` (ws-Schema, kein Port) — häufigste
  Fehlerquelle (`RelayUrlMismatch`).
- **Mitgliedschaft zuerst:** beide Keys müssen via `add-member` freigeschaltet sein, bevor der
  Adapter verbindet (closed relay erzwingt Membership bei AUTH).
- **Dedup + Self-Ignore** verhindern Reprocessing (Reconnect-Replay) und Antwort-Loops.
- **Loopback-Replica-Abhängigkeit:** Der Adapter erreicht das Relay nur über die
  `relay-agent`-Replica auf `127.0.0.1:80` (via `/etc/hosts`). Stack stets mit
  `BUZZ_COMPOSE_AGENT=true` starten.
- **Claude-Auth der Agenten** bleibt unverändert (nanoclaw-Provider/OneCLI-Abo) — Buzz ändert
  nur den Ein-/Ausgabekanal, nicht das Modell-Backend.
- **Skill-Verpackung (optional):** Für einen sauberen, idempotenten Install kann der Adapter
  später als `/add-buzz`-Skill (Muster: `.claude/skills/add-telegram/SKILL.md`) verpackt und
  auf die `channels`-Branch gelegt werden. Für den lokalen Einsatz genügen Modul + Barrel-Import
  + Build.

---

## Betroffene/neue Dateien

- **Neu:** `~/nanoclaw2/src/channels/buzz.ts`, `~/nanoclaw2/src/channels/buzz-client.ts`,
  `~/nanoclaw2/src/channels/buzz-registration.test.ts`, `~/nanoclaw2/data/buzz-config.json`.
- **Geändert:** `~/nanoclaw2/src/channels/index.ts` (+`import './buzz.js'`),
  `~/nanoclaw2/.env` (Relay-URL + 2 nsecs), `~/nanoclaw2/package.json` (`ws`, `nostr-tools`).
- **Nicht-Code (Buzz-Seite + ncl):** 2 Keypaare, 2 Members, 1 Channel, 2 Profile, 2
  messaging-groups, 2 wirings, 1 owner-user.
