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

## Verified fixes

- [ ] Make provider `writeFile()` and `addFolder()` create missing parent
  directories as required by the VFS Toolkit API.
- [x] Emit the transfer-completion log for shares containing only
  same-Nextcloud server-side copies.

## Later cleanup

- [ ] Replace direct compose lifecycle map mutations with focused query and
  transition functions owned by the corresponding lifecycle modules.
- [ ] Split the sharing wizard, sharing renderer/network service, upload engine,
  and password dispatch module by their existing responsibilities without
  changing behavior.
- [x] Share the live and persistent cleanup retry schedule.
- [ ] Remove the unreachable descriptorless cleanup fallback now that every
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
