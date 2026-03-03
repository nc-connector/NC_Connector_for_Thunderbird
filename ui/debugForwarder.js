/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
"use strict";
(function(global){
  /**
   * Check whether a runtime messaging error is expected while the page unloads.
   * @param {string} message
   * @returns {boolean}
   */
  function isKnownRuntimeDisconnectError(message){
    const text = String(message || "");
    return (
      text.includes("context unloaded") ||
      text.includes("Conduits") ||
      text.includes("Receiving end does not exist")
    );
  }

  /**
   * Convert debug payload values into transport-safe strings.
   * @param {any} value
   * @param {(scope:string,error:any)=>void} onError
   * @returns {string}
   */
  function formatLogArg(value, onError){
    if (value == null){
      return String(value);
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean"){
      return String(value);
    }
    if (value instanceof Error){
      return value?.message || value.toString();
    }
    try{
      return JSON.stringify(value);
    }catch(error){
      onError?.("formatLogArg JSON stringify failed", error);
    }
    try{
      return String(value);
    }catch(error){
      onError?.("formatLogArg String conversion failed", error);
      return Object.prototype.toString.call(value);
    }
  }

  /**
   * Forward a debug log line to background runtime logging.
   * @param {{
   *   enabled:boolean,
   *   isPageUnloading:boolean,
   *   source:string,
   *   channel:string,
   *   label:string,
   *   text:any,
   *   details?:any[]|any,
   *   onError?:(scope:string,error:any)=>void
   * }} config
   */
  function forwardDebugLog(config){
    const enabled = !!config?.enabled;
    const isPageUnloading = !!config?.isPageUnloading;
    if (!enabled || isPageUnloading){
      return;
    }
    if (!global.browser?.runtime?.sendMessage){
      return;
    }
    const onError = typeof config?.onError === "function" ? config.onError : null;
    const detailsRaw = Array.isArray(config?.details)
      ? config.details
      : (config?.details == null ? [] : [config.details]);
    const payload = {
      source: String(config?.source || "ui"),
      channel: String(config?.channel || "NCUI"),
      label: String(config?.label || "UI"),
      text: formatLogArg(config?.text, onError)
    };
    if (detailsRaw.length){
      payload.details = detailsRaw.map((value) => formatLogArg(value, onError));
    }
    try{
      void global.browser.runtime.sendMessage({
        type: "debug:log",
        payload
      }).catch((error) => {
        if (isPageUnloading){
          return;
        }
        const message = error?.message || String(error || "");
        if (isKnownRuntimeDisconnectError(message)){
          onError?.("debug log forward skipped", message);
          return;
        }
        onError?.("debug log forward failed", error);
      });
    }catch(error){
      if (isPageUnloading){
        return;
      }
      onError?.("debug log send setup failed", error);
    }
  }

  global.NCDebugForwarder = {
    isKnownRuntimeDisconnectError,
    formatLogArg,
    forwardDebugLog
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

