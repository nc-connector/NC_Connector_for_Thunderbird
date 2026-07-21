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

  function resolvePolicyUrl(value, baseUrl){
    const raw = typeof value === "string" ? value.trim() : "";
    const normalizedBaseUrl = NCCore.normalizeBaseUrl(String(baseUrl || "").trim());
    if (!raw || !normalizedBaseUrl){
      return null;
    }
    try{
      const base = new URL(normalizedBaseUrl);
      const resolved = new URL(raw, normalizedBaseUrl);
      if (resolved.origin !== base.origin){
        globalThis.NCLogContext.safeConsoleError("[NCBG]", "password policy URL origin rejected", {
          baseOrigin: base.origin,
          targetOrigin: resolved.origin
        });
        return null;
      }
      return resolved.toString();
    }catch(error){
      globalThis.NCLogContext.safeConsoleError("[NCBG]", "normalize URL failed", {
        raw: String(raw || ""),
        baseUrl: normalizedBaseUrl,
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
        globalThis.NCLogContext.safeConsoleError("[NCBG]", "password policy missing credentials", {
          hasBaseUrl: !!baseUrl,
          hasUser: !!user,
          hasAppPass: !!appPass
        });
        return fallbackPolicy();
      }
      if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
        const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
        if (!ok){
          globalThis.NCLogContext.safeConsoleError("[NCBG]", "password policy host permission missing", { baseUrl });
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
        globalThis.NCLogContext.safeConsoleError("[NCBG]", "password policy fetch failed", {
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
      globalThis.NCLogContext.safeConsoleError("[NCBG]", "password policy fetch error", {
        error: error?.message || String(error)
      });
      return fallbackPolicy();
    }
  }

  async function generatePassword(policy){
    try{
      const { baseUrl, user, appPass } = await NCCore.getOpts();
      if (!baseUrl || !user || !appPass){
        globalThis.NCLogContext.safeConsoleError("[NCBG]", "password generate missing credentials", {
          hasBaseUrl: !!baseUrl,
          hasUser: !!user,
          hasAppPass: !!appPass
        });
        return { ok: false, error: "credentials_missing" };
      }
      if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
        const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
        if (!ok){
          globalThis.NCLogContext.safeConsoleError("[NCBG]", "password generate host permission missing", { baseUrl });
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
        globalThis.NCLogContext.safeConsoleError("[NCBG]", "password generate failed", {
          error: response.errorMessage || "",
          status: response.status || 0
        });
        return { ok: false, error: response.errorMessage || "http_error" };
      }
      const password = response.data?.ocs?.data?.password;
      if (!password){
        globalThis.NCLogContext.safeConsoleError("[NCBG]", "password generate missing password field");
        return { ok: false, error: "password_missing" };
      }
      const generated = String(password);
      L("password generate success", { length: generated.length });
      return { ok: true, password: generated };
    }catch(error){
      globalThis.NCLogContext.safeConsoleError("[NCBG]", "password generate error", {
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
