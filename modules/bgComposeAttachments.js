/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Compose attachment and sharing-launch runtime module.
 * Owns attachment automation, threshold prompt flow, and launch context handling.
 */

function pruneSharingLaunchContexts(){
  const cutoff = Date.now() - SHARING_LAUNCH_CONTEXT_TTL_MS;
  for (const [contextId, entry] of SHARING_LAUNCH_CONTEXTS.entries()){
    if (!entry || typeof entry.created !== "number" || entry.created < cutoff){
      SHARING_LAUNCH_CONTEXTS.delete(contextId);
    }
  }
}

/**
 * Create a unique context id for the compose sharing launch flow.
 * @returns {string}
 */
function createSharingLaunchContextId(){
  const rand = Math.random().toString(16).slice(2);
  return `sharing-${Date.now()}-${rand}`;
}

/**
 * Store a one-time launch context for the compose sharing wizard.
 * @param {object} entry
 * @returns {string}
 */
function setSharingLaunchContext(entry){
  pruneSharingLaunchContexts();
  const contextId = createSharingLaunchContextId();
  const next = Object.assign({}, entry || {}, { created: Date.now() });
  SHARING_LAUNCH_CONTEXTS.set(contextId, next);
  L("sharing launch context stored", {
    contextId: bgShortId(contextId, 24),
    mode: next?.mode || "",
    attachmentCount: Array.isArray(next?.attachments) ? next.attachments.length : 0
  });
  return contextId;
}

/**
 * Read and consume a one-time launch context.
 * @param {string} contextId
 * @returns {object|null}
 */
function takeSharingLaunchContext(contextId){
  if (!contextId) return null;
  pruneSharingLaunchContexts();
  const entry = SHARING_LAUNCH_CONTEXTS.get(contextId) || null;
  SHARING_LAUNCH_CONTEXTS.delete(contextId);
  L("sharing launch context consumed", {
    contextId: bgShortId(contextId, 24),
    found: !!entry
  });
  return entry;
}

/**
 * Clear pending threshold-evaluation timer for one compose tab.
 * @param {number} tabId
 */
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

/**
 * Debounce threshold-evaluation after attachment changes.
 * @param {number} tabId
 */
function scheduleComposeAttachmentEvaluation(tabId){
  if (!Number.isInteger(tabId) || tabId <= 0){
    return;
  }
  clearComposeAttachmentEvalTimer(tabId);
  const timerId = setTimeout(() => {
    ATTACHMENT_EVAL_TIMER_BY_TAB.delete(tabId);
    evaluateComposeAttachmentThreshold(tabId).catch((error) => {
      console.error("[NCBG] evaluateComposeAttachmentThreshold failed", error);
    });
  }, ATTACHMENT_EVAL_DEBOUNCE_MS);
  ATTACHMENT_EVAL_TIMER_BY_TAB.set(tabId, timerId);
  L("compose attachment evaluation scheduled", {
    tabId,
    debounceMs: ATTACHMENT_EVAL_DEBOUNCE_MS
  });
}

/**
 * Queue one added attachment for threshold batch handling.
 * @param {number} tabId
 * @param {object} attachment
 */
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

/**
 * Read and clear one tab's pending added-attachment batch.
 * @param {number} tabId
 * @returns {Array<{id:number,name:string,sizeBytes:number}>}
 */
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

/**
 * Return true when a backend share policy explicitly contains a key.
 * @param {object} policyStatus
 * @param {string} key
 * @returns {boolean}
 */
function hasAttachmentAutomationPolicyKey(policyStatus, key){
  const sharePolicy = policyStatus?.policy?.share;
  return !!sharePolicy && Object.prototype.hasOwnProperty.call(sharePolicy, key);
}

/**
 * Read compose attachment automation settings from storage.
 * @returns {Promise<{alwaysConnector:boolean,offerAboveEnabled:boolean,thresholdMb:number,thresholdBytes:number}>}
 */
async function getComposeAttachmentAutomationSettings(){
  const keys = SHARING_KEYS || {};
  const stored = await browser.storage.local.get([
    keys.attachmentsAlwaysConnector,
    keys.attachmentsOfferAboveEnabled,
    keys.attachmentsOfferAboveMb
  ]);
  let alwaysConnector = !!stored[keys.attachmentsAlwaysConnector];
  let offerAboveEnabled = stored[keys.attachmentsOfferAboveEnabled] !== undefined
    ? !!stored[keys.attachmentsOfferAboveEnabled]
    : true;
  let thresholdMb = normalizeAttachmentThresholdMb(stored[keys.attachmentsOfferAboveMb]);

  if (typeof NCPolicyRuntime !== "undefined" && NCPolicyRuntime?.getPolicyStatus){
    try{
      const policyStatus = await NCPolicyRuntime.getPolicyStatus();
      if (policyStatus?.policyActive){
        if (NCPolicyRuntime.isLocked(policyStatus, "share", "attachments_always_via_ncconnector")){
          alwaysConnector = !!NCPolicyRuntime.readPolicyValue(
            policyStatus,
            "share",
            "attachments_always_via_ncconnector"
          );
        }
        if (
          NCPolicyRuntime.isLocked(policyStatus, "share", "attachments_min_size_mb")
          && hasAttachmentAutomationPolicyKey(policyStatus, "attachments_min_size_mb")
        ){
          const policyThreshold = NCPolicyRuntime.readPolicyValue(
            policyStatus,
            "share",
            "attachments_min_size_mb"
          );
          if (policyThreshold == null){
            offerAboveEnabled = false;
          }else{
            thresholdMb = normalizeAttachmentThresholdMb(Number(policyThreshold) || 0);
            offerAboveEnabled = true;
          }
        }
      }
    }catch(error){
      L("compose attachment automation policy status fallback", {
        reason: "policy_runtime_failed",
        error: error?.message || String(error)
      });
    }
  }
  return {
    alwaysConnector,
    offerAboveEnabled: !alwaysConnector && offerAboveEnabled,
    thresholdMb,
    thresholdBytes: thresholdMb * 1024 * 1024
  };
}

/**
 * Return attachment size in bytes.
 * @param {object} attachment
 * @returns {number}
 */
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

/**
 * Normalize display paths to slash-separated strings.
 * @param {string} value
 * @returns {string}
 */
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

/**
 * Sum attachment sizes.
 * @param {Array<object>} attachments
 * @returns {number}
 */
function sumAttachmentBytes(attachments){
  if (!Array.isArray(attachments) || !attachments.length){
    return 0;
  }
  return attachments.reduce((sum, attachment) => sum + getAttachmentSizeBytes(attachment), 0);
}

/**
 * Create a unique prompt id for the attachment threshold decision popup.
 * @returns {string}
 */
function createAttachmentPromptId(){
  const rand = Math.random().toString(16).slice(2);
  return `attach-prompt-${Date.now()}-${rand}`;
}

/**
 * Resolve an open attachment threshold prompt.
 * @param {string} promptId
 * @param {"share"|"remove_last"|"dismiss"} decision
 * @param {string} source
 * @returns {boolean}
 */
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

/**
 * Open sharing wizard popup and optionally attach a one-time launch context.
 * @param {number} tabId
 * @param {object|null} launchContext
 * @returns {Promise<object>}
 */
async function openSharingWizardWindow(tabId, launchContext = null){
  const popupUrl = new URL(browser.runtime.getURL("ui/nextcloudSharingWizard.html"));
  popupUrl.searchParams.set("tabId", String(tabId));
  let contextId = "";
  if (launchContext && typeof launchContext === "object"){
    contextId = setSharingLaunchContext(launchContext);
    popupUrl.searchParams.set("launchContextId", contextId);
  }
  const windowInfo = await browser.windows.create({
    url: popupUrl.toString(),
    type: "popup",
    width: SHARING_POPUP_WIDTH,
    height: SHARING_POPUP_HEIGHT
  });
  const focusApplied = await focusPopupWindowBestEffort(windowInfo, {
    label: "sharing wizard popup"
  });
  L("sharing wizard popup opened", {
    tabId,
    windowId: Number(windowInfo?.id) || 0,
    contextId: bgShortId(contextId, 24),
    mode: launchContext?.mode || "default",
    focusApplied
  });
  return windowInfo;
}

/**
 * List attachments currently present in one compose tab.
 * @param {number} tabId
 * @returns {Promise<Array<object>>}
 */
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

/**
 * Remove selected attachments from compose tab.
 * @param {number} tabId
 * @param {Array<number|string>} attachmentIds
 * @returns {Promise<void>}
 */
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

/**
 * Build reason payload for attachment-mode sharing wizard launches.
 * @param {{trigger?:string,totalBytes?:number,thresholdMb?:number,lastAdded?:object}} options
 * @returns {object}
 */
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

/**
 * Start the compose-attachment share flow:
 * - collect current attachments
 * - remove them from compose
 * - launch sharing wizard in attachment mode
 * @param {number} tabId
 * @param {object} context
 * @returns {Promise<void>}
 */
async function startComposeAttachmentShareFlow(tabId, context = {}){
  const guard = await assertAttachmentAutomationAllowed("start_flow", tabId, {
    trigger: String(context?.trigger || "")
  });
  if (!guard.ok){
    return;
  }
  const attachments = await listComposeAttachments(tabId);
  if (!attachments.length){
    L("compose attachment flow skipped (no attachments)", { tabId });
    return;
  }
  const collected = await collectComposeAttachmentFiles(tabId, attachments);
  if (!collected.length){
    L("compose attachment flow skipped (no collectible files)", { tabId });
    return;
  }
  const launchContext = {
    mode: "attachments",
    reason: buildAttachmentLaunchReason(context),
    attachments: collected.map((item) => ({
      sourceAttachmentId: item.attachmentId,
      name: item.name,
      sizeBytes: item.size,
      displayPath: item.displayPath || item.name || "",
      file: item.file
    }))
  };
  L("compose attachment flow start", {
    tabId,
    trigger: launchContext.reason?.trigger || "",
    attachmentCount: launchContext.attachments.length
  });
  await removeComposeAttachments(tabId, collected.map((item) => item.attachmentId));
  await openSharingWizardWindow(tabId, launchContext);
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
    ATTACHMENT_PROMPT_BY_TAB.set(tabId, promptId);
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
    return;
  }
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

/**
 * Listener callback for compose.onAttachmentAdded.
 * @param {object} tab
 * @param {object} attachment
 * @returns {Promise<void>}
 */
async function handleComposeAttachmentAdded(tab, attachment){
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0){
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

/**
 * Cleanup attachment automation runtime state for one compose tab.
 * @param {number} tabId
 * @param {string} reason
 */
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
  L("compose attachment tab state cleaned", { tabId, reason: reason || "" });
}
