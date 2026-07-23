/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const MIB = 1024 * 1024;
  const GIB = 1024 * MIB;
  const DIRECT_UPLOAD_LIMIT_BYTES = 20 * MIB;
  const DEFAULT_CHUNK_SIZE_BYTES = 20 * MIB;
  const MIN_CHUNK_SIZE_BYTES = 5 * MIB;
  const MAX_CHUNK_SIZE_BYTES = 5 * GIB;
  const MAX_CHUNK_COUNT = 10000;
  const MAX_FILE_SIZE_BYTES = MAX_CHUNK_SIZE_BYTES * MAX_CHUNK_COUNT;
  const BULK_CANDIDATE_LIMIT_BYTES = 8 * MIB;
  const BULK_BATCH_LIMIT_BYTES = 20 * MIB;
  const BULK_BATCH_FILE_LIMIT = 100;
  const BULK_MINIMUM_FILE_COUNT = 20;
  const MAX_PARALLEL_REQUESTS = 3;
  const MAX_ATTEMPTS = 3;
  const RETRY_AFTER_LIMIT_MS = 30000;
  const RETRY_STATUS_CODES = Object.freeze([408, 423, 429, 502, 503, 504]);

  function requireSize(value){
    const numeric = Number(value);
    if (!Number.isFinite(numeric)
      || numeric < 0
      || numeric > MAX_FILE_SIZE_BYTES){
      const error = new RangeError("Upload failed (unsupported file size)");
      error.ncUserMessage = bgI18n("sharing_status_error");
      throw error;
    }
    return Math.floor(numeric);
  }

  function getChunkSize(fileSize){
    const size = requireSize(fileSize);
    const minimumForChunkLimit = Math.ceil(size / MAX_CHUNK_COUNT);
    const chunkSize = Math.max(
      DEFAULT_CHUNK_SIZE_BYTES,
      MIN_CHUNK_SIZE_BYTES,
      minimumForChunkLimit
    );
    if (chunkSize > MAX_CHUNK_SIZE_BYTES){
      const error = new RangeError("Upload failed (file exceeds the chunked upload limit)");
      error.ncUserMessage = bgI18n("sharing_status_error");
      throw error;
    }
    return chunkSize;
  }

  function getChunkRequestCount(fileSize){
    const size = requireSize(fileSize);
    if (size <= DIRECT_UPLOAD_LIMIT_BYTES){
      return 1;
    }
    return Math.ceil(size / getChunkSize(size)) + 2;
  }

  function isBulkCandidate(fileSize){
    const numeric = Number(fileSize);
    return Number.isFinite(numeric)
      && numeric >= 0
      && numeric <= BULK_CANDIDATE_LIMIT_BYTES;
  }

  function buildBulkBatches(files){
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const file of files){
      const size = requireSize(file?.size);
      const batchFull = current.length >= BULK_BATCH_FILE_LIMIT
        || (current.length > 0 && currentBytes + size > BULK_BATCH_LIMIT_BYTES);
      if (batchFull){
        batches.push(Object.freeze({
          files: Object.freeze(current.slice()),
          totalBytes: currentBytes
        }));
        current = [];
        currentBytes = 0;
      }
      current.push(file);
      currentBytes += size;
    }
    if (current.length){
      batches.push(Object.freeze({
        files: Object.freeze(current.slice()),
        totalBytes: currentBytes
      }));
    }
    return Object.freeze(batches);
  }

  function shouldUseBulkUpload({
    supported,
    candidateFileCount,
    directRequestCount,
    bulkRequestCount
  } = {}){
    if (!supported
      || candidateFileCount < BULK_MINIMUM_FILE_COUNT
      || Number(bulkRequestCount) <= 0){
      return false;
    }
    const direct = Math.max(0, Number(directRequestCount) || 0);
    const bulk = Math.max(0, Number(bulkRequestCount) || 0);
    return bulk * 5 <= direct * 4;
  }

  function collectAllDirectoryPaths(files){
    const paths = new Set();
    for (const file of files){
      const relativeDir = String(file?.relativeDir || "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (!relativeDir){
        continue;
      }
      const segments = relativeDir.split("/").filter(Boolean);
      let current = "";
      for (const segment of segments){
        current = current ? `${current}/${segment}` : segment;
        paths.add(current);
      }
    }
    return Object.freeze(Array.from(paths).sort((left, right) => {
      const depthDifference = left.split("/").length - right.split("/").length;
      return depthDifference || left.localeCompare(right);
    }));
  }

  function collectSharedDirectDirectoryPaths(files){
    const counts = new Map();
    for (const file of files){
      const relativeDir = String(file?.relativeDir || "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (!relativeDir){
        continue;
      }
      const segments = relativeDir.split("/").filter(Boolean);
      let current = "";
      for (const segment of segments){
        current = current ? `${current}/${segment}` : segment;
        counts.set(current, (counts.get(current) || 0) + 1);
      }
    }
    return Object.freeze(Array.from(counts.entries())
      .filter(([, count]) => count >= 2)
      .map(([path]) => path)
      .sort((left, right) => {
        const depthDifference = left.split("/").length - right.split("/").length;
        return depthDifference || left.localeCompare(right);
      }));
  }

  function mergeDirectoryPaths(...pathLists){
    const paths = new Set();
    for (const list of pathLists){
      for (const path of list || []){
        paths.add(path);
      }
    }
    return Object.freeze(Array.from(paths).sort((left, right) => {
      const depthDifference = left.split("/").length - right.split("/").length;
      return depthDifference || left.localeCompare(right);
    }));
  }

  function buildPlan({
    files,
    bulkSupported = false,
    fixedRequestCount = 0
  } = {}){
    const sourceFiles = Array.isArray(files)
      ? files.map((file, index) => Object.freeze({
        ...file,
        internalId: String(file?.internalId || `file-${index + 1}`),
        size: requireSize(file?.size)
      }))
      : [];
    const directFiles = [];
    const chunkedFiles = [];
    const bulkCandidates = [];
    let normalFileRequestCount = 0;
    let totalBytes = 0;

    for (const file of sourceFiles){
      const size = file.size;
      totalBytes += size;
      normalFileRequestCount += getChunkRequestCount(size);
      if (size > DIRECT_UPLOAD_LIMIT_BYTES){
        chunkedFiles.push(file);
      }else{
        directFiles.push(file);
        if (isBulkCandidate(size)){
          bulkCandidates.push(file);
        }
      }
    }

    const bulkBatches = buildBulkBatches(bulkCandidates);
    const fixed = Math.max(0, Number(fixedRequestCount) || 0);
    const directDirectories = mergeDirectoryPaths(
      collectAllDirectoryPaths(chunkedFiles),
      collectSharedDirectDirectoryPaths(directFiles)
    );
    const nonBulkDirectFiles = directFiles.filter((file) => !isBulkCandidate(file.size));
    const bulkDirectories = mergeDirectoryPaths(
      collectAllDirectoryPaths(chunkedFiles),
      collectAllDirectoryPaths(bulkCandidates),
      collectSharedDirectDirectoryPaths(nonBulkDirectFiles)
    );
    const candidateDirectRequests = bulkCandidates.length;
    const directRequestCount = fixed + directDirectories.length + normalFileRequestCount;
    const bulkRequestCount = fixed
      + bulkDirectories.length
      + normalFileRequestCount
      - candidateDirectRequests
      + bulkBatches.length;
    const useBulkUpload = shouldUseBulkUpload({
      supported: bulkSupported,
      candidateFileCount: bulkCandidates.length,
      directRequestCount,
      bulkRequestCount
    });
    const bulkIds = useBulkUpload
      ? new Set(bulkCandidates.map((file) => file.internalId))
      : new Set();
    const directories = useBulkUpload ? bulkDirectories : directDirectories;

    return Object.freeze({
      files: Object.freeze(sourceFiles),
      directFiles: Object.freeze(directFiles.filter((file) => !bulkIds.has(file.internalId))),
      chunkedFiles: Object.freeze(chunkedFiles),
      bulkFiles: Object.freeze(useBulkUpload ? bulkCandidates : []),
      bulkBatches: Object.freeze(useBulkUpload ? bulkBatches : []),
      directories,
      totalBytes,
      directRequestCount,
      bulkRequestCount,
      useBulkUpload
    });
  }

  function isRetryStatus(status){
    return RETRY_STATUS_CODES.includes(Number(status));
  }

  const api = Object.freeze({
    DIRECT_UPLOAD_LIMIT_BYTES,
    DEFAULT_CHUNK_SIZE_BYTES,
    MAX_CHUNK_COUNT,
    MAX_FILE_SIZE_BYTES,
    BULK_CANDIDATE_LIMIT_BYTES,
    BULK_BATCH_LIMIT_BYTES,
    BULK_BATCH_FILE_LIMIT,
    BULK_MINIMUM_FILE_COUNT,
    MAX_PARALLEL_REQUESTS,
    MAX_ATTEMPTS,
    RETRY_AFTER_LIMIT_MS,
    RETRY_STATUS_CODES,
    getChunkSize,
    getChunkRequestCount,
    isBulkCandidate,
    buildBulkBatches,
    shouldUseBulkUpload,
    buildPlan,
    isRetryStatus
  });

  global.NCFileLinkUploadPolicy = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
