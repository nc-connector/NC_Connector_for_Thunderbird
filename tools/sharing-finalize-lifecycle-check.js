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
    setTimeout(callback, delay){
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id){
      timers.delete(id);
    },
    fireByDelay(delay){
      const match = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert(match, `Expected timer with delay ${delay}`);
      const [id, timer] = match;
      timers.delete(id);
      timer.callback();
    },
    count(){
      return timers.size;
    }
  };
}

function createFinalizeHarness(options = {}){
  const composeCleanup = new Map();
  const persistedCompose = new Map();
  const passwordDispatch = new Map();
  const composeDetails = new Map();
  const timers = createFakeTimers();
  const delayedPasswordRegistration = options.delayedPasswordRegistration
    ? createDeferred()
    : null;
  const calls = {
    cleanupArm: [],
    cleanupRollback: [],
    cleanupCommit: [],
    passwordRegister: [],
    passwordUnregister: [],
    passwordHandoff: [],
    persistentRestore: [],
    tainted: [],
    composeWrites: []
  };
  let runtimeId = 0;
  let insertFailurePending = options.insertFailure === true;

  composeDetails.set(25, {
    type: "new",
    body: "<body><p>Original message</p></body>",
    plainTextBody: "Original message",
    isPlainText: false,
    deliveryFormat: "auto",
    customHeaders: []
  });

  const context = {
    URL,
    Map,
    Set,
    Promise,
    Object,
    Number,
    String,
    Date,
    structuredClone,
    COMPOSE_SHARE_DRAFT_HEADER: "X-NCC-Share-Draft",
    COMPOSE_SHARE_DRAFT_ID_PATTERN: /^[A-Za-z0-9_-]{16,80}$/,
    COMPOSE_SHARE_CLEANUP_BY_TAB: composeCleanup,
    NCShareTemplateContract: {
      RIGHTS_SEGMENT_START: "[[NCC_RIGHTS_START]]",
      RIGHTS_SEGMENT_END: "[[NCC_RIGHTS_END]]"
    },
    NCHtmlSanitizer: {
      plainTextToHtml(value){
        return String(value || "");
      }
    },
    browser: {
      compose: {
        async getComposeDetails(tabId){
          const details = composeDetails.get(tabId);
          if (!details){
            throw new Error("compose_details_missing");
          }
          return structuredClone(details);
        },
        async setComposeDetails(tabId, update){
          const current = composeDetails.get(tabId);
          if (!current){
            throw new Error("compose_details_missing");
          }
          Object.assign(current, structuredClone(update));
          calls.composeWrites.push({
            tabId,
            update: structuredClone(update)
          });
          if (insertFailurePending
            && Object.hasOwn(update, "customHeaders")
            && (Object.hasOwn(update, "body")
              || Object.hasOwn(update, "plainTextBody"))){
            insertFailurePending = false;
            throw new Error("compose_insert_failed_after_apply");
          }
        }
      }
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: {
      error(){}
    },
    globalThis: null,
    L(){},
    bgI18n(key){
      return key;
    },
    bgShortId(value){
      return String(value || "");
    },
    createSecureRuntimeId(){
      runtimeId += 1;
      return `runtime-id-${String(runtimeId).padStart(12, "0")}`;
    },
    NCPolicyRuntime: {
      async getPolicyStatus(){
        return { seat: { assigned: true } };
      }
    },
    NCPolicyState: {
      hasSeatEntitlement(){
        return true;
      }
    },
    async armComposeShareCleanup(tabId, payload){
      calls.cleanupArm.push({ tabId, payload });
      const previousState = composeCleanup.get(tabId) || null;
      const stagedState = {
        tabId,
        draftGroupId: payload.draftGroupId,
        entries: [{ shareId: payload.shareId }],
        saved: false
      };
      const mutation = {
        tabId,
        stagedState,
        previousState,
        wizardWindowId: payload.wizardWindowId,
        wizardEntry: { cleanupId: "wizard-cleanup" },
        wizardOwnershipTransferred: false,
        persistenceTransition: { id: "persistence-transition" }
      };
      composeCleanup.set(tabId, stagedState);
      persistedCompose.set(payload.draftGroupId, {
        passwordHandoffRequired: false,
        passwordHandoffComplete: true
      });
      return mutation;
    },
    rollbackComposeShareCleanupArm(mutation, reason){
      calls.cleanupRollback.push({ mutation, reason });
      if (composeCleanup.get(mutation.tabId) !== mutation.stagedState){
        return false;
      }
      if (mutation.previousState){
        composeCleanup.set(mutation.tabId, mutation.previousState);
      }else{
        composeCleanup.delete(mutation.tabId);
      }
      return true;
    },
    completeComposeShareCleanupArm(mutation, reason){
      calls.cleanupCommit.push({ mutation, reason });
      mutation.wizardOwnershipTransferred = true;
      return true;
    },
    async restorePersistentWizardCleanupOwnership(mutation){
      calls.persistentRestore.push(mutation);
    },
    async registerSeparatePasswordMailDispatch(tabId){
      const registrationId = "password-registration-exact";
      calls.passwordRegister.push({ tabId, registrationId });
      if (delayedPasswordRegistration){
        await delayedPasswordRegistration.promise;
      }
      passwordDispatch.set(registrationId, { tabId });
      return {
        registrationId,
        duplicate: false
      };
    },
    unregisterSeparatePasswordMailDispatch(tabId, registrationId, reason){
      calls.passwordUnregister.push({ tabId, registrationId, reason });
      const current = passwordDispatch.get(registrationId);
      if (!current || current.tabId !== tabId){
        return false;
      }
      passwordDispatch.delete(registrationId);
      return true;
    },
    async setComposeSharePasswordHandoffState(
      tabId,
      required,
      complete,
      reason
    ){
      calls.passwordHandoff.push({ tabId, required, complete, reason });
      const state = composeCleanup.get(tabId);
      if (!state){
        return false;
      }
      state.passwordHandoffRequired = required === true;
      state.passwordHandoffComplete = required !== true || complete === true;
      persistedCompose.set(state.draftGroupId, {
        passwordHandoffRequired: state.passwordHandoffRequired,
        passwordHandoffComplete: state.passwordHandoffComplete
      });
      return true;
    },
    async markPersistentShareCleanupTainted(groupId){
      calls.tainted.push(groupId);
    },
    NCLogContext: {
      safeConsoleError(){}
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readText("modules/bgComposeShareInsert.js"), context, {
    filename: "modules/bgComposeShareInsert.js"
  });
  vm.runInContext(readText("modules/bgComposeFinalize.js"), context, {
    filename: "modules/bgComposeFinalize.js"
  });

  return {
    context,
    calls,
    composeCleanup,
    persistedCompose,
    composeDetails,
    passwordDispatch,
    timers,
    delayedPasswordRegistration
  };
}

function createStoreHarness(){
  const timers = createFakeTimers();
  const storage = {
    disk: {},
    rejectNextWrite: false,
    writes: [],
    async get(){
      return structuredClone(this.disk);
    },
    async set(update){
      if (this.rejectNextWrite){
        this.rejectNextWrite = false;
        throw new Error("storage_write_rejected");
      }
      this.disk = structuredClone(update);
      this.writes.push(structuredClone(update));
    }
  };
  const startup = {
    addListener(){}
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
    structuredClone,
    COMPOSE_SHARE_DRAFT_ID_PATTERN: /^[A-Za-z0-9_-]{16,80}$/,
    browser: {
      storage: {
        local: storage
      },
      runtime: {
        onStartup: startup
      }
    },
    NCFileLinkDav: {
      normalizeRelativePath(value){
        return String(value || "")
          .replace(/\\/g, "/")
          .replace(/^\/+|\/+$/g, "")
          .replace(/\/+/g, "/");
      }
    },
    NCCore: {
      normalizeBaseUrl(value){
        return String(value || "").trim().replace(/\/+$/, "");
      }
    },
    NCHostPermissions: null,
    NCOcs: {},
    NCFileLinkShare: {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    navigator: {
      onLine: true
    },
    addEventListener(){},
    console: {
      error(){}
    },
    globalThis: null,
    L(){},
    bgI18n(key){
      return key;
    },
    bgShortId(value){
      return String(value || "");
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readText("modules/bgShareCleanupStore.js"), context, {
    filename: "modules/bgShareCleanupStore.js"
  });
  return {
    context,
    storage,
    ready: vm.runInContext("PERSISTED_SHARE_CLEANUP_READY", context)
  };
}

function cleanupDescriptor(name){
  return {
    baseUrl: "https://cloud.example.test",
    userId: "user",
    relativeFolder: `FileLink/${name}`,
    reservationRelativeFolder: "",
    targetRelativeFolder: ""
  };
}

function cleanupEntry(groupId, name){
  return {
    cleanupId: groupId,
    cleanupDescriptor: cleanupDescriptor(name)
  };
}

async function expectReject(operation, message){
  let rejected = false;
  try{
    await operation();
  }catch(error){
    rejected = error?.message === "storage_write_rejected";
  }
  assert(rejected, message);
}

async function verifyStorageFirstCleanupMutations(){
  const harness = createStoreHarness();
  await harness.ready;
  const { context, storage } = harness;

  const rejectedWizard = "wizard-reject-add-001";
  storage.rejectNextWrite = true;
  await expectReject(
    () => context.persistWizardShareCleanupGroup(
      cleanupEntry(rejectedWizard, "rejected-add")
    ),
    "Wizard add must report a rejected storage write"
  );
  assert(
    context.getPersistentShareCleanupGroup(rejectedWizard) === null,
    "Rejected wizard add must not change confirmed memory state"
  );
  assert(
    Object.keys(storage.disk.nccShareCleanupGroupsV1 || {}).length === 0,
    "Rejected wizard add must not change storage"
  );

  const wizardA = "wizard-stage-a-00001";
  const composeA = "compose-stage-a-00001";
  await context.persistWizardShareCleanupGroup(
    cleanupEntry(wizardA, "stage-a")
  );
  await context.stagePersistentComposeCleanupGroup(
    wizardA,
    composeA,
    [cleanupEntry("", "stage-a")]
  );
  await context.markPersistentComposeCleanupSaved(composeA, [101]);
  const wizardB = "wizard-stage-b-00001";
  await context.persistWizardShareCleanupGroup(
    cleanupEntry(wizardB, "stage-b")
  );
  const beforeRejectedStage = structuredClone(storage.disk);
  storage.rejectNextWrite = true;
  await expectReject(
    () => context.stagePersistentComposeCleanupGroup(
      wizardB,
      composeA,
      [
        cleanupEntry("", "stage-a"),
        cleanupEntry("", "stage-b")
      ]
    ),
    "Compose stage must report a rejected storage write"
  );
  assert(
    JSON.stringify(storage.disk) === JSON.stringify(beforeRejectedStage),
    "Rejected compose stage must leave storage unchanged"
  );
  assert(
    context.getPersistentShareCleanupGroup(composeA)?.resources.length === 1
      && context.getPersistentShareCleanupGroup(wizardB)?.ownerKind === "wizard",
    "Rejected compose stage must preserve confirmed compose and wizard ownership"
  );

  const stageTransition = await context.stagePersistentComposeCleanupGroup(
    wizardB,
    composeA,
    [
      cleanupEntry("", "stage-a"),
      cleanupEntry("", "stage-b")
    ]
  );
  const stagedBaseline = context.getPersistentShareCleanupGroup(composeA);
  assert(
    stagedBaseline?.state === "saved"
      && stagedBaseline.saved === true
      && stagedBaseline.savePendingChanges === true
      && stagedBaseline.resources.length === 2,
    "Adding a share to a saved draft must retain its saved baseline"
  );
  const beforeRejectedRollback = structuredClone(storage.disk);
  storage.rejectNextWrite = true;
  await expectReject(
    () => context.rollbackPersistentComposeCleanupGroup(stageTransition),
    "Compose-stage rollback must report a rejected storage write"
  );
  assert(
    JSON.stringify(storage.disk) === JSON.stringify(beforeRejectedRollback)
      && context.getPersistentShareCleanupGroup(composeA)?.resources.length === 2,
    "Rejected compose-stage rollback must retain the confirmed staged state"
  );
  await context.rollbackPersistentComposeCleanupGroup(stageTransition);

  const wizardMutation = "wizard-mutation-00001";
  const composeMutation = "compose-mutation-00001";
  await context.persistWizardShareCleanupGroup(
    cleanupEntry(wizardMutation, "mutation")
  );
  await context.stagePersistentComposeCleanupGroup(
    wizardMutation,
    composeMutation,
    [cleanupEntry("", "mutation")]
  );

  for (const [name, operation] of [
    [
      "mark saved",
      () => context.markPersistentComposeCleanupSaved(
        composeMutation,
        [202]
      )
    ],
    [
      "mark pending",
      () => context.markPersistentShareCleanupPending(
        composeMutation,
        "test",
        { schedule: false }
      )
    ],
    [
      "mark password handoff",
      () => context.markPersistentComposePasswordHandoff(
        composeMutation,
        true,
        false
      )
    ],
    [
      "mark send pending",
      () => context.markPersistentComposeSendPending(
        composeMutation,
        true
      )
    ],
    [
      "remove descriptor",
      () => context.removePersistentShareCleanupDescriptor(
        composeMutation,
        cleanupDescriptor("mutation")
      )
    ],
    [
      "mark exhausted",
      () => context.markPersistentShareCleanupExhausted(composeMutation)
    ],
    [
      "mark tainted",
      () => context.markPersistentShareCleanupTainted(composeMutation)
    ],
    [
      "resume active cleanup",
      () => context.resumePersistedShareCleanup(
        "test",
        { recoverActive: true }
      )
    ],
    [
      "remove",
      () => context.removePersistentShareCleanupGroup(composeMutation)
    ]
  ]){
    const beforeDisk = structuredClone(storage.disk);
    const beforeMemory = structuredClone(
      context.getPersistentShareCleanupGroup(composeMutation)
    );
    storage.rejectNextWrite = true;
    await expectReject(
      operation,
      `${name} must report a rejected storage write`
    );
    assert(
      JSON.stringify(storage.disk) === JSON.stringify(beforeDisk),
      `Rejected ${name} must leave storage unchanged`
    );
    assert(
      JSON.stringify(context.getPersistentShareCleanupGroup(composeMutation))
        === JSON.stringify(beforeMemory),
      `Rejected ${name} must leave confirmed memory state unchanged`
    );
  }
}

async function verifyCrashRetentionStates(){
  const sendPending = createStoreHarness();
  await sendPending.ready;
  const sendWizard = "wizard-send-window-001";
  const sendCompose = "compose-send-window-001";
  await sendPending.context.persistWizardShareCleanupGroup(
    cleanupEntry(sendWizard, "send-window")
  );
  await sendPending.context.stagePersistentComposeCleanupGroup(
    sendWizard,
    sendCompose,
    [cleanupEntry("", "send-window")]
  );
  await sendPending.context.markPersistentComposeSendPending(
    sendCompose,
    true
  );
  await sendPending.context.resumePersistedShareCleanup(
    "restart",
    { recoverActive: true }
  );
  assert(
    sendPending.context.getPersistentShareCleanupGroup(sendCompose)?.state
      === "send_pending",
    "Restart must retain a share whose primary send outcome is unknown"
  );

  const passwordCrash = createStoreHarness();
  await passwordCrash.ready;
  const passwordWizard = "wizard-password-crash-1";
  const passwordCompose = "compose-password-crash-1";
  await passwordCrash.context.persistWizardShareCleanupGroup(
    cleanupEntry(passwordWizard, "password-crash")
  );
  await passwordCrash.context.stagePersistentComposeCleanupGroup(
    passwordWizard,
    passwordCompose,
    [cleanupEntry("", "password-crash")]
  );
  await passwordCrash.context.markPersistentComposePasswordHandoff(
    passwordCompose,
    true,
    false
  );
  await passwordCrash.context.resumePersistedShareCleanup(
    "restart",
    { recoverActive: true }
  );
  const retained = passwordCrash.context.getPersistentShareCleanupGroup(
    passwordCompose
  );
  assert(
    retained?.state === "exhausted"
      && retained.passwordHandoffRequired === true
      && retained.passwordHandoffComplete === false,
    "Restart must retain an active share with an incomplete password handoff"
  );
}

function finalizePayload(){
  return {
    tabId: 25,
    wizardWindowId: 50,
    html: "<p>Share block</p>",
    plainText: "Share block",
    cleanup: {
      shareId: "share-1",
      shareUrl: "https://cloud.example.test/s/token",
      shareLabel: "Project",
      folderInfo: {
        relativeFolder: "FileLink/Project",
        folderName: "Project"
      }
    },
    passwordDispatch: {
      shareId: "share-1",
      password: "secret"
    }
  };
}

async function verifyInsertFailureRollback(){
  const harness = createFinalizeHarness({ insertFailure: true });
  const previousState = {
    tabId: 25,
    draftGroupId: "previous-draft-00001",
    entries: [{ shareId: "previous-share" }],
    saved: false
  };
  harness.composeCleanup.set(25, previousState);
  const originalDetails = structuredClone(harness.composeDetails.get(25));

  const result = await harness.context.handleSharingFinalizeTransaction(
    finalizePayload()
  );

  assert(result.ok === false, "Insert failure must fail finalize");
  assert(result.canRetry === true, "Complete rollback must allow retry");
  assert(
    harness.composeCleanup.get(25) === previousState,
    "Insert failure must restore the exact previous cleanup state"
  );
  assert(
    harness.calls.passwordUnregister.length === 1
      && harness.calls.passwordUnregister[0].registrationId
        === "password-registration-exact",
    "Insert failure must remove the exact password registration"
  );
  assert(
    harness.passwordDispatch.size === 0,
    "Insert failure must leave no password registration"
  );
  assert(
    harness.calls.persistentRestore.length === 1,
    "Insert failure must restore persistent wizard cleanup ownership"
  );
  assert(
    JSON.stringify(harness.composeDetails.get(25))
      === JSON.stringify(originalDetails),
    "A partially applied compose mutation must be restored exactly"
  );
  assert(
    harness.context.isComposeFinalizeTransactionActive(25) === false,
    "Rolled-back finalize must release its tab lock"
  );
}

async function verifyDelayedStageTimeoutRollback(){
  const harness = createFinalizeHarness({
    delayedPasswordRegistration: true
  });
  const finalizePromise = harness.context.handleSharingFinalizeTransaction(
    finalizePayload()
  );
  await waitFor(
    () => harness.calls.passwordRegister.length === 1,
    "Finalize did not enter the delayed password stage"
  );

  harness.timers.fireByDelay(30000);
  const transaction = harness.context.captureComposeFinalizeSaveSnapshot(25)
    .transaction;
  assert(
    transaction?.abortRequested === true,
    "Transaction timeout must request rollback while the stage is pending"
  );
  assert(
    harness.context.isComposeFinalizeTransactionActive(25) === true,
    "The finalize lock must remain while the timed-out stage is unresolved"
  );

  harness.delayedPasswordRegistration.resolve();
  const result = await finalizePromise;

  assert(result.ok === false, "Timed-out finalize must fail");
  assert(result.canRetry === true, "Completed timeout rollback must allow retry");
  assert(
    harness.calls.passwordUnregister.length === 1
      && harness.calls.passwordUnregister[0].registrationId
        === "password-registration-exact",
    "A registration resolved after timeout must still be removed exactly"
  );
  assert(
    harness.passwordDispatch.size === 0,
    "Delayed timeout rollback must not leak the password registration"
  );
  assert(
    harness.composeCleanup.has(25) === false,
    "Delayed timeout rollback must release staged cleanup ownership"
  );
  assert(
    harness.context.isComposeFinalizeTransactionActive(25) === false,
    "Completed timeout rollback must release the compose lock"
  );
  assert(
    harness.timers.count() === 0,
    "Completed timeout rollback must clear transaction timers"
  );
}

async function verifySuccessfulCommit(){
  const harness = createFinalizeHarness();
  const result = await harness.context.handleSharingFinalizeTransaction(
    finalizePayload()
  );

  assert(result.ok === true, "Valid finalize must commit");
  assert(
    harness.calls.cleanupCommit.length === 1,
    "Successful finalize must transfer cleanup ownership once"
  );
  assert(
    harness.calls.passwordUnregister.length === 0,
    "Successful finalize must keep its password registration"
  );
  assert(
    harness.calls.passwordHandoff.length === 1
      && harness.calls.passwordHandoff[0].required === true
      && harness.calls.passwordHandoff[0].complete === false,
    "Successful finalize must stage required incomplete password handoff state"
  );
  assert(
    harness.persistedCompose.get(result.draftGroupId)
      ?.passwordHandoffRequired === true
      && harness.persistedCompose.get(result.draftGroupId)
        ?.passwordHandoffComplete === false,
    "Successful finalize must persist required incomplete password handoff state"
  );
  assert(
    harness.composeDetails.get(25).customHeaders.some((header) => {
      return header.name === "X-NCC-Share-Draft"
        && header.value === result.draftGroupId;
    }),
    "Successful finalize must write the local draft marker"
  );
  assert(
    harness.context.isComposeFinalizeTransactionActive(25) === false,
    "Committed finalize must release its tab lock"
  );
}

async function run(){
  await verifyInsertFailureRollback();
  await verifyDelayedStageTimeoutRollback();
  await verifySuccessfulCommit();
  await verifyStorageFirstCleanupMutations();
  await verifyCrashRetentionStates();
  console.log("[OK] sharing-finalize-lifecycle-check passed");
}

run().catch((error) => {
  console.error("[FAIL] sharing-finalize-lifecycle-check", error);
  process.exitCode = 1;
});
