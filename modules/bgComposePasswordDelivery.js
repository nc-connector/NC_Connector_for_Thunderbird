/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Password delivery strategy, Secrets expansion, send orchestration, and recovery.
 */
const PASSWORD_MAIL_RECOVERY_RETRY_DELAYS_MS = [2000, 5000, 10000];
const PASSWORD_MAIL_RECOVERY_BY_SOURCE_TAB = new Map();

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
