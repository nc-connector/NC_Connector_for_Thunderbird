# Add-on Beschreibung

Für eine detaillierte Entwickler-Dokumentation (Onboarding, Storage-Schema, Message-Contracts, Release-Checkliste), siehe `docs/DEVELOPMENT.md`.

## Übersicht
Dieses Add-on integriert Nextcloud Talk und Nextcloud-Freigaben in Thunderbird.
- Freigaben aus dem Compose-Fenster mit Upload und Metadaten
- Talk-Raum-Erstellung mit Lobby, Moderator-Delegation und optionaler Teilnehmer-Übernahme (getrennt nach Benutzern und Gästen)
- Kalender-Integration über Metadaten und einen stabilen Toolbar-Button im Termin-Editor
- Zentrale Optionen für Zugangsdaten und Defaults
- Debug-Logging über UI, Background und Experiment

## Architektur
- modules/*: Kernlogik für OCS-Requests, Auth, Talk, Freigabe, i18n, Background
- ui/*: HTML/JS-Dialoge und Helfer (Optionen, Freigabe-Wizard, Talk Dialog, Popup Sizing, DOM i18n)
- experiments/calendar/*: Thunderbird Kalender-Experiment-API (Items CRUD + Lifecycle-Events) wird “as-is” genutzt
- experiments/ncCalToolbar/*: minimales UI-Experiment für die Integration in die Termin-Editoren (Dialog + Tab)

Kalender-Integration (high level):
- `experiments/ncCalToolbar` macht nur die **Editor-UI-Integration**:
  - Button in beide Editor-Varianten einfügen
  - iCalendar-Snapshot beim Klick liefern
  - Titel/Ort/Beschreibung + `X-NCTALK-*` Properties direkt auf den aktuell bearbeiteten Termin anwenden
  - „persisted vs discarded“ signalisieren, damit ungespeicherte Räume aufgeräumt werden können
- Die komplette Talk/Freigabe-Logik bleibt im WebExtension-Background (`modules/background.js`).
- Persistentes Monitoring (Lobby-Updates, Room-Delete bei Termin-Löschung, Delegation, Teilnehmer-Auto-Add) läuft über `browser.calendar.items.*` aus `experiments/calendar` (unverändert).

Datenfluss:
1. Optionen werden in storage gespeichert (Base URL, Auth-Modus, Defaults)
2. Auth via NCCore und Basic-Auth-Header
3. OCS- und DAV-Requests via NCOcs
4. UI-Dialoge sprechen mit dem Background per runtime messaging
5. Ergebnisse gehen zurück in:
   - Compose-HTML via `browser.compose.*` APIs
   - den aktuell bearbeiteten Termin via `ncCalToolbar` (Editor-Kontext)
6. Kalender-Lifecycle und persistente Updates laufen über `browser.calendar.items.*` (iCal-Format)

## Features (technisch)
### Freigabe
- Erstellt einen datierten Share-Ordner über DAV und lädt Dateien hoch
- Erstellt Shares ueber /ocs/v2.php/apps/files_sharing/api/v1/shares
- Setzt Defaults für Share-Name, Rechte, Passwort und Ablaufdatum
- Berücksichtigt Nextcloud Passwort-Policy (Mindestlänge + Generator-API mit sicherem Fallback)
- Aktualisiert Share-Metadaten (Notiz, Label) nach dem Upload
- Behandelt doppelte Namen und Remote-Konflikte; Fehlerpfade aus DAV/OCS

### Talk
- Capabilities-Check fuer Talk und Core bestimmt Event-Conversation-Support
- Erstellt öffentliche Räume über /ocs/v2.php/apps/spreed/api/v4/room
- Optional Lobby-Timer und Listable-Settings
- Optionales automatisches Hinzufügen der eingeladenen Teilnehmer, aufgeteilt in:
  - **Benutzer:** interne Nextcloud-Benutzer via Systemadressbuch
  - **Gäste:** externe Teilnehmer per E-Mail (kann – je nach Server-Settings – zusätzliche Einladungsmails von Nextcloud auslösen)
- Baut Description-Block mit Link, Passwort und Help-URL
- Unterstützt Moderator-Delegation und Participant-Promotion
- Berücksichtigt Nextcloud Passwort-Policy (Mindestlänge + Generator-API mit sicherem Fallback)

### Kalender
- Talk-Button in den Kalender-Termin-Editoren (Dialog + Tab) via minimalem UI-Experiment (`ncCalToolbar`)
- Klick öffnet den Talk Wizard als echtes Popup-Fenster (`browser.windows.create`, kein `default_popup` Panel)
- Liest den aktuell bearbeiteten Termin als iCal-Snapshot aus dem Editor-Kontext (funktioniert auch bei neuen/ungespeicherten Terminen)
- Write-back direkt in den offenen Editor:
  - Titel/Ort/Beschreibung (Link + optionaler Passwort/Hilfe-Textblock)
  - `X-NCTALK-*` Custom Properties (TOKEN, URL, LOBBY, START, EVENT, OBJECTID, ADD-USERS, ADD-GUESTS, legacy ADD-PARTICIPANTS, DELEGATE, DELEGATE-NAME, DELEGATED, DELEGATE-READY)
- Persistentes Monitoring über die Kalender-Experiment-API “as-is”:
  - Lobby-Updates bei Termin-Verschiebung
  - Room-Delete bei Termin-Löschung
  - Delegation + Teilnehmer-Auto-Add über Kalender-Item-Updates
- Räumt neu erstellte Räume auf, wenn der Editor ohne Speichern geschlossen wird (keine „Orphan“-Räume)

### Logging und Debug
- Debug-Modus in den Optionen aktiviert detaillierte Logs
- Log-Kanäle: [NCBG], [NCUI][Talk], [NCUI][Sharing], [NCCalToolbar]
- Background-Logs enthalten OCS/DAV-Status und Metadaten-Entscheidungen (nur wenn Debug aktiv ist)

## Kompatibilitaet und Anforderungen
- Thunderbird ESR 140 (strict_min_version 140.0, strict_max_version 140.*)
- Nextcloud mit aktivierten OCS-Endpunkten und Talk
- Dateifreigabe via DAV und OCS (remote.php und files_sharing API)
- App-Passwort oder Login Flow v2 fuer Auth
- Permissions: storage (Optionen, Metadaten), compose (UI-Integration), optionale Host-Permissions pro konfigurierte Nextcloud-Instanz

## Konfiguration
- Base URL, User und App-Passwort (manuell) oder Login Flow v2 (automatisch)
- Debug-Modus für detaillierte Logs
- Freigabe-Basisverzeichnis und Default-Share-Name/Rechte/Passwort/Ablauf
- Talk Defaults: Titel, Lobby, Listable, Room Type (event vs normal), Benutzer hinzufügen + Gäste hinzufügen
Security-Hinweise:
- Zugangsdaten liegen in browser.storage.local und werden fuer Basic-Auth-Header genutzt
- Debug-Logs können URLs und Metadaten enthalten; Logs vertraulich behandeln

## Entwicklungshinweise
- Projektstruktur: modules/ für Kernlogik, ui/ für Dialoge, experiments/ für Kalender-Integration
- Build/Packaging: keine Build-Skripte im Repo; Paketierung als Thunderbird Add-on Bundle falls nötig
- Smoke-Test-Checkliste:
  - Optionen: "Test connection" mit gültigen Zugangsdaten
  - Freigabe-Wizard: Share erstellen, Upload, HTML einfuegen
  - Talk Dialog: Raum erstellen, Felder/Metadaten anwenden, dann Termin speichern
  - Talk Dialog: Raum erstellen, Editor ohne Speichern schließen → Room-Cleanup wird ausgelöst
  - Kalender Event-Dialog: Metadaten setzen, speichern, neu öffnen, X-NCTALK-* prüfen
