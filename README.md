<div align="center" style="background:#0082C9; padding:1px 0;"><img src="ui/assets/header-solid-blue-1920x480.png" alt="Add-on" height="80"></div>

[English](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/README.md) | [Deutsch](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/README.de.md)
[Admin Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md) | [Development Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/DEVELOPMENT.md) | [Translations](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/Translations.md) | [VENDOR](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/VENDOR.md)

# NC Connector for Thunderbird

NC Connector is the Thunderbird-native Nextcloud integration for organizations that take Thunderbird seriously. The add-on brings shares, Talk meetings, managed signatures, and attachment rules directly into mail and calendar.

## What the add-on does

- create Nextcloud shares directly from new mails, replies, and forwards
- upload large files with Nextcloud chunked WebDAV upload v2 and send links instead of attachments
- control password, expiration date, permissions, and separate password delivery
- send passwords either as plain mail or as a Nextcloud Secret link
- create and update Talk rooms directly from Thunderbird events
- optionally add invited users and guests to Talk rooms
- apply managed email signatures from the optional backend
- use attachment automation with clear rules instead of manual steps
- write debug logs to Thunderbird's developer console for support cases

## Optional backend

Without the backend, sharing and Talk work locally in Thunderbird. With NC Connector Backend, teams get central management:

- seat assignment and policies
- defaults for sharing, Talk, and signatures
- custom HTML templates for shares, password mails, and Talk invitations
- separate password delivery and optional Nextcloud Secret links
- admin locks for selected options

## Sharing

The sharing wizard uploads files and folders to Nextcloud and inserts the finished share block into the mail. HTML mails receive a formatted block, plain-text mails receive a clean text block.

Key points:

- available in compose windows, replies, and forwards
- optional expiration date and custom permissions per share
- attachment automation for large attachments or always through NC Connector
- separate password mails are sent only after the primary mail was sent successfully
- if auto-send fails, NC Connector opens a prepared manual password mail
- closed drafts without successful send clean up created shares again

## Talk

A Thunderbird event can create a Nextcloud Talk room directly. The dialog supports lobby, password, room type, listable scope, and moderation.

NC Connector can sync event changes back to the room and add invited attendees. Discarded unsaved events clean up their Talk rooms again. Deleting saved events removes rooms only when this behavior is explicitly enabled.

## Signatures

With the backend, Thunderbird can insert managed email signatures or remove local signatures when the policy says so. NC Connector only touches the signature for the matching sender identity. Signatures from other accounts stay untouched.

## Installation

1. Install the latest XPI from [GitHub Releases](https://github.com/nc-connector/NC_Connector_for_Thunderbird/releases) or ATN.
2. Restart Thunderbird.
3. Open the add-on options.
4. Enter the Nextcloud URL.
5. Use Login with Nextcloud or enter an app password manually.
6. Test the connection and save.

## Requirements

- Thunderbird ESR 140 through ESR 153
- Windows, macOS, or Linux
- Nextcloud with Files Sharing
- for Talk features: Nextcloud Talk
- for user/moderator search: Nextcloud system address book
- for Secret-link password delivery: Nextcloud Secrets and NC Connector Backend

## Language

The UI is localized. Supported languages are documented in [`Translations.md`](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/Translations.md). Fallback is German, then English.

Text blocks for shares and Talk can be configured independently from the UI language. Backend templates are used only when the backend is available and the policy allows them.

## Troubleshooting

Debug mode can be enabled in the options. Relevant logs appear in Thunderbird's developer console with prefixes such as `[NCBG]`, `[NCUI][Talk]`, `[NCUI][Sharing]`, `[NCUI][Options]`, and `[ncCalToolbar]`.

For common setup, system address book, and backend policy issues, see the [Admin Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md).

## More documentation

- [Changelog](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/CHANGELOG.md)
- [Admin Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md)
- [Development Guide](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/DEVELOPMENT.md)
- [Third-party licenses](https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/VENDOR.md)

## Screenshots

<details>
<summary><strong>Settings</strong></summary>

| <a href="screenshots/Settings.png"><img src="screenshots/Settings.png" alt="Settings" width="230"></a> |
| --- |

</details>

<details>
<summary><strong>Talk wizard</strong></summary>

| <a href="screenshots/talk_wizzard1.png"><img src="screenshots/talk_wizzard1.png" alt="Talk wizard" width="230"></a> | <a href="screenshots/talk_wizzard2.png"><img src="screenshots/talk_wizzard2.png" alt="Talk wizard step 2" width="230"></a> |
| --- | --- |

</details>

<details open>
<summary><strong>Sharing wizard</strong></summary>

| <a href="screenshots/filelink_wizzard1.png"><img src="screenshots/filelink_wizzard1.png" alt="Sharing step 1" width="230"></a> | <a href="screenshots/filelink_wizzard2.png"><img src="screenshots/filelink_wizzard2.png" alt="Sharing step 2" width="230"></a> |
| --- | --- |
| <a href="screenshots/filelink_wizzard3.png"><img src="screenshots/filelink_wizzard3.png" alt="Sharing step 3" width="230"></a> | <a href="screenshots/filelink_wizzard4.png"><img src="screenshots/filelink_wizzard4.png" alt="Sharing step 4" width="230"></a> |
| <a href="screenshots/filelink_wizzard5.png"><img src="screenshots/filelink_wizzard5.png" alt="Sharing step 5" width="230"></a> | |

</details>
