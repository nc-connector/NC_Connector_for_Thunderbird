/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  "use strict";

  function text(translate, key, fallback = "", substitutions){
    if (typeof translate !== "function"){
      return fallback || "";
    }
    return translate(key, substitutions) || fallback || "";
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
    return NCPolicyState.getSeatUnavailableMessage(policyStatus, translate);
  }

  function isSeparatePasswordFeatureAvailable(policyStatus){
    return NCPolicyState.hasSeatEntitlement(policyStatus);
  }

  function getVfsExternalUnavailableHint(reason, translate, notice){
    return reason === "admin_controlled"
      ? getAdminControlledHint(translate)
      : NCPolicyState.getStatusNoticeMessage({ ...notice, code: reason }, translate, true);
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
    const message = NCPolicyState.getStatusNoticeMessage(notice, translate);
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
