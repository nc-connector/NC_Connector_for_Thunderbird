/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
"use strict";
(function(global){
  const LOG_PREFIX = "[NCHostPermissions]";
  const api = {
    normalizeOriginPattern,
    hasOriginPermission,
    requireOriginPermission,
    ensureOriginPermissionInteractive
  };

  /**
   * Log internal host-permission errors.
   * @param {string} scope
   * @param {any} error
   */
  function logHostPermissionError(scope, error){
    try{
      console.error(LOG_PREFIX, scope, error);
    }catch(logError){
      console.error(LOG_PREFIX, scope, error?.message || String(error), logError?.message || String(logError));
    }
  }

  /**
   * Normalize a user-provided base URL into an origin pattern for optional permissions.
   * @param {string} baseUrl
   * @returns {string} Origin pattern like "https://cloud.example.com/*" or empty string.
   */
  function normalizeOriginPattern(baseUrl){
    if (!baseUrl) return "";
    try{
      const url = new URL(String(baseUrl));
      if (url.protocol !== "https:"){
        return "";
      }
      return url.origin + "/*";
    }catch(error){
      logHostPermissionError("normalize origin pattern failed", error);
      return "";
    }
  }

  /**
   * Check if the extension already has host permission for the given base URL.
   * @param {string} baseUrl
   * @returns {Promise<boolean>}
   */
  async function hasOriginPermission(baseUrl){
    const pattern = normalizeOriginPattern(baseUrl);
    if (!pattern){
      return false;
    }
    if (!global?.browser?.permissions?.contains){
      return true;
    }
    try{
      return await global.browser.permissions.contains({ origins: [pattern] });
    }catch(error){
      logHostPermissionError("permissions.contains failed", error);
      return false;
    }
  }

  /**
   * Assert optional host permission and throw if missing.
   * Shared single-path helper used by runtime modules.
   * @param {string} baseUrl
   * @param {{message?:string,scope?:string,errorFactory?:()=>Error,logMissing?:boolean}} options
   * @returns {Promise<boolean>}
   */
  async function requireOriginPermission(baseUrl, options = {}){
    if (typeof global?.browser?.permissions?.contains !== "function"){
      return true;
    }
    const ok = await hasOriginPermission(baseUrl);
    if (ok){
      return true;
    }
    const fallbackMessage = typeof options?.message === "string" && options.message.trim()
      ? options.message.trim()
      : "Host permission missing.";
    const createError = typeof options?.errorFactory === "function"
      ? options.errorFactory
      : null;
    const scope = typeof options?.scope === "string" && options.scope.trim()
      ? options.scope.trim()
      : "host permission missing";
    const logMissing = options?.logMissing !== false;
    let error = createError ? createError() : new Error(fallbackMessage);
    if (!(error instanceof Error)){
      error = new Error(String(error || fallbackMessage));
    }
    if (logMissing){
      logHostPermissionError(scope, {
        baseUrl: String(baseUrl || ""),
        message: error.message || fallbackMessage
      });
    }
    throw error;
  }

  /**
   * Request optional host permission for the given base URL (interactive by default).
   * @param {string} baseUrl
   * @param {{prompt?:boolean}} options
   * @returns {Promise<boolean>}
   */
  async function ensureOriginPermissionInteractive(baseUrl, options = {}){
    const pattern = normalizeOriginPattern(baseUrl);
    if (!pattern){
      return false;
    }
    if (!global?.browser?.permissions?.request){
      return true;
    }
    const allowPrompt = options?.prompt !== false;
    if (!allowPrompt){
      return await hasOriginPermission(baseUrl);
    }
    try{
      // Request immediately to keep user activation for the prompt.
      const granted = await global.browser.permissions.request({ origins: [pattern] });
      if (granted){
        return true;
      }
      if (global?.browser?.permissions?.contains){
        return await global.browser.permissions.contains({ origins: [pattern] });
      }
      return false;
    }catch(error){
      logHostPermissionError("permissions.request failed", error);
      try{
        if (global?.browser?.permissions?.contains){
          return await global.browser.permissions.contains({ origins: [pattern] });
        }
      }catch(containsError){
        logHostPermissionError("permissions.contains fallback failed", containsError);
      }
      return false;
    }
  }

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCHostPermissions = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
