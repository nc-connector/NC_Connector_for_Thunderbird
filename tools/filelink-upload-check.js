"use strict";

const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { assert, loadScript, readJson, readText } = require("./review-check-utils");

const MIB = 1024 * 1024;

function createContext(){
  const context = {
    console,
    Blob,
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
    URL,
    URLSearchParams,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    AbortController,
    DOMException,
    Date,
    Math,
    JSON,
    globalThis: null,
    window: null,
    self: null,
    module: undefined,
    exports: undefined,
    bgI18n: (key) => key,
    NCLogContext: {
      safeConsoleError: () => {}
    }
  };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  vm.createContext(context);
  loadScript("vendor/spark-md5.min.js", context);
  loadScript("modules/fileLinkUploadPolicy.js", context);
  loadScript("modules/nextcloudDav.js", context);
  loadScript("modules/fileLinkUploadProgress.js", context);
  loadScript("modules/fileLinkBulkUpload.js", context);
  loadScript("modules/fileLinkUpload.js", context);
  loadScript("modules/fileLinkShare.js", context);
  return context;
}

function createTestEvent(){
  const listeners = new Set();
  return {
    addListener(listener){
      listeners.add(listener);
    },
    removeListener(listener){
      listeners.delete(listener);
    },
    emit(value){
      for (const listener of Array.from(listeners)){
        listener(value);
      }
    },
    get size(){
      return listeners.size;
    }
  };
}

function createTestPort({ postError = null, disconnectError = null } = {}){
  const onMessage = createTestEvent();
  const onDisconnect = createTestEvent();
  return {
    posted: [],
    disconnectCount: 0,
    onMessage,
    onDisconnect,
    postMessage(message){
      if (postError){
        throw postError;
      }
      this.posted.push(message);
    },
    disconnect(){
      if (disconnectError){
        throw disconnectError;
      }
      this.disconnectCount++;
      onDisconnect.emit();
    }
  };
}

function createPortRequestContext(){
  const state = {
    port: null,
    connectError: null,
    connectedNames: [],
    lastError: null
  };
  const context = {
    console,
    Error,
    TypeError,
    Promise,
    Object,
    String,
    browser: {
      runtime: {
        connect({ name }){
          state.connectedNames.push(name);
          if (state.connectError){
            throw state.connectError;
          }
          return state.port;
        },
        get lastError(){
          return state.lastError;
        }
      }
    },
    globalThis: null,
    window: null
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("ui/sharingPortRequest.js", context);
  return { context, state };
}

async function checkSharingPortRequest(){
  const { context, state } = createPortRequestContext();
  const runtime = context.NCSharingPortRequest;
  const opened = [];
  const closed = [];
  const progress = [];
  state.port = createTestPort();

  const resultPromise = runtime.run({
    portName: "nc-filelink-upload",
    startMessage: { type: "start", request: { id: 1 } },
    fallbackErrorMessage: "Upload failed",
    onProgress: (message) => progress.push(message.current),
    mapResult: (message) => message.result,
    onPortOpened: (port) => opened.push(port),
    onPortClosed: (port) => closed.push(port)
  });
  assert(state.connectedNames[0] === "nc-filelink-upload", "Port helper must connect with the requested name");
  assert(state.port.posted[0]?.type === "start", "Port helper must post the start message after listener setup");
  state.port.onMessage.emit({ type: "progress", current: 4 });
  state.port.onMessage.emit({ type: "result", result: { shareId: "42" } });
  const result = await resultPromise;
  assert(result.shareId === "42", "Port helper must map the result message");
  assert(progress[0] === 4, "Port helper must forward progress messages");
  assert(opened[0] === state.port && closed[0] === state.port, "Port ownership callbacks must receive the same Port");
  assert(
    state.port.onMessage.size === 0
      && state.port.onDisconnect.size === 0
      && state.port.disconnectCount === 1,
    "Completed Port requests must remove listeners and disconnect once"
  );

  state.port = createTestPort();
  const errorPromise = runtime.run({
    portName: "nc-filelink-upload",
    startMessage: { type: "start" },
    fallbackErrorMessage: "Upload failed",
    mapError: (message) => {
      const error = new Error(message.error.message);
      error.code = message.error.code;
      return error;
    }
  });
  state.port.onMessage.emit({
    type: "error",
    error: { message: "Quota exceeded", code: "quota" }
  });
  let mappedFailure = null;
  try{
    await errorPromise;
  }catch(error){
    mappedFailure = error;
  }
  assert(
    mappedFailure?.message === "Quota exceeded" && mappedFailure.code === "quota",
    "Port helper must preserve the caller's serialized error mapping"
  );

  state.port = createTestPort();
  state.lastError = { message: "Background closed" };
  const disconnectPromise = runtime.run({
    portName: "nc-vfs-source-selection",
    startMessage: { type: "start" },
    fallbackErrorMessage: "Selection failed"
  });
  state.port.onDisconnect.emit();
  let disconnectFailure = null;
  try{
    await disconnectPromise;
  }catch(error){
    disconnectFailure = error;
  }
  assert(disconnectFailure?.message === "Background closed", "Port disconnects must expose runtime.lastError");
  state.lastError = null;

  const postFailure = new Error("Start failed");
  state.port = createTestPort({ postError: postFailure });
  let startFailure = null;
  try{
    await runtime.run({
      portName: "nc-filelink-upload",
      startMessage: { type: "start" },
      fallbackErrorMessage: "Upload failed"
    });
  }catch(error){
    startFailure = error;
  }
  assert(startFailure === postFailure, "A failed start post must reject with the original error");
  assert(
    state.port.onMessage.size === 0
      && state.port.onDisconnect.size === 0
      && state.port.disconnectCount === 1,
    "A failed start post must release the Port"
  );

  const cancelPort = createTestPort();
  assert(
    runtime.cancel(cancelPort, { reason: "wizard_unload" }),
    "An active request must accept wizard cancellation"
  );
  assert(
    cancelPort.posted[0]?.type === "cancel"
      && cancelPort.posted[0]?.reason === "wizard_unload"
      && cancelPort.disconnectCount === 1,
    "Wizard cancellation must post the reason before disconnecting"
  );
}

function plannedFile(index, size, relativeDir = ""){
  return Object.freeze({
    itemId: `item-${index}`,
    sourceFile: new Blob([new Uint8Array(size)]),
    fileName: `file-${index}.bin`,
    displayPath: `${relativeDir ? `${relativeDir}/` : ""}file-${index}.bin`,
    relativeDir,
    size,
    lastModified: 1700000000000 + index,
    contentType: "application/octet-stream"
  });
}

async function run(){
  await checkSharingPortRequest();
  const context = createContext();
  const policy = context.NCFileLinkUploadPolicy;
  const dav = context.NCNextcloudDav;
  const bulk = context.NCFileLinkBulkUpload;

  assert(policy.DIRECT_UPLOAD_LIMIT_BYTES === 20 * MIB, "Direct limit must be 20 MiB");
  assert(policy.getChunkRequestCount(20 * MIB) === 1, "Exactly 20 MiB must use Direct PUT");
  assert(policy.getChunkRequestCount(20 * MIB + 1) === 4, "A file above 20 MiB must use chunk folder, two chunks, and MOVE");
  assert(policy.isBulkCandidate(8 * MIB), "Exactly 8 MiB must remain a bulk candidate");
  assert(!policy.isBulkCandidate(8 * MIB + 1), "A file above 8 MiB must not use bulk");
  assert(
    JSON.stringify(policy.RETRY_STATUS_CODES) === JSON.stringify([408, 423, 429, 502, 503, 504]),
    "Retry status list must match the shared upload rules"
  );
  assert(policy.MAX_PARALLEL_REQUESTS === 3, "Transfer worker limit must be three");
  assert(policy.MAX_ATTEMPTS === 3, "Replay-safe requests must stop after three attempts");

  const immutableInput = Object.freeze({
    itemId: "immutable",
    sourceFile: new Blob(["a"]),
    fileName: "immutable.txt",
    relativeDir: "one/two",
    size: 1
  });
  const singlePlan = policy.buildPlan({
    files: [immutableInput],
    bulkSupported: true,
    fixedRequestCount: 2
  });
  assert(singlePlan.files[0] !== immutableInput, "Planner must create its own item records");
  assert(singlePlan.files[0].size === 1, "Planner must retain source size");
  assert(singlePlan.directories.length === 0, "One Direct path must use server-side parent creation");

  const sharedPlan = policy.buildPlan({
    files: [
      plannedFile(1, 1, "one/two"),
      plannedFile(2, 1, "one/two")
    ],
    bulkSupported: false,
    fixedRequestCount: 2
  });
  assert(
    JSON.stringify(sharedPlan.directories) === JSON.stringify(["one", "one/two"]),
    "Shared Direct parents must be created once"
  );

  const chunkPlan = policy.buildPlan({
    files: [plannedFile(3, 20 * MIB + 1, "large/deep")],
    bulkSupported: false,
    fixedRequestCount: 2
  });
  assert(
    JSON.stringify(chunkPlan.directories) === JSON.stringify(["large", "large/deep"]),
    "Chunked uploads need explicit parent folders"
  );

  const smallFiles = Array.from({ length: 20 }, (_, index) =>
    plannedFile(index + 10, 1024, "bulk")
  );
  const bulkPlan = policy.buildPlan({
    files: smallFiles,
    bulkSupported: true,
    fixedRequestCount: 2
  });
  assert(bulkPlan.useBulkUpload, "Twenty small files with request savings must use DAV bulk");
  assert(bulkPlan.bulkFiles.length === 20 && bulkPlan.bulkBatches.length === 1, "All eligible files must enter one bounded batch");
  assert(bulkPlan.directFiles.length === 0, "Bulk files must not also remain in Direct");
  assert(bulkPlan.directories.length === 1, "Bulk destinations need their shared parent folder once");

  const noCapabilityPlan = policy.buildPlan({
    files: smallFiles,
    bulkSupported: false,
    fixedRequestCount: 2
  });
  assert(!noCapabilityPlan.useBulkUpload, "Missing DAV capability must keep Direct PUT");
  assert(noCapabilityPlan.directFiles.length === 20, "Direct PUT must remain the planned path without bulk");

  const deferredPlan = policy.buildPlan({
    files: [{
      itemId: "external-large",
      fileName: "external-large.bin",
      relativeDir: "external",
      size: 20 * MIB + 1
    }],
    bulkSupported: false
  });
  const mixedSummary = context.NCFileLinkUpload.buildUploadSummary(sharedPlan, {
    additionalPlan: deferredPlan,
    foldersToCreate: 3,
    serverCopies: 2
  });
  assert(
    mixedSummary.files === 3
      && mixedSummary.bytes === sharedPlan.totalBytes + deferredPlan.totalBytes
      && mixedSummary.direct === 2
      && mixedSummary.chunked === 1
      && mixedSummary.bulkFiles === 0
      && mixedSummary.foldersToCreate === 3
      && mixedSummary.serverCopies === 2,
    "Mixed-source upload summaries must include deferred VFS files and server-side copies"
  );

  assert(context.SparkMD5.hash("") === "d41d8cd98f00b204e9800998ecf8427e", "SparkMD5 empty-string vector must match");
  assert(context.SparkMD5.hash("abc") === "900150983cd24fb0d6963f7d28e17f72", "SparkMD5 abc vector must match");

  const contentFile = {
    internalId: "bulk-1",
    itemId: "bulk-item",
    sourceFile: new Blob(["abc"]),
    fileName: "a.txt",
    displayPath: "docs/a.txt",
    relativeDir: "docs",
    size: 3,
    lastModified: 1700000000000,
    contentType: "text/plain"
  };
  const checksum = await bulk.calculateMd5(contentFile);
  assert(checksum === "900150983cd24fb0d6963f7d28e17f72", "File MD5 must match the known vector");
  const checksumProgress = [];
  const preparedChecksums = await bulk.prepareChecksums(
    [
      contentFile,
      {
        ...contentFile,
        internalId: "bulk-2",
        itemId: "bulk-item-2",
        fileName: "b.txt",
        displayPath: "docs/b.txt"
      }
    ],
    null,
    (current, total) => checksumProgress.push(`${current}/${total}`)
  );
  assert(
    checksumProgress[0] === "0/2",
    "Bulk checksums must report their initial file count"
  );
  assert(
    checksumProgress.at(-1) === "2/2",
    "Bulk checksums must report their final file count"
  );
  assert(
    preparedChecksums.size === 2,
    "Bulk checksum preparation must calculate every MD5 value"
  );
  let emptyChecksumUpdates = 0;
  await bulk.prepareChecksums(
    [],
    null,
    () => emptyChecksumUpdates++
  );
  assert(
    emptyChecksumUpdates === 0,
    "Non-Bulk plans must not enter checksum progress"
  );
  const descriptor = bulk.buildMultipartDescriptor({
    batch: { files: [contentFile] },
    shareRoot: "NC Connector/20260723_Test",
    checksums: new Map([[contentFile.internalId, checksum]]),
    boundary: "ncconnector-test"
  });
  const bodyOne = bulk.buildBody(descriptor);
  const bodyTwo = bulk.buildBody(descriptor);
  assert(bodyOne.size === descriptor.contentLength, "Bulk body size must match the calculated byte length");
  assert(bodyTwo.size === bodyOne.size, "A retry must rebuild an equal-size bulk body");
  assert(descriptor.ranges[0].dataEnd - descriptor.ranges[0].dataStart === 3, "Bulk byte range must cover file data only");
  const destinationPath = descriptor.ranges[0].destinationPath;
  bulk.parseBulkResponse(JSON.stringify({
    [destinationPath]: { error: false, etag: "test" }
  }), descriptor);
  let bulkFailure = null;
  try{
    bulk.parseBulkResponse(JSON.stringify({
      [destinationPath]: { error: true, message: "quota" }
    }), descriptor);
  }catch(error){
    bulkFailure = error;
  }
  assert(bulkFailure?.ncBulkPath === destinationPath, "A failed bulk part must identify its exact destination");

  assert(dav.AUTO_MKCOL_HEADER === "X-NC-WebDAV-Auto-Mkcol", "NC32 Auto-Mkcol header spelling must match the server implementation");
  assert(dav.parseRetryAfter("12", 0) === 12000, "Retry-After seconds must be parsed");
  assert(dav.parseRetryAfter("999", 0) === 30000, "Retry-After must be capped at 30 seconds");

  const manifest = readJson("manifest.json");
  const backgroundScripts = manifest.background.scripts;
  const requiredOrder = [
    "vendor/spark-md5.min.js",
    "modules/fileLinkUploadPolicy.js",
    "modules/nextcloudDav.js",
    "modules/fileLinkUploadProgress.js",
    "modules/fileLinkBulkUpload.js",
    "modules/fileLinkUpload.js",
    "modules/fileLinkShare.js",
    "modules/ncSharing.js",
    "modules/bgFileLinkUpload.js"
  ];
  let previousIndex = -1;
  for (const script of requiredOrder){
    const index = backgroundScripts.indexOf(script);
    assert(index > previousIndex, `Background script order must load ${script} after its dependencies`);
    previousIndex = index;
  }

  const wizardSource = readText("ui/nextcloudSharingWizard.js");
  const wizardHtml = readText("ui/nextcloudSharingWizard.html");
  const portRequestSource = readText("ui/sharingPortRequest.js");
  const sharingSource = readText("modules/ncSharing.js");
  const routerSource = readText("modules/bgRouter.js");
  const uploadSource = readText("modules/fileLinkUpload.js");
  assert(
    wizardHtml.includes('<script src="sharingPortRequest.js"></script>')
      && portRequestSource.includes("browser.runtime.connect({ name: portName })")
      && (wizardSource.match(/NCSharingPortRequest\.run\(\{/g) || []).length === 2
      && !wizardSource.includes("browser.runtime.connect("),
    "Sharing wizard Ports must use the shared request lifecycle"
  );
  assert(!wizardSource.includes("NCSharing.createFileLink({"), "Wizard must not own network transfers");
  assert(
    wizardSource.includes('type: "sharing:checkFolderExists"'),
    "Wizard step one must request a background folder collision preflight"
  );
  assert(
    /if\s*\(!\(await preflightShareFolder\(\)\)\)\s*\{\s*return;\s*\}/.test(wizardSource),
    "Wizard step one must not advance when folder preflight rejects the target"
  );
  assert(
    /if\s*\(response\.exists\)\s*\{\s*setMessage\(i18n\('sharing_error_folder_exists'\), 'error'\);\s*return false;\s*\}/.test(wizardSource),
    "Existing manual targets must keep the localized collision error in step one"
  );
  assert(
    !wizardSource.includes("NCNextcloudDav.probePath"),
    "Wizard must not perform DAV network access directly"
  );
  assert(
    routerSource.includes('if (msg.type === "sharing:checkFolderExists")'),
    "Background router must own the wizard folder collision preflight"
  );
  assert(
    sharingSource.includes("async function checkFileLinkFolderExists(request)")
      && sharingSource.includes("NCNextcloudDav.probePath({"),
    "Manual folder collision preflight must reuse the central DAV probe"
  );
  assert(!sharingSource.includes("publicUpload\", \"true"), "Share creation must not add a second permissions mode");
  assert(uploadSource.includes("NCFileLinkUploadPolicy.MAX_PARALLEL_REQUESTS"), "Transfer pool must use the shared worker limit");
  assert(
    uploadSource.includes('phase: "checksums"')
      && wizardSource.includes("sharing_status_calculating_checksums"),
    "Bulk checksum progress must reach the Sharing wizard"
  );
  const mixedTransferStart = uploadSource.indexOf("async function prepareAndUpload");
  const mixedTransferEnd = uploadSource.indexOf("global.NCFileLinkUpload", mixedTransferStart);
  const mixedTransferSource = uploadSource.slice(mixedTransferStart, mixedTransferEnd);
  const localUploadEnd = mixedTransferSource.indexOf("await uploadPlan({");
  const additionalTransferEnd = mixedTransferSource.indexOf("await transferAdditionalSources({");
  const completionLog = mixedTransferSource.indexOf("logUploadCompleted(uploadSummary");
  assert(
    mixedTransferSource.includes("logCompletion: false")
      && localUploadEnd >= 0
      && additionalTransferEnd > localUploadEnd
      && completionLog > additionalTransferEnd,
    "Mixed-source completion must be logged after every source transfer"
  );

  console.log("[OK] filelink-upload-check passed");
}

run().catch((error) => {
  console.error("[FAIL] filelink-upload-check", error);
  process.exitCode = 1;
});
