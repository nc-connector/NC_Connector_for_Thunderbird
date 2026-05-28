/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  "use strict";

  const LICENSE_INVALID_FALLBACK = "Your NC Connector license or seat is currently not valid. Local settings are used. Please contact your Nextcloud administrator.";
  const BACKEND_REQUIRED_FALLBACK = "This feature requires the Nextcloud backend.";
  const NO_SEAT_FALLBACK = "Your administrator must assign an NC Connector seat to your account for this feature.";
  const SEAT_PAUSED_FALLBACK = "Your NC Connector seat is currently paused. Please contact your Nextcloud administrator.";

  function text(translate, key, fallback = ""){
    if (typeof translate !== "function"){
      return fallback || "";
    }
    return translate(key, fallback) || fallback || "";
  }

  function getAdminControlledHint(translate){
    return text(translate, "policy_admin_controlled_tooltip", "Admin controlled");
  }

  function getSeparatePasswordUnavailableHint(policyStatus, translate){
    const status = policyStatus?.status;
    const seatState = String(status?.seatState || "").trim().toLowerCase();
    if (!NCPolicyState.isEndpointAvailable(policyStatus)){
      return text(translate, "sharing_password_separate_backend_required_tooltip", BACKEND_REQUIRED_FALLBACK);
    }
    if (!status?.seatAssigned){
      return text(translate, "sharing_password_separate_no_seat_tooltip", NO_SEAT_FALLBACK);
    }
    if (!status?.isValid || seatState !== "active"){
      return text(translate, "sharing_password_separate_paused_tooltip", SEAT_PAUSED_FALLBACK);
    }
    return "";
  }

  function isSeparatePasswordFeatureAvailable(policyStatus){
    return NCPolicyState.hasSeatEntitlement(policyStatus);
  }

  function readPolicyDomain(status, domain){
    const active = NCPolicyState.isDomainActive(status, domain);
    return {
      status,
      active,
      policy: active ? status?.policy?.[domain] : null,
      editable: active ? status?.policyEditable?.[domain] : null,
      warningVisible: !!status?.warning?.visible,
      warningCode: String(status?.warning?.code || "")
    };
  }

  function applyPolicyWarningUi({ row, textElement, warningVisible, translate } = {}){
    if (!row){
      return;
    }
    const visible = !!warningVisible;
    row.hidden = !visible;
    if (!visible){
      return;
    }
    const message = text(translate, "policy_warning_license_invalid", LICENSE_INVALID_FALLBACK);
    if (textElement){
      textElement.textContent = message;
    }
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
    getSeparatePasswordUnavailableHint,
    isSeparatePasswordFeatureAvailable,
    readPolicyDomain,
    applyPolicyWarningUi,
    createPasswordPolicyActions
  };
})(typeof window !== "undefined" ? window : globalThis);
