/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Owns the pending per-compose password-dispatch queue and its transitions.
 */
const PASSWORD_MAIL_DISPATCH_CLEAR_TIMER_BY_TAB = new Map();

function passwordDispatchRegistrationKey(dispatch){
  const shareId = String(dispatch?.shareId || "").trim();
  const shareUrl = String(dispatch?.shareUrl || "").trim();
  if (shareId || shareUrl){
    return `share:${shareUrl}|${shareId}`;
  }
  const relativeFolder = String(dispatch?.folderInfo?.relativeFolder || "").trim();
  return relativeFolder ? `folder:${relativeFolder}` : "";
}
function passwordDispatchQueueEntryKey(dispatch){
  return String(
    dispatch?.registrationId
      || dispatch?.dedupKey
      || passwordDispatchRegistrationKey(dispatch)
      || ""
  ).trim();
}

function getSeparatePasswordMailDispatchQueue(tabId){
  const queue = PASSWORD_MAIL_DISPATCH_BY_TAB.get(tabId);
  return Array.isArray(queue) && queue.length ? queue : null;
}

function hasSeparatePasswordMailDispatch(tabId){
  return getSeparatePasswordMailDispatchQueue(tabId) !== null;
}

function retainFailedSavedDraftPasswordDispatches(
  tabId,
  sourceQueue,
  failedQueue
){
  const processedKeys = new Set(
    sourceQueue.map(passwordDispatchQueueEntryKey).filter(Boolean)
  );
  const current = getSeparatePasswordMailDispatchQueue(tabId);
  const unprocessed = (current || []).filter((dispatch) => {
    const key = passwordDispatchQueueEntryKey(dispatch);
    return !key || !processedKeys.has(key);
  });
  const remaining = unprocessed.concat(
    Array.isArray(failedQueue) ? failedQueue : []
  );
  if (remaining.length){
    PASSWORD_MAIL_DISPATCH_BY_TAB.set(tabId, remaining);
  }else{
    PASSWORD_MAIL_DISPATCH_BY_TAB.delete(tabId);
  }
  return remaining;
}

function createPasswordDispatchRegistrationId(){
  return createSecureRuntimeId();
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
