"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const {
  ROOT,
  assert,
  loadScript,
  readJson,
  readText
} = require("./review-check-utils");

function createEvent(){
  const listeners = [];
  return {
    addListener(listener){
      listeners.push(listener);
    },
    removeListener(listener){
      const index = listeners.indexOf(listener);
      if (index >= 0){
        listeners.splice(index, 1);
      }
    },
    hasListener(listener){
      return listeners.includes(listener);
    },
    async emit(...args){
      return Promise.all(listeners.slice().map((listener) => listener(...args)));
    },
    count(){
      return listeners.length;
    }
  };
}

function createStorageArea(){
  const values = new Map();
  return {
    values,
    async get(defaults){
      if (typeof defaults === "string"){
        return { [defaults]: values.get(defaults) };
      }
      const result = { ...(defaults || {}) };
      for (const key of Object.keys(result)){
        if (values.has(key)){
          result[key] = values.get(key);
        }
      }
      return result;
    },
    async set(entries){
      for (const [key, value] of Object.entries(entries || {})){
        values.set(key, value);
      }
    }
  };
}

function createPort(senderId){
  return {
    name: "vfs-toolkit",
    sender: { id: senderId },
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    posted: [],
    disconnected: false,
    postMessage(message){
      this.posted.push(message);
    },
    disconnect(){
      this.disconnected = true;
    }
  };
}

function checkRouterLeavesToolkitMessagesUnclaimed(){
  let listener = null;
  const context = {
    console,
    browser: {
      runtime: {
        onMessage: {
          addListener(candidate){
            listener = candidate;
          }
        }
      }
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("modules/bgRouter.js", context);
  assert(typeof listener === "function", "Background router listener must be registered");
  for (const type of [
    "vfs-toolkit-get-connections",
    "vfs-toolkit-add-connection",
    "vfs-picker-result",
    "vfs-provider-updated"
  ]){
    assert(
      listener({ type }, {}) === undefined,
      `Background router must leave ${type} to the Toolkit listener`
    );
  }
}

function moduleUrl(relativePath, caseName){
  return `${pathToFileURL(path.join(ROOT, relativePath)).href}?test=${caseName}-${Date.now()}`;
}

async function waitFor(predicate, label){
  for (let attempt = 0; attempt < 50; attempt++){
    if (predicate()){
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(label);
}

async function checkProviderSenderBinding(){
  const local = createStorageArea();
  const runtimeEvents = {
    onMessage: createEvent(),
    onMessageExternal: createEvent(),
    onConnect: createEvent(),
    onConnectExternal: createEvent()
  };
  const windowsRemoved = createEvent();
  const createdWindows = [];
  const removedWindows = [];
  global.browser = {
    runtime: {
      id: "provider@test",
      ...runtimeEvents,
      getManifest: () => ({ name: "Provider", icons: {} }),
      getURL: (value) => `moz-extension://provider${value}`,
      async sendMessage(target){
        if (typeof target === "string"){
          return undefined;
        }
        const responses = await runtimeEvents.onMessage.emit(
          target,
          { id: "provider@test" }
        );
        return responses.find((response) => response !== undefined);
      }
    },
    storage: { local },
    windows: {
      onRemoved: windowsRemoved,
      async create(options){
        createdWindows.push(options);
        return { id: createdWindows.length };
      },
      async remove(windowId){
        removedWindows.push(windowId);
      }
    }
  };

  const toolkit = await import(moduleUrl(
    "vendor/vfs-toolkit/vfs-provider/vfs-provider.mjs",
    "provider"
  ));
  let listCalls = 0;
  const pendingLists = new Map();
  const cancelledRequests = [];
  class TestProvider extends toolkit.VfsProviderImplementation {
    async onList(requestId, _storageId, path){
      listCalls++;
      if (path === "/pending"){
        return new Promise((resolve) => pendingLists.set(requestId, resolve));
      }
      return [];
    }
    async onCancel(requestId){
      cancelledRequests.push(requestId);
      pendingLists.get(requestId)?.([]);
      pendingLists.delete(requestId);
    }
  }
  const provider = new TestProvider({ name: "Provider", setupPath: "/setup.html" });
  provider.init();
  await toolkit.reportNewConnection(
    "consumer-a@test",
    "Consumer A",
    "storage-a",
    "Storage A",
    {}
  );

  const unauthorizedPort = createPort("consumer-b@test");
  await runtimeEvents.onConnectExternal.emit(unauthorizedPort);
  await unauthorizedPort.onMessage.emit({
    requestId: "list-b",
    cmd: "list",
    storageId: "storage-a",
    path: "/"
  });
  assert(listCalls === 0, "A storage grant must not be usable by another add-on");
  assert(
    unauthorizedPort.posted.some((entry) =>
      entry.requestId === "list-b" && entry.ok === false && entry.errorCode === "E:AUTH"
    ),
    "Unauthorized storage requests must return E:AUTH"
  );

  const authorizedPort = createPort("consumer-a@test");
  await runtimeEvents.onConnectExternal.emit(authorizedPort);
  await authorizedPort.onMessage.emit({
    requestId: "list-a",
    cmd: "list",
    storageId: "storage-a",
    path: "/"
  });
  assert(listCalls === 1, "The add-on owning a storage grant must retain access");
  assert(
    authorizedPort.posted.some((entry) => entry.requestId === "list-a" && entry.ok === true),
    "An authorized storage request must succeed"
  );

  void authorizedPort.onMessage.emit({
    requestId: "legacy-list",
    cmd: "list",
    storageId: "storage-a",
    path: "/pending"
  });
  await waitFor(
    () => pendingLists.has("legacy-list"),
    "The compatibility request did not reach the provider"
  );
  await authorizedPort.onMessage.emit({
    cmd: "cancel",
    canceledRequestId: "legacy-list"
  });
  assert(
    cancelledRequests.includes("legacy-list"),
    "The provider must accept the original API 1.3 cancel envelope"
  );

  await toolkit.reportNewConnection(
    "provider@test",
    "Provider",
    "storage-self",
    "Self storage",
    {}
  );
  const localPort = provider.connectLocal();
  const localResponses = [];
  localPort.onMessage.addListener((message) => localResponses.push(message));
  localPort.postMessage({
    requestId: "list-self",
    cmd: "list",
    storageId: "storage-self",
    path: "/"
  });
  await waitFor(
    () => localResponses.some((entry) => entry.requestId === "list-self"),
    "The co-located provider did not answer through its local port"
  );
  assert(listCalls === 3, "The local port must use the normal provider command handler");
  assert(
    localResponses.some((entry) => entry.requestId === "list-self" && entry.ok === true),
    "An authorized local-provider request must succeed"
  );
  localPort.disconnect();

  const setupPort = createPort("consumer-b@test");
  await runtimeEvents.onConnectExternal.emit(setupPort);
  const setupTask = setupPort.onMessage.emit({
    requestId: "setup-b",
    cmd: "openSetup",
    addonId: "consumer-a@test",
    addonName: "Claimed name"
  });
  await waitFor(() => createdWindows.length === 1, "Provider setup window was not opened");
  const setupUrl = new URL(createdWindows[0].url);
  assert(
    setupUrl.searchParams.get("addonId") === "consumer-b@test",
    "Provider setup must use the verified Port sender instead of a claimed add-on ID"
  );
  const setupToken = setupUrl.searchParams.get("setupToken");
  await toolkit.reportNewConnection(
    "consumer-a@test",
    "Spoofed consumer",
    "storage-b",
    "Storage B",
    {},
    setupToken
  );
  await setupTask;
  const storedAfterSetup = local.values.get("vfs-toolkit-connections");
  assert(
    storedAfterSetup.some((entry) =>
      entry.addonId === "consumer-b@test" && entry.storageId === "storage-b"
    ),
    "Setup completion must persist the verified consumer identity"
  );
  assert(
    !storedAfterSetup.some((entry) =>
      entry.addonId === "consumer-a@test" && entry.storageId === "storage-b"
    ),
    "A setup payload must not spoof another consumer identity"
  );

  let staleRejected = false;
  try{
    await toolkit.reportNewConnection(
      "consumer-a@test",
      "Consumer A",
      "storage-stale",
      "Stale",
      {},
      "unknown-token"
    );
  }catch(error){
    staleRejected = true;
  }
  assert(staleRejected, "Unknown setup tokens must be rejected before persistence");
  assert(
    !local.values.get("vfs-toolkit-connections").some((entry) =>
      entry.storageId === "storage-stale"
    ),
    "Unknown setup tokens must not create storage grants"
  );

  const cancelledPort = createPort("consumer-c@test");
  await runtimeEvents.onConnectExternal.emit(cancelledPort);
  void cancelledPort.onMessage.emit({
    requestId: "setup-c",
    cmd: "openSetup",
    addonName: "Consumer C"
  });
  await waitFor(() => createdWindows.length === 2, "Cancelable setup window was not opened");
  const cancelledUrl = new URL(createdWindows[1].url);
  await cancelledPort.onDisconnect.emit();
  await waitFor(() => removedWindows.includes(2), "Disconnect must close its setup window");
  let lateCompletionRejected = false;
  try{
    await toolkit.reportNewConnection(
      "consumer-c@test",
      "Consumer C",
      "storage-c",
      "Storage C",
      {},
      cancelledUrl.searchParams.get("setupToken")
    );
  }catch(error){
    lateCompletionRejected = true;
  }
  assert(lateCompletionRejected, "A disconnected setup request must stay revoked");
}

function createClientBrowser({ discover, management = null, windowCreate } = {}){
  const session = createStorageArea();
  const local = createStorageArea();
  const runtimeOnMessage = createEvent();
  const runtimeOnMessageExternal = createEvent();
  const windowsRemoved = createEvent();
  const providerPorts = new Map();
  const connectCalls = [];
  const removedWindows = [];
  const browser = {
    extension: { getBackgroundPage: () => global.window },
    runtime: {
      id: "self@test",
      onMessage: runtimeOnMessage,
      onMessageExternal: runtimeOnMessageExternal,
      getURL: (value) => `moz-extension://self/${value}`,
      getManifest: () => ({ name: "Self" }),
      async sendMessage(target, message){
        if (typeof target === "string"){
          return discover(target, message);
        }
        if (target?.type === "vfs-toolkit-discover"){
          return discover("self@test", target);
        }
        const responses = await runtimeOnMessage.emit(
          target,
          { id: "self@test" }
        );
        return responses.find((response) => response !== undefined);
      },
      connect(providerId){
        const internal = typeof providerId === "object";
        providerId = internal ? "self@test" : providerId;
        connectCalls.push({ providerId, internal });
        if (!providerPorts.has(providerId)){
          providerPorts.set(providerId, createPort(providerId));
        }
        return providerPorts.get(providerId);
      }
    },
    storage: { session, local },
    windows: {
      onRemoved: windowsRemoved,
      async create(options){
        return windowCreate ? windowCreate(options) : { id: 17 };
      },
      async remove(windowId){
        removedWindows.push(windowId);
      }
    }
  };
  if (management){
    browser.management = management;
  }
  return {
    browser,
    providerPorts,
    connectCalls,
    removedWindows,
    runtimeOnMessage,
    windowsRemoved
  };
}

async function checkClientLifecycle(){
  const probes = [];
  const clientHarness = createClientBrowser({
    discover: async (providerId) => {
      probes.push(providerId);
      throw new Error("No external providers expected");
    }
  });
  global.browser = clientHarness.browser;
  global.window = global;
  const client = await import(moduleUrl(
    "vendor/vfs-toolkit/vfs-client/vfs-client.mjs",
    "client-race"
  ));
  await client.init({ configStorageKey: "providers" });
  assert(probes.length === 0, "A co-located provider must not use runtime discovery");
  const selfPort = createPort("self@test");
  let localConnectCount = 0;
  await client.registerLocalProvider({
    providerId: "self@test",
    name: "Self provider",
    connections: [{ storageId: "self-storage", name: "Nextcloud", capabilities: {} }],
    icon: null,
    hasConfig: false
  }, () => {
    localConnectCount += 1;
    return selfPort;
  });
  const providers = await client.fetchProviderConnections();
  assert(
    providers.some((entry) =>
      entry.providerId === "self@test"
        && entry.connections.some((connection) => connection.storageRef.storageId === "self-storage")
    ),
    "Self connection must be registered before client init resolves"
  );

  const usagePromise = client.getStorageUsage({
    providerId: "self@test",
    storageId: "self-storage"
  });
  await Promise.resolve();
  const usageMessage = selfPort.posted.find((entry) => entry.cmd === "storageUsage");
  assert(
    localConnectCount === 1 && usageMessage,
    "Self-provider requests must use the registered local provider port"
  );
  await selfPort.onMessage.emit({
    requestId: usageMessage.requestId,
    ok: true,
    result: { usage: 1, quota: 2 }
  });
  assert((await usagePromise).quota === 2, "Self-provider requests must resolve over the internal port");

  const pickerAbort = new AbortController();
  const pickerPromise = client.showDirectoryPicker({
    storageRef: { providerId: "self@test", storageId: "self-storage" },
    lockStorage: "strict",
    signal: pickerAbort.signal
  });
  await Promise.resolve();
  pickerAbort.abort();
  let pickerError = null;
  try{
    await pickerPromise;
  }catch(error){
    pickerError = error;
  }
  assert(pickerError?.name === "AbortError", "Picker cancellation must reject with AbortError");
  assert(
    clientHarness.removedWindows.includes(17),
    "Picker cancellation must close the exact picker window"
  );

  let setupSettled = false;
  const setupPromise = client.openProviderSetup("self@test", "Self");
  setupPromise.finally(() => {
    setupSettled = true;
  });
  await waitFor(
    () => selfPort.posted.some((entry) => entry.cmd === "openSetup"),
    "The co-located setup request was not sent"
  );
  const setupMessage = selfPort.posted.find((entry) => entry.cmd === "openSetup");
  await selfPort.onMessage.emit({
    requestId: setupMessage.requestId,
    ok: true,
    result: "new-storage"
  });
  await Promise.resolve();
  assert(
    !setupSettled,
    "Co-located setup must wait until the picker cache contains the new connection"
  );
  await clientHarness.runtimeOnMessage.emit({
    type: "vfs-toolkit-add-connection",
    storageId: "new-storage",
    name: "New storage",
    capabilities: {}
  }, { id: "self@test" });
  assert(
    (await setupPromise).storageId === "new-storage",
    "Co-located setup must resolve after its connection is visible"
  );

  const deletePromise = client.deleteProviderConnection({
    providerId: "self@test",
    storageId: "new-storage"
  });
  await waitFor(
    () => selfPort.posted.some((entry) =>
      entry.cmd === "deleteConnection" && entry.storageId === "new-storage"
    ),
    "The co-located connection delete request was not sent"
  );
  const deleteMessage = selfPort.posted.find((entry) =>
    entry.cmd === "deleteConnection" && entry.storageId === "new-storage"
  );
  await selfPort.onMessage.emit({
    requestId: deleteMessage.requestId,
    ok: true,
    result: null
  });
  await deletePromise;
  assert(
    !(await client.fetchProviderConnections()).some((providerInfo) =>
      providerInfo.providerId === "self@test"
        && providerInfo.connections.some((connection) =>
          connection.storageRef.storageId === "new-storage"
        )
    ),
    "Deleting a co-located connection must update the local picker cache"
  );

  const requestA = new AbortController();
  const requestB = new AbortController();
  const storageRef = { providerId: "external@test", storageId: "external-storage" };
  const readA = client.readFile({ path: "/a.bin", storageRef }, { signal: requestA.signal });
  const readB = client.readFile({ path: "/b.bin", storageRef }, { signal: requestB.signal });
  await Promise.resolve();
  const providerPort = clientHarness.providerPorts.get("external@test");
  const readMessages = providerPort.posted.filter((entry) => entry.cmd === "readFile");
  assert(readMessages.length === 2, "Two reads must create two provider requests");
  requestA.abort();
  let readAError = null;
  try{
    await readA;
  }catch(error){
    readAError = error;
  }
  assert(readAError?.name === "AbortError", "Canceled VFS read must reject with AbortError");
  const cancelMessage = providerPort.posted.find((entry) => entry.cmd === "cancel");
  assert(
    cancelMessage?.canceledRequestId === readMessages[0].requestId
      && typeof cancelMessage.requestId === "string"
      && cancelMessage.requestId.length > 0,
    "VFS cancellation must preserve the API 1.3 target and add only a correlation ID"
  );
  assert(
    !providerPort.posted.some((entry) =>
      entry.cmd === "cancel" && entry.canceledRequestId === readMessages[1].requestId
    ),
    "Canceling one read must not cancel another request to the same provider"
  );
  await providerPort.onMessage.emit({
    requestId: readMessages[1].requestId,
    ok: true,
    result: { name: "b.bin", size: 1, slice(){} }
  });
  const readBResult = await readB;
  assert(readBResult.name === "b.bin", "The uncanceled provider read must finish normally");
}

async function checkExternalDiscoverySkipsSelf(){
  const probes = [];
  const management = {
    getAll: async () => [
      { id: "self@test", enabled: true },
      { id: "external@test", enabled: true }
    ],
    onInstalled: createEvent(),
    onEnabled: createEvent(),
    onDisabled: createEvent(),
    onUninstalled: createEvent()
  };
  const harness = createClientBrowser({
    management,
    discover: async (providerId) => {
      probes.push(providerId);
      return { API_VERSION: "1.3", name: providerId, connections: [] };
    }
  });
  global.browser = harness.browser;
  global.window = global;
  const client = await import(moduleUrl(
    "vendor/vfs-toolkit/vfs-client/vfs-client.mjs",
    "client-management"
  ));
  await client.init({ enableExternalProviders: true, configStorageKey: "providers" });
  await waitFor(() => probes.includes("external@test"), "External provider was not probed");
  assert(
    probes.filter((providerId) => providerId === "self@test").length === 0,
    "External discovery must not probe the co-located provider"
  );
  assert(
    probes.filter((providerId) => providerId === "external@test").length === 1,
    "Each external provider must be probed once during initialization"
  );
}

function createFile(name, size, type = "application/octet-stream"){
  return {
    name,
    size,
    type,
    lastModified: 1000,
    slice(){
      return this;
    }
  };
}

async function checkMixedSourcePlan(){
  const copyCalls = [];
  const transferOrder = [];
  const itemEvents = [];
  const selfStorageRef = { providerId: "self@test", storageId: "self-storage" };
  const externalStorageRef = { providerId: "external@test", storageId: "external-storage" };
  let activeReads = 0;
  let maximumActiveReads = 0;
  const context = {
    console,
    AbortController,
    DOMException,
    bgI18n: (key) => key,
    NCNextcloudDav: {
      joinPath: (...segments) => segments.filter(Boolean).join("/"),
      normalizeRelativePath: (value) => String(value || "").replace(/^\/+|\/+$/g, ""),
      normalizeVfsPath(value, { allowRoot = true } = {}){
        const pathValue = String(value || "");
        if (!pathValue.startsWith("/") || (!allowRoot && pathValue === "/")){
          throw new Error("invalid_path");
        }
        return pathValue;
      },
      throwIfAborted(signal){
        if (signal?.aborted){
          throw new DOMException("Cancelled", "AbortError");
        }
      }
    },
    NCFileLinkUploadPolicy: {
      DIRECT_UPLOAD_LIMIT_BYTES: 20
    },
    NCFileLinkUpload: {
      async uploadFile({ file }){
        const mode = file.size > context.NCFileLinkUploadPolicy.DIRECT_UPLOAD_LIMIT_BYTES
          ? "chunked"
          : "direct";
        transferOrder.push(`upload-${mode}:${file.itemId}`);
      }
    },
    NCVfsProviderRuntime: {
      async copyIntoShare(storageRef, options){
        assert(
          storageRef.providerId === selfStorageRef.providerId
            && storageRef.storageId === selfStorageRef.storageId,
          "Same-Nextcloud copy must retain its selected storage lease"
        );
        copyCalls.push(options);
      }
    },
    NCVfsClientRuntime: {
      async readFile(entry, options){
        activeReads++;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        transferOrder.push(`read:${entry.path}`);
        options.onProgress?.({ percent: 50 });
        await Promise.resolve();
        activeReads--;
        const size = entry.path.endsWith("large.bin") ? 30 : 10;
        return createFile(entry.path.split("/").pop(), size);
      }
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("modules/fileQueuePathConflicts.js", context);
  loadScript("modules/fileLinkSources.js", context);

  const localFile = createFile("local.txt", 5, "text/plain");
  const sourcePlan = context.NCFileLinkSources.normalizeItems([
    {
      id: "local",
      sourceKind: "local",
      kind: "file",
      file: localFile,
      name: "local.txt",
      displayPath: "local.txt"
    },
    {
      id: "nextcloud-file",
      sourceKind: "nextcloud",
      kind: "file",
      name: "cloud.txt",
      displayPath: "cloud.txt",
      sourcePath: "/Documents/cloud.txt",
      storageRef: selfStorageRef,
      transferGroupId: "nc-file",
      transferRole: "copy-root",
      transferRoot: true
    },
    {
      id: "nextcloud-folder",
      sourceKind: "nextcloud",
      kind: "folder",
      name: "Photos",
      displayPath: "Photos",
      sourcePath: "/Photos",
      storageRef: selfStorageRef,
      transferGroupId: "nc-folder",
      transferRole: "copy-root",
      transferRoot: true
    },
    {
      id: "nextcloud-folder-child",
      sourceKind: "nextcloud",
      kind: "file",
      name: "one.jpg",
      relativeDir: "Photos",
      displayPath: "Photos/one.jpg",
      sourcePath: "/Photos/one.jpg",
      storageRef: selfStorageRef,
      transferGroupId: "nc-folder",
      transferRole: "copy-child"
    },
    {
      id: "external-folder",
      sourceKind: "external-vfs",
      kind: "folder",
      name: "External",
      displayPath: "External",
      sourcePath: "/External",
      storageRef: externalStorageRef,
      transferGroupId: "external-folder",
      transferRole: "directory",
      transferRoot: true
    },
    {
      id: "external-small",
      sourceKind: "external-vfs",
      kind: "file",
      name: "small.bin",
      relativeDir: "External",
      displayPath: "External/small.bin",
      sourcePath: "/External/small.bin",
      storageRef: externalStorageRef,
      size: 10,
      transferGroupId: "external-folder"
    },
    {
      id: "external-large",
      sourceKind: "external-vfs",
      kind: "file",
      name: "large.bin",
      relativeDir: "External/Empty",
      displayPath: "External/Empty/large.bin",
      sourcePath: "/External/Empty/large.bin",
      storageRef: externalStorageRef,
      size: 30,
      transferGroupId: "external-folder"
    }
  ], {
    sanitizeFileName: (value) => String(value),
    sanitizeRelativeDir: (value) => String(value || "")
  });

  assert(sourcePlan.localFiles.length === 1, "Local files must remain on the existing upload path");
  assert(sourcePlan.nextcloudCopies.length === 2, "Only same-Nextcloud selection roots may issue COPY");
  assert(sourcePlan.externalFiles.length === 2, "External files must remain individual transfer items");
  assert(
    sourcePlan.additionalDirectories.includes("External/Empty"),
    "External folder trees must preserve empty and parent directories"
  );

  const controller = new AbortController();
  await context.NCFileLinkSources.transferAdditionalSources({
    plan: sourcePlan,
    davRoot: "https://cloud.test/remote.php/dav/files/user",
    uploadRoot: "https://cloud.test/remote.php/dav/uploads/user",
    shareRoot: "Shares/Target",
    authHeader: "Basic redacted",
    signal: controller.signal,
    onStatus: (event) => itemEvents.push(event),
    progress: {}
  });
  assert(copyCalls.length === 2, "Each same-Nextcloud selection root must use one server-side COPY");
  assert(
    copyCalls.every((entry) => entry.destinationPath.startsWith("/Shares/Target/")),
    "Server-side COPY destinations must stay inside the generated share root"
  );
  assert(maximumActiveReads === 1, "External VFS files must be read one at a time");
  assert(
    JSON.stringify(transferOrder) === JSON.stringify([
      "read:/External/small.bin",
      "upload-direct:external-small",
      "read:/External/Empty/large.bin",
      "upload-chunked:external-large"
    ]),
    "Each external File must be uploaded before the next provider read starts"
  );
  assert(
    itemEvents.some((entry) => entry.itemId === "external-folder" && entry.phase === "done"),
    "Created external directories must be reflected in the queue"
  );

  let metadataRejected = false;
  try{
    context.NCFileLinkSources.normalizeItems([{
      id: "missing-size",
      sourceKind: "external-vfs",
      kind: "file",
      name: "unknown.bin",
      sourcePath: "/unknown.bin",
      storageRef: externalStorageRef
    }], {
      sanitizeFileName: (value) => String(value),
      sanitizeRelativeDir: (value) => String(value || "")
    });
  }catch(error){
    metadataRejected = error.message === "vfs_error_file_metadata_missing";
  }
  assert(metadataRejected, "External files without stable size metadata must fail before upload");
}

function checkManifestAndReviewSurface(){
  const manifest = readJson("manifest.json");
  assert(
    manifest.optional_permissions.includes("management")
      && !manifest.permissions.includes("management"),
    "External provider discovery must use an optional management permission"
  );
  const scripts = manifest.background.scripts;
  const expectedOrder = [
    "modules/nextcloudDav.js",
    "modules/fileLinkUpload.js",
    "modules/nextcloudVfsStorage.js",
    "modules/vfsProviderRuntime.js",
    "modules/vfsClientRuntime.js",
    "modules/fileLinkSources.js",
    "modules/ncSharing.js"
  ];
  let previous = -1;
  for (const script of expectedOrder){
    const index = scripts.indexOf(script);
    assert(index > previous, `${script} must load in dependency order`);
    previous = index;
  }
  assert(!scripts.includes("modules/fileLinkDav.js"), "The replaced DAV module must not remain loaded");
  const wizardHtml = readText("ui/nextcloudSharingWizard.html");
  const pickerCss = readText("vendor/vfs-toolkit/vfs-client/picker.css");
  for (const elementId of [
    "localSourceAction",
    "nextcloudSourceAction",
    "externalSourceAction",
    "addNextcloudFilesBtn",
    "addNextcloudFolderBtn",
    "addExternalFilesBtn",
    "addExternalFolderBtn"
  ]){
    assert(wizardHtml.includes(`id="${elementId}"`), `${elementId} must be available in the queue UI`);
  }
  assert(
    /#vfs-toolbar\s*\{[^}]*display:\s*none\s*;/s.test(pickerCss),
    "The NC Connector picker must hide the management toolbar in selection mode"
  );
  assert(
    wizardHtml.includes("grid-template-columns:minmax(110px,.75fr) minmax(145px,1fr) minmax(190px,1.3fr)")
      && wizardHtml.includes("min-height:44px"),
    "The source actions must give localized labels enough width and line height"
  );
  const wizardRuntime = readText("ui/nextcloudSharingWizard.js");
  assert(
    wizardRuntime.includes("state.vfsPickerReturnFocusSeen = true;")
      && wizardRuntime.includes("state.skipNextVfsFocusRefresh = !state.vfsPickerReturnFocusSeen;")
      && /if \(state\.skipNextVfsFocusRefresh\)\{\s*state\.skipNextVfsFocusRefresh = false;\s*return;\s*\}/s.test(wizardRuntime),
    "Returning from a VFS picker must not refresh while its runtime actor is closing"
  );
  const sourceRuntime = readText("modules/fileLinkSources.js");
  assert(!sourceRuntime.includes("storage.local"), "External File content must not be staged in extension storage");
  assert(!sourceRuntime.includes("indexedDB"), "External File content must not be staged in IndexedDB");
  assert(!sourceRuntime.includes("showSaveFilePicker"), "External File content must not be staged on disk");
  const clientRuntime = readText("modules/vfsClientRuntime.js");
  const providerRuntime = readText("modules/vfsProviderRuntime.js");
  const storageRuntime = readText("modules/nextcloudVfsStorage.js");
  assert(
    !clientRuntime.includes("vfs_self_provider_unavailable"),
    "A fresh profile without credentials must not permanently reject the VFS client runtime"
  );
  assert(
    clientRuntime.includes("toolkit.openProviderSetup(")
      && readText("modules/bgRouter.js").includes('msg.type === "vfs:options:connectProvider"')
      && readText("ui/optionsVfs.js").includes('connectProvider: "vfs:options:connectProvider"'),
    "External providers must have one explicit Toolkit setup path from the VFS options tab"
  );
  assert(
    clientRuntime.includes("async function disconnectExternalConnection(storageRef)")
      && clientRuntime.includes("toolkit.deleteProviderConnection(normalized)")
      && readText("modules/bgRouter.js").includes('msg.type === "vfs:options:disconnectConnection"')
      && readText("ui/optionsVfs.js").includes("MESSAGE_TYPES.disconnectConnection"),
    "External connections must be removable through the official Toolkit API"
  );
  assert(
    clientRuntime.includes("client.registerLocalProvider({")
      && clientRuntime.includes("global.NCVfsProviderRuntime.connectLocal()")
      && providerRuntime.includes("return provider.connectLocal()"),
    "The co-located Nextcloud provider must refresh the picker cache and use the provider command path"
  );
  assert(
    wizardHtml.includes('id="vfsProviderFallbackIcon"')
      && readText("modules/vfsClientRuntime.js").includes("icon: providerInfo.icon || null"),
    "External storage selection must retain provider icons with a local fallback"
  );
  assert(
    providerRuntime.includes("core: NCCore"),
    "VFS provider startup must inject the classic-script NCCore binding explicitly"
  );
  assert(
    storageRuntime.includes("fileUpload.uploadSingleFile({")
      && storageRuntime.includes("getRequiredCapabilities({ ...opts, signal })")
      && !/async function writeFile[\s\S]*?dav\.xhrRequest\(\{/m.test(storageRuntime),
    "Provider writes must enforce the Nextcloud contract and use the shared upload engine"
  );
  assert(
    providerRuntime.includes("uploadLog: (message, metadata = {}) => L(message, {")
      && providerRuntime.includes("origin: 'vfs_provider'"),
    "Provider uploads must retain the existing upload messages with origin metadata"
  );
  assert(
    providerRuntime.includes("expectedAccountKey"),
    "Authorized provider operations must stay bound to the account identity they validated"
  );
  assert(
    providerRuntime.includes("copyIntoShare(storageRef")
      && !sourceRuntime.includes("getStorage()"),
    "Same-Nextcloud share copies must use the provider runtime's storage/account lease"
  );
  assert(
    sourceRuntime.includes("NCFileLinkUpload.uploadFile({")
      && !sourceRuntime.includes("NCFileLinkUpload.uploadDirect({")
      && !sourceRuntime.includes("NCFileLinkUpload.uploadChunked({"),
    "External VFS files must use the shared Direct/Chunked upload selector"
  );
  assert(
    providerRuntime.includes("authorization changed during setup")
      && providerRuntime.includes("current.state.accountKey !== state.accountKey"),
    "Provider grants must be revalidated if settings change while setup is open"
  );
}

async function run(){
  checkManifestAndReviewSurface();
  checkRouterLeavesToolkitMessagesUnclaimed();
  await checkProviderSenderBinding();
  await checkClientLifecycle();
  await checkExternalDiscoverySkipsSelf();
  await checkMixedSourcePlan();
  console.log("[OK] vfs-integration-check passed");
}

run().catch((error) => {
  console.error("[FAIL] vfs-integration-check", error);
  process.exitCode = 1;
});
