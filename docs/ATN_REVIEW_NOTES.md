# Reviewer Notes - 3.2.3
NC Connector for Thunderbird (`{4a35421f-0906-439c-bff2-8eef39e2baee}`)

This document summarizes the currently implemented reviewer-relevant behavior
for add-on version 3.2.3.

---

## Scope

- `experiments/calendar/**` is used as-is and is not modified.
- Calendar monitoring and lifecycle handling remain in background code.
- Custom experiments are limited to required editor/context bridges plus one
  read-only compose preference bridge (`ncComposePrefs`) used to detect and
  lock conflicting Thunderbird big-attachment behavior.

---

## Calendar Editor Rules

The active editor integration is provided by `experiments/ncCalToolbar/**` and
is intentionally minimal:

- stable Talk button via standard `calendar_item_action` in event dialog and event tab
- click entrypoint via `ncCalToolbar.onClicked` bridge (bound to official `calendarItemAction` button)
- stable editor targeting via opaque `editorId`
- editor snapshot read via `ncCalToolbar.getCurrent({ editorId, returnFormat: "ical" })`
- editor write-back via `ncCalToolbar.updateCurrent({ editorId, fields, properties, returnFormat })`
- tracked lifecycle via `ncCalToolbar.onTrackedEditorClosed`

All business logic stays in the background runtime modules (`modules/bgState.js`,
`modules/bgComposeAttachments.js`, `modules/bgComposeShareCleanup.js`, `modules/bgComposeShareInsert.js`, `modules/bgComposePasswordDispatch.js`, `modules/passwordPolicyRuntime.js`,
`modules/bgCompose.js`, `modules/bgCalendarLifecycle.js`, `modules/bgCalendar.js`, `modules/talkAddressbook.js`,
`modules/talkcore.js`, `modules/bgRouter.js`) and uses calendar APIs only
for persisted monitoring (`browser.calendar.items.onCreated/onUpdated/onRemoved`).

---

## Behavior Guarantees

1) Talk button is present in dialog and tab editors.
2) Button click opens the Talk wizard through the native calendar item action popup.
3) Wizard can read/write unsaved editor state through `editorId` targeting.
4) Editor close signals handle discarded/superseded cleanup; only official calendar create/update events with matching `X-NCTALK-TOKEN` confirm persistence.
5) Event move/delete handling remains driven by official calendar item events.
6) Talk/Sharing wizard windows use best-effort focus retries after popup creation; focus requests remain non-fatal due to OS/window-manager policy.
7) Lobby timer updates consume `X-NCTALK-START` as source value; on calendar upserts, `DTSTART` is parsed through the shared iCal rules and synchronized back into `X-NCTALK-START`.
8) Existing saved-event Talk room deletion is opt-in only and requires trusted NC Connector `X-NCTALK-*` metadata.
9) Generic Talk links in `LOCATION` or `URL` fields are deliberately ignored for room-deletion ownership.

---

## Reviewer Alignment Notes (3.2.3)

- Core rules are explicit; fallback behavior is bounded and logged instead of relying on silent heuristics.
- `strict_min_version` is set to `140.0`. The add-on uses Thunderbird APIs added after ESR 115, including `browser.messengerUtilities.parseMailboxString(...)`, and targets the supported ESR 140 through ESR 153 range.
- Active runtime paths touched in this release log failures explicitly; silent failure is not intended behavior.
- Experiment scope is restricted to editor UI/context needs plus the read-only
  compose preference lookup required for attachment-automation conflict locking.
- No custom calendar monitoring inside experiments.
- Background consumers use the exported `NCTalkCore` API surface instead of
  ad-hoc global function calls, to keep Talk runtime rules centralized.
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
  depend on runtime system-addressbook availability checks and are disabled
  with explicit user guidance when the addressbook endpoint is unavailable.
- Effective Talk setting `talk_set_password` controls password protection. New
  password-protected rooms start with a generated password that users can
  replace or generate again.
  The existing manual Generate button remains independent of this default.
- Talk room deletion for existing saved calendar events is disabled by default and can be enabled locally or locked by backend policy via `talk_delete_room_on_event_delete`.
  - the event must have trusted NC Connector `X-NCTALK-*` metadata written by Thunderbird/Outlook integration
  - generic Talk URLs copied into event `LOCATION` or `URL` fields are not parsed as ownership proof
  - old cached mappings without trusted source metadata are ignored and cleared instead of deleting a room
  - cleanup for a room created in an unsaved and then discarded event editor remains active independently
  - save-button events do not clear pending cleanup because Thunderbird can still reject the save; a matching persisted calendar item clears it
- Separate-password follow-up dispatch remains restricted to backend endpoint, active assigned seat, and enabled password protection.
  - `overlicensed=true` makes the seat unusable, keeps all policy domains inactive, shows the license warning, and blocks background dispatch registration before compose access
  - the options/UI toggle surface is only functional when those runtime conditions are met
  - `accountsRead` is requested only to resolve the actual Thunderbird sender identity of the already-open primary compose window, so the password follow-up can reuse the same sender identity instead of guessing from a visible `From` header string.
  - live sender switches are tracked on `compose.onIdentityChanged`, and the final primary-mail envelope is captured on `compose.onBeforeSend`
  - plain password follow-up uses the captured primary-mail recipient envelope
  - auto-send parses string recipients with `messengerUtilities.parseMailboxString(...)`, compares `To`/`Cc`/`Bcc` separately including opaque contact/list IDs, and repeats the full comparison after the settle tick
  - empty, mismatching, or timed-out recipient readiness never reaches `compose.sendMessage()` and opens the existing manual fallback
  - Secrets-link delivery creates one one-time Secrets link per recipient and keeps `Bcc` separation intact
  - if Secrets is unavailable or link creation fails, Thunderbird falls back to plain delivery and warns the user
  - if sender identity cannot be resolved cleanly, or if auto-send fails, the add-on opens an explicit manual fallback draft instead of attempting an unsafe partial send
  - after the primary mail was sent, password-follow-up problems never delete the committed share
- Backend-provided rich HTML is sanitized client-side before use:
  - Talk HTML policy template (`talk_invitation_template`)
  - Share HTML policy templates (`share_html_block_template_v2` with `share_html_block_template` fallback, and `share_password_template`)
  - Email signature HTML policy template (`email_signature_template`)
  - bundled sanitizer: `DOMPurify 3.4.11` documented in `VENDOR.md`
- Follow-up for the previous `ui/signatureCompose.js` `innerHTML` review finding:
  - email signature HTML is still sanitized in background before it reaches the compose script
  - the compose bridge no longer assigns dynamic HTML with `innerHTML`
  - sanitized signature HTML is parsed with `DOMParser` and imported into the compose DOM via `document.importNode(...)`
  - signature change detection serializes managed signature child nodes with `XMLSerializer`
  - a bounded two-second observer repeats the same replacement path when Thunderbird or Signature Switch inserts a matching local signature after compose initialization; it then disconnects
  - background queues identity changes per compose tab and rechecks the current identity plus its email immediately before each signature write
- Backend policy availability is evaluated per policy domain. Older backend
  payloads without `policy.email_signature` disable only central email
  signatures with an update hint; Share/Talk policy domains remain active when
  present.
- Share compose insertion is mode-aware:
  - HTML compose receives pre-rendered share HTML from `NCSharing.buildHtmlBlock(...)`
  - plain-text compose receives a dedicated pre-rendered share text block from `NCSharing.buildPlainTextBlock(...)`
  - local validation covers these render rules via `node tools/share-plaintext-contract-check.js`
  - runtime requires both variants; background does not rebuild missing plain text from HTML
  - backend custom share templates are sanitized before rich or plain-text rendering
  - empty optional placeholders in backend custom share templates are pruned before replacement so hidden rights/password/expiry/note sections do not rely on fixed table rows
  - local built-in share templates stay on the trusted local render path and are not passed through the backend HTML sanitizer
- Password follow-up compose is mode-aware as well:
  - HTML follow-up keeps the pre-rendered HTML block
  - plain-text follow-up uses the dedicated pre-rendered plain-text block
- Sanitizer-dependent backend HTML paths now fail closed:
  - if the expected Talk/share/signature HTML sanitizer is unavailable, the add-on throws instead of falling back to raw HTML
  - the privileged `descriptionHtml` bridge rejects unsanitized HTML instead of forwarding it
  - when `debugEnabled` is active, the bundled sanitizer logs compact structural summaries (removed tag/attribute deltas, element/attribute counts, anchor rel-normalization adjustments) without logging raw backend template HTML, using the existing `[NCUI][Talk]` / `[NCUI][Sharing]` / `[NCBG]` debug channels
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
- Talk + Sharing now mark the forwarder as unloading before close and briefly
  flush already-started `debug:log` sends, reducing teardown-time DevTools noise
  without changing functional runtime behavior.
- The attachment-mode prompt now uses the same `debugEnabled`-controlled shared UI
  debug forwarder/runtime-teardown path as Talk + Sharing, instead of a
  separate always-on prompt-specific variant.
- Forwarded UI debug lines no longer produce redundant `[NCBG] msg debug:log`
  meta entries before the actual `[NCUI][...]` log payload.
- Shared helper/runtime modules now resolve their visible log prefixes through a
  common runtime-context mapper, so active extension pages stay inside the
  `[NCUI][...]` family and background stays on `[NCBG]` instead of using legacy
  standalone helper prefixes.
- Basic Auth continues to use the configured login name, while user-scoped DAV,
  chunk-upload, and CardDAV paths use the canonical user ID returned by
  `/ocs/v2.php/cloud/user`. Missing canonical IDs fail explicitly instead of
  treating an email login alias as a filesystem path ID.
- Password-policy generator URLs are resolved against the normalized Nextcloud base and accepted only for the same origin. A different origin is rejected before any Basic Auth request and uses local password generation.

Known temporary deviation:
- The editor context bridge still includes scoped tab/window correlation inside
  `ncCalToolbar` for stable tab-editor targeting on current ESR builds.
  This is tracked as a temporary bridge until upstream calendar APIs provide an
  equivalent stable editor-targeting rules.
