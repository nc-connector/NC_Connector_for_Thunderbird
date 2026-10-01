"use strict";

const vm = require("node:vm");
const {
  assert,
  loadScript,
  readText
} = require("./review-check-utils");
const {
  collectLogText,
  expectRejected,
  createCoreHarness
} = require("./network-security-test-utils");

function createManagedSetupHarness(
  getManaged,
  localizedMessage = "Settings could not be loaded."
){
  const logs = [];
  const context = {
    console,
    URL,
    globalThis: null,
    window: null,
    NCTalkTextUtils: {
      normalizeBaseUrl: (value) => {
        const normalized = String(value || "").trim().replace(/\/+$/, "");
        return normalized.startsWith("https://") ? normalized : "";
      }
    },
    browser: {
      i18n: {
        getMessage: (key) => key === "options_status_load_failed"
          ? localizedMessage
          : key
      },
      storage: getManaged === undefined
        ? {}
        : {
          managed: {
            get: getManaged
          }
        }
    },
    NCLogContext: {
      resolveAddonLogPrefix: () => "[TEST]",
      safeConsoleError: (...args) => logs.push(args)
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("modules/managedSetup.js", context, ";globalThis.__NCManagedSetup = NCManagedSetup;");
  return {
    managedSetup: context.__NCManagedSetup,
    logs
  };
}

async function checkManagedStorageStates(){
  const unavailable = createManagedSetupHarness(undefined);
  const unavailablePolicy = await unavailable.managedSetup.read();
  assert(unavailablePolicy.hasNextcloudUrl === false, "Missing storage.managed remains a valid empty state");

  const empty = createManagedSetupHarness(async () => undefined);
  const emptyPolicy = await empty.managedSetup.read();
  assert(emptyPolicy.hasNextcloudUrl === false, "An empty managed storage result remains a valid empty state");

  const notConfigured = createManagedSetupHarness(async () => {
    throw new Error("Managed storage manifest not found");
  });
  const notConfiguredPolicy = await notConfigured.managedSetup.read();
  assert(
    notConfiguredPolicy.hasNextcloudUrl === false,
    "A missing managed-storage manifest must remain a valid unmanaged state"
  );
  assert(
    notConfigured.logs.length === 0,
    "The normal unmanaged state must not emit a policy-read error"
  );

  const valid = createManagedSetupHarness(async () => ({
    NextcloudUrl: "https://managed.example.test/nextcloud/",
    NextcloudUrlLocked: true
  }));
  const validPolicy = await valid.managedSetup.read();
  assert(validPolicy.hasNextcloudUrl === true, "A managed URL must be detected");
  assert(validPolicy.nextcloudUrlLocked === true, "A managed URL lock must be retained");
  assert(
    validPolicy.nextcloudUrl === "https://managed.example.test/nextcloud",
    "A managed URL must be normalized"
  );
  assert(validPolicy.isEnterpriseRollout, "An existing managed URL deployment must require a Seat");

  for (const key of ["NextcloudUrl", "NextcloudUrlLocked", "nextcloudUrl", "nextcloudUrlLocked", "baseUrl", "baseUrlLocked", "DefaultsSource"]){
    for (const value of [false, "", null, "invalid"]){
      for (const values of [{ [key]: value }, { adminSettings: { [key]: value } }]){
        const harness = createManagedSetupHarness(async () => values);
        assert((await harness.managedSetup.read()).isEnterpriseRollout, `${key} presence must activate managed rollout regardless of value`);
      }
    }
  }
  for (const values of [{}, { adminSettings: {} }, { adminSettings: { unrelated: true } }]){
    const harness = createManagedSetupHarness(async () => values);
    const policy = await harness.managedSetup.read();
    assert(!policy.isEnterpriseRollout && !policy.hasDefaultsSource, "Unknown keys and an empty wrapper must not activate rollout");
    assert(policy.defaultsSource === "local", "Unmanaged defaults must remain local");
  }
  for (const value of ["local", "backend", " BACKEND "]){
    const harness = createManagedSetupHarness(async () => ({ DefaultsSource: value }));
    const policy = await harness.managedSetup.read();
    assert(policy.hasDefaultsSource && policy.defaultsSourceValid, "Recognized defaults sources must be accepted");
    assert(policy.defaultsSource === value.trim().toLowerCase(), "Defaults sources use the normalized administrator value");
  }
  const invalid = createManagedSetupHarness(async () => ({ DefaultsSource: true }));
  const invalidPolicy = await invalid.managedSetup.read();
  assert(invalidPolicy.isEnterpriseRollout && !invalidPolicy.defaultsSourceValid && invalidPolicy.defaultsSource === "local", "Invalid defaults sources remain managed and use the local fallback");
}

async function checkRejectedManagedStorage(){
  const leakedUrl = "https://private-managed.example.test/nextcloud";
  const leakedPassword = "managed-storage-secret";
  const rejected = createManagedSetupHarness(async () => {
    throw new Error(`${leakedUrl} password=${leakedPassword}`);
  });
  const failure = await expectRejected(
    () => rejected.managedSetup.read(),
    "A storage.managed rejection must propagate"
  );
  const logText = collectLogText(rejected.logs);
  assert(failure.name === "ManagedSetupReadError", "Managed storage failures need a stable error type");
  assert(failure.code === "managed_setup_read_failed", "Managed storage failures need a stable error code");
  assert(failure.message === "Settings could not be loaded.", "Managed storage failures should use existing localized UI text");
  assert(!logText.includes(leakedUrl), "Managed storage error logs must not include URLs");
  assert(!logText.includes(leakedPassword), "Managed storage error logs must not include credentials");

  const fallbackContext = createManagedSetupHarness(async () => {
    throw new Error("managed read failed");
  }, "");
  const fallbackFailure = await expectRejected(
    () => fallbackContext.managedSetup.read(),
    "Managed storage failures need a fallback without i18n"
  );
  assert(
    fallbackFailure.message === "Settings could not be loaded.",
    "Managed storage failures need a non-empty English fallback"
  );
}

async function checkManagedVfsAndCalendarBoundaries(){
  const denial = new Error("enterprise_seat_required");
  const providerSource = readText("modules/vfsProviderRuntime.js");
  const providerStart = providerSource.indexOf("  async function requireStorageAccess(storageId)");
  const providerEnd = providerSource.indexOf("  async function runRequest(", providerStart);
  assert(providerStart >= 0 && providerEnd > providerStart, "Provider access boundary must remain present");
  const providerContext = {
    String,
    global: { NCNextcloudVfsStorage: { createVfsError: (code, message) => Object.assign(new Error(message), { code }) } },
    reconcileAccount: async () => ({ state: { selfStorageId: "self", enabled: true, enabledConfigured: true } }),
    NCVfsPolicyRuntime: { getPolicyStatus: async () => ({}) },
    NCPolicyRuntime: { assertManagedAccess: async () => { throw denial; } }
  };
  vm.createContext(providerContext);
  vm.runInContext(providerSource.slice(providerStart, providerEnd), providerContext);
  const providerFailure = await expectRejected(
    () => providerContext.requireStorageAccess("self"),
    "The own-Nextcloud provider must not bypass managed access"
  );
  assert(providerFailure === denial, "Managed access must be checked before the self-storage shortcut");
  providerContext.NCPolicyRuntime.assertManagedAccess = async () => null;
  assert((await providerContext.requireStorageAccess("self")).selfStorageId === "self", "Unmanaged and entitled own-Nextcloud access must retain the existing path");

  const statusStart = providerSource.indexOf("  async function getStatus(policyStatus = null)");
  const statusEnd = providerSource.indexOf("  async function setEnabled(", statusStart);
  assert(statusStart >= 0 && statusEnd > statusStart, "Provider status must remain available");
  Object.assign(providerContext, {
    readyPromise: Promise.resolve(),
    console,
    Object,
    SELF_ADDON_ID: "self@test",
    readState: async () => ({ enabled: false, enabledConfigured: true }),
    readConnections: async () => [{ addonId: "consumer@test", storageId: "grant" }],
    getConnectionLabel: () => "Nextcloud",
    removeConnections: () => { throw new Error("Status refresh must not revoke grants"); }
  });
  providerContext.NCVfsPolicyRuntime.resolveProviderSetting = () => ({ enabled: false, localEnabled: false, configured: true, locked: false });
  vm.runInContext(providerSource.slice(statusStart, statusEnd), providerContext);
  const providerStatus = await providerContext.getStatus({});
  assert(providerStatus.enabled === false && providerStatus.grants.length === 1, "Policy, source, and Seat changes must not delete saved provider grants during status refresh");

  const calendarSource = readText("modules/bgCalendar.js");
  const calendarStart = calendarSource.indexOf("async function handleCalendarItemUpsert(item)");
  const calendarEnd = calendarSource.indexOf("async function isSavedEventRoomDeleteEnabled()", calendarStart);
  assert(calendarStart >= 0 && calendarEnd > calendarStart, "Calendar update boundary must remain present");
  const calls = [];
  const calendarContext = {
    BG_STATE_READY: Promise.resolve(),
    console: { error(){} },
    L(){},
    extractTalkMetadataFromIcal: () => ({ token: "room", delegated: true, delegateId: "moderator" }),
    removeRoomCleanupEntry: () => calls.push("retain_saved_room"),
    setEventTokenEntry: async () => calls.push("save_ownership"),
    getRoomMeta: () => ({ departurePrepared: true, departureRetryGeneration: 1, departureShouldLeaveSelf: true }),
    activatePreparedCalendarDeparture: async () => calls.push("finish_handoff"),
    NCPolicyRuntime: { assertManagedAccess: async () => { calls.push("check_access"); throw denial; } },
    parseEventStartUnixSeconds: () => { throw new Error("Calendar updates must not start after managed denial"); }
  };
  vm.createContext(calendarContext);
  vm.runInContext(calendarSource.slice(calendarStart, calendarEnd), calendarContext);
  const calendarFailure = await expectRejected(
    () => calendarContext.handleCalendarItemUpsert({ type: "event", item: "ical", calendarId: "calendar", id: "event" }),
    "Managed refusal must stop new calendar-side room updates"
  );
  assert(calendarFailure === denial, "Calendar mutations must fail with the shared managed access error");
  assert(calls.join(",") === "retain_saved_room,save_ownership,finish_handoff,check_access", "Saved-room ownership and pending delegation cleanup must finish before the managed gate");
}

async function checkCoreAndOptionsFailClosed(){
  const propagatedFailure = Object.assign(new Error("Settings could not be loaded."), {
    name: "ManagedSetupReadError",
    code: "managed_setup_read_failed"
  });
  const coreHarness = createCoreHarness({
    localStorage: {
      baseUrl: "https://local.example.test",
      user: "alice",
      appPass: "app-password"
    },
    managedSetup: {
      emptyPolicy: () => ({
        hasNextcloudUrl: false,
        nextcloudUrl: "",
        nextcloudUrlLocked: false,
        source: ""
      }),
      read: async () => {
        throw propagatedFailure;
      },
      resolveBaseUrl: (localBaseUrl) => localBaseUrl
    }
  });
  const coreFailure = await expectRejected(
    () => coreHarness.core.getOpts(),
    "Core option loading must not fall back to a local URL after managed storage rejects"
  );
  assert(coreFailure === propagatedFailure, "Core option loading must propagate the managed storage failure");

  const optionsSource = readText("options.js");
  const refreshStart = optionsSource.indexOf("async function refreshManagedSetupPolicy()");
  const refreshEnd = optionsSource.indexOf("function getEffectiveBaseUrl", refreshStart);
  const refreshSource = optionsSource.slice(refreshStart, refreshEnd);
  assert(refreshStart >= 0 && refreshEnd > refreshStart, "Options managed-policy refresh function must remain present");
  assert(
    !refreshSource.includes("managedSetupPolicy = NCManagedSetup.emptyPolicy()"),
    "Options must not replace a rejected managed policy read with an empty policy"
  );
  assert(
    optionsSource.includes("if (!managedSetupPolicyReady){\n    return \"\";\n  }"),
    "Options must fail closed while no managed-policy read completed"
  );
  assert(
    optionsSource.includes('reason:"managed_setup_unavailable"'),
    "Connection tests must stay blocked after the initial managed-policy read fails"
  );
  assert(
    optionsSource.includes("managedSetupUnavailable || loginFlowInProgress || !hasBaseUrl"),
    "Login Flow must stay disabled while the managed-policy state is unavailable"
  );
  assert(
    optionsSource.includes("if (!managedSetupPolicyReady){\n      showStatus(i18n(\"options_status_load_failed\"), true, true);"),
    "The Login Flow click path must fail closed if the managed-policy state is unavailable"
  );
  assert(
    optionsSource.includes("showStatus(error?.message || i18n(\"options_status_load_failed\"), true);\n  updateAuthModeUI();"),
    "A failed initial options load must refresh the disabled control state"
  );
  const loadStart = optionsSource.indexOf("async function load(){");
  const loadEnd = optionsSource.indexOf("async function save()", loadStart);
  const loadSource = optionsSource.slice(loadStart, loadEnd);
  const hydrateCredentials = loadSource.indexOf("if (stored.user) userInput.value = stored.user;");
  const readManagedPolicy = loadSource.indexOf("await refreshManagedSetupPolicy();");
  assert(
    hydrateCredentials >= 0
      && readManagedPolicy >= 0
      && hydrateCredentials < readManagedPolicy,
    "Options must hydrate stored credentials before a managed-policy failure can abort loading"
  );
}

async function run(){
  await checkManagedStorageStates();
  await checkRejectedManagedStorage();
  await checkManagedVfsAndCalendarBoundaries();
  await checkCoreAndOptionsFailClosed();
  console.log("[OK] managed-setup-contract-check passed");
}

run().catch((error) => {
  console.error("[FAIL] managed-setup-contract-check", error);
  process.exitCode = 1;
});
