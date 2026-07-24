/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

/**
 * Serialized persistence for the calendar/Talk runtime maps. Every mutation
 * reads the latest committed mirror, writes one complete storage snapshot and
 * updates the mirror only after storage accepted that snapshot.
 */
let ROOM_META_MUTATION_CHAIN = Promise.resolve();
let EVENT_TOKEN_MAP_MUTATION_CHAIN = Promise.resolve();

function enqueueRoomMetaMutation(callback){
  const operation = ROOM_META_MUTATION_CHAIN.then(async () => {
    await BG_STATE_READY;
    return callback();
  });
  ROOM_META_MUTATION_CHAIN = operation.catch(() => {});
  return operation;
}

function enqueueEventTokenMapMutation(callback){
  const operation = EVENT_TOKEN_MAP_MUTATION_CHAIN.then(async () => {
    await BG_STATE_READY;
    return callback();
  });
  EVENT_TOKEN_MAP_MUTATION_CHAIN = operation.catch(() => {});
  return operation;
}

async function writeRoomMetaPatch(token, data, predicate = null){
  if (!token){
    return { updated: false, entry: null };
  }
  return enqueueRoomMetaMutation(async () => {
    const current = ROOM_META[token] || {};
    if (typeof predicate === "function" && !predicate(current)){
      return { updated: false, entry: current };
    }
    const entry = Object.assign({}, current, data, { updated: Date.now() });
    const next = Object.assign({}, ROOM_META, { [token]: entry });
    try{
      await browser.storage.local.set({ [ROOM_META_KEY]: next });
    }catch(error){
      console.error("[NCBG] setRoomMeta", error);
      throw error;
    }
    ROOM_META = next;
    return { updated: true, entry };
  });
}

/**
 * Merge and persist room metadata for a Talk token.
 * @param {string} token
 * @param {object} data
 * @returns {Promise<object|null>}
 */
async function setRoomMeta(token, data = {}){
  const result = await writeRoomMetaPatch(token, data);
  return result.entry;
}

async function setRoomMetaIf(token, predicate, data = {}){
  const result = await writeRoomMetaPatch(token, data, predicate);
  return result.updated;
}

async function deleteRoomMeta(token){
  if (!token) return;
  return enqueueRoomMetaMutation(async () => {
    if (!ROOM_META[token]){
      return;
    }
    const next = Object.assign({}, ROOM_META);
    delete next[token];
    try{
      await browser.storage.local.set({ [ROOM_META_KEY]: next });
    }catch(error){
      console.error("[NCBG] deleteRoomMeta", error);
      throw error;
    }
    ROOM_META = next;
  });
}

function getRoomMeta(token){
  if (!token) return null;
  return ROOM_META[token] || null;
}

function makeEventMapKey(calendarId, itemId){
  if (!calendarId || !itemId){
    return "";
  }
  return `${calendarId}::${itemId}`;
}

/**
 * Lookup a stored token mapping for a calendar item.
 * @param {string} calendarId
 * @param {string} itemId
 * @returns {{token:string,url?:string,source?:string,updated?:number}|null}
 */
function getEventTokenEntry(calendarId, itemId){
  const key = makeEventMapKey(calendarId, itemId);
  if (!key) return null;
  return EVENT_TOKEN_MAP[key] || null;
}

/**
 * Return true only for mappings written from NC Connector iCalendar metadata.
 * Legacy mappings without a source are not trusted because older builds also
 * stored tokens discovered from ordinary LOCATION/URL fields.
 * @param {{source?:string}|null} entry
 * @returns {boolean}
 */
function isTrustedEventTokenEntry(entry){
  return entry?.source === "x-nctalk";
}

/**
 * Persist the token mapping for a calendar item.
 * @param {string} calendarId
 * @param {string} itemId
 * @param {{token:string,url?:string,source?:string}} entry
 * @returns {Promise<void>}
 */
async function setEventTokenEntry(calendarId, itemId, entry){
  const key = makeEventMapKey(calendarId, itemId);
  if (!key || !entry?.token){
    return;
  }
  cancelActiveTalkRoomDelete(entry.token, "event_token_mapping_created");
  return enqueueEventTokenMapMutation(async () => {
    const next = Object.assign({}, EVENT_TOKEN_MAP, {
      [key]: {
        token: entry.token,
        url: entry.url || "",
        source: entry.source || "x-nctalk",
        updated: Date.now()
      }
    });
    try{
      await browser.storage.local.set({ [EVENT_TOKEN_MAP_KEY]: next });
    }catch(error){
      console.error("[NCBG] event token map save failed", error);
      throw error;
    }
    EVENT_TOKEN_MAP = next;
  });
}

async function removeEventTokenEntry(calendarId, itemId){
  const key = makeEventMapKey(calendarId, itemId);
  if (!key){
    return;
  }
  return enqueueEventTokenMapMutation(async () => {
    if (!EVENT_TOKEN_MAP[key]){
      return;
    }
    const next = Object.assign({}, EVENT_TOKEN_MAP);
    delete next[key];
    try{
      await browser.storage.local.set({ [EVENT_TOKEN_MAP_KEY]: next });
    }catch(error){
      console.error("[NCBG] event token map remove failed", error);
      throw error;
    }
    EVENT_TOKEN_MAP = next;
  });
}

async function removeEventTokenEntryIfToken(calendarId, itemId, token){
  const key = makeEventMapKey(calendarId, itemId);
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!key || !normalizedToken){
    return false;
  }
  return enqueueEventTokenMapMutation(async () => {
    const current = EVENT_TOKEN_MAP[key];
    if (String(current?.token || "").trim() !== normalizedToken){
      return false;
    }
    const next = Object.assign({}, EVENT_TOKEN_MAP);
    delete next[key];
    try{
      await browser.storage.local.set({ [EVENT_TOKEN_MAP_KEY]: next });
    }catch(error){
      console.error("[NCBG] event token map conditional remove failed", error);
      throw error;
    }
    EVENT_TOKEN_MAP = next;
    return true;
  });
}

function hasTrustedEventTokenReference(token){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!normalizedToken){
    return false;
  }
  return Object.values(EVENT_TOKEN_MAP).some((entry) => {
    return isTrustedEventTokenEntry(entry)
      && String(entry?.token || "").trim() === normalizedToken;
  });
}

function hasTrustedEventTokenReferenceExcept(token, calendarId, itemId){
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  const excludedKey = makeEventMapKey(calendarId, itemId);
  if (!normalizedToken){
    return false;
  }
  return Object.entries(EVENT_TOKEN_MAP).some(([key, entry]) => {
    return key !== excludedKey
      && isTrustedEventTokenEntry(entry)
      && String(entry?.token || "").trim() === normalizedToken;
  });
}

async function getCanonicalCalendarUserId(){
  const opts = await NCCore.getOpts();
  const userId = await NCCore.getCurrentUserId(opts);
  return {
    raw: userId,
    normalized: String(userId || "").trim().toLowerCase()
  };
}
