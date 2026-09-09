/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  /**
   * Coordinates FileLink plans, progress, root setup, and mixed-source transfers.
   */
  const {
    moveChunkIntoPlace,
    uploadDirect,
    uploadChunked,
    uploadFile
  } = global.NCFileLinkTransfer;
  const {
    moveRootReservation,
    reserveRoot
  } = global.NCFileLinkRootReservation;

  const FOLDER_STATUS_INTERVAL_MS = 100;

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
    progress: sharedProgress,
    fileUploadOptions,
    logCompletion = true
  } = {}){
    if (!plan.files.length){
      return;
    }
    const progress = sharedProgress || NCFileLinkUploadProgress.create({
      files: plan.files,
      onStatus,
      log
    });
    const results = new Map();
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
        const result = await uploadFile({
          file,
          davRoot,
          uploadRoot,
          shareRoot,
          authHeader,
          signal: workerSignal,
          log,
          progress,
          ...(fileUploadOptions || {})
        });
        results.set(file.internalId, result);
      }, signal, NCFileLinkUploadPolicy.MAX_PARALLEL_REQUESTS);
      if (logCompletion){
        logUploadCompleted(buildUploadSummary(plan), startedAt, log);
      }
    }finally{
      if (!sharedProgress){
        progress.stop();
      }
    }
    return results;
  }

  function buildUploadSummary(plan, {
    additionalPlan = null,
    foldersToCreate = null,
    serverCopies = null
  } = {}){
    const extra = additionalPlan || {
      files: [],
      directFiles: [],
      chunkedFiles: [],
      bulkFiles: [],
      bulkBatches: [],
      totalBytes: 0
    };
    const summary = {
      files: plan.files.length + extra.files.length,
      foldersToCreate: foldersToCreate == null
        ? plan.directories.length
        : Math.max(0, Number(foldersToCreate) || 0),
      bytes: plan.totalBytes + extra.totalBytes,
      direct: plan.directFiles.length + extra.directFiles.length,
      chunked: plan.chunkedFiles.length + extra.chunkedFiles.length,
      bulkFiles: plan.bulkFiles.length + extra.bulkFiles.length,
      bulkBatches: plan.bulkBatches.length + extra.bulkBatches.length
    };
    if (serverCopies != null){
      summary.serverCopies = Math.max(0, Number(serverCopies) || 0);
    }
    return Object.freeze(summary);
  }

  function logUploadPlan(plan, log, options){
    const summary = buildUploadSummary(plan, options);
    if (typeof log === "function"){
      log("Upload plan ready", summary);
    }
    return summary;
  }

  function logUploadCompleted(summary, startedAt, log){
    const serverCopies = Math.max(0, Number(summary.serverCopies) || 0);
    if (typeof log !== "function" || (summary.files < 1 && serverCopies < 1)){
      return;
    }
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    log("Upload completed", {
      files: summary.files,
      bytes: summary.bytes,
      ...(serverCopies > 0 ? { serverCopies } : {}),
      elapsedMs,
      bytesPerSecond: Math.round(summary.bytes / (elapsedMs / 1000))
    });
  }

  async function uploadSingleFile({
    file,
    davRoot,
    uploadRoot,
    shareRoot,
    authHeader,
    signal,
    log,
    onStatus,
    overwrite,
    autoMkcol = false
  } = {}){
    // A provider write is one VFS operation. Reusing a one-file plan preserves
    // the transfer contract without inventing Bulk batches across callers.
    const plan = NCFileLinkUploadPolicy.buildPlan({
      files: [file],
      bulkSupported: false
    });
    logUploadPlan(plan, log);
    const results = await uploadPlan({
      plan,
      davRoot,
      uploadRoot,
      shareRoot,
      authHeader,
      checksums: new Map(),
      signal,
      log,
      onStatus,
      fileUploadOptions: {
        overwrite,
        autoMkcol
      }
    });
    return Object.freeze({
      plan,
      result: results.get(plan.files[0].internalId) || null
    });
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
    additionalUploadFiles = [],
    serverCopyCount = 0,
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
    const additionalPlan = NCFileLinkUploadPolicy.buildPlan({
      files: additionalUploadFiles,
      bulkSupported: false
    });

    const directories = Array.from(new Set([
      ...plan.directories,
      ...(Array.isArray(additionalDirectories) ? additionalDirectories : [])
    ])).sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || left.localeCompare(right);
    });
    const progressFiles = [
      ...plan.files,
      ...additionalPlan.files
    ];
    const uploadSummary = logUploadPlan(plan, log, {
      additionalPlan,
      foldersToCreate: directories.length,
      serverCopies: serverCopyCount
    });
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
      const uploadStartedAt = Date.now();
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
        progress,
        logCompletion: false
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
      logUploadCompleted(uploadSummary, uploadStartedAt, log);
      return Object.freeze({ plan, root });
    }finally{
      folderStatus.stop();
      progress.stop();
    }
  }

  global.NCFileLinkUpload = Object.freeze({
    createFolderStatusReporter,
    buildUploadSummary,
    moveRootReservation,
    moveChunkIntoPlace,
    uploadDirect,
    uploadChunked,
    uploadFile,
    uploadSingleFile,
    reserveRoot,
    prepareAndUpload
  });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
