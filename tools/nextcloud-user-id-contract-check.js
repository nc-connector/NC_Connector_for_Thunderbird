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
      safeConsoleError: () => {}
    },
    bgI18n: (key) => key,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const response = queue.shift();
      if (!response){
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return response;
    }
  };
  if (backgroundLogger){
    context.L = () => {};
  }
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("modules/nccore.js", context, ";globalThis.__NCCore = NCCore;");
  return { context, requests };
}

function createSharingHarness(){
  const requests = [];
  const credentials = {
    baseUrl: "https://cloud.example.test/nextcloud",
    user: "login@example.test",
    appPass: "app-password",
    debugEnabled: false
  };
  const context = {
    console,
    URL,
    globalThis: null,
    window: null,
    NCShareTemplateContract: undefined,
    NCCore: {
      getOpts: async () => credentials,
      getCurrentUserId: async (options) => {
        assert(options.user === credentials.user, "UID resolution must receive the authentication login");
        return "canonical-user";
      }
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
  loadScript("modules/shareTemplateContract.js", context);
  loadScript("modules/textUtils.js", context);
  loadScript("modules/ncSharing.js", context);
  return { context, requests, credentials };
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

  const missingId = createCoreHarness([
    makeResponse(200, { ocs: { meta: { status: "ok" }, data: { version: "32.0.0" } } }),
    makeResponse(200, { ocs: { meta: { status: "ok" }, data: { email: "login@example.test" } } })
  ]);
  const missingResult = await missingId.context.__NCCore.testCredentials(credentials);
  assert(missingResult.ok === false && missingResult.code === "identity", "Missing ocs.data.id must fail without falling back to email");

  const sharing = createSharingHarness();
  await sharing.context.NCSharing.checkShareFolderAvailability({
    shareName: "Customer",
    basePath: "Team Shares",
    shareDate: new Date("2026-07-16T12:00:00Z")
  });
  assert(sharing.requests.length === 1, "Share availability should issue one DAV request");
  assert(sharing.requests[0].url.includes("/remote.php/dav/files/canonical-user/"), "FileLink DAV path must use the canonical UID");
  assert(!sharing.requests[0].url.includes("login%40example.test"), "FileLink DAV path must not use the email login");
  assert(sharing.requests[0].options.headers.Authorization === "Basic " + Buffer.from("login@example.test:app-password").toString("base64"), "FileLink Basic Auth must still use the configured login");

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
