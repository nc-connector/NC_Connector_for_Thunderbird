"use strict";

const vm = require("node:vm");
const { assert, loadScript, readJson, readText } = require("./review-check-utils");

function createScheduler(){
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback){
      const id = nextId;
      nextId += 1;
      tasks.set(id, callback);
      return id;
    },
    clearTimeout(id){
      tasks.delete(id);
    },
    runAll(){
      const pending = Array.from(tasks.values());
      tasks.clear();
      for (const callback of pending){
        callback();
      }
    },
    get size(){
      return tasks.size;
    }
  };
}

function createLifecycleHarness({
  deleteFailures = 0,
  deleteStatus = 0,
  deferDelete = false,
  deferFirstStorageWrite = false,
  initialRoomDeleteRetry = {},
  storageFailures = 0
} = {}){
  const scheduler = createScheduler();
  const deletedRooms = [];
  const deletedMeta = [];
  const removedEventMappings = [];
  const referencedTokens = new Set();
  let deleteAttempts = 0;
  let deleteStarted = false;
  let storageAttempts = 0;
  let persistedRoomDeleteRetry =
    JSON.parse(JSON.stringify(initialRoomDeleteRetry));
  let releaseDeferredDelete = null;
  let releaseFirstStorageWrite = null;
  const firstStorageGate = deferFirstStorageWrite
    ? new Promise((resolve) => {
        releaseFirstStorageWrite = resolve;
      })
    : null;
  const context = {
    AbortController,
    BG_STATE_READY: Promise.resolve(),
    CALENDAR_WIZARD_CONTEXTS: new Map(),
    CALENDAR_WIZARD_CONTEXT_TTL_MS: 60_000,
    L(){},
    NCTalkCore: {
      async deleteTalkRoom({ token, signal }){
        deleteAttempts += 1;
        deleteStarted = true;
        if (deferDelete){
          await new Promise((resolve, reject) => {
            releaseDeferredDelete = resolve;
            signal?.addEventListener?.("abort", () => {
              const error = new Error("Request canceled");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        if (deleteAttempts <= deleteFailures){
          const error = new Error("temporary delete failure");
          error.status = 503;
          throw error;
        }
        if (deleteStatus){
          const error = new Error("room delete rejected");
          error.status = deleteStatus;
          throw error;
        }
        deletedRooms.push(token);
      }
    },
    Promise,
    ROOM_DELETE_RETRY: JSON.parse(JSON.stringify(initialRoomDeleteRetry)),
    ROOM_DELETE_RETRY_DELAYS_MS: [2, 5, 10, 30, 60],
    ROOM_DELETE_RETRY_KEY: "nctalkRoomDeleteRetry",
    ROOM_DELETE_RETRY_TIMER_BY_TOKEN: new Map(),
    ROOM_CLEANUP_BY_EDITOR: new Map(),
    ROOM_CLEANUP_BY_TOKEN: new Map(),
    ROOM_CLEANUP_DELETE_DELAY_MS: 15_000,
    clearTimeout: scheduler.clearTimeout,
    console: { error(){} },
    browser: {
      storage: {
        local: {
          async set(values){
            storageAttempts += 1;
            if (storageAttempts <= storageFailures){
              throw new Error("storage write failed");
            }
            if (storageAttempts === 1 && firstStorageGate){
              await firstStorageGate;
            }
            if (values.nctalkRoomDeleteRetry){
              persistedRoomDeleteRetry =
                JSON.parse(JSON.stringify(values.nctalkRoomDeleteRetry));
            }
          }
        }
      }
    },
    async deleteRoomMeta(token){
      deletedMeta.push(token);
    },
    async removeEventTokenEntryIfToken(calendarId, itemId, token){
      removedEventMappings.push({ calendarId, itemId, token });
      return false;
    },
    globalThis: null,
    hasTrustedEventTokenReference(token){
      return referencedTokens.has(token);
    },
    setTimeout: scheduler.setTimeout,
    shortToken: (token) => token
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript(
    "modules/bgCalendarLifecycle.js",
    context,
    "\nglobalThis.NCCalendarCleanupTest = { handleCalendarItemsEditorClosed, removeRoomCleanupEntry, mergeCalendarEventFields, persistTalkRoomDeleteRetry, clearTalkRoomDeleteRetry, runTalkRoomDeleteRetry, cancelActiveTalkRoomDelete };"
  );
  return {
    context,
    deletedMeta,
    deletedRooms,
    removedEventMappings,
    referencedTokens,
    scheduler,
    get deleteStarted(){
      return deleteStarted;
    },
    releaseDelete(){
      releaseDeferredDelete?.();
    },
    get deleteAttempts(){
      return deleteAttempts;
    },
    get persistedRoomDeleteRetry(){
      return JSON.parse(JSON.stringify(persistedRoomDeleteRetry));
    },
    get storageAttempts(){
      return storageAttempts;
    },
    releaseFirstStorageWrite(){
      releaseFirstStorageWrite?.();
    }
  };
}

function trackRoom(harness, editorId, token){
  const entry = { editorKey: editorId, scheduleNonce: 0, timerId: null };
  harness.context.ROOM_CLEANUP_BY_EDITOR.set(editorId, token);
  harness.context.ROOM_CLEANUP_BY_TOKEN.set(token, entry);
  return entry;
}

function loadCalendarUpsertHandler(callOrder){
  const calendarSource = readText("modules/bgCalendar.js");
  const start = calendarSource.indexOf("async function handleCalendarItemUpsert");
  const end = calendarSource.indexOf("\nasync function handleCalendarItemRemoved", start);
  assert(start >= 0 && end > start, "Calendar upsert handler should be present");
  const context = {
    BG_STATE_READY: Promise.resolve(),
    L(){},
    console: { error(){} },
    extractTalkMetadataFromIcal(payload){
      return payload === "with-token" ? { token: "stored-token" } : {};
    },
    getEventTokenEntry(){
      return null;
    },
    getRoomMeta(){
      callOrder.push("read-room-meta");
      throw new Error("stop after persistence signal");
    },
    removeRoomCleanupEntry(token, reason){
      callOrder.push(`clear:${token}:${reason}`);
    },
    async setEventTokenEntry(){
      callOrder.push("set-event-token");
    },
    shortToken: (token) => token
  };
  vm.createContext(context);
  vm.runInContext(
    `${calendarSource.slice(start, end)}\nglobalThis.handleCalendarItemUpsert = handleCalendarItemUpsert;`,
    context,
    { filename: "modules/bgCalendar.js#handleCalendarItemUpsert" }
  );
  return context.handleCalendarItemUpsert;
}

async function flushPromises(){
  for (let i = 0; i < 30; i++){
    await Promise.resolve();
  }
}

async function run(){
  const experimentSource = readText("experiments/ncCalToolbar/parent.js");
  assert(!experimentSource.includes('add("dialogaccept"'), "A save attempt must not report a stored event");
  assert(!experimentSource.includes('add("dialogextra1"'), "Save-and-close must not report a stored event before calendar persistence");
  assert(
    experimentSource.includes('add("unload", () => emitOnce("discarded", "unload"), true)'),
    "Editor unload should keep the discard cleanup path"
  );

  const schema = readJson("experiments/ncCalToolbar/schema.json");
  const namespace = schema.find((entry) => entry.namespace === "ncCalToolbar");
  const actionType = namespace?.types?.find((entry) => entry.id === "EditorClosedAction");
  const reasonType = namespace?.types?.find((entry) => entry.id === "EditorClosedReason");
  assert(!actionType?.enum?.includes("persisted"), "Editor-close actions must not claim calendar persistence");
  assert(!reasonType?.enum?.includes("dialogaccept"), "dialogaccept must not remain a persistence reason");
  assert(!reasonType?.enum?.includes("dialogextra1"), "dialogextra1 must not remain a persistence reason");

  const liveFieldMerge = createLifecycleHarness().context.NCCalendarCleanupTest.mergeCalendarEventFields(
    { title: "Old", location: "Old room", description: "Old description" },
    { title: "", location: "", description: "" }
  );
  assert(liveFieldMerge.title === "", "An intentionally cleared live title must stay empty");
  assert(liveFieldMerge.location === "", "An intentionally cleared live location must stay empty");
  assert(liveFieldMerge.description === "", "An intentionally cleared live description must stay empty");

  const serializedRetryState = createLifecycleHarness({
    deferFirstStorageWrite: true
  });
  const firstRetryWrite =
    serializedRetryState.context.NCCalendarCleanupTest.persistTalkRoomDeleteRetry({
      token: "first-token",
      attempts: 0,
      nextAttemptAt: 1
    });
  await flushPromises();
  const secondRetryWrite =
    serializedRetryState.context.NCCalendarCleanupTest.persistTalkRoomDeleteRetry({
      token: "second-token",
      attempts: 0,
      nextAttemptAt: 2
    });
  await flushPromises();
  assert(
    serializedRetryState.storageAttempts === 1,
    "ROOM_DELETE_RETRY mutations must wait for the active storage commit"
  );
  assert(
    !serializedRetryState.context.ROOM_DELETE_RETRY["first-token"],
    "An uncommitted ROOM_DELETE_RETRY write must not reach the runtime mirror"
  );
  serializedRetryState.releaseFirstStorageWrite();
  await Promise.all([firstRetryWrite, secondRetryWrite]);
  assert(
    serializedRetryState.storageAttempts === 2,
    "Serialized ROOM_DELETE_RETRY mutations must both reach storage"
  );
  assert(
    serializedRetryState.context.ROOM_DELETE_RETRY["first-token"]?.token === "first-token"
      && serializedRetryState.context.ROOM_DELETE_RETRY["second-token"]?.token === "second-token",
    "Serialized ROOM_DELETE_RETRY writes must retain both records"
  );
  assert(
    serializedRetryState.persistedRoomDeleteRetry["first-token"]?.token === "first-token"
      && serializedRetryState.persistedRoomDeleteRetry["second-token"]?.token === "second-token",
    "The final persisted ROOM_DELETE_RETRY snapshot must retain both records"
  );

  const rejectedRetryState = createLifecycleHarness({
    initialRoomDeleteRetry: {
      "stable-token": {
        token: "stable-token",
        attempts: 0,
        nextAttemptAt: 1
      }
    },
    storageFailures: 1
  });
  let retryStorageRejected = false;
  try{
    await rejectedRetryState.context.NCCalendarCleanupTest.persistTalkRoomDeleteRetry({
      token: "must-not-commit",
      attempts: 0,
      nextAttemptAt: 2
    });
  }catch(error){
    retryStorageRejected = true;
  }
  assert(retryStorageRejected, "A rejected ROOM_DELETE_RETRY storage write must propagate");
  assert(
    !rejectedRetryState.context.ROOM_DELETE_RETRY["must-not-commit"]
      && rejectedRetryState.context.ROOM_DELETE_RETRY["stable-token"]?.token === "stable-token",
    "A rejected ROOM_DELETE_RETRY storage write must leave the runtime mirror unchanged"
  );

  const rejectedRetryClear = createLifecycleHarness({
    initialRoomDeleteRetry: {
      "stable-token": {
        token: "stable-token",
        attempts: 1,
        nextAttemptAt: 2
      }
    },
    storageFailures: 1
  });
  let retryClearRejected = false;
  try{
    await rejectedRetryClear.context.NCCalendarCleanupTest.clearTalkRoomDeleteRetry(
      "stable-token",
      "test_rejection"
    );
  }catch(error){
    retryClearRejected = true;
  }
  assert(retryClearRejected, "A rejected ROOM_DELETE_RETRY clear must propagate");
  assert(
    rejectedRetryClear.context.ROOM_DELETE_RETRY["stable-token"]?.token === "stable-token",
    "A rejected ROOM_DELETE_RETRY clear must retain the runtime evidence"
  );

  const rejectedSave = createLifecycleHarness();
  const rejectedEditor = "ed-12345678-1234-1234-1234-123456789abc";
  trackRoom(rejectedSave, rejectedEditor, "rejected-token");
  rejectedSave.context.NCCalendarCleanupTest.handleCalendarItemsEditorClosed({
    editorId: rejectedEditor,
    action: "discarded",
    reason: "unload"
  });
  await flushPromises();
  assert(rejectedSave.scheduler.size === 1, "Discarding after a rejected save should schedule room deletion");
  rejectedSave.scheduler.runAll();
  await flushPromises();
  assert(rejectedSave.deletedRooms.join(",") === "rejected-token", "Discarded editor should delete its pending room");
  assert(rejectedSave.deletedMeta.join(",") === "rejected-token", "Discarded editor should delete local room metadata");

  const storedEvent = createLifecycleHarness();
  const storedEditor = "ed-abcdefab-cdef-abcd-efab-cdefabcdefab";
  trackRoom(storedEvent, storedEditor, "stored-token");
  storedEvent.context.NCCalendarCleanupTest.handleCalendarItemsEditorClosed({
    editorId: storedEditor,
    action: "discarded",
    reason: "unload"
  });
  await flushPromises();
  storedEvent.context.NCCalendarCleanupTest.removeRoomCleanupEntry("stored-token", "calendar_item_persisted");
  await flushPromises();
  assert(storedEvent.scheduler.size === 0, "A stored calendar event should cancel pending room deletion");
  storedEvent.scheduler.runAll();
  await flushPromises();
  assert(storedEvent.deletedRooms.length === 0, "A stored calendar event must retain its Talk room");

  const retryDelete = createLifecycleHarness({ deleteFailures: 1 });
  const retryEditor = "ed-fedcbafe-dcba-fedc-bafe-dcbafedcbafe";
  trackRoom(retryDelete, retryEditor, "retry-token");
  retryDelete.context.NCCalendarCleanupTest.handleCalendarItemsEditorClosed({
    editorId: retryEditor,
    action: "discarded",
    reason: "unload"
  });
  await flushPromises();
  retryDelete.scheduler.runAll();
  await flushPromises();
  assert(retryDelete.deleteAttempts === 1, "The first delete attempt should run");
  assert(
    retryDelete.context.ROOM_DELETE_RETRY["retry-token"]?.attempts === 1,
    "A temporary delete failure must stay in persistent retry state"
  );
  assert(retryDelete.deletedMeta.length === 0, "A failed delete must retain room metadata");
  assert(retryDelete.scheduler.size === 1, "A temporary delete failure must schedule a bounded retry");
  retryDelete.scheduler.runAll();
  await flushPromises();
  assert(retryDelete.deleteAttempts === 2, "The scheduled room delete retry should run");
  assert(retryDelete.deletedRooms.join(",") === "retry-token", "The retry should delete the room");
  assert(!retryDelete.context.ROOM_DELETE_RETRY["retry-token"], "A successful retry must clear persistent state");
  assert(retryDelete.deletedMeta.join(",") === "retry-token", "A successful retry must clear room metadata");

  const forbiddenDelete = createLifecycleHarness({
    deleteStatus: 403,
    initialRoomDeleteRetry: {
      "forbidden-token": {
        token: "forbidden-token",
        attempts: 0,
        nextAttemptAt: 0,
        reason: "saved_event_removed",
        calendarId: "calendar-a",
        itemId: "item-a"
      }
    }
  });
  await forbiddenDelete.context.NCCalendarCleanupTest.runTalkRoomDeleteRetry(
    "forbidden-token"
  );
  const forbiddenEvidence =
    forbiddenDelete.context.ROOM_DELETE_RETRY["forbidden-token"];
  assert(
    forbiddenEvidence?.exhausted === true
      && forbiddenEvidence?.terminalReason === "delete_forbidden"
      && forbiddenEvidence?.terminalStatus === 403,
    "HTTP 403 must remain as exhausted persistent room-delete evidence"
  );
  assert(
    forbiddenDelete.persistedRoomDeleteRetry["forbidden-token"]?.terminalStatus === 403,
    "HTTP 403 evidence must be committed to storage"
  );
  assert(
    forbiddenDelete.deletedMeta.length === 0,
    "HTTP 403 must retain local room metadata because the room still exists"
  );
  assert(
    forbiddenDelete.removedEventMappings.length === 0,
    "HTTP 403 must not erase the event-token evidence"
  );

  const referencedDuringDelete = createLifecycleHarness({ deferDelete: true });
  referencedDuringDelete.context.ROOM_DELETE_RETRY["moving-token"] = {
    token: "moving-token",
    attempts: 0,
    nextAttemptAt: 0,
    reason: "saved_event_removed"
  };
  const activeDelete =
    referencedDuringDelete.context.NCCalendarCleanupTest.runTalkRoomDeleteRetry("moving-token");
  await flushPromises();
  assert(referencedDuringDelete.deleteStarted, "The deferred room delete must enter its HTTP request");
  referencedDuringDelete.referencedTokens.add("moving-token");
  referencedDuringDelete.context.NCCalendarCleanupTest.removeRoomCleanupEntry(
    "moving-token",
    "calendar_item_persisted"
  );
  await activeDelete;
  await flushPromises();
  assert(
    referencedDuringDelete.deletedRooms.length === 0,
    "A new calendar reference must abort an in-flight room deletion"
  );
  assert(
    referencedDuringDelete.deletedMeta.length === 0,
    "An aborted room deletion must retain local room metadata"
  );
  assert(
    !referencedDuringDelete.context.ROOM_DELETE_RETRY["moving-token"],
    "A new trusted reference must clear the obsolete delete retry"
  );

  const callOrder = [];
  const handleCalendarItemUpsert = loadCalendarUpsertHandler(callOrder);
  await handleCalendarItemUpsert({ type: "event", item: "without-token" });
  assert(callOrder.length === 0, "Calendar items without connector metadata must not clear room cleanup");
  try{
    await handleCalendarItemUpsert({ type: "event", item: "with-token" });
  }catch(error){
    assert(error.message === "stop after persistence signal", "Unexpected calendar upsert test failure");
  }
  assert(
    callOrder.join(",") === "clear:stored-token:calendar_item_persisted,set-event-token,read-room-meta",
    "A stored item with connector metadata should clear cleanup and map its token before later synchronization"
  );

  console.log("[OK] calendar-room-cleanup-check passed");
}

run().catch((error) => {
  console.error("[FAIL] calendar-room-cleanup-check", error);
  process.exitCode = 1;
});
