/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

const NCVfsPolicyRuntime = (() => {
  const DOMAIN = "share";
  const CACHE_MS = 30 * 1000;
  const ERROR_KEYS = Object.freeze({
    backend_required: "sharing_password_separate_backend_required_tooltip",
    pro_required: "vfs_external_pro_required_tooltip",
    license_invalid: "policy_warning_license_invalid",
    seat_required: "sharing_password_separate_no_seat_tooltip",
    seat_paused: "sharing_password_separate_paused_tooltip",
    admin_controlled: "policy_admin_controlled_tooltip",
    disabled: "sharing_vfs_external_disabled_notice"
  });
  let cachedStatus = null;
  let cachedAt = 0;
  let pendingStatus = null;

  async function getPolicyStatus({ refresh = false } = {}){
    const now = Date.now();
    if (!refresh && cachedStatus && now - cachedAt < CACHE_MS){
      return cachedStatus;
    }
    if (!pendingStatus){
      pendingStatus = NCPolicyRuntime.getPolicyStatus()
        .then((status) => {
          cachedStatus = status;
          cachedAt = Date.now();
          return status;
        })
        .finally(() => {
          pendingStatus = null;
        });
    }
    return pendingStatus;
  }

  function resolveBooleanSetting(policyStatus, key, localEnabled, configured){
    const locked = NCPolicyState.isLocked(policyStatus, DOMAIN, key);
    const enabled = NCPolicyState.resolveDefaultValue(
      policyStatus,
      DOMAIN,
      key,
      localEnabled === true,
      configured === true,
      NCPolicyState.coerceBoolean
    );
    return Object.freeze({
      enabled: enabled === true,
      localEnabled: localEnabled === true,
      configured: configured === true,
      locked
    });
  }

  function resolveProviderSetting(policyStatus, localEnabled, configured){
    return resolveBooleanSetting(
      policyStatus,
      NCSharingStorage.SHARE_POLICY_KEYS.vfsProviderEnabled,
      configured === true ? localEnabled : true,
      configured
    );
  }

  function resolveExternalSetting(policyStatus, localEnabled, configured){
    const setting = resolveBooleanSetting(
      policyStatus,
      NCSharingStorage.SHARE_POLICY_KEYS.vfsExternalProvidersEnabled,
      localEnabled,
      configured
    );
    const unavailableReason = NCPolicyState.getProSeatUnavailableReason(policyStatus);
    const entitled = unavailableReason === "";
    return Object.freeze({
      ...setting,
      enabled: setting.enabled && entitled,
      entitled,
      unavailableReason
    });
  }

  function errorMessage(reason){
    const key = ERROR_KEYS[String(reason || "")] || ERROR_KEYS.disabled;
    return bgI18n(key);
  }

  return Object.freeze({
    getPolicyStatus,
    resolveProviderSetting,
    resolveExternalSetting,
    errorMessage
  });
})();
