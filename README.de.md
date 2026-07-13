<div align="center" style="background:#0082C9; padding:1px 0;"><img src="ui/assets/header-solid-blue-1920x480.png" alt="Add-on" height="80"></div>

[English](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/README.md) | [Deutsch](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/README.de.md)
[Admin](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md) | [Development](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/DEVELOPMENT.md) | [Translations](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/Translations.md) | [VENDOR](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/VENDOR.md)

# NC Connector for Thunderbird

NC Connector ist die Thunderbird-native Nextcloud-Integration für Organisationen, die Thunderbird ernst nehmen. Das Add-on bringt Freigaben, Talk-Meetings, zentrale Signaturen und Anhangsregeln direkt in Mail und Kalender.

## Was das Add-on macht

- Nextcloud-Freigaben direkt aus neuen Mails, Antworten und Weiterleitungen erstellen
- große Dateien per Nextcloud Chunked WebDAV Upload v2 hochladen und als Link senden
- Passwort, Ablaufdatum, Berechtigungen und separate Passwortzustellung steuern
- Passwörter wahlweise als Klartext-Mail oder als Nextcloud Secret-Link senden
- Talk-Räume direkt aus Thunderbird-Terminen erstellen und aktualisieren
- eingeladene Benutzer und Gäste optional in Talk-Räume übernehmen
- zentrale E-Mail-Signaturen aus dem optionalen Backend anwenden
- Anhangsautomatisierung mit klaren Regeln statt manueller Einzelschritte nutzen
- Debug-Logs für Supportfälle in der Thunderbird-Entwicklerkonsole schreiben

## Optionales Backend

Ohne Backend funktionieren Freigaben und Talk lokal in Thunderbird. Mit NC Connector Backend kommen zentrale Steuerung und Team-Funktionen hinzu:

- Seat-Zuteilung und Richtlinien
- Vorgaben für Freigaben, Talk und Signaturen
- eigene HTML-Vorlagen für Freigaben, Passwortmails und Talk-Einladungen
- separate Passwortzustellung und optional Nextcloud Secret-Links
- Sperren einzelner Optionen durch Administratoren

## Freigaben

Der Freigabe-Assistent lädt Dateien und Ordner nach Nextcloud hoch und fügt den fertigen Freigabeblock in die Mail ein. HTML-Mails bekommen einen formatierten Block, Plaintext-Mails einen klaren Textblock.

Weitere Punkte:

- verfügbar in Compose-Fenstern, Antworten und Weiterleitungen
- optionales Ablaufdatum und eigene Berechtigungen pro Freigabe
- Anhangsautomatisierung für große Anhänge oder immer über NC Connector
- separate Passwortmails werden erst nach erfolgreichem Versand der Hauptmail verschickt
- bei Auto-Send-Fehlern öffnet sich eine vorbereitete manuelle Passwortmail
- geschlossene Entwürfe ohne erfolgreichen Versand räumen angelegte Freigaben wieder auf

## Talk

Aus einem Thunderbird-Termin kann direkt ein Nextcloud Talk-Raum erstellt werden. Der Dialog unterstützt Lobby, Passwort, Raumtyp, Listbarkeit und Moderation.

NC Connector kann Terminänderungen mit dem Raum abgleichen und eingeladene Teilnehmer übernehmen. Verworfene, nicht gespeicherte Termine räumen ihre Talk-Räume wieder auf. Das Löschen gespeicherter Termine entfernt Räume nur nach ausdrücklicher Aktivierung.

## Signaturen

Mit Backend kann Thunderbird zentral verwaltete E-Mail-Signaturen einfügen oder lokale Signaturen entfernen, wenn die Policy das vorgibt. NC Connector greift nur die Signatur der passenden Absenderidentität an. Signaturen anderer Konten bleiben unberührt.

## Installation

1. Aktuelle XPI aus den [GitHub Releases](https://github.com/nc-connector/NC_Connector_for_Thunderbird/releases) oder über ATN installieren.
2. Thunderbird neu starten.
3. Add-on-Optionen öffnen.
4. Nextcloud-URL eintragen.
5. Login mit Nextcloud oder manuelles App-Passwort nutzen.
6. Verbindung testen und speichern.

## Voraussetzungen

- Thunderbird ESR 140 bis ESR 153
- Windows, macOS oder Linux
- Nextcloud mit Files Sharing
- für Talk-Funktionen: Nextcloud Talk
- für Benutzer-/Moderatorensuche: Nextcloud-Systemadressbuch
- für Secret-Link-Passwortzustellung: Nextcloud Secrets und NC Connector Backend

## Sprache

Die UI ist lokalisiert. Unterstützte Sprachen sind in [`Translations.md`](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/Translations.md) dokumentiert. Fallback ist Deutsch, danach Englisch.

Textbausteine für Freigaben und Talk können in den Einstellungen unabhängig von der UI-Sprache gesetzt werden. Backend-Vorlagen werden nur genutzt, wenn das Backend vorhanden ist und die Policy sie freigibt.

## Fehleranalyse

Der Debug-Modus lässt sich in den Optionen aktivieren. Relevante Logs erscheinen in der Thunderbird-Entwicklerkonsole mit Prefixen wie `[NCBG]`, `[NCUI][Talk]`, `[NCUI][Sharing]`, `[NCUI][Options]` und `[ncCalToolbar]`.

Für typische Setup-, Systemadressbuch- und Backend-Policy-Probleme siehe den [Admin Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md).

## Weitere Dokumentation

- [Changelog](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/CHANGELOG.md)
- [Admin Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md)
- [Development Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/DEVELOPMENT.md)
- [Drittanbieter-Lizenzen](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/VENDOR.md)

## Roadmap

Geplante Arbeiten fuer Thunderbird, Outlook und Backend werden in der oeffentlichen [NC Connector Roadmap](https://github.com/orgs/nc-connector/projects/1) gepflegt.

## Screenshots

<details>
<summary><strong>Einstellungen</strong></summary>

| <a href="screenshots/Settings.png"><img src="screenshots/Settings.png" alt="Einstellungen" width="230"></a> |
| --- |

</details>

<details>
<summary><strong>Talk-Wizard</strong></summary>

| <a href="screenshots/talk_wizzard1.png"><img src="screenshots/talk_wizzard1.png" alt="Talk-Wizard" width="230"></a> | <a href="screenshots/talk_wizzard2.png"><img src="screenshots/talk_wizzard2.png" alt="Talk-Wizard Schritt 2" width="230"></a> |
| --- | --- |

</details>

<details open>
<summary><strong>Freigabe-Assistent</strong></summary>

| <a href="screenshots/filelink_wizzard1.png"><img src="screenshots/filelink_wizzard1.png" alt="Freigabe Schritt 1" width="230"></a> | <a href="screenshots/filelink_wizzard2.png"><img src="screenshots/filelink_wizzard2.png" alt="Freigabe Schritt 2" width="230"></a> |
| --- | --- |
| <a href="screenshots/filelink_wizzard3.png"><img src="screenshots/filelink_wizzard3.png" alt="Freigabe Schritt 3" width="230"></a> | <a href="screenshots/filelink_wizzard4.png"><img src="screenshots/filelink_wizzard4.png" alt="Freigabe Schritt 4" width="230"></a> |
| <a href="screenshots/filelink_wizzard5.png"><img src="screenshots/filelink_wizzard5.png" alt="Freigabe Schritt 5" width="230"></a> | |

</details>
