"use strict";

const vm = require("node:vm");
const { assert, readText } = require("./review-check-utils");

function createDeferred(){
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(){
  const composeDrafts = [];
  const sendCalls = [];
  const notifications = [];
  const removedTabs = [];
  let beginNewFails = false;
  let beginNewFailureSequence = [];
  let nextSendPromise = Promise.resolve();
  let runtimeId = 0;
  const browser = {
    accounts: {
      async list(){
        return [];
      }
    },
    compose: {
      async beginNew(details){
        const sequenceFailure = beginNewFailureSequence.length
          ? beginNewFailureSequence.shift()
          : null;
        if (sequenceFailure === true || beginNewFails){
          throw new Error("begin_new_failed");
        }
        composeDrafts.push(details);
        return { id: 80 + composeDrafts.length };
      },
      sendMessage(tabId, options){
        sendCalls.push({ tabId, options });
        return nextSendPromise;
      },
      async getComposeDetails(){
        return {
          identityId: "identity-1",
          from: "Sender <sender@example.test>",
          to: ["user@example.test"],
          cc: [],
          bcc: [],
          isPlainText: false,
          deliveryFormat: "auto"
        };
      }
    },
    identities: {
      async list(){
        return [];
      }
    },
    messengerUtilities: {
      async parseMailboxString(value){
        const raw = String(value || "").trim();
        const angleMatch = raw.match(/<([^>]+)>/);
        return [{
          name: "",
          email: (angleMatch?.[1] || raw).trim()
        }];
      }
    },
    notifications: {
      async create(id, details){
        notifications.push({ id, details });
      }
    },
    runtime: {
      getURL(path){
        return `moz-extension://test/${path}`;
      }
    },
    tabs: {
      async remove(tabId){
        removedTabs.push(tabId);
      }
    }
  };
  const context = {
    browser,
    console: {
      error(){}
    },
    L(){},
    createSecureRuntimeId(){
      runtimeId += 1;
      return `password-registration-${runtimeId}`;
    },
    bgI18n(key, substitutions){
      const values = Array.isArray(substitutions) ? substitutions.join(",") : "";
      return values ? `${key}:${values}` : key;
    },
    NCTalkTextUtils: {
      escapeHtml(value){
        return String(value || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }
    },
    NCSharePasswordDelivery: {
      MODE_PLAIN: "plain",
      MODE_SECRETS: "secrets",
      clampSecretsExpireDays(value){
        return Number(value) || 7;
      },
      coerceMode(value, fallback){
        return value === "secrets" ? "secrets" : fallback;
      }
    },
    NCPolicyRuntime: {
      async getPolicyStatus(){
        return { entitled: true };
      }
    },
    NCPolicyState: {
      hasSeatEntitlement(status){
        return status?.entitled === true;
      }
    },
    NCSecrets: {
      async createSecretLink(){
        return {
          shareUrl: "https://cloud.example.test/apps/secrets/s/secret-token",
          uuid: "secret-id",
          expires: 1
        };
      }
    },
    NCSharing: {
      async buildHtmlBlock(){
        return "<p>Prepared Secrets link</p>";
      },
      async buildPlainTextBlock(){
        return "Prepared Secrets link";
      }
    },
    NCEmailSignature: {
      async applyAndWait(){
        return {
          ok: false,
          error: "signature_apply_failed"
        };
      }
    },
    normalizeComposeShareCleanupFolderInfo(folderInfo){
      return folderInfo?.relativeFolder ? { ...folderInfo } : null;
    },
    PASSWORD_MAIL_DISPATCH_BY_TAB: new Map(),
    Promise,
    Map,
    Set,
    clearTimeout,
    setTimeout
  };
  vm.createContext(context);
  vm.runInContext(readText("modules/bgComposePasswordDispatch.js"), context, {
    filename: "modules/bgComposePasswordDispatch.js"
  });
  return {
    context,
    composeDrafts,
    sendCalls,
    notifications,
    removedTabs,
    setBeginNewFails(value){
      beginNewFails = value;
    },
    setBeginNewFailureSequence(value){
      beginNewFails = false;
      beginNewFailureSequence = Array.isArray(value) ? value.slice() : [];
    },
    setSendPromise(value){
      nextSendPromise = value;
    }
  };
}

function createDispatch(overrides = {}){
  return {
    shareLabel: "Project",
    shareUrl: "https://cloud.example.test/s/token",
    shareId: "share-1",
    folderInfo: {
      relativeFolder: "FileLink/Project",
      folderName: "Project"
    },
    password: "secret",
    deliveryMode: "plain",
    html: "<p>Password</p>",
    plainText: "##################################################\nPassword\n##################################################",
    isPlainText: false,
    to: ["user@example.test"],
    cc: [],
    bcc: [],
    identityId: "identity-1",
    from: "Sender <sender@example.test>",
    fromEmail: "sender@example.test",
    ...overrides
  };
}

async function run(){
  const harness = createHarness();
  const duplicateSecrets = createDispatch({
    deliveryMode: "secrets",
    to: ["same@example.test"],
    cc: ["same@example.test"],
    bcc: ["same@example.test"]
  });
  const expanded = await harness.context.expandSeparatePasswordDispatchQueue([duplicateSecrets]);
  assert(expanded.length === 1, "Secrets recipient must be deduplicated across To/Cc/Bcc");
  assert(expanded[0].to.length === 1, "First recipient occurrence must keep To precedence");
  assert(expanded[0].cc.length === 0 && expanded[0].bcc.length === 0, "Duplicate recipient fields must be empty");
  const mailboxDuplicate = await harness.context.expandSeparatePasswordDispatchQueue([
    createDispatch({
      deliveryMode: "secrets",
      to: ["User <same@example.test>"],
      cc: ["same@example.test"]
    })
  ]);
  assert(
    mailboxDuplicate.length === 1 && mailboxDuplicate[0].to[0] === "same@example.test",
    "Secrets recipient deduplication must use parsed mailbox addresses"
  );
  const plainDuplicate = await harness.context.expandSeparatePasswordDispatchQueue([
    createDispatch({
      deliveryMode: "plain",
      to: ["User <same@example.test>"],
      cc: ["same@example.test", { id: "contact-1", type: "contact" }],
      bcc: [{ id: "contact-1", type: "contact" }, "other@example.test"]
    })
  ]);
  assert(
    plainDuplicate.length === 1
      && plainDuplicate[0].to.length === 1
      && plainDuplicate[0].cc.length === 1
      && plainDuplicate[0].bcc.length === 1,
    "Plain delivery must deduplicate globally with To, Cc, Bcc precedence"
  );
  assert(
    harness.context.buildSecretsTitle(createDispatch({ shareLabel: "Quarterly report" }))
      === "NCC Quarterly report",
    "Secrets title must use the user-visible share label"
  );
  assert(
    harness.context.buildSecretsTitle(createDispatch({ shareLabel: "", folderInfo: null }))
      === "NCC share password",
    "Secrets title must keep Secrets delivery without folder metadata"
  );

  const registration = await harness.context.registerSeparatePasswordMailDispatch(
    20,
    createDispatch()
  );
  const duplicateRegistration = await harness.context.registerSeparatePasswordMailDispatch(
    20,
    createDispatch()
  );
  assert(registration.registrationId, "Password dispatch registration must return an id");
  assert(
    duplicateRegistration.registrationId === registration.registrationId
      && duplicateRegistration.duplicate === true,
    "Repeated registration must return the existing id"
  );
  assert(
    harness.context.PASSWORD_MAIL_DISPATCH_BY_TAB.get(20).length === 1,
    "Repeated password registration must not duplicate the queue"
  );
  assert(
    harness.context.unregisterSeparatePasswordMailDispatch(
      20,
      registration.registrationId,
      "test_rollback"
    ) === true,
    "Password dispatch rollback must remove its registration"
  );
  assert(
    harness.context.PASSWORD_MAIL_DISPATCH_BY_TAB.has(20) === false,
    "Password dispatch rollback must clear an empty tab queue"
  );
  const firstUnique = await harness.context.registerSeparatePasswordMailDispatch(
    23,
    createDispatch({ shareId: "share-a", shareUrl: "https://cloud.example.test/s/a" })
  );
  const secondUnique = await harness.context.registerSeparatePasswordMailDispatch(
    23,
    createDispatch({ shareId: "share-b", shareUrl: "https://cloud.example.test/s/b" })
  );
  assert(
    firstUnique.registrationId !== secondUnique.registrationId,
    "Distinct dispatch registrations must use distinct runtime ids"
  );
  assert(
    harness.context.unregisterSeparatePasswordMailDispatch(
      23,
      secondUnique.registrationId,
      "second_rollback"
    ) === true
      && harness.context.PASSWORD_MAIL_DISPATCH_BY_TAB.get(23)?.[0]?.registrationId
        === firstUnique.registrationId,
    "Rolling back one registration must retain a pre-existing dispatch"
  );

  await harness.context.stageSeparatePasswordMailForSendLater(
    21,
    [createDispatch()]
  );
  assert(harness.composeDrafts.length === 1, "sendLater must create one manual password draft");
  assert(harness.sendCalls.length === 0, "sendLater staging must not call compose.sendMessage");
  assert(
    harness.composeDrafts[0].body.includes("sharing_password_mail_send_later_notice"),
    "Queued-mail password draft must contain the wait-for-primary notice"
  );
  assert(
    harness.notifications.some((entry) => {
      return entry.details.message.startsWith("sharing_password_mail_notify_send_later_manual_required");
    }),
    "sendLater must show the dedicated manual-send notification"
  );
  await harness.context.stageSeparatePasswordMailForSendLater(
    21,
    [createDispatch({
      shareId: "share-2",
      shareUrl: "https://cloud.example.test/s/token-2",
      deliveryMode: "secrets",
      to: ["secret-user@example.test"]
    })]
  );
  assert(
    harness.composeDrafts[1].body.includes("Prepared Secrets link"),
    "Queued-mail manual draft must preserve Secrets delivery"
  );

  const failedSendLater = createHarness();
  failedSendLater.setBeginNewFails(true);
  const failedSendLaterResult = await failedSendLater.context
    .stageSeparatePasswordMailForSendLater(
      24,
      [createDispatch({ shareId: "share-send-later-failed" })]
    );
  const retainedRecovery = vm.runInContext(
    "PASSWORD_MAIL_RECOVERY_BY_SOURCE_TAB.get(24)",
    failedSendLater.context
  );
  assert(
    failedSendLaterResult.failedQueue.length === 1
      && retainedRecovery?.queue.length === 1,
    "Failed sendLater draft creation must retain its queue for session retry"
  );
  assert(
    failedSendLater.notifications.some((entry) => {
      return entry.details.message.startsWith(
        "sharing_password_mail_notify_failure"
      );
    }),
    "Failed sendLater draft creation must show a failure notification"
  );
  assert(
    failedSendLater.notifications.every((entry) => {
      return !entry.details.message.startsWith(
        "sharing_password_mail_notify_send_later_manual_required"
      );
    }),
    "sendLater must not claim a manual draft exists when beginNew rejected"
  );
  clearTimeout(retainedRecovery.timerId);
  retainedRecovery.timerId = null;

  const failedReplacement = createHarness();
  failedReplacement.setBeginNewFailureSequence([false, true]);
  await failedReplacement.context.sendSeparatePasswordMail(
    25,
    [createDispatch({ shareId: "share-replacement-failed" })],
    "sendNow"
  );
  assert(
    failedReplacement.composeDrafts.length === 1,
    "Failed replacement beginNew must keep the populated auto-send compose"
  );
  assert(
    failedReplacement.removedTabs.length === 0,
    "Populated auto-send compose must not close before replacement opens"
  );
  assert(
    failedReplacement.notifications.some((entry) => {
      return entry.details.message.startsWith(
        "sharing_password_mail_notify_failure"
      );
    }),
    "Failed replacement beginNew must show a failure notification"
  );
  assert(
    failedReplacement.notifications.every((entry) => {
      return !entry.details.message.startsWith(
        "sharing_password_mail_notify_manual_required"
      );
    }),
    "Failed replacement beginNew must not claim another draft was opened"
  );

  const pendingSend = createDeferred();
  harness.setSendPromise(pendingSend.promise);
  const draftCountBeforePending = harness.composeDrafts.length;
  const pendingResult = await harness.context.sendComposeWithTimeout(91, "sendNow", 1);
  assert(pendingResult.status === "pending", "Timed-out password send must enter pending state");
  assert(
    harness.composeDrafts.length === draftCountBeforePending,
    "Pending send must not create a duplicate fallback draft"
  );
  pendingSend.resolve({ mode: "sendNow" });
  await pendingResult.completion;

  const failureHarness = createHarness();
  failureHarness.setBeginNewFails(true);
  await failureHarness.context.sendSeparatePasswordMail(
    22,
    [createDispatch({
      identityId: "",
      from: "",
      fromEmail: ""
    })],
    "sendNow"
  );
  assert(
    failureHarness.notifications.some((entry) => {
      return entry.details.message.startsWith("sharing_password_mail_notify_failure");
    }),
    "Failed manual fallback must always show a failure notification"
  );

  const source = readText("modules/bgComposePasswordDispatch.js");
  const signatureIndex = source.indexOf("NCEmailSignature.applyAndWait(");
  const readinessIndex = source.indexOf("await waitForComposeAutoSendReady(", signatureIndex);
  const sendIndex = source.indexOf("await sendComposeWithTimeout(", readinessIndex);
  assert(signatureIndex >= 0, "Password auto-send must wait for signature completion");
  assert(readinessIndex > signatureIndex, "Compose readiness must be rechecked after signature completion");
  assert(sendIndex > readinessIndex, "Password mail must send only after signature and readiness checks");

  console.log("[OK] password-dispatch-regression-check passed");
}

run().catch((error) => {
  console.error("[FAIL] password-dispatch-regression-check", error);
  process.exitCode = 1;
});
