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

function createCoreHarness(responses, { backgroundLogger = true } = {}){
  const requests = [];
  const queue = responses.slice();
  const context = {
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    AbortController,
    DOMException,
    globalThis: null,
    window: null,
    browser: {
      storage: {
        local: {
          get: async () => ({})
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
  return { context, requests };
}

function createSharingHarness(){
  const requests = [];
  const transferCalls = [];
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
      }
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
    NCFileLinkDav: {
      throwIfAborted: (signal) => {
        if (signal?.aborted){
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
      },
      buildFileUrl: (root, path) => `${root}/${path}`,
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
  loadScript("modules/shareTemplateContract.js", context);
  loadScript("modules/textUtils.js", context);
  loadScript("modules/ncSharing.js", context);
  return { context, requests, transferCalls, credentials };
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

async function run(){
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
  for (let index = 0; index < 4; index++){
    await Promise.resolve();
  }
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
  for (let index = 0; index < 4; index++){
    await Promise.resolve();
  }
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

  const sharing = createSharingHarness();
  await sharing.context.NCSharing.createFileLink({
    shareName: "Customer",
    basePath: "Team Shares",
    shareDate: new Date("2026-07-16T12:00:00Z").toISOString(),
    permissions: { read: true },
    files: []
  });
  assert(sharing.transferCalls.length === 1, "FileLink upload should create one transfer plan");
  assert(sharing.transferCalls[0].davRoot.includes("/remote.php/dav/files/canonical-user"), "FileLink DAV path must use the canonical UID");
  assert(sharing.transferCalls[0].uploadRoot.includes("/remote.php/dav/uploads/canonical-user"), "Chunk path must use the canonical UID");
  assert(!sharing.transferCalls[0].davRoot.includes("login%40example.test"), "FileLink DAV path must not use the email login");
  assert(
    sharing.transferCalls[0].authHeader === "Basic " + Buffer.from("login@example.test:app-password").toString("base64"),
    "FileLink Basic Auth must still use the configured login"
  );

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
    () => sharing.context.NCSharing.updateShareDetails({
      shareInfo: {
        shareId: "42",
        label: "Customer",
        folderInfo: { folderName: "Customer" },
        permissions: { read: true }
      },
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
  sharing.context.NCFileLinkDav.deleteTrackedRoot = async (options) => {
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
    () => sharing.context.NCSharing.createFileLink({
      shareName: "Customer",
      basePath: "Team Shares",
      shareDate: new Date("2026-07-16T12:00:00Z").toISOString(),
      permissions: { read: true },
      files: []
    }),
    "A failed share create must clean its reserved root"
  );
  assert(
    trackedRootCleanup?.reservationUrl?.endsWith("/_stage")
      && trackedRootCleanup?.targetUrl?.endsWith("/Customer"),
    "Immediate cleanup must preserve the safe root-MOVE resolution paths"
  );

  const sharingSource = readText("modules/ncSharing.js");
  const addressbookSource = readText("modules/talkAddressbook.js");
  assert(sharingSource.includes("/remote.php/dav/uploads/${encodeURIComponent(userId)}"), "Chunked upload path must use the canonical UID");
  assert(addressbookSource.includes("encodeURIComponent(userId)"), "System addressbook path must use the canonical UID");
  assert(!addressbookSource.includes("encodeURIComponent(user) + \"/z-server-generated"), "System addressbook path must not use the authentication login");

  console.log("[OK] nextcloud-user-id-contract-check passed");
}

run().catch((error) => {
  console.error("[FAIL] nextcloud-user-id-contract-check", error);
  process.exitCode = 1;
});
