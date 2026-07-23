"use strict";

const { assert, loadScript } = require("./review-check-utils");
const {
  createFakeClock,
  createClockDate,
  createUploadContext
} = require("./filelink-test-harness");

function progressFile(index, size = 10){
  return Object.freeze({
    internalId: `file-${index}`,
    itemId: `item-${index}`,
    fileName: `file-${index}.bin`,
    displayPath: `file-${index}.bin`,
    size
  });
}

function runProgressChecks(){
  const clock = createFakeClock(100000);
  const statuses = [];
  const logs = [];
  const context = createUploadContext({
    Date: createClockDate(clock),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  loadScript("modules/fileLinkUploadProgress.js", context);

  const files = Array.from({ length: 200 }, (_, index) => progressFile(index));
  const progress = context.NCFileLinkUploadProgress.create({
    files,
    onStatus: (event) => statuses.push(event),
    log: (...args) => logs.push(args)
  });
  assert(statuses.length === 1 && statuses[0].phase === "summary", "Progress must start with one summary");
  assert(logs.length === 1, "The initial summary may write one progress log");

  for (const file of files){
    progress.setLoaded(file, file.size);
    progress.complete(file);
    progress.reportItem({
      phase: "done",
      itemId: file.itemId,
      fileName: file.fileName,
      displayPath: file.displayPath
    });
  }
  assert(statuses.length === 1, "A same-tick file burst must wait for the UI interval");
  assert(clock.pendingCount() === 1, "A progress burst must use one pending UI timer");

  clock.advance(context.NCFileLinkUploadProgress.UI_INTERVAL_MS);
  assert(statuses.length === 3, "A progress burst must emit one item batch and one summary");
  assert(statuses[1].phase === "items", "Item states must be sent as one batch");
  assert(statuses[1].items.length === files.length, "The item batch must include every changed row");
  assert(
    statuses[2].completedFiles === files.length
      && statuses[2].loadedBytes === statuses[2].totalBytes,
    "The final summary must report every file and byte as complete"
  );
  assert(logs.length === 1, "Progress logs must stay quiet inside five seconds");

  clock.advance(context.NCFileLinkUploadProgress.LOG_INTERVAL_MS - 100);
  progress.reportItem({
    phase: "progress",
    itemId: files[0].itemId,
    percent: 100
  });
  assert(logs.length === 2, "The next progress log may appear after five seconds");

  progress.reportItem({
    phase: "done",
    itemId: files[1].itemId
  });
  assert(clock.pendingCount() === 1, "A second same-tick item update must remain queued");
  progress.stop();
  assert(clock.pendingCount() === 0, "Stopping progress must clear its UI timer");
  assert(statuses.at(-2).phase === "items", "Stopping progress must flush pending item states");
  assert(statuses.at(-1).phase === "summary", "Stopping progress must finish with a summary");

  const folderEvents = [];
  loadScript("modules/fileLinkUploadPolicy.js", context);
  loadScript("modules/fileLinkDav.js", context);
  loadScript("modules/fileLinkUpload.js", context);
  const folders = context.NCFileLinkUpload.createFolderStatusReporter(
    (event) => folderEvents.push(event),
    1000
  );
  folders.set(0, true);
  for (let current = 1; current <= 1000; current++){
    folders.set(current);
  }
  assert(folderEvents.length === 1, "A same-tick folder burst must wait for the UI interval");
  assert(clock.pendingCount() === 1, "Folder progress must use one pending UI timer");
  clock.advance(100);
  assert(folderEvents.length === 2, "A folder burst must emit one aggregated update");
  assert(folderEvents[1].current === 1000, "The aggregated folder event must report the latest value");
  folders.stop();
  assert(clock.pendingCount() === 0, "Stopping folder progress must leave no timer");
}

module.exports = {
  runProgressChecks
};
