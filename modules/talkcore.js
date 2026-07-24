/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

async function getOpts(){
  return NCCore.getOpts();
}
const talkShortId = NCTalkTextUtils.shortId;
const resolveTalkCoreLogPrefix = () =>
  globalThis.NCLogContext?.resolveAddonLogPrefix?.("TalkCore")
  || "[NCBG]";

function hostPermissionError(){
  if (typeof localizedError === "function"){
    return localizedError("error_host_permission_missing");
  }
  const fallback = typeof bgI18n === "function"
    ? bgI18n("error_host_permission_missing")
    : "Host permission missing.";
  return new Error(fallback);
}

function logTalkCoreError(scope, error, details = undefined){
  globalThis.NCLogContext.safeConsoleError(resolveTalkCoreLogPrefix(), scope, error, details);
}

function getTalkOcsData(response){
  return response?.data?.ocs?.data ?? null;
}

function getTalkOcsFailureDetail(response){
  return NCOcs.getFailureMessage(
    response,
    response?.status
      ? `HTTP ${response.status} ${response.statusText || ""}`.trim()
      : ""
  );
}

function makeTalkOcsError(messageKey, response){
  const detail = getTalkOcsFailureDetail(response);
  const error = localizedError(messageKey, detail ? [detail] : []);
  error.status = Number(response?.status) || 0;
  error.response = response?.raw || "";
  error.meta = response?.meta || response?.data?.ocs?.meta || null;
  error.payload = getTalkOcsData(response);
  return error;
}

function isTalkOcsSuccess(response){
  return NCOcs.isExplicitSuccess(response);
}

async function requestTalkOcs({ url, method = "GET", headers, body, signal } = {}){
  return NCOcs.ocsRequest({
    url,
    method,
    headers,
    body,
    signal,
    acceptJson: true
  });
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
    scope: "host permission missing",
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
    const response = await requestTalkOcs({ url, method:"GET", headers });
    L("talk capabilities status", { status: response.status, ok: response.ok });
    if (response.status === 404){
      return { supported:null, reason:"Talk capabilities endpoint returned HTTP 404." };
    }
    if (!isTalkOcsSuccess(response)){
      const detail = getTalkOcsFailureDetail(response);
      return { supported:null, reason:"Talk capabilities request failed: " + detail };
    }
    const data = response.data;
    const spreedCaps = data?.ocs?.data?.spreed ?? data?.ocs?.data ?? data?.spreed ?? null;
    const parsed = parseEventSupportFlag(spreedCaps);
    if (parsed.status === true){
      return { supported:true, reason:"Talk Capabilities: " + parsed.hint };
    }
    if (parsed.status === false){
      return { supported:false, reason:"Talk capabilities: " + parsed.hint + " => event not available." };
    }
    return { supported:null, reason: parsed.hint ? "Talk capabilities: " + parsed.hint : "Talk capabilities without event flag." };
  }catch(error){
    logTalkCoreError("requestTalkCapabilities failed", error, { url });
    return { supported:null, reason: error?.message || "Talk capabilities endpoint unreachable." };
  }
}

/**
 * Request core capabilities and interpret them for event support.
 * @param {{baseUrl:string,user:string,appPass:string}} options
 * @returns {Promise<{supported:boolean|null, reason:string}>}
 */
async function requestCoreCapabilities(options){
  try{
    const snapshot = await NCCore.getRequiredCapabilities(options);
    const capabilities = snapshot.capabilities || {};
    const spreedCaps = capabilities.spreed ?? null;
    const parsed = parseEventSupportFlag(spreedCaps);
    if (parsed.status === true){
      return { supported:true, reason:"Cloud Capabilities: " + parsed.hint };
    }
    if (parsed.status === false){
      return { supported:false, reason:"Cloud capabilities: " + parsed.hint + " => event not available." };
    }
    const versionMajor = snapshot.versionMajor ??
      parseMajorVersion(spreedCaps?.version) ??
      parseMajorVersion(capabilities?.spreed?.version);
    if (versionMajor !== null && versionMajor < 32){
      return { supported:false, reason:"Cloud capabilities: Nextcloud version " + versionMajor + " (<32) => event disabled." };
    }
    if (versionMajor !== null && versionMajor >= 32){
      return { supported:null, reason:"Cloud capabilities: Nextcloud version " + versionMajor + " does not expose an event flag." };
    }
    return { supported:null, reason:"Cloud capabilities without event indicators." };
  }catch(error){
    logTalkCoreError("requestCoreCapabilities failed", error, {
      baseUrl: options?.baseUrl || ""
    });
    if (error?.ncCapabilitiesCode === "minimum_version"){
      return { supported:false, reason:error.message };
    }
    return { supported:null, reason: error?.message || "Cloud capabilities endpoint unreachable." };
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
  const coreResult = await requestCoreCapabilities({ baseUrl, user, appPass });
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
 * @param {string} languageOverride
 * @returns {Promise<string>}
 */
async function buildStandardTalkDescription(url, password, languageOverride = ""){
  const override = typeof NCI18nOverride !== "undefined" && typeof NCI18nOverride.normalizeLanguageOverride === "function"
    ? NCI18nOverride.normalizeLanguageOverride(languageOverride, { allowCustom: true })
    : String(languageOverride || "").trim().toLowerCase();
  const lang = (override && override !== "default" && override !== "custom")
    ? override
    : await getEventDescriptionLang();
  const heading = await descriptionI18n(lang, "ui_description_heading");
  const joinLabel = await descriptionI18n(lang, "ui_description_join_label");
  const passwordLine = password
    ? await descriptionI18n(lang, "ui_description_password_line", [password])
    : "";
  const helpLabel = await descriptionI18n(lang, "ui_description_help_label");
  const helpUrl = (await descriptionI18n(lang, "ui_description_help_url"))
    || "https://docs.nextcloud.com/server/latest/user_manual/en/talk/guest.html";
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
 * Create one Talk room using exactly one server-side create path.
 * @returns {Promise<{url:string,token:string,reason:string|null,description:string}>}
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
    if (supportInfo.supported === false){
      const detail = supportInfo.reason || bgI18n("error_room_create_failed");
      const error = localizedError("error_ocs", [detail]);
      error.fatal = true;
      error.status = 0;
      error.response = "";
      error.meta = null;
      error.payload = null;
      throw error;
    }
  }

  const includeEvent = attemptEvent;
  L("create attempt start", { includeEvent });
  const body = {
    roomType: ROOM_TYPE_PUBLIC,
    type: ROOM_TYPE_PUBLIC,
    roomName: title || "Meeting",
    listable: listableScope,
    participants: {}
  };
  if (password) body.password = password;
  if (cleanedDescription) body.description = cleanedDescription;
  if (includeEvent){
    body.objectType = "event";
    body.objectId = String(objectId).trim();
  }

  const response = await requestTalkOcs({
    url: createUrl,
    method:"POST",
    headers,
    body: JSON.stringify(body)
  });
  L("create attempt status", { includeEvent, status: response.status, ok: response.ok });
  const data = response.data;
  if (!isTalkOcsSuccess(response)){
    const meta = data?.ocs?.meta || {};
    const payload = getTalkOcsData(response) || {};
    L("create attempt failure", {
      includeEvent,
      status: response.status,
      meta: meta?.message || null,
      error: payload?.error || null
    });
    if (includeEvent){
      noteEventSupport(false, payload?.error || meta?.message || "");
    }
    const parts = [];
    if (meta.message && meta.message !== meta.status) parts.push(meta.message);
    if (payload.error) parts.push(payload.error);
    if (Array.isArray(payload.errors)) parts.push(...payload.errors);
    if (meta.statuscode) parts.push("Status code " + meta.statuscode);
    if (response.status) parts.push("HTTP " + response.status + " " + response.statusText);
    const detail = parts.filter(Boolean).join(" / ") || getTalkOcsFailureDetail(response);
    const error = localizedError("error_ocs", [detail]);
    error.fatal = true;
    error.status = response.status;
    error.response = response.raw;
    error.meta = meta;
    error.payload = payload;
    throw error;
  }
  if (includeEvent){
    noteEventSupport(true, "");
  }

  const token = data?.ocs?.data?.token || data?.ocs?.data?.roomToken || data?.token || data?.data?.token;
  if (!token){
    throw localizedError("error_token_missing_in_response");
  }
  L("create attempt success", {
    includeEvent,
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
      const lobbyResponse = await requestTalkOcs({
        url: lobbyUrl,
        method:"PUT",
        headers,
        body: JSON.stringify(lobbyPayload)
      });
      if (!isTalkOcsSuccess(lobbyResponse)){
        const detail = getTalkOcsFailureDetail(lobbyResponse);
        L("lobby set failed", lobbyResponse.status, lobbyResponse.statusText, detail);
        throw makeTalkOcsError("error_lobby_set_failed", lobbyResponse);
      }
      L("lobby set success", {
        token: shortToken(token),
        timer: lobbyPayload.timer ?? null
      });
    }catch(error){
      logTalkCoreError("lobby update error", error, {
        token: shortToken(token)
      });
      await deleteCreatedRoomAfterLobbySetupFailure(token);
      throw error;
    }
  }
  if (enableListable){
    try{
      const listableUrl = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + token + "/listable";
      const listableResponse = await requestTalkOcs({
        url: listableUrl,
        method:"PUT",
        headers,
        body: JSON.stringify({ scope: listableScope })
      });
      if (!isTalkOcsSuccess(listableResponse)){
        const error = makeTalkOcsError("error_ocs", listableResponse);
        L(
          "listable set failed status",
          listableResponse.status,
          listableResponse.statusText,
          getTalkOcsFailureDetail(listableResponse)
        );
        logTalkCoreError("listable update failed", error, {
          token: shortToken(token)
        });
      }else{
        L("listable set success", {
          token: shortToken(token),
          scope: listableScope
        });
      }
    }catch(error){
      logTalkCoreError("listable update error", error, {
        token: shortToken(token)
      });
    }
  }
  const finalDescription = await buildRoomDescription(description, url, password);
  const allowDescriptionUpdate = !(includeEvent && eventConversation);
  if (allowDescriptionUpdate && finalDescription && finalDescription !== cleanedDescription){
    try{
      const descUrl = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + token + "/description";
      const descriptionResponse = await requestTalkOcs({
        url: descUrl,
        method:"PUT",
        headers,
        body: JSON.stringify({ description: finalDescription })
      });
      if (!isTalkOcsSuccess(descriptionResponse)){
        const error = makeTalkOcsError("error_ocs", descriptionResponse);
        L(
          "description set failed status",
          descriptionResponse.status,
          descriptionResponse.statusText,
          getTalkOcsFailureDetail(descriptionResponse)
        );
        logTalkCoreError("description update failed", error, {
          token: shortToken(token)
        });
      }else{
        L("description update success", { token: shortToken(token) });
      }
    }catch(error){
      logTalkCoreError("description update error", error, {
        token: shortToken(token)
      });
    }
  }
  L("create attempt complete", {
    includeEvent,
    token: shortToken(token),
    reason: null
  });
  return {
    url,
    token,
    reason: null,
    description: finalDescription || cleanedDescription || ""
  };
}

async function deleteCreatedRoomAfterLobbySetupFailure(token){
  try{
    await deleteTalkRoom({ token });
    L("created room deleted after lobby setup failure", {
      token: shortToken(token)
    });
  }catch(error){
    logTalkCoreError("created room cleanup after lobby setup failure failed", error, {
      token: shortToken(token)
    });
  }
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
  const response = await requestTalkOcs({
    url: lobbyUrl,
    method:"PUT",
    headers,
    body: JSON.stringify(payload)
  });
  if (!isTalkOcsSuccess(response)) {
    if (response.status === 403) {
      throw localizedError("error_lobby_no_permission");
    }
    throw makeTalkOcsError("error_lobby_update_failed", response);
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
async function deleteTalkRoom({ token, signal } = {}){
  if (!token) throw localizedError("error_room_token_missing");
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass) throw localizedError("error_credentials_missing");
  await ensureHostPermission(baseUrl);
  const auth = NCOcs.buildAuthHeader(user, appPass);
  const headers = { "OCS-APIRequest": "true", "Authorization": auth, "Accept":"application/json" };
  const base = baseUrl.replace(/\/$/,"");
  const url = base + "/ocs/v2.php/apps/spreed/api/v4/room/" + encodeURIComponent(token);
  L("delete talk room request", { token: shortToken(token) });
  const response = await requestTalkOcs({
    url,
    method:"DELETE",
    headers,
    signal
  });
  L("delete talk room status", {
    token: shortToken(token),
    status: response.status,
    ok: response.ok
  });
  if (response.status === 404){
    L("delete talk room already removed", { token: shortToken(token) });
    return true;
  }
  if (!isTalkOcsSuccess(response)){
    throw makeTalkOcsError("error_room_delete_failed", response);
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
  const response = await requestTalkOcs({ url: infoUrl, method:"GET", headers });
  if (response.status === 404){
    return [];
  }
  if (!isTalkOcsSuccess(response)){
    throw makeTalkOcsError("error_ocs", response);
  }
  const participants = getTalkOcsData(response);
  const list = Array.isArray(participants) ? participants : [];
  L("get room participants result", { token: shortToken(token), count: list.length });
  return list;
}

function findTalkParticipant(participants, actorId){
  const target = String(actorId || "").trim().toLowerCase();
  if (!target){
    return null;
  }
  return (participants || []).find((participant) => {
    return String(participant?.actorId || "").trim().toLowerCase() === target;
  }) || null;
}

function isTalkModeratorParticipant(participant){
  return [1, 2, 6].includes(Number(participant?.participantType));
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
  const response = await requestTalkOcs({
    url,
    method:"POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!isTalkOcsSuccess(response)){
    if (response.status === 409){
      const participants = await getTalkRoomParticipants({ token });
      const existing = findTalkParticipant(participants, actorId);
      if (existing){
        L("add participant conflict verified", {
          token: shortToken(token),
          actor: String(actorId).trim()
        });
        return existing;
      }
    }
    throw makeTalkOcsError("error_participant_add_failed", response);
  }
  L("add participant result", {
    token: shortToken(token),
    status: response.status
  });
  const added = getTalkOcsData(response);
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
  const response = await requestTalkOcs({
    url,
    method:"POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!isTalkOcsSuccess(response)){
    if (response.status === 409){
      const participants = await getTalkRoomParticipants({ token });
      const promoted = participants.find((participant) => {
        return Number(participant?.attendeeId) === attendeeId
          && isTalkModeratorParticipant(participant);
      });
      if (promoted){
        L("promote moderator conflict verified", {
          token: shortToken(token),
          attendeeId
        });
        return true;
      }
    }
    throw makeTalkOcsError("error_moderator_set_failed", response);
  }
  L("promote moderator success", {
    token: shortToken(token),
    status: response.status
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
  const response = await requestTalkOcs({ url, method:"DELETE", headers });
  if (response.status !== 404 && !isTalkOcsSuccess(response)){
    throw makeTalkOcsError("error_leave_failed", response);
  }
  L("leave room success", { token: shortToken(token), status: response.status });
  return true;
}
/**
 * Delegate moderation to another user, optionally leaving the room.
 */
async function delegateRoomModerator({ token, newModerator, leaveSelf = true } = {}){
  if (!token || !newModerator) throw localizedError("error_delegation_data_missing");
  const opts = await getOpts();
  const targetId = String(newModerator).trim();
  if (!targetId) throw localizedError("error_moderator_target_missing");
  const currentUser = await NCCore.getCurrentUserId(opts);
  L("delegate moderator request", {
    token: shortToken(token),
    target: targetId,
    currentUser
  });
  let participants = await getTalkRoomParticipants({ token });
  let match = findTalkParticipant(participants, targetId);
  if (!match){
    await addTalkParticipant({ token, actorId: targetId, source: "users" });
    participants = await getTalkRoomParticipants({ token });
    match = findTalkParticipant(participants, targetId);
  }
  if (!match){
    throw localizedError("error_participant_not_found");
  }
  if (!isTalkModeratorParticipant(match)){
    await promoteTalkModerator({ token, attendeeId: match.attendeeId });
    participants = await getTalkRoomParticipants({ token });
    match = findTalkParticipant(participants, targetId);
    if (!isTalkModeratorParticipant(match)){
      throw localizedError("error_moderator_set_failed");
    }
  }
  const loweredUser = String(currentUser || "").trim().toLowerCase();
  const shouldLeaveSelf = !!(loweredUser && loweredUser !== targetId.toLowerCase());
  if (leaveSelf && shouldLeaveSelf){
    await leaveTalkRoom({ token });
    L("delegate moderator completed", { token: shortToken(token), delegate: targetId, leftSelf: true });
    return { leftSelf: true, shouldLeaveSelf, delegate: targetId };
  }
  L("delegate moderator completed", { token: shortToken(token), delegate: targetId, leftSelf: false });
  return { leftSelf: false, shouldLeaveSelf, delegate: targetId };
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
