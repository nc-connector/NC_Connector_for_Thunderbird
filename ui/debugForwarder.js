/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
"use strict";
(function(global){
  let runtimeDisconnectGuardInstalled = false;
  let runtimeContextUnloading = false;
  let mirroredDebugEnabled = false;
  const pendingDebugSends = new Set();
  const FORWARDER_LOG_PREFIX =
    global.NCLogContext?.resolveAddonLogPrefix?.("DebugForwarder")
    || "[NCUI][DebugForwarder]";

  /**
   * Report one internal helper failure without throwing.
   * @param {(scope:string,error:any)=>void} onError
   * @param {string} scope
   * @param {any} error
   */
  function reportHelperError(onError, scope, error){
    if (typeof onError !== "function"){
      return;
    }
    try{
      onError(scope, error);
    }catch(callbackError){
      try{
        console.error(FORWARDER_LOG_PREFIX, "onError callback failed", callbackError);
      }catch(logError){
        // Ignore teardown-time logging errors.
      }
    }
  }

  /**
   * Mark the UI runtime context as unloading.
   * This stops new forwarded logs before the browser unload events arrive.
   */
  function markRuntimeContextUnloading(){
    runtimeContextUnloading = true;
  }

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
   * Wait briefly for already-started debug forwards to settle.
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  async function flushPendingDebugLogs(timeoutMs = 120){
    if (!pendingDebugSends.size){
      return;
    }
    const pending = Array.from(pendingDebugSends);
    const waitMs = Math.max(0, Number(timeoutMs) || 0);
    const settled = Promise.allSettled(pending).then(() => {});
    if (!waitMs){
      await settled;
      return;
    }
    let timerId = null;
    try{
      await Promise.race([
        settled,
        new Promise((resolve) => {
          timerId = global.setTimeout(resolve, waitMs);
        })
      ]);
    }finally{
      if (timerId !== null && typeof global.clearTimeout === "function"){
        global.clearTimeout(timerId);
      }
    }
  }

  /**
   * Mirror the persisted debugEnabled flag into one UI page.
   * Consumers receive live updates while the page stays open.
   * @param {{
   *   onChange?:(enabled:boolean)=>void,
   *   onError?:(scope:string,error:any)=>void
   * }} config
   * @returns {Promise<{getValue:()=>boolean,refresh:()=>Promise<boolean>,dispose:()=>void}>}
   */
  async function installDebugEnabledMirror(config){
    const onChange = typeof config?.onChange === "function" ? config.onChange : null;
    const onError = typeof config?.onError === "function" ? config.onError : null;
    let disposed = false;
    let currentValue = false;
    const storageChanged = global.browser?.storage?.onChanged;
    const apply = (value) => {
      if (disposed){
        return currentValue;
      }
      currentValue = !!value;
      mirroredDebugEnabled = currentValue;
      if (!onChange){
        return currentValue;
      }
      try{
        onChange(currentValue);
      }catch(error){
        reportHelperError(onError, "debug flag onChange failed", error);
      }
      return currentValue;
    };
    const refresh = async () => {
      if (disposed){
        return currentValue;
      }
      if (!global.browser?.storage?.local?.get){
        return apply(false);
      }
      try{
        const stored = await global.browser.storage.local.get(["debugEnabled"]);
        return apply(!!stored?.debugEnabled);
      }catch(error){
        reportHelperError(onError, "debug flag init failed", error);
        return apply(false);
      }
    };
    const handleStorageChange = (changes, areaName) => {
      if (disposed || areaName !== "local"){
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(changes || {}, "debugEnabled")){
        return;
      }
      apply(!!changes.debugEnabled?.newValue);
    };
    if (typeof storageChanged?.addListener === "function"){
      storageChanged.addListener(handleStorageChange);
    }
    await refresh();
    return {
      getValue: () => currentValue,
      refresh,
      dispose: () => {
        if (disposed){
          return;
        }
        disposed = true;
        if (typeof storageChanged?.removeListener === "function"){
          try{
            storageChanged.removeListener(handleStorageChange);
          }catch(error){
            reportHelperError(onError, "debug flag mirror cleanup failed", error);
          }
        }
      }
    };
  }

  /**
   * Build one shared UI debug logger that forwards through the background channel.
   * @param {{
   *   source:string,
   *   channel:string,
   *   label:string,
   *   getEnabled?:()=>boolean,
   *   getIsPageUnloading?:()=>boolean,
   *   onError?:(scope:string,error:any)=>void
   * }} config
   * @returns {(text:any,...details:any[])=>void}
   */
  function createUiDebugLogger(config){
    const source = String(config?.source || "ui");
    const channel = String(config?.channel || "NCUI");
    const label = String(config?.label || "UI");
    const getEnabled = typeof config?.getEnabled === "function"
      ? config.getEnabled
      : () => !!config?.enabled;
    const getIsPageUnloading = typeof config?.getIsPageUnloading === "function"
      ? config.getIsPageUnloading
      : () => !!config?.isPageUnloading;
    const onError = typeof config?.onError === "function" ? config.onError : null;
    return function uiDebugLog(text, ...details){
      const enabled = !!getEnabled();
      const isPageUnloading = !!getIsPageUnloading();
      if (!enabled || isPageUnloading || runtimeContextUnloading){
        return;
      }
      forwardDebugLog({
        enabled,
        isPageUnloading,
        source,
        channel,
        label,
        text,
        details,
        onError
      });
    };
  }

  /**
   * Return the latest mirrored debug flag for this UI page.
   * @returns {boolean}
   */
  function getMirroredDebugEnabled(){
    return !!mirroredDebugEnabled;
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
    const reportError = (scope, error) => reportHelperError(onError, scope, error);
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
      const trackedSend = Promise.resolve(sendPromise).then(() => {}, (error) => {
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
      pendingDebugSends.add(trackedSend);
      void trackedSend.finally(() => {
        pendingDebugSends.delete(trackedSend);
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
    forwardDebugLog,
    installDebugEnabledMirror,
    createUiDebugLogger,
    getMirroredDebugEnabled,
    markRuntimeContextUnloading,
    flushPendingDebugLogs
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
