/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const AUTO_MKCOL_HEADER = "X-NC-WebDAV-Auto-Mkcol";
  const UPLOAD_TIMEOUT_MS = 300000;
  const CONTROL_REQUEST_TIMEOUT_MS = 60000;
  const CLEANUP_TIMEOUT_MS = 10000;
  const RESPONSE_LIFETIMES = new WeakMap();

  function createFileLinkId(){
    if (global.crypto && typeof global.crypto.randomUUID === "function"){
      return `ncconnector-${global.crypto.randomUUID()}`;
    }
    return `ncconnector-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }

  function getSourceBlob(file){
    const source = file?.sourceFile;
    if (!source || typeof source.slice !== "function"){
      throw createTechnicalError("Upload failed (file data unavailable)");
    }
    return source;
  }

  function normalizeRelativePath(value){
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
  }

  function joinPath(base, child){
    const left = normalizeRelativePath(base);
    const right = normalizeRelativePath(child);
    if (!left) return right;
    if (!right) return left;
    return `${left}/${right}`;
  }

  function encodePath(value){
    return normalizeRelativePath(value)
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  function buildFileUrl(davRoot, relativePath){
    const path = encodePath(relativePath);
    return path ? `${String(davRoot || "").replace(/\/+$/, "")}/${path}` : String(davRoot || "").replace(/\/+$/, "");
  }

  function createAbortError(){
    try{
      return new DOMException("Upload canceled", "AbortError");
    }catch(error){
      const abortError = new Error("Upload canceled");
      abortError.name = "AbortError";
      return abortError;
    }
  }

  function throwIfAborted(signal){
    if (signal?.aborted){
      throw createAbortError();
    }
  }

  function createTechnicalError(detail, status = 0){
    const numericStatus = Number(status) || 0;
    const technicalMessage = String(detail || "").trim() || (numericStatus
      ? `Upload failed (${numericStatus})`
      : "Upload failed (network error)");
    const error = new Error(technicalMessage);
    error.status = numericStatus;
    error.ncUserMessage = numericStatus === 507
      ? bgI18n("sharing_insufficient_storage")
      : bgI18n("sharing_status_error");
    return error;
  }

  function createUploadError(status, detail = ""){
    return createTechnicalError(detail, status);
  }

  function createTimeoutError(cause){
    const error = createTechnicalError("Request timed out");
    error.name = "TimeoutError";
    error.cause = cause;
    return error;
  }

  function releaseResponseLifetime(response){
    const lifetime = response && RESPONSE_LIFETIMES.get(response);
    if (!lifetime){
      return;
    }
    RESPONSE_LIFETIMES.delete(response);
    lifetime.release();
  }

  async function readResponseText(response, signal){
    if (!response || typeof response.text !== "function"){
      return "";
    }
    try{
      return await response.text();
    }catch(error){
      const lifetime = RESPONSE_LIFETIMES.get(response);
      if (signal?.aborted){
        throw createAbortError();
      }
      if (lifetime?.isTimedOut()){
        throw createTimeoutError(error);
      }
      if (error?.name === "AbortError"){
        throw createAbortError();
      }
      global.NCLogContext?.safeConsoleError?.(
        "[NCBG][FileLink]",
        "DAV response read failed",
        error
      );
      throw error;
    }finally{
      releaseResponseLifetime(response);
    }
  }

  async function closeResponse(response){
    try{
      await response?.body?.cancel?.();
    }catch(error){
      global.NCLogContext?.safeConsoleError?.(
        "[NCBG][FileLink]",
        "DAV response close failed",
        error
      );
    }finally{
      releaseResponseLifetime(response);
    }
  }

  async function snapshotResponse(response, signal, readBody = true){
    const snapshot = {
      ok: !!response?.ok,
      status: Number(response?.status) || 0,
      statusText: String(response?.statusText || ""),
      headers: response?.headers || null,
      raw: ""
    };
    if (readBody){
      snapshot.raw = await readResponseText(response, signal);
    }else{
      await closeResponse(response);
    }
    return snapshot;
  }

  function parseRetryAfter(value, now = Date.now()){
    const text = String(value || "").trim();
    if (!text){
      return null;
    }
    if (/^\d+$/.test(text)){
      return Math.min(
        NCFileLinkUploadPolicy.RETRY_AFTER_LIMIT_MS,
        Math.max(0, Number(text) * 1000)
      );
    }
    const timestamp = Date.parse(text);
    if (!Number.isFinite(timestamp)){
      return null;
    }
    return Math.min(
      NCFileLinkUploadPolicy.RETRY_AFTER_LIMIT_MS,
      Math.max(0, timestamp - now)
    );
  }

  function getRetryDelay(attempt, retryAfterValue = ""){
    const retryAfter = parseRetryAfter(retryAfterValue);
    if (retryAfter != null){
      return retryAfter;
    }
    return Math.min(1000, Math.max(1, Number(attempt) || 1) * 500);
  }

  async function waitForRetry(delayMs, signal){
    throwIfAborted(signal);
    await new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        signal?.removeEventListener?.("abort", onAbort);
        callback(value);
      };
      const onAbort = () => {
        clearTimeout(timer);
        finish(reject, createAbortError());
      };
      const timer = setTimeout(
        () => finish(resolve),
        Math.max(0, Number(delayMs) || 0)
      );
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted){
        onAbort();
      }
    });
  }

  function logRetry(log, operation, attempt, status, delayMs){
    if (typeof log === "function"){
      log("Upload request retry scheduled", {
        operation,
        attempt,
        status: Number(status) || 0,
        delayMs
      });
    }
  }

  async function fetchWithTimeout({
    request,
    signal,
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS
  } = {}){
    throwIfAborted(signal);
    const safeTimeout = Math.max(0, Number(timeoutMs) || 0);
    if (!safeTimeout){
      return request(signal);
    }
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => controller.abort();
    signal?.addEventListener?.("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, safeTimeout);
    let released = false;
    const release = () => {
      if (released){
        return;
      }
      released = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onParentAbort);
    };
    try{
      const response = await request(controller.signal);
      if (response && (
        typeof response.text === "function"
        || response.body
      )){
        RESPONSE_LIFETIMES.set(response, {
          isTimedOut: () => timedOut,
          release
        });
      }else{
        release();
      }
      return response;
    }catch(error){
      release();
      if (signal?.aborted){
        throw createAbortError();
      }
      if (timedOut){
        throw createTimeoutError(error);
      }
      throw error;
    }
  }

  async function fetchWithRetry({
    request,
    operation,
    signal,
    log,
    retryTransport = true,
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
    consume
  } = {}){
    for (let attempt = 1; attempt <= NCFileLinkUploadPolicy.MAX_ATTEMPTS; attempt++){
      throwIfAborted(signal);
      let response;
      try{
        response = await fetchWithTimeout({
          request: async (requestSignal) => {
            const requested = await request(attempt, requestSignal);
            return typeof consume === "function"
              ? consume(requested, requestSignal, attempt)
              : requested;
          },
          signal,
          timeoutMs
        });
      }catch(error){
        if (signal?.aborted || error?.name === "AbortError"){
          throw createAbortError();
        }
        if (!retryTransport || attempt >= NCFileLinkUploadPolicy.MAX_ATTEMPTS){
          const uploadError = createTechnicalError(
            error?.message || String(error)
          );
          uploadError.cause = error;
          throw uploadError;
        }
        const delayMs = getRetryDelay(attempt);
        logRetry(log, operation, attempt, 0, delayMs);
        await waitForRetry(delayMs, signal);
        continue;
      }
      if (!NCFileLinkUploadPolicy.isRetryStatus(response.status)
        || attempt >= NCFileLinkUploadPolicy.MAX_ATTEMPTS){
        return response;
      }
      const delayMs = getRetryDelay(attempt, response.headers?.get?.("Retry-After") || "");
      logRetry(log, operation, attempt, response.status, delayMs);
      await closeResponse(response);
      await waitForRetry(delayMs, signal);
    }
    throw createUploadError(0);
  }

  function xhrRequest({
    method,
    url,
    headers,
    body,
    signal,
    onProgress,
    timeoutMs = UPLOAD_TIMEOUT_MS
  } = {}){
    return new Promise((resolve, reject) => {
      throwIfAborted(signal);
      const xhr = new XMLHttpRequest();
      let settled = false;
      const finish = (callback, value) => {
        if (settled){
          return;
        }
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        callback(value);
      };
      const onAbort = () => {
        try{
          xhr.abort();
        }catch(error){
          global.NCLogContext?.safeConsoleError?.(
            "[NCBG][FileLink]",
            "XHR abort failed",
            error
          );
        }
        finish(reject, createAbortError());
      };

      xhr.open(String(method || "PUT"), url, true);
      xhr.timeout = Math.max(1, Number(timeoutMs) || UPLOAD_TIMEOUT_MS);
      for (const [name, value] of Object.entries(headers || {})){
        xhr.setRequestHeader(name, String(value));
      }
      xhr.upload.onprogress = (event) => {
        if (typeof onProgress === "function"){
          onProgress({
            loaded: Math.max(0, Number(event.loaded) || 0),
            total: event.lengthComputable ? Math.max(0, Number(event.total) || 0) : 0
          });
        }
      };
      xhr.onload = () => finish(resolve, {
        status: Number(xhr.status) || 0,
        statusText: xhr.statusText || "",
        responseText: xhr.responseText || "",
        getHeader: (name) => xhr.getResponseHeader(name) || ""
      });
      xhr.onerror = () => {
        const error = createUploadError(0);
        error.ncTransportFailure = true;
        finish(reject, error);
      };
      xhr.ontimeout = () => {
        const error = createUploadError(0, "Upload failed (timeout)");
        error.ncTransportFailure = true;
        finish(reject, error);
      };
      xhr.onabort = () => finish(reject, createAbortError());
      signal?.addEventListener?.("abort", onAbort, { once: true });
      xhr.send(body);
    });
  }

  async function xhrWithRetry({
    method,
    url,
    headers,
    createBody,
    signal,
    onProgress,
    onRetry,
    operation,
    log
  } = {}){
    for (let attempt = 1; attempt <= NCFileLinkUploadPolicy.MAX_ATTEMPTS; attempt++){
      throwIfAborted(signal);
      let result;
      try{
        result = await xhrRequest({
          method,
          url,
          headers,
          body: await createBody(attempt),
          signal,
          onProgress
        });
      }catch(error){
        if (signal?.aborted || error?.name === "AbortError"){
          throw createAbortError();
        }
        if (!error?.ncTransportFailure || attempt >= NCFileLinkUploadPolicy.MAX_ATTEMPTS){
          throw error;
        }
        const delayMs = getRetryDelay(attempt);
        onRetry?.();
        logRetry(log, operation, attempt, 0, delayMs);
        await waitForRetry(delayMs, signal);
        continue;
      }
      if (result.status >= 200 && result.status < 300){
        return result;
      }
      if (!NCFileLinkUploadPolicy.isRetryStatus(result.status)
        || attempt >= NCFileLinkUploadPolicy.MAX_ATTEMPTS){
        throw createUploadError(result.status, result.responseText);
      }
      const delayMs = getRetryDelay(attempt, result.getHeader("Retry-After"));
      onRetry?.();
      logRetry(log, operation, attempt, result.status, delayMs);
      await waitForRetry(delayMs, signal);
    }
    throw createUploadError(0);
  }

  async function probePath({
    url,
    authHeader,
    signal,
    log,
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS
  } = {}){
    const response = await fetchWithRetry({
      operation: "dav_probe",
      signal,
      log,
      timeoutMs,
      consume: (response, requestSignal) =>
        snapshotResponse(response, requestSignal, response.status !== 404),
      request: (_attempt, requestSignal) => fetch(url, {
        method: "PROPFIND",
        headers: {
          "Authorization": authHeader,
          "Depth": "0"
        },
        signal: requestSignal
      })
    });
    if (response.status === 404){
      return Object.freeze({ exists: false, collection: false, contentLength: null });
    }
    if (response.status !== 207 && response.status !== 200){
      throw createUploadError(response.status, response.raw);
    }
    const xml = response.raw;
    const collection = /<(?:[\w.-]+:)?collection(?:\s|\/|>)/i.test(xml);
    const lengthMatch = xml.match(
      /<(?:[\w.-]+:)?getcontentlength[^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?getcontentlength>/i
    );
    const contentLength = lengthMatch ? Number(lengthMatch[1]) : null;
    return Object.freeze({
      exists: true,
      collection,
      contentLength: Number.isFinite(contentLength) ? contentLength : null
    });
  }

  async function createCollection({
    url,
    authHeader,
    destination = "",
    signal,
    log,
    operation = "folder",
    allowExisting = true,
    retryTransport = true
  } = {}){
    const headers = { "Authorization": authHeader };
    if (destination){
      headers.Destination = destination;
    }
    const response = await fetchWithRetry({
      operation,
      signal,
      log,
      retryTransport,
      consume: (response, requestSignal) =>
        snapshotResponse(
          response,
          requestSignal,
          response.status !== 201 && response.status !== 405
        ),
      request: (_attempt, requestSignal) => fetch(url, {
        method: "MKCOL",
        headers,
        signal: requestSignal
      })
    });
    if (response.status === 201){
      return true;
    }
    if (response.status === 405){
      if (!allowExisting){
        return false;
      }
      const probe = await probePath({ url, authHeader, signal, log });
      if (probe.exists && probe.collection){
        return false;
      }
    }
    throw createUploadError(response.status, response.raw);
  }

  async function prepareFolderPath({
    davRoot,
    relativePath,
    authHeader,
    signal,
    log,
    onCreated
  } = {}){
    const segments = normalizeRelativePath(relativePath).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments){
      current = current ? `${current}/${segment}` : segment;
      await createCollection({
        url: buildFileUrl(davRoot, current),
        authHeader,
        signal,
        log,
        operation: "base_folder",
        allowExisting: true
      });
      onCreated?.(current);
    }
  }

  async function runPool(items, worker, parentSignal, limit = NCFileLinkUploadPolicy.MAX_PARALLEL_REQUESTS){
    const list = Array.isArray(items) ? items : [];
    const controller = new AbortController();
    let firstError = null;
    let nextIndex = 0;
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
    if (parentSignal?.aborted){
      controller.abort();
    }
    const workers = Array.from(
      { length: Math.min(Math.max(1, Number(limit) || 1), list.length) },
      async () => {
        while (!controller.signal.aborted){
          const index = nextIndex++;
          if (index >= list.length){
            return;
          }
          try{
            await worker(list[index], index, controller.signal);
          }catch(error){
            if (!firstError){
              firstError = error;
            }
            controller.abort();
            return;
          }
        }
      }
    );
    await Promise.allSettled(workers);
    parentSignal?.removeEventListener?.("abort", onParentAbort);
    if (firstError){
      throw firstError;
    }
    throwIfAborted(parentSignal);
  }

  async function createPlannedDirectories({
    davRoot,
    shareRoot,
    directories,
    authHeader,
    signal,
    log,
    onProgress
  } = {}){
    const list = Array.isArray(directories) ? directories : [];
    const groups = new Map();
    for (const path of list){
      const depth = normalizeRelativePath(path).split("/").filter(Boolean).length;
      if (!groups.has(depth)){
        groups.set(depth, []);
      }
      groups.get(depth).push(path);
    }
    let completed = 0;
    for (const depth of Array.from(groups.keys()).sort((left, right) => left - right)){
      await runPool(groups.get(depth), async (relativeDir, index, workerSignal) => {
        await createCollection({
          url: buildFileUrl(davRoot, joinPath(shareRoot, relativeDir)),
          authHeader,
          signal: workerSignal,
          log,
          operation: "planned_folder",
          allowExisting: true
        });
        completed++;
        onProgress?.(completed, list.length);
      }, signal);
    }
  }

  async function deleteRemotePath({ url, authHeader, signal, log } = {}){
    const response = await fetchWithRetry({
      operation: "cleanup_delete",
      signal,
      log,
      timeoutMs: CLEANUP_TIMEOUT_MS,
      consume: (response, requestSignal) =>
        snapshotResponse(
          response,
          requestSignal,
          !response.ok && response.status !== 404
        ),
      request: (_attempt, requestSignal) => fetch(url, {
        method: "DELETE",
        headers: { "Authorization": authHeader },
        signal: requestSignal
      })
    });
    if (response.status === 404){
      return false;
    }
    if (!response.ok){
      throw createUploadError(response.status, response.raw);
    }
    return true;
  }

  async function deleteRootReservation({
    reservationUrl,
    targetUrl,
    authHeader,
    signal,
    log
  } = {}){
    const source = await probePath({
      url: reservationUrl,
      authHeader,
      signal,
      log,
      timeoutMs: CLEANUP_TIMEOUT_MS
    });
    if (source.exists){
      await deleteRemotePath({
        url: reservationUrl,
        authHeader,
        signal,
        log
      });
      return "reservation";
    }

    const target = await probePath({
      url: targetUrl,
      authHeader,
      signal,
      log,
      timeoutMs: CLEANUP_TIMEOUT_MS
    });
    if (!target.exists){
      return "absent";
    }
    if (!target.collection){
      throw createTechnicalError("Reserved share target is not a collection");
    }
    await deleteRemotePath({
      url: targetUrl,
      authHeader,
      signal,
      log
    });
    return "target";
  }

  async function deleteTrackedRoot({
    url,
    reservationUrl = "",
    targetUrl = "",
    authHeader,
    signal,
    log
  } = {}){
    const hasReservationUrl = !!String(reservationUrl || "").trim();
    const hasTargetUrl = !!String(targetUrl || "").trim();
    if (hasReservationUrl !== hasTargetUrl){
      throw createTechnicalError("Incomplete share root cleanup paths");
    }
    if (hasReservationUrl){
      return deleteRootReservation({
        reservationUrl,
        targetUrl,
        authHeader,
        signal,
        log
      });
    }
    if (!String(url || "").trim()){
      throw createTechnicalError("Share root cleanup URL is missing");
    }
    await deleteRemotePath({
      url,
      authHeader,
      signal,
      log
    });
    return "target";
  }

  async function deleteBestEffort({ url, authHeader, log, scope = "Upload cleanup failed" } = {}){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
    try{
      await deleteRemotePath({
        url,
        authHeader,
        signal: controller.signal,
        log
      });
      return true;
    }catch(error){
      global.NCLogContext?.safeConsoleError?.("[NCBG][FileLink]", scope, error);
      return false;
    }finally{
      clearTimeout(timer);
    }
  }

  const api = Object.freeze({
    AUTO_MKCOL_HEADER,
    CONTROL_REQUEST_TIMEOUT_MS,
    CLEANUP_TIMEOUT_MS,
    createFileLinkId,
    getSourceBlob,
    normalizeRelativePath,
    joinPath,
    buildFileUrl,
    createAbortError,
    throwIfAborted,
    createTechnicalError,
    createUploadError,
    readResponseText,
    closeResponse,
    parseRetryAfter,
    fetchWithTimeout,
    fetchWithRetry,
    xhrWithRetry,
    probePath,
    createCollection,
    prepareFolderPath,
    createPlannedDirectories,
    runPool,
    deleteRemotePath,
    deleteRootReservation,
    deleteTrackedRoot,
    deleteBestEffort
  });

  global.NCFileLinkDav = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
