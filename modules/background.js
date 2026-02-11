/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Background script for Nextcloud Talk Direct.
 * Handles API calls (Talk + CardDAV), caching, and messaging utilities.
 */

browser.ncCalToolbar?.onClicked?.addListener(async (snapshot) => {
  L("ncCalToolbar.onClicked", {
    calendarId: snapshot?.calendarId || "",
    id: snapshot?.id || "",
    type: snapshot?.type || "",
    hasIcal: snapshot?.format === "ical" && typeof snapshot?.item === "string" && !!snapshot.item
  });
  try{
    if (!snapshot || snapshot.format !== "ical" || typeof snapshot.item !== "string" || !snapshot.item){
      console.error("[NCBG] ncCalToolbar.onClicked invalid snapshot");
      return;
    }

    const contextId = createCalendarWizardContextId();
    const context = setCalendarWizardContext(contextId, {
      source: "ncCalToolbar",
      editorRef: {
        windowId: typeof snapshot.windowId === "number" ? snapshot.windowId : null,
        dialogOuterId: typeof snapshot.dialogOuterId === "number" ? snapshot.dialogOuterId : null
      },
      item: {
        id: snapshot.id || "",
        calendarId: snapshot.calendarId || "",
        type: snapshot.type || "event",
        format: "ical",
        item: snapshot.item
      },
      event: {},
      metadata: {}
    });
    refreshCalendarWizardContextSnapshot(context);

    const url = new URL(browser.runtime.getURL("ui/talkDialog.html"));
    url.searchParams.set("contextId", contextId);
    L("talk wizard open", {
      contextId,
      editorRef: context.editorRef || null,
      calendarId: context.item?.calendarId || "",
      itemId: context.item?.id || ""
    });
    await browser.windows.create({
      type: "popup",
      url: url.toString(),
      width: TALK_POPUP_WIDTH,
      height: TALK_POPUP_HEIGHT
    });
  }catch(e){
    console.error("[NCBG] ncCalToolbar.onClicked error", e);
  }
});

browser.ncCalToolbar?.onRoomCleanup?.addListener((event) => {
  try{
    handleNcCalToolbarRoomCleanup(event || {});
  }catch(e){
    console.error("[NCBG] ncCalToolbar.onRoomCleanup handler failed", e);
  }
});

const ROOM_META_KEY = "nctalkRoomMeta";
const EVENT_TOKEN_MAP_KEY = "nctalkEventTokenMap";
let DEBUG_ENABLED = false;
let ROOM_META = {};
let EVENT_TOKEN_MAP = {};
const TALK_LINK_REGEX = /(https?:\/\/[^\s"'<>]+\/call\/([A-Za-z0-9_-]+))/i;
const TALK_POPUP_WIDTH = 540;
const TALK_POPUP_HEIGHT = 860;
const SHARING_POPUP_WIDTH = 660;
const SHARING_POPUP_HEIGHT = 760;
const CALENDAR_WIZARD_CONTEXT_TTL_MS = 30 * 60 * 1000;
const CALENDAR_WIZARD_CONTEXTS = new Map();
const ROOM_CLEANUP_DELETE_DELAY_MS = 15 * 1000;
const ROOM_CLEANUP_BY_TOKEN = new Map();
const ROOM_CLEANUP_BY_EDITOR = new Map();
const INVITEE_SYNC_IN_FLIGHT = new Set();
const DELEGATION_IN_FLIGHT = new Set();
const FALLBACK_PASSWORD_POLICY = {
  hasPolicy: false,
  minLength: null,
  apiGenerateUrl: null
};

(async () => {
  try{
    if (NCSharingStorage?.migrateLegacySharingKeys){
      await NCSharingStorage.migrateLegacySharingKeys();
    }
    const stored = await browser.storage.local.get(["debugEnabled", ROOM_META_KEY, EVENT_TOKEN_MAP_KEY]);
    DEBUG_ENABLED = !!stored.debugEnabled;
    ROOM_META = stored[ROOM_META_KEY] || {};
    EVENT_TOKEN_MAP = stored[EVENT_TOKEN_MAP_KEY] || {};
    if (DEBUG_ENABLED){
      try{
        const manifest = browser.runtime.getManifest();
        console.log("[NCBG] startup", {
          version: manifest?.version || "",
          hasApiNcCalToolbar: !!browser?.ncCalToolbar,
          hasApiCalendarItems: !!browser?.calendar?.items
        });
      }catch(e){
        console.error("[NCBG] startup manifest probe failed", e);
      }
    }
  }catch(_){ }
})();
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.prototype.hasOwnProperty.call(changes, "debugEnabled")){
    DEBUG_ENABLED = !!changes.debugEnabled.newValue;
  }
  if (Object.prototype.hasOwnProperty.call(changes, ROOM_META_KEY)){
    ROOM_META = changes[ROOM_META_KEY].newValue || {};
  }
  if (Object.prototype.hasOwnProperty.call(changes, EVENT_TOKEN_MAP_KEY)){
    EVENT_TOKEN_MAP = changes[EVENT_TOKEN_MAP_KEY].newValue || {};
  }
});
/**
 * Log helper gated by the debug flag.
 * @param {...any} a
 */
function L(...a){
  if (!DEBUG_ENABLED) return;
  try{
    console.log("[NCBG]", ...a);
  }catch(_){ }
}

function makeRoomCleanupEditorKey(editorRef){
  const ref = editorRef && typeof editorRef === "object" ? editorRef : {};
  if (typeof ref.dialogOuterId === "number"){
    return `dialog:${ref.dialogOuterId}`;
  }
  if (typeof ref.windowId === "number"){
    return `window:${ref.windowId}`;
  }
  return "";
}

function removeRoomCleanupEntry(token, reason = ""){
  if (!token) return;
  const entry = ROOM_CLEANUP_BY_TOKEN.get(token);
  if (!entry){
    return;
  }
  if (entry.timerId){
    try{
      clearTimeout(entry.timerId);
    }catch(_){ }
    entry.timerId = null;
  }
  ROOM_CLEANUP_BY_TOKEN.delete(token);
  if (entry.editorKey && ROOM_CLEANUP_BY_EDITOR.get(entry.editorKey) === token){
    ROOM_CLEANUP_BY_EDITOR.delete(entry.editorKey);
  }
  L("room cleanup cleared", { token: shortToken(token), reason: reason || "" });
}

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
  const delay = Math.max(0, Number(delayMs) || 0);
  entry.timerId = setTimeout(() => {
    (async () => {
      const current = ROOM_CLEANUP_BY_TOKEN.get(token);
      if (!current){
        return;
      }
      removeRoomCleanupEntry(token, `delete:${reason || ""}`);
      try{
        L("room cleanup delete", { token: shortToken(token), reason: reason || "" });
        await deleteTalkRoom({ token });
        await deleteRoomMeta(token);
      }catch(e){
        console.error("[NCBG] room cleanup delete failed", e);
      }
    })().catch((e) => console.error("[NCBG] room cleanup delete failed", e));
  }, delay);
  L("room cleanup scheduled", { token: shortToken(token), delayMs: delay, reason: reason || "" });
}

function handleNcCalToolbarRoomCleanup(event){
  const token = typeof event?.token === "string" ? event.token.trim() : "";
  const action = typeof event?.action === "string" ? event.action : "";
  const reason = typeof event?.reason === "string" ? event.reason : "";
  if (!token || !action){
    return;
  }
  L("ncCalToolbar.onRoomCleanup", {
    token: shortToken(token),
    action,
    reason
  });
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
 * Shorten a token for log output.
 * @param {string} token
 * @param {{keepStart?:number, keepEnd?:number}} options
 * @returns {string}
 */
function shortToken(token, { keepStart = 4, keepEnd = 3 } = {}){
  if (!token) return "";
  const str = String(token);
  if (str.length <= keepStart + keepEnd + 3){
    return str;
  }
  return str.slice(0, keepStart) + "..." + str.slice(str.length - keepEnd);
}

/**
 * Shorten a string identifier for logs.
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
function shortId(value, max = 12){
  if (value == null) return "";
  const str = String(value);
  if (str.length <= max){
    return str;
  }
  return str.slice(0, max) + "...";
}

/**
 * Resolve a password policy URL against the base URL.
 * @param {string} value
 * @param {string} baseUrl
 * @returns {string|null}
 */
function resolvePolicyUrl(value, baseUrl){
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try{
    if (baseUrl){
      return new URL(raw, baseUrl).toString();
    }
    return new URL(raw).toString();
  }catch(_){
    return null;
  }
}

/**
 * Normalize the password policy payload from capabilities.
 * @param {object} policy
 * @param {string} baseUrl
 * @returns {{hasPolicy:boolean,minLength:number|null,apiGenerateUrl:string|null}}
 */
function normalizePasswordPolicy(policy, baseUrl){
  if (!policy || typeof policy !== "object"){
    return { ...FALLBACK_PASSWORD_POLICY };
  }
  const minRaw = policy.minLength ?? policy.min_length ?? policy.minimumLength ?? policy.minimum_length;
  const minLength = Number.isFinite(Number(minRaw)) && Number(minRaw) > 0
    ? Math.floor(Number(minRaw))
    : null;
  const generateRaw = policy?.api?.generate ?? policy?.api?.generateUrl ?? policy?.apiGenerateUrl ?? policy?.api?.generate_url;
  const apiGenerateUrl = resolvePolicyUrl(generateRaw, baseUrl);
  return {
    hasPolicy: true,
    minLength,
    apiGenerateUrl
  };
}

/**
 * Fetch the live password policy from Nextcloud.
 * @returns {Promise<{hasPolicy:boolean,minLength:number|null,apiGenerateUrl:string|null}>}
 */
  async function fetchPasswordPolicy(){
    try{
    const { baseUrl, user, appPass } = await NCCore.getOpts();
    if (!baseUrl || !user || !appPass){
      console.error("[NCBG] password policy missing credentials");
      L("password policy fallback", { reason: "credentials_missing" });
      return { ...FALLBACK_PASSWORD_POLICY };
    }
    if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
      const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
      if (!ok){
        console.error("[NCBG] password policy host permission missing", baseUrl);
        L("password policy fallback", { reason: "permission_missing" });
        return { ...FALLBACK_PASSWORD_POLICY };
      }
    }
    const url = baseUrl + "/ocs/v2.php/cloud/capabilities?format=json";
    const headers = {
      "OCS-APIRequest": "true",
      "Authorization": NCOcs.buildAuthHeader(user, appPass),
      "Accept": "application/json"
    };
    const response = await NCOcs.ocsRequest({ url, method: "GET", headers, acceptJson: true });
    if (!response.ok){
      console.error("[NCBG] password policy fetch failed", response.errorMessage || response.status);
      L("password policy fallback", { reason: "http_error", status: response.status });
      return { ...FALLBACK_PASSWORD_POLICY };
    }
    const capabilities = response.data?.ocs?.data?.capabilities || {};
    const policyRaw = capabilities.password_policy || capabilities.passwordPolicy || null;
    if (!policyRaw || typeof policyRaw !== "object"){
      L("password policy fallback", { reason: "policy_missing" });
      return { ...FALLBACK_PASSWORD_POLICY };
    }
    const normalized = normalizePasswordPolicy(policyRaw, baseUrl);
    L("password policy fetched", {
      hasPolicy: normalized.hasPolicy,
      minLength: normalized.minLength,
      apiGenerateUrl: normalized.apiGenerateUrl || ""
    });
    return normalized;
  }catch(err){
    console.error("[NCBG] password policy fetch error", err);
    L("password policy fallback", { reason: "exception" });
    return { ...FALLBACK_PASSWORD_POLICY };
  }
}

/**
 * Request a generated password via the Nextcloud policy API.
 * @param {object} policy
 * @returns {Promise<{ok:boolean,password?:string,error?:string}>}
 */
async function generatePasswordViaPolicy(policy){
  try{
    const { baseUrl, user, appPass } = await NCCore.getOpts();
    if (!baseUrl || !user || !appPass){
      console.error("[NCBG] password generate missing credentials");
      return { ok: false, error: "credentials_missing" };
    }
    if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
      const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
      if (!ok){
        console.error("[NCBG] password generate host permission missing", baseUrl);
        return { ok: false, error: "permission_missing" };
      }
    }
    const apiUrl = resolvePolicyUrl(policy?.apiGenerateUrl, baseUrl);
    if (!apiUrl){
      return { ok: false, error: "generate_url_missing" };
    }
    L("password generate request", { apiGenerateUrl: apiUrl });
    const headers = {
      "OCS-APIRequest": "true",
      "Authorization": NCOcs.buildAuthHeader(user, appPass),
      "Accept": "application/json"
    };
    const response = await NCOcs.ocsRequest({ url: apiUrl, method: "GET", headers, acceptJson: true });
    if (!response.ok){
      console.error("[NCBG] password generate failed", response.errorMessage || response.status);
      return { ok: false, error: response.errorMessage || "http_error" };
    }
    const password = response.data?.ocs?.data?.password;
    if (!password){
      console.error("[NCBG] password generate missing password field");
      return { ok: false, error: "password_missing" };
    }
    const generated = String(password);
    L("password generate success", { length: generated.length });
    return { ok: true, password: generated };
  }catch(err){
    console.error("[NCBG] password generate error", err);
    return { ok: false, error: err?.message || String(err) };
  }
}


/**
 * Create a localized Error using the i18n catalog.
 */
function localizedError(key, substitutions = []){
  const message = bgI18n(key, substitutions);
  return new Error(message || key);
}

browser.composeAction.onClicked.addListener(async (tab) => {
  try{
    const popupUrl = browser.runtime.getURL(`ui/nextcloudSharingWizard.html?tabId=${tab.id}`);
    await browser.windows.create({
      url: popupUrl,
      type: "popup",
      width: SHARING_POPUP_WIDTH,
      height: SHARING_POPUP_HEIGHT
    });
  }catch(e){
    console.error("[NCBG] composeAction.onClicked", e);
  }
});

function refreshCalendarWizardContextSnapshot(entry){
  if (!entry?.item?.item){
    return;
  }
  const ical = String(entry.item.item || "");
  try{
    entry.metadata = extractTalkMetadataFromIcal(ical) || {};
  }catch(_){
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
  }catch(_){
    entry.event = entry.event || {};
  }
}

// Calendar event editor toolbar integration is provided via the minimal custom
// experiment `ncCalToolbar` which inserts the button and delivers an iCal snapshot
// on click.

/**
 * Merge and persist room metadata for a Talk token.
 * @param {string} token
 * @param {object} data
 * @returns {Promise<void>}
 */
async function setRoomMeta(token, data = {}){
  if (!token) return;
  const next = Object.assign({}, ROOM_META[token], data, { updated: Date.now() });
  ROOM_META[token] = next;
  try{
    await browser.storage.local.set({ [ROOM_META_KEY]: ROOM_META });
  }catch(e){
    console.error("[NCBG] setRoomMeta", e);
  }
}

/**
 * Remove cached room metadata for a token.
 * @param {string} token
 * @returns {Promise<void>}
 */
async function deleteRoomMeta(token){
  if (!token || !ROOM_META[token]) return;
  delete ROOM_META[token];
  try{
    await browser.storage.local.set({ [ROOM_META_KEY]: ROOM_META });
  }catch(e){
    console.error("[NCBG] deleteRoomMeta", e);
  }
}

/**
 * Read cached room metadata for a token.
 * @param {string} token
 * @returns {object|null}
 */
function getRoomMeta(token){
  if (!token) return null;
  return ROOM_META[token] || null;
}

/**
 * Build the storage key for a calendar item mapping.
 * @param {string} calendarId
 * @param {string} itemId
 * @returns {string}
 */
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
 * @returns {{token:string,url?:string,updated?:number}|null}
 */
function getEventTokenEntry(calendarId, itemId){
  const key = makeEventMapKey(calendarId, itemId);
  if (!key) return null;
  return EVENT_TOKEN_MAP[key] || null;
}

/**
 * Persist the token mapping for a calendar item.
 * @param {string} calendarId
 * @param {string} itemId
 * @param {{token:string,url?:string}} entry
 * @returns {Promise<void>}
 */
async function setEventTokenEntry(calendarId, itemId, entry){
  const key = makeEventMapKey(calendarId, itemId);
  if (!key || !entry?.token){
    return;
  }
  const next = Object.assign({}, EVENT_TOKEN_MAP, {
    [key]: {
      token: entry.token,
      url: entry.url || "",
      updated: Date.now()
    }
  });
  EVENT_TOKEN_MAP = next;
  try{
    await browser.storage.local.set({ [EVENT_TOKEN_MAP_KEY]: next });
  }catch(e){
    console.error("[NCBG] event token map save failed", e);
  }
}

/**
 * Remove the token mapping for a calendar item.
 * @param {string} calendarId
 * @param {string} itemId
 * @returns {Promise<void>}
 */
async function removeEventTokenEntry(calendarId, itemId){
  const key = makeEventMapKey(calendarId, itemId);
  if (!key || !EVENT_TOKEN_MAP[key]){
    return;
  }
  const next = Object.assign({}, EVENT_TOKEN_MAP);
  delete next[key];
  EVENT_TOKEN_MAP = next;
  try{
    await browser.storage.local.set({ [EVENT_TOKEN_MAP_KEY]: next });
  }catch(e){
    console.error("[NCBG] event token map remove failed", e);
  }
}

/**
 * Decode a base64 avatar into pixel data.
 * @param {{base64:string,mime?:string}} options
 * @returns {Promise<{width:number,height:number,pixels:number[],byteLength:number}>}
 */
async function decodeAvatarPixels({ base64, mime } = {}){
  const clean = String(base64 || "").replace(/\s+/g, "");
  if (!clean){
    throw localizedError("error_avatar_data_missing");
  }
  const binary = atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++){
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  const blob = new Blob([bytes], { type: mime || "image/png" });
  const hidden = getHiddenWindow();
  let canvas = null;
  let ctx = null;
  if (typeof createImageBitmap === "function"){
    try{
      const bitmap = await createImageBitmap(blob);
      canvas = createScratchCanvas(bitmap.width || 1, bitmap.height || 1);
      ctx = canvas.getContext("2d");
      if (!ctx){
        throw localizedError("error_canvas_context_missing");
      }
      ctx.drawImage(bitmap, 0, 0);
      if (typeof bitmap.close === "function"){
        try { bitmap.close(); } catch (_){ }
      }
    }catch(e){
      canvas = null;
      ctx = null;
    }
  }
  if (!canvas){
    if (!hidden || !hidden.document || typeof hidden.document.createElement !== "function"){
      throw localizedError("error_image_decode_failed");
    }
    const img = hidden.document.createElement("img");
    img.src = "data:" + (mime || "image/png") + ";base64," + clean;
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (event) => reject(event || localizedError("error_image_load_failed"));
    });
    const width = img.naturalWidth || img.width || 0;
    const height = img.naturalHeight || img.height || 0;
    if (!width || !height){
      throw localizedError("error_image_size_unknown");
    }
    canvas = createScratchCanvas(width, height);
    ctx = canvas.getContext("2d");
    if (!ctx){
      throw localizedError("error_canvas_context_missing");
    }
    ctx.drawImage(img, 0, 0);
  }
  const finalCtx = ctx || canvas.getContext("2d");
  if (!finalCtx){
    throw localizedError("error_canvas_context_missing");
  }
  const width = canvas.width || 0;
  const height = canvas.height || 0;
  const imageData = finalCtx.getImageData(0, 0, width, height);
  const sourcePixels = imageData && imageData.data ? imageData.data : null;
  if (!sourcePixels || typeof sourcePixels.length !== "number"){
    throw localizedError("error_pixel_data_missing");
  }
  const plain = Array.from(sourcePixels);
  const byteLength = sourcePixels.byteLength || plain.length;
  return {
    width,
    height,
    pixels: plain,
    byteLength
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  return (async () => {
    L("msg", msg.type, { hasPayload: !!msg.payload });
  if (msg.type === "debug:log"){
    const source = msg.payload?.source ? String(msg.payload.source) : "frontend";
    const text = msg.payload?.text ? String(msg.payload.text) : "";
    const extras = Array.isArray(msg.payload?.details)
      ? msg.payload.details
      : (msg.payload?.details != null ? [msg.payload.details] : []);
    const channelRaw = msg.payload?.channel ? String(msg.payload.channel) : "NCDBG";
    const channel = channelRaw.toUpperCase();
    const label = msg.payload?.label ? String(msg.payload.label) : source;
    const prefix = label ? `[${channel}][${label}]` : `[${channel}]`;
    if (DEBUG_ENABLED){
      try{
        console.log(prefix, text, ...extras);
      }catch(_){ }
    }
    return { ok:true };
  }
  if (msg.type === "passwordPolicy:fetch"){
    const policy = await fetchPasswordPolicy();
    return { ok:true, policy };
  }
  if (msg.type === "passwordPolicy:generate"){
    return await generatePasswordViaPolicy(msg?.payload?.policy || {});
  }
  if (msg.type === "talkMenu:newPublicSubmit"){
    try {
      const out = await createTalkPublicRoom(msg.payload);
      return { ok:true, url: out.url, token: out.token, fallback: !!out.fallback, reason: out.reason };
    } catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talkMenu:getConfig"){
    try{
      const config = await NCCore.getOpts();
      return { ok:true, config };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talkMenu:decodeAvatar"){
    try{
      const payload = msg.payload || msg;
      const result = await decodeAvatarPixels({ base64: payload?.base64, mime: payload?.mime });
      return {
        ok:true,
        width: result.width,
        height: result.height,
        byteLength: result.byteLength,
        pixels: result.pixels
      };
    }catch(e){
      L("decodeAvatar runtime error", e?.message || String(e));
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talkMenu:updateLobby"){
    try{
      await updateTalkLobby(msg.payload);
      return { ok:true };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talkMenu:delegateModerator"){
    try{
      const result = await delegateRoomModerator(msg.payload || {});
      return { ok:true, result };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talk:delegateModerator"){
    try{
      const result = await delegateRoomModerator(msg.payload || {});
      return { ok:true, result };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talkMenu:searchUsers"){
    try{
      const users = await searchSystemAddressbook(msg.payload || {});
      return { ok:true, users };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talk:searchUsers"){
    try{
      const users = await searchSystemAddressbook(msg.payload || {});
      return { ok:true, users };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talk:initDialog"){
    const contextId = msg.contextId ?? msg?.payload?.contextId;
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    refreshCalendarWizardContextSnapshot(context);
    return { ok:true };
  }
  if (msg.type === "talk:getEventSnapshot"){
    const contextId = msg.contextId ?? msg?.payload?.contextId;
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    refreshCalendarWizardContextSnapshot(context);
    return {
      ok:true,
      event: context.event || {},
      metadata: context.metadata || {}
    };
  }
  if (msg.type === "talk:applyEventFields"){
    const contextId = msg.contextId ?? msg?.payload?.contextId;
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    const fields = msg.fields ?? msg?.payload?.fields ?? {};
    try{
      L("talk:applyEventFields", {
        contextId,
        calendarId: context.item?.calendarId || "",
        itemId: context.item?.id || "",
        hasTitle: typeof fields.title === "string",
        hasLocation: typeof fields.location === "string",
        hasDescription: typeof fields.description === "string"
      });
      const updates = {};
      if (typeof fields.title === "string"){
        updates["SUMMARY"] = fields.title;
      }
      if (typeof fields.location === "string"){
        updates["LOCATION"] = fields.location;
      }
      if (typeof fields.description === "string"){
        updates["DESCRIPTION"] = fields.description;
      }
      const baseIcal = context.item?.item || "";
      const { ical } = applyIcalPropertyUpdates(baseIcal, updates);
      context.item.item = ical;
      refreshCalendarWizardContextSnapshot(context);

      if (!browser?.ncCalToolbar?.applyEventFields){
        console.error("[NCBG] ncCalToolbar.applyEventFields missing");
        throw localizedError("talk_error_apply_failed");
      }
      const editor = context.editorRef || {};
      const editorRef = {};
      if (typeof editor.windowId === "number"){
        editorRef.windowId = editor.windowId;
      }
      if (typeof editor.dialogOuterId === "number"){
        editorRef.dialogOuterId = editor.dialogOuterId;
      }
      if (!Object.keys(editorRef).length){
        throw new Error(bgI18n("talk_error_editor_context_missing"));
      }
      const fieldsPayload = {};
      if (typeof fields.title === "string"){
        fieldsPayload.title = fields.title;
      }
      if (typeof fields.location === "string"){
        fieldsPayload.location = fields.location;
      }
      if (typeof fields.description === "string"){
        fieldsPayload.description = fields.description;
      }
      const applyResponse = await browser.ncCalToolbar.applyEventFields({
        editor: editorRef,
        fields: fieldsPayload
      });
      if (!applyResponse?.ok){
        throw new Error(applyResponse?.error || bgI18n("talk_error_apply_failed"));
      }
      if ((typeof fields.title === "string" && applyResponse?.applied?.title !== true)
        || (typeof fields.location === "string" && applyResponse?.applied?.location !== true)
        || (typeof fields.description === "string" && applyResponse?.applied?.description !== true)){
        throw new Error(bgI18n("talk_error_apply_failed"));
      }
      return { ok:true };
    }catch(e){
      L("talk:applyEventFields error", { contextId, error: e?.message || String(e) });
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talk:createRoom"){
    try{
      const result = await createTalkPublicRoom(msg.payload);
      return { ok:true, result };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talk:trackRoom"){
    try{
      const payload = msg.payload || {};
      const token = msg.token ?? payload.token;
      if (!token){
        return { ok:false, error: "token required" };
      }
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(msg, "lobbyEnabled") || Object.prototype.hasOwnProperty.call(payload, "lobbyEnabled")){
        updates.lobbyEnabled = !!(msg.lobbyEnabled ?? payload.lobbyEnabled);
      }
      if (Object.prototype.hasOwnProperty.call(msg, "eventConversation") || Object.prototype.hasOwnProperty.call(payload, "eventConversation")){
        updates.eventConversation = !!(msg.eventConversation ?? payload.eventConversation);
      }
      const startRaw = msg.startTimestamp ?? payload.startTimestamp;
      if (typeof startRaw === "number" && Number.isFinite(startRaw)){
        updates.startTimestamp = startRaw;
      }
      await setRoomMeta(token, updates);
      return { ok:true };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talk:applyMetadata"){
    const contextId = msg.contextId ?? msg?.payload?.contextId;
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    const meta = msg.metadata ?? msg?.payload?.metadata ?? {};
    try{
      L("talk:applyMetadata", {
        contextId,
        calendarId: context.item?.calendarId || "",
        itemId: context.item?.id || "",
        hasToken: typeof meta?.token === "string" && !!meta.token,
        hasUrl: typeof meta?.url === "string" && !!meta.url,
        lobby: Object.prototype.hasOwnProperty.call(meta, "lobbyEnabled") ? !!meta.lobbyEnabled : null,
        hasStart: typeof meta?.startTimestamp === "number" && Number.isFinite(meta.startTimestamp)
      });
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(meta, "token")){
        updates["X-NCTALK-TOKEN"] = meta.token ? String(meta.token) : null;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "url")){
        updates["X-NCTALK-URL"] = meta.url ? String(meta.url) : null;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "lobbyEnabled")){
        updates["X-NCTALK-LOBBY"] = meta.lobbyEnabled ? "TRUE" : "FALSE";
      }
      if (Object.prototype.hasOwnProperty.call(meta, "startTimestamp")){
        if (typeof meta.startTimestamp === "number" && Number.isFinite(meta.startTimestamp)){
          updates["X-NCTALK-START"] = String(Math.floor(meta.startTimestamp));
        }else{
          updates["X-NCTALK-START"] = null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(meta, "eventConversation")){
        updates["X-NCTALK-EVENT"] = meta.eventConversation ? "event" : "standard";
      }
      if (Object.prototype.hasOwnProperty.call(meta, "objectId")){
        updates["X-NCTALK-OBJECTID"] = meta.objectId ? String(meta.objectId) : null;
      }
      const hasAddUsers = Object.prototype.hasOwnProperty.call(meta, "addUsers");
      const hasAddGuests = Object.prototype.hasOwnProperty.call(meta, "addGuests");
      if (hasAddUsers){
        updates["X-NCTALK-ADD-USERS"] = meta.addUsers ? "TRUE" : "FALSE";
      }
      if (hasAddGuests){
        updates["X-NCTALK-ADD-GUESTS"] = meta.addGuests ? "TRUE" : "FALSE";
      }
      if (hasAddUsers || hasAddGuests){
        updates["X-NCTALK-ADD-PARTICIPANTS"] = (meta.addUsers || meta.addGuests) ? "TRUE" : "FALSE";
      }else if (Object.prototype.hasOwnProperty.call(meta, "addParticipants")){
        updates["X-NCTALK-ADD-PARTICIPANTS"] = meta.addParticipants ? "TRUE" : "FALSE";
      }
      if (Object.prototype.hasOwnProperty.call(meta, "delegateId")){
        updates["X-NCTALK-DELEGATE"] = meta.delegateId ? String(meta.delegateId) : null;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "delegateName")){
        updates["X-NCTALK-DELEGATE-NAME"] = meta.delegateName ? String(meta.delegateName) : null;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "delegated")){
        updates["X-NCTALK-DELEGATED"] = meta.delegated ? "TRUE" : "FALSE";
      }
      if (meta?.delegateId && meta.delegated !== true){
        updates["X-NCTALK-DELEGATE-READY"] = "TRUE";
      }

      const baseIcal = context.item?.item || "";
      const { ical } = applyIcalPropertyUpdates(baseIcal, updates);
      context.item.item = ical;
      refreshCalendarWizardContextSnapshot(context);

      if (!browser?.ncCalToolbar?.setItemProperties){
        console.error("[NCBG] ncCalToolbar.setItemProperties missing");
        throw localizedError("talk_error_apply_failed");
      }
      const editor = context.editorRef || {};
      const editorRef = {};
      if (typeof editor.windowId === "number"){
        editorRef.windowId = editor.windowId;
      }
      if (typeof editor.dialogOuterId === "number"){
        editorRef.dialogOuterId = editor.dialogOuterId;
      }
      if (!Object.keys(editorRef).length){
        throw new Error(bgI18n("talk_error_editor_context_missing"));
      }
      const propResponse = await browser.ncCalToolbar.setItemProperties({
        editor: editorRef,
        properties: updates
      });
      if (!propResponse?.ok){
        throw new Error(propResponse?.error || bgI18n("talk_error_apply_failed"));
      }

      if (meta?.token && context.item?.calendarId && context.item?.id){
        await setEventTokenEntry(context.item.calendarId, context.item.id, { token: meta.token, url: meta.url || "" });
      }
      return { ok:true };
    }catch(e){
      if (meta?.token){
        try{
          await deleteTalkRoom({ token: meta.token });
          await deleteRoomMeta(meta.token);
        }catch(_){}
      }
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talk:registerCleanup"){
    const contextId = msg.contextId ?? msg?.payload?.contextId;
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    const token = msg.token ?? msg?.payload?.token;
    if (!token){
      return { ok:false, error: "token required" };
    }
    const info = msg.info ?? msg?.payload?.info ?? {};
    try{
      const editorRef = context.editorRef || {};
      const editorKey = makeRoomCleanupEditorKey(editorRef);
      if (!editorKey){
        return { ok:false, error: bgI18n("talk_error_editor_context_missing") };
      }

      const previousToken = ROOM_CLEANUP_BY_EDITOR.get(editorKey);
      if (previousToken && previousToken !== token){
        scheduleRoomCleanupDelete(previousToken, "superseded", 0);
      }

      ROOM_CLEANUP_BY_EDITOR.set(editorKey, token);
      ROOM_CLEANUP_BY_TOKEN.set(token, {
        token,
        editorKey,
        info: info || {},
        registered: Date.now(),
        timerId: null
      });

      if (!browser?.ncCalToolbar?.registerRoomCleanup){
        console.error("[NCBG] ncCalToolbar.registerRoomCleanup missing");
        removeRoomCleanupEntry(token, "registerRoomCleanup_missing");
        return { ok:false, error: bgI18n("talk_error_apply_failed") };
      }
      const resp = await browser.ncCalToolbar.registerRoomCleanup({
        editor: editorRef,
        token
      });
      if (!resp?.ok){
        console.error("[NCBG] ncCalToolbar.registerRoomCleanup failed", resp?.error || "");
        removeRoomCleanupEntry(token, "registerRoomCleanup_failed");
        return { ok:false, error: bgI18n("talk_error_apply_failed") };
      }

      deleteCalendarWizardContext(contextId);
      return { ok:true };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "options:testConnection"){
    try{
      const result = await NCCore.testCredentials(msg.payload || {});
      if (result.ok){
        return { ok:true, message: result.message || "", version: result.version || "" };
      }
      return { ok:false, error: result.message || bgI18n("error_credentials_missing"), code: result.code || "" };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "options:loginFlowStart"){
    try{
      const baseUrl = NCCore.normalizeBaseUrl(msg.payload?.baseUrl || "");
      if (!baseUrl){
        return { ok:false, error: bgI18n("options_loginflow_missing") };
      }
      const start = await NCCore.startLoginFlow(baseUrl);
      return {
        ok:true,
        loginUrl: start.loginUrl,
        pollEndpoint: start.pollEndpoint,
        pollToken: start.pollToken
      };
    }catch(e){
      return { ok:false, error: e?.message || bgI18n("options_loginflow_failed") };
    }
  }
  if (msg.type === "options:loginFlowComplete"){
    try{
      const pollEndpoint = msg.payload?.pollEndpoint || "";
      const pollToken = msg.payload?.pollToken || "";
      if (!pollEndpoint || !pollToken){
        return { ok:false, error: bgI18n("options_loginflow_failed") };
      }
      const creds = await NCCore.completeLoginFlow({ pollEndpoint, pollToken });
      return { ok:true, user: creds.loginName, appPass: creds.appPassword };
    }catch(e){
      return { ok:false, error: e?.message || bgI18n("options_loginflow_failed") };
    }
  }
  if (msg.type === "sharing:insertHtml"){
    try{
      const tabId = msg.payload?.tabId;
      const html = msg.payload?.html || "";
      if (!tabId || !html){
        return { ok:false, error: "tab/html missing" };
      }
      const details = await browser.compose.getComposeDetails(tabId);
      const currentBody = details.body || "";
      const blockSegment = `<br>${html}<br><br>`;
      const bodyMatch = currentBody.match(/<body[^>]*>/i);
      let newBody = "";
      if (bodyMatch){
        const insertIndex = bodyMatch.index + bodyMatch[0].length;
        newBody = currentBody.slice(0, insertIndex) + blockSegment + currentBody.slice(insertIndex);
      }else{
        newBody = blockSegment + currentBody;
      }
      await browser.compose.setComposeDetails(tabId, { body: newBody, isPlainText: false });
      return { ok:true };
    }catch(e){
      return { ok:false, error: e?.message || String(e) };
    }
  }
  })();
});

/**
 * Update lobby/start time based on a calendar event change.
 * @param {{token:string,startTimestamp?:number,delegateId?:string,delegated?:boolean,lobbyEnabled?:boolean}} payload
 * @returns {Promise<{ok:boolean,skipped?:boolean,reason?:string,error?:string}>}
 */
async function applyCalendarLobbyUpdate(payload = {}){
  const token = payload?.token;
  if (!token){
    return { ok:false, error: bgI18n("error_room_token_missing") };
  }
  const meta = getRoomMeta(token) || {};
  const { user: currentUserRaw } = await NCCore.getOpts();
  const delegateIdRaw = (payload?.delegateId ?? meta.delegateId ?? "").trim();
  const delegateTarget = delegateIdRaw.toLowerCase();
  const currentUser = (currentUserRaw || "").trim().toLowerCase();
  const delegated = payload?.delegated === true || meta.delegated === true;
  const incomingStart = typeof payload?.startTimestamp === "number" ? payload.startTimestamp : null;
  const metaStart = typeof meta.startTimestamp === "number" ? meta.startTimestamp : null;

  if (DEBUG_ENABLED){
    L("calendar lobby update payload", {
      token: shortToken(token),
      delegate: delegateTarget ? shortId(delegateTarget, 20) : "",
      delegated,
      startTimestamp: incomingStart,
      metaStart
    });
  }

  if (payload?.lobbyEnabled === false || meta.lobbyEnabled === false){
    return { ok:false, skipped:true, reason:"lobbyDisabled" };
  }

  if (delegateTarget && currentUser && delegateTarget !== currentUser){
    if (delegated){
      L("calendar lobby update skipped (delegate mismatch)", {
        token: shortToken(token),
        delegate: delegateIdRaw || meta.delegateId || "",
        currentUser: currentUserRaw || ""
      });
      return { ok:false, skipped:true, reason:"delegateMismatch" };
    }
    L("calendar lobby update by owner before delegation", {
      token: shortToken(token),
      delegate: delegateIdRaw || meta.delegateId || "",
      currentUser: currentUserRaw || ""
    });
  }

  const startTs = incomingStart ?? metaStart;
  if (typeof startTs !== "number"){
    return { ok:false, error: bgI18n("error_unknown_utility_request") };
  }
  if (metaStart === startTs){
    L("calendar lobby update skipped (unchanged start)", {
      token: shortToken(token),
      startTimestamp: startTs
    });
    return { ok:true, skipped:true, reason:"startUnchanged" };
  }

  L("calendar lobby update apply", { token: shortToken(token), startTimestamp: startTs });
  await updateTalkLobby({
    token,
    enableLobby: true,
    startTimestamp: startTs
  });
  await setRoomMeta(token, {
    lobbyEnabled: true,
    startTimestamp: startTs
  });
  L("calendar lobby update success", { token: shortToken(token), startTimestamp: startTs });
  return { ok:true };
}

/**
 * Delegate moderator role after calendar changes when ready.
 * @param {{token:string,delegateId:string,delegateName?:string}} payload
 * @returns {Promise<{ok:boolean,skipped?:boolean,reason?:string,error?:string,result?:object}>}
 */
async function applyCalendarDelegation(payload = {}){
  const token = payload?.token;
  const delegateId = payload?.delegateId;
  if (!token || !delegateId){
    return { ok:false, error: bgI18n("error_delegation_data_missing") };
  }
  const { user } = await NCCore.getOpts();
  const targetNorm = String(delegateId).trim().toLowerCase();
  const currentNorm = (user || "").trim().toLowerCase();
  if (targetNorm === currentNorm){
    L("calendar delegation skipped (same user)", { token: shortToken(token), delegate: delegateId });
    return { ok:false, skipped:true, reason:"sameUser" };
  }
  const result = await delegateRoomModerator({ token, newModerator: delegateId });
  await setRoomMeta(token, {
    delegated: true,
    delegateId,
    delegateName: payload?.delegateName || delegateId
  });
  return { ok:true, result };
}

/**
 * Unfold iCalendar lines (continuations starting with space or tab).
 * @param {string} ical
 * @returns {string}
 */
function unfoldIcal(ical){
  if (!ical) return "";
  return String(ical).replace(/\r?\n[ \t]/g, "");
}

/**
 * Parse a single iCalendar content line into name/params/value.
 * @param {string} line
 * @returns {{name:string,params:Object,value:string}|null}
 */
function parseIcalLine(line){
  if (!line) return null;
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = left.split(";");
  const name = parts.shift();
  if (!name) return null;
  const params = {};
  for (const part of parts){
    const [key, val] = part.split("=");
    if (key && val){
      params[key.toUpperCase()] = val;
    }
  }
  return { name: name.toUpperCase(), params, value };
}

/**
 * Unescape iCalendar text values.
 * @param {string} value
 * @returns {string}
 */
function unescapeIcalText(value){
  if (!value) return "";
  return String(value)
    .replace(/\\\\/g, "\\")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";");
}

/**
 * Escape iCalendar TEXT values (RFC 5545) for writing.
 * @param {any} value
 * @returns {string}
 */
function escapeIcalText(value){
  if (value == null) return "";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Fold an iCalendar content line to 75 characters (approximation; RFC uses octets).
 * @param {string} line
 * @param {number} limit
 * @returns {string}
 */
function foldIcalLine(line, limit = 75){
  const raw = String(line || "");
  if (!raw || raw.length <= limit){
    return raw;
  }
  const out = [];
  out.push(raw.slice(0, limit));
  let pos = limit;
  const contLimit = Math.max(1, limit - 1);
  while (pos < raw.length){
    out.push(raw.slice(pos, pos + contLimit));
    pos += contLimit;
  }
  return out.join("\r\n ");
}

/**
 * Extract an e-mail address from a calendar address value.
 * @param {string} value
 * @returns {string}
 */
function extractEmailFromCalAddress(value){
  if (!value) return "";
  let cleaned = unescapeIcalText(value).trim();
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  if (lower.startsWith("mailto:")){
    cleaned = cleaned.slice(7).trim();
  }
  cleaned = cleaned.replace(/^<|>$/g, "");
  const match = cleaned.match(/[^\s<>"]+@[^\s<>"]+/);
  return match ? match[0] : "";
}

/**
 * Extract attendee e-mail addresses from the first VEVENT in an iCal payload.
 * @param {string} ical
 * @returns {string[]}
 */
function extractIcalAttendees(ical){
  if (!ical) return [];
  const lines = unfoldIcal(ical).split(/\r?\n/);
  let inEvent = false;
  let eventIndex = 0;
  const seen = new Map();
  for (const line of lines){
    if (line === "BEGIN:VEVENT"){
      inEvent = true;
      eventIndex++;
      continue;
    }
    if (line === "END:VEVENT"){
      if (inEvent && eventIndex === 1){
        break;
      }
      inEvent = false;
      continue;
    }
    if (!inEvent || eventIndex !== 1){
      continue;
    }
    const parsed = parseIcalLine(line);
    if (!parsed || parsed.name !== "ATTENDEE"){
      continue;
    }
    const valueEmail = extractEmailFromCalAddress(parsed.value || "");
    const paramEmail = extractEmailFromCalAddress(parsed.params?.EMAIL || "");
    const email = valueEmail || paramEmail;
    if (!email) continue;
    const key = email.toLowerCase();
    if (!seen.has(key)){
      seen.set(key, email);
    }
  }
  return Array.from(seen.values());
}

/**
 * Add calendar attendees to a Talk room.
 * @param {{token:string,ical:string,addUsers?:boolean,addGuests?:boolean}} payload
 * @returns {Promise<{ok:boolean,total:number,added:number,failed:number}>}
 */
async function addInviteesToTalkRoom({ token, ical, addUsers = true, addGuests = true } = {}){
  if (!token || !ical){
    return { ok:false, total:0, added:0, failed:0 };
  }
  if (!addUsers && !addGuests){
    L("invitees add skipped (disabled)", { token: shortToken(token) });
    return { ok:true, total:0, added:0, failed:0 };
  }
  const attendees = extractIcalAttendees(ical);
  if (!attendees.length){
    L("invitees add skipped (no attendees)", { token: shortToken(token) });
    return { ok:true, total:0, added:0, failed:0 };
  }
  let contacts = [];
  try{
    if (typeof getSystemAddressbookContacts === "function"){
      contacts = await getSystemAddressbookContacts(false);
    }
  }catch(err){
    console.error("[NCBG] system addressbook lookup failed", err);
    contacts = [];
  }
  const emailToUserId = new Map();
  for (const contact of contacts){
    const emailLower = contact?.emailLower;
    const id = contact?.id;
    if (emailLower && id && !emailToUserId.has(emailLower)){
      emailToUserId.set(emailLower, id);
    }
  }
  let added = 0;
  let failed = 0;
  let users = 0;
  let emails = 0;
  let skippedUsers = 0;
  let skippedGuests = 0;
  for (const email of attendees){
    const lower = email.toLowerCase();
    const userId = emailToUserId.get(lower) || "";
    const source = userId ? "users" : "emails";
    const actorId = userId || email;
    if (userId){
      users += 1;
      if (!addUsers){
        skippedUsers += 1;
        continue;
      }
    }else{
      emails += 1;
      if (!addGuests){
        skippedGuests += 1;
        continue;
      }
    }
    try{
      await addTalkParticipant({ token, actorId, source });
      added += 1;
    }catch(err){
      failed += 1;
      console.error("[NCBG] add participant failed", {
        actor: actorId,
        source,
        error: err?.message || String(err)
      });
    }
  }
  L("invitees add result", {
    token: shortToken(token),
    total: attendees.length,
    addUsers,
    addGuests,
    users,
    emails,
    skippedUsers,
    skippedGuests,
    added,
    failed
  });
  return { ok: failed === 0, total: attendees.length, added, failed };
}

/**
 * Parse a boolean-like property value.
 * @param {string|boolean|number} value
 * @returns {boolean|null}
 */
function parseBooleanProp(value){
  if (typeof value === "boolean") return value;
  if (typeof value === "string"){
    const norm = value.trim().toLowerCase();
    if (norm === "true" || norm === "1" || norm === "yes") return true;
    if (norm === "false" || norm === "0" || norm === "no") return false;
  }
  return null;
}

/**
 * Parse a numeric property value.
 * @param {string|number} value
 * @returns {number|null}
 */
function parseNumberProp(value){
  if (typeof value === "number" && Number.isFinite(value)){
    return value;
  }
  if (typeof value === "string"){
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Calculate the time zone offset for a Date in a specific time zone.
 * @param {string} timeZone
 * @param {Date} date
 * @returns {number|null}
 */
function getTimeZoneOffsetMs(timeZone, date){
  try{
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    const parts = dtf.formatToParts(date);
    const values = {};
    for (const part of parts){
      if (part.type !== "literal"){
        values[part.type] = part.value;
      }
    }
    const asUTC = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second)
    );
    return asUTC - date.getTime();
  }catch(_){
    return null;
  }
}

/**
 * Convert local date parts in a time zone to a UTC timestamp.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {string} tzid
 * @returns {number}
 */
function zonedTimeToUtc(year, month, day, hour, minute, second, tzid){
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = tzid ? getTimeZoneOffsetMs(tzid, new Date(utcGuess)) : null;
  return offset == null ? utcGuess : utcGuess - offset;
}

/**
 * Parse an iCalendar DATE or DATE-TIME into unix seconds.
 * @param {string} rawValue
 * @param {string} tzid
 * @returns {number|null}
 */
function parseIcalDateTime(rawValue, tzid){
  if (!rawValue) return null;
  const value = String(rawValue).trim();
  if (!value) return null;
  const isDateOnly = /^\d{8}$/.test(value);
  const isDateTime = /^\d{8}T\d{6}Z?$/.test(value);
  if (!isDateOnly && !isDateTime){
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  let hour = 0;
  let minute = 0;
  let second = 0;
  if (isDateTime){
    hour = Number(value.slice(9, 11));
    minute = Number(value.slice(11, 13));
    second = Number(value.slice(13, 15));
  }
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)){
    return null;
  }
  const hasZ = value.endsWith("Z");
  if (hasZ || String(tzid || "").toUpperCase() === "UTC"){
    const utc = Date.UTC(year, month - 1, day, hour, minute, second);
    return Math.floor(utc / 1000);
  }
  if (tzid){
    const utc = zonedTimeToUtc(year, month, day, hour, minute, second, tzid);
    return Math.floor(utc / 1000);
  }
  const local = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(local.getTime())){
    return null;
  }
  return Math.floor(local.getTime() / 1000);
}

/**
 * Extract event properties and start/end fields from VEVENT.
 * @param {string} ical
 * @returns {{props:Object,dtStart:{value:string,tzid:string}|null,dtEnd:{value:string,tzid:string}|null}}
 */
function parseIcalEventData(ical){
  const props = {};
  let dtStart = null;
  let dtEnd = null;
  if (!ical) return { props, dtStart, dtEnd };
  const lines = unfoldIcal(ical).split(/\r?\n/);
  let inEvent = false;
  for (const line of lines){
    if (!line) continue;
    if (line === "BEGIN:VEVENT"){
      inEvent = true;
      continue;
    }
    if (line === "END:VEVENT"){
      if (inEvent) break;
      continue;
    }
    if (!inEvent) continue;
    const parsed = parseIcalLine(line);
    if (!parsed) continue;
    const name = parsed.name;
    const value = unescapeIcalText(parsed.value);
    if (name === "DTSTART"){
      dtStart = { value: parsed.value, tzid: parsed.params.TZID || null };
    }else if (name === "DTEND"){
      dtEnd = { value: parsed.value, tzid: parsed.params.TZID || null };
    }
    props[name] = value;
  }
  return { props, dtStart, dtEnd };
}

/**
 * Extract Talk link/token from iCal properties.
 * @param {object} props
 * @returns {{token:string,url:string}|null}
 */
function extractTalkLinkFromProps(props){
  const propToken = props["X-NCTALK-TOKEN"];
  if (propToken){
    const propUrl = props["X-NCTALK-URL"];
    return {
      token: propToken,
      url: propUrl || ("https://nextcloud.local/call/" + propToken)
    };
  }
  const candidates = [
    props["LOCATION"],
    props["DESCRIPTION"],
    props["URL"],
    props["SUMMARY"]
  ];
  for (const text of candidates){
    if (!text) continue;
    const match = TALK_LINK_REGEX.exec(text);
    if (match){
      return { url: match[1], token: match[2] };
    }
  }
  return null;
}

/**
 * Parse Talk metadata from an iCal VEVENT payload.
 * @param {string} ical
 * @returns {object}
 */
function extractTalkMetadataFromIcal(ical){
  const { props, dtStart, dtEnd } = parseIcalEventData(ical);
  const link = extractTalkLinkFromProps(props) || {};
  const startProp = parseNumberProp(props["X-NCTALK-START"]);
  const startFromDt = parseIcalDateTime(dtStart?.value || "", dtStart?.tzid || null);
  const endFromDt = parseIcalDateTime(dtEnd?.value || "", dtEnd?.tzid || null);
  const delegateReadyRaw = props["X-NCTALK-DELEGATE-READY"];
  const addParticipantsLegacy = parseBooleanProp(props["X-NCTALK-ADD-PARTICIPANTS"]);
  const hasAddUsers = Object.prototype.hasOwnProperty.call(props, "X-NCTALK-ADD-USERS");
  const hasAddGuests = Object.prototype.hasOwnProperty.call(props, "X-NCTALK-ADD-GUESTS");
  let addUsers = parseBooleanProp(props["X-NCTALK-ADD-USERS"]);
  let addGuests = parseBooleanProp(props["X-NCTALK-ADD-GUESTS"]);
  if (!hasAddUsers && !hasAddGuests && addParticipantsLegacy != null){
    addUsers = addParticipantsLegacy;
    addGuests = addParticipantsLegacy;
  }
  return {
    token: link.token || "",
    url: link.url || "",
    title: props["SUMMARY"] || "",
    lobbyEnabled: parseBooleanProp(props["X-NCTALK-LOBBY"]),
    startProp,
    startFromDt,
    startTimestamp: startProp ?? startFromDt,
    endTimestamp: endFromDt,
    eventConversation: (() => {
      const raw = props["X-NCTALK-EVENT"];
      if (!raw) return null;
      return raw.trim().toLowerCase() === "event";
    })(),
    objectId: props["X-NCTALK-OBJECTID"] || "",
    addUsers,
    addGuests,
    delegateId: props["X-NCTALK-DELEGATE"] || "",
    delegateName: props["X-NCTALK-DELEGATE-NAME"] || "",
    delegated: parseBooleanProp(props["X-NCTALK-DELEGATED"]),
    delegateReady: parseBooleanProp(delegateReadyRaw),
    delegateReadyKnown: Object.prototype.hasOwnProperty.call(props, "X-NCTALK-DELEGATE-READY")
  };
}

/**
 * Apply property updates to the first VEVENT in an iCal payload.
 * @param {string} ical
 * @param {Object<string,string|null>} updates
 * @returns {{ical:string,changed:boolean}}
 */
function applyIcalPropertyUpdates(ical, updates){
  if (!ical || !updates) return { ical, changed:false };
  const updateMap = {};
  for (const [rawKey, rawValue] of Object.entries(updates)){
    if (!rawKey) continue;
    const key = String(rawKey).toUpperCase();
    updateMap[key] = rawValue === undefined ? null : rawValue;
  }
  const updateKeys = Object.keys(updateMap);
  if (!updateKeys.length) return { ical, changed:false };

  const lines = unfoldIcal(ical).split(/\r?\n/);
  const result = [];
  const seen = {};
  let inEvent = false;
  let eventIndex = 0;
  let changed = false;

  for (const line of lines){
    if (line === "BEGIN:VEVENT"){
      inEvent = true;
      eventIndex++;
      result.push(foldIcalLine(line));
      continue;
    }
    if (line === "END:VEVENT" && inEvent && eventIndex === 1){
      for (const key of updateKeys){
        const value = updateMap[key];
        if (seen[key] || value == null){
          continue;
        }
        const nextLine = `${key}:${escapeIcalText(value)}`;
        result.push(foldIcalLine(nextLine));
        changed = true;
      }
      result.push(foldIcalLine(line));
      inEvent = false;
      continue;
    }
    if (inEvent && eventIndex === 1){
      const parsed = parseIcalLine(line);
      if (parsed && Object.prototype.hasOwnProperty.call(updateMap, parsed.name)){
        seen[parsed.name] = true;
        const nextValue = updateMap[parsed.name];
        if (nextValue == null){
          changed = true;
          continue;
        }
        const idx = line.indexOf(":");
        const left = idx >= 0 ? line.slice(0, idx) : parsed.name;
        const currentUnescaped = unescapeIcalText(parsed.value || "");
        const desired = String(nextValue);
        if (currentUnescaped !== desired){
          changed = true;
        }
        const nextLine = `${left}:${escapeIcalText(desired)}`;
        result.push(foldIcalLine(nextLine));
        continue;
      }
    }
    result.push(foldIcalLine(line));
  }
  return { ical: result.join("\r\n"), changed };
}

/**
 * Persist metadata updates back to the calendar item.
 * @param {{calendarId:string,id:string,format:string,item:string}} item
 * @param {Object<string,string|null>} updates
 * @returns {Promise<boolean>}
 */
async function updateCalendarItemProps(item, updates){
  if (!item || item.format !== "ical" || !item.item){
    return false;
  }
  const { ical, changed } = applyIcalPropertyUpdates(item.item, updates);
  if (!changed){
    return false;
  }
  try{
    await browser.calendar.items.update(item.calendarId, item.id, {
      format: "ical",
      item: ical,
      returnFormat: "ical"
    });
    return true;
  }catch(e){
    console.error("[NCBG] calendar item update failed", e);
    return false;
  }
}

/**
 * Handle calendar item creates/updates and keep Talk room state in sync.
 * @param {object} item
 * @returns {Promise<void>}
 */
async function handleCalendarItemUpsert(item){
  try{
    if (!item || item.type !== "event"){
      return;
    }
    const meta = extractTalkMetadataFromIcal(item.item || "");
    if (!meta?.token){
      return;
    }
    removeRoomCleanupEntry(meta.token, "calendar_upsert");
    await setEventTokenEntry(item.calendarId, item.id, { token: meta.token, url: meta.url });

    if (typeof meta.startTimestamp === "number" && meta.lobbyEnabled !== false){
      await applyCalendarLobbyUpdate({
        token: meta.token,
        startTimestamp: meta.startTimestamp,
        delegateId: meta.delegateId || "",
        delegated: meta.delegated === true,
        lobbyEnabled: meta.lobbyEnabled
      });
    }

    const updates = {};
    if (meta.lobbyEnabled != null){
      updates.lobbyEnabled = meta.lobbyEnabled;
    }
    if (meta.eventConversation != null){
      updates.eventConversation = meta.eventConversation;
    }
    if (typeof meta.startTimestamp === "number"){
      updates.startTimestamp = meta.startTimestamp;
    }
    if (meta.delegateId){
      updates.delegateId = meta.delegateId;
      updates.delegateName = meta.delegateName || meta.delegateId;
    }
    if (meta.delegated != null){
      updates.delegated = meta.delegated;
    }
    if (Object.keys(updates).length){
      await setRoomMeta(meta.token, updates);
    }

    if (typeof meta.startFromDt === "number"){
      const shouldPersist = meta.startProp == null || Math.abs(meta.startFromDt - meta.startProp) >= 1;
      if (shouldPersist){
        await updateCalendarItemProps(item, { "X-NCTALK-START": String(Math.floor(meta.startFromDt)) });
      }
    }

    if (meta.addUsers === true || meta.addGuests === true){
      try{
        let canSync = true;
        const delegateIdRaw = (meta.delegateId || "").trim();
        if (meta.delegated === true && delegateIdRaw){
          const { user: currentUserRaw } = await NCCore.getOpts();
          const currentUser = (currentUserRaw || "").trim().toLowerCase();
          const delegateId = delegateIdRaw.toLowerCase();
          if (currentUser && delegateId && currentUser !== delegateId){
            canSync = false;
            L("invitee sync skipped (delegate mismatch)", {
              token: shortToken(meta.token),
              delegate: meta.delegateId || "",
              currentUser: currentUserRaw || ""
            });
          }
        }
        if (canSync){
          if (INVITEE_SYNC_IN_FLIGHT.has(meta.token)){
            L("invitee sync skipped (inflight)", { token: shortToken(meta.token) });
          }else{
            INVITEE_SYNC_IN_FLIGHT.add(meta.token);
            try{
              await addInviteesToTalkRoom({
                token: meta.token,
                ical: item.item,
                addUsers: meta.addUsers === true,
                addGuests: meta.addGuests === true
              });
            }finally{
              INVITEE_SYNC_IN_FLIGHT.delete(meta.token);
            }
          }
        }
      }catch(e){
        console.error("[NCBG] add invitees failed", e);
      }
    }

    const legacyMode = !meta.delegateReadyKnown;
    if (meta.delegateId && meta.delegated !== true){
      if (meta.delegateReady === true || legacyMode){
        if (DELEGATION_IN_FLIGHT.has(meta.token)){
          L("calendar delegation skipped (inflight)", { token: shortToken(meta.token) });
        }else{
          DELEGATION_IN_FLIGHT.add(meta.token);
          try{
            const result = await applyCalendarDelegation({
              token: meta.token,
              delegateId: meta.delegateId,
              delegateName: meta.delegateName || meta.delegateId
            });
            if (result?.ok){
              await updateCalendarItemProps(item, {
                "X-NCTALK-DELEGATED": "TRUE",
                "X-NCTALK-DELEGATE-READY": null
              });
            }
          }catch(e){
            console.error("[NCBG] calendar delegation failed", e);
          }finally{
            DELEGATION_IN_FLIGHT.delete(meta.token);
          }
        }
      }
    }
  }catch(e){
    console.error("[NCBG] calendar item upsert failed", e);
  }
}

/**
 * Handle calendar item deletion and remove the Talk room.
 * @param {string} calendarId
 * @param {string} id
 * @returns {Promise<void>}
 */
async function handleCalendarItemRemoved(calendarId, id){
  try{
    const entry = getEventTokenEntry(calendarId, id);
    if (!entry?.token){
      return;
    }
    const token = entry.token;
    const meta = getRoomMeta(token) || {};
    const delegateIdRaw = typeof meta.delegateId === "string" ? meta.delegateId.trim() : "";
    if (meta.delegated === true && delegateIdRaw){
      try{
        const { user: currentUserRaw } = await NCCore.getOpts();
        const currentUser = (currentUserRaw || "").trim().toLowerCase();
        const delegateId = delegateIdRaw.toLowerCase();
        if (currentUser && delegateId && currentUser !== delegateId){
          L("calendar item removed: skip room delete (delegated)", {
            token: shortToken(token),
            delegate: delegateIdRaw,
            currentUser: currentUserRaw || ""
          });
          await deleteRoomMeta(token);
          await removeEventTokenEntry(calendarId, id);
          return;
        }
      }catch(_){}
    }

    try{
      await deleteTalkRoom({ token });
    }catch(e){
      const msg = e?.message || String(e);
      if (/\b403\b/.test(msg)){
        L("calendar item removed: room delete forbidden", { token: shortToken(token) });
      }else{
        console.error("[NCBG] calendar item removed: room delete failed", e);
      }
    }finally{
      await deleteRoomMeta(token);
      await removeEventTokenEntry(calendarId, id);
    }
  }catch(e){
    console.error("[NCBG] calendar item removed handler failed", e);
  }
}

/**
 * Register calendar experiment listeners for event lifecycle changes.
 */
function startCalendarMonitor(){
  if (!browser?.calendar?.items?.onCreated){
    console.warn("[NCBG] calendar experiment not available");
    return;
  }
  browser.calendar.items.onCreated.addListener(handleCalendarItemUpsert, { returnFormat: "ical" });
  browser.calendar.items.onUpdated.addListener(handleCalendarItemUpsert, { returnFormat: "ical" });
  browser.calendar.items.onRemoved.addListener(handleCalendarItemRemoved);
}

// *** IMPORTANT: initialize calendar monitor on startup ***
(async () => {
  try{
    startCalendarMonitor();
  }catch(e){
    console.error("[NCBG] calendar monitor init error", e);
  }
})();




























  
