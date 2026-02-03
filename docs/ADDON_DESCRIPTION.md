# Add-on Description

## Overview
This add-on integrates Nextcloud Talk and Nextcloud Sharing into Thunderbird.
- Sharing from the compose window with upload and share metadata
- Talk room creation with lobby, moderator delegation, and optional invitee sync
- Calendar event integration via metadata and dialog/tab injection
- Central options for credentials and defaults
- Debug logging across UI/background/experiment layers

## Architecture
- modules/*: core logic for OCS requests, auth, Talk, Sharing, i18n, and background orchestration
- ui/*: HTML/JS dialogs and helpers (options, sharing wizard, talk dialog, popup sizing, DOM i18n)
- experiments/*: calendar experiment for window hooking and dialog injection (parent.js, calToolbarShared.js, calToolbarDialog.js)
Data flow:
1. Options saved in storage (base URL, auth mode, defaults)
2. Auth resolved via NCCore and Basic auth header
3. OCS and DAV requests executed via NCOcs
4. UI dialogs call background via messaging or the experiment bridge
5. Results are written back into compose HTML or calendar metadata
The calendar integration uses an experiment because the event dialog lives in privileged windows.
The experiment registers window listeners and injects scripts to read and write event fields.

## Features
### Sharing
- Creates a dated share folder via DAV and uploads selected files
- Creates a share via /ocs/v2.php/apps/files_sharing/api/v1/shares
- Applies defaults for share name, permissions, password, and expiry date
- Honors Nextcloud password policies (min length + generator API with secure fallback)
- Updates share metadata (note, label) after upload
- Handles duplicate names and remote path conflicts; surfaces errors from DAV/OCS

### Talk
- Checks Talk capabilities and core capabilities to decide event-conversation support
- Creates public rooms via /ocs/v2.php/apps/spreed/api/v4/room
- Optional lobby scheduling and listable settings
- Optional auto-add of event invitees (Nextcloud users via system addressbook, others via e-mail)
- Builds a description block with link, password, and help URL
- Supports moderator delegation and participant promotion
- Honors Nextcloud password policies (min length + generator API with secure fallback)

### Calendar
- Injects a Talk button into the event dialog and the tab editor (iframe variants)
- Stores metadata in X-NCTALK-* properties (TOKEN, URL, LOBBY, START, EVENT, OBJECTID, ADD-PARTICIPANTS, DELEGATE, DELEGATE-NAME, DELEGATED, DELEGATE-READY)
- Reads current title/location/description and applies updates back to the dialog
- Persists lobby updates on calendar modifications (drag-and-drop or dialog edits) and handles cleanup on deletion

### Logging and Debug
- Enable debug mode in options to log detailed traces
- Logs appear with channels [NCBG], [NCUI], [NCSHARE], [NCExp], [NCDBG]
- Background logs include OCS/DAV status and metadata decisions

## Compatibility and Requirements
- Thunderbird ESR 140 (strict_min_version 140.0, strict_max_version 140.*)
- Nextcloud with OCS endpoints enabled and Talk installed
- File sharing via DAV and OCS (remote.php and files_sharing API)
- App password or Login Flow v2 for authentication
- Permissions: storage (options, metadata), compose (UI integration), optional host access per configured Nextcloud origin for API and login flow

## Configuration
- Base URL, user, and app password (manual) or Login Flow v2 (auto)
- Debug mode for verbose logging
- Sharing base path and default share name/permissions/password/expiry
- Talk defaults: title, lobby, listable, room type (event vs normal), add invitees toggle
Security notes:
- Credentials are stored in browser.storage.local and used to build Basic auth headers
- Debug logs may include URLs and metadata; treat logs as sensitive

## Development Notes
- Project structure: modules/ for core logic, ui/ for dialogs, experiments/ for calendar integration
- Build/Packaging: no build scripts in this repo; package as a Thunderbird add-on bundle when needed
- Smoke-test checklist:
  - Options: "Test connection" with valid credentials
  - Sharing wizard: create share, upload, insert HTML
  - Talk dialog: create room and apply fields
  - Calendar event dialog: set metadata, save, reopen, verify X-NCTALK-* values
