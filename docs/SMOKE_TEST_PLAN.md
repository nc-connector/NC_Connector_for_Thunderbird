# Smoke Test Plan (NC Connector for Thunderbird)

Version scope:
- `2.2.9`
- `3.0.1`

## 1. Scope

This plan covers end-to-end smoke checks for:
- Talk wizard
- Sharing wizard
- Attachment automation
- Cleanup/lifecycle paths
- Focus behavior
- Runtime logging quality

Known version delta:
- `2.2.9`: separate password mail is feature-gated (disabled).
- `3.0.1`: separate password mail is implemented, but only available when the backend endpoint exists, the current user has an active assigned seat, and password protection is enabled.

## 2. Test Matrix

| Matrix ID | Version | Separate Password Mail |
|---|---|---|
| M1 | 2.2.9 | Disabled (gated) |
| M2 | 3.0.1 | Available only with backend + active seat + password protection |

Run all cases at least once on M1 and M2, except cases marked `3.0.1 only`.

## 3. Preconditions

- [ ] Fresh Thunderbird profile
- [ ] Add-on installed and enabled
- [ ] Debug mode enabled in add-on settings
- [ ] Nextcloud account configured and reachable
- [ ] Talk + Sharing (DAV) available on server
- [ ] For `3.0.1` separate-password cases: backend endpoint available and active seat assigned to the current user
- [ ] Test mailbox and test calendar writable
- [ ] Test files prepared (small, large, duplicate names, folder tree)
- [ ] System address book scenario A prepared (available)
- [ ] System address book scenario B prepared (unavailable)

## 4. Smoke Cases

### A. Preflight

- [ ] `PF-01` Add-on starts without addon-side `Uncaught` errors.
  - Pass: No addon-side `ReferenceError`/`TypeError` on startup.
- [ ] `PF-02` Options page opens/saves without addon-side exceptions.
  - Pass: Save succeeds, values persist.
- [ ] `PF-03` Wizard open/close does not produce unhandled runtime promise noise from addon code.
  - Pass: No addon-side unhandled promise regression.
- [ ] `PF-04` i18n strings resolve in UI (no raw message keys).
  - Pass: Visible labels are localized.

### B. Talk Flow

- [ ] `T-01` Talk button in event dialog opens wizard.
  - Pass: Wizard opens, context is valid.
- [ ] `T-02` Talk button in event tab opens wizard.
  - Pass: Wizard opens, context is valid.
- [ ] `T-03` Create room with title/password/lobby/listable/room type.
  - Pass: Room creation succeeds.
- [ ] `T-04` Event metadata write-back works.
  - Pass: Title/location/description updates are present in editor/event.
- [ ] `T-05` Save event after room creation.
  - Pass: Cleanup state becomes persisted (no delete of active room).
- [ ] `T-06` Cancel/discard event after room creation.
  - Pass: Cleanup removes room server-side.
- [ ] `T-07` Multiple editors open in parallel.
  - Pass: No context cross-talk; correct event is targeted.
- [ ] `T-08` Password generation path works.
  - Pass: Password field receives generated value.

### C. System Address Book Hardening

- [ ] `AB-01` Options page with address book unavailable.
  - Pass: Warning block visible; affected controls disabled.
- [ ] `AB-02` Options page with address book available.
  - Pass: Warning block hidden; controls enabled.
- [ ] `AB-03` Talk wizard with address book unavailable.
  - Pass: moderator/users/guests controls are disabled with lock hint behavior.
- [ ] `AB-04` Talk wizard with address book available.
  - Pass: controls enabled; normal tooltips/help behavior.
- [ ] `AB-05` Status refresh on Talk button click.
  - Pass: live availability check is executed.
- [ ] `AB-06` Status refresh on options open and options save.
  - Pass: availability state updates immediately.

### D. Version/Release Consistency

- [ ] `D-01` Version labels are consistent for tested build.
  - Pass: manifest/options/about text do not contradict the tested package version.

### E. Sharing Wizard

- [ ] `S-01` Sharing wizard opens from compose action.
  - Pass: popup opens with valid tab context.
- [ ] `S-02` Share name availability check.
  - Pass: duplicate folder names are detected.
- [ ] `S-03` Upload path with files.
  - Pass: files upload and status/progress update correctly.
- [ ] `S-04` No-file path (create-only share), when applicable.
  - Pass: share creation works without upload if flow allows it.
- [ ] `S-05` Duplicate file names in queue trigger rename behavior.
  - Pass: user can resolve collision and continue.
- [ ] `S-06` Finalize inserts HTML block into compose body.
  - Pass: compose body contains formatted share block.
- [ ] `S-07` Wizard cancel before finalize.
  - Pass: remote cleanup removes created share folder/share.
- [ ] `S-08` Wizard close via window close button (`X`).
  - Pass: same cleanup behavior as cancel.

### F. Attachment Automation

- [ ] `AT-01` Mode `always`: attachment flow opens deterministic wizard path.
  - Pass: compose attachments route through NC flow.
- [ ] `AT-02` Mode `threshold`: prompt appears only above threshold.
  - Pass: below threshold no prompt; above threshold prompt visible.
- [ ] `AT-03` Prompt action: share via NC.
  - Pass: correct branch starts.
- [ ] `AT-04` Prompt action: remove last selected attachments batch.
  - Pass: only last batch is removed.
- [ ] `AT-05` Conflict lock with Thunderbird native large-file setting.
  - Pass: deterministic block/guidance behavior.
- [ ] `AT-06` Abort/no-send cleanup after attachment/share flow.
  - Pass: no orphaned server artifacts remain.

### G. Separate Password Mail

- [ ] `P-01` `2.2.9`: feature is disabled/gated in settings and sharing wizard.
  - Pass: control is non-functional and clearly marked as gated.
- [ ] `P-02` `3.0.1 only`: auto-send success path with backend endpoint + active seat.
  - Pass: password mail sent, success notification shown.
- [ ] `P-03` `3.0.1 only`: auto-send failure path with backend endpoint + active seat.
  - Pass: failure notification shown; manual action guidance shown.
- [ ] `P-04` `3.0.1 only`: fallback compose opens sendable draft when identity resolution is ambiguous/unavailable or auto-send fails.
  - Pass: user can manually send password mail.
- [ ] `P-05` `3.0.1 only`: fallback opened but not sent, then tab closed after the primary mail was already sent.
  - Pass: committed share is retained; password follow-up problems do not trigger share cleanup after successful primary send.

### H. Focus Behavior

- [ ] `F-01` Talk wizard focus best effort.
  - Pass: focus attempt logged; wizard remains functional even if OS/WM blocks focus.
- [ ] `F-02` Sharing wizard focus best effort.
  - Pass: same behavior as Talk.
- [ ] `F-03` No functional regression if focus cannot be forced.
  - Pass: user can continue flow manually.

### I. Logging Quality

- [ ] `L-01` No duplicated addon error logs for same exception in active path.
  - Pass: one deterministic error signal per failure.
- [ ] `L-02` Expected teardown disconnect noise is suppressed where intended.
  - Pass: no recurring addon-side `context unloaded/Conduits` forwarder noise regression.
- [ ] `L-03` Debug logs remain readable and trace core actions.
  - Pass: key milestones are still visible in debug mode.

## 5. Quick Execution Order (recommended)

1. Run `A` once.
2. Run `B + C` with address book available.
3. Run `B + C` with address book unavailable.
4. Run `E + F`.
5. Run `G` (respect version-specific gating/availability conditions).
6. Run `H + I` as final regression pass.

## 6. Result Sheet

Fill after each matrix run:

- Matrix ID:
- Date:
- Tester:
- Thunderbird version:
- Add-on version:
- Nextcloud version:
- Summary:
  - Passed:
  - Failed:
  - Blocked:
- Blocking findings:
  - ID:
  - Repro steps:
  - Actual result:
  - Expected result:
  - Log excerpt:

