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

function createShareCleanupId(){
  if (globalThis.crypto?.randomUUID){
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
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

async function deleteShareCleanupEntry(entry){
  if (entry?.cleanupTarget){
    await NCFileLinkDav.deleteTrackedRoot({
      url: entry.cleanupTarget.url,
      reservationUrl: entry.cleanupTarget.reservationUrl,
      targetUrl: entry.cleanupTarget.targetUrl,
      authHeader: entry.cleanupTarget.authHeader,
      log: (...args) => L(...args)
    });
    if (entry.cleanupTarget.baseUrl && entry.cleanupTarget.relativeFolder){
      await NCFileLinkShare.clearIndeterminate({
        baseUrl: entry.cleanupTarget.baseUrl,
        relativeFolder: entry.cleanupTarget.relativeFolder,
        authHeader: entry.cleanupTarget.authHeader
      });
    }
    return;
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
  SHARING_WIZARD_CLEANUP_BY_WINDOW.set(windowId, {
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
  });
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
    await deleteShareCleanupEntry(entry);
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
async function armComposeShareCleanup(tabId, payload = {}){
  if (!Number.isInteger(tabId) || tabId <= 0){
    throw new Error("invalid_tab_id");
  }
  const folderInfo = normalizeComposeShareCleanupFolderInfo(payload.folderInfo);
  if (!folderInfo){
    throw new Error("folder_info_missing");
  }
  const wizardWindowId = Number(payload.wizardWindowId);
  let previous = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) || null;
  if (previous?.deleting && previous.deletePromise){
    try{
      await previous.deletePromise;
    }catch(error){
      throw new Error("previous_cleanup_failed");
    }
    previous = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId) || null;
  }
  if (previous?.timerId){
    clearTimeout(previous.timerId);
    previous.timerId = null;
  }
  const wizardEntry = Number.isInteger(wizardWindowId)
    ? SHARING_WIZARD_CLEANUP_BY_WINDOW.get(wizardWindowId)
    : null;
  const trackedShare = Object.freeze({
    folderInfo,
    shareId: String(payload.shareId || "").trim(),
    shareLabel: String(payload.shareLabel || "").trim(),
    shareUrl: String(payload.shareUrl || "").trim(),
    cleanupTarget: normalizeShareCleanupTarget(payload.cleanupTarget)
      || wizardEntry?.cleanupTarget
      || null,
    created: Date.now()
  });
  const entries = Array.isArray(previous?.entries)
    ? [...previous.entries, trackedShare]
    : [trackedShare];
  COMPOSE_SHARE_CLEANUP_BY_TAB.set(tabId, {
    cleanupId: createShareCleanupId(),
    tabId,
    entries,
    created: Date.now(),
    sendPending: false,
    timerId: null,
    deleting: false,
    deletePromise: null
  });
  if (wizardEntry){
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
}

function setComposeShareCleanupSendPending(tabId, pending, reason = ""){
  const state = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!state){
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
  state.sendPending = !!pending;
  state.sendStateUpdated = Date.now();
  L("compose share cleanup send state updated", {
    tabId,
    sendPending: state.sendPending,
    reason: reason || "",
    shares: Array.isArray(state.entries) ? state.entries.length : 0
  });
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
      await deleteShareCleanupEntry(entry);
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
