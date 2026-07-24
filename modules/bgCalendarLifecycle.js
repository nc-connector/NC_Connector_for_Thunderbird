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

const TALK_ROOM_DELETE_ACTIVE_BY_TOKEN = new Map();
let ROOM_DELETE_RETRY_MUTATION_CHAIN = Promise.resolve();

function enqueueRoomDeleteRetryMutation(callback){
  const operation = ROOM_DELETE_RETRY_MUTATION_CHAIN.then(async () => {
    await BG_STATE_READY;
    return callback();
  });
  ROOM_DELETE_RETRY_MUTATION_CHAIN = operation.catch(() => {});
  return operation;
}

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

function removeRoomCleanupEntry(token, reason = ""){
  if (!token) return;
  if (reason === "calendar_item_persisted"){
    cancelActiveTalkRoomDelete(token, reason);
  }
  const entry = ROOM_CLEANUP_BY_TOKEN.get(token);
  if (!entry){
    if (reason === "calendar_item_persisted"){
      void clearTalkRoomDeleteRetry(token, reason)
        .catch((error) => console.error("[NCBG] persisted room delete cancellation failed", error));
    }
    return;
  }
  entry.scheduleNonce = (Number(entry.scheduleNonce) || 0) + 1;
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
  if (reason === "calendar_item_persisted"){
    void clearTalkRoomDeleteRetry(token, reason)
      .catch((error) => console.error("[NCBG] persisted room delete cancellation failed", error));
  }
  L("room cleanup cleared", { token: shortToken(token), reason: reason || "" });
}

async function persistTalkRoomDeleteRetry(record){
  const token = typeof record?.token === "string" ? record.token.trim() : "";
  if (!token){
    return null;
  }
  return enqueueRoomDeleteRetryMutation(async () => {
    const persistedRecord = Object.assign({}, record, {
      token,
      updated: Date.now()
    });
    const next = Object.assign({}, ROOM_DELETE_RETRY, {
      [token]: persistedRecord
    });
    await browser.storage.local.set({ [ROOM_DELETE_RETRY_KEY]: next });
    ROOM_DELETE_RETRY = next;
    return persistedRecord;
  });
}

async function clearTalkRoomDeleteRetry(token, reason = ""){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!normalizedToken){
    return;
  }
  const removed = await enqueueRoomDeleteRetryMutation(async () => {
    if (!ROOM_DELETE_RETRY[normalizedToken]){
      return false;
    }
    const next = Object.assign({}, ROOM_DELETE_RETRY);
    delete next[normalizedToken];
    await browser.storage.local.set({ [ROOM_DELETE_RETRY_KEY]: next });
    ROOM_DELETE_RETRY = next;
    return true;
  });
  const timerId = ROOM_DELETE_RETRY_TIMER_BY_TOKEN.get(normalizedToken);
  if (timerId){
    clearTimeout(timerId);
    ROOM_DELETE_RETRY_TIMER_BY_TOKEN.delete(normalizedToken);
  }
  if (!removed){
    return;
  }
  L("room delete retry cleared", {
    token: shortToken(normalizedToken),
    reason: reason || ""
  });
}

function scheduleTalkRoomDeleteRetryTimer(record){
  const token = typeof record?.token === "string" ? record.token.trim() : "";
  if (!token || ROOM_DELETE_RETRY_TIMER_BY_TOKEN.has(token)){
    return;
  }
  const delayMs = Math.max(0, Number(record.nextAttemptAt) - Date.now());
  const timerId = setTimeout(() => {
    ROOM_DELETE_RETRY_TIMER_BY_TOKEN.delete(token);
    void runTalkRoomDeleteRetry(token)
      .catch((error) => console.error("[NCBG] room delete retry runner failed", error));
  }, delayMs);
  ROOM_DELETE_RETRY_TIMER_BY_TOKEN.set(token, timerId);
  const cleanupEntry = ROOM_CLEANUP_BY_TOKEN.get(token);
  if (cleanupEntry){
    cleanupEntry.timerId = timerId;
  }
  L("room delete retry scheduled", {
    token: shortToken(token),
    attempt: Number(record.attempts) || 0,
    delayMs,
    reason: record.reason || ""
  });
}

async function armTalkRoomDeleteRetry({
  token,
  reason = "",
  delayMs = 0,
  calendarId = "",
  itemId = "",
  cleanupGuard = null
} = {}){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!normalizedToken){
    return;
  }
  await BG_STATE_READY;
  if (
    cleanupGuard
    && (
      ROOM_CLEANUP_BY_TOKEN.get(normalizedToken) !== cleanupGuard.entry
      || cleanupGuard.entry.scheduleNonce !== cleanupGuard.scheduleNonce
    )
  ){
    return;
  }
  const existing = ROOM_DELETE_RETRY[normalizedToken] || {};
  const nextAttemptAt = Date.now() + Math.max(0, Number(delayMs) || 0);
  const record = {
    token: normalizedToken,
    reason: reason || existing.reason || "",
    attempts: Number(existing.attempts) || 0,
    nextAttemptAt,
    calendarId: calendarId || existing.calendarId || "",
    itemId: itemId || existing.itemId || "",
    created: Number(existing.created) || Date.now()
  };
  const persistedRecord = await persistTalkRoomDeleteRetry(record);
  if (
    cleanupGuard
    && (
      ROOM_CLEANUP_BY_TOKEN.get(normalizedToken) !== cleanupGuard.entry
      || cleanupGuard.entry.scheduleNonce !== cleanupGuard.scheduleNonce
    )
  ){
    await clearTalkRoomDeleteRetry(normalizedToken, "stale_cleanup_schedule");
    return;
  }
  scheduleTalkRoomDeleteRetryTimer(persistedRecord);
}

function readTalkDeleteErrorStatus(error){
  const status = Number(error?.status);
  return Number.isInteger(status) ? status : 0;
}

function cancelActiveTalkRoomDelete(token, reason = ""){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  const active = normalizedToken
    ? TALK_ROOM_DELETE_ACTIVE_BY_TOKEN.get(normalizedToken)
    : null;
  if (!active){
    return false;
  }
  active.cancelReason = reason || "calendar_reference_created";
  try{
    active.controller.abort();
  }catch(error){
    console.error("[NCBG] active room delete cancellation failed", error);
  }
  L("active room delete canceled", {
    token: shortToken(normalizedToken),
    reason: active.cancelReason
  });
  return true;
}

function isTalkRoomDeleteCanceledForReference(active){
  return !!active?.cancelReason;
}

async function finishTalkRoomDelete(record, reason){
  const token = record.token;
  await clearTalkRoomDeleteRetry(token, reason);
  if (typeof hasTrustedEventTokenReference === "function" && hasTrustedEventTokenReference(token)){
    removeRoomCleanupEntry(token, "token_referenced_before_local_cleanup");
    L("room delete local cleanup skipped (token referenced)", {
      token: shortToken(token),
      reason
    });
    return false;
  }
  removeRoomCleanupEntry(token, reason);
  await deleteRoomMeta(token);
  if (record.calendarId && record.itemId){
    await removeEventTokenEntryIfToken(record.calendarId, record.itemId, token);
  }
  return true;
}

async function retainTalkRoomDeleteEvidence(record, {
  reason,
  status = 0
} = {}){
  const token = typeof record?.token === "string" ? record.token.trim() : "";
  if (!token){
    return false;
  }
  const attempts = (Number(record.attempts) || 0) + 1;
  await persistTalkRoomDeleteRetry(Object.assign({}, record, {
    attempts,
    nextAttemptAt: 0,
    exhausted: true,
    terminalReason: reason || "delete_not_completed",
    terminalStatus: Number(status) || 0
  }));
  removeRoomCleanupEntry(token, reason || "delete_evidence_retained");
  L("room delete evidence retained", {
    token: shortToken(token),
    attempts,
    reason: reason || "",
    status: Number(status) || 0
  });
  return true;
}

async function runTalkRoomDeleteRetry(token){
  await BG_STATE_READY;
  const record = ROOM_DELETE_RETRY[token];
  if (!record){
    return;
  }
  const cleanupEntry = ROOM_CLEANUP_BY_TOKEN.get(token);
  if (cleanupEntry){
    cleanupEntry.timerId = null;
  }
  if (typeof hasTrustedEventTokenReference === "function" && hasTrustedEventTokenReference(token)){
    await clearTalkRoomDeleteRetry(token, "token_still_referenced");
    removeRoomCleanupEntry(token, "token_still_referenced");
    return;
  }
  const active = {
    controller: new AbortController(),
    cancelReason: ""
  };
  TALK_ROOM_DELETE_ACTIVE_BY_TOKEN.set(token, active);
  try{
    // Register the abort handle before the final reference check. A calendar
    // upsert that arrives while the HTTP request is in flight can then cancel
    // the request instead of merely clearing its persisted retry record.
    if (typeof hasTrustedEventTokenReference === "function" && hasTrustedEventTokenReference(token)){
      cancelActiveTalkRoomDelete(token, "token_referenced_before_delete");
      await clearTalkRoomDeleteRetry(token, "token_still_referenced");
      removeRoomCleanupEntry(token, "token_still_referenced");
      return;
    }
    L("room delete attempt", {
      token: shortToken(token),
      attempt: (Number(record.attempts) || 0) + 1,
      reason: record.reason || ""
    });
    await NCTalkCore.deleteTalkRoom({
      token,
      signal: active.controller.signal
    });
    await finishTalkRoomDelete(record, "delete_success");
  }catch(error){
    if (isTalkRoomDeleteCanceledForReference(active)){
      await clearTalkRoomDeleteRetry(token, active.cancelReason);
      removeRoomCleanupEntry(token, active.cancelReason);
      return;
    }
    const status = readTalkDeleteErrorStatus(error);
    if (status === 403){
      L("room delete no longer permitted", { token: shortToken(token) });
      await retainTalkRoomDeleteEvidence(record, {
        reason: "delete_forbidden",
        status
      });
      return;
    }
    const attempts = (Number(record.attempts) || 0) + 1;
    console.error("[NCBG] room delete failed", {
      token: shortToken(token),
      attempt: attempts,
      status,
      error: error?.message || String(error)
    });
    if (attempts > ROOM_DELETE_RETRY_DELAYS_MS.length){
      await persistTalkRoomDeleteRetry(Object.assign({}, record, {
        attempts,
        nextAttemptAt: 0,
        exhausted: true
      }));
      L("room delete retries exhausted", { token: shortToken(token), attempts });
      return;
    }
    const retryRecord = Object.assign({}, record, {
      attempts,
      nextAttemptAt: Date.now() + ROOM_DELETE_RETRY_DELAYS_MS[attempts - 1],
      exhausted: false
    });
    await persistTalkRoomDeleteRetry(retryRecord);
    scheduleTalkRoomDeleteRetryTimer(retryRecord);
  }finally{
    if (TALK_ROOM_DELETE_ACTIVE_BY_TOKEN.get(token) === active){
      TALK_ROOM_DELETE_ACTIVE_BY_TOKEN.delete(token);
    }
  }
}

async function resumeTalkRoomDeleteRetries(){
  await BG_STATE_READY;
  for (const record of Object.values(ROOM_DELETE_RETRY)){
    if (!record?.token || record.exhausted === true){
      continue;
    }
    scheduleTalkRoomDeleteRetryTimer(record);
  }
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
  void armTalkRoomDeleteRetry({
    token,
    reason: `editor_${reason || "discarded"}`,
    delayMs: delay,
    cleanupGuard: { entry, scheduleNonce }
  }).catch((error) => console.error("[NCBG] room cleanup scheduling failed", error));
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
  if (action === "discarded"){
    scheduleRoomCleanupDelete(token, reason || "discarded");
    return;
  }
  if (action === "superseded"){
    scheduleRoomCleanupDelete(token, reason || "superseded", 0);
  }
}

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

let latestCalendarWizardPopupContextId = "";

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

function setLatestCalendarWizardPopupContext(contextId){
  latestCalendarWizardPopupContextId = getCalendarWizardContext(contextId) ? contextId : "";
}

function consumeLatestCalendarWizardPopupContext(){
  const contextId = latestCalendarWizardPopupContextId;
  latestCalendarWizardPopupContextId = "";
  return getCalendarWizardContext(contextId) ? contextId : "";
}

function deleteCalendarWizardContext(contextId){
  if (!contextId) return;
  if (latestCalendarWizardPopupContextId === contextId){
    latestCalendarWizardPopupContextId = "";
  }
  CALENDAR_WIZARD_CONTEXTS.delete(contextId);
}

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
 * Apply editor fields, including deliberate empty values.
 * @param {object} base
 * @param {object} update
 * @returns {object}
 */
function mergeCalendarEventFields(base, update){
  const merged = Object.assign({}, base || {});
  for (const key of ["title", "location", "description", "descriptionHtml"]){
    if (typeof update?.[key] === "string"){
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
