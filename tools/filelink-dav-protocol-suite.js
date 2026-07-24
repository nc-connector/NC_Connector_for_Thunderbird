"use strict";

const { assert } = require("./review-check-utils");
const {
  createUploadContext,
  createFakeClock,
  loadUploadModules,
  makeDavResponse,
  expectFailure,
  flushMicrotasks
} = require("./filelink-test-harness");

function immediateTimers(){
  return {
    setTimeout: (callback) => {
      callback();
      return 1;
    },
    clearTimeout: () => {}
  };
}

async function checkRetryRules(){
  const context = createUploadContext(immediateTimers());
  loadUploadModules(context, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js"
  ]);
  const dav = context.NCFileLinkDav;

  assert(
    JSON.stringify(context.NCFileLinkUploadPolicy.RETRY_STATUS_CODES)
      === JSON.stringify([408, 423, 429, 502, 503, 504]),
    "Retry status list must match the upload rules"
  );
  assert(dav.parseRetryAfter("12", 0) === 12000, "Retry-After seconds must be parsed");
  assert(dav.parseRetryAfter("999", 0) === 30000, "Retry-After seconds must stop at thirty seconds");
  assert(
    dav.parseRetryAfter("Thu, 01 Jan 1970 00:00:12 GMT", 2000) === 10000,
    "Retry-After HTTP dates must be relative to the supplied clock"
  );
  assert(dav.parseRetryAfter("invalid", 0) === null, "Invalid Retry-After values must be ignored");

  let attempts = 0;
  let closedResponses = 0;
  const retryLog = [];
  const recovered = await dav.fetchWithRetry({
    operation: "retry_check",
    timeoutMs: 0,
    log: (...args) => retryLog.push(args),
    request: async () => {
      attempts++;
      if (attempts === 1){
        return makeDavResponse(503, {
          headers: { "Retry-After": "0" },
          onCancel: () => closedResponses++
        });
      }
      if (attempts === 2){
        return makeDavResponse(429, {
          headers: { "Retry-After": "0" },
          onCancel: () => closedResponses++
        });
      }
      return makeDavResponse(201);
    }
  });
  assert(recovered.status === 201, "A replay-safe request must return its later success");
  assert(attempts === 3, "A replay-safe request must use at most three attempts");
  assert(closedResponses === 2, "Retry responses must be closed before replay");
  assert(retryLog.length === 2, "Each replay must emit one retry log");

  attempts = 0;
  const nonRetry = await dav.fetchWithRetry({
    operation: "non_retry_check",
    timeoutMs: 0,
    request: async () => {
      attempts++;
      return makeDavResponse(500);
    }
  });
  assert(nonRetry.status === 500, "A non-retry status must return to its caller");
  assert(attempts === 1, "A non-retry status must not be replayed");

  attempts = 0;
  const exhausted = await dav.fetchWithRetry({
    operation: "retry_limit_check",
    timeoutMs: 0,
    request: async () => {
      attempts++;
      return makeDavResponse(503, { headers: { "Retry-After": "0" } });
    }
  });
  assert(exhausted.status === 503, "The final retry response must return to its caller");
  assert(attempts === 3, "Retry status handling must stop after three attempts");

  attempts = 0;
  const transportRecovered = await dav.fetchWithRetry({
    operation: "transport_check",
    timeoutMs: 0,
    request: async () => {
      attempts++;
      if (attempts < 3){
        throw new Error("temporary transport failure");
      }
      return makeDavResponse(200);
    }
  });
  assert(transportRecovered.status === 200, "A replay-safe transport failure may recover");
  assert(attempts === 3, "Transport recovery must use the shared attempt limit");

  attempts = 0;
  const bodyRecovered = await dav.fetchWithRetry({
    operation: "body_transport_check",
    timeoutMs: 0,
    request: async () => {
      attempts++;
      return makeDavResponse(207);
    },
    consume: async (response) => {
      if (attempts === 1){
        throw new Error("response body interrupted");
      }
      return { status: response.status, headers: response.headers };
    }
  });
  assert(bodyRecovered.status === 207, "A replay-safe body-read failure may recover");
  assert(attempts === 2, "Body-read transport recovery must repeat the complete request");

  attempts = 0;
  const transportFailure = await expectFailure(() => dav.fetchWithRetry({
    operation: "no_transport_retry",
    timeoutMs: 0,
    retryTransport: false,
    request: async () => {
      attempts++;
      throw new Error("transport stopped");
    }
  }), "A disabled transport retry must fail");
  assert(attempts === 1, "Disabled transport retry must issue one request");
  assert(transportFailure.cause?.message === "transport stopped", "Transport detail must remain available for logs");

  const quotaError = dav.createUploadError(507, "quota");
  assert(quotaError.status === 507, "Quota errors must retain HTTP 507");
  assert(
    quotaError.ncUserMessage === "sharing_insufficient_storage",
    "HTTP 507 must use the storage-specific user text"
  );
}

async function checkRequestTimeoutsAndAbort(){
  const clock = createFakeClock(0);
  const context = createUploadContext({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  loadUploadModules(context, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js"
  ]);
  const dav = context.NCFileLinkDav;

  const headerRequest = dav.fetchWithTimeout({
    timeoutMs: 100,
    request: (signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  });
  await flushMicrotasks();
  clock.advance(100);
  const headerTimeout = await expectFailure(
    () => headerRequest,
    "A control request without headers must time out"
  );
  assert(headerTimeout.name === "TimeoutError", "Header timeout must retain its timeout type");

  let bodySignal = null;
  const response = await dav.fetchWithTimeout({
    timeoutMs: 100,
    request: async (signal) => {
      bodySignal = signal;
      return {
        status: 207,
        text: () => new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        }),
        body: { cancel: async () => {} }
      };
    }
  });
  const bodyRead = dav.readResponseText(response);
  await flushMicrotasks();
  clock.advance(100);
  const bodyTimeout = await expectFailure(
    () => bodyRead,
    "A DAV response body must remain inside the request timeout"
  );
  assert(bodySignal.aborted, "Body timeout must abort the actual fetch signal");
  assert(bodyTimeout.name === "TimeoutError", "Body timeout must not look like user cancellation");

  let activeXhr = null;
  class FakeXMLHttpRequest{
    constructor(){
      activeXhr = this;
      this.upload = {};
      this.status = 0;
      this.statusText = "";
      this.responseText = "";
    }

    open(){}
    setRequestHeader(){}
    getResponseHeader(){ return ""; }
    send(){}
    abort(){
      this.aborted = true;
      this.onabort?.();
    }
  }
  const xhrContext = createUploadContext({
    XMLHttpRequest: FakeXMLHttpRequest
  });
  loadUploadModules(xhrContext, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js"
  ]);
  const controller = new AbortController();
  const xhrRequest = xhrContext.NCFileLinkDav.xhrWithRetry({
    method: "PUT",
    url: "https://cloud.example.test/files/share/file.bin",
    headers: { "Authorization": "Basic test" },
    createBody: async () => new Blob(["data"]),
    signal: controller.signal,
    operation: "xhr_abort"
  });
  await flushMicrotasks();
  controller.abort();
  const xhrFailure = await expectFailure(
    () => xhrRequest,
    "Canceling a transfer must abort its active XHR"
  );
  assert(activeXhr?.aborted, "The upload signal must call XMLHttpRequest.abort()");
  assert(xhrFailure.name === "AbortError", "XHR cancellation must stay an AbortError");
}

async function checkMoveRecovery(){
  const context = createUploadContext();
  loadUploadModules(context, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js",
    "modules/fileLinkUpload.js"
  ]);
  const upload = context.NCFileLinkUpload;
  const baseDav = context.NCFileLinkDav;
  const moveRequests = [];

  context.fetch = async (url, options) => {
    moveRequests.push({ url, options });
    throw new Error("connection closed");
  };
  context.NCFileLinkDav = {
    ...baseDav,
    probePath: async () => ({
      exists: true,
      collection: false,
      contentLength: 41
    })
  };
  await upload.moveChunkIntoPlace({
    uploadFolderUrl: "https://cloud.example.test/uploads/id",
    targetUrl: "https://cloud.example.test/files/share/file.bin",
    totalSize: 41,
    lastModified: 1700000000000,
    authHeader: "Basic test"
  });
  assert(moveRequests.length === 1, "Chunk MOVE must not be sent twice after a transport failure");
  assert(moveRequests[0].options.method === "MOVE", "Chunk completion must use MOVE");

  context.fetch = async () => makeDavResponse(503, { body: "gateway" });
  await upload.moveChunkIntoPlace({
    uploadFolderUrl: "https://cloud.example.test/uploads/id",
    targetUrl: "https://cloud.example.test/files/share/file.bin",
    totalSize: 41,
    authHeader: "Basic test"
  });

  context.NCFileLinkDav = {
    ...baseDav,
    probePath: async () => ({
      exists: true,
      collection: false,
      contentLength: 40
    })
  };
  const mismatch = await expectFailure(() => upload.moveChunkIntoPlace({
    uploadFolderUrl: "https://cloud.example.test/uploads/id",
    targetUrl: "https://cloud.example.test/files/share/file.bin",
    totalSize: 41,
    authHeader: "Basic test"
  }), "A mismatched target size must not recover an unclear MOVE");
  assert(mismatch.status === 503, "Unrecovered MOVE must retain its HTTP status");

  let rootProbeCalls = 0;
  context.fetch = async (_url, options) => {
    assert(options.headers.Overwrite === "F", "Root reservation MOVE must reject overwrites");
    return makeDavResponse(412);
  };
  context.NCFileLinkDav = {
    ...baseDav,
    probePath: async () => {
      rootProbeCalls++;
      return { exists: false, collection: false, contentLength: null };
    }
  };
  const collision = await upload.moveRootReservation({
    reservationUrl: "https://cloud.example.test/files/_stage",
    targetUrl: "https://cloud.example.test/files/share",
    authHeader: "Basic test"
  });
  assert(collision === false, "HTTP 412 must report a root collision");
  assert(rootProbeCalls === 0, "HTTP 412 needs no follow-up probe");

  const probeQueue = [
    { exists: false, collection: false, contentLength: null },
    { exists: true, collection: true, contentLength: null }
  ];
  context.fetch = async () => {
    throw new Error("connection closed");
  };
  context.NCFileLinkDav = {
    ...baseDav,
    probePath: async () => probeQueue.shift()
  };
  const moved = await upload.moveRootReservation({
    reservationUrl: "https://cloud.example.test/files/_stage",
    targetUrl: "https://cloud.example.test/files/share",
    authHeader: "Basic test"
  });
  assert(moved === true, "Missing source plus collection target must recover root MOVE");

  const collisionProbeQueue = [
    { exists: true, collection: true, contentLength: null },
    { exists: true, collection: true, contentLength: null }
  ];
  context.fetch = async () => makeDavResponse(503);
  context.NCFileLinkDav = {
    ...baseDav,
    probePath: async () => collisionProbeQueue.shift()
  };
  const resolvedCollision = await upload.moveRootReservation({
    reservationUrl: "https://cloud.example.test/files/_stage",
    targetUrl: "https://cloud.example.test/files/share",
    authHeader: "Basic test"
  });
  assert(resolvedCollision === false, "Present source and target must resolve as collision");
}

async function checkConcurrentRootReservations(){
  const reservationIds = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002"
  ];
  const context = createUploadContext({
    crypto: {
      randomUUID: () => reservationIds.shift()
    }
  });
  loadUploadModules(context, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js",
    "modules/fileLinkUpload.js"
  ]);
  const collections = new Set();
  const requests = [];
  const collectionBody = "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>";
  context.fetch = async (url, options) => {
    const request = {
      url,
      method: options.method,
      destination: options.headers?.Destination || "",
      status: 0
    };
    requests.push(request);
    if (options.method === "MKCOL"){
      request.status = collections.has(url) ? 405 : 201;
      if (request.status === 201){
        collections.add(url);
      }
      return makeDavResponse(request.status);
    }
    if (options.method === "MOVE"){
      assert(options.headers.Overwrite === "F", "Concurrent root MOVE must reject overwrites");
      await Promise.resolve();
      if (collections.has(request.destination)){
        request.status = 412;
        return makeDavResponse(412);
      }
      assert(collections.has(url), "Concurrent root MOVE source must exist");
      collections.delete(url);
      collections.add(request.destination);
      request.status = 201;
      return makeDavResponse(201);
    }
    if (options.method === "PROPFIND"){
      request.status = collections.has(url) ? 207 : 404;
      return makeDavResponse(request.status, {
        body: request.status === 207 ? collectionBody : ""
      });
    }
    if (options.method === "DELETE"){
      request.status = collections.delete(url) ? 204 : 404;
      return makeDavResponse(request.status);
    }
    throw new Error(`Unexpected concurrent reservation request: ${options.method} ${url}`);
  };

  const candidate = {
    shareName: "Share",
    folderInfo: {
      relativeBase: "NC Connector",
      relativeFolder: "NC Connector/20260723_Share",
      folderName: "20260723_Share"
    }
  };
  const reserve = () => context.NCFileLinkUpload.reserveRoot({
    davRoot: "https://cloud.example.test/remote.php/dav/files/user",
    candidates: [candidate],
    authHeader: "Basic test",
    collisionMessage: "collision"
  });
  const results = await Promise.allSettled([reserve(), reserve()]);
  assert(
    results.filter((result) => result.status === "fulfilled").length === 1
      && results.filter((result) => result.status === "rejected").length === 1,
    "Concurrent reservations for one target must produce one owner and one collision"
  );
  assert(
    results.find((result) => result.status === "rejected")?.reason?.message === "collision",
    "The losing regular share reservation must report the configured collision"
  );

  const moves = requests.filter((request) => request.method === "MOVE");
  const reservationSources = moves.map((request) => request.url);
  assert(
    moves.length === 2 && new Set(reservationSources).size === 2,
    "Concurrent regular shares must use separate server-side reservations"
  );
  assert(
    new Set(moves.map((request) => request.destination)).size === 1,
    "Concurrent regular shares must compete for the same requested target"
  );
  const winningMove = moves.find((request) => request.status === 201);
  const losingMove = moves.find((request) => request.status === 412);
  assert(winningMove && losingMove, "The server must accept one MOVE and reject one with HTTP 412");

  const deletes = requests.filter((request) => request.method === "DELETE");
  assert(
    deletes.length === 1 && deletes[0].url === losingMove.url,
    "Collision cleanup must delete only the losing reservation"
  );
  assert(
    collections.has(winningMove.destination)
      && !collections.has(winningMove.url)
      && !collections.has(losingMove.url),
    "Collision cleanup must retain the winning target and remove both reservation paths"
  );
}

async function checkDirectAndChunkRequests(){
  const context = createUploadContext();
  loadUploadModules(context, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js",
    "modules/fileLinkUpload.js"
  ]);
  const upload = context.NCFileLinkUpload;
  const dav = context.NCFileLinkDav;
  const xhrCalls = [];
  const collectionCalls = [];
  let cleanupCalls = 0;
  const moveCalls = [];
  context.fetch = async (url, options) => {
    moveCalls.push({ url, options });
    return makeDavResponse(201);
  };
  context.NCFileLinkDav = {
    ...dav,
    xhrWithRetry: async (options) => {
      const body = await options.createBody(1);
      xhrCalls.push({ options, body });
      options.onProgress?.({ loaded: Number(body?.size) || 0, total: Number(body?.size) || 0 });
      return { status: 201 };
    },
    createCollection: async (options) => {
      collectionCalls.push(options);
      return true;
    },
    deleteBestEffort: async () => {
      cleanupCalls++;
      return true;
    }
  };
  const progress = {
    reportItem: () => {},
    setLoaded: () => {},
    reset: () => {},
    complete: () => {}
  };

  const directFile = {
    itemId: "direct",
    sourceFile: new Blob(["direct body"], { type: "text/plain" }),
    fileName: "direct file.txt",
    displayPath: "direct file.txt",
    relativeDir: "Sub Folder",
    size: 11,
    contentType: "text/plain"
  };
  await upload.uploadDirect({
    file: directFile,
    davRoot: "https://cloud.example.test/remote.php/dav/files/user",
    shareRoot: "NC Connector/Share",
    authHeader: "Basic direct",
    progress
  });
  assert(xhrCalls.length === 1, "Direct upload must issue one XHR PUT");
  assert(xhrCalls[0].options.method === "PUT", "Direct transfer must use PUT");
  assert(
    xhrCalls[0].options.url.endsWith("/NC%20Connector/Share/Sub%20Folder/direct%20file.txt"),
    "Direct transfer must encode its final DAV path"
  );
  assert(
    xhrCalls[0].options.headers["X-NC-WebDAV-Auto-Mkcol"] === "1"
      && !Object.prototype.hasOwnProperty.call(xhrCalls[0].options.headers, "Destination"),
    "Direct PUT must use the Nextcloud Auto-Mkcol header without a chunk Destination"
  );
  assert(xhrCalls[0].body === directFile.sourceFile, "Direct retries must rebuild from the source Blob");

  xhrCalls.length = 0;
  const chunkRanges = [];
  const chunkSize = context.NCFileLinkUploadPolicy.DEFAULT_CHUNK_SIZE_BYTES;
  const chunkedFile = {
    itemId: "chunked",
    sourceFile: {
      slice: (start, end, type) => {
        const chunk = { start, end, size: end - start, type };
        chunkRanges.push(chunk);
        return chunk;
      }
    },
    fileName: "large.bin",
    displayPath: "large.bin",
    relativeDir: "",
    size: chunkSize + 1,
    lastModified: 1700000000000,
    contentType: "application/octet-stream"
  };
  await upload.uploadChunked({
    file: chunkedFile,
    davRoot: "https://cloud.example.test/remote.php/dav/files/user",
    uploadRoot: "https://cloud.example.test/remote.php/dav/uploads/user",
    shareRoot: "NC Connector/Share",
    authHeader: "Basic chunk",
    progress
  });
  assert(collectionCalls.length === 1, "Chunked upload must create one upload collection");
  assert(xhrCalls.length === 2, "A file one byte above the chunk size must use two chunk PUTs");
  assert(
    xhrCalls[0].options.url.endsWith("/00001")
      && xhrCalls[1].options.url.endsWith("/00002"),
    "Chunk PUT names must be sequential and zero-padded"
  );
  assert(
    xhrCalls.every(({ options }) =>
      options.headers.Destination?.endsWith("/NC%20Connector/Share/large.bin")
      && options.headers["OC-Total-Length"] === String(chunkedFile.size)
      && !Object.prototype.hasOwnProperty.call(options.headers, "X-NC-WebDAV-Auto-Mkcol")
    ),
    "Every chunk PUT must carry Destination and total length without the Direct header"
  );
  assert(
    chunkRanges[0].start === 0
      && chunkRanges[0].end === chunkSize
      && chunkRanges[1].start === chunkSize
      && chunkRanges[1].end === chunkSize + 1,
    "Chunk bodies must cover the source in order without overlap"
  );
  assert(
    moveCalls.length === 1
      && moveCalls[0].url.endsWith("/.file")
      && moveCalls[0].options.method === "MOVE"
      && moveCalls[0].options.headers.Destination.endsWith("/NC%20Connector/Share/large.bin"),
    "Chunk completion must MOVE .file to the final DAV target"
  );
  assert(cleanupCalls === 0, "Successful chunk completion must not delete its upload collection");
}

async function checkRootReservationCleanup(){
  const context = createUploadContext();
  loadUploadModules(context, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js"
  ]);
  const dav = context.NCFileLinkDav;
  const reservationUrl = "https://cloud.example.test/files/_stage";
  const targetUrl = "https://cloud.example.test/files/share";
  const collectionBody = "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>";

  const sourcePresentCalls = [];
  context.fetch = async (url, options) => {
    sourcePresentCalls.push({ url, method: options.method });
    if (options.method === "PROPFIND" && url === reservationUrl){
      return makeDavResponse(207, { body: collectionBody });
    }
    if (options.method === "DELETE" && url === reservationUrl){
      return makeDavResponse(204);
    }
    throw new Error(`Unexpected reservation-cleanup request: ${options.method} ${url}`);
  };
  const sourceResult = await dav.deleteRootReservation({
    reservationUrl,
    targetUrl,
    authHeader: "Basic cleanup"
  });
  assert(sourceResult === "reservation", "A present staging root must be deleted");
  assert(
    sourcePresentCalls.length === 2
      && sourcePresentCalls.every((request) => request.url === reservationUrl),
    "A present staging root must prevent access to a possibly foreign target"
  );

  const targetPresentCalls = [];
  context.fetch = async (url, options) => {
    targetPresentCalls.push({ url, method: options.method });
    if (options.method === "PROPFIND" && url === reservationUrl){
      return makeDavResponse(404);
    }
    if (options.method === "PROPFIND" && url === targetUrl){
      return makeDavResponse(207, { body: collectionBody });
    }
    if (options.method === "DELETE" && url === targetUrl){
      return makeDavResponse(204);
    }
    throw new Error(`Unexpected moved-root cleanup request: ${options.method} ${url}`);
  };
  const targetResult = await dav.deleteRootReservation({
    reservationUrl,
    targetUrl,
    authHeader: "Basic cleanup"
  });
  assert(targetResult === "target", "A missing staging root plus target collection must delete the moved root");
  assert(
    targetPresentCalls.length === 3
      && targetPresentCalls[2].method === "DELETE"
      && targetPresentCalls[2].url === targetUrl,
    "Moved-root cleanup must delete only the resolved target"
  );

  const absentCalls = [];
  context.fetch = async (url, options) => {
    absentCalls.push({ url, method: options.method });
    return makeDavResponse(404);
  };
  const absentResult = await dav.deleteRootReservation({
    reservationUrl,
    targetUrl,
    authHeader: "Basic cleanup"
  });
  assert(absentResult === "absent", "Missing staging and target roots must finish cleanup");
  assert(
    absentCalls.length === 2 && absentCalls.every((request) => request.method === "PROPFIND"),
    "An already absent reservation must not issue DELETE"
  );
}

async function checkBulkQuota(){
  const context = createUploadContext();
  loadUploadModules(context, [
    "vendor/spark-md5.min.js",
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js",
    "modules/fileLinkBulkUpload.js"
  ]);
  const file = {
    internalId: "bulk-1",
    sourceFile: new Blob(["abc"]),
    fileName: "a.txt",
    relativeDir: "",
    size: 3,
    lastModified: 1700000000000
  };
  const descriptor = context.NCFileLinkBulkUpload.buildMultipartDescriptor({
    batch: { files: [file] },
    shareRoot: "NC Connector/Share",
    checksums: new Map([["bulk-1", "900150983cd24fb0d6963f7d28e17f72"]]),
    boundary: "ncconnector-test"
  });
  const destinationPath = descriptor.ranges[0].destinationPath;
  const quotaFailure = await expectFailure(
    async () => context.NCFileLinkBulkUpload.parseBulkResponse(JSON.stringify({
      [destinationPath]: {
        error: true,
        status: 507,
        message: "quota"
      }
    }), descriptor),
    "A bulk part with HTTP 507 must fail"
  );
  assert(quotaFailure.ncBulkPath === destinationPath, "Bulk failure must identify its destination");
  assert(
    quotaFailure.ncUserMessage === "sharing_insufficient_storage",
    "Bulk HTTP 507 must use the storage-specific user text"
  );
}

async function checkReservationCleanupHandoff(){
  const context = createUploadContext();
  loadUploadModules(context, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js",
    "modules/fileLinkUpload.js"
  ]);
  const upload = context.NCFileLinkUpload;
  const baseDav = context.NCFileLinkDav;
  const candidate = {
    shareName: "Share",
    folderInfo: {
      relativeBase: "NC Connector",
      relativeFolder: "NC Connector/20260723_Share",
      folderName: "20260723_Share"
    }
  };
  const controller = new AbortController();
  context.fetch = async (_url, options) => {
    assert(options.method === "MOVE", "Reservation completion must use MOVE");
    controller.abort();
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  const probeQueue = [
    { exists: false, collection: false, contentLength: null },
    { exists: true, collection: true, contentLength: null }
  ];
  context.NCFileLinkDav = {
    ...baseDav,
    createCollection: async () => true,
    probePath: async () => probeQueue.shift(),
    deleteBestEffort: async () => false
  };
  const recoveredRootFailure = await expectFailure(
    () => upload.reserveRoot({
      davRoot: "https://cloud.example.test/remote.php/dav/files/user",
      candidates: [candidate],
      authHeader: "Basic test",
      signal: controller.signal
    }),
    "A moved root with failed cleanup must be handed to the outer lifecycle"
  );
  assert(
    recoveredRootFailure.ncRecoveredRootCandidate?.folderInfo?.relativeFolder
      === candidate.folderInfo.relativeFolder,
    "Failed cleanup of a recovered MOVE must retain the exact root candidate"
  );

  const stagingContext = createUploadContext();
  loadUploadModules(stagingContext, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js",
    "modules/fileLinkUpload.js"
  ]);
  const stagingUpload = stagingContext.NCFileLinkUpload;
  const stagingDav = stagingContext.NCFileLinkDav;
  stagingContext.fetch = async () => makeDavResponse(412);
  stagingContext.NCFileLinkDav = {
    ...stagingDav,
    createCollection: async () => true,
    probePath: async (options) => ({
      exists: !options.url.endsWith(candidate.folderInfo.folderName),
      collection: true,
      contentLength: null
    }),
    deleteBestEffort: async () => false
  };
  const stagingFailure = await expectFailure(
    () => stagingUpload.reserveRoot({
      davRoot: "https://cloud.example.test/remote.php/dav/files/user",
      candidates: [candidate],
      authHeader: "Basic test",
      collisionMessage: "collision"
    }),
    "A staging collection that cannot be removed must be handed to cleanup"
  );
  assert(
    stagingFailure.ncRecoveredRootCandidate?.folderInfo?.relativeFolder
      ?.startsWith("NC Connector/_ncconnector-"),
    "Failed staging cleanup must retain its unique DAV path"
  );

  const ambiguousContext = createUploadContext();
  loadUploadModules(ambiguousContext, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js",
    "modules/fileLinkUpload.js"
  ]);
  const ambiguousUpload = ambiguousContext.NCFileLinkUpload;
  const ambiguousDav = ambiguousContext.NCFileLinkDav;
  ambiguousContext.fetch = async () => {
    throw new Error("connection closed");
  };
  ambiguousContext.NCFileLinkDav = {
    ...ambiguousDav,
    createCollection: async () => true,
    probePath: async () => {
      throw new Error("probe offline");
    }
  };
  const ambiguousFailure = await expectFailure(
    () => ambiguousUpload.reserveRoot({
      davRoot: "https://cloud.example.test/remote.php/dav/files/user",
      candidates: [candidate],
      authHeader: "Basic test"
    }),
    "An unresolved root MOVE must defer both cleanup paths"
  );
  assert(
    ambiguousFailure.ncRecoveredRootCandidate?.cleanupResolution?.reservationUrl
      ?.includes("_ncconnector-")
      && ambiguousFailure.ncRecoveredRootCandidate?.cleanupResolution?.targetUrl
        ?.endsWith(candidate.folderInfo.folderName),
    "An unresolved root MOVE must retain staging and target URLs"
  );
}

async function runDavProtocolChecks(){
  await checkRetryRules();
  await checkRequestTimeoutsAndAbort();
  await checkMoveRecovery();
  await checkConcurrentRootReservations();
  await checkDirectAndChunkRequests();
  await checkRootReservationCleanup();
  await checkBulkQuota();
  await checkReservationCleanupHandoff();
}

module.exports = {
  runDavProtocolChecks
};
