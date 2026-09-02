/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  "use strict";

  const LIST_PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:getetag/>
  </d:prop>
</d:propfind>`;

  const QUOTA_PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:quota-used-bytes/>
    <d:quota-available-bytes/>
  </d:prop>
</d:propfind>`;

  function createVfsError(code, message, details = {}, status = 0){
    const error = new Error(String(message || "Nextcloud storage request failed"));
    error.code = code;
    error.status = Number(status) || 0;
    if (code === "E:PROVIDER"){
      error.details = Object.freeze({
        id: String(details.id || "nextcloud-storage"),
        title: String(details.title || "Nextcloud storage error"),
        description: String(details.description || "The Nextcloud storage request could not be completed.")
      });
    }
    return error;
  }

  function statusError(status, operation){
    const numericStatus = Number(status) || 0;
    if (numericStatus === 401 || numericStatus === 403){
      return createVfsError("E:AUTH", "Nextcloud storage authorization failed", {}, numericStatus);
    }
    if (numericStatus === 412){
      return createVfsError("E:EXIST", "The destination already exists", {}, numericStatus);
    }
    const descriptions = {
      404: ["not-found", "Storage item not found", "The requested file or folder does not exist."],
      409: ["conflict", "Storage conflict", "The parent folder does not exist or the operation conflicts with the current storage state."],
      423: ["locked", "Storage item locked", "The requested file or folder is locked."],
      429: ["rate-limited", "Nextcloud is busy", "Nextcloud temporarily rejected the request. Please try again later."],
      507: ["insufficient-storage", "Insufficient storage", "Nextcloud does not have enough free storage for this operation."]
    };
    const known = descriptions[numericStatus];
    return createVfsError(
      "E:PROVIDER",
      `Nextcloud DAV ${operation || "request"} failed (${numericStatus || "network"})`,
      known
        ? { id: known[0], title: known[1], description: known[2] }
        : {
          id: numericStatus ? `http-${numericStatus}` : "network",
          title: numericStatus ? `Nextcloud error (${numericStatus})` : "Nextcloud unavailable",
          description: numericStatus
            ? "Nextcloud returned an unexpected response."
            : "The Nextcloud storage request could not be completed."
        },
      numericStatus
    );
  }

  function mapDavError(error, operation){
    if (error?.name === "AbortError"){
      return error;
    }
    if (error?.code === "E:AUTH" || error?.code === "E:EXIST" || error?.code === "E:PROVIDER"){
      return error;
    }
    if (error?.name === "TimeoutError"){
      return createVfsError("E:PROVIDER", "Nextcloud storage request timed out", {
        id: "timeout",
        title: "Nextcloud timeout",
        description: "Nextcloud did not finish the storage request in time."
      });
    }
    return statusError(error?.status, operation);
  }

  function attachCompletedChanges(error, completedChanges){
    if (!Array.isArray(completedChanges) || !completedChanges.length){
      return error;
    }
    try{
      error.completedChanges = completedChanges.slice();
    }catch(attachError){
      const wrapped = new Error(error?.message || "Nextcloud storage operation was interrupted");
      wrapped.name = error?.name || "Error";
      wrapped.code = error?.code;
      wrapped.status = error?.status;
      wrapped.details = error?.details;
      wrapped.completedChanges = completedChanges.slice();
      return wrapped;
    }
    return error;
  }

  function parentPath(path){
    if (path === "/"){
      return null;
    }
    const index = path.lastIndexOf("/");
    return index <= 0 ? "/" : path.slice(0, index);
  }

  function childPath(base, child){
    return base === "/" ? `/${child}` : `${base}/${child}`;
  }

  function relativeSuffix(root, path){
    return path.slice(root.length);
  }

  function pathDepth(path){
    return path.split("/").filter(Boolean).length;
  }

  function create(options = {}){
    const core = options.core || global.NCCore;
    const dav = options.dav || global.NCNextcloudDav;
    const hostPermissions = options.hostPermissions || global.NCHostPermissions;
    const log = typeof options.log === "function" ? options.log : null;
    const uploadLog = typeof options.uploadLog === "function" ? options.uploadLog : log;
    const fileUpload = options.fileUpload || global.NCFileLinkUpload;

    if (!core?.getOpts || !core?.getCurrentUserId || !core?.buildDavAccountContext || !dav?.requestPath){
      throw createVfsError("E:PROVIDER", "Nextcloud storage dependencies are unavailable", {
        id: "dependencies",
        title: "Nextcloud storage unavailable",
        description: "NC Connector could not initialize its Nextcloud storage adapter."
      });
    }

    function logOperation(operation, metadata = {}){
      log?.(operation, metadata);
    }

    async function resolveContext(signal, expectedAccountKey = "", requireCapabilities = false){
      dav.throwIfAborted(signal);
      const opts = await core.getOpts();
      dav.throwIfAborted(signal);
      if (!opts?.baseUrl || !opts?.user || !opts?.appPass){
        throw createVfsError("E:AUTH", "Nextcloud account is not configured");
      }
      if (hostPermissions?.requireOriginPermission){
        await hostPermissions.requireOriginPermission(opts.baseUrl, {
          logMissing: false,
          errorFactory: () => createVfsError("E:AUTH", "Nextcloud host permission is missing")
        });
      }
      dav.throwIfAborted(signal);
      if (requireCapabilities){
        if (typeof core.getRequiredCapabilities !== "function"){
          throw createVfsError("E:PROVIDER", "Nextcloud upload dependencies are unavailable", {
            id: "dependencies",
            title: "Nextcloud storage unavailable",
            description: "NC Connector could not initialize its Nextcloud upload engine."
          });
        }
        await core.getRequiredCapabilities({ ...opts, signal });
      }
      dav.throwIfAborted(signal);
      let userId;
      try{
        userId = await core.getCurrentUserId({ ...opts, signal });
      }catch(error){
        if (error?.ncCurrentUserIdCode === "auth" || error?.ncCurrentUserIdCode === "missing"){
          throw createVfsError("E:AUTH", "Nextcloud storage authorization failed");
        }
        if (error?.name !== "AbortError"){
          throw createVfsError("E:PROVIDER", "Nextcloud account identity could not be resolved", {
            id: "account-identity",
            title: "Nextcloud account unavailable",
            description: "NC Connector could not resolve the configured Nextcloud account."
          });
        }
        throw mapDavError(error, "identity");
      }
      dav.throwIfAborted(signal);
      const account = core.buildDavAccountContext({ ...opts, userId });
      const context = Object.freeze({
        ...account,
        davRoot: dav.normalizeDavRoot(account.davRoot),
        uploadRoot: dav.normalizeDavRoot(account.uploadRoot)
      });
      if (expectedAccountKey && expectedAccountKey !== context.accountIdentity){
        throw createVfsError("E:AUTH", "The authorized Nextcloud storage connection has changed");
      }
      return context;
    }

    async function getAccountIdentity(operationOptions = {}){
      return withMappedErrors("account-identity", async () => {
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        return Object.freeze({
          key: context.accountIdentity,
          baseUrl: context.baseUrl,
          userId: context.userId
        });
      });
    }

    async function withMappedErrors(operation, callback){
      try{
        return await callback();
      }catch(error){
        let mapped = mapDavError(error, operation);
        if (Array.isArray(error?.completedChanges)){
          mapped = attachCompletedChanges(mapped, error.completedChanges);
        }
        throw mapped;
      }
    }

    async function request(context, method, path, requestOptions = {}){
      const normalizedPath = dav.normalizeVfsPath(path, {
        allowRoot: requestOptions.allowRoot !== false
      });
      return dav.requestPath({
        method,
        url: dav.buildVfsFileUrl(context.davRoot, normalizedPath, {
          allowRoot: requestOptions.allowRoot !== false
        }),
        authHeader: context.authHeader,
        headers: requestOptions.headers,
        body: requestOptions.body,
        signal: requestOptions.signal,
        timeoutMs: requestOptions.timeoutMs,
        readBody: requestOptions.readBody !== false,
        retryTransport: requestOptions.retryTransport === true,
        retryStatuses: requestOptions.retryStatuses === true,
        operation: requestOptions.operation || `vfs_${String(method || "request").toLowerCase()}`,
        log: logOperation
      });
    }

    function requireSuccess(response, operation){
      if (!response?.ok){
        throw statusError(response?.status, operation);
      }
      return response;
    }

    async function probeWithContext(context, path, signal){
      const normalizedPath = dav.normalizeVfsPath(path);
      const response = await request(context, "PROPFIND", normalizedPath, {
        signal,
        headers: {
          "Depth": "0",
          "Content-Type": "application/xml; charset=utf-8"
        },
        body: LIST_PROPFIND_BODY,
        operation: "vfs_probe"
      });
      if (response.status === 404){
        return Object.freeze({ exists: false, entry: null });
      }
      requireSuccess(response, "probe");
      const entries = dav.parseDavMultiStatus(response.raw, context.davRoot);
      const entry = entries.find((candidate) => candidate.path === normalizedPath) || null;
      if (!entry){
        throw createVfsError("E:PROVIDER", "Nextcloud returned an incomplete DAV response", {
          id: "invalid-response",
          title: "Invalid Nextcloud response",
          description: "Nextcloud did not identify the requested storage item."
        });
      }
      return Object.freeze({ exists: true, entry });
    }

    async function listWithContext(context, path, signal){
      const normalizedPath = dav.normalizeVfsPath(path);
      const response = await request(context, "PROPFIND", normalizedPath, {
        signal,
        headers: {
          "Depth": "1",
          "Content-Type": "application/xml; charset=utf-8"
        },
        body: LIST_PROPFIND_BODY,
        operation: "vfs_list"
      });
      requireSuccess(response, "list");
      return dav.parseDavMultiStatus(response.raw, context.davRoot)
        .filter((entry) => entry.path !== normalizedPath && parentPath(entry.path) === normalizedPath)
        .map(({ path: entryPath, name, kind, size, lastModified }) => Object.freeze({
          path: entryPath,
          name,
          kind,
          size,
          lastModified
        }))
        .sort((left, right) => {
          if (left.kind !== right.kind){
            return left.kind === "directory" ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });
    }

    async function collectTree(context, rootPath, signal){
      const directories = [];
      const files = [];
      const pending = [rootPath];
      let pendingIndex = 0;
      while (pendingIndex < pending.length){
        dav.throwIfAborted(signal);
        const current = pending[pendingIndex++];
        const entries = await listWithContext(context, current, signal);
        for (const entry of entries){
          if (entry.kind === "directory"){
            directories.push(entry);
            pending.push(entry.path);
          }else{
            files.push(entry);
          }
        }
      }
      return Object.freeze({ directories, files });
    }

    async function list(path = "/", operationOptions = {}){
      return withMappedErrors("list", async () => {
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        return listWithContext(context, path, operationOptions.signal);
      });
    }

    async function readFile(path, operationOptions = {}){
      return withMappedErrors("read", async () => {
        const normalizedPath = dav.normalizeVfsPath(path, { allowRoot: false });
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        const response = await dav.fetchWithTimeout({
          request: (requestSignal) => global.fetch(
            dav.buildVfsFileUrl(context.davRoot, normalizedPath, { allowRoot: false }),
            {
              method: "GET",
              headers: { "Authorization": context.authHeader },
              signal: requestSignal,
              cache: "no-store"
            }
          ),
          signal: operationOptions.signal,
          timeoutMs: dav.UPLOAD_TIMEOUT_MS
        });
        if (!response.ok){
          const status = Number(response.status) || 0;
          await dav.readResponseText(response, operationOptions.signal);
          throw statusError(status, "read");
        }
        const blob = await dav.readResponseBlob(response, operationOptions.signal);
        if (!blob){
          throw createVfsError("E:PROVIDER", "Nextcloud returned no file content", {
            id: "empty-response",
            title: "Empty Nextcloud response",
            description: "Nextcloud returned no file content."
          });
        }
        const name = normalizedPath.split("/").pop();
        if (typeof global.File === "function"){
          return new global.File([blob], name, {
            type: blob.type || "application/octet-stream",
            lastModified: Number(operationOptions.lastModified) || Date.now()
          });
        }
        return blob;
      });
    }

    async function writeFile(path, file, overwrite, operationOptions = {}){
      return withMappedErrors("write", async () => {
        const normalizedPath = dav.normalizeVfsPath(path, { allowRoot: false });
        if (!file || typeof file.slice !== "function"){
          throw createVfsError("E:PROVIDER", "File content is unavailable", {
            id: "invalid-file",
            title: "Invalid file",
            description: "The file content could not be written to Nextcloud."
          });
        }
        if (typeof fileUpload?.uploadSingleFile !== "function"){
          throw createVfsError("E:PROVIDER", "Nextcloud upload dependencies are unavailable", {
            id: "dependencies",
            title: "Nextcloud storage unavailable",
            description: "NC Connector could not initialize its Nextcloud upload engine."
          });
        }
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey,
          true
        );
        const pathSegments = normalizedPath.slice(1).split("/");
        const fileName = pathSegments.pop();
        const relativeFolder = pathSegments.join("/");
        const uploadFile = Object.freeze({
          internalId: normalizedPath,
          itemId: normalizedPath,
          fileName,
          displayPath: normalizedPath,
          relativeDir: "",
          size: Number(file.size),
          contentType: file.type || "application/octet-stream",
          lastModified: Number(file.lastModified) || Date.now(),
          sourceFile: file
        });
        const transfer = await fileUpload.uploadSingleFile({
          file: uploadFile,
          davRoot: context.davRoot,
          uploadRoot: context.uploadRoot,
          shareRoot: relativeFolder,
          authHeader: context.authHeader,
          signal: operationOptions.signal,
          log: uploadLog,
          overwrite: overwrite === true,
          // The VFS contract expects the selected parent to exist already.
          autoMkcol: false,
          onStatus: (event) => {
            if (event?.phase === "summary"){
              operationOptions.onProgress?.({
                loaded: event.loadedBytes,
                total: event.totalBytes
              });
            }
          }
        });
        const resultStatus = Number(transfer?.result?.status) || 0;
        const created = resultStatus
          ? resultStatus === 201
          : overwrite !== true;
        return Object.freeze({
          created,
          changes: [{
            kind: "file",
            action: created ? "created" : "modified",
            target: { path: normalizedPath }
          }]
        });
      });
    }

    async function addFolderWithContext(context, path, signal, allowExisting = false){
      const normalizedPath = dav.normalizeVfsPath(path, { allowRoot: false });
      const response = await request(context, "MKCOL", normalizedPath, {
        signal,
        allowRoot: false,
        operation: "vfs_add_folder"
      });
      if (response.status === 405){
        const existing = await probeWithContext(context, normalizedPath, signal);
        if (existing.exists){
          if (existing.entry.kind === "directory" && allowExisting){
            return false;
          }
          throw createVfsError("E:EXIST", "The folder already exists", {}, response.status);
        }
      }
      requireSuccess(response, "add-folder");
      return true;
    }

    async function addFolder(path, operationOptions = {}){
      return withMappedErrors("add-folder", async () => {
        const normalizedPath = dav.normalizeVfsPath(path, { allowRoot: false });
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        await addFolderWithContext(context, normalizedPath, operationOptions.signal, false);
        return Object.freeze({
          changes: [{ kind: "directory", action: "created", target: { path: normalizedPath } }]
        });
      });
    }

    async function moveWithContext(context, sourcePath, destinationPath, kind, overwrite, signal){
      const response = await request(context, "MOVE", sourcePath, {
        signal,
        allowRoot: false,
        headers: {
          "Destination": dav.buildVfsFileUrl(context.davRoot, destinationPath, { allowRoot: false }),
          "Overwrite": overwrite ? "T" : "F"
        },
        operation: kind === "directory" ? "vfs_move_folder" : "vfs_move_file"
      });
      requireSuccess(response, `move-${kind}`);
      return response;
    }

    async function copyWithContext(context, sourcePath, destinationPath, kind, overwrite, signal){
      try{
        return await dav.copyWithinDavRoot({
          davRoot: context.davRoot,
          sourcePath,
          destinationPath,
          kind,
          authHeader: context.authHeader,
          signal,
          log: logOperation,
          overwrite
        });
      }catch(error){
        throw mapDavError(error, `copy-${kind}`);
      }
    }

    function validateDistinctPaths(sourcePath, destinationPath, kind){
      const source = dav.normalizeVfsPath(sourcePath, { allowRoot: false });
      const destination = dav.normalizeVfsPath(destinationPath, { allowRoot: false });
      if (source === destination){
        throw createVfsError("E:EXIST", "Source and destination are identical");
      }
      if (kind === "directory" && destination.startsWith(`${source}/`)){
        throw createVfsError("E:PROVIDER", "A folder cannot be copied or moved into itself", {
          id: "recursive-destination",
          title: "Invalid destination",
          description: "A folder cannot be copied or moved into itself."
        });
      }
      return Object.freeze({ source, destination });
    }

    async function moveFile(oldPath, newPath, overwrite, operationOptions = {}){
      return withMappedErrors("move-file", async () => {
        const paths = validateDistinctPaths(oldPath, newPath, "file");
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        await moveWithContext(context, paths.source, paths.destination, "file", !!overwrite, operationOptions.signal);
        return Object.freeze({
          changes: [{
            kind: "file",
            action: "moved",
            source: { path: paths.source },
            target: { path: paths.destination }
          }]
        });
      });
    }

    async function copyFile(oldPath, newPath, overwrite, operationOptions = {}){
      return withMappedErrors("copy-file", async () => {
        const paths = validateDistinctPaths(oldPath, newPath, "file");
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        await copyWithContext(context, paths.source, paths.destination, "file", !!overwrite, operationOptions.signal);
        return Object.freeze({
          changes: [{
            kind: "file",
            action: "copied",
            source: { path: paths.source },
            target: { path: paths.destination }
          }]
        });
      });
    }

    async function mergeFolder(context, sourcePath, destinationPath, mode, operationOptions){
      const signal = operationOptions.signal;
      const completedChanges = [];
      try{
        const sourceProbe = await probeWithContext(context, sourcePath, signal);
        if (!sourceProbe.exists || sourceProbe.entry.kind !== "directory"){
          throw statusError(404, `${mode}-folder`);
        }
        const tree = await collectTree(context, sourcePath, signal);
        const destinationCreated = await addFolderWithContext(context, destinationPath, signal, true);
        if (destinationCreated){
          completedChanges.push({
            kind: "directory",
            action: "created",
            target: { path: destinationPath }
          });
        }
        const directories = tree.directories.slice().sort((left, right) =>
          pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path)
        );
        const total = directories.length + tree.files.length + (mode === "move" ? 1 : 0);
        let completed = 0;
        for (const directory of directories){
          dav.throwIfAborted(signal);
          const target = `${destinationPath}${relativeSuffix(sourcePath, directory.path)}`;
          const created = await addFolderWithContext(context, target, signal, true);
          if (created){
            completedChanges.push({
              kind: "directory",
              action: "created",
              target: { path: target }
            });
          }
          operationOptions.onProgress?.(++completed, total);
        }
        for (const file of tree.files){
          dav.throwIfAborted(signal);
          const target = `${destinationPath}${relativeSuffix(sourcePath, file.path)}`;
          if (mode === "move"){
            await moveWithContext(context, file.path, target, "file", true, signal);
          }else{
            await copyWithContext(context, file.path, target, "file", true, signal);
          }
          completedChanges.push({
            kind: "file",
            action: mode === "move" ? "moved" : "copied",
            source: { path: file.path },
            target: { path: target }
          });
          operationOptions.onProgress?.(++completed, total);
        }
        if (mode === "move"){
          const response = await request(context, "DELETE", sourcePath, {
            signal,
            allowRoot: false,
            operation: "vfs_merge_move_cleanup"
          });
          if (response.status !== 404){
            requireSuccess(response, "move-folder-cleanup");
          }
          completedChanges.push({
            kind: "directory",
            action: "deleted",
            target: { path: sourcePath }
          });
          operationOptions.onProgress?.(++completed, total);
        }
        return Object.freeze({ changes: completedChanges.slice() });
      }catch(error){
        throw attachCompletedChanges(error, completedChanges);
      }
    }

    async function moveFolder(oldPath, newPath, merge, operationOptions = {}){
      return withMappedErrors("move-folder", async () => {
        const paths = validateDistinctPaths(oldPath, newPath, "directory");
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        if (merge){
          return mergeFolder(context, paths.source, paths.destination, "move", operationOptions);
        }
        await moveWithContext(context, paths.source, paths.destination, "directory", false, operationOptions.signal);
        return Object.freeze({
          changes: [{
            kind: "directory",
            action: "moved",
            source: { path: paths.source },
            target: { path: paths.destination }
          }]
        });
      });
    }

    async function copyFolder(oldPath, newPath, merge, operationOptions = {}){
      return withMappedErrors("copy-folder", async () => {
        const paths = validateDistinctPaths(oldPath, newPath, "directory");
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        if (merge){
          return mergeFolder(context, paths.source, paths.destination, "copy", operationOptions);
        }
        await copyWithContext(context, paths.source, paths.destination, "directory", false, operationOptions.signal);
        return Object.freeze({
          changes: [{
            kind: "directory",
            action: "copied",
            source: { path: paths.source },
            target: { path: paths.destination }
          }]
        });
      });
    }

    async function deletePath(path, kind, operationOptions){
      return withMappedErrors(`delete-${kind}`, async () => {
        const normalizedPath = dav.normalizeVfsPath(path, { allowRoot: false });
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        const response = await request(context, "DELETE", normalizedPath, {
          signal: operationOptions.signal,
          allowRoot: false,
          operation: `vfs_delete_${kind}`
        });
        if (response.status === 404){
          return Object.freeze({ deleted: false, changes: [] });
        }
        requireSuccess(response, `delete-${kind}`);
        return Object.freeze({
          deleted: true,
          changes: [{ kind, action: "deleted", target: { path: normalizedPath } }]
        });
      });
    }

    function deleteFile(path, operationOptions = {}){
      return deletePath(path, "file", operationOptions);
    }

    function deleteFolder(path, operationOptions = {}){
      return deletePath(path, "directory", operationOptions);
    }

    async function storageUsage(operationOptions = {}){
      return withMappedErrors("storage-usage", async () => {
        const context = await resolveContext(
          operationOptions.signal,
          operationOptions.expectedAccountKey
        );
        const response = await request(context, "PROPFIND", "/", {
          signal: operationOptions.signal,
          headers: {
            "Depth": "0",
            "Content-Type": "application/xml; charset=utf-8"
          },
          body: QUOTA_PROPFIND_BODY,
          operation: "vfs_storage_usage"
        });
        requireSuccess(response, "storage-usage");
        return dav.parseDavQuota(response.raw);
      });
    }

    /**
     * Copy an existing source from this configured account into an already
     * reserved FileLink share path. Both paths stay below the same canonical
     * DAV root; the source is never downloaded, moved or deleted.
     */
    async function copyIntoShare({
      sourcePath,
      destinationPath,
      kind = "file",
      signal,
      expectedAccountKey = ""
    } = {}){
      return withMappedErrors("copy-into-share", async () => {
        const paths = validateDistinctPaths(sourcePath, destinationPath, kind);
        const context = await resolveContext(signal, expectedAccountKey);
        await copyWithContext(
          context,
          paths.source,
          paths.destination,
          kind,
          false,
          signal
        );
        return Object.freeze({
          serverSide: true,
          kind,
          sourcePath: paths.source,
          destinationPath: paths.destination
        });
      });
    }

    return Object.freeze({
      list,
      readFile,
      writeFile,
      addFolder,
      moveFile,
      moveFolder,
      copyFile,
      copyFolder,
      deleteFile,
      deleteFolder,
      storageUsage,
      copyIntoShare,
      getAccountIdentity
    });
  }

  const api = Object.freeze({
    create,
    createVfsError,
    mapDavError
  });

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCNextcloudVfsStorage = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
