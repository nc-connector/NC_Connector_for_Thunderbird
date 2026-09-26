/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

const NCPolicyState = (() => {
  const POLICY_DOMAINS = Object.freeze(["share", "talk", "email_signature"]);
  const ACTIVE_SEAT_STATE = "active";
  const NOTICE_KEYS = Object.freeze({
    backend_required: "sharing_password_separate_backend_required_tooltip",
    backend_unavailable: "policy_warning_backend_unavailable",
    no_seat: "policy_warning_no_seat",
    license_expired: "policy_license_expired",
    license_inactive: "policy_license_inactive",
    license_invalid_explicit: "policy_license_invalid",
    license_activation_conflict: "policy_license_activation_conflict",
    license_activation_required: "policy_license_activation_required",
    license_offline_expired: "policy_license_offline_expired",
    license_invalid: "policy_warning_license_invalid",
    seat_paused: "policy_warning_seat_suspended",
    seat_unavailable: "policy_warning_seat_unavailable",
    license_grace: "policy_license_grace",
    license_connection_error: "policy_license_connection_error"
  });

  function isObject(value){
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function readDomainValue(domainPolicy, key){
    if (!isObject(domainPolicy)){
      return null;
    }
    return Object.prototype.hasOwnProperty.call(domainPolicy, key)
      ? domainPolicy[key]
      : null;
  }

  function readEditableFlag(status, domain, key){
    const editableDomain = status?.policyEditable?.[domain];
    if (!isObject(editableDomain)){
      return null;
    }
    if (editableDomain[key] === true){
      return true;
    }
    if (editableDomain[key] === false){
      return false;
    }
    return null;
  }

  function readPolicyValue(status, domain, key){
    return readDomainValue(status?.policy?.[domain], key);
  }

  function hasPolicyKey(status, domain, key){
    return isObject(status?.policy?.[domain])
      && Object.prototype.hasOwnProperty.call(status.policy[domain], key);
  }

  function isExplicitNull(status, domain, key){
    return hasPolicyKey(status, domain, key) && readPolicyValue(status, domain, key) == null;
  }

  function isSeatUsable(seatStatus){
    const seatState = String(seatStatus?.seatState || "").trim().toLowerCase();
    return !!(
      seatStatus?.seatAssigned
      && seatStatus?.isValid
      && seatState === ACTIVE_SEAT_STATE
    );
  }

  function isEndpointAvailable(status){
    return !!status?.endpointAvailable;
  }

  function hasSeatEntitlement(status){
    return !!(
      isEndpointAvailable(status)
      && isSeatUsable(status?.status)
    );
  }

  function getStatusNoticeCode(policyStatus, forFeature = false){
    if (policyStatus?.fetchSucceeded === false){
      return ["credentials_missing", "endpoint_missing", "permission_missing", "local_defaults"].includes(policyStatus.reason)
        ? ""
        : "backend_unavailable";
    }
    const status = policyStatus?.status;
    if (!isEndpointAvailable(policyStatus) || !isObject(status)){
      return "";
    }
    if (!status.seatAssigned && (forFeature || status.canManageLicense !== true)){
      return "no_seat";
    }
    const licenseStatus = String(status.licenseStatus || "").trim().toUpperCase();
    const accessStatus = String(status.accessStatus || "").trim().toUpperCase();
    if (status.isValid !== true){
      // Access refusals can differ from the purchased license's commercial status.
      switch (accessStatus || licenseStatus){
        case "EXPIRED":
          return "license_expired";
        case "INACTIVE":
          return "license_inactive";
        case "INVALID":
          return "license_invalid_explicit";
        case "ACTIVATION_REQUIRED":
          return String(status.licenseActivationState || "").trim().toLowerCase() === "conflict"
            ? "license_activation_conflict"
            : "license_activation_required";
        case "OFFLINE_EXPIRED":
          return "license_offline_expired";
        default:
          return "license_invalid";
      }
    }
    const seatState = String(status.seatState || "").trim().toLowerCase();
    if (status.seatAssigned && seatState !== ACTIVE_SEAT_STATE){
      return seatState === "suspended_overlimit" ? "seat_paused" : "seat_unavailable";
    }
    if ((accessStatus || licenseStatus) === "GRACE"){
      return "license_grace";
    }
    if (status.licenseConnectionError === true){
      return "license_connection_error";
    }
    return status.seatAssigned ? "" : "no_seat";
  }

  function getStatusNotice(policyStatus, forFeature = false){
    const status = policyStatus?.status;
    const code = getStatusNoticeCode(policyStatus, forFeature);
    return Object.freeze({
      code,
      license: code.startsWith("license_"),
      canManageLicense: status?.canManageLicense === true,
      seatAssigned: status?.seatAssigned === true,
      graceUntilIso: typeof status?.graceUntilIso === "string" ? status.graceUntilIso : null,
      connectionError: status?.licenseConnectionError === true,
      lastSyncAtIso: typeof status?.licenseLastSyncAtIso === "string" ? status.licenseLastSyncAtIso : null,
      offlineUntilIso: typeof status?.licenseOfflineUntilIso === "string" ? status.licenseOfflineUntilIso : null
    });
  }

  function getSeatUnavailableReason(status){
    if (hasSeatEntitlement(status)){
      return "";
    }
    return getStatusNoticeCode(status, true)
      || (isEndpointAvailable(status) ? "license_invalid" : "backend_required");
  }

  function formatNoticeDate(value){
    if (typeof value !== "string" || !value.trim()){
      return "";
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
  }

  function getStatusNoticeMessage(notice, translate, forFeature = false){
    const noSeatKey = forFeature ? "sharing_password_separate_no_seat_tooltip" : NOTICE_KEYS.no_seat;
    const code = forFeature && notice?.license && !notice.seatAssigned ? "no_seat" : notice?.code;
    const key = code === "no_seat" ? noSeatKey : NOTICE_KEYS[code];
    if (!key){
      return "";
    }
    const graceUntil = formatNoticeDate(notice.graceUntilIso);
    const lines = [code === "license_grace" && graceUntil
      ? translate("policy_license_grace_format", [graceUntil])
      : translate(key)];
    if (notice.license && code !== "no_seat"){
      if (notice.connectionError && code !== "license_connection_error"){
        lines.push(translate("policy_license_connection_error"));
      }
      if (notice.connectionError || code === "license_offline_expired"){
        const lastSync = formatNoticeDate(notice.lastSyncAtIso);
        const offlineUntil = formatNoticeDate(notice.offlineUntilIso);
        if (lastSync){
          lines.push(translate("policy_license_last_sync_format", [lastSync]));
        }
        if (offlineUntil){
          lines.push(translate("policy_license_offline_until_format", [offlineUntil]));
        }
      }
      lines.push(translate(notice.canManageLicense ? "policy_license_admin_hint" : "policy_license_user_hint"));
      if (!notice.seatAssigned){
        lines.push(translate(noSeatKey));
      }
    }else if (code === "seat_paused" || code === "seat_unavailable"){
      lines.push(translate(notice.canManageLicense ? "policy_license_admin_hint" : "policy_license_user_hint"));
    }
    return lines.filter(Boolean).join("\n");
  }

  function getSeatUnavailableMessage(status, translate){
    const code = getSeatUnavailableReason(status);
    if (!code){
      return "";
    }
    return getStatusNoticeMessage({ ...getStatusNotice(status, true), code }, translate, true);
  }

  function buildDomainState(policyDomain, editableDomain, seatUsable){
    const available = isObject(policyDomain) && isObject(editableDomain);
    return {
      available,
      active: !!seatUsable && available
    };
  }

  function isDomainAvailable(status, domain){
    const domainState = status?.policyDomains?.[domain];
    if (isObject(domainState) && Object.prototype.hasOwnProperty.call(domainState, "available")){
      return domainState.available === true;
    }
    return isObject(status?.policy?.[domain]) && isObject(status?.policyEditable?.[domain]);
  }

  function isDomainActive(status, domain){
    const domainState = status?.policyDomains?.[domain];
    if (isObject(domainState) && Object.prototype.hasOwnProperty.call(domainState, "active")){
      return domainState.active === true;
    }
    return !!status?.policyActive && isDomainAvailable(status, domain);
  }

  function isLocked(status, domain, key){
    if (!isDomainActive(status, domain)){
      return false;
    }
    return readEditableFlag(status, domain, key) === false;
  }

  function isEditableLocked(active, editableDomain, key){
    return !!active && isObject(editableDomain) && editableDomain[key] === false;
  }

  function coerceBoolean(value, fallback){
    if (value === true){
      return true;
    }
    if (value === false){
      return false;
    }
    return fallback;
  }

  function coerceInt(value, fallback){
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)){
      return fallback;
    }
    return parsed;
  }

  function coerceString(value, fallback){
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function resolveValue(status, domain, key, localValue, coerce){
    if (!isLocked(status, domain, key)){
      return localValue;
    }
    const policyValue = readPolicyValue(status, domain, key);
    return typeof coerce === "function" ? coerce(policyValue, localValue) : localValue;
  }

  /**
   * Resolve a persisted default against the active backend policy.
   * An editable policy value seeds the add-on until a valid local value exists;
   * a locked policy value always wins.
   * @param {object|null} status
   * @param {string} domain
   * @param {string} key
   * @param {*} localValue
   * @param {boolean} hasLocalValue
   * @param {Function} coerce
   * @returns {*}
   */
  function resolveDefaultValue(status, domain, key, localValue, hasLocalValue, coerce){
    if (!isDomainActive(status, domain) || (hasLocalValue && !isLocked(status, domain, key))){
      return localValue;
    }
    const policyValue = readPolicyValue(status, domain, key);
    return typeof coerce === "function" ? coerce(policyValue, localValue) : localValue;
  }

  return {
    POLICY_DOMAINS,
    isObject,
    readDomainValue,
    readEditableFlag,
    readPolicyValue,
    hasPolicyKey,
    isExplicitNull,
    isSeatUsable,
    isEndpointAvailable,
    hasSeatEntitlement,
    getStatusNotice,
    getSeatUnavailableReason,
    getStatusNoticeMessage,
    getSeatUnavailableMessage,
    buildDomainState,
    isDomainAvailable,
    isDomainActive,
    isLocked,
    isEditableLocked,
    coerceBoolean,
    coerceInt,
    coerceString,
    resolveValue,
    resolveDefaultValue
  };
})();
