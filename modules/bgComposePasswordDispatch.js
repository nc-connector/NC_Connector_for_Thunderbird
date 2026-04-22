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
const PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS = 20000;
const PASSWORD_MAIL_COMPOSE_READY_RETRY_DELAYS_MS = [0, 150, 300, 500, 800, 1200];

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
    const groups = [dispatch?.to];
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
 * Normalize a mailbox address to a stable lowercase email.
 * @param {string} value
 * @returns {string}
 */
function normalizeMailboxEmail(value){
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

/**
 * Parse the sender mailbox of one compose `from` string.
 * @param {string} value
 * @returns {Promise<string>}
 */
async function extractComposeMailboxEmail(value){
  const raw = String(value || "").trim();
  if (!raw){
    return "";
  }
  const messengerUtilities = browser?.messengerUtilities;
  if (messengerUtilities && typeof messengerUtilities.parseMailboxString === "function"){
    try{
      const parsed = await messengerUtilities.parseMailboxString(raw);
      if (Array.isArray(parsed) && parsed.length){
        return normalizeMailboxEmail(parsed[0]?.email || "");
      }
    }catch(error){
      console.error("[NCBG] compose sender mailbox parse failed", {
        value: raw.slice(0, 160),
        error: error?.message || String(error)
      });
    }
  }
  const fallbackMatch = raw.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  return fallbackMatch ? normalizeMailboxEmail(fallbackMatch[1]) : "";
}

/**
 * Normalize one Thunderbird identity object.
 * @param {object} identity
 * @param {string} accountId
 * @returns {{id:string,email:string,accountId:string,name:string,label:string}|null}
 */
function normalizeComposeIdentityRecord(identity, accountId = ""){
  if (!identity || typeof identity !== "object"){
    return null;
  }
  const id = String(identity.id || "").trim();
  const email = normalizeMailboxEmail(identity.email || "");
  if (!id || !email){
    return null;
  }
  return {
    id,
    email,
    accountId: String(identity.accountId || accountId || "").trim(),
    name: String(identity.name || "").trim(),
    label: String(identity.label || "").trim()
  };
}

/**
 * List all readable Thunderbird sender identities for sender resolution.
 * @returns {Promise<Array<{id:string,email:string,accountId:string,name:string,label:string}>>}
 */
async function listComposeSenderIdentityRecords(){
  const identityApi = browser?.identities;
  if (identityApi && typeof identityApi.list === "function"){
    try{
      const identities = await identityApi.list();
      return (Array.isArray(identities) ? identities : [])
        .map((identity) => normalizeComposeIdentityRecord(identity))
        .filter(Boolean);
    }catch(error){
      console.error("[NCBG] identities.list failed", {
        error: error?.message || String(error)
      });
    }
  }
  const accountApi = browser?.accounts;
  if (accountApi && typeof accountApi.list === "function"){
    try{
      const accounts = await accountApi.list(false);
      const identities = [];
      for (const account of Array.isArray(accounts) ? accounts : []){
        for (const identity of Array.isArray(account?.identities) ? account.identities : []){
          const normalized = normalizeComposeIdentityRecord(identity, String(account?.id || "").trim());
          if (normalized){
            identities.push(normalized);
          }
        }
      }
      return identities;
    }catch(error){
      console.error("[NCBG] accounts.list failed", {
        error: error?.message || String(error)
      });
    }
  }
  return [];
}

/**
 * Ensure one dispatch has a real Thunderbird identity id for auto-send.
 * @param {object} dispatch
 * @returns {Promise<{identityId:string,fromEmail:string,reason:string,matchCount:number}>}
 */
async function ensureSeparatePasswordDispatchIdentity(dispatch){
  const currentIdentityId = String(dispatch?.identityId || "").trim();
  if (currentIdentityId){
    if (!dispatch.fromEmail){
      dispatch.fromEmail = await extractComposeMailboxEmail(dispatch?.from || "");
    }
    return {
      identityId: currentIdentityId,
      fromEmail: String(dispatch?.fromEmail || "").trim(),
      reason: "identity_present",
      matchCount: 1
    };
  }
  const from = String(dispatch?.from || "").trim();
  if (!from){
    return {
      identityId: "",
      fromEmail: "",
      reason: "from_missing",
      matchCount: 0
    };
  }
  const fromEmail = String(dispatch?.fromEmail || "").trim().toLowerCase()
    || await extractComposeMailboxEmail(from);
  dispatch.fromEmail = fromEmail;
  if (!fromEmail){
    return {
      identityId: "",
      fromEmail: "",
      reason: "sender_email_missing",
      matchCount: 0
    };
  }
  const identities = await listComposeSenderIdentityRecords();
  const matches = identities.filter((identity) => identity.email === fromEmail);
  if (matches.length === 1){
    dispatch.identityId = matches[0].id;
    return {
      identityId: dispatch.identityId,
      fromEmail,
      reason: "resolved_from_sender_email",
      matchCount: 1
    };
  }
  return {
    identityId: "",
    fromEmail,
    reason: matches.length > 1 ? "identity_ambiguous" : "identity_not_found",
    matchCount: matches.length
  };
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
 * Render top/bottom hash separators for password follow-up plain text.
 * Border width is fixed to 50 hash characters.
 * @param {string} plainText
 * @returns {string}
 */
function framePasswordDispatchPlainTextBlock(plainText){
  const lines = String(plainText || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const border = "#".repeat(50);
  return [border, ...lines, border].join("\n");
}

/**
 * Build plain text from a password-dispatch HTML block.
 * @param {string} sourceHtml
 * @returns {string}
 */
function buildPasswordDispatchPlainText(sourceHtml){
  if (typeof NCHtmlSanitizer?.htmlToPlainText !== "function"){
    throw new Error("sharing_template_plaintext_converter_unavailable");
  }
  const plainText = String(NCHtmlSanitizer.htmlToPlainText(String(sourceHtml || "")) || "").trim();
  if (!plainText){
    throw new Error("sharing_password_dispatch_plaintext_empty");
  }
  return framePasswordDispatchPlainTextBlock(plainText);
}

/**
 * Resolve whether follow-up password mail should use plain text or HTML.
 * @param {object} details
 * @returns {{isPlainText:boolean,reason:string,deliveryFormat:string}}
 */
function resolvePasswordDispatchComposeMode(details = {}){
  const editorIsPlainText = details?.isPlainText === true;
  const deliveryFormat = typeof details?.deliveryFormat === "string"
    ? details.deliveryFormat.trim().toLowerCase()
    : "";
  if (editorIsPlainText){
    return {
      isPlainText: true,
      reason: "compose_plaintext_mode",
      deliveryFormat
    };
  }
  if (deliveryFormat === "plaintext"){
    return {
      isPlainText: true,
      reason: "delivery_format_plaintext",
      deliveryFormat
    };
  }
  return {
    isPlainText: false,
    reason: "compose_html_mode",
    deliveryFormat
  };
}

/**
 * Build compose body fields for separate password dispatch.
 * Mirrors the source compose mode when possible.
 * @param {object} dispatch
 * @returns {{isPlainText:boolean,body?:string,plainTextBody?:string}}
 */
function buildSeparatePasswordMailBodyFields(dispatch){
  if (dispatch?.isPlainText === true){
    const plainTextBody = String(dispatch?.plainText || "").trim();
    if (plainTextBody){
      return {
        isPlainText: true,
        plainTextBody
      };
    }
  }
  return {
    isPlainText: false,
    body: String(dispatch?.html || "")
  };
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
  const rawHtml = String(payload.html || "").trim();
  if (!password || !rawHtml){
    throw new Error("password_or_html_missing");
  }
  const html = rawHtml;
  const plainText = buildPasswordDispatchPlainText(html);
  const dispatch = {
    tabId,
    shareLabel: String(payload.shareLabel || "").trim(),
    shareUrl: String(payload.shareUrl || "").trim(),
    shareId: String(payload.shareId || "").trim(),
    folderInfo: normalizeComposeShareCleanupFolderInfo(payload.folderInfo) || null,
    password,
    html,
    plainText,
    isPlainText: false,
    composeModeReason: "compose_html_mode",
    deliveryFormat: "",
    to: [],
    cc: [],
    bcc: [],
    identityId: "",
    from: "",
    fromEmail: "",
    created: Date.now()
  };
  try{
    const composeDetails = await browser.compose.getComposeDetails(tabId);
    const composeMode = resolvePasswordDispatchComposeMode(composeDetails);
    dispatch.isPlainText = composeMode.isPlainText;
    dispatch.composeModeReason = composeMode.reason;
    dispatch.deliveryFormat = composeMode.deliveryFormat;
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
    await ensureSeparatePasswordDispatchIdentity(dispatch);
  }catch(error){
    console.error("[NCBG] sharing separate password dispatch compose details unavailable", {
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
    hasFromEmail: !!dispatch.fromEmail,
    composeMode: dispatch.isPlainText ? "plain" : "html",
    composeModeReason: dispatch.composeModeReason || "",
    deliveryFormat: dispatch.deliveryFormat || "",
    composeModeSource: "registration_snapshot",
    to: dispatch.to.length,
    cc: dispatch.cc.length,
    bcc: dispatch.bcc.length
  });
}

/**
 * Capture the final sender/recipient envelope from compose.onBeforeSend.
 * The password follow-up itself targets only `To`, but `Cc`/`Bcc` are still
 * recorded here as the authoritative primary-mail recipient state.
 * @param {number} tabId
 * @param {object} details
 * @returns {Promise<void>}
 */
async function captureSeparatePasswordDispatchRecipients(tabId, details = {}){
  const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
  if (!Array.isArray(queue) || !queue.length){
    return;
  }
  let composeModeSource = "registration_snapshot";
  let composeMode = null;
  if (typeof details?.isPlainText === "boolean" || typeof details?.deliveryFormat === "string"){
    composeMode = resolvePasswordDispatchComposeMode(details);
    composeModeSource = "on_before_send_details";
  }else{
    try{
      const composeDetails = await browser.compose.getComposeDetails(tabId);
      if (typeof composeDetails?.isPlainText === "boolean" || typeof composeDetails?.deliveryFormat === "string"){
        composeMode = resolvePasswordDispatchComposeMode(composeDetails);
        composeModeSource = "compose_details_fallback";
      }else{
        composeModeSource = "compose_mode_missing";
      }
    }catch(error){
      composeModeSource = "compose_mode_fallback_failed";
      L("sharing separate password compose mode fallback unavailable", {
        tabId,
        error: error?.message || String(error)
      });
    }
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
    if (composeMode){
      dispatch.isPlainText = composeMode.isPlainText;
      dispatch.composeModeReason = composeMode.reason;
      dispatch.deliveryFormat = composeMode.deliveryFormat;
    }
  }
  const identityResolution = await ensureSeparatePasswordDispatchIdentity(queue[0]);
  for (const dispatch of queue){
    if (!dispatch.identityId && identityResolution.identityId){
      dispatch.identityId = identityResolution.identityId;
    }
    if (!dispatch.fromEmail && identityResolution.fromEmail){
      dispatch.fromEmail = identityResolution.fromEmail;
    }
  }
  L("sharing separate password recipients captured", {
    tabId,
    queued: queue.length,
    to: to.length,
    cc: cc.length,
    bcc: bcc.length,
    hasIdentityId: queue.some((dispatch) => !!String(dispatch?.identityId || "").trim()),
    hasFrom: !!from,
    hasFromEmail: queue.some((dispatch) => !!String(dispatch?.fromEmail || "").trim()),
    composeMode: queue.some((dispatch) => dispatch?.isPlainText === true) ? "plain" : "html",
    composeModeReason: String(queue[0]?.composeModeReason || ""),
    deliveryFormat: String(queue[0]?.deliveryFormat || ""),
    composeModeSource,
    firstToType: typeof to[0] === "string" ? "string" : (to[0]?.type || "")
  });
}

/**
 * Track live sender identity changes before the final onBeforeSend capture.
 * This keeps queued password-follow-up drafts closer to the current compose
 * sender state, while onBeforeSend remains the authoritative final source.
 * @param {number} tabId
 * @param {string} identityId
 * @returns {Promise<void>}
 */
async function captureSeparatePasswordDispatchIdentityChange(tabId, identityId = ""){
  const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
  if (!Array.isArray(queue) || !queue.length){
    return;
  }
  const normalizedIdentityId = String(identityId || "").trim();
  if (normalizedIdentityId){
    for (const dispatch of queue){
      dispatch.identityId = normalizedIdentityId;
    }
  }
  await enrichSeparatePasswordDispatchSourceIdentity(tabId, queue);
  L("sharing separate password identity changed", {
    tabId,
    identityIdChanged: !!normalizedIdentityId,
    hasIdentityId: queue.some((dispatch) => !!String(dispatch?.identityId || "").trim()),
    hasFrom: queue.some((dispatch) => !!String(dispatch?.from || "").trim()),
    hasFromEmail: queue.some((dispatch) => !!String(dispatch?.fromEmail || "").trim())
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
    const identityResolution = await ensureSeparatePasswordDispatchIdentity(queue[0]);
    for (const dispatch of queue){
      if (!dispatch.identityId && identityResolution.identityId){
        dispatch.identityId = identityResolution.identityId;
      }
      if (!dispatch.fromEmail && identityResolution.fromEmail){
        dispatch.fromEmail = identityResolution.fromEmail;
      }
    }
    L("sharing separate password source identity enriched", {
      tabId,
      hasIdentityId: queue.some((dispatch) => !!String(dispatch?.identityId || "").trim()),
      hasFrom: queue.some((dispatch) => !!String(dispatch?.from || "").trim()),
      hasFromEmail: queue.some((dispatch) => !!String(dispatch?.fromEmail || "").trim())
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
      requireSenderSelection,
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
  }
}

/**
 * Open a manual password-mail compose fallback.
 * The follow-up targets only the original `To` recipients. When source
 * identity resolution failed, sender selection stays manual.
 * @param {number} sourceTabId
 * @param {object} dispatch
 * @param {number} failedComposeTabId
 * @param {string} reason
 * @returns {Promise<number>}
 */
async function openManualPasswordComposeFallback(sourceTabId, dispatch, failedComposeTabId, reason){
  const bodyFields = buildSeparatePasswordMailBodyFields(dispatch);
  const manualComposeDetails = {
    to: dispatch.to,
    subject: buildSeparatePasswordMailSubject(dispatch),
    ...bodyFields
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
    composeMode: bodyFields.isPlainText ? "plain" : "html",
    composeModeReason: String(dispatch?.composeModeReason || ""),
    deliveryFormat: String(dispatch?.deliveryFormat || ""),
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
 * Warm a freshly opened compose tab before auto-send.
 * Thunderbird can return from beginNew() before the compose window is fully
 * ready to send. We therefore poll compose details until the expected sender /
 * recipient envelope is visible, then wait one short additional settle tick.
 * @param {number} composeTabId
 * @param {{identityId?:string,to?:Array<any>,subject?:string}} expected
 * @returns {Promise<void>}
 */
async function waitForComposeAutoSendReady(composeTabId, expected = {}){
  const expectedIdentityId = String(expected?.identityId || "").trim();
  const expectedSubject = String(expected?.subject || "").trim();
  const expectedToCount = normalizeComposeRecipientList(expected?.to).length;
  let lastProbe = null;
  let lastError = null;
  for (let attempt = 0; attempt < PASSWORD_MAIL_COMPOSE_READY_RETRY_DELAYS_MS.length; attempt++){
    const delayMs = PASSWORD_MAIL_COMPOSE_READY_RETRY_DELAYS_MS[attempt];
    if (delayMs > 0){
      await waitMs(delayMs);
    }
    try{
      const details = await browser.compose.getComposeDetails(composeTabId);
      const actualIdentityId = String(details?.identityId || "").trim();
      const actualSubject = String(details?.subject || "").trim();
      const actualTo = normalizeComposeRecipientList(details?.to);
      const readyIdentity = !expectedIdentityId || actualIdentityId === expectedIdentityId;
      const readySubject = !expectedSubject || actualSubject === expectedSubject;
      const readyRecipients = !expectedToCount || actualTo.length >= expectedToCount;
      lastProbe = {
        attempt: attempt + 1,
        identityId: actualIdentityId,
        subject: actualSubject,
        toCount: actualTo.length
      };
      if (readyIdentity && readySubject && readyRecipients){
        await waitMs(250);
        L("sharing separate password compose ready", {
          composeTabId,
          attempt: attempt + 1,
          to: actualTo.length,
          hasIdentityId: !!actualIdentityId,
          subjectLength: actualSubject.length
        });
        return;
      }
      L("sharing separate password compose not ready yet", {
        composeTabId,
        attempt: attempt + 1,
        expectedTo: expectedToCount,
        actualTo: actualTo.length,
        expectedIdentityId: !!expectedIdentityId,
        actualIdentityId: !!actualIdentityId,
        expectedSubjectLength: expectedSubject.length,
        actualSubjectLength: actualSubject.length
      });
    }catch(error){
      lastError = error;
      L("sharing separate password compose readiness probe failed", {
        composeTabId,
        attempt: attempt + 1,
        error: error?.message || String(error)
      });
    }
  }
  console.error("[NCBG] sharing separate password compose readiness timed out", {
    composeTabId,
    lastProbe,
    error: lastError?.message || ""
  });
}

/**
 * Manual password fallback compose tabs must not arm share cleanup.
 * The primary mail was already sent at this point, so deleting the share later
 * would break a committed user-visible link.
 * @param {number} sourceTabId
 * @param {number} manualComposeTabId
 * @param {object} dispatch
 * @returns {Promise<void>}
 */
async function armManualPasswordFallbackCleanup(sourceTabId, manualComposeTabId, dispatch){
  if (!Number.isInteger(manualComposeTabId) || manualComposeTabId <= 0){
    return;
  }
  L("sharing separate password manual cleanup skipped", {
    sourceTabId,
    manualComposeTabId,
    relativeFolder: String(dispatch?.folderInfo?.relativeFolder || "").trim(),
    shareId: String(dispatch?.shareId || "").trim(),
    shareLabel: String(dispatch?.shareLabel || "").trim(),
    reason: "primary_mail_already_sent"
  });
}

/**
 * Keep the share when password-only dispatch fails after the primary mail was sent.
 * The sent message already contains the link, so post-send password-dispatch
 * problems must never delete the share.
 * @param {number} sourceTabId
 * @param {object} dispatch
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function deleteShareAfterPasswordDispatchFailure(sourceTabId, dispatch, reason = ""){
  L("sharing separate password failure cleanup skipped", {
    sourceTabId,
    reason: reason || "",
    relativeFolder: String(dispatch?.folderInfo?.relativeFolder || "").trim(),
    shareId: String(dispatch?.shareId || "").trim(),
    shareLabel: String(dispatch?.shareLabel || "").trim()
  });
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
  let autoSendSkippedIdentityCount = 0;
  let manualFallbackOpenedCount = 0;
  let manualFallbackFailedCount = 0;
  let manualFallbackNeedsSenderCount = 0;
  for (const dispatch of queue){
    const identityResolution = await ensureSeparatePasswordDispatchIdentity(dispatch);
    const bodyFields = buildSeparatePasswordMailBodyFields(dispatch);
    const autoComposeDetails = {
      to: dispatch.to,
      subject: buildSeparatePasswordMailSubject(dispatch),
      ...bodyFields
    };
    if (identityResolution.identityId){
      autoComposeDetails.identityId = identityResolution.identityId;
    }
    L("sharing separate password mail send start", {
      sourceTabId: tabId,
      to: dispatch.to.length,
      hasIdentityId: !!identityResolution.identityId,
      hasFrom: !!dispatch.from,
      hasFromEmail: !!identityResolution.fromEmail,
      composeMode: bodyFields.isPlainText ? "plain" : "html",
      composeModeReason: String(dispatch?.composeModeReason || ""),
      deliveryFormat: String(dispatch?.deliveryFormat || "")
    });
    if (!identityResolution.identityId){
      autoSendSkippedIdentityCount++;
      L("sharing separate password mail auto-send skipped", {
        sourceTabId: tabId,
        reason: identityResolution.reason,
        matchCount: identityResolution.matchCount,
        hasFrom: !!dispatch.from,
        hasFromEmail: !!identityResolution.fromEmail,
        to: dispatch.to.length
      });
      try{
        const manualComposeTabId = await openManualPasswordComposeFallback(tabId, dispatch, 0, identityResolution.reason);
        await armManualPasswordFallbackCleanup(tabId, manualComposeTabId, dispatch);
        manualFallbackOpenedCount++;
        manualFallbackNeedsSenderCount++;
      }catch(fallbackError){
        manualFallbackFailedCount++;
        console.error("[NCBG] sharing separate password mail manual fallback failed", {
          sourceTabId: tabId,
          failedComposeTabId: 0,
          error: fallbackError?.message || String(fallbackError)
        });
        await deleteShareAfterPasswordDispatchFailure(tabId, dispatch, "identity_unresolved_manual_fallback_open_failed");
      }
      continue;
    }
    let composeTabId = 0;
    try{
      const composeTab = await browser.compose.beginNew(autoComposeDetails);
      composeTabId = Number(composeTab?.id);
      if (!Number.isInteger(composeTabId) || composeTabId <= 0){
        throw new Error("password_mail_compose_tab_invalid");
      }
      await waitForComposeAutoSendReady(composeTabId, {
        identityId: identityResolution.identityId,
        to: dispatch.to,
        subject: autoComposeDetails.subject
      });
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
        }
      }
      try{
        const manualComposeTabId = await openManualPasswordComposeFallback(tabId, dispatch, composeTabId, "auto_send_failed");
        await armManualPasswordFallbackCleanup(tabId, manualComposeTabId, dispatch);
        manualFallbackOpenedCount++;
        if (!String(dispatch?.identityId || "").trim()){
          manualFallbackNeedsSenderCount++;
        }
      }catch(fallbackError){
        manualFallbackFailedCount++;
        console.error("[NCBG] sharing separate password mail manual fallback failed", {
          sourceTabId: tabId,
          failedComposeTabId: composeTabId,
          error: fallbackError?.message || String(fallbackError)
        });
        await deleteShareAfterPasswordDispatchFailure(tabId, dispatch, "manual_fallback_open_failed");
      }
    }
  }
  if (autoSendFailedCount === 0 && autoSendSkippedIdentityCount === 0){
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
    autoSendSkippedIdentityCount,
    manualFallbackOpenedCount,
    manualFallbackFailedCount,
    manualFallbackNeedsSenderCount
  });
  if (autoSendFailedCount > 0){
    await showPasswordMailFailureNotification(recipientCount);
  }
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
      return { ...FALLBACK_PASSWORD_POLICY };
    }
    if (typeof NCHostPermissions !== "undefined" && NCHostPermissions?.hasOriginPermission){
      const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
      if (!ok){
        console.error("[NCBG] password policy host permission missing", baseUrl);
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

