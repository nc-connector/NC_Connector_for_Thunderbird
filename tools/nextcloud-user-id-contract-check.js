"use strict";

const vm = require("node:vm");
const { assert, loadScript, readText } = require("./review-check-utils");

function makeResponse(status, payload){
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(payload)
  };
}

function createCoreHarness(responses, { backgroundLogger = true, stored = {
  baseUrl: "https://cloud.example.test/nextcloud",
  user: "login@example.test",
  appPass: "app-password"
}, timers = null, clock = null, uiRuntime = false } = {}){
  const requests = [];
  const queue = responses.slice();
  const context = {
    console,
    Buffer,
    URL,
    Date: clock ? { now: () => clock.now, parse: Date.parse } : Date,
    setTimeout: timers ? timers.set : setTimeout,
    clearTimeout: timers ? timers.clear : clearTimeout,
    AbortController,
    DOMException,
    globalThis: null,
    window: null,
    browser: {
      storage: {
        local: {
          get: async () => ({ ...stored }),
          set: async (updates) => Object.assign(stored, updates),
          remove: async (keys) => { for (const key of keys) delete stored[key]; }
        }
      }
    },
    NCTalkTextUtils: {
      normalizeBaseUrl: (value) => {
        const normalized = String(value || "").trim().replace(/\/+$/, "");
        return normalized.startsWith("https://") ? normalized : "";
      },
      shortId: (value) => String(value || "").slice(0, 24)
    },
    NCOcs: {
      buildAuthHeader: (user, appPass) =>
        "Basic " + Buffer.from(`${user}:${appPass}`, "utf8").toString("base64")
    },
    NCHostPermissions: {
      requireOriginPermission: async () => true
    },
    NCLogContext: {
      isKnownUiRuntime: () => uiRuntime,
      resolveAddonLogPrefix: () => "[TEST]",
      redactSensitiveText: (value) => String(value ?? ""),
      safeConsoleError: () => {}
    },
    bgI18n: (key) => key,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const response = queue.shift();
      if (!response){
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return typeof response === "function"
        ? response({ url, options, requests })
        : response;
    }
  };
  if (backgroundLogger){
    context.L = () => {};
  }
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("modules/ocs.js", context);
  context.NCOcs.buildAuthHeader = (user, appPass) =>
    "Basic " + Buffer.from(`${user}:${appPass}`, "utf8").toString("base64");
  loadScript("modules/nccore.js", context, ";globalThis.__NCCore = NCCore;");
  return { context, requests, stored };
}

function createSharingHarness(buildDavAccountContext){
  const requests = [];
  const transferCalls = [];
  const davProbes = [];
  const credentials = {
    baseUrl: "https://cloud.example.test/nextcloud",
    user: "login@example.test",
    appPass: "app-password",
    debugEnabled: false
  };
  const context = {
    console,
    URL,
    URLSearchParams,
    AbortController,
    DOMException,
    globalThis: null,
    window: null,
    NCShareTemplateContract: undefined,
    NCCore: {
      getOpts: async () => credentials,
      getRequiredCapabilities: async () => ({
        versionMajor: 32,
        versionString: "32.0.0",
        bulkUploadSupported: false,
        capabilities: {}
      }),
      getCurrentUserId: async (options) => {
        assert(options.user === credentials.user, "UID resolution must receive the authentication login");
        return "canonical-user";
      },
      buildDavAccountContext
    },
    NCOcs: {
      buildAuthHeader: (user, appPass) =>
        "Basic " + Buffer.from(`${user}:${appPass}`, "utf8").toString("base64"),
      ocsRequest: async (request) => {
        requests.push(request);
        return {
          ok: true,
          status: 200,
          raw: "",
          data: {
            ocs: {
              meta: { status: "ok", statuscode: 100 },
              data: {
                id: "42",
                token: "share-token",
                url: "https://cloud.example.test/nextcloud/s/share-token"
              }
            }
          }
        };
      }
    },
    NCHostPermissions: {
      requireOriginPermission: async () => true
    },
    NCLogContext: {
      resolveAddonLogPrefix: () => "[TEST]",
      safeConsoleError: () => {}
    },
    NCI18n: { translate: (key) => key },
    NCI18nOverride: {
      normalizeLanguageOverride: (value) => String(value || "default"),
      tInLang: async (_lang, key) => key
    },
    NCHtmlSanitizer: {
      htmlToPlainText: (value) => String(value || ""),
      plainTextToHtml: (value) => String(value || ""),
      sanitizeShareTemplateHtml: (value) => String(value || "")
    },
    browser: {
      i18n: { getMessage: (key) => key },
      storage: {
        local: {
          get: async () => ({ sharingBasePath: "Team Shares" })
        }
      }
    },
    bgI18n: (key) => key,
    L: () => {},
    NCFileLinkUpload: {
      prepareAndUpload: async (options) => {
        transferCalls.push(options);
        const root = options.rootCandidates[0];
        await options.onRootCreated(root);
        return {
          plan: { files: [], totalBytes: 0 },
          root
        };
      }
    },
    NCFileLinkShare: {
      create: async (options) => {
        requests.push({
          url: `${options.baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares`,
          options
        });
        return {
          id: "42",
          token: "share-token",
          url: "https://cloud.example.test/nextcloud/s/share-token"
        };
      },
      clearIndeterminate: async () => true
    },
    NCNextcloudDav: {
      throwIfAborted: (signal) => {
        if (signal?.aborted){
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
      },
      buildFileUrl: (root, path) => `${root}/${path}`,
      probePath: async (options) => {
        davProbes.push(options);
        return { exists: false, collection: false, contentLength: null };
      },
      deleteBestEffort: async () => true,
      deleteRemotePath: async () => true
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => ""
      };
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  const testOcsRequest = context.NCOcs.ocsRequest;
  const testBuildAuthHeader = context.NCOcs.buildAuthHeader;
  loadScript("modules/ocs.js", context);
  context.NCOcs.ocsRequest = testOcsRequest;
  context.NCOcs.buildAuthHeader = testBuildAuthHeader;
  loadScript("modules/sharingStorage.js", context);
  loadScript("modules/shareTemplateContract.js", context);
  loadScript("modules/textUtils.js", context);
  loadScript("modules/fileQueuePathConflicts.js", context);
  loadScript("modules/fileLinkSources.js", context);
  loadScript("modules/shareBlockRenderer.js", context);
  loadScript("modules/ncSharing.js", context);
  return { context, requests, transferCalls, davProbes, credentials };
}

async function expectRejected(callback, label){
  let failure = null;
  try{
    await callback();
  }catch(error){
    failure = error;
  }
  assert(failure, label);
  return failure;
}

async function checkSavedAuthenticationRecovery(){
  const credentials = { baseUrl: "https://cloud.example.test/nextcloud", user: "login@example.test", appPass: "old-password" };
  const stored = { ...credentials };
  const capabilities = makeResponse(200, {
    ocs: { meta: { status: "ok", statuscode: 100 }, data: { version: "35.0.1", capabilities: {} } }
  });
  const currentUser = makeResponse(200, {
    ocs: { meta: { status: "ok", statuscode: 100 }, data: { id: "canonical-user" } }
  });
  const rejected = makeResponse(401, {});
  const harness = createCoreHarness([capabilities, currentUser, rejected, capabilities, currentUser, capabilities, currentUser], { stored });
  const core = harness.context.__NCCore;
  const url = credentials.baseUrl + "/remote.php/dav/files/canonical-user/a";
  const header = harness.context.NCOcs.buildAuthHeader(credentials.user, credentials.appPass);
  const successful = await core.testCredentials(credentials);
  assert(successful.ok, "Initial credentials must be independently verified");
  let oldResponse;
  const oldRequest = core.runAuthenticatedRequest({ url, authHeader: header, request: () => new Promise((resolve) => { oldResponse = resolve; }) });
  let beforeSaveResponse;
  const beforeSaveRequest = core.runAuthenticatedRequest({ url, authHeader: header, request: () => new Promise((resolve) => { beforeSaveResponse = resolve; }) });
  await new Promise(setImmediate);
  await expectRejected(() => core.runAuthenticatedRequest({ url, authHeader: header, request: async () => rejected }), "A saved-credential 401 must pause the connection");
  assert((await core.getConnectionState()).reason === "auth_required", "The confirmed refusal must be visible as an authentication problem");
  const stateText = JSON.stringify(stored.ncConnectionStateV1);
  assert(!stateText.includes(credentials.user) && !stateText.includes(credentials.appPass) && !stateText.includes(header), "The persistent pause marker must not duplicate credentials");
  assert(await core.getCurrentUserId(credentials) === "canonical-user", "A paused connection must retain its canonical ownership metadata");
  let automaticCalls = 0;
  await expectRejected(() => core.runAuthenticatedRequest({ url, authHeader: header, request: async () => { automaticCalls += 1; return currentUser; } }), "Automatic requests with rejected credentials must stop before transport");
  assert(automaticCalls === 0, "A paused connection must not create another failed server login");
  const restart = createCoreHarness([], { stored });
  await expectRejected(() => restart.context.__NCCore.getRequiredCapabilities(credentials), "The pause must survive a background restart");
  assert(restart.requests.length === 0, "Restart must not retry rejected stored credentials");

  const wrongDraft = await core.testCredentials({ ...credentials, appPass: "wrong-draft" });
  assert(!wrongDraft.ok && wrongDraft.code === "auth", "Wrong replacement credentials must fail clearly");
  const replacement = { ...credentials, appPass: "new-valid-password" };
  const validDraft = await core.testCredentials(replacement);
  assert(validDraft.ok, "A user-directed replacement test must bypass the old 401 pause");
  beforeSaveResponse(rejected);
  await expectRejected(() => beforeSaveRequest, "A late rejection may still belong to the old saved password before replacement is written");
  assert((await core.getConnectionState()).reason === "auth_required", "A successful draft test alone must not release automatic requests");
  await expectRejected(() => core.commitVerifiedConnection(replacement), "An unsaved tested account must not resume the connection");
  const resumed = [];
  core.onConnectionRestored.addListener((identity) => resumed.push(identity));
  Object.assign(stored, replacement);
  await core.commitVerifiedConnection(replacement);
  await new Promise(setImmediate);
  assert((await core.getConnectionState()).reason === "" && resumed.length === 1, "Verified saved credentials must resume the connection and notify paused work");
  assert(resumed[0].baseUrl === credentials.baseUrl && resumed[0].userId === "canonical-user", "Recovery must identify the verified canonical account without credentials");
  await core.runAuthenticatedRequest({ url, authHeader: harness.context.NCOcs.buildAuthHeader(replacement.user, replacement.appPass), request: async () => currentUser });
  await expectRejected(() => core.runAuthenticatedRequest({ url, authHeader: header, request: async () => { automaticCalls += 1; return rejected; } }), "Delayed work must not replay the replaced password");
  assert(automaticCalls === 0, "Stale captured passwords must stay off the network after recovery");
  oldResponse(rejected);
  await expectRejected(() => oldRequest, "A late old-account response still fails its original operation");
  assert((await core.getConnectionState()).reason === "", "A late rejection of the old password must not poison a newly verified saved connection");
  assert((await core.getVerifiedConnectionIdentity())?.userId === "canonical-user", "Late cleanup failures may recover through the current saved verification");

  const foreign = { ...replacement, baseUrl: "https://other.example.test" };
  const foreignTest = await core.testCredentials(foreign);
  assert(foreignTest.ok, "Testing another server may establish only a draft verification");
  await expectRejected(() => core.commitVerifiedConnection(foreign), "A different unsaved server must not unlock or replace the current connection");
  assert((await core.getVerifiedConnectionIdentity())?.baseUrl === credentials.baseUrl, "An unsaved draft must not change the verified cleanup owner");

  const permissionResponse = makeResponse(403, {});
  await core.runAuthenticatedRequest({ url, authHeader: harness.context.NCOcs.buildAuthHeader(replacement.user, replacement.appPass), request: async () => permissionResponse });
  assert((await core.getConnectionState()).reason === "", "Operation-specific 403 refusals must not mark the app password invalid");
  stored.defaultsSource = "backend";
  stored.nccShareCleanupGroupsV1 = { retained: true };
  await core.removeSavedCredentials();
  assert(!("user" in stored) && !("appPass" in stored), "Explicit credential removal must remove both saved login fields");
  assert(stored.baseUrl === credentials.baseUrl && stored.defaultsSource === "backend" && stored.nccShareCleanupGroupsV1.retained,
    "Removing credentials must preserve the configured URL, local defaults and cleanup ownership");
  assert(await core.getVerifiedConnectionIdentity() === null, "Removing credentials must discard the old recovery proof");
  await expectRejected(() => core.runAuthenticatedRequest({ url, authHeader: harness.context.NCOcs.buildAuthHeader(replacement.user, replacement.appPass), request: async () => { automaticCalls += 1; return currentUser; } }), "A previously captured account must stop working after explicit credential removal");
  assert(automaticCalls === 0, "Removing saved credentials must stop stale captured requests before they reach the server");
  stored.ncConnectionStateV1 = { baseUrl: credentials.baseUrl, authenticationRejected: true, retryAt: 0 };
  assert((await core.getConnectionState()).reason === "", "An incomplete account needs first sign-in rather than an invalid-login banner");

  const validStored = { ...credentials };
  const validConnection = createCoreHarness([rejected], { stored: validStored });
  const failedDraft = await validConnection.context.__NCCore.testCredentials({ ...credentials, appPass: "invented-draft" });
  assert(!failedDraft.ok && (await validConnection.context.__NCCore.getConnectionState()).reason === "",
    "Testing an incorrect unsaved password must not pause a valid saved connection");
  await validConnection.context.__NCCore.runAuthenticatedRequest({ url, authHeader: header, request: async () => currentUser });
}

async function checkRateLimitRecovery(){
  const stored = { baseUrl: "https://cloud.example.test", user: "alice", appPass: "app-password" };
  const pendingTimers = new Map();
  let nextTimer = 1;
  const timers = {
    set: (callback, delayMs) => { const id = nextTimer++; pendingTimers.set(id, { callback, delayMs }); return id; },
    clear: (id) => pendingTimers.delete(id)
  };
  const harness = createCoreHarness([], { stored, timers });
  let now = 1700000000000;
  harness.context.Date = { now: () => now, parse: Date.parse };
  const core = harness.context.__NCCore;
  const url = stored.baseUrl + "/ocs/v2.php/cloud/user";
  const authHeader = harness.context.NCOcs.buildAuthHeader(stored.user, stored.appPass);
  const rateResponse = { status: 429, headers: { get: () => "120" } };
  await expectRejected(() => core.runAuthenticatedRequest({ url, authHeader, request: async () => rateResponse }), "HTTP 429 must stop the request flow");
  const state = await core.getConnectionState();
  assert(state.reason === "rate_limited" && state.retryAt === now + 120000, "Retry-After must be honored without the former 30-second cap");
  let calls = 0;
  await expectRejected(() => core.runAuthenticatedRequest({ url, authHeader, verification: true, request: async () => { calls += 1; return { status: 200 }; } }), "Even explicit verification must respect the server cooldown");
  assert(calls === 0, "A cooldown must not make another automatic or explicit request before its deadline");
  const restarted = createCoreHarness([], { stored, timers });
  restarted.context.Date = harness.context.Date;
  assert((await restarted.context.__NCCore.getConnectionState()).reason === "rate_limited", "Server cooldowns must survive a background restart");
  assert(pendingTimers.size > 0, "A persisted cooldown must schedule its expiry after restart");
  stored.baseUrl = "https://other.example.test";
  assert((await core.getConnectionState()).reason === "", "Another server must not inherit the earlier server cooldown");
  stored.baseUrl = "https://cloud.example.test";
  await core.removeSavedCredentials();
  assert((await core.getConnectionState()).reason === "rate_limited", "Removing a saved password must not bypass a server-requested cooldown");
  stored.user = "alice";
  stored.appPass = "app-password";
  await harness.context.browser.storage.local.set({ ncConnectionStateV1: { ...stored.ncConnectionStateV1, authenticationRejected: true, baseUrl: stored.baseUrl } });
  now += 120001;
  assert((await core.getConnectionState()).reason === "auth_required", "Expiry of a 429 must not clear a separate confirmed 401 refusal");

  const expiredStored = {
    baseUrl: "https://cloud.example.test", user: "alice", appPass: "app-password",
    ncConnectionStateV1: { authenticationRejected: false, rateLimitOrigin: "https://cloud.example.test", retryAt: 1700000000000 }
  };
  const expiryRecovery = createCoreHarness([makeResponse(200, {
    ocs: { meta: { status: "ok", statuscode: 100 }, data: { id: "canonical-alice" } }
  })], { stored: expiredStored, timers, clock: { now: 1700000000001 } });
  await new Promise(setImmediate);
  const restored = [];
  expiryRecovery.context.__NCCore.onConnectionRestored.addListener((identity) => restored.push(identity));
  await new Promise(setImmediate);
  assert(restored.length === 1 && restored[0].userId === "canonical-alice", "A cooldown expiring during startup must notify cleanup listeners registered later");
  assert((await expiryRecovery.context.__NCCore.getConnectionState()).reason === "", "Expired server cooldowns must become usable without another credential save");
  const uiStored = { ...expiredStored, ncConnectionStateV1: { authenticationRejected: false, rateLimitOrigin: "https://cloud.example.test", retryAt: 1700000000000 } };
  const uiCopy = createCoreHarness([], { stored: uiStored, timers, clock: { now: 1700000000001 }, uiRuntime: true });
  await new Promise(setImmediate);
  assert(uiCopy.requests.length === 0 && uiStored.ncConnectionStateV1.retryAt === 1700000000000,
    "A rendering-only Sharing UI copy must not consume background cooldown recovery");

  const saveStored = {
    baseUrl: "https://cloud.example.test", user: "alice", appPass: "old-password",
    ncConnectionStateV1: { baseUrl: "https://cloud.example.test", authenticationRejected: true, retryAt: 0 }
  };
  const saveClock = { now: 1700000100000 };
  const saveDuringCooldown = createCoreHarness([
    makeResponse(200, { ocs: { meta: { status: "ok", statuscode: 100 }, data: { version: "35.0.1", capabilities: {} } } }),
    makeResponse(200, { ocs: { meta: { status: "ok", statuscode: 100 }, data: { id: "canonical-alice" } } })
  ], { stored: saveStored, timers, clock: saveClock });
  const saveCore = saveDuringCooldown.context.__NCCore;
  const replacement = { baseUrl: saveStored.baseUrl, user: saveStored.user, appPass: "new-password" };
  assert((await saveCore.testCredentials(replacement)).ok, "Replacement credentials may verify before an optional backend probe receives 429");
  await expectRejected(() => saveCore.runAuthenticatedRequest({ url, authHeader: harness.context.NCOcs.buildAuthHeader(replacement.user, replacement.appPass), verification: true, request: async () => rateResponse }), "An optional post-test backend request may rate-limit the connection");
  Object.assign(saveStored, replacement);
  const recovery = [];
  saveCore.onConnectionRestored.addListener((identity) => recovery.push(identity));
  assert((await saveCore.commitVerifiedConnection(replacement)).reason === "rate_limited", "A verified saved password must keep an active server cooldown instead of falsely reporting Save failure");
  assert(!saveStored.ncConnectionStateV1.authenticationRejected && recovery.length === 0, "A good saved replacement clears the old 401 but does not run cleanup during the server wait");
  saveClock.now += 120001;
  await saveCore.getConnectionState();
  await new Promise(setImmediate);
  assert(recovery.length === 1 && recovery[0].userId === "canonical-alice", "Paused operations become eligible after both verified Save and expiry of the server cooldown");
}

async function run(){
  await checkSavedAuthenticationRecovery();
  await checkRateLimitRecovery();
  const capabilities = makeResponse(200, {
    ocs: { meta: { status: "ok" }, data: { version: "32.0.0" } }
  });
  const currentUser = makeResponse(200, {
    ocs: { meta: { status: "ok" }, data: { id: "canonical-user", email: "login@example.test" } }
  });
  const core = createCoreHarness([capabilities, currentUser]);
  const credentials = {
    baseUrl: "https://cloud.example.test/nextcloud/",
    user: "login@example.test",
    appPass: "app-password"
  };
  const result = await core.context.__NCCore.testCredentials(credentials);
  assert(result.ok === true, "Credential test should accept a valid current-user response");
  assert(result.userId === "canonical-user", "Credential test should return ocs.data.id");
  assert(core.requests[1].url === "https://cloud.example.test/nextcloud/ocs/v2.php/cloud/user?format=json", "Current-user request should preserve a Nextcloud subfolder URL");
  assert(core.requests[1].options.headers.Authorization === "Basic " + Buffer.from("login@example.test:app-password").toString("base64"), "Current-user request must authenticate with the configured login");

  const uiCore = createCoreHarness([currentUser], { backgroundLogger: false });
  const uiUserId = await uiCore.context.__NCCore.getCurrentUserId(credentials);
  assert(uiUserId === "canonical-user", "UI UID resolution must not depend on the background logger");
  assert(uiCore.requests.length === 1, "UI UID resolution should issue one current-user request");

  const cachedUserId = await core.context.__NCCore.getCurrentUserId(credentials);
  assert(cachedUserId === "canonical-user", "Resolved canonical UID should be reused from the session cache");
  assert(core.requests.length === 2, "Cached UID resolution should not repeat the OCS request");

  const davAccount = core.context.__NCCore.buildDavAccountContext({
    ...credentials,
    userId: "canonical/user"
  });
  assert(davAccount.baseUrl === "https://cloud.example.test/nextcloud", "DAV account data must normalize the Nextcloud base URL");
  assert(davAccount.davRoot === "https://cloud.example.test/nextcloud/remote.php/dav/files/canonical%2Fuser", "File DAV roots must encode the canonical UID");
  assert(davAccount.uploadRoot === "https://cloud.example.test/nextcloud/remote.php/dav/uploads/canonical%2Fuser", "Upload DAV roots must encode the canonical UID");
  assert(davAccount.bulkUrl === "https://cloud.example.test/nextcloud/remote.php/dav/bulk", "Bulk DAV URL must preserve the Nextcloud subfolder");
  assert(davAccount.accountIdentity === JSON.stringify([davAccount.baseUrl, "canonical/user"]), "DAV account identity must use only server and canonical UID");
  assert(davAccount.authHeader === "Basic " + Buffer.from("login@example.test:app-password").toString("base64"), "DAV Basic Auth must use the configured login alias");

  const nextcloud31 = createCoreHarness([
    makeResponse(200, {
      ocs: {
        meta: { status: "ok", statuscode: 100 },
        data: { version: { major: 31, minor: 0, micro: 9, string: "31.0.9" } }
      }
    })
  ]);
  const oldVersionFailure = await expectRejected(
    () => nextcloud31.context.__NCCore.getRequiredCapabilities(credentials),
    "Nextcloud 31 must be rejected"
  );
  assert(
    oldVersionFailure.ncCapabilitiesCode === "minimum_version",
    "Nextcloud 31 must use the localized minimum-version failure"
  );

  const unknownVersion = createCoreHarness([
    makeResponse(200, {
      ocs: {
        meta: { status: "ok", statuscode: 100 },
        data: { capabilities: {} }
      }
    })
  ]);
  const unknownVersionFailure = await expectRejected(
    () => unknownVersion.context.__NCCore.getRequiredCapabilities(credentials),
    "A capability response without a server version must be rejected"
  );
  assert(
    unknownVersionFailure.ncCapabilitiesCode === "minimum_version",
    "An unknown server version must fail the Nextcloud-version gate"
  );

  const missingMeta = createCoreHarness([
    makeResponse(200, {
      ocs: {
        data: { version: "32.0.0", capabilities: {} }
      }
    })
  ]);
  const missingMetaFailure = await expectRejected(
    () => missingMeta.context.__NCCore.getRequiredCapabilities(credentials),
    "Capabilities without an OCS result must be rejected"
  );
  assert(
    missingMetaFailure.ncCapabilitiesCode === "invalid",
    "A missing OCS result must be reported as an invalid response"
  );

  const exactBulk = createCoreHarness([
    makeResponse(200, {
      ocs: {
        meta: { status: "ok", statuscode: 100 },
        data: {
          version: "32.0.0",
          capabilities: { dav: { bulkupload: "1.0" } }
        }
      }
    })
  ]);
  const exactBulkSnapshot = await exactBulk.context.__NCCore.getRequiredCapabilities(credentials);
  assert(exactBulkSnapshot.bulkUploadSupported, "The exact DAV bulk capability string must enable bulk");

  const numericBulk = createCoreHarness([
    makeResponse(200, {
      ocs: {
        meta: { status: "ok", statuscode: 100 },
        data: {
          version: "32.0.0",
          capabilities: { dav: { bulkupload: 1 } }
        }
      }
    })
  ]);
  const numericBulkSnapshot = await numericBulk.context.__NCCore.getRequiredCapabilities(credentials);
  assert(!numericBulkSnapshot.bulkUploadSupported, "A numeric DAV bulk value must keep bulk disabled");

  let releaseCapabilities;
  const inflightCapabilities = createCoreHarness([
    () => new Promise((resolve) => {
      releaseCapabilities = resolve;
    })
  ]);
  const firstCapabilities = inflightCapabilities.context.__NCCore.getRequiredCapabilities(credentials);
  const secondCapabilities = inflightCapabilities.context.__NCCore.getRequiredCapabilities(credentials);
  await new Promise(setImmediate);
  assert(
    inflightCapabilities.requests.length === 1,
    "Concurrent non-upload capability reads must share one request"
  );
  releaseCapabilities(makeResponse(200, {
    ocs: {
      meta: { status: "ok", statuscode: 100 },
      data: { version: "32.0.0", capabilities: {} }
    }
  }));
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    firstCapabilities,
    secondCapabilities
  ]);
  assert(firstSnapshot === secondSnapshot, "Concurrent capability readers must receive the same snapshot");

  const abortController = new AbortController();
  const abortCapabilities = createCoreHarness([
    ({ options }) => new Promise((resolve, reject) => {
      const stop = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      options.signal.addEventListener("abort", stop, { once: true });
      if (options.signal.aborted){
        stop();
      }
    })
  ]);
  const abortedRequest = abortCapabilities.context.__NCCore.getRequiredCapabilities({
    ...credentials,
    signal: abortController.signal
  });
  await new Promise(setImmediate);
  abortController.abort();
  const abortFailure = await expectRejected(
    () => abortedRequest,
    "An upload abort must stop its capability request"
  );
  assert(abortFailure.name === "AbortError", "Capability cancellation must stay an AbortError");
  assert(
    abortCapabilities.requests[0].options.signal !== abortController.signal
      && abortCapabilities.requests[0].options.signal.aborted,
    "The upload signal must abort the bounded capability fetch"
  );

  const missingId = createCoreHarness([
    makeResponse(200, { ocs: { meta: { status: "ok" }, data: { version: "32.0.0" } } }),
    makeResponse(200, { ocs: { meta: { status: "ok" }, data: { email: "login@example.test" } } })
  ]);
  const missingResult = await missingId.context.__NCCore.testCredentials(credentials);
  assert(missingResult.ok === false && missingResult.code === "identity", "Missing ocs.data.id must fail without falling back to email");

  const sharing = createSharingHarness(core.context.__NCCore.buildDavAccountContext);
  const preflightRequest = {
    shareName: "Customer",
    basePath: "Team Shares",
    shareDate: new Date("2026-07-16T12:00:00Z").toISOString()
  };
  const folderExists = await sharing.context.NCSharing.checkFileLinkFolderExists(
    preflightRequest
  );
  assert(folderExists === false, "A missing manual share folder must pass preflight");
  assert(sharing.davProbes.length === 1, "Manual share preflight should issue one DAV probe");
  assert(
    sharing.davProbes[0].url.endsWith(
      "/remote.php/dav/files/canonical-user/Team Shares/20260716_Customer"
    ),
    "Manual share preflight must probe the same canonical UID, base path, date, and sanitized name used by upload"
  );
  assert(
    sharing.davProbes[0].authHeader
      === "Basic " + Buffer.from("login@example.test:app-password").toString("base64"),
    "Manual share preflight must authenticate with the configured login"
  );
  sharing.context.NCNextcloudDav.probePath = async () => ({
    exists: true,
    collection: true,
    contentLength: null
  });
  assert(
    await sharing.context.NCSharing.checkFileLinkFolderExists(preflightRequest),
    "An existing manual share folder must fail wizard preflight"
  );
  await sharing.context.NCSharing.createFileLink(
    sharing.context.NCSharing.prepareFileLinkRequest({
      shareName: "Customer",
      basePath: "Team Shares",
      shareDate: new Date("2026-07-16T12:00:00Z").toISOString(),
      permissions: { read: true },
      files: []
    })
  );
  assert(sharing.transferCalls.length === 1, "FileLink upload should create one transfer plan");
  assert(sharing.transferCalls[0].davRoot.includes("/remote.php/dav/files/canonical-user"), "FileLink DAV path must use the canonical UID");
  assert(sharing.transferCalls[0].uploadRoot.includes("/remote.php/dav/uploads/canonical-user"), "Chunk path must use the canonical UID");
  assert(!sharing.transferCalls[0].davRoot.includes("login%40example.test"), "FileLink DAV path must not use the email login");
  assert(
    sharing.transferCalls[0].authHeader === "Basic " + Buffer.from("login@example.test:app-password").toString("base64"),
    "FileLink Basic Auth must still use the configured login"
  );

  let metadataRequest = null;
  sharing.context.NCOcs.ocsRequest = async (request) => {
    metadataRequest = request;
    return {
      ok: true,
      status: 200,
      raw: "",
      data: {
        ocs: {
          meta: { status: "ok", statuscode: 100 },
          data: null
        }
      }
    };
  };
  await sharing.context.NCSharing.updateShareNote({
    baseUrl: "https://upload-account.example.test",
    authHeader: "Basic upload-account",
    shareId: "42",
    permissions: { read: true, write: true, create: false, delete: false },
    noteEnabled: false,
    note: ""
  });
  assert(metadataRequest.method === "PUT", "Share metadata must use the OCS update endpoint");
  assert(
    metadataRequest.url.startsWith("https://upload-account.example.test/"),
    "Share note updates must keep the account captured by the upload"
  );
  assert(
    metadataRequest.headers.Authorization === "Basic upload-account",
    "Share note updates must keep the authorization captured by the upload"
  );
  assert(metadataRequest.body.get("permissions") === "3", "Read and edit must retain the Nextcloud READ|UPDATE mask");
  assert(!metadataRequest.body.has("publicUpload"), "Share metadata must not override the exact mask with legacy publicUpload");

  sharing.context.NCOcs.ocsRequest = async () => ({
    ok: true,
    status: 200,
    raw: "",
    data: {
      ocs: {
        meta: {
          status: "failure",
          statuscode: 403,
          message: "metadata denied"
        },
        data: null
      }
    }
  });
  const metadataFailure = await expectRejected(
    () => sharing.context.NCSharing.updateShareNote({
      baseUrl: "https://upload-account.example.test",
      authHeader: "Basic upload-account",
      shareId: "42",
      permissions: { read: true },
      noteEnabled: true,
      note: "Test"
    }),
    "An HTTP 200 response with OCS failure meta must reject share finalization"
  );
  assert(
    metadataFailure.message === "metadata denied",
    "Share metadata failure must retain the OCS message"
  );

  let trackedRootCleanup = null;
  sharing.context.NCNextcloudDav.deleteTrackedRoot = async (options) => {
    trackedRootCleanup = options;
    return "reservation";
  };
  sharing.context.NCFileLinkUpload.prepareAndUpload = async (options) => {
    const root = {
      ...options.rootCandidates[0],
      cleanupResolution: {
        reservationUrl: "https://cloud.example.test/remote.php/dav/files/canonical-user/Team%20Shares/_stage",
        targetUrl: "https://cloud.example.test/remote.php/dav/files/canonical-user/Team%20Shares/Customer"
      }
    };
    await options.onRootCreated(root);
    return { plan: { files: [], totalBytes: 0 }, root };
  };
  sharing.context.NCFileLinkShare.create = async () => {
    throw new Error("share create failed");
  };
  await expectRejected(
    () => sharing.context.NCSharing.createFileLink(
      sharing.context.NCSharing.prepareFileLinkRequest({
        shareName: "Customer",
        basePath: "Team Shares",
        shareDate: new Date("2026-07-16T12:00:00Z").toISOString(),
        permissions: { read: true },
        files: []
      })
    ),
    "A failed share create must clean its reserved root"
  );
  assert(
    trackedRootCleanup?.reservationUrl?.endsWith("/_stage")
      && trackedRootCleanup?.targetUrl?.endsWith("/Customer"),
    "Immediate cleanup must preserve the safe root-MOVE resolution paths"
  );

  const sharingSource = readText("modules/ncSharing.js");
  const coreSource = readText("modules/nccore.js");
  const storageSource = readText("modules/nextcloudVfsStorage.js");
  const cleanupSource = readText("modules/bgShareCleanupStore.js");
  const addressbookSource = readText("modules/talkAddressbook.js");
  assert(coreSource.includes("/remote.php/dav/uploads/${encodedUserId}"), "Core DAV account data must own the chunked-upload root");
  assert((sharingSource.match(/NCCore\.buildDavAccountContext/g) || []).length === 1, "Sharing uploads must reuse core DAV account data");
  assert(storageSource.includes("core.buildDavAccountContext({ ...opts, userId })"), "Nextcloud VFS must reuse core DAV account data");
  assert(cleanupSource.includes("NCCore.buildDavAccountContext({ ...opts, userId: currentUserId })"), "Persistent cleanup must reuse core DAV account data");
  assert(addressbookSource.includes("encodeURIComponent(userId)"), "System addressbook path must use the canonical UID");
  assert(!addressbookSource.includes("encodeURIComponent(user) + \"/z-server-generated"), "System addressbook path must not use the authentication login");

  console.log("[OK] nextcloud-user-id-contract-check passed");
}

run().catch((error) => {
  console.error("[FAIL] nextcloud-user-id-contract-check", error);
  process.exitCode = 1;
});
