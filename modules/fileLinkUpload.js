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
    const targetPath = NCNextcloudDav.joinPath(
      shareRoot,
      NCNextcloudDav.joinPath(file.relativeDir, file.fileName)
    );
    const targetUrl = NCNextcloudDav.buildFileUrl(davRoot, targetPath);
    progress.reportItem({
      phase: "start",
      itemId: file.itemId,
      fileName: file.fileName,
      displayPath: file.displayPath
    });
    try{
      await NCNextcloudDav.xhrWithRetry({
        method: "PUT",
        url: targetUrl,
        headers: {
          "Authorization": authHeader,
          "Content-Type": file.contentType || "application/octet-stream",
          [NCNextcloudDav.AUTO_MKCOL_HEADER]: "1"
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
      const probe = await NCNextcloudDav.probePath({
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
      response = await NCNextcloudDav.fetchWithTimeout({
        signal,
        timeoutMs: NCNextcloudDav.CONTROL_REQUEST_TIMEOUT_MS,
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
        throw NCNextcloudDav.createAbortError();
      }
      if (await probeCompletedTarget()){
        return;
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
        if ([408, 502, 503, 504].includes(status)
          && await probeCompletedTarget()){
          return;
        }
        throw error;
      }
      if ([408, 502, 503, 504].includes(status) && await probeCompletedTarget()){
        return;
      }
      throw NCNextcloudDav.createUploadError(status, detail);
    }
    await NCNextcloudDav.closeResponse(response);
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
        await NCNextcloudDav.deleteBestEffort({
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
    const reservationPath = NCNextcloudDav.joinPath(
      relativeBase,
      `_${NCNextcloudDav.createFileLinkId()}`
    );
    const reservationUrl = NCNextcloudDav.buildFileUrl(davRoot, reservationPath);
    let reservationPresent = true;
    let attemptedTargetUrl = "";
    let attemptedCandidate = null;
    let reservationFailure = null;
    let recoveredRootCleanupError = null;
    try{
      try{
        await NCNextcloudDav.createCollection({
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
        const probe = await NCNextcloudDav.probePath({
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
        NCNextcloudDav.throwIfAborted(signal);
        attemptedCandidate = candidate;
        const targetUrl = NCNextcloudDav.buildFileUrl(
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
            NCNextcloudDav.CLEANUP_TIMEOUT_MS
          );
          try{
            const [sourceResult, targetResult] = await Promise.allSettled([
              NCNextcloudDav.probePath({
                url: reservationUrl,
                authHeader,
                signal: cleanupController.signal,
                log
              }),
              NCNextcloudDav.probePath({
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
              const cleaned = await NCNextcloudDav.deleteBestEffort({
                url: attemptedTargetUrl,
                authHeader,
                log,
                scope: "Moved share root cleanup failed"
              });
              if (!cleaned && attemptedCandidate){
                const cleanupError = NCNextcloudDav.createTechnicalError(
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
              const cleanupError = NCNextcloudDav.createTechnicalError(
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
        const cleaned = await NCNextcloudDav.deleteBestEffort({
          url: reservationUrl,
          authHeader,
          log,
          scope: "Share root reservation cleanup failed"
        });
        if (!cleaned){
          const cleanupError = NCNextcloudDav.createTechnicalError(
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
        NCNextcloudDav.probePath({
          url: reservationUrl,
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
      response = await NCNextcloudDav.fetchWithTimeout({
        signal,
        timeoutMs: NCNextcloudDav.CONTROL_REQUEST_TIMEOUT_MS,
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
        throw NCNextcloudDav.createAbortError();
      }
      const resolved = await resolveUnclearResult();
      if (resolved != null){
        return resolved;
      }
      const uploadError = NCNextcloudDav.createTechnicalError(
        error?.message || String(error)
      );
      uploadError.cause = error;
      throw uploadError;
    }
    if (response.ok){
      await NCNextcloudDav.closeResponse(response);
      return true;
    }
    const status = Number(response.status) || 0;
    if (status === 412){
      await NCNextcloudDav.closeResponse(response);
      return false;
    }
    let detail = "";
    try{
      detail = await NCNextcloudDav.readResponseText(response, signal);
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
    throw NCNextcloudDav.createUploadError(status, detail);
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
    onStatus,
    progress: sharedProgress
  } = {}){
    if (!plan.files.length){
      return;
    }
    const progress = sharedProgress || NCFileLinkUploadProgress.create({
      files: plan.files,
      onStatus,
      log
    });
    const startedAt = Date.now();
    try{
      for (const batch of plan.bulkBatches){
        NCNextcloudDav.throwIfAborted(signal);
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
      await NCNextcloudDav.runPool(nonBulkFiles, async (file, _index, workerSignal) => {
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
      if (!sharedProgress){
        progress.stop();
      }
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
    collisionMessage,
    additionalDirectories = [],
    additionalProgressFiles = [],
    transferAdditionalSources
  } = {}){
    onStatus?.({ phase: "scanning" });
    const plan = NCFileLinkUploadPolicy.buildPlan({
      files,
      bulkSupported,
      fixedRequestCount
    });
    const checksums = plan.useBulkUpload
      ? await NCFileLinkBulkUpload.prepareChecksums(
          plan.bulkFiles,
          signal,
          (current, total) => onStatus?.({
            phase: "checksums",
            current,
            total
          })
        )
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

    const directories = Array.from(new Set([
      ...plan.directories,
      ...(Array.isArray(additionalDirectories) ? additionalDirectories : [])
    ])).sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || left.localeCompare(right);
    });
    const progressFiles = [
      ...plan.files,
      ...(Array.isArray(additionalProgressFiles) ? additionalProgressFiles : [])
    ];
    const progress = NCFileLinkUploadProgress.create({
      files: progressFiles,
      onStatus,
      log
    });
    const baseSegments = NCNextcloudDav.normalizeRelativePath(basePath).split("/").filter(Boolean);
    const folderTotal = baseSegments.length + 1 + directories.length;
    let folderCurrent = 0;
    const folderStatus = createFolderStatusReporter(onStatus, folderTotal);
    let root = null;
    try{
      folderStatus.set(folderCurrent, true);
      await NCNextcloudDav.prepareFolderPath({
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
      await NCNextcloudDav.createPlannedDirectories({
        davRoot,
        shareRoot: root.folderInfo.relativeFolder,
        directories,
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
        onStatus,
        progress
      });
      if (typeof transferAdditionalSources === "function"){
        await transferAdditionalSources({
          davRoot,
          uploadRoot,
          bulkUrl,
          shareRoot: root.folderInfo.relativeFolder,
          authHeader,
          signal,
          log,
          onStatus,
          progress
        });
      }
      return Object.freeze({ plan, root });
    }finally{
      folderStatus.stop();
      progress.stop();
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
