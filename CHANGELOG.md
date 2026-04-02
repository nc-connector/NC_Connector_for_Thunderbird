# Changelog

All notable changes to **NC Connector for Thunderbird** will be documented in this file.

This project targets **Thunderbird ESR 140.\***.

## 3.0.1

Release package version is **3.0.1**.  
Functional delta documented here corresponds to **3.0.0 -> 3.0.1**.

### Changed
- Release/version references were aligned to `3.0.1` across manifest, review notes, readmes, and docs.
- Plain-text Talk invitation templates now persist correctly in Thunderbird rich event-description editors; the editor bridge synchronizes Thunderbird's HTML/text description state for both HTML and plain-text writes.
- Backend-provided Talk/Share HTML is sanitized client-side with bundled `DOMPurify 3.3.1` before use.
- `ncCalToolbar` no longer parses inbound description HTML via `innerHTML` in privileged experiment code.
- Active add-on/runtime hardening was extended:
  - legacy `execCommand(...)` usage was removed from the active editor/plain-text and clipboard fallback paths
  - sharing wizard upload-status rendering no longer writes HTML via `innerHTML`; DOM nodes are created explicitly instead
  - attachment-mode DAV folder creation now skips known-existing base prefixes, avoiding benign repeated `MKCOL 405` responses in the common upload flow
  - shared UI debug forwarding now tracks page teardown centrally so expected `context unloaded` / `Conduits` runtime disconnects do not surface as false-positive errors during popup close
- Separate-password follow-up delivery was hardened after the 3.0.0 release:
  - the final main-mail envelope is captured on `compose.onBeforeSend`
  - live sender changes are tracked on `compose.onIdentityChanged`
  - the Thunderbird sender identity is resolved via `accountsRead` / identity lookup
  - the password follow-up targets only the primary mail `To` recipients
  - the auto-send path now warms the freshly opened password compose tab before sending and uses a longer timeout guard for slower Thunderbird/SMTP handshakes
  - a manual password-mail draft is opened whenever sender identity resolution is ambiguous/unavailable or auto-send fails
  - committed shares are never deleted after the primary mail was sent

## 3.0.0

Release package version is **3.0.0**.  
Functional delta documented here corresponds to **2.3.0 -> 3.0.0**.

### Changed
- Functional runtime baseline remains equivalent to the hardened 2.3.0 line, now including optional NC Connector backend policy mode:
  - backend status endpoint is queried on Talk wizard open, Sharing wizard open, Settings open, and Settings save
  - active valid seats enable backend policy values plus `policy_editable` locks
  - paused/invalid seat states show UI warnings and fall back to local add-on settings
  - central templates can control share HTML/password blocks and Talk description text
  - separate password follow-up delivery is explicitly gated behind backend endpoint + active assigned seat
  - backend custom text templates are only activated when the language override is set to `Custom`, otherwise local UI-default text remains active
  - backend attachment-threshold policy now treats `attachments_min_size_mb: null` as an explicit "disabled" state
  - locked backend attachment-automation policy is now also enforced in compose runtime, not only in Settings/Wizard UI
  - backend policy runtime now targets `/apps/ncc_backend_4mc/api/v1/status`
  - if the backend is unreachable or the license/seat state is no longer usable, Thunderbird falls back to local add-on settings
  - Talk event descriptions now honor backend `event_description_type`; HTML templates are written into Thunderbird's rich event-description editor while keeping the plain-text representation aligned via the editor snapshot
  - Talk room creation now uses one authoritative server-side create path without fallback from event conversation to standard room or pseudo URLs
  - share creation now follows the documented Nextcloud OCS contract more closely: `label` is sent during create, while mutable metadata like `note` is updated later via form-encoded OCS update arguments
  - stale Talk create fallback contract fields were removed from runtime/UI cleanup payloads
  - duplicate background error logs were reduced in active compose/Talk paths
  - core runtime errors now use always-on error logging independent of the debug fla

## 2.2.9

Release package version is **2.2.9**.
Functional delta documented here corresponds to **2.2.8 -> 2.2.9** only.

### Changed
- Calendar editor Talk button wiring was switched to the official `calendar_item_action` path:
  - `manifest.json` now declares `calendar_item_action` + `calendarItemAction`
  - `ncCalToolbar` no longer injects a custom toolbarbutton
  - `ncCalToolbar` now binds its click/context bridge to the official action button
- Lobby time synchronization was hardened to a single deterministic contract:
  - `X-NCTALK-START` is now the only authoritative source for lobby timer updates
  - no lobby-time fallback derivation from `DTSTART/TZID` is used in runtime updates
  - missing/invalid `X-NCTALK-START` now causes explicit error logging and skips lobby update
  - calendar upsert no longer parses `DTEND` with custom TZID conversion, avoiding noisy Windows-TZID (`W. Europe Standard Time`) offset-resolution errors in logs
- Wizard popup focus handling was hardened (Talk + Sharing):
  - best-effort foreground focus request right after popup creation
  - short retry sequence to reduce startup/window-manager race conditions
  - deterministic debug logging for focus attempts and outcomes
- Talk user/guest/moderator controls are now guarded by live system-addressbook availability checks:
  - options + wizard disable affected controls when the system address book is unavailable
  - options include a dedicated red warning block with setup-guide link
  - lock tooltips switch context-aware: normal help when available, lock hint when unavailable
  - availability checks are forced on Talk button click, on options open, and on options save
- Talk-button addressbook preflight is now non-blocking (fire-and-forget), so wizard opening no longer waits on network status probes.
- `ncCalToolbar` startup retry handling was hardened with delayed backoff retries (instead of tight main-thread redispatch), reducing intermittent startup race failures when `ExtensionSupport` is not ready yet.
- UI debug forwarding now suppresses expected teardown-time runtime disconnect rejections (context unload / Conduits), avoiding noisy false-error logs during popup close.
- Background runtime responsibilities were split further:
  - `modules/bgCalendarLifecycle.js` for calendar wizard context + room-cleanup lifecycle helpers
  - `modules/talkAddressbook.js` for system-addressbook fetch/cache/search/status logic
- Options Talk tab now forces one live addressbook refresh when opened; window-focus refresh uses cached status (no forced probe on every focus switch).
- About tab content was aligned with the Outlook variant:
  - homepage row now links to `https://nc-connector.de`
  - technical overview + "More information" block is shown in About
  - localized About texts were synchronized across all shipped locales
- Documentation and release references were updated to 2.2.9 across manifest/readmes/docs.

### Added
- Best-effort popup focus helper in background runtime (`focusPopupWindowBestEffort`) reused by both wizard entrypoints.
- System address book hardening for Talk user/guest/moderator flows:
  - live availability checks in wizard/options
  - lock state + guidance tooltip when unavailable
  - admin docs include Nextcloud 31 (`occ`) and Nextcloud >=32 (UI) enablement path

### Clarified
- **Send password in separate email** remains intentionally disabled in this release (visible but locked).
- Readme/docs now reflect the effective runtime behavior (no active separate-password dispatch path in normal UI flow).

## 2.2.8

### Changed
- `ncCalToolbar` was hardened for deterministic editor targeting in dialog and tab event editors.
- Event write-back and cleanup paths were stabilized for open editors (including unsaved item flows).
- Sharing wizard queue behavior was improved (active-row highlight, success colors, path-column handling).
- Attachment upload flow was simplified in newly created share folders by removing redundant per-file pre-checks.
- Remote cleanup behavior was tightened for wizard and compose flows when shares are not sent.
- Error handling and debug logging were normalized to explicit, deterministic runtime logs.

### Added
- Attachment automation modes:
  - always share attachments via NC Connector
  - threshold-based prompt with deterministic user actions
  - direct attachment-mode wizard start in step 3
- Conflict lock for Thunderbird’s native “Upload for files larger than ...” setting with explicit user guidance.
- Centralized i18n/runtime parity checks and parser contract checks in local tooling.

### Disabled In This Release
- **Send password in separate email** is intentionally disabled in options and sharing wizard.
- The control stays visible but is grayed out with a “Coming soon (Pro feature)” tooltip.
- Runtime guard keeps separate-password dispatch inactive even if legacy settings exist.

## 2.2.7

### Removed
- Removed the previous calendar event editor **injection/bridge experiment** used in 2.2.5.

### Added / Changed
- Added a **minimal** calendar toolbar experiment (`experiments/ncCalToolbar`) to reliably provide the Talk button in both event editor variants:
  - dialog editor (`calendar-event-dialog.xhtml`)
  - tab editor (inside `messenger.xhtml` / calendar event tab)
- Talk wizard is opened as a **real popup window** (`browser.windows.create`) from the calendar toolbar button.
- Event write-back now targets the **currently edited** item (title/location/description + `X-NCTALK-*` metadata) and is persisted when the editor is saved.
- “Add participants” was split into **Add users** (internal Nextcloud users) and **Add guests** (external e-mail invitees) with dedicated defaults and tooltips.
- Updated documentation for admins and developers:
  - `docs/ADMIN.md`
  - `docs/DEVELOPMENT.md`
  - `Translations.md`

### Notes
- Invitee sync (users/guests) is applied **after saving** the event, driven by calendar item updates (official calendar experiment API under `experiments/calendar`, unchanged).
