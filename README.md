# Gesprächskalender

Web-App, um im Nachhinein einzutragen, wann ein **Vorgespräch** oder ein
**Seelsorgegespräch** stattgefunden hat – **persönlich** oder per **Telefon**
(Terminarten und Formen sind in den Einstellungen frei anpassbar).

- Monatskalender, Einträge mit Datum, optionaler Uhrzeit, Art, Form, Kürzel und Notiz
- Übersicht pro Monat und Jahr
- Anmeldung mit Passwort, Einstellungen für Terminarten, Formen, Farben und Passwort
- **Automatische Speicherung online, auf allen Geräten gleich**
- **Ende-zu-Ende-verschlüsselt:** Die Einträge werden im Browser mit dem Passwort
  verschlüsselt (AES-GCM, Schlüssel per PBKDF2 aus dem Passwort). Der Server
  speichert nur verschlüsselte Daten und kennt weder Passwort noch Inhalte.
- Zusätzlich Sicherung als Datei herunterladen / einlesen

## Aufbau

- `public/` – die App (HTML, CSS, JavaScript)
- `netlify/functions/api.mjs` – Server-Funktion unter `/api/*`
- `netlify/lib/handler.mjs` – Anmeldung, Sitzungen, Speichern (Netlify Blobs)

## Hosting auf Netlify (kostenlos)

Die App muss **über GitHub** mit Netlify verbunden sein (nicht per Drag-and-drop),
damit die Server-Funktion und der Datenspeicher funktionieren:

1. Netlify → **Add new site → Import an existing project → GitHub** → dieses Repository wählen
2. Branch: den Branch mit diesem Code; alles andere steht in `netlify.toml`
3. **Deploy** – fertig. Netlify Blobs braucht keine weitere Einrichtung.

Beim ersten Anmelden gilt das Start-Passwort. Danach in den Einstellungen ein eigenes
Passwort setzen. **Wichtig:** Ohne Passwort lassen sich die Daten nicht entschlüsseln.

## Wichtig bei Passwortverlust

Es gibt keine „Passwort vergessen“-Funktion – das ist bei Ende-zu-Ende-Verschlüsselung
nicht möglich. Eine heruntergeladene Sicherungsdatei ist unverschlüsselt und kann
jederzeit wieder eingelesen werden; bitte sicher aufbewahren.
