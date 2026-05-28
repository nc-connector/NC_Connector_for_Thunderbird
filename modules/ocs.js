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

  /**
   * Log internal OCS helper errors.
   * @param {string} scope
   * @param {any} reportedError
   */
  function logOcsError(scope, reportedError){
    global.NCLogContext.safeConsoleError(LOG_PREFIX, scope, reportedError);
  }

  function encodeUtf8Base64(value){
    const bytes = new TextEncoder().encode(String(value || ""));
    let binary = "";
    for (let i = 0; i < bytes.length; i++){
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Build a Basic Authorization header value.
   * @param {string} user
   * @param {string} password
   * @returns {string}
   */
  function buildAuthHeader(user, password){
    const raw = `${user || ""}:${password || ""}`;
    const encoded = encodeUtf8Base64(raw);
    return "Basic " + encoded;
  }

  /**
   * Send an OCS request and normalize the response payload.
   * @param {object} options
   * @returns {Promise<{ok:boolean,status:number,statusText:string,data:any,raw:string,meta:any,errorMessage:string}>}
   */
  async function ocsRequest({ url, method = "GET", headers = {}, body, acceptJson = true } = {}){
    const res = await fetch(url, { method, headers, body });
    const status = res.status;
    const statusText = res.statusText || "";
    const raw = await res.text().catch((error) => {
      logOcsError("response read failed", error);
      return "";
    });
    let data = null;
    if (acceptJson){
      try{
        data = raw ? JSON.parse(raw) : null;
      }catch(error){
        logOcsError("json parse failed", error);
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

  const api = { buildAuthHeader, ocsRequest };

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCOcs = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
