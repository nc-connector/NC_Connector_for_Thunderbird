"use strict";

const { assert } = require("./review-check-utils");
const {
  createUploadContext,
  createFakeClock,
  loadUploadModules,
  expectFailure,
  flushMicrotasks
} = require("./filelink-test-harness");

function successResponse(data){
  return {
    ok: true,
    status: 200,
    raw: "",
    data: {
      ocs: {
        meta: { status: "ok", statuscode: 100 },
        data
      }
    }
  };
}

function unclearResponse(){
  return {
    ok: false,
    status: 503,
    raw: "gateway",
    data: null
  };
}

function shareRecord(path, suffix = ""){
  return {
    id: `42${suffix}`,
    token: `token${suffix}`,
    url: `https://cloud.example.test/s/token${suffix}`,
    path,
    share_type: 3
  };
}

function createShareHarness(handler){
  const requests = [];
  const context = createUploadContext();
  loadUploadModules(context, ["modules/ocs.js"]);
  context.NCOcs.ocsRequest = async (request) => {
    requests.push(request);
    return handler(request, requests.length);
  };
  loadUploadModules(context, [
    "modules/fileLinkUploadPolicy.js",
    "modules/fileLinkDav.js",
    "modules/fileLinkShare.js"
  ]);
  return { context, requests };
}

function shareOptions(authHeader = "Basic account-a", changes = {}){
  return {
    baseUrl: "https://cloud.example.test",
    relativeFolder: "NC Connector/Share",
    authHeader,
    permissionMask: 1,
    password: "secret",
    label: "Share",
    ...changes
  };
}

async function checkOcsTimeout(){
  const clock = createFakeClock(0);
  const context = createUploadContext({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: async (_url, options) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })
    })
  });
  loadUploadModules(context, ["modules/ocs.js"]);
  const pending = context.NCOcs.ocsRequest({
    url: "https://cloud.example.test/ocs/v2.php/cloud/capabilities?format=json",
    timeoutMs: 100
  });
  await flushMicrotasks();
  clock.advance(100);
  const failure = await expectFailure(
    () => pending,
    "An OCS response body must not wait without a bound"
  );
  assert(failure.name === "TimeoutError", "OCS timeout must retain its timeout type");
}

async function checkShareRecovery(){
  await checkOcsTimeout();
  const direct = createShareHarness((request) => {
    assert(request.method === "POST", "A normal share create must use one POST");
    assert(!request.body.has("publicUpload"), "Share create must not send an extra permissions mode");
    return successResponse(shareRecord("/NC Connector/Share"));
  });
  const created = await direct.context.NCFileLinkShare.create(shareOptions());
  assert(created.id === "42", "A successful share response must return its share data");
  assert(direct.requests.length === 1, "A successful share create must use one request");

  let ambiguousStep = 0;
  const recovered = createShareHarness((request) => {
    ambiguousStep++;
    if (ambiguousStep === 1){
      assert(request.method === "POST", "Ambiguous recovery must start with POST");
      return unclearResponse();
    }
    assert(request.method === "GET", "Ambiguous recovery must query the exact path");
    return successResponse([shareRecord("/NC Connector/Share", "-recovered")]);
  });
  const recoveredShare = await recovered.context.NCFileLinkShare.create(shareOptions());
  assert(recoveredShare.id === "42-recovered", "Exact lookup must recover the created share");
  assert(recovered.requests.length === 2, "Recovered share creation must not repeat POST");

  let retryStep = 0;
  const knownEmpty = createShareHarness((request) => {
    retryStep++;
    if (retryStep === 1){
      return unclearResponse();
    }
    if (retryStep === 2){
      assert(request.method === "GET", "The first unclear POST must be followed by GET");
      return successResponse([]);
    }
    assert(request.method === "POST", "A known empty lookup may permit one more POST");
    return successResponse(shareRecord("/NC Connector/Share", "-second"));
  });
  const secondCreate = await knownEmpty.context.NCFileLinkShare.create(shareOptions());
  assert(secondCreate.id === "42-second", "The bounded second POST may return the share");
  assert(knownEmpty.requests.length === 3, "Known empty recovery must stop after the second POST");

  const explicitFailure = createShareHarness(() => ({
    ok: false,
    status: 503,
    raw: "",
    data: {
      ocs: {
        meta: { status: "failure", statuscode: 403, message: "Denied" },
        data: null
      }
    }
  }));
  const denied = await expectFailure(
    () => explicitFailure.context.NCFileLinkShare.create(shareOptions()),
    "An explicit OCS failure must stop share creation"
  );
  assert(denied.status === 503, "Explicit OCS failure must retain HTTP status");
  assert(explicitFailure.requests.length === 1, "Explicit OCS failure must not trigger lookup or replay");

  const accountCalls = [];
  let accountAUnclear = true;
  const isolated = createShareHarness((request) => {
    const auth = request.headers.Authorization;
    accountCalls.push(`${request.method}:${auth}`);
    if (auth === "Basic account-b"){
      return successResponse(shareRecord("/NC Connector/Share", "-b"));
    }
    if (request.method === "POST" && accountAUnclear){
      accountAUnclear = false;
      return unclearResponse();
    }
    if (request.method === "GET"){
      if (accountCalls.length === 2){
        return unclearResponse();
      }
      return successResponse([shareRecord("/NC Connector/Share", "-a")]);
    }
    throw new Error("Unexpected account A request");
  });
  await expectFailure(
    () => isolated.context.NCFileLinkShare.create(shareOptions("Basic account-a")),
    "Unknown account A state must fail closed"
  );
  const accountBShare = await isolated.context.NCFileLinkShare.create(
    shareOptions("Basic account-b")
  );
  assert(accountBShare.id === "42-b", "Account B must create its own share");
  assert(
    accountCalls[2] === "POST:Basic account-b",
    "Account A recovery state must not add a lookup for account B"
  );

  await expectFailure(
    () => isolated.context.NCFileLinkShare.create(
      shareOptions("Basic account-a", { password: "changed" })
    ),
    "Changed settings must not claim an earlier unclear share"
  );
  const accountAShare = await isolated.context.NCFileLinkShare.create(
    shareOptions("Basic account-a")
  );
  assert(accountAShare.id === "42-a", "Matching account A settings may recover its share");
  assert(
    accountCalls.every((entry) => entry.endsWith("Basic account-a") || entry.endsWith("Basic account-b")),
    "All recovery requests must stay inside their account"
  );

  let releaseSharedCreate;
  const sharedCreate = createShareHarness(() => new Promise((resolve) => {
    releaseSharedCreate = resolve;
  }));
  const firstController = new AbortController();
  const secondController = new AbortController();
  const firstCaller = sharedCreate.context.NCFileLinkShare.create(
    shareOptions("Basic shared", { signal: firstController.signal })
  );
  const secondCaller = sharedCreate.context.NCFileLinkShare.create(
    shareOptions("Basic shared", { signal: secondController.signal })
  );
  await flushMicrotasks(20);
  for (let index = 0; index < 4 && sharedCreate.requests.length === 0; index++){
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert(sharedCreate.requests.length === 1, "Equal concurrent share creates must use one POST");
  const conflictingCaller = await expectFailure(
    () => sharedCreate.context.NCFileLinkShare.create(
      shareOptions("Basic shared", { password: "different" })
    ),
    "Different settings must not join an active share create"
  );
  assert(
    conflictingCaller.ncUserMessage === "sharing_status_error",
    "Conflicting share settings must use the localized upload error"
  );
  firstController.abort();
  const firstAbort = await expectFailure(
    () => firstCaller,
    "An aborted share-create caller must stop waiting"
  );
  assert(firstAbort.name === "AbortError", "Caller cancellation must stay an AbortError");
  releaseSharedCreate(successResponse(shareRecord("/NC Connector/Share", "-shared")));
  const sharedResult = await secondCaller;
  assert(sharedResult.id === "42-shared", "A remaining caller must receive the shared result");
  assert(sharedCreate.requests.length === 1, "One caller abort must not repeat the POST");
}

module.exports = {
  runShareProtocolChecks: checkShareRecovery
};
