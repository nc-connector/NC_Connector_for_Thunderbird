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

const SAVED_DRAFT_PASSWORD_HANDOFF_BY_TAB = new Map();
const COMPOSE_SHARE_SAVE_TASK_BY_TAB = new Map();
const COMPOSE_DRAFT_REHYDRATE_DELAYS_MS = [100, 350, 900];

async function showComposeShareBlockedNotification(messageKey = "sharing_error_insert_failed"){
  try{
    await browser.notifications.create(
      `nc-compose-share-blocked-${Date.now()}`,
      {
        type: "basic",
        title: bgI18n("extName"),
        message: bgI18n(messageKey),
        iconUrl: browser.runtime.getURL("icons/app-32.png")
      }
    );
  }catch(error){
    console.error("[NCBG] compose share blocked notification failed", error);
  }
}

function composeShareBlockedMessageKey(reason){
  if (reason === "share_template_unsupported"){
    return "sharing_saved_template_unsupported";
  }
  if (reason === "password_handoff_incomplete"){
    return "sharing_password_handoff_incomplete";
  }
  return "sharing_saved_draft_state_unavailable";
}

async function validateComposeShareStateForSend(tabId, details = {}){
  const composeType = String(details?.type || "");
  const markerHeaders = normalizeComposeCustomHeaders(details?.customHeaders)
    .filter((header) => {
      return header.name.toLowerCase() === COMPOSE_SHARE_DRAFT_HEADER.toLowerCase();
    });
  const draftIds = [...new Set(getComposeShareDraftIds(details?.customHeaders))];
  let state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) || null;
  const persistedByDraftId = new Map();
  if (draftIds.length){
    await PERSISTED_SHARE_CLEANUP_READY;
    try{
      assertPersistentShareCleanupStoreAvailable();
    }catch(error){
      console.error("[NCBG] compose share lifecycle store unavailable", {
        tabId,
        error: error?.message || String(error)
      });
      return { ok: false, reason: "share_lifecycle_store_unavailable" };
    }
    for (const draftGroupId of draftIds){
      persistedByDraftId.set(
        draftGroupId,
        getPersistentShareCleanupGroup(draftGroupId)
      );
    }
    if (draftIds.some((draftGroupId) => {
      const persisted = persistedByDraftId.get(draftGroupId);
      return persisted?.templateUnsupported === true
        || persisted?.lifecycleTainted === true;
    })){
      const templateUnsupported = draftIds.some((draftGroupId) => {
        return persistedByDraftId.get(draftGroupId)?.templateUnsupported === true;
      });
      return {
        ok: false,
        reason: templateUnsupported
          ? "share_template_unsupported"
          : "share_lifecycle_tainted"
      };
    }
    const stateDraftGroupId = String(state?.draftGroupId || "").trim();
    if (stateDraftGroupId && draftIds.includes(stateDraftGroupId)){
      const persisted = persistedByDraftId.get(stateDraftGroupId);
      const savedStateMatches = state.saved === true
        && persisted?.state === "saved"
        && persisted?.saved === true;
      const activeStateMatches = state.saved !== true
        && persisted?.state === "active"
        && persisted?.saved !== true;
      const sendPendingStateMatches = state.sendPending === true
        && persisted?.state === "send_pending"
        && persisted?.saved === (state.saved === true);
      if (persisted?.ownerKind !== "compose"
        || (!savedStateMatches
          && !activeStateMatches
          && !sendPendingStateMatches)){
        return { ok: false, reason: "draft_cleanup_record_inconsistent" };
      }
    }
    if (!state
      && composeType !== "draft"
      && [...persistedByDraftId.values()].some(Boolean)){
      return {
        ok: false,
        reason: "draft_cleanup_record_not_rehydratable"
      };
    }
  }
  if (!state && composeType === "draft" && draftIds.length === 1){
    const rehydrated = await rehydrateComposeShareCleanup(tabId, details);
    if (rehydrated.ok){
      state = rehydrated.state;
    }else{
      return rehydrated;
    }
  }
  if (!state && markerHeaders.length){
    if (composeType === "draft"){
      return { ok: false, reason: "draft_cleanup_record_missing" };
    }
    const inheritedMessageMarker = ["reply", "forward", "redirect"].includes(
      composeType
    ) || (composeType === "new"
      && Number.isInteger(Number(details?.relatedMessageId))
      && Number(details.relatedMessageId) > 0);
    if (!inheritedMessageMarker || composeType === "template"){
      return { ok: false, reason: "draft_cleanup_record_missing" };
    }
    try{
      await browser.compose.setComposeDetails(tabId, {
        customHeaders: removeComposeShareDraftHeaders(details?.customHeaders)
      });
    }catch(error){
      L("foreign compose share marker could not be removed", {
        tabId,
        composeType,
        error: error?.message || String(error)
      });
      return { ok: false, reason: "foreign_draft_marker_remove_failed" };
    }
    return { ok: true, state: null, foreignMarkerIgnored: true };
  }
  if (!state){
    return { ok: true, state: null };
  }
  if (composeType === "template"){
    return { ok: false, reason: "share_template_unsupported" };
  }
  if (state.templateUnsupported === true){
    return { ok: false, reason: "share_template_unsupported" };
  }
  if (state.lifecycleTainted === true){
    return { ok: false, reason: "share_lifecycle_tainted" };
  }
  if (draftIds.length !== 1 || draftIds[0] !== state.draftGroupId){
    return { ok: false, reason: "draft_cleanup_marker_mismatch" };
  }
  const liveUnsavedPasswordDispatch = PASSWORD_MAIL_DISPATCH_BY_TAB.has(tabId)
    && (state.saved !== true || state.savePendingChanges === true);
  if (state.passwordHandoffRequired === true
    && state.passwordHandoffComplete !== true
    && !liveUnsavedPasswordDispatch){
    return { ok: false, reason: "password_handoff_incomplete" };
  }
  return { ok: true, state };
}

function passwordDispatchQueueEntryKey(dispatch){
  return String(
    dispatch?.registrationId
      || dispatch?.dedupKey
      || passwordDispatchRegistrationKey(dispatch)
      || ""
  ).trim();
}

function retainFailedSavedDraftPasswordDispatches(
  tabId,
  sourceQueue,
  failedQueue
){
  const processedKeys = new Set(
    sourceQueue.map(passwordDispatchQueueEntryKey).filter(Boolean)
  );
  const current = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
  const unprocessed = (Array.isArray(current) ? current : []).filter((dispatch) => {
    const key = passwordDispatchQueueEntryKey(dispatch);
    return !key || !processedKeys.has(key);
  });
  const remaining = unprocessed.concat(
    Array.isArray(failedQueue) ? failedQueue : []
  );
  if (remaining.length){
    PASSWORD_MAIL_DISPATCH_BY_TAB.set(tabId, remaining);
  }else{
    PASSWORD_MAIL_DISPATCH_BY_TAB.delete(tabId);
  }
  return remaining;
}

async function handoffSavedDraftPasswordDispatch(tabId, options = {}){
  if (SAVED_DRAFT_PASSWORD_HANDOFF_BY_TAB.has(tabId)){
    return SAVED_DRAFT_PASSWORD_HANDOFF_BY_TAB.get(tabId);
  }
  const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
  if (!Array.isArray(queue) || !queue.length){
    return null;
  }
  const completion = (async () => {
    if (options.tabClosed === true){
      if (queue.some((dispatch) => dispatch?.savedDraftEnvelopeCaptured !== true)){
        await setComposeSharePasswordHandoffState(
          tabId,
          true,
          false,
          "saved_draft_envelope_missing_after_close"
        );
        throw new Error("saved_draft_password_envelope_not_captured");
      }
    }else{
      try{
        const details = await browser.compose.getComposeDetails(tabId);
        await captureSeparatePasswordDispatchRecipients(tabId, details || {});
        await enrichSeparatePasswordDispatchSourceIdentity(tabId, queue);
        for (const dispatch of queue){
          dispatch.savedDraftEnvelopeCaptured = true;
        }
      }catch(error){
        await setComposeSharePasswordHandoffState(
          tabId,
          true,
          false,
          "saved_draft_envelope_refresh_failed"
        );
        throw error;
      }
    }
    const pending = queue.slice();
    let dispatchQueue;
    try{
      dispatchQueue = await expandSeparatePasswordDispatchQueue(pending);
    }catch(error){
      await setComposeSharePasswordHandoffState(
        tabId,
        true,
        false,
        "saved_draft_expand_failed"
      );
      throw error;
    }
    const recipientCount = countUniquePasswordDispatchRecipients(dispatchQueue);
    const fallback = await openManualPasswordFallbackQueue(
      tabId,
      dispatchQueue,
      0,
      "primary_saved_draft"
    );
    const remaining = retainFailedSavedDraftPasswordDispatches(
      tabId,
      pending,
      fallback.failedQueue
    );
    await setComposeSharePasswordHandoffState(
      tabId,
      true,
      remaining.length === 0,
      remaining.length ? "saved_draft_handoff_incomplete" : "saved_draft_handoff_complete"
    );
    if (fallback.opened > 0){
      await showPasswordMailManualRequiredNotification(
        recipientCount || dispatchQueue.length,
        { requireSenderSelection: fallback.needsSender > 0 }
      );
    }
    if (fallback.failed > 0){
      await showPasswordMailFailureNotification(
        recipientCount || dispatchQueue.length
      );
    }
    return fallback;
  })().finally(() => {
    SAVED_DRAFT_PASSWORD_HANDOFF_BY_TAB.delete(tabId);
  });
  SAVED_DRAFT_PASSWORD_HANDOFF_BY_TAB.set(tabId, completion);
  return completion;
}

async function rehydrateComposeShareDraftTab(tab){
  const tabId = Number(tab?.id);
  if (String(tab?.type || "") !== "messageCompose"
    || !Number.isInteger(tabId)
    || tabId <= 0){
    return;
  }
  for (const delayMs of COMPOSE_DRAFT_REHYDRATE_DELAYS_MS){
    await waitMs(delayMs);
    try{
      const details = await browser.compose.getComposeDetails(tabId);
      if (String(details?.type || "") !== "draft"){
        return;
      }
      if (getComposeShareDraftIds(details?.customHeaders).length === 1){
        await rehydrateComposeShareCleanup(tabId, details);
      }
      return;
    }catch(error){
      const message = error?.message || String(error);
      if (/invalid tab id|no tab with id/i.test(message)){
        return;
      }
      if (delayMs === COMPOSE_DRAFT_REHYDRATE_DELAYS_MS.at(-1)){
        console.error("[NCBG] compose share draft rehydrate failed", {
          tabId,
          error: message
        });
      }
    }
  }
}

/**
 * Entry point for manual sharing from compose action button.
 */
browser.composeAction.onClicked.addListener(async (tab) => {
  try{
    L("composeAction.onClicked", { tabId: Number(tab?.id) || 0 });
    await openSharingWizardWindow(tab.id);
  }catch(error){
    console.error("[NCBG] composeAction.onClicked", error);
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
 * onBeforeSend captures the final envelope.
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
  if (isComposeFinalizeTransactionActive(tabId)){
    void showComposeShareBlockedNotification();
    return { cancel: true };
  }
  const shareState = await validateComposeShareStateForSend(tabId, details || {});
  if (!shareState.ok){
    console.error("[NCBG] compose send blocked by share lifecycle", {
      tabId,
      reason: shareState.reason || ""
    });
    void showComposeShareBlockedNotification(
      composeShareBlockedMessageKey(shareState.reason)
    );
    return { cancel: true };
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
      await setComposeShareCleanupSendPending(tabId, true, "before_send");
    }
  }catch(error){
    globalThis.NCLogContext?.safeConsoleError?.(
      "[NCBG]",
      "compose.onBeforeSend capture failed",
      error,
      { tabId, hasPasswordDispatch }
    );
    if (hasShareCleanup){
      try{
        await setComposeShareCleanupSendPending(
          tabId,
          false,
          "before_send_capture_failed"
        );
      }catch(resetError){
        console.error("[NCBG] compose send-pending rollback failed", {
          tabId,
          error: resetError?.message || String(resetError)
        });
      }
    }
    if (hasPasswordDispatch || hasShareCleanup){
      void showComposeShareBlockedNotification();
      return { cancel: true };
    }
  }
  return {};
});

/**
 * Dispatch password-only follow-up mail after successful primary send.
 */
browser.compose.onAfterSend.addListener(async (tab, details) => {
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
  const sendNowSucceeded = !error && mode === "sendNow";
  // Thunderbird queues sendLater messages without a headerMessageId. The
  // queued primary mail owns its share, but its password mail stays manual
  // because no API event confirms the later Outbox delivery.
  const sendLaterQueued = !error && mode === "sendLater";
  const primaryMailCommitted = sendNowSucceeded || sendLaterQueued;
  if (hasShareCleanup){
    if (primaryMailCommitted){
      try{
        await commitComposeShareCleanup(tabId, "after_send_success");
      }catch(error){
        const cleanupState = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
        if (cleanupState){
          cleanupState.saved = true;
        }
        console.error("[NCBG] compose share cleanup commit failed", {
          tabId,
          error: error?.message || String(error)
        });
      }
    }else{
      let sendPendingCleared = false;
      try{
        sendPendingCleared = await setComposeShareCleanupSendPending(
          tabId,
          false,
          "after_send_not_success"
        );
      }catch(error){
        console.error("[NCBG] compose send-pending clear failed", {
          tabId,
          error: error?.message || String(error)
        });
      }
      const retainedState = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
      if (sendPendingCleared
        && retainedState?.saved
        && retainedState.tabClosed){
        detachSavedComposeShareCleanup(
          tabId,
          "closed_saved_draft_send_not_confirmed"
        );
      }
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
  if (!primaryMailCommitted){
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
      if (sendLaterQueued){
        await stageSeparatePasswordMailForSendLater(tabId, dispatchQueue);
        return;
      }
      await sendSeparatePasswordMail(tabId, dispatchQueue, mode);
    }catch(error){
      const recipientCount = countUniquePasswordDispatchRecipients(dispatchQueue);
      console.error("[NCBG] compose.onAfterSend password dispatch failed", error);
      L("compose onAfterSend password dispatch failed", {
        tabId,
        error: error?.message || String(error),
        recipients: recipientCount
      });
      const fallbackResult = await openManualPasswordFallbackQueue(
        tabId,
        dispatchQueue,
        0,
        sendLaterQueued ? "primary_send_later" : "dispatch_failed_after_primary_send"
      );
      if (fallbackResult.opened > 0){
        await showPasswordMailManualRequiredNotification(recipientCount || dispatchQueue.length, {
          requireSenderSelection: fallbackResult.needsSender > 0,
          primarySendLater: sendLaterQueued
        });
      }
      if (fallbackResult.failed > 0){
        await showPasswordMailFailureNotification(recipientCount || dispatchQueue.length);
      }
    }
  })().catch((error) => {
    console.error("[NCBG] compose.onAfterSend password dispatch failed", error);
  });
});

async function processComposeShareAfterSave(
  tabId,
  mode,
  saveInfo,
  finalizeSnapshot
){
  if (finalizeSnapshot?.active){
    if (!finalizeSnapshot.insertApplied){
      L("compose save ignored before finalize insertion", {
        tabId,
        mode
      });
      return;
    }
    const finalizeOutcome = await resolveComposeFinalizeSaveSnapshot(
      finalizeSnapshot
    );
    if (!finalizeOutcome.committed){
      L("compose save ignored after finalize rollback", {
        tabId,
        mode
      });
      return;
    }
  }
  let state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) || null;
  let details = null;
  if (!state){
    try{
      details = await browser.compose.getComposeDetails(tabId);
      const rehydrated = await rehydrateComposeShareCleanup(tabId, details);
      state = rehydrated.ok ? rehydrated.state : null;
    }catch(error){
      console.error("[NCBG] saved compose share state lookup failed", {
        tabId,
        error: error?.message || String(error)
      });
    }
  }
  if (!state){
    return;
  }
  if (!details){
    details = await browser.compose.getComposeDetails(tabId);
  }
  const savedDraftIds = [...new Set(
    getComposeShareDraftIds(details?.customHeaders)
  )];
  if (savedDraftIds.length !== 1
    || savedDraftIds[0] !== state.draftGroupId){
    L("compose save ignored because share marker is not current", {
      tabId,
      mode,
      markers: savedDraftIds.length
    });
    return;
  }
  const hasPasswordDispatchQueue = PASSWORD_MAIL_DISPATCH_BY_TAB.has(tabId);
  const passwordHandoffRequired = hasPasswordDispatchQueue
    || state.passwordHandoffRequired === true;
  const passwordHandoffComplete = hasPasswordDispatchQueue
    ? false
    : (state.passwordHandoffRequired !== true
      || state.passwordHandoffComplete === true);
  await markComposeShareCleanupSaved(
    tabId,
    saveInfo,
    {
      passwordHandoffRequired,
      passwordHandoffComplete,
      templateUnsupported: mode === "template"
    }
  );
  await handoffSavedDraftPasswordDispatch(tabId);
  state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) || null;
  if (state?.passwordHandoffRequired === true
    && state.passwordHandoffComplete !== true){
    await showComposeShareBlockedNotification(
      "sharing_password_handoff_incomplete"
    );
  }
  if (mode === "template"){
    await showComposeShareBlockedNotification(
      "sharing_saved_template_unsupported"
    );
  }
}

function queueComposeShareAfterSave(
  tabId,
  mode,
  saveInfo,
  finalizeSnapshot
){
  const previous = COMPOSE_SHARE_SAVE_TASK_BY_TAB.get(tabId)
    || Promise.resolve();
  const completion = previous
    .catch(() => {})
    .then(() => processComposeShareAfterSave(
      tabId,
      mode,
      saveInfo,
      finalizeSnapshot
    ))
    .catch(async (error) => {
      const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
      if (state){
        // Thunderbird confirmed the save, but durable lifecycle state did not.
        // Never schedule deletion for this uncertain outcome.
        state.saveOutcomeUncertain = true;
        try{
          await markPersistentShareCleanupExhausted(state.draftGroupId);
        }catch(persistError){
          console.error("[NCBG] saved compose retention persistence failed", {
            tabId,
            error: persistError?.message || String(persistError)
          });
        }
      }
      console.error("[NCBG] compose.onAfterSave share lifecycle failed", {
        tabId,
        mode,
        error: error?.message || String(error)
      });
      await showComposeShareBlockedNotification();
    });
  COMPOSE_SHARE_SAVE_TASK_BY_TAB.set(tabId, completion);
  void completion.finally(() => {
    if (COMPOSE_SHARE_SAVE_TASK_BY_TAB.get(tabId) === completion){
      COMPOSE_SHARE_SAVE_TASK_BY_TAB.delete(tabId);
    }
  });
  return completion;
}

browser.compose.onAfterSave.addListener((tab, saveInfo) => {
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0 || saveInfo?.error){
    return;
  }
  const mode = String(saveInfo?.mode || "");
  if (!["draft", "autoSave", "template"].includes(mode)){
    return;
  }
  queueComposeShareAfterSave(
    tabId,
    mode,
    saveInfo,
    captureComposeFinalizeSaveSnapshot(tabId)
  );
});

/**
 * Resolve pending attachment prompt when the prompt popup closes externally.
 */
async function handleComposeWindowRemoved(windowId){
  if (COMPOSE_FINALIZE_BY_WIZARD_WINDOW.has(windowId)){
    await rollbackComposeFinalizeForWizardWindow(
      windowId,
      "wizard_window_removed_during_finalize"
    );
  }
  const promptId = ATTACHMENT_PROMPT_BY_WINDOW.get(windowId);
  if (promptId){
    L("compose attachment prompt window removed", {
      windowId,
      promptId: bgShortId(promptId, 24)
    });
    resolveAttachmentPrompt(promptId, "dismiss", "prompt_window_closed");
  }
  if (SHARING_WIZARD_CLEANUP_BY_WINDOW.has(windowId)){
    const cleanupId = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId)?.cleanupId || "";
    try{
      await markPersistentShareCleanupPending(
        cleanupId,
        "wizard_window_removed",
        { schedule: false, resetAttempts: false }
      );
    }catch(error){
      console.error("[NCBG] wizard cleanup pending persistence failed", {
        windowId,
        error: error?.message || String(error)
      });
    }
    const removed = await deleteSharingWizardRemoteCleanupNow(
      windowId,
      "wizard_window_removed",
      cleanupId
    );
    if (!removed){
      scheduleSharingWizardRemoteCleanupRetry(
        windowId,
        cleanupId,
        "wizard_window_removed_retry"
      );
    }
  }
}

browser.windows.onRemoved.addListener((windowId) => {
  void handleComposeWindowRemoved(windowId).catch((error) => {
    console.error("[NCBG] compose window removal cleanup failed", {
      windowId,
      error: error?.message || String(error)
    });
  });
});

browser.tabs.onCreated.addListener((tab) => {
  void rehydrateComposeShareDraftTab(tab);
});

/**
 * Clear compose-tab scoped runtime state on tab close.
 */
function scheduleSavedSendPendingDetach(tabId, state){
  if (!state || COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) !== state){
    return false;
  }
  if (state.timerId){
    clearTimeout(state.timerId);
  }
  state.timerId = setTimeout(() => {
    const current = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
    if (current !== state || !current.saved || !current.sendPending){
      return;
    }
    current.timerId = null;
    current.sendPending = false;
    detachSavedComposeShareCleanup(
      tabId,
      "saved_send_pending_confirmation_timeout"
    );
    L("saved compose send outcome unconfirmed; share retained", {
      tabId,
      draftGroupId: bgShortId(current.draftGroupId, 24)
    });
  }, COMPOSE_SHARE_CLEANUP_SEND_GRACE_MS);
  return true;
}

async function handleComposeTabRemoved(tabId){
  L("compose tab removed", { tabId });
  if (COMPOSE_FINALIZE_BY_TAB.has(tabId)){
    await rollbackComposeFinalizeForTab(tabId, "tab_removed_during_finalize");
  }
  const saveTask = COMPOSE_SHARE_SAVE_TASK_BY_TAB.get(tabId);
  if (saveTask){
    await saveTask;
  }
  cleanupComposeAttachmentTabState(tabId, "tab_removed");
  let cleanupEntry = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (cleanupEntry?.saved || cleanupEntry?.saveOutcomeUncertain){
    cleanupEntry.tabClosed = true;
    if (cleanupEntry.saved && cleanupEntry.sendPending){
      scheduleSavedSendPendingDetach(tabId, cleanupEntry);
      return;
    }
    if (cleanupEntry.saved && cleanupEntry.savePendingChanges === true){
      clearSeparatePasswordDispatch(
        tabId,
        "saved_draft_unsaved_share_changes"
      );
      detachRetainedComposeShareCleanup(
        tabId,
        "saved_draft_unsaved_share_changes"
      );
      return;
    }
    await handoffSavedDraftPasswordDispatch(tabId, { tabClosed: true });
    cleanupEntry = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
    if (!cleanupEntry
      || (!cleanupEntry.saved && !cleanupEntry.saveOutcomeUncertain)){
      return;
    }
    detachRetainedComposeShareCleanup(tabId, "saved_draft_tab_removed");
    return;
  }
  const sendPending = !!cleanupEntry?.sendPending;
  if (sendPending){
    // TB 153 Daily can remove the compose tab before the final successful onAfterSend arrives.
    scheduleSeparatePasswordDispatchClear(tabId, "tab_removed_send_pending", COMPOSE_SHARE_CLEANUP_SEND_GRACE_MS);
  }else{
    clearSeparatePasswordDispatch(tabId, "tab_removed");
  }
  if (cleanupEntry){
    const delayMs = sendPending ? COMPOSE_SHARE_CLEANUP_SEND_GRACE_MS : 0;
    const reason = sendPending
      ? "tab_removed_send_pending"
      : "tab_removed_without_send";
    scheduleComposeShareCleanupDelete(tabId, reason, delayMs);
  }
}

browser.tabs.onRemoved.addListener((tabId) => {
  void handleComposeTabRemoved(tabId).catch((error) => {
    console.error("[NCBG] compose tab removal cleanup failed", {
      tabId,
      error: error?.message || String(error)
    });
  });
});
