"use strict";

const vm = require("node:vm");
const {
  assert,
  listFiles,
  loadScript,
  readJson,
  readText
} = require("./review-check-utils");

function createContext(){
  const context = {
    console,
    globalThis: null,
    window: null,
    self: null
  };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  vm.createContext(context);
  loadScript("modules/fileQueuePathConflicts.js", context);
  loadScript("ui/sharingQueueEntries.js", context);
  loadScript("ui/sharingQueueTree.js", context);
  return context;
}

function testQueueEntryModel(context){
  const queueEntries = context.NCSharingQueueEntries.create({
    sanitizeFileName: (value) => String(value || "").replace(/[\\/:]/g, "_"),
    sanitizeRelativeDir: (value) => String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
    findPathConflict: context.NCFileQueuePathConflicts.find
  });
  assert(
    queueEntries.normalizeDisplayPath("Folder\\Nested//file.txt") === "Folder/Nested/file.txt",
    "Queue entry paths must normalize Windows separators"
  );
  assert(
    queueEntries.extractSelectionRootDir("C:\\fakepath\\file.txt") === ""
      && queueEntries.extractSelectionRootDir("C:\\Files\\file.txt") === "C:/Files",
    "Queue entry roots must ignore browser fake paths without dropping real exposed paths"
  );

  const remote = queueEntries.createRemoteEntry({
    sourceKind: "external-vfs",
    sourceLabel: "WebDAV · KuP",
    kind: "file",
    name: "report:final.pdf",
    storageRef: { providerId: "webdav@test", storageId: "customer-files" },
    sourcePath: "/Reports/report:final.pdf",
    relativeDir: "Reports",
    size: 42,
    lastModified: 123,
    contentType: "application/pdf",
    transferGroupId: "remote-group"
  }, 0, { invalidNameMessage: "invalid" });
  assert(
    remote.sourceKind === "external-vfs"
      && remote.storageRef.providerId === "webdav@test"
      && remote.displayPath === "Reports/report:final.pdf"
      && remote.size === 42,
    "Remote queue descriptors must retain provider, path, and file metadata"
  );
  assert(
    queueEntries.getTargetRelativePath(remote) === "Reports/report_final.pdf",
    "Queue target paths must use the injected Nextcloud sanitizers"
  );

  const root = {
    kind: "folder",
    sourceKind: "nextcloud",
    transferGroupId: "tree",
    transferRoot: true,
    displayPath: "Pack",
    displayDir: "",
    relativeDir: "",
    name: "Pack"
  };
  const child = {
    kind: "file",
    sourceKind: "nextcloud",
    transferGroupId: "tree",
    transferRoot: false,
    displayPath: "Pack/Sub/file.txt",
    displayDir: "Pack/Sub",
    relativeDir: "Pack/Sub",
    name: "file.txt"
  };
  queueEntries.renameEntry([root, child], root, "Renamed");
  assert(
    root.displayPath === "Renamed"
      && child.displayPath === "Renamed/Sub/file.txt"
      && child.relativeDir === "Renamed/Sub",
    "Renaming a remote folder root must update every member of its transfer group"
  );
  assert(
    queueEntries.getCollisionRenameTarget([root, child], child) === root,
    "Nested Nextcloud collisions must rename the selected transfer root"
  );

  const duplicate = { ...remote, id: "duplicate" };
  assert(
    queueEntries.findConflict([remote, duplicate])?.type === "exact",
    "Queue entry collision checks must use sanitized target paths"
  );
  duplicate.status = "error";
  duplicate.progress = 55;
  duplicate.error = "failed";
  duplicate.speedKbps = 12;
  duplicate.progressStartedAt = 100;
  queueEntries.resetTransferState(duplicate);
  assert(
    duplicate.status === "pending"
      && duplicate.progress === 0
      && duplicate.error === ""
      && duplicate.speedKbps === 0
      && duplicate.progressStartedAt === 0,
    "Queue entry retry state must reset as one model operation"
  );
}

function collectKeys(model){
  const keys = [];
  function visit(node){
    keys.push(node.key);
    node.children.forEach(visit);
  }
  model.sources.forEach((source) => source.nodes.forEach(visit));
  return keys;
}

function buildFixture(){
  const mib = 1024 * 1024;
  const externalRef = { providerId: "webdav@test", storageId: "customer-files" };
  return [
    {
      id: "local-a",
      sourceKind: "local",
      kind: "file",
      name: "a.bin",
      relativeDir: "Root/A",
      queueGroupId: "local-folder",
      file: { size: 64 * mib }
    },
    {
      id: "local-b",
      sourceKind: "local",
      kind: "file",
      name: "b.bin",
      relativeDir: "Root/B",
      queueGroupId: "local-folder",
      file: { size: 48 * mib }
    },
    {
      id: "external-root",
      sourceKind: "external-vfs",
      sourceLabel: "WebDAV · KuP",
      storageRef: externalRef,
      kind: "folder",
      name: "Pack",
      relativeDir: "",
      transferGroupId: "external-folder",
      transferRoot: true
    },
    {
      id: "external-c-folder",
      sourceKind: "external-vfs",
      sourceLabel: "WebDAV · KuP",
      storageRef: externalRef,
      kind: "folder",
      name: "C",
      relativeDir: "Pack",
      transferGroupId: "external-folder"
    },
    {
      id: "external-c",
      sourceKind: "external-vfs",
      sourceLabel: "WebDAV · KuP",
      storageRef: externalRef,
      kind: "file",
      name: "c.bin",
      relativeDir: "Pack/C",
      transferGroupId: "external-folder",
      size: 56 * mib
    },
    {
      id: "external-d-folder",
      sourceKind: "external-vfs",
      sourceLabel: "WebDAV · KuP",
      storageRef: externalRef,
      kind: "folder",
      name: "D",
      relativeDir: "Pack",
      transferGroupId: "external-folder"
    },
    {
      id: "external-d",
      sourceKind: "external-vfs",
      sourceLabel: "WebDAV · KuP",
      storageRef: externalRef,
      kind: "file",
      name: "d.bin",
      relativeDir: "Pack/D",
      transferGroupId: "external-folder",
      size: 56 * mib
    }
  ];
}

async function testLiveComposeQueue(){
  const source = readText("ui/nextcloudSharingWizard.js");
  function extract(start, end){
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert(from >= 0 && to > from, `Wizard function boundary missing: ${start}`);
    return source.slice(from, to);
  }
  let receive;
  let disconnect;
  let closed = 0;
  const posted = [];
  const uploads = [];
  const File = class { constructor(name){ this.name = name; this.size = 10; } };
  const state = { files: [], composeBatches: new Map(), queueRevision: 0,
    uploadedQueueRevision: 0, uploadCompleted: false, uploadResult: null,
    currentStep: 1, mode: "default" };
  const result = { shareInfo: { shareId: "single", folderInfo: { relativeFolder: "Shares/Single" } } };
  const context = createContext();
  Object.assign(context, {
    state, File, isPageUnloading: false,
    browser: { runtime: { connect: () => ({
      postMessage: (message) => posted.push(message),
      onMessage: { addListener: (handler) => { receive = handler; } },
      onDisconnect: { addListener: (handler) => { disconnect = handler; } }
    }) } },
    dom: { noteToggle: { checked: true }, noteInput: { value: "keep this note" },
      passwordToggle: {}, passwordInput: {}, expireToggle: {}, expireDate: {} },
    updateAttachmentModeInfo(){}, updateButtons(){}, rebuildFileEntryIndex(){},
    invalidateUpload(){ state.uploadCompleted = false; }, renderFileQueue(){},
    setMessage(){}, logUiError(){}, closeWizardWindow: async () => { closed++; },
    hasInsufficientDestinationStorage: () => false, validatePasswordIfNeeded: () => true,
    ensureUniqueQueueEntries: async () => true, log(){}, setUploadStatus(){},
    setOverallProgress(){}, getPermissions: () => ({ read: true }),
    getShareContext: () => ({ sanitizedName: "Single", shareDate: new Date("2026-10-21") }),
    setFinalizeInputsDisabled(){}, renderTargetFolderPath(){}, refreshConnectionWarning: async () => {},
    i18n: (key) => key
  });
  context.queueEntries = context.NCSharingQueueEntries.create({
    sanitizeFileName: (value) => value, sanitizeRelativeDir: (value) => value,
    findPathConflict: context.NCFileQueuePathConflicts.find
  });
  const apply = (batchId, name, revision) => {
    receive({ type: "attachments", batchId, attachments: [{ file: new File(name), name }] });
    assert(posted.at(-1).type === "accepted", "Valid files must be accepted before detaching");
    receive({ type: "committed", batchId, revision });
    assert(posted.at(-1).type === "applied", "A committed queue must acknowledge adoption");
  };
  context.runBackgroundFileLinkUpload = async (request) => {
    uploads.push(request);
    if (uploads.length === 1) apply("during-upload", "later.txt", 2);
    return result;
  };
  vm.runInContext(extract("  function connectComposeQueue(){", "  /**\n   * Apply the fixed defaults"), context);
  vm.runInContext(extract("  async function startUpload(", "  /**\n   * Update UI state for upload"), context);
  context.connectComposeQueue();
  receive({ type: "ready" });
  receive({ type: "attachments", batchId: "first", attachments: [{ file: new File("first.txt"), name: "first.txt" }] });
  assert(state.files.length === 0, "An offered batch must not enter the active queue before commit");
  receive({ type: "committed", batchId: "first", revision: 1 });
  receive({ type: "committed", batchId: "first", revision: 1 });
  assert(state.files.length === 1 && state.currentStep === 1 && context.dom.noteInput.value === "keep this note",
    "A drop before the queue step must preserve the current step, settings and unique entry");
  await context.startUpload();
  assert(uploads.length === 2 && uploads[0].append === false && uploads[1].append === true,
    "A drop during the first upload must continue the existing share");
  assert(uploads[0].files.length === 1 && uploads[1].files.length === 1
    && uploads[1].files[0].file.name === "later.txt",
  "Continuation must upload only newly adopted files");
  assert(state.uploadResult === result && state.uploadedQueueRevision === 2
    && state.files.every((entry) => entry.uploaded), "Completion must retain the same share and current queue revision");
  apply("after-upload", "last.txt", 3);
  assert(!state.uploadCompleted && state.uploadResult === result,
    "Later adoption must invalidate completion but preserve remote ownership");
  await context.startUpload();
  assert(uploads.length === 3 && uploads[2].append === true && uploads[2].files.length === 1,
    "A later upload must not resend completed entries");
  disconnect();
  assert(closed === 1 && !state.composeReady, "Disconnected queue sessions must close the wizard");
}

async function testQueueBootstrapWithoutVfsOrFocus(){
  const source = readText("ui/nextcloudSharingWizard.js");
  const start = source.indexOf("  async function init(){");
  const end = source.indexOf("  function setWizardReady(", start);
  assert(start >= 0 && end > start, "The wizard bootstrap must be available");
  let resolveVfs;
  const vfs = new Promise((resolve) => { resolveVfs = resolve; });
  const messages = [];
  const errors = [];
  let vfsRefreshes = 0;
  let uiReady = false;
  const state = { composeDisconnected: false };
  const context = {
    state, dom: {}, URLSearchParams, isPageUnloading: false,
    window: { location: { search: "?tabId=31&attachmentMode=1" } },
    NCTalkDomI18n: { translatePage(){} }, NCSharingStorage: {},
    passwordPolicyActions: { load: async () => {} },
    cacheElements(){}, setWizardReady(ready){ uiReady = ready; }, initializeQueueView(){},
    parseTabId: () => 31,
    connectComposeQueue(){ state.composePort = { postMessage: (message) => messages.push(message) }; },
    resolveWizardWindowId: async () => 91, initDebugLogging: async () => {}, attachEvents(){},
    refreshPolicyStatus: async () => {}, loadDefaultSettings: async () => {}, setDefaultShareName(){},
    applyDefaultSecuritySettings: async () => {}, loadBasePath: async () => {},
    refreshVfsSourceAvailability(){ vfsRefreshes++; return vfs; },
    applyAttachmentModeDefaults: async () => {}, renderFileQueue(){},
    updateStep(step){ state.currentStep = step; }, updateAttachmentModeInfo(){},
    log(){}, logUiError(...args){ errors.push(args); }, i18n: (key) => key,
    closeWizardWindow: async () => {}, setupWindowSizing(){}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context, { filename: "ui/nextcloudSharingWizard.js" });
  const focusStart = source.indexOf("  function handleWindowFocus(){");
  const focusEnd = source.indexOf("  async function loadDefaultSettings(", focusStart);
  vm.runInContext(source.slice(focusStart, focusEnd), context);
  context.handleWindowFocus();
  assert(vfsRefreshes === 0, "Focus during bootstrap must not start a duplicate discovery");
  let timeout;
  try{
    await Promise.race([
      context.init(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Queue waits for VFS discovery")), 1000); })
    ]);
    assert(messages.length === 1 && messages[0].type === "ready"
      && messages[0].tabId === 31 && messages[0].windowId === 91
      && state.currentStep === 3 && uiReady && errors.length === 0,
    "Attachment queue bootstrap must announce ready without interaction or a VFS response");
    assert(vfsRefreshes === 1, "Optional source discovery must still start once");
  }finally{
    clearTimeout(timeout);
    resolveVfs();
  }
}

async function run(){
  await testQueueBootstrapWithoutVfsOrFocus();
  await testLiveComposeQueue();
  const context = createContext();
  testQueueEntryModel(context);
  const queue = context.NCSharingQueueTree;
  const entries = buildFixture();
  const options = {
    getSourceLabel: (entry) => entry.sourceKind === "local" ? "Local" : entry.sourceLabel,
    getTargetPath: (entry) => [entry.relativeDir, entry.name].filter(Boolean).join("/")
  };
  const model = queue.buildModel(entries, options);
  const summary = queue.summarize(model);
  assert(summary.entryCount === 10, "The fixture must render ten logical tree entries");
  assert(summary.sourceCount === 2, "Storage identity must produce two source groups");
  assert(
    summary.knownFileBytes === 224 * 1024 * 1024 && !summary.hasUnknownSize,
    "Queue totals must sum files once without counting folder nodes"
  );

  const localRoot = model.sources.find((source) => source.key === "local")?.nodes[0];
  assert(
    localRoot?.label === "Root"
      && localRoot.synthetic === true
      && localRoot.removalTarget?.groupId === "local-folder",
    "A local folder pick must have one removable synthetic selection root"
  );
  assert(
    localRoot.children.every((child) =>
      child.kind === "folder"
        && child.removalTarget === null
        && child.children.length === 1
    ),
    "Nested folder children must be independently expandable but not removable yet"
  );
  const externalRoot = model.sources
    .find((source) => source.key.startsWith("external-vfs:"))?.nodes[0];
  assert(
    externalRoot?.entry?.id === "external-root"
      && externalRoot.removalTarget?.groupId === "external-folder",
    "A remote folder root must remove exactly its transfer group"
  );
  const beforeKeys = collectKeys(model);
  entries[4].status = "uploading";
  const afterKeys = collectKeys(queue.buildModel(entries, options));
  assert(
    JSON.stringify(afterKeys) === JSON.stringify(beforeKeys),
    "Status updates must not change stable expansion keys"
  );

  const unknownModel = queue.buildModel([{
    id: "unknown",
    sourceKind: "external-vfs",
    sourceLabel: "Legacy provider",
    storageRef: { providerId: "legacy@test", storageId: "one" },
    kind: "file",
    name: "unknown.bin",
    size: null
  }], options);
  const unknownSummary = queue.summarize(unknownModel);
  assert(
    unknownSummary.knownFileBytes === 0 && unknownSummary.hasUnknownSize,
    "Missing file metadata must remain visible as an unknown total"
  );

  assert(
    queue.evaluateCapacity(summary, { state: "finite", available: summary.knownFileBytes }).blocked === false,
    "A queue that exactly fits must remain uploadable"
  );
  assert(
    queue.evaluateCapacity(summary, { state: "finite", available: summary.knownFileBytes - 1 }).blocked === true,
    "A known finite shortage must block upload"
  );
  for (const state of ["unlimited", "unknown", "error"]){
    assert(
      queue.evaluateCapacity(summary, { state, available: 0 }).blocked === false,
      `${state} storage must not be guessed into a quota block`
    );
  }

  assert(queue.getFileGlyph("report.xlsx") === "📗", "Queue files must reuse the vendored VFS glyph map");
  assert(queue.getFileGlyph("archive.unknown") === "📄", "Unknown extensions must use the VFS fallback glyph");

  const source = readText("ui/sharingQueueTree.js");
  assert(
    source.includes("if (node.depth === 0)")
      && source.includes("children.hidden = !expandedKeys.has(node.key)")
      && source.includes("knownFolderKeys"),
    "Top-level folders must open initially while recursive expansion survives rerenders"
  );

  const wizardMarkup = readText("ui/nextcloudSharingWizard.html");
  const wizardSource = readText("ui/nextcloudSharingWizard.js");
  const queueEntriesSource = readText("ui/sharingQueueEntries.js");
  const sourceLabelStyle = wizardMarkup.match(/\.source-action summary > span\{([\s\S]*?)\}/)?.[1] || "";
  assert(
    wizardMarkup.includes('data-i18n="sharing_button_add_local">+ Local</span>')
      && wizardMarkup.includes('data-i18n="sharing_button_add_nextcloud">+ My Nextcloud</span>')
      && wizardMarkup.includes('data-i18n="sharing_button_add_external">+ Other source</span>'),
    "The three source actions must use complete add labels"
  );
  assert(
    !sourceLabelStyle.includes("text-overflow:ellipsis")
      && !sourceLabelStyle.includes("white-space:nowrap")
      && sourceLabelStyle.includes("overflow-wrap:anywhere"),
    "Source action labels must wrap instead of being clipped"
  );
  assert(
    wizardMarkup.includes('id="externalSourceNotice"')
      && wizardMarkup.includes('id="openVfsSettingsBtn"')
      && wizardMarkup.includes('id="findVfsProvidersBtn"')
      && !wizardMarkup.includes('id="refreshExternalSourcesBtn"'),
    "Other-source guidance must expose setup and search actions without a redundant refresh action"
  );
  for (const buttonId of [
    "addFilesBtn",
    "addFolderBtn",
    "addNextcloudFilesBtn",
    "addNextcloudFolderBtn",
    "addExternalFilesBtn",
    "addExternalFolderBtn",
    "openVfsSettingsBtn",
    "findVfsProvidersBtn"
  ]){
    assert(
      new RegExp(`<button[^>]+id="${buttonId}"[^>]*>\\s*<svg class="source-menu-icon"`).test(wizardMarkup),
      `${buttonId} must use the shared source-menu icon style`
    );
  }
  assert(
    wizardMarkup.includes(".base-path strong{")
      && wizardMarkup.includes("overflow-wrap:anywhere"),
    "The complete target folder path must be allowed to wrap"
  );
  assert(
    wizardSource.includes("NCSharing.buildShareFolderInfo(")
      && wizardSource.includes("state.uploadResult?.shareInfo?.folderInfo?.relativeFolder")
      && wizardSource.includes("formatTransferSize(destination.usage)"),
    "The queue must use the upload path builder, reserved result path, and reported unlimited usage"
  );
  assert(
    wizardSource.includes("state.vfsAvailability.external.connections.find")
      && wizardSource.includes("URL.createObjectURL(sourceIcon)")
      && wizardSource.includes("releaseUnusedQueueSourceIconUrls(model)")
      && wizardMarkup.includes(".sharing-queue-source-icon img,"),
    "External queue groups must render and release provider-reported icons"
  );
  const conflictScriptIndex = wizardMarkup.indexOf('<script src="../modules/fileQueuePathConflicts.js"></script>');
  const entriesScriptIndex = wizardMarkup.indexOf('<script src="sharingQueueEntries.js"></script>');
  const wizardScriptIndex = wizardMarkup.indexOf('<script src="nextcloudSharingWizard.js"></script>');
  assert(
    conflictScriptIndex >= 0
      && entriesScriptIndex > conflictScriptIndex
      && wizardScriptIndex > entriesScriptIndex,
    "Queue entry rules must load after path conflicts and before the Sharing wizard"
  );
  assert(
    wizardSource.includes("NCSharingQueueEntries.create({")
      && !/function (?:createRemoteQueueEntry|normalizeDisplayPath|resolveEntryDisplayPath|applyEntryRename)\(/.test(wizardSource)
      && queueEntriesSource.includes("function createRemoteEntry(")
      && queueEntriesSource.includes("function resolveDisplayPath(")
      && queueEntriesSource.includes("function renameEntry("),
    "The Sharing wizard must delegate queue descriptor and path rules to the queue entry model"
  );

  const en = readJson("_locales/en/messages.json");
  const de = readJson("_locales/de/messages.json");
  assert(
    en.sharing_step_files_title.message === "Build share"
      && en.sharing_base_path_info.message === "Target folder:"
      && en.sharing_queue_storage_available.message === "Free space: $1 of $2"
      && en.sharing_queue_storage_unlimited.message === "No storage limit · $1 used",
    "English queue wording must match the revised UX"
  );
  assert(
    de.sharing_step_files_title.message === "Freigabe zusammenstellen"
      && de.sharing_base_path_info.message === "Zielordner:"
      && de.sharing_queue_storage_available.message === "Freier Speicher: $1 von $2"
      && de.sharing_queue_storage_unlimited.message === "Kein Speicherlimit · $1 belegt",
    "German queue wording must match the revised UX"
  );

  const queueLocaleKeys = [
    "sharing_queue_entries_summary",
    "sharing_queue_sources_summary",
    "sharing_queue_total_summary",
    "sharing_queue_size_unknown",
    "sharing_queue_storage_loading",
    "sharing_queue_storage_available",
    "sharing_queue_storage_unlimited",
    "sharing_queue_storage_unknown",
    "sharing_queue_storage_insufficient",
    "sharing_queue_expand_folder",
    "sharing_queue_collapse_folder",
    "sharing_queue_remove_item",
    "sharing_queue_source_group",
    "sharing_vfs_external_disabled_notice",
    "sharing_vfs_external_no_providers_notice",
    "sharing_vfs_external_no_connections_notice",
    "sharing_vfs_external_load_failed_notice",
    "sharing_vfs_open_settings",
    "sharing_vfs_set_up_connection",
    "sharing_vfs_add_connection",
    "sharing_vfs_find_providers",
    "sharing_vfs_activation_reload_warning",
    "sharing_vfs_navigation_failed"
  ];
  for (const localePath of listFiles("_locales", { extensions: [".json"] })){
    const localeSource = readText(localePath);
    for (const key of queueLocaleKeys){
      const occurrences = localeSource.match(new RegExp(`"${key}"`, "g")) || [];
      assert(occurrences.length === 1, `${localePath} must define ${key} exactly once`);
    }
  }
  console.log("[OK] sharing-queue-ui-check passed");
}

run().catch((error) => {
  console.error("[FAIL] sharing-queue-ui-check", error);
  process.exitCode = 1;
});
