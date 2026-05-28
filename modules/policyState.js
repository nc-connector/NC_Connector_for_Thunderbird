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
    return !!(
      seatStatus?.seatAssigned
      && seatStatus?.isValid
      && seatStatus?.seatState === ACTIVE_SEAT_STATE
      && !seatStatus?.overlicensed
    );
  }

  function isEndpointAvailable(status){
    return !!status?.endpointAvailable;
  }

  function hasSeatEntitlement(status){
    const seatStatus = status?.status;
    const seatState = String(seatStatus?.seatState || "").trim().toLowerCase();
    return !!(
      isEndpointAvailable(status)
      && seatStatus?.seatAssigned
      && seatStatus?.isValid
      && seatState === ACTIVE_SEAT_STATE
    );
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
    buildDomainState,
    isDomainAvailable,
    isDomainActive,
    isLocked,
    isEditableLocked,
    coerceBoolean,
    coerceInt,
    coerceString,
    resolveValue
  };
})();
