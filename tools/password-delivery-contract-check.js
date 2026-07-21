"use strict";

const vm = require("node:vm");
const { assert, loadScript } = require("./review-check-utils");

function loadDeliveryApi(){
  const context = {
    console,
    module: undefined,
    window: null,
    globalThis: null
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/policyState.js", context, "\nglobalThis.NCPolicyState = NCPolicyState;");
  loadScript("modules/sharePasswordDelivery.js", context);
  return context.NCSharePasswordDelivery;
}

function createStatus(modeValue, expireDays = 30){
  return {
    policyActive: true,
    policyDomains: {
      share: { available: true, active: true }
    },
    policy: {
      share: {
        share_send_password_mode: modeValue,
        share_secrets_expire_days: expireDays
      }
    },
    policyEditable: {
      share: {
        share_send_password_mode: true,
        share_secrets_expire_days: false
      }
    }
  };
}

function createMailboxParser(){
  const mailboxes = new Map([
    ["Alice Example <ALICE@example.test>", [{ name: "Alice Example", email: "ALICE@example.test" }]],
    ["alice@example.test", [{ email: "alice@example.test" }]],
    ["Carol Example <CAROL@example.test>", [{ name: "Carol Example", email: "CAROL@example.test" }]],
    ["carol@example.test", [{ email: "carol@example.test" }]],
    ["Copy <copy@example.test>", [{ name: "Copy", email: "copy@example.test" }]],
    ["copy@example.test", [{ email: "copy@example.test" }]],
    ["Wrong Copy <wrong-copy@example.test>", [{ name: "Wrong Copy", email: "wrong-copy@example.test" }]],
    ["right@example.test", [{ email: "right@example.test" }]],
    ["Right <right@example.test>", [{ name: "Right", email: "right@example.test" }]],
    ["wrong@example.test", [{ email: "wrong@example.test" }]],
    ["Blind <blind@example.test>", [{ name: "Blind", email: "blind@example.test" }]],
    ["blind@example.test", [{ email: "blind@example.test" }]],
    ["Other Blind <other-blind@example.test>", [{ name: "Other Blind", email: "other-blind@example.test" }]]
  ]);
  return async (value) => {
    const key = String(value || "");
    if (!mailboxes.has(key)){
      throw new Error(`Missing mailbox fixture: ${key}`);
    }
    return mailboxes.get(key);
  };
}

function createDispatchHarness(composeDetailsByProbe = []){
  const state = {
    beginNewCalls: [],
    errors: [],
    mailboxParseCalls: [],
    probeCalls: 0,
    removedTabIds: [],
    sendCalls: []
  };
  const parseMailboxString = createMailboxParser();
  const context = {
    browser: {
      compose: {
        async beginNew(details){
          state.beginNewCalls.push(details);
          return { id: 700 + state.beginNewCalls.length };
        },
        async getComposeDetails(){
          const index = Math.min(state.probeCalls, Math.max(0, composeDetailsByProbe.length - 1));
          state.probeCalls++;
          return composeDetailsByProbe[index] || {};
        },
        async sendMessage(tabId, options){
          state.sendCalls.push({ tabId, options });
        }
      },
      messengerUtilities: {
        async parseMailboxString(value){
          state.mailboxParseCalls.push(String(value || ""));
          return parseMailboxString(value);
        }
      },
      runtime: {
        getURL(path){
          return `moz-extension://test/${path}`;
        }
      },
      tabs: {
        async remove(tabId){
          state.removedTabIds.push(tabId);
        }
      }
    },
    bgI18n(key){
      return key;
    },
    clearTimeout,
    console: {
      debug(){},
      error(...args){
        state.errors.push(args);
      },
      log: console.log
    },
    L(){},
    module: undefined,
    Promise,
    setTimeout,
    async waitMs(){},
    window: null,
    globalThis: null
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/policyState.js", context, "\nglobalThis.NCPolicyState = NCPolicyState;");
  loadScript("modules/sharePasswordDelivery.js", context);
  loadScript(
    "modules/bgComposePasswordDispatch.js",
    context,
    "\nglobalThis.passwordDispatchTestApi = { waitForComposeAutoSendReady, sendSeparatePasswordMail };"
  );
  return {
    api: context.passwordDispatchTestApi,
    state
  };
}

async function expectFailure(promise, message){
  let caught = null;
  try{
    await promise;
  }catch(error){
    caught = error;
  }
  assert(caught, message);
  return caught;
}

async function run(){
  const delivery = loadDeliveryApi();

  assert(delivery.normalizeMode("secrets") === "secrets", "secrets mode should be accepted");
  assert(delivery.normalizeMode(" SECRETS ") === "secrets", "secrets mode should be case-insensitive");
  assert(delivery.normalizeMode("plain") === "plain", "plain mode should be accepted");
  assert(delivery.normalizeMode("other") === "plain", "Unknown mode should fall back to plain");

  assert(delivery.coerceMode(null, "secrets") === "secrets", "Missing mode should use fallback");
  assert(delivery.coerceMode("", "plain") === "plain", "Empty mode should use fallback");
  assert(delivery.coerceMode("secrets", "plain") === "secrets", "Explicit mode should override fallback");

  assert(delivery.clampSecretsExpireDays("0") === 1, "Secrets expiry should clamp to minimum");
  assert(delivery.clampSecretsExpireDays("366") === 365, "Secrets expiry should clamp to maximum");
  assert(delivery.clampSecretsExpireDays("abc") === 7, "Invalid expiry should use default");
  assert(delivery.coerceSecretsExpireDays(null, 14) === 14, "Missing expiry should use fallback");

  assert(delivery.isSecretsUnavailable(createStatus(null)) === true, "Explicit null mode from active backend should mean Secrets unavailable");
  assert(delivery.isSecretsUnavailable(createStatus("secrets")) === false, "Explicit secrets mode should be available");
  assert(delivery.isSecretsUnavailable({ ...createStatus(null), policyDomains: { share: { available: true, active: false } } }) === false, "Inactive policy domain should not block Secrets");
  assert(delivery.isSecretsUnavailable({ policyActive: true, policy: { share: {} }, policyEditable: { share: {} } }) === false, "Missing mode key should remain backward-compatible");

  assert(delivery.resolveSecretsExpireDays(createStatus("secrets", 21)) === 21, "Policy expiry should be used");
  assert(delivery.resolveSecretsExpireDays(createStatus("secrets", null)) === 7, "Null policy expiry should use default");
  assert(delivery.resolveSecretsExpireDays({ policy: { share: {} }, policyEditable: { share: {} } }) === 7, "Missing policy expiry key should use default");
  const equivalentDetails = {
    identityId: "identity-1",
    subject: "Password",
    to: [
      { type: "contact", id: "CONTACT-1" },
      "alice@example.test"
    ],
    cc: ["carol@example.test"],
    bcc: [{ type: "mailingList", id: "LIST-1" }]
  };
  const equivalentHarness = createDispatchHarness([equivalentDetails, equivalentDetails]);
  await equivalentHarness.api.waitForComposeAutoSendReady(71, {
    identityId: "identity-1",
    subject: "Password",
    to: [
      "Alice Example <ALICE@example.test>",
      { type: "CONTACT", id: "CONTACT-1" }
    ],
    cc: ["Carol Example <CAROL@example.test>"],
    bcc: [{ type: "mailingList", id: "LIST-1" }]
  });
  assert(equivalentHarness.state.probeCalls === 2, "A matching envelope should pass the initial and settled probes");
  assert(
    equivalentHarness.state.mailboxParseCalls.includes("Alice Example <ALICE@example.test>"),
    "Recipient strings should be parsed through messengerUtilities"
  );

  const opaqueIdHarness = createDispatchHarness([{
    ...equivalentDetails,
    to: [{ type: "contact", id: "contact-1" }, "alice@example.test"]
  }]);
  const opaqueIdMismatch = await expectFailure(
    opaqueIdHarness.api.waitForComposeAutoSendReady(78, {
      identityId: "identity-1",
      subject: "Password",
      to: [{ type: "CONTACT", id: "CONTACT-1" }, "alice@example.test"],
      cc: ["carol@example.test"],
      bcc: [{ type: "mailingList", id: "LIST-1" }]
    }),
    "Differently cased contact IDs should reject readiness"
  );
  assert(opaqueIdMismatch.message === "password_mail_compose_readiness_timeout", "Opaque contact IDs should be compared exactly");

  const changedBccDetails = {
    ...equivalentDetails,
    bcc: ["Other Blind <other-blind@example.test>"]
  };
  const settledMismatchHarness = createDispatchHarness([equivalentDetails, changedBccDetails]);
  const settledMismatch = await expectFailure(
    settledMismatchHarness.api.waitForComposeAutoSendReady(72, {
      identityId: "identity-1",
      subject: "Password",
      to: ["alice@example.test", { type: "contact", id: "CONTACT-1" }],
      cc: ["carol@example.test"],
      bcc: [{ type: "mailingList", id: "LIST-1" }]
    }),
    "A Bcc change during the settle tick should reject readiness"
  );
  assert(settledMismatch.message === "password_mail_compose_readiness_timeout", "A settled recipient mismatch should time out");

  const wrongCcHarness = createDispatchHarness([{
    identityId: "identity-1",
    subject: "Password",
    to: ["right@example.test"],
    cc: ["Wrong Copy <wrong-copy@example.test>"],
    bcc: ["blind@example.test"]
  }]);
  const wrongCc = await expectFailure(
    wrongCcHarness.api.waitForComposeAutoSendReady(73, {
      identityId: "identity-1",
      subject: "Password",
      to: ["Right <right@example.test>"],
      cc: ["Copy <copy@example.test>"],
      bcc: ["Blind <blind@example.test>"]
    }),
    "A same-sized but different Cc set should reject readiness"
  );
  assert(wrongCc.message === "password_mail_compose_readiness_timeout", "A Cc mismatch should time out");

  const ccBccOnlyHarness = createDispatchHarness([{
    identityId: "identity-1",
    subject: "Password",
    to: [],
    cc: [],
    bcc: []
  }]);
  const ccBccOnly = await expectFailure(
    ccBccOnlyHarness.api.waitForComposeAutoSendReady(74, {
      identityId: "identity-1",
      subject: "Password",
      to: [],
      cc: ["Copy <copy@example.test>"],
      bcc: ["Blind <blind@example.test>"]
    }),
    "Missing Cc and Bcc recipients should reject readiness when To is empty"
  );
  assert(ccBccOnly.message === "password_mail_compose_readiness_timeout", "Missing Cc and Bcc recipients should time out");

  const emptyHarness = createDispatchHarness([equivalentDetails]);
  const emptyEnvelope = await expectFailure(
    emptyHarness.api.waitForComposeAutoSendReady(75, {
      identityId: "identity-1",
      subject: "Password",
      to: [],
      cc: [],
      bcc: []
    }),
    "An empty recipient envelope should be rejected"
  );
  assert(emptyEnvelope.message === "password_mail_expected_recipients_empty", "An empty envelope should report its specific error");
  assert(emptyHarness.state.probeCalls === 0, "An empty envelope should fail before compose probing");

  const blockedSendHarness = createDispatchHarness([{
    identityId: "identity-1",
    subject: "sharing_password_mail_subject",
    to: ["wrong@example.test"],
    cc: [],
    bcc: []
  }]);
  await blockedSendHarness.api.sendSeparatePasswordMail(76, [{
    deliveryMode: "plain",
    identityId: "identity-1",
    to: ["right@example.test"],
    cc: [],
    bcc: [],
    html: "<p>Password</p>",
    plainText: "Password",
    isPlainText: false,
    shareLabel: ""
  }]);
  assert(blockedSendHarness.state.sendCalls.length === 0, "A failed readiness check must not call compose.sendMessage");
  assert(blockedSendHarness.state.beginNewCalls.length === 2, "A failed auto-send should open one manual fallback draft");
  assert(blockedSendHarness.state.removedTabIds.length === 1, "The rejected auto-send tab should be closed");

  console.log("[OK] password-delivery-contract-check passed");
}

run().catch((error) => {
  console.error("[FAIL] password delivery check", error);
  process.exitCode = 1;
});
