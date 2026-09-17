/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

const NCPolicyState = (() => {
  const POLICY_DOMAINS = Object.freeze(["share", "talk", "email_signature"]);
  const ACTIVE_SEAT_STATE = "active";

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
      && !seatStatus?.overlicensed
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

  function getStatusNoticeCode(policyStatus){
    if (policyStatus?.fetchSucceeded === false){
      return ["credentials_missing", "endpoint_missing", "permission_missing", "local_defaults"].includes(policyStatus.reason)
        ? ""
        : "backend_unavailable";
    }
    const status = policyStatus?.status;
    if (!isEndpointAvailable(policyStatus) || !isObject(status)){
      return "";
    }
    if (!status.seatAssigned && status.canManageLicense !== true){
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
    if (status.overlicensed){
      return "overlicensed";
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

  function getStatusNotice(policyStatus){
    const status = policyStatus?.status;
    const code = getStatusNoticeCode(policyStatus);
    return Object.freeze({
      code,
      license: code.startsWith("license_") || code === "overlicensed",
      canManageLicense: status?.canManageLicense === true,
      seatAssigned: status?.seatAssigned === true,
      graceUntilIso: typeof status?.graceUntilIso === "string" ? status.graceUntilIso : null,
      connectionError: status?.licenseConnectionError === true,
      lastSyncAtIso: typeof status?.licenseLastSyncAtIso === "string" ? status.licenseLastSyncAtIso : null,
      offlineUntilIso: typeof status?.licenseOfflineUntilIso === "string" ? status.licenseOfflineUntilIso : null
    });
  }

  function getProSeatUnavailableReason(status){
    if (!isEndpointAvailable(status)){
      return "backend_required";
    }
    if (String(status?.status?.mode || "").trim().toLowerCase() !== "pro"){
      return "pro_required";
    }
    if (status?.status?.overlicensed){
      return "license_invalid";
    }
    if (!status?.status?.seatAssigned){
      return "seat_required";
    }
    if (!isSeatUsable(status?.status)){
      return "seat_paused";
    }
    return "";
  }

  function hasProSeatEntitlement(status){
    return getProSeatUnavailableReason(status) === "";
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
    getProSeatUnavailableReason,
    hasProSeatEntitlement,
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
