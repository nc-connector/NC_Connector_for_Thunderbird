/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
"use strict";
(function(global){
  let runtimeDisconnectGuardInstalled = false;
  let runtimeContextUnloading = false;

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
   * Suppress known runtime-disconnect unhandled rejections during page teardown.
   * This keeps the console free of expected "context unloaded"/"Conduits" noise.
   */
  function installRuntimeDisconnectGuard(){
    if (runtimeDisconnectGuardInstalled){
      return;
    }
    if (typeof global?.addEventListener !== "function"){
      return;
    }
    runtimeDisconnectGuardInstalled = true;
    const markRuntimeContextUnloading = () => {
      runtimeContextUnloading = true;
    };
    global.addEventListener("pagehide", markRuntimeContextUnloading, true);
    global.addEventListener("beforeunload", markRuntimeContextUnloading, true);
    global.addEventListener("unload", markRuntimeContextUnloading, true);
    global.addEventListener("unhandledrejection", (event) => {
      try{
        const reason = event?.reason;
        const message = reason?.message || String(reason || "");
        if (!isKnownRuntimeDisconnectError(message)){
          return;
        }
        event?.preventDefault?.();
      }catch(error){
        // Ignore teardown-time guard failures.
      }
    });
  }

  /**
   * Convert debug payload values into transport-safe strings.
   * @param {any} value
   * @param {(scope:string,error:any)=>void} onError
   * @returns {string}
   */
  function formatLogArg(value, reportError){
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
      reportError?.("formatLogArg JSON stringify failed", error);
    }
    try{
      return String(value);
    }catch(error){
      reportError?.("formatLogArg String conversion failed", error);
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
    const isPageUnloading = !!config?.isPageUnloading || runtimeContextUnloading;
    if (!enabled || isPageUnloading){
      return;
    }
    if (!global.browser?.runtime?.sendMessage){
      return;
    }
    installRuntimeDisconnectGuard();
    const onError = typeof config?.onError === "function" ? config.onError : null;
    const reportError = (scope, error) => {
      if (!onError){
        return;
      }
      try{
        onError(scope, error);
      }catch(callbackError){
        try{
          console.error("[NCDebugForwarder] onError callback failed", callbackError);
        }catch(logError){
          // Ignore teardown-time logging errors.
        }
      }
    };
    const detailsRaw = Array.isArray(config?.details)
      ? config.details
      : (config?.details == null ? [] : [config.details]);
    const payload = {
      source: String(config?.source || "ui"),
      channel: String(config?.channel || "NCUI"),
      label: String(config?.label || "UI"),
      text: formatLogArg(config?.text, reportError)
    };
    if (detailsRaw.length){
      payload.details = detailsRaw.map((value) => formatLogArg(value, reportError));
    }
    try{
      const sendPromise = global.browser.runtime.sendMessage({
        type: "debug:log",
        payload
      });
      if (!sendPromise || typeof sendPromise.then !== "function"){
        return;
      }
      void sendPromise.then(() => {}, (error) => {
        if (runtimeContextUnloading || isPageUnloading){
          return;
        }
        const message = error?.message || String(error || "");
        if (isKnownRuntimeDisconnectError(message)){
          // Expected during page teardown.
          return;
        }
        reportError("debug log forward failed", error);
      });
    }catch(error){
      if (runtimeContextUnloading || isPageUnloading){
        return;
      }
      reportError("debug log send setup failed", error);
    }
  }

  global.NCDebugForwarder = {
    isKnownRuntimeDisconnectError,
    formatLogArg,
    forwardDebugLog
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
