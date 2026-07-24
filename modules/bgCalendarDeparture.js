/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

/**
 * Persistent, bounded retry lifecycle for leaving a Talk room after moderator
 * delegation. The retry evidence lives in ROOM_META so it survives a
 * Thunderbird restart without adding a second source of truth.
 */
const CALENDAR_DEPARTURE_RETRY_DELAYS_MS = [2000, 5000, 10000, 30000, 60000];
const CALENDAR_DEPARTURE_RETRY_TIMER_BY_TOKEN = new Map();
const CALENDAR_DEPARTURE_RETRY_ACTIVE_BY_TOKEN = new Set();
const CALENDAR_DEPARTURE_RETRY_RERUN_BY_TOKEN = new Set();
const CALENDAR_DEPARTURE_PREPARED_TIMER_BY_TOKEN = new Map();

function getCalendarDepartureRetryRecord(token){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  const meta = normalizedToken ? (getRoomMeta(normalizedToken) || {}) : {};
  const delegateId = typeof meta.delegateId === "string"
    ? meta.delegateId.trim()
    : "";
  if (!normalizedToken || meta.departurePending !== true || !delegateId){
    return null;
  }
  return {
    token: normalizedToken,
    delegateId,
    generation: Math.max(0, Number(meta.departureRetryGeneration) || 0),
    attempts: Math.max(0, Number(meta.departureRetryAttempts) || 0),
    nextAttemptAt: Math.max(0, Number(meta.departureNextAttemptAt) || 0),
    exhausted: meta.departureRetryExhausted === true
  };
}

function getCalendarDeparturePreparedRecord(token){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  const meta = normalizedToken ? (getRoomMeta(normalizedToken) || {}) : {};
  const delegateId = typeof meta.delegateId === "string"
    ? meta.delegateId.trim()
    : "";
  const calendarId = typeof meta.departureCalendarId === "string"
    ? meta.departureCalendarId.trim()
    : "";
  const itemId = typeof meta.departureItemId === "string"
    ? meta.departureItemId.trim()
    : "";
  if (
    !normalizedToken
    || meta.departurePrepared !== true
    || !delegateId
  ){
    return null;
  }
  return {
    token: normalizedToken,
    delegateId,
    calendarId,
    itemId,
    generation: Math.max(0, Number(meta.departureRetryGeneration) || 0),
    shouldLeaveSelf: meta.departureShouldLeaveSelf === true
  };
}

function cancelPreparedCalendarDepartureTimer(token, reason = ""){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  const scheduled = normalizedToken
    ? CALENDAR_DEPARTURE_PREPARED_TIMER_BY_TOKEN.get(normalizedToken)
    : null;
  if (!scheduled){
    return false;
  }
  clearTimeout(scheduled.timerId);
  CALENDAR_DEPARTURE_PREPARED_TIMER_BY_TOKEN.delete(normalizedToken);
  L("calendar prepared departure recovery canceled", {
    token: shortToken(normalizedToken),
    reason: reason || ""
  });
  return true;
}

function schedulePreparedCalendarDepartureRecovery(token, attempt){
  const record = getCalendarDeparturePreparedRecord(token);
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  if (
    !record
    || !record.calendarId
    || !record.itemId
    || CALENDAR_DEPARTURE_PREPARED_TIMER_BY_TOKEN.has(record.token)
  ){
    return false;
  }
  if (normalizedAttempt > CALENDAR_DEPARTURE_RETRY_DELAYS_MS.length){
    L("calendar prepared departure recovery exhausted", {
      token: shortToken(record.token),
      generation: record.generation,
      attempts: normalizedAttempt - 1
    });
    return false;
  }
  const delayMs = CALENDAR_DEPARTURE_RETRY_DELAYS_MS[normalizedAttempt - 1];
  const timerId = setTimeout(() => {
    const scheduled =
      CALENDAR_DEPARTURE_PREPARED_TIMER_BY_TOKEN.get(record.token);
    if (scheduled?.timerId !== timerId){
      return;
    }
    CALENDAR_DEPARTURE_PREPARED_TIMER_BY_TOKEN.delete(record.token);
    void recoverPreparedCalendarDeparture(record.token, normalizedAttempt);
  }, delayMs);
  CALENDAR_DEPARTURE_PREPARED_TIMER_BY_TOKEN.set(record.token, {
    timerId,
    attempt: normalizedAttempt,
    generation: record.generation
  });
  L("calendar prepared departure recovery scheduled", {
    token: shortToken(record.token),
    generation: record.generation,
    attempt: normalizedAttempt,
    delayMs
  });
  return true;
}

function isCurrentCalendarDepartureRetry(token, generation){
  const current = getCalendarDepartureRetryRecord(token);
  return !!current && current.generation === generation;
}

function cancelCalendarDepartureRetryTimer(token, reason = ""){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  const scheduled = normalizedToken
    ? CALENDAR_DEPARTURE_RETRY_TIMER_BY_TOKEN.get(normalizedToken)
    : null;
  if (!scheduled){
    return false;
  }
  clearTimeout(scheduled.timerId);
  CALENDAR_DEPARTURE_RETRY_TIMER_BY_TOKEN.delete(normalizedToken);
  L("calendar departure retry canceled", {
    token: shortToken(normalizedToken),
    reason: reason || ""
  });
  return true;
}

function scheduleCalendarDepartureRetryTimer(record){
  if (!record?.token || record.exhausted === true){
    return false;
  }
  const existing = CALENDAR_DEPARTURE_RETRY_TIMER_BY_TOKEN.get(record.token);
  if (existing){
    if (
      existing.generation === record.generation
      && existing.nextAttemptAt === record.nextAttemptAt
    ){
      return false;
    }
    clearTimeout(existing.timerId);
    CALENDAR_DEPARTURE_RETRY_TIMER_BY_TOKEN.delete(record.token);
  }
  const delayMs = Math.max(0, record.nextAttemptAt - Date.now());
  const timerId = setTimeout(() => {
    const scheduled = CALENDAR_DEPARTURE_RETRY_TIMER_BY_TOKEN.get(record.token);
    if (scheduled?.timerId !== timerId){
      return;
    }
    CALENDAR_DEPARTURE_RETRY_TIMER_BY_TOKEN.delete(record.token);
    void runCalendarDepartureRetry(record.token, record.generation)
      .catch((error) => console.error("[NCBG] calendar departure retry runner failed", error));
  }, delayMs);
  CALENDAR_DEPARTURE_RETRY_TIMER_BY_TOKEN.set(record.token, {
    timerId,
    generation: record.generation,
    nextAttemptAt: record.nextAttemptAt
  });
  L("calendar departure retry scheduled", {
    token: shortToken(record.token),
    generation: record.generation,
    attempt: record.attempts,
    delayMs
  });
  return true;
}

async function persistCalendarDepartureRetryFailure(record, error){
  const attempts = record.attempts + 1;
  const exhausted = attempts > CALENDAR_DEPARTURE_RETRY_DELAYS_MS.length;
  const nextAttemptAt = exhausted
    ? 0
    : Date.now() + CALENDAR_DEPARTURE_RETRY_DELAYS_MS[attempts - 1];
  const updated = await setRoomMetaIf(
    record.token,
    (current) =>
      current.departurePending === true
      && (Number(current.departureRetryGeneration) || 0) === record.generation,
    {
      departurePrepared: false,
      departurePending: true,
      departureRetryGeneration: record.generation,
      departureRetryAttempts: attempts,
      departureNextAttemptAt: nextAttemptAt,
      departureRetryExhausted: exhausted,
      departureCompleted: false
    }
  );
  if (!updated){
    return false;
  }
  console.error("[NCBG] calendar delegation self-leave failed", {
    token: shortToken(record.token),
    attempt: attempts,
    exhausted,
    error: error?.message || String(error)
  });
  if (!exhausted){
    scheduleCalendarDepartureRetryTimer({
      ...record,
      attempts,
      nextAttemptAt,
      exhausted: false
    });
  }
  return !exhausted;
}

async function completeCalendarDepartureRetry(record, reason){
  const updated = await setRoomMetaIf(
    record.token,
    (current) =>
      current.departurePending === true
      && (Number(current.departureRetryGeneration) || 0) === record.generation,
    {
      departurePrepared: false,
      departurePending: false,
      departureRetryGeneration: record.generation,
      departureRetryAttempts: 0,
      departureNextAttemptAt: 0,
      departureRetryExhausted: false,
      departureShouldLeaveSelf: false,
      departureCompleted: true
    }
  );
  if (!updated){
    return false;
  }
  cancelCalendarDepartureRetryTimer(record.token, reason);
  L("calendar departure completed", {
    token: shortToken(record.token),
    generation: record.generation,
    reason
  });
  return true;
}

async function activatePreparedCalendarDeparture({
  token,
  generation,
  shouldLeaveSelf
} = {}){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  const normalizedGeneration = Math.max(0, Number(generation) || 0);
  if (!normalizedToken){
    return false;
  }
  const departureArmed = await setRoomMetaIf(
    normalizedToken,
    (current) =>
      current.departurePrepared === true
      && (Number(current.departureRetryGeneration) || 0) === normalizedGeneration,
    {
      delegated: true,
      departurePrepared: false,
      departurePending: shouldLeaveSelf === true,
      departureRetryGeneration: normalizedGeneration,
      departureRetryAttempts: 0,
      departureNextAttemptAt: shouldLeaveSelf === true ? Date.now() : 0,
      departureRetryExhausted: false,
      departureCompleted: shouldLeaveSelf !== true
    }
  );
  if (!departureArmed){
    return false;
  }
  cancelPreparedCalendarDepartureTimer(
    normalizedToken,
    "departure_activated"
  );
  if (shouldLeaveSelf === true){
    await startCalendarDepartureRetry(normalizedToken, normalizedGeneration);
  }else{
    L("calendar departure completed", {
      token: shortToken(normalizedToken),
      generation: normalizedGeneration,
      reason: "self_leave_not_required"
    });
  }
  return true;
}

async function resumePreparedCalendarDeparture(token){
  await BG_STATE_READY;
  const record = getCalendarDeparturePreparedRecord(token);
  if (!record){
    return false;
  }
  if (!record.calendarId || !record.itemId){
    L("calendar prepared departure retained (event identity missing)", {
      token: shortToken(record.token),
      generation: record.generation
    });
    return false;
  }
  const getCalendarItem = browser?.calendar?.items?.get;
  if (typeof getCalendarItem !== "function"){
    L("calendar prepared departure retained (calendar API unavailable)", {
      token: shortToken(record.token),
      generation: record.generation
    });
    return false;
  }
  const item = await getCalendarItem(
    record.calendarId,
    record.itemId,
    { returnFormat: "ical" }
  );
  const current = getCalendarDeparturePreparedRecord(record.token);
  if (!current || current.generation !== record.generation){
    return false;
  }
  let itemMeta = {};
  if (item?.format === "ical" && typeof item.item === "string"){
    itemMeta = extractTalkMetadataFromIcal(item.item) || {};
  }
  const delegationConfirmed =
    String(itemMeta.token || "").trim() === record.token
    && itemMeta.delegated === true
    && String(itemMeta.delegateId || "").trim().toLowerCase()
      === record.delegateId.toLowerCase();
  if (!delegationConfirmed){
    L("calendar prepared departure awaiting confirmed writeback", {
      token: shortToken(record.token),
      generation: record.generation,
      hasItem: !!item
    });
    if (item && typeof queueCalendarItemUpsert === "function"){
      await queueCalendarItemUpsert(item);
    }
    return false;
  }
  return activatePreparedCalendarDeparture({
    token: record.token,
    generation: record.generation,
    shouldLeaveSelf: record.shouldLeaveSelf
  });
}

async function recoverPreparedCalendarDeparture(token, completedAttempt = 0){
  try{
    await resumePreparedCalendarDeparture(token);
  }catch(error){
    console.error("[NCBG] calendar prepared departure recovery failed", {
      token: shortToken(token),
      error: error?.message || String(error)
    });
  }
  if (getCalendarDeparturePreparedRecord(token)){
    schedulePreparedCalendarDepartureRecovery(
      token,
      Math.max(0, Number(completedAttempt) || 0) + 1
    );
  }
}

async function runCalendarDepartureRetry(token, expectedGeneration = null){
  await BG_STATE_READY;
  const record = getCalendarDepartureRetryRecord(token);
  if (
    !record
    || record.exhausted
    || (
      expectedGeneration != null
      && record.generation !== Number(expectedGeneration)
    )
  ){
    return false;
  }
  if (CALENDAR_DEPARTURE_RETRY_ACTIVE_BY_TOKEN.has(record.token)){
    CALENDAR_DEPARTURE_RETRY_RERUN_BY_TOKEN.add(record.token);
    return false;
  }
  CALENDAR_DEPARTURE_RETRY_ACTIVE_BY_TOKEN.add(record.token);
  try{
    const { normalized: currentUser } = await getCanonicalCalendarUserId();
    if (!isCurrentCalendarDepartureRetry(record.token, record.generation)){
      return false;
    }
    if (!currentUser){
      throw new Error("Canonical Nextcloud user id is unavailable.");
    }
    if (currentUser !== record.delegateId.toLowerCase()){
      await NCTalkCore.leaveTalkRoom({ token: record.token });
    }
    if (!isCurrentCalendarDepartureRetry(record.token, record.generation)){
      return false;
    }
    return await completeCalendarDepartureRetry(
      record,
      currentUser === record.delegateId.toLowerCase()
        ? "current_user_is_delegate"
        : "leave_success"
    );
  }catch(error){
    await persistCalendarDepartureRetryFailure(record, error);
    return false;
  }finally{
    CALENDAR_DEPARTURE_RETRY_ACTIVE_BY_TOKEN.delete(record.token);
    if (CALENDAR_DEPARTURE_RETRY_RERUN_BY_TOKEN.delete(record.token)){
      const current = getCalendarDepartureRetryRecord(record.token);
      if (current && !current.exhausted){
        scheduleCalendarDepartureRetryTimer(current);
      }
    }
  }
}

async function startCalendarDepartureRetry(token, generation){
  cancelCalendarDepartureRetryTimer(token, "new_departure");
  return runCalendarDepartureRetry(token, generation);
}

function ensureCalendarDepartureRetry(token){
  const record = getCalendarDepartureRetryRecord(token);
  if (!record || record.exhausted){
    return false;
  }
  return scheduleCalendarDepartureRetryTimer(record);
}

async function resumeCalendarDepartureRetries(){
  await BG_STATE_READY;
  for (const token of Object.keys(ROOM_META)){
    if (getCalendarDeparturePreparedRecord(token)){
      await recoverPreparedCalendarDeparture(token);
    }
    ensureCalendarDepartureRetry(token);
  }
}
