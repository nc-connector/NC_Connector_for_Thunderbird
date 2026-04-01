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

/**
 * Normalize share-folder info payload for compose cleanup handling.
 * @param {object} folderInfo
 * @returns {{relativeFolder:string,relativeBase?:string,folderName?:string}|null}
 */
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
  return normalized;
}

/**
 * Clear one sharing-wizard remote cleanup entry.
 * @param {number} windowId
 * @param {string} reason
 * @returns {boolean}
 */
function clearSharingWizardRemoteCleanup(windowId, reason = ""){
  const entry = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId);
  if (!entry){
    return false;
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
  clearSharingWizardRemoteCleanup(windowId, "replaced");
  SHARING_WIZARD_CLEANUP_BY_WINDOW.set(windowId, {
    windowId,
    tabId: Number.isInteger(Number(payload.tabId)) ? Number(payload.tabId) : 0,
    folderInfo,
    shareId: String(payload.shareId || "").trim(),
    shareLabel: String(payload.shareLabel || "").trim(),
    shareUrl: String(payload.shareUrl || "").trim(),
    created: Date.now()
  });
  L("sharing wizard cleanup armed", {
    windowId,
    tabId: Number.isInteger(Number(payload.tabId)) ? Number(payload.tabId) : 0,
    relativeFolder: folderInfo.relativeFolder,
    shareId: String(payload.shareId || "").trim(),
    shareLabel: String(payload.shareLabel || "").trim()
  });
}

/**
 * Delete one armed sharing-wizard remote folder on server and clear state.
 * @param {number} windowId
 * @param {string} reason
 */
async function deleteSharingWizardRemoteCleanupNow(windowId, reason = ""){
  const entry = SHARING_WIZARD_CLEANUP_BY_WINDOW.get(windowId);
  if (!entry){
    return;
  }
  try{
    await NCSharing.deleteShareFolder({ folderInfo: entry.folderInfo });
    L("sharing wizard cleanup delete done", {
      windowId,
      reason: reason || "",
      relativeFolder: entry.folderInfo?.relativeFolder || ""
    });
  }catch(error){
    console.error("[NCBG] sharing wizard cleanup delete failed", {
      windowId,
      reason: reason || "",
      relativeFolder: entry.folderInfo?.relativeFolder || "",
      error: error?.message || String(error)
    });
  }finally{
    clearSharingWizardRemoteCleanup(windowId, reason || "cleanup_done");
  }
}

/**
 * Clear one compose-share cleanup entry and cancel pending timers.
 * @param {number} tabId
 * @param {string} reason
 * @returns {boolean}
 */
function clearComposeShareCleanup(tabId, reason = ""){
  const entry = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!entry){
    return false;
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
  COMPOSE_SHARE_CLEANUP_BY_TAB.delete(tabId);
  L("compose share cleanup cleared", {
    tabId,
    reason: reason || "",
    shareId: entry.shareId || "",
    shareLabel: entry.shareLabel || "",
    sendPending: !!entry.sendPending
  });
  return true;
}

/**
 * Arm compose-share cleanup for one compose tab after share creation.
 * Cleanup is cleared only after successful compose send.
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
  clearComposeShareCleanup(tabId, "replaced");
  COMPOSE_SHARE_CLEANUP_BY_TAB.set(tabId, {
    tabId,
    folderInfo,
    shareId: String(payload.shareId || "").trim(),
    shareLabel: String(payload.shareLabel || "").trim(),
    shareUrl: String(payload.shareUrl || "").trim(),
    created: Date.now(),
    sendPending: false,
    timerId: null
  });
  L("compose share cleanup armed", {
    tabId,
    relativeFolder: folderInfo.relativeFolder,
    shareId: String(payload.shareId || "").trim(),
    shareLabel: String(payload.shareLabel || "").trim()
  });
}

/**
 * Update send state for one compose-share cleanup entry.
 * @param {number} tabId
 * @param {boolean} pending
 * @param {string} reason
 * @returns {boolean}
 */
function setComposeShareCleanupSendPending(tabId, pending, reason = ""){
  const entry = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!entry){
    return false;
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
  entry.sendPending = !!pending;
  entry.sendStateUpdated = Date.now();
  L("compose share cleanup send state updated", {
    tabId,
    sendPending: entry.sendPending,
    reason: reason || "",
    shareId: entry.shareId || ""
  });
  return true;
}

/**
 * Delete one compose-share folder on the server and clear cleanup state.
 * @param {number} tabId
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function deleteComposeShareCleanupNow(tabId, reason = ""){
  const entry = COMPOSE_SHARE_CLEANUP_BY_TAB.get(tabId);
  if (!entry){
    return;
  }
  try{
    await NCSharing.deleteShareFolder({ folderInfo: entry.folderInfo });
    L("compose share cleanup delete done", {
      tabId,
      relativeFolder: entry.folderInfo?.relativeFolder || "",
      reason: reason || ""
    });
  }catch(error){
    console.error("[NCBG] compose share cleanup delete failed", {
      tabId,
      relativeFolder: entry.folderInfo?.relativeFolder || "",
      reason: reason || "",
      error: error?.message || String(error)
    });
  }finally{
    clearComposeShareCleanup(tabId, reason || "cleanup_done");
  }
}

/**
 * Schedule compose-share cleanup deletion.
 * @param {number} tabId
 * @param {string} reason
 * @param {number} delayMs
 */
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
    void deleteComposeShareCleanupNow(tabId, reason).catch((error) => {
      console.error("[NCBG] compose share cleanup delete execution failed", {
        tabId,
        reason: reason || "",
        error: error?.message || String(error)
      });
    });
  };
  if (safeDelay === 0){
    executeDelete();
    return;
  }
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
