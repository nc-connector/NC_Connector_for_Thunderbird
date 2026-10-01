"use strict";

const vm = require("node:vm");
const { assert, loadScript, readText } = require("./review-check-utils");
const {
  makeResponse,
  collectLogText,
  expectRejected,
  createCoreHarness
} = require("./network-security-test-utils");

async function checkStartRequest(){
  let bodyReadInsideTimeout = false;
  const harness = createCoreHarness({
    fetchImpl: ({ insideTimeout }) => makeResponse(200, "", {
      text: async () => {
        bodyReadInsideTimeout = insideTimeout();
        return JSON.stringify({
          login: "https://cloud.example.test/login/flow/abc",
          poll: {
            endpoint: "/index.php/login/v2/poll",
            token: "poll-secret"
          }
        });
      }
    })
  });
  const start = await harness.core.startLoginFlow("https://cloud.example.test/nextcloud/");
  assert(bodyReadInsideTimeout, "Login Flow start must read the response body inside runWithTimeout");
  assert(harness.timeoutCalls.length === 1, "Login Flow start must use one bounded request");
  assert(
    harness.requests[0].options.signal === harness.timeoutCalls[0].signal,
    "Login Flow start must pass the timeout signal to fetch"
  );
  assert(
    start.pollEndpoint === "https://cloud.example.test/nextcloud/index.php/login/v2/poll",
    "Login Flow start must preserve a configured Nextcloud subfolder"
  );
}

async function checkCredentialLogging(){
  const leakedAuth = "dXNlcjpsZWFrZWQtcGFzcw==";
  const leakedPassword = "plain-secret-value";
  const leakedCookie = "ncc_session=plain-secret-cookie";
  const leakedPublicToken = "public-share-token";
  const leakedSecretKey = "secret-fragment-key";
  const networkHarness = createCoreHarness({
    fetchImpl: async () => {
      throw new Error(
        `Authorization: Basic ${leakedAuth} appPassword=${leakedPassword} `
          + `Cookie: ${leakedCookie}\n`
          + `https://cloud.example.test/s/${leakedPublicToken} `
          + `https://cloud.example.test/index.php/apps/secrets/share/id#${leakedSecretKey}`
      );
    }
  });
  const networkFailure = await expectRejected(
    () => networkHarness.core.startLoginFlow("https://cloud.example.test"),
    "A failed Login Flow start request must reject"
  );
  const networkLog = collectLogText(networkHarness.logs);
  assert(networkFailure.ncLoginFlowFatal === true, "Login Flow network failures must use the generic fatal error");
  assert(!networkLog.includes(leakedAuth), "Basic Auth values must be redacted from core logs");
  assert(!networkLog.includes(leakedPassword), "Password fields must be redacted from core logs");
  assert(!networkLog.includes(leakedCookie), "Cookie values must be redacted from core logs");
  assert(!networkLog.includes(leakedPublicToken), "Public-share tokens must be redacted from core logs");
  assert(!networkLog.includes(leakedSecretKey), "Secrets fragment keys must be redacted from core logs");
  assert(networkLog.includes("[redacted]"), "Credential redaction should remain visible in diagnostics");

  const rawSecret = "response-app-password";
  const rawToken = "response-poll-token";
  const rejectedHarness = createCoreHarness({
    fetchImpl: () => makeResponse(
      500,
      JSON.stringify({
        appPassword: rawSecret,
        pollToken: rawToken,
        loginName: "alice@example.test"
      })
    )
  });
  const rejectedFailure = await expectRejected(
    () => rejectedHarness.core.startLoginFlow("https://cloud.example.test"),
    "A rejected Login Flow start response must fail"
  );
  const rejectedLog = collectLogText(rejectedHarness.logs);
  assert(!rejectedFailure.message.includes(rawSecret), "Credential response bodies must not escape through errors");
  assert(!rejectedLog.includes(rawSecret), "Credential response bodies must not be logged");
  assert(!rejectedLog.includes(rawToken), "Poll tokens must not be logged");
}

async function checkPollDeadline(){
  const clock = { now: 0 };
  let bodyReads = 0;
  const harness = createCoreHarness({
    clock,
    fetchImpl: ({ insideTimeout }) => makeResponse(404, "", {
      text: async () => {
        assert(insideTimeout(), "Login Flow poll must read 404 response bodies inside runWithTimeout");
        bodyReads += 1;
        return "";
      }
    })
  });
  await expectRejected(
    () => harness.core.completeLoginFlow({
      pollEndpoint: "https://cloud.example.test/index.php/login/v2/poll",
      pollToken: "poll-secret",
      timeoutMs: 100,
      intervalMs: 60
    }),
    "Login Flow poll must stop at its total deadline"
  );
  assert(bodyReads === 2, "The poll loop should issue only requests that start before the deadline");
  assert(clock.now === 100, "The polling delay must not extend beyond the total deadline");
  assert(
    harness.timeoutCalls[0].options.timeoutMs === 100
      && harness.timeoutCalls[1].options.timeoutMs === 40,
    "Each poll request timeout must be capped by the remaining total deadline"
  );
  for (let index = 0; index < harness.requests.length; index++){
    assert(
      harness.requests[index].options.signal === harness.timeoutCalls[index].signal,
      "Every Login Flow poll request must receive its timeout signal"
    );
  }
}

function deferred(){
  let resolve;
  const promise = new Promise((complete, reject) => {
    const timer = setTimeout(() => reject(new Error("Options Login Flow test did not reach its expected stage")), 5000);
    resolve = (value) => { clearTimeout(timer); complete(value); };
  });
  return { promise, resolve };
}

async function createOptionsLoginHarness({ managed = {}, stored = {}, setup = false } = {}){
  const source = readText("options.js");
  const state = {
    stored: { ...stored }, writes: [], messages: [], permissions: [], closedTabs: [],
    statuses: [], logs: [], events: [], handlers: {}, permissionGranted: true,
    restartRequired: false, saveFailure: false, refreshPolicy: null
  };
  const element = (value = "") => ({
    value, disabled: false, checked: false, title: "", hidden: true, textContent: "",
    classList: { toggle(){} }, setAttribute(){}
  });
  let checkedMode = stored.authMode || "manual";
  const authRadios = ["manual", "loginFlow"].map((value) => ({
    value, disabled: false, title: "", parentElement: { title: "" },
    get checked(){ return checkedMode === value; },
    set checked(selected){ if (selected) checkedMode = value; }
  }));
  const pageListeners = {};
  const debugInput = element();
  const responses = {
    "options:loginFlowStart": {
      ok: true, loginUrl: "https://cloud.example.test/login/flow",
      pollEndpoint: "https://cloud.example.test/login/v2/poll", pollToken: "poll-token"
    },
    "options:loginFlowComplete": { ok: true, user: "verified-user", appPass: "verified-app-password" },
    "options:testConnection": { ok: true }
  };
  const context = {
    console, URL, authRadios, loginFlowInProgress: false,
    managedSetupPolicyReady: true, managedSetupPolicy: null,
    baseUrlInput: element(stored.baseUrl || ""),
    userInput: element(stored.user || ""), appPassInput: element(stored.appPass || ""),
    authBlock: element(), authModeManagedHint: element(),
    baseUrlManagedPolicyMarker: element(), baseUrlManagedPolicyTooltip: element(),
    loginFlowButton: element(), saveButton: element(), testButton: element(),
    OPTIONS_LOG_PREFIX: "[NCUI][Options]", i18n: (key) => key,
    getAdminControlledHint: () => "policy_admin_controlled_tooltip",
    localDefaultDraft: { ...stored }, dirtyLocalDefaultKeys: new Set(), defaultsSourceDirty: false,
    getDefaultsSourceState: () => ({ editable: true }),
    showStatus: (...args) => state.statuses.push(args),
    refreshBackendPolicyStatus: async (options) => {
      state.events.push("policy");
      if (state.refreshPolicy) await state.refreshPolicy(options);
    },
    refreshTalkSystemAddressbookState: async () => {},
    openLoginUrl: async () => { state.events.push("browser"); return true; },
    restartBackgroundForVfsDiscovery: async () => state.events.push("restart"),
    NCLogContext: { safeConsoleError: (...args) => state.logs.push(args) },
    NCHostPermissions: {
      ensureOriginPermissionInteractive: async (baseUrl, options) => {
        state.permissions.push({ baseUrl, ...options });
        return state.permissionGranted;
      }
    },
    NCVfsOptions: {
      save: async (options) => {
        state.events.push(options?.beforeSourceChange ? "vfs:before" : "vfs:after");
        return state.restartRequired;
      }
    },
    window: {
      location: { href: "moz-extension://test/options.html" + (setup ? "?authenticationRequired=1" : "") },
      addEventListener: (name, handler) => { pageListeners[name] = handler; }
    },
    document: {
      getElementById: (id) => id === "debugEnabled" ? debugInput : null,
      querySelector: () => authRadios.find((radio) => radio.checked)
    },
    browser: {
      storage: {
        managed: { get: async () => managed },
        local: {
          set: async (updates) => {
            if (state.saveFailure) throw new Error("options_status_save_failed");
            state.events.push("storage");
            state.writes.push({ ...updates });
            Object.assign(state.stored, updates);
          }
        }
      },
      runtime: {
        sendMessage: async (message) => {
          state.messages.push(message);
          state.events.push(message.type);
          return state.handlers[message.type]
            ? state.handlers[message.type](message)
            : responses[message.type];
        }
      },
      tabs: {
        getCurrent: async () => { state.events.push("tab:current"); return { id: 73 }; },
        remove: async (tabId) => { state.events.push("tab:close"); state.closedTabs.push(tabId); }
      }
    }
  };
  Object.assign(context, context.window);
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/textUtils.js", context);
  loadScript("modules/managedSetup.js", context);
  for (const [from, to] of [
    ["const authenticationRequired =", "const SYSTEM_ADDRESSBOOK_ADMIN_URL"],
    ["async function refreshManagedSetupPolicy(){", "function applyOptionPolicyBindings("],
    ["function getSelectedAuthMode(){", "function initTalkDefaultRoomTypePicker(){"],
    ["async function ensureOriginPermissionInteractive(", "async function openLoginUrl("],
    ["async function save(", "async function restartBackgroundForVfsDiscovery(){"],
    ["async function startLoginFlow(", null]
  ]){
    const start = source.indexOf(from);
    const end = to ? source.indexOf(to, start + from.length) : source.length;
    assert(start >= 0 && end > start, `Options section ${from} must remain present`);
    vm.runInContext(source.slice(start, end), context, { filename: "options.js" });
  }
  // Exercise the load tail without constructing unrelated Share/Talk controls.
  const loadStart = source.indexOf("async function load(){");
  const loadEnd = source.indexOf("\n}\n", loadStart) + 2;
  const loadAuthStart = source.indexOf('  setAuthMode(stored.authMode || "manual");', loadStart);
  assert(loadAuthStart > loadStart && loadEnd > loadAuthStart, "Options load must apply authentication and automatic setup at its end");
  vm.runInContext("async function finishOptionsLoad(stored){\n" + source.slice(loadAuthStart, loadEnd), context);
  await context.refreshManagedSetupPolicy();
  context.baseUrlInput.value = context.getEffectiveBaseUrl(context.baseUrlInput.value);
  context.setAuthMode(checkedMode);
  context.updateAuthModeUI();
  return {
    context, state, responses,
    closePage: () => pageListeners.pagehide(),
    finishLoad: () => context.finishOptionsLoad(state.stored)
  };
}

async function checkOptionsAuthModeControlsAndSaving(){
  for (const [managedValue, mode] of [["Manual", "manual"], ["LoginFlow", "loginFlow"], [null, "loginFlow"]]){
    const harness = await createOptionsLoginHarness({
      managed: { AuthMode: managedValue },
      stored: { baseUrl: "https://cloud.example.test", user: "saved-user", appPass: "saved-password", authMode: "manual" }
    });
    const { context, state } = harness;
    assert(context.getSelectedAuthMode() === mode, "Managed authentication must select the effective radio");
    assert(context.authRadios.every((radio) => radio.disabled), "Both managed authentication radios must be locked");
    assert(context.userInput.disabled === (mode !== "manual") && context.appPassInput.disabled === (mode !== "manual"), "Only managed Manual permits credential editing");
    assert(context.loginFlowButton.disabled === (mode !== "loginFlow"), "Login Flow remains available for the managed flow and invalid fallback");
    const expectedHint = managedValue === null ? "managed_auth_mode_invalid" : "policy_admin_controlled_tooltip";
    assert(context.authModeManagedHint.textContent === expectedHint && !context.authModeManagedHint.hidden, "Managed authentication needs the correct visible explanation");
    await context.save();
    assert(!Object.prototype.hasOwnProperty.call(state.writes[0], "authMode") && state.stored.authMode === "manual", "Saving a managed overlay must preserve the raw local authentication preference");
  }
  const unmanaged = await createOptionsLoginHarness({
    stored: { baseUrl: "https://cloud.example.test", user: "saved-user", appPass: "saved-password" }
  });
  await unmanaged.finishLoad();
  assert(unmanaged.context.getSelectedAuthMode() === "manual" && unmanaged.state.writes.length === 0, "An unset local mode stays Manual without an initialization write");
  assert(unmanaged.context.authRadios.every((radio) => !radio.disabled), "Unmanaged authentication radios remain editable");
  unmanaged.context.setAuthMode("loginFlow");
  await unmanaged.context.save();
  assert(unmanaged.state.stored.authMode === "loginFlow", "An explicit unmanaged save must persist the selected authentication mode");
  assert(Object.keys(unmanaged.state.writes[0]).sort().join(",") === "appPass,authMode,baseUrl,debugEnabled,user", "Credential saves must not materialize untouched defaults or an unset defaults source");
}

async function checkOptionsGuidedLogin(){
  const managed = { AuthMode: "LoginFlow", NextcloudUrl: "https://cloud.example.test" };
  const normal = await createOptionsLoginHarness({ managed });
  await normal.finishLoad();
  assert(normal.state.messages.length === 0, "Ordinary settings must not start managed Login Flow automatically");
  await normal.context.startLoginFlow();
  assert(normal.state.messages.some((message) => message.type === "options:testConnection"), "Manual browser login must verify the returned credentials");
  assert(normal.state.writes.length === 0 && normal.state.closedTabs.length === 0, "Ordinary settings must not auto-save or close after successful login");

  const setup = await createOptionsLoginHarness({ managed, setup: true });
  await setup.finishLoad();
  assert(setup.state.writes.length === 1 && setup.state.closedTabs.join(",") === "73", "Verified managed setup must save once and close only its own tab");
  assert(setup.state.stored.user === "verified-user" && setup.state.stored.appPass === "verified-app-password", "Guided setup must persist the verified credentials");
  assert(!Object.prototype.hasOwnProperty.call(setup.state.stored, "authMode"), "First managed setup must preserve an absent local authentication preference");
  assert(setup.state.permissions.every((request) => request.prompt === false), "Automatic start, verification, and guided save must not prompt for permissions");
  assert(setup.state.events.indexOf("options:testConnection") < setup.state.events.indexOf("storage")
    && setup.state.events.indexOf("storage") < setup.state.events.indexOf("tab:close"), "Verification and persistence must complete before the setup tab closes");

  const complete = await createOptionsLoginHarness({ managed, setup: true, stored: { user: "saved-user", appPass: "saved-password" } });
  await complete.finishLoad();
  assert(complete.state.messages.length === 0, "Existing complete credentials must suppress automatic setup login");
  for (const value of ["Manual", "invalid"]){
    const blocked = await createOptionsLoginHarness({ managed: { ...managed, AuthMode: value }, setup: true });
    await blocked.finishLoad();
    assert(blocked.state.messages.length === 0, "Managed Manual and invalid values must not auto-start");
    await blocked.context.startLoginFlow();
    assert(blocked.state.writes.length === 0 && blocked.state.closedTabs.length === 0, "Managed Manual and invalid values must not auto-save or close");
    assert(blocked.state.messages.some((message) => message.type === "options:testConnection") === (value === "invalid"), "Invalid policy permits an explicit verified login, while Manual must keep Login Flow disabled");
  }

  const noManagedUrl = await createOptionsLoginHarness({ managed: { AuthMode: "LoginFlow" }, setup: true, stored: { baseUrl: "https://cloud.example.test" } });
  await noManagedUrl.finishLoad();
  assert(noManagedUrl.state.messages.length === 0, "A local-only URL cannot trigger automatic login");
  noManagedUrl.state.restartRequired = true;
  await noManagedUrl.context.startLoginFlow();
  assert(noManagedUrl.state.writes.length === 1 && noManagedUrl.state.closedTabs.length === 1, "An explicit verified setup login may auto-save without a managed URL");
  assert(noManagedUrl.state.events.indexOf("storage") < noManagedUrl.state.events.indexOf("restart")
    && noManagedUrl.state.events.indexOf("restart") < noManagedUrl.state.events.indexOf("tab:close"), "Any required VFS background restart must precede closing the saved setup tab");
}

async function checkOptionsLoginFailuresAndRetry(){
  const managed = { AuthMode: "LoginFlow", NextcloudUrl: "https://cloud.example.test" };
  const automaticFailure = await createOptionsLoginHarness({ managed, setup: true });
  automaticFailure.responses["options:loginFlowStart"] = { ok: false, error: "start-failed" };
  await automaticFailure.finishLoad();
  assert(automaticFailure.state.messages.length === 1 && !automaticFailure.context.loginFlowButton.disabled, "A failed automatic attempt must stop once and leave only an explicit retry");
  const missingPermission = await createOptionsLoginHarness({ managed, setup: true });
  missingPermission.state.permissionGranted = false;
  await missingPermission.finishLoad();
  assert(missingPermission.state.permissions[0].prompt === false && missingPermission.state.messages.length === 0, "An automatic attempt without host permission must not prompt or start a request");
  assert(!missingPermission.context.loginFlowButton.disabled, "Missing permission must leave an explicit retry available");
  missingPermission.state.permissionGranted = true;
  await missingPermission.context.startLoginFlow();
  assert(missingPermission.state.permissions[1].prompt === true && missingPermission.state.writes.length === 1, "An explicit retry may prompt and then save verified setup credentials");

  for (const type of ["options:loginFlowStart", "options:loginFlowComplete", "options:testConnection"]){
    for (const reject of [false, true]){
      const harness = await createOptionsLoginHarness({ managed, setup: true });
      harness.state.handlers[type] = () => {
        if (reject) throw new Error("request-failed");
        return { ok: false, error: "request-failed" };
      };
      await harness.context.startLoginFlow();
      assert(harness.state.writes.length === 0 && harness.state.closedTabs.length === 0, `${type} failure must keep setup open without persistence`);
      assert(!harness.context.loginFlowButton.disabled && harness.context.loginFlowInProgress === false, "Failed login must release the busy state for explicit retry");
    }
  }
  const saveFailure = await createOptionsLoginHarness({ managed, setup: true });
  saveFailure.state.saveFailure = true;
  await saveFailure.context.startLoginFlow();
  assert(saveFailure.state.writes.length === 0 && saveFailure.state.closedTabs.length === 0, "Failed credential persistence must not close the setup tab");
  assert(saveFailure.state.statuses.some(([message]) => message === "options_status_save_failed"), "Persistence failure must remain visible");
}

async function checkOptionsLoginLifetime(){
  const managed = { AuthMode: "LoginFlow", NextcloudUrl: "https://cloud.example.test" };
  for (const type of ["options:loginFlowComplete", "options:testConnection", "policy"]){
    const harness = await createOptionsLoginHarness({ managed, setup: true });
    const entered = deferred();
    const pending = deferred();
    const pause = () => { entered.resolve(); return pending.promise; };
    if (type === "policy") harness.state.refreshPolicy = pause;
    else harness.state.handlers[type] = pause;
    const flow = harness.context.startLoginFlow();
    await entered.promise;
    const requestsBeforeDuplicate = harness.state.messages.length;
    await harness.context.startLoginFlow();
    assert(harness.state.messages.length === requestsBeforeDuplicate, "A busy options page must not start a duplicate Login Flow");
    harness.closePage();
    pending.resolve(harness.responses[type]);
    await flow;
    assert(harness.state.writes.length === 0 && harness.state.closedTabs.length === 0, `Closing setup during ${type} must prevent late save or tab removal`);
    assert(harness.context.loginFlowInProgress === false, "An unloaded page must still release its transient busy state");
  }
}

async function run(){
  await checkStartRequest();
  await checkCredentialLogging();
  await checkPollDeadline();
  await checkOptionsAuthModeControlsAndSaving();
  await checkOptionsGuidedLogin();
  await checkOptionsLoginFailuresAndRetry();
  await checkOptionsLoginLifetime();
  console.log("[OK] login-network-security-check passed");
}

run().catch((error) => {
  console.error("[FAIL] login-network-security-check", error);
  process.exitCode = 1;
});
