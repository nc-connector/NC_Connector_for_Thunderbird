/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const MODE_PLAIN = "plain";
  const MODE_SECRETS = "secrets";
  const DEFAULT_SECRETS_EXPIRE_DAYS = 7;
  const MIN_SECRETS_EXPIRE_DAYS = 1;
  const MAX_SECRETS_EXPIRE_DAYS = 365;
  const MODE_POLICY_KEY = "share_send_password_mode";
  const EXPIRE_DAYS_POLICY_KEY = "share_secrets_expire_days";

  function normalizeMode(value){
    return String(value || "").trim().toLowerCase() === MODE_SECRETS
      ? MODE_SECRETS
      : MODE_PLAIN;
  }

  function clampSecretsExpireDays(value){
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)){
      return DEFAULT_SECRETS_EXPIRE_DAYS;
    }
    if (parsed < MIN_SECRETS_EXPIRE_DAYS){
      return MIN_SECRETS_EXPIRE_DAYS;
    }
    if (parsed > MAX_SECRETS_EXPIRE_DAYS){
      return MAX_SECRETS_EXPIRE_DAYS;
    }
    return parsed;
  }

  function coerceMode(value, fallback = MODE_PLAIN){
    const fallbackMode = normalizeMode(fallback);
    if (value === null || value === undefined || value === ""){
      return fallbackMode;
    }
    return normalizeMode(value);
  }

  function coerceSecretsExpireDays(value, fallback = DEFAULT_SECRETS_EXPIRE_DAYS){
    if (value === null || value === undefined || value === ""){
      return clampSecretsExpireDays(fallback);
    }
    return clampSecretsExpireDays(value);
  }

  function isSecretsUnavailable(status){
    if (typeof NCPolicyState === "undefined" || !NCPolicyState?.hasPolicyKey){
      return false;
    }
    return NCPolicyState.isDomainActive(status, "share")
      && NCPolicyState.hasPolicyKey(status, "share", MODE_POLICY_KEY)
      && NCPolicyState.readPolicyValue(status, "share", MODE_POLICY_KEY) == null;
  }

  function resolveSecretsExpireDays(status){
    if (typeof NCPolicyState === "undefined" || !NCPolicyState?.hasPolicyKey){
      return DEFAULT_SECRETS_EXPIRE_DAYS;
    }
    if (!NCPolicyState.hasPolicyKey(status, "share", EXPIRE_DAYS_POLICY_KEY)){
      return DEFAULT_SECRETS_EXPIRE_DAYS;
    }
    return coerceSecretsExpireDays(
      NCPolicyState.readPolicyValue(status, "share", EXPIRE_DAYS_POLICY_KEY),
      DEFAULT_SECRETS_EXPIRE_DAYS
    );
  }

  const api = {
    MODE_PLAIN,
    MODE_SECRETS,
    DEFAULT_SECRETS_EXPIRE_DAYS,
    MIN_SECRETS_EXPIRE_DAYS,
    MAX_SECRETS_EXPIRE_DAYS,
    MODE_POLICY_KEY,
    EXPIRE_DAYS_POLICY_KEY,
    normalizeMode,
    clampSecretsExpireDays,
    coerceMode,
    coerceSecretsExpireDays,
    isSecretsUnavailable,
    resolveSecretsExpireDays
  };

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCSharePasswordDelivery = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
