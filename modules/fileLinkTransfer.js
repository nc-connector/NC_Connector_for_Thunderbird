/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  /**
   * Implements direct and chunked FileLink data transfers.
   */
  function emitItemProgress(progress, file, loaded){
    const safeLoaded = Math.min(file.size, Math.max(0, Number(loaded) || 0));
    const percent = file.size > 0
      ? Math.round((safeLoaded / file.size) * 100)
      : 0;
    progress.reportItem({
      phase: "progress",
      itemId: file.itemId,
      fileName: file.fileName,
      displayPath: file.displayPath,
      loaded: safeLoaded,
      total: file.size,
      percent
    });
  }

  async function moveFileIntoPlace({
    sourceUrl,
    sourceProbeUrl = sourceUrl,
    targetUrl,
    totalSize,
    authHeader,
    signal,
    log,
    overwrite,
    headers = {},
    scope = "File"
  } = {}){
    const resolveUnclearMove = async () => {
      const [source, target] = await Promise.all([
        NCNextcloudDav.probePath({
          url: sourceProbeUrl,
          authHeader,
          signal,
          log
        }),
        NCNextcloudDav.probePath({
          url: targetUrl,
          authHeader,
          signal,
          log
        })
      ]);
      if (!source.exists
        && target.exists
        && !target.collection
        && target.contentLength === totalSize){
        if (typeof log === "function"){
          log(`${scope} MOVE result recovered`, { totalSize });
        }
        return "moved";
      }
      if (overwrite === false && source.exists && target.exists){
        return "collision";
      }
      return "unknown";
    };
    const recoverUnclearMove = async () => {
      const resolution = await resolveUnclearMove();
      if (resolution === "moved"){
        return Object.freeze({ status: 0, recovered: true });
      }
      if (resolution === "collision"){
        throw NCNextcloudDav.createUploadError(412);
      }
      return null;
    };
    let response;
    try{
      response = await NCNextcloudDav.fetchWithTimeout({
        signal,
        timeoutMs: NCNextcloudDav.CONTROL_REQUEST_TIMEOUT_MS,
        request: (requestSignal) => fetch(sourceUrl, {
          method: "MOVE",
          headers: {
            "Authorization": authHeader,
            "Destination": targetUrl,
            ...(typeof overwrite === "boolean" ? { "Overwrite": overwrite ? "T" : "F" } : {}),
            ...headers
          },
          signal: requestSignal
        })
      });
    }catch(error){
      if (signal?.aborted || error?.name === "AbortError"){
        throw NCNextcloudDav.createAbortError();
      }
      const recovered = await recoverUnclearMove();
      if (recovered){
        return recovered;
      }
      const uploadError = NCNextcloudDav.createTechnicalError(
        error?.message || String(error)
      );
      uploadError.cause = error;
      throw uploadError;
    }
    if (!response.ok){
      const status = Number(response.status) || 0;
      let detail = "";
      try{
        detail = await NCNextcloudDav.readResponseText(response, signal);
      }catch(error){
        if ([408, 502, 503, 504].includes(status)){
          const recovered = await recoverUnclearMove();
          if (recovered){
            return recovered;
          }
        }
        throw error;
      }
      if ([408, 502, 503, 504].includes(status)){
        const recovered = await recoverUnclearMove();
        if (recovered){
          return recovered;
        }
      }
      throw NCNextcloudDav.createUploadError(status, detail);
    }
    await NCNextcloudDav.closeResponse(response);
    return Object.freeze({ status: Number(response.status) || 0, recovered: false });
  }

  async function uploadDirect({
    file,
    davRoot,
    shareRoot,
    authHeader,
    signal,
    log,
    progress,
    overwrite,
    autoMkcol = true
  } = {}){
    const targetPath = NCNextcloudDav.joinPath(
      shareRoot,
      NCNextcloudDav.joinPath(file.relativeDir, file.fileName)
    );
    const targetUrl = NCNextcloudDav.buildFileUrl(davRoot, targetPath);
    const createOnly = overwrite === false;
    const stagePath = createOnly
      ? NCNextcloudDav.joinPath(
          shareRoot,
          NCNextcloudDav.joinPath(
            file.relativeDir,
            `.ncc-upload-${NCNextcloudDav.createFileLinkId()}`
          )
        )
      : targetPath;
    const uploadUrl = NCNextcloudDav.buildFileUrl(davRoot, stagePath);
    progress.reportItem({
      phase: "start",
      itemId: file.itemId,
      fileName: file.fileName,
      displayPath: file.displayPath
    });
    let cleanupRequired = createOnly;
    try{
      const putResult = await NCNextcloudDav.xhrWithRetry({
        method: "PUT",
        url: uploadUrl,
        headers: {
          "Authorization": authHeader,
          "Content-Type": file.contentType || "application/octet-stream",
          ...(autoMkcol !== false ? { [NCNextcloudDav.AUTO_MKCOL_HEADER]: "1" } : {})
        },
        createBody: async () => NCNextcloudDav.getSourceBlob(file),
        signal,
        operation: "direct_put",
        log,
        onRetry: () => {
          progress.reset(file);
          emitItemProgress(progress, file, 0);
        },
        onProgress: ({ loaded }) => {
          progress.setLoaded(file, loaded);
          emitItemProgress(progress, file, loaded);
        }
      });
      const result = createOnly
        ? await moveFileIntoPlace({
            sourceUrl: uploadUrl,
            targetUrl,
            totalSize: file.size,
            authHeader,
            signal,
            log,
            overwrite: false,
            scope: "Direct upload"
          })
        : putResult;
      cleanupRequired = false;
      progress.complete(file);
      progress.reportItem({
        phase: "done",
        itemId: file.itemId,
        fileName: file.fileName,
        displayPath: file.displayPath
      });
      return result;
    }catch(error){
      progress.reportItem({
        phase: "error",
        itemId: file.itemId,
        fileName: file.fileName,
        displayPath: file.displayPath,
        error: error?.ncUserMessage || bgI18n("sharing_status_error")
      });
      throw error;
    }finally{
      if (cleanupRequired){
        await NCNextcloudDav.deleteBestEffort({
          url: uploadUrl,
          authHeader,
          log,
          scope: "Direct upload staging cleanup failed"
        });
      }
    }
  }

  async function moveChunkIntoPlace({
    uploadFolderUrl,
    targetUrl,
    totalSize,
    lastModified,
    authHeader,
    signal,
    log,
    overwrite
  } = {}){
    return moveFileIntoPlace({
      sourceUrl: `${uploadFolderUrl}/.file`,
      sourceProbeUrl: uploadFolderUrl,
      targetUrl,
      totalSize,
      authHeader,
      signal,
      log,
      overwrite,
      headers: {
        "OC-Total-Length": String(totalSize),
        "X-OC-Mtime": String(Math.max(0, Math.floor((Number(lastModified) || Date.now()) / 1000)))
      },
      scope: "Chunk"
    });
  }

  async function uploadChunked({
    file,
    davRoot,
    uploadRoot,
    shareRoot,
    authHeader,
    signal,
    log,
    progress,
    overwrite
  } = {}){
    const targetPath = NCNextcloudDav.joinPath(
      shareRoot,
      NCNextcloudDav.joinPath(file.relativeDir, file.fileName)
    );
    const targetUrl = NCNextcloudDav.buildFileUrl(davRoot, targetPath);
    const uploadFolderUrl = `${String(uploadRoot || "").replace(/\/+$/, "")}/${encodeURIComponent(NCNextcloudDav.createFileLinkId())}`;
    const chunkSize = NCFileLinkUploadPolicy.getChunkSize(file.size);
    const chunkCount = Math.ceil(file.size / chunkSize);
    if (chunkCount > NCFileLinkUploadPolicy.MAX_CHUNK_COUNT){
      throw NCNextcloudDav.createTechnicalError(
        "Upload failed (too many chunks)"
      );
    }

    progress.reportItem({
      phase: "start",
      itemId: file.itemId,
      fileName: file.fileName,
      displayPath: file.displayPath
    });
    let cleanupRequired = true;
    try{
      await NCNextcloudDav.createCollection({
        url: uploadFolderUrl,
        authHeader,
        destination: targetUrl,
        signal,
        log,
        operation: "chunk_folder",
        allowExisting: true
      });
      for (let index = 0; index < chunkCount; index++){
        NCNextcloudDav.throwIfAborted(signal);
        const start = index * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        const chunkName = String(index + 1).padStart(5, "0");
        const chunk = NCNextcloudDav.getSourceBlob(file).slice(
          start,
          end,
          file.contentType || "application/octet-stream"
        );
        await NCNextcloudDav.xhrWithRetry({
          method: "PUT",
          url: `${uploadFolderUrl}/${chunkName}`,
          headers: {
            "Authorization": authHeader,
            "Content-Type": file.contentType || "application/octet-stream",
            "Destination": targetUrl,
            "OC-Total-Length": String(file.size)
          },
          createBody: async () => chunk,
          signal,
          operation: "chunk_put",
          log,
          onRetry: () => {
            progress.setLoaded(file, start);
            emitItemProgress(progress, file, start);
          },
          onProgress: ({ loaded }) => {
            const fileLoaded = Math.min(file.size, start + loaded);
            progress.setLoaded(file, fileLoaded);
            emitItemProgress(progress, file, fileLoaded);
          }
        });
        progress.setLoaded(file, end);
      }
      const result = await moveChunkIntoPlace({
        uploadFolderUrl,
        targetUrl,
        totalSize: file.size,
        lastModified: file.lastModified,
        authHeader,
        signal,
        log,
        overwrite
      });
      cleanupRequired = false;
      progress.complete(file);
      progress.reportItem({
        phase: "done",
        itemId: file.itemId,
        fileName: file.fileName,
        displayPath: file.displayPath
      });
      return result;
    }catch(error){
      progress.reportItem({
        phase: "error",
        itemId: file.itemId,
        fileName: file.fileName,
        displayPath: file.displayPath,
        error: error?.ncUserMessage || bgI18n("sharing_status_error")
      });
      throw error;
    }finally{
      if (cleanupRequired){
        await NCNextcloudDav.deleteBestEffort({
          url: uploadFolderUrl,
          authHeader,
          log,
          scope: "Chunk upload cleanup failed"
        });
      }
    }
  }

  async function uploadFile({
    file,
    davRoot,
    uploadRoot,
    shareRoot,
    authHeader,
    signal,
    log,
    progress,
    overwrite,
    autoMkcol
  } = {}){
    if (file.size > NCFileLinkUploadPolicy.DIRECT_UPLOAD_LIMIT_BYTES){
      return uploadChunked({
        file,
        davRoot,
        uploadRoot,
        shareRoot,
        authHeader,
        signal,
        log,
        progress,
        overwrite
      });
    }
    return uploadDirect({
      file,
      davRoot,
      shareRoot,
      authHeader,
      signal,
      log,
      progress,
      overwrite,
      autoMkcol
    });
  }

  global.NCFileLinkTransfer = Object.freeze({
    moveChunkIntoPlace,
    uploadDirect,
    uploadChunked,
    uploadFile
  });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
