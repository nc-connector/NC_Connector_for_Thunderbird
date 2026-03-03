# Development Guide — NC Connector for Thunderbird

This document is the **single source of truth** for developers maintaining or extending **NC Connector for Thunderbird**.

It complements:
- `docs/ADDON_DESCRIPTION.md` (architecture overview)
- `docs/ATN_REVIEW_CHECKLIST_INTERNAL.md` (internal review constraints you must not violate)
- `docs/ATN_REVIEW_NOTES_2.2.8.md` (reviewer-facing release-specific notes)

---

## Table of Contents

- [1. Scope & goals](#1-scope--goals)
- [2. Supported versions](#2-supported-versions)
- [3. Repository layout](#3-repository-layout)
- [4. Running & debugging](#4-running--debugging)
  - [4.1 Install (XPI)](#41-install-xpi)
  - [4.2 Developer tools & consoles](#42-developer-tools--consoles)
  - [4.3 Debug logging](#43-debug-logging)
- [5. Internationalization (i18n)](#5-internationalization-i18n)
  - [5.1 How i18n works in this add-on](#51-how-i18n-works-in-this-add-on)
  - [5.2 Adding a new language](#52-adding-a-new-language)
  - [5.3 Language overrides (advanced settings)](#53-language-overrides-advanced-settings)
- [6. Options & storage keys](#6-options--storage-keys)
  - [6.1 Where options live](#61-where-options-live)
  - [6.2 Storage schema (key list)](#62-storage-schema-key-list)
  - [6.3 Migration notes](#63-migration-notes)
- [7. Calendar integration (Talk button in event editor)](#7-calendar-integration-talk-button-in-event-editor)
  - [7.1 Why a custom toolbar experiment exists](#71-why-a-custom-toolbar-experiment-exists)
  - [7.2 Editor variants: dialog vs tab](#72-editor-variants-dialog-vs-tab)
  - [7.2.1 Why manual tab/window correlation exists today](#721-why-manual-tabwindow-correlation-exists-today)
  - [7.3 `ncCalToolbar` API surface (editor-targeted)](#73-nccaltoolbar-api-surface-editor-targeted)
  - [7.4 Click snapshot & editor references](#74-click-snapshot--editor-references)
  - [7.5 Room cleanup signals](#75-room-cleanup-signals)
- [8. Talk wizard (end-to-end flow)](#8-talk-wizard-end-to-end-flow)
  - [8.1 Wizard open → snapshot](#81-wizard-open--snapshot)
  - [8.2 Create room](#82-create-room)
  - [8.3 Write-back to the currently edited event](#83-write-back-to-the-currently-edited-event)
  - [8.4 Users vs guests (invitee sync)](#84-users-vs-guests-invitee-sync)
  - [8.5 Room types](#85-room-types)
  - [8.6 Moderator delegation](#86-moderator-delegation)
- [9. Calendar monitoring & server sync](#9-calendar-monitoring--server-sync)
  - [9.1 Official calendar experiment API (as-is)](#91-official-calendar-experiment-api-as-is)
  - [9.2 What we do on create/update/remove](#92-what-we-do-on-createupdateremove)
  - [9.3 Orphan-room prevention](#93-orphan-room-prevention)
- [10. Sharing wizard (compose window)](#10-sharing-wizard-compose-window)
  - [10.1 Flow & responsibilities](#101-flow--responsibilities)
  - [10.2 Inserting the HTML block into the compose window](#102-inserting-the-html-block-into-the-compose-window)
  - [10.3 Share block language override](#103-share-block-language-override)
- [11. Data model](#11-data-model)
  - [11.1 `X-NCTALK-*` iCalendar properties](#111-x-nctalk--icalendar-properties)
  - [11.2 Internal persistence (`storage.local`)](#112-internal-persistence-storagelocal)
- [12. Runtime messaging contracts](#12-runtime-messaging-contracts)
  - [12.1 Background message types](#121-background-message-types)
  - [12.2 Common response shape](#122-common-response-shape)
- [13. Network endpoints used](#13-network-endpoints-used)
- [14. Packaging & release checklist](#14-packaging--release-checklist)
- [15. Troubleshooting](#15-troubleshooting)
- [16. Reviewer constraints (must-read)](#16-reviewer-constraints-must-read)

---

## 1. Scope & goals

Goals for this project:
- Provide **Nextcloud Talk** room creation directly from the **calendar event editor** (dialog + tab).
- Provide **Nextcloud sharing** directly from the **compose window** (sharing wizard).
- Maintain **no feature loss** across reviewer-driven changes.
- Keep custom experiments **minimal, deterministic, and auditable**.
- Keep all user-facing text **localized** via WebExtension i18n (`_locales/**/messages.json`).

Non-goals:
- We do not aim to implement our own calendar backend or duplicate Thunderbird’s calendar logic.
- We do not modify the official calendar experiment (`experiments/calendar/**`) used by the add-on.

---

## 2. Supported versions

Thunderbird:
- Target: **Thunderbird ESR 140.\***  
  Enforced by `manifest.json`:
  - `strict_min_version: "140.0"`
  - `strict_max_version: "140.*"`

Nextcloud:
- Requires a Nextcloud instance with:
  - OCS endpoints enabled
  - Nextcloud Talk installed
  - Files sharing (DAV + OCS) enabled

---

## 3. Repository layout

Top-level:
- `manifest.json` — add-on manifest (MV2) + experiment registrations
- `modules/` — shared logic (background + reusable modules)
- `ui/` — HTML/JS/CSS for options and wizards
- `experiments/`
  - `experiments/calendar/` — official calendar experiment API (kept **as-is**) for persisted item monitoring
  - `experiments/ncCalToolbar/` — minimal custom experiment for deterministic editor toolbar integration (dialog + tab)
  - `experiments/ncComposePrefs/` — read-only experiment exposing Thunderbird compose big-attachment prefs for conflict locking
- `_locales/` — translations (`messages.json` per locale)
- `docs/` — developer & reviewer documentation

Key files you’ll touch most:
- `modules/bgState.js` — shared runtime state, startup initialization, and `[NCBG]` log helper
- `modules/bgComposeAttachments.js` — compose attachment automation, threshold prompts, and sharing-launch context handling
- `modules/bgComposeShareCleanup.js` — compose-tab and wizard-window remote cleanup lifecycle
- `modules/bgComposePasswordDispatch.js` — separate-password-mail dispatch and password policy fetch/generate
- `modules/bgCompose.js` — compose/window/tab listener wiring
- `modules/bgCalendar.js` — `ncCalToolbar` integration, calendar wizard contexts, room metadata mapping, and persisted calendar monitoring sync
- `modules/bgRouter.js` — `runtime.onMessage` dispatcher for Talk/Sharing/Options/UI bridge contracts
- `modules/background.js` — thin bootstrap entrypoint
- `modules/hostPermissions.js` — single host-permission gate used by core/talk/sharing runtime modules
- `modules/nccore.js` — Nextcloud auth/login-flow helpers
- `modules/talkcore.js` — Nextcloud Talk API helpers (OCS)
- `modules/ncSharing.js` — Nextcloud sharing/DAV helpers used by the sharing wizard
- `modules/icalContract.js` — shared iCal/vCard parser contract (powered by vendored `vendor/ical.js`)
- `experiments/ncComposePrefs/parent.js` — read-only compose preference bridge (`mail.compose.big_attachments.*`)
- `ui/talkDialog.html` + `ui/talkDialog.js` — Talk wizard UI
- `ui/nextcloudSharingWizard.html` + `ui/nextcloudSharingWizard.js` — Sharing wizard UI
- `ui/debugForwarder.js` — shared runtime debug forwarding helper for Talk + Sharing wizard UIs
- `ui/passwordPolicyClient.js` — shared password-policy fetch/generate helper for both wizards
- `options.html` + `options.js` — settings UI

---

## 4. Running & debugging

### 4.1 Install (XPI)

Typical workflow (also used for manual testing):
1. Create an `.xpi` (it is just a ZIP with the add-on files at the root).
2. In Thunderbird: Add-ons Manager → Gear icon → **Install Add-on From File…**
3. Restart Thunderbird if required.

Important for packaging:
- `manifest.json` must be at the **root** of the XPI (not inside a nested folder).
- Avoid including previous `.xpi` files inside the new XPI.

### 4.2 Developer tools & consoles

To debug, you’ll typically use:
- The Thunderbird **Developer Console / Error Console** (for `[NCBG]`, `[NCUI][Talk]`, `[NCUI][Sharing]`, `[ncCalToolbar]`, and `[calendar.items]` logs).
- The add-on debug view (background + extension pages).

What to look for:
- `[NCBG]` — background logic (calendar monitoring, Talk operations, cleanup)
- `[NCUI][Talk]` — Talk wizard UI flow
- `[NCUI][Sharing]` — Sharing wizard UI flow
- `[ncCalToolbar]` — custom editor integration logs (button/context/read-write lifecycle)
- `[calendar.items]` — calendar monitoring logs (persisted item updates/removals)

### 4.3 Debug logging

Debug output is gated by the option:
- `debugEnabled` in `browser.storage.local`

Implementation:
- Background uses `L(...)` in `modules/bgState.js` and logs as `[NCBG] …` when enabled.
- UI pages can:
  - log locally to their own console, and/or
  - forward structured logs via `browser.runtime.sendMessage({ type: "debug:log", ... })` (see message contracts below).
- Attachment automation adds debug traces for:
  - threshold evaluation and prompt decisions in `[NCBG]`
  - attachment-mode wizard/prompt flow in `[NCUI][Sharing]`

Keep in mind:
- Debug logs can contain URLs, tokens, and metadata. Treat logs as sensitive.

---

## 5. Internationalization (i18n)

### 5.1 How i18n works in this add-on

Translations live in:
- `_locales/<locale>/messages.json`

UI translation in HTML:
- HTML uses `data-i18n="some_key"`
- `ui/domI18n.js` applies translations on page load.

JS translation:
- `modules/i18n.js` exposes a translate function used by UI and background.

Rule of thumb:
- Do not hardcode user-visible strings. Add a new i18n key instead.

### 5.2 Adding a new language

Checklist:
1. Add folder `_locales/<new_locale>/messages.json` (copy from `en` and translate the `message` fields).
2. Ensure **all keys exist** (missing keys show up as “Unknown localization message …”).
3. Add the locale to `Translations.md`.
4. Update `modules/i18nOverride.js`:
   - Add the locale to `SUPPORTED_LOCALES`
   - Add mapping to `SUPPORTED_BY_LOWER` if needed (for region/script normalization)
5. Verify JSON validity (no trailing commas).

### 5.3 Language overrides (advanced settings)

The options UI provides **language override selects** for generated text blocks:
- Sharing HTML block language (`shareBlockLang`)
- Talk event description language (`eventDescriptionLang`)

Implementation pieces:
- `options.html` + `options.js` populate selects from `NCI18nOverride.supportedLocales`.
- `modules/i18nOverride.js` loads `_locales/<locale>/messages.json` and provides:
  - `NCI18nOverride.tInLang(lang, key, substitutions)`

Design intent:
- The add-on UI follows the Thunderbird UI language (normal WebExtension i18n).
- Generated blocks inserted into mails/events can be forced to a specific language (useful in multi-language environments).

---

## 6. Options & storage keys

### 6.1 Where options live

Options UI:
- `options.html`
- `options.js`

Storage backend:
- `browser.storage.local`

### 6.2 Storage schema (key list)

Core:
- `baseUrl` — Nextcloud base URL
- `user` — Nextcloud username
- `appPass` — app password (or generated via Login Flow)
- `debugEnabled` — enable verbose logging

Talk defaults:
- `talkDefaultTitle`
- `talkDefaultLobby`
- `talkDefaultListable`
- `talkDefaultRoomType` (`"event"` or `"normal"`)
- `talkPasswordDefaultEnabled`
- `talkAddUsersDefaultEnabled`
- `talkAddGuestsDefaultEnabled`
- `talkAddParticipantsDefaultEnabled` (legacy; kept for backward compatibility as `addUsers || addGuests`)

Sharing defaults (managed by `modules/sharingStorage.js`):
- `sharingBasePath` (base path)
- `sharingDefaultShareName`
- `sharingDefaultPermCreate`
- `sharingDefaultPermWrite`
- `sharingDefaultPermDelete`
- `sharingDefaultPassword`
- `sharingDefaultPasswordSeparate`
- `sharingDefaultExpireDays`
- `sharingAttachmentsAlwaysConnector`
- `sharingAttachmentsOfferAboveEnabled`
- `sharingAttachmentsOfferAboveMb`

Advanced language overrides:
- `shareBlockLang` (`"default"` or a supported locale folder name like `de`, `pt_BR`, `zh_TW`, …)
- `eventDescriptionLang` (`"default"` or supported locale)

### 6.3 Migration notes

Talk “participants” split (as of 2.2.7):
- Previously: one toggle `X-NCTALK-ADD-PARTICIPANTS`
- Now: two toggles
  - `X-NCTALK-ADD-USERS`
  - `X-NCTALK-ADD-GUESTS`

Backward compatibility:
- If both new properties are missing, we interpret legacy `ADD-PARTICIPANTS` as “users + guests”.
- When writing, we still write legacy `ADD-PARTICIPANTS` as `ADD-USERS || ADD-GUESTS`.

---

## 7. Calendar integration (Talk button in event editor)

### 7.1 Why a custom toolbar experiment exists

Reviewer goal:
- Prefer the official calendar experiment API (`experiments/calendar/**`) and avoid custom injection.

Reality in Thunderbird ESR 140:
- We need a deterministic editor-targeted contract for **dialog + tab** editors, including **new/unsaved** items.
- We must not modify `experiments/calendar/**` (reviewer rule), so editor UI integration cannot be solved there.

Current implementation:
- `experiments/ncCalToolbar/**` provides only editor integration:
  - reliable Talk button in both editor variants
  - deterministic editor identity (`editorId`)
  - editor-targeted snapshot/write-back (`getCurrent` / `updateCurrent`)
  - tracked close lifecycle (`onTrackedEditorClosed`)
- `experiments/calendar/**` remains untouched and is used only for persisted item monitoring.
- Business logic remains in background runtime modules (`modules/bgState.js`, `modules/bgComposeAttachments.js`, `modules/bgComposeShareCleanup.js`, `modules/bgComposePasswordDispatch.js`, `modules/bgCompose.js`, `modules/bgCalendar.js`, `modules/bgRouter.js`).

### 7.2 Editor variants: dialog vs tab

Event editors can open as:
- Dialog: `chrome://calendar/content/calendar-event-dialog.xhtml`
- Tab: inside `chrome://messenger/content/messenger.xhtml` with a `calendarEvent` tab + iframe

We must support both, without duplicating logic or increasing experiment scope.

### 7.2.1 Why manual tab/window correlation exists today

Current constraint:
- Thunderbird ESR 140 does not yet provide a stable upstream API contract to resolve the active event-editor iframe context purely via API IDs in all dialog/tab permutations we need.

Current implementation in `ncCalToolbar`:
- We correlate the editor iframe to its `tabInfo` in a scoped way to produce a deterministic opaque `editorId`.
- This is intentionally limited to calendar editor surfaces only (`ExtensionSupport.registerWindowListener` with editor chrome URLs), not generic window scanning.
- Reviewer/ATN implementation detail:
  - `ExtensionSupport` is consumed as a global experiment symbol (no `ChromeUtils.importESModule(...)` re-import in `parent.js`).
  - This matches `docs/ATN_REVIEW_CHECKLIST_INTERNAL.md` ("globals must be used directly in Experiment scripts").
  - Startup listener registration includes a deferred retry when `ExtensionSupport` is temporarily unavailable in the first startup tick, preventing intermittent bootstrap failures.
- Historical context:
  - Add-on 2.2.7 already contained manual editor mapping (`windowId`/`dialogOuterId`).
  - In 2.2.7 tab mode, `windowId` identified the 3-pane host window only; follow-up
    editor operations could resolve via selected `currentTabInfo`, which can drift
    after tab switches or with multiple open editor tabs.
  - In 2.2.8 this was upgraded to an opaque `editorId` bridge so targeting is deterministic and API-contract oriented.

Upstream direction:
- We track this as a temporary bridge until upstream APIs expose the same deterministic contract.
- Reference: PR #65 (deterministic editor context contract proposal): https://github.com/thunderbird/webext-experiments/pull/65

### 7.3 `ncCalToolbar` API surface (editor-targeted)

Entry / UI:
- `browser.ncCalToolbar.onClicked(snapshot)` with `snapshot.editorId`

Snapshot:
- `browser.ncCalToolbar.getCurrent({ editorId, returnFormat: "ical" })`

Write-back:
- `browser.ncCalToolbar.updateCurrent({ editorId, fields, properties, returnFormat: "ical" })`

Lifecycle:
- `browser.ncCalToolbar.onTrackedEditorClosed` with action payload (`persisted`, `discarded`, `superseded`)

### 7.4 Click snapshot & editor references

On click, background receives:
- `browser.ncCalToolbar.onClicked(snapshot)` as entrypoint
- snapshot payload includes:
- an iCal snapshot of the **currently edited** item (`format: "ical"`, `item: "BEGIN:VCALENDAR..."`)
- `calendarId` and `id` (note: `id` can be empty for new/unsaved items)
- an `editorId` (opaque identifier for one specific open editor)
  - contract: add-ons must treat `editorId` as opaque and must not parse it
  - lifetime: valid only while that editor remains open in the current Thunderbird session

For fresh reads before write-back, background can call:
- `browser.ncCalToolbar.getCurrent({ editorId, returnFormat: "ical" })`

Why we rely on the iCal snapshot:
- New/unsaved items may not have a stable `itemId` yet.
- The snapshot allows the wizard to work **before the event is saved**.

### 7.5 Room cleanup signals

Problem:
- A user can create a Talk room, then close the editor without saving → we must prevent orphan rooms.

Solution:
- Background stores cleanup tracking via `talk:registerCleanup` using `editorId`.
- `browser.ncCalToolbar.onTrackedEditorClosed` (tracked editors only, after `getCurrent`/`updateCurrent`) emits:
  - `action: "persisted"` (saved) / `"discarded"` (closed/canceled) / `"superseded"`
  - `reason`: `dialogaccept`, `dialogextra1`, `dialogcancel`, `dialogextra2`, `unload`, `re-bound`
  - ordering relative to other calendar item events is intentionally not guaranteed

Background behavior:
- If discarded: delete the room (if it was created during this session and not persisted).
- If persisted: cancel cleanup entry and keep the room.

---

## 8. Talk wizard (end-to-end flow)

### 8.1 Wizard open → snapshot

Entry point:
- `browser.ncCalToolbar.onClicked` listener in `modules/bgCalendar.js`

What happens:
1. Create a `contextId` (calendar wizard context)
2. Store:
   - `editorId`
   - `item` (iCal)
   - derived `event` + `metadata` snapshot
3. Open `ui/talkDialog.html?contextId=...` as a **real popup window** via `browser.windows.create({ type: "popup" })`

Wizard initialization:
- `ui/talkDialog.js` reads `contextId`
- calls `talk:initDialog` and `talk:getEventSnapshot` to populate defaults from the snapshot

### 8.2 Create room

User clicks “Talk-Raum erstellen”:
- Wizard sends `talk:createRoom` to background.

Background:
- uses `modules/talkcore.js` + `modules/ocs.js` + `modules/nccore.js`
- creates the room, applies lobby/listable/password, etc.

### 8.3 Write-back to the currently edited event

After create success, the wizard:
1. Sends `talk:applyMetadata` → write `X-NCTALK-*` properties into the open editor
2. Sends `talk:applyEventFields` → write:
   - title (from wizard)
   - location = Talk URL
   - description = generated block (localized, may include password + help URL)
3. Sends `talk:trackRoom` → store runtime meta for monitoring
4. Sends `talk:registerCleanup` → enable orphan-room cleanup if the editor is discarded

Persistence model:
- The editor is updated immediately (in-memory).
- The data becomes persistent when the user clicks **Save** in the editor.

### 8.4 Users vs guests (invitee sync)

The Talk options include two independent toggles:
- **Users**: internal Nextcloud users (added via username)
- **Guests**: external e-mail addresses (added as guests)

Where it is stored:
- `X-NCTALK-ADD-USERS` (`TRUE` / `FALSE`)
- `X-NCTALK-ADD-GUESTS` (`TRUE` / `FALSE`)
- legacy: `X-NCTALK-ADD-PARTICIPANTS`

When syncing happens:
- Invitee sync is triggered on **calendar item upsert** (after the item is saved/persisted),
  not immediately on wizard click.

Why:
- Persisted calendar updates are the stable “truth” and drive delegation/invitee workflows.

Guest e-mail behavior note:
- Whether guests receive a separate invitation e-mail and/or a “personal access link” can depend on
  Nextcloud server configuration and Talk version.

### 8.5 Room types

We expose two room types:
- **Event-Unterhaltung** (`eventConversation = true`)
  - created with event-object metadata (`objectType`, `objectId`)
- **Gruppenunterhaltung** (`eventConversation = false`)
  - standard public room

In iCal:
- `X-NCTALK-EVENT` is stored as `"event"` or `"standard"`

### 8.6 Moderator delegation

The wizard allows choosing a moderator.

Important design choice:
- Delegation is **deferred** to the calendar monitoring flow after the event is persisted.

Reason:
- Delegation and participant sync must be robust across editor close/reopen and across machines,
  so it is driven by persisted calendar updates.

Properties used:
- `X-NCTALK-DELEGATE` (ID)
- `X-NCTALK-DELEGATE-NAME` (label)
- `X-NCTALK-DELEGATED` (`TRUE`/`FALSE`)
- `X-NCTALK-DELEGATE-READY` (`TRUE` while pending)

---

## 9. Calendar monitoring & server sync

### 9.1 Official calendar experiment API (as-is)

We rely on `browser.calendar.items.*` from:
- `experiments/calendar/**` (must remain unchanged)

We subscribe to:
- `browser.calendar.items.onCreated`
- `browser.calendar.items.onUpdated`
- `browser.calendar.items.onRemoved`

We use `returnFormat: "ical"` so our parsing logic stays consistent.

### 9.2 What we do on create/update/remove

On create/update (`handleCalendarItemUpsert` in `modules/bgCalendar.js`):
- Keep room meta in sync:
  - lobby timer updates when event time changes
  - store token ↔ event mapping
- Trigger invitee sync if enabled (`ADD-USERS` and/or `ADD-GUESTS`)
- Trigger delegation flow if pending (`DELEGATE-READY`)

On remove:
- If the removed event has a Talk token, attempt to delete the room.
  - If moderation was delegated, deletion may fail (403). This is expected and should be handled gracefully.

### 9.3 Orphan-room prevention

Orphan prevention is handled by:
- `browser.ncCalToolbar.onTrackedEditorClosed` (editor saved vs discarded)
- background cleanup maps keyed by room token + editor reference

---

## 10. Sharing wizard (compose window)

### 10.1 Flow & responsibilities

Entry point:
- `compose_action` button opens the sharing wizard (popup window).
- `compose.onAttachmentAdded` can auto-open the sharing wizard in attachment mode
  based on sharing options (`always` or threshold-based).

Responsibilities:
- The sharing wizard UI performs most DAV/OCS actions using shared modules.
- The background is used for **compose insertion**, because the compose APIs are executed from the background.
- In attachment mode, background removes selected attachments from compose and
  passes them as a one-time launch context to the wizard.

Key files:
- `ui/nextcloudSharingWizard.html`
- `ui/nextcloudSharingWizard.js`
- `ui/composeAttachmentPrompt.html`
- `ui/composeAttachmentPrompt.js`
- `modules/ncSharing.js`
- `modules/ocs.js`
- `modules/nccore.js`
- `modules/sharingStorage.js`

Attachment mode specifics:
- Wizard starts in step 3 (files queue), without note step.
- Share name base is fixed to `email_attachment` with deterministic `_1`, `_2`, ... suffix handling.
- Compose HTML block for this mode uses ZIP download URL (`/s/<token>/download`) and hides permission row.
- Recipient permissions are enforced as read-only in this mode (`read=true`, `create/write/delete=false`), independent of sharing defaults.
- Queue UI behavior:
  - path column shows the best available source path (including file name)
  - path text is horizontally scrollable per row (mouse wheel), while type/status columns remain fixed
  - currently uploading row is highlighted in accent blue; upload progress and done state use green success styling
- Upload uniqueness behavior:
  - local duplicate target paths are resolved before upload (rename prompt)
  - no per-file remote preflight checks are executed for each queue entry in newly created share folders
- Share cleanup contract:
  - cleanup is armed in background once a share was created and prepared for compose insertion
  - cleanup is cleared only after successful `compose.onAfterSend` (`sendNow`/`sendLater` with message id)
  - if compose tab is closed without successful send, background deletes the share folder on the server
  - when send is still pending at tab-close time, cleanup delete is delayed by a short grace timer to avoid send/close races
  - wizard-side cleanup is armed by window id in background; if the sharing wizard closes before finalize, background deletes the remote folder on `windows.onRemoved`
  - finalize explicitly clears the wizard cleanup entry before closing the popup
- Password separation:
  - Option + wizard toggle can send password in a dedicated follow-up mail.
  - This toggle is only active when password protection is enabled.
  - Main compose block omits the inline password and shows a dedicated hint when enabled.
  - Background captures final recipients on `compose.onBeforeSend` and dispatches password-only mail on `compose.onAfterSend`.
  - Dispatch path: first try `compose.sendMessage(..., { mode: "sendNow" })` with a timeout guard for stuck send attempts.
  - If immediate send fails (or times out), background opens a prefilled compose draft as explicit manual fallback.
  - If a manual fallback draft was opened, a dedicated desktop notification tells the user to send the password mail manually.
  - If manual fallback draft closes without successful send, compose-share cleanup removes the remote share folder.
  - If manual fallback draft cannot be opened at all, background performs immediate best-effort remote share cleanup.
- If Thunderbird's own big-attachment upload setting is enabled, add-on attachment automation settings are locked and a guidance block is shown in options.
- The same lock is enforced live in background before evaluate/start/prompt-action and again at attachment-mode wizard finish.
- On cancel, attachments are not restored to compose (explicit product decision).

### 10.2 Inserting the HTML block into the compose window

The sharing wizard sends:
- `browser.runtime.sendMessage({ type: "sharing:armComposeShareCleanup", payload: { tabId, folderInfo, ... } })`
- `browser.runtime.sendMessage({ type: "sharing:insertHtml", payload: { tabId, html } })`

Background:
- arms compose-share cleanup before insertion (for unsent-tab cleanup handling)
- reads current compose body and inserts the block near the `<body>` tag.

### 10.3 Share block language override

The language for the generated sharing block can be overridden via:
- options → advanced → `shareBlockLang`

Implementation uses:
- `modules/i18nOverride.js` to translate in a forced locale.

---

## 11. Data model

### 11.1 `X-NCTALK-*` iCalendar properties

Core:
- `X-NCTALK-TOKEN` — Talk room token
- `X-NCTALK-URL` — full Talk URL

Room settings:
- `X-NCTALK-LOBBY` — `TRUE`/`FALSE`
- `X-NCTALK-START` — Unix seconds (string)
- `X-NCTALK-EVENT` — `"event"` or `"standard"`

Invitee sync:
- `X-NCTALK-ADD-USERS` — `TRUE`/`FALSE`
- `X-NCTALK-ADD-GUESTS` — `TRUE`/`FALSE`
- `X-NCTALK-ADD-PARTICIPANTS` — legacy combined flag (`TRUE` if either is enabled)

Event conversation binding:
- `X-NCTALK-OBJECTID` — event object identifier used when binding rooms to events

Delegation:
- `X-NCTALK-DELEGATE` — user ID
- `X-NCTALK-DELEGATE-NAME` — display label
- `X-NCTALK-DELEGATED` — `TRUE`/`FALSE`
- `X-NCTALK-DELEGATE-READY` — `TRUE` while pending

### 11.2 Internal persistence (`storage.local`)

Room runtime metadata:
- Key: `nctalkRoomMeta`
- Used to track lobby start times, delegation status, and other runtime decisions.

Event ↔ token mapping:
- Key: `nctalkEventTokenMap`
- Used to find a token when an event changes or is deleted.

---

## 12. Runtime messaging contracts

### 12.1 Background message types

Common utility:
- `debug:log` — structured log forwarding (debug-gated)
- `passwordPolicy:fetch` — returns active password policy endpoints + min length
- `passwordPolicy:generate` — server-side password generation

Options:
- `options:testConnection`
- `options:loginFlowStart`
- `options:loginFlowComplete`

Talk wizard:
- `talk:initDialog`
- `talk:getEventSnapshot`
- `talk:createRoom`
- `talk:searchUsers`
- `talk:applyMetadata`
- `talk:applyEventFields`
- `talk:trackRoom`
- `talk:registerCleanup`

Sharing wizard:
- `sharing:insertHtml`
- `sharing:armComposeShareCleanup`
- `sharing:armWizardRemoteCleanup`
- `sharing:clearWizardRemoteCleanup`
- `sharing:getLaunchContext`
- `sharing:resolveAttachmentPrompt`
- `sharing:checkAttachmentAutomationAllowed`
- `sharing:registerSeparatePasswordDispatch`

Note:
- Talk-related runtime messaging uses the `talk:*` namespace only.

### 12.2 Common response shape

Most messages return one of:
- `{ ok: true, ... }`
- `{ ok: false, error: string, ... }`

Always ensure errors are logged (reviewer requirement: no silent failures).

---

## 13. Network endpoints used

This add-on uses Nextcloud APIs such as:
- Core capabilities:
  - `/ocs/v2.php/cloud/capabilities`
- Talk capabilities and room operations:
  - `/ocs/v2.php/apps/spreed/api/v4/...`
- Password policy:
  - `/ocs/v2.php/apps/password_policy/api/v1/generate`
- Files sharing:
  - `/ocs/v2.php/apps/files_sharing/api/v1/shares`
- DAV:
  - `remote.php/dav/...`
- Addressbook (system addressbook export):
  - `remote.php/dav/addressbooks/.../?export`

All endpoint interaction lives in the shared modules (`modules/ocs.js`, `modules/nccore.js`, `modules/talkcore.js`, `modules/ncSharing.js`).

---

## 14. Packaging & release checklist

Before you ship:
1. Bump `manifest.json` version.
2. Update `docs/ATN_REVIEW_NOTES_<version>.md` and README “What’s new”.
3. Run the manual tests (Talk dialog + tab editor, sharing wizard, event move/delete, delegation, invitee sync).
4. Run parser contract checks:
   - `node tools/ical-contract-check.js`
   - `node tools/i18n-locale-parity-check.js`
5. Package the XPI with correct root structure.
6. Sanity check:
   - add-on installs on ESR 140.\*
   - button is present in dialog + tab editor by default
   - no console spam in non-debug mode

---

## 15. Troubleshooting

Common symptoms:

- **Button missing in dialog editor**
  - Verify `experiments/ncCalToolbar` is registered in `manifest.json`.
  - Check `[ncCalToolbar]` logs for toolbar insertion/context errors.

- **Wizard opens but writes nothing**
  - Verify `contextId` is present in the wizard URL.
  - Verify `browser.ncCalToolbar.updateCurrent` is available and receives a valid `editorId`.

- **Invitees not added**
  - Invitee sync happens after the event is saved (calendar upsert), not immediately.
  - Check that `X-NCTALK-ADD-USERS` / `X-NCTALK-ADD-GUESTS` are set and persisted.

- **Room deletion fails with 403**
  - Can happen after delegation (moderation transferred). Handle gracefully.

---

## 16. Reviewer constraints (must-read)

Before changing experiments or calendar integration, read:
- `docs/ATN_REVIEW_CHECKLIST_INTERNAL.md`

Key rules:
- Do not modify `experiments/calendar/**`.
- Keep experiments minimal, deterministic, and auditable.
- No trial-and-error code paths.
- No broad window/tab monitoring; target only required windows via window listeners.



