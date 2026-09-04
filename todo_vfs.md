# VFS and share architecture follow-ups

This file tracks verified work from the share architecture review. Keep the
vendored VFS Toolkit unchanged unless an upstream-compatible patch has explicit
approval.

## Completed in this pass

- [x] Resolve effective FileLink settings in the background and reject queue
  path conflicts before the first remote mutation.
- [x] Finalize changed share notes in the background with the account captured
  by the upload session.
- [x] Reuse one set of sharing defaults and backend policy key mappings in
  options, wizard, and background code.
- [x] Replace the flat mixed-source table with a recursive source-grouped tree,
  stable folder expansion, file sizes, queue totals, root-level removal, and
  target-storage capacity feedback.

## Completed

- [x] Route local files and external VFS files through the same Direct/Chunked
  upload selector.
- [x] Route Nextcloud-provider writes through the existing upload engine.
- [x] Keep same-Nextcloud selections on server-side WebDAV COPY.
- [x] Preserve folders, empty directories, source labels, and mixed-source
  selections in one queue.
- [x] Keep provider grants bound to the verified add-on ID, storage ID, and
  configured Nextcloud account.
- [x] Consolidate repeated wizard port request/listener bookkeeping.
- [x] Centralize authenticated DAV account data used by sharing, VFS, and
  persistent cleanup.

## Verified bugs / required fixes

- [x] **A-03 - release blocker:** Block sending the compose message while an
  attachment-routing handoff or attachment-mode wizard is active. The current
  send guard starts only with background finalization/compose cleanup, so a
  user can send while the originals are already detached but no share block
  has been inserted.
- [x] **A-01 - release blocker:** Make compose-attachment handoff transactional.
  Collect every attachment first, then ensure the wizard/context handoff can be
  completed; if attachment
  removal fails part-way or popup/context bootstrap fails, add back every
  attachment already removed with its original file and name. The deliberate
  product rule that user cancellation does not restore attachments starts only
  after the wizard has adopted a complete launch context.
- [x] **S-01 - release blocker:** Transfer exactly the enumerated queue snapshot
  for folders selected from the configured Nextcloud. A recursive
  `Depth: infinity` COPY of the source root can include files added after
  selection which were never shown in the queue or included in its capacity
  calculation.
- [x] **A-02 - high:** Serialize attachment automation per compose tab and
  reserve the threshold prompt before asynchronous popup creation. Resolve or
  discard attachment
  batches deterministically when a prompt closes so overlapping evaluations
  cannot open duplicate prompts or start competing detach flows.
- [x] **F-01 - medium:** Allow the Sharing wizard to close after a finalize
  attempt has settled.
  Cancel remains blocked while the request is running and closes the wizard
  after retryable and non-retryable insertion/finalize failures.
- [ ] **P-01 - medium:** Reconcile ambiguous non-overwrite VFS-provider writes.
  A successful Direct PUT whose response is lost is retried and then reported
  as HTTP 412, while an
  unclear chunk MOVE accepts any existing same-size target as the just-written
  file. Recovery must distinguish the requested content from an older target.
- [ ] **P-02 - VFS contract:** Make provider `writeFile()` and `addFolder()`
  create missing parent directories as required by the VFS Toolkit API.
- [x] Emit the transfer-completion log for shares containing only
  same-Nextcloud server-side copies.

## Later cleanup

- [ ] Replace direct compose lifecycle map mutations with focused query and
  transition functions owned by the corresponding lifecycle modules.
- [ ] Split the sharing wizard, sharing renderer/network service, upload engine,
  and password dispatch module by their existing responsibilities without
  changing behavior.
- [x] Remove the wizard's unused one-shot finalize bookkeeping. The background
  transaction remains the sole owner of staged progress and rollback.
- [x] Share the live and persistent cleanup retry schedule.
- [x] Remove the unreachable descriptorless cleanup fallback now that every
  supported live and persisted record has a validated descriptor.

## UX follow-up

- [x] Redesign the mixed-source queue for clearer hierarchy, source, size, and
  status scanning without changing transfer behavior.
- [ ] Clarify whether individual files and nested folders inside a selected
  folder can be deselected safely. If implemented, rebuild the transfer
  descriptor deliberately so empty parents, same-Nextcloud COPY roots, and
  queue path-conflict checks remain correct.

## Deliberate boundaries

- DAV upload, DAV COPY, DAV Bulk, and OCS share operations remain separate
  protocol paths.
- Live compose cleanup and restart-safe persistent cleanup keep separate state
  machines.
- External VFS files remain one in-memory `File` during transfer and are not
  staged on disk.

## Validation

- `npm run test:review`
- `npm run test:webext-linter`

## Missing regression coverage

- [x] Add an attachment-automation lifecycle harness covering debounce batches,
  one prompt/flow per compose tab, partial removal, popup creation failure,
  missing or incomplete launch context, send blocking during attachment mode,
  and the post-handoff no-restore product boundary.
- [x] Add a wizard UI lifecycle check for retryable and non-retryable finalize
  failures, including Retry, Cancel, and window-close behavior.
- [x] Add exact-snapshot coverage for same-Nextcloud folder COPY.
- [ ] Add ambiguity tests for Direct and chunked non-overwrite provider writes.
