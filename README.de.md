[English](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/README.md) | [Deutsch](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/README.de.md)
[Admin](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md) | [Development](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/DEVELOPMENT.md)

<div align="center" style="background:#0082C9; padding:1px 0;"><img src="ui/assets/header-solid-blue-1920x480.png" alt="Addon" height="80"></div>

##
NC Connector for Thunderbird verbindet Ihr Thunderbird direkt mit Nextcloud Talk und der sicheren Nextcloud-Freigabe. Ein einziger Klick öffnet einen modernen Wizard, erstellt automatisch Talk-Räume inklusive Lobby und Moderatoren Delegation und fügt den Meeting-Link mitsamt Passwort sauber in den Termin ein. Aus dem Verfassen-Fenster heraus erzeugen Sie auf Wunsch sofort eine Nextcloud-Freigabe inklusive Upload-Ordner, Ablaufdatum, Passwort und personalisierter Nachricht. Keine Copy-&-Paste-Orgien mehr, keine offenen Links in Mails: alles läuft in Thunderbird, alles wird sauber in Ihrer Nextcloud abgelegt.

Dies ist ein Community-Projekt und kein offizielles Produkt der Nextcloud GmbH.

## Highlights

- **Ein Klick zu Nextcloud Talk** 
Termin öffnen, Nextcloud Talk wählen, Raum konfigurieren, Moderator definieren. Optional können eingeladene Teilnehmer direkt in den Raum übernommen werden (getrennt nach internen Nextcloud-Benutzern und externen E-Mail-Gästen). Der Wizard schreibt Titel/Ort/Beschreibung inklusive Hilfe-Link automatisch in den Termin.
- **Sharing deluxe** 
Compose-Button Nextcloud Freigabe hinzufügen startet den Freigabe-Assistenten mit Upload-Queue, Passwortgenerator, Ablaufdatum und Notizfeld. Die fertige Freigabe landet als formatiertes HTML direkt in der E-Mail.
- **Enterprise-Sicherheit** 
Lobby bis Startzeit, Moderator-Delegation, automatisches Aufräumen nicht gespeicherter Termine, Pflicht-Passwörter und Ablauffristen schützen sensible Meetings und Dateien.
- **Nahtlose Nextcloud-Integration** 
Login-Flow V2, automatische Raumverfolgung sowie Debug-Logs in [NCBG], [NCUI][Talk], [NCUI][Sharing], [NCCalToolbar] helfen beim Troubleshooting.
- **ESR-ready** 
Optimiert und getestet für Thunderbird ESR 140.X mit minimalem Experiment-Anteil.

## Changelog

Siehe [`CHANGELOG.md`](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/CHANGELOG.md).

## Funktionsüberblick

### Nextcloud Talk direkt aus dem Termin
- Talk-Popup mit Lobby, Passwort, Listbarkeit, Raumtyp und Moderatorensuche.
- Automatische Einträge von Titel, Ort, Beschreibung (inkl. Hilfe-Link und Passwort) in das Terminfenster.
- Room-Tracking, Lobby-Updates, Delegations-Workflow und Cleanup, falls der Termin verworfen oder verschoben wird.
- Kalender-Aenderungen (Drag-and-drop oder Dialog-Edit) halten Lobby/Startzeit des Talk-Raums synchron.
- Optionales Teilnehmer-Sync nach dem Speichern des Termins:
  - **Benutzer:** interne Nextcloud-Benutzer werden direkt dem Raum hinzugefügt.
  - **Gäste:** externe E-Mail-Adressen werden als Gäste eingeladen (ggf. zusätzliche Einladung per E-Mail durch Nextcloud).

### Nextcloud Sharing im Compose-Fenster
- Vier Schritte (Freigabe, Ablaufdatum, Dateien, Notiz) mit passwortgeschütztem Upload-Ordner.
- Upload-Queue mit Duplikatprüfung, Fortschrittsanzeige und optionaler Freigabe.
- Automatische HTML-Bausteine mit Link, Passwort, Ablaufdatum und optionaler Notiz.

### Administration & Compliance
- Login Flow V2 (App-Passwort wird automatisch angelegt) und zentrale Optionen (Basis-URL, Debug-Modus, Freigabe-Pfade, Defaultwerte fuer Freigabe/Talk).
- Vollständige Internationalisierung (siehe [`Translations.md`](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/Translations.md)) und strukturierte Debug-Logs für Support-Fälle.

## Systemvoraussetzungen
- Thunderbird ESR 140.X (Windows/macOS/Linux)
- Nextcloud mit Talk & Freigabe (DAV) aktiviert
- App-Passwort oder Login Flow V2

## Installation
1. Aktuelle XPI 
`nc4tb-2.2.7.xpi` in Thunderbird installieren (Add-ons ? Zahnrad ? Add-on aus Datei installieren).
2. Thunderbird neu starten.
3. In den Add-on-Optionen Basis-URL, Benutzer und App-Passwort hinterlegen oder den Login Flow starten.

## Support & Feedback
- **Fehleranalyse:** Debug-Modus in den Optionen aktivieren; relevante Logs erscheinen als [NCBG], [NCUI][Talk], [NCUI][Sharing], [NCCalToolbar] in der Entwickler-Konsole von Thunderbird.

Viel Erfolg beim sicheren, professionellen Arbeiten mit NC Connector for Thunderbird!

## Screenshots

<details>
<summary><strong>Settings-Menü</strong></summary>

| <a href="screenshots/Settings.png"><img src="screenshots/Settings.png" alt="Settings-Menü" width="230"></a> |
| --- |

</details>

<details>
<summary><strong>Talk Wizard</strong></summary>

| <a href="screenshots/talk_wizzard1.png"><img src="screenshots/talk_wizzard1.png" alt="Talk Wizard" width="230"></a> | <a href="screenshots/talk_wizzard2.png"><img src="screenshots/talk_wizzard2.png" alt="Talk Wizard Schritt 2" width="230"></a> |
| --- | --- |

</details>

<details>
<summary><strong>Sharing Wizard</strong></summary>

| <a href="screenshots/filelink_wizzard1.png"><img src="screenshots/filelink_wizzard1.png" alt="Sharing Wizard Schritt 1" width="230"></a> | <a href="screenshots/filelink_wizzard2.png"><img src="screenshots/filelink_wizzard2.png" alt="Sharing Wizard Schritt 2" width="230"></a> |
| --- | --- |
| <a href="screenshots/filelink_wizzard3.png"><img src="screenshots/filelink_wizzard3.png" alt="Sharing Wizard Schritt 3" width="230"></a> | <a href="screenshots/filelink_wizzard4.png"><img src="screenshots/filelink_wizzard4.png" alt="Sharing Wizard Schritt 4" width="230"></a> |
| --- | --- |
| <a href="screenshots/filelink_wizzard5.png"><img src="screenshots/filelink_wizzard5.png" alt="Sharing Wizard Schritt 5" width="230"></a> |  |
| --- | --- |

</details>








