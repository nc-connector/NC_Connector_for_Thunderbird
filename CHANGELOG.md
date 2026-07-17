# Changelog

All notable changes to **NC Connector for Thunderbird** will be documented in this file.

This project targets **Thunderbird ESR 140** through **ESR 153**.

## 3.2.3

### Added
- A public roadmap and guided GitHub issue forms make planned work and useful support details easier to find.

### Changed
- Share blocks now use the language selected for backend templates, including link labels, introductory text, password notices, expiration dates, and rights.
- New clients prefer versioned backend share templates while remaining compatible with older backend responses.
- Repository checks now fetch the current Thunderbird webext-linter main branch before reviewing the add-on.

### Fixed
- Share blocks use wording that matches either a normal Nextcloud share page or a ZIP download.
- Login aliases such as email addresses no longer get used as Nextcloud DAV path IDs; the add-on uses the canonical user ID returned by Nextcloud.
- The sharing wizard no longer stops after its first step when canonical-user logging runs outside the background page.
- Backend signatures also replace matching Thunderbird file or Signature Switch signatures that appear shortly after the compose window opens.

## 3.2.2

### Added
- Repository review checks now run the Thunderbird webext-linter and local contract checks through npm/GitHub Actions.

### Changed
- Thunderbird compatibility metadata now targets ESR 140 through ESR 153, matching the APIs used by the add-on.

## 3.2.1

### Changed
- The Talk wizard now uses the native calendar item action popup and a more compact layout, improving focus behavior in event editors.
- Bundled DOMPurify is now 3.4.11.
- Thunderbird compatibility metadata covered ESR 115 through ESR 153.

### Fixed
- Backend email signatures no longer assign dynamic HTML through `innerHTML` in the compose bridge. Sanitized signature HTML is parsed in an inert document and imported into the compose DOM node by node.

## 3.2.0

### Added
- Managed Nextcloud URL setup can be provided through Thunderbird Enterprise Policy.
- Separate password delivery can use Nextcloud Secrets links when the backend and Secrets app are available.
- Sharing settings and the sharing wizard now include password delivery controls for plain mail or Secrets links.

### Changed
- README and admin/developer documentation now describe managed setup and Secrets password delivery.

### Fixed
- Managed URL lock hints are shown in Thunderbird options and localized across shipped languages.

## 3.1.4

### Changed
- Backend policy checks now log clearer setup diagnostics.

### Fixed
- Backend policy detection now works when a Nextcloud server requires the `index.php` app route because pretty URLs are not configured correctly.
- Reply and forward signatures stay in the author area, with quoted sender signatures left untouched.

## 3.1.3

### Added
- First-run setup now guides the user more clearly before a Nextcloud URL and app password are available.

### Changed
- Options refresh backend policy after saving connection settings.
- Policy handling in options and wizards now uses shared UI bindings.
- Password-policy and backend-policy helper code was moved into shared modules.
- UI error logging now goes through the shared safe logger where teardown races can happen.
- Runtime comments, helper docs, and old changelog wording were trimmed.
- Bundled DOMPurify was updated to 3.4.7.
- Generated share password HTML no longer contains inline JavaScript handlers.

### Fixed
- Separate password follow-up mails are kept until Thunderbird reports the send result, which fixes send races on newer Thunderbird builds.
- Talk rooms are deleted again when lobby setup fails after room creation.
- Talk rooms are cleaned up when writing the event data back to Thunderbird fails.
- Basic-auth header encoding no longer uses deprecated `unescape()`.
- Error fallback logging keeps the original error and the logging error separate.

## 3.1.2

### Added
- Improve large file uploads with Nextcloud chunked WebDAV v2.
- Show upload speed below progress bar and fix status text clipping.

### Changed
- Refactor: standardize error naming in runtime modules.

## 3.1.1

### Fixed (Mainline)
- Fix flaky iCal snapshot flow and keep X-NCTALK metadata in sync.

## 3.1.0

### Added
- Backend-controlled email signature settings were added for compose/reply/forward handling.

### Changed
- Signature ownership on replies/forwards is now bound strictly to the matching Nextcloud identity.
- Local Thunderbird/signature-switch signatures are preserved when backend signature delivery is disabled.
- Backend policy domains are handled independently to avoid cross-domain policy coupling.
- Talk calendar update rules were simplified around one predictable active path.

### Fixed
- Calendar/runtime behavior was stabilized to reduce fragility in Talk event processing.

### Documentation
- Thunderbird reviewer notes and sender parsing documentation were cleaned up and aligned with runtime behavior.
- Locale/doc alignment for the new calendar rules and signature behavior was refreshed.

## 3.0.4

### Added
- Optional Talk setting to delete linked Talk rooms when saved NC Connector calendar events are deleted:
  - available as a local add-on setting
  - controllable by backend policy via `talk_delete_room_on_event_delete`
  - off by default

### Changed
- Saved-event Talk room deletion now requires both explicit opt-in and trusted NC Connector `X-NCTALK-*` metadata.
- Legacy calendar token mappings without a trusted source are no longer accepted as room-deletion ownership proof.

### Fixed
- Generic Talk links in calendar `LOCATION` or `URL` fields no longer grant NC Connector ownership over a Talk room.
- Deleting a normal calendar event with a manually pasted Talk link no longer deletes the linked room.
- Unsaved event cleanup remains active for rooms created and then discarded during event creation.

## 3.0.3

### Added
- Mode-aware plain-text insertion for share mails and separate password follow-up mails:
  - share/password follow-up rendering now provides explicit pre-rendered HTML + plain-text variants
  - compose insertion supports dedicated plain-text output instead of relying on HTML-only rendering
  - share plain-text rules coverage was added and documented

### Changed
- Share/plain-text rendering was tightened further:
  - legacy share pre-rendering was removed from the upload/create path
- Sanitizer observability and debug behavior were improved:
  - backend Talk/share template sanitization now emits compact structural summaries on the existing add-on debug channels
  - Talk/Sharing teardown-time debug forwarding races were reduced during popup close
  - add-on logging channels were unified and legacy debug-path drift was removed from active runtime/UI paths
- Supporting maintenance updates included:
  - vendor calendar experiment refresh
  - Talk/Sharing wording updates with full locale coverage
### Fixed
- Talk guest help URL now points to the current documentation page.
- Local share-base default is now set to `NC Connector`.

## 3.0.2

### Changed
- Sanitizer-dependent backend HTML paths now fail closed instead of falling back to raw HTML:
  - share template rendering throws if the expected share HTML sanitizer is unavailable
  - Talk HTML template rendering throws if the expected Talk HTML sanitizer is unavailable
  - the privileged `descriptionHtml` bridge rejects the update if the expected sanitizer is unavailable

## 3.0.1

### Changed
- Plain-text Talk invitation templates now persist correctly in Thunderbird rich event-description editors; the editor bridge synchronizes Thunderbird's HTML/text description state for both HTML and plain-text writes.
- Backend-provided Talk/Share HTML is sanitized client-side with bundled `DOMPurify 3.3.1` before use.
- `ncCalToolbar` no longer parses inbound description HTML via `innerHTML` in privileged experiment code.
- Active add-on/runtime hardening was extended:
  - legacy `execCommand(...)` usage was removed from the active editor/plain-text and clipboard fallback paths
  - sharing wizard upload-status rendering no longer writes HTML via `innerHTML`; DOM nodes are created explicitly instead
  - attachment-mode DAV folder creation now skips known-existing base prefixes, avoiding benign repeated `MKCOL 405` responses in the common upload flow
  - shared UI debug forwarding now tracks page teardown centrally so expected `context unloaded` / `Conduits` runtime disconnects do not surface as false-positive errors during popup close
- Separate-password follow-up delivery was stabilized after the 3.0.0 release:
  - the final main-mail envelope is captured on `compose.onBeforeSend`
  - live sender changes are tracked on `compose.onIdentityChanged`
  - the Thunderbird sender identity is resolved via `accountsRead` / identity lookup
  - the password follow-up targets only the primary mail `To` recipients
  - the auto-send path now warms the freshly opened password compose tab before sending and uses a longer timeout guard for slower Thunderbird/SMTP handshakes
  - a manual password-mail draft is opened whenever sender identity resolution is ambiguous/unavailable or auto-send fails
  - committed shares are never deleted after the primary mail was sent

## 3.0.0

### Changed
- Functional runtime baseline remains equivalent to the stabilized 2.3.0 line, now including optional NC Connector backend policy mode:
  - backend status endpoint is queried on Talk wizard open, Sharing wizard open, Settings open, and Settings save
  - active valid seats enable backend policy values plus `policy_editable` locks
  - paused/invalid seat states show UI warnings and fall back to local add-on settings
  - central templates can control share HTML/password blocks and Talk description text
  - separate password follow-up delivery is explicitly restricted to backend endpoint + active assigned seat
  - backend custom text templates are only activated when the language override is set to `Custom`, otherwise local UI-default text remains active
  - backend attachment-threshold policy now treats `attachments_min_size_mb: null` as an explicit "disabled" state
  - locked backend attachment-automation policy is now also enforced in compose runtime, not only in Settings/Wizard UI
  - backend policy runtime now targets `/apps/ncc_backend_4mc/api/v1/status`
  - if the backend is unreachable or the license/seat state is no longer usable, Thunderbird falls back to local add-on settings
  - Talk event descriptions now honor backend `event_description_type`; HTML templates are written into Thunderbird's rich event-description editor while keeping the plain-text representation aligned via the editor snapshot
  - Talk room creation now uses one server-side create path without fallback from event conversation to standard room or pseudo URLs
  - share creation now follows the documented Nextcloud OCS rules more closely: `label` is sent during create, while mutable metadata like `note` is updated later via form-encoded OCS update arguments
  - stale Talk create fallback fields were removed from runtime/UI cleanup payloads
  - duplicate background error logs were reduced in active compose/Talk paths
  - core runtime errors now use always-on error logging independent of the debug fla

## 2.2.9

### Changed
- Calendar editor Talk button wiring was switched to the official `calendar_item_action` path:
  - `manifest.json` now declares `calendar_item_action` + `calendarItemAction`
  - `ncCalToolbar` no longer injects a custom toolbarbutton
  - `ncCalToolbar` now binds its click/context bridge to the official action button
- Lobby time synchronization was tightened to one predictable rule:
  - `X-NCTALK-START` is now the only source value for lobby timer updates
  - no lobby-time fallback derivation from `DTSTART/TZID` is used in runtime updates
  - missing/invalid `X-NCTALK-START` now causes explicit error logging and skips lobby update
  - calendar upsert no longer parses `DTEND` with custom TZID conversion, avoiding noisy Windows-TZID (`W. Europe Standard Time`) offset-resolution errors in logs
- Wizard popup focus handling was improved (Talk + Sharing):
  - best-effort foreground focus request right after popup creation
  - short retry sequence to reduce startup/window-manager race conditions
  - clear debug logging for focus attempts and outcomes
- Talk user/guest/moderator controls are now guarded by live system-addressbook availability checks:
  - options + wizard disable affected controls when the system address book is unavailable
  - options include a dedicated red warning block with setup-guide link
  - lock tooltips switch context-aware: normal help when available, lock hint when unavailable
  - availability checks are forced on Talk button click, on options open, and on options save
- Talk-button addressbook preflight is now non-blocking (fire-and-forget), so wizard opening no longer waits on network status probes.
- `ncCalToolbar` startup retry handling now uses delayed backoff retries (instead of tight main-thread redispatch), reducing intermittent startup race failures when `ExtensionSupport` is not ready yet.
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
- `ncCalToolbar` was improved for predictable editor targeting in dialog and tab event editors.
- Event write-back and cleanup paths were stabilized for open editors (including unsaved item flows).
- Sharing wizard queue behavior was improved (active-row highlight, success colors, path-column handling).
- Attachment upload flow was simplified in newly created share folders by removing redundant per-file pre-checks.
- Remote cleanup behavior was tightened for wizard and compose flows when shares are not sent.
- Error handling and debug logging were normalized to explicit runtime logs.

### Added
- Attachment automation modes:
  - always share attachments via NC Connector
  - threshold-based prompt with clear user actions
  - direct attachment-mode wizard start in step 3
- Conflict lock for Thunderbird’s native “Upload for files larger than ...” setting with explicit user guidance.
- Centralized i18n/runtime parity checks and parser rules checks in local tooling.

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
