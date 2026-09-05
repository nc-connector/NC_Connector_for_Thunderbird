"use strict";

const vm = require("node:vm");
const {
  assert,
  loadScript
} = require("./review-check-utils");
const {
  createUploadContext,
  flushMicrotasks
} = require("./filelink-test-harness");

const TEST_BASE_URL = "https://cloud.example.test";
const TEST_USER_ID = "test-user";
const TEST_LOGIN = "test-login";
const TEST_APP_PASSWORD = "test-app-password";

class TestFile extends Blob{
  constructor(parts, name, options = {}){
    super(parts, options);
    this.name = String(name || "");
    this.lastModified = Number(options.lastModified) || 0;
  }
}

function clone(value){
  return value === undefined ? undefined : structuredClone(value);
}

function createEventChannel(){
  const listeners = [];
  return {
    listeners,
    addListener(listener){
      listeners.push(listener);
    },
    async emit(...args){
      const results = [];
      for (const listener of listeners){
        results.push(await listener(...args));
      }
      return results;
    },
    async request(...args){
      for (const listener of listeners){
        const result = listener(...args);
        if (result !== undefined){
          return await result;
        }
      }
      return undefined;
    }
  };
}

function createStorageArea(initial = {}){
  const values = clone(initial) || {};
  return {
    values,
    async get(keys){
      if (keys === undefined || keys === null){
        return clone(values);
      }
      const result = {};
      if (typeof keys === "string"){
        result[keys] = clone(values[keys]);
        return result;
      }
      if (Array.isArray(keys)){
        for (const key of keys){
          result[key] = clone(values[key]);
        }
        return result;
      }
      for (const [key, fallback] of Object.entries(keys || {})){
        result[key] = Object.prototype.hasOwnProperty.call(values, key)
          ? clone(values[key])
          : clone(fallback);
      }
      return result;
    },
    async set(update){
      for (const [key, value] of Object.entries(update || {})){
        values[key] = clone(value);
      }
    }
  };
}

function normalizeBaseUrl(value){
  const raw = String(value || "").trim();
  if (!raw){
    return "";
  }
  const parsed = new URL(raw);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeRelativePath(value){
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

function buildFileUrl(davRoot, relativePath){
  const encodedPath = normalizeRelativePath(relativePath)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const root = String(davRoot || "").replace(/\/+$/, "");
  return encodedPath ? `${root}/${encodedPath}` : root;
}

async function waitFor(predicate, message){
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline){
    if (predicate()){
      return;
    }
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function createPort(){
  let messageListener = null;
  let disconnectListener = null;
  const posted = [];
  return {
    name: "nc-filelink-upload",
    posted,
    postMessage(message){
      posted.push(message);
    },
    onMessage: {
      addListener(listener){
        messageListener = listener;
      }
    },
    onDisconnect: {
      addListener(listener){
        disconnectListener = listener;
      }
    },
    emitMessage(message){
      return messageListener?.(message);
    },
    emitDisconnect(){
      return disconnectListener?.();
    }
  };
}

async function createHarness({ tabId, wizardWindowId }){
  const events = {
    composeActionClicked: createEventChannel(),
    attachmentAdded: createEventChannel(),
    identityChanged: createEventChannel(),
    beforeSend: createEventChannel(),
    afterSend: createEventChannel(),
    afterSave: createEventChannel(),
    runtimeConnect: createEventChannel(),
    runtimeMessage: createEventChannel(),
    runtimeStartup: createEventChannel(),
    windowRemoved: createEventChannel(),
    tabCreated: createEventChannel(),
    tabRemoved: createEventChannel()
  };
  const storage = createStorageArea();
  const attachmentsByTab = new Map();
  const attachmentFiles = new Map();
  const composeDetails = new Map();
  const calls = {
    removedAttachments: [],
    restoredAttachments: [],
    composeWrites: [],
    notifications: [],
    uploadRequests: [],
    remoteDeletes: [],
    clearedIndeterminate: []
  };
  let runtimeId = 0;

  const browser = {
    storage: {
      local: storage
    },
    runtime: {
      getURL(path){
        return `moz-extension://test/${path}`;
      },
      onConnect: events.runtimeConnect,
      onMessage: events.runtimeMessage,
      onStartup: events.runtimeStartup
    },
    composeAction: {
      onClicked: events.composeActionClicked
    },
    compose: {
      onAttachmentAdded: events.attachmentAdded,
      onIdentityChanged: events.identityChanged,
      onBeforeSend: events.beforeSend,
      onAfterSend: events.afterSend,
      onAfterSave: events.afterSave,
      async listAttachments(requestTabId){
        return (attachmentsByTab.get(requestTabId) || []).map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          size: attachment.size
        }));
      },
      async getAttachmentFile(attachmentId){
        return attachmentFiles.get(attachmentId) || null;
      },
      async removeAttachment(requestTabId, attachmentId){
        const attachments = attachmentsByTab.get(requestTabId) || [];
        const index = attachments.findIndex((attachment) => attachment.id === attachmentId);
        if (index < 0){
          throw new Error("attachment_missing");
        }
        attachments.splice(index, 1);
        calls.removedAttachments.push({ tabId: requestTabId, attachmentId });
      },
      async addAttachment(requestTabId, attachment){
        const restoredId = 1000 + calls.restoredAttachments.length;
        const file = attachment?.file;
        const restored = {
          id: restoredId,
          name: String(attachment?.name || file?.name || ""),
          size: Number(file?.size) || 0
        };
        const list = attachmentsByTab.get(requestTabId) || [];
        list.push(restored);
        attachmentsByTab.set(requestTabId, list);
        attachmentFiles.set(restoredId, file);
        calls.restoredAttachments.push({ tabId: requestTabId, attachment });
        return restored;
      },
      async getComposeDetails(requestTabId){
        const details = composeDetails.get(requestTabId);
        if (!details){
          throw new Error("compose_details_missing");
        }
        return clone(details);
      },
      async setComposeDetails(requestTabId, update){
        const details = composeDetails.get(requestTabId);
        if (!details){
          throw new Error("compose_details_missing");
        }
        Object.assign(details, clone(update));
        calls.composeWrites.push({ tabId: requestTabId, update: clone(update) });
      }
    },
    windows: {
      onRemoved: events.windowRemoved,
      async create(){
        return {
          id: wizardWindowId,
          tabs: [{ id: wizardWindowId + 1 }]
        };
      },
      async remove(windowId){
        await events.windowRemoved.emit(windowId);
      }
    },
    tabs: {
      onCreated: events.tabCreated,
      onRemoved: events.tabRemoved
    },
    notifications: {
      async create(id, options){
        calls.notifications.push({ id, options: clone(options) });
        return id;
      }
    }
  };

  const context = createUploadContext({
    File: TestFile,
    browser,
    structuredClone,
    navigator: { onLine: true },
    addEventListener(){},
    COMPOSE_SHARE_DRAFT_HEADER: "X-NCC-Share-Draft",
    COMPOSE_SHARE_DRAFT_ID_PATTERN: /^[A-Za-z0-9_-]{16,80}$/,
    SHARING_POPUP_WIDTH: 660,
    SHARING_POPUP_HEIGHT: 760,
    ATTACHMENT_PROMPT_WIDTH: 560,
    ATTACHMENT_PROMPT_HEIGHT: 260,
    ATTACHMENT_EVAL_DEBOUNCE_MS: 250,
    ATTACHMENT_DEFAULT_THRESHOLD_MB: 20,
    SHARING_LAUNCH_CONTEXT_TTL_MS: 15 * 60 * 1000,
    COMPOSE_SHARE_CLEANUP_SEND_GRACE_MS: 15000,
    SHARE_CLEANUP_RETRY_DELAYS_MS: Object.freeze([
      2000,
      5000,
      10000,
      30000,
      60000
    ]),
    SHARING_KEYS: {},
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
    PASSWORD_MAIL_DISPATCH_BY_TAB: new Map(),
    COMPOSE_SHARE_CLEANUP_BY_TAB: new Map(),
    SHARING_WIZARD_CLEANUP_BY_WINDOW: new Map(),
    createSecureRuntimeId(){
      runtimeId += 1;
      return `runtime-id-${String(runtimeId).padStart(12, "0")}`;
    },
    bgShortId(value, maxLength = 24){
      return String(value || "").slice(0, maxLength);
    },
    L(){},
    focusPopupWindowBestEffort: async () => true,
    NCSharingStorage: {
      DEFAULT_ATTACHMENT_THRESHOLD_MB: 20,
      SHARING_KEYS: {},
      normalizeAttachmentThresholdMb(value){
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : 20;
      }
    },
    NCPolicyRuntime: {
      getPolicyStatus: async () => ({})
    },
    NCPolicyState: {
      isDomainActive: () => false,
      hasSeatEntitlement: () => true
    },
    NCShareRequestRules: {
      resolveUploadRequest(request, options = {}){
        const attachmentMode = options.attachmentMode === true;
        return {
          ...request,
          attachmentMode,
          permissions: attachmentMode
            ? { read: true, create: false, write: false, delete: false }
            : request.permissions
        };
      }
    },
    NCShareTemplateContract: {
      RIGHTS_SEGMENT_START: "[[NCC_RIGHTS_START]]",
      RIGHTS_SEGMENT_END: "[[NCC_RIGHTS_END]]"
    },
    NCHtmlSanitizer: {
      plainTextToHtml(value){
        return String(value || "");
      }
    },
    NCCore: {
      normalizeBaseUrl,
      async getOpts(){
        return {
          baseUrl: TEST_BASE_URL,
          user: TEST_LOGIN,
          appPass: TEST_APP_PASSWORD
        };
      },
      async getCurrentUserId(){
        return TEST_USER_ID;
      },
      buildDavAccountContext({ baseUrl, user, appPass, userId }){
        const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
        const encodedUserId = encodeURIComponent(userId);
        return Object.freeze({
          baseUrl: normalizedBaseUrl,
          userId,
          authHeader: `Basic ${user}:${appPass}`,
          davRoot: `${normalizedBaseUrl}/remote.php/dav/files/${encodedUserId}`,
          uploadRoot: `${normalizedBaseUrl}/remote.php/dav/uploads/${encodedUserId}`,
          bulkUrl: `${normalizedBaseUrl}/remote.php/dav/bulk`,
          accountIdentity: JSON.stringify([normalizedBaseUrl, userId])
        });
      }
    },
    NCHostPermissions: {
      requireOriginPermission: async () => true
    },
    NCNextcloudDav: {
      normalizeRelativePath,
      buildFileUrl,
      async deleteTrackedRoot(options){
        calls.remoteDeletes.push({
          url: String(options?.url || ""),
          reservationUrl: String(options?.reservationUrl || ""),
          targetUrl: String(options?.targetUrl || ""),
          relativeFolder: String(options?.relativeFolder || "")
        });
        return true;
      }
    },
    NCFileLinkShare: {
      async clearIndeterminate(options){
        calls.clearedIndeterminate.push(clone(options));
        return true;
      }
    },
    NCOcs: {},
    NCSharing: {
      prepareFileLinkRequest(request){
        calls.uploadRequests.push(request);
        return { request, sourcePlan: {} };
      },
      async createFileLink(prepared){
        const request = prepared?.request;
        const shareName = String(request?.shareName || "Attachment share");
        const relativeFolder = `NC Connector/${shareName}`;
        const davRoot = `${TEST_BASE_URL}/remote.php/dav/files/${encodeURIComponent(TEST_USER_ID)}`;
        const folderInfo = Object.freeze({
          relativeBase: "NC Connector",
          relativeFolder,
          folderName: shareName
        });
        await request.onRootCreated({
          shareName,
          folderInfo,
          cleanupTarget: {
            url: buildFileUrl(davRoot, relativeFolder),
            authHeader: "Basic upload-session",
            baseUrl: TEST_BASE_URL,
            relativeFolder,
            reservationUrl: "",
            targetUrl: ""
          }
        });
        request.onUploadStatus?.({
          phase: "summary",
          completedFiles: request.files.length,
          totalFiles: request.files.length,
          loadedBytes: request.files.reduce((sum, entry) => sum + Number(entry.size || entry.file?.size) || 0, 0),
          totalBytes: request.files.reduce((sum, entry) => sum + Number(entry.size || entry.file?.size) || 0, 0)
        });
        return {
          shareInfo: {
            folderInfo,
            shareId: `share-${tabId}`,
            label: shareName,
            shareUrl: `${TEST_BASE_URL}/s/share-${tabId}`,
            permissions: {
              read: true,
              create: false,
              write: false,
              delete: false
            },
            expireDate: "",
            password: "",
            noteEnabled: false,
            note: ""
          }
        };
      },
      async updateShareNote(){
        throw new Error("attachment_share_note_must_not_change");
      }
    },
    hasSeparatePasswordDispatch(requestTabId){
      return context.PASSWORD_MAIL_DISPATCH_BY_TAB.has(Number(requestTabId));
    },
    clearSeparatePasswordDispatch(){},
    scheduleSeparatePasswordDispatchClear(){},
    NCLogContext: {
      safeConsoleError(){}
    }
  });

  const runtimeSetTimeout = context.setTimeout;
  const runtimeClearTimeout = context.clearTimeout;
  // Settle the store's explicit startup recovery before the test creates an
  // active wizard owner. A newly created owner must not look like stale state
  // merely because the harness loaded all scripts within one event-loop turn.
  context.setTimeout = () => -1;
  context.clearTimeout = () => {};
  loadScript("modules/bgShareCleanupStore.js", context);
  await vm.runInContext("PERSISTED_SHARE_CLEANUP_READY", context);
  await vm.runInContext(
    'resumePersistedShareCleanup("test_background_start", { recoverActive: true })',
    context
  );
  context.setTimeout = runtimeSetTimeout;
  context.clearTimeout = runtimeClearTimeout;
  loadScript("modules/bgComposeShareCleanup.js", context);
  loadScript("modules/bgComposeAttachments.js", context);
  loadScript("modules/bgFileLinkUpload.js", context);
  loadScript("modules/bgComposeShareInsert.js", context);
  loadScript("modules/bgComposeFinalize.js", context);
  loadScript("modules/bgCompose.js", context);
  loadScript("modules/bgRouter.js", context);

  context.__allowAttachmentAutomation = async () => ({ ok: true, thresholdMb: 20 });
  vm.runInContext(
    "assertAttachmentAutomationAllowed = globalThis.__allowAttachmentAutomation;",
    context
  );
  delete context.__allowAttachmentAutomation;

  const files = [
    new context.File(["first attachment"], "first.txt", { type: "text/plain" }),
    new context.File(["second attachment"], "second.txt", { type: "text/plain" })
  ];
  const attachmentRecords = files.map((file, index) => ({
    id: index + 1,
    name: file.name,
    size: file.size
  }));
  attachmentsByTab.set(tabId, attachmentRecords);
  attachmentRecords.forEach((record, index) => {
    attachmentFiles.set(record.id, files[index]);
  });
  composeDetails.set(tabId, {
    type: "new",
    body: "<body><p>Original message</p></body>",
    plainTextBody: "Original message",
    isPlainText: false,
    deliveryFormat: "auto",
    customHeaders: []
  });

  return {
    context,
    browser,
    events,
    storage,
    attachmentsByTab,
    composeDetails,
    calls,
    files,
    tabId,
    wizardWindowId
  };
}

function buildUploadFile(entry, index){
  return {
    id: `attachment-${index + 1}`,
    sourceKind: "local",
    sourceLabel: "Local",
    kind: "file",
    name: entry.name,
    file: entry.file,
    size: entry.sizeBytes,
    contentType: entry.file.type || "application/octet-stream",
    displayPath: entry.displayPath,
    relativeDir: ""
  };
}

async function runThroughFinalize(harness){
  const { context, events, tabId, wizardWindowId } = harness;
  await context.startComposeAttachmentShareFlow(tabId, { trigger: "always" });

  assert(
    harness.calls.removedAttachments.length === 2
      && harness.attachmentsByTab.get(tabId).length === 0,
    "Attachment automation must detach the complete compose attachment set"
  );
  assert(
    context.isComposeAttachmentRoutingActive(tabId),
    "Attachment routing must block the compose while the wizard owns the files"
  );

  const blocked = (await events.beforeSend.emit(
    { id: tabId },
    clone(harness.composeDetails.get(tabId))
  ))[0];
  assert(blocked?.cancel === true, "Sending must be blocked before attachment adoption completes");

  const handoff = vm.runInContext(
    `ATTACHMENT_AUTOMATION_BY_TAB.get(${tabId}).handoff`,
    context
  );
  assert(handoff?.contextId, "Attachment handoff must expose one launch context ID");
  const launchResponse = await events.runtimeMessage.request({
    type: "sharing:getLaunchContext",
    payload: {
      contextId: handoff.contextId,
      tabId,
      windowId: wizardWindowId
    }
  }, {});
  assert(
    launchResponse?.ok === true && launchResponse.context.attachments.length === 2,
    "The bound wizard must receive the complete attachment launch context"
  );
  launchResponse.context.attachments.forEach((entry, index) => {
    assert(entry.file === harness.files[index], "Launch context must preserve each original File object");
  });

  const adoption = await events.runtimeMessage.request({
    type: "sharing:adoptAttachmentLaunchContext",
    payload: {
      contextId: handoff.contextId,
      tabId,
      windowId: wizardWindowId,
      attachmentCount: launchResponse.context.attachments.length
    }
  }, {});
  assert(adoption?.ok === true, "The wizard must adopt the complete attachment launch context");
  assert(
    !vm.runInContext(`SHARING_LAUNCH_CONTEXTS.has(${JSON.stringify(handoff.contextId)})`, context),
    "Adoption must release background launch-context File references"
  );

  const port = createPort();
  await events.runtimeConnect.emit(port);
  port.emitMessage({
    type: "start",
    windowId: wizardWindowId,
    tabId,
    request: {
      shareName: `Attachment share ${tabId}`,
      basePath: "NC Connector",
      permissions: { read: true, create: true, write: true, delete: true },
      passwordEnabled: false,
      expireEnabled: false,
      noteEnabled: false,
      note: "",
      files: launchResponse.context.attachments.map(buildUploadFile)
    }
  });
  await waitFor(
    () => port.posted.some((message) => message.type === "result"),
    "Background upload did not return its result"
  );
  const uploadResult = port.posted.find((message) => message.type === "result")?.result;
  assert(uploadResult?.shareInfo?.folderInfo, "Background upload must return complete share metadata");
  assert(
    harness.calls.uploadRequests.length === 1
      && harness.calls.uploadRequests[0].attachmentMode === true,
    "Background request resolution must retain attachment mode"
  );
  assert(
    harness.calls.uploadRequests[0].permissions.read === true
      && harness.calls.uploadRequests[0].permissions.create === false
      && harness.calls.uploadRequests[0].permissions.write === false
      && harness.calls.uploadRequests[0].permissions.delete === false,
    "Attachment-mode upload must resolve to read-only share permissions"
  );
  harness.calls.uploadRequests[0].files.forEach((entry, index) => {
    assert(entry.file === harness.files[index], "Background upload must receive each adopted File unchanged");
  });
  assert(
    context.SHARING_WIZARD_CLEANUP_BY_WINDOW.has(wizardWindowId),
    "Completed upload must arm wizard-owned cleanup before result delivery"
  );

  const finalizeResponse = await events.runtimeMessage.request({
    type: "sharing:finalizeRenderedShare",
    payload: {
      tabId,
      wizardWindowId,
      html: '<section data-ncc-share="true">Attachment share</section>',
      plainText: "Attachment share",
      cleanup: {
        shareId: uploadResult.shareInfo.shareId,
        shareLabel: uploadResult.shareInfo.label,
        shareUrl: uploadResult.shareInfo.shareUrl,
        folderInfo: uploadResult.shareInfo.folderInfo
      },
      shareNote: {
        noteEnabled: false,
        note: ""
      },
      passwordDispatch: null
    }
  }, {});
  assert(finalizeResponse?.ok === true, "Background finalize transaction must commit");
  assert(
    !context.SHARING_WIZARD_CLEANUP_BY_WINDOW.has(wizardWindowId)
      && context.COMPOSE_SHARE_CLEANUP_BY_TAB.has(tabId),
    "Finalize must transfer cleanup ownership from wizard to compose"
  );
  const persisted = context.getPersistentShareCleanupGroup(finalizeResponse.draftGroupId);
  assert(
    persisted?.ownerKind === "compose" && persisted.state === "active",
    "Finalize must persist active compose cleanup ownership"
  );
  const details = harness.composeDetails.get(tabId);
  assert(
    details.body.includes('data-ncc-share="true"'),
    "Finalize must insert the rendered share block into compose"
  );
  assert(
    details.customHeaders.some((header) => {
      return header.name === "X-NCC-Share-Draft"
        && header.value === finalizeResponse.draftGroupId;
    }),
    "Finalize must insert the matching compose lifecycle marker"
  );

  await events.windowRemoved.emit(wizardWindowId);
  await waitFor(
    () => !context.isComposeAttachmentRoutingActive(tabId),
    "Closing the finalized wizard must release attachment routing"
  );
  assert(
    !context.SHARING_WIZARD_REQUEST_BY_WINDOW.has(wizardWindowId),
    "Closing the wizard must release its upload request binding"
  );
  assert(
    harness.calls.remoteDeletes.length === 0,
    "Closing after finalize must not delete compose-owned share data"
  );

  return {
    draftGroupId: finalizeResponse.draftGroupId,
    relativeFolder: uploadResult.shareInfo.folderInfo.relativeFolder
  };
}

async function checkConfirmedSend(){
  const harness = await createHarness({ tabId: 41, wizardWindowId: 141 });
  const finalized = await runThroughFinalize(harness);
  const sendResult = (await harness.events.beforeSend.emit(
    { id: harness.tabId },
    clone(harness.composeDetails.get(harness.tabId))
  ))[0];
  assert(sendResult?.cancel !== true, "Finalized attachment share must be sendable");
  assert(
    harness.context.getPersistentShareCleanupGroup(finalized.draftGroupId)?.state === "send_pending",
    "onBeforeSend must persist pending send confirmation"
  );

  await harness.events.afterSend.emit(
    { id: harness.tabId },
    { mode: "sendNow", error: "", headerMessageId: "<sent@example.test>" }
  );
  assert(
    !harness.context.COMPOSE_SHARE_CLEANUP_BY_TAB.has(harness.tabId)
      && !harness.context.getPersistentShareCleanupGroup(finalized.draftGroupId),
    "Confirmed send must commit and remove compose cleanup ownership"
  );
  assert(
    harness.calls.remoteDeletes.length === 0,
    "Confirmed send must retain the delivered share data"
  );
  assert(
    harness.calls.restoredAttachments.length === 0,
    "Adopted attachment files must not be restored after confirmed send"
  );
}

async function checkComposeCloseCleanup(){
  const harness = await createHarness({ tabId: 42, wizardWindowId: 142 });
  const finalized = await runThroughFinalize(harness);
  await harness.events.tabRemoved.emit(harness.tabId);
  await waitFor(
    () => harness.calls.remoteDeletes.length === 1
      && !harness.context.COMPOSE_SHARE_CLEANUP_BY_TAB.has(harness.tabId)
      && !harness.context.getPersistentShareCleanupGroup(finalized.draftGroupId),
    "Closing an unsent compose did not remove its tracked share root"
  );
  assert(
    harness.calls.remoteDeletes[0].url === buildFileUrl(
      `${TEST_BASE_URL}/remote.php/dav/files/${encodeURIComponent(TEST_USER_ID)}`,
      finalized.relativeFolder
    ),
    "Compose-close cleanup must delete the exact uploaded share root"
  );
  assert(
    harness.calls.restoredAttachments.length === 0,
    "Closing after adoption must preserve the documented no-restore boundary"
  );
}

async function run(){
  await checkConfirmedSend();
  await checkComposeCloseCleanup();
  console.log("[OK] compose-attachment-e2e-check passed");
}

run().catch((error) => {
  console.error("[FAIL] compose-attachment-e2e-check", error);
  process.exitCode = 1;
});
