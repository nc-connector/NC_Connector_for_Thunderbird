"use strict";

const vm = require("node:vm");
const { assert, readText } = require("./review-check-utils");

function createDeferred(){
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message){
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline){
    if (predicate()){
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function createFakeTimers(){
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay){
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id){
      timers.delete(id);
    }
  };
}

function createHarness(){
  const timers = createFakeTimers();
  const connectListeners = [];
  const attachments = new Map();
  let runtimeId = 0;
  const calls = {
    windowsCreate: 0,
    windowsRemove: [],
    windowsUpdate: [],
    tabsUpdate: [],
    attachmentsRemoved: [],
    attachmentsAdded: [],
    notifications: []
  };
  const control = {
    windowCreate: async () => ({ id: 91 }),
    windowUpdate: async () => {},
    windowFocused: true,
    removeAttachment: async () => {},
    addAttachment: async () => {},
    composeDetails: { customHeaders: [] },
    hasShareCleanup: false
  };
  const TestFile = class File {
    constructor(name, size = 0){
      this.name = name;
      this.size = size;
    }
  };
  const context = {
    URL,
    Map,
    Set,
    Promise,
    Object,
    Number,
    String,
    Date,
    POPUP_FOCUS_RETRY_DELAYS_MS: [0],
    waitMs: async () => {},
    File: TestFile,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: { error(){} },
    globalThis: null,
    SHARING_WIZARD_REQUEST_BY_WINDOW: new Map(),
    ATTACHMENT_PROMPT_BY_ID: new Map(),
    ATTACHMENT_PROMPT_BY_TAB: new Map(),
    ATTACHMENT_PROMPT_BY_WINDOW: new Map(),
    ATTACHMENT_EVAL_TIMER_BY_TAB: new Map(),
    ATTACHMENT_PENDING_ADDED_BY_TAB: new Map(),
    ATTACHMENT_SUPPRESSED_TABS: new Set(),
    ATTACHMENT_AUTOMATION_BY_TAB: new Map(),
    ATTACHMENT_EVAL_DEBOUNCE_MS: 250,
    ATTACHMENT_DEFAULT_THRESHOLD_MB: 20,
    ATTACHMENT_PROMPT_WIDTH: 560,
    ATTACHMENT_PROMPT_HEIGHT: 260,
    SHARING_POPUP_WIDTH: 660,
    SHARING_POPUP_HEIGHT: 760,
    SHARING_KEYS: {},
    COMPOSE_SHARE_DRAFT_HEADER: "X-NCC-Share-Draft",
    createSecureRuntimeId(){ return `test-session-${++runtimeId}`; },
    hasComposeShareCleanup(){ return control.hasShareCleanup; },
    async showComposeShareBlockedNotification(key){ calls.notifications.push(key); },
    NCPolicyRuntime: { assertManagedAccess: async () => null },
    L(){},
    bgShortId(value){
      return String(value || "");
    },
    getAttachmentSizeBytes(attachment){
      return attachment?.size || 0;
    },
    browser: {
      runtime: {
        id: "test-addon",
        onConnect: { addListener(listener){ connectListeners.push(listener); } },
        getURL(path){
          return `moz-extension://test/${path}`;
        }
      },
      windows: {
        async create(options){
          calls.windowsCreate += 1;
          return control.windowCreate(options);
        },
        async remove(windowId){
          calls.windowsRemove.push(windowId);
        },
        async update(windowId, update){
          calls.windowsUpdate.push({ windowId, update });
          await control.windowUpdate(windowId, update);
        },
        async get(){
          return { focused: control.windowFocused };
        }
      },
      tabs: {
        async update(tabId, update){ calls.tabsUpdate.push({ tabId, update }); }
      },
      compose: {
        async getComposeDetails(){ return control.composeDetails; },
        async listAttachments(){
          return [...attachments.values()].map((item) => ({
            id: item.attachmentId, name: item.name, size: item.size
          }));
        },
        async getAttachmentFile(id){ return attachments.get(id)?.file; },
        async removeAttachment(tabId, attachmentId){
          calls.attachmentsRemoved.push({ tabId, attachmentId });
          await control.removeAttachment(tabId, attachmentId);
          attachments.delete(attachmentId);
        },
        async addAttachment(tabId, attachment){
          calls.attachmentsAdded.push({ tabId, attachment });
          await control.addAttachment(tabId, attachment);
          const attachmentId = 1000 + calls.attachmentsAdded.length;
          attachments.set(attachmentId, { attachmentId, name: attachment.name,
            size: attachment.file.size, displayPath: attachment.name, file: attachment.file });
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  const stateSource = readText("modules/bgState.js");
  const focusStart = stateSource.indexOf("async function focusPopupWindowBestEffort(");
  const focusEnd = stateSource.indexOf("async function isNextcloudAccountConfigured(", focusStart);
  assert(focusStart >= 0 && focusEnd > focusStart, "The real popup focus helper must be available");
  vm.runInContext(stateSource.slice(focusStart, focusEnd), context, { filename: "modules/bgState.js" });
  vm.runInContext(readText("modules/bgComposeAttachments.js"), context, {
    filename: "modules/bgComposeAttachments.js"
  });
  return { context, control, calls, timers, attachments, connectListeners };
}

async function checkSerializedEvaluation(){
  const harness = createHarness();
  const first = createDeferred();
  const second = createDeferred();
  const gates = [first, second];
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  harness.context.__testEvaluate = async () => {
    const gate = gates[calls];
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active -= 1;
  };
  vm.runInContext(
    "evaluateComposeAttachmentThreshold = globalThis.__testEvaluate;",
    harness.context
  );

  const one = harness.context.requestComposeAttachmentEvaluation(11);
  const two = harness.context.requestComposeAttachmentEvaluation(11);
  const three = harness.context.requestComposeAttachmentEvaluation(11);
  assert(calls === 1, "Concurrent attachment evaluations must share one active task");
  first.resolve();
  await waitFor(() => calls === 2, "One queued attachment evaluation must run after the active task");
  second.resolve();
  await Promise.all([one, two, three]);
  assert(calls === 2, "Multiple overlapping requests must collapse into one rerun");
  assert(maxActive === 1, "Attachment evaluations must never overlap for one compose tab");
}

async function checkPromptReservation(){
  const harness = createHarness();
  const windowCreated = createDeferred();
  harness.control.windowCreate = () => windowCreated.promise;

  const first = harness.context.showComposeAttachmentThresholdPrompt({
    tabId: 12,
    totalBytes: 30,
    thresholdMb: 20,
    lastAdded: { name: "one.bin", sizeBytes: 30 }
  });
  await Promise.resolve();
  const second = await harness.context.showComposeAttachmentThresholdPrompt({
    tabId: 12,
    totalBytes: 30,
    thresholdMb: 20,
    lastAdded: { name: "one.bin", sizeBytes: 30 }
  });
  assert(second === "dismiss", "A reserved prompt must reject a duplicate prompt request");
  assert(harness.calls.windowsCreate === 1, "Prompt ownership must be reserved before window creation completes");

  const promptId = harness.context.ATTACHMENT_PROMPT_BY_TAB.get(12);
  assert(!!promptId, "The compose tab must own the prompt while window creation is pending");
  windowCreated.resolve({ id: 92 });
  await waitFor(
    () => harness.context.ATTACHMENT_PROMPT_BY_WINDOW.get(92) === promptId,
    "The created prompt window must be associated with the reservation"
  );
  harness.context.resolveAttachmentPrompt(promptId, "dismiss", "test");
  assert(await first === "dismiss", "The reserved prompt must settle through its single decision");
}

function checkPromptBatchSettlement(){
  const harness = createHarness();
  const pending = harness.context.ATTACHMENT_PENDING_ADDED_BY_TAB;

  pending.set(13, [{ id: 1 }]);
  harness.context.settleComposeAttachmentPromptBatch(13, "dismiss");
  assert(!pending.has(13), "Dismiss must discard additions queued behind the dismissed prompt");

  pending.set(14, [{ id: 2 }]);
  harness.context.settleComposeAttachmentPromptBatch(14, "share");
  assert(!pending.has(14), "Share must consume the pending compose attachment set");

  pending.set(15, [{ id: 3 }]);
  harness.context.settleComposeAttachmentPromptBatch(15, "remove_last");
  assert(pending.has(15), "Remove-last must retain later additions for one follow-up evaluation");
  assert(
    harness.context.ATTACHMENT_AUTOMATION_BY_TAB.get(15)?.rerunRequested === true,
    "Remove-last must schedule the retained attachment batch"
  );
}

function createCollectedAttachments(harness, names){
  return names.map((name, index) => ({
    attachmentId: index + 1,
    name,
    size: 100 + index,
    displayPath: name,
    file: new harness.context.File(name, 100 + index)
  }));
}

function installCollectedFlow(harness, collected){
  harness.context.assertAttachmentAutomationAllowed = async () => ({ ok:true });
  collected.forEach((item) => harness.attachments.set(item.attachmentId, item));
}

function getSession(harness, tabId){
  return vm.runInContext(`COMPOSE_SHARING_BY_TAB.get(${tabId})`, harness.context);
}

function connectQueue(harness, tabId, {
  accept = true, apply = true, senderUrl, windowId = 91, senderWindowId = windowId
} = {}){
  const session = getSession(harness, tabId);
  let onMessage;
  let onDisconnect;
  let disconnected = false;
  const port = {
    name: "nc-sharing-compose",
    sender: { id: "test-addon", url: senderUrl || session.url,
      tab: { id: 191, windowId: senderWindowId } },
    posted: [],
    onMessage: { addListener(listener){ onMessage = listener; } },
    onDisconnect: { addListener(listener){ onDisconnect = listener; } },
    postMessage(message){
      port.posted.push(message);
      if (message.type === "attachments" && accept){
        onMessage({ type: "accepted", batchId: message.batchId });
      }
      if (message.type === "committed" && apply){
        onMessage({ type: "applied", batchId: message.batchId });
      }
    },
    emitMessage(message){ return onMessage(message); },
    disconnect(){
      if (disconnected) return;
      disconnected = true;
      onDisconnect?.();
    }
  };
  harness.connectListeners.forEach((listener) => listener(port));
  port.emitMessage({ type: "ready", tabId, windowId });
  return port;
}

async function waitForIdle(harness, tabId){
  await waitFor(() => {
    const session = getSession(harness, tabId);
    return session?.ready && !session.intakeTask && !session.batch;
  }, "The compose queue must settle its acknowledged batch");
}

async function checkWizardOwnership(){
  const harness = createHarness();
  installCollectedFlow(harness, []);
  const windowCreated = createDeferred();
  harness.control.windowCreate = () => windowCreated.promise;
  const first = harness.context.openSharingWizardWindow(16);
  const automatic = harness.context.startComposeAttachmentShareFlow(16, { trigger:"always" });
  const repeated = harness.context.openSharingWizardWindow(16);
  await waitFor(() => harness.calls.windowsCreate === 1, "The first wizard must be opening");
  windowCreated.resolve({ id:93 });
  await Promise.all([first, automatic, repeated]);
  assert(harness.calls.windowsCreate === 1, "Manual, repeated and automated starts must reuse one reserved wizard");
  assert(getSession(harness, 16).mode === "default", "Reusing a manual wizard must preserve its current mode/settings");
  assert(harness.context.isComposeAttachmentRoutingActive(16), "The common wizard must block sending before ready");
  await harness.context.releaseComposeAttachmentWizard(93, "test");
  assert(!harness.context.isComposeAttachmentRoutingActive(16), "Closing must release the common send guard");
  assert(!harness.context.ATTACHMENT_EVAL_TIMER_BY_TAB.has(16), "Closing must not create a second deferred automation path");
}

async function checkEarlyAndLaterDropAdoption(){
  const harness = createHarness();
  const collected = createCollectedAttachments(harness, ["existing.txt", "early.txt", "later.txt"]);
  installCollectedFlow(harness, collected.slice(0, 1));
  await harness.context.openSharingWizardWindow(20);
  harness.attachments.set(2, collected[1]);
  await harness.context.handleComposeAttachmentAdded({ id:20 }, { id:2, name:"early.txt", size:101 });
  assert(harness.calls.attachmentsRemoved.length === 0, "Existing and early-drop files must remain in compose until queue acceptance");
  const port = connectQueue(harness, 20, { accept:false, apply:false });
  await waitFor(() => port.posted.some((message) => message.type === "attachments"), "Ready must offer all current compose attachments");
  const offer = port.posted.find((message) => message.type === "attachments");
  assert(offer.attachments.length === 2, "A drop before queue readiness must join the initial batch");
  assert(offer.attachments[0].file === collected[0].file, "Queue handoff must preserve the original File");
  assert(harness.calls.attachmentsRemoved.length === 0, "An offer alone must not detach originals");
  port.emitMessage({ type:"accepted", batchId:"wrong-batch" });
  await Promise.resolve();
  assert(harness.calls.attachmentsRemoved.length === 0, "Unrelated acknowledgements must not adopt originals");
  port.emitMessage({ type:"accepted", batchId:offer.batchId });
  await waitFor(() => port.posted.some((message) => message.type === "committed"), "Acceptance must detach and commit the batch");
  assert(harness.calls.attachmentsRemoved.length === 2, "The accepted batch must detach exactly once");
  port.emitMessage({ type:"applied", batchId:offer.batchId });
  await waitForIdle(harness, 20);
  assert(getSession(harness, 20).queueRevision === 1, "Only applied batches advance the queue revision");

  harness.attachments.set(3, collected[2]);
  const drop = harness.context.handleComposeAttachmentAdded({ id:20 }, { id:3, name:"later.txt", size:102 });
  await waitFor(() => port.posted.filter((message) => message.type === "attachments").length === 2,
    "Drops in earlier wizard steps must reach the same port immediately");
  const second = port.posted.filter((message) => message.type === "attachments")[1];
  assert(second.attachments.length === 1 && second.attachments[0].name === "later.txt", "A live drop must not replay previously adopted files");
  port.emitMessage({ type:"accepted", batchId:second.batchId });
  await waitFor(() => port.posted.filter((message) => message.type === "committed").length === 2, "The live drop must commit");
  port.emitMessage({ type:"applied", batchId:second.batchId });
  await drop;
  await waitForIdle(harness, 20);
  assert(harness.calls.windowsCreate === 1, "Live drops must not open another wizard");
  assert(getSession(harness, 20).queueRevision === 2, "Later batches must advance the same revision");
  await harness.context.releaseComposeAttachmentWizard(91, "cancel_after_adoption");
  assert(harness.calls.attachmentsAdded.length === 0, "Explicit cancellation after adoption must not restore attachments");
}

async function checkQueueWithoutFocusCompletion(){
  const harness = createHarness();
  const focus = createDeferred();
  harness.control.windowCreate = async () => ({ id: 91, tabs: [{ id: 191 }] });
  harness.control.windowUpdate = () => focus.promise;
  harness.control.windowFocused = false;
  installCollectedFlow(harness, createCollectedAttachments(harness, ["drop.txt"]));
  let opened = false;
  const opening = harness.context.startComposeAttachmentShareFlow(28, { trigger: "always" })
    .then(() => { opened = true; });
  await waitFor(() => opened, "Opening must not wait for window-manager focus completion");
  assert(harness.calls.windowsUpdate.length === 1
    && harness.calls.windowsUpdate[0].windowId === 91
    && harness.calls.windowsUpdate[0].update.focused === true,
  "The real focus helper must receive the returned window, not a bare ID");
  connectQueue(harness, 28);
  await waitForIdle(harness, 28);
  assert(harness.attachments.size === 0 && getSession(harness, 28).queueRevision === 1,
    "Attachment adoption must finish without a click, resize or completed focus request");
  focus.resolve();
  await opening;
  await waitFor(() => harness.calls.tabsUpdate.length === 1, "The created popup tab must be activated");
  assert(harness.calls.tabsUpdate[0].tabId === 191, "Tab activation must use the returned window's tab");
  await harness.context.openSharingWizardWindow(28);
  assert(harness.calls.windowsUpdate.length === 2 && harness.calls.windowsCreate === 1,
    "Reopening must focus the same window using the real helper");
  await harness.context.releaseComposeAttachmentWizard(91, "test");
}

async function checkQueueBeforeNativeWindowCreationCompletes(){
  const harness = createHarness();
  const created = createDeferred();
  const focus = createDeferred();
  harness.control.windowCreate = () => created.promise;
  harness.control.windowUpdate = () => focus.promise;
  const files = createCollectedAttachments(harness, ["initial.txt", "later.txt"]);
  installCollectedFlow(harness, files.slice(0, 1));
  let opened = false;
  const opening = harness.context.startComposeAttachmentShareFlow(29, { trigger: "always" })
    .then(() => { opened = true; });
  await waitFor(() => harness.calls.windowsCreate === 1, "Native popup creation must have started");
  connectQueue(harness, 29);
  await waitForIdle(harness, 29);
  await waitFor(() => opened, "The authenticated wizard must settle opening without native focus");
  assert(harness.attachments.size === 0 && getSession(harness, 29).queueRevision === 1,
    "The first batch must be adopted while windows.create is still pending");
  assert(harness.context.getSharingWizardRequestContext(91, 29).attachmentMode === true,
    "The early port handshake must bind the same upload authorization context");
  harness.attachments.set(2, files[1]);
  await harness.context.handleComposeAttachmentAdded({ id: 29 }, { id: 2, name: "later.txt" });
  await waitForIdle(harness, 29);
  assert(harness.attachments.size === 0 && getSession(harness, 29).queueRevision === 2,
    "Later drops must use the same queue without a click or completed window creation");
  await harness.context.openSharingWizardWindow(29);
  assert(harness.calls.windowsCreate === 1, "Repeated entry must reuse the ready but unfocused wizard");
  await harness.context.releaseComposeAttachmentWizard(91, "cancel_before_native_focus");
  created.resolve({ id: 91, tabs: [{ id: 191 }] });
  focus.resolve();
  await opening;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(!getSession(harness, 29) && !harness.context.SHARING_WIZARD_REQUEST_BY_WINDOW.has(91),
    "Late windows.create completion must not resurrect a cancelled session or request context");
}

async function checkQueueSenderBinding(){
  const harness = createHarness();
  const created = createDeferred();
  harness.control.windowCreate = () => created.promise;
  installCollectedFlow(harness, createCollectedAttachments(harness, ["private.txt"]));
  const opening = harness.context.openSharingWizardWindow(30);
  await waitFor(() => harness.calls.windowsCreate === 1, "Popup creation must be pending");
  const wrongWindow = connectQueue(harness, 30, { senderWindowId: 92 });
  const wrongSession = connectQueue(harness, 30, { senderUrl: "moz-extension://test/ui/nextcloudSharingWizard.html" });
  assert(!getSession(harness, 30).ready && harness.attachments.size === 1
    && wrongWindow.posted.length === 0 && wrongSession.posted.length === 0,
  "Wrong window IDs or a URL without the session token must not receive files");
  connectQueue(harness, 30);
  await waitForIdle(harness, 30);
  const owner = harness.context.getSharingWizardRequestContext(91, 30);
  created.resolve({ id: 91, tabs: [{ id: 191 }] });
  await opening;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(harness.context.getSharingWizardRequestContext(91, 30) === owner,
    "Native completion must not bind a second upload context");
  const duplicate = connectQueue(harness, 30);
  assert(duplicate.posted.length === 0 && getSession(harness, 30).queueRevision === 1,
    "Another port must not replay the queue or replace its owner");
  await harness.context.releaseComposeAttachmentWizard(91, "test");
}

async function checkComposeCloseDuringNativeCreation(){
  const harness = createHarness();
  const created = createDeferred();
  harness.control.windowCreate = () => created.promise;
  let settled = false;
  const opening = harness.context.openSharingWizardWindow(31).then((result) => {
    assert(result === null, "Closing compose must cancel the pending opening");
    settled = true;
  });
  await waitFor(() => harness.calls.windowsCreate === 1, "Native popup creation must have started");
  harness.context.cleanupComposeAttachmentTabState(31, "tab_removed");
  await waitFor(() => settled, "Compose closing must not wait for native popup focus");
  assert(!getSession(harness, 31), "Closing must release the reservation before a window ID exists");
  created.resolve({ id: 91 });
  await opening;
  await waitFor(() => harness.calls.windowsRemove.includes(91), "A late popup must close with its compose");
  assert(!harness.context.SHARING_WIZARD_REQUEST_BY_WINDOW.has(91),
    "Late popup completion must not retain an orphaned upload context");
}

async function checkPartialRemovalRollback(){
  const harness = createHarness();
  const collected = createCollectedAttachments(harness, ["one.txt", "two.txt", "three.txt"]);
  installCollectedFlow(harness, collected);
  harness.control.removeAttachment = async (_tabId, attachmentId) => {
    if (attachmentId === 2) throw new Error("remove_failed");
  };
  await harness.context.openSharingWizardWindow(18);
  const session = getSession(harness, 18);
  connectQueue(harness, 18);
  await waitFor(() => harness.calls.attachmentsAdded.length === 1 && !getSession(harness, 18),
    "Partial removal failure must finish restoration");
  assert(harness.calls.attachmentsRemoved.map((call) => call.attachmentId).join(",") === "1,2", "Removal must stop at the first failed attachment");
  assert(harness.calls.attachmentsAdded[0].attachment.file === collected[0].file, "Rollback must reuse the original File");
  assert(harness.calls.attachmentsAdded[0].attachment.name === "one.txt", "Rollback must preserve the original name");
  assert(harness.attachments.size === 3, "A rejected batch must leave all originals available in compose");
  assert(session.queueRevision === 0, "A rolled-back batch must not advance queue ownership");
}

async function checkManagedRefusalRetainsAttachments(){
  const harness = createHarness();
  installCollectedFlow(harness, createCollectedAttachments(harness, ["one.txt", "two.txt"]));
  harness.context.NCPolicyRuntime.assertManagedAccess = async () => { throw new Error("managed_seat_required"); };
  let rejected = false;
  try{
    await harness.context.startComposeAttachmentShareFlow(18, { trigger:"always" });
  }catch(error){ rejected = error.message === "managed_seat_required"; }
  assert(rejected, "Managed refusal must stop a new automated sharing action");
  assert(harness.calls.attachmentsRemoved.length === 0, "Managed refusal must leave original attachments in compose");
  assert(harness.calls.windowsCreate === 0, "Managed refusal must not launch a wizard");
}

async function checkPopupFailureRetainsAttachments(){
  const harness = createHarness();
  installCollectedFlow(harness, createCollectedAttachments(harness, ["one.txt", "two.txt"]));
  harness.control.windowCreate = async () => { throw new Error("popup_failed"); };
  let failed = false;
  try{
    await harness.context.startComposeAttachmentShareFlow(19, { trigger:"always" });
  }catch(error){ failed = error.message === "popup_failed"; }
  assert(failed, "Popup failure must remain visible to the caller");
  assert(harness.calls.attachmentsRemoved.length === 0 && harness.calls.attachmentsAdded.length === 0,
    "Popup failure must not detach or duplicate originals");
  assert(!harness.context.isComposeAttachmentRoutingActive(19), "Popup failure must release the failed reservation");
}

async function checkCloseBeforeAdoptionRollback(){
  const harness = createHarness();
  installCollectedFlow(harness, createCollectedAttachments(harness, ["one.txt", "two.txt"]));
  await harness.context.startComposeAttachmentShareFlow(21, { trigger:"always" });
  const port = connectQueue(harness, 21, { apply:false });
  await waitFor(() => port.posted.some((message) => message.type === "committed"), "The queue must be waiting for final adoption");
  assert(await harness.context.releaseComposeAttachmentWizard(91, "test") === true, "Closing before applied must release the wizard");
  assert(harness.calls.attachmentsAdded.length === 2, "Closing before applied must restore every detached attachment");
  assert(await harness.context.releaseComposeAttachmentWizard(91, "repeat") === false, "Repeated close must not start another rollback");
  assert(harness.calls.attachmentsAdded.length === 2, "Repeated close must not duplicate restored attachments");
}

async function checkRestoreAttemptsAllAttachments(){
  const harness = createHarness();
  installCollectedFlow(harness, createCollectedAttachments(harness, ["one.txt", "two.txt", "three.txt"]));
  harness.control.addAttachment = async (_tabId, attachment) => {
    if (attachment.name === "two.txt") throw new Error("restore_failed");
  };
  await harness.context.openSharingWizardWindow(22);
  const port = connectQueue(harness, 22, { apply:false });
  await waitFor(() => port.posted.some((message) => message.type === "committed"), "The batch must be detached before restoration is tested");
  await harness.context.releaseComposeAttachmentWizard(91, "test");
  const session = getSession(harness, 22);
  assert(harness.calls.attachmentsAdded.length === 3, "Rollback must attempt every detached attachment");
  assert(session.restoreFailed === true, "Failed restoration must preserve the failure state");
  assert(harness.context.isComposeAttachmentRoutingActive(22), "Failed restoration must keep sending blocked");
  assert(session.batch.detached.length === 1, "Only unrestored attachments must remain journaled");
}

async function checkExistingShareBlocksBothEntrypoints(){
  for (const persisted of [false, true]){
    const harness = createHarness();
    installCollectedFlow(harness, createCollectedAttachments(harness, ["ordinary.txt"]));
    harness.control.hasShareCleanup = !persisted;
    if (persisted) harness.control.composeDetails.customHeaders = [{ name:"x-ncc-share-draft", value:"saved-share" }];
    assert(await harness.context.openSharingWizardWindow(26) === null, "Existing share must reject manual reopening");
    await harness.context.handleComposeAttachmentAdded({ id:26 }, { id:1, name:"ordinary.txt", size:100 });
    await harness.context.requestComposeAttachmentEvaluation(26);
    assert(harness.calls.windowsCreate === 0, "Existing shares must suppress both manual and automated wizards");
    assert(harness.calls.attachmentsRemoved.length === 0, "Later files must remain ordinary attachments");
    assert(!harness.context.isComposeAttachmentRoutingActive(26), "An existing completed share must not leave a wizard send guard");
    assert(harness.calls.notifications.includes("sharing_compose_existing_share"), "The user must receive an existing-share notice");
  }
}

async function checkFinalizeRevisionGuard(){
  const harness = createHarness();
  installCollectedFlow(harness, createCollectedAttachments(harness, ["one.txt"]));
  await harness.context.openSharingWizardWindow(27);
  connectQueue(harness, 27);
  await waitForIdle(harness, 27);
  let stale = false;
  try{ await harness.context.lockComposeSharingForFinalize(27, 91, 0); }
  catch(error){ stale = error.message === "sharing_compose_pending_attachments"; }
  assert(stale, "Finalize must reject a stale uploaded queue revision");
  const session = await harness.context.lockComposeSharingForFinalize(27, 91, 1);
  harness.context.assertComposeSharingFinalizationCurrent(session);
  const later = createCollectedAttachments(harness, ["later.txt"])[0];
  later.attachmentId = 2;
  harness.attachments.set(2, later);
  await harness.context.handleComposeAttachmentAdded({ id:27 }, { id:2, name:later.name, size:later.size });
  let changed = false;
  try{ harness.context.assertComposeSharingFinalizationCurrent(session); }
  catch(error){ changed = error.message === "sharing_compose_pending_attachments"; }
  assert(changed, "A drop during finalization must invalidate insertion");
  harness.context.finishComposeSharingFinalize(session, false);
  await waitForIdle(harness, 27);
  assert(session.queueRevision === 2, "A rejected finalize must send the late file into the existing queue");
}

function checkSingleQueueProtocolCode(){
  const wizard = readText("ui/nextcloudSharingWizard.js");
  const router = readText("modules/bgRouter.js");
  assert(wizard.includes("name: 'nc-sharing-compose'"), "The wizard must use the common compose queue port");
  assert(!wizard.includes("adoptAttachmentLaunchContext") && !router.includes("sharing:getLaunchContext"),
    "The obsolete launch-context path must not survive beside the live queue");
}

async function checkSuppressedAttachmentAdds(){
  const harness = createHarness();
  harness.context.ATTACHMENT_SUPPRESSED_TABS.add(17);
  await harness.context.handleComposeAttachmentAdded(
    { id: 17 },
    { id: 4, name: "restored.txt", size: 12 }
  );
  assert(
    !harness.context.ATTACHMENT_PENDING_ADDED_BY_TAB.has(17),
    "Programmatic attachment additions must not enter the automation queue"
  );
  assert(
    !harness.context.ATTACHMENT_EVAL_TIMER_BY_TAB.has(17),
    "Programmatic attachment additions must not schedule an evaluation"
  );
}

async function checkMandatoryRoutingBeforeSend(){
  const harness = createHarness();
  harness.attachments.set(5, { attachmentId:5, name:"quick-send.txt", size:12 });
  let evaluationRequests = 0;
  harness.context.assertAttachmentAutomationAllowed = async () => ({ ok:true });
  harness.context.getComposeAttachmentAutomationSettings = async () => ({
    alwaysConnector: true
  });
  harness.context.__testRequestEvaluation = () => {
    evaluationRequests += 1;
    return Promise.resolve();
  };
  vm.runInContext(
    "requestComposeAttachmentEvaluation = globalThis.__testRequestEvaluation;",
    harness.context
  );

  await harness.context.handleComposeAttachmentAdded(
    { id:24 },
    { id:5, name:"quick-send.txt", size:12 }
  );
  assert(
    harness.context.ATTACHMENT_EVAL_TIMER_BY_TAB.has(24),
    "A newly added attachment must start in the debounce window"
  );
  assert(
    await harness.context.prepareComposeAttachmentRoutingBeforeSend(24) === true,
    "Mandatory attachment routing must cancel a send during the debounce window"
  );
  assert(
    !harness.context.ATTACHMENT_EVAL_TIMER_BY_TAB.has(24),
    "The send guard must replace the debounce timer with an immediate evaluation"
  );
  assert(
    evaluationRequests === 1,
    "The send guard must start one immediate attachment evaluation"
  );
}

async function checkOptionalRoutingDoesNotBlockSend(){
  const harness = createHarness();
  harness.attachments.set(6, { attachmentId:6, name:"optional.txt", size:12 });
  let evaluationRequests = 0;
  harness.context.assertAttachmentAutomationAllowed = async () => ({ ok:true });
  harness.context.getComposeAttachmentAutomationSettings = async () => ({
    alwaysConnector: false
  });
  harness.context.__testRequestEvaluation = () => {
    evaluationRequests += 1;
    return Promise.resolve();
  };
  vm.runInContext(
    "requestComposeAttachmentEvaluation = globalThis.__testRequestEvaluation;",
    harness.context
  );

  await harness.context.handleComposeAttachmentAdded(
    { id:25 },
    { id:6, name:"optional.txt", size:12 }
  );
  assert(
    await harness.context.prepareComposeAttachmentRoutingBeforeSend(25) === false,
    "Optional attachment routing must not cancel a send during the debounce window"
  );
  assert(
    harness.context.ATTACHMENT_EVAL_TIMER_BY_TAB.has(25),
    "An optional attachment evaluation must keep its normal debounce timer"
  );
  assert(
    evaluationRequests === 0,
    "The send guard must not start an optional attachment evaluation"
  );
}

async function checkPostShareSendPolicy(){
  for (const persisted of [false, true]){
    for (const rule of ["always", "locked-threshold", "optional-threshold"]){
      for (const size of [0, 100, 101]){
        const harness = createHarness();
        harness.control.hasShareCleanup = !persisted;
        harness.control.composeDetails = {
          customHeaders: persisted ? [{ name:"x-ncc-share-draft", value:"saved" }] : [],
          body: '<div class="moz-signature"><img src="cid:signature-logo"></div>'
        };
        harness.context.getComposeAttachmentAutomationSettings = async () => ({
          alwaysConnector: rule === "always", thresholdMandatory: rule === "locked-threshold",
          offerAboveEnabled: true, thresholdBytes: 100
        });
        // Thunderbird listAttachments exposes the attachment bucket, not embedded body images.
        assert(await harness.context.prepareComposeAttachmentRoutingBeforeSend(28) === false,
          "An embedded signature without ordinary attachments must remain sendable");
        harness.attachments.set(1, { attachmentId:1, name:"photo.png", size });
        const required = rule === "always" || (rule === "locked-threshold" && size > 100);
        assert(await harness.context.prepareComposeAttachmentRoutingBeforeSend(28) === required,
          `Post-share policy bypass: ${persisted}/${rule}/${size}`);
        assert(harness.calls.windowsCreate === 0 && harness.calls.attachmentsRemoved.length === 0,
          "Send validation must not create another share or delete attachments");
        harness.attachments.clear();
        assert(await harness.context.prepareComposeAttachmentRoutingBeforeSend(28) === false,
          "Removing the ordinary file must unblock Send without changing the signature");
        assert(harness.control.composeDetails.body.includes("cid:signature-logo"), "Signature was modified");
      }
    }
  }
  const harness = createHarness();
  harness.attachments.set(1, { attachmentId:1, name:"file.txt", size:1 });
  harness.context.getComposeAttachmentAutomationSettings = async () => ({ alwaysConnector:true });
  harness.context.assertAttachmentAutomationAllowed = async () => ({ ok:false });
  assert(await harness.context.prepareComposeAttachmentRoutingBeforeSend(29) === true,
    "Disabled intake must not exempt required file attachments at Send");
  harness.context.browser.compose.listAttachments = async () => { throw new Error("read_failed"); };
  assert(await harness.context.prepareComposeAttachmentRoutingBeforeSend(29) === true,
    "A failed final attachment read must not permit an unchecked send");
}

async function checkMandatoryThresholdResolution(){
  for (const locked of [false, true]){
    for (const threshold of [null, 5]){
      const harness = createHarness();
      harness.context.browser.storage = { local: { get: async () => ({}) } };
      harness.context.normalizeAttachmentThresholdMb = (value) => Number(value) || 20;
      harness.context.NCPolicyRuntime.getPolicyStatus = async () => ({});
      harness.context.NCSharingStorage = { SHARE_POLICY_KEYS: { attachmentsMinSizeMb:"size" } };
      harness.context.NCPolicyState = {
        getManagedAccessState: () => ({ allowed:true }), isDomainActive: () => true,
        resolveDefaultValue: () => false, isLocked: () => locked,
        hasPolicyKey: () => true, readPolicyValue: () => threshold
      };
      const settings = await harness.context.getComposeAttachmentAutomationSettings();
      assert(settings.thresholdMandatory === (locked && threshold !== null),
        "Only an active locked numeric size policy may make the threshold mandatory");
    }
  }
}

async function run(){
  await checkSerializedEvaluation();
  await checkPromptReservation();
  checkPromptBatchSettlement();
  await checkWizardOwnership();
  await checkPartialRemovalRollback();
  await checkManagedRefusalRetainsAttachments();
  await checkPopupFailureRetainsAttachments();
  await checkEarlyAndLaterDropAdoption();
  await checkQueueWithoutFocusCompletion();
  await checkQueueBeforeNativeWindowCreationCompletes();
  await checkQueueSenderBinding();
  await checkComposeCloseDuringNativeCreation();
  await checkCloseBeforeAdoptionRollback();
  await checkRestoreAttemptsAllAttachments();
  await checkExistingShareBlocksBothEntrypoints();
  await checkFinalizeRevisionGuard();
  checkSingleQueueProtocolCode();
  await checkSuppressedAttachmentAdds();
  await checkMandatoryRoutingBeforeSend();
  await checkOptionalRoutingDoesNotBlockSend();
  await checkPostShareSendPolicy();
  await checkMandatoryThresholdResolution();
  console.log("[OK] compose-attachment-lifecycle-check passed");
}

run().catch((error) => {
  console.error("[FAIL] compose-attachment-lifecycle-check", error);
  process.exitCode = 1;
});
