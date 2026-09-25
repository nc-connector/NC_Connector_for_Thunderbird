/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  "use strict";

  const BACKEND_REQUIRED_FALLBACK = "This feature requires the Nextcloud backend.";
  const NO_SEAT_FALLBACK = "Your administrator must assign an NC Connector seat to your account for this feature.";
  const PRO_REQUIRED_FALLBACK = "External VFS providers require NC Connector Pro.";
  const NOTICE_KEYS = Object.freeze({
    backend_unavailable: "policy_warning_backend_unavailable",
    no_seat: "policy_warning_no_seat",
    license_expired: "policy_license_expired",
    license_inactive: "policy_license_inactive",
    license_invalid_explicit: "policy_license_invalid",
    license_activation_conflict: "policy_license_activation_conflict",
    license_activation_required: "policy_license_activation_required",
    license_offline_expired: "policy_license_offline_expired",
    license_invalid: "policy_warning_license_invalid",
    overlicensed: "policy_warning_overlicensed",
    seat_paused: "policy_warning_seat_suspended",
    seat_unavailable: "policy_warning_seat_unavailable",
    license_grace: "policy_license_grace",
    license_connection_error: "policy_license_connection_error"
  });

  function text(translate, key, fallback = "", substitutions){
    if (typeof translate !== "function"){
      return fallback || "";
    }
    return translate(key, substitutions) || fallback || "";
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
    const key = notice?.code === "no_seat" ? noSeatKey : NOTICE_KEYS[notice?.code];
    if (!key){
      return "";
    }
    const graceUntil = formatNoticeDate(notice.graceUntilIso);
    const lines = [notice.code === "license_grace" && graceUntil
      ? text(translate, "policy_license_grace_format", "", [graceUntil])
      : text(translate, key)];
    if (notice.license){
      if (notice.connectionError && notice.code !== "license_connection_error"){
        lines.push(text(translate, "policy_license_connection_error"));
      }
      if (notice.connectionError || notice.code === "license_offline_expired"){
        const lastSync = formatNoticeDate(notice.lastSyncAtIso);
        const offlineUntil = formatNoticeDate(notice.offlineUntilIso);
        if (lastSync){
          lines.push(text(translate, "policy_license_last_sync_format", "", [lastSync]));
        }
        if (offlineUntil){
          lines.push(text(translate, "policy_license_offline_until_format", "", [offlineUntil]));
        }
      }
      lines.push(text(translate, notice.canManageLicense
        ? "policy_license_admin_hint"
        : "policy_license_user_hint"));
      if (notice.canManageLicense && !notice.seatAssigned && notice.code === "license_grace"){
        lines.push(text(translate, noSeatKey));
      }
    }else if (notice.code === "seat_paused" || notice.code === "seat_unavailable"){
      lines.push(text(translate, "policy_license_user_hint"));
    }
    return lines.filter(Boolean).join("\n");
  }

  function getPolicyWarningMessage(policyStatus, translate){
    return getStatusNoticeMessage(NCPolicyState.getStatusNotice(policyStatus), translate);
  }

  function getLicenseAdminUrl(policyStatus){
    if (policyStatus?.status?.canManageLicense !== true){
      return "";
    }
    // endpointUrl comes from the configured account, never from the server reply.
    const endpoint = String(policyStatus?.endpointUrl || "");
    const suffix = ["/index.php/apps/ncc_backend_4mc/api/v1/status", "/apps/ncc_backend_4mc/api/v1/status"]
      .find((candidate) => endpoint.endsWith(candidate));
    if (!suffix){
      return "";
    }
    let url;
    try{
      url = new URL(endpoint.slice(0, -suffix.length) + "/index.php/settings/admin/ncc_backend_4mc");
    }catch(error){
      return "";
    }
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      ? url.href
      : "";
  }

  function getAdminControlledHint(translate){
    return text(translate, "policy_admin_controlled_tooltip", "Admin controlled");
  }

  function getSeparatePasswordUnavailableHint(policyStatus, translate){
    if (NCPolicyState.hasSeatEntitlement(policyStatus)){
      return "";
    }
    const notice = NCPolicyState.getStatusNotice(policyStatus);
    if (notice.code){
      return getStatusNoticeMessage(notice, translate, true);
    }
    if (!NCPolicyState.isEndpointAvailable(policyStatus)){
      return text(translate, "sharing_password_separate_backend_required_tooltip", BACKEND_REQUIRED_FALLBACK);
    }
    return text(translate, "policy_warning_license_invalid");
  }

  function isSeparatePasswordFeatureAvailable(policyStatus){
    return NCPolicyState.hasSeatEntitlement(policyStatus);
  }

  function getVfsExternalUnavailableHint(reason, translate, notice){
    if (reason && reason !== "admin_controlled" && notice?.code){
      return getStatusNoticeMessage(notice, translate, true);
    }
    switch (String(reason || "")){
      case "backend_required":
        return text(translate, "sharing_password_separate_backend_required_tooltip", BACKEND_REQUIRED_FALLBACK);
      case "pro_required":
        return text(translate, "vfs_external_pro_required_tooltip", PRO_REQUIRED_FALLBACK);
      case "license_invalid":
        return text(translate, "policy_warning_license_invalid");
      case "seat_required":
        return text(translate, "sharing_password_separate_no_seat_tooltip", NO_SEAT_FALLBACK);
      case "seat_paused":
        return text(translate, "policy_warning_license_invalid");
      case "admin_controlled":
        return getAdminControlledHint(translate);
      default:
        return "";
    }
  }

  function readPolicyDomain(status, domain){
    const active = NCPolicyState.isDomainActive(status, domain);
    return {
      status,
      active,
      policy: active ? status?.policy?.[domain] : null,
      editable: active ? status?.policyEditable?.[domain] : null,
      warningCode: String(status?.warning?.code || "")
    };
  }

  function applyPolicyWarningUi({ row, textElement, adminLink, policyStatus, translate } = {}){
    if (!row){
      return;
    }
    const notice = NCPolicyState.getStatusNotice(policyStatus);
    const message = getStatusNoticeMessage(notice, translate);
    const informational = ["license_grace", "license_connection_error", "backend_unavailable", "no_seat"].includes(notice.code);
    row.hidden = !message;
    row.classList.toggle("is-informational", informational);
    row.setAttribute("role", informational ? "status" : "alert");
    if (textElement){
      textElement.textContent = message;
    }
    if (adminLink){
      const url = message && notice.license ? getLicenseAdminUrl(policyStatus) : "";
      adminLink.hidden = !url;
      adminLink.textContent = text(translate, "policy_warning_admin_link_label");
      if (url){
        adminLink.href = url;
      }else{
        adminLink.removeAttribute("href");
      }
    }
  }

  function coerceBindingValue(value, fallback, binding = {}){
    if (typeof binding.coerce === "function"){
      return binding.coerce(value, fallback);
    }
    if (binding.type === "boolean"){
      return NCPolicyState.coerceBoolean(value, fallback);
    }
    if (binding.type === "int"){
      return NCPolicyState.coerceInt(value, fallback);
    }
    if (binding.type === "string"){
      return NCPolicyState.coerceString(value, fallback);
    }
    return value ?? fallback;
  }

  function normalizeBindingValue(value, fallback, binding = {}){
    const coerced = coerceBindingValue(value, fallback, binding);
    return typeof binding.normalize === "function"
      ? binding.normalize(coerced, fallback)
      : coerced;
  }

  function getBindingFallback(binding, current, locked){
    if (locked && Object.prototype.hasOwnProperty.call(binding, "lockedFallback")){
      return binding.lockedFallback;
    }
    return current;
  }

  function readPolicyBoundDefaults(domainState, bindings, defaults = {}, options = {}){
    const next = { ...defaults };
    if (!domainState?.active || !domainState?.policy){
      return next;
    }
    const localNames = typeof options?.localNames?.has === "function" ? options.localNames : null;
    bindings.forEach((binding) => {
      if (!binding?.name || !binding.key){
        return;
      }
      if (localNames?.has(binding.name)
        && !NCPolicyState.isEditableLocked(domainState.active, domainState.editable, binding.key)){
        return;
      }
      const current = Object.prototype.hasOwnProperty.call(next, binding.name)
        ? next[binding.name]
        : binding.fallback;
      const raw = NCPolicyState.readDomainValue(domainState.policy, binding.key);
      const locked = NCPolicyState.isEditableLocked(domainState.active, domainState.editable, binding.key);
      next[binding.name] = normalizeBindingValue(
        raw,
        getBindingFallback(binding, current, locked),
        binding
      );
    });
    return next;
  }

  function resolvePolicyBoundValues(status, bindings, values = {}){
    const next = { ...values };
    bindings.forEach((binding) => {
      if (!binding?.name || !binding.domain || !binding.key){
        return;
      }
      const current = Object.prototype.hasOwnProperty.call(next, binding.name)
        ? next[binding.name]
        : binding.fallback;
      const locked = NCPolicyState.isLocked(status, binding.domain, binding.key);
      next[binding.name] = NCPolicyState.resolveValue(
        status,
        binding.domain,
        binding.key,
        current,
        (value) => normalizeBindingValue(
          value,
          getBindingFallback(binding, current, locked),
          binding
        )
      );
    });
    return next;
  }

  function applyDisabledState({ element, row, disabled, title = "" } = {}){
    const locked = !!disabled;
    if (element){
      element.disabled = locked;
      element.title = title || "";
    }
    if (row){
      row.classList.toggle("is-disabled", locked);
      row.title = title || "";
    }
  }

  function applyEditableLock({ active, editable, key, element, row, translate, onLocked } = {}){
    const locked = NCPolicyState.isEditableLocked(active, editable, key);
    applyDisabledState({
      element,
      row,
      disabled: locked,
      title: locked ? getAdminControlledHint(translate) : ""
    });
    if (locked && typeof onLocked === "function"){
      onLocked();
    }
    return locked;
  }

  function applyPolicyBinding(status, binding, translate){
    if (!binding?.domain || !binding.key){
      return false;
    }
    const locked = NCPolicyState.isLocked(status, binding.domain, binding.key);
    const element = binding.element || null;
    if (locked && element && binding.property){
      const current = element[binding.property];
      const currentFallback = (current === "" || current == null) && binding.fallback !== undefined
        ? binding.fallback
        : current;
      const fallback = getBindingFallback(binding, currentFallback, locked);
      const raw = NCPolicyState.readPolicyValue(status, binding.domain, binding.key);
      element[binding.property] = normalizeBindingValue(raw, fallback, binding);
    }
    applyDisabledState({
      element,
      row: binding.row || null,
      disabled: locked,
      title: locked ? getAdminControlledHint(translate) : ""
    });
    return locked;
  }

  function createPasswordPolicyActions(options = {}){
    const sendMessage = options.sendMessage || ((message) => browser.runtime.sendMessage(message));
    const logger = options.logger || null;
    const logPrefix = options.logPrefix || "[NCUI][PasswordPolicy]";
    const fallbackLength = Math.max(1, Number(options.fallbackLength) || 12);

    return {
      async load(){
        const policy = await NCPasswordPolicyClient.loadPolicy({
          sendMessage,
          logger,
          logPrefix
        });
        if (typeof options.setPolicy === "function"){
          options.setPolicy(policy);
        }
        return policy;
      },
      getMinLength(){
        const policy = typeof options.getPolicy === "function" ? options.getPolicy() : null;
        return NCPasswordPolicyClient.getPolicyMinLength(policy);
      },
      async generate(){
        const policy = typeof options.getPolicy === "function" ? options.getPolicy() : null;
        return NCPasswordPolicyClient.generatePassword({
          policy,
          sendMessage,
          passwordGenerator: options.passwordGenerator,
          fallbackLength,
          logger,
          logPrefix
        });
      }
    };
  }

  global.NCWizardPolicyUi = {
    getAdminControlledHint,
    getPolicyWarningMessage,
    getLicenseAdminUrl,
    getSeparatePasswordUnavailableHint,
    isSeparatePasswordFeatureAvailable,
    getVfsExternalUnavailableHint,
    readPolicyDomain,
    applyPolicyWarningUi,
    readPolicyBoundDefaults,
    resolvePolicyBoundValues,
    applyDisabledState,
    applyEditableLock,
    applyPolicyBinding,
    createPasswordPolicyActions
  };
})(typeof window !== "undefined" ? window : globalThis);
