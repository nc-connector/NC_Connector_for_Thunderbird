"use strict";

const vm = require("node:vm");
const { assert, readText } = require("./review-check-utils");

class FakeText {
  constructor(value){
    this.nodeType = 3;
    this.data = String(value || "");
    this.parentNode = null;
  }
}

class FakeElement {
  constructor(tagName){
    this.nodeType = 1;
    this.tagName = String(tagName || "div").toLowerCase();
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.className = "";
    this.style = {};
  }

  appendChild(node){
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, reference){
    node.parentNode = this;
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index < 0){
      this.childNodes.push(node);
    }else{
      this.childNodes.splice(index, 0, node);
    }
    return node;
  }

  remove(){
    if (!this.parentNode){
      return;
    }
    const index = this.parentNode.childNodes.indexOf(this);
    if (index >= 0){
      this.parentNode.childNodes.splice(index, 1);
    }
    this.parentNode = null;
  }

  setAttribute(name, value){
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name){
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  closest(){
    return null;
  }

  contains(node){
    return this === node || this.childNodes.some((child) => child?.contains?.(node));
  }

  compareDocumentPosition(){
    return 0;
  }

  focus(){}

  set textContent(value){
    this.childNodes = [];
    const text = String(value || "");
    if (text){
      this.appendChild(new FakeText(text));
    }
  }

  get textContent(){
    return this.childNodes.map((node) => node.nodeType === 3 ? node.data : node.textContent).join("");
  }
}

function serializeNode(node){
  if (node?.nodeType === 3){
    return node.data;
  }
  const classAttribute = node?.className ? ` class="${node.className}"` : "";
  const attributes = Array.from(node?.attributes || [])
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  const children = Array.from(node?.childNodes || []).map(serializeNode).join("");
  return `<${node.tagName}${classAttribute}${attributes}>${children}</${node.tagName}>`;
}

function listDescendants(root){
  const elements = [];
  for (const child of root.childNodes){
    if (child?.nodeType !== 1){
      continue;
    }
    elements.push(child, ...listDescendants(child));
  }
  return elements;
}

function matchesSelector(element, selector){
  if (selector === '[data-nc-connector-signature="true"]'){
    return element.getAttribute("data-nc-connector-signature") === "true";
  }
  if (selector === '[data-nc-connector-signature-spacer="true"]'){
    return element.getAttribute("data-nc-connector-signature-spacer") === "true";
  }
  if (selector === '.moz-signature:not([data-nc-connector-signature="true"]), [data-signature-switch-id]'){
    const classes = String(element.className || "").split(/\s+/).filter(Boolean);
    return (classes.includes("moz-signature") && element.getAttribute("data-nc-connector-signature") !== "true")
      || element.getAttribute("data-signature-switch-id") !== null;
  }
  return false;
}

function createScheduler(){
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay){
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id){
      tasks.delete(id);
    },
    advance(delay){
      const target = now + Math.max(0, Number(delay) || 0);
      while (true){
        const due = Array.from(tasks.entries())
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due){
          break;
        }
        const [id, task] = due;
        tasks.delete(id);
        now = task.at;
        task.callback();
      }
      now = target;
    }
  };
}

function createHarness(){
  const scheduler = createScheduler();
  const body = new FakeElement("body");
  const observers = [];
  const messageListeners = [];
  const unloadListeners = [];

  class FakeMutationObserver {
    constructor(callback){
      this.callback = callback;
      this.active = false;
      this.options = null;
      observers.push(this);
    }

    observe(target, options){
      this.target = target;
      this.options = options;
      this.active = true;
    }

    disconnect(){
      this.active = false;
    }

    trigger(){
      if (this.active){
        this.callback([]);
      }
    }
  }

  const document = {
    body,
    documentElement: body,
    createElement: (tagName) => new FakeElement(tagName),
    importNode: (node) => node,
    querySelectorAll: (selector) => listDescendants(body).filter((element) => matchesSelector(element, selector)),
    querySelector: () => null,
    createRange: () => ({ setStart(){}, collapse(){} })
  };
  const context = {
    browser: {
      runtime: {
        onMessage: {
          addListener(listener){
            messageListeners.push(listener);
          }
        }
      }
    },
    console: {
      debug(){},
      error: console.error,
      log: console.log
    },
    document,
    MutationObserver: FakeMutationObserver,
    XMLSerializer: class {
      serializeToString(node){
        return serializeNode(node);
      }
    },
    DOMParser: class {
      parseFromString(){
        return { body: new FakeElement("body") };
      }
    },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    Promise,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    addEventListener(type, listener){
      if (type === "unload"){
        unloadListeners.push(listener);
      }
    },
    getSelection: () => ({ removeAllRanges(){}, addRange(){} }),
    globalThis: null,
    window: null
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readText("ui/signatureCompose.js"), context, { filename: "ui/signatureCompose.js" });

  return {
    body,
    document,
    scheduler,
    observers,
    messageListener: messageListeners[0],
    unloadListeners
  };
}

function createDeferred(){
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createEventChannel(){
  const listeners = [];
  return {
    listeners,
    addListener(listener){
      listeners.push(listener);
    }
  };
}

function wait(delayMs){
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForCondition(predicate, failureMessage, timeoutMs = 2000){
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs){
    if (predicate()){
      return;
    }
    await wait(10);
  }
  throw new Error(failureMessage);
}

function createBackgroundSignatureHarness({ initialIdentityId, pauseFirstPing = false }){
  const tabId = 41;
  const firstPolicyStarted = createDeferred();
  const firstPolicyRelease = createDeferred();
  const firstPingStarted = createDeferred();
  const firstPingRelease = createDeferred();
  const tabCreated = createEventChannel();
  const tabRemoved = createEventChannel();
  const windowCreated = createEventChannel();
  const identityChanged = createEventChannel();
  const applyMessages = [];
  const logs = [];
  const errors = [];
  let policyCallCount = 0;
  let pingCallCount = 0;
  let composeDetails = {
    identityId: initialIdentityId,
    type: "new",
    isModified: false,
    isPlainText: false,
    deliveryFormat: "auto"
  };
  const identityRecords = new Map([
    ["seat-identity", { id: "seat-identity", email: "seat@example.test", accountId: "account-1" }],
    ["other-identity", { id: "other-identity", email: "other@example.test", accountId: "account-1" }]
  ]);
  const signaturePolicy = {
    email_signature_on_compose: true,
    email_signature_on_reply: true,
    email_signature_on_forward: true,
    email_signature_template: "<p>Managed signature</p>",
    user_email: "seat@example.test"
  };
  const policyStatus = {
    policy: {
      email_signature: signaturePolicy
    }
  };

  const browser = {
    accounts: {
      async list(){
        return [{ id: "account-1", identities: Array.from(identityRecords.values()) }];
      }
    },
    compose: {
      onIdentityChanged: identityChanged,
      async getComposeDetails(requestedTabId){
        assert(requestedTabId === tabId, "Signature background requested an unexpected compose tab");
        return { ...composeDetails };
      },
      async setComposeDetails(requestedTabId, changes){
        assert(requestedTabId === tabId, "Signature background changed an unexpected compose tab");
        composeDetails = { ...composeDetails, ...changes };
      }
    },
    composeScripts: {
      async register(){
        return {};
      }
    },
    identities: {
      async get(identityId){
        return identityRecords.get(identityId) || null;
      },
      async list(){
        return Array.from(identityRecords.values());
      }
    },
    storage: {
      local: {
        async get(){
          return {
            emailSignatureOnCompose: true,
            emailSignatureOnReply: true,
            emailSignatureOnForward: true,
            debugEnabled: false
          };
        }
      }
    },
    tabs: {
      onCreated: tabCreated,
      onRemoved: tabRemoved,
      async query(){
        return [{ id: tabId, type: "messageCompose" }];
      },
      async sendMessage(requestedTabId, message){
        assert(requestedTabId === tabId, "Signature background messaged an unexpected compose tab");
        if (message?.type === "nc-signature:ping"){
          pingCallCount += 1;
          if (pauseFirstPing && pingCallCount === 1){
            firstPingStarted.resolve();
            await firstPingRelease.promise;
          }
          return { ok: true };
        }
        if (message?.type === "nc-signature:apply"){
          applyMessages.push({
            identityId: composeDetails.identityId,
            payload: message.payload
          });
          return {
            ok: true,
            changed: true,
            managed: message.payload?.desired === true,
            reason: message.payload?.desired === true ? "signature_inserted" : "signature_cleared"
          };
        }
        throw new Error("Unexpected signature tab message");
      }
    },
    windows: {
      onCreated: windowCreated
    }
  };
  const context = {
    browser,
    console: {
      debug(){},
      error(){
        errors.push(Array.from(arguments));
      },
      log(){}
    },
    L(message, details){
      logs.push({ message, details: details || {} });
    },
    NCHtmlSanitizer: {
      sanitizeShareTemplateHtml(value){
        return String(value || "");
      },
      htmlToPlainText(){
        return "Managed signature";
      }
    },
    NCPolicyRuntime: {
      getPolicyStatus(){
        policyCallCount += 1;
        if (policyCallCount === 1){
          firstPolicyStarted.resolve();
          return firstPolicyRelease.promise;
        }
        return Promise.resolve(policyStatus);
      }
    },
    NCPolicyState: {
      coerceBoolean(value, fallback = false){
        return typeof value === "boolean" ? value : fallback;
      },
      isDomainActive(status, domain){
        return !!status?.policy?.[domain];
      },
      isDomainAvailable(status, domain){
        return !!status?.policy?.[domain];
      },
      readPolicyValue(status, domain, key){
        return status?.policy?.[domain]?.[key];
      },
      resolveDefaultValue(status, domain, key, localValue){
        const policyValue = status?.policy?.[domain]?.[key];
        return typeof policyValue === "boolean" ? policyValue : localValue;
      }
    },
    Promise,
    clearTimeout,
    setTimeout
  };
  vm.createContext(context);
  vm.runInContext(readText("modules/bgSignature.js"), context, { filename: "modules/bgSignature.js" });

  return {
    tabId,
    applyMessages,
    errors,
    logs,
    get policyCallCount(){
      return policyCallCount;
    },
    start(){
      tabCreated.listeners[0]({ id: tabId, type: "messageCompose" });
    },
    changeIdentity(identityId){
      composeDetails = { ...composeDetails, identityId };
      identityChanged.listeners[0]({ id: tabId, type: "messageCompose" }, identityId);
    },
    setIdentityWithoutEvent(identityId){
      composeDetails = { ...composeDetails, identityId };
    },
    setIdentityEmail(identityId, email){
      const current = identityRecords.get(identityId);
      identityRecords.set(identityId, { ...current, email });
    },
    async waitForFirstPolicyRequest(){
      await Promise.race([
        firstPolicyStarted.promise,
        wait(2000).then(() => {
          throw new Error("Signature policy request did not start");
        })
      ]);
    },
    releaseFirstPolicy(){
      firstPolicyRelease.resolve(policyStatus);
    },
    async waitForFirstPing(){
      await Promise.race([
        firstPingStarted.promise,
        wait(2000).then(() => {
          throw new Error("Signature compose-script ping did not start");
        })
      ]);
    },
    releaseFirstPing(){
      firstPingRelease.resolve();
    },
    close(){
      tabRemoved.listeners[0](tabId);
    }
  };
}

async function runIdentityChangeRaceChecks(){
  const matchingToOther = createBackgroundSignatureHarness({
    initialIdentityId: "seat-identity"
  });
  matchingToOther.start();
  await matchingToOther.waitForFirstPolicyRequest();
  matchingToOther.changeIdentity("other-identity");
  matchingToOther.start();
  matchingToOther.releaseFirstPolicy();
  await waitForCondition(
    () => matchingToOther.logs.some((entry) => {
      return entry.message === "email signature skipped for non-seat identity"
        && entry.details.reason === "identity_changed";
    }),
    "Final non-seat identity was not processed"
  );
  assert(matchingToOther.policyCallCount >= 2, "Identity change should trigger a follow-up policy pass");
  assert(matchingToOther.applyMessages.length === 0, "Old matching identity must not insert a signature");
  assert(matchingToOther.errors.length === 0, "Matching-to-other race should not log a processing error");
  matchingToOther.close();

  const otherToMatching = createBackgroundSignatureHarness({
    initialIdentityId: "other-identity"
  });
  otherToMatching.start();
  await otherToMatching.waitForFirstPolicyRequest();
  otherToMatching.changeIdentity("seat-identity");
  otherToMatching.releaseFirstPolicy();
  await waitForCondition(
    () => otherToMatching.logs.some((entry) => {
      return entry.message === "email signature processed"
        && entry.details.reason === "identity_changed";
    }),
    "Final seat identity was not processed"
  );
  assert(otherToMatching.policyCallCount >= 2, "Identity change should trigger a follow-up policy pass");
  assert(otherToMatching.applyMessages.length === 1, "Final matching identity should insert one signature");
  assert(
    otherToMatching.applyMessages[0].identityId === "seat-identity",
    "Signature write must use the final matching identity"
  );
  assert(otherToMatching.errors.length === 0, "Other-to-matching race should not log a processing error");
  otherToMatching.close();

  const finalReadGuard = createBackgroundSignatureHarness({
    initialIdentityId: "seat-identity",
    pauseFirstPing: true
  });
  finalReadGuard.start();
  await finalReadGuard.waitForFirstPolicyRequest();
  finalReadGuard.releaseFirstPolicy();
  await finalReadGuard.waitForFirstPing();
  finalReadGuard.setIdentityWithoutEvent("other-identity");
  finalReadGuard.releaseFirstPing();
  await waitForCondition(
    () => finalReadGuard.logs.some((entry) => {
      return entry.message === "email signature skipped for non-seat identity"
        && entry.details.reason === "identity_changed";
    }),
    "Final compose identity was not processed after the pre-write check"
  );
  assert(finalReadGuard.policyCallCount >= 2, "Pre-write identity drift should trigger another policy pass");
  assert(finalReadGuard.applyMessages.length === 0, "Pre-write identity drift must block the old signature");
  assert(finalReadGuard.errors.length === 0, "Pre-write identity drift should not log a processing error");
  finalReadGuard.close();

  const policyEmailGuard = createBackgroundSignatureHarness({
    initialIdentityId: "seat-identity",
    pauseFirstPing: true
  });
  policyEmailGuard.start();
  await policyEmailGuard.waitForFirstPolicyRequest();
  policyEmailGuard.releaseFirstPolicy();
  await policyEmailGuard.waitForFirstPing();
  policyEmailGuard.setIdentityEmail("seat-identity", "other@example.test");
  policyEmailGuard.releaseFirstPing();
  await waitForCondition(
    () => policyEmailGuard.logs.some((entry) => {
      return entry.message === "email signature skipped for non-seat identity"
        && entry.details.reason === "identity_changed";
    }),
    "Final identity email was not checked against the signature policy"
  );
  assert(policyEmailGuard.policyCallCount >= 2, "Changed identity email should trigger another policy pass");
  assert(policyEmailGuard.applyMessages.length === 0, "Policy email mismatch must block the old signature");
  assert(policyEmailGuard.errors.length === 0, "Policy email mismatch should not log a processing error");
  policyEmailGuard.close();
}

async function run(){
  const harness = createHarness();
  const payload = {
    desired: true,
    clearForeign: true,
    clearOwnOnly: false,
    plainTextMode: true,
    plainText: "Backend signature",
    placeCursorAtStart: false,
    debugEnabled: false
  };
  const applyMessage = { type: "nc-signature:apply", payload };
  const managedSelector = '[data-nc-connector-signature="true"]';
  const foreignSelector = '.moz-signature:not([data-nc-connector-signature="true"]), [data-signature-switch-id]';

  const initialResult = await harness.messageListener(applyMessage);
  assert(initialResult?.reason === "signature_inserted", "Initial backend signature should be inserted");
  assert(harness.document.querySelectorAll(managedSelector).length === 1, "Exactly one backend signature should exist");
  const initialManagedSignature = harness.document.querySelectorAll(managedSelector)[0];
  const initialObserver = harness.observers.find((observer) => observer.active);
  assert(initialObserver, "Late signature observer should start after backend insertion");
  assert(initialObserver.options?.attributes === true, "Late signature observer should watch signature attributes");

  harness.body.appendChild(new FakeElement("p"));
  initialObserver.trigger();
  harness.scheduler.advance(100);
  assert(
    harness.document.querySelectorAll(managedSelector)[0] === initialManagedSignature,
    "Ordinary compose mutations must not rebuild the backend signature"
  );

  const lateLocalSignature = new FakeElement("div");
  lateLocalSignature.className = "moz-signature";
  lateLocalSignature.textContent = "Local file signature";
  harness.body.appendChild(lateLocalSignature);
  initialObserver.trigger();
  harness.scheduler.advance(50);
  assert(harness.document.querySelectorAll(foreignSelector).length === 0, "Late local signature should be removed");
  assert(harness.document.querySelectorAll(managedSelector).length === 1, "Backend signature should remain after settling");
  assert(
    harness.document.querySelectorAll(managedSelector)[0] !== initialManagedSignature,
    "Late local signature should use the existing replacement path"
  );

  harness.scheduler.advance(1850);
  assert(initialObserver.active === false, "Late signature observer should stop after two seconds");
  const afterWindowSignature = new FakeElement("div");
  afterWindowSignature.className = "moz-signature";
  harness.body.appendChild(afterWindowSignature);
  initialObserver.trigger();
  harness.scheduler.advance(100);
  assert(
    harness.document.querySelectorAll(foreignSelector).length === 1,
    "Observer must not keep changing signatures after the settle window"
  );

  await harness.messageListener(applyMessage);
  const editedManagedSignature = harness.document.querySelectorAll(managedSelector)[0];
  const editedMarker = new FakeElement("span");
  editedMarker.textContent = "edited";
  editedManagedSignature.appendChild(editedMarker);
  const localAfterEdit = new FakeElement("div");
  localAfterEdit.className = "moz-signature";
  harness.body.appendChild(localAfterEdit);
  const editObserver = harness.observers.find((observer) => observer.active);
  editObserver.trigger();
  harness.scheduler.advance(50);
  assert(
    harness.document.querySelectorAll(foreignSelector).length === 1,
    "A modified backend signature must not be overwritten during settling"
  );
  assert(editObserver.active === false, "Settling should stop after detecting a modified backend signature");

  for (const listener of harness.unloadListeners){
    listener();
  }
  await runIdentityChangeRaceChecks();
  console.log("[OK] signature-compose-settle-check passed");
}

run().catch((error) => {
  console.error("[FAIL] signature-compose-settle-check", error);
  process.exitCode = 1;
});
