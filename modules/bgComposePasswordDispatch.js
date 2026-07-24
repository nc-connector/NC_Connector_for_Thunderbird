/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Compose password-dispatch runtime module.
 * Owns recipient capture and follow-up password mails.
 */
const PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS = 20000;
const PASSWORD_MAIL_COMPOSE_READY_RETRY_DELAYS_MS = [0, 150, 300, 500, 800, 1200];
const PASSWORD_MAIL_RECOVERY_RETRY_DELAYS_MS = [2000, 5000, 10000];
const PASSWORD_MAIL_DISPATCH_CLEAR_TIMER_BY_TAB = new Map();
const PASSWORD_MAIL_RECOVERY_BY_SOURCE_TAB = new Map();

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

function composeRecipientKey(recipient){
  if (typeof recipient === "string"){
    const value = recipient.trim().toLowerCase();
    return value ? `addr:${value}` : "";
  }
  if (!recipient || typeof recipient !== "object"){
    return "";
  }
  const type = String(recipient.type || "").trim().toLowerCase();
  const id = String(recipient.id || "").trim();
  const nodeId = String(recipient.nodeId || "").trim();
  if (type && id){
    return `${type}:id:${id}`;
  }
  if (type && nodeId){
    return `${type}:node:${nodeId}`;
  }
  return "";
}

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

function passwordDispatchRegistrationKey(dispatch){
  const shareId = String(dispatch?.shareId || "").trim();
  const shareUrl = String(dispatch?.shareUrl || "").trim();
  if (shareId || shareUrl){
    return `share:${shareUrl}|${shareId}`;
  }
  const relativeFolder = String(dispatch?.folderInfo?.relativeFolder || "").trim();
  return relativeFolder ? `folder:${relativeFolder}` : "";
}

function createPasswordDispatchRegistrationId(){
  return createSecureRuntimeId();
}

function normalizeMailboxEmail(value){
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

function collectParsedMailboxEmails(parsed, target = []){
  for (const mailbox of Array.isArray(parsed) ? parsed : []){
    const email = normalizeMailboxEmail(mailbox?.email || "");
    if (email){
      target.push(email);
    }
    if (Array.isArray(mailbox?.group)){
      collectParsedMailboxEmails(mailbox.group, target);
    }
  }
  return target;
}

async function parseComposeMailboxEmails(value){
  const raw = String(value || "").trim();
  if (!raw){
    return [];
  }
  const messengerUtilities = browser?.messengerUtilities;
  if (!messengerUtilities || typeof messengerUtilities.parseMailboxString !== "function"){
    throw new Error("messenger_utilities_mailbox_parser_unavailable");
  }
  const parsed = await messengerUtilities.parseMailboxString(raw);
  return collectParsedMailboxEmails(parsed);
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
  try{
    const emails = await parseComposeMailboxEmails(raw);
    if (emails.length){
      return emails[0];
    }
  }catch(error){
    console.error("[NCBG] compose sender mailbox parse failed", {
      value: raw.slice(0, 160),
      error: error?.message || String(error)
    });
  }
  return "";
}

async function buildComposeRecipientValueSet(value){
  const recipients = normalizeComposeRecipientList(value);
  const keys = new Set();
  for (const recipient of recipients){
    if (typeof recipient === "string"){
      const emails = await parseComposeMailboxEmails(recipient);
      if (!emails.length){
        throw new Error("password_mail_recipient_parse_failed");
      }
      for (const email of emails){
        keys.add(`addr:${email}`);
      }
      continue;
    }
    const key = composeRecipientKey(recipient);
    if (!key){
      throw new Error("password_mail_recipient_reference_invalid");
    }
    keys.add(key);
  }
  return keys;
}

async function buildComposeRecipientEnvelope(details = {}){
  const [to, cc, bcc] = await Promise.all([
    buildComposeRecipientValueSet(details?.to),
    buildComposeRecipientValueSet(details?.cc),
    buildComposeRecipientValueSet(details?.bcc)
  ]);
  return {
    to,
    cc,
    bcc,
    count: to.size + cc.size + bcc.size
  };
}

function composeRecipientValueSetsMatch(expected, actual){
  if (!(expected instanceof Set) || !(actual instanceof Set) || expected.size !== actual.size){
    return false;
  }
  for (const key of expected){
    if (!actual.has(key)){
      return false;
    }
  }
  return true;
}

function composeRecipientEnvelopesMatch(expected, actual){
  return composeRecipientValueSetsMatch(expected?.to, actual?.to)
    && composeRecipientValueSetsMatch(expected?.cc, actual?.cc)
    && composeRecipientValueSetsMatch(expected?.bcc, actual?.bcc);
}

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

function finalizePasswordDispatchPlainText(plainText){
  const normalized = String(plainText || "").trim();
  if (!normalized){
    throw new Error("sharing_password_dispatch_plaintext_empty");
  }
  return framePasswordDispatchPlainTextBlock(normalized);
}

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

function addManualPasswordMailNotice(bodyFields, reason){
  if (!["primary_send_later", "primary_saved_draft"].includes(reason)){
    return bodyFields;
  }
  const noticeKey = reason === "primary_saved_draft"
    ? "sharing_password_mail_saved_draft_notice"
    : "sharing_password_mail_send_later_notice";
  const notice = bgI18n(noticeKey);
  if (bodyFields?.isPlainText === true){
    return {
      isPlainText: true,
      plainTextBody: `${notice}\n\n${String(bodyFields.plainTextBody || "")}`
    };
  }
  return {
    isPlainText: false,
    body: `<p><strong>${NCTalkTextUtils.escapeHtml(notice)}</strong></p>${String(bodyFields?.body || "")}`
  };
}

function normalizePasswordMailSendMode(value){
  return String(value || "").trim() === "sendLater" ? "sendLater" : "sendNow";
}

/**
 * Register a pending password-only follow-up mail for one compose tab.
 * Recipients are captured from compose.onBeforeSend for the final send action.
 * Initial compose details are captured immediately to preserve identity context.
 * @param {number} tabId
 * @param {{shareLabel?:string,shareUrl?:string,shareId?:string,folderInfo?:object,password?:string,deliveryMode?:string,secretsExpireDays?:number,renderShareInfo?:object,policyShare?:object,policyEditableShare?:object,html?:string,plainText?:string}} payload
 */
async function registerSeparatePasswordMailDispatch(tabId, payload = {}, options = {}){
  if (!Number.isInteger(tabId) || tabId <= 0){
    throw new Error("invalid_tab_id");
  }
  const policyStatus = options.policyStatus
    || await NCPolicyRuntime.getPolicyStatus();
  if (!NCPolicyState.hasSeatEntitlement(policyStatus)){
    L("sharing separate password dispatch blocked", {
      tabId,
      endpointAvailable: !!policyStatus?.endpointAvailable,
      seatAssigned: !!policyStatus?.status?.seatAssigned,
      seatState: String(policyStatus?.status?.seatState || ""),
      isValid: policyStatus?.status?.isValid === true,
      overlicensed: policyStatus?.status?.overlicensed === true
    });
    throw new Error(bgI18n("sharing_error_insert_failed"));
  }
  cancelSeparatePasswordDispatchClear(tabId, "register");
  const password = String(payload.password || "").trim();
  const rawHtml = String(payload.html || "").trim();
  const rawPlainText = String(payload.plainText || "").trim();
  const deliveryMode = NCSharePasswordDelivery.coerceMode(payload.deliveryMode, NCSharePasswordDelivery.MODE_PLAIN);
  if (!password || !rawHtml || !rawPlainText){
    throw new Error("password_or_html_or_plaintext_missing");
  }
  const html = rawHtml;
  const plainText = finalizePasswordDispatchPlainText(rawPlainText);
  const dispatch = {
    tabId,
    shareLabel: String(payload.shareLabel || "").trim(),
    shareUrl: String(payload.shareUrl || "").trim(),
    shareId: String(payload.shareId || "").trim(),
    folderInfo: normalizeComposeShareCleanupFolderInfo(payload.folderInfo) || null,
    password,
    deliveryMode,
    secretsExpireDays: NCSharePasswordDelivery.clampSecretsExpireDays(payload.secretsExpireDays),
    renderShareInfo: payload?.renderShareInfo && typeof payload.renderShareInfo === "object"
      ? payload.renderShareInfo
      : null,
    policyShare: payload?.policyShare && typeof payload.policyShare === "object"
      ? payload.policyShare
      : null,
    policyEditableShare: payload?.policyEditableShare && typeof payload.policyEditableShare === "object"
      ? payload.policyEditableShare
      : null,
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
  dispatch.dedupKey = passwordDispatchRegistrationKey(dispatch);
  if (!dispatch.dedupKey){
    throw new Error("password_dispatch_dedup_key_missing");
  }
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
    const duplicate = queue.find((entry) => {
      return String(entry?.dedupKey || passwordDispatchRegistrationKey(entry)).trim()
        === dispatch.dedupKey;
    });
    if (duplicate){
      L("sharing separate password dispatch registration skipped", {
        tabId,
        reason: "share_already_registered",
        dedupKey: dispatch.dedupKey
      });
      return {
        registrationId: String(duplicate.registrationId || "").trim(),
        duplicate: true
      };
    }
  }
  do{
    dispatch.registrationId = createPasswordDispatchRegistrationId();
  }while ((queue || []).some((entry) => entry?.registrationId === dispatch.registrationId));
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
    deliveryMode: dispatch.deliveryMode,
    secretsExpireDays: dispatch.secretsExpireDays,
    composeMode: dispatch.isPlainText ? "plain" : "html",
    composeModeReason: dispatch.composeModeReason || "",
    deliveryFormat: dispatch.deliveryFormat || "",
    composeModeSource: "registration_snapshot",
    to: dispatch.to.length,
    cc: dispatch.cc.length,
    bcc: dispatch.bcc.length
  });
  return {
    registrationId: dispatch.registrationId,
    duplicate: false
  };
}

function unregisterSeparatePasswordMailDispatch(tabId, registrationId, reason = ""){
  const normalizedTabId = Number(tabId);
  const normalizedRegistrationId = String(registrationId || "").trim();
  if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0 || !normalizedRegistrationId){
    return false;
  }
  const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(normalizedTabId);
  if (!Array.isArray(queue) || !queue.length){
    return false;
  }
  const remaining = queue.filter((dispatch) => {
    return String(dispatch?.registrationId || "").trim() !== normalizedRegistrationId;
  });
  const removed = queue.length - remaining.length;
  if (remaining.length){
    PASSWORD_MAIL_DISPATCH_BY_TAB.set(normalizedTabId, remaining);
  }else{
    PASSWORD_MAIL_DISPATCH_BY_TAB.delete(normalizedTabId);
  }
  L("sharing separate password dispatch unregistered", {
    tabId: normalizedTabId,
    registrationId: normalizedRegistrationId,
    reason: String(reason || ""),
    removed,
    queued: remaining.length
  });
  return removed > 0;
}

/**
 * Capture the final sender/recipient envelope from compose.onBeforeSend.
 * The password follow-up reuses `To`, `Cc`, and `Bcc` from the final
 * primary-mail recipient state.
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
 * sender state, while onBeforeSend stays the final source.
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

function cancelSeparatePasswordDispatchClear(tabId, reason = ""){
  const timerId = PASSWORD_MAIL_DISPATCH_CLEAR_TIMER_BY_TAB.get(tabId);
  if (!timerId){
    return false;
  }
  PASSWORD_MAIL_DISPATCH_CLEAR_TIMER_BY_TAB.delete(tabId);
  try{
    clearTimeout(timerId);
  }catch(error){
    console.error("[NCBG] sharing separate password dispatch clear timer cancel failed", {
      tabId,
      reason: reason || "",
      error: error?.message || String(error)
    });
  }
  L("sharing separate password dispatch clear canceled", {
    tabId,
    reason: reason || ""
  });
  return true;
}

function clearSeparatePasswordDispatch(tabId, reason = ""){
  cancelSeparatePasswordDispatchClear(tabId, reason || "clear");
  if (!PASSWORD_MAIL_DISPATCH_BY_TAB.has(tabId)){
    return;
  }
  PASSWORD_MAIL_DISPATCH_BY_TAB.delete(tabId);
  L("sharing separate password dispatch cleared", {
    tabId,
    reason: reason || ""
  });
}

function takeSeparatePasswordDispatch(tabId, reason = ""){
  cancelSeparatePasswordDispatchClear(tabId, reason || "take");
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
 * Delay password-dispatch clearing while Thunderbird finishes send callbacks.
 * @param {number} tabId
 * @param {string} reason
 * @param {number} delayMs
 * @returns {boolean}
 */
function scheduleSeparatePasswordDispatchClear(tabId, reason = "", delayMs = 0){
  const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
  if (!Array.isArray(queue) || !queue.length){
    return false;
  }
  cancelSeparatePasswordDispatchClear(tabId, reason || "reschedule");
  const safeDelay = Math.max(0, Number(delayMs) || 0);
  if (safeDelay === 0){
    clearSeparatePasswordDispatch(tabId, reason || "clear_now");
    return true;
  }
  const timerId = setTimeout(() => {
    PASSWORD_MAIL_DISPATCH_CLEAR_TIMER_BY_TAB.delete(tabId);
    clearSeparatePasswordDispatch(tabId, reason || "delayed_clear");
  }, safeDelay);
  PASSWORD_MAIL_DISPATCH_CLEAR_TIMER_BY_TAB.set(tabId, timerId);
  L("sharing separate password dispatch clear scheduled", {
    tabId,
    delayMs: safeDelay,
    reason: reason || "",
    queued: queue.length
  });
  return true;
}

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

async function showPasswordMailManualRequiredNotification(recipientCount, options = {}){
  const count = Math.max(0, Number(recipientCount) || 0);
  const requireSenderSelection = !!options?.requireSenderSelection;
  const primarySendLater = options?.primarySendLater === true;
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
    const messageKey = primarySendLater
      ? "sharing_password_mail_notify_send_later_manual_required"
      : (requireSenderSelection
        ? "sharing_password_mail_notify_manual_required_select_sender"
        : "sharing_password_mail_notify_manual_required");
    await browser.notifications.create(notificationId, {
      type: "basic",
      title: bgI18n("sharing_password_mail_notify_title"),
      message: bgI18n(messageKey, [String(count)]),
      iconUrl: browser.runtime.getURL("icons/app-32.png")
    });
    L("sharing separate password manual-required notification shown", {
      notificationId,
      recipients: count,
      requireSenderSelection,
      primarySendLater
    });
  }catch(error){
    console.error("[NCBG] sharing separate password manual-required notification failed", {
      recipients: count,
      requireSenderSelection,
      primarySendLater,
      error: error?.message || String(error)
    });
  }
}

async function showPasswordMailPendingNotification(recipientCount){
  const count = Math.max(0, Number(recipientCount) || 0);
  if (count <= 0){
    return;
  }
  if (typeof browser?.notifications?.create !== "function"){
    L("sharing separate password pending notification skipped", {
      reason: "notifications_api_missing",
      recipients: count
    });
    return;
  }
  try{
    const notificationId = `nc-password-mail-pending-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await browser.notifications.create(notificationId, {
      type: "basic",
      title: bgI18n("sharing_password_mail_notify_title"),
      message: bgI18n("sharing_password_mail_notify_send_pending", [String(count)]),
      iconUrl: browser.runtime.getURL("icons/app-32.png")
    });
    L("sharing separate password pending notification shown", {
      notificationId,
      recipients: count
    });
  }catch(error){
    console.error("[NCBG] sharing separate password pending notification failed", {
      recipients: count,
      error: error?.message || String(error)
    });
  }
}

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
 * The follow-up preserves the original `To`/`Cc`/`Bcc` envelope. When source
 * identity resolution failed, sender selection stays manual.
 * @param {number} sourceTabId
 * @param {object} dispatch
 * @param {number} failedComposeTabId
 * @param {string} reason
 * @returns {Promise<number>}
 */
async function openManualPasswordComposeFallback(sourceTabId, dispatch, failedComposeTabId, reason){
  const bodyFields = addManualPasswordMailNotice(
    buildSeparatePasswordMailBodyFields(dispatch),
    reason
  );
  const manualComposeDetails = {
    to: dispatch.to,
    cc: dispatch.cc,
    bcc: dispatch.bcc,
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
 * Send a compose tab with timeout to fail fast on hangs
 * @param {number} composeTabId
 * @param {string} sendMode
 * @param {number} timeoutMs
 * @returns {Promise<{status:string,completion?:Promise<any>}>}
 */
async function sendComposeWithTimeout(composeTabId, sendMode = "sendNow", timeoutMs = PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS){
  let timeoutId = null;
  const normalizedSendMode = normalizePasswordMailSendMode(sendMode);
  const sendPromise = browser.compose.sendMessage(composeTabId, { mode: normalizedSendMode });
  try{
    const result = await Promise.race([
      sendPromise.then(() => ({ status: "sent" })),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ status: "pending" });
        }, Math.max(1000, Number(timeoutMs) || PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS));
      })
    ]);
    if (result.status === "sent"){
      return result;
    }
    // A timed-out send cannot be canceled or safely retried. Keep the original
    // compose tab and observe the same request instead of opening a duplicate.
    return {
      status: "pending",
      completion: sendPromise
    };
  }finally{
    if (timeoutId){
      clearTimeout(timeoutId);
    }
  }
}

async function readPasswordMailComposeState(composeTabId){
  const details = await browser.compose.getComposeDetails(composeTabId);
  return {
    identityId: String(details?.identityId || "").trim(),
    subject: String(details?.subject || "").trim(),
    recipients: await buildComposeRecipientEnvelope(details)
  };
}

function passwordMailComposeStateMatches(expected, actual){
  const identityMatches = !expected.identityId || actual.identityId === expected.identityId;
  const subjectMatches = !expected.subject || actual.subject === expected.subject;
  return identityMatches
    && subjectMatches
    && composeRecipientEnvelopesMatch(expected.recipients, actual.recipients);
}

function passwordMailComposeStateSummary(state, attempt, settled = false){
  return {
    attempt,
    settled,
    identityId: state?.identityId || "",
    subject: state?.subject || "",
    toCount: state?.recipients?.to?.size || 0,
    ccCount: state?.recipients?.cc?.size || 0,
    bccCount: state?.recipients?.bcc?.size || 0
  };
}

/**
 * Warm a freshly opened compose tab before auto-send.
 * Thunderbird can return from beginNew() before the compose window is fully
 * ready to send. Poll and compare the complete recipient envelope, then repeat
 * the same check after one short settle tick.
 * @param {number} composeTabId
 * @param {{identityId?:string,to?:Array<any>,cc?:Array<any>,bcc?:Array<any>,subject?:string}} expected
 * @returns {Promise<void>}
 */
async function waitForComposeAutoSendReady(composeTabId, expected = {}){
  const expectedState = {
    identityId: String(expected?.identityId || "").trim(),
    subject: String(expected?.subject || "").trim(),
    recipients: null
  };
  try{
    expectedState.recipients = await buildComposeRecipientEnvelope(expected);
  }catch(error){
    console.error("[NCBG] sharing separate password expected recipients invalid", {
      composeTabId,
      error: error?.message || String(error)
    });
    throw error;
  }
  if (expectedState.recipients.count <= 0){
    console.error("[NCBG] sharing separate password expected recipient envelope empty", {
      composeTabId
    });
    throw new Error("password_mail_expected_recipients_empty");
  }
  let lastProbe = null;
  let lastError = null;
  for (let attempt = 0; attempt < PASSWORD_MAIL_COMPOSE_READY_RETRY_DELAYS_MS.length; attempt++){
    const delayMs = PASSWORD_MAIL_COMPOSE_READY_RETRY_DELAYS_MS[attempt];
    if (delayMs > 0){
      await waitMs(delayMs);
    }
    try{
      let actualState = await readPasswordMailComposeState(composeTabId);
      lastProbe = passwordMailComposeStateSummary(actualState, attempt + 1);
      if (passwordMailComposeStateMatches(expectedState, actualState)){
        // getComposeDetails can expose the envelope before send commands settle.
        await waitMs(250);
        actualState = await readPasswordMailComposeState(composeTabId);
        lastProbe = passwordMailComposeStateSummary(actualState, attempt + 1, true);
        if (passwordMailComposeStateMatches(expectedState, actualState)){
          L("sharing separate password compose ready", {
            composeTabId,
            attempt: attempt + 1,
            to: actualState.recipients.to.size,
            cc: actualState.recipients.cc.size,
            bcc: actualState.recipients.bcc.size,
            hasIdentityId: !!actualState.identityId,
            subjectLength: actualState.subject.length
          });
          return;
        }
      }
      L("sharing separate password compose not ready yet", {
        composeTabId,
        attempt: attempt + 1,
        settled: !!lastProbe?.settled,
        expectedTo: expectedState.recipients.to.size,
        actualTo: actualState.recipients.to.size,
        expectedCc: expectedState.recipients.cc.size,
        actualCc: actualState.recipients.cc.size,
        expectedBcc: expectedState.recipients.bcc.size,
        actualBcc: actualState.recipients.bcc.size,
        expectedIdentityId: !!expectedState.identityId,
        actualIdentityId: !!actualState.identityId,
        expectedSubjectLength: expectedState.subject.length,
        actualSubjectLength: actualState.subject.length
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
  throw new Error("password_mail_compose_readiness_timeout");
}

/**
 * Log why the share stays after a password-only dispatch failure.
 * The sent message already contains the link.
 * @param {number} sourceTabId
 * @param {object} dispatch
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function logPasswordDispatchShareRetention(sourceTabId, dispatch, reason = ""){
  L("sharing separate password share kept after dispatch failure", {
    sourceTabId,
    reason: reason || "",
    relativeFolder: String(dispatch?.folderInfo?.relativeFolder || "").trim(),
    shareId: String(dispatch?.shareId || "").trim(),
    shareLabel: String(dispatch?.shareLabel || "").trim()
  });
}

/**
 * Open manual password drafts for every queued follow-up that was not sent.
 * @param {number} sourceTabId
 * @param {Array<object>} queue
 * @param {number} failedComposeTabId
 * @param {string} reason
 * @returns {Promise<{opened:number,failed:number,needsSender:number,openedQueue:Array<object>,failedQueue:Array<object>}>}
 */
async function openManualPasswordFallbackQueue(sourceTabId, queue, failedComposeTabId = 0, reason = ""){
  let opened = 0;
  let failed = 0;
  let needsSender = 0;
  const openedQueue = [];
  const failedQueue = [];
  for (const dispatch of Array.isArray(queue) ? queue : []){
    try{
      await openManualPasswordComposeFallback(sourceTabId, dispatch, failedComposeTabId, reason);
      opened++;
      openedQueue.push(dispatch);
      if (!String(dispatch?.identityId || "").trim()){
        needsSender++;
      }
    }catch(error){
      failed++;
      failedQueue.push(dispatch);
      console.error("[NCBG] sharing separate password mail manual fallback failed", {
        sourceTabId,
        failedComposeTabId: Number.isInteger(failedComposeTabId) ? failedComposeTabId : 0,
        reason: reason || "",
        error: error?.message || String(error)
      });
      await logPasswordDispatchShareRetention(sourceTabId, dispatch, `${reason || "manual_fallback"}_open_failed`);
    }
  }
  L("sharing separate password manual fallback queue handled", {
    sourceTabId,
    failedComposeTabId: Number.isInteger(failedComposeTabId) ? failedComposeTabId : 0,
    reason: reason || "",
    opened,
    failed,
    needsSender
  });
  return {
    opened,
    failed,
    needsSender,
    openedQueue,
    failedQueue
  };
}

function clonePasswordDispatch(dispatch){
  if (!dispatch || typeof dispatch !== "object"){
    return null;
  }
  return {
    ...dispatch,
    to: Array.isArray(dispatch.to) ? dispatch.to.slice() : [],
    cc: Array.isArray(dispatch.cc) ? dispatch.cc.slice() : [],
    bcc: Array.isArray(dispatch.bcc) ? dispatch.bcc.slice() : [],
    folderInfo: dispatch.folderInfo && typeof dispatch.folderInfo === "object" ? { ...dispatch.folderInfo } : null,
    renderShareInfo: dispatch.renderShareInfo && typeof dispatch.renderShareInfo === "object" ? { ...dispatch.renderShareInfo } : null,
    policyShare: dispatch.policyShare && typeof dispatch.policyShare === "object" ? { ...dispatch.policyShare } : null,
    policyEditableShare: dispatch.policyEditableShare && typeof dispatch.policyEditableShare === "object"
      ? { ...dispatch.policyEditableShare }
      : null
  };
}

function schedulePasswordMailRecoveryRetry(sourceTabId){
  const entry = PASSWORD_MAIL_RECOVERY_BY_SOURCE_TAB.get(sourceTabId);
  if (!entry || entry.timerId || !entry.queue.length){
    return false;
  }
  if (entry.attempt >= PASSWORD_MAIL_RECOVERY_RETRY_DELAYS_MS.length){
    return false;
  }
  const delayMs = PASSWORD_MAIL_RECOVERY_RETRY_DELAYS_MS[entry.attempt];
  entry.timerId = setTimeout(() => {
    entry.timerId = null;
    void retryPasswordMailRecoveryQueue(sourceTabId).catch((error) => {
      console.error("[NCBG] sharing separate password recovery retry failed", {
        sourceTabId,
        error: error?.message || String(error)
      });
    });
  }, delayMs);
  return true;
}

function retainPasswordMailRecoveryQueue(sourceTabId, queue, reason = ""){
  const failedQueue = (Array.isArray(queue) ? queue : [])
    .map(clonePasswordDispatch)
    .filter(Boolean);
  if (!failedQueue.length){
    return false;
  }
  const previous = PASSWORD_MAIL_RECOVERY_BY_SOURCE_TAB.get(sourceTabId);
  if (previous?.timerId){
    clearTimeout(previous.timerId);
  }
  PASSWORD_MAIL_RECOVERY_BY_SOURCE_TAB.set(sourceTabId, {
    sourceTabId,
    queue: [
      ...(Array.isArray(previous?.queue) ? previous.queue : []),
      ...failedQueue
    ],
    reason: String(reason || ""),
    attempt: Number(previous?.attempt) || 0,
    timerId: null
  });
  schedulePasswordMailRecoveryRetry(sourceTabId);
  L("sharing separate password recovery retained", {
    sourceTabId,
    failed: failedQueue.length,
    queued: PASSWORD_MAIL_RECOVERY_BY_SOURCE_TAB.get(sourceTabId).queue.length,
    reason: String(reason || "")
  });
  return true;
}

async function retryPasswordMailRecoveryQueue(sourceTabId){
  const entry = PASSWORD_MAIL_RECOVERY_BY_SOURCE_TAB.get(sourceTabId);
  if (!entry || !entry.queue.length){
    return false;
  }
  const pending = entry.queue.slice();
  const result = await openManualPasswordFallbackQueue(
    sourceTabId,
    pending,
    0,
    entry.reason || "password_recovery_retry"
  );
  if (result.openedQueue.length){
    const openedRecipients = countUniquePasswordDispatchRecipients(
      result.openedQueue
    );
    await showPasswordMailManualRequiredNotification(
      openedRecipients || result.openedQueue.length,
      {
        requireSenderSelection: result.needsSender > 0,
        primarySendLater: entry.reason === "primary_send_later"
      }
    );
  }
  if (!result.failedQueue.length){
    PASSWORD_MAIL_RECOVERY_BY_SOURCE_TAB.delete(sourceTabId);
    return true;
  }
  entry.queue = result.failedQueue.map(clonePasswordDispatch).filter(Boolean);
  entry.attempt += 1;
  if (!schedulePasswordMailRecoveryRetry(sourceTabId)){
    const failedRecipients = countUniquePasswordDispatchRecipients(entry.queue);
    await showPasswordMailFailureNotification(
      failedRecipients || entry.queue.length
    );
  }
  return false;
}

function isSecretsPasswordDispatch(dispatch){
  return NCSharePasswordDelivery.coerceMode(dispatch?.deliveryMode, NCSharePasswordDelivery.MODE_PLAIN)
    === NCSharePasswordDelivery.MODE_SECRETS;
}

async function addPerRecipientPasswordDispatches(target, source, recipients, field, seen){
  if (!Array.isArray(target) || !source || !Array.isArray(recipients) || !recipients.length){
    return 0;
  }
  let added = 0;
  for (const recipient of recipients){
    const normalizedRecipients = typeof recipient === "string"
      ? await parseComposeMailboxEmails(recipient)
      : [recipient];
    for (const normalizedRecipient of normalizedRecipients){
      const key = composeRecipientKey(normalizedRecipient);
      if (!key || seen.has(key)){
        continue;
      }
      seen.add(key);
      const clone = clonePasswordDispatch(source);
      clone.to = field === "to" ? [normalizedRecipient] : [];
      clone.cc = field === "cc" ? [normalizedRecipient] : [];
      clone.bcc = field === "bcc" ? [normalizedRecipient] : [];
      target.push(clone);
      added++;
    }
  }
  return added;
}

async function dedupePasswordDispatchRecipients(dispatch){
  const normalized = clonePasswordDispatch(dispatch);
  if (!normalized){
    return null;
  }
  const seen = new Set();
  for (const field of ["to", "cc", "bcc"]){
    const deduped = [];
    for (const recipient of normalizeComposeRecipientList(normalized[field])){
      const values = typeof recipient === "string"
        ? await parseComposeMailboxEmails(recipient)
        : [recipient];
      for (const value of values){
        const key = composeRecipientKey(value);
        if (!key || seen.has(key)){
          continue;
        }
        seen.add(key);
        deduped.push(value);
      }
    }
    normalized[field] = deduped;
  }
  return normalized;
}

async function expandSeparatePasswordDispatchQueue(queue){
  const expanded = [];
  for (const dispatch of Array.isArray(queue) ? queue : []){
    const normalized = await dedupePasswordDispatchRecipients(dispatch);
    if (!normalized){
      continue;
    }
    if (!isSecretsPasswordDispatch(normalized)){
      expanded.push(normalized);
      continue;
    }
    const seen = new Set();
    let added = 0;
    added += await addPerRecipientPasswordDispatches(expanded, normalized, normalized.to, "to", seen);
    added += await addPerRecipientPasswordDispatches(expanded, normalized, normalized.cc, "cc", seen);
    added += await addPerRecipientPasswordDispatches(expanded, normalized, normalized.bcc, "bcc", seen);
    if (added === 0){
      expanded.push(normalized);
    }
  }
  return expanded;
}

function countSecretsPasswordDispatches(queue){
  return (Array.isArray(queue) ? queue : []).reduce((count, dispatch) => {
    return count + (isSecretsPasswordDispatch(dispatch) ? 1 : 0);
  }, 0);
}

function buildSecretsTitle(dispatch){
  const shareLabel = String(dispatch?.shareLabel || "").trim();
  return shareLabel ? `NCC ${shareLabel}` : "NCC share password";
}

function buildPasswordDeliveryShareInfo(dispatch, deliveryValue){
  const base = dispatch?.renderShareInfo && typeof dispatch.renderShareInfo === "object"
    ? dispatch.renderShareInfo
    : {};
  return {
    ...base,
    shareUrl: String(base.shareUrl || dispatch?.shareUrl || ""),
    shareId: String(base.shareId || dispatch?.shareId || ""),
    folderInfo: base.folderInfo || dispatch?.folderInfo || null,
    label: String(base.label || dispatch?.shareLabel || ""),
    password: String(deliveryValue || "")
  };
}

async function renderPasswordDispatchBodies(dispatch, deliveryValue, secretLink){
  const shareInfo = buildPasswordDeliveryShareInfo(dispatch, deliveryValue);
  const renderOptions = {
    policyShare: dispatch?.policyShare || null,
    policyEditableShare: dispatch?.policyEditableShare || null,
    passwordOnly: true,
    secretLink: !!secretLink
  };
  const html = dispatch?.isPlainText === true
    ? ""
    : await NCSharing.buildHtmlBlock(shareInfo, renderOptions);
  const plainText = dispatch?.isPlainText === true
    ? finalizePasswordDispatchPlainText(await NCSharing.buildPlainTextBlock(shareInfo, renderOptions))
    : "";
  return { html, plainText };
}

async function prepareSecretsPasswordDispatch(dispatch, sourceTabId){
  if (!isSecretsPasswordDispatch(dispatch)){
    return { dispatch, fellBack: false };
  }
  try{
    L("sharing separate password secrets link create start", {
      sourceTabId,
      to: Array.isArray(dispatch.to) ? dispatch.to.length : 0,
      cc: Array.isArray(dispatch.cc) ? dispatch.cc.length : 0,
      bcc: Array.isArray(dispatch.bcc) ? dispatch.bcc.length : 0,
      expireDays: dispatch.secretsExpireDays,
      composeMode: dispatch.isPlainText ? "plain" : "html"
    });
    const secret = await NCSecrets.createSecretLink({
      plainText: dispatch.password,
      title: buildSecretsTitle(dispatch),
      expireDays: dispatch.secretsExpireDays
    });
    const prepared = clonePasswordDispatch(dispatch);
    const bodies = await renderPasswordDispatchBodies(prepared, secret.shareUrl, true);
    prepared.password = secret.shareUrl;
    prepared.deliveryMode = NCSharePasswordDelivery.MODE_SECRETS;
    prepared.html = bodies.html || prepared.html;
    prepared.plainText = bodies.plainText || prepared.plainText;
    L("sharing separate password secrets link created", {
      sourceTabId,
      hasUuid: !!secret.uuid,
      hasExpires: !!secret.expires,
      hasHtml: !!prepared.html,
      hasPlainText: !!prepared.plainText
    });
    return { dispatch: prepared, fellBack: false };
  }catch(error){
    console.error("[NCBG] sharing separate password secrets link creation failed, falling back to plain mail", {
      sourceTabId,
      error: error?.message || String(error)
    });
    const fallback = clonePasswordDispatch(dispatch);
    fallback.deliveryMode = NCSharePasswordDelivery.MODE_PLAIN;
    return { dispatch: fallback, fellBack: true };
  }
}

async function showPasswordSecretsFallbackNotification(){
  if (typeof browser?.notifications?.create !== "function"){
    L("sharing separate password secrets fallback notification skipped", {
      reason: "notifications_api_missing"
    });
    return;
  }
  try{
    const notificationId = `nc-password-secrets-fallback-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await browser.notifications.create(notificationId, {
      type: "basic",
      title: bgI18n("sharing_password_mail_notify_title"),
      message: bgI18n("sharing_password_secrets_fallback_warning"),
      iconUrl: browser.runtime.getURL("icons/app-32.png")
    });
    L("sharing separate password secrets fallback notification shown", { notificationId });
  }catch(error){
    console.error("[NCBG] sharing separate password secrets fallback notification failed", {
      error: error?.message || String(error)
    });
  }
}

async function stageSeparatePasswordMailForSendLater(tabId, queue){
  if (!Array.isArray(queue) || !queue.length){
    return;
  }
  const expandedQueue = await expandSeparatePasswordDispatchQueue(queue);
  const dispatchQueue = [];
  let secretsFallbackCount = 0;
  for (const dispatch of expandedQueue){
    const prepared = await prepareSecretsPasswordDispatch(dispatch, tabId);
    dispatchQueue.push(prepared.dispatch);
    if (prepared.fellBack){
      secretsFallbackCount++;
    }
  }
  const recipientCount = countUniquePasswordDispatchRecipients(dispatchQueue);
  const fallbackResult = await openManualPasswordFallbackQueue(
    tabId,
    dispatchQueue,
    0,
    "primary_send_later"
  );
  L("sharing separate password drafts staged for queued primary mail", {
    sourceTabId: tabId,
    dispatchCount: dispatchQueue.length,
    recipients: recipientCount,
    opened: fallbackResult.opened,
    failed: fallbackResult.failed,
    needsSender: fallbackResult.needsSender,
    secretsFallbackCount
  });
  if (secretsFallbackCount > 0){
    await showPasswordSecretsFallbackNotification();
  }
  if (fallbackResult.failed > 0){
    retainPasswordMailRecoveryQueue(
      tabId,
      fallbackResult.failedQueue,
      "primary_send_later"
    );
    const failedRecipients = countUniquePasswordDispatchRecipients(
      fallbackResult.failedQueue
    );
    await showPasswordMailFailureNotification(
      failedRecipients || fallbackResult.failedQueue.length
    );
  }
  if (fallbackResult.opened > 0){
    const openedRecipients = countUniquePasswordDispatchRecipients(
      fallbackResult.openedQueue
    );
    await showPasswordMailManualRequiredNotification(
      openedRecipients || fallbackResult.openedQueue.length,
      {
      requireSenderSelection: fallbackResult.needsSender > 0,
      primarySendLater: true
      }
    );
  }
  return fallbackResult;
}

async function sendSeparatePasswordMail(tabId, queue, sendMode = "sendNow"){
  if (!Array.isArray(queue) || !queue.length){
    return;
  }
  const passwordSendMode = normalizePasswordMailSendMode(sendMode);
  if (passwordSendMode === "sendLater"){
    await stageSeparatePasswordMailForSendLater(tabId, queue);
    return;
  }
  const dispatchQueue = await expandSeparatePasswordDispatchQueue(queue);
  const queuedSecrets = countSecretsPasswordDispatches(queue);
  if (queuedSecrets > 0){
    L("sharing separate password dispatch queue prepared", {
      sourceTabId: tabId,
      queued: queue.length,
      expanded: dispatchQueue.length,
      secretsQueued: queuedSecrets,
      secretsExpanded: countSecretsPasswordDispatches(dispatchQueue)
    });
  }
  const recipientCount = countUniquePasswordDispatchRecipients(dispatchQueue);
  if (!recipientCount){
    const fallbackResult = await openManualPasswordFallbackQueue(
      tabId,
      dispatchQueue,
      0,
      "no_recipients_for_password_mail"
    );
    if (fallbackResult.failed > 0){
      await showPasswordMailFailureNotification(dispatchQueue.length);
    }
    if (fallbackResult.opened > 0){
      await showPasswordMailManualRequiredNotification(dispatchQueue.length, {
        requireSenderSelection: true
      });
    }
    return;
  }
  let autoSendFailedCount = 0;
  let autoSendSkippedIdentityCount = 0;
  let autoSendPendingCount = 0;
  let manualFallbackOpenedCount = 0;
  let manualFallbackFailedCount = 0;
  let manualFallbackNeedsSenderCount = 0;
  let secretsFallbackCount = 0;
  for (const queuedDispatch of dispatchQueue){
    const prepared = await prepareSecretsPasswordDispatch(queuedDispatch, tabId);
    const dispatch = prepared.dispatch;
    if (prepared.fellBack){
      secretsFallbackCount++;
    }
    const identityResolution = await ensureSeparatePasswordDispatchIdentity(dispatch);
    const bodyFields = buildSeparatePasswordMailBodyFields(dispatch);
    const autoComposeDetails = {
      to: dispatch.to,
      cc: dispatch.cc,
      bcc: dispatch.bcc,
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
      deliveryFormat: String(dispatch?.deliveryFormat || ""),
      deliveryMode: String(dispatch?.deliveryMode || NCSharePasswordDelivery.MODE_PLAIN),
      sendMode: passwordSendMode
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
        const fallbackResult = await openManualPasswordFallbackQueue(tabId, [dispatch], 0, identityResolution.reason);
        manualFallbackOpenedCount += fallbackResult.opened;
        manualFallbackFailedCount += fallbackResult.failed;
        manualFallbackNeedsSenderCount += fallbackResult.needsSender;
      }catch(error){
        manualFallbackFailedCount++;
        console.error("[NCBG] sharing separate password fallback queue failed", {
          sourceTabId: tabId,
          failedComposeTabId: 0,
          error: error?.message || String(error)
        });
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
      if (typeof NCEmailSignature === "undefined"
        || typeof NCEmailSignature.applyAndWait !== "function"){
        throw new Error("password_mail_signature_runtime_unavailable");
      }
      const signatureResult = await NCEmailSignature.applyAndWait(
        composeTabId,
        "password_followup"
      );
      if (signatureResult?.ok !== true){
        throw new Error(signatureResult?.error || "password_mail_signature_apply_failed");
      }
      L("sharing separate password signature settled", {
        sourceTabId: tabId,
        composeTabId,
        applied: signatureResult.applied === true,
        result: String(signatureResult.reason || "")
      });
      await waitForComposeAutoSendReady(composeTabId, {
        identityId: identityResolution.identityId,
        to: dispatch.to,
        cc: dispatch.cc,
        bcc: dispatch.bcc,
        subject: autoComposeDetails.subject
      });
      const sendResult = await sendComposeWithTimeout(
        composeTabId,
        passwordSendMode,
        PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS
      );
      if (sendResult.status === "pending"){
        autoSendPendingCount++;
        const pendingRecipientCount = countUniquePasswordDispatchRecipients([dispatch]) || 1;
        void sendResult.completion.then(async () => {
          L("sharing separate password mail pending send completed", {
            sourceTabId: tabId,
            composeTabId
          });
          await showPasswordMailSuccessNotification(pendingRecipientCount);
        }).catch(async (error) => {
          console.error("[NCBG] sharing separate password mail pending send failed", {
            sourceTabId: tabId,
            composeTabId,
            error: error?.message || String(error)
          });
          await showPasswordMailFailureNotification(pendingRecipientCount);
        });
        L("sharing separate password mail send confirmation pending", {
          sourceTabId: tabId,
          composeTabId,
          sendMode: passwordSendMode
        });
        continue;
      }
      L("sharing separate password mail send done", {
        sourceTabId: tabId,
        composeTabId,
        sendMode: passwordSendMode
      });
    }catch(error){
      autoSendFailedCount++;
      console.error("[NCBG] sharing separate password mail auto-send failed", {
        sourceTabId: tabId,
        composeTabId,
        sendMode: passwordSendMode,
        error: error?.message || String(error)
      });
      let fallbackResult = null;
      try{
        fallbackResult = await openManualPasswordFallbackQueue(
          tabId,
          [dispatch],
          composeTabId,
          "auto_send_failed"
        );
        manualFallbackOpenedCount += fallbackResult.opened;
        manualFallbackFailedCount += fallbackResult.failed;
        manualFallbackNeedsSenderCount += fallbackResult.needsSender;
      }catch(error){
        manualFallbackFailedCount++;
        console.error("[NCBG] sharing separate password fallback queue failed", {
          sourceTabId: tabId,
          failedComposeTabId: composeTabId,
          error: error?.message || String(error)
        });
      }
      if (fallbackResult?.opened > 0
        && Number.isInteger(composeTabId)
        && composeTabId > 0){
        try{
          await browser.tabs.remove(composeTabId);
          L("sharing separate password mail failed auto tab removed", {
            sourceTabId: tabId,
            composeTabId
          });
        }catch(error){
          console.error("[NCBG] sharing separate password mail failed auto tab remove failed", {
            sourceTabId: tabId,
            composeTabId,
            error: error?.message || String(error)
          });
        }
      }else if (Number.isInteger(composeTabId) && composeTabId > 0){
        L("sharing separate password mail failed auto tab retained", {
          sourceTabId: tabId,
          composeTabId,
          reason: "manual_replacement_not_opened"
        });
      }
    }
  }
  if (autoSendFailedCount === 0
    && autoSendSkippedIdentityCount === 0
    && autoSendPendingCount === 0){
    L("sharing separate password mail sent", {
      sourceTabId: tabId,
      dispatchCount: dispatchQueue.length,
      recipients: recipientCount,
      sendMode: passwordSendMode
    });
    if (secretsFallbackCount > 0){
      await showPasswordSecretsFallbackNotification();
    }
    await showPasswordMailSuccessNotification(recipientCount);
    return;
  }
  L("sharing separate password mail partially sent (manual fallback required)", {
    sourceTabId: tabId,
    dispatchCount: dispatchQueue.length,
    recipients: recipientCount,
    autoSendFailedCount,
    autoSendSkippedIdentityCount,
    secretsFallbackCount,
    manualFallbackOpenedCount,
    manualFallbackFailedCount,
    manualFallbackNeedsSenderCount,
    autoSendPendingCount
  });
  if (secretsFallbackCount > 0){
    await showPasswordSecretsFallbackNotification();
  }
  if (autoSendFailedCount > 0 || manualFallbackFailedCount > 0){
    await showPasswordMailFailureNotification(recipientCount);
  }
  if (autoSendPendingCount > 0){
    await showPasswordMailPendingNotification(recipientCount);
  }
  if (manualFallbackOpenedCount > 0){
    await showPasswordMailManualRequiredNotification(recipientCount, {
      requireSenderSelection: manualFallbackNeedsSenderCount > 0
    });
  }
}
