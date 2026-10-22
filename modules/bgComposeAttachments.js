/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Owns the shared compose/wizard queue and attachment automation prompts.
 */

function bindSharingWizardRequestContext(windowId, tabId, options = null){
  const normalizedWindowId = Number(windowId);
  const normalizedTabId = Number(tabId);
  if (!Number.isInteger(normalizedWindowId)
    || normalizedWindowId <= 0
    || !Number.isInteger(normalizedTabId)
    || normalizedTabId <= 0){
    throw new Error("sharing_wizard_request_context_invalid");
  }
  const context = Object.freeze({
    windowId: normalizedWindowId,
    tabId: normalizedTabId,
    attachmentMode: options?.mode === "attachments"
  });
  SHARING_WIZARD_REQUEST_BY_WINDOW.set(normalizedWindowId, context);
  return context;
}

function getSharingWizardRequestContext(windowId, tabId){
  const normalizedWindowId = Number(windowId);
  const normalizedTabId = Number(tabId);
  const context = SHARING_WIZARD_REQUEST_BY_WINDOW.get(normalizedWindowId) || null;
  if (!context || context.tabId !== normalizedTabId){
    throw new Error("sharing_wizard_request_context_missing");
  }
  return context;
}

function clearSharingWizardRequestContext(windowId){
  return SHARING_WIZARD_REQUEST_BY_WINDOW.delete(Number(windowId));
}

function clearComposeAttachmentEvalTimer(tabId){
  const timerId = ATTACHMENT_EVAL_TIMER_BY_TAB.get(tabId);
  if (!timerId){
    return;
  }
  try{
    clearTimeout(timerId);
  }catch(error){
    console.error("[NCBG] clear attachment eval timer failed", error);
  }
  ATTACHMENT_EVAL_TIMER_BY_TAB.delete(tabId);
}


const COMPOSE_SHARING_BY_TAB = new Map();
const COMPOSE_SHARING_ACK_TIMEOUT_MS = 30000;

async function hasComposeSharingBlock(tabId){
  if (hasComposeShareCleanup(tabId)){
    return true;
  }
  const details = await browser.compose.getComposeDetails(tabId);
  return (details?.customHeaders || []).some((header) =>
    String(header.name).toLowerCase() === COMPOSE_SHARE_DRAFT_HEADER.toLowerCase());
}

function getComposeAttachmentAutomationState(tabId){
  let state = ATTACHMENT_AUTOMATION_BY_TAB.get(tabId);
  if (!state){
    state = { phase: "idle", evaluationTask: null, rerunRequested: false,
      promptId: "", disposed: false };
    ATTACHMENT_AUTOMATION_BY_TAB.set(tabId, state);
  }
  return state;
}

function isComposeAttachmentRoutingActive(tabId){
  return COMPOSE_SHARING_BY_TAB.has(Number(tabId));
}

async function prepareComposeAttachmentRoutingBeforeSend(tabId){
  if (isComposeAttachmentRoutingActive(tabId)){
    return true;
  }
  try{
    // Use the same native attachment list as intake; embedded body images are not files in this list.
    const attachments = await listComposeAttachments(tabId);
    if (isComposeAttachmentRoutingActive(tabId)) return true;
    if (!attachments.length) return false;
    const settings = await getComposeAttachmentAutomationSettings();
    if (isComposeAttachmentRoutingActive(tabId)) return true;
    if (!settings.alwaysConnector
      && !(settings.thresholdMandatory && sumAttachmentBytes(attachments) > settings.thresholdBytes)){
      return false;
    }
    // A completed share prevents a second wizard, never the required attachment check.
    if (settings.alwaysConnector && !await hasComposeSharingBlock(tabId)){
      const guard = await assertAttachmentAutomationAllowed("before_send", tabId);
      if (guard.ok && !isComposeAttachmentRoutingActive(tabId)){
        clearComposeAttachmentEvalTimer(tabId);
        void requestComposeAttachmentEvaluation(tabId).catch((error) => {
          console.error("[NCBG] compose attachment evaluation before send failed", error);
        });
      }
    }
  }catch(error){
    console.error("[NCBG] compose attachment send guard failed", error);
  }
  return true;
}

function postComposeSharingMessage(session, message){
  if (session.closed || !session.port){
    throw new Error("sharing_compose_session_closed");
  }
  session.port.postMessage(message);
}

function exchangeComposeSharingBatch(session, batch, type, expectedType, extra = {}){
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (session.ack?.batchId === batch.id){
        session.ack = null;
      }
      reject(new Error("sharing_compose_ack_timeout"));
    }, COMPOSE_SHARING_ACK_TIMEOUT_MS);
    session.ack = {
      batchId: batch.id,
      type: expectedType,
      resolve(){
        clearTimeout(timer);
        session.ack = null;
        resolve();
      },
      reject(error){
        clearTimeout(timer);
        session.ack = null;
        reject(error);
      }
    };
    try{
      postComposeSharingMessage(session, { type, batchId: batch.id, ...extra });
    }catch(error){
      session.ack.reject(error);
    }
  });
}

async function restoreComposeSharingBatch(session, batch){
  if (session.tabClosed || !batch.detached.length){
    return;
  }
  markComposeAttachmentSuppressed(session.tabId, true);
  const failed = [];
  try{
    for (const item of batch.detached){
      try{
        await browser.compose.addAttachment(session.tabId, { file: item.file, name: item.name });
      }catch(error){
        failed.push(item);
        console.error("[NCBG] compose attachment restore failed", {
          tabId: session.tabId, error: error?.message || String(error)
        });
      }
    }
  }finally{
    markComposeAttachmentSuppressed(session.tabId, false);
  }
  batch.detached = failed;
  if (failed.length){
    session.restoreFailed = true;
    throw new Error("attachment_restore_failed");
  }
}

function drainComposeSharingAttachments(session){
  if (!session.ready || session.closed || session.finalizing || session.finished){
    return session.intakeTask || Promise.resolve();
  }
  session.rerun = true;
  if (session.intakeTask) return session.intakeTask;
  const task = (async () => {
    while (session.rerun && !session.closed && !session.finalizing){
      session.rerun = false;
      await NCPolicyRuntime.assertManagedAccess();
      const attachments = await listComposeAttachments(session.tabId);
      if (session.closed || !attachments.length) break;
      const files = await collectComposeAttachmentFiles(session.tabId, attachments);
      if (session.closed) break;
      const batch = { id: createSecureRuntimeId(), detached: [] };
      session.batch = batch;
      try{
        L("compose attachments offered to sharing wizard", {
          tabId: session.tabId, windowId: session.windowId, count: files.length
        });
        await exchangeComposeSharingBatch(session, batch, "attachments", "accepted", {
          attachments: files.map((item) => ({
            sourceAttachmentId: item.attachmentId, name: item.name,
            sizeBytes: item.size, displayPath: item.displayPath, file: item.file
          }))
        });
        for (const item of files){
          if (session.closed) throw new Error("sharing_compose_session_closed");
          await browser.compose.removeAttachment(session.tabId, item.attachmentId);
          batch.detached.push(item);
        }
        // Keep the detached originals until the wizard has committed the queue.
        await exchangeComposeSharingBatch(session, batch, "committed", "applied", {
          revision: session.queueRevision + 1
        });
        session.queueRevision++;
        batch.detached = [];
        session.batch = null;
        ATTACHMENT_PENDING_ADDED_BY_TAB.delete(session.tabId);
        L("compose attachments adopted by sharing wizard", {
          tabId: session.tabId, windowId: session.windowId, count: files.length
        });
        session.rerun = true;
      }catch(error){
        if (!session.closed){
          try{
            postComposeSharingMessage(session, { type: "rejected", batchId: batch.id });
          }catch(postError){
            console.error("[NCBG] compose queue rejection failed", postError);
          }
        }
        await restoreComposeSharingBatch(session, batch);
        session.batch = null;
        throw error;
      }
    }
  })().catch((error) => {
    // A lost acknowledgement leaves queue ownership uncertain. End this UI
    // session after restoring the current batch, rather than offer it twice.
    void releaseComposeAttachmentWizard(session.windowId, "queue_intake_failed")
      .catch(reportComposeSharingIntakeError);
    throw error;
  });
  session.intakeTask = task;
  return task.finally(() => {
    if (session.intakeTask === task) session.intakeTask = null;
  });
}

async function releaseComposeAttachmentWizard(windowId, reason = ""){
  const session = [...COMPOSE_SHARING_BY_TAB.values()]
    .find((entry) => entry.windowId === Number(windowId));
  if (!session) return false;
  if (session.closeTask) return session.closeTask;
  session.closed = true;
  session.resolveWindowReady?.(null);
  session.resolveWindowReady = null;
  session.ack?.reject(new Error("sharing_compose_session_closed"));
  session.closeTask = (async () => {
    try{
      await session.intakeTask;
    }catch(error){
      console.error("[NCBG] sharing intake stopped", {
        tabId: session.tabId, reason, error: error?.message || String(error)
      });
    }
    clearSharingWizardRequestContext(windowId);
    if (!session.restoreFailed && COMPOSE_SHARING_BY_TAB.get(session.tabId) === session){
      COMPOSE_SHARING_BY_TAB.delete(session.tabId);
    }
    // Closing is cancellation; already adopted files are intentionally not restored.
    ATTACHMENT_PENDING_ADDED_BY_TAB.delete(session.tabId);
    clearComposeAttachmentEvalTimer(session.tabId);
    session.port?.disconnect();
    return true;
  })();
  return session.closeTask;
}

async function lockComposeSharingForFinalize(tabId, windowId, queueRevision){
  const session = COMPOSE_SHARING_BY_TAB.get(Number(tabId));
  if (!session || !session.ready || session.closed || session.windowId !== Number(windowId)){
    throw new Error("sharing_wizard_request_context_missing");
  }
  if (await hasComposeSharingBlock(tabId)){
    throw new Error("sharing_compose_existing_share");
  }
  await drainComposeSharingAttachments(session);
  if (session.closed || session.intakeTask || session.batch
    || Number(queueRevision) !== session.queueRevision){
    throw new Error("sharing_compose_pending_attachments");
  }
  const revision = session.revision;
  const attachments = await listComposeAttachments(tabId);
  if (attachments.length || revision !== session.revision){
    void drainComposeSharingAttachments(session).catch(reportComposeSharingIntakeError);
    throw new Error("sharing_compose_pending_attachments");
  }
  session.finalizing = true;
  session.finalizeRevision = revision;
  return session;
}

function assertComposeSharingFinalizationCurrent(session){
  if (!session || session.closed || session.revision !== session.finalizeRevision){
    throw new Error("sharing_compose_pending_attachments");
  }
}

function finishComposeSharingFinalize(session, committed){
  if (!session) return;
  session.finalizing = false;
  session.finished = committed === true;
  if (!committed){
    void drainComposeSharingAttachments(session).catch(reportComposeSharingIntakeError);
  }
}

function reportComposeSharingIntakeError(error){
  console.error("[NCBG] compose sharing queue intake failed", error);
  void showComposeShareBlockedNotification("sharing_error_insert_failed");
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "nc-sharing-compose") return;
  let session = null;
  port.onMessage.addListener((message) => {
    if (message?.type === "ready" && !session){
      const candidate = COMPOSE_SHARING_BY_TAB.get(Number(message.tabId));
      const windowId = Number(port.sender?.tab?.windowId);
      if (!candidate || candidate.closed || candidate.port
        || port.sender?.id !== browser.runtime.id || port.sender?.url !== candidate.url
        || !Number.isInteger(windowId) || windowId <= 0
        || windowId !== Number(message.windowId)
        || (candidate.windowId && candidate.windowId !== windowId)){
        console.error("[NCBG] sharing queue port rejected");
        port.disconnect();
        return;
      }
      session = candidate;
      session.port = port;
      try{
        // Thunderbird's windows.create waits for native focus. The authenticated
        // page can be ready earlier, so its Port binds the window without that wait.
        bindComposeSharingWindow(session, { id: windowId, tabs: [port.sender.tab] });
        session.ready = true;
        L("compose sharing queue ready", { tabId: session.tabId, windowId: session.windowId });
        postComposeSharingMessage(session, {
          type: "ready", mode: session.mode, reason: session.reason
        });
        void drainComposeSharingAttachments(session).catch(reportComposeSharingIntakeError);
      }catch(error){
        port.disconnect();
        reportComposeSharingIntakeError(error);
      }
      return;
    }
    if (!session || message?.batchId !== session.ack?.batchId) return;
    if (message.type === session.ack.type){
      session.ack.resolve();
    }else if (message.type === "rejected"){
      session.ack.reject(new Error("sharing_compose_queue_rejected"));
    }
  });
  port.onDisconnect.addListener(() => {
    if (session){
      void releaseComposeAttachmentWizard(session.windowId, "queue_port_disconnected")
        .catch(reportComposeSharingIntakeError);
    }
  });
});

function requestComposeAttachmentEvaluation(tabId){
  const session = COMPOSE_SHARING_BY_TAB.get(tabId);
  if (session) return drainComposeSharingAttachments(session);
  const state = getComposeAttachmentAutomationState(tabId);
  if (state.evaluationTask){
    state.rerunRequested = true;
    return state.evaluationTask;
  }
  if (isComposeAttachmentRoutingActive(tabId)){
    state.rerunRequested = true;
    return Promise.resolve();
  }
  const task = (async () => {
    do{
      state.rerunRequested = false;
      state.phase = "evaluating";
      await evaluateComposeAttachmentThreshold(tabId);
    }while (state.rerunRequested && !isComposeAttachmentRoutingActive(tabId));
  })();
  state.evaluationTask = task;
  return task.finally(() => {
    if (state.evaluationTask === task){
      state.evaluationTask = null;
    }
    if (state.phase === "evaluating"){
      state.phase = "idle";
    }
  });
}

function settleComposeAttachmentPromptBatch(tabId, decision){
  const state = getComposeAttachmentAutomationState(tabId);
  if (decision === "remove_last"){
    state.rerunRequested = ATTACHMENT_PENDING_ADDED_BY_TAB.has(tabId);
    return;
  }
  // Share consumes the current compose set; dismiss deliberately ignores all
  // additions made while the same prompt was open.
  ATTACHMENT_PENDING_ADDED_BY_TAB.delete(tabId);
  state.rerunRequested = false;
}

function scheduleComposeAttachmentEvaluation(tabId){
  if (!Number.isInteger(tabId) || tabId <= 0){
    return;
  }
  clearComposeAttachmentEvalTimer(tabId);
  const timerId = setTimeout(() => {
    ATTACHMENT_EVAL_TIMER_BY_TAB.delete(tabId);
    requestComposeAttachmentEvaluation(tabId).catch((error) => {
      console.error("[NCBG] compose attachment evaluation failed", error);
    });
  }, ATTACHMENT_EVAL_DEBOUNCE_MS);
  ATTACHMENT_EVAL_TIMER_BY_TAB.set(tabId, timerId);
  L("compose attachment evaluation scheduled", {
    tabId,
    debounceMs: ATTACHMENT_EVAL_DEBOUNCE_MS
  });
}

function queueComposeAddedAttachment(tabId, attachment){
  if (!Number.isInteger(tabId) || tabId <= 0){
    return;
  }
  const entry = {
    id: attachment?.id,
    name: String(attachment?.name || ""),
    sizeBytes: getAttachmentSizeBytes(attachment)
  };
  const list = ATTACHMENT_PENDING_ADDED_BY_TAB.get(tabId);
  if (Array.isArray(list)){
    list.push(entry);
    return;
  }
  ATTACHMENT_PENDING_ADDED_BY_TAB.set(tabId, [entry]);
}

function takeComposeAddedAttachmentBatch(tabId){
  const list = ATTACHMENT_PENDING_ADDED_BY_TAB.get(tabId);
  ATTACHMENT_PENDING_ADDED_BY_TAB.delete(tabId);
  if (!Array.isArray(list) || !list.length){
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of list){
    const id = Number(entry?.id);
    if (!Number.isInteger(id) || id < 0 || seen.has(id)){
      continue;
    }
    seen.add(id);
    out.push({
      id,
      name: String(entry?.name || ""),
      sizeBytes: Math.max(0, Number(entry?.sizeBytes) || 0)
    });
  }
  return out;
}

/**
 * Mark tab-local attachment handling as suppressed while we remove attachments
 * programmatically to avoid recursive trigger loops.
 * @param {number} tabId
 * @param {boolean} suppressed
 */
function markComposeAttachmentSuppressed(tabId, suppressed){
  if (!Number.isInteger(tabId) || tabId <= 0){
    return;
  }
  if (suppressed){
    ATTACHMENT_SUPPRESSED_TABS.add(tabId);
  }else{
    ATTACHMENT_SUPPRESSED_TABS.delete(tabId);
  }
  L("compose attachment suppression changed", { tabId, suppressed: !!suppressed });
}

/**
 * Read Thunderbird's live big-attachment compose setting.
 * This must be checked before NC attachment automation runs.
 * @returns {Promise<{lockActive:boolean,thresholdMb:number}>}
 */
async function getComposeBigAttachmentSettingsLive(){
  const readApi = browser?.ncComposePrefs?.getBigAttachmentSettings;
  if (typeof readApi !== "function"){
    console.error("[NCBG] compose big-attachment settings check failed", {
      reason: "api_missing"
    });
    throw new Error("ncComposePrefs.getBigAttachmentSettings API missing");
  }
  const settings = await readApi();
  const thresholdMb = normalizeAttachmentThresholdMb(settings?.thresholdMb);
  const lockActive = !!settings?.lockActive;
  L("compose big-attachment settings check", {
    thresholdMb,
    lockActive
  });
  return {
    thresholdMb,
    lockActive
  };
}

/**
 * Assert that NC attachment automation is allowed in current live TB settings.
 * @param {string} stage
 * @param {number} tabId
 * @param {object} details
 * @returns {Promise<{ok:boolean,thresholdMb:number}>}
 */
async function assertAttachmentAutomationAllowed(stage, tabId, details = {}){
  const settings = await getComposeBigAttachmentSettingsLive();
  if (!settings.lockActive){
    return { ok:true, thresholdMb: settings.thresholdMb };
  }
  const logDetails = {
    tabId: Number.isInteger(tabId) ? tabId : 0,
    stage: String(stage || ""),
    thresholdMb: settings.thresholdMb
  };
  if (details && typeof details === "object"){
    for (const [key, value] of Object.entries(details)){
      logDetails[key] = value;
    }
  }
  L("compose attachment automation blocked by thunderbird setting", logDetails);
  return { ok:false, thresholdMb: settings.thresholdMb };
}

async function getComposeAttachmentAutomationSettings(){
  const keys = SHARING_KEYS || {};
  const stored = await browser.storage.local.get([
    keys.attachmentsAlwaysConnector,
    keys.attachmentsOfferAboveEnabled,
    keys.attachmentsOfferAboveMb
  ]);
  const hasLocalAlways = typeof stored[keys.attachmentsAlwaysConnector] === "boolean";
  const hasLocalThreshold = typeof stored[keys.attachmentsOfferAboveEnabled] === "boolean"
    || stored[keys.attachmentsOfferAboveMb] !== undefined;
  let alwaysConnector = hasLocalAlways ? stored[keys.attachmentsAlwaysConnector] : false;
  let offerAboveEnabled = typeof stored[keys.attachmentsOfferAboveEnabled] === "boolean"
    ? stored[keys.attachmentsOfferAboveEnabled]
    : true;
  let thresholdMb = normalizeAttachmentThresholdMb(stored[keys.attachmentsOfferAboveMb]);
  let thresholdMandatory = false;

  try{
    const policyStatus = await NCPolicyRuntime.getPolicyStatus();
    const access = NCPolicyState.getManagedAccessState(policyStatus);
    if (!access.allowed){
      L("compose attachment automation disabled by managed rollout", { reason: access.reason });
      return {
        alwaysConnector: false,
        offerAboveEnabled: false,
        thresholdMandatory: false,
        thresholdMb,
        thresholdBytes: thresholdMb * 1024 * 1024
      };
    }
    if (NCPolicyState.isDomainActive(policyStatus, "share")){
      alwaysConnector = NCPolicyState.resolveDefaultValue(
        policyStatus,
        "share",
        NCSharingStorage.SHARE_POLICY_KEYS.attachmentsAlwaysConnector,
        alwaysConnector,
        hasLocalAlways,
        NCPolicyState.coerceBoolean
      );
      if (
        (!hasLocalThreshold || NCPolicyState.getDefaultsSourceState(policyStatus).value === "backend" || NCPolicyState.isLocked(
          policyStatus,
          "share",
          NCSharingStorage.SHARE_POLICY_KEYS.attachmentsMinSizeMb
        ))
        && NCPolicyState.hasPolicyKey(
          policyStatus,
          "share",
          NCSharingStorage.SHARE_POLICY_KEYS.attachmentsMinSizeMb
        )
      ){
        const policyThreshold = NCPolicyState.readPolicyValue(
          policyStatus,
          "share",
          NCSharingStorage.SHARE_POLICY_KEYS.attachmentsMinSizeMb
        );
        if (policyThreshold == null){
          offerAboveEnabled = false;
        }else{
          thresholdMb = normalizeAttachmentThresholdMb(Number(policyThreshold) || 0);
          offerAboveEnabled = true;
          thresholdMandatory = NCPolicyState.isLocked(
            policyStatus, "share", NCSharingStorage.SHARE_POLICY_KEYS.attachmentsMinSizeMb
          );
        }
      }
    }
  }catch(error){
    if (error?.code === "managed_setup_read_failed"){
      throw error;
    }
    L("compose attachment automation policy status fallback", {
      reason: "policy_runtime_failed",
      error: error?.message || String(error)
    });
  }
  return {
    alwaysConnector,
    offerAboveEnabled: !alwaysConnector && offerAboveEnabled,
    thresholdMandatory,
    thresholdMb,
    thresholdBytes: thresholdMb * 1024 * 1024
  };
}

function getAttachmentSizeBytes(attachment){
  if (!attachment){
    return 0;
  }
  const value = Number(attachment.size);
  if (!Number.isFinite(value) || value < 0){
    return 0;
  }
  return Math.floor(value);
}

function normalizeAttachmentDisplayPath(value){
  const raw = String(value || "").trim();
  if (!raw){
    return "";
  }
  return raw.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/**
 * Resolve the best available display path for one compose attachment file.
 * @param {object} attachment
 * @param {File} file
 * @returns {string}
 */
function resolveAttachmentDisplayPath(attachment, file){
  const fileName = String(attachment?.name || file?.name || "").trim();
  const candidates = [
    file?.webkitRelativePath,
    file?.relativePath,
    file?.mozFullPath,
    file?.path,
    attachment?.name,
    file?.name
  ];
  for (const candidate of candidates){
    const normalized = normalizeAttachmentDisplayPath(candidate);
    if (!normalized){
      continue;
    }
    if (!fileName){
      return normalized;
    }
    const lowerName = fileName.toLowerCase();
    const lowerPath = normalized.toLowerCase();
    if (lowerPath.endsWith(`/${lowerName}`) || lowerPath === lowerName){
      return normalized;
    }
    return `${normalized.replace(/\/+$/, "")}/${fileName}`;
  }
  return fileName;
}

function sumAttachmentBytes(attachments){
  if (!Array.isArray(attachments) || !attachments.length){
    return 0;
  }
  return attachments.reduce((sum, attachment) => sum + getAttachmentSizeBytes(attachment), 0);
}

function createAttachmentPromptId(){
  const rand = Math.random().toString(16).slice(2);
  return `attach-prompt-${Date.now()}-${rand}`;
}

function getAttachmentPromptIdForWindow(windowId){
  return String(ATTACHMENT_PROMPT_BY_WINDOW.get(windowId) || "");
}

function resolveAttachmentPrompt(promptId, decision = "dismiss", source = ""){
  const entry = ATTACHMENT_PROMPT_BY_ID.get(promptId);
  if (!entry){
    L("compose attachment prompt resolve ignored (missing)", {
      promptId: bgShortId(promptId, 24),
      decision,
      source: source || ""
    });
    return false;
  }
  ATTACHMENT_PROMPT_BY_ID.delete(promptId);
  if (Number.isInteger(entry.tabId) && ATTACHMENT_PROMPT_BY_TAB.get(entry.tabId) === promptId){
    ATTACHMENT_PROMPT_BY_TAB.delete(entry.tabId);
  }
  if (Number.isInteger(entry.windowId) && ATTACHMENT_PROMPT_BY_WINDOW.get(entry.windowId) === promptId){
    ATTACHMENT_PROMPT_BY_WINDOW.delete(entry.windowId);
  }
  const automationState = ATTACHMENT_AUTOMATION_BY_TAB.get(entry.tabId);
  if (automationState?.promptId === promptId){
    automationState.promptId = "";
    if (automationState.phase === "prompt"){
      automationState.phase = "evaluating";
    }
  }
  if (typeof entry.resolve === "function"){
    entry.resolve(decision);
  }
  L("compose attachment prompt resolved", {
    promptId: bgShortId(promptId, 24),
    tabId: entry.tabId || 0,
    decision,
    source: source || ""
  });
  return true;
}

/** Bind once, whether the page or native window creation finishes first */
function bindComposeSharingWindow(session, windowInfo){
  if (session.closed) return null;
  const windowId = Number(windowInfo?.id);
  if (!Number.isInteger(windowId) || windowId <= 0
    || (session.windowId && session.windowId !== windowId)){
    throw new Error("sharing_wizard_window_mismatch");
  }
  if (!session.windowId){
    session.windowId = windowId;
    bindSharingWizardRequestContext(windowId, session.tabId, { mode: session.mode });
  }
  session.resolveWindowReady?.(windowInfo);
  session.resolveWindowReady = null;
  return windowInfo;
}

/** Reserve one wizard per compose before creating or focusing its window */
async function openSharingWizardWindow(tabId, options = null){
  tabId = Number(tabId);
  const existing = COMPOSE_SHARING_BY_TAB.get(tabId);
  if (existing){
    const windowInfo = await existing.openTask;
    if (!existing.closed && windowInfo){
      void focusPopupWindowBestEffort(windowInfo, { label: "sharing" }).catch((error) => {
        console.error("[NCBG] sharing wizard focus failed", error);
      });
      await drainComposeSharingAttachments(existing);
    }
    return windowInfo;
  }
  const session = {
    tabId, windowId: 0, mode: options?.mode === "attachments" ? "attachments" : "default",
    reason: options?.reason || null, ready: false, closed: false, revision: 0, queueRevision: 0,
    port: null, intakeTask: null, batch: null, ack: null, finalizing: false, finished: false
  };
  // Reserve before any asynchronous check so manual and automatic starts share one owner.
  COMPOSE_SHARING_BY_TAB.set(tabId, session);
  const popupUrl = new URL(browser.runtime.getURL("ui/nextcloudSharingWizard.html"));
  popupUrl.searchParams.set("tabId", String(tabId));
  popupUrl.searchParams.set("sessionId", createSecureRuntimeId());
  if (session.mode === "attachments") popupUrl.searchParams.set("attachmentMode", "1");
  session.url = popupUrl.href;
  const windowReady = new Promise((resolve) => { session.resolveWindowReady = resolve; });
  // Both native completion and the authenticated page use the same window binding.
  // Neither queue intake nor the opening caller may wait for the first native focus.
  const windowCreation = (async () => {
    if (await hasComposeSharingBlock(tabId)){
      COMPOSE_SHARING_BY_TAB.delete(tabId);
      session.closed = true;
      session.resolveWindowReady = null;
      await showComposeShareBlockedNotification("sharing_compose_existing_share");
      return null;
    }
    const promptId = getComposeAttachmentAutomationState(tabId).promptId;
    if (promptId){
      const prompt = ATTACHMENT_PROMPT_BY_ID.get(promptId);
      resolveAttachmentPrompt(promptId, "dismiss", "sharing_wizard_opened");
      if (prompt?.windowId) await browser.windows.remove(prompt.windowId);
    }
    if (session.closed) return null;
    const windowInfo = await browser.windows.create({
      url: session.url, type: "popup",
      width: SHARING_POPUP_WIDTH, height: SHARING_POPUP_HEIGHT
    });
    if (session.tabClosed){
      if (!session.closeTask) await browser.windows.remove(windowInfo.id);
      return null;
    }
    return bindComposeSharingWindow(session, windowInfo);
  })().catch(async (error) => {
    if (session.windowId){
      await releaseComposeAttachmentWizard(session.windowId, "window_creation_failed");
    }else{
      session.closed = true;
      session.resolveWindowReady = null;
      if (COMPOSE_SHARING_BY_TAB.get(tabId) === session) COMPOSE_SHARING_BY_TAB.delete(tabId);
    }
    console.error("[NCBG] sharing wizard creation failed", error);
    throw error;
  });
  session.openTask = Promise.race([windowCreation, windowReady]);
  const windowInfo = await session.openTask;
  if (windowInfo && !session.closed){
    // Focus retries are cosmetic and never gate queue ownership or intake.
    void focusPopupWindowBestEffort(windowInfo, { label: "sharing" }).catch((error) => {
      console.error("[NCBG] sharing wizard focus failed", error);
    });
  }
  return windowInfo;
}

async function listComposeAttachments(tabId){
  const attachments = await browser.compose.listAttachments(tabId);
  if (!Array.isArray(attachments)){
    L("compose attachments listed", { tabId, count: 0 });
    return [];
  }
  L("compose attachments listed", { tabId, count: attachments.length });
  return attachments;
}

/**
 * Resolve attachment File objects for the current compose tab.
 * @param {number} tabId
 * @param {Array<object>} attachments
 * @returns {Promise<Array<object>>}
 */
async function collectComposeAttachmentFiles(tabId, attachments){
  const out = [];
  for (const attachment of attachments){
    const attachmentId = Number(attachment?.id);
    if (!Number.isInteger(attachmentId) || attachmentId < 0){
      throw new Error(`compose attachment id is invalid: ${attachment?.id}`);
    }
    const file = await browser.compose.getAttachmentFile(attachmentId);
    if (!(file instanceof File)){
      throw new Error(`compose.getAttachmentFile returned invalid file for attachment ${attachmentId}`);
    }
    out.push({
      attachmentId,
      name: attachment?.name || file.name || "",
      size: getAttachmentSizeBytes(attachment) || Number(file.size) || 0,
      displayPath: resolveAttachmentDisplayPath(attachment, file),
      file
    });
  }
  L("compose attachment files collected", {
    tabId,
    requested: Array.isArray(attachments) ? attachments.length : 0,
    collected: out.length
  });
  return out;
}

async function removeComposeAttachments(tabId, attachmentIds){
  const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
  L("compose attachments remove requested", { tabId, count: ids.length });
  markComposeAttachmentSuppressed(tabId, true);
  try{
    for (const attachmentId of ids){
      await browser.compose.removeAttachment(tabId, attachmentId);
    }
    L("compose attachments removed", { tabId, count: ids.length });
  }finally{
    setTimeout(() => {
      markComposeAttachmentSuppressed(tabId, false);
    }, 0);
  }
}

function buildAttachmentLaunchReason({ trigger, totalBytes, thresholdMb, lastAdded } = {}){
  if (trigger === "threshold"){
    return {
      trigger,
      totalBytes: Number(totalBytes) || 0,
      thresholdMb: Number(thresholdMb) || ATTACHMENT_DEFAULT_THRESHOLD_MB,
      lastName: String(lastAdded?.name || ""),
      lastSizeBytes: Number(lastAdded?.sizeBytes || 0) || 0,
      lastCount: Number(lastAdded?.count || 0) || 0
    };
  }
  return { trigger: "always" };
}

/** Open the common wizard; its acknowledged queue handoff adopts the attachments */
async function startComposeAttachmentShareFlow(tabId, context = {}){
  const guard = await assertAttachmentAutomationAllowed("start_flow", tabId);
  if (!guard.ok) return;
  await NCPolicyRuntime.assertManagedAccess();
  const state = ATTACHMENT_AUTOMATION_BY_TAB.get(tabId);
  if (state?.disposed) return;
  await openSharingWizardWindow(tabId, {
    mode: "attachments", reason: buildAttachmentLaunchReason(context)
  });
}

/**
 * Open the threshold decision prompt and wait for the user decision.
 * @param {{tabId:number,totalBytes:number,thresholdMb:number,lastAdded:object}} options
 * @returns {Promise<"share"|"remove_last"|"dismiss">}
 */
async function showComposeAttachmentThresholdPrompt({
  tabId,
  totalBytes,
  thresholdMb,
  lastAdded
} = {}){
  if (ATTACHMENT_PROMPT_BY_TAB.has(tabId)){
    L("compose attachment prompt skipped (already open)", { tabId });
    return "dismiss";
  }
  const promptId = createAttachmentPromptId();
  const promptUrl = new URL(browser.runtime.getURL("ui/composeAttachmentPrompt.html"));
  promptUrl.searchParams.set("promptId", promptId);
  promptUrl.searchParams.set("tabId", String(tabId));
  promptUrl.searchParams.set("totalBytes", String(Math.max(0, Number(totalBytes) || 0)));
  promptUrl.searchParams.set("thresholdMb", String(Math.max(1, Number(thresholdMb) || ATTACHMENT_DEFAULT_THRESHOLD_MB)));
  promptUrl.searchParams.set("lastName", String(lastAdded?.name || ""));
  promptUrl.searchParams.set("lastSizeBytes", String(Math.max(0, Number(lastAdded?.sizeBytes || 0))));

  const decisionPromise = new Promise((resolve) => {
    ATTACHMENT_PROMPT_BY_ID.set(promptId, {
      tabId,
      windowId: 0,
      resolve
    });
  });
  ATTACHMENT_PROMPT_BY_TAB.set(tabId, promptId);
  const automationState = getComposeAttachmentAutomationState(tabId);
  automationState.phase = "prompt";
  automationState.promptId = promptId;

  try{
    const promptWindow = await browser.windows.create({
      url: promptUrl.toString(),
      type: "popup",
      width: ATTACHMENT_PROMPT_WIDTH,
      height: ATTACHMENT_PROMPT_HEIGHT
    });
    const entry = ATTACHMENT_PROMPT_BY_ID.get(promptId);
    if (!entry){
      return "dismiss";
    }
    entry.windowId = Number(promptWindow?.id) || 0;
    if (entry.windowId > 0){
      ATTACHMENT_PROMPT_BY_WINDOW.set(entry.windowId, promptId);
    }
    L("compose attachment prompt opened", {
      promptId: bgShortId(promptId, 24),
      tabId,
      totalBytes: Number(totalBytes) || 0,
      thresholdMb: Number(thresholdMb) || ATTACHMENT_DEFAULT_THRESHOLD_MB
    });
    return decisionPromise;
  }catch(error){
    console.error("[NCBG] compose attachment prompt open failed", error);
    resolveAttachmentPrompt(promptId, "dismiss", "open_failed");
    throw error;
  }
}

/**
 * Evaluate whether attachment automation should trigger for the compose tab.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function evaluateComposeAttachmentThreshold(tabId){
  if (!Number.isInteger(tabId) || tabId <= 0){
    return;
  }
  if (ATTACHMENT_SUPPRESSED_TABS.has(tabId)){
    return;
  }
  if (ATTACHMENT_PROMPT_BY_TAB.has(tabId)){
    return;
  }
  const session = COMPOSE_SHARING_BY_TAB.get(tabId);
  if (session){
    await drainComposeSharingAttachments(session);
    return;
  }
  if (await hasComposeSharingBlock(tabId)){
    ATTACHMENT_PENDING_ADDED_BY_TAB.delete(tabId);
    await showComposeShareBlockedNotification("sharing_compose_existing_share");
    return;
  }
  const guard = await assertAttachmentAutomationAllowed("evaluate", tabId);
  if (!guard.ok){
    ATTACHMENT_PENDING_ADDED_BY_TAB.delete(tabId);
    return;
  }
  const settings = await getComposeAttachmentAutomationSettings();
  if (!settings.alwaysConnector && !settings.offerAboveEnabled){
    ATTACHMENT_PENDING_ADDED_BY_TAB.delete(tabId);
    L("compose attachment evaluation skipped (automation disabled)", { tabId });
    return;
  }
  const attachments = await listComposeAttachments(tabId);
  if (!attachments.length){
    ATTACHMENT_PENDING_ADDED_BY_TAB.delete(tabId);
    L("compose attachment evaluation skipped (no attachments)", { tabId });
    return;
  }
  const totalBytes = sumAttachmentBytes(attachments);
  const pendingAddedBatch = takeComposeAddedAttachmentBatch(tabId);
  const attachmentIdSet = new Set(attachments
    .map((entry) => Number(entry?.id))
    .filter((id) => Number.isInteger(id) && id >= 0));
  const scopedPendingBatch = pendingAddedBatch.filter((entry) => attachmentIdSet.has(entry.id));
  const fallbackLatest = attachments[attachments.length - 1] || null;
  const lastAdded = scopedPendingBatch.length
    ? {
      ids: scopedPendingBatch.map((entry) => entry.id),
      name: scopedPendingBatch[scopedPendingBatch.length - 1]?.name || "",
      sizeBytes: scopedPendingBatch.reduce((sum, entry) => sum + (Number(entry.sizeBytes) || 0), 0),
      count: scopedPendingBatch.length
    }
    : {
      ids: fallbackLatest?.id !== undefined && fallbackLatest?.id !== null ? [Number(fallbackLatest.id)] : [],
      name: fallbackLatest?.name || "",
      sizeBytes: getAttachmentSizeBytes(fallbackLatest),
      count: fallbackLatest ? 1 : 0
    };
  L("compose attachment evaluation", {
    tabId,
    attachmentCount: attachments.length,
    totalBytes,
    lastAddedCount: lastAdded.count || 0,
    alwaysConnector: settings.alwaysConnector,
    offerAboveEnabled: settings.offerAboveEnabled,
    thresholdBytes: settings.thresholdBytes
  });

  if (settings.alwaysConnector){
    await startComposeAttachmentShareFlow(tabId, {
      trigger: "always"
    });
    return;
  }

  if (!settings.offerAboveEnabled || totalBytes <= settings.thresholdBytes){
    return;
  }

  const decision = await showComposeAttachmentThresholdPrompt({
    tabId,
    totalBytes,
    thresholdMb: settings.thresholdMb,
    lastAdded
  });
  const guardAfterPrompt = await assertAttachmentAutomationAllowed("after_prompt", tabId, {
    decision
  });
  if (!guardAfterPrompt.ok){
    settleComposeAttachmentPromptBatch(tabId, "dismiss");
    return;
  }
  settleComposeAttachmentPromptBatch(tabId, decision);
  if (decision === "share"){
    L("compose attachment threshold decision", {
      tabId,
      decision,
      totalBytes,
      thresholdBytes: settings.thresholdBytes
    });
    await startComposeAttachmentShareFlow(tabId, {
      trigger: "threshold",
      totalBytes,
      thresholdMb: settings.thresholdMb,
      lastAdded
    });
    return;
  }
  if (decision === "remove_last"){
    const removeIds = Array.isArray(lastAdded?.ids)
      ? lastAdded.ids.filter((id) => Number.isInteger(Number(id)) && Number(id) >= 0).map((id) => Number(id))
      : [];
    L("compose attachment threshold decision", {
      tabId,
      decision,
      removeCount: removeIds.length
    });
    if (removeIds.length){
      await removeComposeAttachments(tabId, removeIds);
    }
    return;
  }
  L("compose attachment threshold decision", { tabId, decision: "dismiss" });
}

async function handleComposeAttachmentAdded(tab, attachment){
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0){
    return;
  }
  if (ATTACHMENT_SUPPRESSED_TABS.has(tabId)){
    L("compose attachment add ignored (suppressed)", { tabId });
    return;
  }
  const session = COMPOSE_SHARING_BY_TAB.get(tabId);
  if (session){
    session.revision++;
    await drainComposeSharingAttachments(session);
    return;
  }
  queueComposeAddedAttachment(tabId, attachment);
  L("compose attachment added", {
    tabId,
    attachmentId: attachment?.id ?? null,
    name: String(attachment?.name || ""),
    sizeBytes: getAttachmentSizeBytes(attachment)
  });
  scheduleComposeAttachmentEvaluation(tabId);
}

function cleanupComposeAttachmentTabState(tabId, reason = ""){
  if (!Number.isInteger(tabId) || tabId <= 0){
    return;
  }
  clearComposeAttachmentEvalTimer(tabId);
  ATTACHMENT_PENDING_ADDED_BY_TAB.delete(tabId);
  ATTACHMENT_SUPPRESSED_TABS.delete(tabId);
  const promptId = ATTACHMENT_PROMPT_BY_TAB.get(tabId);
  if (promptId){
    resolveAttachmentPrompt(promptId, "dismiss", reason || "tab_closed");
  }
  const automationState = ATTACHMENT_AUTOMATION_BY_TAB.get(tabId);
  if (automationState) automationState.disposed = true;
  const session = COMPOSE_SHARING_BY_TAB.get(tabId);
  if (session){
    session.tabClosed = true;
    session.closed = true;
    session.resolveWindowReady?.(null);
    session.resolveWindowReady = null;
    if (session.windowId){
      void releaseComposeAttachmentWizard(session.windowId, reason)
        .then(() => browser.windows.remove(session.windowId))
        .catch(reportComposeSharingIntakeError);
    }else{
      COMPOSE_SHARING_BY_TAB.delete(tabId);
    }
  }
  ATTACHMENT_AUTOMATION_BY_TAB.delete(tabId);
  L("compose attachment tab state cleaned", { tabId, reason: reason || "" });
}
