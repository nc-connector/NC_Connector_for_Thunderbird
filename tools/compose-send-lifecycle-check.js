"use strict";

const vm = require("node:vm");
const { assert, readText } = require("./review-check-utils");

const DRAFT_HEADER = "X-NCC-Share-Draft";

function createDeferred(){
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createEventChannel(){
  const listeners = [];
  return {
    listeners,
    addListener(listener){
      listeners.push(listener);
    }
  };
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
    }
  };
}

function createComposeHarness(){
  const composeActionClicked = createEventChannel();
  const attachmentAdded = createEventChannel();
  const identityChanged = createEventChannel();
  const beforeSend = createEventChannel();
  const afterSend = createEventChannel();
  const afterSave = createEventChannel();
  const windowRemoved = createEventChannel();
  const tabCreated = createEventChannel();
  const tabRemoved = createEventChannel();
  const runtimeStartup = createEventChannel();
  const runtimeInstalled = createEventChannel();
  const composeCleanup = new Map();
  const passwordDispatch = new Map();
  const wizardCleanup = new Map();
  const composeDetails = new Map();
  const persistedGroups = new Map();
  const getDetailsFailures = new Map();
  const timers = createFakeTimers();
  const control = {
    storeAvailable: true,
    saveDeferred: null,
    captureRecipientsError: null
  };
  const calls = {
    composeWrites: [],
    notifications: [],
    persistentSave: [],
    passwordHandoff: [],
    sendPending: [],
    persistentRemove: [],
    persistentPending: [],
    persistentExhausted: [],
    captureRecipients: [],
    enrichIdentity: [],
    manualFallback: [],
    stagedSendLater: [],
    sentPassword: [],
    manualNotifications: [],
    failureNotifications: [],
    attachmentCleanup: [],
    passwordClear: [],
    remoteDeletes: []
  };
  let runtimeId = 0;

  function clone(value){
    return structuredClone(value);
  }

  function getPersistentGroup(groupId){
    return persistedGroups.get(String(groupId || "").trim()) || null;
  }

  const browser = {
    composeAction: {
      onClicked: composeActionClicked
    },
    compose: {
      onAttachmentAdded: attachmentAdded,
      onIdentityChanged: identityChanged,
      onBeforeSend: beforeSend,
      onAfterSend: afterSend,
      onAfterSave: afterSave,
      async getComposeDetails(tabId){
        const failure = getDetailsFailures.get(tabId);
        if (failure){
          getDetailsFailures.delete(tabId);
          throw failure;
        }
        const details = composeDetails.get(tabId);
        if (!details){
          throw new Error("compose_details_missing");
        }
        return clone(details);
      },
      async setComposeDetails(tabId, update){
        const details = composeDetails.get(tabId);
        if (!details){
          throw new Error("compose_details_missing");
        }
        Object.assign(details, clone(update));
        calls.composeWrites.push({ tabId, update: clone(update) });
      }
    },
    notifications: {
      async create(id, options){
        calls.notifications.push({ id, options: clone(options) });
        return id;
      }
    },
    runtime: {
      getURL(path){
        return `moz-extension://test/${path}`;
      },
      onStartup: runtimeStartup,
      onInstalled: runtimeInstalled
    },
    windows: {
      onRemoved: windowRemoved
    },
    tabs: {
      onCreated: tabCreated,
      onRemoved: tabRemoved
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
    structuredClone,
    browser,
    COMPOSE_SHARE_DRAFT_HEADER: DRAFT_HEADER,
    COMPOSE_SHARE_DRAFT_ID_PATTERN: /^[A-Za-z0-9_-]{16,80}$/,
    COMPOSE_SHARE_CLEANUP_BY_TAB: composeCleanup,
    PASSWORD_MAIL_DISPATCH_BY_TAB: passwordDispatch,
    SHARING_WIZARD_CLEANUP_BY_WINDOW: wizardCleanup,
    ATTACHMENT_PROMPT_BY_WINDOW: new Map(),
    COMPOSE_SHARE_CLEANUP_SEND_GRACE_MS: 15000,
    PERSISTED_SHARE_CLEANUP_READY: Promise.resolve(),
    NCShareTemplateContract: {
      RIGHTS_SEGMENT_START: "[[NCC_RIGHTS_START]]",
      RIGHTS_SEGMENT_END: "[[NCC_RIGHTS_END]]"
    },
    NCHtmlSanitizer: {
      plainTextToHtml(value){
        return String(value || "");
      }
    },
    NCSharing: {
      async deleteShareFolder(){
        calls.remoteDeletes.push("legacy");
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
    assertPersistentShareCleanupStoreAvailable(){
      if (!control.storeAvailable){
        throw new Error("share_cleanup_store_unavailable");
      }
    },
    getPersistentShareCleanupGroup: getPersistentGroup,
    getPersistedComposeCleanupEntries(groupId){
      const group = getPersistentGroup(groupId);
      if (!group || group.ownerKind !== "compose"){
        return [];
      }
      return group.resources.map((resource) => Object.freeze({
        folderInfo: Object.freeze({
          relativeFolder: resource.relativeFolder
        }),
        cleanupDescriptor: resource,
        cleanupTarget: null,
        shareId: "",
        shareLabel: "",
        shareUrl: "",
        created: group.created
      }));
    },
    async markPersistentComposeCleanupSaved(groupId, messageIds, options){
      calls.persistentSave.push({
        groupId,
        messageIds: clone(messageIds),
        options: clone(options)
      });
      if (control.saveDeferred){
        await control.saveDeferred.promise;
      }
      const group = getPersistentGroup(groupId);
      if (!group || group.ownerKind !== "compose"){
        return false;
      }
      group.state = "saved";
      group.saved = true;
      group.passwordHandoffRequired = options.passwordHandoffRequired === true;
      group.passwordHandoffComplete = group.passwordHandoffRequired !== true
        || options.passwordHandoffComplete === true;
      group.templateUnsupported = group.templateUnsupported === true
        || options.templateUnsupported === true;
      group.savePendingChanges = false;
      group.sendPending = false;
      group.sendPendingPreviousState = "";
      group.messageIds = clone(messageIds);
      return true;
    },
    async markPersistentComposePasswordHandoff(groupId, required, complete){
      calls.passwordHandoff.push({ groupId, required, complete });
      const group = getPersistentGroup(groupId);
      if (!group || group.ownerKind !== "compose"){
        return false;
      }
      group.passwordHandoffRequired = required === true;
      group.passwordHandoffComplete = required !== true || complete === true;
      return true;
    },
    async markPersistentComposeSendPending(groupId, pending){
      calls.sendPending.push({ groupId, pending });
      const group = getPersistentGroup(groupId);
      if (!group || group.ownerKind !== "compose"){
        return false;
      }
      if (pending === true){
        group.sendPendingPreviousState = group.state;
        group.state = "send_pending";
        group.sendPending = true;
      }else if (group.state === "send_pending"){
        group.state = group.sendPendingPreviousState
          || (group.saved ? "saved" : "active");
        group.sendPending = false;
        group.sendPendingPreviousState = "";
      }
      return true;
    },
    async removePersistentShareCleanupGroup(groupId){
      calls.persistentRemove.push(groupId);
      return persistedGroups.delete(groupId);
    },
    async markPersistentShareCleanupPending(groupId, reason){
      calls.persistentPending.push({ groupId, reason });
      const group = getPersistentGroup(groupId);
      if (group){
        group.state = "pending";
        group.saved = false;
      }
      return !!group;
    },
    async markPersistentShareCleanupExhausted(groupId){
      calls.persistentExhausted.push(groupId);
      const group = getPersistentGroup(groupId);
      if (group){
        group.state = "exhausted";
        group.saved = false;
      }
      return !!group;
    },
    async markPersistentShareCleanupTainted(groupId){
      const group = getPersistentGroup(groupId);
      if (group){
        group.state = "exhausted";
        group.lifecycleTainted = true;
      }
      return !!group;
    },
    async removePersistentShareCleanupDescriptor(){},
    async deletePersistedShareCleanupDescriptor(){
      calls.remoteDeletes.push("persisted");
    },
    createPersistedShareCleanupDescriptor(entry){
      return entry?.cleanupDescriptor || {
        baseUrl: "https://cloud.example.test",
        userId: "user",
        relativeFolder: entry?.folderInfo?.relativeFolder || "",
        reservationRelativeFolder: "",
        targetRelativeFolder: ""
      };
    },
    async persistWizardShareCleanupGroup(){},
    async stagePersistentComposeCleanupGroup(
      wizardGroupId,
      composeGroupId,
      entries
    ){
      const previousWizard = getPersistentGroup(wizardGroupId)
        ? clone(getPersistentGroup(wizardGroupId))
        : null;
      const previousCompose = getPersistentGroup(composeGroupId)
        ? clone(getPersistentGroup(composeGroupId))
        : null;
      if (!previousWizard || previousWizard.ownerKind !== "wizard"){
        throw new Error("wizard_cleanup_persistence_mismatch");
      }
      const hasSavedBaseline = previousCompose?.saved === true;
      const resources = entries.map((entry) => {
        return clone(entry.cleanupDescriptor || {
          baseUrl: "https://cloud.example.test",
          userId: "user",
          relativeFolder: entry.folderInfo.relativeFolder,
          reservationRelativeFolder: "",
          targetRelativeFolder: ""
        });
      });
      persistedGroups.set(composeGroupId, {
        ...previousCompose,
        version: 1,
        groupId: composeGroupId,
        ownerKind: "compose",
        state: hasSavedBaseline ? "saved" : "active",
        saved: hasSavedBaseline,
        savePendingChanges: hasSavedBaseline,
        sendPending: false,
        sendPendingPreviousState: "",
        resources,
        messageIds: hasSavedBaseline
          ? (previousCompose.messageIds || []).slice()
          : [],
        created: previousCompose?.created || Date.now(),
        updated: Date.now()
      });
      persistedGroups.delete(wizardGroupId);
      return {
        wizardGroupId,
        composeGroupId,
        previousWizard,
        previousCompose
      };
    },
    async rollbackPersistentComposeCleanupGroup(transition){
      if (transition.previousCompose){
        persistedGroups.set(
          transition.composeGroupId,
          clone(transition.previousCompose)
        );
      }else{
        persistedGroups.delete(transition.composeGroupId);
      }
      if (transition.previousWizard){
        persistedGroups.set(
          transition.wizardGroupId,
          clone(transition.previousWizard)
        );
      }
    },
    async openSharingWizardWindow(){},
    async handleComposeAttachmentAdded(){},
    async captureSeparatePasswordDispatchIdentityChange(){},
    async captureSeparatePasswordDispatchRecipients(tabId){
      calls.captureRecipients.push(tabId);
      if (control.captureRecipientsError){
        throw control.captureRecipientsError;
      }
    },
    async enrichSeparatePasswordDispatchSourceIdentity(tabId){
      calls.enrichIdentity.push(tabId);
    },
    async expandSeparatePasswordDispatchQueue(queue){
      return queue.slice();
    },
    passwordDispatchRegistrationKey(dispatch){
      return String(dispatch?.registrationId || dispatch?.shareId || "");
    },
    countUniquePasswordDispatchRecipients(queue){
      return Array.isArray(queue) ? queue.length : 0;
    },
    async openManualPasswordFallbackQueue(tabId, queue, failedComposeTabId, reason){
      calls.manualFallback.push({
        tabId,
        queue: queue.slice(),
        failedComposeTabId,
        reason
      });
      return {
        opened: queue.length,
        failed: 0,
        needsSender: 0,
        failedQueue: []
      };
    },
    async showPasswordMailManualRequiredNotification(count, options){
      calls.manualNotifications.push({ count, options: clone(options || {}) });
    },
    async showPasswordMailFailureNotification(count){
      calls.failureNotifications.push(count);
    },
    takeSeparatePasswordDispatch(tabId){
      const queue = passwordDispatch.get(tabId) || [];
      passwordDispatch.delete(tabId);
      return queue;
    },
    async stageSeparatePasswordMailForSendLater(tabId, queue){
      calls.stagedSendLater.push({ tabId, queue: queue.slice() });
    },
    async sendSeparatePasswordMail(tabId, queue, mode){
      calls.sentPassword.push({ tabId, queue: queue.slice(), mode });
    },
    scheduleSeparatePasswordDispatchClear(tabId, reason, delayMs){
      calls.passwordClear.push({ tabId, reason, delayMs });
    },
    clearSeparatePasswordDispatch(tabId){
      calls.passwordClear.push({ tabId, reason: "clear", delayMs: 0 });
      passwordDispatch.delete(tabId);
    },
    cleanupComposeAttachmentTabState(tabId, reason){
      calls.attachmentCleanup.push({ tabId, reason });
    },
    resolveAttachmentPrompt(){},
    NCLogContext: {
      safeConsoleError(){}
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    "modules/bgComposeShareInsert.js",
    "modules/bgComposeShareCleanup.js",
    "modules/bgComposeFinalize.js",
    "modules/bgCompose.js"
  ]){
    vm.runInContext(readText(file), context, { filename: file });
  }

  function setDetails(tabId, details){
    composeDetails.set(tabId, clone(details));
  }

  function setPersistent(groupId, options = {}){
    const saved = options.saved === true;
    const group = {
      version: 1,
      groupId,
      ownerKind: options.ownerKind || "compose",
      state: options.state || (saved ? "saved" : "active"),
      saved,
      passwordHandoffRequired: options.passwordHandoffRequired === true,
      passwordHandoffComplete: options.passwordHandoffRequired !== true
        || options.passwordHandoffComplete === true,
      templateUnsupported: options.templateUnsupported === true,
      lifecycleTainted: options.lifecycleTainted === true,
      savePendingChanges: options.savePendingChanges === true,
      sendPending: options.sendPending === true,
      sendPendingPreviousState: options.sendPendingPreviousState || "",
      messageIds: [],
      resources: [{
        baseUrl: "https://cloud.example.test",
        userId: "user",
        relativeFolder: `FileLink/${groupId}`,
        reservationRelativeFolder: "",
        targetRelativeFolder: ""
      }],
      attempt: 0,
      created: Date.now(),
      updated: Date.now()
    };
    persistedGroups.set(groupId, group);
    return group;
  }

  function setRuntime(tabId, groupId, options = {}){
    const state = {
      cleanupId: `cleanup-${groupId}`,
      tabId,
      entries: [{
        folderInfo: Object.freeze({
          relativeFolder: `FileLink/${groupId}`
        }),
        shareId: "share-1",
        shareLabel: "Project",
        shareUrl: "https://cloud.example.test/s/token",
        cleanupTarget: null,
        cleanupDescriptor: {
          baseUrl: "https://cloud.example.test",
          userId: "user",
          relativeFolder: `FileLink/${groupId}`,
          reservationRelativeFolder: "",
          targetRelativeFolder: ""
        },
        created: Date.now()
      }],
      draftGroupId: groupId,
      saved: options.saved === true,
      savePendingChanges: options.savePendingChanges === true,
      messageIds: [],
      passwordHandoffRequired: options.passwordHandoffRequired === true,
      passwordHandoffComplete: options.passwordHandoffRequired !== true
        || options.passwordHandoffComplete === true,
      templateUnsupported: options.templateUnsupported === true,
      lifecycleTainted: options.lifecycleTainted === true,
      created: Date.now(),
      sendPending: options.sendPending === true,
      timerId: null,
      deleting: false,
      deletePromise: null
    };
    composeCleanup.set(tabId, state);
    return state;
  }

  function setShare(tabId, groupId, options = {}){
    setDetails(tabId, {
      type: options.type || (options.saved ? "draft" : "new"),
      body: "<body><p>Message</p></body>",
      plainTextBody: "Message",
      isPlainText: false,
      deliveryFormat: "auto",
      customHeaders: [{
        name: DRAFT_HEADER,
        value: groupId
      }]
    });
    const persisted = setPersistent(groupId, options);
    const state = setRuntime(tabId, groupId, options);
    return { persisted, state };
  }

  return {
    context,
    control,
    calls,
    composeCleanup,
    passwordDispatch,
    persistedGroups,
    composeDetails,
    getDetailsFailures,
    setDetails,
    setPersistent,
    setRuntime,
    setShare,
    beforeSend: beforeSend.listeners[0],
    afterSend: afterSend.listeners[0],
    afterSave: afterSave.listeners[0],
    tabRemoved: tabRemoved.listeners[0]
  };
}

async function verifySaveOrdering(){
  const beforeInsert = createComposeHarness();
  const beforeGroup = "draft-save-before-0001";
  beforeInsert.setShare(11, beforeGroup);
  const beforeTransaction = beforeInsert.context.beginComposeFinalizeTransaction(
    11,
    101
  );
  const beforeSnapshot = beforeInsert.context.captureComposeFinalizeSaveSnapshot(11);
  await beforeInsert.context.queueComposeShareAfterSave(
    11,
    "draft",
    { messages: [{ id: 111 }] },
    beforeSnapshot
  );
  assert(
    beforeInsert.calls.persistentSave.length === 0,
    "Save captured before insertion must not persist the share lifecycle"
  );
  await beforeInsert.context.rollbackComposeFinalizeTransaction(
    beforeTransaction,
    "test_cleanup"
  );

  const afterCommit = createComposeHarness();
  const committedGroup = "draft-save-commit-0001";
  afterCommit.setShare(12, committedGroup);
  const committedTransaction = afterCommit.context.beginComposeFinalizeTransaction(
    12,
    102
  );
  committedTransaction.draftGroupId = committedGroup;
  committedTransaction.insertMutation = {
    attempted: false,
    applied: true
  };
  const committedSnapshot = afterCommit.context.captureComposeFinalizeSaveSnapshot(12);
  const committedSave = afterCommit.context.queueComposeShareAfterSave(
    12,
    "draft",
    { messages: [{ id: 112 }] },
    committedSnapshot
  );
  afterCommit.context.commitComposeFinalizeTransaction(committedTransaction);
  await committedSave;
  assert(
    afterCommit.calls.persistentSave.length === 1,
    "Save captured after insertion and commit must persist once"
  );
  assert(
    afterCommit.persistedGroups.get(committedGroup)?.state === "saved"
      && afterCommit.composeCleanup.get(12)?.saved === true,
    "Committed save must update persistent and in-memory lifecycle state"
  );

  const afterRollback = createComposeHarness();
  const rolledBackGroup = "draft-save-rollback-01";
  afterRollback.setShare(13, rolledBackGroup);
  const rolledBackTransaction = afterRollback.context.beginComposeFinalizeTransaction(
    13,
    103
  );
  rolledBackTransaction.draftGroupId = rolledBackGroup;
  rolledBackTransaction.insertMutation = {
    attempted: false,
    applied: true
  };
  const rolledBackSnapshot = afterRollback.context.captureComposeFinalizeSaveSnapshot(13);
  const rolledBackSave = afterRollback.context.queueComposeShareAfterSave(
    13,
    "draft",
    { messages: [{ id: 113 }] },
    rolledBackSnapshot
  );
  await afterRollback.context.rollbackComposeFinalizeTransaction(
    rolledBackTransaction,
    "test_rollback"
  );
  await rolledBackSave;
  assert(
    afterRollback.calls.persistentSave.length === 0,
    "Save captured after insertion but followed by rollback must be ignored"
  );
  assert(
    afterRollback.persistedGroups.get(rolledBackGroup)?.state === "active",
    "Rolled-back save must leave the persistent lifecycle active"
  );
}

async function verifyTemplateLifecycle(){
  const harness = createComposeHarness();
  const groupId = "draft-template-000001";
  harness.setShare(21, groupId, { type: "template" });

  await harness.context.queueComposeShareAfterSave(
    21,
    "template",
    { messages: [{ id: 210 }] },
    { active: false, insertApplied: false, transaction: null }
  );

  const persisted = harness.persistedGroups.get(groupId);
  assert(
    persisted?.state === "saved" && persisted.templateUnsupported === true,
    "Saving as template must persist the unsupported-template state"
  );
  const originalTemplate = await harness.context.validateComposeShareStateForSend(
    21,
    harness.composeDetails.get(21)
  );
  assert(
    originalTemplate.ok === false
      && originalTemplate.reason === "share_template_unsupported",
    "Saved share template must be blocked"
  );

  harness.composeCleanup.delete(21);
  const derivedDetails = {
    ...structuredClone(harness.composeDetails.get(21)),
    type: "new"
  };
  harness.setDetails(22, derivedDetails);
  const derivedCompose = await harness.context.validateComposeShareStateForSend(
    22,
    derivedDetails
  );
  assert(
    derivedCompose.ok === false
      && derivedCompose.reason === "share_template_unsupported",
    "Compose created from a saved share template must remain blocked"
  );
}

async function verifyDraftRecordValidation(){
  const missing = createComposeHarness();
  const missingGroup = "draft-missing-0000001";
  const missingDetails = {
    type: "draft",
    customHeaders: [{ name: DRAFT_HEADER, value: missingGroup }]
  };
  missing.setDetails(31, missingDetails);
  const missingResult = await missing.context.validateComposeShareStateForSend(
    31,
    missingDetails
  );
  assert(
    missingResult.ok === false
      && missingResult.reason === "draft_cleanup_record_missing",
    "Draft marker without a local cleanup record must block send"
  );

  const inconsistent = createComposeHarness();
  const inconsistentGroup = "draft-inconsistent-001";
  inconsistent.setShare(32, inconsistentGroup);
  inconsistent.persistedGroups.get(inconsistentGroup).state = "pending";
  const inconsistentResult = await inconsistent.context.validateComposeShareStateForSend(
    32,
    inconsistent.composeDetails.get(32)
  );
  assert(
    inconsistentResult.ok === false
      && inconsistentResult.reason === "draft_cleanup_record_inconsistent",
    "A tab-bound marker with an inactive persistent record must block send"
  );

  const knownNonDraft = createComposeHarness();
  const knownGroup = "draft-known-pending-001";
  knownNonDraft.setPersistent(knownGroup, { state: "pending" });
  const knownDetails = {
    type: "reply",
    customHeaders: [{ name: DRAFT_HEADER, value: knownGroup }]
  };
  knownNonDraft.setDetails(33, knownDetails);
  const knownResult = await knownNonDraft.context.validateComposeShareStateForSend(
    33,
    knownDetails
  );
  assert(
    knownResult.ok === false
      && knownResult.reason === "draft_cleanup_record_not_rehydratable",
    "Known non-draft marker without a safe tab binding must block send"
  );
  assert(
    knownNonDraft.calls.composeWrites.length === 0,
    "Known unsafe marker must not be removed as foreign metadata"
  );

  const active = createComposeHarness();
  const activeGroup = "draft-active-valid-0001";
  active.setShare(34, activeGroup);
  const activeResult = await active.context.validateComposeShareStateForSend(
    34,
    active.composeDetails.get(34)
  );
  assert(
    activeResult.ok === true,
    "Matching active runtime and persistent state must remain sendable"
  );
}

async function verifyForeignMarkerHandling(){
  const foreign = createComposeHarness();
  const foreignGroup = "foreign-marker-000001";
  const details = {
    type: "reply",
    customHeaders: [
      { name: "X-Other", value: "keep" },
      { name: DRAFT_HEADER, value: foreignGroup }
    ]
  };
  foreign.setDetails(41, details);
  const result = await foreign.context.validateComposeShareStateForSend(
    41,
    details
  );
  assert(
    result.ok === true && result.foreignMarkerIgnored === true,
    "Unknown inherited non-draft marker must be ignored"
  );
  assert(
    foreign.composeDetails.get(41).customHeaders.length === 1
      && foreign.composeDetails.get(41).customHeaders[0].name === "X-Other",
    "Ignoring a foreign marker must remove only the NC Connector header"
  );

  const unavailable = createComposeHarness();
  unavailable.control.storeAvailable = false;
  unavailable.setDetails(42, details);
  const unavailableResult = await unavailable.context.validateComposeShareStateForSend(
    42,
    details
  );
  assert(
    unavailableResult.ok === false
      && unavailableResult.reason === "share_lifecycle_store_unavailable",
    "Unavailable local lifecycle storage must block marker removal"
  );
  assert(
    unavailable.calls.composeWrites.length === 0,
    "Store failure must leave the marker untouched"
  );
}

async function verifyPasswordRefreshFailure(){
  const harness = createComposeHarness();
  const groupId = "draft-password-000001";
  harness.setShare(51, groupId, { saved: true, type: "draft" });
  harness.passwordDispatch.set(51, [{
    registrationId: "registration-1",
    shareId: "share-1",
    savedDraftEnvelopeCaptured: false
  }]);
  harness.getDetailsFailures.set(
    51,
    new Error("recipient_refresh_failed")
  );

  let handoffError = null;
  try{
    await harness.context.handoffSavedDraftPasswordDispatch(51);
  }catch(error){
    handoffError = error;
  }
  assert(
    handoffError?.message === "recipient_refresh_failed",
    "Recipient refresh failure must reject saved-draft handoff"
  );
  assert(
    harness.passwordDispatch.get(51)?.length === 1,
    "Recipient refresh failure must retain the password queue"
  );
  assert(
    harness.composeCleanup.get(51)?.passwordHandoffRequired === true
      && harness.composeCleanup.get(51)?.passwordHandoffComplete === false,
    "Recipient refresh failure must persist an incomplete handoff"
  );

  const sendResult = await harness.beforeSend(
    { id: 51 },
    harness.composeDetails.get(51)
  );
  assert(
    sendResult?.cancel === true,
    "Incomplete password handoff must block the primary draft send"
  );
}

async function verifySavedBaselineRetention(){
  const harness = createComposeHarness();
  const tabId = 56;
  const composeGroupId = "draft-baseline-a-00001";
  const wizardGroupId = "wizard-baseline-b-00001";
  const wizardWindowId = 560;
  harness.setShare(tabId, composeGroupId, {
    saved: true,
    type: "draft"
  });
  const shareBDescriptor = {
    baseUrl: "https://cloud.example.test",
    userId: "user",
    relativeFolder: "FileLink/share-b",
    reservationRelativeFolder: "",
    targetRelativeFolder: ""
  };
  harness.persistedGroups.set(wizardGroupId, {
    version: 1,
    groupId: wizardGroupId,
    ownerKind: "wizard",
    state: "active",
    saved: false,
    passwordHandoffRequired: false,
    passwordHandoffComplete: true,
    templateUnsupported: false,
    lifecycleTainted: false,
    savePendingChanges: false,
    sendPending: false,
    sendPendingPreviousState: "",
    messageIds: [],
    resources: [shareBDescriptor],
    attempt: 0,
    created: Date.now(),
    updated: Date.now()
  });
  const wizardEntry = {
    cleanupId: wizardGroupId,
    windowId: wizardWindowId,
    tabId,
    folderInfo: Object.freeze({
      relativeFolder: "FileLink/share-b",
      folderName: "share-b"
    }),
    shareId: "share-b",
    shareLabel: "Share B",
    shareUrl: "https://cloud.example.test/s/share-b",
    cleanupTarget: null,
    cleanupDescriptor: shareBDescriptor,
    created: Date.now(),
    retryTimerId: null
  };
  harness.context.wizardEntryForTest = wizardEntry;
  vm.runInContext(
    `SHARING_WIZARD_CLEANUP_BY_WINDOW.set(${wizardWindowId}, wizardEntryForTest)`,
    harness.context
  );
  delete harness.context.wizardEntryForTest;
  harness.passwordDispatch.set(tabId, [{
    registrationId: "share-b-password",
    shareId: "share-b"
  }]);

  const mutation = await harness.context.armComposeShareCleanup(
    tabId,
    {
      wizardWindowId,
      shareId: "share-b",
      shareLabel: "Share B",
      shareUrl: "https://cloud.example.test/s/share-b",
      folderInfo: {
        relativeFolder: "FileLink/share-b",
        folderName: "share-b"
      }
    },
    {
      draftGroupId: composeGroupId,
      persist: true,
      transferWizardOwnership: false
    }
  );
  harness.context.completeComposeShareCleanupArm(
    mutation,
    "test_commit"
  );

  const stagedRuntime = harness.composeCleanup.get(tabId);
  const stagedPersistent = harness.persistedGroups.get(composeGroupId);
  assert(
    stagedRuntime?.saved === true
      && stagedRuntime.savePendingChanges === true
      && stagedRuntime.entries.length === 2,
    "Adding Share B must keep saved Share A as a retained baseline"
  );
  assert(
    stagedPersistent?.state === "saved"
      && stagedPersistent.saved === true
      && stagedPersistent.savePendingChanges === true
      && stagedPersistent.resources.length === 2,
    "Saved baseline plus Share B must remain retained in persistent state"
  );

  await harness.context.handleComposeTabRemoved(tabId);
  assert(
    harness.composeCleanup.has(tabId) === false,
    "Closing without another save must detach the retained runtime state"
  );
  assert(
    harness.persistedGroups.get(composeGroupId)?.resources.length === 2,
    "Closing without another save must retain Share A and Share B"
  );
  assert(
    harness.calls.remoteDeletes.length === 0,
    "Closing saved baseline plus unsaved Share B must not delete either share"
  );
  assert(
    harness.calls.manualFallback.length === 0
      && harness.passwordDispatch.has(tabId) === false,
    "Discarded Share B changes must not create a misleading password draft"
  );
}

async function verifyTabCloseWaitsForSave(){
  const harness = createComposeHarness();
  const groupId = "draft-close-wait-00001";
  harness.setShare(61, groupId);
  harness.control.saveDeferred = createDeferred();
  const savePromise = harness.context.queueComposeShareAfterSave(
    61,
    "draft",
    { messages: [{ id: 610 }] },
    { active: false, insertApplied: false, transaction: null }
  );
  await waitFor(
    () => harness.calls.persistentSave.length === 1,
    "Save task did not enter persistent storage"
  );

  const closePromise = harness.context.handleComposeTabRemoved(61);
  await Promise.resolve();
  assert(
    harness.composeCleanup.has(61),
    "Tab close must retain runtime cleanup while save persistence is pending"
  );
  assert(
    harness.calls.attachmentCleanup.length === 0,
    "Tab close must not clear tab state before the save task settles"
  );

  harness.control.saveDeferred.resolve();
  await Promise.all([savePromise, closePromise]);
  assert(
    harness.persistedGroups.get(groupId)?.state === "saved",
    "Completed save must remain persisted after tab close"
  );
  assert(
    harness.composeCleanup.has(61) === false,
    "Tab close must detach the saved runtime state after persistence"
  );
  assert(
    harness.calls.remoteDeletes.length === 0,
    "Closing a successfully saved draft must not delete its remote share"
  );
}

async function verifySendLaterManualPasswordDraft(){
  const harness = createComposeHarness();
  const groupId = "draft-send-later-0001";
  harness.setShare(71, groupId);
  harness.passwordDispatch.set(71, [{
    registrationId: "registration-later",
    shareId: "share-later",
    identityId: "identity-1",
    from: "Sender <sender@example.test>",
    fromEmail: "sender@example.test"
  }]);

  await harness.afterSend(
    { id: 71 },
    { mode: "sendLater", error: "", headerMessageId: "" }
  );
  await waitFor(
    () => harness.calls.stagedSendLater.length === 1,
    "sendLater did not create its manual password draft"
  );

  assert(
    harness.composeCleanup.has(71) === false
      && harness.persistedGroups.has(groupId) === false,
    "Queued primary mail must commit cleanup ownership without deleting the share"
  );
  assert(
    harness.calls.remoteDeletes.length === 0,
    "sendLater must retain the remote share"
  );
  assert(
    harness.passwordDispatch.has(71) === false,
    "sendLater must transfer the password queue out of the primary compose"
  );
  assert(
    harness.calls.sentPassword.length === 0,
    "sendLater must never auto-send the password mail"
  );

  await harness.context.handleComposeTabRemoved(71);
  assert(
    harness.calls.remoteDeletes.length === 0,
    "Closing the queued primary compose must not delete its committed share"
  );
}

async function run(){
  await verifySaveOrdering();
  await verifyTemplateLifecycle();
  await verifyDraftRecordValidation();
  await verifyForeignMarkerHandling();
  await verifyPasswordRefreshFailure();
  await verifySavedBaselineRetention();
  await verifyTabCloseWaitsForSave();
  await verifySendLaterManualPasswordDraft();
  console.log("[OK] compose-send-lifecycle-check passed");
}

run().catch((error) => {
  console.error("[FAIL] compose-send-lifecycle-check", error);
  process.exitCode = 1;
});
