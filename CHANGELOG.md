# Changelog

All notable changes to **NC Connector for Thunderbird** will be documented in this file.

This project targets **Thunderbird ESR 140.\***.

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

