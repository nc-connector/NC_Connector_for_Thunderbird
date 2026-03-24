/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Compose password-dispatch and password-policy runtime module.
 * Owns recipient capture, follow-up password mails, and policy helpers.
 */
const PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS = 10000;

/**
 * Normalize compose recipients for beginNew/sendMessage.
 * Accepts string addresses and contact/list references (`id`/`nodeId` + `type`).
 * @param {any} value
 * @returns {Array<string|{type:string,id?:string,nodeId?:string}>}
 */
function normalizeComposeRecipientList(value){
  if (value == null){
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const entry of raw){
    if (typeof entry === "string"){
      const trimmed = entry.trim();
      if (trimmed){
        out.push(trimmed);
      }
      continue;
    }
    if (!entry || typeof entry !== "object"){
      continue;
    }
    const type = String(entry.type || "").trim();
    if (!type){
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id){
      out.push({ type, id });
      continue;
    }
    const nodeId = typeof entry.nodeId === "string" ? entry.nodeId.trim() : "";
    if (nodeId){
      out.push({ type, nodeId });
    }
  }
  return out;
}

/**
 * Build a stable key for one compose recipient entry.
 * @param {string|{type?:string,id?:string,nodeId?:string}} recipient
 * @returns {string}
 */
function composeRecipientKey(recipient){
  if (typeof recipient === "string"){
    const value = recipient.trim().toLowerCase();
    return value ? `addr:${value}` : "";
  }
  if (!recipient || typeof recipient !== "object"){
    return "";
  }
  const type = String(recipient.type || "").trim().toLowerCase();
  const id = String(recipient.id || "").trim().toLowerCase();
  const nodeId = String(recipient.nodeId || "").trim().toLowerCase();
  if (type && id){
    return `${type}:id:${id}`;
  }
  if (type && nodeId){
    return `${type}:node:${nodeId}`;
  }
  return "";
}

/**
 * Count unique recipients in one password-dispatch queue.
 * @param {Array<object>} queue
 * @returns {number}
 */
function countUniquePasswordDispatchRecipients(queue){
  const keys = new Set();
  for (const dispatch of queue){
    const groups = [dispatch?.to, dispatch?.cc, dispatch?.bcc];
    for (const group of groups){
      if (!Array.isArray(group)){
        continue;
      }
      for (const recipient of group){
        const key = composeRecipientKey(recipient);
        if (key){
          keys.add(key);
        }
      }
    }
  }
  return keys.size;
}

/**
 * Build a localized subject for password-only follow-up mails.
 * @param {object} dispatch
 * @returns {string}
 */
function buildSeparatePasswordMailSubject(dispatch){
  const shareLabel = String(dispatch?.shareLabel || "").trim();
  if (shareLabel){
    return bgI18n("sharing_password_mail_subject_with_label", [shareLabel]);
  }
  return bgI18n("sharing_password_mail_subject");
}

/**
 * Register a pending password-only follow-up mail for one compose tab.
 * Recipients are captured from compose.onBeforeSend for the final send action.
 * Initial compose details are captured immediately to preserve identity context.
 * @param {number} tabId
 * @param {{shareLabel?:string,shareUrl?:string,shareId?:string,folderInfo?:object,password?:string,html?:string}} payload
 */
async function registerSeparatePasswordMailDispatch(tabId, payload = {}){
  if (!Number.isInteger(tabId) || tabId <= 0){
    throw new Error("invalid_tab_id");
  }
  const password = String(payload.password || "").trim();
  const html = String(payload.html || "").trim();
  if (!password || !html){
    throw new Error("password_or_html_missing");
  }
  const dispatch = {
    tabId,
    shareLabel: String(payload.shareLabel || "").trim(),
    shareUrl: String(payload.shareUrl || "").trim(),
    shareId: String(payload.shareId || "").trim(),
    folderInfo: normalizeComposeShareCleanupFolderInfo(payload.folderInfo) || null,
    password,
    html,
    to: [],
    cc: [],
    bcc: [],
    identityId: "",
    from: "",
    created: Date.now()
  };
  try{
    const composeDetails = await browser.compose.getComposeDetails(tabId);
    const identityId = String(composeDetails?.identityId || "").trim();
    if (identityId){
      dispatch.identityId = identityId;
    }
    const from = String(composeDetails?.from || "").trim();
    if (from){
      dispatch.from = from;
    }
    dispatch.to = normalizeComposeRecipientList(composeDetails?.to);
    dispatch.cc = normalizeComposeRecipientList(composeDetails?.cc);
    dispatch.bcc = normalizeComposeRecipientList(composeDetails?.bcc);
  }catch(error){
    console.error("[NCBG] sharing separate password dispatch compose details unavailable", {
      tabId,
      error: error?.message || String(error)
    });
    L("sharing separate password dispatch compose details unavailable", {
      tabId,
      error: error?.message || String(error)
    });
  }
  const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
  if (Array.isArray(queue)){
    queue.push(dispatch);
  }else{
    PASSWORD_MAIL_DISPATCH_BY_TAB.set(tabId, [dispatch]);
  }
  L("sharing separate password dispatch registered", {
    tabId,
    queued: Array.isArray(PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId))
      ? PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId).length
      : 0,
    shareLabel: dispatch.shareLabel || "",
    hasShareUrl: !!dispatch.shareUrl,
    hasShareId: !!dispatch.shareId,
    hasFolderInfo: !!dispatch.folderInfo,
    hasIdentityId: !!dispatch.identityId,
    hasFrom: !!dispatch.from,
    to: dispatch.to.length,
    cc: dispatch.cc.length,
    bcc: dispatch.bcc.length
  });
}

/**
 * Capture recipients from compose.onBeforeSend for a pending password dispatch.
 * @param {number} tabId
 * @param {object} details
 */
function captureSeparatePasswordDispatchRecipients(tabId, details = {}){
  const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
  if (!Array.isArray(queue) || !queue.length){
    return;
  }
  const to = normalizeComposeRecipientList(details?.to);
  const cc = normalizeComposeRecipientList(details?.cc);
  const bcc = normalizeComposeRecipientList(details?.bcc);
  const identityId = String(details?.identityId || "").trim();
  const from = String(details?.from || "").trim();
  for (const dispatch of queue){
    dispatch.to = to.slice();
    dispatch.cc = cc.slice();
    dispatch.bcc = bcc.slice();
    if (identityId){
      dispatch.identityId = identityId;
    }
    if (from){
      dispatch.from = from;
    }
  }
  L("sharing separate password recipients captured", {
    tabId,
    queued: queue.length,
    to: to.length,
    cc: cc.length,
    bcc: bcc.length,
    hasIdentityId: !!identityId,
    hasFrom: !!from,
    firstToType: typeof to[0] === "string" ? "string" : (to[0]?.type || "")
  });
}

/**
 * Re-read compose details from the source tab to enrich queued dispatch identity/from.
 * This runs after send trigger and can still recover missing metadata in some setups.
 * @param {number} tabId
 * @param {Array<object>} queue
 * @returns {Promise<void>}
 */
async function enrichSeparatePasswordDispatchSourceIdentity(tabId, queue){
  if (!Array.isArray(queue) || !queue.length){
    return;
  }
  try{
    const composeDetails = await browser.compose.getComposeDetails(tabId);
    const identityId = String(composeDetails?.identityId || "").trim();
    const from = String(composeDetails?.from || "").trim();
    if (!identityId && !from){
      return;
    }
    for (const dispatch of queue){
      if (!dispatch.identityId && identityId){
        dispatch.identityId = identityId;
      }
      if (!dispatch.from && from){
        dispatch.from = from;
      }
    }
    L("sharing separate password source identity enriched", {
      tabId,
      hasIdentityId: !!identityId,
      hasFrom: !!from
    });
  }catch(error){
    const errorMessage = error?.message || String(error);
    if (errorMessage.includes("Invalid tab ID")){
      L("sharing separate password source identity enrich skipped (tab closed)", {
        tabId,
        error: errorMessage
      });
      return;
    }
    console.error("[NCBG] sharing separate password source identity enrich failed", {
      tabId,
      error: errorMessage
    });
    L("sharing separate password source identity enrich failed", {
      tabId,
      error: errorMessage
    });
  }
}

/**
 * Clear pending password dispatch state for one compose tab.
 * @param {number} tabId
 * @param {string} reason
 */
function clearSeparatePasswordDispatch(tabId, reason = ""){
  if (!PASSWORD_MAIL_DISPATCH_BY_TAB.has(tabId)){
    return;
  }
  PASSWORD_MAIL_DISPATCH_BY_TAB.delete(tabId);
  L("sharing separate password dispatch cleared", {
    tabId,
    reason: reason || ""
  });
}

/**
 * Take and clear pending password dispatch queue for one compose tab.
 * @param {number} tabId
 * @param {string} reason
 * @returns {Array<object>}
 */
function takeSeparatePasswordDispatch(tabId, reason = ""){
  const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
  PASSWORD_MAIL_DISPATCH_BY_TAB.delete(tabId);
  if (!Array.isArray(queue) || !queue.length){
    return [];
  }
  L("sharing separate password dispatch taken", {
    tabId,
    reason: reason || "",
    queued: queue.length
  });
  return queue;
}

/**
 * Show a desktop notification after password-only follow-up mail delivery.
 * @param {number} recipientCount
 * @returns {Promise<void>}
 */
async function showPasswordMailSuccessNotification(recipientCount){
  const count = Math.max(0, Number(recipientCount) || 0);
  if (count <= 0){
    return;
  }
  if (typeof browser?.notifications?.create !== "function"){
    L("sharing separate password notification skipped", {
      reason: "notifications_api_missing",
      recipients: count
    });
    return;
  }
  try{
    const notificationId = `nc-password-mail-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await browser.notifications.create(notificationId, {
      type: "basic",
      title: bgI18n("sharing_password_mail_notify_title"),
      message: bgI18n("sharing_password_mail_notify_success", [String(count)]),
      iconUrl: browser.runtime.getURL("icons/app-32.png")
    });
    L("sharing separate password notification shown", {
      notificationId,
      recipients: count
    });
  }catch(error){
    console.error("[NCBG] sharing separate password notification failed", {
      recipients: count,
      error: error?.message || String(error)
    });
    L("sharing separate password notification failed", {
      recipients: count,
      error: error?.message || String(error)
    });
  }
}

/**
 * Show a desktop notification that manual password-mail send is required.
 * @param {number} recipientCount
 * @param {{requireSenderSelection?:boolean}} options
 * @returns {Promise<void>}
 */
async function showPasswordMailManualRequiredNotification(recipientCount, options = {}){
  const count = Math.max(0, Number(recipientCount) || 0);
  const requireSenderSelection = !!options?.requireSenderSelection;
  if (count <= 0){
    return;
  }
  if (typeof browser?.notifications?.create !== "function"){
    L("sharing separate password manual-required notification skipped", {
      reason: "notifications_api_missing",
      recipients: count
    });
    return;
  }
  try{
    const notificationId = `nc-password-mail-manual-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const messageKey = requireSenderSelection
      ? "sharing_password_mail_notify_manual_required_select_sender"
      : "sharing_password_mail_notify_manual_required";
    await browser.notifications.create(notificationId, {
      type: "basic",
      title: bgI18n("sharing_password_mail_notify_title"),
      message: bgI18n(messageKey, [String(count)]),
      iconUrl: browser.runtime.getURL("icons/app-32.png")
    });
    L("sharing separate password manual-required notification shown", {
      notificationId,
      recipients: count,
      requireSenderSelection
    });
  }catch(error){
    console.error("[NCBG] sharing separate password manual-required notification failed", {
      recipients: count,
      error: error?.message || String(error)
    });
    L("sharing separate password manual-required notification failed", {
      recipients: count,
      error: error?.message || String(error)
    });
  }
}

/**
 * Show a desktop notification that automatic password-mail delivery failed.
 * @param {number} recipientCount
 * @returns {Promise<void>}
 */
async function showPasswordMailFailureNotification(recipientCount){
  const count = Math.max(0, Number(recipientCount) || 0);
  if (count <= 0){
    return;
  }
  if (typeof browser?.notifications?.create !== "function"){
    L("sharing separate password failure notification skipped", {
      reason: "notifications_api_missing",
      recipients: count
    });
    return;
  }
  try{
    const notificationId = `nc-password-mail-failed-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await browser.notifications.create(notificationId, {
      type: "basic",
      title: bgI18n("sharing_password_mail_notify_title"),
      message: bgI18n("sharing_password_mail_notify_failure", [String(count)]),
      iconUrl: browser.runtime.getURL("icons/app-32.png")
    });
    L("sharing separate password failure notification shown", {
      notificationId,
      recipients: count
    });
  }catch(error){
    console.error("[NCBG] sharing separate password failure notification failed", {
      recipients: count,
      error: error?.message || String(error)
    });
    L("sharing separate password failure notification failed", {
      recipients: count,
      error: error?.message || String(error)
    });
  }
}

/**
 * Open a manual password-mail compose fallback without forcing source identity.
 * This keeps sender selection editable if source identity metadata is missing.
 * @param {number} sourceTabId
 * @param {object} dispatch
 * @param {number} failedComposeTabId
 * @param {string} reason
 * @returns {Promise<number>}
 */
async function openManualPasswordComposeFallback(sourceTabId, dispatch, failedComposeTabId, reason){
  const manualComposeDetails = {
    to: dispatch.to,
    cc: dispatch.cc,
    bcc: dispatch.bcc,
    subject: buildSeparatePasswordMailSubject(dispatch),
    isPlainText: false,
    body: dispatch.html
  };
  if (dispatch.identityId){
    manualComposeDetails.identityId = dispatch.identityId;
  }
  const manualComposeTab = await browser.compose.beginNew(manualComposeDetails);
  const manualComposeTabId = Number(manualComposeTab?.id) || 0;
  L("sharing separate password mail manual fallback opened", {
    sourceTabId,
    failedComposeTabId: Number.isInteger(failedComposeTabId) ? failedComposeTabId : 0,
    manualComposeTabId,
    reason: String(reason || "")
  });
  return manualComposeTabId;
}

/**
 * Send a compose tab immediately with timeout, so hung sends can fail fast.
 * @param {number} composeTabId
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function sendComposeNowWithTimeout(composeTabId, timeoutMs = PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS){
  let timeoutId = null;
  let timeoutTriggered = false;
  const sendPromise = browser.compose.sendMessage(composeTabId, { mode: "sendNow" });
  try{
    await Promise.race([
      sendPromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutTriggered = true;
          reject(new Error("password_mail_send_timeout"));
        }, Math.max(1000, Number(timeoutMs) || PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS));
      })
    ]);
  }finally{
    if (timeoutId){
      clearTimeout(timeoutId);
    }
    // Prevent late unhandled rejection noise when timeout won the race.
    sendPromise.catch((error) => {
      if (!timeoutTriggered){
        return;
      }
      console.error("[NCBG] password mail send late rejection after timeout", {
        composeTabId,
        error: error?.message || String(error)
      });
    });
  }
}

/**
 * Arm compose-share cleanup for a manually opened password fallback compose tab.
 * If the tab closes without successful send, the share folder is deleted.
 * @param {number} sourceTabId
 * @param {number} manualComposeTabId
 * @param {object} dispatch
 * @returns {Promise<void>}
 */
async function armManualPasswordFallbackCleanup(sourceTabId, manualComposeTabId, dispatch){
  const folderInfo = normalizeComposeShareCleanupFolderInfo(dispatch?.folderInfo);
  if (!folderInfo){
    return;
  }
  if (!Number.isInteger(manualComposeTabId) || manualComposeTabId <= 0){
    return;
  }
  await armComposeShareCleanup(manualComposeTabId, {
    shareId: String(dispatch?.shareId || "").trim(),
    shareLabel: String(dispatch?.shareLabel || "").trim(),
    shareUrl: String(dispatch?.shareUrl || "").trim(),
    folderInfo
  });
  L("sharing separate password manual cleanup armed", {
    sourceTabId,
    manualComposeTabId,
    relativeFolder: folderInfo.relativeFolder,
    shareId: String(dispatch?.shareId || "").trim(),
    shareLabel: String(dispatch?.shareLabel || "").trim()
  });
}

/**
 * Best-effort immediate share cleanup if no manual fallback could be opened.
 * @param {number} sourceTabId
 * @param {object} dispatch
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function deleteShareAfterPasswordDispatchFailure(sourceTabId, dispatch, reason = ""){
  const folderInfo = normalizeComposeShareCleanupFolderInfo(dispatch?.folderInfo);
  if (!folderInfo){
    return;
  }
  try{
    await NCSharing.deleteShareFolder({ folderInfo });
    L("sharing separate password failure cleanup delete done", {
      sourceTabId,
      reason: reason || "",
      relativeFolder: folderInfo.relativeFolder,
      shareId: String(dispatch?.shareId || "").trim(),
      shareLabel: String(dispatch?.shareLabel || "").trim()
    });
  }catch(error){
    console.error("[NCBG] sharing separate password failure cleanup delete failed", {
      sourceTabId,
      reason: reason || "",
      relativeFolder: folderInfo.relativeFolder,
      shareId: String(dispatch?.shareId || "").trim(),
      shareLabel: String(dispatch?.shareLabel || "").trim(),
      error: error?.message || String(error)
    });
    L("sharing separate password failure cleanup delete failed", {
      sourceTabId,
      reason: reason || "",
      relativeFolder: folderInfo.relativeFolder,
      shareId: String(dispatch?.shareId || "").trim(),
      shareLabel: String(dispatch?.shareLabel || "").trim(),
      error: error?.message || String(error)
    });
  }
}

/**
 * Send the password-only follow-up mail after main compose send.
 * @param {number} tabId
 * @param {Array<object>} queue
 * @returns {Promise<void>}
 */
async function sendSeparatePasswordMail(tabId, queue){
  if (!Array.isArray(queue) || !queue.length){
    return;
  }
  const recipientCount = countUniquePasswordDispatchRecipients(queue);
  if (!recipientCount){
    throw new Error("no_recipients_for_password_mail");
  }
  let autoSendFailedCount = 0;
  let manualFallbackOpenedCount = 0;
  let manualFallbackFailedCount = 0;
  let manualFallbackNeedsSenderCount = 0;
  for (const dispatch of queue){
    const autoComposeDetails = {
      to: dispatch.to,
      cc: dispatch.cc,
      bcc: dispatch.bcc,
      subject: buildSeparatePasswordMailSubject(dispatch),
      isPlainText: false,
      body: dispatch.html
    };
    if (dispatch.identityId){
      autoComposeDetails.identityId = dispatch.identityId;
    }
    L("sharing separate password mail send start", {
      sourceTabId: tabId,
      to: dispatch.to.length,
      cc: dispatch.cc.length,
      bcc: dispatch.bcc.length,
      hasIdentityId: !!dispatch.identityId,
      hasFrom: !!dispatch.from
    });
    let composeTabId = 0;
    try{
      const composeTab = await browser.compose.beginNew(autoComposeDetails);
      composeTabId = Number(composeTab?.id);
      if (!Number.isInteger(composeTabId) || composeTabId <= 0){
        throw new Error("password_mail_compose_tab_invalid");
      }
      await browser.compose.getComposeDetails(composeTabId);
      await sendComposeNowWithTimeout(composeTabId, PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS);
      L("sharing separate password mail send done", {
        sourceTabId: tabId,
        composeTabId
      });
    }catch(sendError){
      autoSendFailedCount++;
      console.error("[NCBG] sharing separate password mail auto-send failed", {
        sourceTabId: tabId,
        composeTabId,
        error: sendError?.message || String(sendError)
      });
      L("sharing separate password mail auto-send failed", {
        sourceTabId: tabId,
        composeTabId,
        error: sendError?.message || String(sendError)
      });
      if (Number.isInteger(composeTabId) && composeTabId > 0){
        try{
          await browser.tabs.remove(composeTabId);
          L("sharing separate password mail failed auto tab removed", {
            sourceTabId: tabId,
            composeTabId
          });
        }catch(removeError){
          console.error("[NCBG] sharing separate password mail failed auto tab remove failed", {
            sourceTabId: tabId,
            composeTabId,
            error: removeError?.message || String(removeError)
          });
          L("sharing separate password mail failed auto tab remove failed", {
            sourceTabId: tabId,
            composeTabId,
            error: removeError?.message || String(removeError)
          });
        }
      }
      try{
        const manualComposeTabId = await openManualPasswordComposeFallback(tabId, dispatch, composeTabId, "auto_send_failed");
        await armManualPasswordFallbackCleanup(tabId, manualComposeTabId, dispatch);
        manualFallbackOpenedCount++;
        if (!String(dispatch?.identityId || "").trim() && !String(dispatch?.from || "").trim()){
          manualFallbackNeedsSenderCount++;
        }
      }catch(fallbackError){
        manualFallbackFailedCount++;
        console.error("[NCBG] sharing separate password mail manual fallback failed", {
          sourceTabId: tabId,
          failedComposeTabId: composeTabId,
          error: fallbackError?.message || String(fallbackError)
        });
        L("sharing separate password mail manual fallback failed", {
          sourceTabId: tabId,
          failedComposeTabId: composeTabId,
          error: fallbackError?.message || String(fallbackError)
        });
        await deleteShareAfterPasswordDispatchFailure(tabId, dispatch, "manual_fallback_open_failed");
      }
    }
  }
  if (autoSendFailedCount === 0){
    L("sharing separate password mail sent", {
      sourceTabId: tabId,
      dispatchCount: queue.length,
      recipients: recipientCount
    });
    await showPasswordMailSuccessNotification(recipientCount);
    return;
  }
  L("sharing separate password mail partially sent (manual fallback required)", {
    sourceTabId: tabId,
    dispatchCount: queue.length,
    recipients: recipientCount,
    autoSendFailedCount,
    manualFallbackOpenedCount,
    manualFallbackFailedCount,
    manualFallbackNeedsSenderCount
  });
  await showPasswordMailFailureNotification(recipientCount);
  if (manualFallbackOpenedCount > 0){
    await showPasswordMailManualRequiredNotification(recipientCount, {
      requireSenderSelection: manualFallbackNeedsSenderCount > 0
    });
  }
}

/**
 * Resolve a password policy URL against the base URL.
 * @param {string} value
 * @param {string} baseUrl
 * @returns {string|null}
 */
function resolvePolicyUrl(value, baseUrl){
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try{
    if (baseUrl){
      return new URL(raw, baseUrl).toString();
    }
    return new URL(raw).toString();
  }catch(error){
    console.error("[NCBG] normalize URL failed", {
      raw: String(raw || ""),
      baseUrl: String(baseUrl || ""),
      error: error?.message || String(error)
    });
    L("normalize URL failed", { raw: String(raw || ""), baseUrl: String(baseUrl || ""), error: error?.message || String(error) });
    return null;
  }
}

/**
 * Normalize the password policy payload from capabilities.
 * @param {object} policy
 * @param {string} baseUrl
 * @returns {{hasPolicy:boolean,minLength:number|null,apiGenerateUrl:string|null}}
 */
function normalizePasswordPolicy(policy, baseUrl){
  if (!policy || typeof policy !== "object"){
    return { ...FALLBACK_PASSWORD_POLICY };
  }
  const minRaw = policy.minLength ?? policy.min_length ?? policy.minimumLength ?? policy.minimum_length;
  const minLength = Number.isFinite(Number(minRaw)) && Number(minRaw) > 0
    ? Math.floor(Number(minRaw))
    : null;
  const generateRaw = policy?.api?.generate ?? policy?.api?.generateUrl ?? policy?.apiGenerateUrl ?? policy?.api?.generate_url;
  const apiGenerateUrl = resolvePolicyUrl(generateRaw, baseUrl);
  return {
    hasPolicy: true,
    minLength,
    apiGenerateUrl
  };
}

/**
 * Fetch the live password policy from Nextcloud.
 * @returns {Promise<{hasPolicy:boolean,minLength:number|null,apiGenerateUrl:string|null}>}
 */
async function fetchPasswordPolicy(){
  try{
    const { baseUrl, user, appPass } = await NCCore.getOpts();
    if (!baseUrl || !user || !appPass){
      console.error("[NCBG] password policy missing credentials");
      L("password policy fallback", { reason: "credentials_missing" });
      return { ...FALLBACK_PASSWORD_POLICY };
    }
    if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
      const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
      if (!ok){
        console.error("[NCBG] password policy host permission missing", baseUrl);
        L("password policy fallback", { reason: "permission_missing" });
        return { ...FALLBACK_PASSWORD_POLICY };
      }
    }
    const url = baseUrl + "/ocs/v2.php/cloud/capabilities?format=json";
    const headers = {
      "OCS-APIRequest": "true",
      "Authorization": NCOcs.buildAuthHeader(user, appPass),
      "Accept": "application/json"
    };
    const response = await NCOcs.ocsRequest({ url, method: "GET", headers, acceptJson: true });
    if (!response.ok){
      console.error("[NCBG] password policy fetch failed", response.errorMessage || response.status);
      L("password policy fallback", { reason: "http_error", status: response.status });
      return { ...FALLBACK_PASSWORD_POLICY };
    }
    const capabilities = response.data?.ocs?.data?.capabilities || {};
    const policyRaw = capabilities.password_policy || capabilities.passwordPolicy || null;
    if (!policyRaw || typeof policyRaw !== "object"){
      L("password policy fallback", { reason: "policy_missing" });
      return { ...FALLBACK_PASSWORD_POLICY };
    }
    const normalized = normalizePasswordPolicy(policyRaw, baseUrl);
    L("password policy fetched", {
      hasPolicy: normalized.hasPolicy,
      minLength: normalized.minLength,
      apiGenerateUrl: normalized.apiGenerateUrl || ""
    });
    return normalized;
  }catch(err){
    console.error("[NCBG] password policy fetch error", err);
    L("password policy fallback", { reason: "exception" });
    return { ...FALLBACK_PASSWORD_POLICY };
  }
}

/**
 * Request a generated password via the Nextcloud policy API.
 * @param {object} policy
 * @returns {Promise<{ok:boolean,password?:string,error?:string}>}
 */
async function generatePasswordViaPolicy(policy){
  try{
    const { baseUrl, user, appPass } = await NCCore.getOpts();
    if (!baseUrl || !user || !appPass){
      console.error("[NCBG] password generate missing credentials");
      return { ok: false, error: "credentials_missing" };
    }
    if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
      const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
      if (!ok){
        console.error("[NCBG] password generate host permission missing", baseUrl);
        return { ok: false, error: "permission_missing" };
      }
    }
    const apiUrl = resolvePolicyUrl(policy?.apiGenerateUrl, baseUrl);
    if (!apiUrl){
      return { ok: false, error: "generate_url_missing" };
    }
    L("password generate request", { apiGenerateUrl: apiUrl });
    const headers = {
      "OCS-APIRequest": "true",
      "Authorization": NCOcs.buildAuthHeader(user, appPass),
      "Accept": "application/json"
    };
    const response = await NCOcs.ocsRequest({ url: apiUrl, method: "GET", headers, acceptJson: true });
    if (!response.ok){
      console.error("[NCBG] password generate failed", response.errorMessage || response.status);
      return { ok: false, error: response.errorMessage || "http_error" };
    }
    const password = response.data?.ocs?.data?.password;
    if (!password){
      console.error("[NCBG] password generate missing password field");
      return { ok: false, error: "password_missing" };
    }
    const generated = String(password);
    L("password generate success", { length: generated.length });
    return { ok: true, password: generated };
  }catch(err){
    console.error("[NCBG] password generate error", err);
    return { ok: false, error: err?.message || String(err) };
  }
}

