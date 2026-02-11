# Add-on Description

For a detailed developer guide (onboarding, storage schema, message contracts, release checklist), see `docs/DEVELOPMENT.md`.

## Overview
This add-on integrates Nextcloud Talk and Nextcloud Sharing into Thunderbird.
- Sharing from the compose window with upload and share metadata
- Talk room creation with lobby, moderator delegation, and optional invitee sync (separately for internal users and external guests)
- Calendar event integration via metadata and a stable event-editor toolbar button
- Central options for credentials and defaults
- Debug logging across UI/background/experiment layers

## Architecture
- modules/*: core logic for OCS requests, auth, Talk, Sharing, i18n, and background orchestration
- ui/*: HTML/JS dialogs and helpers (options, sharing wizard, talk dialog, popup sizing, DOM i18n)
- experiments/calendar/*: Thunderbird calendar experiment API (items CRUD + item lifecycle events) used “as-is”
- experiments/ncCalToolbar/*: minimal UI experiment to integrate with the calendar event editors (dialog + tab)

Calendar integration (high level):
- `experiments/ncCalToolbar` is responsible only for **editor UI integration**:
  - insert the Talk button in both editor variants
  - provide an iCalendar snapshot on click
  - apply title/location/description + `X-NCTALK-*` properties directly to the currently edited item
  - signal “persisted vs discarded” to enable cleanup of unsaved rooms
- All Talk/Sharing control logic remains in the WebExtension background (`modules/background.js`).
- Persistent monitoring (lobby updates, delete-room-on-event-delete, delegation flow, participant auto-add) uses `browser.calendar.items.*` from `experiments/calendar` (unchanged).

Data flow:
1. Options saved in storage (base URL, auth mode, defaults)
2. Auth resolved via NCCore and Basic auth header
3. OCS and DAV requests executed via NCOcs
4. UI dialogs call background via runtime messaging
5. Results are written back into:
   - compose HTML via `browser.compose.*` APIs
   - the currently edited calendar item via `ncCalToolbar` (editor context)
6. Calendar lifecycle monitoring and persisted updates use `browser.calendar.items.*` (iCal format)

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
- Optional auto-add of event invitees, split into:
  - **Users:** internal Nextcloud users via the system addressbook
  - **Guests:** external attendees via e-mail (may trigger additional invitation e-mails from Nextcloud, depending on server settings)
- Builds a description block with link, password, and help URL
- Supports moderator delegation and participant promotion
- Honors Nextcloud password policies (min length + generator API with secure fallback)

### Calendar
- Provides a Talk button inside the calendar event editors (dialog + tab) via a minimal UI experiment (`ncCalToolbar`)
- Clicking the button opens the Talk wizard as a real popup window (`browser.windows.create`, no `default_popup` panel)
- Reads the currently edited item as iCal snapshot from the editor context on click (works for new/unsaved items too)
- Writes back into the open editor:
  - title/location/description (link + optional password/help text block)
  - `X-NCTALK-*` custom properties (TOKEN, URL, LOBBY, START, EVENT, OBJECTID, ADD-USERS, ADD-GUESTS, legacy ADD-PARTICIPANTS, DELEGATE, DELEGATE-NAME, DELEGATED, DELEGATE-READY)
- Uses the calendar experiment API “as-is” for persisted monitoring:
  - lobby updates when the event time changes
  - delete room when an event is removed
  - delegation + participant auto-add triggered by calendar item updates
- Cleans up newly created rooms when the editor is closed without saving (prevents orphan rooms)

### Logging and Debug
- Enable debug mode in options to log detailed traces
- Logs appear with channels [NCBG], [NCUI][Talk], [NCUI][Sharing], [NCCalToolbar]
- Background logs include OCS/DAV status and metadata decisions (only when debug is enabled)

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
- Talk defaults: title, lobby, listable, room type (event vs normal), add users + add guests toggles
Security notes:
- Credentials are stored in browser.storage.local and used to build Basic auth headers
- Debug logs may include URLs and metadata; treat logs as sensitive

## Development Notes
- Project structure: modules/ for core logic, ui/ for dialogs, experiments/ for calendar integration
- Build/Packaging: no build scripts in this repo; package as a Thunderbird add-on bundle when needed
- Smoke-test checklist:
  - Options: "Test connection" with valid credentials
  - Sharing wizard: create share, upload, insert HTML
  - Talk dialog: create room, apply fields/metadata, then save the event
  - Talk dialog: create room, then close the editor without saving → room cleanup triggers
  - Calendar event dialog: set metadata, save, reopen, verify X-NCTALK-* values
