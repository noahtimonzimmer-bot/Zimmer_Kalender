# Gesprächskalender

Kleine Web-App, um im Nachhinein einzutragen, wann ein **Vorgespräch** oder ein
**Seelsorgegespräch** stattgefunden hat – **persönlich (Treffen)** oder per **Telefon**.

- Monatskalender (Tag antippen → Eintrag anlegen; Tag mit Einträgen antippen → Liste, nochmal antippen → neuer Eintrag)
- Pro Eintrag: Datum, optionale Uhrzeit, Art, Form, optionales Kürzel und Notiz
- Übersicht: Anzahl pro Art und Form für den Monat und das Jahr
- Daten bleiben **nur im Browser auf deinem Gerät** (localStorage) – nichts wird ins Internet hochgeladen
- Sicherung als JSON-Datei herunterladen und wieder laden (auch zum Übertragen auf ein anderes Gerät)

## Kostenlos hosten mit GitHub Pages

1. Auf GitHub im Repository: **Settings → Pages**
2. Unter *Build and deployment*: Source **Deploy from a branch**, Branch wählen (z. B. `main`), Ordner `/ (root)` → **Save**
3. Nach ca. 1 Minute ist die App unter `https://<benutzername>.github.io/<repo-name>/` erreichbar.
4. Auf dem Handy im Browser öffnen → „Zum Startbildschirm hinzufügen“, dann verhält sie sich wie eine App.

Hinweis: Das Repository enthält nur den Programmcode, keine Einträge.

## Lokal ausprobieren

Einfach `index.html` im Browser öffnen.
