/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

/**
 * Central email signature runtime.
 * Uses standard Thunderbird compose APIs plus a compose script for live editor
 * DOM cleanup/insertion. Backend HTML is sanitized with the existing Share/Talk
 * sanitizer path before it enters the compose document.
 */
const NCEmailSignature = (() => {
  const COMPOSE_SCRIPT_FILE = "ui/signatureCompose.js";
  const APPLY_MESSAGE_TYPE = "nc-signature:apply";
  const PING_MESSAGE_TYPE = "nc-signature:ping";
  const STORAGE_KEYS = {
    onCompose: "emailSignatureOnCompose",
    onReply: "emailSignatureOnReply",
    onForward: "emailSignatureOnForward",
    debug: "debugEnabled"
  };
  const INIT_RETRY_DELAYS_MS = [100, 250, 500, 900, 1400];
  const TAB_STATE = new Map();
  const PENDING_TABS = new Set();

  function normalizeEmail(value){
    const email = String(value || "").trim().toLowerCase();
    return email.includes("@") ? email : "";
  }

  function normalizeIdentityRecord(identity, accountId = ""){
    if (!identity || typeof identity !== "object"){
      return null;
    }
    const id = String(identity.id || "").trim();
    const email = normalizeEmail(identity.email || "");
    if (!id || !email){
      return null;
    }
    return {
      id,
      email,
      accountId: String(identity.accountId || accountId || "").trim()
    };
  }

  async function listIdentityRecords(){
    const identityApi = browser?.identities;
    if (identityApi && typeof identityApi.list === "function"){
      const identities = await identityApi.list();
      return (Array.isArray(identities) ? identities : [])
        .map((identity) => normalizeIdentityRecord(identity))
        .filter(Boolean);
    }
    const accounts = await browser.accounts.list();
    const identities = [];
    for (const account of Array.isArray(accounts) ? accounts : []){
      for (const identity of Array.isArray(account?.identities) ? account.identities : []){
        const normalized = normalizeIdentityRecord(identity, String(account?.id || ""));
        if (normalized){
          identities.push(normalized);
        }
      }
    }
    return identities;
  }

  async function resolveIdentityEmail(identityId){
    const id = String(identityId || "").trim();
    if (!id){
      return "";
    }
    const identityApi = browser?.identities;
    if (identityApi && typeof identityApi.get === "function"){
      try{
        const identity = await identityApi.get(id);
        return normalizeIdentityRecord(identity)?.email || "";
      }catch(error){
        console.error("[NCBG] email signature identity lookup failed", {
          error: error?.message || String(error)
        });
      }
    }
    const identities = await listIdentityRecords();
    return identities.find((identity) => identity.id === id)?.email || "";
  }

  async function readLocalSignatureOptions(){
    return browser.storage.local.get(Object.values(STORAGE_KEYS));
  }

  function resolveSignaturePolicy(status, localOptions){
    if (!NCPolicyState.isDomainAvailable(status, "email_signature")){
      return { active: false, reason: "signature_backend_unsupported" };
    }
    if (!NCPolicyState.isDomainActive(status, "email_signature")){
      return { active: false, reason: "policy_inactive" };
    }
    const backendOnCompose = NCPolicyState.readPolicyValue(status, "email_signature", "email_signature_on_compose") === true;
    const backendOnReply = NCPolicyState.readPolicyValue(status, "email_signature", "email_signature_on_reply") === true;
    const backendOnForward = NCPolicyState.readPolicyValue(status, "email_signature", "email_signature_on_forward") === true;
    const templateHtml = String(NCPolicyState.readPolicyValue(status, "email_signature", "email_signature_template") || "").trim();
    const userEmail = normalizeEmail(NCPolicyState.readPolicyValue(status, "email_signature", "user_email"));

    const onCompose = NCPolicyState.resolveDefaultValue(
      status,
      "email_signature",
      "email_signature_on_compose",
      NCPolicyState.coerceBoolean(localOptions?.[STORAGE_KEYS.onCompose], backendOnCompose),
      typeof localOptions?.[STORAGE_KEYS.onCompose] === "boolean",
      NCPolicyState.coerceBoolean
    );
    const onReply = NCPolicyState.resolveDefaultValue(
      status,
      "email_signature",
      "email_signature_on_reply",
      NCPolicyState.coerceBoolean(localOptions?.[STORAGE_KEYS.onReply], backendOnReply),
      typeof localOptions?.[STORAGE_KEYS.onReply] === "boolean",
      NCPolicyState.coerceBoolean
    );
    const onForward = NCPolicyState.resolveDefaultValue(
      status,
      "email_signature",
      "email_signature_on_forward",
      NCPolicyState.coerceBoolean(localOptions?.[STORAGE_KEYS.onForward], backendOnForward),
      typeof localOptions?.[STORAGE_KEYS.onForward] === "boolean",
      NCPolicyState.coerceBoolean
    );

    if (!onCompose){
      return { active: false, reason: "signature_disabled" };
    }
    if (!templateHtml){
      return { active: false, reason: "signature_template_missing" };
    }
    if (!userEmail){
      return { active: false, reason: "signature_user_email_missing" };
    }

    return {
      active: true,
      userEmail,
      templateHtml,
      onCompose,
      onReply,
      onForward
    };
  }

  function resolveComposeKind(details){
    const type = String(details?.type || "").trim().toLowerCase();
    if (type === "new" || type === "reply" || type === "forward"){
      return type;
    }
    return "";
  }

  function resolveShouldInsert(policy, composeKind){
    if (!policy?.onCompose){
      return false;
    }
    if (composeKind === "new"){
      return true;
    }
    if (composeKind === "reply"){
      return policy.onReply === true;
    }
    if (composeKind === "forward"){
      return policy.onForward === true;
    }
    return false;
  }

  function resolveShouldClearForeign(policy, composeKind){
    if (!policy?.onCompose){
      return false;
    }
    return composeKind === "new" || composeKind === "reply" || composeKind === "forward";
  }

  function resolvePlainTextMode(details){
    const deliveryFormat = typeof details?.deliveryFormat === "string"
      ? details.deliveryFormat.trim().toLowerCase()
      : "";
    return details?.isPlainText === true || deliveryFormat === "plaintext";
  }

  function sanitizeSignatureHtml(html){
    if (typeof NCHtmlSanitizer?.sanitizeShareTemplateHtml !== "function"){
      throw new Error("email_signature_sanitizer_unavailable");
    }
    const sanitized = String(NCHtmlSanitizer.sanitizeShareTemplateHtml(String(html || "")) || "").trim();
    if (!sanitized){
      throw new Error("email_signature_sanitized_empty");
    }
    return sanitized;
  }

  function signatureHtmlToPlainText(html){
    if (typeof NCHtmlSanitizer?.htmlToPlainText !== "function"){
      throw new Error("email_signature_plaintext_converter_unavailable");
    }
    const plainText = String(NCHtmlSanitizer.htmlToPlainText(String(html || "")) || "")
      .replace(/\r\n?/g, "\n")
      .trim();
    if (!plainText){
      throw new Error("email_signature_plaintext_empty");
    }
    return plainText;
  }

  function delay(ms){
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  async function waitForComposeScript(tabId){
    for (const delayMs of INIT_RETRY_DELAYS_MS){
      try{
        const response = await browser.tabs.sendMessage(tabId, { type: PING_MESSAGE_TYPE });
        if (response?.ok){
          return true;
        }
      }catch(error){
        // The compose script can lag behind the compose tab creation event.
      }
      await delay(delayMs);
    }
    return false;
  }

  async function sendSignatureMessage(tabId, payload){
    const ready = await waitForComposeScript(tabId);
    if (!ready){
      return { ok: false, error: "compose_script_unavailable" };
    }
    return browser.tabs.sendMessage(tabId, {
      type: APPLY_MESSAGE_TYPE,
      payload
    });
  }

  async function resetModifiedStateIfNeeded(tabId, wasModified, result){
    if (wasModified || result?.changed !== true){
      return;
    }
    try{
      await browser.compose.setComposeDetails(tabId, { isModified: false });
    }catch(error){
      console.error("[NCBG] email signature modified-state reset failed", {
        tabId,
        error: error?.message || String(error)
      });
    }
  }

  async function clearOwnSignatureIfUnchanged(tabId, reason){
    const result = await sendSignatureMessage(tabId, {
      desired: false,
      clearOwnOnly: true,
      clearForeign: false,
      requireExistingOwnUnchanged: true
    });
    TAB_STATE.set(tabId, { managed: false, matched: false });
    L("email signature own signature cleared or skipped", {
      tabId,
      reason,
      changed: result?.changed === true,
      result: String(result?.reason || result?.error || "")
    });
  }

  async function applySignatureToTab(tabId, reason){
    let details;
    try{
      details = await browser.compose.getComposeDetails(tabId);
    }catch(error){
      L("email signature compose details unavailable", {
        tabId,
        reason,
        error: error?.message || String(error)
      });
      return;
    }

    const composeKind = resolveComposeKind(details);
    if (!composeKind){
      L("email signature skipped for compose type", {
        tabId,
        reason,
        composeType: String(details?.type || "")
      });
      return;
    }

    const [status, localOptions] = await Promise.all([
      NCPolicyRuntime.getPolicyStatus(),
      readLocalSignatureOptions()
    ]);
    const policy = resolveSignaturePolicy(status, localOptions);
    const previousState = TAB_STATE.get(tabId) || {};
    if (!policy.active){
      if (previousState.managed === true){
        await clearOwnSignatureIfUnchanged(tabId, policy.reason);
      }else{
        TAB_STATE.set(tabId, { managed: false, matched: false });
      }
      L("email signature inactive", {
        tabId,
        reason,
        cause: policy.reason
      });
      return;
    }

    const identityEmail = await resolveIdentityEmail(details?.identityId);
    if (identityEmail !== policy.userEmail){
      // Only the matching Nextcloud identity owns the managed signature slot.
      // Other Thunderbird identities may use local or Signature Switch signatures.
      if (reason === "identity_changed" && TAB_STATE.get(tabId)?.matched){
        await clearOwnSignatureIfUnchanged(tabId, "identity_mismatch");
      }else{
        TAB_STATE.set(tabId, { managed: false, matched: false });
      }
      L("email signature skipped for non-seat identity", {
        tabId,
        reason,
        composeType: composeKind,
        hasIdentityEmail: !!identityEmail,
        hasPolicyEmail: !!policy.userEmail
      });
      return;
    }

    const shouldInsert = resolveShouldInsert(policy, composeKind);
    const shouldClearForeign = resolveShouldClearForeign(policy, composeKind);
    const requireExistingOwnUnchanged = reason === "identity_changed" && previousState.managed === true;
    const sanitizedHtml = shouldInsert ? sanitizeSignatureHtml(policy.templateHtml) : "";
    const plainTextMode = shouldInsert && resolvePlainTextMode(details);
    const plainText = plainTextMode ? signatureHtmlToPlainText(sanitizedHtml) : "";
    const result = await sendSignatureMessage(tabId, {
      desired: shouldInsert,
      clearForeign: shouldClearForeign,
      clearOwnOnly: !shouldInsert && !shouldClearForeign,
      requireExistingOwnUnchanged,
      html: sanitizedHtml,
      plainText,
      plainTextMode,
      placeCursorAtStart: reason === "compose_open" && details?.isModified !== true,
      debugEnabled: localOptions?.[STORAGE_KEYS.debug] === true
    });
    if (!result?.ok){
      throw new Error(result?.error || "email_signature_apply_failed");
    }
    const managed = shouldInsert ? result.managed !== false : false;
    TAB_STATE.set(tabId, { managed, matched: true });
    await resetModifiedStateIfNeeded(tabId, details?.isModified === true, result);
    L("email signature processed", {
      tabId,
      reason,
      composeType: composeKind,
      desired: shouldInsert,
      clearForeign: shouldClearForeign,
      changed: result.changed === true,
      result: String(result.reason || ""),
      plainTextMode
    });
  }

  function scheduleApply(tabId, reason){
    const normalizedTabId = Number(tabId);
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0){
      return;
    }
    if (PENDING_TABS.has(normalizedTabId)){
      return;
    }
    PENDING_TABS.add(normalizedTabId);
    (async () => {
      try{
        await delay(150);
        await applySignatureToTab(normalizedTabId, reason);
      }catch(error){
        console.error("[NCBG] email signature processing failed", {
          tabId: normalizedTabId,
          reason,
          error: error?.message || String(error)
        });
      }finally{
        PENDING_TABS.delete(normalizedTabId);
      }
    })();
  }

  async function registerComposeScript(){
    if (!browser?.composeScripts?.register){
      console.error("[NCBG] email signature composeScripts API unavailable");
      return;
    }
    await browser.composeScripts.register({
      js: [{ file: COMPOSE_SCRIPT_FILE }]
    });
    L("email signature compose script registered");
  }

  async function handleComposeWindowCreated(window){
    if (String(window?.type || "") !== "messageCompose"){
      return;
    }
    const windowId = Number(window?.id);
    if (!Number.isInteger(windowId) || windowId <= 0){
      return;
    }
    for (const delayMs of INIT_RETRY_DELAYS_MS){
      await delay(delayMs);
      const tabs = await browser.tabs.query({ windowId, type: "messageCompose" });
      const tabId = Number(tabs?.[0]?.id);
      if (Number.isInteger(tabId) && tabId > 0){
        scheduleApply(tabId, "compose_open");
        return;
      }
    }
  }

  function init(){
    registerComposeScript().catch((error) => {
      console.error("[NCBG] email signature compose script registration failed", error);
    });
    browser.windows.onCreated.addListener((window) => {
      handleComposeWindowCreated(window).catch((error) => {
        console.error("[NCBG] email signature window handler failed", error);
      });
    });
    browser.tabs.onCreated.addListener((tab) => {
      if (String(tab?.type || "") === "messageCompose"){
        scheduleApply(tab.id, "compose_open");
      }
    });
    browser.compose.onIdentityChanged.addListener((tab) => {
      scheduleApply(tab?.id, "identity_changed");
    });
    browser.tabs.onRemoved.addListener((tabId) => {
      TAB_STATE.delete(Number(tabId));
      PENDING_TABS.delete(Number(tabId));
    });
  }

  return {
    init,
    STORAGE_KEYS
  };
})();

NCEmailSignature.init();
