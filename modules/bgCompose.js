/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Compose runtime listener module.
 * Wires compose/window/tab listeners to helpers in bgCompose* modules.
 */

/**
 * Entry point for manual sharing from compose action button.
 */
browser.composeAction.onClicked.addListener(async (tab) => {
  try{
    L("composeAction.onClicked", { tabId: Number(tab?.id) || 0 });
    await openSharingWizardWindow(tab.id);
  }catch(e){
    console.error("[NCBG] composeAction.onClicked", e);
  }
});

/**
 * Compose attachment automation trigger.
 */
browser.compose.onAttachmentAdded.addListener((tab, attachment) => {
  handleComposeAttachmentAdded(tab, attachment).catch((error) => {
    console.error("[NCBG] compose.onAttachmentAdded failed", error);
  });
});

/**
 * Track live sender identity changes for queued password-follow-up dispatch.
 * onBeforeSend remains the authoritative final envelope capture.
 */
browser.compose.onIdentityChanged.addListener((tab, identityId) => {
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0 || !PASSWORD_MAIL_DISPATCH_BY_TAB.has(tabId)){
    return;
  }
  captureSeparatePasswordDispatchIdentityChange(tabId, identityId).catch((error) => {
    console.error("[NCBG] compose.onIdentityChanged capture failed", error);
  });
});

/**
 * Capture final recipients before send for queued password follow-up dispatch.
 */
browser.compose.onBeforeSend.addListener(async (tab, details) => {
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0){
    return {};
  }
  const hasPasswordDispatch = PASSWORD_MAIL_DISPATCH_BY_TAB.has(tabId);
  const hasShareCleanup = COMPOSE_SHARE_CLEANUP_BY_TAB.has(tabId);
  if (!hasPasswordDispatch && !hasShareCleanup){
    return {};
  }
  try{
    if (hasPasswordDispatch){
      await captureSeparatePasswordDispatchRecipients(tabId, details || {});
      const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
      const needsIdentityEnrichment = Array.isArray(queue) && queue.some((dispatch) => {
        return !String(dispatch?.identityId || "").trim()
          || !String(dispatch?.from || "").trim()
          || !String(dispatch?.fromEmail || "").trim();
      });
      if (needsIdentityEnrichment){
        await enrichSeparatePasswordDispatchSourceIdentity(tabId, queue);
      }
    }
    if (hasShareCleanup){
      setComposeShareCleanupSendPending(tabId, true, "before_send");
    }
  }catch(error){
    console.error("[NCBG] compose.onBeforeSend capture failed", error);
  }
  return {};
});

/**
 * Dispatch password-only follow-up mail after successful primary send.
 */
browser.compose.onAfterSend.addListener((tab, details) => {
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0){
    return;
  }
  const hasPasswordDispatch = PASSWORD_MAIL_DISPATCH_BY_TAB.has(tabId);
  const hasShareCleanup = COMPOSE_SHARE_CLEANUP_BY_TAB.has(tabId);
  if (!hasPasswordDispatch && !hasShareCleanup){
    return;
  }
  const mode = String(details?.mode || "");
  const error = String(details?.error || "");
  const headerMessageId = String(details?.headerMessageId || "").trim();
  const sendSucceeded = !error
    && (mode === "sendNow" || mode === "sendLater")
    && !!headerMessageId;
  if (hasShareCleanup){
    if (sendSucceeded){
      clearComposeShareCleanup(tabId, "after_send_success");
    }else{
      setComposeShareCleanupSendPending(tabId, false, "after_send_not_success");
      L("compose onAfterSend without successful send, share cleanup kept", {
        tabId,
        mode,
        hasError: !!error,
        hasHeaderMessageId: !!headerMessageId
      });
    }
  }
  if (!hasPasswordDispatch){
    return;
  }
  if (!sendSucceeded){
    L("compose onAfterSend without successful send, password dispatch kept", {
      tabId,
      mode,
      hasError: !!error,
      hasHeaderMessageId: !!headerMessageId
    });
    return;
  }
  (async () => {
    const dispatchQueue = takeSeparatePasswordDispatch(tabId, "after_send_start");
    if (!dispatchQueue.length){
      L("compose onAfterSend password dispatch skipped: queue missing", { tabId });
      return;
    }
    try{
      const needsIdentityEnrichment = dispatchQueue.some((dispatch) => {
        return !String(dispatch?.identityId || "").trim()
          || !String(dispatch?.from || "").trim()
          || !String(dispatch?.fromEmail || "").trim();
      });
      if (needsIdentityEnrichment){
        await enrichSeparatePasswordDispatchSourceIdentity(tabId, dispatchQueue);
      }
      L("compose onAfterSend password dispatch trigger", {
        tabId,
        mode,
        messageId: headerMessageId
      });
      await sendSeparatePasswordMail(tabId, dispatchQueue);
    }catch(error){
      const recipientCount = countUniquePasswordDispatchRecipients(dispatchQueue);
      console.error("[NCBG] compose.onAfterSend password dispatch failed", error);
      L("compose onAfterSend password dispatch failed", {
        tabId,
        error: error?.message || String(error),
        recipients: recipientCount
      });
      await showPasswordMailFailureNotification(recipientCount);
    }
  })().catch((error) => {
    console.error("[NCBG] compose.onAfterSend password dispatch failed", error);
  });
});

/**
 * Resolve pending attachment prompt when the prompt popup closes externally.
 */
browser.windows.onRemoved.addListener((windowId) => {
  const promptId = ATTACHMENT_PROMPT_BY_WINDOW.get(windowId);
  if (promptId){
    L("compose attachment prompt window removed", {
      windowId,
      promptId: bgShortId(promptId, 24)
    });
    resolveAttachmentPrompt(promptId, "dismiss", "prompt_window_closed");
  }
  if (SHARING_WIZARD_CLEANUP_BY_WINDOW.has(windowId)){
    void deleteSharingWizardRemoteCleanupNow(windowId, "wizard_window_removed").catch((error) => {
      console.error("[NCBG] sharing wizard cleanup delete execution failed", {
        windowId,
        error: error?.message || String(error)
      });
    });
  }
});

/**
 * Clear compose-tab scoped runtime state on tab close.
 */
browser.tabs.onRemoved.addListener((tabId) => {
  L("compose tab removed", { tabId });
  cleanupComposeAttachmentTabState(tabId, "tab_removed");
  clearSeparatePasswordDispatch(tabId, "tab_removed");
  const cleanupEntry = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (cleanupEntry){
    const delayMs = cleanupEntry.sendPending ? COMPOSE_SHARE_CLEANUP_SEND_GRACE_MS : 0;
    const reason = cleanupEntry.sendPending
      ? "tab_removed_send_pending"
      : "tab_removed_without_send";
    scheduleComposeShareCleanupDelete(tabId, reason, delayMs);
  }
});
