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

function createCalendarWizardContextId(){
  const rand = Math.random().toString(16).slice(2);
  return `${Date.now()}-${rand}`;
}

function setCalendarWizardContext(contextId, entry){
  pruneCalendarWizardContexts();
  const next = Object.assign({}, entry || {}, { created: Date.now() });
  CALENDAR_WIZARD_CONTEXTS.set(contextId, next);
  return next;
}

function getCalendarWizardContext(contextId){
  if (!contextId) return null;
  pruneCalendarWizardContexts();
  return CALENDAR_WIZARD_CONTEXTS.get(contextId) || null;
}

function deleteCalendarWizardContext(contextId){
  if (!contextId) return;
  CALENDAR_WIZARD_CONTEXTS.delete(contextId);
}

/**
 * Resolve the shared iCal parser API used by lifecycle snapshots.
 * @returns {object|null}
 */
function getLifecycleIcalContract(){
  const api = globalThis?.NCIcalContract || null;
  if (!api){
    return null;
  }
  if (
    typeof api.parseEventData !== "function"
    || typeof api.parseEventStartUnixSeconds !== "function"
    || typeof api.parseEventEndUnixSeconds !== "function"
  ){
    return null;
  }
  return api;
}

/**
 * Check whether a ncCalToolbar snapshot contains serialized iCal.
 * @param {object} snapshot
 * @returns {boolean}
 */
function calendarSnapshotHasIcal(snapshot){
  return !!(
    snapshot &&
    snapshot.format === "ical" &&
    typeof snapshot.item === "string" &&
    snapshot.item
  );
}

function isCalendarSnapshotTimestamp(value){
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Extract live editor fields from a ncCalToolbar snapshot.
 * @param {object} snapshot
 * @returns {object}
 */
function readCalendarSnapshotLiveEvent(snapshot){
  const event = {};
  for (const key of ["title", "location", "description", "descriptionHtml"]){
    if (typeof snapshot?.[key] === "string"){
      event[key] = snapshot[key];
    }
  }
  if (isCalendarSnapshotTimestamp(snapshot?.startTimestamp)){
    event.startTimestamp = Math.floor(snapshot.startTimestamp);
  }
  if (isCalendarSnapshotTimestamp(snapshot?.endTimestamp)){
    event.endTimestamp = Math.floor(snapshot.endTimestamp);
  }
  return event;
}

/**
 * Merge event fields without erasing existing values with empty snapshot data.
 * @param {object} base
 * @param {object} update
 * @returns {object}
 */
function mergeCalendarEventFields(base, update){
  const merged = Object.assign({}, base || {});
  for (const key of ["title", "location", "description", "descriptionHtml"]){
    if (typeof update?.[key] === "string" && update[key]){
      merged[key] = update[key];
    }
  }
  if (isCalendarSnapshotTimestamp(update?.startTimestamp)){
    merged.startTimestamp = Math.floor(update.startTimestamp);
  }
  if (isCalendarSnapshotTimestamp(update?.endTimestamp)){
    merged.endTimestamp = Math.floor(update.endTimestamp);
  }
  return merged;
}

/**
 * Check whether a ncCalToolbar snapshot contains useful iCal or live editor data.
 * @param {object} snapshot
 * @returns {boolean}
 */
function calendarSnapshotHasContent(snapshot){
  if (calendarSnapshotHasIcal(snapshot)){
    return true;
  }
  const event = readCalendarSnapshotLiveEvent(snapshot);
  return !!(
    event.title ||
    event.location ||
    event.description ||
    event.descriptionHtml ||
    isCalendarSnapshotTimestamp(event.startTimestamp) ||
    isCalendarSnapshotTimestamp(event.endTimestamp)
  );
}

/**
 * Merge a ncCalToolbar snapshot into one wizard context.
 * @param {object} entry
 * @param {object} snapshot
 */
function mergeCalendarSnapshotIntoWizardContext(entry, snapshot){
  if (!entry || !snapshot){
    return;
  }
  entry.item = Object.assign({}, entry.item || {}, {
    id: typeof snapshot.id === "string" ? snapshot.id : (entry.item?.id || ""),
    calendarId: typeof snapshot.calendarId === "string" ? snapshot.calendarId : (entry.item?.calendarId || ""),
    type: typeof snapshot.type === "string" ? snapshot.type : (entry.item?.type || "event")
  });
  if (calendarSnapshotHasIcal(snapshot)){
    entry.item.format = "ical";
    entry.item.item = snapshot.item;
  }
  entry.event = mergeCalendarEventFields(entry.event || {}, readCalendarSnapshotLiveEvent(snapshot));
  entry.snapshotSource = typeof snapshot.snapshotSource === "string" ? snapshot.snapshotSource : "";
}

/**
 * Refresh parsed event/metadata snapshot for a wizard context entry.
 * @param {object} entry
 */
function refreshCalendarWizardContextSnapshot(entry){
  if (!entry?.item?.item){
    entry.event = entry.event || {};
    entry.metadata = entry.metadata || {};
    L("calendar snapshot refresh live-only", {
      hasStart: isCalendarSnapshotTimestamp(entry.event?.startTimestamp),
      hasEnd: isCalendarSnapshotTimestamp(entry.event?.endTimestamp),
      hasTitle: !!entry.event?.title,
      source: entry.snapshotSource || ""
    });
    return;
  }
  const ical = String(entry.item.item || "");
  const contract = getLifecycleIcalContract();
  if (!contract){
    console.error("[NCBG] iCal contract unavailable for calendar snapshot");
    entry.event = entry.event || {};
    entry.metadata = entry.metadata || {};
    return;
  }
  try{
    entry.metadata = extractTalkMetadataFromIcal(ical) || {};
  }catch(error){
    console.error("[NCBG] extractTalkMetadataFromIcal failed", error);
    entry.metadata = entry.metadata || {};
  }
  try{
    const { props } = contract.parseEventData(ical);
    entry.event = mergeCalendarEventFields(entry.event || {}, {
      title: props["SUMMARY"] || "",
      location: props["LOCATION"] || "",
      description: props["DESCRIPTION"] || "",
      startTimestamp: contract.parseEventStartUnixSeconds(ical),
      endTimestamp: contract.parseEventEndUnixSeconds(ical)
    });
  }catch(error){
    console.error("[NCBG] parseIcalEventData failed", error);
    entry.event = entry.event || {};
  }
}
