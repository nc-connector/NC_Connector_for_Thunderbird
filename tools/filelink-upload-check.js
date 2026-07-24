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
  loadScript("modules/fileLinkDav.js", context);
  loadScript("modules/fileLinkUploadProgress.js", context);
  loadScript("modules/fileLinkBulkUpload.js", context);
  loadScript("modules/fileLinkUpload.js", context);
  loadScript("modules/fileLinkShare.js", context);
  return context;
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
  const context = createContext();
  const policy = context.NCFileLinkUploadPolicy;
  const dav = context.NCFileLinkDav;
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

  assert(dav.AUTO_MKCOL_HEADER === "X-NC-WebDAV-AutoMkcol", "NC32 AutoMkcol header spelling must match the server API");
  assert(dav.parseRetryAfter("12", 0) === 12000, "Retry-After seconds must be parsed");
  assert(dav.parseRetryAfter("999", 0) === 30000, "Retry-After must be capped at 30 seconds");

  const manifest = readJson("manifest.json");
  const backgroundScripts = manifest.background.scripts;
  const requiredOrder = [
    "vendor/spark-md5.min.js",
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js",
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
  const sharingSource = readText("modules/ncSharing.js");
  const routerSource = readText("modules/bgRouter.js");
  const uploadSource = readText("modules/fileLinkUpload.js");
  assert(wizardSource.includes("browser.runtime.connect({ name: 'nc-filelink-upload' })"), "Wizard must hand FileLink work to the background");
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
    !wizardSource.includes("NCFileLinkDav.probePath"),
    "Wizard must not perform DAV network access directly"
  );
  assert(
    routerSource.includes('if (msg.type === "sharing:checkFolderExists")'),
    "Background router must own the wizard folder collision preflight"
  );
  assert(
    sharingSource.includes("async function checkFileLinkFolderExists(request)")
      && sharingSource.includes("NCFileLinkDav.probePath({"),
    "Manual folder collision preflight must reuse the central DAV probe"
  );
  assert(!sharingSource.includes("publicUpload\", \"true"), "Share creation must not add a second permissions mode");
  assert(uploadSource.includes("NCFileLinkUploadPolicy.MAX_PARALLEL_REQUESTS"), "Transfer pool must use the shared worker limit");

  console.log("[OK] filelink-upload-check passed");
}

run().catch((error) => {
  console.error("[FAIL] filelink-upload-check", error);
  process.exitCode = 1;
});
