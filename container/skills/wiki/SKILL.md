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
   - Widersprüche zu bestehenden Seiten markieren mit `> ⚠️ Widerspruch zu [[seite]]`
4. Aktualisiere `index.md` — neue Seiten eintragen
5. Schreibe Log-Eintrag: `## [YYYY-MM-DD] ingest | <Dateiname>`
6. Erst dann: nächste Datei

Typisch berührt ein Ingest 5–15 Wiki-Seiten.

## /query — Frage beantworten

1. Lese zuerst `index.md` um relevante Seiten zu finden
2. Öffne die relevanten Seiten
3. Synthetisiere eine Antwort mit Verweisen auf Wiki-Seiten
4. Gute Antworten die neue Erkenntnisse enthalten → als neue Wiki-Seite speichern

## /lint — Wiki-Gesundheitscheck

Suche nach:
- Widersprüchen zwischen Seiten
- Waisen-Seiten (keine eingehenden Links)
- Veralteten Behauptungen (neuere Quellen widersprechen)
- Fehlenden Querverweisen zwischen verwandten Seiten
- Konzepten die eine eigene Seite verdienen, aber noch verstreut sind
- Lücken: wichtige Themen die im Zettelkasten fehlen

Erstelle einen Befund-Report und biete an, Probleme zu beheben.

## /batch — Thematischer Massen-Ingest

Für den Batch-Ingest nach Thema:
1. Liste mit `ls /workspace/extra/private-vault/zettelkasten/` alle Dateien
2. Schlage dem User Themen-Cluster vor (z.B. "Kubernetes (23 Dateien)", "Bücher (15 Dateien)")
3. User wählt ein Cluster
4. Verarbeite Datei für Datei mit /ingest-Workflow
5. Nach dem Cluster: kurze Zusammenfassung was neu in der Wiki ist
