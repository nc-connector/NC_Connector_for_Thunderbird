/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Password follow-up compose construction, readiness, transport, fallback, and notifications.
 */
const PASSWORD_MAIL_AUTO_SEND_TIMEOUT_MS = 20000;
const PASSWORD_MAIL_COMPOSE_READY_RETRY_DELAYS_MS = [0, 150, 300, 500, 800, 1200];

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
