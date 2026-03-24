/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Calendar lifecycle/context helper module.
 * Keeps room-cleanup lifecycle and wizard-context handling separate from the
 * main calendar synchronization flow.
 */

/**
 * Normalize and validate an editor id for room-cleanup tracking.
 * @param {string} editorId
 * @returns {string}
 */
function makeRoomCleanupEditorKey(editorId){
  if (typeof editorId !== "string"){
    return "";
  }
  const value = editorId.trim();
  if (!value){
    return "";
  }
  return /^ed-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : "";
}

/**
 * Remove one pending room cleanup entry and clear its timer.
 * @param {string} token
 * @param {string} reason
 */
function removeRoomCleanupEntry(token, reason = ""){
  if (!token) return;
  const entry = ROOM_CLEANUP_BY_TOKEN.get(token);
  if (!entry){
    return;
  }
  if (entry.timerId){
    try{
      clearTimeout(entry.timerId);
    }catch(error){
      console.error("[NCBG] clear cleanup timer failed", error);
    }
    entry.timerId = null;
  }
  ROOM_CLEANUP_BY_TOKEN.delete(token);
  if (entry.editorKey && ROOM_CLEANUP_BY_EDITOR.get(entry.editorKey) === token){
    ROOM_CLEANUP_BY_EDITOR.delete(entry.editorKey);
  }
  L("room cleanup cleared", { token: shortToken(token), reason: reason || "" });
}

/**
 * Schedule deferred room deletion for discarded/superseded editors.
 * @param {string} token
 * @param {string} reason
 * @param {number} delayMs
 */
function scheduleRoomCleanupDelete(token, reason = "", delayMs = ROOM_CLEANUP_DELETE_DELAY_MS){
  if (!token) return;
  const entry = ROOM_CLEANUP_BY_TOKEN.get(token);
  if (!entry){
    L("room cleanup ignored (not pending)", { token: shortToken(token), reason: reason || "" });
    return;
  }
  if (entry.timerId){
    return;
  }
  entry.scheduleNonce = (Number(entry.scheduleNonce) || 0) + 1;
  const scheduleNonce = entry.scheduleNonce;
  const delay = Math.max(0, Number(delayMs) || 0);
  entry.timerId = setTimeout(() => {
    (async () => {
      const current = ROOM_CLEANUP_BY_TOKEN.get(token);
      if (!current){
        return;
      }
      if (current !== entry || current.scheduleNonce !== scheduleNonce){
        L("room cleanup skipped (stale timer)", {
          token: shortToken(token),
          reason: reason || ""
        });
        return;
      }
      current.timerId = null;
      removeRoomCleanupEntry(token, `delete:${reason || ""}`);
      try{
        L("room cleanup delete", { token: shortToken(token), reason: reason || "" });
        await NCTalkCore.deleteTalkRoom({ token });
        await deleteRoomMeta(token);
      }catch(error){
        console.error("[NCBG] room cleanup delete failed", error);
      }
    })().catch((error) => console.error("[NCBG] room cleanup delete failed", error));
  }, delay);
  L("room cleanup scheduled", { token: shortToken(token), delayMs: delay, reason: reason || "" });
}

/**
 * Handle editor-close lifecycle signals from ncCalToolbar.
 * @param {{editorId?:string,action?:string,reason?:string}} event
 */
function handleCalendarItemsEditorClosed(event){
  const editorKey = makeRoomCleanupEditorKey(event?.editorId);
  const action = typeof event?.action === "string" ? event.action : "";
  const reason = typeof event?.reason === "string" ? event.reason : "";
  if (!editorKey || !action){
    return;
  }
  const token = ROOM_CLEANUP_BY_EDITOR.get(editorKey);
  L("ncCalToolbar.onTrackedEditorClosed", {
    editorKey,
    token: token ? shortToken(token) : "",
    action,
    reason
  });
  if (!token){
    return;
  }
  if (action === "persisted"){
    removeRoomCleanupEntry(token, `persisted:${reason}`);
    return;
  }
  if (action === "discarded"){
    scheduleRoomCleanupDelete(token, reason || "discarded");
    return;
  }
  if (action === "superseded"){
    scheduleRoomCleanupDelete(token, reason || "superseded", 0);
  }
}

/**
 * Drop stale calendar wizard contexts.
 */
function pruneCalendarWizardContexts(){
  const cutoff = Date.now() - CALENDAR_WIZARD_CONTEXT_TTL_MS;
  for (const [contextId, entry] of CALENDAR_WIZARD_CONTEXTS.entries()){
    if (!entry || typeof entry.created !== "number" || entry.created < cutoff){
      CALENDAR_WIZARD_CONTEXTS.delete(contextId);
    }
  }
}

/**
 * Create a unique id for one calendar wizard context.
 * @returns {string}
 */
function createCalendarWizardContextId(){
  const rand = Math.random().toString(16).slice(2);
  return `${Date.now()}-${rand}`;
}

/**
 * Persist one calendar wizard context.
 * @param {string} contextId
 * @param {object} entry
 * @returns {object}
 */
function setCalendarWizardContext(contextId, entry){
  pruneCalendarWizardContexts();
  const next = Object.assign({}, entry || {}, { created: Date.now() });
  CALENDAR_WIZARD_CONTEXTS.set(contextId, next);
  return next;
}

/**
 * Read one calendar wizard context by id.
 * @param {string} contextId
 * @returns {object|null}
 */
function getCalendarWizardContext(contextId){
  if (!contextId) return null;
  pruneCalendarWizardContexts();
  return CALENDAR_WIZARD_CONTEXTS.get(contextId) || null;
}

/**
 * Remove one calendar wizard context.
 * @param {string} contextId
 */
function deleteCalendarWizardContext(contextId){
  if (!contextId) return;
  CALENDAR_WIZARD_CONTEXTS.delete(contextId);
}

/**
 * Refresh parsed event/metadata snapshot for a wizard context entry.
 * @param {object} entry
 */
function refreshCalendarWizardContextSnapshot(entry){
  if (!entry?.item?.item){
    return;
  }
  const ical = String(entry.item.item || "");
  try{
    entry.metadata = extractTalkMetadataFromIcal(ical) || {};
  }catch(error){
    console.error("[NCBG] extractTalkMetadataFromIcal failed", error);
    entry.metadata = entry.metadata || {};
  }
  try{
    const { props, dtStart, dtEnd } = parseIcalEventData(ical);
    entry.event = {
      title: props["SUMMARY"] || "",
      location: props["LOCATION"] || "",
      description: props["DESCRIPTION"] || "",
      startTimestamp: parseIcalDateTime(dtStart?.value || "", dtStart?.tzid || null),
      endTimestamp: parseIcalDateTime(dtEnd?.value || "", dtEnd?.tzid || null)
    };
  }catch(error){
    console.error("[NCBG] parseIcalEventData failed", error);
    entry.event = entry.event || {};
  }
}
