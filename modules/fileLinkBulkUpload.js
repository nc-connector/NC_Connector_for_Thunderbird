/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const HASH_READ_SIZE_BYTES = 2 * 1024 * 1024;

  function createBoundary(){
    if (global.crypto && typeof global.crypto.randomUUID === "function"){
      return `ncconnector-${global.crypto.randomUUID()}`;
    }
    return `ncconnector-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }

  function getSourceBlob(file){
    const source = file?.sourceFile;
    if (!source || typeof source.slice !== "function"){
      throw NCFileLinkDav.createTechnicalError(
        "Upload failed (file data unavailable)"
      );
    }
    return source;
  }

  async function calculateMd5(file, signal){
    if (typeof global.SparkMD5?.ArrayBuffer !== "function"){
      throw NCFileLinkDav.createTechnicalError(
        "Upload failed (MD5 component unavailable)"
      );
    }
    const source = getSourceBlob(file);
    const hasher = new global.SparkMD5.ArrayBuffer();
    try{
      for (let offset = 0; offset < file.size; offset += HASH_READ_SIZE_BYTES){
        NCFileLinkDav.throwIfAborted(signal);
        const end = Math.min(file.size, offset + HASH_READ_SIZE_BYTES);
        hasher.append(await source.slice(offset, end).arrayBuffer());
      }
      if (file.size === 0){
        hasher.append(new ArrayBuffer(0));
      }
      return hasher.end(false).toLowerCase();
    }finally{
      hasher.destroy?.();
    }
  }

  async function prepareChecksums(files, signal){
    const checksums = new Map();
    for (const file of files || []){
      NCFileLinkDav.throwIfAborted(signal);
      checksums.set(file.internalId, await calculateMd5(file, signal));
    }
    return checksums;
  }

  function getUnixMtime(file){
    const milliseconds = Number(file?.lastModified) || Date.now();
    return Math.max(0, Math.floor(milliseconds / 1000));
  }

  function buildRelativeFilePath(file){
    return NCFileLinkDav.joinPath(file?.relativeDir || "", file?.fileName || "File");
  }

  function buildMultipartDescriptor({ batch, shareRoot, checksums, boundary = createBoundary() } = {}){
    const encoder = new TextEncoder();
    const parts = [];
    const ranges = [];
    let byteOffset = 0;
    const files = Array.isArray(batch?.files) ? batch.files : [];

    for (const file of files){
      const relativePath = NCFileLinkDav.joinPath(shareRoot, buildRelativeFilePath(file));
      const destinationPath = `/${relativePath}`;
      if (/[\r\n]/.test(destinationPath)){
        throw NCFileLinkDav.createTechnicalError(
          "Upload failed (invalid file path)"
        );
      }
      const checksum = String(checksums?.get(file.internalId) || "").toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(checksum)){
        throw NCFileLinkDav.createTechnicalError(
          "Upload failed (invalid MD5 checksum)"
        );
      }
      const header = [
        `--${boundary}`,
        `Content-Length: ${file.size}`,
        "Content-Type: application/octet-stream",
        `X-File-MD5: ${checksum}`,
        `X-File-Mtime: ${getUnixMtime(file)}`,
        `X-File-Path: ${destinationPath}`,
        "",
        ""
      ].join("\r\n");
      parts.push(header);
      byteOffset += encoder.encode(header).byteLength;
      const dataStart = byteOffset;
      parts.push(getSourceBlob(file));
      byteOffset += file.size;
      const dataEnd = byteOffset;
      parts.push("\r\n");
      byteOffset += 2;
      ranges.push(Object.freeze({
        file,
        destinationPath,
        dataStart,
        dataEnd
      }));
    }

    const closing = `--${boundary}--\r\n`;
    parts.push(closing);
    byteOffset += encoder.encode(closing).byteLength;
    return Object.freeze({
      boundary,
      contentType: `multipart/related; boundary="${boundary}"`,
      parts: Object.freeze(parts),
      ranges: Object.freeze(ranges),
      contentLength: byteOffset
    });
  }

  function buildBody(descriptor){
    return new Blob(descriptor.parts, { type: descriptor.contentType });
  }

  function parseBulkResponse(responseText, descriptor){
    let payload;
    try{
      payload = JSON.parse(String(responseText || ""));
    }catch(error){
      throw NCFileLinkDav.createTechnicalError(
        "Bulk upload returned invalid JSON"
      );
    }
    for (const range of descriptor.ranges){
      const result = payload?.[range.destinationPath];
      if (!result || result.error !== false){
        const detail = result?.message || result?.error || "Bulk upload part failed";
        const status = Number(result?.status ?? result?.statusCode);
        const error = NCFileLinkDav.createTechnicalError(
          String(detail),
          status === 507 ? 507 : 0
        );
        error.ncBulkPath = range.destinationPath;
        throw error;
      }
    }
    return payload;
  }

  async function uploadBatch({
    url,
    batch,
    shareRoot,
    checksums,
    authHeader,
    signal,
    log,
    progress,
    onItemStatus
  } = {}){
    const descriptor = buildMultipartDescriptor({
      batch,
      shareRoot,
      checksums
    });
    for (const range of descriptor.ranges){
      onItemStatus?.({
        phase: "start",
        itemId: range.file.itemId,
        fileName: range.file.fileName,
        displayPath: range.file.displayPath
      });
    }

    let result;
    try{
      result = await NCFileLinkDav.xhrWithRetry({
        method: "POST",
        url,
        headers: {
          "Authorization": authHeader,
          "Content-Type": descriptor.contentType
        },
        createBody: async () => {
          const body = buildBody(descriptor);
          if (body.size !== descriptor.contentLength){
            throw NCFileLinkDav.createTechnicalError(
              "Bulk upload body length mismatch"
            );
          }
          return body;
        },
        signal,
        operation: "bulk_post",
        log,
        onRetry: () => {
          for (const range of descriptor.ranges){
            progress.reset(range.file);
            onItemStatus?.({
              phase: "progress",
              itemId: range.file.itemId,
              fileName: range.file.fileName,
              displayPath: range.file.displayPath,
              loaded: 0,
              total: range.file.size,
              percent: 0
            });
          }
        },
        onProgress: ({ loaded }) => {
          for (const range of descriptor.ranges){
            const fileLoaded = Math.min(
              range.file.size,
              Math.max(0, loaded - range.dataStart)
            );
            progress.setLoaded(range.file, fileLoaded);
            const percent = range.file.size > 0
              ? Math.round((fileLoaded / range.file.size) * 100)
              : 0;
            onItemStatus?.({
              phase: "progress",
              itemId: range.file.itemId,
              fileName: range.file.fileName,
              displayPath: range.file.displayPath,
              loaded: fileLoaded,
              total: range.file.size,
              percent
            });
          }
        }
      });
      parseBulkResponse(result.responseText, descriptor);
      for (const range of descriptor.ranges){
        progress.complete(range.file);
        onItemStatus?.({
          phase: "done",
          itemId: range.file.itemId,
          fileName: range.file.fileName,
          displayPath: range.file.displayPath
        });
      }
    }catch(error){
      for (const range of descriptor.ranges){
        onItemStatus?.({
          phase: "error",
          itemId: range.file.itemId,
          fileName: range.file.fileName,
          displayPath: range.file.displayPath,
          error: error?.ncUserMessage || bgI18n("sharing_status_error")
        });
      }
      if (error?.ncBulkPath && typeof log === "function"){
        log("Bulk upload part failed", {
          error: error.message
        });
      }
      throw error;
    }
  }

  global.NCFileLinkBulkUpload = Object.freeze({
    calculateMd5,
    prepareChecksums,
    buildMultipartDescriptor,
    buildBody,
    parseBulkResponse,
    uploadBatch
  });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
