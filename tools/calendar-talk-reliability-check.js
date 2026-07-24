"use strict";

const vm = require("node:vm");
const path = require("node:path");
const { assert, loadScript, readText } = require("./review-check-utils");

function sourceSection(file, startMarker, endMarker){
  const source = readText(file);
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Could not extract ${startMarker} from ${file}`);
  return source.slice(start, end);
}

async function expectRejected(callback, message){
  let rejected = false;
  try{
    await callback();
  }catch(error){
    rejected = true;
  }
  assert(rejected, message);
}

async function flushPromises(){
  for (let i = 0; i < 20; i++){
    await Promise.resolve();
  }
}

function createCallbackScheduler(){
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimeout(callback){
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id){
      callbacks.delete(id);
    },
    runAll(){
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      pending.forEach((callback) => callback());
    },
    get size(){
      return callbacks.size;
    }
  };
}

function createDepartureHarness({
  calendarGetFailures = 0,
  calendarItem = null,
  calendarItemMeta = {},
  initialRoomMeta = {},
  leaveFailures = 0,
  deferLeave = false,
  deferFirstStorageWrite = false,
  storageFailures = 0
} = {}){
  const scheduler = createCallbackScheduler();
  let leaveAttempts = 0;
  let calendarGetAttempts = 0;
  let storageAttempts = 0;
  let persistedRoomMeta = JSON.parse(JSON.stringify(initialRoomMeta));
  let releaseLeave = null;
  let releaseFirstStorageWrite = null;
  const loggedErrors = [];
  const queuedCalendarItems = [];
  const firstStorageGate = deferFirstStorageWrite
    ? new Promise((resolve) => {
        releaseFirstStorageWrite = resolve;
      })
    : null;
  const context = {
    BG_STATE_READY: Promise.resolve(),
    Date,
    EVENT_TOKEN_MAP: {},
    EVENT_TOKEN_MAP_KEY: "nctalkEventTokenMap",
    L(){},
    Promise,
    ROOM_META: JSON.parse(JSON.stringify(initialRoomMeta)),
    ROOM_META_KEY: "nctalkRoomMeta",
    NCTalkCore: {
      async leaveTalkRoom(){
        leaveAttempts += 1;
        if (deferLeave){
          await new Promise((resolve) => {
            releaseLeave = resolve;
          });
        }
        if (leaveAttempts <= leaveFailures){
          throw new Error("temporary leave failure");
        }
      }
    },
    NCCore: {
      async getOpts(){
        return {};
      },
      async getCurrentUserId(){
        return "owner-user";
      }
    },
    cancelActiveTalkRoomDelete(){},
    extractTalkMetadataFromIcal(){
      return JSON.parse(JSON.stringify(calendarItemMeta));
    },
    async queueCalendarItemUpsert(item){
      queuedCalendarItems.push(item);
    },
    browser: {
      calendar: {
        items: {
          async get(){
            calendarGetAttempts += 1;
            if (calendarGetAttempts <= calendarGetFailures){
              throw new Error("calendar item read failed");
            }
            return calendarItem;
          }
        }
      },
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
            if (values.nctalkRoomMeta){
              persistedRoomMeta = JSON.parse(JSON.stringify(values.nctalkRoomMeta));
            }
          }
        }
      }
    },
    clearTimeout: scheduler.clearTimeout,
    console: {
      error(...args){
        loggedErrors.push(args);
      }
    },
    setTimeout: scheduler.setTimeout,
    shortToken: (token) => token
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/bgCalendarState.js", context);
  loadScript(
    "modules/bgCalendarDeparture.js",
    context,
    "\nglobalThis.NCCalendarDepartureTest = { runCalendarDepartureRetry, resumeCalendarDepartureRetries, setRoomMeta, setRoomMetaIf, setEventTokenEntry, removeEventTokenEntryIfToken, hasTrustedEventTokenReferenceExcept };"
  );
  return {
    context,
    loggedErrors,
    queuedCalendarItems,
    scheduler,
    get calendarGetAttempts(){
      return calendarGetAttempts;
    },
    get leaveAttempts(){
      return leaveAttempts;
    },
    get storageAttempts(){
      return storageAttempts;
    },
    get persistedRoomMeta(){
      return JSON.parse(JSON.stringify(persistedRoomMeta));
    },
    releaseLeave(){
      releaseLeave?.();
    },
    releaseFirstStorageWrite(){
      releaseFirstStorageWrite?.();
    }
  };
}

async function testCalendarQueue(){
  const queueSource = sourceSection(
    "modules/bgCalendar.js",
    "const CALENDAR_OPERATION_QUEUE",
    "/**\n * Register calendar experiment listeners"
  );
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const processed = [];
  const retryTimers = new Map();
  let nextTimerId = 1;
  let retryAttempts = 0;
  let removeRetryAttempts = 0;
  const context = {
    L(){},
    Promise,
    console: { error(){} },
    setTimeout(callback){
      const timerId = nextTimerId;
      nextTimerId += 1;
      retryTimers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(timerId){
      retryTimers.delete(timerId);
    },
    makeEventMapKey(calendarId, itemId){
      return calendarId && itemId ? `${calendarId}::${itemId}` : "";
    },
    async handleCalendarItemUpsert(item){
      if (item.waitGate){
        processed.push(item.revision);
        await item.waitGate;
        if (item.failAfterGate){
          const error = new Error("temporary delayed failure");
          error.ncCalendarRetryable = true;
          error.ncCalendarRetryCode = "delayed";
          throw error;
        }
        return;
      }
      if (item.retryCase){
        retryAttempts += 1;
        if (retryAttempts === 1){
          const error = new Error("temporary addressbook failure");
          error.ncCalendarRetryable = true;
          error.ncCalendarRetryCode = "addressbook";
          throw error;
        }
        processed.push(item.revision);
        return;
      }
      processed.push(item.revision);
      if (item.revision === 1){
        await firstGate;
      }
    },
    async handleCalendarItemRemoved(calendarId, itemId){
      if (calendarId === "calendar-remove-retry"){
        removeRetryAttempts += 1;
        if (removeRetryAttempts === 1){
          const error = new Error("temporary delete-intent persistence failure");
          error.ncCalendarRetryable = true;
          error.ncCalendarRetryCode = "room_delete_schedule";
          throw error;
        }
      }
      processed.push(`remove:${calendarId}:${itemId}`);
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${queueSource}
globalThis.NCCalendarQueueTest = { queueCalendarItemUpsert, queueCalendarItemRemoved };`,
    context,
    { filename: "modules/bgCalendar.js#calendar-operation-queue" }
  );

  const first = context.NCCalendarQueueTest.queueCalendarItemUpsert({
    type: "event",
    calendarId: "calendar-a",
    id: "item-a",
    revision: 1
  });
  await flushPromises();
  const second = context.NCCalendarQueueTest.queueCalendarItemUpsert({
    type: "event",
    calendarId: "calendar-a",
    id: "item-a",
    revision: 2
  });
  const third = context.NCCalendarQueueTest.queueCalendarItemUpsert({
    type: "event",
    calendarId: "calendar-a",
    id: "item-a",
    revision: 3
  });
  releaseFirst();
  await Promise.all([first, second, third]);
  assert(
    processed.join(",") === "1,3",
    "The serial queue must process the active update and the latest coalesced update"
  );

  await expectRejected(
    () => context.NCCalendarQueueTest.queueCalendarItemUpsert({
      type: "event",
      calendarId: "calendar-b",
      id: "item-b",
      revision: 4,
      retryCase: true
    }),
    "The original retryable upsert must report its failed attempt"
  );
  assert(retryTimers.size === 1, "A retryable calendar error must schedule one bounded retry");
  const retryCallback = retryTimers.values().next().value;
  retryTimers.clear();
  retryCallback();
  await flushPromises();
  assert(retryAttempts === 2, "The scheduled calendar upsert retry must run");
  assert(processed.join(",") === "1,3,4", "The retry must preserve the latest event payload");

  await expectRejected(
    () => context.NCCalendarQueueTest.queueCalendarItemRemoved(
      "calendar-remove-retry",
      "item-remove-retry"
    ),
    "The original retryable remove must report its failed attempt"
  );
  assert(
    retryTimers.size === 1,
    "A retryable room-delete persistence failure must schedule one bounded remove retry"
  );
  const removeRetryCallback = retryTimers.values().next().value;
  retryTimers.clear();
  removeRetryCallback();
  await flushPromises();
  assert(removeRetryAttempts === 2, "The scheduled calendar remove retry must run");
  assert(
    processed.includes("remove:calendar-remove-retry:item-remove-retry"),
    "The calendar remove retry must preserve the deleted event identity"
  );

  let releaseStaleForRemove;
  const staleForRemoveGate = new Promise((resolve) => {
    releaseStaleForRemove = resolve;
  });
  const staleForRemove = context.NCCalendarQueueTest.queueCalendarItemUpsert({
    type: "event",
    calendarId: "calendar-c",
    id: "item-c",
    revision: 5,
    waitGate: staleForRemoveGate,
    failAfterGate: true
  });
  await flushPromises();
  const removeAfterFailure = context.NCCalendarQueueTest.queueCalendarItemRemoved(
    "calendar-c",
    "item-c"
  );
  releaseStaleForRemove();
  await expectRejected(
    () => staleForRemove,
    "The superseded active upsert must still report its failed original attempt"
  );
  await removeAfterFailure;
  assert(
    retryTimers.size === 0,
    "A remove received during an active upsert must suppress its stale retry"
  );

  let releaseStaleForUpdate;
  const staleForUpdateGate = new Promise((resolve) => {
    releaseStaleForUpdate = resolve;
  });
  const staleForUpdate = context.NCCalendarQueueTest.queueCalendarItemUpsert({
    type: "event",
    calendarId: "calendar-d",
    id: "item-d",
    revision: 6,
    waitGate: staleForUpdateGate,
    failAfterGate: true
  });
  await flushPromises();
  const newerUpdate = context.NCCalendarQueueTest.queueCalendarItemUpsert({
    type: "event",
    calendarId: "calendar-d",
    id: "item-d",
    revision: 7
  });
  releaseStaleForUpdate();
  await expectRejected(
    () => staleForUpdate,
    "The failed active revision must reject even when a newer revision is queued"
  );
  await newerUpdate;
  assert(
    retryTimers.size === 0,
    "A newer upsert received during an active upsert must suppress its stale retry"
  );
  assert(
    processed.slice(-2).join(",") === "6,7",
    "The newer revision must run after the failed superseded revision"
  );

  let releaseQueueBlocker;
  const queueBlockerGate = new Promise((resolve) => {
    releaseQueueBlocker = resolve;
  });
  const queueBlocker = context.NCCalendarQueueTest.queueCalendarItemUpsert({
    type: "event",
    calendarId: "calendar-blocker",
    id: "item-blocker",
    revision: "blocker",
    waitGate: queueBlockerGate
  });
  await flushPromises();
  const sequenceStart = processed.length;
  const beforeRemove = context.NCCalendarQueueTest.queueCalendarItemUpsert({
    type: "event",
    calendarId: "calendar-e",
    id: "item-e",
    revision: 8
  });
  const middleRemove = context.NCCalendarQueueTest.queueCalendarItemRemoved(
    "calendar-e",
    "item-e"
  );
  const afterRemove = context.NCCalendarQueueTest.queueCalendarItemUpsert({
    type: "event",
    calendarId: "calendar-e",
    id: "item-e",
    revision: 9
  });
  releaseQueueBlocker();
  await Promise.all([queueBlocker, beforeRemove, middleRemove, afterRemove]);
  assert(
    processed.slice(sequenceStart).join(",") === "8,remove:calendar-e:item-e,9",
    "Upsert/remove/upsert must preserve causal order instead of coalescing across the remove"
  );
}

async function testSerializedRoomMetaMutations(){
  const serialized = createDepartureHarness({
    initialRoomMeta: {
      "room-token": { existing: true }
    },
    deferFirstStorageWrite: true
  });
  const first = serialized.context.NCCalendarDepartureTest.setRoomMeta(
    "room-token",
    { first: true }
  );
  await flushPromises();
  const second = serialized.context.NCCalendarDepartureTest.setRoomMeta(
    "room-token",
    { second: true }
  );
  await flushPromises();
  assert(
    serialized.storageAttempts === 1,
    "A second ROOM_META mutation must wait until the first storage commit finishes"
  );
  serialized.releaseFirstStorageWrite();
  await Promise.all([first, second]);
  assert(
    serialized.storageAttempts === 2,
    "Both serialized ROOM_META mutations must reach persistent storage"
  );
  assert(
    serialized.context.ROOM_META["room-token"].first === true
      && serialized.context.ROOM_META["room-token"].second === true,
    "Serialized ROOM_META patches must merge without losing the earlier write"
  );
  assert(
    serialized.persistedRoomMeta["room-token"].first === true
      && serialized.persistedRoomMeta["room-token"].second === true,
    "The final persisted ROOM_META snapshot must contain both serialized patches"
  );

  const rejected = createDepartureHarness({
    initialRoomMeta: {
      "room-token": { stable: true }
    },
    storageFailures: 1
  });
  await expectRejected(
    () => rejected.context.NCCalendarDepartureTest.setRoomMeta(
      "room-token",
      { mustNotCommit: true }
    ),
    "A rejected ROOM_META storage write must propagate to the caller"
  );
  assert(
    rejected.context.ROOM_META["room-token"].mustNotCommit !== true,
    "A rejected ROOM_META storage write must not be committed to the runtime mirror"
  );

  const serializedEventMap = createDepartureHarness({
    deferFirstStorageWrite: true
  });
  const firstMapping =
    serializedEventMap.context.NCCalendarDepartureTest.setEventTokenEntry(
      "calendar-a",
      "item-a",
      { token: "token-a", source: "x-nctalk" }
    );
  await flushPromises();
  const secondMapping =
    serializedEventMap.context.NCCalendarDepartureTest.setEventTokenEntry(
      "calendar-b",
      "item-b",
      { token: "token-b", source: "x-nctalk" }
    );
  await flushPromises();
  assert(
    serializedEventMap.storageAttempts === 1,
    "A second EVENT_TOKEN_MAP mutation must wait for the first storage commit"
  );
  serializedEventMap.releaseFirstStorageWrite();
  await Promise.all([firstMapping, secondMapping]);
  assert(
    serializedEventMap.context.EVENT_TOKEN_MAP["calendar-a::item-a"]?.token === "token-a"
      && serializedEventMap.context.EVENT_TOKEN_MAP["calendar-b::item-b"]?.token === "token-b",
    "Serialized event-token writes must retain both mappings"
  );
  await serializedEventMap.context.NCCalendarDepartureTest.setEventTokenEntry(
    "calendar-c",
    "item-c",
    { token: "token-a", source: "x-nctalk" }
  );
  assert(
    serializedEventMap.context.NCCalendarDepartureTest.hasTrustedEventTokenReferenceExcept(
      "token-a",
      "calendar-a",
      "item-a"
    ) === true,
    "Reference checks must find the same token on a different calendar item"
  );
  assert(
    serializedEventMap.context.NCCalendarDepartureTest.hasTrustedEventTokenReferenceExcept(
      "token-b",
      "calendar-b",
      "item-b"
    ) === false,
    "Reference checks must exclude the removed calendar item itself"
  );
  const wrongTokenRemoved =
    await serializedEventMap.context.NCCalendarDepartureTest.removeEventTokenEntryIfToken(
      "calendar-b",
      "item-b",
      "different-token"
    );
  assert(
    wrongTokenRemoved === false
      && serializedEventMap.context.EVENT_TOKEN_MAP["calendar-b::item-b"]?.token === "token-b",
    "Conditional event cleanup must not remove a mapping that now points to another token"
  );
}

async function testPersistentCalendarDepartureRetries(){
  const preparedRecord = {
    "prepared-token": {
      delegated: false,
      delegateId: "delegate-user",
      departurePrepared: true,
      departureShouldLeaveSelf: true,
      departurePending: false,
      departureRetryGeneration: 3,
      departureRetryAttempts: 0,
      departureNextAttemptAt: 0,
      departureRetryExhausted: false,
      departureCompleted: false,
      departureCalendarId: "calendar-a",
      departureItemId: "item-a"
    }
  };
  const preparedConfirmed = createDepartureHarness({
    initialRoomMeta: preparedRecord,
    calendarItem: {
      type: "event",
      format: "ical",
      calendarId: "calendar-a",
      id: "item-a",
      item: "confirmed-delegation"
    },
    calendarItemMeta: {
      token: "prepared-token",
      delegateId: "delegate-user",
      delegated: true
    }
  });
  await preparedConfirmed.context.NCCalendarDepartureTest.resumeCalendarDepartureRetries();
  assert(
    preparedConfirmed.calendarGetAttempts === 1,
    "Startup must re-read the calendar item for a prepared departure"
  );
  assert(
    preparedConfirmed.leaveAttempts === 1,
    "A confirmed prepared delegation must continue with self-leave on startup"
  );
  assert(
    preparedConfirmed.context.ROOM_META["prepared-token"].departurePrepared === false
      && preparedConfirmed.context.ROOM_META["prepared-token"].departurePending === false
      && preparedConfirmed.context.ROOM_META["prepared-token"].departureCompleted === true,
    "A recovered prepared departure must persist completion"
  );

  const preparedUnconfirmed = createDepartureHarness({
    initialRoomMeta: preparedRecord,
    calendarItem: {
      type: "event",
      format: "ical",
      calendarId: "calendar-a",
      id: "item-a",
      item: "unconfirmed-delegation"
    },
    calendarItemMeta: {
      token: "prepared-token",
      delegateId: "delegate-user",
      delegated: false
    }
  });
  await preparedUnconfirmed.context.NCCalendarDepartureTest.resumeCalendarDepartureRetries();
  assert(
    preparedUnconfirmed.leaveAttempts === 0,
    "Startup must not leave before the delegated VEVENT writeback is confirmed"
  );
  assert(
    preparedUnconfirmed.context.ROOM_META["prepared-token"].departurePrepared === true,
    "An unconfirmed writeback must retain prepared departure evidence"
  );
  assert(
    preparedUnconfirmed.queuedCalendarItems.length === 1,
    "An unconfirmed prepared departure must re-enter normal calendar synchronization"
  );

  const preparedReadRetry = createDepartureHarness({
    initialRoomMeta: preparedRecord,
    calendarGetFailures: 1,
    calendarItem: {
      type: "event",
      format: "ical",
      calendarId: "calendar-a",
      id: "item-a",
      item: "confirmed-delegation"
    },
    calendarItemMeta: {
      token: "prepared-token",
      delegateId: "delegate-user",
      delegated: true
    }
  });
  await preparedReadRetry.context.NCCalendarDepartureTest.resumeCalendarDepartureRetries();
  assert(
    preparedReadRetry.scheduler.size === 1,
    "A transient prepared-event read failure must schedule bounded recovery"
  );
  preparedReadRetry.scheduler.runAll();
  await new Promise((resolve) => setImmediate(resolve));
  await flushPromises();
  assert(
    preparedReadRetry.calendarGetAttempts === 2
      && preparedReadRetry.leaveAttempts === 1,
    "Prepared departure recovery must retry the event read and continue after success"
  );

  const initialRecord = {
    "room-token": {
      delegated: true,
      delegateId: "delegate-user",
      departurePending: true,
      departureRetryGeneration: 1,
      departureRetryAttempts: 0,
      departureNextAttemptAt: 0,
      departureRetryExhausted: false,
      departureCompleted: false
    }
  };
  const firstRun = createDepartureHarness({
    initialRoomMeta: initialRecord,
    leaveFailures: 1
  });
  await firstRun.context.NCCalendarDepartureTest.runCalendarDepartureRetry(
    "room-token",
    1
  );
  assert(
    firstRun.leaveAttempts === 1,
    `The first delegation departure attempt must run: ${
      firstRun.loggedErrors
        .flat()
        .map((value) => value?.stack || value?.message || JSON.stringify(value))
        .join(" | ")
    }`
  );
  assert(
    firstRun.context.ROOM_META["room-token"].departureRetryAttempts === 1,
    "A transient departure failure must persist its attempt counter"
  );
  assert(
    firstRun.scheduler.size === 1,
    "A transient departure failure must schedule one bounded retry"
  );

  const restarted = createDepartureHarness({
    initialRoomMeta: firstRun.persistedRoomMeta
  });
  await restarted.context.NCCalendarDepartureTest.resumeCalendarDepartureRetries();
  assert(
    restarted.scheduler.size === 1,
    "Startup must resume a persisted pending departure retry"
  );
  restarted.scheduler.runAll();
  await flushPromises();
  assert(restarted.leaveAttempts === 1, "The resumed departure retry must call Talk self-leave");
  assert(
    restarted.context.ROOM_META["room-token"].departurePending === false
      && restarted.context.ROOM_META["room-token"].departureCompleted === true,
    "A successful resumed departure must persist completion"
  );

  const bounded = createDepartureHarness({
    initialRoomMeta: initialRecord,
    leaveFailures: 100
  });
  await bounded.context.NCCalendarDepartureTest.runCalendarDepartureRetry(
    "room-token",
    1
  );
  for (let i = 0; i < 10; i++){
    if (!bounded.scheduler.size){
      await new Promise((resolve) => setImmediate(resolve));
      await flushPromises();
    }
    if (!bounded.scheduler.size){
      break;
    }
    bounded.scheduler.runAll();
    await new Promise((resolve) => setImmediate(resolve));
    await flushPromises();
  }
  assert(
    bounded.leaveAttempts === 6,
    `Departure retries must stop after the initial attempt and five bounded retries (got ${bounded.leaveAttempts})`
  );
  assert(
    bounded.context.ROOM_META["room-token"].departureRetryExhausted === true,
    "An exhausted departure retry must remain as persistent evidence"
  );
  assert(bounded.scheduler.size === 0, "An exhausted departure retry must not schedule another timer");

  const generationRace = createDepartureHarness({
    initialRoomMeta: initialRecord,
    deferLeave: true
  });
  const staleRun =
    generationRace.context.NCCalendarDepartureTest.runCalendarDepartureRetry(
      "room-token",
      1
    );
  await flushPromises();
  assert(generationRace.leaveAttempts === 1, "The stale generation must enter self-leave");
  await generationRace.context.NCCalendarDepartureTest.setRoomMeta(
    "room-token",
    {
      delegateId: "new-delegate",
      departurePending: true,
      departureRetryGeneration: 2,
      departureRetryAttempts: 0,
      departureNextAttemptAt: 0,
      departureRetryExhausted: false,
      departureCompleted: false
    }
  );
  generationRace.releaseLeave();
  await staleRun;
  assert(
    generationRace.context.ROOM_META["room-token"].departureRetryGeneration === 2
      && generationRace.context.ROOM_META["room-token"].departurePending === true,
    "A completed stale departure attempt must not clear a newer persisted generation"
  );
}

function createCalendarRemovalHarness(withOtherReference, { armFailures = 0 } = {}){
  const removalSource = sourceSection(
    "modules/bgCalendar.js",
    "async function handleCalendarItemRemoved",
    "const CALENDAR_OPERATION_QUEUE"
  );
  const eventMap = {
    "calendar-a::item-a": {
      token: "room-token",
      source: "x-nctalk"
    }
  };
  if (withOtherReference){
    eventMap["calendar-b::item-b"] = {
      token: "room-token",
      source: "x-nctalk"
    };
  }
  const armed = [];
  let armAttempts = 0;
  const context = {
    BG_STATE_READY: Promise.resolve(),
    L(){},
    EVENT_TOKEN_MAP: eventMap,
    console: { error(){} },
    getEventTokenEntry(calendarId, id){
      return eventMap[`${calendarId}::${id}`] || null;
    },
    isTrustedEventTokenEntry(entry){
      return entry?.source === "x-nctalk";
    },
    async removeEventTokenEntry(calendarId, id){
      delete eventMap[`${calendarId}::${id}`];
    },
    async isSavedEventRoomDeleteEnabled(){
      return true;
    },
    hasTrustedEventTokenReference(token){
      return Object.values(eventMap).some((entry) => {
        return entry.source === "x-nctalk" && entry.token === token;
      });
    },
    hasTrustedEventTokenReferenceExcept(token, calendarId, itemId){
      const excludedKey = `${calendarId}::${itemId}`;
      return Object.entries(eventMap).some(([key, entry]) => {
        return key !== excludedKey
          && entry.source === "x-nctalk"
          && entry.token === token;
      });
    },
    isRetryableTalkCalendarError(error){
      const status = Number(error?.status) || 0;
      return status === 0 || status >= 500;
    },
    createCalendarRetryableError(message, cause, code){
      const error = new Error(message);
      error.cause = cause;
      error.ncCalendarRetryable = true;
      error.ncCalendarRetryCode = code;
      return error;
    },
    getRoomMeta(){
      return {};
    },
    async getCanonicalCalendarUserId(){
      return { raw: "owner", normalized: "owner" };
    },
    async deleteRoomMeta(){},
    async armTalkRoomDeleteRetry(record){
      armAttempts += 1;
      armed.push({
        ...record,
        mappingPresentAtArm:
          eventMap[`${record.calendarId}::${record.itemId}`]?.token === record.token
      });
      if (armAttempts <= armFailures){
        throw new Error("room delete retry storage failed");
      }
    },
    ROOM_CLEANUP_DELETE_DELAY_MS: 15_000,
    shortToken: (token) => token
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${removalSource}
globalThis.NCCalendarRemovalTest = { handleCalendarItemRemoved };`,
    context,
    { filename: "modules/bgCalendar.js#handleCalendarItemRemoved" }
  );
  return {
    context,
    eventMap,
    armed,
    get armAttempts(){
      return armAttempts;
    }
  };
}

async function testCalendarMoveProtection(){
  const moved = createCalendarRemovalHarness(true);
  await moved.context.NCCalendarRemovalTest.handleCalendarItemRemoved("calendar-a", "item-a");
  assert(!moved.eventMap["calendar-a::item-a"], "The source mapping must be removed after a move");
  assert(!!moved.eventMap["calendar-b::item-b"], "The destination mapping must remain");
  assert(moved.armed.length === 0, "A room still referenced by the moved event must not be deleted");

  const deleted = createCalendarRemovalHarness(false);
  await deleted.context.NCCalendarRemovalTest.handleCalendarItemRemoved("calendar-a", "item-a");
  assert(deleted.armed.length === 1, "A removed final event reference must arm room deletion");
  assert(
    deleted.armed[0].mappingPresentAtArm === true,
    "The delete intent must be persisted before the final token mapping is removed"
  );
  assert(
    deleted.armed[0].delayMs === 15_000,
    "Saved-event deletion must leave the existing cleanup grace window for a matching move destination"
  );

  const rejectedPersistence = createCalendarRemovalHarness(false, {
    armFailures: 1
  });
  await expectRejected(
    () => rejectedPersistence.context.NCCalendarRemovalTest.handleCalendarItemRemoved(
      "calendar-a",
      "item-a"
    ),
    "A rejected delete-intent storage write must propagate for bounded retry"
  );
  assert(
    rejectedPersistence.eventMap["calendar-a::item-a"]?.token === "room-token",
    "A rejected delete-intent storage write must retain the source token mapping"
  );
}

async function testAddressbookFailureStopsClassification(){
  const inviteeSource = sourceSection(
    "modules/bgCalendar.js",
    "async function addInviteesToTalkRoom",
    "function parseBooleanProp"
  );
  const additions = [];
  let addressbookCalls = 0;
  const context = {
    L(){},
    console: { error(){} },
    shortToken: (token) => token,
    isRetryableTalkCalendarError(){
      return true;
    },
    createCalendarRetryableError(message, cause, code){
      const error = new Error(message);
      error.cause = cause;
      error.ncCalendarRetryable = true;
      error.ncCalendarRetryCode = code;
      return error;
    },
    async extractIcalAttendees(){
      return ["internal@example.test"];
    },
    NCTalkCore: {
      async getSystemAddressbookContacts(){
        addressbookCalls += 1;
        if (addressbookCalls === 1){
          throw new Error("CardDAV unavailable");
        }
        return [{
          id: "internal-user",
          emailLower: "internal@example.test"
        }];
      },
      async addTalkParticipant(payload){
        additions.push(payload);
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${inviteeSource}
globalThis.NCInviteeClassificationTest = { addInviteesToTalkRoom };`,
    context,
    { filename: "modules/bgCalendar.js#addInviteesToTalkRoom" }
  );
  let firstError = null;
  try{
    await context.NCInviteeClassificationTest.addInviteesToTalkRoom({
      token: "room-token",
      ical: "VEVENT",
      addUsers: true,
      addGuests: true
    });
  }catch(error){
    firstError = error;
  }
  assert(firstError?.ncCalendarRetryable === true, "A CardDAV failure must be marked for bounded retry");
  assert(firstError?.ncCalendarRetryCode === "addressbook", "The retry reason must identify CardDAV classification");
  assert(
    additions.length === 0,
    "A CardDAV failure must not reclassify an internal attendee as an email guest"
  );
  const retryResult = await context.NCInviteeClassificationTest.addInviteesToTalkRoom({
    token: "room-token",
    ical: "VEVENT",
    addUsers: true,
    addGuests: true
  });
  assert(retryResult.ok === true, "A later successful addressbook read must complete classification");
  assert(additions.length === 1, "The later successful attempt must add one participant");
  assert(additions[0].source === "users", "The internal attendee must be added as a user");
  assert(additions[0].actorId === "internal-user", "The internal attendee must use the canonical contact UID");
}

function makeOcsResponse(status, statusName, data){
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    raw: "",
    data: {
      ocs: {
        meta: {
          status: statusName,
          statuscode: statusName === "ok" ? 100 : status
        },
        data
      }
    }
  };
}

function createTalkCoreHarness(){
  const responses = [];
  const requests = [];
  let canonicalUserId = "owner-uid";
  const context = {
    AbortController,
    browser: {
      storage: {
        local: {
          async get(){
            return {};
          }
        }
      }
    },
    console,
    globalThis: null,
    L(){},
    shortToken: (token) => token,
    bgI18n: (key) => key,
    localizedError(key, substitutions = []){
      return new Error([key, ...substitutions].filter(Boolean).join(":"));
    },
    NCTalkTextUtils: {
      shortId: (value) => value
    },
    NCLogContext: {
      resolveAddonLogPrefix(){
        return "[NCBG]";
      },
      safeConsoleError(){}
    },
    NCCore: {
      async getOpts(){
        return {
          baseUrl: "https://cloud.example.test",
          user: "login-alias@example.test",
          appPass: "secret"
        };
      },
      async getCurrentUserId(){
        return canonicalUserId;
      }
    },
    NCOcs: {
      buildAuthHeader(){
        return "Basic test";
      },
      async ocsRequest(request){
        requests.push(request);
        assert(responses.length > 0, "Unexpected Talk OCS request");
        return responses.shift();
      },
      isExplicitSuccess(response){
        return response?.ok === true
          && response?.data?.ocs?.meta?.status === "ok";
      },
      getFailureMessage(response, fallback){
        return response?.data?.ocs?.meta?.message || fallback || `HTTP ${response?.status || 0}`;
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/talkcore.js", context);
  return {
    api: context.NCTalkCore,
    requests,
    responses,
    setCanonicalUserId(value){
      canonicalUserId = value;
    }
  };
}

async function testTalkOcsValidationAndDelegation(){
  const cancelableDelete = createTalkCoreHarness();
  const deleteController = new AbortController();
  cancelableDelete.responses.push(makeOcsResponse(200, "ok", null));
  await cancelableDelete.api.deleteTalkRoom({
    token: "room-token",
    signal: deleteController.signal
  });
  assert(
    cancelableDelete.requests[0].signal === deleteController.signal,
    "Room deletion must forward the lifecycle abort signal to the shared OCS request"
  );

  const failedDelete = createTalkCoreHarness();
  failedDelete.responses.push(makeOcsResponse(200, "failure", null));
  await expectRejected(
    () => failedDelete.api.deleteTalkRoom({ token: "room-token" }),
    "HTTP 200 with failed OCS meta must not count as a room deletion"
  );

  const verifiedConflict = createTalkCoreHarness();
  verifiedConflict.responses.push(
    makeOcsResponse(409, "failure", null),
    makeOcsResponse(200, "ok", [
      { actorId: "user-b", attendeeId: 42, participantType: 3 }
    ])
  );
  await verifiedConflict.api.addTalkParticipant({
    token: "room-token",
    actorId: "user-b",
    source: "users"
  });

  const unverifiedConflict = createTalkCoreHarness();
  unverifiedConflict.responses.push(
    makeOcsResponse(409, "failure", null),
    makeOcsResponse(200, "ok", [])
  );
  await expectRejected(
    () => unverifiedConflict.api.addTalkParticipant({
      token: "room-token",
      actorId: "user-b",
      source: "users"
    }),
    "An unverified participant conflict must remain a failure"
  );

  const delegation = createTalkCoreHarness();
  delegation.setCanonicalUserId("owner-uid");
  delegation.responses.push(
    makeOcsResponse(200, "ok", [
      { actorId: "delegate-uid", attendeeId: 84, participantType: 2 }
    ])
  );
  const result = await delegation.api.delegateRoomModerator({
    token: "room-token",
    newModerator: "delegate-uid",
    leaveSelf: false
  });
  assert(result.shouldLeaveSelf === true, "Canonical owner UID must drive the self-leave decision");
  assert(result.leftSelf === false, "The preparation phase must retain the owner until local write-back succeeds");
  assert(
    delegation.requests.every((request) => request.method !== "DELETE"),
    "Delegation preparation must not leave the room before local calendar write-back"
  );
}

function testUidOnlyAddressbookContact(){
  const root = path.resolve(__dirname, "..");
  global.ICAL = require(path.join(root, "vendor", "ical.js"));
  const contract = require(path.join(root, "modules", "icalContract.js"));
  const context = {
    NCIcalContract: contract,
    console,
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript(
    "modules/talkAddressbook.js",
    context,
    "\nglobalThis.NCAddressbookParseTest = { parseSystemAddressbook };"
  );
  const contacts = context.NCAddressbookParseTest.parseSystemAddressbook([
    "BEGIN:VCARD",
    "VERSION:4.0",
    "UID:user-without-mail",
    "FN:User Without Mail",
    "END:VCARD"
  ].join("\r\n"));
  assert(contacts.length === 1, "A UID contact without EMAIL must remain selectable as moderator");
  assert(contacts[0].id === "user-without-mail", "The UID-only contact must preserve its user id");
  assert(contacts[0].email === "", "The UID-only contact must expose an empty email value");
}

function createToolbarHarness(){
  const cacheTopics = [];
  let unregistered = 0;
  class ExtensionAPI {}
  class ExtensionError extends Error {}
  class EventManager {
    api(){
      return {};
    }
  }
  const context = {
    ChromeUtils: {
      importESModule(url){
        if (url.includes("ExtensionCommon")){
          return {
            ExtensionCommon: {
              ExtensionAPI,
              EventManager,
              makeWidgetId: (value) => value
            }
          };
        }
        if (url.includes("ExtensionUtils")){
          return {
            ExtensionUtils: {
              ExtensionError
            }
          };
        }
        return { cal: {} };
      }
    },
    Services: {
      obs: {
        notifyObservers(subject, topic){
          cacheTopics.push(topic);
        }
      },
      uuid: {
        generateUUID(){
          return "{12345678-1234-1234-1234-123456789abc}";
        }
      },
      wm: {
        getOuterWindowWithId(){
          return null;
        }
      }
    },
    ExtensionSupport: {
      openWindows: [],
      registerWindowListener(){},
      unregisterWindowListener(){
        unregistered += 1;
      }
    },
    console,
    globalThis: null,
    Symbol,
    Map,
    Set,
    WeakMap
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript("experiments/ncCalToolbar/parent.js", context);
  return {
    ApiClass: context.ncCalToolbar,
    cacheTopics,
    context,
    get unregistered(){
      return unregistered;
    }
  };
}

function testPropertyRollbackProgress(){
  for (const failingSetter of [2, 3]){
    const harness = createToolbarHarness();
    const api = new harness.ApiClass();
    api.extension = { id: "test@example.invalid" };
    api._logError = () => {};
    const values = {
      "X-FIRST": "old-first",
      "X-SECOND": "old-second",
      "X-THIRD": "old-third"
    };
    let setterCalls = 0;
    const item = {
      getProperty(name){
        return values[name] ?? null;
      },
      setProperty(name, value){
        setterCalls += 1;
        if (setterCalls === failingSetter){
          throw new Error(`setter ${failingSetter} failed`);
        }
        values[name] = value;
      },
      deleteProperty(name){
        delete values[name];
      }
    };
    const updates = {
      "X-FIRST": "new-first",
      "X-SECOND": "new-second",
      "X-THIRD": "new-third"
    };
    const snapshot = api._snapshotProperties(item, updates);
    const applied = [];
    let failed = false;
    try{
      api._applyProperties(item, updates, applied);
    }catch(error){
      failed = true;
    }
    assert(failed, `Setter ${failingSetter} must fail the property batch`);
    assert(
      applied.length === failingSetter - 1,
      `Setter ${failingSetter} must expose every earlier property to rollback`
    );
    api._rollbackProperties(item, snapshot, applied);
    assert(values["X-FIRST"] === "old-first", `Setter ${failingSetter} must roll back X-FIRST`);
    assert(values["X-SECOND"] === "old-second", `Setter ${failingSetter} must retain or roll back X-SECOND`);
    assert(values["X-THIRD"] === "old-third", `Setter ${failingSetter} must retain X-THIRD`);
  }
}

async function testPropertySnapshotPrecedesFieldMutation(){
  const harness = createToolbarHarness();
  const api = new harness.ApiClass();
  api.extension = { id: "test@example.invalid" };
  api._logError = () => {};
  const editorWindow = {};
  const item = {
    getProperty(){
      throw new Error("native getter failed");
    }
  };
  let fieldWrites = 0;
  api._bridge = () => ({
    normalizeEditorId(value){
      return value;
    }
  });
  api._resolveEditorWindow = () => editorWindow;
  api._getEditedItem = () => item;
  api._ensureLifecycleWatch = () => {};
  api._assertWindowOpen = () => {};
  api._resolveWritableField = () => ({ kind: "input" });
  api._readField = () => "old title";
  api._writeField = () => {
    fieldWrites += 1;
  };
  const extensionApi = api.getAPI({}).ncCalToolbar;
  await expectRejected(
    () => extensionApi.updateCurrent({
      editorId: "editor-a",
      fields: { title: "new title" },
      properties: { "X-NCTALK-TOKEN": "room-token" }
    }),
    "A native property snapshot failure must reject updateCurrent"
  );
  assert(
    fieldWrites === 0,
    "Native properties must be snapshotted before any writable editor field is mutated"
  );
}

function testExperimentShutdownLifecycle(){
  const harness = createToolbarHarness();
  const api = new harness.ApiClass();
  api.extension = { id: "test@example.invalid" };
  api._listenerId = "listener-id";
  api._listenerRegistered = true;
  api._startupRetryPending = true;
  api._startupRetryCount = 2;
  let timerCanceled = false;
  api._startupRetryTimer = {
    cancel(){
      timerCanceled = true;
    }
  };
  api.onShutdown(false);
  assert(api._shutdownStarted === true, "Experiment shutdown must block late callbacks");
  assert(timerCanceled, "Experiment shutdown must cancel its startup retry timer");
  assert(harness.unregistered === 1, "Experiment shutdown must unregister its window listener");
  assert(
    harness.cacheTopics.includes("startupcache-invalidate"),
    "Non-application shutdown must invalidate Thunderbird's startup cache"
  );
  let bridgeRejected = false;
  try{
    api._bridge();
  }catch(error){
    bridgeRejected = true;
  }
  assert(bridgeRejected, "A late callback must not recreate the editor bridge after shutdown");

  const appShutdownHarness = createToolbarHarness();
  const appShutdownApi = new appShutdownHarness.ApiClass();
  appShutdownApi.extension = { id: "test@example.invalid" };
  appShutdownApi._listenerId = "listener-id";
  appShutdownApi._listenerRegistered = true;
  appShutdownApi.onShutdown(true);
  assert(appShutdownApi._shutdownStarted === true, "Application shutdown must set the shutdown guard");
  assert(appShutdownHarness.unregistered === 0, "Application shutdown must not touch closing windows");
  assert(
    !appShutdownHarness.cacheTopics.includes("startupcache-invalidate"),
    "Application shutdown must not invalidate startup cache during process exit"
  );
}

function testStaticLifecycleRules(){
  const stateSource = readText("modules/bgState.js");
  const calendarSource = readText("modules/bgCalendar.js");
  const lifecycleSource = readText("modules/bgCalendarLifecycle.js");
  const talkSource = readText("modules/talkcore.js");
  const addressbookSource = readText("modules/talkAddressbook.js");
  const routerSource = readText("modules/bgRouter.js");
  const dialogSource = readText("ui/talkDialog.js");
  const toolbarSource = readText("experiments/ncCalToolbar/parent.js");

  assert(stateSource.includes("const BG_STATE_READY = (async () =>"), "Background state must expose one readiness promise");
  assert(calendarSource.includes("await BG_STATE_READY;"), "Calendar handlers must wait for background hydration");
  assert(
    calendarSource.includes("departureCalendarId: String(item.calendarId || \"\")")
      && calendarSource.includes("departureItemId: String(item.id || \"\")"),
    "Prepared departures must persist the calendar identity needed for startup verification"
  );
  assert(lifecycleSource.includes("ROOM_DELETE_RETRY_DELAYS_MS"), "Room deletion must use bounded retry delays");
  assert(talkSource.includes("NCCore.getCurrentUserId(opts)"), "Talk delegation must use the canonical user id");
  assert(!talkSource.includes("await fetch("), "Talk OCS calls must use the shared timeout request path");
  assert(addressbookSource.includes("NCOcs.runWithTimeout"), "CardDAV reads must use the shared timeout helper");
  assert(routerSource.includes("await hydrateTalkWizardContextFromEditor"), "Room create must refresh the editor context");
  assert(routerSource.includes('bgI18n("talk_error_existing_room_linked")'), "Room create must block an existing linked room");
  assert(dialogSource.includes('t("talk_error_existing_room_linked")'), "The Talk UI must explain the existing-room guard");
  assert(
    toolbarSource.includes("this._clearCalendarItemActionButtonWait(window);"),
    "Experiment shutdown must disconnect pending button observers"
  );
  assert(
    toolbarSource.includes("this._removeDialogReleaseListener(window);"),
    "Experiment shutdown must remove dialog release listeners"
  );
  assert(toolbarSource.includes("onShutdown(isAppShutdown)"), "Experiment shutdown must receive the application-shutdown flag");
  assert(toolbarSource.includes('"startupcache-invalidate"'), "Experiment disable/reload must invalidate startup cache");
}

async function run(){
  await testCalendarQueue();
  await testSerializedRoomMetaMutations();
  await testPersistentCalendarDepartureRetries();
  await testCalendarMoveProtection();
  await testAddressbookFailureStopsClassification();
  await testTalkOcsValidationAndDelegation();
  testUidOnlyAddressbookContact();
  testPropertyRollbackProgress();
  await testPropertySnapshotPrecedesFieldMutation();
  testExperimentShutdownLifecycle();
  testStaticLifecycleRules();
  console.log("[OK] calendar-talk-reliability-check passed");
}

run().catch((error) => {
  console.error("[FAIL] calendar-talk-reliability-check", error);
  process.exitCode = 1;
});
