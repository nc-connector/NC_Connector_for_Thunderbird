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
    windowsCreate: 0
  };
  const control = {
    windowCreate: async () => ({ id: 91 })
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
    File: class File {},
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
        }
      }
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

function checkWizardOwnership(){
  const harness = createHarness();
  harness.context.activateComposeAttachmentWizard(16, 93);
  void harness.context.requestComposeAttachmentEvaluation(16);
  const state = harness.context.ATTACHMENT_AUTOMATION_BY_TAB.get(16);
  assert(state?.rerunRequested === true, "An active attachment wizard must defer later evaluations");
  assert(harness.context.releaseComposeAttachmentWizard(93, "test") === true, "The owning wizard must release its compose tab");
  assert(state.phase === "idle", "Closing the attachment wizard must release the tab flow");
  assert(harness.context.ATTACHMENT_EVAL_TIMER_BY_TAB.has(16), "Deferred additions must be evaluated after the wizard closes");
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
  checkWizardOwnership();
  await checkSuppressedAttachmentAdds();
  console.log("[OK] compose-attachment-lifecycle-check passed");
}

run().catch((error) => {
  console.error("[FAIL] compose-attachment-lifecycle-check", error);
  process.exitCode = 1;
});
