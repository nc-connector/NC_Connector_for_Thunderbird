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

## Completed

- [x] Route local files and external VFS files through the same Direct/Chunked
  upload selector.
- [x] Route Nextcloud-provider writes through the existing upload engine.
- [x] Keep same-Nextcloud selections on server-side WebDAV COPY.
- [x] Preserve folders, empty directories, source labels, and mixed-source
  selections in one queue.
- [x] Keep provider grants bound to the verified add-on ID, storage ID, and
  configured Nextcloud account.

## Later cleanup

- [ ] Centralize construction of authenticated DAV account data currently used
  by sharing, the Nextcloud VFS adapter, and persistent cleanup.
- [ ] Replace direct compose lifecycle map mutations with focused query and
  transition functions owned by the corresponding lifecycle modules.
- [ ] Split the sharing wizard, sharing renderer/network service, upload engine,
  and password dispatch module by their existing responsibilities without
  changing behavior.
- [ ] Share the live and persistent cleanup retry schedule.
- [ ] Remove the descriptorless cleanup fallback after confirming that no
  supported persisted record can reach it.
- [ ] Consolidate repeated wizard port request/listener bookkeeping.

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
