/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
(function(){
  const LOG_SOURCE = "composeAttachmentPrompt";
  const LOG_CHANNEL = "NCUI";
  const LOG_LABEL = "Sharing";
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
  debugLog("attachment prompt init", {
    promptId: toShortId(promptId, 24),
    totalBytes,
    thresholdMb,
    hasLastName: !!lastName
  });

  reasonText.textContent = i18n("sharing_attachment_prompt_reason", [
    NCTalkTextUtils.formatSizeMb(totalBytes),
    NCTalkTextUtils.formatSizeMb(thresholdMb * 1024 * 1024),
    lastName || i18n("sharing_attachment_prompt_last_unknown"),
    NCTalkTextUtils.formatSizeMb(lastSizeBytes)
  ]);

  shareBtn?.addEventListener("click", () => {
    debugLog("attachment prompt action", { decision: "share", promptId: toShortId(promptId, 24) });
    resolvePrompt("share");
  });
  removeLastBtn?.addEventListener("click", () => {
    debugLog("attachment prompt action", { decision: "remove_last", promptId: toShortId(promptId, 24) });
    resolvePrompt("remove_last");
  });
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
        console.error("[NCSHARE][Prompt] resolve failed", error);
        debugLog("attachment prompt resolve failed", {
          decision,
          promptId: toShortId(promptId, 24),
          error: message
        });
      }
    }
    window.close();
  }

  /**
   * Stop async runtime forwarding when popup context is unloading.
   */
  function cleanupPromptResources(){
    if (isPageUnloading){
      return;
    }
    isPageUnloading = true;
    window.removeEventListener("pagehide", cleanupPromptResources, true);
    window.removeEventListener("beforeunload", cleanupPromptResources, true);
    window.removeEventListener("unload", cleanupPromptResources, true);
  }

  /**
   * Forward a structured debug line to background logger.
   * @param {string} text
   * @param {object|string|number|boolean|null} details
   */
  function debugLog(text, details = null){
    if (isPageUnloading){
      return;
    }
    const forwardDebugLog = window.NCDebugForwarder?.forwardDebugLog;
    if (typeof forwardDebugLog !== "function"){
      return;
    }
    forwardDebugLog({
      enabled: true,
      isPageUnloading,
      source: LOG_SOURCE,
      channel: LOG_CHANNEL,
      label: LOG_LABEL,
      text: String(text || ""),
      details: details == null ? [] : [details],
      onError: (scope, error) => {
        if (isPageUnloading){
          return;
        }
        console.error("[NCUI][AttachmentPrompt]", scope, error);
      }
    });
  }

})();
