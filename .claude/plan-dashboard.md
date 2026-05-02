# Dashboard Erweiterungsplan

## 1. Log-Metriken Fix (Errors/Warns zeigen 0)

**Problem:** `collectLogMetrics()` liest `nanoclaw.log`, der ausschließlich INFO-Einträge enthält. WARN/ERROR/FATAL landen im separaten `nanoclaw.error.log` (aktuell 6001 Zeilen, 358 WARN/ERROR-Einträge).

**Fix:** Einzige Änderung in `server.ts` — Datei von `nanoclaw.log` auf `nanoclaw.error.log` umstellen.

```ts
// server.ts — collectLogMetrics()
const logFile = path.join(LOGS_DIR, 'nanoclaw.error.log'); // war: nanoclaw.log
```

Das Balkendiagramm und die Perioden-Zähler (1h/6h/24h) funktionieren danach korrekt, da die Leveldetektierung (`/ WARN /`, `/ ERROR /`) bereits stimmt.

---

## 2. Token Rate-Limit-Window

### Datenlage

Die JSONL-Sessiondateien enthalten pro API-Antwort ein `usage`-Objekt:
```json
{
  "input_tokens": 3,
  "output_tokens": 85,
  "cache_read_input_tokens": 10864,
  "cache_creation_input_tokens": 8906,
  "service_tier": "standard"
}
```

- `service_tier: "standard"` = normales Kontingent; abweichende Werte (`"priority"`, `"batch"`) deuten auf extra/overflow hin.
- `/home/paranoid/.claude/stats-cache.json` enthält `dailyModelTokens` mit Output-Tokens pro Tag und Modell (bis zum letzten `lastComputedDate`, nicht live).
- `/home/paranoid/.claude/usage-data/session-meta/*.json` enthält `input_tokens`, `output_tokens`, `start_time` pro Session (live).

### Claude Max Rate-Limit-Modell

Claude Max hat ein **5-Stunden-Rolling-Window** basierend auf Output-Tokens:
- Max 5x: ~88 000 Output-Tokens / 5h
- Max 20x: ~352 000 Output-Tokens / 5h
- (Genaue Werte via env-Variable konfigurierbar: `CLAUDE_MAX_5H_OUTPUT_LIMIT`)

Tages- und Wochen-Caps sind nicht dokumentiert. Extra Usage (`service_tier != "standard"`) ist erkennbar und sollte separat summiert werden.

### Implementierung

**`server.ts` — neue Funktion `collectRateLimitMetrics()`:**
- Alle JSONL-Dateien (NanoClaw-Sessions + CLI-Sessions) scannen
- Output-Tokens nach UTC-Zeit gruppieren:
  - Aktuelles 5h-Fenster (rollend ab jetzt - 5h)
  - Heutige 24h
  - Letzte 7 Tage
- `service_tier != "standard"` separat als Extra-Usage zählen
- Ergebnis: `{ window5h, daily, weekly, extraUsage, limitConfig }`

**Neue env-Variablen in `docker-compose.dashboard.yml`:**
```yaml
CLAUDE_5H_OUTPUT_LIMIT: "88000"   # anpassen je nach Plan (Max 5x / 20x)
CLAUDE_DAILY_OUTPUT_LIMIT: "0"    # 0 = kein bekannter Cap
```

**Neuer Abschnitt im Tokens-Tab:**
- Drei Fortschrittsbalken: 5h-Window, 24h, 7 Tage
- Reset-Zeitpunkt des 5h-Windows ("reset in Xh Xm")
- Extra-Usage-Zähler mit `service_tier`-Breakdown
- Balken werden gelb ab 70%, rot ab 90%

**Overview-Karte:** Bestehende "Cache Hit Rate"-Karte ergänzen um "5h-Window: XX%" Subtext.

---

## 3. Agenten-Detailansicht (inkl. Magrathea-Sichtbarkeit)

### Warum Magrathea nicht sichtbar ist

Magrathea (`ag-1777444093166-1stdt2`) existiert in der DB und hat eine aktive Session. Das Problem: Im Dashboard-Sessions-Tab erscheinen alle Sessions, aber der **Routing-Kontext** (Trigger-Muster, welcher Agent welche Nachrichten bekommt) fehlt vollständig.

Magrathea und Marvin teilen denselben Messaging-Group (`mg-1777057908881-l70fd2`) mit Pattern-Routing:
- Magrathea: `^[Mm]agrathea\b` (Nachrichten, die mit "Magrathea" beginnen)
- Marvin: `^(?![Mm]agrathea\b)` (alle anderen)

Das ist aus der `messaging_group_agents`-Tabelle lesbar (Spalten `session_mode`, `trigger_rules`, `pattern`).

### Neue Tab-Struktur: "Agents"

Eigener Tab (zwischen Overview und Tokens) mit einer Karte pro Agent-Group:

**Karte pro Agent:**
```
┌─ Magrathea ─────────────────────────────────────────────────┐
│ Folder: magrathea  │ Provider: claude  │ Status: stopped     │
│                                                              │
│ WIRING                                                       │
│  telegram:8177091736  [shared]  Trigger: ^[Mm]agrathea\b    │
│                       Priority: 0  Unknown senders: drop     │
│                                                              │
│ AKTIVE SESSION                                               │
│  sess-1777488527053  │ Heartbeat: 2h ago  │ CTX: 40% ████░  │
│  268 Nachrichten     │ Cache Hit: 96%      │                  │
│                                                              │
│ LETZTE AKTIVITÄT     Heute 08:08          Tokens: 1.2M out  │
└──────────────────────────────────────────────────────────────┘
```

**Datenquellen:**
- `agent_groups` + `messaging_group_agents` + `messaging_groups` (DB): Konfiguration, Trigger
- `sessions` (DB): Aktueller Status
- Token-Metriken aus JSONL: Tokens, Context-Window-Füllstand, Cache-Rate
- Heartbeat-Datei: Letzter Lebenszeichen-Zeitstempel

**Agenten-Detailseite (Klick auf Karte):**
- Tab innerhalb des Agents-Views: Overview | Messages | Tokens | Config
- Messages: Letzte 20 Nachrichten (inbound + outbound), komprimiert (kein roher JSON)
- Tokens: Zeitverlauf der Token-Nutzung (Balkendiagramm per Session)
- Config: Raw CLAUDE.md-Inhalt, Container-Config, Destinations

---

## 4. Message-Metriken (statt verbosem Inhalt)

### Aktueller Zustand
Messages-Tab zeigt rohen JSON-Inhalt jeder Nachricht — unlesbar und nicht nützlich für Betriebsübersicht.

### Neue Metriken-Ansicht

**Pro Session (ersetzt die Message-Liste):**

| Metrik | Quelle | Beschreibung |
|--------|--------|--------------|
| Nachrichten gesamt | `COUNT(*)` inbound | Gesamtanzahl Turns |
| Ø Antwortzeit | `timestamp(out) - timestamp(in)` | Median-Latenz pro Turn |
| Letzte Aktivität | `MAX(timestamp)` | Zeit seit letzter Nachricht |
| Ausstehende Nachrichten | `status = 'pending'` | Noch nicht verarbeitet |
| Nachrichten heute / 7 Tage | Zeitfilter auf `timestamp` | Aktivitätstrend |
| Nachrichten nach Stunde | `GROUP BY strftime('%H')` | Aktivitätsmuster (24h-Balken) |
| Kinds-Breakdown | `GROUP BY kind` | chat-sdk vs task vs system |
| Delivery-Fehler | `delivered.status != 'delivered'` | Fehlgeschlagene Zustellungen |
| Tool-Call-Anteil | aus JSONL (tool_use-Blöcke) | % der Turns mit Tool-Calls |
| Kompaktierungen | `system`-Entries mit `compactMetadata` | Wie oft Context kompaktiert |

**Visualisierung:**
- Stat-Karten oben (Gesamt, Heute, Ausstehend, Ø Latenz)
- 24h-Aktivitätsbalken (inbound Nachrichten pro Stunde)
- Kinds-Donut (chat-sdk / task / system / sonstiges)
- Letzte 5 Nachrichten: Nur Timestamp + Kind + erste 60 Zeichen Text (kein JSON)

**Aggregierte Übersicht (über alle Sessions):**
- Im Overview-Tab: Gesamtnachrichten heute, Nachrichten pro Agent
- Aktive vs. ruhende Sessions (letzter Turn < 1h / 1–24h / >24h)

---

## Implementierungsreihenfolge

| Prio | Item | Aufwand | Dateien |
|------|------|---------|---------|
| 1 | Error-Metriken Fix | Klein | `server.ts` (1 Zeile) |
| 2 | Agents-Tab | Mittel | `server.ts` (DB-Query), `index.html` (neuer Tab) |
| 3 | Message-Metriken | Mittel | `server.ts` (Aggregation), `index.html` (neuer Render) |
| 4 | Rate-Limit-Window | Groß | `server.ts` (JSONL-Scan + Bucketing), `docker-compose.yml`, `index.html` |

---

## Offene Fragen

- **Rate-Limit-Werte:** Welcher Claude Max Plan ist aktiv (5x oder 20x)? Die Limits müssen als env-Variable konfiguriert werden, da Anthropic sie nicht über die API zurückmeldet.
- **Extra-Usage-Definition:** `service_tier` im JSONL-`usage`-Objekt muss beobachtet werden — aktuell nur `"standard"` gesehen. Sobald Extra-Usage aktiv war, erscheinen andere Werte.
- **Magrathea Agents-Tab:** Sollen alle 4 Agent-Groups eine Karte bekommen oder nur aktive?
