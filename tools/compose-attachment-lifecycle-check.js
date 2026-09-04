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
  const calls = {
    windowsCreate: 0,
    windowsRemove: [],
    attachmentsRemoved: [],
    attachmentsAdded: []
  };
  const control = {
    windowCreate: async () => ({ id: 91 }),
    removeAttachment: async () => {},
    addAttachment: async () => {}
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
    File: TestFile,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: { error(){} },
    globalThis: null,
    SHARING_LAUNCH_CONTEXT_TTL_MS: 15 * 60 * 1000,
    SHARING_LAUNCH_CONTEXTS: new Map(),
    SHARING_WIZARD_REQUEST_BY_WINDOW: new Map(),
    ATTACHMENT_PROMPT_BY_ID: new Map(),
    ATTACHMENT_PROMPT_BY_TAB: new Map(),
    ATTACHMENT_PROMPT_BY_WINDOW: new Map(),
    ATTACHMENT_EVAL_TIMER_BY_TAB: new Map(),
    ATTACHMENT_PENDING_ADDED_BY_TAB: new Map(),
    ATTACHMENT_SUPPRESSED_TABS: new Set(),
    ATTACHMENT_AUTOMATION_BY_TAB: new Map(),
    ATTACHMENT_AUTOMATION_TAB_BY_WINDOW: new Map(),
    ATTACHMENT_EVAL_DEBOUNCE_MS: 250,
    ATTACHMENT_DEFAULT_THRESHOLD_MB: 20,
    ATTACHMENT_PROMPT_WIDTH: 560,
    ATTACHMENT_PROMPT_HEIGHT: 260,
    SHARING_POPUP_WIDTH: 660,
    SHARING_POPUP_HEIGHT: 760,
    SHARING_KEYS: {},
    L(){},
    bgShortId(value){
      return String(value || "");
    },
    getAttachmentSizeBytes(){
      return 0;
    },
    browser: {
      runtime: {
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
        }
      },
      compose: {
        async removeAttachment(tabId, attachmentId){
          calls.attachmentsRemoved.push({ tabId, attachmentId });
          return control.removeAttachment(tabId, attachmentId);
        },
        async addAttachment(tabId, attachment){
          calls.attachmentsAdded.push({ tabId, attachment });
          return control.addAttachment(tabId, attachment);
        }
      }
    },
    async focusPopupWindowBestEffort(){
      return true;
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readText("modules/bgComposeAttachments.js"), context, {
    filename: "modules/bgComposeAttachments.js"
  });
  return { context, control, calls, timers };
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
  harness.context.listComposeAttachments = async () => collected.map((item) => ({
    id: item.attachmentId,
    name: item.name,
    size: item.size
  }));
  harness.context.collectComposeAttachmentFiles = async () => collected;
}

async function checkWizardOwnership(){
  const harness = createHarness();
  const file = new harness.context.File("one.txt", 10);
  harness.context.getComposeAttachmentAutomationState(16);
  const handoff = harness.context.beginComposeAttachmentHandoff(16, {
    mode: "attachments",
    attachments: [{ name:file.name, file }]
  });
  harness.context.activateComposeAttachmentWizard(16, handoff.contextId, 93);
  void harness.context.requestComposeAttachmentEvaluation(16);
  const state = harness.context.ATTACHMENT_AUTOMATION_BY_TAB.get(16);
  assert(state?.rerunRequested === true, "An active attachment wizard must defer later evaluations");
  assert(await harness.context.releaseComposeAttachmentWizard(93, "test") === true, "The owning wizard must release its compose tab");
  assert(state.phase === "idle", "Closing the attachment wizard must release the tab flow");
  assert(harness.context.ATTACHMENT_EVAL_TIMER_BY_TAB.has(16), "Deferred additions must be evaluated after the wizard closes");
}

async function checkPartialRemovalRollback(){
  const harness = createHarness();
  const collected = createCollectedAttachments(harness, ["one.txt", "two.txt", "three.txt"]);
  installCollectedFlow(harness, collected);
  harness.control.removeAttachment = async (_tabId, attachmentId) => {
    if (attachmentId === 2){
      throw new Error("remove_failed");
    }
  };

  let failed = false;
  try{
    await harness.context.startComposeAttachmentShareFlow(18, { trigger:"always" });
  }catch(error){
    failed = error?.message === "remove_failed";
  }
  assert(failed, "A partial removal failure must reject the attachment flow");
  assert(
    harness.calls.attachmentsRemoved.map((call) => call.attachmentId).join(",") === "1,2",
    "Removal must stop at the first failed attachment"
  );
  assert(harness.calls.attachmentsAdded.length === 1, "Every successfully removed attachment must be restored");
  assert(harness.calls.attachmentsAdded[0].attachment.file === collected[0].file, "Restore must reuse the original File");
  assert(harness.calls.attachmentsAdded[0].attachment.name === "one.txt", "Restore must preserve the attachment name");
  assert(harness.context.SHARING_LAUNCH_CONTEXTS.size === 0, "Failed handoff context must be discarded");
}

async function checkPopupFailureRollback(){
  const harness = createHarness();
  const collected = createCollectedAttachments(harness, ["one.txt", "two.txt"]);
  installCollectedFlow(harness, collected);
  harness.control.windowCreate = async () => {
    throw new Error("popup_failed");
  };

  try{
    await harness.context.startComposeAttachmentShareFlow(19, { trigger:"always" });
  }catch(error){
    assert(error?.message === "popup_failed", "Popup failure must remain visible to the caller");
  }
  assert(harness.calls.attachmentsAdded.length === 2, "Popup failure must restore all detached attachments");
  assert(harness.context.SHARING_LAUNCH_CONTEXTS.size === 0, "Popup failure must discard the launch context");
}

async function checkLaunchContextAdoption(){
  const harness = createHarness();
  const collected = createCollectedAttachments(harness, ["one.txt", "two.txt"]);
  installCollectedFlow(harness, collected);
  const windowCreated = createDeferred();
  harness.control.windowCreate = () => windowCreated.promise;

  const flow = harness.context.startComposeAttachmentShareFlow(20, { trigger:"always" });
  await waitFor(
    () => harness.context.ATTACHMENT_AUTOMATION_BY_TAB.get(20)?.handoff?.detached?.length === 2,
    "Attachments must be detached before the wizard receives its context"
  );
  const handoff = harness.context.ATTACHMENT_AUTOMATION_BY_TAB.get(20).handoff;
  let contextReadFinished = false;
  const contextRead = harness.context.getComposeAttachmentLaunchContext(
    handoff.contextId,
    20,
    91
  ).then((result) => {
    contextReadFinished = true;
    return result;
  });
  await Promise.resolve();
  assert(!contextReadFinished, "An early context request must wait for popup binding");

  windowCreated.resolve({ id:91 });
  await flow;
  const response = await contextRead;
  assert(response.ok === true, "The bound wizard must receive its attachment context");
  assert(response.context.attachments.length === 2, "The complete attachment context must be retained until adoption");
  assert(harness.context.SHARING_LAUNCH_CONTEXTS.has(handoff.contextId), "Reading must not consume the context");

  const mismatch = harness.context.adoptComposeAttachmentLaunchContext(handoff.contextId, 20, 91, 1);
  assert(mismatch.ok === false, "A queue count mismatch must reject adoption");
  const adopted = harness.context.adoptComposeAttachmentLaunchContext(handoff.contextId, 20, 91, 2);
  assert(adopted.ok === true, "The complete queue must adopt its attachment context");
  assert(!harness.context.SHARING_LAUNCH_CONTEXTS.has(handoff.contextId), "Adoption must release context File references");
  assert(await harness.context.releaseComposeAttachmentWizard(91, "test") === true, "The adopted wizard must release its state");
  assert(harness.calls.attachmentsAdded.length === 0, "Closing after adoption must not restore attachments");
}

async function checkCloseBeforeAdoptionRollback(){
  const harness = createHarness();
  const collected = createCollectedAttachments(harness, ["one.txt", "two.txt"]);
  installCollectedFlow(harness, collected);
  await harness.context.startComposeAttachmentShareFlow(21, { trigger:"always" });

  assert(await harness.context.releaseComposeAttachmentWizard(91, "test") === true, "Closing before adoption must release the wizard");
  assert(harness.calls.attachmentsAdded.length === 2, "Closing before adoption must restore every attachment");
  assert(await harness.context.releaseComposeAttachmentWizard(91, "repeat") === false, "Repeated close must not start another rollback");
  assert(harness.calls.attachmentsAdded.length === 2, "Repeated close must not restore attachments twice");
}

async function checkRestoreAttemptsAllAttachments(){
  const harness = createHarness();
  const collected = createCollectedAttachments(harness, ["one.txt", "two.txt", "three.txt"]);
  installCollectedFlow(harness, collected);
  harness.control.windowCreate = async () => {
    throw new Error("popup_failed");
  };
  harness.control.addAttachment = async (_tabId, attachment) => {
    if (attachment.name === "two.txt"){
      throw new Error("restore_failed");
    }
  };

  try{
    await harness.context.startComposeAttachmentShareFlow(22, { trigger:"always" });
  }catch(_error){}
  assert(harness.calls.attachmentsAdded.length === 3, "Rollback must attempt every detached attachment");
  const state = harness.context.ATTACHMENT_AUTOMATION_BY_TAB.get(22);
  assert(state?.phase === "rollback_failed", "A failed restore must keep the compose flow blocked");
  assert(state?.handoff?.detached?.length === 1, "Only unrestored attachments must remain journaled");
}

function checkClosedComposeCannotRestartHandoff(){
  const harness = createHarness();
  const state = harness.context.getComposeAttachmentAutomationState(23);
  harness.context.cleanupComposeAttachmentTabState(23, "tab_removed");
  let rejected = false;
  try{
    const file = new harness.context.File("one.txt", 10);
    harness.context.beginComposeAttachmentHandoff(23, {
      mode: "attachments",
      attachments: [{ name:file.name, file }]
    });
  }catch(error){
    rejected = error?.message === "attachment_handoff_missing";
  }
  assert(state.disposed === true, "Closing the compose tab must dispose its attachment state");
  assert(rejected, "A closed compose tab must not create a replacement handoff state");
  assert(harness.context.SHARING_LAUNCH_CONTEXTS.size === 0, "Closed compose tabs must not retain launch contexts");
}

function checkWizardAdoptionCode(){
  const wizard = readText("ui/nextcloudSharingWizard.js");
  const router = readText("modules/bgRouter.js");
  assert(
    wizard.includes("list.length !== expectedCount")
      && wizard.includes("validCount !== expectedCount"),
    "The wizard must reject incomplete attachment contexts"
  );
  assert(
    wizard.indexOf("renderFileQueue();") < wizard.indexOf("await adoptAttachmentLaunchContext();"),
    "The wizard must build the queue before adopting the context"
  );
  assert(
    router.includes('msg.type === "sharing:adoptAttachmentLaunchContext"')
      && router.includes('msg.type === "sharing:rejectAttachmentLaunchContext"'),
    "The background router must expose explicit attachment adoption and rejection"
  );
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

async function run(){
  await checkSerializedEvaluation();
  await checkPromptReservation();
  checkPromptBatchSettlement();
  await checkWizardOwnership();
  await checkPartialRemovalRollback();
  await checkPopupFailureRollback();
  await checkLaunchContextAdoption();
  await checkCloseBeforeAdoptionRollback();
  await checkRestoreAttemptsAllAttachments();
  checkClosedComposeCannotRestartHandoff();
  checkWizardAdoptionCode();
  await checkSuppressedAttachmentAdds();
  console.log("[OK] compose-attachment-lifecycle-check passed");
}

run().catch((error) => {
  console.error("[FAIL] compose-attachment-lifecycle-check", error);
  process.exitCode = 1;
});
