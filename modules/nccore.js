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

  function logNCCoreError(scope, error, details = undefined){
    globalThis.NCLogContext.safeConsoleError(resolveLogPrefix(), scope, error, details);
  }

  function createLoginFlowError(){
    const fallback = typeof bgI18n === "function"
      ? bgI18n("options_loginflow_failed")
      : "Login flow failed.";
    const error = new Error(fallback || "Login flow failed.");
    error.ncLoginFlowFatal = true;
    return error;
  }

  function normalizeBaseUrl(input){
    return NCTalkTextUtils.normalizeBaseUrl(input);
  }

  function createCurrentUserIdError(code, message){
    const error = new Error(message || bgI18n("options_test_failed"));
    error.ncCurrentUserIdCode = code || "identity";
    return error;
  }

  function createCapabilitiesError(code, message, status = 0){
    const error = new Error(message || bgI18n("options_test_failed"));
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
    signal
  }){
    throwIfRequestAborted(signal);
    await ensureHostPermission(normalizedBase);
    throwIfRequestAborted(signal);
    const url = normalizedBase + "/ocs/v2.php/cloud/capabilities?format=json";
    let response;
    let raw = "";
    try{
      const requestResult = await NCOcs.runWithTimeout(async (requestSignal) => {
        const fetched = await fetch(url, {
          method: "GET",
          headers: {
            "OCS-APIRequest": "true",
            "Authorization": NCOcs.buildAuthHeader(trimmedUser, password),
            "Accept": "application/json"
          },
          signal: requestSignal
        });
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
        responseSample: String(raw || "").slice(0, 160)
      });
    }
    if (response.status === 401 || response.status === 403){
      const detail = data?.ocs?.meta?.message || "HTTP " + response.status;
      throw createCapabilitiesError("auth", detail, response.status);
    }
    if (!response.ok){
      const detail = data?.ocs?.meta?.message || raw || (response.status + " " + response.statusText);
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
    signal = null
  } = {}){
    const normalizedBase = normalizeBaseUrl(typeof baseUrl === "string" ? baseUrl.trim() : "");
    const trimmedUser = typeof user === "string" ? user.trim() : "";
    const password = typeof appPass === "string" ? appPass : "";
    if (!normalizedBase || !trimmedUser || !password){
      throw createCapabilitiesError("missing", bgI18n("error_credentials_missing"));
    }
    throwIfRequestAborted(signal);

    const cacheKey = `${normalizedBase}\n${trimmedUser}`;
    const cached = capabilitiesCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.loadedAt < CAPABILITIES_CACHE_MS){
      return cached;
    }
    if (signal){
      return fetchCapabilitiesSnapshot({
        normalizedBase,
        trimmedUser,
        password,
        cacheKey,
        signal
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
      signal: null
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
    signal = null
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
        const fetched = await fetch(userUrl, {
          method: "GET",
          headers: {
            "OCS-APIRequest": "true",
            "Authorization": NCOcs.buildAuthHeader(trimmedUser, password),
            "Accept": "application/json"
          },
          signal: requestSignal
        });
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
        responseSample: String(raw || "").slice(0, 160)
      });
    }

    if (response.status === 401 || response.status === 403){
      throw createCurrentUserIdError("auth", bgI18n("options_test_failed_auth"));
    }
    if (!response.ok){
      const detail = data?.ocs?.meta?.message || raw || (response.status + " " + response.statusText);
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
        forceRefresh: true
      }));
      const versionStr = snapshot.versionString;
      const message = versionStr ? "Nextcloud " + versionStr : "";
      try{
        const userId = await resolveCurrentUserId({
          baseUrl: normalizedBase,
          user: trimmedUser,
          appPass: password,
          forceRefresh: true
        });
        return { ok:true, version: versionStr, message, userId };
      }catch(error){
        return {
          ok: false,
          code: error?.ncCurrentUserIdCode || "identity",
          message: error?.message || bgI18n("options_test_failed")
        };
      }
    }catch(error){
      return {
        ok: false,
        code: error?.ncCapabilitiesCode || "network",
        message: error?.message || String(error)
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
    const url = normalized + "/index.php/login/v2";
    const headers = {
      "OCS-APIRequest": "true",
      "Accept": "application/json",
      "Content-Type": "application/json"
    };
    const body = JSON.stringify({ name: DEVICE_NAME });
    const res = await fetch(url, { method:"POST", headers, body });
    const raw = await res.text().catch((error) => {
      logNCCoreError("login flow start response read failed", error);
      return "";
    });
    let data = null;
    try{
      data = raw ? JSON.parse(raw) : null;
    }catch(error){
      logNCCoreError("login flow start json parse failed", error, { responseSample: String(raw || "").slice(0, 160) });
    }
    if (!res.ok){
      const detail = data?.ocs?.meta?.message || raw || (res.status + " " + res.statusText);
      throw new Error(detail || bgI18n("options_loginflow_failed"));
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
    const headers = {
      "OCS-APIRequest": "true",
      "Accept": "application/json",
      "Content-Type": "application/json"
    };
    const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : 120000);
    while (Date.now() < deadline){
      try{
        const payload = JSON.stringify({ token: pollToken, deviceName: DEVICE_NAME });
        const res = await fetch(pollEndpoint, { method:"POST", headers, body: payload });
        if (res.status === 404){
          await delay(intervalMs);
          continue;
        }
        const raw = await res.text().catch((error) => {
          logNCCoreError("login flow poll response read failed", error);
          return "";
        });
        let data = null;
        try{
          data = raw ? JSON.parse(raw) : null;
        }catch(error){
          logNCCoreError("login flow poll json parse failed", error, { responseSample: String(raw || "").slice(0, 160) });
        }
        if (!res.ok){
          const detail = data?.ocs?.meta?.message || raw || (res.status + " " + res.statusText);
          throw new Error(detail || bgI18n("options_loginflow_failed"));
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
          console.error(resolveLogPrefix(), "login flow poll fatal error", error);
          logNCCoreError("login flow poll fatal error", error);
          throw error;
        }
        if (error && error.statusCode === 404){
          await delay(intervalMs);
          continue;
        }
        console.error(resolveLogPrefix(), "login flow poll failed", error);
        logNCCoreError("login flow poll failed", error);
        throw error;
      }
    }
    throw createLoginFlowError();
  }

  function delay(ms){
    return new Promise((resolve) => setTimeout(resolve, Math.max(ms || 0, 50)));
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
      "authMode"
    ]);
    let managedSetup = typeof NCManagedSetup !== "undefined" && NCManagedSetup?.emptyPolicy
      ? NCManagedSetup.emptyPolicy()
      : null;
    if (typeof NCManagedSetup !== "undefined" && NCManagedSetup?.read){
      try{
        managedSetup = await NCManagedSetup.read();
      }catch(error){
        logNCCoreError("managed setup policy read failed", error);
      }
    }
    const baseUrl = typeof NCManagedSetup !== "undefined" && NCManagedSetup?.resolveBaseUrl
      ? NCManagedSetup.resolveBaseUrl(stored.baseUrl || "", managedSetup)
      : (stored.baseUrl || "");
    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      user: typeof stored.user === "string" ? stored.user.trim() : "",
      appPass: typeof stored.appPass === "string" ? stored.appPass : "",
      debugEnabled: !!stored.debugEnabled,
      authMode: stored.authMode || "manual",
      managedSetup
    };
  }

  return {
    normalizeBaseUrl,
    parseNextcloudVersion,
    getCapabilitiesSnapshot,
    getRequiredCapabilities,
    requireSupportedNextcloud,
    testCredentials,
    startLoginFlow,
    completeLoginFlow,
    getOpts,
    getCurrentUserId
  };
})();
