# Add-on Beschreibung

## Uebersicht
Dieses Add-on integriert Nextcloud Talk und Nextcloud-Freigaben in Thunderbird.
- Freigaben aus dem Compose-Fenster mit Upload und Metadaten
- Talk-Raum-Erstellung mit Lobby, Moderator-Delegation und optionaler Teilnehmer-Uebernahme
- Kalender-Integration ueber Metadaten und Dialog-/Tab-Injektion
- Zentrale Optionen fuer Zugangsdaten und Defaults
- Debug-Logging ueber UI, Background und Experiment

## Architektur
- modules/*: Kernlogik fuer OCS-Requests, Auth, Talk, Freigabe, i18n, Background
- ui/*: HTML/JS-Dialoge und Helfer (Optionen, Freigabe-Wizard, Talk Dialog, Popup Sizing, DOM i18n)
- experiments/*: Kalender-Experiment fuer Window-Hooking und Dialog-Injektion (parent.js, calToolbarShared.js, calToolbarDialog.js)
Datenfluss:
1. Optionen werden in storage gespeichert (Base URL, Auth-Modus, Defaults)
2. Auth via NCCore und Basic-Auth-Header
3. OCS- und DAV-Requests via NCOcs
4. UI-Dialoge sprechen mit dem Background per Messaging oder Experiment-Bridge
5. Ergebnisse gehen in Compose-HTML oder Kalender-Metadaten
Die Kalender-Integration nutzt ein Experiment, weil der Event-Dialog in privilegierten Fenstern laeuft.
Das Experiment registriert Window-Listener und injiziert Scripts zum Lesen/Schreiben der Felder.

## Features (technisch)
### Freigabe
- Erstellt einen datierten Share-Ordner ueber DAV und laedt Dateien hoch
- Erstellt Shares ueber /ocs/v2.php/apps/files_sharing/api/v1/shares
- Setzt Defaults fuer Share-Name, Rechte, Passwort und Ablaufdatum
- Beruecksichtigt Nextcloud Passwort-Policy (Mindestlaenge + Generator-API mit sicherem Fallback)
- Aktualisiert Share-Metadaten (Notiz, Label) nach dem Upload
- Behandelt doppelte Namen und Remote-Konflikte; Fehlerpfade aus DAV/OCS

### Talk
- Capabilities-Check fuer Talk und Core bestimmt Event-Conversation-Support
- Erstellt oeffentliche Raeume ueber /ocs/v2.php/apps/spreed/api/v4/room
- Optional Lobby-Timer und Listable-Settings
- Optionales automatisches Hinzufuegen der eingeladenen Teilnehmer (Nextcloud-User via Systemadressbuch, sonst per E-Mail)
- Baut Description-Block mit Link, Passwort und Help-URL
- Unterstuetzt Moderator-Delegation und Participant-Promotion
- Beruecksichtigt Nextcloud Passwort-Policy (Mindestlaenge + Generator-API mit sicherem Fallback)

### Kalender
- Injektion eines Talk-Buttons in den Event-Dialog und den Tab-Editor (iframe-Varianten)
- Speichert Metadaten in X-NCTALK-* Properties (TOKEN, URL, LOBBY, START, EVENT, OBJECTID, ADD-PARTICIPANTS, DELEGATE, DELEGATE-NAME, DELEGATED, DELEGATE-READY)
- Liest Titel/Ort/Beschreibung und schreibt Updates zurueck in den Dialog
- Persistiert Lobby-Updates bei Kalenderaenderungen (Drag-and-drop oder Dialog-Edit) und Cleanup bei Loeschung

### Logging und Debug
- Debug-Modus in den Optionen aktiviert detaillierte Logs
- Log-Kanaele: [NCBG], [NCUI], [NCSHARE], [NCExp], [NCDBG]
- Background-Logs enthalten OCS/DAV-Status und Metadaten-Entscheidungen

## Kompatibilitaet und Anforderungen
- Thunderbird ESR 140 (strict_min_version 140.0, strict_max_version 140.*)
- Nextcloud mit aktivierten OCS-Endpunkten und Talk
- Dateifreigabe via DAV und OCS (remote.php und files_sharing API)
- App-Passwort oder Login Flow v2 fuer Auth
- Permissions: storage (Optionen, Metadaten), compose (UI-Integration), optionale Host-Permissions pro konfigurierte Nextcloud-Instanz

## Konfiguration
- Base URL, User und App-Passwort (manuell) oder Login Flow v2 (automatisch)
- Debug-Modus fuer detaillierte Logs
- Freigabe-Basisverzeichnis und Default-Share-Name/Rechte/Passwort/Ablauf
- Talk Defaults: Titel, Lobby, Listable, Room Type (event vs normal), Teilnehmer-Uebernahme
Security-Hinweise:
- Zugangsdaten liegen in browser.storage.local und werden fuer Basic-Auth-Header genutzt
- Debug-Logs koennen URLs und Metadaten enthalten; Logs vertraulich behandeln

## Entwicklungshinweise
- Projektstruktur: modules/ fuer Kernlogik, ui/ fuer Dialoge, experiments/ fuer Kalender-Integration
- Build/Packaging: keine Build-Skripte im Repo; Paketierung als Thunderbird Add-on Bundle falls noetig
- Smoke-Test-Checkliste:
  - Optionen: "Test connection" mit gueltigen Zugangsdaten
  - Freigabe-Wizard: Share erstellen, Upload, HTML einfuegen
  - Talk Dialog: Raum erstellen und Felder anwenden
  - Kalender Event-Dialog: Metadaten setzen, speichern, neu oeffnen, X-NCTALK-* pruefen
