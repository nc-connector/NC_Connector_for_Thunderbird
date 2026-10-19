/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

/**
 * Core helpers for Login Flow v2 and credential checks.
 * Runs in the same context as talkcore/background.
 */
const NCCore = (() => {
  const DEVICE_NAME = "NC Connector for Thunderbird";
  const coreShortId = NCTalkTextUtils.shortId;
  const resolveLogPrefix = () =>
    globalThis.NCLogContext?.resolveAddonLogPrefix?.("Core")
    || "[NCBG]";
  const currentUserIdCache = new Map();
  const capabilitiesCache = new Map();
  const capabilitiesInflight = new Map();
  const CAPABILITIES_CACHE_MS = 5 * 60 * 1000;
  const MINIMUM_NEXTCLOUD_MAJOR = 32;
  const LOGIN_FLOW_REQUEST_TIMEOUT_MS = 60000;
  const CONNECTION_STATE_KEY = "ncConnectionStateV1";
  const VERIFIED_CONNECTION_MS = 5 * 60 * 1000;
  const DEFAULT_RATE_LIMIT_MS = 60 * 1000;
  const restoredListeners = new Set();
  const verifiedConnections = new Map();
  let connectionStateQueue = Promise.resolve();
  let rateLimitTimer = null;
  let savedVerifiedConnection = null;
  let lastRestoredConnection = null;

  function logNCCoreError(scope, error, details = undefined){
    globalThis.NCLogContext.safeConsoleError(resolveLogPrefix(), scope, error, details);
  }

  function createLoginFlowError(message = ""){
    const fallback = globalThis.NCLogContext.redactSensitiveText(message || (typeof bgI18n === "function"
      ? bgI18n("options_loginflow_failed")
      : "Login flow failed."));
    const error = new Error(fallback || "Login flow failed.");
    error.ncLoginFlowFatal = true;
    return error;
  }

  function normalizeBaseUrl(input){
    return NCTalkTextUtils.normalizeBaseUrl(input);
  }

  function serializeConnectionState(callback){
    const operation = connectionStateQueue.then(callback);
    connectionStateQueue = operation.catch((error) => {
      logNCCoreError("connection state update failed", error);
    });
    return operation;
  }

  async function readConnectionState(){
    const stored = await browser.storage.local.get(CONNECTION_STATE_KEY);
    const state = stored[CONNECTION_STATE_KEY];
    return {
      baseUrl: normalizeBaseUrl(state?.baseUrl),
      authenticationRejected: state?.authenticationRejected === true,
      rateLimitOrigin: typeof state?.rateLimitOrigin === "string" ? state.rateLimitOrigin : "",
      retryAt: Number.isFinite(state?.retryAt) && state.retryAt > 0 ? state.retryAt : 0
    };
  }

  function connectionStateForUi(state, options, requestUrl){
    const requestBase = requestUrl || options.baseUrl;
    const origin = requestBase ? new URL(requestBase).origin : "";
    const rateLimited = state.retryAt > Date.now() && state.rateLimitOrigin === origin;
    const rejected = state.authenticationRejected && state.baseUrl === options.baseUrl
      && !!options.user && !!options.appPass;
    return Object.freeze({
      reason: rateLimited ? "rate_limited" : (rejected ? "auth_required" : ""),
      retryAt: rateLimited ? state.retryAt : 0
    });
  }

  function notifyConnectionRestored(identity, key){
    lastRestoredConnection = { identity, key };
    for (const listener of restoredListeners){
      Promise.resolve().then(() => listener(identity)).catch((error) => {
        logNCCoreError("connection recovery listener failed", error);
      });
    }
  }

  function scheduleRateLimitExpiry(state){
    if (rateLimitTimer != null){
      clearTimeout(rateLimitTimer);
      rateLimitTimer = null;
    }
    if (state.retryAt <= Date.now()) return;
    rateLimitTimer = setTimeout(() => {
      rateLimitTimer = null;
      getConnectionState().catch((error) => {
        logNCCoreError("rate limit recovery failed", error);
      });
    }, Math.min(state.retryAt - Date.now(), 2147483647));
  }

  async function getConnectionState(requestUrl = null){
    const options = await getOpts();
    let resumeAfterWait = false;
    const state = await serializeConnectionState(async () => {
      const stored = await readConnectionState();
      if (stored.retryAt && stored.retryAt <= Date.now()){
        stored.retryAt = 0;
        await browser.storage.local.set({ [CONNECTION_STATE_KEY]: stored });
        const currentAuthenticationRejected = stored.authenticationRejected
          && stored.baseUrl === options.baseUrl;
        resumeAfterWait = !currentAuthenticationRejected && !!options.baseUrl
          && stored.rateLimitOrigin === new URL(options.baseUrl).origin;
      }
      scheduleRateLimitExpiry(stored);
      return connectionStateForUi(stored, options, requestUrl);
    });
    if (resumeAfterWait){
      if (options.baseUrl && options.user && options.appPass){
        Promise.resolve().then(async () => {
          const userId = await getCurrentUserId(options);
          notifyConnectionRestored({ baseUrl: options.baseUrl, userId }, verifiedConnectionKey(options));
        }).catch((error) => {
          logNCCoreError("rate limit account recovery failed", error);
        });
      }
    }
    return state;
  }

  function createConnectionPausedError(reason, retryAt = 0){
    const message = bgI18n(reason === "rate_limited" ? "connection_rate_limited" : "connection_auth_required");
    const error = new Error(message);
    error.status = reason === "rate_limited" ? 429 : 401;
    error.code = reason;
    error.ncAuthenticationPaused = reason !== "rate_limited";
    error.ncRateLimited = reason === "rate_limited";
    error.ncUserMessage = message;
    error.retryAt = retryAt;
    error.ncCapabilitiesCode = reason === "rate_limited" ? "rate_limited" : "auth";
    error.ncCurrentUserIdCode = error.ncCapabilitiesCode;
    return error;
  }

  function isConnectionPausedError(error){
    return error?.ncAuthenticationPaused === true || error?.ncRateLimited === true
      || error?.status === 401 || error?.status === 429;
  }

  function requestUsesSavedCredentials(url, authHeader, options){
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    return !!baseUrl && !!options.user && !!options.appPass
      && (url === baseUrl || url.startsWith(baseUrl + "/"))
      && authHeader === NCOcs.buildAuthHeader(options.user, options.appPass);
  }

  async function assertAuthenticationAllowed(url, authHeader, verification){
    const options = await getOpts();
    const matchesSaved = requestUsesSavedCredentials(url, authHeader, options);
    const state = await getConnectionState(url);
    if (state.reason === "rate_limited"){
      throw createConnectionPausedError(state.reason, state.retryAt);
    }
    if (!verification && state.reason === "auth_required"){
      throw createConnectionPausedError(state.reason);
    }
    // A delayed operation must not replay a password replaced by a verified save.
    if (!verification && !matchesSaved){
      throw createConnectionPausedError("auth_required");
    }
  }

  function readRetryAfter(response){
    const raw = response.headers?.get?.("Retry-After")
      ?? response.getHeader?.("Retry-After")
      ?? response.getResponseHeader?.("Retry-After");
    const numeric = Number(String(raw ?? "").trim());
    if (raw != null && String(raw).trim() && Number.isFinite(numeric) && numeric >= 0){
      return Date.now() + numeric * 1000;
    }
    const date = Date.parse(String(raw || ""));
    return Number.isFinite(date) && date > Date.now() ? date : Date.now() + DEFAULT_RATE_LIMIT_MS;
  }

  async function runAuthenticatedRequest({ url, authHeader, request, verification = false }){
    await assertAuthenticationAllowed(url, authHeader, verification);
    const response = await request();
    if (response.status !== 401 && response.status !== 429) return response;
    let state = null;
    await serializeConnectionState(async () => {
      const options = await getOpts();
      const matchesSaved = requestUsesSavedCredentials(url, authHeader, options);
      const stored = await readConnectionState();
      if (response.status === 401 && matchesSaved){
        stored.baseUrl = options.baseUrl;
        stored.authenticationRejected = true;
        capabilitiesCache.clear();
        capabilitiesInflight.clear();
        verifiedConnections.delete(verifiedConnectionKey(options));
        savedVerifiedConnection = null;
        lastRestoredConnection = null;
      }
      if (response.status === 429){
        const origin = new URL(url).origin;
        const retryAt = readRetryAfter(response);
        stored.retryAt = stored.rateLimitOrigin === origin ? Math.max(stored.retryAt, retryAt) : retryAt;
        stored.rateLimitOrigin = origin;
      }
      if ((response.status === 401 && matchesSaved) || response.status === 429){
        await browser.storage.local.set({ [CONNECTION_STATE_KEY]: stored });
        scheduleRateLimitExpiry(stored);
        if (typeof L === "function"){
          L("Nextcloud requests paused", { reason: response.status === 401 ? "auth_required" : "rate_limited", retryAt: stored.retryAt });
        }
      }
      state = stored;
    });
    const reason = response.status === 429 ? "rate_limited" : "auth_required";
    const error = createConnectionPausedError(reason, state.retryAt);
    error.ncCapabilitiesCode = response.status === 401 ? "auth" : "rate_limited";
    error.ncCurrentUserIdCode = error.ncCapabilitiesCode;
    throw error;
  }

  function verifiedConnectionKey({ baseUrl, user, appPass }){
    return JSON.stringify([normalizeBaseUrl(baseUrl), String(user || "").trim(), appPass]);
  }

  async function commitVerifiedConnection(options){
    const key = verifiedConnectionKey(options);
    const proof = verifiedConnections.get(key);
    if (!proof || Date.now() - proof.verifiedAt > VERIFIED_CONNECTION_MS){
      throw new Error(bgI18n("options_test_failed"));
    }
    await serializeConnectionState(async () => {
      const stored = await getOpts();
      if (verifiedConnectionKey(stored) !== key){
        throw new Error(bgI18n("options_test_failed"));
      }
      const state = await readConnectionState();
      const resumed = { ...state, baseUrl: "", authenticationRejected: false };
      await browser.storage.local.set({ [CONNECTION_STATE_KEY]: resumed });
      scheduleRateLimitExpiry(resumed);
      capabilitiesCache.clear();
      capabilitiesInflight.clear();
      currentUserIdCache.clear();
      currentUserIdCache.set(`${normalizeBaseUrl(stored.baseUrl)}\n${stored.user}`, proof.userId);
      savedVerifiedConnection = { key, userId: proof.userId };
      verifiedConnections.clear();
      if (typeof L === "function"){
        L("Nextcloud verified connection saved", {
          rateLimited: state.retryAt > Date.now() && state.rateLimitOrigin === new URL(stored.baseUrl).origin
        });
      }
    });
    const state = await getConnectionState();
    if (!state.reason){
      notifyConnectionRestored({ baseUrl: normalizeBaseUrl(options.baseUrl), userId: proof.userId }, key);
    }
    return state;
  }

  async function getVerifiedConnectionIdentity(){
    if (!savedVerifiedConnection || (await getConnectionState()).reason) return null;
    const options = await getOpts();
    return verifiedConnectionKey(options) === savedVerifiedConnection.key
      ? { baseUrl: options.baseUrl, userId: savedVerifiedConnection.userId }
      : null;
  }

  async function removeSavedCredentials(){
    await serializeConnectionState(async () => {
      await browser.storage.local.remove(["user", "appPass"]);
      capabilitiesCache.clear();
      capabilitiesInflight.clear();
      currentUserIdCache.clear();
      verifiedConnections.clear();
      savedVerifiedConnection = null;
      lastRestoredConnection = null;
      if (typeof L === "function") L("Nextcloud saved credentials removed");
    });
    return getConnectionState();
  }

  function addConnectionRestoredListener(listener){
    restoredListeners.add(listener);
    // Restart recovery may finish before a later background script registers.
    const restored = lastRestoredConnection;
    if (restored){
      Promise.resolve().then(async () => {
        const options = await getOpts();
        const state = await getConnectionState();
        if (restoredListeners.has(listener) && lastRestoredConnection === restored
          && !state.reason && verifiedConnectionKey(options) === restored.key){
          await listener(restored.identity);
        }
      }).catch((error) => {
        logNCCoreError("connection recovery listener replay failed", error);
      });
    }
  }

  /**
   * Build DAV roots for a resolved Nextcloud account.
   * @param {{baseUrl:string,user:string,appPass:string,userId:string}} account
   * @returns {{baseUrl:string,userId:string,authHeader:string,davRoot:string,uploadRoot:string,bulkUrl:string,accountIdentity:string}}
   */
  function buildDavAccountContext({ baseUrl, user, appPass, userId } = {}){
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const loginName = typeof user === "string" ? user.trim() : "";
    const password = typeof appPass === "string" ? appPass : "";
    const canonicalUserId = typeof userId === "string" ? userId.trim() : "";
    if (!normalizedBaseUrl || !loginName || !password || !canonicalUserId){
      throw new TypeError("DAV account data is incomplete");
    }
    const encodedUserId = encodeURIComponent(canonicalUserId);
    return Object.freeze({
      baseUrl: normalizedBaseUrl,
      userId: canonicalUserId,
      authHeader: NCOcs.buildAuthHeader(loginName, password),
      davRoot: `${normalizedBaseUrl}/remote.php/dav/files/${encodedUserId}`,
      uploadRoot: `${normalizedBaseUrl}/remote.php/dav/uploads/${encodedUserId}`,
      bulkUrl: `${normalizedBaseUrl}/remote.php/dav/bulk`,
      accountIdentity: JSON.stringify([normalizedBaseUrl, canonicalUserId])
    });
  }

  function createCurrentUserIdError(code, message){
    const error = new Error(globalThis.NCLogContext.redactSensitiveText(message || bgI18n("options_test_failed")));
    error.ncCurrentUserIdCode = code || "identity";
    return error;
  }

  function createCapabilitiesError(code, message, status = 0){
    const error = new Error(globalThis.NCLogContext.redactSensitiveText(message || bgI18n("options_test_failed")));
    error.ncCapabilitiesCode = code || "http";
    error.status = Number(status) || 0;
    return error;
  }

  function throwIfRequestAborted(signal){
    if (!signal?.aborted){
      return;
    }
    const error = new Error("Aborted");
    error.name = "AbortError";
    throw error;
  }

  function parseVersionPart(value){
    const numeric = Number.parseInt(String(value ?? "").trim(), 10);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  }

  function parseNextcloudVersion(versionValue, fallbackValue = ""){
    let versionString = "";
    let major = null;
    let minor = null;
    let micro = null;
    if (versionValue && typeof versionValue === "object"){
      major = parseVersionPart(versionValue.major);
      minor = parseVersionPart(versionValue.minor);
      micro = parseVersionPart(versionValue.micro);
      if (typeof versionValue.string === "string" && versionValue.string.trim()){
        versionString = versionValue.string.trim();
      }
    }else if (typeof versionValue === "string" || typeof versionValue === "number"){
      versionString = String(versionValue).trim();
    }
    if (!versionString && fallbackValue != null){
      versionString = String(fallbackValue).trim();
    }
    if (major == null && versionString){
      const match = versionString.match(/^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
      if (match){
        major = parseVersionPart(match[1]);
        minor = parseVersionPart(match[2]);
        micro = parseVersionPart(match[3]);
      }
    }
    if (!versionString && major != null){
      const parts = [major];
      if (minor != null) parts.push(minor);
      if (micro != null) parts.push(micro);
      versionString = parts.join(".");
    }
    return Object.freeze({
      string: versionString,
      major,
      minor,
      micro
    });
  }

  async function fetchCapabilitiesSnapshot({
    normalizedBase,
    trimmedUser,
    password,
    cacheKey,
    signal,
    verification
  }){
    throwIfRequestAborted(signal);
    await ensureHostPermission(normalizedBase);
    throwIfRequestAborted(signal);
    const url = normalizedBase + "/ocs/v2.php/cloud/capabilities?format=json";
    let response;
    let raw = "";
    try{
      const requestResult = await NCOcs.runWithTimeout(async (requestSignal) => {
        const authHeader = NCOcs.buildAuthHeader(trimmedUser, password);
        const fetched = await runAuthenticatedRequest({ url, authHeader, verification, request: () => fetch(url, {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          headers: {
            "OCS-APIRequest": "true",
            "Authorization": authHeader,
            "Accept": "application/json"
          },
          signal: requestSignal
        }) });
        const responseText = await fetched.text().catch((error) => {
          if (requestSignal?.aborted || error?.name === "AbortError"){
            throw error;
          }
          logNCCoreError("capabilities response read failed", error);
          throw error;
        });
        return { response: fetched, raw: responseText };
      }, {
        signal
      });
      response = requestResult.response;
      raw = requestResult.raw;
    }catch(error){
      if (isConnectionPausedError(error)) throw error;
      if (signal?.aborted || error?.name === "AbortError"){
        throwIfRequestAborted(signal);
        throw error;
      }
      logNCCoreError("capabilities request failed", error, { base: normalizedBase });
      throw createCapabilitiesError("network", error?.message || String(error));
    }

    let data = null;
    try{
      data = raw ? JSON.parse(raw) : null;
    }catch(error){
      logNCCoreError("capabilities json parse failed", error, {
        responseLength: String(raw || "").length
      });
    }
    if (response.status === 401 || response.status === 403){
      const detail = data?.ocs?.meta?.message || "HTTP " + response.status;
      throw createCapabilitiesError("auth", detail, response.status);
    }
    if (!response.ok){
      const detail = data?.ocs?.meta?.message || (response.status + " " + response.statusText);
      throw createCapabilitiesError("http", detail, response.status);
    }
    const meta = data?.ocs?.meta;
    const ocsResponse = { ok: response.ok, data, raw };
    const hasMetaResult = NCOcs.hasExplicitResult(ocsResponse);
    const metaStatusCode = Number(meta?.statuscode);
    if (!NCOcs.isExplicitSuccess(ocsResponse)){
      throw createCapabilitiesError(
        hasMetaResult ? "ocs" : "invalid",
        NCOcs.getFailureMessage(ocsResponse, bgI18n("options_test_failed")),
        metaStatusCode
      );
    }
    if (!data?.ocs?.data || typeof data.ocs.data !== "object"){
      throw createCapabilitiesError("invalid", bgI18n("options_test_failed"));
    }

    const ocsData = data.ocs.data;
    const version = parseNextcloudVersion(
      ocsData.version,
      ocsData.versionstring ?? ocsData.versionString ?? ""
    );
    const bulkVersion = ocsData.capabilities?.dav?.bulkupload;
    const snapshot = Object.freeze({
      baseUrl: normalizedBase,
      user: trimmedUser,
      version,
      versionString: version.string,
      versionMajor: version.major,
      bulkUploadSupported: typeof bulkVersion === "string" && bulkVersion.trim() === "1.0",
      capabilities: ocsData.capabilities || {},
      loadedAt: Date.now()
    });
    capabilitiesCache.set(cacheKey, snapshot);
    if (typeof L === "function"){
      L("Nextcloud capabilities loaded", {
        version: snapshot.versionString || "?",
        davBulkUpload: snapshot.bulkUploadSupported ? "1.0" : "off"
      });
    }
    return snapshot;
  }

  async function getCapabilitiesSnapshot({
    baseUrl,
    user,
    appPass,
    forceRefresh = false,
    signal = null,
    verification = false
  } = {}){
    const normalizedBase = normalizeBaseUrl(typeof baseUrl === "string" ? baseUrl.trim() : "");
    const trimmedUser = typeof user === "string" ? user.trim() : "";
    const password = typeof appPass === "string" ? appPass : "";
    if (!normalizedBase || !trimmedUser || !password){
      throw createCapabilitiesError("missing", bgI18n("error_credentials_missing"));
    }
    throwIfRequestAborted(signal);
    await assertAuthenticationAllowed(normalizedBase + "/ocs/v2.php/cloud/capabilities", NCOcs.buildAuthHeader(trimmedUser, password), verification);

    const cacheKey = `${normalizedBase}\n${trimmedUser}`;
    const cached = capabilitiesCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.loadedAt < CAPABILITIES_CACHE_MS){
      return cached;
    }
    if (signal || forceRefresh || verification){
      return fetchCapabilitiesSnapshot({
        normalizedBase,
        trimmedUser,
        password,
        cacheKey,
        signal,
        verification
      });
    }
    if (capabilitiesInflight.has(cacheKey)){
      return capabilitiesInflight.get(cacheKey);
    }

    const request = fetchCapabilitiesSnapshot({
      normalizedBase,
      trimmedUser,
      password,
      cacheKey,
      signal: null,
      verification
    });
    capabilitiesInflight.set(cacheKey, request);
    try{
      return await request;
    }finally{
      if (capabilitiesInflight.get(cacheKey) === request){
        capabilitiesInflight.delete(cacheKey);
      }
    }
  }

  function requireSupportedNextcloud(snapshot){
    if (snapshot?.versionMajor != null && snapshot.versionMajor >= MINIMUM_NEXTCLOUD_MAJOR){
      return snapshot;
    }
    const detectedVersion = snapshot?.versionString || "?";
    throw createCapabilitiesError(
      "minimum_version",
      bgI18n("nextcloud_minimum_version_required", [detectedVersion])
    );
  }

  async function getRequiredCapabilities(options = null){
    const source = options && typeof options === "object"
      ? options
      : await getOpts();
    return requireSupportedNextcloud(await getCapabilitiesSnapshot(source));
  }

  async function resolveCurrentUserId({
    baseUrl,
    user,
    appPass,
    forceRefresh = false,
    signal = null,
    verification = false
  } = {}){
    const normalizedBase = normalizeBaseUrl(typeof baseUrl === "string" ? baseUrl.trim() : "");
    const trimmedUser = typeof user === "string" ? user.trim() : "";
    const password = typeof appPass === "string" ? appPass : "";
    if (!normalizedBase || !trimmedUser || !password){
      throw createCurrentUserIdError("missing", bgI18n("error_credentials_missing"));
    }
    throwIfRequestAborted(signal);

    const cacheKey = `${normalizedBase}\n${trimmedUser}`;
    if (!forceRefresh && currentUserIdCache.has(cacheKey)){
      return currentUserIdCache.get(cacheKey);
    }

    throwIfRequestAborted(signal);
    await ensureHostPermission(normalizedBase);
    throwIfRequestAborted(signal);
    const userUrl = normalizedBase + "/ocs/v2.php/cloud/user?format=json";
    let response;
    let raw = "";
    try{
      const requestResult = await NCOcs.runWithTimeout(async (requestSignal) => {
        const authHeader = NCOcs.buildAuthHeader(trimmedUser, password);
        const fetched = await runAuthenticatedRequest({ url: userUrl, authHeader, verification, request: () => fetch(userUrl, {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          headers: {
            "OCS-APIRequest": "true",
            "Authorization": authHeader,
            "Accept": "application/json"
          },
          signal: requestSignal
        }) });
        const responseText = await fetched.text().catch((error) => {
          if (requestSignal?.aborted || error?.name === "AbortError"){
            throw error;
          }
          logNCCoreError("current user id response read failed", error);
          throw error;
        });
        return { response: fetched, raw: responseText };
      }, {
        signal
      });
      response = requestResult.response;
      raw = requestResult.raw;
    }catch(error){
      if (isConnectionPausedError(error)) throw error;
      if (signal?.aborted || error?.name === "AbortError"){
        throwIfRequestAborted(signal);
        throw error;
      }
      logNCCoreError("current user id request failed", error, { base: normalizedBase });
      throw createCurrentUserIdError("network", error?.message || String(error));
    }

    let data = null;
    try{
      data = raw ? JSON.parse(raw) : null;
    }catch(error){
      logNCCoreError("current user id json parse failed", error, {
        responseLength: String(raw || "").length
      });
    }

    if (response.status === 401 || response.status === 403){
      throw createCurrentUserIdError("auth", bgI18n("options_test_failed_auth"));
    }
    if (!response.ok){
      const detail = data?.ocs?.meta?.message || (response.status + " " + response.statusText);
      throw createCurrentUserIdError("http", detail);
    }

    const rawUserId = data?.ocs?.data?.id;
    const userId = typeof rawUserId === "string" ? rawUserId.trim() : "";
    if (!userId){
      // Login aliases such as email addresses must never be substituted into user-scoped DAV paths.
      logNCCoreError("current user id missing", new Error("ocs.data.id missing"), {
        base: normalizedBase,
        user: coreShortId(trimmedUser)
      });
      throw createCurrentUserIdError("identity", bgI18n("options_test_failed"));
    }

    currentUserIdCache.set(cacheKey, userId);
    if (typeof L === "function"){
      L("current user id resolved", {
        base: normalizedBase,
        authUser: coreShortId(trimmedUser),
        userId: coreShortId(userId)
      });
    }
    return userId;
  }

  async function getCurrentUserId(options = null){
    const source = options && typeof options === "object"
      ? options
      : await getOpts();
    return resolveCurrentUserId(source);
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
      message: bgI18n("error_host_permission_missing"),
      scope: "host permission missing"
    });
  }

  /**
   * Validate base URL, username, and app password via OCS.
   * Calls /cloud/capabilities first and then /cloud/user.
   * @param {{baseUrl:string,user:string,appPass:string}} params
   * @returns {Promise<{ok:boolean, code:string, message?:string, version?:string, userId?:string}>}
   */
  async function testCredentials({ baseUrl, user, appPass } = {}){
    const rawBase = typeof baseUrl === "string" ? baseUrl.trim() : "";
    const normalizedBase = normalizeBaseUrl(rawBase);
    const trimmedUser = typeof user === "string" ? user.trim() : "";
    const password = typeof appPass === "string" ? appPass : "";
    const verificationKey = verifiedConnectionKey({ baseUrl: normalizedBase, user: trimmedUser, appPass: password });
    verifiedConnections.delete(verificationKey);
    if (!rawBase || !trimmedUser || !password){
      return { ok:false, code:"missing", message: bgI18n("error_credentials_missing") };
    }
    if (!normalizedBase){
      return { ok:false, code:"https_required", message: bgI18n("error_baseurl_https_required") };
    }
    try{
      L("options test connection", { base: normalizedBase, user: coreShortId(trimmedUser) });
      const snapshot = requireSupportedNextcloud(await getCapabilitiesSnapshot({
        baseUrl: normalizedBase,
        user: trimmedUser,
        appPass: password,
        forceRefresh: true,
        verification: true
      }));
      const versionStr = snapshot.versionString;
      const message = versionStr ? "Nextcloud " + versionStr : "";
      try{
        const userId = await resolveCurrentUserId({
          baseUrl: normalizedBase,
          user: trimmedUser,
          appPass: password,
          forceRefresh: true,
          verification: true
        });
        if (verifiedConnections.size >= 10) verifiedConnections.delete(verifiedConnections.keys().next().value);
        verifiedConnections.set(verificationKey, {
          userId,
          verifiedAt: Date.now()
        });
        L("options test connection succeeded", { version: versionStr });
        return { ok:true, version: versionStr, message, userId };
      }catch(error){
        L("options test connection failed", { code: error?.ncCurrentUserIdCode || "identity" });
        return {
          ok: false,
          code: error?.ncCurrentUserIdCode || "identity",
          message: error?.message || bgI18n("options_test_failed"),
          retryAt: error?.retryAt || 0
        };
      }
    }catch(error){
      L("options test connection failed", { code: error?.ncCapabilitiesCode || "network" });
      return {
        ok: false,
        code: error?.ncCapabilitiesCode || "network",
        message: error?.message || String(error),
        retryAt: error?.retryAt || 0
      };
    }
  }

  /**
   * Start Login Flow v2 and return the browser URL and poll endpoint.
   * @param {string} baseUrl - Nextcloud instance (already validated).
   * @returns {Promise<{loginUrl:string,pollEndpoint:string,pollToken:string}>}
   */
  async function startLoginFlow(baseUrl){
    const rawBase = typeof baseUrl === "string" ? baseUrl.trim() : "";
    if (!rawBase){
      throw new Error(bgI18n("error_credentials_missing"));
    }
    const normalized = normalizeBaseUrl(rawBase);
    if (!normalized){
      throw new Error(bgI18n("error_baseurl_https_required"));
    }
    await ensureHostPermission(normalized);
    await assertAuthenticationAllowed(normalized, "", true);
    const url = normalized + "/index.php/login/v2";
    const headers = {
      "OCS-APIRequest": "true",
      "Accept": "application/json",
      "Content-Type": "application/json"
    };
    const body = JSON.stringify({ name: DEVICE_NAME });
    let res;
    let raw = "";
    try{
      const result = await NCOcs.runWithTimeout(async (requestSignal) => {
        const response = await fetch(url, {
          credentials: "omit",
          method: "POST",
          headers,
          body,
          signal: requestSignal
        });
        const responseText = await response.text();
        return { response, raw: responseText };
      });
      res = result.response;
      raw = result.raw;
    }catch(error){
      logNCCoreError("login flow start request failed", error, {
        base: normalized
      });
      throw createLoginFlowError();
    }
    let data = null;
    try{
      data = raw ? JSON.parse(raw) : null;
    }catch(error){
      logNCCoreError("login flow start json parse failed", error, {
        responseLength: String(raw || "").length
      });
    }
    if (!res.ok){
      logNCCoreError("login flow start rejected", new Error("HTTP " + res.status), {
        base: normalized,
        status: res.status,
        statusText: res.statusText
      });
      throw createLoginFlowError();
    }
    const loginUrl = data?.login;
    const poll = data?.poll || {};
    let pollEndpoint = poll.endpoint || "";
    const pollToken = poll.token || "";
    if (!loginUrl || !pollEndpoint || !pollToken){
      throw createLoginFlowError();
    }
    if (!/^https?:/i.test(pollEndpoint)){
      pollEndpoint = normalized + pollEndpoint;
    }
    if (!/^https:/i.test(pollEndpoint)){
      throw createLoginFlowError(bgI18n("error_baseurl_https_required"));
    }
    return {
      loginUrl,
      pollEndpoint,
      pollToken
    };
  }

  /**
   * Poll the login flow endpoint until an app password is returned.
   * @param {{pollEndpoint:string,pollToken:string,timeoutMs?:number,intervalMs?:number}} options
   * @returns {Promise<{loginName:string,appPassword:string}>}
   */
  async function completeLoginFlow({ pollEndpoint, pollToken, timeoutMs = 120000, intervalMs = 2000 } = {}){
    if (!pollEndpoint || !pollToken){
      throw createLoginFlowError();
    }
    await ensureHostPermission(pollEndpoint);
    await assertAuthenticationAllowed(pollEndpoint, "", true);
    const headers = {
      "OCS-APIRequest": "true",
      "Accept": "application/json",
      "Content-Type": "application/json"
    };
    const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : 120000);
    while (Date.now() < deadline){
      try{
        await assertAuthenticationAllowed(pollEndpoint, "", true);
        const payload = JSON.stringify({ token: pollToken, deviceName: DEVICE_NAME });
        const remainingMs = Math.max(1, deadline - Date.now());
        const result = await NCOcs.runWithTimeout(async (requestSignal) => {
          const response = await fetch(pollEndpoint, {
            credentials: "omit",
            method: "POST",
            headers,
            body: payload,
            signal: requestSignal
          });
          const responseText = await response.text();
          return { response, raw: responseText };
        }, {
          timeoutMs: Math.min(LOGIN_FLOW_REQUEST_TIMEOUT_MS, remainingMs)
        });
        const res = result.response;
        const raw = result.raw;
        if (res.status === 404){
          await delayUntilNextPoll(intervalMs, deadline);
          continue;
        }
        let data = null;
        try{
          data = raw ? JSON.parse(raw) : null;
        }catch(error){
          logNCCoreError("login flow poll json parse failed", error, {
            responseLength: String(raw || "").length
          });
        }
        if (!res.ok){
          logNCCoreError("login flow poll rejected", new Error("HTTP " + res.status), {
            status: res.status,
            statusText: res.statusText
          });
          throw createLoginFlowError();
        }
        const appPassword = data?.appPassword || data?.token || data?.ocs?.data?.appPassword || data?.ocs?.data?.token;
        const loginName = data?.loginName || data?.ocs?.data?.loginName;
        if (!appPassword || !loginName){
          throw createLoginFlowError();
        }
        return {
          loginName,
          appPassword
        };
      }catch(error){
        if (error?.ncLoginFlowFatal){
          logNCCoreError("login flow poll fatal error", error);
          throw error;
        }
        logNCCoreError("login flow poll failed", error);
        throw createLoginFlowError();
      }
    }
    throw createLoginFlowError();
  }

  async function delayUntilNextPoll(intervalMs, deadline){
    const remainingMs = Math.max(0, deadline - Date.now());
    if (!remainingMs){
      return;
    }
    const requestedDelay = Math.max(Number(intervalMs) || 0, 50);
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(requestedDelay, remainingMs));
    });
  }

  async function getOpts(){
    if (typeof browser === "undefined" || !browser?.storage?.local){
      return {
        baseUrl: "",
        user: "",
        appPass: "",
        debugEnabled: false,
        authMode: "manual"
      };
    }
    const stored = await browser.storage.local.get([
      "baseUrl",
      "user",
      "appPass",
      "debugEnabled",
      "authMode",
      "defaultsSource"
    ]);
    let managedSetup = typeof NCManagedSetup !== "undefined" && NCManagedSetup?.emptyPolicy
      ? NCManagedSetup.emptyPolicy()
      : null;
    if (typeof NCManagedSetup !== "undefined" && NCManagedSetup?.read){
      managedSetup = await NCManagedSetup.read();
    }
    const baseUrl = typeof NCManagedSetup !== "undefined" && NCManagedSetup?.resolveBaseUrl
      ? NCManagedSetup.resolveBaseUrl(stored.baseUrl || "", managedSetup)
      : (stored.baseUrl || "");
    const authMode = typeof NCManagedSetup !== "undefined" && NCManagedSetup?.resolveAuthMode
      ? NCManagedSetup.resolveAuthMode(stored.authMode, managedSetup)
      : (stored.authMode || "manual");
    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      user: typeof stored.user === "string" ? stored.user.trim() : "",
      appPass: typeof stored.appPass === "string" ? stored.appPass : "",
      debugEnabled: !!stored.debugEnabled,
      authMode,
      defaultsSource: stored.defaultsSource,
      managedSetup
    };
  }

  // Sharing also loads this module for rendering; only background restores work.
  if (!globalThis.NCLogContext.isKnownUiRuntime()){
    getConnectionState().catch((error) => {
      logNCCoreError("connection state restore failed", error);
    });
  }

  return {
    normalizeBaseUrl,
    buildDavAccountContext,
    parseNextcloudVersion,
    getCapabilitiesSnapshot,
    getRequiredCapabilities,
    requireSupportedNextcloud,
    testCredentials,
    startLoginFlow,
    completeLoginFlow,
    getOpts,
    getCurrentUserId,
    assertAuthenticationAllowed,
    runAuthenticatedRequest,
    getConnectionState,
    isConnectionPausedError,
    commitVerifiedConnection,
    getVerifiedConnectionIdentity,
    removeSavedCredentials,
    onConnectionRestored: Object.freeze({
      addListener: addConnectionRestoredListener,
      removeListener: (listener) => restoredListeners.delete(listener)
    })
  };
})();
