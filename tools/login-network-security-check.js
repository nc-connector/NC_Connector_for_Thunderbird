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

async function createOptionsLoginHarness({ managed = {}, stored = {}, setup = false, reauthenticate = false, activeTab = "general" } = {}){
  const source = readText("options.js");
  const state = {
    stored: { ...stored }, writes: [], messages: [], permissions: [], closedTabs: [],
    statuses: [], logs: [], events: [], handlers: {}, permissionGranted: true,
    confirmation: true, confirmations: [],
    restartRequired: false, saveFailure: false, refreshPolicy: null, activeTab
  };
  const element = (value = "") => ({
    value, disabled: false, checked: false, title: "", hidden: true, textContent: "",
    classList: { toggle(){} }, setAttribute(){}, focus(){}
  });
  let checkedMode = stored.authMode || "manual";
  const authRadios = ["manual", "loginFlow"].map((value) => ({
    value, disabled: false, title: "", parentElement: { title: "" },
    get checked(){ return checkedMode === value; },
    set checked(selected){ if (selected) checkedMode = value; }
  }));
  const pageListeners = {};
  const debugInput = element();
  const debugTabPanel = element();
  debugTabPanel.classList.contains = (name) => name === "active" && state.activeTab === "debug";
  const responses = {
    "options:loginFlowStart": {
      ok: true, loginUrl: "https://cloud.example.test/login/flow",
      pollEndpoint: "https://cloud.example.test/login/v2/poll", pollToken: "poll-token"
    },
    "options:loginFlowComplete": { ok: true, user: "verified-user", appPass: "verified-app-password" },
    "options:testConnection": { ok: true },
    "connection:commitVerified": { ok: true, state: { reason: "", retryAt: 0 } },
    "connection:getState": { ok: true, state: { reason: "", retryAt: 0 } },
    "connection:removeCredentials": { ok: true, state: { reason: "", retryAt: 0 } }
  };
  const context = {
    console, URL, authRadios, loginFlowInProgress: false,
    managedSetupPolicyReady: true, managedSetupPolicy: null,
    baseUrlInput: element(stored.baseUrl || ""),
    userInput: element(stored.user || ""), appPassInput: element(stored.appPass || ""),
    removeCredentialsButton: element(),
    authBlock: element(), authModeManagedHint: element(),
    connectionSetupNotice: element(), connectionSetupMessage: element(), connectionSetupHint: element(),
    policyWarningRow: element(), policyWarningText: element(), policyWarningAdminLink: element(),
    policyWarningReauthenticate: element(),
    runtimePolicyStatus: {},
    baseUrlManagedPolicyMarker: element(), baseUrlManagedPolicyTooltip: element(),
    loginFlowButton: element(), saveButton: element(), testButton: element(), debugTabPanel,
    OPTIONS_LOG_PREFIX: "[NCUI][Options]", i18n: (key) => key,
    getAdminControlledHint: () => "policy_admin_controlled_tooltip",
    localDefaultDraft: { ...stored }, dirtyLocalDefaultKeys: new Set(), defaultsSourceDirty: false,
    getDefaultsSourceState: () => ({ editable: true }),
    showStatus: (...args) => state.statuses.push(args),
    refreshBackendPolicyStatus: async (options) => {
      state.events.push("policy");
      if (state.refreshPolicy) await state.refreshPolicy(options);
      return responses["options:testConnection"];
    },
    refreshTalkSystemAddressbookState: async () => { state.events.push("addressbook"); },
    NCWizardPolicyUi: {
      applyPolicyWarningUi: ({ row }) => {
        state.events.push("policy:notice");
        row.hidden = false;
      },
      refreshConnectionWarningUi: async () => {}
    },
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
      location: { href: "moz-extension://test/options.html?" + new URLSearchParams({
        ...(setup ? { authenticationRequired: "1" } : {}),
        ...(reauthenticate ? { reauthenticate: "1" } : {})
      }) },
      addEventListener: (name, handler) => { pageListeners[name] = handler; },
      confirm: (message) => { state.confirmations.push(message); return state.confirmation; }
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
          const response = await (state.handlers[message.type]
            ? state.handlers[message.type](message)
            : responses[message.type]);
          if (message.type === "connection:removeCredentials" && response?.ok){
            delete state.stored.user;
            delete state.stored.appPass;
          }
          return response;
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
    ["function applyPolicyWarningUi(){", "async function refreshBackendPolicyStatus("],
    ["function getConnectionTestErrorMessage(", "\n/**"],
    ["async function refreshManagedSetupPolicy(){", "function applyOptionPolicyBindings("],
    ["function getSelectedAuthMode(){", "function initTalkDefaultRoomTypePicker(){"],
    ["async function ensureOriginPermissionInteractive(", "async function openLoginUrl("],
    ["async function save(", "async function restartBackgroundForVfsDiscovery(){"],
    ["async function removeSavedCredentials(){", "\nremoveCredentialsButton?.addEventListener"],
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
  const setupStart = source.indexOf("  managedConnectionSetup = authenticationRequired", loadStart);
  const setupEnd = source.indexOf("\n  if (sharingBaseInput)", setupStart);
  const debugLoadStart = source.indexOf('  document.getElementById("debugEnabled").checked = !!stored.debugEnabled;', loadStart);
  const debugLoadEnd = source.indexOf("\n", debugLoadStart);
  assert(debugLoadStart > loadStart && debugLoadEnd > debugLoadStart
    && debugLoadStart < source.indexOf("  await refreshManagedSetupPolicy();", loadStart),
    "Stored Debug logging must be shown even if the managed-policy read later fails");
  assert(loadAuthStart > loadStart && loadEnd > loadAuthStart && setupStart > loadStart && setupEnd > setupStart, "Options load must resolve first sign-in state and apply authentication");
  vm.runInContext("async function finishOptionsLoad(stored){\n"
    + source.slice(debugLoadStart, debugLoadEnd) + "\n"
    + 'const effectiveBaseUrl = getEffectiveBaseUrl(stored.baseUrl || "");\n'
    + source.slice(setupStart, setupEnd) + "\n" + source.slice(loadAuthStart, loadEnd), context);
  await context.refreshManagedSetupPolicy();
  context.baseUrlInput.value = context.getEffectiveBaseUrl(context.baseUrlInput.value);
  context.setAuthMode(checkedMode);
  context.updateAuthModeUI();
  return {
    context, state, responses, debugInput,
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
  assert(normal.context.connectionSetupNotice.hidden, "Ordinary settings must not show the action setup notice");
  await normal.context.startLoginFlow();
  assert(normal.state.messages.some((message) => message.type === "options:testConnection"), "Manual browser login must verify the returned credentials");
  assert(normal.state.writes.length === 0 && normal.state.closedTabs.length === 0, "Ordinary settings must not auto-save or close after successful login");

  const setup = await createOptionsLoginHarness({ managed, setup: true });
  await setup.finishLoad();
  setup.context.applyPolicyWarningUi();
  assert(setup.state.messages.length === 0 && setup.state.permissions.length === 0 && setup.state.writes.length === 0, "Opening managed setup must explain sign-in without starting requests or permission prompts");
  assert(!setup.context.connectionSetupNotice.hidden
    && setup.context.connectionSetupMessage.textContent === "options_setup_managed_message"
    && setup.context.connectionSetupHint.textContent === "options_setup_loginflow_hint", "Managed first sign-in must explain the installation and explicit Login Flow button");
  assert(setup.context.policyWarningRow.hidden, "Missing first-login credentials must not be shown as a backend refusal");
  const setupLogin = setup.context.startLoginFlow();
  assert(setup.state.permissions.length === 1 && setup.state.messages.length === 0, "The explicit Login Flow click must invoke its permission request before the first asynchronous network step");
  await setupLogin;
  assert(setup.state.writes.length === 1 && setup.state.closedTabs.length === 0, "Verified managed setup must save once and keep settings open");
  assert(setup.state.stored.user === "verified-user" && setup.state.stored.appPass === "verified-app-password", "Guided setup must persist the verified credentials");
  assert(!Object.prototype.hasOwnProperty.call(setup.state.stored, "authMode"), "First managed setup must preserve an absent local authentication preference");
  assert(setup.state.permissions[0].prompt === true && setup.state.permissions.slice(1).every((request) => request.prompt === false), "Only the explicit login click may request permissions; verification and saving must not prompt again");
  assert(setup.state.events.indexOf("options:testConnection") < setup.state.events.indexOf("storage")
    && setup.context.connectionSetupMessage.textContent === "options_setup_saved"
    && setup.context.connectionSetupHint.hidden, "Verification must precede saving, followed by the instruction to repeat the action");
  assert(!setup.context.policyWarningRow.hidden, "Saving credentials must restore genuine backend or Seat warnings");
  assert(setup.state.messages.every((message) => message.type.startsWith("options:") || message.type === "connection:commitVerified"), "Successful setup must not resume an original action");

  const complete = await createOptionsLoginHarness({ managed, setup: true, stored: { user: "saved-user", appPass: "saved-password" } });
  await complete.finishLoad();
  assert(complete.state.messages.length === 0 && complete.context.connectionSetupNotice.hidden, "Existing complete credentials must not show setup guidance or start login");
  for (const value of ["Manual", "invalid"]){
    const blocked = await createOptionsLoginHarness({ managed: { ...managed, AuthMode: value }, setup: true });
    await blocked.finishLoad();
    assert(blocked.state.messages.length === 0, "Managed Manual and invalid values must not auto-start");
    assert(blocked.context.connectionSetupHint.textContent === (value === "Manual" ? "options_setup_manual_hint" : "options_setup_loginflow_hint"), "The setup hint must describe the effective authentication method");
    await blocked.context.startLoginFlow();
    assert(blocked.state.writes.length === 0 && blocked.state.closedTabs.length === 0, "Managed Manual and invalid values must not auto-save or close");
    assert(blocked.state.messages.some((message) => message.type === "options:testConnection") === (value === "invalid"), "Invalid policy permits an explicit verified login, while Manual must keep Login Flow disabled");
    if (value === "Manual"){
      blocked.context.userInput.value = "manual-user";
      blocked.context.appPassInput.value = "manual-password";
      await blocked.context.runConnectionTest();
      await blocked.context.save();
      assert(blocked.state.stored.user === "manual-user" && blocked.state.stored.appPass === "manual-password"
        && blocked.context.connectionSetupMessage.textContent === "options_setup_saved"
        && blocked.state.closedTabs.length === 0, "Managed Manual must retain Test/Save and show the return instruction without closing settings");
    }
  }

  const noManagedUrl = await createOptionsLoginHarness({ managed: { AuthMode: "LoginFlow" }, setup: true, stored: { baseUrl: "https://cloud.example.test" } });
  await noManagedUrl.finishLoad();
  assert(noManagedUrl.state.messages.length === 0 && noManagedUrl.state.permissions.length === 0, "A local-only URL cannot trigger login without a click");
  noManagedUrl.state.restartRequired = true;
  await noManagedUrl.context.startLoginFlow();
  assert(noManagedUrl.state.writes.length === 1 && noManagedUrl.state.closedTabs.length === 0, "An explicit verified setup login may auto-save without a managed URL and keeps settings open");
  assert(noManagedUrl.state.events.indexOf("storage") < noManagedUrl.state.events.indexOf("restart")
    && noManagedUrl.context.connectionSetupMessage.textContent === "options_setup_saved", "Any required VFS background restart must follow saving without changing setup guidance");

  const unmanaged = await createOptionsLoginHarness({ setup: true, stored: { baseUrl: "https://cloud.example.test" } });
  await unmanaged.finishLoad();
  assert(unmanaged.context.connectionSetupNotice.hidden && unmanaged.state.messages.length === 0, "Unmanaged action setup must not show a managed-installation notice");
}

async function checkOptionsLoginFailuresAndRetry(){
  const managed = { AuthMode: "LoginFlow", NextcloudUrl: "https://cloud.example.test" };
  const missingPermission = await createOptionsLoginHarness({ managed, setup: true });
  missingPermission.state.permissionGranted = false;
  await missingPermission.finishLoad();
  assert(missingPermission.state.permissions.length === 0 && missingPermission.state.messages.length === 0, "Settings initialization must not request host permission");
  await missingPermission.context.startLoginFlow();
  assert(missingPermission.state.permissions[0].prompt === true && missingPermission.state.messages.length === 0, "Declining the explicit permission request must prevent network requests");
  assert(!missingPermission.context.loginFlowButton.disabled, "Missing permission must leave an explicit retry available");
  missingPermission.state.permissionGranted = true;
  await missingPermission.context.startLoginFlow();
  assert(missingPermission.state.permissions[1].prompt === true && missingPermission.state.writes.length === 1
    && missingPermission.state.closedTabs.length === 0, "An explicit retry may prompt and save verified setup credentials without closing settings");

  for (const type of ["options:loginFlowStart", "options:loginFlowComplete", "options:testConnection"]){
    for (const reject of [false, true]){
      const harness = await createOptionsLoginHarness({ managed, setup: true });
      await harness.finishLoad();
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
  await saveFailure.finishLoad();
  saveFailure.state.saveFailure = true;
  await saveFailure.context.startLoginFlow();
  assert(saveFailure.state.writes.length === 0 && saveFailure.state.closedTabs.length === 0, "Failed credential persistence must not close the setup tab");
  assert(saveFailure.state.statuses.some(([message]) => message === "options_status_save_failed"), "Persistence failure must remain visible");
}

async function checkOptionsLoginLifetime(){
  const managed = { AuthMode: "LoginFlow", NextcloudUrl: "https://cloud.example.test" };
  for (const type of ["options:loginFlowComplete", "options:testConnection", "policy"]){
    const harness = await createOptionsLoginHarness({ managed, setup: true });
    await harness.finishLoad();
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
    assert(harness.state.writes.length === 0 && harness.state.closedTabs.length === 0, `Closing setup during ${type} must prevent a late credential save`);
    assert(harness.context.loginFlowInProgress === false, "An unloaded page must still release its transient busy state");
  }
}

async function checkExplicitCredentialAuthentication(){
  const validAuth = "Basic " + Buffer.from("valid-user:valid-app-password").toString("base64");
  const harness = createCoreHarness({
    localStorage: { baseUrl: "https://cloud.example.test", user: "valid-user", appPass: "valid-app-password" },
    fetchImpl: ({ url, options }) => {
      // Model a retained session that would otherwise conceal incorrect Basic Auth.
      const authenticated = options.credentials !== "omit" || options.headers.Authorization === validAuth;
      if (!authenticated){
        return makeResponse(401, JSON.stringify({ ocs: { meta: { statuscode: 997, message: "Not logged in" } } }));
      }
      const data = url.includes("/capabilities")
        ? { version: { major: 35, minor: 0, micro: 1, string: "35.0.1" }, capabilities: {} }
        : { id: "valid-user" };
      return makeResponse(200, JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200 }, data } }));
    }
  });
  loadScript("modules/ocs.js", harness.context);
  const baseUrl = "https://cloud.example.test";
  const correct = await harness.core.testCredentials({ baseUrl, user: "valid-user", appPass: "valid-app-password" });
  assert(correct.ok && correct.userId === "valid-user", "Correct explicit credentials must authenticate and resolve the user");
  for (const [user, appPass] of [["imaginary-user", "imaginary-password"], ["valid-user", "wrong-password"]]){
    const before = harness.requests.length;
    const rejected = await harness.core.testCredentials({ baseUrl, user, appPass });
    assert(rejected.ok === false && rejected.code === "auth", "A retained session and cached snapshots must not validate invented credentials");
    assert(harness.requests.length > before, "Each credential test must make a fresh request, including a changed password for the same login");
  }
  const retried = await harness.core.testCredentials({ baseUrl, user: "valid-user", appPass: "valid-app-password" });
  assert(retried.ok, "Correcting credentials after a refusal must allow another successful login");
  for (const request of harness.requests){
    assert(request.options.credentials === "omit" && request.options.cache === "no-store", "Credential checks must exclude ambient authentication and cached responses");
    assert(request.options.headers.Authorization?.startsWith("Basic "), "Anonymous transport must retain the explicitly constructed authorization header");
  }

  const ocs = await harness.context.NCOcs.ocsRequest({
    url: baseUrl + "/ocs/v2.php/cloud/user?format=json",
    headers: { Authorization: validAuth }
  });
  assert(ocs.ok && harness.requests.at(-1).options.credentials === "omit", "Shared OCS requests must use explicit credentials without ambient authentication");
  assert(harness.requests.at(-1).options.headers.Authorization === validAuth, "OCS transport must not remove explicit account authorization");

  for (const file of [
    "modules/nccore.js", "modules/ocs.js", "modules/policyRuntime.js", "modules/talkAddressbook.js",
    "modules/nextcloudDav.js", "modules/nextcloudVfsStorage.js", "modules/fileLinkTransfer.js", "modules/fileLinkRootReservation.js"
  ]){
    const source = readText(file);
    const requests = source.match(/\bfetch\s*\(/g) || [];
    const isolated = source.match(/credentials:\s*"omit"/g) || [];
    assert(requests.length > 0 && requests.length === isolated.length, `${file}: every Nextcloud fetch must exclude ambient authentication`);
  }
}

async function checkRejectedCredentialSaving(){
  const source = readText("options.js");
  const start = source.indexOf("async function refreshBackendPolicyStatus(");
  const end = source.indexOf("\n/**", start);
  for (const managed of [{}, { AuthMode: "Manual", NextcloudUrl: "https://cloud.example.test" }]){
    for (const stored of [{}, { baseUrl: "https://cloud.example.test", user: "saved-user", appPass: "saved-password" }]){
      const harness = await createOptionsLoginHarness({ managed, stored, setup: true });
      const { context, state, responses } = harness;
      await harness.finishLoad();
      context.refreshLanguageOverrideSelects = () => {};
      context.applyPolicySettingsOverlay = () => {};
      vm.runInContext(source.slice(start, end), context, { filename: "options.js" });
      context.baseUrlInput.value = "https://cloud.example.test";
      context.userInput.value = "imaginary-user";
      context.appPassInput.value = "imaginary-password";
      context.localDefaultDraft.talkDefaultTitle = "Unsaved title";
      context.dirtyLocalDefaultKeys.add("talkDefaultTitle");
      const original = JSON.stringify(state.stored);
      for (const failure of [
        { ok: false, code: "auth", error: "Raw server authentication failure" },
        { ok: false, code: "network", error: "Connection failed" },
        null,
        "throw"
      ]){
        state.events.length = 0;
        state.statuses.length = 0;
        state.handlers["options:testConnection"] = () => {
          if (failure === "throw") throw new Error("Transport rejected");
          return failure;
        };
        await context.save();
        const expected = failure?.code === "auth" ? "options_test_failed_auth"
          : failure?.error || "options_test_failed";
        assert(state.statuses.at(-1)?.[0] === expected && state.statuses.at(-1)?.[1] === true, "Failed Save must display the localized authentication or connection error");
        assert(state.writes.length === 0 && JSON.stringify(state.stored) === original, "A rejected login must preserve the previously stored account and preferences");
        assert(!state.events.some((event) => event.startsWith("vfs:")), "A rejected login must not flush VFS edits or restart its runtime");
        assert(context.userInput.value === "imaginary-user" && context.appPassInput.value === "imaginary-password"
          && context.dirtyLocalDefaultKeys.has("talkDefaultTitle"), "A failed Save must retain the form draft for correction");
        assert(!vm.runInContext("managedConnectionSaved", context), "Rejected credentials must not complete managed setup");
      }
      state.handlers["options:testConnection"] = () => ({ ok: false, code: "auth", error: "Raw server failure" });
      await context.runConnectionTest();
      assert(state.statuses.at(-1)?.[0] === "options_test_failed_auth", "The Test button must use the same clear authentication message as Save");
      delete state.handlers["options:testConnection"];
      responses["options:testConnection"] = { ok: true, policyStatus: null };
      context.userInput.value = "corrected-user";
      context.appPassInput.value = "corrected-password";
      await context.save();
      assert(state.writes.length === 1 && state.stored.user === "corrected-user"
        && state.stored.appPass === "corrected-password", "A successful retry must save the newly verified account");
      assert(state.stored.talkDefaultTitle === "Unsaved title", "Pending local preferences may be saved after successful authentication");
      assert(state.statuses.at(-1)?.[0] !== "options_test_failed_auth", "A successful retry must replace the previous error with success");
    }
  }
}

async function checkDebugSavingWithoutConnection(){
  for (const managed of [{}, { AuthMode: "LoginFlow", NextcloudUrl: "https://cloud.example.test" }]){
    for (const stored of [{}, {
      baseUrl: "https://local.example.test", user: "saved-user", appPass: "saved-password",
      authMode: "manual", defaultsSource: "local", talkDefaultTitle: "Saved local title",
      sharingDefaultPassword: false, debugEnabled: false
    }]){
      for (const blockedState of ["none", "policy", "login"]){
        const harness = await createOptionsLoginHarness({ managed, stored, setup: true, activeTab: "debug" });
        const { context, state, debugInput } = harness;
        await harness.finishLoad();
        context.localDefaultDraft.talkDefaultTitle = "Unsaved title";
        context.localDefaultDraft.defaultsSource = "backend";
        context.dirtyLocalDefaultKeys.add("talkDefaultTitle");
        context.defaultsSourceDirty = true;
        if (blockedState === "policy") context.managedSetupPolicyReady = false;
        if (blockedState === "login") context.loginFlowInProgress = true;
        context.updateAuthModeUI();
        assert(!context.saveButton.disabled, `${blockedState}: Debug saving must remain available independently of credentials or login checks`);
        const savedBefore = JSON.stringify(state.stored);
        const setupSavedBefore = vm.runInContext("managedConnectionSaved", context);
        state.events.length = 0;
        for (const enabled of [true, false]){
          debugInput.checked = enabled;
          const restartRequired = await context.save();
          assert(restartRequired === false, "Saving Debug must not request a background restart");
          const updates = state.writes.at(-1);
          assert(Object.keys(updates).join(",") === "debugEnabled" && updates.debugEnabled === enabled,
            "The Debug tab must persist only the chosen logging flag");
          assert(state.events.join(",") === Array(state.writes.length).fill("storage").join(","),
            "Debug saving must not refresh policy, authenticate, or flush VFS defaults");
          assert(state.permissions.length === 0 && state.messages.length === 0,
            "Debug saving must not prompt for permission or send login/network messages");
          assert(vm.runInContext("managedConnectionSaved", context) === setupSavedBefore,
            "Debug saving must not mark a managed connection as saved");
          assert(context.dirtyLocalDefaultKeys.has("talkDefaultTitle") && context.defaultsSourceDirty,
            "Debug saving must leave pending connection and default edits untouched");
          assert(state.statuses.at(-1)[0] === "options_status_debug_saved",
            "Debug saving needs its own success message, not a connection-setup confirmation");
          const withoutDebug = { ...state.stored };
          const beforeWithoutDebug = JSON.parse(savedBefore);
          delete withoutDebug.debugEnabled;
          delete beforeWithoutDebug.debugEnabled;
          assert(JSON.stringify(withoutDebug) === JSON.stringify(beforeWithoutDebug),
            "Debug saving must preserve saved credentials and raw preferences, including absent keys");
        }
        state.activeTab = "general";
        context.updateAuthModeUI();
        const hasConnection = context.managedSetupPolicyReady && !!context.getEffectiveBaseUrl(context.baseUrlInput.value)
          && !!context.userInput.value && !!context.appPassInput.value;
        assert(context.saveButton.disabled === (!hasConnection || context.loginFlowInProgress),
          "Leaving Debug must restore the existing normal-tab Save restrictions");
      }
    }
  }

  const managed = { AuthMode: "LoginFlow", NextcloudUrl: "https://cloud.example.test" };
  const login = await createOptionsLoginHarness({ managed, setup: true });
  await login.finishLoad();
  const entered = deferred();
  const pending = deferred();
  login.state.handlers["options:loginFlowComplete"] = () => { entered.resolve(); return pending.promise; };
  const flow = login.context.startLoginFlow();
  await entered.promise;
  login.state.activeTab = "debug";
  login.context.updateAuthModeUI();
  assert(!login.context.saveButton.disabled, "Debug saving must remain possible while a Login Flow is pending");
  login.debugInput.checked = true;
  await login.context.save();
  assert(Object.keys(login.state.writes[0]).join(",") === "debugEnabled", "A pending login must not broaden a manual Debug save");
  assert(!vm.runInContext("managedConnectionSaved", login.context), "Debug saving during login must not complete setup early");
  pending.resolve(login.responses["options:loginFlowComplete"]);
  await flow;
  assert(login.state.writes.length === 2 && login.state.writes[1].user === "verified-user"
    && login.state.writes[1].appPass === "verified-app-password",
    "The later verified automatic login save must persist credentials even with the Debug tab selected");
  assert(vm.runInContext("managedConnectionSaved", login.context), "Only the completed credential save may finish setup");
  assert(login.state.closedTabs.length === 0, "Debug and verified login saves must keep the options tab open");
}

async function checkOptionsReauthentication(){
  const stored = {
    baseUrl: "https://cloud.example.test", user: "saved-user", appPass: "revoked-password"
  };
  for (const managed of [{}, { AuthMode: "Manual", NextcloudUrl: stored.baseUrl, NextcloudUrlLocked: true }, { AuthMode: "LoginFlow", NextcloudUrl: stored.baseUrl, NextcloudUrlLocked: true }]){
    const harness = await createOptionsLoginHarness({ managed, stored, reauthenticate: true });
    const { context, state } = harness;
    let focused = "";
    context.appPassInput.focus = () => { focused = "password"; };
    context.loginFlowButton.focus = () => { focused = "loginFlow"; };
    await harness.finishLoad();
    const manual = context.getSelectedAuthMode() === "manual";
    assert(context.appPassInput.value === (manual ? "" : stored.appPass), "Reauthentication clears only the manual password input");
    assert(state.stored.appPass === stored.appPass && state.writes.length === 0, "Opening sign-in settings must not erase the stored account");
    assert(context.userInput.value === stored.user && context.baseUrlInput.value === stored.baseUrl, "Reauthentication must retain the server and username");
    assert(focused === (manual ? "password" : "loginFlow"), "Reauthentication must focus the effective sign-in control");
    assert(state.statuses.at(-1)[0] === "connection_auth_required", "Sign-in settings must explain why reauthentication is needed");
    assert(!state.messages.some((message) => message.type === "options:loginFlowStart"), "Reauthentication must not automatically start Login Flow");
    if (managed.AuthMode){
      assert(context.authRadios.every((radio) => radio.disabled), "Reauthentication must preserve managed authentication locks");
      assert(context.baseUrlInput.disabled, "Reauthentication must preserve the managed URL lock");
    }
    context.appPassInput.value = "replacement-password";
    await context.runConnectionTest();
    assert(state.writes.length === 0 && !state.messages.some((message) => message.type === "connection:commitVerified"), "Testing credentials alone must not resume stored operations");
    await context.save();
    const commit = state.messages.find((message) => message.type === "connection:commitVerified");
    assert(commit?.payload.appPass === "replacement-password", "The verified save must commit the replacement account");
    assert(state.events.indexOf("storage") < state.events.indexOf("connection:commitVerified"), "Stored-account recovery must follow the successful storage write");
  }
  const fresh = await createOptionsLoginHarness({ reauthenticate: true });
  await fresh.finishLoad();
  assert(!fresh.state.statuses.some(([message]) => message === "connection_auth_required"), "An unconfigured profile must not be labelled as an expired sign-in");
}

async function checkOptionsCredentialRemoval(){
  const stored = {
    baseUrl: "https://cloud.example.test", user: "saved-user", appPass: "saved-password",
    sharingDefaultShareName: "My share", debugEnabled: true, cleanupPending: ["owned-room"]
  };
  for (const managed of [{}, { AuthMode: "Manual", NextcloudUrl: stored.baseUrl, NextcloudUrlLocked: true }, { AuthMode: "LoginFlow", NextcloudUrl: stored.baseUrl, NextcloudUrlLocked: true }]){
    const harness = await createOptionsLoginHarness({ managed, stored });
    const { context, state } = harness;
    await harness.finishLoad();
    const effectiveMode = context.getSelectedAuthMode();
    const urlLocked = context.baseUrlInput.disabled;
    const authLocked = context.authRadios.map((radio) => radio.disabled);
    context.localDefaultDraft.sharingDefaultShareName = "Unsaved preference";
    context.dirtyLocalDefaultKeys.add("sharingDefaultShareName");
    state.confirmation = false;
    assert(await context.removeSavedCredentials() === false, "Cancelling credential removal must stop before mutation");
    assert(state.messages.length === 0 && state.stored.appPass === stored.appPass, "Cancelled removal must preserve the saved account");
    assert(state.confirmations[0] === "options_remove_credentials_confirm", "Credential removal requires a localized confirmation");
    state.confirmation = true;
    harness.responses["connection:removeCredentials"] = { ok: false, error: "options_remove_credentials_busy" };
    assert(await context.removeSavedCredentials() === false, "Busy or failed removal must remain retryable");
    assert(context.userInput.value === stored.user && context.appPassInput.value === stored.appPass
      && state.stored.appPass === stored.appPass, "Failed removal must preserve saved credentials and the form");
    assert(state.statuses.at(-1)[0] === "options_remove_credentials_busy", "Busy removal must explain the action needed");
    assert(!state.events.includes("policy") && !state.events.includes("addressbook"), "Failed removal must not refresh using an unchanged account");
    const pending = deferred();
    state.handlers["connection:removeCredentials"] = () => pending.promise;
    const removal = context.removeSavedCredentials();
    assert(context.removeCredentialsButton.disabled && context.testButton.disabled
      && context.saveButton.disabled && context.loginFlowButton.disabled, "Removal in progress must prevent concurrent connection changes");
    pending.resolve({ ok: true, state: { reason: "", retryAt: 0 } });
    assert(await removal, "Confirmed credential removal must finish successfully");
    assert(!Object.hasOwn(state.stored, "user") && !Object.hasOwn(state.stored, "appPass"), "Only the removal API should erase stored credentials");
    assert(context.userInput.value === "" && context.appPassInput.value === "", "Successful removal must clear the credential inputs");
    assert(context.baseUrlInput.value === stored.baseUrl && state.stored.baseUrl === stored.baseUrl, "Removal must preserve the configured server");
    assert(state.stored.sharingDefaultShareName === stored.sharingDefaultShareName && state.stored.debugEnabled
      && JSON.stringify(state.stored.cleanupPending) === JSON.stringify(stored.cleanupPending), "Removal must retain defaults, diagnostics and cleanup ownership");
    assert(context.localDefaultDraft.sharingDefaultShareName === "Unsaved preference"
      && context.dirtyLocalDefaultKeys.has("sharingDefaultShareName"), "Removal must not discard or save unrelated pending preferences");
    assert(context.getSelectedAuthMode() === effectiveMode && context.baseUrlInput.disabled === urlLocked
      && context.authRadios.every((radio, index) => radio.disabled === authLocked[index]), "Credential removal must retain effective authentication and managed locks");
    assert(!state.writes.length && state.messages.every((message) => message.type === "connection:removeCredentials"), "Removal must not save settings, launch login or resume an action");
    assert(state.events.includes("policy") && state.events.includes("addressbook"), "Successful removal must refresh missing-account UI");
    assert(state.statuses.at(-1)[0] === "options_remove_credentials_success", "Successful removal must explain that a new sign-in is needed");
    if (managed.AuthMode){
      assert(!context.connectionSetupNotice.hidden && context.connectionSetupMessage.textContent === "options_setup_managed_message", "Managed removal must restore first-sign-in guidance instead of a Seat refusal");
    }
    context.loginFlowInProgress = true;
    context.updateAuthModeUI();
    const before = state.messages.length;
    assert(context.removeCredentialsButton.disabled, "Credential removal must be disabled during Login Flow");
    assert(await context.removeSavedCredentials() === false && state.messages.length === before, "An ongoing Login Flow must not race credential removal");
  }
  for (const operation of ["save", "runConnectionTest"]){
    const harness = await createOptionsLoginHarness({ stored });
    const { context, state } = harness;
    const entered = deferred();
    const pending = deferred();
    if (operation === "save"){
      state.refreshPolicy = () => { entered.resolve(); return pending.promise; };
    }else{
      state.handlers["options:testConnection"] = () => { entered.resolve(); return pending.promise; };
    }
    const request = context[operation]();
    await entered.promise;
    assert(context.removeCredentialsButton.disabled, `${operation} must disable credential removal until completion`);
    const before = state.messages.length;
    assert(await context.removeSavedCredentials() === false && state.messages.length === before
      && !state.confirmations.length, `Credential removal must not race a pending ${operation}`);
    pending.resolve({ ok: true });
    await request;
    assert(!context.removeCredentialsButton.disabled, `${operation} must release the credential-removal lock`);
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
  await checkExplicitCredentialAuthentication();
  await checkRejectedCredentialSaving();
  await checkDebugSavingWithoutConnection();
  await checkOptionsReauthentication();
  await checkOptionsCredentialRemoval();
  console.log("[OK] login-network-security-check passed");
}

run().catch((error) => {
  console.error("[FAIL] login-network-security-check", error);
  process.exitCode = 1;
});
