"use strict";

const vm = require("node:vm");
const { assert, loadScript } = require("./review-check-utils");
const {
  createUploadContext,
  flushMicrotasks,
  createFakeClock
} = require("./filelink-test-harness");

function createCleanupHarness(deleteRemotePath, overrides = {}){
  let cleanupCounter = 0;
  const wizardEntries = new Map();
  const composeEntries = new Map();
  const clearedIndeterminate = [];
  const context = createUploadContext({
    console: {
      log: () => {},
      error: () => {}
    },
    crypto: {
      randomUUID: () => `cleanup-${++cleanupCounter}`
    },
    SHARING_WIZARD_CLEANUP_BY_WINDOW: wizardEntries,
    COMPOSE_SHARE_CLEANUP_BY_TAB: composeEntries,
    L: () => {},
    NCFileLinkDav: {
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
    ...overrides
  });
  loadScript("modules/bgComposeShareCleanup.js", context);
  return {
    context,
    wizardEntries,
    composeEntries,
    clearedIndeterminate
  };
}

async function checkCleanupRetry(){
  const clock = createFakeClock(1000);
  let attempts = 0;
  const cleanup = createCleanupHarness(async () => {
    attempts++;
    if (attempts < 3){
      throw new Error("offline");
    }
    return true;
  }, {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  await cleanup.context.armComposeShareCleanup(12, {
    folderInfo: { relativeFolder: "NC Connector/Retry" },
    cleanupTarget: {
      url: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Retry",
      authHeader: "Basic retry"
    }
  });
  cleanup.context.scheduleComposeShareCleanupDelete(
    12,
    "compose_closed",
    0
  );
  await flushMicrotasks();
  assert(attempts === 1, "Compose cleanup must try immediately");
  assert(clock.pendingCount() === 1, "A temporary cleanup failure must schedule one retry");
  clock.advance(2000);
  await flushMicrotasks();
  assert(attempts === 2, "The first delayed cleanup retry must run");
  assert(clock.pendingCount() === 1, "A second cleanup failure must keep one retry timer");
  clock.advance(5000);
  await flushMicrotasks();
  assert(attempts === 3, "The second delayed cleanup retry must run");
  assert(!cleanup.composeEntries.has(12), "A successful retry must clear compose cleanup state");
  assert(clock.pendingCount() === 0, "Successful cleanup must leave no retry timer");

  const multiClock = createFakeClock(2000);
  const multiCalls = [];
  let secondShareAttempts = 0;
  const multiCleanup = createCleanupHarness(async ({ url }) => {
    multiCalls.push(url);
    if (url.endsWith("/Second") && ++secondShareAttempts === 1){
      throw new Error("second share offline");
    }
    return !url.endsWith("/First") || multiCalls.filter((item) => item.endsWith("/First")).length === 1;
  }, {
    setTimeout: multiClock.setTimeout,
    clearTimeout: multiClock.clearTimeout
  });
  for (const name of ["First", "Second"]){
    await multiCleanup.context.armComposeShareCleanup(13, {
      folderInfo: { relativeFolder: `NC Connector/${name}` },
      cleanupTarget: {
        url: `https://cloud.example.test/remote.php/dav/files/user/${name}`,
        authHeader: "Basic multi"
      }
    });
  }
  multiCleanup.context.scheduleComposeShareCleanupDelete(
    13,
    "compose_closed",
    0
  );
  await flushMicrotasks();
  assert(
    multiCalls.length === 2 && multiClock.pendingCount() === 1,
    "A partial multi-share cleanup failure must schedule one retry"
  );
  assert(
    multiCleanup.composeEntries.get(13)?.entries?.length === 1
      && multiCleanup.composeEntries.get(13).entries[0].folderInfo.relativeFolder.endsWith("/Second"),
    "A partial cleanup failure must retain only the unfinished share roots"
  );
  multiClock.advance(2000);
  await flushMicrotasks();
  assert(
    multiCalls.length === 3 && multiCalls[2].endsWith("/Second"),
    "A multi-share retry must not revisit a root that was already deleted"
  );
  assert(
    !multiCleanup.composeEntries.has(13),
    "A completed multi-share retry must clear compose cleanup state"
  );
}

async function checkCleanupGenerations(){
  const deleteCalls = [];
  const cleanup = createCleanupHarness(async (options) => {
    deleteCalls.push(options);
    return true;
  });
  const payload = {
    folderInfo: {
      relativeFolder: "NC Connector/Share",
      folderName: "Share"
    },
    cleanupTarget: {
      url: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Share",
      authHeader: "Basic original",
      baseUrl: "https://cloud.example.test",
      relativeFolder: "NC Connector/Share"
    }
  };
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
      && deleteCalls[0].authHeader === "Basic original",
    "Cleanup must use its captured URL and credentials"
  );
  assert(cleanup.clearedIndeterminate.length === 1, "DAV cleanup must clear matching share recovery state");

  let reservationCleanup = null;
  cleanup.context.NCFileLinkDav.deleteRootReservation = async (options) => {
    reservationCleanup = options;
    return "target";
  };
  await cleanup.context.armSharingWizardRemoteCleanup(9, {
    folderInfo: { relativeFolder: "NC Connector/Ambiguous" },
    cleanupTarget: {
      url: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Ambiguous",
      authHeader: "Basic ambiguous",
      reservationUrl: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/_stage",
      targetUrl: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Ambiguous"
    }
  });
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
  await cleanup.context.armSharingWizardRemoteCleanup(8, {
    folderInfo: { relativeFolder: "NC Connector/Old" },
    cleanupTarget: {
      url: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Old",
      authHeader: "Basic old"
    }
  });
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
  await cleanup.context.armComposeShareCleanup(11, {
    folderInfo: { relativeFolder: "NC Connector/Compose" },
    cleanupTarget: {
      url: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Compose",
      authHeader: "Basic compose"
    }
  });
  const composeEntry = cleanup.composeEntries.get(11);
  const composeStale = await cleanup.context.deleteComposeShareCleanupNow(
    11,
    "stale_timer",
    "older-compose-cleanup"
  );
  assert(composeStale === false, "A stale compose generation must not report deletion");
  assert(cleanup.composeEntries.get(11) === composeEntry, "A stale compose generation must remain armed");
  await cleanup.context.armComposeShareCleanup(11, {
    folderInfo: { relativeFolder: "NC Connector/Compose-2" },
    cleanupTarget: {
      url: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Compose-2",
      authHeader: "Basic compose"
    }
  });
  const multiShareState = cleanup.composeEntries.get(11);
  assert(multiShareState.entries.length === 2, "One compose tab must retain every inserted share root");
  const multiShareRemoved = await cleanup.context.deleteComposeShareCleanupNow(
    11,
    "compose_closed",
    multiShareState.cleanupId
  );
  assert(multiShareRemoved === true, "Compose cleanup must remove all tracked share roots");
  assert(composeDeleteCount === 2, "Compose cleanup must issue one delete per tracked share");

  await cleanup.context.armSharingWizardRemoteCleanup(10, {
    folderInfo: { relativeFolder: "NC Connector/Transfer" },
    cleanupTarget: {
      url: "https://cloud.example.test/remote.php/dav/files/user/NC%20Connector/Transfer",
      authHeader: "Basic transfer"
    }
  });
  await cleanup.context.armComposeShareCleanup(16, {
    wizardWindowId: 10,
    folderInfo: { relativeFolder: "NC Connector/Transfer" }
  });
  assert(
    !cleanup.wizardEntries.has(10),
    "Compose cleanup arm must transfer ownership away from the wizard entry"
  );
  assert(
    cleanup.composeEntries.get(16)?.entries?.[0]?.cleanupTarget?.authHeader === "Basic transfer",
    "Compose cleanup must retain the wizard cleanup target during ownership transfer"
  );
  cleanup.context.clearComposeShareCleanup(16, "test_done");
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

function createBackgroundHarness({
  deleteRemotePath = async () => true,
  createFileLink
} = {}){
  let connectListener = null;
  let windowRemovedListener = null;
  const wizardEntries = new Map();
  const composeEntries = new Map();
  const context = createUploadContext({
    console: {
      log: () => {},
      error: () => {}
    },
    crypto: {
      randomUUID: () => "cleanup-id"
    },
    SHARING_WIZARD_CLEANUP_BY_WINDOW: wizardEntries,
    COMPOSE_SHARE_CLEANUP_BY_TAB: composeEntries,
    L: () => {},
    NCFileLinkDav: {
      deleteRemotePath,
      async deleteTrackedRoot(options){
        return options?.reservationUrl
          ? this.deleteRootReservation(options)
          : this.deleteRemotePath(options);
      },
      deleteRootReservation: async () => true
    },
    NCFileLinkShare: {
      clearIndeterminate: async () => true
    },
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
  loadScript("modules/bgComposeShareCleanup.js", context);
  loadScript("modules/bgFileLinkUpload.js", context);
  return {
    context,
    wizardEntries,
    connect: (port) => connectListener(port),
    removeWindow: (windowId) => windowRemovedListener(windowId)
  };
}

async function checkBackgroundAbort(){
  let uploadSignal = null;
  let createCalls = 0;
  const background = createBackgroundHarness({
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
  const blocked = createBackgroundHarness({
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
  const canceled = createBackgroundHarness({
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
  const removedWindow = createBackgroundHarness({
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
  const background = createBackgroundHarness({
    createFileLink: async ({ signal }) => {
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
  const background = createBackgroundHarness({
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
  await flushMicrotasks(30);
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
