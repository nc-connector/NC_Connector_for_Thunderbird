# Reviewer Notes - 2.2.8
NC Connector for Thunderbird (`{4a35421f-0906-439c-bff2-8eef39e2baee}`)

This document summarizes the currently implemented reviewer-relevant contract
for add-on version 2.2.8.

---

## Scope

- `experiments/calendar/**` is used as-is and is not modified.
- Calendar monitoring and lifecycle handling remain in background code.
- Custom experiments are limited to required UI/context bridges only.

---

## Calendar Editor Contract

The active editor integration is provided by `experiments/ncCalToolbar/**` and
is intentionally minimal:

- deterministic toolbar button in event dialog and event tab
- click entrypoint via `ncCalToolbar.onClicked`
- deterministic editor targeting via opaque `editorId`
- editor snapshot read via `ncCalToolbar.getCurrent({ editorId, returnFormat: "ical" })`
- editor write-back via `ncCalToolbar.updateCurrent({ editorId, fields, properties, returnFormat })`
- tracked lifecycle via `ncCalToolbar.onTrackedEditorClosed`

All business logic stays in the background runtime modules (`modules/bgState.js`,
`modules/bgComposeAttachments.js`, `modules/bgComposeShareCleanup.js`, `modules/bgComposePasswordDispatch.js`,
`modules/bgCompose.js`, `modules/bgCalendar.js`, `modules/bgRouter.js`) and uses calendar APIs only
for persisted monitoring (`browser.calendar.items.onCreated/onUpdated/onRemoved`).

---

## Behavior Guarantees

1) Talk button is present in dialog and tab editors.
2) Button click opens Talk wizard as popup window.
3) Wizard can read/write unsaved editor state through `editorId` targeting.
4) Cleanup flow handles persisted/discarded/superseded editor close actions.
5) Event move/delete handling remains driven by official calendar item events.

---

## Reviewer Alignment Notes (2.2.8)

- No trial-and-error fallbacks in core paths.
- Catch blocks in active paths log errors.
- Experiment scope is restricted to editor UI/context needs.
- No custom calendar monitoring inside experiments.
- Background consumers use the exported `NCTalkCore` API surface instead of
  ad-hoc global function calls, to keep Talk runtime contracts centralized.
- `experiments/ncCalToolbar/parent.js` uses `ExtensionSupport` directly as an
  Experiment global (no local `ChromeUtils.importESModule(...)` re-import),
  aligned with ATN guidance for experiment scripts.
- This `ExtensionSupport` global usage was runtime-validated on Thunderbird ESR
  140 in both editor variants (dialog + tab).

Known temporary deviation:
- The editor context bridge still includes scoped tab/window correlation inside
  `ncCalToolbar` for deterministic tab-editor targeting on current ESR builds.
  This is tracked as a temporary bridge until upstream calendar APIs provide an
  equivalent deterministic editor-targeting contract.


