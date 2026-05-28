/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

const NCPasswordPolicyRuntime = (() => {
  const FALLBACK_POLICY = Object.freeze({
    hasPolicy: false,
    minLength: null,
    apiGenerateUrl: null
  });

  function fallbackPolicy(){
    return { ...FALLBACK_POLICY };
  }

  function logPasswordPolicyRuntimeError(scope, details = {}){
    globalThis.NCLogContext.safeConsoleError("[NCBG]", scope, details);
  }

  function resolvePolicyUrl(value, baseUrl){
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw){
      return null;
    }
    try{
      if (baseUrl){
        return new URL(raw, baseUrl).toString();
      }
      return new URL(raw).toString();
    }catch(error){
      logPasswordPolicyRuntimeError("normalize URL failed", {
        raw: String(raw || ""),
        baseUrl: String(baseUrl || ""),
        error: error?.message || String(error)
      });
      return null;
    }
  }

  function normalizePasswordPolicy(policy, baseUrl){
    if (!policy || typeof policy !== "object"){
      return fallbackPolicy();
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

  async function fetchPolicy(){
    try{
      const { baseUrl, user, appPass } = await NCCore.getOpts();
      if (!baseUrl || !user || !appPass){
        logPasswordPolicyRuntimeError("password policy missing credentials", {
          hasBaseUrl: !!baseUrl,
          hasUser: !!user,
          hasAppPass: !!appPass
        });
        return fallbackPolicy();
      }
      if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
        const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
        if (!ok){
          logPasswordPolicyRuntimeError("password policy host permission missing", { baseUrl });
          return fallbackPolicy();
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
        logPasswordPolicyRuntimeError("password policy fetch failed", {
          error: response.errorMessage || "",
          status: response.status || 0
        });
        return fallbackPolicy();
      }
      const capabilities = response.data?.ocs?.data?.capabilities || {};
      const policyRaw = capabilities.password_policy || capabilities.passwordPolicy || null;
      if (!policyRaw || typeof policyRaw !== "object"){
        L("password policy fallback", { reason: "policy_missing" });
        return fallbackPolicy();
      }
      const normalized = normalizePasswordPolicy(policyRaw, baseUrl);
      L("password policy fetched", {
        hasPolicy: normalized.hasPolicy,
        minLength: normalized.minLength,
        apiGenerateUrl: normalized.apiGenerateUrl || ""
      });
      return normalized;
    }catch(error){
      logPasswordPolicyRuntimeError("password policy fetch error", {
        error: error?.message || String(error)
      });
      return fallbackPolicy();
    }
  }

  async function generatePassword(policy){
    try{
      const { baseUrl, user, appPass } = await NCCore.getOpts();
      if (!baseUrl || !user || !appPass){
        logPasswordPolicyRuntimeError("password generate missing credentials", {
          hasBaseUrl: !!baseUrl,
          hasUser: !!user,
          hasAppPass: !!appPass
        });
        return { ok: false, error: "credentials_missing" };
      }
      if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
        const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
        if (!ok){
          logPasswordPolicyRuntimeError("password generate host permission missing", { baseUrl });
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
        logPasswordPolicyRuntimeError("password generate failed", {
          error: response.errorMessage || "",
          status: response.status || 0
        });
        return { ok: false, error: response.errorMessage || "http_error" };
      }
      const password = response.data?.ocs?.data?.password;
      if (!password){
        logPasswordPolicyRuntimeError("password generate missing password field");
        return { ok: false, error: "password_missing" };
      }
      const generated = String(password);
      L("password generate success", { length: generated.length });
      return { ok: true, password: generated };
    }catch(error){
      logPasswordPolicyRuntimeError("password generate error", {
        error: error?.message || String(error)
      });
      return { ok: false, error: error?.message || String(error) };
    }
  }

  return {
    fetchPolicy,
    generatePassword
  };
})();
