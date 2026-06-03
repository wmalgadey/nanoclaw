# Plan: Claude Code SessionEnd Hook — Session-Level Usage Tracking

## Ausgangslage

Das Dashboard scannt alle JSONL-Dateien bei jedem `/api/data`-Request (rolling windows 5h/24h/7d).
Exhaustion-Events werden mit bis zu 10 Minuten Verzögerung erkannt (Cron-Polling via `claude-status.sh`).
Es gibt keine Granularität auf Session-Ebene — nur Aggregatsummen.

### Bekannte JSONL-Pfade

| Quelle | Pfad |
|--------|------|
| Host CLI | `~/.claude/projects/<project-hash>/<session-uuid>.jsonl` |
| Container (Agent-Gruppe) | `data/v2-sessions/ag-<id>/.claude-shared/projects/-workspace-agent/<session-uuid>.jsonl` |
| Container Subagents | `.../subagents/agent-<id>.jsonl` |

### Was Claude Code Hooks liefern

Hooks empfangen via **stdin** ein JSON-Objekt:
```json
{
  "session_id": "f884ba50-8e42-4557-b42a-a109c9857bd6",
  "transcript_path": "/home/paranoid/.claude/projects/-home-paranoid-nanoclaw2/f884ba50-8e42-4557-b42a-a109c9857bd6.jsonl"
}
```

Der `SessionEnd`-Hook wird nach Beenden einer Sitzung gefeuert, bevor der Prozess endet.
Hooks werden in `~/.claude/settings.json` (global) oder `.claude/settings.json` (per-Projekt) konfiguriert.

---

## Ziel

1. **Session-Level Granularität**: Token-Verbrauch, Dauer, Modell — pro Session, nicht nur als rollende Fenstersumme
2. **Schnelle Exhaustion-Erkennung**: sofort bei Session-Ende statt 10-Minuten-Cron-Delay
3. **Quellen-Coverage**: sowohl Host-Sessions als auch Container-Sessions (Agent-Gruppen)
4. **Dashboard-Integration**: neue Tabelle „Session History" + Exhaustion-Learning aus Session-Log statt JSONL-Rescan

---

## Session-Log-Format (`data/claude-session-log.jsonl`)

Append-only, eine JSON-Zeile pro Session:

```json
{
  "ts":           1777828933992,
  "sessionId":    "f884ba50-8e42-4557-b42a-a109c9857bd6",
  "source":       "host",
  "agentGroupId": null,
  "projectPath":  "-home-paranoid-nanoclaw2",
  "model":        "claude-sonnet-4-6",
  "durationMs":   7200000,
  "turnCount":    48,
  "tokens": {
    "input":       1200,
    "output":      62360,
    "cacheCreate": 255286,
    "cacheRead":   3218568
  },
  "hadExhaustionHit": false,
  "exhaustionTs":     null,
  "exhaustionMsg":    null
}
```

Für Container-Sessions: `source: "container"`, `agentGroupId: "ag-1777057794648-h32w7x"`.

---

## Ansatz A: Host-Sessions via Claude Code Hook

### Hook-Konfiguration

In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/paranoid/nanoclaw2/scripts/session-log-hook.sh"
          }
        ]
      }
    ]
  }
}
```

### Hook-Skript (`scripts/session-log-hook.sh`)

```bash
#!/usr/bin/env bash
# Liest SessionEnd-Daten via stdin, parst JSONL, schreibt in session-log.jsonl
set -euo pipefail

DATA_DIR="$(dirname "$(dirname "$0")")/data"
OUT="$DATA_DIR/claude-session-log.jsonl"

STDIN=$(cat)
TRANSCRIPT=$(echo "$STDIN" | python3 -c "import json,sys; print(json.load(sys.stdin).get('transcript_path',''))")
SESSION_ID=$(echo "$STDIN" | python3 -c "import json,sys; print(json.load(sys.stdin).get('session_id',''))")

[ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ] && exit 0

python3 - "$TRANSCRIPT" "$SESSION_ID" "$OUT" <<'PYEOF'
import json, sys, os
from datetime import datetime, timezone

transcript, session_id, out = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(transcript).readlines()

tokens = {'input': 0, 'output': 0, 'cacheCreate': 0, 'cacheRead': 0}
turn_count = 0
model = None
exhaustion_ts = None
exhaustion_msg = None
first_ts = None
last_ts = None

for raw in lines:
    if not raw.strip():
        continue
    e = json.loads(raw)
    ts_str = e.get('timestamp', '')
    ts = int(datetime.fromisoformat(ts_str.replace('Z','+00:00')).timestamp() * 1000) if ts_str else None
    if ts:
        if first_ts is None: first_ts = ts
        last_ts = ts

    if e.get('type') == 'assistant':
        u = e.get('message', {}).get('usage', {})
        if u:
            tokens['input']       += u.get('input_tokens', 0)
            tokens['output']      += u.get('output_tokens', 0)
            tokens['cacheCreate'] += u.get('cache_creation_input_tokens', 0)
            tokens['cacheRead']   += u.get('cache_read_input_tokens', 0)
            turn_count += 1
            if not model:
                model = e.get('message', {}).get('model')
        # Exhaustion detection
        if e.get('message', {}).get('model') == '<synthetic>':
            for c in (e.get('message', {}).get('content') or []):
                if isinstance(c, dict) and 'out of extra usage' in c.get('text', ''):
                    exhaustion_ts = ts
                    exhaustion_msg = c.get('text', '')[:200]

project_path = os.path.basename(os.path.dirname(transcript))
entry = {
    'ts': last_ts or int(datetime.now(timezone.utc).timestamp() * 1000),
    'sessionId': session_id,
    'source': 'host',
    'agentGroupId': None,
    'projectPath': project_path,
    'model': model,
    'durationMs': (last_ts - first_ts) if first_ts and last_ts else 0,
    'turnCount': turn_count,
    'tokens': tokens,
    'hadExhaustionHit': exhaustion_ts is not None,
    'exhaustionTs': exhaustion_ts,
    'exhaustionMsg': exhaustion_msg,
}

os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'a') as f:
    f.write(json.dumps(entry) + '\n')
PYEOF
```

**Vorteile**: Einfach, kein Container-Rebuild, sofort wirksam.
**Einschränkung**: Funktioniert nur für interaktive Host-Claude-Code-Sessions, nicht für Agent-Runner-Sessions.

---

## Ansatz B: Container-Sessions via Agent-Runner-Extension

### Problem

Container-Sessions laufen nicht durch den interaktiven Claude Code CLI-Prozess des Hosts,
sondern durch den **agent-runner** (Bun), der den `@anthropic-ai/claude-agent-sdk` verwendet.
Der agent-runner hat keinen `SessionEnd`-Hook-Mechanismus.

### Option B1: Claude Code Hook im Container (via `.claude-shared/settings.json`)

Die `.claude-shared/settings.json` wird beim Container-Start aus dem Agent-Gruppen-Verzeichnis geladen.
Sie kann ebenfalls `hooks.SessionEnd` enthalten.

**Konfiguration in `src/group-init.ts`** (bei Scaffolding):
```typescript
// Füge hooks zu .claude-shared/settings.json hinzu
const settings = {
  env: { ... },
  hooks: {
    SessionEnd: [{
      hooks: [{ type: 'command', command: '/nanoclaw/scripts/session-log-hook-container.sh' }]
    }]
  }
};
```

**Hook-Skript im Container** muss im Container-Image enthalten sein.
Schreibt nach `/data/claude-session-log.jsonl` (bereits gemountet).

**Nachteile**: Braucht Container-Rebuild, Hook-Skript muss in Dockerfile kopiert werden,
nur für Claude-Code-interne Sessions (nicht für agent-runner-gesteuerte Calls).

### Option B2: Agent-Runner-Extension (empfohlen)

Der agent-runner in `container/agent-runner/src/poll-loop.ts` durchläuft alle Turn-Events
und hat direkten Zugriff auf Token-Daten aus dem SDK-Stream.

**Erweiterung in `poll-loop.ts`** nach `processQuery()`:

```typescript
// Nach Abschluss einer Task
const sessionSummary = {
  ts: Date.now(),
  sessionId: continuation ?? 'unknown',
  source: 'container',
  agentGroupId: process.env.AGENT_GROUP_ID,   // neu als env-var setzen
  projectPath: '-workspace-agent',
  model: lastSeenModel,
  durationMs: Date.now() - taskStartTs,
  turnCount,
  tokens: accumulatedTokens,  // aus SDK-Events gesammelt
  hadExhaustionHit: sawExhaustionMsg,
  exhaustionTs: exhaustionTs,
  exhaustionMsg: exhaustionMsg,
};

// Schreibe in /data/claude-session-log.jsonl (bereits gemountet)
const logPath = '/data/claude-session-log.jsonl';
appendFileSync(logPath, JSON.stringify(sessionSummary) + '\n');
```

**Token-Akkumulierung**: Der agent-runner empfängt SDK-Events. Im `claude`-Provider
werden `usage`-Felder aus den API-Responses übernommen. Dazu muss der Provider
die Summen akkumulieren und nach Ende zurückgeben.

**Vorteile**:
- Kein zusätzliches Hook-Skript nötig
- Direkte API-Ebene — genaueste Token-Daten
- Container mounts `/data` bereits → kein zusätzliches Volume nötig
- Deckt alle container-seitigen Calls ab

**AGENT_GROUP_ID**: Muss als env-var in `src/container-runner.ts` gesetzt werden
(ist bereits implizit im Container-Namen, muss nur explizit übergeben werden).

### Option B3: Host-seitige Erkennung via Sweep (Fallback)

Der `src/host-sweep.ts` erkennt bereits, wenn Container-Sessions enden (Heartbeat weg).
Er könnte dann das JSONL-File lesen und den Session-Log eintrag schreiben.

**Nachteile**: 60s Verzögerung (Sweep-Intervall), Host muss Container-JSONL-Pfad kennen.
Nur als Fallback sinnvoll wenn B2 nicht realisiert wird.

---

## Dashboard-Integration

### Server-Side (`dashboard/server.ts`)

Neue Funktion `readSessionLog()`:

```typescript
function readSessionLog(maxAge = window7dMs): SessionLogEntry[] {
  const cutoff = Date.now() - maxAge;
  try {
    return readFileSync(SESSION_LOG, 'utf-8')
      .split('\n').filter(l => l.trim())
      .map(l => JSON.parse(l) as SessionLogEntry)
      .filter(e => e.ts > cutoff);
  } catch { return []; }
}
```

**Exhaustion-Learning-Verbesserung**:
- Statt JSONL-Rescan beim API-Request: Exhaustion-Events direkt aus `session-log.jsonl` lesen
- Schneller (eine Datei statt N JSONL-Scans)
- Genauere Timestamps (aus Session-Ende, nicht aus periodischem Cron)

**Neue API-Felder in `/api/data`**:
```typescript
session_history: {
  recentSessions: SessionLogEntry[],  // letzte 20 Sessions
  bySource: { host: number, container: number },
  todayTokens: { ... },  // Aggregat heute aus Session-Log
}
```

### UI (`dashboard/public/index.html`)

Neuer Abschnitt im **Tokens**-Tab: „Session-Verlauf":

| Zeitpunkt | Quelle | Projekt / Agent | Dauer | Output | CacheCreate | ⚡ |
|-----------|--------|-----------------|-------|--------|-------------|---|
| 04.05 07:15 | host | nanoclaw2 | 2h 14m | 62.3k | 255k | — |
| 04.05 05:02 | container | magrathea | 45m | 8.4k | 12k | — |
| 03.05 19:09 | host | nanoclaw2 | 1h 32m | 110k | 180k | ⛔ |

Zeichen ⛔ = Exhaustion-Hit während dieser Session.

---

## Implementierungsschritte (priorisiert)

### Phase 1 — Host-Hook (unabhängig, sofort möglich)

1. `scripts/session-log-hook.sh` erstellen
2. `~/.claude/settings.json` um `hooks.SessionEnd` erweitern  
   (via Skript, nicht manuell — damit idempotent)
3. `dashboard/server.ts`: `readSessionLog()` + Exhaustion-Events aus Session-Log
4. `dashboard/public/index.html`: Session-History-Tabelle im Tokens-Tab

### Phase 2 — Container-Hook (B2, braucht Container-Rebuild)

5. `src/container-runner.ts`: `AGENT_GROUP_ID` als env-var im Container setzen
6. `container/agent-runner/src/poll-loop.ts`:
   - Token-Akkumulierung über Task-Laufzeit
   - `appendFileSync('/data/claude-session-log.jsonl', ...)` nach Task-Ende
7. Container-Image rebuild (`./container/build.sh`)
8. Test: Session in Agent-Gruppe auslösen → Eintrag in session-log verifizieren

### Phase 3 — Refinements

9. Subagent-Sessions (`subagents/*.jsonl`) in Hook-Skript einbeziehen
10. `docs.html` mit Session-Hook-Dokumentation erweitern
11. `claude-status.sh`-Cron vereinfachen (Exhaustion wird jetzt via Session-Log erkannt)

---

## Offene Entscheidungen

| Frage | Optionen |
|-------|----------|
| Container-Ansatz | B2 (agent-runner, empfohlen) vs. B1 (hook im container) vs. B3 (host sweep) |
| Hook-Skript-Sprache | Bash + Python (kein Dep) vs. Node/TypeScript (besser wartbar) |
| Session-Log-Aufbewahrung | Unbegrenzt (append-only, JSONL) vs. Rotation nach 30 Tagen |
| Subagent-Sessions | Separat erfassen oder unter Parent-Session zusammenfassen? |
| Exhaustion-Quelle | Session-Log allein vs. hybrid (Log + JSONL-Fallback für ältere Daten) |

---

## Kritische Dateien

| Datei | Änderung |
|-------|----------|
| `scripts/session-log-hook.sh` | NEU — Hook-Skript für Host-Sessions |
| `dashboard/server.ts` | `readSessionLog()` + Exhaustion aus Log |
| `dashboard/public/index.html` | Session-History-Tabelle |
| `container/agent-runner/src/poll-loop.ts` | Token-Akkumulierung + Log-Write |
| `src/container-runner.ts` | `AGENT_GROUP_ID` env-var übergeben |
| `~/.claude/settings.json` | `hooks.SessionEnd` eintragen |
| `data/claude-session-log.jsonl` | NEU — persistentes Session-Log |
