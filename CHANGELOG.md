# Changelog

All notable changes to **NC Connector for Thunderbird** will be documented in this file.

This project targets **Thunderbird ESR 140.\***.

## 2.2.8

Release package version is **2.2.8**.
Functional delta documented here corresponds to **2.2.7 -> 2.2.8** only.

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

