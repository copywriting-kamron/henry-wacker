# Obi Objekt-Checker

Live-Version des Objekt-Checkers von Brot & Butter Immobilien.

- `public/index.html` – die Seite (ohne Vorschau-Code)
- `api/obi.js` – Server-Endpoint `/api/obi`: schickt Unterlagen an Claude (mit Websuche für Marktpreise und Mietspiegel) und streamt die Antwort
- `lib/rules.js` – Obis Prüfregeln (Systemprompt)

## Auf Vercel live stellen

1. Repo in Vercel importieren (Framework: „Other“, kein Build-Befehl).
2. Umgebungsvariablen setzen:
   - `ANTHROPIC_API_KEY` – API-Key aus der Claude Console (Pflicht)
   - `OBI_CODE` – optionaler Zugangscode für die Testphase. Gesetzt: Link mit `?code=…` öffnen.
   - `OBI_MODEL` – optional, Standard `claude-opus-5-5`
3. Deploy. Fertig.

Einbettung auf bub-immo.de: Seite mit `?embed=1` im iframe laden (blendet Kopf und Fuß aus).
