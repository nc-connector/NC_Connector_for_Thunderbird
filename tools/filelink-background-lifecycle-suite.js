"use strict";

const vm = require("node:vm");
const { assert, loadScript } = require("./review-check-utils");
const {
  createUploadContext,
  flushMicrotasks,
  createFakeClock
} = require("./filelink-test-harness");

const TEST_BASE_URL = "https://cloud.example.test";
const TEST_USER_ID = "user";
const TEST_LOGIN = "test-login";
const TEST_APP_PASSWORD = "test-app-password";

function cloneStorageValue(value){
  return value === undefined ? undefined : structuredClone(value);
}

function createStorageArea(initial = {}){
  const values = cloneStorageValue(initial) || {};
  return {
    values,
    area: {
      async get(keys){
        if (keys === undefined || keys === null){
          return cloneStorageValue(values);
        }
        const result = {};
        if (typeof keys === "string"){
          result[keys] = cloneStorageValue(values[keys]);
          return result;
        }
        if (Array.isArray(keys)){
          for (const key of keys){
            result[key] = cloneStorageValue(values[key]);
          }
          return result;
        }
        for (const [key, fallback] of Object.entries(keys || {})){
          result[key] = Object.prototype.hasOwnProperty.call(values, key)
            ? cloneStorageValue(values[key])
            : cloneStorageValue(fallback);
        }
        return result;
      },
      async set(update){
        for (const [key, value] of Object.entries(update || {})){
          values[key] = cloneStorageValue(value);
        }
      }
    }
  };
}

function normalizeTestBaseUrl(value){
  const raw = String(value || "").trim();
  if (!raw){
    return "";
  }
  const parsed = new URL(raw);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeTestRelativePath(value){
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function buildTestFileUrl(davRoot, relativePath){
  const encodedPath = normalizeTestRelativePath(relativePath)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const root = String(davRoot || "").replace(/\/+$/, "");
  return encodedPath ? `${root}/${encodedPath}` : root;
}

function createCleanupPayload(name, options = {}){
  const relativeFolder = options.relativeFolder || `NC Connector/${name}`;
  const davRoot = `${TEST_BASE_URL}/remote.php/dav/files/${TEST_USER_ID}`;
  return {
    tabId: Number(options.tabId) || 0,
    folderInfo: {
      relativeFolder,
      folderName: name
    },
    shareId: options.shareId || `share-${name}`,
    shareLabel: options.shareLabel || name,
    shareUrl: options.shareUrl || `${TEST_BASE_URL}/s/${name.toLowerCase()}`,
    cleanupTarget: {
      url: buildTestFileUrl(davRoot, relativeFolder),
      authHeader: options.authHeader || "Basic captured-credentials",
      baseUrl: TEST_BASE_URL,
      relativeFolder,
      reservationUrl: options.reservationRelativeFolder
        ? buildTestFileUrl(davRoot, options.reservationRelativeFolder)
        : "",
      targetUrl: options.reservationRelativeFolder
        ? buildTestFileUrl(davRoot, relativeFolder)
        : ""
    }
  };
}

function createUploadRoot(name, options = {}){
  const payload = createCleanupPayload(name, options);
  return {
    shareName: name,
    folderInfo: payload.folderInfo,
    cleanupTarget: payload.cleanupTarget
  };
}

async function armComposeShareForTest(
  cleanup,
  tabId,
  wizardWindowId,
  name,
  options = {}
){
  const payload = createCleanupPayload(name, {
    ...options,
    tabId
  });
  await cleanup.context.armSharingWizardRemoteCleanup(wizardWindowId, payload);
  return cleanup.context.armComposeShareCleanup(tabId, {
    ...payload,
    wizardWindowId
  });
}

async function flushCleanupPersistence(context){
  await vm.runInContext(
    "PERSISTED_SHARE_CLEANUP_READY.then(() => PERSISTED_SHARE_CLEANUP_WRITE_QUEUE)",
    context
  );
  await flushMicrotasks();
}

async function createCleanupHarness(deleteRemotePath, overrides = {}){
  let cleanupCounter = 0;
  const nextRuntimeId = () => {
    cleanupCounter++;
    return `00000000-0000-4000-8000-${String(cleanupCounter).padStart(12, "0")}`;
  };
  const wizardEntries = new Map();
  const composeEntries = new Map();
  const clearedIndeterminate = [];
  const {
    initialStorage,
    setTimeout: overrideSetTimeout,
    clearTimeout: overrideClearTimeout,
    browser: browserOverrides = {},
    ...contextOverrides
  } = overrides;
  const storage = createStorageArea(initialStorage);
  const runtimeSetTimeout = overrideSetTimeout || setTimeout;
  const runtimeClearTimeout = overrideClearTimeout || clearTimeout;
  const runtimeOverrides = browserOverrides.runtime || {};
  const context = createUploadContext({
    console: {
      log: () => {},
      error: () => {}
    },
    crypto: {
      randomUUID: nextRuntimeId
    },
    structuredClone,
    COMPOSE_SHARE_DRAFT_ID_PATTERN: /^[A-Za-z0-9_-]{16,80}$/,
    createSecureRuntimeId: nextRuntimeId,
    bgShortId: (value, maxLength = 24) => String(value || "").slice(0, maxLength),
    SHARING_WIZARD_CLEANUP_BY_WINDOW: wizardEntries,
    COMPOSE_SHARE_CLEANUP_BY_TAB: composeEntries,
    L: () => {},
    NCCore: {
      normalizeBaseUrl: normalizeTestBaseUrl,
      getOpts: async () => ({
        baseUrl: TEST_BASE_URL,
        user: TEST_LOGIN,
        appPass: TEST_APP_PASSWORD
      }),
      getCurrentUserId: async () => TEST_USER_ID
    },
    NCHostPermissions: {
      requireOriginPermission: async () => true
    },
    NCOcs: {
      buildAuthHeader: (user, appPass) => `Basic ${user}:${appPass}`
    },
    NCFileLinkDav: {
      normalizeRelativePath: normalizeTestRelativePath,
      buildFileUrl: buildTestFileUrl,
      deleteRemotePath,
      deleteRootReservation: async () => true,
      async deleteTrackedRoot(options){
        return options?.reservationUrl
          ? this.deleteRootReservation(options)
          : this.deleteRemotePath(options);
      }
    },
    NCFileLinkShare: {
      clearIndeterminate: async (options) => {
        clearedIndeterminate.push(options);
        return true;
      }
    },
    NCSharing: {
      deleteShareFolder: async () => {}
    },
    browser: {
      ...browserOverrides,
      storage: {
        ...browserOverrides.storage,
        local: storage.area
      },
      runtime: {
        ...runtimeOverrides,
        onStartup: {
          addListener: () => {}
        }
      }
    },
    setTimeout: () => -1,
    clearTimeout: () => {},
    ...contextOverrides
  });
  loadScript("modules/bgShareCleanupStore.js", context);
  await vm.runInContext("PERSISTED_SHARE_CLEANUP_READY", context);
  context.setTimeout = runtimeSetTimeout;
  context.clearTimeout = runtimeClearTimeout;
  await vm.runInContext(
    'resumePersistedShareCleanup("test_background_start", { recoverActive: true })',
    context
  );
  loadScript("modules/bgComposeShareCleanup.js", context);
  return {
    context,
    wizardEntries,
    composeEntries,
    clearedIndeterminate,
    persisted: storage.values
  };
}

async function checkCleanupRetry(){
  const clock = createFakeClock(1000);
  let attempts = 0;
  const cleanup = await createCleanupHarness(async () => {
    attempts++;
    if (attempts < 3){
      throw new Error("offline");
    }
    return true;
  }, {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  await armComposeShareForTest(cleanup, 12, 112, "Retry");
  cleanup.context.scheduleComposeShareCleanupDelete(
    12,
    "compose_closed",
    0
  );
  await flushMicrotasks(30);
  assert(attempts === 1, "Compose cleanup must try immediately");
  assert(
    clock.pendingCount() === 1,
    `A temporary cleanup failure must schedule one retry (pending: ${clock.pendingCount()}, `
      + `timer: ${String(cleanup.composeEntries.get(12)?.timerId)}, `
      + `deleting: ${String(cleanup.composeEntries.get(12)?.deleting)})`
  );
  clock.advance(2000);
  await flushMicrotasks(30);
  assert(attempts === 2, "The first delayed cleanup retry must run");
  assert(clock.pendingCount() === 1, "A second cleanup failure must keep one retry timer");
  clock.advance(5000);
  await flushMicrotasks(30);
  assert(attempts === 3, "The second delayed cleanup retry must run");
  assert(!cleanup.composeEntries.has(12), "A successful retry must clear compose cleanup state");
  assert(clock.pendingCount() === 0, "Successful cleanup must leave no retry timer");

  const multiClock = createFakeClock(2000);
  const multiCalls = [];
  let secondShareAttempts = 0;
  const multiCleanup = await createCleanupHarness(async ({ url }) => {
    multiCalls.push(url);
    if (url.endsWith("/Second") && ++secondShareAttempts === 1){
      throw new Error("second share offline");
    }
    return !url.endsWith("/First") || multiCalls.filter((item) => item.endsWith("/First")).length === 1;
  }, {
    setTimeout: multiClock.setTimeout,
    clearTimeout: multiClock.clearTimeout
  });
  await armComposeShareForTest(multiCleanup, 13, 113, "First");
  await armComposeShareForTest(multiCleanup, 13, 114, "Second");
  const multiDraftGroupId = multiCleanup.composeEntries.get(13).draftGroupId;
  multiCleanup.context.scheduleComposeShareCleanupDelete(
    13,
    "compose_closed",
    0
  );
  await flushMicrotasks(60);
  assert(
    multiCalls.length === 2 && multiClock.pendingCount() === 1,
    "A partial multi-share cleanup failure must schedule one retry"
  );
  assert(
    multiCleanup.composeEntries.get(13)?.entries?.length === 1
      && multiCleanup.composeEntries.get(13).entries[0].folderInfo.relativeFolder.endsWith("/Second"),
    "A partial cleanup failure must retain only the unfinished share roots"
  );
  await flushCleanupPersistence(multiCleanup.context);
  const persistedAfterPartial = multiCleanup.context.getPersistentShareCleanupGroup(
    multiDraftGroupId
  );
  assert(
    persistedAfterPartial?.state === "pending"
      && persistedAfterPartial.resources.length === 1
      && persistedAfterPartial.resources[0].relativeFolder.endsWith("/Second"),
    "A partial cleanup failure must persist only the unfinished share root for retry"
  );
  multiClock.advance(2000);
  await flushMicrotasks(40);
  assert(
    multiCalls.length === 3 && multiCalls[2].endsWith("/Second"),
    "A multi-share retry must not revisit a root that was already deleted"
  );
  assert(
    !multiCleanup.composeEntries.has(13),
    "A completed multi-share retry must clear compose cleanup state"
  );
  await flushCleanupPersistence(multiCleanup.context);
  assert(
    !multiCleanup.context.getPersistentShareCleanupGroup(multiDraftGroupId),
    "A completed multi-share retry must remove its persistent cleanup group"
  );
}

async function checkCleanupGenerations(){
  const deleteCalls = [];
  const cleanup = await createCleanupHarness(async (options) => {
    deleteCalls.push(options);
    return true;
  });
  const payload = createCleanupPayload("Share", {
    tabId: 17,
    authHeader: "Basic original"
  });
  await cleanup.context.armSharingWizardRemoteCleanup(7, payload);
  const firstEntry = cleanup.wizardEntries.get(7);
  payload.cleanupTarget.url = "https://attacker.invalid/replaced";
  payload.cleanupTarget.authHeader = "Basic changed";

  const staleResult = await cleanup.context.deleteSharingWizardRemoteCleanupNow(
    7,
    "stale",
    "older-cleanup"
  );
  assert(staleResult === false, "A stale wizard generation must not delete");
  assert(deleteCalls.length === 0, "A stale wizard generation must not reach DAV");

  const removed = await cleanup.context.deleteSharingWizardRemoteCleanupNow(
    7,
    "window_closed",
    firstEntry.cleanupId
  );
  assert(removed === true, "The current wizard generation must delete");
  assert(deleteCalls.length === 1, "The current wizard generation must issue one DAV delete");
  assert(
    deleteCalls[0].url === "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Share"
      && deleteCalls[0].authHeader === `Basic ${TEST_LOGIN}:${TEST_APP_PASSWORD}`,
    "Cleanup must reconstruct the captured resource with current account credentials"
  );
  assert(cleanup.clearedIndeterminate.length === 1, "DAV cleanup must clear matching share recovery state");
  assert(
    !JSON.stringify(cleanup.persisted).includes("Basic")
      && !JSON.stringify(cleanup.persisted).includes(TEST_APP_PASSWORD),
    "Persistent cleanup state must not contain captured or current credentials"
  );

  let reservationCleanup = null;
  cleanup.context.NCFileLinkDav.deleteRootReservation = async (options) => {
    reservationCleanup = options;
    return "target";
  };
  await cleanup.context.armSharingWizardRemoteCleanup(
    9,
    createCleanupPayload("Ambiguous", {
      tabId: 19,
      reservationRelativeFolder: "NC Connector/_stage"
    })
  );
  const reservationEntry = cleanup.wizardEntries.get(9);
  const reservationRemoved = await cleanup.context.deleteSharingWizardRemoteCleanupNow(
    9,
    "move_state_recovery",
    reservationEntry.cleanupId
  );
  assert(reservationRemoved === true, "Deferred root-reservation cleanup must complete");
  assert(
    reservationCleanup?.reservationUrl?.endsWith("/_stage")
      && reservationCleanup?.targetUrl?.endsWith("/Ambiguous"),
    "Deferred cleanup must retain both immutable MOVE paths"
  );

  let finishDelete;
  cleanup.context.NCFileLinkDav.deleteRemotePath = () => new Promise((resolve) => {
    finishDelete = resolve;
  });
  await cleanup.context.armSharingWizardRemoteCleanup(
    8,
    createCleanupPayload("Old", { tabId: 18 })
  );
  const oldEntry = cleanup.wizardEntries.get(8);
  const deleting = cleanup.context.deleteSharingWizardRemoteCleanupNow(
    8,
    "async_delete",
    oldEntry.cleanupId
  );
  await flushMicrotasks();
  const replacement = {
    ...oldEntry,
    cleanupId: "cleanup-replacement",
    folderInfo: { relativeFolder: "NC Connector/New" }
  };
  cleanup.wizardEntries.set(8, replacement);
  finishDelete(true);
  const asyncResult = await deleting;
  assert(asyncResult === false, "A completed old delete must not clear a newer wizard generation");
  assert(cleanup.wizardEntries.get(8) === replacement, "The newer wizard generation must remain armed");

  let composeDeleteCount = 0;
  cleanup.context.NCFileLinkDav.deleteRemotePath = async () => {
    composeDeleteCount++;
    return true;
  };
  await armComposeShareForTest(cleanup, 11, 111, "Compose");
  const composeEntry = cleanup.composeEntries.get(11);
  const composeStale = await cleanup.context.deleteComposeShareCleanupNow(
    11,
    "stale_timer",
    "older-compose-cleanup"
  );
  assert(composeStale === false, "A stale compose generation must not report deletion");
  assert(cleanup.composeEntries.get(11) === composeEntry, "A stale compose generation must remain armed");
  await armComposeShareForTest(cleanup, 11, 115, "Compose-2");
  const multiShareState = cleanup.composeEntries.get(11);
  assert(multiShareState.entries.length === 2, "One compose tab must retain every inserted share root");
  const persistedMultiShare = cleanup.context.getPersistentShareCleanupGroup(
    multiShareState.draftGroupId
  );
  assert(
    persistedMultiShare?.resources?.length === 2,
    "One compose tab must persist every inserted share root"
  );
  const multiShareRemoved = await cleanup.context.deleteComposeShareCleanupNow(
    11,
    "compose_closed",
    multiShareState.cleanupId
  );
  assert(multiShareRemoved === true, "Compose cleanup must remove all tracked share roots");
  assert(composeDeleteCount === 2, "Compose cleanup must issue one delete per tracked share");

  const transferPayload = createCleanupPayload("Transfer", {
    tabId: 16,
    authHeader: "Basic transfer"
  });
  await cleanup.context.armSharingWizardRemoteCleanup(10, transferPayload);
  await cleanup.context.armComposeShareCleanup(16, {
    ...transferPayload,
    wizardWindowId: 10,
    folderInfo: transferPayload.folderInfo
  });
  assert(
    !cleanup.wizardEntries.has(10),
    "Compose cleanup arm must transfer ownership away from the wizard entry"
  );
  assert(
    cleanup.composeEntries.get(16)?.entries?.[0]?.cleanupTarget?.authHeader === "Basic transfer",
    "Compose cleanup must retain the wizard cleanup target during ownership transfer"
  );
  await cleanup.context.commitComposeShareCleanup(16, "test_done");
}

function createPort(){
  let messageListener = null;
  let disconnectListener = null;
  const posted = [];
  return {
    name: "nc-filelink-upload",
    posted,
    postMessage: (message) => posted.push(message),
    onMessage: {
      addListener: (listener) => {
        messageListener = listener;
      }
    },
    onDisconnect: {
      addListener: (listener) => {
        disconnectListener = listener;
      }
    },
    emitMessage: (message) => messageListener?.(message),
    emitDisconnect: () => disconnectListener?.()
  };
}

async function createBackgroundHarness({
  deleteRemotePath = async () => true,
  createFileLink
} = {}){
  let connectListener = null;
  let windowRemovedListener = null;
  const cleanup = await createCleanupHarness(deleteRemotePath, {
    NCSharing: {
      deleteShareFolder: async () => {},
      createFileLink
    },
    browser: {
      runtime: {
        onConnect: {
          addListener: (listener) => {
            connectListener = listener;
          }
        }
      },
      windows: {
        onRemoved: {
          addListener: (listener) => {
            windowRemovedListener = listener;
          }
        }
      }
    }
  });
  loadScript("modules/bgFileLinkUpload.js", cleanup.context);
  return {
    context: cleanup.context,
    wizardEntries: cleanup.wizardEntries,
    connect: (port) => connectListener(port),
    removeWindow: (windowId) => windowRemovedListener(windowId)
  };
}

async function checkBackgroundAbort(){
  let uploadSignal = null;
  let createCalls = 0;
  const background = await createBackgroundHarness({
    createFileLink: async ({ signal }) => {
      createCalls++;
      uploadSignal = signal;
      return new Promise((resolve, reject) => {
        const stop = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted){
          stop();
        }
      });
    }
  });
  const port = createPort();
  background.connect(port);
  port.emitMessage({
    type: "start",
    windowId: 21,
    tabId: 31,
    request: { files: [] }
  });
  await flushMicrotasks();
  assert(createCalls === 1 && uploadSignal, "A start message must begin one background upload");
  port.emitDisconnect();
  await flushMicrotasks();
  assert(uploadSignal.aborted, "Port disconnect must abort the active upload signal");
  assert(
    vm.runInContext("FILELINK_UPLOAD_SESSIONS.size", background.context) === 0,
    "An aborted background upload must leave no active session"
  );

  let blockedCreateCalls = 0;
  const blocked = await createBackgroundHarness({
    deleteRemotePath: async () => {
      throw new Error("delete failed");
    },
    createFileLink: async () => {
      blockedCreateCalls++;
      return {};
    }
  });
  blocked.wizardEntries.set(22, {
    cleanupId: "old-cleanup",
    folderInfo: { relativeFolder: "NC Connector/Old" },
    cleanupTarget: {
      url: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Old",
      authHeader: "Basic old"
    }
  });
  const blockedPort = createPort();
  blocked.connect(blockedPort);
  blockedPort.emitMessage({
    type: "start",
    windowId: 22,
    tabId: 32,
    request: { files: [] }
  });
  await flushMicrotasks();
  assert(blockedCreateCalls === 0, "A failed old cleanup must block the new upload");
  assert(
    blockedPort.posted.some((message) => message.type === "error"),
    "Blocked upload startup must report an error through the port"
  );

  let cancelSignal = null;
  const canceled = await createBackgroundHarness({
    createFileLink: async ({ signal }) => {
      cancelSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
  });
  const cancelPort = createPort();
  canceled.connect(cancelPort);
  cancelPort.emitMessage({
    type: "start",
    windowId: 23,
    tabId: 33,
    request: { files: [] }
  });
  await flushMicrotasks();
  cancelPort.emitMessage({ type: "cancel", reason: "test_cancel" });
  await flushMicrotasks();
  assert(cancelSignal?.aborted, "An explicit cancel message must abort the active upload signal");

  let removedWindowSignal = null;
  const removedWindow = await createBackgroundHarness({
    createFileLink: async ({ signal }) => {
      removedWindowSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
  });
  const removedWindowPort = createPort();
  removedWindow.connect(removedWindowPort);
  removedWindowPort.emitMessage({
    type: "start",
    windowId: 24,
    tabId: 34,
    request: { files: [] }
  });
  await flushMicrotasks();
  removedWindow.removeWindow(24);
  await flushMicrotasks();
  assert(
    removedWindowSignal?.aborted,
    "Removing the sharing-wizard window must abort its active upload signal"
  );
}

async function checkSessionReplacement(){
  const sequence = [];
  let callCount = 0;
  const background = await createBackgroundHarness({
    createFileLink: async ({ signal, onRootCreated }) => {
      callCount++;
      if (callCount === 1){
        sequence.push("first-start");
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            sequence.push("first-abort");
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      }
      sequence.push("second-start");
      await onRootCreated(createUploadRoot("New"));
      return {
        shareInfo: {
          folderInfo: { relativeFolder: "NC Connector/New" },
          shareId: "new",
          label: "New",
          shareUrl: "https://cloud.example.test/s/new"
        }
      };
    }
  });
  const firstPort = createPort();
  background.connect(firstPort);
  firstPort.emitMessage({
    type: "start",
    windowId: 30,
    tabId: 40,
    request: { files: [] }
  });
  await flushMicrotasks();
  const secondPort = createPort();
  background.connect(secondPort);
  secondPort.emitMessage({
    type: "start",
    windowId: 30,
    tabId: 40,
    request: { files: [] }
  });
  await flushMicrotasks(30);
  assert(
    sequence.join(",") === "first-start,first-abort,second-start",
    "A replacement must finish the older window session before starting the new one"
  );
  assert(
    secondPort.posted.some((message) => message.type === "result"),
    "The replacement session must deliver its result"
  );
}

async function checkUndeliveredResultCleanup(){
  const deleteCalls = [];
  let finishUpload;
  const background = await createBackgroundHarness({
    deleteRemotePath: async (options) => {
      deleteCalls.push(options);
      return true;
    },
    createFileLink: async ({ onRootCreated }) => {
      await onRootCreated({
        shareName: "Late",
        folderInfo: {
          relativeBase: "NC Connector",
          relativeFolder: "NC Connector/Late",
          folderName: "Late"
        },
        cleanupTarget: {
          url: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Late",
          authHeader: "Basic late",
          baseUrl: "https://cloud.example.test",
          relativeFolder: "NC Connector/Late"
        }
      });
      return new Promise((resolve) => {
        finishUpload = resolve;
      });
    }
  });
  const port = createPort();
  background.connect(port);
  port.emitMessage({
    type: "start",
    windowId: 31,
    tabId: 41,
    request: { files: [] }
  });
  await flushMicrotasks();
  port.emitDisconnect();
  finishUpload({
    shareInfo: {
      folderInfo: { relativeFolder: "NC Connector/Late" },
      shareId: "late",
      label: "Late",
      shareUrl: "https://cloud.example.test/s/late"
    }
  });
  await flushMicrotasks(100);
  assert(deleteCalls.length === 1, "An undelivered completed result must delete its remote root");
  assert(
    deleteCalls[0].url.endsWith("/NC%20Connector/Late"),
    "Undelivered-result cleanup must use the captured DAV target"
  );
  assert(
    !background.wizardEntries.has(31),
    "Successful undelivered-result cleanup must clear its wizard entry"
  );
}

async function runBackgroundLifecycleChecks(){
  await checkCleanupGenerations();
  await checkCleanupRetry();
  await checkBackgroundAbort();
  await checkSessionReplacement();
  await checkUndeliveredResultCleanup();
}

module.exports = {
  runBackgroundLifecycleChecks
};
