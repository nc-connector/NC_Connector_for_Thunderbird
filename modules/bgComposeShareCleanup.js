/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Compose share-cleanup runtime module.
 * Owns compose-tab and sharing-wizard remote cleanup lifecycle.
 */

const SHARING_WIZARD_CLEANUP_RETRY_DELAYS_MS = Object.freeze([
  2000,
  5000,
  10000,
  30000,
  60000
]);

function normalizeComposeShareCleanupFolderInfo(folderInfo){
  if (!folderInfo || typeof folderInfo !== "object"){
    return null;
  }
  const relativeFolder = typeof folderInfo.relativeFolder === "string"
    ? folderInfo.relativeFolder.trim().replace(/^\/+|\/+$/g, "")
    : "";
  if (!relativeFolder){
    return null;
  }
  const normalized = { relativeFolder };
  if (typeof folderInfo.relativeBase === "string"){
    const relativeBase = folderInfo.relativeBase.trim().replace(/^\/+|\/+$/g, "");
    if (relativeBase){
      normalized.relativeBase = relativeBase;
    }
  }
  if (typeof folderInfo.folderName === "string"){
    const folderName = folderInfo.folderName.trim();
    if (folderName){
      normalized.folderName = folderName;
    }
  }
  return Object.freeze(normalized);
}

function composeShareCleanupEntryKey(entry){
  const shareUrl = String(entry?.shareUrl || "").trim();
  const shareId = String(entry?.shareId || "").trim();
  if (shareUrl || shareId){
    return `share:${shareUrl}|${shareId}`;
  }
  const cleanupUrl = String(entry?.cleanupTarget?.url || "").trim();
  if (cleanupUrl){
    return `target:${cleanupUrl}`;
  }
  const relativeFolder = String(entry?.folderInfo?.relativeFolder || "").trim();
  return relativeFolder ? `folder:${relativeFolder}` : "";
}

function createShareCleanupId(){
  return createSecureRuntimeId();
}

function normalizeShareCleanupTarget(cleanupTarget){
  if (!cleanupTarget || typeof cleanupTarget !== "object"){
    return null;
  }
  const url = String(cleanupTarget.url || "").trim();
  const authHeader = String(cleanupTarget.authHeader || "").trim();
  const reservationUrl = String(cleanupTarget.reservationUrl || "").trim();
  const targetUrl = String(cleanupTarget.targetUrl || "").trim();
  if (!url || !authHeader){
    return null;
  }
  try{
    for (const candidateUrl of [url, reservationUrl, targetUrl].filter(Boolean)){
      const parsed = new URL(candidateUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:"){
        return null;
      }
    }
  }catch(error){
    return null;
  }
  const hasReservationResolution = !!(reservationUrl && targetUrl);
  if ((reservationUrl || targetUrl) && !hasReservationResolution){
    return null;
  }
  return Object.freeze({
    url,
    authHeader,
    baseUrl: String(cleanupTarget.baseUrl || "").trim(),
    relativeFolder: String(cleanupTarget.relativeFolder || "").trim(),
    reservationUrl: hasReservationResolution ? reservationUrl : "",
    targetUrl: hasReservationResolution ? targetUrl : ""
  });
}

async function deleteShareCleanupEntry(entry, groupId = ""){
  const descriptor = entry?.cleanupDescriptor
    || createPersistedShareCleanupDescriptor(entry);
  if (descriptor){
    await deletePersistedShareCleanupDescriptor(descriptor);
    if (groupId){
      await removePersistentShareCleanupDescriptor(groupId, descriptor);
    }
    return;
  }
  if (entry?.cleanupTarget){
    throw new Error("share_cleanup_descriptor_invalid");
  }
  await NCSharing.deleteShareFolder({ folderInfo: entry?.folderInfo });
}

function clearSharingWizardRemoteCleanup(windowId, reason = "", expectedEntry = null){
  const entry = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId);
  if (!entry){
    return false;
  }
  if (expectedEntry && entry !== expectedEntry){
    return false;
  }
  if (entry.retryTimerId){
    clearTimeout(entry.retryTimerId);
    entry.retryTimerId = null;
  }
  SHARING_WIZARD_CLEANUP_BY_WINDOW.delete(windowId);
  L("sharing wizard cleanup cleared", {
    windowId,
    reason: reason || "",
    relativeFolder: entry.folderInfo?.relativeFolder || "",
    shareId: entry.shareId || "",
    shareLabel: entry.shareLabel || ""
  });
  return true;
}

/**
 * Arm a sharing-wizard remote cleanup entry for the wizard popup window.
 * If the popup closes without explicit clear, server-side folder cleanup runs.
 * @param {number} windowId
 * @param {{folderInfo?:object,shareId?:string,shareLabel?:string,shareUrl?:string,tabId?:number}} payload
 */
async function armSharingWizardRemoteCleanup(windowId, payload = {}){
  if (!Number.isInteger(windowId) || windowId <= 0){
    throw new Error("invalid_window_id");
  }
  const folderInfo = normalizeComposeShareCleanupFolderInfo(payload.folderInfo);
  if (!folderInfo){
    throw new Error("folder_info_missing");
  }
  while (SHARING_WIZARD_CLEANUP_BY_WINDOW.has(windowId)){
    const previous = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId);
    const removed = await deleteSharingWizardRemoteCleanupNow(
      windowId,
      "replaced",
      previous.cleanupId
    );
    if (!removed && SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId) === previous){
      throw new Error("previous_cleanup_failed");
    }
  }
  const entry = {
    cleanupId: createShareCleanupId(),
    windowId,
    tabId: Number.isInteger(Number(payload.tabId)) ? Number(payload.tabId) : 0,
    folderInfo,
    shareId: String(payload.shareId || "").trim(),
    shareLabel: String(payload.shareLabel || "").trim(),
    shareUrl: String(payload.shareUrl || "").trim(),
    cleanupTarget: normalizeShareCleanupTarget(payload.cleanupTarget),
    created: Date.now(),
    retryTimerId: null
  };
  entry.cleanupDescriptor = createPersistedShareCleanupDescriptor(entry);
  if (!entry.cleanupDescriptor){
    throw new Error("share_cleanup_descriptor_invalid");
  }
  await persistWizardShareCleanupGroup(entry);
  SHARING_WIZARD_CLEANUP_BY_WINDOW.set(windowId, entry);
  L("sharing wizard cleanup armed", {
    windowId,
    tabId: Number.isInteger(Number(payload.tabId)) ? Number(payload.tabId) : 0,
    relativeFolder: folderInfo.relativeFolder,
    shareId: String(payload.shareId || "").trim(),
    shareLabel: String(payload.shareLabel || "").trim()
  });
}

async function deleteSharingWizardRemoteCleanupNow(
  windowId,
  reason = "",
  expectedCleanupId = ""
){
  const entry = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId);
  if (!entry){
    return true;
  }
  if (expectedCleanupId && entry.cleanupId !== expectedCleanupId){
    return false;
  }
  try{
    await deleteShareCleanupEntry(entry, entry.cleanupId);
    L("sharing wizard cleanup delete done", {
      windowId,
      reason: reason || "",
      relativeFolder: entry.folderInfo?.relativeFolder || ""
    });
    return clearSharingWizardRemoteCleanup(
      windowId,
      reason || "cleanup_done",
      entry
    );
  }catch(error){
    console.error("[NCBG] sharing wizard cleanup delete failed", {
      windowId,
      reason: reason || "",
      relativeFolder: entry.folderInfo?.relativeFolder || "",
      error: error?.message || String(error)
    });
    return false;
  }
}

function scheduleSharingWizardRemoteCleanupRetry(
  windowId,
  cleanupId,
  reason = "",
  attempt = 0
){
  const entry = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId);
  if (!entry || entry.cleanupId !== cleanupId || entry.retryTimerId){
    return false;
  }
  const retryIndex = Math.max(0, Number(attempt) || 0);
  if (retryIndex >= SHARING_WIZARD_CLEANUP_RETRY_DELAYS_MS.length){
    console.error("[NCBG] sharing wizard cleanup retries exhausted", {
      windowId,
      reason: reason || ""
    });
    void markPersistentShareCleanupExhausted(entry.cleanupId);
    return false;
  }
  entry.retryTimerId = setTimeout(() => {
    const current = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId);
    if (!current || current.cleanupId !== cleanupId){
      return;
    }
    current.retryTimerId = null;
    void deleteSharingWizardRemoteCleanupNow(
      windowId,
      reason,
      cleanupId
    ).then((removed) => {
      if (!removed
        && SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId)?.cleanupId === cleanupId){
        scheduleSharingWizardRemoteCleanupRetry(
          windowId,
          cleanupId,
          reason,
          retryIndex + 1
        );
      }
    }).catch((error) => {
      console.error("[NCBG] sharing wizard cleanup retry failed", {
        windowId,
        reason: reason || "",
        error: error?.message || String(error)
      });
      if (SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId)?.cleanupId === cleanupId){
        scheduleSharingWizardRemoteCleanupRetry(
          windowId,
          cleanupId,
          reason,
          retryIndex + 1
        );
      }
    });
  }, SHARING_WIZARD_CLEANUP_RETRY_DELAYS_MS[retryIndex]);
  return true;
}

function clearComposeShareCleanup(tabId, reason = "", expectedEntry = null){
  const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!state){
    return false;
  }
  if (expectedEntry && state !== expectedEntry){
    return false;
  }
  if (state.timerId){
    try{
      clearTimeout(state.timerId);
    }catch(error){
      console.error("[NCBG] compose share cleanup timer clear failed", {
        tabId,
        error: error?.message || String(error)
      });
    }
    state.timerId = null;
  }
  COMPOSE_SHARE_CLEANUP_BY_TAB.delete(tabId);
  L("compose share cleanup cleared", {
    tabId,
    reason: reason || "",
    shares: Array.isArray(state.entries) ? state.entries.length : 0,
    sendPending: !!state.sendPending
  });
  return true;
}

/**
 * Add one share to the compose-tab cleanup state.
 * All tracked shares are cleared only after successful compose send.
 * @param {number} tabId
 * @param {{folderInfo?:object,shareId?:string,shareLabel?:string,shareUrl?:string}} payload
 */
async function armComposeShareCleanup(tabId, payload = {}, options = {}){
  if (!Number.isInteger(tabId) || tabId <= 0){
    throw new Error("invalid_tab_id");
  }
  const folderInfo = normalizeComposeShareCleanupFolderInfo(payload.folderInfo);
  if (!folderInfo){
    throw new Error("folder_info_missing");
  }
  const wizardWindowId = Number(payload.wizardWindowId);
  if (!Number.isInteger(wizardWindowId) || wizardWindowId <= 0){
    throw new Error("wizard_cleanup_window_missing");
  }
  let previous = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) || null;
  if (previous?.deleting && previous.deletePromise){
    try{
      await previous.deletePromise;
    }catch(error){
      throw new Error("previous_cleanup_failed");
    }
    previous = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) || null;
  }
  if (previous?.timerId || previous?.deleting){
    throw new Error("compose_cleanup_busy");
  }
  const wizardEntry = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(wizardWindowId);
  if (!wizardEntry
    || wizardEntry.tabId !== tabId
    || wizardEntry.folderInfo?.relativeFolder !== folderInfo.relativeFolder){
    throw new Error("wizard_cleanup_ownership_mismatch");
  }
  for (const field of ["shareId", "shareUrl"]){
    if (String(payload[field] || "").trim()
      !== String(wizardEntry[field] || "").trim()){
      throw new Error("wizard_cleanup_share_mismatch");
    }
  }
  const wizardDescriptor = wizardEntry.cleanupDescriptor
    || createPersistedShareCleanupDescriptor(wizardEntry);
  if (!wizardDescriptor){
    throw new Error("wizard_cleanup_descriptor_invalid");
  }
  const trackedShare = Object.freeze({
    folderInfo: wizardEntry.folderInfo,
    shareId: wizardEntry.shareId,
    shareLabel: wizardEntry.shareLabel,
    shareUrl: wizardEntry.shareUrl,
    cleanupTarget: wizardEntry.cleanupTarget,
    cleanupDescriptor: wizardDescriptor,
    created: Date.now()
  });
  const previousEntries = Array.isArray(previous?.entries)
    ? previous.entries.slice()
    : [];
  const trackedKey = composeShareCleanupEntryKey(trackedShare);
  const existingIndex = trackedKey
    ? previousEntries.findIndex((entry) => composeShareCleanupEntryKey(entry) === trackedKey)
    : -1;
  if (existingIndex >= 0){
    const existing = previousEntries[existingIndex];
    previousEntries[existingIndex] = Object.freeze({
      ...trackedShare,
      cleanupTarget: trackedShare.cleanupTarget || existing.cleanupTarget || null,
      cleanupDescriptor: trackedShare.cleanupDescriptor || existing.cleanupDescriptor || null,
      created: Number(existing.created) || trackedShare.created
    });
  }else{
    previousEntries.push(trackedShare);
  }
  const entries = previousEntries;
  const hasSavedBaseline = previous?.saved === true;
  const stagedState = {
    cleanupId: createShareCleanupId(),
    tabId,
    entries,
    draftGroupId: String(
      options.draftGroupId
      || payload.draftGroupId
      || previous?.draftGroupId
      || createShareCleanupId()
    ).trim(),
    saved: hasSavedBaseline,
    savePendingChanges: hasSavedBaseline,
    messageIds: hasSavedBaseline
      ? (Array.isArray(previous?.messageIds) ? previous.messageIds.slice() : [])
      : [],
    passwordHandoffRequired: previous?.passwordHandoffRequired === true,
    passwordHandoffComplete: previous?.passwordHandoffRequired !== true
      || previous?.passwordHandoffComplete === true,
    templateUnsupported: previous?.templateUnsupported === true,
    lifecycleTainted: previous?.lifecycleTainted === true,
    created: Date.now(),
    sendPending: false,
    timerId: null,
    deleting: false,
    deletePromise: null
  };
  if (!stagedState.draftGroupId){
    throw new Error("compose_share_draft_group_missing");
  }
  let persistenceTransition = null;
  if (options.persist !== false){
    persistenceTransition = await stagePersistentComposeCleanupGroup(
      wizardEntry?.cleanupId || "",
      stagedState.draftGroupId,
      entries
    );
  }
  COMPOSE_SHARE_CLEANUP_BY_TAB.set(tabId, stagedState);
  const wizardOwnershipTransferred = !!wizardEntry
    && options.transferWizardOwnership !== false;
  if (wizardOwnershipTransferred){
    clearSharingWizardRemoteCleanup(
      wizardWindowId,
      "ownership_transferred_to_compose",
      wizardEntry
    );
  }
  L("compose share cleanup armed", {
    tabId,
    relativeFolder: folderInfo.relativeFolder,
    shareId: String(payload.shareId || "").trim(),
    shareLabel: String(payload.shareLabel || "").trim(),
    shares: entries.length
  });
  return {
    mutationId: createShareCleanupId(),
    tabId,
    stagedState,
    previousState: previous,
    wizardWindowId: Number.isInteger(wizardWindowId) ? wizardWindowId : 0,
    wizardEntry,
    wizardOwnershipTransferred,
    persistenceTransition
  };
}

function completeComposeShareCleanupArm(mutation, reason = ""){
  if (!mutation?.wizardEntry || mutation.wizardOwnershipTransferred){
    return true;
  }
  const cleared = clearSharingWizardRemoteCleanup(
    mutation.wizardWindowId,
    reason || "ownership_transferred_to_compose",
    mutation.wizardEntry
  );
  if (cleared){
    mutation.wizardOwnershipTransferred = true;
  }
  return cleared;
}

function rollbackComposeShareCleanupArm(mutation, reason = ""){
  if (!mutation || COMPOSE_SHARE_CLEANUP_BY_TAB.get(mutation.tabId) !== mutation.stagedState){
    return false;
  }
  if (mutation.previousState){
    COMPOSE_SHARE_CLEANUP_BY_TAB.set(mutation.tabId, mutation.previousState);
  }else{
    COMPOSE_SHARE_CLEANUP_BY_TAB.delete(mutation.tabId);
  }
  if (mutation.wizardOwnershipTransferred
    && mutation.wizardEntry
    && mutation.wizardWindowId > 0){
    const currentWizardEntry = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(mutation.wizardWindowId);
    if (!currentWizardEntry){
      SHARING_WIZARD_CLEANUP_BY_WINDOW.set(
        mutation.wizardWindowId,
        mutation.wizardEntry
      );
    }else if (currentWizardEntry !== mutation.wizardEntry){
      console.error("[NCBG] sharing wizard ownership rollback conflict", {
        windowId: mutation.wizardWindowId,
        reason: reason || ""
      });
      return false;
    }
  }
  L("compose share cleanup arm rolled back", {
    tabId: mutation.tabId,
    reason: reason || "",
    restoredShares: Array.isArray(mutation.previousState?.entries)
      ? mutation.previousState.entries.length
      : 0
  });
  return true;
}

async function restorePersistentWizardCleanupOwnership(mutation){
  if (!mutation?.persistenceTransition){
    return;
  }
  await rollbackPersistentComposeCleanupGroup(mutation.persistenceTransition);
}

async function setComposeShareCleanupSendPending(tabId, pending, reason = ""){
  const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!state?.draftGroupId){
    return false;
  }
  const persisted = await markPersistentComposeSendPending(
    state.draftGroupId,
    pending === true
  );
  if (!persisted){
    throw new Error("compose_send_pending_record_missing");
  }
  if (COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) !== state){
    return false;
  }
  if (state.timerId){
    try{
      clearTimeout(state.timerId);
    }catch(error){
      console.error("[NCBG] compose share cleanup timer clear failed", {
        tabId,
        error: error?.message || String(error)
      });
    }
    state.timerId = null;
  }
  state.sendPending = pending === true;
  state.sendStateUpdated = Date.now();
  L("compose share cleanup send state updated", {
    tabId,
    sendPending: state.sendPending,
    reason: reason || "",
    shares: Array.isArray(state.entries) ? state.entries.length : 0
  });
  return true;
}

async function setComposeSharePasswordHandoffState(
  tabId,
  required,
  complete,
  reason = ""
){
  const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!state?.draftGroupId){
    return false;
  }
  const previousRequired = state.passwordHandoffRequired === true;
  const previousComplete = state.passwordHandoffRequired !== true
    || state.passwordHandoffComplete === true;
  state.passwordHandoffRequired = required === true;
  state.passwordHandoffComplete = required !== true || complete === true;
  try{
    const persisted = await markPersistentComposePasswordHandoff(
      state.draftGroupId,
      state.passwordHandoffRequired,
      state.passwordHandoffComplete
    );
    if (!persisted){
      throw new Error("compose_password_handoff_record_missing");
    }
  }catch(error){
    state.passwordHandoffRequired = previousRequired;
    state.passwordHandoffComplete = previousComplete;
    throw error;
  }
  L("compose password handoff state updated", {
    tabId,
    required: state.passwordHandoffRequired,
    complete: state.passwordHandoffComplete,
    reason: reason || ""
  });
  return true;
}

async function rehydrateComposeShareCleanup(tabId, details = null){
  if (!Number.isInteger(tabId) || tabId <= 0){
    return { ok: false, reason: "invalid_tab_id" };
  }
  await PERSISTED_SHARE_CLEANUP_READY;
  const composeDetails = details || await browser.compose.getComposeDetails(tabId);
  if (String(composeDetails?.type || "") !== "draft"){
    return { ok: false, reason: "not_saved_draft" };
  }
  const draftIds = [...new Set(getComposeShareDraftIds(composeDetails?.customHeaders))];
  if (draftIds.length !== 1){
    return {
      ok: false,
      reason: draftIds.length ? "draft_marker_conflict" : "draft_marker_missing"
    };
  }
  const draftGroupId = draftIds[0];
  const persisted = getPersistentShareCleanupGroup(draftGroupId);
  if (!persisted
    || persisted.ownerKind !== "compose"
    || !["saved", "send_pending"].includes(persisted.state)
    || persisted.saved !== true){
    return { ok: false, reason: "draft_cleanup_record_missing" };
  }
  const entries = getPersistedComposeCleanupEntries(draftGroupId);
  if (!entries.length){
    return { ok: false, reason: "draft_cleanup_resources_missing" };
  }
  const current = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (current?.draftGroupId === draftGroupId){
    return { ok: true, state: current, rehydrated: false };
  }
  if (current){
    return { ok: false, reason: "draft_cleanup_tab_conflict" };
  }
  const state = {
    cleanupId: createShareCleanupId(),
    tabId,
    entries,
    draftGroupId,
    saved: true,
    savePendingChanges: persisted.savePendingChanges === true,
    messageIds: persisted.messageIds.slice(),
    passwordHandoffRequired: persisted.passwordHandoffRequired === true,
    passwordHandoffComplete: persisted.passwordHandoffRequired !== true
      || persisted.passwordHandoffComplete === true,
    templateUnsupported: persisted.templateUnsupported === true,
    lifecycleTainted: persisted.lifecycleTainted === true,
    created: persisted.created,
    sendPending: persisted.state === "send_pending"
      || persisted.sendPending === true,
    timerId: null,
    deleting: false,
    deletePromise: null
  };
  COMPOSE_SHARE_CLEANUP_BY_TAB.set(tabId, state);
  L("compose share cleanup rehydrated", {
    tabId,
    draftGroupId: bgShortId(draftGroupId, 24),
    shares: entries.length
  });
  return { ok: true, state, rehydrated: true };
}

async function markComposeShareCleanupSaved(
  tabId,
  saveInfo = {},
  options = {}
){
  const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!state?.draftGroupId){
    return false;
  }
  const messageIds = (Array.isArray(saveInfo?.messages) ? saveInfo.messages : [])
    .map((message) => Number(message?.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const passwordHandoffRequired = options.passwordHandoffRequired === true;
  const passwordHandoffComplete = passwordHandoffRequired !== true
    || options.passwordHandoffComplete === true;
  const templateUnsupported = state.templateUnsupported === true
    || options.templateUnsupported === true;
  const persisted = await markPersistentComposeCleanupSaved(
    state.draftGroupId,
    messageIds,
    {
      passwordHandoffRequired,
      passwordHandoffComplete,
      templateUnsupported
    }
  );
  if (!persisted){
    throw new Error("compose_cleanup_record_missing");
  }
  if (COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) !== state){
    return false;
  }
  state.saved = true;
  state.saveOutcomeUncertain = false;
  state.savePendingChanges = false;
  state.messageIds = messageIds;
  state.sendPending = false;
  state.passwordHandoffRequired = passwordHandoffRequired;
  state.passwordHandoffComplete = passwordHandoffComplete;
  state.templateUnsupported = templateUnsupported;
  L("compose share cleanup marked as saved draft", {
    tabId,
    draftGroupId: bgShortId(state.draftGroupId, 24),
    messages: messageIds.length,
    shares: state.entries.length
  });
  return true;
}

function detachSavedComposeShareCleanup(tabId, reason = ""){
  const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!state?.saved){
    return false;
  }
  if (state.timerId){
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  COMPOSE_SHARE_CLEANUP_BY_TAB.delete(tabId);
  L("saved compose share cleanup detached", {
    tabId,
    reason: reason || "",
    draftGroupId: bgShortId(state.draftGroupId, 24),
    shares: state.entries.length
  });
  return true;
}

function detachRetainedComposeShareCleanup(tabId, reason = ""){
  const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!state || (!state.saved && !state.saveOutcomeUncertain)){
    return false;
  }
  if (state.timerId){
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  COMPOSE_SHARE_CLEANUP_BY_TAB.delete(tabId);
  L("retained compose share cleanup detached", {
    tabId,
    reason: reason || "",
    draftGroupId: bgShortId(state.draftGroupId, 24),
    saved: state.saved === true,
    saveOutcomeUncertain: state.saveOutcomeUncertain === true,
    shares: state.entries.length
  });
  return true;
}

async function commitComposeShareCleanup(tabId, reason = ""){
  const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!state){
    return false;
  }
  await removePersistentShareCleanupGroup(state.draftGroupId);
  clearComposeShareCleanup(tabId, reason || "committed", state);
  return true;
}

async function deleteComposeShareCleanupNow(
  tabId,
  reason = "",
  expectedCleanupId = ""
){
  const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!state){
    return true;
  }
  if (expectedCleanupId && state.cleanupId !== expectedCleanupId){
    return false;
  }
  if (state.deleting && state.deletePromise){
    try{
      await state.deletePromise;
    }catch(error){
      return false;
    }
    return !COMPOSE_SHARE_CLEANUP_BY_TAB.has(tabId);
  }
  const entries = Array.isArray(state.entries) ? state.entries.slice() : [];
  const deletePromise = (async () => {
    for (const entry of entries){
      await deleteShareCleanupEntry(entry, state.draftGroupId);
      if (COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) === state){
        state.entries = state.entries.filter((candidate) => candidate !== entry);
      }
    }
  })();
  state.deleting = true;
  state.deletePromise = deletePromise;
  try{
    await deletePromise;
    L("compose share cleanup delete done", {
      tabId,
      shares: entries.length,
      reason: reason || ""
    });
    return clearComposeShareCleanup(
      tabId,
      reason || "cleanup_done",
      state
    );
  }catch(error){
    state.deleting = false;
    state.deletePromise = null;
    console.error("[NCBG] compose share cleanup delete failed", {
      tabId,
      shares: Array.isArray(state.entries) ? state.entries.length : 0,
      reason: reason || "",
      error: error?.message || String(error)
    });
    return false;
  }
}

function scheduleComposeShareCleanupRetry(
  tabId,
  cleanupId,
  reason = "",
  attempt = 0
){
  const entry = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!entry || entry.cleanupId !== cleanupId || entry.timerId){
    return false;
  }
  const retryIndex = Math.max(0, Number(attempt) || 0);
  if (retryIndex >= SHARING_WIZARD_CLEANUP_RETRY_DELAYS_MS.length){
    console.error("[NCBG] compose share cleanup retries exhausted", {
      tabId,
      reason: reason || ""
    });
    void markPersistentShareCleanupExhausted(entry.draftGroupId);
    return false;
  }
  entry.timerId = setTimeout(() => {
    const current = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
    if (!current || current.cleanupId !== cleanupId){
      return;
    }
    current.timerId = null;
    void deleteComposeShareCleanupNow(
      tabId,
      reason,
      cleanupId
    ).then((removed) => {
      if (!removed
        && COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId)?.cleanupId === cleanupId){
        scheduleComposeShareCleanupRetry(
          tabId,
          cleanupId,
          reason,
          retryIndex + 1
        );
      }
    }).catch((error) => {
      console.error("[NCBG] compose share cleanup retry failed", {
        tabId,
        reason: reason || "",
        error: error?.message || String(error)
      });
      if (COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId)?.cleanupId === cleanupId){
        scheduleComposeShareCleanupRetry(
          tabId,
          cleanupId,
          reason,
          retryIndex + 1
        );
      }
    });
  }, SHARING_WIZARD_CLEANUP_RETRY_DELAYS_MS[retryIndex]);
  return true;
}

function scheduleComposeShareCleanupDelete(tabId, reason = "", delayMs = 0){
  const entry = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!entry){
    return;
  }
  if (entry.timerId){
    try{
      clearTimeout(entry.timerId);
    }catch(error){
      console.error("[NCBG] compose share cleanup timer clear failed", {
        tabId,
        error: error?.message || String(error)
      });
    }
    entry.timerId = null;
  }
  const safeDelay = Math.max(0, Number(delayMs) || 0);
  void markPersistentShareCleanupPending(
    entry.draftGroupId,
    reason || "compose_cleanup",
    { schedule: false, resetAttempts: false }
  );
  const executeDelete = () => {
    void deleteComposeShareCleanupNow(
      tabId,
      reason,
      entry.cleanupId
    ).then((removed) => {
      if (!removed
        && COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId)?.cleanupId === entry.cleanupId){
        scheduleComposeShareCleanupRetry(
          tabId,
          entry.cleanupId,
          `${reason || "cleanup"}_retry`
        );
      }
    }).catch((error) => {
      console.error("[NCBG] compose share cleanup delete execution failed", {
        tabId,
        reason: reason || "",
        error: error?.message || String(error)
      });
      if (COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId)?.cleanupId === entry.cleanupId){
        scheduleComposeShareCleanupRetry(
          tabId,
          entry.cleanupId,
          `${reason || "cleanup"}_retry`
        );
      }
    });
  };
  if (safeDelay === 0){
    executeDelete();
    return;
  }
  // TB can remove the compose tab before onAfterSend reports success.
  // Delay avoids deleting a share from a message that just left the outbox.
  entry.timerId = setTimeout(() => {
    const current = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
    if (current){
      current.timerId = null;
    }
    executeDelete();
  }, safeDelay);
  L("compose share cleanup delete scheduled", {
    tabId,
    delayMs: safeDelay,
    reason: reason || "",
    sendPending: !!entry.sendPending
  });
}
