/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

/**
 * Backend policy runtime.
 * Resolves `/apps/ncc_backend_4mc/api/v1/status` and normalizes the payload for
 * options/talk/sharing UI consumers.
 */
const NCPolicyRuntime = (() => {
  const STATUS_ENDPOINT_PATH = "/apps/ncc_backend_4mc/api/v1/status";
  const POLICY_DOMAINS = ["share", "talk", "email_signature"];

  /**
   * Build the status endpoint URL from a normalized base URL.
   * @param {string} baseUrl
   * @returns {string}
   */
  function buildStatusEndpointUrl(baseUrl){
    return String(baseUrl || "").replace(/\/+$/, "") + STATUS_ENDPOINT_PATH;
  }

  /**
   * Return true when the value is a plain object.
   * @param {any} value
   * @returns {boolean}
   */
  function isObject(value){
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * Write policy-runtime errors to the console regardless of debug mode.
   * @param {string} scope
   * @param {object} details
   */
  function logPolicyRuntimeError(scope, details = {}){
    try{
      console.error("[NCBG]", scope, details);
    }catch(error){
      console.error("[NCBG]", scope, String(error));
    }
  }

  /**
   * Read one boolean policy-editable flag.
   * @param {any} payload
   * @param {"share"|"talk"|"email_signature"} domain
   * @param {string} key
   * @returns {boolean|null}
   */
  function readEditableFlag(payload, domain, key){
    const editableDomain = payload?.policyEditable?.[domain];
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

  /**
   * Read one policy value.
   * @param {any} payload
   * @param {"share"|"talk"|"email_signature"} domain
   * @param {string} key
   * @returns {any}
   */
  function readPolicyValue(payload, domain, key){
    const policyDomain = payload?.policy?.[domain];
    if (!isObject(policyDomain)){
      return null;
    }
    return Object.prototype.hasOwnProperty.call(policyDomain, key)
      ? policyDomain[key]
      : null;
  }

  /**
   * Build the default local-mode status payload.
   * @param {string} reason
   * @param {object} details
   * @returns {object}
   */
  function buildLocalModeResult(reason, details = {}){
    const seatState = String(details?.seatState || "none");
    const seatAssigned = !!details?.seatAssigned;
    const isValid = details?.isValid !== false;
    const warningCode = seatAssigned && (!isValid || seatState !== "active")
      ? "license_invalid"
      : "";
    return {
      ok: true,
      fetchSucceeded: false,
      cached: false,
      mode: "local",
      reason: reason || "local_defaults",
      endpointAvailable: !!details?.endpointAvailable,
      endpointChecked: !!details?.endpointChecked,
      endpointUrl: String(details?.endpointUrl || ""),
      status: {
        userId: String(details?.userId || ""),
        seatAssigned,
        seatState,
        overlicensed: !!details?.overlicensed,
        mode: String(details?.licenseMode || ""),
        isValid,
        expiresAtIso: details?.expiresAtIso || null,
        graceUntilIso: details?.graceUntilIso || null
      },
      policyActive: false,
      policyDomains: {
        share: { available: false, active: false },
        talk: { available: false, active: false },
        email_signature: { available: false, active: false }
      },
      policy: { share: null, talk: null, email_signature: null },
      policyEditable: { share: null, talk: null, email_signature: null },
      warning: {
        visible: !!warningCode,
        code: warningCode
      }
    };
  }

  /**
   * Return true when the backend status allows policy use for assigned seats.
   * @param {object} status
   * @returns {boolean}
   */
  function isSeatUsable(status){
    return !!(
      status?.seatAssigned
      && status?.isValid
      && status?.seatState === "active"
      && !status?.overlicensed
    );
  }

  /**
   * Build availability/activation state for one policy domain.
   * @param {any} policyDomain
   * @param {any} editableDomain
   * @param {boolean} seatUsable
   * @returns {{available:boolean, active:boolean}}
   */
  function buildDomainState(policyDomain, editableDomain, seatUsable){
    const available = isObject(policyDomain) && isObject(editableDomain);
    return {
      available,
      active: !!seatUsable && available
    };
  }

  /**
   * Normalize the server payload to the internal runtime status contract.
   * @param {any} payload
   * @returns {object}
   */
  function normalizeStatusPayload(payload){
    const rawStatus = isObject(payload?.status) ? payload.status : {};
    const status = {
      userId: String(rawStatus.user_id || ""),
      seatAssigned: !!rawStatus.seat_assigned,
      seatState: String(rawStatus.seat_state || "none"),
      overlicensed: !!rawStatus.overlicensed,
      mode: String(rawStatus.mode || ""),
      isValid: rawStatus.is_valid === true,
      expiresAtIso: rawStatus.expires_at_iso || null,
      graceUntilIso: rawStatus.grace_until_iso || null
    };
    const policyShare = isObject(payload?.policy?.share) ? payload.policy.share : null;
    const policyTalk = isObject(payload?.policy?.talk) ? payload.policy.talk : null;
    const policyEmailSignature = isObject(payload?.policy?.email_signature) ? payload.policy.email_signature : null;
    const editableShare = isObject(payload?.policy_editable?.share) ? payload.policy_editable.share : null;
    const editableTalk = isObject(payload?.policy_editable?.talk) ? payload.policy_editable.talk : null;
    const editableEmailSignature = isObject(payload?.policy_editable?.email_signature) ? payload.policy_editable.email_signature : null;
    const seatUsable = isSeatUsable(status);
    const policyDomains = {
      share: buildDomainState(policyShare, editableShare, seatUsable),
      talk: buildDomainState(policyTalk, editableTalk, seatUsable),
      email_signature: buildDomainState(policyEmailSignature, editableEmailSignature, seatUsable)
    };
    const policyActive = POLICY_DOMAINS.some((domain) => policyDomains[domain]?.active === true);
    const reason = policyActive
      ? "policy_active"
      : (seatUsable ? "policy_domains_unavailable" : "seat_not_usable");
    const warningCode = status.seatAssigned && (!status.isValid || status.seatState !== "active")
      ? "license_invalid"
      : "";
    return {
      ok: true,
      fetchSucceeded: true,
      cached: false,
      mode: policyActive ? "policy" : "local",
      reason,
      endpointAvailable: true,
      endpointChecked: true,
      endpointUrl: "",
      status,
      policyActive,
      policyDomains,
      policy: {
        share: policyShare,
        talk: policyTalk,
        email_signature: policyEmailSignature
      },
      policyEditable: {
        share: editableShare,
        talk: editableTalk,
        email_signature: editableEmailSignature
      },
      warning: {
        visible: !!warningCode,
        code: warningCode
      }
    };
  }

  /**
   * Read backend status live from the backend endpoint.
   * @returns {Promise<object>}
   */
  async function getPolicyStatus(){
    const opts = await NCCore.getOpts();
    const baseUrl = String(opts?.baseUrl || "").trim();
    const user = String(opts?.user || "").trim();
    const appPass = String(opts?.appPass || "");
    if (!baseUrl || !user || !appPass){
      return buildLocalModeResult("credentials_missing", {
        endpointChecked: false
      });
    }

    const endpointUrl = buildStatusEndpointUrl(baseUrl);
    try{
      if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.requireOriginPermission){
        await NCHostPermissions.requireOriginPermission(baseUrl, {
          message: bgI18n("error_host_permission_missing"),
          scope: "policy status host permission missing",
          logMissing: true
        });
      }
    }catch(error){
      const localResult = buildLocalModeResult("permission_missing", {
        endpointChecked: false
      });
      logPolicyRuntimeError("policy status fallback", {
        reason: localResult.reason,
        error: error?.message || String(error)
      });
      return localResult;
    }

    let response;
    try{
      response = await fetch(endpointUrl, {
        method: "GET",
        headers: {
          "Authorization": NCOcs.buildAuthHeader(user, appPass),
          "Accept": "application/json"
        }
      });
    }catch(error){
      const localResult = buildLocalModeResult("network_error", {
        endpointChecked: true,
        endpointUrl
      });
      logPolicyRuntimeError("policy status fallback", {
        reason: localResult.reason,
        endpointUrl,
        error: error?.message || String(error)
      });
      return localResult;
    }

    const raw = await response.text().catch(() => "");
    if (response.status === 404){
      const localResult = buildLocalModeResult("endpoint_missing", {
        endpointAvailable: false,
        endpointChecked: true,
        endpointUrl
      });
      logPolicyRuntimeError("policy status endpoint missing", { endpointUrl });
      return localResult;
    }
    if (!response.ok){
      const localResult = buildLocalModeResult("http_error", {
        endpointAvailable: true,
        endpointChecked: true,
        endpointUrl
      });
      logPolicyRuntimeError("policy status fallback", {
        reason: localResult.reason,
        status: response.status,
        endpointUrl
      });
      return localResult;
    }

    let parsed = null;
    try{
      parsed = raw ? JSON.parse(raw) : null;
    }catch(error){
      const localResult = buildLocalModeResult("invalid_payload", {
        endpointAvailable: true,
        endpointChecked: true,
        endpointUrl
      });
      logPolicyRuntimeError("policy status fallback", {
        reason: localResult.reason,
        endpointUrl,
        error: error?.message || String(error)
      });
      return localResult;
    }

    const normalized = normalizeStatusPayload(parsed);
    normalized.endpointUrl = endpointUrl;
    L("policy status fetched", {
      mode: normalized.mode,
      policyActive: normalized.policyActive,
      domains: {
        share: normalized.policyDomains?.share?.active === true,
        talk: normalized.policyDomains?.talk?.active === true,
        emailSignature: normalized.policyDomains?.email_signature?.active === true
      },
      seatAssigned: normalized.status.seatAssigned,
      seatState: normalized.status.seatState,
      isValid: normalized.status.isValid,
      warning: normalized.warning.code || ""
    });
    return normalized;
  }

  /**
   * Return true when a policy setting is locked by admin.
   * @param {any} status
   * @param {"share"|"talk"|"email_signature"} domain
   * @param {string} key
   * @returns {boolean}
   */
  function isLocked(status, domain, key){
    if (!isDomainActive(status, domain)){
      return false;
    }
    return readEditableFlag(status, domain, key) === false;
  }

  /**
   * Return true when a policy domain exists in the backend payload.
   * @param {any} status
   * @param {"share"|"talk"|"email_signature"} domain
   * @returns {boolean}
   */
  function isDomainAvailable(status, domain){
    const domainState = status?.policyDomains?.[domain];
    if (isObject(domainState) && Object.prototype.hasOwnProperty.call(domainState, "available")){
      return domainState.available === true;
    }
    return isObject(status?.policy?.[domain]) && isObject(status?.policyEditable?.[domain]);
  }

  /**
   * Return true when a policy domain exists and the seat may use backend policy.
   * @param {any} status
   * @param {"share"|"talk"|"email_signature"} domain
   * @returns {boolean}
   */
  function isDomainActive(status, domain){
    const domainState = status?.policyDomains?.[domain];
    if (isObject(domainState) && Object.prototype.hasOwnProperty.call(domainState, "active")){
      return domainState.active === true;
    }
    return !!status?.policyActive && isDomainAvailable(status, domain);
  }

  return {
    getPolicyStatus,
    readPolicyValue,
    readEditableFlag,
    isDomainAvailable,
    isDomainActive,
    isLocked
  };
})();
