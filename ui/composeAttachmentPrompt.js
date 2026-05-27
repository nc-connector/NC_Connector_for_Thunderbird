/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(){
  'use strict';
  const LOG_SOURCE = "composeAttachmentPrompt";
  const LOG_CHANNEL = "NCUI";
  const LOG_LABEL = "Sharing";
  const LOG_PREFIX = `[${LOG_CHANNEL}][${LOG_LABEL}]`;
  const i18n = NCI18n.translate;
  const toShortId = NCTalkTextUtils.shortId;
  const isKnownRuntimeDisconnectError =
    typeof window.NCDebugForwarder?.isKnownRuntimeDisconnectError === "function"
      ? (message) => window.NCDebugForwarder.isKnownRuntimeDisconnectError(message)
      : () => false;
  NCTalkDomI18n.translatePage(i18n, { titleKey: "sharing_attachment_prompt_title" });

  const params = new URLSearchParams(window.location.search);
  const promptId = String(params.get("promptId") || "").trim();
  const totalBytes = Math.max(0, Number(params.get("totalBytes") || 0) || 0);
  const thresholdMb = Math.max(1, Number(params.get("thresholdMb") || 0) || 1);
  const lastName = String(params.get("lastName") || "").trim();
  const lastSizeBytes = Math.max(0, Number(params.get("lastSizeBytes") || 0) || 0);

  const reasonText = document.getElementById("reasonText");
  const shareBtn = document.getElementById("shareBtn");
  const removeLastBtn = document.getElementById("removeLastBtn");

  let resolved = false;
  let isPageUnloading = false;
  let debugEnabled = false;
  let disposeDebugFlagMirror = null;
  const emitDebugLog = typeof window.NCDebugForwarder?.createUiDebugLogger === "function"
    ? window.NCDebugForwarder.createUiDebugLogger({
      source: LOG_SOURCE,
      channel: LOG_CHANNEL,
      label: LOG_LABEL,
      getEnabled: () => debugEnabled,
      getIsPageUnloading: () => isPageUnloading,
      onError: logUiError
    })
    : () => {};
  shareBtn.disabled = true;
  removeLastBtn.disabled = true;
  void bootstrapPrompt();

  reasonText.textContent = i18n("sharing_attachment_prompt_reason", [
    NCTalkTextUtils.formatSizeMb(totalBytes),
    NCTalkTextUtils.formatSizeMb(thresholdMb * 1024 * 1024),
    lastName || i18n("sharing_attachment_prompt_last_unknown"),
    NCTalkTextUtils.formatSizeMb(lastSizeBytes)
  ]);

  window.addEventListener("pagehide", cleanupPromptResources, true);
  window.addEventListener("beforeunload", cleanupPromptResources, true);
  window.addEventListener("unload", cleanupPromptResources, true);

  /**
   * Resolve prompt decision and close popup window.
   * @param {"share"|"remove_last"|"dismiss"} decision
   * @returns {Promise<void>}
   */
  async function resolvePrompt(decision){
    if (resolved){
      return;
    }
    if (isPageUnloading && decision === "dismiss"){
      return;
    }
    resolved = true;
    try{
      await browser.runtime.sendMessage({
        type: "sharing:resolveAttachmentPrompt",
        payload: {
          promptId,
          decision
        }
      });
      debugLog("attachment prompt resolved", { decision, promptId: toShortId(promptId, 24) });
    }catch(error){
      const message = error?.message || String(error || "");
      if (!isPageUnloading && !isKnownRuntimeDisconnectError(message)){
        logUiError("resolve failed", error);
        debugLog("attachment prompt resolve failed", {
          decision,
          promptId: toShortId(promptId, 24),
          error: message
        });
      }
    }
    await closePromptWindow();
  }

  /**
   * Initialize debug logging before enabling prompt actions.
   * @returns {Promise<void>}
   */
  async function bootstrapPrompt(){
    await initDebugLogging();
    shareBtn.disabled = false;
    removeLastBtn.disabled = false;
    shareBtn?.addEventListener("click", () => {
      debugLog("attachment prompt action", { decision: "share", promptId: toShortId(promptId, 24) });
      resolvePrompt("share");
    });
    removeLastBtn?.addEventListener("click", () => {
      debugLog("attachment prompt action", { decision: "remove_last", promptId: toShortId(promptId, 24) });
      resolvePrompt("remove_last");
    });
  }

  /**
   * Load and live-mirror the debug flag for this prompt.
   * @returns {Promise<void>}
   */
  async function initDebugLogging(){
    disposeDebugFlagMirror?.();
    disposeDebugFlagMirror = null;
    if (typeof window.NCDebugForwarder?.installDebugEnabledMirror !== "function"){
      debugEnabled = false;
      return;
    }
    const control = await window.NCDebugForwarder.installDebugEnabledMirror({
      onChange: (enabled) => {
        debugEnabled = !!enabled;
      },
      onError: logUiError
    });
    disposeDebugFlagMirror = typeof control?.dispose === "function"
      ? () => control.dispose()
      : null;
    debugLog("attachment prompt init", {
      promptId: toShortId(promptId, 24),
      totalBytes,
      thresholdMb,
      hasLastName: !!lastName
    });
  }

  /**
   * Stop async runtime forwarding when popup context is unloading.
   */
  function cleanupPromptResources(){
    if (isPageUnloading){
      return;
    }
    window.NCDebugForwarder?.markRuntimeContextUnloading?.();
    isPageUnloading = true;
    disposeDebugFlagMirror?.();
    disposeDebugFlagMirror = null;
    debugEnabled = false;
    window.removeEventListener("pagehide", cleanupPromptResources, true);
    window.removeEventListener("beforeunload", cleanupPromptResources, true);
    window.removeEventListener("unload", cleanupPromptResources, true);
  }

  /**
   * Flush pending debug forwards and close the prompt window.
   * @returns {Promise<void>}
   */
  async function closePromptWindow(){
    window.NCDebugForwarder?.markRuntimeContextUnloading?.();
    cleanupPromptResources();
    try{
      await window.NCDebugForwarder?.flushPendingDebugLogs?.(120);
    }catch(error){
      logUiError("debug log flush failed", error);
    }
    window.close();
  }

  /**
   * Log internal UI errors with stable context.
   * @param {string} scope
   * @param {any} reportedError
   */
  function logUiError(scope, reportedError){
    try{
      console.error(LOG_PREFIX, scope, reportedError);
    }catch(error){
      console.error(LOG_PREFIX, scope, reportedError?.message || String(reportedError), error?.message || String(error));
    }
  }

  /**
   * Forward a structured debug line to the shared background-backed UI channel.
   * @param {string} text
   * @param {object|string|number|boolean|null} details
   */
  function debugLog(text, details = null){
    emitDebugLog(String(text || ""), ...(details == null ? [] : [details]));
  }

})();
