"use strict";

const { assert } = require("./review-check-utils");
const {
  createUploadContext,
  loadUploadModules
} = require("./filelink-test-harness");

const MIB = 1024 * 1024;

function plannedFile(index, size, relativeDir = ""){
  return Object.freeze({
    itemId: `item-${index}`,
    sourceFile: new Blob([]),
    fileName: `file-${index}.bin`,
    displayPath: `${relativeDir ? `${relativeDir}/` : ""}file-${index}.bin`,
    relativeDir,
    size,
    lastModified: 1700000000000 + index,
    contentType: "application/octet-stream"
  });
}

function expectSizeFailure(callback, label){
  let failure = null;
  try{
    callback();
  }catch(error){
    failure = error;
  }
  assert(failure?.name === "RangeError", `${label} must raise RangeError`);
  assert(failure.ncUserMessage === "sharing_status_error", `${label} must carry a localized user message`);
}

function run(){
  const context = createUploadContext();
  loadUploadModules(context, ["modules/fileLinkUploadPolicy.js"]);
  const policy = context.NCFileLinkUploadPolicy;

  assert(policy.DIRECT_UPLOAD_LIMIT_BYTES === 20 * MIB, "Direct limit must be 20 MiB");
  assert(policy.BULK_CANDIDATE_LIMIT_BYTES === 8 * MIB, "Bulk candidate limit must be 8 MiB");
  assert(policy.BULK_BATCH_LIMIT_BYTES === 20 * MIB, "Bulk batch byte limit must be 20 MiB");
  assert(policy.BULK_BATCH_FILE_LIMIT === 100, "Bulk batch file limit must be 100");
  assert(policy.BULK_MINIMUM_FILE_COUNT === 20, "Bulk planning must start at twenty files");
  assert(policy.MAX_PARALLEL_REQUESTS === 3, "Transfer worker limit must be three");
  assert(policy.MAX_ATTEMPTS === 3, "Replay-safe requests must stop after three attempts");

  assert(policy.getChunkRequestCount(20 * MIB) === 1, "Exactly 20 MiB must use Direct PUT");
  assert(
    policy.getChunkRequestCount(20 * MIB + 1) === 4,
    "A file above 20 MiB must use a chunk folder, two chunks, and MOVE"
  );
  assert(
    policy.getChunkRequestCount(policy.MAX_FILE_SIZE_BYTES) === policy.MAX_CHUNK_COUNT + 2,
    "The largest accepted file must stay within the chunk-count limit"
  );
  expectSizeFailure(() => policy.getChunkSize(-1), "Negative size");
  expectSizeFailure(() => policy.getChunkSize(Number.NaN), "NaN size");
  expectSizeFailure(() => policy.getChunkSize(Number.POSITIVE_INFINITY), "Infinite size");
  expectSizeFailure(
    () => policy.getChunkSize(policy.MAX_FILE_SIZE_BYTES + 1),
    "Size above the chunk limit"
  );

  assert(!policy.isBulkCandidate(-1), "Negative sizes must not enter a bulk batch");
  assert(policy.isBulkCandidate(8 * MIB), "Exactly 8 MiB must remain a bulk candidate");
  assert(!policy.isBulkCandidate(8 * MIB + 1), "A file above 8 MiB must not use bulk");
  assert(!policy.isBulkCandidate(Number.NaN), "NaN must not enter a bulk batch");

  assert(!policy.shouldUseBulkUpload({
    supported: true,
    candidateFileCount: 19,
    directRequestCount: 100,
    bulkRequestCount: 1
  }), "Nineteen candidates must stay on Direct PUT");
  assert(policy.shouldUseBulkUpload({
    supported: true,
    candidateFileCount: 20,
    directRequestCount: 100,
    bulkRequestCount: 80
  }), "Exactly twenty percent request savings must enable bulk");
  assert(!policy.shouldUseBulkUpload({
    supported: true,
    candidateFileCount: 20,
    directRequestCount: 100,
    bulkRequestCount: 81
  }), "Savings below twenty percent must keep Direct PUT");
  assert(!policy.shouldUseBulkUpload({
    supported: true,
    candidateFileCount: 20,
    directRequestCount: 100,
    bulkRequestCount: 0
  }), "An empty bulk request plan must not enable bulk");

  const byteLimitedBatches = policy.buildBulkBatches([
    plannedFile(1, 8 * MIB),
    plannedFile(2, 8 * MIB),
    plannedFile(3, 4 * MIB),
    plannedFile(4, 1)
  ]);
  assert(byteLimitedBatches.length === 2, "A byte overflow must start a second bulk batch");
  assert(byteLimitedBatches[0].totalBytes === 20 * MIB, "Exactly 20 MiB must fit in one bulk batch");
  assert(byteLimitedBatches[1].totalBytes === 1, "Overflow bytes must remain in the next batch");

  const countLimitedBatches = policy.buildBulkBatches(
    Array.from({ length: 101 }, (_, index) => plannedFile(index + 10, 1))
  );
  assert(countLimitedBatches.length === 2, "A 101st file must start a second bulk batch");
  assert(countLimitedBatches[0].files.length === 100, "The first batch must stop at one hundred files");
  assert(countLimitedBatches[1].files.length === 1, "The last file must remain in the second batch");

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
  assert(singlePlan.files[0] !== immutableInput, "Planner must create its own item record");
  assert(!Object.prototype.hasOwnProperty.call(immutableInput, "internalId"), "Planner must not mutate source records");
  assert(singlePlan.directories.length === 0, "One Direct path must use server-side parent creation");

  const sharedPlan = policy.buildPlan({
    files: [
      plannedFile(120, 1, "one/two"),
      plannedFile(121, 1, "one/two")
    ],
    bulkSupported: false,
    fixedRequestCount: 2
  });
  assert(
    JSON.stringify(sharedPlan.directories) === JSON.stringify(["one", "one/two"]),
    "Shared Direct parents must be created once"
  );

  const chunkPlan = policy.buildPlan({
    files: [plannedFile(122, 20 * MIB + 1, "large/deep")],
    bulkSupported: false,
    fixedRequestCount: 2
  });
  assert(
    JSON.stringify(chunkPlan.directories) === JSON.stringify(["large", "large/deep"]),
    "Chunked uploads need explicit parent folders"
  );

  const smallFiles = Array.from({ length: 20 }, (_, index) =>
    plannedFile(index + 200, 1024, "bulk")
  );
  const bulkPlan = policy.buildPlan({
    files: smallFiles,
    bulkSupported: true,
    fixedRequestCount: 2
  });
  assert(bulkPlan.useBulkUpload, "Twenty small files with request savings must use DAV bulk");
  assert(bulkPlan.bulkFiles.length === 20, "All eligible files must enter bulk");
  assert(bulkPlan.directFiles.length === 0, "Bulk files must not also remain in Direct");
  assert(bulkPlan.directories.length === 1, "Bulk destinations need their shared parent once");

  const noCapabilityPlan = policy.buildPlan({
    files: smallFiles,
    bulkSupported: false,
    fixedRequestCount: 2
  });
  assert(!noCapabilityPlan.useBulkUpload, "Missing DAV capability must keep Direct PUT");
  assert(noCapabilityPlan.directFiles.length === 20, "Direct PUT must remain planned without bulk");

  console.log("[OK] filelink-policy-check passed");
}

try{
  run();
}catch(error){
  console.error("[FAIL] filelink-policy-check", error);
  process.exitCode = 1;
}
