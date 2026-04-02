# Reviewer Notes - 3.0.1
NC Connector for Thunderbird (`{4a35421f-0906-439c-bff2-8eef39e2baee}`)

This document summarizes the currently implemented reviewer-relevant contract
for add-on version 3.0.1.

---

## Scope

- `experiments/calendar/**` is used as-is and is not modified.
- Calendar monitoring and lifecycle handling remain in background code.
- Custom experiments are limited to required editor/context bridges plus one
  read-only compose preference bridge (`ncComposePrefs`) used to detect and
  lock conflicting Thunderbird big-attachment behavior.

---

## Calendar Editor Contract

The active editor integration is provided by `experiments/ncCalToolbar/**` and
is intentionally minimal:

- deterministic Talk button via standard `calendar_item_action` in event dialog and event tab
- click entrypoint via `ncCalToolbar.onClicked` bridge (bound to official `calendarItemAction` button)
- deterministic editor targeting via opaque `editorId`
- editor snapshot read via `ncCalToolbar.getCurrent({ editorId, returnFormat: "ical" })`
- editor write-back via `ncCalToolbar.updateCurrent({ editorId, fields, properties, returnFormat })`
- tracked lifecycle via `ncCalToolbar.onTrackedEditorClosed`

All business logic stays in the background runtime modules (`modules/bgState.js`,
`modules/bgComposeAttachments.js`, `modules/bgComposeShareCleanup.js`, `modules/bgComposePasswordDispatch.js`,
`modules/bgCompose.js`, `modules/bgCalendarLifecycle.js`, `modules/bgCalendar.js`, `modules/talkAddressbook.js`,
`modules/talkcore.js`, `modules/bgRouter.js`) and uses calendar APIs only
for persisted monitoring (`browser.calendar.items.onCreated/onUpdated/onRemoved`).

---

## Behavior Guarantees

1) Talk button is present in dialog and tab editors.
2) Button click opens Talk wizard as popup window.
3) Wizard can read/write unsaved editor state through `editorId` targeting.
4) Cleanup flow handles persisted/discarded/superseded editor close actions.
5) Event move/delete handling remains driven by official calendar item events.
6) Talk/Sharing wizard windows use best-effort focus retries after popup creation; focus requests remain non-fatal due to OS/window-manager policy.
7) Lobby timer updates consume `X-NCTALK-START` as authoritative value; no runtime fallback from `DTSTART/TZID` is used.

---

## Reviewer Alignment Notes (3.0.1)

- Core contracts are explicit; fallback behavior is bounded and logged instead of relying on silent heuristics.
- Active runtime paths touched in this release log failures explicitly; silent failure is not an intended contract.
- Experiment scope is restricted to editor UI/context needs plus the read-only
  compose preference lookup required for attachment-automation conflict locking.
- No custom calendar monitoring inside experiments.
- Background consumers use the exported `NCTalkCore` API surface instead of
  ad-hoc global function calls, to keep Talk runtime contracts centralized.
- `experiments/ncCalToolbar/parent.js` uses `ExtensionSupport` directly as an
  Experiment global (no local `ChromeUtils.importESModule(...)` re-import),
  aligned with ATN guidance for experiment scripts.
- This `ExtensionSupport` global usage was runtime-validated on Thunderbird ESR
  140 in both editor variants (dialog + tab).
- `manifest.json` uses standard `calendar_item_action` + `calendarItemAction`
  experiment API; `ncCalToolbar` no longer injects its own toolbar button.
- On current ESR 140 builds, startup may log
  `Warning processing calendar_item_action: An unexpected property was found in the WebExtension manifest.`
  This warning is non-fatal in our runtime validation (button + click flow still works in dialog/tab),
  and is tracked as an ESR parser-compatibility caveat while keeping the official action path.
- Talk and sharing popup open paths use a best-effort foreground-focus request
  with bounded retries; failures are intentionally non-fatal due OS/window-manager
  focus-stealing policies.
- Talk user search, moderator selection, and participant toggles (users/guests)
  are runtime-gated by system-addressbook availability checks and are disabled
  with explicit user guidance when the addressbook endpoint is unavailable.
- Separate-password follow-up dispatch is implemented in 3.0.1, but remains runtime-gated behind the backend endpoint, an active assigned seat, and enabled password protection.
  - the options/UI toggle surface is only functional when those runtime conditions are met
  - `accountsRead` is requested only to resolve the actual Thunderbird sender identity of the already-open primary compose window, so the password follow-up can reuse the same sender identity instead of guessing from a visible `From` header string.
  - live sender switches are tracked on `compose.onIdentityChanged`, and the final primary-mail envelope is captured on `compose.onBeforeSend`
  - the password follow-up itself targets only the primary mail `To` recipients
  - if sender identity cannot be resolved cleanly, or if auto-send fails, the add-on opens an explicit manual fallback draft instead of attempting an unsafe partial send
  - after the primary mail was sent, password-follow-up problems never delete the committed share
- Backend-provided rich HTML is sanitized client-side before use:
  - Talk HTML policy template (`talk_invitation_template`)
  - Share HTML policy templates (`share_html_block_template`, `share_password_template`)
  - bundled sanitizer: `DOMPurify 3.3.1` documented in `VENDOR.md`
- `experiments/ncCalToolbar/parent.js` no longer uses `innerHTML` to parse
  inbound description HTML; sanitized markup is converted via `DOMParser` and
  imported into the rich editor DOM as a fragment.
- Active add-on UI/runtime paths were tightened beyond the privileged parent:
  - Sharing wizard upload-status cells are rendered via DOM node creation, not `innerHTML`
  - legacy `execCommand(...)` usage was removed from the editor plain-text writeback path
  - clipboard fallback no longer uses `document.execCommand("copy")`; it selects text for manual copy instead
- The privileged editor bridge accepts only sanitized HTML on the
  background->experiment boundary (`modules/bgRouter.js`).
- Startup retry in `ncCalToolbar` uses an XPCOM one-shot timer instead of a
  bare global `setTimeout` in the experiment parent context.
- Remaining timer usage is limited to normal popup/background lifecycle helpers
  plus the upstream `experiments/calendar/**` code that is shipped unmodified;
  the privileged experiment-parent startup path no longer relies on a bare
  global `setTimeout`.
- Sharing attachment-mode folder creation skips known-existing DAV prefixes,
  avoiding benign repeated `MKCOL 405` responses for the configured base folder.
- Shared UI debug forwarding tracks page teardown centrally and suppresses the
  expected runtime-disconnect race (`context unloaded` / `Conduits`) during popup close.

Known temporary deviation:
- The editor context bridge still includes scoped tab/window correlation inside
  `ncCalToolbar` for deterministic tab-editor targeting on current ESR builds.
  This is tracked as a temporary bridge until upstream calendar APIs provide an
  equivalent deterministic editor-targeting contract.

