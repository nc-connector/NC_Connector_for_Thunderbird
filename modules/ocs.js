/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Helpers for Basic auth headers and OCS JSON parsing.
 */
(function(global){
  "use strict";
  const LOG_PREFIX =
    global.NCLogContext?.resolveAddonLogPrefix?.("OCS")
    || "[NCBG]";
  const CONTROL_REQUEST_TIMEOUT_MS = 60000;

  function encodeUtf8Base64(value){
    const bytes = new TextEncoder().encode(String(value || ""));
    let binary = "";
    for (let i = 0; i < bytes.length; i++){
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function buildAuthHeader(user, password){
    const raw = `${user || ""}:${password || ""}`;
    const encoded = encodeUtf8Base64(raw);
    return "Basic " + encoded;
  }

  function getResponseMeta(response){
    return response?.data?.ocs?.meta || response?.meta || null;
  }

  function hasExplicitResult(response){
    const meta = getResponseMeta(response);
    if (!meta || typeof meta !== "object"){
      return false;
    }
    return Object.prototype.hasOwnProperty.call(meta, "status")
      || Object.prototype.hasOwnProperty.call(meta, "statuscode");
  }

  function isExplicitSuccess(response){
    if (!response?.ok || !hasExplicitResult(response)){
      return false;
    }
    const meta = getResponseMeta(response);
    const status = String(meta?.status || "").trim().toLowerCase();
    const statusCode = Number(meta?.statuscode);
    const statusOk = !status || status === "ok";
    const statusCodeOk = !Number.isFinite(statusCode)
      || statusCode === 100
      || (statusCode >= 200 && statusCode < 300);
    return statusOk && statusCodeOk;
  }

  function getFailureMessage(response, fallback = ""){
    const meta = getResponseMeta(response);
    const status = String(meta?.status || "").trim();
    const statusCode = Number(meta?.statuscode);
    return String(
      meta?.message
      || response?.errorMessage
      || response?.raw
      || fallback
      || (Number.isFinite(statusCode) ? `OCS ${statusCode}` : status)
    );
  }

  function createAbortError(){
    try{
      return new DOMException("Request canceled", "AbortError");
    }catch(error){
      const abortError = new Error("Request canceled");
      abortError.name = "AbortError";
      return abortError;
    }
  }

  async function runWithTimeout(
    callback,
    { signal, timeoutMs = CONTROL_REQUEST_TIMEOUT_MS } = {}
  ){
    if (signal?.aborted){
      throw createAbortError();
    }
    const safeTimeout = Math.max(0, Number(timeoutMs) || 0);
    if (!safeTimeout){
      return callback(signal);
    }
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = () => controller.abort();
    signal?.addEventListener?.("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, safeTimeout);
    try{
      return await callback(controller.signal);
    }catch(error){
      if (signal?.aborted){
        throw createAbortError();
      }
      if (timedOut){
        const timeoutError = new Error("Request timed out");
        timeoutError.name = "TimeoutError";
        timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    }finally{
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onParentAbort);
    }
  }

  /**
   * Send an OCS request and normalize the response payload.
   * @param {object} options
   * @returns {Promise<{ok:boolean,status:number,statusText:string,data:any,raw:string,meta:any,errorMessage:string}>}
   */
  async function ocsRequest({
    url,
    method = "GET",
    headers = {},
    body,
    acceptJson = true,
    signal,
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS
  } = {}){
    const { res, raw } = await runWithTimeout(async (requestSignal) => {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: requestSignal
      });
      const responseText = await response.text().catch((error) => {
        if (requestSignal?.aborted || error?.name === "AbortError"){
          throw error;
        }
        global.NCLogContext.safeConsoleError(LOG_PREFIX, "response read failed", error);
        throw error;
      });
      return { res: response, raw: responseText };
    }, {
      signal,
      timeoutMs
    });
    const status = res.status;
    const statusText = res.statusText || "";
    let data = null;
    if (acceptJson){
      try{
        data = raw ? JSON.parse(raw) : null;
      }catch(error){
        global.NCLogContext.safeConsoleError(LOG_PREFIX, "json parse failed", error);
        data = null;
      }
    }
    const meta = data?.ocs?.meta || null;
    let errorMessage = "";
    if (!res.ok){
      errorMessage = meta?.message || raw || (status + " " + statusText);
    }
    return {
      ok: res.ok,
      status,
      statusText,
      data,
      raw,
      meta,
      errorMessage
    };
  }

  const api = {
    buildAuthHeader,
    hasExplicitResult,
    isExplicitSuccess,
    getFailureMessage,
    runWithTimeout,
    ocsRequest
  };

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCOcs = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
