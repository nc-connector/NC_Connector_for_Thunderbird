[English](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/README.md) | [Deutsch](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/README.de.md)
[Admin Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md) | [Development Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/DEVELOPMENT.md)

<div align="center" style="background:#0082C9; padding:1px 0;"><img src="ui/assets/header-solid-blue-1920x480.png" alt="Addon" height="80"></div>

##
NC Connector for Thunderbird connects Thunderbird directly with Nextcloud Talk and secure Nextcloud sharing. One click opens a modern wizard, creates Talk rooms with lobby and moderator delegation, and inserts the meeting link (including password) into the event. From the compose window, you can generate a Nextcloud share with upload folder, expiration date, password, and personal message. No copy-paste juggling and no open links in emails: everything stays in Thunderbird and is stored cleanly in your Nextcloud.

This is a community project and is not an official Nextcloud GmbH product.

## Highlights

- **One-click Nextcloud Talk**
  Open an event, choose Nextcloud Talk, configure the room, and define a moderator. Optionally add invitees to the room (separately for internal Nextcloud users and external e-mail guests). The wizard writes title/location/description (including help link) into the event.
- **Sharing deluxe**
  The "Add Nextcloud Share" button starts the sharing assistant with upload queue, password generator, expiration date, and note field. The finished share is inserted as formatted HTML into the email.
- **Enterprise security**
  Lobby until start time, moderator delegation, automatic cleanup of unsaved events, required passwords, and expiration policies protect sensitive meetings and files.
- **Seamless Nextcloud integration**
  Login Flow V2, automatic room tracking, and debug logs in [NCBG], [NCUI][Talk], [NCUI][Sharing], [NCCalToolbar] help with troubleshooting.
- **ESR-ready**
  Optimized and tested for Thunderbird ESR 140.X with a minimal experiment footprint.

## Changelog

See [`CHANGELOG.md`](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/CHANGELOG.md).

## Feature overview

### Nextcloud Talk directly from the event
- Talk popup with lobby, password, listable option, room type, and moderator search.
- Automatic insertion of title, location, and description (including help link and password) into the event.
- Room tracking, lobby updates, delegation workflow, and cleanup if the event is discarded or moved.
- Calendar changes (drag-and-drop or dialog edits) keep lobby/start time in sync on the server.
- Optional invitee sync after saving the event:
  - **Users:** internal Nextcloud users are added directly to the room.
  - **Guests:** external e-mail guests are invited as guests (they may receive an additional invitation e-mail from Nextcloud).

### Nextcloud Sharing in the compose window
- Four steps (share, expiration date, files, note) with a password-protected upload folder.
- Upload queue with duplicate checks, progress display, and optional share without upload.
- Automatic HTML blocks with link, password, expiration date, and optional note.

### Administration & compliance
- Login Flow V2 (app password is created automatically) and central options (base URL, debug mode, sharing paths, default values for Sharing/Talk).
- Full internationalization (see [`Translations.md`](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/Translations.md)) and structured debug logs for support cases.

## System requirements
- Thunderbird ESR 140.X (Windows/macOS/Linux)
- Nextcloud with Talk & Sharing (DAV) enabled
- App password or Login Flow V2

## Installation
1. Install the current XPI `nc4tb-2.2.7.xpi` in Thunderbird (Add-ons > Gear > Install Add-on From File).
2. Restart Thunderbird.
3. In the add-on options, enter base URL, user, and app password or start the login flow.

## Support & feedback
- **Troubleshooting:** Enable debug mode in the options; relevant logs appear as [NCBG], [NCUI][Talk], [NCUI][Sharing], [NCCalToolbar] in Thunderbird’s developer console.

Good luck with secure, professional work using NC Connector for Thunderbird!

## Screenshots

<details>
<summary><strong>Settings menu</strong></summary>

| <a href="screenshots/Settings.png"><img src="screenshots/Settings.png" alt="Settings menu" width="230"></a> |
| --- |

</details>

<details>
<summary><strong>Talk wizard</strong></summary>

| <a href="screenshots/talk_wizzard1.png"><img src="screenshots/talk_wizzard1.png" alt="Talk wizard" width="230"></a> | <a href="screenshots/talk_wizzard2.png"><img src="screenshots/talk_wizzard2.png" alt="Talk wizard step 2" width="230"></a> |
| --- | --- |

</details>

<details>
<summary><strong>Sharing wizard</strong></summary>

| <a href="screenshots/filelink_wizzard1.png"><img src="screenshots/filelink_wizzard1.png" alt="Sharing wizard step 1" width="230"></a> | <a href="screenshots/filelink_wizzard2.png"><img src="screenshots/filelink_wizzard2.png" alt="Sharing wizard step 2" width="230"></a> |
| --- | --- |
| <a href="screenshots/filelink_wizzard3.png"><img src="screenshots/filelink_wizzard3.png" alt="Sharing wizard step 3" width="230"></a> | <a href="screenshots/filelink_wizzard4.png"><img src="screenshots/filelink_wizzard4.png" alt="Sharing wizard step 4" width="230"></a> |
| --- | --- |
| <a href="screenshots/filelink_wizzard5.png"><img src="screenshots/filelink_wizzard5.png" alt="Sharing wizard step 5" width="230"></a> |  |
| --- | --- |

</details>








