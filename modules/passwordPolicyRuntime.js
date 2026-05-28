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
    if (!raw){
      return null;
    }
    try{
      if (baseUrl){
        return new URL(raw, baseUrl).toString();
      }
      return new URL(raw).toString();
    }catch(error){
      console.error("[NCBG] normalize URL failed", {
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
        console.error("[NCBG] password policy missing credentials");
        return fallbackPolicy();
      }
      if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
        const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
        if (!ok){
          console.error("[NCBG] password policy host permission missing", baseUrl);
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
        console.error("[NCBG] password policy fetch failed", response.errorMessage || response.status);
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
      console.error("[NCBG] password policy fetch error", error);
      return fallbackPolicy();
    }
  }

  async function generatePassword(policy){
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
    }catch(error){
      console.error("[NCBG] password generate error", error);
      return { ok: false, error: error?.message || String(error) };
    }
  }

  return {
    fetchPolicy,
    generatePassword
  };
})();
