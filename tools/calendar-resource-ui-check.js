"use strict";

const vm = require("node:vm");
const { assert, readText, readJson, loadScript } = require("./review-check-utils");

class Element {
  constructor(tag = "div", ownerDocument = null){
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.text = "";
    this.style = {};
    this.offsetWidth = 180;
    this.offsetHeight = 36;
    this.classList = {
      contains: name => this.className.split(" ").includes(name),
      add: name => this.classList.toggle(name, true),
      remove: name => this.classList.toggle(name, false),
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
      }
    };
  }
  set textContent(value){ this.replaceChildren(); this.text = String(value); }
  get textContent(){ return this.text + this.children.map(child => child.textContent).join(""); }
  get options(){ return this.children.filter(child => child.tagName === "option"); }
  get hidden(){ return this.attributes.has("hidden"); }
  set hidden(value){ if (value) this.attributes.set("hidden", ""); else this.attributes.delete("hidden"); }
  get tabIndex(){
    return this.attributes.has("tabindex") ? Number(this.attributes.get("tabindex"))
      : ["button", "input", "select", "textarea"].includes(this.tagName) ? 0 : -1;
  }
  set tabIndex(value){ this.setAttribute("tabindex", String(value)); }
  get isConnected(){ return this.tagName === "document" || !!this.parentElement?.isConnected; }
  append(...children){
    for (const child of children){
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(entry => entry !== child);
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
    }
  }
  replaceChildren(...children){
    for (const child of this.children) child.parentElement = null;
    this.text = "";
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value){ this.attributes.set(name, String(value)); }
  getAttribute(name){ return this.attributes.get(name) ?? null; }
  removeAttribute(name){ this.attributes.delete(name); if (name === "href") delete this.href; }
  addEventListener(name, listener){
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  descendants(){ return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector){
    const parts = selector.trim().split(/\s+/);
    const target = parts.pop();
    const simple = (element, part) => {
      for (const match of part.matchAll(/:not\(([^)]+)\)/g)) if (simple(element, match[1])) return false;
      part = part.replace(/:not\([^)]+\)/g, "");
      const tag = part.match(/^[a-z]+/)?.[0];
      if (tag && element.tagName !== tag) return false;
      for (const match of part.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(match[1])) return false;
      for (const match of part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)){
        const value = element.attributes.get(match[1]) ?? element[match[1]];
        if (match[2] === undefined ? value === undefined || value === false : String(value) !== match[2]) return false;
      }
      return true;
    };
    if (!simple(this, target)) return false;
    let ancestor = this.parentElement;
    while (parts.length){
      const part = parts.pop();
      while (ancestor && !simple(ancestor, part)) ancestor = ancestor.parentElement;
      if (!ancestor) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  }
  querySelectorAll(selector){ return this.descendants().filter(child => selector.split(",").some(part => child.matches(part))); }
  querySelector(selector){ return this.querySelectorAll(selector)[0] || null; }
  closest(selector){ return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(element){ return element === this || this.descendants().includes(element); }
  getBoundingClientRect(){ return { left: 12, top: 24, right: 192, bottom: 60 }; }
  focus(){
    this.focused = !this.disabled;
    if (this.focused && this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  async fire(name, event = {}){
    event = { target: this, currentTarget: this, preventDefault(){ this.defaultPrevented = true; }, stopPropagation(){}, ...event };
    for (const listener of this.listeners.get(name) || []) await listener(event);
  }
}

function createUi(page, respond, query = "?contextId=event-1", options = {}){
  const html = readText(`ui/${page}.html`);
  const document = new Element("document");
  document.ownerDocument = document;
  document.documentElement = { clientWidth: 780, clientHeight: 600 };
  const main = new Element("main", document);
  const footer = new Element("footer", document);
  document.append(main, footer);
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)){
    const element = new Element(match[1], document);
    element.disabled = /\bdisabled\b/.test(match[0]);
    element.hidden = /\bhidden\b/.test(match[0]);
    element.className = match[0].match(/\bclass="([^"]*)"/)?.[1] || "";
    element.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || "";
    element.type = match[0].match(/\btype="([^"]*)"/)?.[1] || "";
    for (const attribute of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
    elements.set(match[2], element);
    main.append(element);
  }
  for (const id of ["roomIcon", "resourceIcon", "calendarIcon"]){
    if (elements.has(id)) elements.get(id).content = { cloneNode: () => new Element("svg", document) };
  }
  document.getElementById = id => elements.get(id);
  document.createElement = tag => new Element(tag, document);
  if (elements.has("dayView")){
    for (const id of ["dayClose", "previousDay", "dateControl", "nextDay", "today", "dayScroll"]){
      elements.get("dayView").append(elements.get(id));
    }
    elements.get("dateControl").append(elements.get("dayDate"), elements.get("datePopover"));
    for (const id of ["previousMonth", "calendarMonth", "nextMonth", "calendarWeekdays", "calendarDays", "calendarClose"]){
      elements.get("datePopover").append(elements.get(id));
    }
  }
  const messages = [];
  const errors = [];
  const catalog = readJson("_locales/en/messages.json");
  const window = new Element("window");
  window.location = { search: query, replace: url => { window.destination = url; } };
  window.close = () => { window.closed = true; };
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => {
    if (delay < 1000) return setTimeout(callback, 0);
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  const stored = { ...options.storage };
  const storageWrites = [];
  const context = vm.createContext({
    console, URL, URLSearchParams, window, document, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    NCI18n: { translate: (key, values = []) => {
      assert(catalog[key], `Unknown UI key: ${key}`);
      return catalog[key].message.replace(/\$(\d)/g, (_, index) => values[Number(index) - 1]);
    } },
    NCTalkDomI18n: { translatePage: () => {} },
    NCLogContext: { safeConsoleError: (...args) => errors.push(args) },
    browser: {
      storage: { local: {
        get: async () => ({ ...stored }),
        set: async value => { storageWrites.push(value); Object.assign(stored, value); }
      } },
      runtime: { sendMessage: async message => {
        messages.push(message);
        if (["resource:interval", "resource:availability", "resource:cancel", "resource:close"].includes(message.type)){
          return options.onAux ? options.onAux(message) : { ok: true, interval: null, results: [] };
        }
        return respond(message);
      } }
    }
  });
  if (page === "calendarResources"){
    loadScript("modules/policyState.js", context, "\nglobalThis.policyState = NCPolicyState;");
    loadScript("ui/wizardPolicyUi.js", context);
    context.NCWizardPolicyUi = window.NCWizardPolicyUi;
  }
  loadScript(`ui/${page}.js`, context);
  return { elements, window, document, messages, errors, context, stored, storageWrites, timers,
    rows: () => document.querySelectorAll(".resource-row"),
    visibleRows: () => document.querySelectorAll(".resource-row").filter(row => {
      for (let parent = row; parent; parent = parent.parentElement) if (parent.hidden) return false;
      return true;
    }),
    tick: async () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) await callback(); await settle(); }
  };
}

function selectionMessages(ui){ return ui.messages.filter(message => ["resource:list", "resource:apply"].includes(message.type)); }

function deferred(){
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function settle(){
  for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve));
}

const catalogResources = [
  { email: "room-a@example.invalid", kind: "ROOM", displayName: "Room A", buildingName: "Headquarters",
    roomType: "Meeting room", capacity: 0, buildingAddress: "Test street 1", floor: "0", roomNumber: "10",
    features: ["TV", "Whiteboard"], location: "0, Test street 1" },
  { email: "room-b@example.invalid", kind: "ROOM", displayName: "Room B", buildingName: "Branch" },
  { email: "equipment@example.invalid", kind: "RESOURCE", displayName: "<img src=x onerror=alert(1)>",
    resourceType: "Projector", capacity: null }
].map((resource, index) => ({ ...resource, selectable: true, principalPath: `/principals/${resource.kind}/${index}` }));

function pickerPolicy(status = {}, mode = "pro"){
  return {
    endpointAvailable: true, endpointChecked: true, fetchSucceeded: true,
    endpointUrl: "https://cloud.example.test/nextcloud/index.php/apps/ncc_backend_4mc/api/v1/status",
    managedSetup: { isEnterpriseRollout: true },
    status: { mode, seatAssigned: true, isValid: true, seatState: "active",
      licenseStatus: mode === "community" ? "COMMUNITY" : "ACTIVE", ...status }
  };
}

function listResponse(selectedEmails = [], policyStatus = pickerPolicy()){
  return { ok: true, resources: catalogResources, selectedEmails, selectionToken: "selection-1", policyStatus };
}

function rowFor(ui, email){ return ui.rows().find(row => row.dataset.email === email); }

async function select(ui, email, checked){
  const checkbox = rowFor(ui, email).querySelector("input");
  checkbox.checked = checked;
  await checkbox.fire("change");
}

async function testPickerSelection(){
  const ui = createUi("calendarResources", message => message.type === "resource:list"
    ? listResponse([catalogResources[0].email, catalogResources[2].email]) : { ok: true });
  await ui.document.fire("DOMContentLoaded");
  await settle();
  assert(ui.rows().length === 3, "Both resource groups must render");
  assert(ui.elements.get("selectionCount").textContent === "Selected: 2", "Initial attendees must be selected");
  assert(ui.elements.get("search").focused, "Search must receive focus after loading");
  await rowFor(ui, catalogResources[0].email).querySelector("input").fire("focus");
  const details = ui.elements.get("details").textContent;
  assert(details.includes(`${ui.context.NCI18n.translate("resource_capacity")}0`) && details.includes("Floor0") && details.includes("TV, Whiteboard"),
    "Metadata must preserve zero values and feature lists");
  assert(ui.elements.get("details").children.filter(child => child.tagName === "dd").length === 11
    && details.includes("Test street 1") && details.includes("0, Test street 1"),
  "Compact details must retain every field, including the full address and appointment location");
  await rowFor(ui, catalogResources[2].email).querySelector("input").fire("focus");
  assert(ui.elements.get("detailsTitle").textContent === catalogResources[2].displayName,
    "Server names must remain literal text");
  ui.elements.get("search").value = "Branch";
  await ui.elements.get("search").fire("input");
  assert(ui.rows().length === 1, "Search must include building metadata");
  await select(ui, catalogResources[1].email, true);
  assert(ui.elements.get("selectionCount").textContent === "Selected: 2",
    "Selecting a filtered room must replace the hidden room but preserve equipment");
  ui.elements.get("search").value = "";
  await ui.elements.get("search").fire("input");
  assert(!rowFor(ui, catalogResources[0].email).querySelector("input").checked
    && rowFor(ui, catalogResources[2].email).querySelector("input").checked,
  "Search changes must not clear the complete selection");
  await select(ui, catalogResources[1].email, false);
  assert(ui.elements.get("selectionCount").textContent === "Selected: 1", "A room can be unchecked");
  await ui.elements.get("apply").fire("click");
  const write = ui.messages.find(message => message.type === "resource:apply");
  assert(write.contextId === "event-1" && write.selectionToken === "selection-1"
    && write.selectedEmails.join() === catalogResources[2].email, "Apply must use its original editor selection token");
  assert(ui.window.closed, "Successful apply closes the picker");
}

async function testPickerFailureAndCancellation(){
  let complete;
  let requests = 0;
  const ui = createUi("calendarResources", message => {
    if (message.type === "resource:list") return listResponse();
    requests++;
    return new Promise(resolve => { complete = resolve; });
  });
  await ui.document.fire("DOMContentLoaded");
  await settle();
  await select(ui, catalogResources[0].email, true);
  const applying = ui.elements.get("apply").fire("click");
  await settle();
  assert(ui.elements.get("cancel").disabled && ui.elements.get("apply").disabled,
    "Apply must prevent duplicate writes and cancellation during the editor transaction");
  await ui.elements.get("apply").fire("click");
  await ui.document.fire("keydown", { key: "Escape" });
  assert(requests === 1 && !ui.window.closed, "Busy apply cannot be repeated or Escape-cancelled");
  complete({ ok: false, error: "The event changed.", code: "resource_selection_changed" });
  await applying;
  assert(ui.elements.get("apply").disabled && !ui.elements.get("cancel").disabled
    && !ui.elements.get("retry").hidden, "Failed apply must allow cancellation but require a fresh snapshot");
  assert(ui.rows().every(row => row.querySelector("input").disabled), "Stale choices must not remain editable");
  await ui.elements.get("cancel").fire("click");
  assert(ui.window.closed && requests === 1, "Cancel does not issue another editor mutation");

  const denied = createUi("calendarResources", () => ({ ok: false, error: "Sign in again.", code: "auth_required" }));
  await denied.document.fire("DOMContentLoaded");
  await settle();
  assert(denied.elements.get("apply").disabled && !denied.elements.get("reauthenticate").hidden,
    "Authentication rejection must keep apply disabled and expose reauthentication");

  const missing = createUi("calendarResources", () => { throw new Error("Unexpected request"); }, "");
  await missing.document.fire("DOMContentLoaded");
  await settle();
  assert(missing.messages.length === 0 && missing.elements.get("apply").disabled,
    "Missing editor context must not initiate requests");

  const multiple = createUi("calendarResources", () => listResponse([catalogResources[0].email, catalogResources[1].email]));
  await multiple.document.fire("DOMContentLoaded");
  await settle();
  assert(multiple.elements.get("apply").disabled, "Existing multiple rooms require an explicit choice");
  await select(multiple, catalogResources[0].email, false);
  assert(!multiple.elements.get("apply").disabled && multiple.elements.get("status").textContent === "",
    "Unchecking the extra room clears the validation message");
}

async function testUnbookableCatalogRows(){
  const missing = { ...catalogResources[1], principalPath: "/principals/calendar-rooms/missing", email: "", selectable: false, displayName: "Missing address" };
  const secondMissing = { ...missing, principalPath: missing.principalPath + "2", displayName: "Second missing address" };
  const alias = { ...catalogResources[2], principalPath: "/principals/calendar-resources/alias", selectable: false, displayName: "Alias one" };
  const secondAlias = { ...alias, principalPath: alias.principalPath + "2", displayName: "Alias two" };
  for (const resources of [[catalogResources[0], missing, secondMissing, alias, secondAlias], [missing, secondMissing, alias, secondAlias]]){
    const ui = createUi("calendarResources", message => message.type === "resource:list"
      ? { ...listResponse([catalogResources[0].email, "", alias.email]), resources, interval: appointment } : { ok: true }, undefined, {
      onAux: () => ({ ok: true, interval: appointment, results: resources.map(resource => ({
        email: resource.email, state: "free", start: appointment.start, end: appointment.end, periods: []
      })) })
    });
    await ui.document.fire("DOMContentLoaded");
    await settle();
    assert(ui.rows().length === resources.length, "Addressless and duplicate-email aliases render as distinct principal rows");
    const unavailable = ui.rows().filter(row => row.dataset.resourceUnavailable === "true");
    assert(unavailable.length === 4 && unavailable.every(row => row.querySelector("input").disabled
      && !row.querySelector("input").checked && row.querySelector("button").disabled && row.querySelector(".availability-unknown")),
    "Unbookable rows stay unchecked, disabled, and Unknown after loading and availability rendering");
    const first = unavailable.find(row => row.dataset.principalPath === missing.principalPath);
    await first.fire("focus");
    assert(ui.elements.get("detailsTitle").textContent === missing.displayName && first.classList.contains("is-current")
      && ui.rows().filter(row => row.classList.contains("is-current")).length === 1,
    "Principal identity keeps details and focus distinct when multiple addresses are empty");
    await first.querySelector("button").fire("click");
    await first.fire("contextmenu");
    assert(ui.elements.get("dayView").hidden && ui.elements.get("resourceMenu").hidden,
      "Unbookable rows cannot open day queries through buttons or context menus");
    first.querySelector("input").checked = true;
    await first.querySelector("input").fire("change");
    ui.elements.get("onlyAvailable").checked = true;
    await ui.elements.get("onlyAvailable").fire("change");
    assert(ui.rows().length === resources.filter(resource => resource.selectable).length,
      "Unbookable rows never pass available-only filtering even if a reply includes their address");
    await ui.elements.get("apply").fire("click");
    const write = ui.messages.find(message => message.type === "resource:apply");
    assert(write.selectedEmails.join() === resources.filter(resource => resource.selectable).map(resource => resource.email).join()
      && ui.window.closed && ui.errors.length === 0,
    "Only usable unique selected addresses reach apply, including an all-unbookable catalog");
  }
}

async function testPickerPolicyWarnings(){
  const dates = {
    graceUntilIso: "2026-10-28T12:00:00Z",
    licenseLastSyncAtIso: "2026-10-14T08:00:00Z",
    licenseOfflineUntilIso: "2026-10-28T08:00:00Z"
  };
  for (const mode of ["community", "pro"]){
    for (const canManageLicense of [false, true]){
      for (const [code, status] of [
        ["", {}],
        ["license_grace", { licenseStatus: "EXPIRED", accessStatus: "GRACE" }],
        ["license_connection_error", { licenseConnectionError: true }],
        ["license_grace", { licenseStatus: "EXPIRED", accessStatus: "GRACE", licenseConnectionError: true }]
      ]){
        const policyStatus = pickerPolicy({ ...status, ...dates, canManageLicense }, mode);
        const ui = createUi("calendarResources", message => message.type === "resource:list"
          ? listResponse([], policyStatus) : { ok: true });
        await ui.document.fire("DOMContentLoaded");
        await settle();
        const row = ui.elements.get("policyWarningRow");
        const text = ui.elements.get("policyWarningText").textContent;
        const adminLink = ui.elements.get("policyWarningAdminLink");
        const notice = ui.context.policyState.getStatusNotice(policyStatus);
        assert(notice.code === code && text === ui.context.policyState.getStatusNoticeMessage(notice, ui.context.NCI18n.translate),
          "Resources must render the same notice and full formatting as the existing wizard helper");
        assert(row.hidden === !code && ui.errors.length === 0,
          "Active access needs no banner; grace and confirmed synchronization warnings must remain visible");
        if (code){
          assert(row.classList.contains("is-informational") && row.attributes.get("role") === "status",
            "Usable grace and synchronization states must use the shared informational presentation");
          if (code === "license_grace"){
            assert(text.includes(new Date(dates.graceUntilIso).toLocaleString()),
              "Grace warnings must display the backend date through the shared date formatter");
          }
          if (status.licenseConnectionError){
            assert(text.includes(new Date(dates.licenseLastSyncAtIso).toLocaleString())
              && text.includes(new Date(dates.licenseOfflineUntilIso).toLocaleString()),
            "Confirmed synchronization warnings must retain both existing display dates");
          }
        }
        assert(adminLink.hidden === !(code && canManageLicense),
          "The existing license-management link must remain limited to administrators with a license notice");
        if (!adminLink.hidden){
          assert(adminLink.href === "https://cloud.example.test/nextcloud/index.php/settings/admin/ncc_backend_4mc",
            "Resources must reuse the configured account's existing administrator URL, including its subdirectory");
        }else{
          assert(!adminLink.href, "Hidden administrator links must not retain a stale destination");
        }
        assert(selectionMessages(ui).length === 1 && ui.messages[0].type === "resource:list"
          && !ui.elements.get("apply").disabled && !ui.elements.get("search").disabled && ui.rows().length === 3,
        "Warning rendering must not add another policy request or block resource selection");
        await select(ui, catalogResources[0].email, true);
        await ui.elements.get("apply").fire("click");
        assert(ui.window.closed && selectionMessages(ui).length === 2 && selectionMessages(ui)[1].type === "resource:apply",
          "Informational warnings must leave the existing guarded apply path usable");
      }
    }
  }
}

async function testPickerWarningLifecycle(){
  const grace = pickerPolicy({ licenseStatus: "EXPIRED", accessStatus: "GRACE", canManageLicense: true });
  for (const failure of ["denial", "transport", "malformed"]){
    let finishReload;
    let rejectReload;
    let calls = 0;
    const ui = createUi("calendarResources", () => {
      calls++;
      if (calls === 1) return listResponse([], grace);
      if (calls === 2) return new Promise((resolve, reject) => { finishReload = resolve; rejectReload = reject; });
      return listResponse();
    });
    await ui.document.fire("DOMContentLoaded");
    await settle();
    assert(!ui.elements.get("policyWarningRow").hidden, "The initial grace banner must be visible");
    await ui.elements.get("retry").fire("click");
    assert(ui.elements.get("policyWarningRow").hidden && ui.elements.get("apply").disabled,
      "A fresh list request must hide its previous warning immediately, before the response");
    await settle();
    if (failure === "transport") rejectReload(new Error("Directory unavailable"));
    else finishReload(failure === "denial"
      ? { ok: false, code: "seat_paused", error: "Seat paused", policyStatus: grace }
      : { ok: true, resources: null, policyStatus: grace });
    await settle();
    assert(ui.elements.get("policyWarningRow").hidden && ui.elements.get("apply").disabled
      && !ui.elements.get("retry").hidden,
    `${failure}: stale grace must never accompany a failed or refused refresh`);
    await ui.elements.get("retry").fire("click");
    await settle();
    assert(ui.elements.get("policyWarningRow").hidden && !ui.elements.get("apply").disabled
      && ui.elements.get("policyWarningText").textContent === ""
      && ui.elements.get("policyWarningAdminLink").hidden && !ui.elements.get("policyWarningAdminLink").href,
    "A successful active-state retry must clear the old message and administrator link");
    assert(selectionMessages(ui).length === 3 && selectionMessages(ui).every(message => message.type === "resource:list")
      && !ui.messages.some(message => message.type === "calendar:actionState"),
      "Retries must use the existing list policy result, without separate warning fetches");
  }

  for (const code of ["seat_paused", "no_seat", "license_invalid_explicit"]){
    const ui = createUi("calendarResources", message => message.type === "resource:list"
      ? listResponse([], grace) : { ok: false, code, error: `Denied: ${code}`, policyStatus: grace });
    await ui.document.fire("DOMContentLoaded");
    await settle();
    await ui.elements.get("apply").fire("click");
    assert(ui.elements.get("policyWarningRow").hidden && ui.elements.get("apply").disabled
      && ui.elements.get("status").textContent === `Denied: ${code}` && !ui.window.closed,
    `${code}: a new apply refusal must hide informational grace and retain the existing blocked state`);
  }
}

const appointment = { start: Date.parse("2026-10-25T08:00:00Z"), end: Date.parse("2026-10-25T09:00:00Z"), timeZone: "Europe/Berlin" };
const filterCatalog = [
  { ...catalogResources[0], capacity: 12, floor: "1" },
  { ...catalogResources[1], capacity: 6, floor: "2", buildingName: "Headquarters", roomType: "Meeting room", features: "TV" },
  { email: "car@example.invalid", kind: "ROOM", principalPath: "/principals/calendar-rooms/car", selectable: true,
    displayName: "Car", buildingName: "Branch", roomType: "car", capacity: 4, features: "TV, Whiteboard" },
  { ...catalogResources[2], displayName: "Projector", buildingName: "Headquarters", floor: "1", features: "Projector" }
];

function availableResponse(interval = appointment, states = {}){
  return { ok: true, interval, range: { start: interval.start, end: interval.end }, results: filterCatalog.map(resource => ({
    email: resource.email, state: states[resource.email] || "free", start: interval.start, end: interval.end, periods: []
  })) };
}

async function change(ui, id, value, event = "change"){
  ui.elements.get(id).value = value;
  await ui.elements.get(id).fire(event);
  await settle();
}

async function testMetadataFiltersAndGrouping(){
  const ui = createUi("calendarResources", () => ({ ...listResponse([filterCatalog[3].email]), resources: filterCatalog, interval: appointment }),
    undefined, { onAux: () => availableResponse() });
  await ui.document.fire("DOMContentLoaded");
  await settle();
  assert(ui.rows().length === 4 && ui.rows().every(row => row.children.length === 6),
    "Every room/resource needs the same six columns, not metadata appended to its name");
  assert(rowFor(ui, filterCatalog[0].email).children[0].textContent === "Room A"
    && rowFor(ui, filterCatalog[0].email).querySelector(".resource-seats").textContent === "♟12"
    && rowFor(ui, filterCatalog[3].email).querySelector(".resource-seats").textContent === "—",
  "Names, left-aligned capacity figures, and unknown capacities must remain distinct");
  await change(ui, "building", JSON.stringify("Headquarters"));
  assert(ui.rows().length === 3 && ui.elements.get("floor").options.map(option => option.value).join() === '*,"1","2"',
    "Building selection must limit both the rows and the available floors");
  await change(ui, "floor", JSON.stringify("1"));
  assert(ui.rows().length === 2, "Floor and building filters combine");
  await change(ui, "capacity", "8", "input");
  assert(ui.rows().length === 1 && ui.rows()[0].dataset.email === filterCatalog[0].email,
    "Minimum capacity excludes unknown values instead of treating them as seats");
  await ui.elements.get("clearFilters").fire("click");
  await ui.elements.get("featuresButton").fire("click");
  assert(!ui.elements.get("featuresMenu").hidden && ui.elements.get("featuresButton").getAttribute("aria-expanded") === "true",
    "The feature selector must be an operable multiselect");
  for (const feature of ["TV", "Whiteboard"]){
    const label = ui.elements.get("featuresMenu").children.find(element => element.textContent === feature);
    label.querySelector("input").checked = true;
    await label.querySelector("input").fire("change");
  }
  assert(ui.rows().length === 2 && ui.rows().every(row => [filterCatalog[0].email, filterCatalog[2].email].includes(row.dataset.email)),
    "Selected features combine with AND, including comma-delimited DAV metadata");
  await change(ui, "search", "Room A", "input");
  assert(ui.rows().length === 1 && ui.rows()[0].dataset.email === filterCatalog[0].email, "Search combines with feature filtering");
  await change(ui, "grouping", "building");
  await ui.elements.get("clearFilters").fire("click");
  assert(ui.rows().length === 4 && ui.elements.get("grouping").value === "building"
    && ui.elements.get("selectionCount").textContent === "Selected: 1",
  "Reset clears filters, but not grouping or hidden selected resources");
  const buildingGroups = ui.elements.get("groups").children;
  assert(buildingGroups.length === 2 && buildingGroups.every(group => group.children[1].children.every(child => child.classList.contains("resource-group"))),
    "Building grouping must contain floor groups before resource rows");
  const branch = buildingGroups.find(group => group.children[0].textContent.includes("Branch"));
  assert(branch.children[1].textContent.includes(ui.context.NCI18n.translate("resource_without_information")),
    "Missing floor metadata must receive an explicit group label");
  const heading = branch.children[0];
  await heading.fire("keydown", { key: "ArrowLeft" });
  assert(heading.getAttribute("aria-expanded") === "false" && branch.children[1].hidden, "Left arrow must collapse a group");
  await heading.fire("keydown", { key: "ArrowRight" });
  assert(heading.getAttribute("aria-expanded") === "true" && !branch.children[1].hidden, "Right arrow must expand a group");
  await change(ui, "grouping", "room-type");
  const roots = ui.elements.get("groups").children;
  assert(roots.length === 2 && roots[0].textContent.includes("car")
    && roots[0].querySelectorAll(".resource-row").some(row => row.dataset.email === filterCatalog[2].email)
    && roots[1].querySelectorAll(".resource-row").length === 1,
  "A ROOM with room-type car must remain under rooms, not be reclassified as RESOURCE");
  await select(ui, filterCatalog[0].email, true);
  await select(ui, filterCatalog[2].email, true);
  assert(!rowFor(ui, filterCatalog[0].email).querySelector("input").checked
    && rowFor(ui, filterCatalog[3].email).querySelector("input").checked,
  "The one-ROOM limit must apply to vehicle room types without removing RESOURCE selections");
}

async function testGroupingPreferences(){
  const preferences = { calendarResourceGrouping: "building", calendarResourceGroupsExpanded: false };
  const ui = createUi("calendarResources", () => ({ ...listResponse(), resources: filterCatalog }), undefined, { storage: preferences });
  await ui.document.fire("DOMContentLoaded");
  await settle();
  assert(ui.elements.get("grouping").value === "building" && ui.visibleRows().length === 0,
    "The next opening must restore local grouping and the global collapsed state");
  await ui.elements.get("expandAll").fire("click");
  await settle();
  assert(ui.visibleRows().length === 4 && ui.stored.calendarResourceGroupsExpanded === true,
    "Expand all must expand nested floors and persist the next-opening preference");
  await change(ui, "grouping", "room-type");
  assert(ui.stored.calendarResourceGrouping === "room-type" && ui.storageWrites.every(value =>
    Object.keys(value).sort().join() === "calendarResourceGrouping,calendarResourceGroupsExpanded"),
  "Only local view preferences may be persisted, never selections, resource names, or availability");
  await ui.elements.get("expandAll").fire("click");
  await settle();
  assert(ui.visibleRows().length === 0 && ui.stored.calendarResourceGroupsExpanded === false,
    "Collapse all must hide every row and persist its state");
  const sparse = createUi("calendarResources", () => ({ ...listResponse(), resources: [catalogResources[2]] }),
    undefined, { storage: preferences });
  await sparse.document.fire("DOMContentLoaded");
  await settle();
  assert(sparse.elements.get("grouping").options.length === 1 && sparse.elements.get("grouping").value === "none",
    "Unavailable DAV grouping fields must not produce nonfunctional choices");
}

async function testAvailabilityFilteringAndStaleResponses(){
  const first = deferred();
  const second = deferred();
  let currentInterval = appointment;
  let calls = 0;
  const ui = createUi("calendarResources", () => ({ ...listResponse([filterCatalog[1].email]), resources: filterCatalog, interval: appointment }), undefined, {
    onAux: message => message.type === "resource:interval" ? { ok: true, interval: currentInterval }
      : message.type === "resource:availability" ? (++calls === 1 ? first.promise : second.promise) : { ok: true }
  });
  await ui.document.fire("DOMContentLoaded");
  await settle();
  assert(ui.rows().every(row => row.querySelector(".availability-checking")), "Initial checks must not claim availability before a DAV result");
  ui.elements.get("onlyAvailable").checked = true;
  await ui.elements.get("onlyAvailable").fire("change");
  assert(ui.rows().length === 0 && ui.elements.get("empty").textContent === ui.context.NCI18n.translate("resource_checking"),
    "Only available must exclude unconfirmed entries while explaining a running check");
  currentInterval = { ...appointment, start: appointment.start + 3600000, end: appointment.end + 3600000 };
  await ui.tick();
  const current = availableResponse(currentInterval, { [filterCatalog[1].email]: "busy" });
  current.results = current.results.slice(0, 3);
  current.results[2].end = currentInterval.start;
  second.resolve(current);
  await settle();
  assert(ui.rows().length === 1 && ui.rows()[0].dataset.email === filterCatalog[0].email,
    "Only available must exclude busy, missing, and incomplete-coverage responses");
  first.resolve(availableResponse(appointment));
  await settle();
  assert(ui.rows().length === 1, "A stale result for the previous appointment interval must never overwrite the current states");
  ui.elements.get("onlyAvailable").checked = false;
  await ui.elements.get("onlyAvailable").fire("change");
  assert(rowFor(ui, filterCatalog[1].email).querySelector("input").checked
    && rowFor(ui, filterCatalog[1].email).querySelector(".availability-busy")
    && rowFor(ui, filterCatalog[2].email).querySelector(".availability-unknown")
    && rowFor(ui, filterCatalog[3].email).querySelector(".availability-unknown"),
  "Availability filtering must preserve selection and visibly distinguish missing data from free");
  await ui.window.fire("pagehide");
  assert(ui.timers.size === 0 && ui.messages.at(-1).type === "resource:close", "Closing the popup must release its session and interval timer");
}

async function testDayViewInSamePopup(){
  const nextDay = deferred();
  const dayRange = { start: Date.parse("2026-10-24T22:00:00Z"), end: Date.parse("2026-10-25T23:00:00Z") };
  const ui = createUi("calendarResources", () => ({ ...listResponse(), resources: filterCatalog, interval: appointment }), undefined, {
    onAux: message => {
      if (message.type !== "resource:availability" || !message.email) return availableResponse();
      if (message.date !== "2026-10-25") return nextDay.promise;
      return { ok: true, interval: appointment, range: dayRange, results: [{ email: message.email, ...dayRange, state: "busy",
        periods: [{ start: appointment.start, end: appointment.end }], summary: "Private meeting", organizer: "private@example.invalid" }] };
    }
  });
  await ui.document.fire("DOMContentLoaded");
  await settle();
  const calendar = rowFor(ui, filterCatalog[0].email).querySelector(".calendar-button");
  await calendar.fire("click");
  await settle();
  const day = ui.elements.get("dayView");
  const timeline = ui.elements.get("timeline");
  assert(!day.hidden && ui.document.querySelector("main").inert && ui.document.querySelector("footer").inert
    && !ui.window.destination && !ui.window.closed,
  "Calendar action must show an in-place day view without navigating or opening another window");
  assert(ui.elements.get("dayDate").value === "2026-10-25" && timeline.style.height === "900px"
    && timeline.querySelectorAll(".day-hour").length === 25,
  "The autumn clock change must render the actual 25-hour day, not a fixed 24-hour range");
  assert(timeline.querySelectorAll(".day-busy").length === 1 && timeline.querySelectorAll(".day-appointment").length === 1
    && timeline.querySelector(".day-track") && !timeline.querySelector(".is-unknown")
    && !timeline.textContent.includes("Private") && !timeline.textContent.includes("private@example.invalid"),
  "Day view must show anonymous busy blocks and the appointment overlay without private booking details");
  assert(ui.messages.find(message => message.email)?.email === filterCatalog[0].email,
    "Day requests must contain only the specifically selected room or resource");
  ui.elements.get("dayScroll").focus();
  await ui.document.fire("keydown", { key: "Tab" });
  assert(ui.document.activeElement === ui.elements.get("dayClose"), "Day view keyboard navigation must remain inside the view");
  await ui.elements.get("nextDay").fire("click");
  assert(ui.elements.get("dayDate").value === "2026-10-26" && timeline.children.length === 0,
    "Day navigation must clear the previous busy blocks while loading");
  await ui.document.fire("keydown", { key: "Escape" });
  assert(day.hidden && !ui.window.closed && !ui.document.querySelector("main").inert && ui.document.activeElement === calendar,
    "Escape must close only the day view and return focus to its calendar button");
  nextDay.resolve({ ok: true, interval: appointment, range: dayRange, results: [] });
  await settle();
  assert(day.hidden && timeline.children.length === 0, "A late day response cannot repaint a dismissed day view");
  const row = rowFor(ui, filterCatalog[3].email);
  await row.fire("keydown", { key: "F10", shiftKey: true });
  assert(!ui.elements.get("resourceMenu").hidden && ui.elements.get("showAvailability").focused,
    "Resource availability must also be reachable through the keyboard context menu");
  await ui.elements.get("showAvailability").fire("click");
  await settle();
  assert(!day.hidden && ui.elements.get("dayTitle").textContent.includes("Projector"),
    "The context menu must open the exact resource within the same day view");
  await ui.elements.get("dayClose").fire("click");
  await row.fire("contextmenu", { clientX: 770, clientY: 590 });
  assert(!ui.elements.get("resourceMenu").hidden && ui.elements.get("resourceMenu").style.left === "600px",
    "The pointer context menu must remain inside the popup edges");
  await ui.document.fire("keydown", { key: "Escape" });
  assert(ui.elements.get("resourceMenu").hidden && !ui.window.closed, "Escape must dismiss the menu before closing the picker");
}

async function openDateTestUi(date = "2026-10-25"){
  const interval = { ...appointment, start: Date.parse(`${date}T08:00:00Z`), end: Date.parse(`${date}T09:00:00Z`) };
  const ui = createUi("calendarResources", () => ({ ...listResponse(), resources: filterCatalog, interval }), undefined, {
    onAux: message => {
      if (message.type !== "resource:availability") return { ok: true, interval };
      if (!message.email) return availableResponse(interval);
      const range = { start: Date.parse(`${message.date}T00:00:00Z`), end: Date.parse(`${message.date}T00:00:00Z`) + 86400000 };
      return { ok: true, interval, range, results: [{ email: message.email, ...range, state: "free", periods: [] }] };
    }
  });
  await ui.document.fire("DOMContentLoaded");
  await settle();
  await rowFor(ui, filterCatalog[0].email).querySelector(".calendar-button").fire("click");
  await settle();
  return ui;
}

function dayQueries(ui){ return ui.messages.filter(message => message.type === "resource:availability" && message.email); }

async function calendarKey(ui, key, modifiers = {}){
  const target = ui.document.activeElement;
  const event = { key, target, ...modifiers };
  await target.fire("keydown", event);
  if (target !== ui.elements.get("calendarDays")) await ui.elements.get("calendarDays").fire("keydown", event);
  await ui.document.fire("keydown", event);
}

async function testAnchoredDateCalendar(){
  const ui = await openDateTestUi();
  const trigger = ui.elements.get("dayDate"), popover = ui.elements.get("datePopover");
  const dates = () => popover.querySelectorAll(".calendar-date");
  assert(trigger.tagName === "button" && trigger.type === "button"
    && !/<input\b[^>]*\btype="date"/.test(readText("ui/calendarResources.html")),
  "The date control must not invoke a native date popup that can fall behind Thunderbird's panel");
  assert(ui.elements.get("dateControl").contains(trigger) && ui.elements.get("dateControl").contains(popover)
    && ui.elements.get("dayView").contains(popover), "The month calendar must remain anchored inside the existing day view");
  const queryCount = dayQueries(ui).length;
  await trigger.fire("click");
  const selected = dates().find(button => button.dataset.date === "2026-10-25");
  assert(!popover.hidden && trigger.getAttribute("aria-expanded") === "true"
    && trigger.getAttribute("aria-controls") === "datePopover" && ui.document.activeElement === selected,
  "Opening the anchored calendar focuses the selected day and exposes its expanded state");
  assert(dates().filter(button => button.tabIndex === 0).length === 1 && selected.tabIndex === 0
    && selected.classList.contains("is-selected") && selected.parentElement.getAttribute("aria-selected") === "true",
  "The month grid must have one keyboard tab stop and expose the selected date separately");
  assert(ui.elements.get("calendarDays").children.length === 6
    && ui.elements.get("calendarDays").querySelectorAll("td").length === 42
    && ui.elements.get("calendarWeekdays").children.length === 7
    && ui.elements.get("calendarMonth").getAttribute("aria-live") === "polite",
  "The calendar must render complete weeks with weekday headers and announce month changes");
  assert(selected.getAttribute("aria-label")?.includes("2026"), "Calendar dates need full accessible labels, not just day numbers");
  const month = ui.elements.get("calendarMonth").textContent;
  await ui.elements.get("nextMonth").fire("click");
  assert(ui.elements.get("calendarMonth").textContent !== month && trigger.value === "2026-10-25"
    && dayQueries(ui).length === queryCount, "Browsing months must not change the selected date or issue DAV queries");
  await ui.document.fire("keydown", { key: "Escape" });
  assert(popover.hidden && trigger.getAttribute("aria-expanded") === "false"
    && !ui.elements.get("dayView").hidden && ui.document.activeElement === trigger && !ui.window.closed,
  "Escape closes the month calendar first and returns focus to the date button");
  await trigger.fire("click");
  assert(ui.document.activeElement.dataset.date === "2026-10-25", "Reopening starts at the selected date, not an abandoned month");
  const chosen = dates().find(button => button.dataset.date === "2026-10-26");
  ui.document.activeElement = ui.document;
  await ui.elements.get("dateControl").fire("focusout", { relatedTarget: chosen });
  await settle();
  assert(!popover.hidden, "A native focus transition through body must not hide the chosen day before its click");
  chosen.focus();
  await chosen.fire("click");
  await settle();
  assert(popover.hidden && trigger.value === "2026-10-26" && trigger.textContent.includes("2026")
    && ui.document.activeElement === trigger && dayQueries(ui).length === queryCount + 1
    && dayQueries(ui).at(-1).date === "2026-10-26",
  "Choosing a date updates the visible value, queries it exactly once, and restores date-button focus");
  await trigger.fire("click");
  ui.elements.get("calendarClose").focus();
  await ui.document.fire("keydown", { key: "Tab" });
  assert(ui.document.activeElement === ui.elements.get("previousMonth"), "Tab stays inside the open month calendar");
  await ui.document.fire("keydown", { key: "Tab", shiftKey: true });
  assert(ui.document.activeElement === ui.elements.get("calendarClose"), "Reverse Tab wraps within the month calendar");
  await ui.elements.get("calendarClose").fire("click");
  ui.elements.get("dayScroll").focus();
  await ui.document.fire("keydown", { key: "Tab" });
  assert(ui.document.activeElement === ui.elements.get("dayClose"), "Hidden month controls cannot enter the day view tab order");
  await trigger.fire("click");
  await ui.elements.get("dayClose").fire("click");
  assert(popover.hidden && trigger.getAttribute("aria-expanded") === "false" && ui.elements.get("dayView").hidden,
    "Closing the day view must also reset its anchored calendar");
  await rowFor(ui, filterCatalog[1].email).querySelector(".calendar-button").fire("click");
  await settle();
  assert(popover.hidden && trigger.value === "2026-10-25", "Opening another resource cannot inherit a previous calendar overlay");
}

async function testDateCalendarKeyboardAndDismissal(){
  const ui = await openDateTestUi("2028-01-31");
  const trigger = ui.elements.get("dayDate"), popover = ui.elements.get("datePopover");
  const before = dayQueries(ui).length;
  await trigger.fire("click");
  await calendarKey(ui, "PageUp");
  assert(ui.document.activeElement.dataset.date === "2027-12-31", "Previous-month navigation must cross into the preceding year");
  await calendarKey(ui, "ArrowRight");
  assert(ui.document.activeElement.dataset.date === "2028-01-01", "Day navigation must cross New Year's Day without a time-zone shift");
  await calendarKey(ui, "ArrowLeft");
  await calendarKey(ui, "PageDown");
  await calendarKey(ui, "PageDown");
  assert(ui.document.activeElement.dataset.date === "2028-02-29", "Month navigation must clamp January 31 to leap-year February 29");
  await calendarKey(ui, "PageDown", { shiftKey: true });
  assert(ui.document.activeElement.dataset.date === "2029-02-28", "Year navigation must clamp leap day in a non-leap year");
  await calendarKey(ui, "ArrowRight");
  assert(ui.document.activeElement.dataset.date === "2029-03-01", "Arrow navigation must cross month boundaries");
  await calendarKey(ui, "ArrowUp");
  assert(ui.document.activeElement.dataset.date === "2029-02-22", "Arrow Up moves exactly one civil week");
  await calendarKey(ui, "Home");
  assert(ui.document.activeElement.dataset.date === "2029-02-19", "Home moves to Monday of the focused week");
  await calendarKey(ui, "End");
  assert(ui.document.activeElement.dataset.date === "2029-02-25", "End moves to Sunday of the focused week");
  assert(trigger.value === "2028-01-31" && dayQueries(ui).length === before,
    "Keyboard browsing cannot commit a date or query availability before explicit selection");
  await ui.document.activeElement.fire("click");
  await settle();
  assert(trigger.value === "2029-02-25" && dayQueries(ui).length === before + 1,
    "Selecting a keyboard-focused date follows the same single-query path");
  await trigger.fire("click");
  const inside = ui.elements.get("nextMonth");
  ui.document.activeElement = ui.document;
  await ui.elements.get("dateControl").fire("focusout", { relatedTarget: inside });
  assert(!popover.hidden, "Moving focus between month controls must not dismiss the calendar");
  inside.focus();
  const outside = ui.elements.get("today");
  outside.focus();
  await ui.elements.get("dateControl").fire("focusout", { relatedTarget: outside });
  assert(popover.hidden && ui.document.activeElement === outside && trigger.value === "2029-02-25",
    "Leaving the calendar dismisses it without stealing focus or changing the selected date");
  await trigger.fire("click");
  ui.elements.get("dayScroll").focus();
  await ui.document.fire("click", { target: ui.elements.get("dayScroll") });
  assert(popover.hidden && ui.document.activeElement === ui.elements.get("dayScroll") && !ui.elements.get("dayView").hidden,
    "Outside clicks dismiss only the month calendar, preserving the user's focus target");
  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: appointment.timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(Date.now());
  const today = ["year", "month", "day"].map(type => todayParts.find(part => part.type === type).value).join("-");
  await ui.elements.get("today").fire("click");
  await settle();
  await trigger.fire("click");
  const todayButton = popover.querySelectorAll(".calendar-date").find(button => button.dataset.date === today);
  assert(trigger.value === today && todayButton?.getAttribute("aria-current") === "date"
    && dayQueries(ui).at(-1).date === today, "Today must use the appointment time zone and identify the current calendar day");
}

async function testUnavailableAndIncompleteQueries(){
  for (const interval of [null, { ...appointment, timeZone: "Invalid/Zone" }, { ...appointment, end: appointment.start }]){
    const ui = createUi("calendarResources", () => ({ ...listResponse(), interval }));
    await ui.document.fire("DOMContentLoaded");
    await settle();
    assert(ui.rows().every(row => row.querySelector(".availability-unknown"))
      && !ui.messages.some(message => message.type === "resource:availability"),
    "An absent, invalid, or empty appointment interval cannot initiate a query or claim availability");
  }
  for (const failure of ["transport", "partial", "denied"]){
    const ui = createUi("calendarResources", () => ({ ...listResponse(), resources: filterCatalog, interval: appointment }), undefined, {
      onAux: message => {
        if (message.type === "resource:interval"){
          if (failure === "denied") return { ok: false, code: "seat_paused", error: "Seat paused" };
          throw new Error("Editor unavailable");
        }
        if (message.type !== "resource:availability") return { ok: true };
        if (failure === "transport") throw new Error("DAV unavailable");
        return availableResponse();
      }
    });
    await ui.document.fire("DOMContentLoaded");
    await settle();
    if (failure === "transport"){
      assert(ui.rows().every(row => row.querySelector(".availability-unknown")),
        "Transport failure must show unknown for every entry, never free");
    }else{
      assert(ui.rows().every(row => row.querySelector(".availability-free")), "The fixture starts with confirmed availability");
      await ui.tick();
      assert(ui.rows().every(row => row.querySelector(".availability-unknown")),
        "Loss of the live interval or access must discard previously confirmed free states");
      if (failure === "denied") assert(ui.elements.get("apply").disabled && ui.elements.get("status").textContent === "Seat paused",
        "A new Seat refusal during interval polling must disable editor application and preserve its reason");
    }
  }
  const dayRange = { start: Date.parse("2026-03-28T23:00:00Z"), end: Date.parse("2026-03-29T22:00:00Z") };
  const spring = { ...appointment, start: dayRange.start + 9 * 3600000, end: dayRange.start + 10 * 3600000 };
  const ui = createUi("calendarResources", () => ({ ...listResponse(), resources: filterCatalog, interval: spring }), undefined, {
    onAux: message => !message.email ? availableResponse(spring) : {
      ok: true, interval: spring, range: dayRange,
      results: [{ email: message.email, state: "free", start: dayRange.start + 3600000, end: dayRange.end, periods: [] }]
    }
  });
  await ui.document.fire("DOMContentLoaded");
  await settle();
  await rowFor(ui, filterCatalog[0].email).querySelector(".calendar-button").fire("click");
  await settle();
  const timeline = ui.elements.get("timeline");
  assert(timeline.style.height === "828px" && timeline.querySelectorAll(".day-hour").length === 23,
    "Spring daylight saving must retain its actual 23-hour day");
  assert(timeline.querySelector(".day-track.is-unknown") && ui.elements.get("dayStatus").textContent,
    "Partial day coverage cannot paint green free time or hide its warning");
}

async function testActionMenu(){
  const ui = createUi("calendarAction", message => message.type === "calendar:claimPopupContext"
    ? { ok: true, contextId: "opaque id/1" }
    : { ok: true, talk: { enabled: true, code: "", notice: "" }, resources: { enabled: false, code: "no_seat", notice: "A valid Seat is required." } });
  await ui.document.fire("DOMContentLoaded");
  await settle();
  assert(!ui.elements.get("talk").disabled && !ui.elements.get("resources").disabled,
    "Both entries remain invocable when only resources lack entitlement");
  assert(ui.elements.get("resources").title === "A valid Seat is required."
    && ui.elements.get("resourceNotice").hidden, "A policy refusal uses its tooltip and click explanation, not duplicated text");
  await ui.elements.get("resources").fire("click");
  const deniedUrl = new URL(ui.window.destination, "https://extension.test/ui/");
  assert(deniedUrl.pathname === "/ui/connectionRequired.html"
    && deniedUrl.searchParams.get("notice") === "A valid Seat is required."
    && deniedUrl.searchParams.get("native") === "1",
  "A refused resource action must show its existing notice, not open the picker");
  await ui.elements.get("talk").fire("click");
  assert(ui.window.destination === "talkDialog.html?contextId=opaque%20id%2F1",
    "Talk navigation must retain and encode the exact editor context");

  const resourceUi = createUi("calendarAction", message => message.type === "calendar:claimPopupContext"
    ? { ok: true, contextId: "resource-event" }
    : { ok: true, talk: { enabled: false, code: "talk_unavailable", notice: "Talk is disabled." }, resources: { enabled: true, code: "", notice: "" } });
  await resourceUi.document.fire("DOMContentLoaded");
  await settle();
  await resourceUi.elements.get("resources").fire("click");
  assert(resourceUi.window.destination === "calendarResources.html?contextId=resource-event"
    && resourceUi.messages.every(message => ["calendar:claimPopupContext", "calendar:actionState"].includes(message.type)),
  "The resource card must only open the picker, not create a booking");

  const errorUi = createUi("calendarAction", message => message.type === "calendar:claimPopupContext"
    ? { ok: true, contextId: "event-1" } : { ok: false, error: "Localized access failure", code: "auth_required" });
  await errorUi.document.fire("DOMContentLoaded");
  await settle();
  assert(!errorUi.elements.get("reauthenticate").hidden && errorUi.elements.get("talk").disabled
    && errorUi.elements.get("status").textContent === "Localized access failure",
  "Menu failures must keep actions disabled and preserve the shared localized explanation");

  for (const code of ["enterprise_seat_required", "seat_paused", "license_expired", "auth_required", "rate_limited"]){
    const denied = { enabled: false, code, notice: `Existing notice: ${code}` };
    const blocked = createUi("calendarAction", message => message.type === "calendar:claimPopupContext"
      ? { ok: true, contextId: "blocked-event" }
      : { ok: true, talk: denied, resources: denied });
    await blocked.document.fire("DOMContentLoaded");
    await settle();
    const destination = new URL(blocked.window.destination, "https://extension.test/ui/");
    assert(destination.pathname === "/ui/connectionRequired.html"
      && destination.searchParams.get("notice") === denied.notice,
    "Identical refusals must show one compact notice without rendering disabled cards");
    assert(destination.searchParams.has("reauthenticate") === (code === "auth_required"),
      "Only authentication refusal offers sign-in, never Seat/license/rate refusal");
    assert(blocked.messages.length === 2 && blocked.elements.get("talk").disabled
      && blocked.elements.get("resources").disabled, "A refused menu makes no wizard/directory requests");
  }
  const readonly = createUi("calendarAction", message => message.type === "calendar:claimPopupContext"
    ? { ok: true, contextId: "readonly" }
    : { ok: true, talk: { enabled: true, code: "", notice: "" }, resources: { enabled: false, code: "resource_readonly", notice: "Read-only event" } });
  await readonly.document.fire("DOMContentLoaded");
  await settle();
  await readonly.elements.get("resources").fire("click");
  assert(readonly.elements.get("resources").disabled && !readonly.window.destination
    && readonly.elements.get("resourceNotice").textContent === "Read-only event",
  "A genuinely unusable editor context stays disabled with a visible reason");
  for (const malformed of [undefined, {}, { enabled: "true", code: "", notice: "" },
    { enabled: false, code: "no_seat", notice: "" }, { enabled: true, code: "no_seat", notice: "Denied" }]){
    const broken = createUi("calendarAction", message => message.type === "calendar:claimPopupContext"
      ? { ok: true, contextId: "broken" }
      : { ok: true, talk: malformed, resources: { enabled: true, code: "", notice: "" } });
    await broken.document.fire("DOMContentLoaded");
    await settle();
    assert(broken.elements.get("talk").disabled && broken.elements.get("resources").disabled
      && !broken.window.destination && broken.elements.get("status").textContent
      && broken.errors.length === 1, "Malformed access responses must fail closed with a localized error, never undefined notice text");
  }
}

function testAccessNoticeStyle(){
  const theme = readText("ui/tbTheme.css");
  assert(theme.includes("--tb-error:#b00020") && theme.includes("--tb-error:#ff858f")
    && theme.includes("--tb-error:CanvasText"), "Refusals require red light/dark colors and system high-contrast text");
  const html = readText("ui/connectionRequired.html");
  assert(html.includes("body.native-popup{width:420px;height:auto;}")
    && html.includes("min-width:420px") && !html.includes("100vw"),
  "The shared notice must keep intrinsic width inside the native calendar panel");
  assert(html.includes(".message.is-error{color:var(--tb-error);}")
    && html.includes('class="nc-brand-header"'), "The compact notice reuses the red theme color and shared header");
  const warning = theme.match(/\.wizard-policy-warning\s*\{([^}]+)\}/)?.[1] || "";
  assert(warning.includes("color:var(--tb-error)") && warning.includes("border:1px solid var(--tb-error)"),
    "The shared wizard warning must retain readable red for a later refusal");
  assert(/\.wizard-policy-warning\.is-informational\s*\{[^}]*#b8860b/.test(theme),
    "The shared wizard warning must retain its existing informational color");
  for (const page of ["nextcloudSharingWizard", "talkDialog", "calendarResources"]){
    const markup = readText(`ui/${page}.html`);
    assert(markup.includes('class="wizard-policy-warning"') && markup.includes('href="tbTheme.css"'),
      `${page} must reuse the shared wizard banner presentation`);
    const localRule = markup.match(/\.wizard-policy-warning\s*\{([^}]+)\}/)?.[1] || "";
    assert(!/color:|border:|background:/.test(localRule), "Pages must not retain duplicate warning colors");
  }
}

function testUiMarkup(){
  for (const page of ["calendarAction", "calendarResources"]){
    const script = readText(`ui/${page}.js`);
    const html = readText(`ui/${page}.html`);
    assert(!/innerHTML|insertAdjacentHTML|eval\(/.test(script), "Resource UI cannot insert untrusted markup");
    assert(html.includes('href="tbTheme.css"'), "Calendar pages must follow the existing Thunderbird theme");
    assert(!/windows\.(?:create|update)\s*\(/.test(script), "Native action popups must not open a window or resize the host editor");
    assert(script.includes("NCLogContext.safeConsoleError"), "UI failures must use the shared safe logger");
  }
  const css = readText("ui/calendarResources.css");
  const resourceHtml = readText("ui/calendarResources.html");
  const groupingRow = resourceHtml.match(/<div class="resource-grouping">([\s\S]*?)<\/div>/)?.[1] || "";
  assert(groupingRow.includes('id="search"') && groupingRow.indexOf('id="grouping"') < groupingRow.indexOf('id="search"')
    && groupingRow.indexOf('id="search"') < groupingRow.indexOf('id="expandAll"'),
  "Search must share the grouping row between grouping and expand-all, without an extra row above the filters");
  assert(!/<h1\b/i.test(resourceHtml) && resourceHtml.includes('<title data-i18n="resource_title">'),
    "The picker must retain its localized window title without a duplicate content heading");
  const helperPaths = ["../modules/policyState.js", "wizardPolicyUi.js", "calendarResources.js"];
  const helperPositions = helperPaths.map(source => resourceHtml.indexOf(`src="${source}"`));
  assert(helperPositions.every(position => position >= 0)
    && helperPositions[0] < helperPositions[1] && helperPositions[1] < helperPositions[2],
  "The resource picker must load the shared status and warning helpers before its own UI");
  assert(/\.resource-group-heading\s*\{[^}]*font-weight:600/.test(css)
    && !/\.resource-group-heading\s*\{[^}]*(?:color:blue|#0000ff)/i.test(css),
    "Interactive group headings must remain prominent without dark blue text");
  assert(css.includes("overflow:auto") && /@media\s*\(max-width:600px\)/.test(css),
    "Catalogs and metadata must remain accessible in small popups");
  const detailsRules = [...css.matchAll(/\.resource-details\s*\{([^}]+)\}/g)];
  assert(detailsRules.length > 0 && detailsRules.every(([, rule]) =>
    !/(?:^|;)\s*(?:(?:max-)?height|overflow(?:-[xy])?)\s*:/.test(rule)),
  "Details must grow with their text instead of clipping it or creating a nested scrollbar");
  const columnsRule = css.match(/\.resource-columns\s*\{([^}]+)\}/)[1];
  assert(/min-height:(?:2[8-9]\d|[3-9]\d\d)px/.test(columnsRule) && /flex:1/.test(columnsRule),
    "The catalog and details must retain usable height and share remaining panel space");
  assert(!/(?:^|;)\s*(?:max-)?height\s*:/.test(columnsRule),
    "The detail column must not be constrained to the old fixed row height");
  assert(/\.resource-list\s*\{[^}]*contain:size[^}]*overflow:auto/.test(css),
    "The catalog must scroll independently without determining the details height");
}

function testActionCardLabels(){
  const html = readText("ui/calendarAction.html");
  for (const [button, prefix, key] of [["talk", "talk", "talk"], ["resources", "resource", "resources"]]){
    const markup = html.match(new RegExp(`<button id="${button}"[^>]*>[\\s\\S]*?</button>`))?.[0] || "";
    assert(markup.includes(`aria-labelledby="${prefix}Label"`)
      && markup.includes(`aria-describedby="${prefix}Description ${prefix}Notice"`),
    "Each card must expose its title, explanation, and existing access notice separately");
    assert(markup.includes(`id="${prefix}Label" data-i18n="calendar_action_${key}"`)
      && markup.includes(`id="${prefix}Description" class="action-description" data-i18n="calendar_action_${key}_description"`),
    "Card titles and descriptions must use localized text");
  }
  assert(html.includes('<rect x="3" y="6" width="12" height="12" rx="2"/>')
    && !html.includes('d="M4 4h16v12H9l-5 4z"'), "Talk must use the camera icon instead of the chat bubble");
}

function testSharedHeaders(){
  const theme = readText("ui/tbTheme.css");
  const rule = theme.match(/\.nc-brand-header\s*\{([^}]+)\}/)?.[1] || "";
  assert(rule.includes("height:48px") && rule.includes("flex:0 0 48px"),
    "All four headers must retain the Share picker's 48px height under flex pressure");
  assert(/\.nc-brand-header img\s*\{[^}]*height:100%[^}]*object-fit:contain/.test(theme),
    "All four headers must use the same proportional logo sizing");
  for (const page of ["nextcloudSharingWizard", "talkDialog", "calendarAction", "calendarResources"]){
    const html = readText(`ui/${page}.html`);
    assert(html.includes('href="tbTheme.css"') && html.includes('class="nc-brand-header"'),
      `${page} must use the shared brand header`);
    assert(!/nc-dialog-hero|dialog-hero|calendar-hero|--header-height/.test(html),
      `${page} must not keep a second local header definition`);
  }
  assert(!/calendar-hero|nc-brand-header/.test(readText("ui/calendarAction.css")),
    "Calendar pages must not override the shared header height");
}

function testNativePopupSizingContract(){
  // A native ViewPopup obtains its preferred width with an initial width of zero.
  // Fake DOM interaction tests cannot detect CSS that caps it to that viewport.
  // Keep both entry pages intrinsically sized; Thunderbird supplies the 800px cap.
  const actionCss = readText("ui/calendarAction.css");
  for (const [page, bodyClass, width] of [
    ["calendarAction", "calendar-menu", 420],
    ["calendarResources", "resource-picker", 780]
  ]){
    const html = readText(`ui/${page}.html`);
    const css = page === "calendarAction" ? actionCss : `${actionCss}\n${readText(`ui/${page}.css`)}`;
    const rule = css.match(new RegExp(`\\.${bodyClass}\\s*\\{([^}]+)\\}`));
    assert(html.includes(`class="${bodyClass}"`) && rule, `${page} must use its native-popup body rule`);
    assert(new RegExp(`(?:^|;)\\s*width\\s*:\\s*${width}px\\s*(?:;|$)`).test(rule[1]),
      `${page} must declare its intrinsic width independently of the initial popup viewport`);
    assert(!/(?:max|min)-width\s*:/.test(rule[1]), `${page} must not override its intrinsic width with a viewport cap`);
    assert(!/\b(?:\d*\.)?\d+(?:dvw|svw|lvw|vw)\b/.test(css),
      `${page} must not introduce circular viewport-relative popup sizing`);
    assert(!html.includes("popupSizing.js") && !/resizeTo\s*\(|windows\.update\s*\(/.test(readText(`ui/${page}.js`)),
      `${page} must let the native panel resize itself, not its editor window`);
  }
}

async function testReadWriteRaces(){
  const groupQuery = deferred();
  const keyboard = createUi('calendarResources', () => ({ ...listResponse(), resources: filterCatalog, interval: appointment }), undefined, {
    onAux: message => message.type === 'resource:availability' ? groupQuery.promise : { ok: true }
  });
  await keyboard.document.fire('DOMContentLoaded');
  await settle();
  const groupHeading = keyboard.document.querySelector('.resource-group-heading');
  groupHeading.focus();
  groupQuery.resolve(availableResponse());
  await settle();
  assert(keyboard.document.activeElement !== groupHeading && keyboard.document.activeElement.isConnected
    && keyboard.document.activeElement.dataset.groupKey === groupHeading.dataset.groupKey,
  'An asynchronous status repaint preserves keyboard focus on the current group');
  for (const lane of ['resource:availability', 'resource:interval']){
    const pendingRead = deferred();
    const pendingWrite = deferred();
    const ui = createUi('calendarResources', message => message.type === 'resource:list'
      ? { ...listResponse(), resources: filterCatalog, interval: appointment } : pendingWrite.promise, undefined, {
      onAux: message => message.type === lane ? pendingRead.promise
        : message.type === 'resource:availability' ? availableResponse() : { ok: true }
    });
    await ui.document.fire('DOMContentLoaded');
    await settle();
    const tick = lane === 'resource:interval' ? ui.tick() : Promise.resolve();
    await settle();
    const write = ui.elements.get('apply').fire('click');
    await settle();
    assert(ui.messages.some(message => message.type === 'resource:cancel')
      && ui.messages.some(message => message.type === 'resource:apply'), 'Apply cancels read queries before writing');
    pendingRead.resolve({ ok: false, code: 'seat_paused', error: 'Delayed refusal' });
    await tick;
    await settle();
    assert(ui.elements.get('apply').disabled && ui.elements.get('cancel').disabled
      && ui.elements.get('status').textContent !== 'Delayed refusal',
    'A late read refusal cannot unlock controls or replace status during the atomic draft write');
    pendingWrite.resolve({ ok: true });
    await write;
    assert(ui.window.closed, 'The independent write response completes normally');
  }

  const delayedList = deferred();
  const loading = createUi('calendarResources', () => delayedList.promise);
  await loading.document.fire('DOMContentLoaded');
  await settle();
  await loading.window.fire('pagehide');
  assert(loading.messages.some(message => message.type === 'resource:close' && message.selectionToken === null),
    'Closing during initial catalog loading cancels the tokenless loading session');
  delayedList.resolve(listResponse());
  await settle();
  assert(loading.rows().length === 0, 'A catalog response cannot initialize a closed popup');

  let rejectPoll;
  let loads = 0;
  const reloaded = createUi('calendarResources', () => ({ ...listResponse(), resources: filterCatalog,
    interval: appointment, selectionToken: `session-${++loads}` }), undefined, {
    onAux: message => message.type === 'resource:interval' ? new Promise((_resolve, reject) => { rejectPoll = reject; })
      : message.type === 'resource:availability' ? availableResponse() : { ok: true }
  });
  await reloaded.document.fire('DOMContentLoaded');
  await settle();
  const poll = reloaded.tick();
  await settle();
  await reloaded.elements.get('retry').fire('click');
  await settle();
  rejectPoll(new Error('Old editor query failed'));
  await poll;
  assert(reloaded.rows().every(row => row.querySelector('.availability-free')),
    'An old failed poll must not erase availability from a successfully reloaded session');
}

async function run(){
  await testReadWriteRaces();
  await testPickerSelection();
  await testPickerFailureAndCancellation();
  await testUnbookableCatalogRows();
  await testPickerPolicyWarnings();
  await testPickerWarningLifecycle();
  await testMetadataFiltersAndGrouping();
  await testGroupingPreferences();
  await testAvailabilityFilteringAndStaleResponses();
  await testDayViewInSamePopup();
  await testAnchoredDateCalendar();
  await testDateCalendarKeyboardAndDismissal();
  await testUnavailableAndIncompleteQueries();
  await testActionMenu();
  testUiMarkup();
  testAccessNoticeStyle();
  testActionCardLabels();
  testSharedHeaders();
  testNativePopupSizingContract();
  console.log("[OK] calendar-resource-ui-check passed");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
