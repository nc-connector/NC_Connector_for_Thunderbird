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
  console.log("[OK] signature-compose-settle-check passed");
}

run().catch((error) => {
  console.error("[FAIL] signature-compose-settle-check", error);
  process.exitCode = 1;
});
