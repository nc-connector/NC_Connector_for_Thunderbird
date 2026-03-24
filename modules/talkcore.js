/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Return stored add-on credentials via NCCore.getOpts().
 * @returns {Promise<{baseUrl:string,user:string,appPass:string,debugEnabled:boolean,authMode:string}>}
 */
async function getOpts(){
  return NCCore.getOpts();
}
const talkShortId = NCTalkTextUtils.shortId;

/**
 * Build a standard host-permission error.
 * @returns {Error}
 */
function hostPermissionError(){
  if (typeof localizedError === "function"){
    return localizedError("error_host_permission_missing");
  }
  const fallback = typeof bgI18n === "function"
    ? bgI18n("error_host_permission_missing")
    : "Host permission missing.";
  return new Error(fallback);
}

/**
 * Log Talk core internal errors (uses L(...) when available).
 * @param {string} scope
 * @param {any} error
 * @param {object} details
 */
function logTalkCoreError(scope, error, details = undefined){
  if (typeof L === "function"){
    try{
      L(scope, {
        error: error?.message || String(error),
        details: details || null
      });
      return;
    }catch(logError){
      console.error("[NCTalk]", scope, error, details || "", logError);
      return;
    }
  }
  console.error("[NCTalk]", scope, error, details || "");
}

/**
 * Ensure optional host permission exists for the given base URL.
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
async function ensureHostPermission(baseUrl){
  if (typeof NCHostPermissions === "undefined" || !NCHostPermissions?.requireOriginPermission){
    return true;
  }
  return NCHostPermissions.requireOriginPermission(baseUrl, {
    errorFactory: hostPermissionError,
    scope: "[NCTalk] host permission missing",
    logMissing: false
  });
}

const EVENT_SUPPORT_CACHE = {
  value: null,
  reason: "",
  expires: 0
};
const EVENT_SUPPORT_TTL = 5 * 60 * 1000;

/**
 * Store the resolved event support state in the local cache.
 * @param {boolean|null} value - Resolved event capability (true/false/null)
 * @param {string} reason - Short hint for logs and debugging
 */
function noteEventSupport(value, reason){
  EVENT_SUPPORT_CACHE.value = value;
  EVENT_SUPPORT_CACHE.reason = reason || "";
  EVENT_SUPPORT_CACHE.expires = Date.now() + EVENT_SUPPORT_TTL;
}

/**
 * Cache a negative event support result with a reason.
 * @param {string} reason - Why event conversations are unavailable
 */
function markEventSupportUnsupported(reason){
  noteEventSupport(false, reason || "");
}

/**
 * Parse Talk/Cloud capabilities and infer event conversation support.
 * @param {object} data - Capabilities payload subset
 * @returns {{status:boolean|null, hint:string}}
 */
function parseEventSupportFlag(data){
  if (!data) return { status:null, hint:"" };
  const featureSources = [];
  if (Array.isArray(data.features)) featureSources.push(...data.features);
  if (Array.isArray(data.optionalFeatures)) featureSources.push(...data.optionalFeatures);
  if (Array.isArray(data.localFeatures)) featureSources.push(...data.localFeatures);
  const normalizedFeatures = featureSources.map((feature) => String(feature || "").toLowerCase());
  const eventFeatureTokens = [
    "event-conversation",
    "event-conversations",
    "conversation-object",
    "conversation-objects",
    "conversation-object-bind",
    "dashboard-event-rooms",
    "mutual-calendar-events",
    "unbind-conversation"
  ];
  for (const token of normalizedFeatures){
    const match = eventFeatureTokens.find((needle) => token.includes(needle));
    if (match) return { status:true, hint:"Feature '" + match + "'" };
    if (token.includes("event") && token.includes("conversation")){
      return { status:true, hint:"Feature '" + token + "'" };
    }
  }
  const flagCandidates = [
    ["eventConversation", data.eventConversation],
    ["eventConversations", data.eventConversations],
    ["supportsEventConversation", data.supportsEventConversation],
    ["supportsEventConversations", data.supportsEventConversations],
    ["conversationObject", data.conversationObject],
    ["supportsConversationObjects", data.supportsConversationObjects]
  ];
  for (const [name, entry] of flagCandidates){
    if (entry === true) return { status:true, hint:"Flag '" + name + "'" };
    if (entry === false) return { status:false, hint:"Flag '" + name + "'" };
  }
  const convoConfig = data.config || data.conversations || data.configurations || {};
  const retention = (convoConfig.conversations && (convoConfig.conversations["retention-event"] ?? convoConfig.conversations.retentionEvent))
    ?? convoConfig["retention-event"]
    ?? convoConfig.retentionEvent;
  if (retention !== undefined) return { status:true, hint:"Config 'retention-event'" };
  return { status:null, hint:"" };
}

/**
 * Extract a major version from various field formats.
 * @param {*} value - Version field in string/number/object form
 * @returns {number|null} - Major version or null
 */
function parseMajorVersion(value){
  if (value == null) return null;
  if (typeof value === "number"){
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string"){
    const match = /^(\d+)/.exec(value.trim());
    if (match && match[1]) return parseInt(match[1], 10);
  }
  if (typeof value === "object"){
    if (typeof value.major === "number") return Number.isFinite(value.major) ? value.major : null;
    if (typeof value.major === "string"){
      const parsed = parseInt(value.major, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
    if (typeof value.string === "string"){
      const match = /^(\d+)/.exec(value.string.trim());
      if (match && match[1]) return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Request Talk capabilities and normalize event support status.
 * @param {string} url - Full endpoint URL
 * @param {object} headers - Prepared OCS headers
 * @returns {Promise<{supported:boolean|null, reason:string}>}
 */
async function requestTalkCapabilities(url, headers){
  try{
    L("request talk capabilities", { url });
    const res = await fetch(url, { method:"GET", headers });
    L("talk capabilities status", { status: res.status, ok: res.ok });
    const raw = await res.text();
    let data = null;
    try{
      data = raw ? JSON.parse(raw) : null;
    }catch(error){
      logTalkCoreError("talk capabilities json parse failed", error, {
        responseSample: String(raw || "").slice(0, 160)
      });
    }
    if (res.status === 404){
      return { supported:null, reason:"Talk capabilities endpoint returned HTTP 404." };
    }
    if (!res.ok){
      const meta = data?.ocs?.meta || {};
      const detailParts = [];
      if (meta.message && meta.message !== meta.status) detailParts.push(meta.message);
      if (meta.status && meta.status !== meta.statuscode) detailParts.push(meta.status);
      if (meta.statuscode) detailParts.push("HTTP " + meta.statuscode);
      if (res.status) detailParts.push("HTTP " + res.status + " " + res.statusText);
      const detail = detailParts.filter(Boolean).join(" / ") || raw || ("HTTP " + res.status + " " + res.statusText);
      return { supported:null, reason:"Talk capabilities request failed: " + detail };
    }
    const spreedCaps = data?.ocs?.data?.spreed ?? data?.ocs?.data ?? data?.spreed ?? null;
    const parsed = parseEventSupportFlag(spreedCaps);
    if (parsed.status === true){
      return { supported:true, reason:"Talk Capabilities: " + parsed.hint };
    }
    if (parsed.status === false){
      return { supported:false, reason:"Talk capabilities: " + parsed.hint + " => event not available." };
    }
    return { supported:null, reason: parsed.hint ? "Talk capabilities: " + parsed.hint : "Talk capabilities without event flag." };
  }catch(e){
    logTalkCoreError("requestTalkCapabilities failed", e, { url });
    return { supported:null, reason: e?.message || "Talk capabilities endpoint unreachable." };
  }
}

/**
 * Request core capabilities and interpret them for event support.
 * @param {string} baseUrl - Normalized Nextcloud base URL
 * @param {object} headers - Prepared OCS headers
 * @returns {Promise<{supported:boolean|null, reason:string}>}
 */
async function requestCoreCapabilities(baseUrl, headers){
  const coreUrl = baseUrl + "/ocs/v2.php/cloud/capabilities";
  try{
    L("request core capabilities", { url: coreUrl });
    const res = await fetch(coreUrl, { method:"GET", headers });
    L("core capabilities status", { status: res.status, ok: res.ok });
    const raw = await res.text();
    let data = null;
    try{
      data = raw ? JSON.parse(raw) : null;
    }catch(error){
      logTalkCoreError("core capabilities json parse failed", error, {
        responseSample: String(raw || "").slice(0, 160)
      });
    }
    if (!res.ok){
      const meta = data?.ocs?.meta || {};
      const detailParts = [];
      if (meta.message && meta.message !== meta.status) detailParts.push(meta.message);
      if (meta.status && meta.status !== meta.statuscode) detailParts.push(meta.status);
      if (meta.statuscode) detailParts.push("HTTP " + meta.statuscode);
      if (res.status) detailParts.push("HTTP " + res.status + " " + res.statusText);
      const detail = detailParts.filter(Boolean).join(" / ") || raw || ("HTTP " + res.status + " " + res.statusText);
      return { supported:null, reason:"Cloud capabilities request failed: " + detail };
    }
    const capabilities = data?.ocs?.data?.capabilities || {};
    const spreedCaps = capabilities.spreed ?? data?.ocs?.data?.spreed ?? null;
    const parsed = parseEventSupportFlag(spreedCaps);
    if (parsed.status === true){
      return { supported:true, reason:"Cloud Capabilities: " + parsed.hint };
    }
    if (parsed.status === false){
      return { supported:false, reason:"Cloud capabilities: " + parsed.hint + " => event not available." };
    }
    const versionMajor =
      parseMajorVersion(spreedCaps?.version) ??
      parseMajorVersion(capabilities?.spreed?.version) ??
      parseMajorVersion(data?.ocs?.data?.version) ??
      parseMajorVersion(data?.ocs?.data?.installed?.version) ??
      parseMajorVersion(data?.ocs?.data?.system?.version);
    if (versionMajor !== null && versionMajor < 32){
      return { supported:false, reason:"Cloud capabilities: Nextcloud version " + versionMajor + " (<32) => event disabled." };
    }
    if (versionMajor !== null && versionMajor >= 32){
      return { supported:null, reason:"Cloud capabilities: Nextcloud version " + versionMajor + " does not expose an event flag." };
    }
    return { supported:null, reason:"Cloud capabilities without event indicators." };
  }catch(e){
    logTalkCoreError("requestCoreCapabilities failed", e, { url: coreUrl });
    return { supported:null, reason: e?.message || "Cloud capabilities endpoint unreachable." };
  }
}

/**
 * Resolve event conversation support with caching.
 * @returns {Promise<{supported:boolean|null, reason:string}>}
 */
async function getEventConversationSupport(){
  const now = Date.now();
  if (EVENT_SUPPORT_CACHE.expires > now && EVENT_SUPPORT_CACHE.value !== null){
    L("event support cache hit", {
      supported: EVENT_SUPPORT_CACHE.value,
      reason: EVENT_SUPPORT_CACHE.reason || "",
      expiresInMs: Math.max(0, EVENT_SUPPORT_CACHE.expires - now)
    });
    return { supported: EVENT_SUPPORT_CACHE.value, reason: EVENT_SUPPORT_CACHE.reason };
  }
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass){
    L("event support aborted", "credentials missing");
    noteEventSupport(false, "Credentials missing");
    return { supported:false, reason:"Credentials missing" };
  }
  await ensureHostPermission(baseUrl);
  const headers = {
    "OCS-APIRequest": "true",
    "Authorization": NCOcs.buildAuthHeader(user, appPass),
    "Accept": "application/json"
  };
  const talkUrl = baseUrl + "/ocs/v2.php/apps/spreed/api/v4/capabilities";
  const talkResult = await requestTalkCapabilities(talkUrl, headers);
  if (talkResult.supported === true){
    if (talkResult.reason){
      L("event capability (talk)", talkResult.reason);
    } else {
      L("event capability (talk)", "Event support confirmed (Talk capabilities).");
    }
    noteEventSupport(true, talkResult.reason || "");
    return { supported:true, reason: talkResult.reason || "" };
  }
  if (talkResult.reason){
    L("event capability (talk)", talkResult.reason);
  }
  const reasons = [];
  if (talkResult.reason) reasons.push(talkResult.reason);
  if (talkResult.supported === false){
    const reason = reasons.filter(Boolean).join(" | ") || "";
    noteEventSupport(false, reason);
    return { supported:false, reason };
  }
  const coreResult = await requestCoreCapabilities(baseUrl, headers);
  if (coreResult.supported === true){
    const reason = coreResult.reason || "";
    if (reason){
      L("event capability (core)", reason);
    } else {
      L("event capability (core)", "Event support confirmed (Cloud capabilities).");
    }
    noteEventSupport(true, reason);
    return { supported:true, reason };
  }
  if (coreResult.reason){
    L("event capability (core)", coreResult.reason);
  }
  if (coreResult.reason) reasons.push(coreResult.reason);
  if (coreResult.supported === false){
    const reason = reasons.filter(Boolean).join(" | ") || coreResult.reason || "";
    noteEventSupport(false, reason);
    return { supported:false, reason };
  }
  const aggregatedReason = reasons.filter(Boolean).join(" | ") || "Capabilities could not be evaluated.";
  noteEventSupport(null, aggregatedReason);
  L("event support indeterminate", { reason: aggregatedReason });
  return { supported:null, reason: aggregatedReason };
}
/**
 * Generate a simple random token for pseudo fallbacks.
 */
function randToken(len=10){ const a="abcdefghijklmnopqrstuvwxyz0123456789"; let s=""; for(let i=0;i<len;i++) s+=a[Math.floor(Math.random()*a.length)]; return s; }
/**
 * Trim and normalize room descriptions.
 */
function sanitizeDescription(desc){
  if (!desc) return "";
  return String(desc).trim();
}

/**
 * Combine a base description with optional Talk link and password.
 */
async function buildRoomDescription(baseDescription, url, password){
  const parts = [];
  if (baseDescription && String(baseDescription).trim()){
    parts.push(String(baseDescription).trim());
  }
  const talkBlock = await buildStandardTalkDescription(url, password);
  if (talkBlock){
    parts.push(talkBlock);
  }
  return parts.join("\n\n").trim();
}

/**
 * Resolve the configured language override for event description blocks.
 * @returns {Promise<string>}
 */
async function getEventDescriptionLang(){
  if (!browser?.storage?.local){
    return "default";
  }
  try{
    const stored = await browser.storage.local.get(["eventDescriptionLang"]);
    return stored.eventDescriptionLang || "default";
  }catch(error){
    logTalkCoreError("event description language read failed", error);
    return "default";
  }
}

/**
 * Translate event description strings for the given language.
 * @param {string} lang
 * @param {string} key
 * @param {string[]|string} substitutions
 * @returns {Promise<string>}
 */
async function descriptionI18n(lang, key, substitutions = []){
  if (typeof NCI18nOverride !== "undefined" && typeof NCI18nOverride.tInLang === "function"){
    const msg = await NCI18nOverride.tInLang(lang, key, substitutions);
    if (msg) return msg;
  }
  try{
    if (typeof bgI18n === "function"){
      const msg = bgI18n(key, substitutions);
      if (msg) return msg;
    }
  }catch(error){
    logTalkCoreError("description bgI18n failed", error, { key });
  }
  try{
    if (typeof NCI18n !== "undefined" && typeof NCI18n.translate === "function"){
      const msg = NCI18n.translate(key, substitutions);
      if (msg) return msg;
    }
  }catch(error){
    logTalkCoreError("description fallback i18n failed", error, { key });
  }
  if (substitutions.length){
    return String(substitutions[0]);
  }
  return "";
}

/**
 * Build the plain-text Talk description block for calendar events.
 * @param {string} url
 * @param {string} password
 * @returns {Promise<string>}
 */
async function buildStandardTalkDescription(url, password){
  const lang = await getEventDescriptionLang();
  const heading = await descriptionI18n(lang, "ui_description_heading");
  const joinLabel = await descriptionI18n(lang, "ui_description_join_label");
  const passwordLine = password
    ? await descriptionI18n(lang, "ui_description_password_line", [password])
    : "";
  const helpLabel = await descriptionI18n(lang, "ui_description_help_label");
  const helpUrl = (await descriptionI18n(lang, "ui_description_help_url"))
    || "https://docs.nextcloud.com/server/latest/user_manual/en/talk/join_a_call_or_chat_as_guest.html";
  const lines = [
    heading,
    "",
    joinLabel,
    url || "",
    ""
  ];
  if (passwordLine){
    lines.push(passwordLine, "");
  }
  lines.push(helpLabel, "", helpUrl);
  return lines.join("\n").trim();
}

/**
 * Create a Talk room with optional event binding and fallbacks.
 * @returns {Promise<{url:string,token:string,fallback:boolean,reason:string|null,description:string}>}
 */
async function createTalkPublicRoom({
  title,
  password,
  enableLobby,
  enableListable,
  description,
  startTimestamp,
  objectType,
  objectId,
  eventConversation
} = {}){
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass) throw localizedError("error_credentials_missing");
  await ensureHostPermission(baseUrl);

  const auth = NCOcs.buildAuthHeader(user, appPass);
  const headers = { "OCS-APIRequest": "true", "Authorization": auth, "Accept":"application/json", "Content-Type":"application/json" };

  const base = baseUrl.replace(/\/$/,"");
  const createUrl = base + "/ocs/v2.php/apps/spreed/api/v4/room";
  const ROOM_TYPE_PUBLIC = 3;
  const LISTABLE_NONE = 0;
  const LISTABLE_USERS = 1;
  const listableScope = enableListable ? LISTABLE_USERS : LISTABLE_NONE;
  const cleanedDescription = sanitizeDescription(description);
  const attemptEvent = !!(eventConversation && objectType === "event" && objectId && String(objectId).trim().length);
  L("create talk room request", {
    title: title || "",
    hasPassword: !!password,
    enableLobby: !!enableLobby,
    enableListable: !!enableListable,
    descriptionLength: (cleanedDescription || "").length,
    attemptEvent,
    objectType: attemptEvent ? objectType : null,
    objectId: attemptEvent ? talkShortId(objectId) : null,
    startTimestamp: typeof startTimestamp === "number" ? startTimestamp : null
  });
  let supportInfo = { supported:null, reason:"" };
  if (attemptEvent){
    supportInfo = await getEventConversationSupport();
    L("event support info (create)", {
      supported: supportInfo.supported,
      reason: supportInfo.reason || ""
    });
  }
  const attempts = [];
  if (attemptEvent && supportInfo.supported !== false){
    attempts.push({ includeEvent:true });
  }
  attempts.push({ includeEvent:false });
  let lastError = null;
  for (const attempt of attempts){
    L("create attempt start", { includeEvent: attempt.includeEvent });
    const body = {
      roomType: ROOM_TYPE_PUBLIC,
      type: ROOM_TYPE_PUBLIC,
      roomName: title || "Meeting",
      listable: listableScope,
      participants: {}
    };
    if (password) body.password = password;
    if (cleanedDescription) body.description = cleanedDescription;
    if (attempt.includeEvent){
      body.objectType = "event";
      body.objectId = String(objectId).trim();
    }
    const res = await fetch(createUrl, { method:"POST", headers, body: JSON.stringify(body) });
    L("create attempt status", { includeEvent: attempt.includeEvent, status: res.status, ok: res.ok });
    const raw = await res.text();
    let data = null;
    try{
      data = raw ? JSON.parse(raw) : null;
    }catch(error){
      logTalkCoreError("room create json parse failed", error, {
        includeEvent: attempt.includeEvent,
        responseSample: String(raw || "").slice(0, 160)
      });
    }
    if (!res.ok){
      const meta = data?.ocs?.meta || {};
      const payload = data?.ocs?.data || {};
      L("create attempt failure", {
        includeEvent: attempt.includeEvent,
        status: res.status,
        meta: meta?.message || null,
        error: payload?.error || null
      });
      if (attempt.includeEvent && isEventConversationError(meta, payload, raw)){
        markEventSupportUnsupported(payload?.error || meta?.message || "");
        L("event conversation rejected by server, falling back");
        continue;
      }
      const parts = [];
      if (meta.message && meta.message !== meta.status) parts.push(meta.message);
      if (payload.error) parts.push(payload.error);
      if (Array.isArray(payload.errors)) parts.push(...payload.errors);
      if (meta.statuscode) parts.push("Status code " + meta.statuscode);
      if (res.status) parts.push("HTTP " + res.status + " " + res.statusText);
      const detail = parts.filter(Boolean).join(" / ") || raw || (res.status + " " + res.statusText);
      const err = localizedError("error_ocs", [detail]);
      err.fatal = true;
      err.status = res.status;
      err.response = raw;
      err.meta = meta;
      err.payload = payload;
      lastError = err;
      break;
    }
    if (attempt.includeEvent){
      noteEventSupport(true, "");
    }
    let token = data?.ocs?.data?.token || data?.ocs?.data?.roomToken || data?.token || data?.data?.token;
    if (!token){
      lastError = localizedError("error_token_missing_in_response");
      break;
    }
    L("create attempt success", {
      includeEvent: attempt.includeEvent,
      token: shortToken(token)
    });
    const url = base + "/call/" + token;
    if (enableLobby){
      try{
        const lobbyUrl = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + token + "/webinar/lobby";
        const lobbyPayload = { state: 1 };
        if (typeof startTimestamp === "number" && Number.isFinite(startTimestamp) && startTimestamp > 0){
          let timerVal = startTimestamp;
          if (timerVal > 1e12) timerVal = Math.floor(timerVal / 1000);
          lobbyPayload.timer = Math.floor(timerVal);
        }
        L("set lobby payload", lobbyPayload);
        const lobbyRes = await fetch(lobbyUrl, { method:"PUT", headers, body: JSON.stringify(lobbyPayload) });
        if (!lobbyRes.ok){
          const lobbyText = await lobbyRes.text().catch((error) => {
            logTalkCoreError("lobby response read failed", error);
            return "";
          });
          L("lobby set failed", lobbyRes.status, lobbyRes.statusText, lobbyText);
          throw localizedError("error_lobby_set_failed", [lobbyText || (lobbyRes.status + " " + lobbyRes.statusText)]);
        }
        L("lobby set success", {
          token: shortToken(token),
          timer: lobbyPayload.timer ?? null
        });
      }catch(e){
        console.error("[NCTalk] lobby update error", {
          token: shortToken(token),
          error: e?.message || String(e)
        });
        L("lobby update error", e?.message || String(e));
        return { url, token, fallback:true, reason: e?.message || bgI18n("error_lobby_set_failed_short") };
      }
    }
    if (enableListable){
      try{
        const listableUrl = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + token + "/listable";
        const listableRes = await fetch(listableUrl, { method:"PUT", headers, body: JSON.stringify({ scope: listableScope }) });
        if (!listableRes.ok){
          L("listable set failed status", listableRes.status, listableRes.statusText);
        } else {
          L("listable set success", {
            token: shortToken(token),
            scope: listableScope
          });
        }
      }catch(e){
        console.error("[NCTalk] listable update error", {
          token: shortToken(token),
          error: e?.message || String(e)
        });
        L("listable update error", e?.message || String(e));
      }
    }
    const finalDescription = await buildRoomDescription(description, url, password);
    const allowDescriptionUpdate = !(attempt.includeEvent && eventConversation);
    if (allowDescriptionUpdate && finalDescription && finalDescription !== cleanedDescription){
      try{
        const descUrl = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + token + "/description";
        const descRes = await fetch(descUrl, { method:"PUT", headers, body: JSON.stringify({ description: finalDescription }) });
        if (!descRes.ok){
          L("description set failed status", descRes.status, descRes.statusText);
        } else {
          L("description update success", { token: shortToken(token) });
        }
      }catch(e){
        console.error("[NCTalk] description update error", {
          token: shortToken(token),
          error: e?.message || String(e)
        });
        L("description update error", e?.message || String(e));
      }
    }
    const fallbackFlag = attemptEvent && !attempt.includeEvent;
    const fallbackReason = fallbackFlag ? supportInfo.reason || "Event conversation not available." : null;
    L("create attempt complete", {
      includeEvent: attempt.includeEvent,
      token: shortToken(token),
      fallback: fallbackFlag,
      reason: fallbackReason
    });
    return {
      url,
      token,
      fallback: fallbackFlag,
      reason: fallbackReason,
      description: finalDescription || cleanedDescription || ""
    };
  }
  if (lastError){
    if (lastError.fatal){
      L("create attempt fatal", {
        message: lastError?.message || "",
        status: lastError?.status || null
      });
      throw lastError;
    }
    L("create via OCS failed, fallback to pseudo url:", lastError?.message);
    const fallbackToken = randToken(10);
    L("create fallback token", { token: shortToken(fallbackToken) });
    return {
      url: base + "/call/" + fallbackToken,
      token: fallbackToken,
      fallback: true,
      reason: lastError?.message || String(lastError)
    };
  }
  L("create talk room failed", "unknown error");
  throw localizedError("error_room_create_failed");
}
/**
 * Update lobby state (and optional start time) for an existing room.
 */
async function updateTalkLobby({ token, enableLobby, startTimestamp } = {}){
  if (!token) throw localizedError("error_room_token_missing");
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass) throw localizedError("error_credentials_missing");
  await ensureHostPermission(baseUrl);
  const auth = NCOcs.buildAuthHeader(user, appPass);
  const headers = { "OCS-APIRequest": "true", "Authorization": auth, "Accept":"application/json", "Content-Type":"application/json" };
  const base = baseUrl.replace(/\/$/,"");
  const lobbyUrl = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + token + "/webinar/lobby";
  const payload = { state: enableLobby ? 1 : 0 };
  if (enableLobby && typeof startTimestamp === "number" && Number.isFinite(startTimestamp) && startTimestamp > 0){
    let timerVal = startTimestamp;
    if (timerVal > 1e12) timerVal = Math.floor(timerVal / 1000);
    payload.timer = Math.floor(timerVal);
  }
  if (!enableLobby) delete payload.timer;
  L("update lobby payload", payload);
  const res = await fetch(lobbyUrl, { method:"PUT", headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    if (res.status === 403) {
      throw localizedError("error_lobby_no_permission");
    }
    throw localizedError("error_lobby_update_failed", [res.status]);
  }
  L("update lobby success", {
    token: shortToken(token),
    enableLobby: !!enableLobby,
    timer: payload.timer ?? null
  });
  return true;
}
/**
 * Delete a Talk room via OCS; 404 is treated as success.
 */
async function deleteTalkRoom({ token } = {}){
  if (!token) throw localizedError("error_room_token_missing");
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass) throw localizedError("error_credentials_missing");
  await ensureHostPermission(baseUrl);
  const auth = NCOcs.buildAuthHeader(user, appPass);
  const headers = { "OCS-APIRequest": "true", "Authorization": auth, "Accept":"application/json" };
  const base = baseUrl.replace(/\/$/,"");
  const url = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + encodeURIComponent(token);
  L("delete talk room request", { token: shortToken(token) });
  const res = await fetch(url, { method:"DELETE", headers });
  const raw = await res.text().catch((error) => {
    logTalkCoreError("delete room response read failed", error);
    return "";
  });
  let data = null;
  try{
    data = raw ? JSON.parse(raw) : null;
  }catch(error){
    logTalkCoreError("delete room json parse failed", error, {
      responseSample: String(raw || "").slice(0, 160)
    });
  }
  L("delete talk room status", { token: shortToken(token), status: res.status, ok: res.ok });
  if (res.status === 404){
    L("delete talk room already removed", { token: shortToken(token) });
    return true;
  }
  if (!res.ok){
    const meta = data?.ocs?.meta || {};
    const payload = data?.ocs?.data || {};
    const parts = [];
    if (meta.message && meta.message !== meta.status) parts.push(meta.message);
    if (payload.error) parts.push(payload.error);
    if (meta.statuscode) parts.push("Status code " + meta.statuscode);
    if (res.status) parts.push("HTTP " + res.status + " " + res.statusText);
    const detail = parts.filter(Boolean).join(" / ") || raw || (res.status + " " + res.statusText);
    throw localizedError("error_room_delete_failed", [detail]);
  }
  L("delete talk room success", { token: shortToken(token) });
  return true;
}

/**
 * Fetch room participants, including moderator info when available.
 * @param {{token:string}} param0
 * @returns {Promise<object[]>}
 */
async function getTalkRoomParticipants({ token } = {}){
  if (!token) throw localizedError("error_room_token_missing");
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass) throw localizedError("error_credentials_missing");
  await ensureHostPermission(baseUrl);
  L("get room participants request", { token: shortToken(token) });
  const auth = NCOcs.buildAuthHeader(user, appPass);
  const headers = { "OCS-APIRequest": "true", "Authorization": auth, "Accept":"application/json" };
  const base = baseUrl.replace(/\/$/,"");
  const infoUrl = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + encodeURIComponent(token) + "/participants?includeStatus=true";
  const res = await fetch(infoUrl, { method:"GET", headers });
  const raw = await res.text();
  let data = null;
  try{
    data = raw ? JSON.parse(raw) : null;
  }catch(error){
    logTalkCoreError("participants json parse failed", error, {
      responseSample: String(raw || "").slice(0, 160)
    });
  }
  if (res.status === 404){
    return [];
  }
  if (!res.ok){
    const meta = data?.ocs?.meta || {};
    const detail = meta.message || raw || (res.status + " " + res.statusText);
    throw localizedError("error_ocs", [detail]);
  }
  const participants = data?.ocs?.data;
  const list = Array.isArray(participants) ? participants : [];
  L("get room participants result", { token: shortToken(token), count: list.length });
  return list;
}
/**
 * Add a user to the Talk room via the OCS API.
 */
async function addTalkParticipant({ token, actorId, source = "users" } = {}){
  if (!token || !actorId) throw localizedError("error_token_or_actor_missing");
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass) throw localizedError("error_credentials_missing");
  await ensureHostPermission(baseUrl);
  L("add participant request", {
    token: shortToken(token),
    actor: String(actorId).trim(),
    source: source || "users"
  });
  const auth = NCOcs.buildAuthHeader(user, appPass);
  const headers = {
    "OCS-APIRequest": "true",
    "Authorization": auth,
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
  const base = baseUrl.replace(/\/$/,"");
  const url = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + encodeURIComponent(token) + "/participants";
  const body = { newParticipant: actorId, source: source || "users" };
  const res = await fetch(url, { method:"POST", headers, body: JSON.stringify(body) });
  const raw = await res.text().catch((error) => {
    logTalkCoreError("add participant response read failed", error);
    return "";
  });
  let json = null;
  try{
    json = raw ? JSON.parse(raw) : null;
  }catch(error){
    logTalkCoreError("add participant json parse failed", error, {
      responseSample: String(raw || "").slice(0, 160)
    });
  }
  if (!res.ok && res.status !== 409){
    const meta = json?.ocs?.meta || {};
    const detail = meta.message || raw || (res.status + " " + res.statusText);
    throw localizedError("error_participant_add_failed", [detail]);
  }
  L("add participant result", {
    token: shortToken(token),
    status: res.status,
    conflict: res.status === 409
  });
  const added = json?.ocs?.data;
  return added || null;
}
/**
 * Promote an existing participant to moderator.
 */
async function promoteTalkModerator({ token, attendeeId } = {}){
  if (!token || typeof attendeeId !== "number") throw localizedError("error_moderator_id_missing");
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass) throw localizedError("error_credentials_missing");
  await ensureHostPermission(baseUrl);
  L("promote moderator request", {
    token: shortToken(token),
    attendeeId
  });
  const auth = NCOcs.buildAuthHeader(user, appPass);
  const headers = {
    "OCS-APIRequest": "true",
    "Authorization": auth,
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
  const base = baseUrl.replace(/\/$/,"");
  const url = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + encodeURIComponent(token) + "/moderators";
  const body = { attendeeId };
  const res = await fetch(url, { method:"POST", headers, body: JSON.stringify(body) });
  if (!res.ok && res.status !== 409){
    const raw = await res.text().catch((error) => {
      logTalkCoreError("promote moderator response read failed", error);
      return "";
    });
    let json = null;
    try{
      json = raw ? JSON.parse(raw) : null;
    }catch(error){
      logTalkCoreError("promote moderator json parse failed", error, {
        responseSample: String(raw || "").slice(0, 160)
      });
    }
    const meta = json?.ocs?.meta || {};
    const detail = meta.message || raw || (res.status + " " + res.statusText);
    throw localizedError("error_moderator_set_failed", [detail]);
  }
  L("promote moderator success", {
    token: shortToken(token),
    status: res.status,
    conflict: res.status === 409
  });
  return true;
}
/**
 * Remove the authenticated user from the room (self-leave).
 */
async function leaveTalkRoom({ token } = {}){
  if (!token) throw localizedError("error_room_token_missing");
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass) throw localizedError("error_credentials_missing");
  await ensureHostPermission(baseUrl);
  L("leave room request", { token: shortToken(token) });
  const auth = NCOcs.buildAuthHeader(user, appPass);
  const headers = {
    "OCS-APIRequest": "true",
    "Authorization": auth,
    "Accept": "application/json"
  };
  const base = baseUrl.replace(/\/$/,"");
  const url = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + encodeURIComponent(token) + "/participants/self";
  const res = await fetch(url, { method:"DELETE", headers });
  if (!res.ok && res.status !== 404){
    const raw = await res.text().catch((error) => {
      logTalkCoreError("leave room response read failed", error);
      return "";
    });
    let json = null;
    try{
      json = raw ? JSON.parse(raw) : null;
    }catch(error){
      logTalkCoreError("leave room json parse failed", error, {
        responseSample: String(raw || "").slice(0, 160)
      });
    }
    const meta = json?.ocs?.meta || {};
    const detail = meta.message || raw || (res.status + " " + res.statusText);
    throw localizedError("error_leave_failed", [detail]);
  }
  L("leave room success", { token: shortToken(token), status: res.status });
  return true;
}
/**
 * Delegate moderation to another user, optionally leaving the room.
 */
async function delegateRoomModerator({ token, newModerator } = {}){
  if (!token || !newModerator) throw localizedError("error_delegation_data_missing");
  const { user } = await getOpts();
  const targetId = String(newModerator).trim();
  if (!targetId) throw localizedError("error_moderator_target_missing");
  const currentUser = (user || "").trim();
  L("delegate moderator request", {
    token: shortToken(token),
    target: targetId,
    currentUser
  });
  await addTalkParticipant({ token, actorId: targetId, source: "users" });
  const participants = await getTalkRoomParticipants({ token });
  const match = participants.find((p) => {
    if (!p) return false;
    const actor = (p.actorId || "").trim().toLowerCase();
    return actor === targetId.toLowerCase();
  });
  if (!match){
    throw localizedError("error_participant_not_found");
  }
  await promoteTalkModerator({ token, attendeeId: match.attendeeId });
  const loweredUser = currentUser.toLowerCase();
  if (loweredUser && loweredUser !== targetId.toLowerCase()){
    await leaveTalkRoom({ token });
    L("delegate moderator completed", { token: shortToken(token), delegate: targetId, leftSelf: true });
    return { leftSelf: true, delegate: targetId };
  }
  L("delegate moderator completed", { token: shortToken(token), delegate: targetId, leftSelf: false });
  return { leftSelf: false, delegate: targetId };
}

/**
 * Resolve optional Talk addressbook runtime APIs.
 * In background they are provided by `talkAddressbook.js`; in popup contexts
 * they may be absent and must not break NCTalkCore initialization.
 * @returns {{
 *   getSystemAddressbookContacts: Function,
 *   getSystemAddressbookStatus: Function,
 *   searchSystemAddressbook: Function
 * }}
 */
function getTalkAddressbookRuntimeApi(){
  const notAvailable = (name) => async () => {
    throw new Error("Talk addressbook API unavailable in this context: " + name);
  };
  return {
    getSystemAddressbookContacts:
      typeof getSystemAddressbookContacts === "function"
        ? getSystemAddressbookContacts
        : notAvailable("getSystemAddressbookContacts"),
    getSystemAddressbookStatus:
      typeof getSystemAddressbookStatus === "function"
        ? getSystemAddressbookStatus
        : notAvailable("getSystemAddressbookStatus"),
    searchSystemAddressbook:
      typeof searchSystemAddressbook === "function"
        ? searchSystemAddressbook
        : notAvailable("searchSystemAddressbook")
  };
}
const TALK_ADDRESSBOOK_API = getTalkAddressbookRuntimeApi();

const NCTalkCore = Object.freeze({
  buildStandardTalkDescription,
  getEventConversationSupport,
  getSystemAddressbookContacts: TALK_ADDRESSBOOK_API.getSystemAddressbookContacts,
  getSystemAddressbookStatus: TALK_ADDRESSBOOK_API.getSystemAddressbookStatus,
  searchSystemAddressbook: TALK_ADDRESSBOOK_API.searchSystemAddressbook,
  createTalkPublicRoom,
  updateTalkLobby,
  deleteTalkRoom,
  getTalkRoomParticipants,
  addTalkParticipant,
  promoteTalkModerator,
  leaveTalkRoom,
  delegateRoomModerator
});

if (typeof globalThis !== "undefined"){
  globalThis.NCTalkCore = NCTalkCore;
}
