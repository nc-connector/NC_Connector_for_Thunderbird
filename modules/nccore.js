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

  /**
   * Log NCCore internal errors (with L(...) when available).
   * @param {string} scope
   * @param {any} error
   * @param {object} details
   */
  function logNCCoreError(scope, error, details = undefined){
    if (typeof L === "function"){
      try{
        L(scope, {
          error: error?.message || String(error),
          details: details || null
        });
        return;
      }catch(logError){
        console.error("[NCCore]", scope, error, details || "", logError);
        return;
      }
    }
    console.error("[NCCore]", scope, error, details || "");
  }

  /**
   * Build a localized login-flow error and mark it as fatal.
   * @returns {Error}
   */
  function createLoginFlowError(){
    const fallback = typeof bgI18n === "function"
      ? bgI18n("options_loginflow_failed")
      : "Login flow failed.";
    const error = new Error(fallback || "Login flow failed.");
    error.ncLoginFlowFatal = true;
    return error;
  }

  /**
   * Normalize a base URL and enforce HTTPS.
   * @param {string} input - User input from settings.
   * @returns {string} - Normalized base URL or empty string.
   */
  function normalizeBaseUrl(input){
    if (!input) return "";
    const raw = String(input).trim();
    if (!raw){
      return "";
    }
    try{
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:"){
        return "";
      }
      const normalizedPath = String(parsed.pathname || "").replace(/\/+$/, "");
      return parsed.origin + normalizedPath;
    }catch(error){
      logNCCoreError("normalize base URL failed", error, {
        inputSample: raw.slice(0, 160)
      });
      return "";
    }
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
      scope: "[NCCore] host permission missing"
    });
  }

  /**
   * Validate base URL, username, and app password via OCS.
   * Calls /cloud/capabilities first and then /cloud/user.
   * @param {{baseUrl:string,user:string,appPass:string}} params
   * @returns {Promise<{ok:boolean, code:string, message?:string, version?:string}>}
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
    await ensureHostPermission(normalizedBase);
    const basicHeader = NCOcs.buildAuthHeader(trimmedUser, password);
    try{
      L("options test connection", { base: normalizedBase, user: coreShortId(trimmedUser) });
      const headers = {
        "OCS-APIRequest": "true",
        "Authorization": basicHeader,
        "Accept": "application/json"
      };
      const url = normalizedBase + "/ocs/v2.php/cloud/capabilities";
      const res = await fetch(url, { method:"GET", headers });
      const raw = await res.text().catch((error) => {
        logNCCoreError("capabilities response read failed", error);
        return "";
      });
      let data = null;
      try{
        data = raw ? JSON.parse(raw) : null;
      }catch(error){
        logNCCoreError("capabilities json parse failed", error, { responseSample: String(raw || "").slice(0, 160) });
      }
      if (res.status === 401 || res.status === 403){
        const detail = data?.ocs?.meta?.message || "HTTP " + res.status;
        return { ok:false, code:"auth", message: detail };
      }
      if (!res.ok){
        const detail = data?.ocs?.meta?.message || raw || (res.status + " " + res.statusText);
        return { ok:false, code:"http", message: detail };
      }
      const versionRaw = data?.ocs?.meta?.version || data?.ocs?.data?.version || "";
      let versionStr = "";
      if (typeof versionRaw === "string"){
        versionStr = versionRaw;
      } else if (versionRaw && typeof versionRaw === "object"){
        if (typeof versionRaw.string === "string" && versionRaw.string.trim()){
          versionStr = versionRaw.string.trim();
        } else {
          const parts = [];
          if (versionRaw.major != null) parts.push(String(versionRaw.major));
          if (versionRaw.minor != null) parts.push(String(versionRaw.minor));
          if (versionRaw.micro != null) parts.push(String(versionRaw.micro));
          if (parts.length){
            versionStr = parts.join(".");
          }
        }
      }
      const message = versionStr ? "Nextcloud " + versionStr : "";
      try{
        const userUrl = normalizedBase + "/ocs/v2.php/cloud/user";
        const userRes = await fetch(userUrl, {
          method: "GET",
          headers: {
            "OCS-APIRequest": "true",
            "Authorization": basicHeader,
            "Accept": "application/json"
          }
        });
        if (userRes.status === 401 || userRes.status === 403){
          return { ok:false, code:"auth", message: bgI18n("options_test_failed_auth") };
        }
        if (!userRes.ok){
          const userRaw = await userRes.text().catch((error) => {
            logNCCoreError("user endpoint response read failed", error);
            return "";
          });
          let userData = null;
          try{
            userData = userRaw ? JSON.parse(userRaw) : null;
          }catch(error){
            logNCCoreError("user endpoint json parse failed", error, { responseSample: String(userRaw || "").slice(0, 160) });
            userData = null;
          }
          const detail = userData?.ocs?.meta?.message || userRaw || (userRes.status + " " + userRes.statusText);
          return { ok:false, code:"http", message: detail };
        }
      }catch(userErr){
        console.error("[NCCore] user endpoint request failed", userErr);
        logNCCoreError("user endpoint request failed", userErr, { base: normalizedBase });
        return { ok:false, code:"network", message: userErr?.message || String(userErr) };
      }
      return { ok:true, version: versionStr, message };
    }catch(e){
      console.error("[NCCore] capabilities request failed", e);
      logNCCoreError("capabilities request failed", e, { base: normalizedBase });
      return { ok:false, code:"network", message: e?.message || String(e) };
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
      }catch(err){
        if (err?.ncLoginFlowFatal){
          console.error("[NCCore] login flow poll fatal error", err);
          logNCCoreError("login flow poll fatal error", err);
          throw err;
        }
        if (err && err.statusCode === 404){
          await delay(intervalMs);
          continue;
        }
        console.error("[NCCore] login flow poll failed", err);
        logNCCoreError("login flow poll failed", err);
        throw err;
      }
    }
    throw createLoginFlowError();
  }

  /**
   * Return a promise that resolves after the given milliseconds.
   * @param {number} ms - Delay in milliseconds.
   * @returns {Promise<void>}
   */
  function delay(ms){
    return new Promise((resolve) => setTimeout(resolve, Math.max(ms || 0, 50)));
  }

  /**
   * Return stored credentials with a normalized base URL.
   * @returns {Promise<{baseUrl:string,user:string,appPass:string,debugEnabled:boolean,authMode:string}>}
   */
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
    return {
      baseUrl: normalizeBaseUrl(stored.baseUrl || ""),
      user: typeof stored.user === "string" ? stored.user.trim() : "",
      appPass: typeof stored.appPass === "string" ? stored.appPass : "",
      debugEnabled: !!stored.debugEnabled,
      authMode: stored.authMode || "manual"
    };
  }

  return {
    normalizeBaseUrl,
    testCredentials,
    startLoginFlow,
    completeLoginFlow,
    getOpts
  };
})();

