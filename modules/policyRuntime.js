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
  const STATUS_ENDPOINT_INDEX_PATH = "/index.php/apps/ncc_backend_4mc/api/v1/status";
  const {
    POLICY_DOMAINS,
    isObject,
    isSeatUsable,
    buildDomainState
  } = NCPolicyState;

  function buildStatusEndpointUrl(baseUrl, endpointPath = STATUS_ENDPOINT_PATH){
    return String(baseUrl || "").replace(/\/+$/, "") + endpointPath;
  }

  function hasOwn(object, key){
    return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
  }

  function isBackendStatusPayload(payload){
    return isObject(payload?.status)
      && hasOwn(payload.status, "seat_assigned")
      && hasOwn(payload.status, "seat_state")
      && (isObject(payload?.policy) || isObject(payload?.policy_editable));
  }

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

  function buildPolicyResponseDebug(response, endpointUrl, raw = ""){
    const details = {
      status: Number(response?.status) || 0,
      statusText: String(response?.statusText || ""),
      endpointUrl: String(endpointUrl || ""),
      responseUrl: String(response?.url || ""),
      contentType: "",
      rawLength: String(raw || "").length
    };
    try{
      details.contentType = String(response?.headers?.get?.("content-type") || "");
    }catch(error){
      details.headerReadError = error?.message || String(error);
    }
    return details;
  }

  function buildPolicyStatusDebug(result, source = ""){
    return {
      source: String(source || ""),
      reason: String(result?.reason || ""),
      endpointAvailable: !!result?.endpointAvailable,
      endpointChecked: !!result?.endpointChecked,
      endpointUrl: String(result?.endpointUrl || ""),
      policyActive: !!result?.policyActive,
      seatAssigned: !!result?.status?.seatAssigned,
      seatState: String(result?.status?.seatState || ""),
      isValid: result?.status?.isValid === true,
      domains: {
        share: result?.policyDomains?.share?.active === true,
        talk: result?.policyDomains?.talk?.active === true,
        emailSignature: result?.policyDomains?.email_signature?.active === true
      }
    };
  }

  function logPolicyFallback(scope, details, optionalProbe){
    if (optionalProbe){
      L(scope, details);
      return;
    }
    globalThis.NCLogContext.safeConsoleError("[NCBG]", scope, details);
  }

  async function fetchStatusEndpoint(endpointUrl, trimmedUser, password){
    const response = await fetch(endpointUrl, {
      method: "GET",
      headers: {
        "Authorization": NCOcs.buildAuthHeader(trimmedUser, password),
        "Accept": "application/json"
      }
    });
    const raw = await response.text().catch(() => "");
    return { response, raw };
  }

  function parseStatusPayload(raw){
    try{
      return {
        ok: true,
        payload: raw ? JSON.parse(raw) : null,
        error: null
      };
    }catch(error){
      return {
        ok: false,
        payload: null,
        error
      };
    }
  }

  function logNormalizedStatus(source, normalized){
    L("policy status fetched", {
      source,
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
  }

  function normalizeAndLogStatusPayload(payload, endpointUrl, source){
    const normalized = normalizeStatusPayload(payload);
    normalized.endpointUrl = endpointUrl;
    logNormalizedStatus(source, normalized);
    return normalized;
  }

  /**
   * Normalize server payload into internal runtime status shape.
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

  async function readPolicyStatusFromCredentials({
    baseUrl,
    user,
    appPass,
    source = "runtime",
    optionalProbe = false
  } = {}){
    const normalizedBaseUrl = NCCore.normalizeBaseUrl(String(baseUrl || "").trim());
    const trimmedUser = String(user || "").trim();
    const password = String(appPass || "");
    if (!normalizedBaseUrl || !trimmedUser || !password){
      L("policy status skipped", {
        source,
        reason: "credentials_missing",
        hasBaseUrl: !!normalizedBaseUrl,
        hasUser: !!trimmedUser,
        hasAppPass: !!password
      });
      return buildLocalModeResult("credentials_missing", {
        endpointChecked: false
      });
    }

    const endpointUrl = buildStatusEndpointUrl(normalizedBaseUrl);
    let activeEndpointUrl = endpointUrl;
    try{
      if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.requireOriginPermission){
        await NCHostPermissions.requireOriginPermission(normalizedBaseUrl, {
          message: bgI18n("error_host_permission_missing"),
          scope: "policy status host permission missing",
          logMissing: true
        });
      }
    }catch(error){
      const localResult = buildLocalModeResult("permission_missing", {
        endpointChecked: false,
        endpointUrl
      });
      logPolicyFallback("policy status fallback", {
        source,
        reason: localResult.reason,
        endpointUrl,
        error: error?.message || String(error)
      }, optionalProbe);
      return localResult;
    }

    let response;
    let raw = "";
    try{
      const result = await fetchStatusEndpoint(endpointUrl, trimmedUser, password);
      response = result.response;
      raw = result.raw;
    }catch(error){
      const localResult = buildLocalModeResult("network_error", {
        endpointChecked: true,
        endpointUrl
      });
      logPolicyFallback("policy status fallback", {
        source,
        reason: localResult.reason,
        endpointUrl,
        error: error?.message || String(error)
      }, optionalProbe);
      return localResult;
    }

    if (response.status === 404){
      // Broken pretty URL rewrites can return the real Nextcloud app body with HTTP 404.
      const parsedPretty = parseStatusPayload(raw);
      if (parsedPretty.ok && isBackendStatusPayload(parsedPretty.payload)){
        L("policy status pretty url returned valid payload with http 404", {
          source,
          hint: "Backend reachable, but server returned unexpected HTTP status. Check Nextcloud rewrite / pretty URL configuration.",
          ...buildPolicyResponseDebug(response, endpointUrl, raw)
        });
        return normalizeAndLogStatusPayload(parsedPretty.payload, endpointUrl, source);
      }

      const fallbackEndpointUrl = buildStatusEndpointUrl(normalizedBaseUrl, STATUS_ENDPOINT_INDEX_PATH);
      L("policy status trying index.php fallback", {
        source,
        reason: "pretty_url_404",
        prettyUrl: endpointUrl,
        fallbackUrl: fallbackEndpointUrl
      });

      try{
        activeEndpointUrl = fallbackEndpointUrl;
        const fallbackResult = await fetchStatusEndpoint(fallbackEndpointUrl, trimmedUser, password);
        response = fallbackResult.response;
        raw = fallbackResult.raw;
      }catch(error){
        const localResult = buildLocalModeResult("endpoint_missing", {
          endpointAvailable: false,
          endpointChecked: true,
          endpointUrl
        });
        logPolicyFallback("policy status fallback", {
          source,
          reason: localResult.reason,
          prettyUrl: endpointUrl,
          fallbackUrl: fallbackEndpointUrl,
          error: error?.message || String(error)
        }, optionalProbe);
        return localResult;
      }

      if (response.ok){
        L("policy status index.php fallback responded", {
          source,
          hint: "Backend policy endpoint reached via index.php fallback. Pretty URL rewrite may be misconfigured.",
          ...buildPolicyResponseDebug(response, fallbackEndpointUrl, raw)
        });
      }else if (response.status === 404){
        const localResult = buildLocalModeResult("endpoint_missing", {
          endpointAvailable: false,
          endpointChecked: true,
          endpointUrl: fallbackEndpointUrl
        });
        L("policy status endpoint missing", {
          source,
          prettyUrl: endpointUrl,
          ...buildPolicyResponseDebug(response, fallbackEndpointUrl, raw)
        });
        return localResult;
      }
    }
    if (!response.ok){
      const localResult = buildLocalModeResult("http_error", {
        endpointAvailable: true,
        endpointChecked: true,
        endpointUrl: activeEndpointUrl
      });
      logPolicyFallback("policy status fallback", {
        source,
        reason: localResult.reason,
        ...buildPolicyResponseDebug(response, activeEndpointUrl, raw)
      }, optionalProbe);
      return localResult;
    }

    const parsed = parseStatusPayload(raw);
    if (!parsed.ok || !isBackendStatusPayload(parsed.payload)){
      const localResult = buildLocalModeResult("invalid_payload", {
        endpointAvailable: true,
        endpointChecked: true,
        endpointUrl: activeEndpointUrl
      });
      logPolicyFallback("policy status fallback", {
        source,
        reason: localResult.reason,
        ...buildPolicyResponseDebug(response, activeEndpointUrl, raw),
        error: parsed.error?.message || "Unexpected backend status payload"
      }, optionalProbe);
      return localResult;
    }

    return normalizeAndLogStatusPayload(parsed.payload, activeEndpointUrl, source);
  }

  /**
   * Read backend status live from the backend endpoint.
   * @returns {Promise<object>}
   */
  async function getPolicyStatus(){
    const opts = await NCCore.getOpts();
    return readPolicyStatusFromCredentials({
      baseUrl: opts?.baseUrl,
      user: opts?.user,
      appPass: opts?.appPass,
      source: "runtime",
      optionalProbe: false
    });
  }

  async function probePolicyStatus(params = {}){
    const result = await readPolicyStatusFromCredentials({
      baseUrl: params?.baseUrl,
      user: params?.user,
      appPass: params?.appPass,
      source: params?.source || "options_test",
      optionalProbe: true
    });
    L("policy status probe result", buildPolicyStatusDebug(result, params?.source || "options_test"));
    return result;
  }

  return {
    getPolicyStatus,
    probePolicyStatus
  };
})();
