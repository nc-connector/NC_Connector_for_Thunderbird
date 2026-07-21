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

function createLifecycleHarness(){
  const scheduler = createScheduler();
  const deletedRooms = [];
  const deletedMeta = [];
  const context = {
    CALENDAR_WIZARD_CONTEXTS: new Map(),
    CALENDAR_WIZARD_CONTEXT_TTL_MS: 60_000,
    L(){},
    NCTalkCore: {
      async deleteTalkRoom({ token }){
        deletedRooms.push(token);
      }
    },
    Promise,
    ROOM_CLEANUP_BY_EDITOR: new Map(),
    ROOM_CLEANUP_BY_TOKEN: new Map(),
    ROOM_CLEANUP_DELETE_DELAY_MS: 15_000,
    clearTimeout: scheduler.clearTimeout,
    console: { error: console.error },
    async deleteRoomMeta(token){
      deletedMeta.push(token);
    },
    globalThis: null,
    setTimeout: scheduler.setTimeout,
    shortToken: (token) => token
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript(
    "modules/bgCalendarLifecycle.js",
    context,
    "\nglobalThis.NCCalendarCleanupTest = { handleCalendarItemsEditorClosed, removeRoomCleanupEntry };"
  );
  return { context, deletedMeta, deletedRooms, scheduler };
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
  await Promise.resolve();
  await Promise.resolve();
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

  const rejectedSave = createLifecycleHarness();
  const rejectedEditor = "ed-12345678-1234-1234-1234-123456789abc";
  trackRoom(rejectedSave, rejectedEditor, "rejected-token");
  rejectedSave.context.NCCalendarCleanupTest.handleCalendarItemsEditorClosed({
    editorId: rejectedEditor,
    action: "discarded",
    reason: "unload"
  });
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
  storedEvent.context.NCCalendarCleanupTest.removeRoomCleanupEntry("stored-token", "calendar_item_persisted");
  assert(storedEvent.scheduler.size === 0, "A stored calendar event should cancel pending room deletion");
  storedEvent.scheduler.runAll();
  await flushPromises();
  assert(storedEvent.deletedRooms.length === 0, "A stored calendar event must retain its Talk room");

  const callOrder = [];
  const handleCalendarItemUpsert = loadCalendarUpsertHandler(callOrder);
  await handleCalendarItemUpsert({ type: "event", item: "without-token" });
  assert(callOrder.length === 0, "Calendar items without connector metadata must not clear room cleanup");
  await handleCalendarItemUpsert({ type: "event", item: "with-token" });
  assert(
    callOrder.join(",") === "clear:stored-token:calendar_item_persisted,read-room-meta",
    "A stored item with connector metadata should clear cleanup before later synchronization"
  );

  console.log("[OK] calendar-room-cleanup-check passed");
}

run().catch((error) => {
  console.error("[FAIL] calendar-room-cleanup-check", error);
  process.exitCode = 1;
});
