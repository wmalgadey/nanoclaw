---
name: wiki
description: Magrathea LLM Wiki — Ingest, Query, Lint operations over the Zettelkasten-backed knowledge base.
---

# Wiki Operations

Paths (always use these):
- **Zettelkasten** (Sources, read-only): `/workspace/extra/private-vault/zettelkasten/`
- **Wiki** (LLM-maintained): `/workspace/agent/llm-wiki/`
- **Index**: `/workspace/agent/llm-wiki/index.md`
- **Log**: `/workspace/agent/llm-wiki/log.md`

---

## Frontmatter-Standard

Jede Wiki-Seite (außer `sources/`) bekommt dieses Frontmatter:

```yaml
---
tags:
  - tech/Kubernetes
  - company/Red-Hat
confidence: medium
confidence_reason: "2 Quellen: offizielle Docs + Blog-Post"
inbound_links: 0
last_reviewed: 2026-06-06
---
```

`superseded_by` und `supersedes` sind optional — nur bei Supersession (siehe unten).

### Tag-Taxonomie

| Präfix | Für was | Beispiele |
|---|---|---|
| `person/` | Personen, Autoren | `person/Simon-Wardley`, `person/Karpathy` |
| `company/` | Firmen, Organisationen | `company/Microsoft`, `company/Red-Hat` |
| `tech/` | Technologien, Plattformen | `tech/Azure`, `tech/Kubernetes`, `tech/dotnet` |
| `pattern/` | Architektur-/Design-Patterns | `pattern/DDD`, `pattern/GitOps`, `pattern/Wardley-Maps` |
| `concept/` | Abstrakte Konzepte | `concept/Platform-Engineering`, `concept/AI-Safety` |
| `source-type/` | Quellentyp | `source-type/buch`, `source-type/offizielle-docs`, `source-type/blog`, `source-type/synthese` |

Mind. 2 Tags pro Artikel (1× Kategorie + 1× Inhalt). Neue Präfixe nur bei echtem Bedarf.

### Confidence-Scoring-Formel

Berechne den Score beim Anlegen/Aktualisieren einer Seite:

| Signal | Punkte |
|---|---|
| Quellen ≥ 3 | +1 |
| Quelle = Buch / offizielle Docs | +1 |
| Quelle = LinkedIn / X / Blog-Post | −1 |
| Widerspruch-Marker (`⚠️`) vorhanden | −1 |
| Quelle älter als 18 Monate (schnelllebiges Thema) | −1 |
| Inbound Links ≥ 3 | +1 |
| Inbound Links = 0 (Waise) | −1 |

**Ergebnis:** ≥ 2 → `high` | 0–1 → `medium` | < 0 → `low`

`inbound_links` wird beim `/lint`-Lauf aktualisiert (nicht beim Ingest — zu teuer).

### Supersession

Wenn ein neues Ingest eine bestehende Seite **eindeutig ersetzt** (nicht nur ergänzt):

- Alte Seite: `superseded_by: "[[neue-seite]]"` + `confidence: low` im Frontmatter; Inhalt-Hinweis: `> ⚠️ Dieser Artikel wurde ersetzt durch [[neue-seite]] (DATUM)`
- Neue Seite: `supersedes: "[[alte-seite]]"` im Frontmatter

Unterschied zu `⚠️ Widerspruch`: Widerspruch = unklar welcher stimmt; Supersession = neue Quelle ist klar aktueller/besser.

---

## /ingest — Quelle einarbeiten

Wird aufgerufen wenn der User eine oder mehrere Zettelkasten-Notizen übergibt.

**Pflicht: eine Datei nach der anderen.** Nie alle auf einmal lesen und dann verarbeiten.

Für jede Datei:
1. Lese die Datei komplett
2. Diskutiere kurz die wichtigsten Erkenntnisse mit dem User
3. Erstelle oder aktualisiere alle relevanten Wiki-Seiten:
   - Zusammenfassung der Quelle (`sources/<slug>.md` in wiki/)
   - Entitäts-Seiten (Personen, Projekte, Werkzeuge, Orte)
   - Konzept-Seiten (Ideen, Muster, Techniken)
   - Querverweise zu bestehenden Seiten aktualisieren
   - Widersprüche markieren mit `> ⚠️ Widerspruch zu [[seite]]`
   - Supersession prüfen: ersetzt der neue Inhalt eine bestehende Seite eindeutig?
   - **Frontmatter setzen:** Tags (mind. 2), Confidence-Score + Reason, `last_reviewed: heute`
4. Aktualisiere `index.md` — neue Seiten eintragen
5. Schreibe Log-Eintrag: `## [YYYY-MM-DD] ingest | <Dateiname>`
6. Erst dann: nächste Datei

Typisch berührt ein Ingest 5–15 Wiki-Seiten.

## /query — Frage beantworten

1. Lese zuerst `index.md` um relevante Seiten zu finden
2. Öffne die relevanten Seiten
3. Synthetisiere eine Antwort mit Verweisen auf Wiki-Seiten
4. Gute Antworten die neue Erkenntnisse enthalten → als neue Wiki-Seite speichern (`source-type/synthese`)

## /lint — Wiki-Gesundheitscheck

Suche nach und erstelle Befund-Report:

**Inhaltsqualität:**
- Widersprüchen zwischen Seiten
- Veralteten Behauptungen (neuere Quellen widersprechen)
- Fehlenden Querverweisen zwischen verwandten Seiten
- Konzepten die eine eigene Seite verdienen, aber noch verstreut sind
- Lücken: wichtige Themen die im Zettelkasten fehlen

**Confidence & Tags:**
- Seiten ohne `tags`-Feld → Tags vorschlagen
- Seiten ohne `confidence`-Feld → Score berechnen und anbieten
- `confidence: low` + >90 Tage seit `last_reviewed` → als Review-Kandidat markieren
- Seiten mit `superseded_by` → Info-Liste

**Struktur:**
- Waisen-Seiten: `inbound_links: 0` → Liste mit Vorschlägen wo sie verlinkt werden könnten

`inbound_links` bei jedem `/lint`-Lauf aktualisieren:
```bash
grep -rl "\[\[seitenname" /workspace/agent/llm-wiki/ --include="*.md" | wc -l
```
(Pro Seite einmal ausführen, Wert ins Frontmatter schreiben)

Biete nach dem Report an, Probleme zu beheben.

## /batch — Thematischer Massen-Ingest

Für den Batch-Ingest nach Thema:
1. Liste mit `ls /workspace/extra/private-vault/zettelkasten/` alle Dateien
2. Schlage dem User Themen-Cluster vor (z.B. "Kubernetes (23 Dateien)", "Bücher (15 Dateien)")
3. User wählt ein Cluster
4. Verarbeite Datei für Datei mit /ingest-Workflow
5. Nach dem Cluster: kurze Zusammenfassung was neu in der Wiki ist
