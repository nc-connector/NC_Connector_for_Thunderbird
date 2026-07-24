/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const FOLDER_STATUS_INTERVAL_MS = 100;

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

  function createFolderStatusReporter(onStatus, total){
    let current = 0;
    let lastSent = -1;
    let lastSentAt = 0;
    let timer = null;
    const emit = (force = false) => {
      const now = Date.now();
      const remaining = FOLDER_STATUS_INTERVAL_MS - (now - lastSentAt);
      if (!force && remaining > 0){
        if (!timer){
          timer = setTimeout(() => {
            timer = null;
            emit(true);
          }, remaining);
        }
        return;
      }
      if (timer){
        clearTimeout(timer);
        timer = null;
      }
      if (lastSent === current){
        return;
      }
      lastSent = current;
      lastSentAt = now;
      onStatus?.({
        phase: "folders",
        current,
        total
      });
    };
    return Object.freeze({
      set(value, force = false){
        current = Math.min(total, Math.max(0, Number(value) || 0));
        emit(force);
      },
      flush(){
        emit(true);
      },
      stop(){
        if (timer){
          clearTimeout(timer);
          timer = null;
        }
        emit(true);
      }
    });
  }

  async function uploadDirect({
    file,
    davRoot,
    shareRoot,
    authHeader,
    signal,
    log,
    progress
  } = {}){
    const targetPath = NCFileLinkDav.joinPath(
      shareRoot,
      NCFileLinkDav.joinPath(file.relativeDir, file.fileName)
    );
    const targetUrl = NCFileLinkDav.buildFileUrl(davRoot, targetPath);
    progress.reportItem({
      phase: "start",
      itemId: file.itemId,
      fileName: file.fileName,
      displayPath: file.displayPath
    });
    try{
      await NCFileLinkDav.xhrWithRetry({
        method: "PUT",
        url: targetUrl,
        headers: {
          "Authorization": authHeader,
          "Content-Type": file.contentType || "application/octet-stream",
          [NCFileLinkDav.AUTO_MKCOL_HEADER]: "1"
        },
        createBody: async () => NCFileLinkDav.getSourceBlob(file),
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
      progress.complete(file);
      progress.reportItem({
        phase: "done",
        itemId: file.itemId,
        fileName: file.fileName,
        displayPath: file.displayPath
      });
    }catch(error){
      progress.reportItem({
        phase: "error",
        itemId: file.itemId,
        fileName: file.fileName,
        displayPath: file.displayPath,
        error: error?.ncUserMessage || bgI18n("sharing_status_error")
      });
      throw error;
    }
  }

  async function moveChunkIntoPlace({
    uploadFolderUrl,
    targetUrl,
    totalSize,
    lastModified,
    authHeader,
    signal,
    log
  } = {}){
    const probeCompletedTarget = async () => {
      const probe = await NCFileLinkDav.probePath({
        url: targetUrl,
        authHeader,
        signal,
        log
      });
      if (probe.exists && !probe.collection && probe.contentLength === totalSize){
        if (typeof log === "function"){
          log("Chunk MOVE result recovered", { totalSize });
        }
        return true;
      }
      return false;
    };
    let response;
    try{
      response = await NCFileLinkDav.fetchWithTimeout({
        signal,
        timeoutMs: NCFileLinkDav.CONTROL_REQUEST_TIMEOUT_MS,
        request: (requestSignal) => fetch(`${uploadFolderUrl}/.file`, {
          method: "MOVE",
          headers: {
            "Authorization": authHeader,
            "Destination": targetUrl,
            "OC-Total-Length": String(totalSize),
            "X-OC-Mtime": String(Math.max(0, Math.floor((Number(lastModified) || Date.now()) / 1000)))
          },
          signal: requestSignal
        })
      });
    }catch(error){
      if (signal?.aborted || error?.name === "AbortError"){
        throw NCFileLinkDav.createAbortError();
      }
      if (await probeCompletedTarget()){
        return;
      }
      const uploadError = NCFileLinkDav.createTechnicalError(
        error?.message || String(error)
      );
      uploadError.cause = error;
      throw uploadError;
    }
    if (!response.ok){
      const status = Number(response.status) || 0;
      let detail = "";
      try{
        detail = await NCFileLinkDav.readResponseText(response, signal);
      }catch(error){
        if ([408, 502, 503, 504].includes(status)
          && await probeCompletedTarget()){
          return;
        }
        throw error;
      }
      if ([408, 502, 503, 504].includes(status) && await probeCompletedTarget()){
        return;
      }
      throw NCFileLinkDav.createUploadError(status, detail);
    }
    await NCFileLinkDav.closeResponse(response);
  }

  async function uploadChunked({
    file,
    davRoot,
    uploadRoot,
    shareRoot,
    authHeader,
    signal,
    log,
    progress
  } = {}){
    const targetPath = NCFileLinkDav.joinPath(
      shareRoot,
      NCFileLinkDav.joinPath(file.relativeDir, file.fileName)
    );
    const targetUrl = NCFileLinkDav.buildFileUrl(davRoot, targetPath);
    const uploadFolderUrl = `${String(uploadRoot || "").replace(/\/+$/, "")}/${encodeURIComponent(NCFileLinkDav.createFileLinkId())}`;
    const chunkSize = NCFileLinkUploadPolicy.getChunkSize(file.size);
    const chunkCount = Math.ceil(file.size / chunkSize);
    if (chunkCount > NCFileLinkUploadPolicy.MAX_CHUNK_COUNT){
      throw NCFileLinkDav.createTechnicalError(
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
      await NCFileLinkDav.createCollection({
        url: uploadFolderUrl,
        authHeader,
        destination: targetUrl,
        signal,
        log,
        operation: "chunk_folder",
        allowExisting: true
      });
      for (let index = 0; index < chunkCount; index++){
        NCFileLinkDav.throwIfAborted(signal);
        const start = index * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        const chunkName = String(index + 1).padStart(5, "0");
        const chunk = NCFileLinkDav.getSourceBlob(file).slice(
          start,
          end,
          file.contentType || "application/octet-stream"
        );
        await NCFileLinkDav.xhrWithRetry({
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
      await moveChunkIntoPlace({
        uploadFolderUrl,
        targetUrl,
        totalSize: file.size,
        lastModified: file.lastModified,
        authHeader,
        signal,
        log
      });
      cleanupRequired = false;
      progress.complete(file);
      progress.reportItem({
        phase: "done",
        itemId: file.itemId,
        fileName: file.fileName,
        displayPath: file.displayPath
      });
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
        await NCFileLinkDav.deleteBestEffort({
          url: uploadFolderUrl,
          authHeader,
          log,
          scope: "Chunk upload cleanup failed"
        });
      }
    }
  }

  async function reserveRoot({
    davRoot,
    candidates,
    authHeader,
    signal,
    log,
    collisionMessage
  } = {}){
    const createCollisionError = () => {
      const message = collisionMessage || "Share folder already exists";
      const error = new Error(message);
      error.ncUserMessage = message;
      return error;
    };
    const list = Array.isArray(candidates) ? candidates : [];
    if (!list.length){
      throw createCollisionError();
    }
    const relativeBase = list[0]?.folderInfo?.relativeBase || "";
    const reservationPath = NCFileLinkDav.joinPath(
      relativeBase,
      `_${NCFileLinkDav.createFileLinkId()}`
    );
    const reservationUrl = NCFileLinkDav.buildFileUrl(davRoot, reservationPath);
    let reservationPresent = true;
    let attemptedTargetUrl = "";
    let attemptedCandidate = null;
    let reservationFailure = null;
    let recoveredRootCleanupError = null;
    try{
      try{
        await NCFileLinkDav.createCollection({
          url: reservationUrl,
          authHeader,
          signal,
          log,
          operation: "share_root_reservation",
          allowExisting: true
        });
      }catch(error){
        if (signal?.aborted || error?.name === "AbortError"){
          throw error;
        }
        const probe = await NCFileLinkDav.probePath({
          url: reservationUrl,
          authHeader,
          signal,
          log
        });
        if (!probe.exists || !probe.collection){
          throw error;
        }
      }

      for (const candidate of list){
        NCFileLinkDav.throwIfAborted(signal);
        attemptedCandidate = candidate;
        const targetUrl = NCFileLinkDav.buildFileUrl(
          davRoot,
          candidate.folderInfo.relativeFolder
        );
        attemptedTargetUrl = targetUrl;
        const moved = await moveRootReservation({
          reservationUrl,
          targetUrl,
          authHeader,
          signal,
          log
        });
        if (moved){
          reservationPresent = false;
          return candidate;
        }
      }
      throw createCollisionError();
    }catch(error){
      reservationFailure = error;
      throw error;
    }finally{
      if (reservationPresent){
        if (attemptedTargetUrl){
          const cleanupController = new AbortController();
          const cleanupTimer = setTimeout(
            () => cleanupController.abort(),
            NCFileLinkDav.CLEANUP_TIMEOUT_MS
          );
          try{
            const [sourceResult, targetResult] = await Promise.allSettled([
              NCFileLinkDav.probePath({
                url: reservationUrl,
                authHeader,
                signal: cleanupController.signal,
                log
              }),
              NCFileLinkDav.probePath({
                url: attemptedTargetUrl,
                authHeader,
                signal: cleanupController.signal,
                log
              })
            ]);
            if (sourceResult.status !== "fulfilled"
              || targetResult.status !== "fulfilled"){
              throw sourceResult.reason || targetResult.reason;
            }
            const source = sourceResult.value;
            const target = targetResult.value;
            if (!source.exists && target.exists){
              reservationPresent = false;
              const cleaned = await NCFileLinkDav.deleteBestEffort({
                url: attemptedTargetUrl,
                authHeader,
                log,
                scope: "Moved share root cleanup failed"
              });
              if (!cleaned && attemptedCandidate){
                const cleanupError = NCFileLinkDav.createTechnicalError(
                  "Moved share root could not be cleaned"
                );
                cleanupError.cause = reservationFailure;
                cleanupError.ncRecoveredRootCandidate = attemptedCandidate;
                recoveredRootCleanupError = cleanupError;
              }
            }
          }catch(error){
            global.NCLogContext?.safeConsoleError?.(
              "[NCBG][FileLink]",
              "Share root move cleanup probe failed",
              error
            );
            if (attemptedCandidate && attemptedTargetUrl){
              reservationPresent = false;
              const cleanupError = NCFileLinkDav.createTechnicalError(
                "Share root move state requires cleanup"
              );
              cleanupError.cause = reservationFailure || error;
              cleanupError.ncRecoveredRootCandidate = Object.freeze({
                ...attemptedCandidate,
                cleanupResolution: Object.freeze({
                  reservationUrl,
                  targetUrl: attemptedTargetUrl
                })
              });
              recoveredRootCleanupError = cleanupError;
            }
          }finally{
            clearTimeout(cleanupTimer);
          }
          if (recoveredRootCleanupError){
            throw recoveredRootCleanupError;
          }
        }
      }
      if (reservationPresent){
        const cleaned = await NCFileLinkDav.deleteBestEffort({
          url: reservationUrl,
          authHeader,
          log,
          scope: "Share root reservation cleanup failed"
        });
        if (!cleaned){
          const cleanupError = NCFileLinkDav.createTechnicalError(
            "Share root reservation could not be cleaned"
          );
          cleanupError.cause = reservationFailure;
          cleanupError.ncRecoveredRootCandidate = Object.freeze({
            shareName: "",
            folderInfo: Object.freeze({
              relativeBase,
              relativeFolder: reservationPath,
              folderName: reservationPath.split("/").filter(Boolean).pop() || ""
            })
          });
          throw cleanupError;
        }
      }
    }
  }

  async function moveRootReservation({
    reservationUrl,
    targetUrl,
    authHeader,
    signal,
    log
  } = {}){
    const resolveUnclearResult = async () => {
      const [source, target] = await Promise.all([
        NCFileLinkDav.probePath({
          url: reservationUrl,
          authHeader,
          signal,
          log
        }),
        NCFileLinkDav.probePath({
          url: targetUrl,
          authHeader,
          signal,
          log
        })
      ]);
      if (!source.exists && target.exists && target.collection){
        return true;
      }
      if (source.exists && source.collection && target.exists){
        return false;
      }
      return null;
    };

    let response;
    try{
      response = await NCFileLinkDav.fetchWithTimeout({
        signal,
        timeoutMs: NCFileLinkDav.CONTROL_REQUEST_TIMEOUT_MS,
        request: (requestSignal) => fetch(reservationUrl, {
          method: "MOVE",
          headers: {
            "Authorization": authHeader,
            "Destination": targetUrl,
            "Overwrite": "F"
          },
          signal: requestSignal
        })
      });
    }catch(error){
      if (signal?.aborted || error?.name === "AbortError"){
        throw NCFileLinkDav.createAbortError();
      }
      const resolved = await resolveUnclearResult();
      if (resolved != null){
        return resolved;
      }
      const uploadError = NCFileLinkDav.createTechnicalError(
        error?.message || String(error)
      );
      uploadError.cause = error;
      throw uploadError;
    }
    if (response.ok){
      await NCFileLinkDav.closeResponse(response);
      return true;
    }
    const status = Number(response.status) || 0;
    if (status === 412){
      await NCFileLinkDav.closeResponse(response);
      return false;
    }
    let detail = "";
    try{
      detail = await NCFileLinkDav.readResponseText(response, signal);
    }catch(error){
      if ([405, 408, 409, 502, 503, 504].includes(status)){
        const resolved = await resolveUnclearResult();
        if (resolved != null){
          return resolved;
        }
      }
      throw error;
    }
    if ([405, 408, 409, 502, 503, 504].includes(status)){
      const resolved = await resolveUnclearResult();
      if (resolved != null){
        return resolved;
      }
    }
    throw NCFileLinkDav.createUploadError(status, detail);
  }

  async function uploadPlan({
    plan,
    davRoot,
    uploadRoot,
    bulkUrl,
    shareRoot,
    authHeader,
    checksums,
    signal,
    log,
    onStatus
  } = {}){
    if (!plan.files.length){
      return;
    }
    const progress = NCFileLinkUploadProgress.create({
      files: plan.files,
      onStatus,
      log
    });
    const startedAt = Date.now();
    try{
      for (const batch of plan.bulkBatches){
        NCFileLinkDav.throwIfAborted(signal);
        await NCFileLinkBulkUpload.uploadBatch({
          url: bulkUrl,
          batch,
          shareRoot,
          checksums,
          authHeader,
          signal,
          log,
          progress,
          onItemStatus: (event) => progress.reportItem(event)
        });
      }
      const nonBulkFiles = [...plan.directFiles, ...plan.chunkedFiles];
      await NCFileLinkDav.runPool(nonBulkFiles, async (file, _index, workerSignal) => {
        if (file.size > NCFileLinkUploadPolicy.DIRECT_UPLOAD_LIMIT_BYTES){
          await uploadChunked({
            file,
            davRoot,
            uploadRoot,
            shareRoot,
            authHeader,
            signal: workerSignal,
            log,
            progress
          });
        }else{
          await uploadDirect({
            file,
            davRoot,
            shareRoot,
            authHeader,
            signal: workerSignal,
            log,
            progress
          });
        }
      }, signal, NCFileLinkUploadPolicy.MAX_PARALLEL_REQUESTS);
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      if (typeof log === "function"){
        log("Upload completed", {
          files: plan.files.length,
          bytes: plan.totalBytes,
          elapsedMs,
          bytesPerSecond: Math.round(plan.totalBytes / (elapsedMs / 1000))
        });
      }
    }finally{
      progress.stop();
    }
  }

  async function prepareAndUpload({
    files,
    bulkSupported,
    fixedRequestCount,
    davRoot,
    uploadRoot,
    bulkUrl,
    basePath,
    rootCandidates,
    authHeader,
    signal,
    log,
    onStatus,
    onRootCreated,
    collisionMessage
  } = {}){
    onStatus?.({ phase: "scanning" });
    const plan = NCFileLinkUploadPolicy.buildPlan({
      files,
      bulkSupported,
      fixedRequestCount
    });
    const checksums = plan.useBulkUpload
      ? await NCFileLinkBulkUpload.prepareChecksums(plan.bulkFiles, signal)
      : new Map();
    if (typeof log === "function"){
      log("Upload plan ready", {
        files: plan.files.length,
        foldersToCreate: plan.directories.length,
        bytes: plan.totalBytes,
        direct: plan.directFiles.length,
        chunked: plan.chunkedFiles.length,
        bulkFiles: plan.bulkFiles.length,
        bulkBatches: plan.bulkBatches.length
      });
    }

    const baseSegments = NCFileLinkDav.normalizeRelativePath(basePath).split("/").filter(Boolean);
    const folderTotal = baseSegments.length + 1 + plan.directories.length;
    let folderCurrent = 0;
    const folderStatus = createFolderStatusReporter(onStatus, folderTotal);
    let root = null;
    try{
      folderStatus.set(folderCurrent, true);
      await NCFileLinkDav.prepareFolderPath({
        davRoot,
        relativePath: basePath,
        authHeader,
        signal,
        log,
        onCreated: () => {
          folderCurrent++;
          folderStatus.set(folderCurrent);
        }
      });
      try{
        root = await reserveRoot({
          davRoot,
          candidates: rootCandidates,
          authHeader,
          signal,
          log,
          collisionMessage
        });
      }catch(error){
        if (error?.ncRecoveredRootCandidate){
          await onRootCreated?.(error.ncRecoveredRootCandidate);
        }
        throw error;
      }
      folderCurrent++;
      folderStatus.set(folderCurrent);
      await onRootCreated?.(root);
      await NCFileLinkDav.createPlannedDirectories({
        davRoot,
        shareRoot: root.folderInfo.relativeFolder,
        directories: plan.directories,
        authHeader,
        signal,
        log,
        onProgress: (current) => {
          folderCurrent = baseSegments.length + 1 + current;
          folderStatus.set(folderCurrent);
        }
      });
      folderStatus.flush();
      await uploadPlan({
        plan,
        davRoot,
        uploadRoot,
        bulkUrl,
        shareRoot: root.folderInfo.relativeFolder,
        authHeader,
        checksums,
        signal,
        log,
        onStatus
      });
      return Object.freeze({ plan, root });
    }finally{
      folderStatus.stop();
    }
  }

  global.NCFileLinkUpload = Object.freeze({
    createFolderStatusReporter,
    moveRootReservation,
    moveChunkIntoPlace,
    uploadDirect,
    uploadChunked,
    reserveRoot,
    prepareAndUpload
  });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
