/**
 * Calendar and address book setup contract.
 *
 * Run:
 *   node tools/collection-sync-check.js
 */
"use strict";

const vm = require("node:vm");
const { assert, loadScript, readText } = require("./review-check-utils");

const BASE_URL = "https://cloud.example.test/nc";
const ORIGIN = "https://cloud.example.test";
const HOME = "/nc/remote.php/dav/calendars/alice/";
const BOOKS = "/nc/remote.php/dav/addressbooks/users/alice/";

/**
 * Minimal namespace-aware XML DOM for the PROPFIND parser.
 */
class XmlElement {
  constructor(prefixedName, attributes, nsScope){
    const [prefix, local] = prefixedName.includes(":") ? prefixedName.split(":") : ["", prefixedName];
    this.localName = local;
    this.attributes = attributes;
    this.nsScope = nsScope;
    this.namespaceURI = nsScope[prefix] || "";
    this.children = [];
    this.text = "";
  }
  get textContent(){
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  getAttribute(name){
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  getElementsByTagNameNS(ns, localName){
    const found = [];
    const walk = (node) => {
      for (const child of node.children){
        if (child.namespaceURI === ns && child.localName === localName) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  getElementsByTagName(name){
    return name === "parsererror" ? [] : [];
  }
}

class FakeDOMParser {
  parseFromString(xml){
    const root = new XmlElement("#document", {}, {});
    const stack = [root];
    const tokens = xml.replace(/<\?[^>]*\?>/g, "").match(/<[^>]+>|[^<]+/g) || [];
    for (const token of tokens){
      const parent = stack[stack.length - 1];
      if (!token.startsWith("<")){
        parent.text += token.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        continue;
      }
      if (token.startsWith("</")){
        stack.pop();
        continue;
      }
      const selfClosing = token.endsWith("/>");
      const body = token.slice(1, selfClosing ? -2 : -1).trim();
      const name = body.split(/\s+/)[0];
      const attributes = {};
      for (const match of body.matchAll(/([\w:.-]+)="([^"]*)"/g)){
        attributes[match[1]] = match[2];
      }
      const nsScope = { ...parent.nsScope };
      for (const [key, value] of Object.entries(attributes)){
        if (key === "xmlns") nsScope[""] = value;
        if (key.startsWith("xmlns:")) nsScope[key.slice(6)] = value;
      }
      const element = new XmlElement(name, attributes, nsScope);
      parent.children.push(element);
      if (!selfClosing) stack.push(element);
    }
    return root;
  }
}

function calendarResponse(href, { name, color = "", comps = ["VEVENT"], write = true, extraType = "", calendar = true }){
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>
    <d:resourcetype><d:collection/>${calendar ? "<cal:calendar/>" : ""}${extraType}</d:resourcetype>
    <d:displayname>${name}</d:displayname>
    ${color ? `<x1:calendar-color xmlns:x1="http://apple.com/ns/ical/">${color}</x1:calendar-color>` : ""}
    <cal:supported-calendar-component-set>${comps.map((comp) => `<cal:comp name="${comp}"/>`).join("")}</cal:supported-calendar-component-set>
    <d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${write ? "<d:privilege><d:write/></d:privilege>" : ""}</d:current-user-privilege-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function multistatus(responses){
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">`
    + `<d:response><d:href>${HOME}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    + responses.join("") + "</d:multistatus>";
}

const FULL_HOME = [
  calendarResponse(HOME + "personal/", { name: "Persönlich", color: "#0082C9FF" }),
  calendarResponse(HOME + "team_shared_by_bob/", { name: "Team (Bob)", write: false }),
  calendarResponse(HOME + "tasks/", { name: "Aufgaben", comps: ["VTODO"] }),
  calendarResponse(HOME + "inbox/", { name: "inbox", calendar: false, extraType: "<cal:schedule-inbox/>" }),
  calendarResponse(HOME + "outbox/", { name: "outbox", calendar: false, extraType: "<cal:schedule-outbox/>" }),
  calendarResponse(HOME + "trashbin/", { name: "trash", calendar: false }),
  calendarResponse(HOME + "holidays/", { name: "Feiertage", extraType: "<cs:subscribed/>" }),
  calendarResponse(HOME + "journal/", { name: "Journal", comps: ["VJOURNAL"] })
];

function bookResponse(href, { name, write = true, book = true }){
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>
    <d:resourcetype><d:collection/>${book ? "<card:addressbook/>" : ""}</d:resourcetype>
    <d:displayname>${name}</d:displayname>
    <d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${write ? "<d:privilege><d:write/></d:privilege>" : ""}</d:current-user-privilege-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function bookMultistatus(responses){
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">`
    + `<d:response><d:href>${BOOKS}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    + responses.join("") + "</d:multistatus>";
}

const FULL_BOOKS = [
  bookResponse(BOOKS + "contacts/", { name: "Kontakte" }),
  bookResponse(BOOKS + "z-server-generated--system/", { name: "Konten", write: false }),
  bookResponse(BOOKS + "kunden_shared_by_bob/", { name: "Kunden (Bob)" }),
  bookResponse(BOOKS + "z-app-generated--contactsinteraction--recent/", { name: "Recently contacted" })
];

function createHarness({ enabled = true, books = false, storage = { calendarSyncEnabled: enabled, addressBookSyncEnabled: books } } = {}){
  const tb = new Map();
  const ab = new Map();
  let nextId = 1;
  const calls = { logins: [], created: [], removed: [], updated: [], books: [], booksRemoved: [], booksRenamed: [] };
  const harness = { storage, tb, ab, calls, home: FULL_HOME.slice(), books: FULL_BOOKS.slice(), userId: "alice", appPass: "app-pass" };
  const context = {
    console: { ...console, error: () => {} },
    URL,
    JSON,
    Date,
    DOMParser: FakeDOMParser,
    setTimeout: () => 0,
    setInterval: () => 0,
    L: () => {},
    bgI18n: (key) => key,
    browser: {
      storage: {
        local: {
          get: async (keys) => {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((key) => key in storage).map((key) => [key, JSON.parse(JSON.stringify(storage[key]))]));
          },
          set: async (values) => Object.assign(storage, JSON.parse(JSON.stringify(values)))
        },
        onChanged: { addListener: () => {} }
      },
      ncDavCollections: {
        saveLogin: async (login) => { calls.logins.push(login); },
        createCalendar: async (props) => {
          const id = "cal-" + nextId++;
          tb.set(id, { id, type: "caldav", url: props.url, name: props.name, color: props.color, readOnly: !!props.readOnly, enabled: true });
          calls.created.push(props);
          return id;
        },
        listAddressBooks: async () => [...ab.values()].map(({ id, url, name }) => ({ id, url, name })),
        createAddressBook: async (props) => {
          const id = "ab-" + nextId++;
          ab.set(id, { id, url: props.url, name: props.name, readOnly: !!props.readOnly });
          calls.books.push(props);
          return id;
        },
        renameAddressBook: async (id, name) => { ab.get(id).name = name; calls.booksRenamed.push({ id, name }); },
        removeAddressBook: async (id) => { ab.delete(id); calls.booksRemoved.push(id); }
      },
      calendar: {
        calendars: {
          get: async (id) => tb.get(id) || null,
          query: async ({ type, enabled }) => [...tb.values()].filter((entry) => entry.type === type
            && (enabled == null || entry.enabled !== false) === (enabled == null || enabled)),
          remove: async (id) => { tb.delete(id); calls.removed.push(id); },
          update: async (id, changes) => { Object.assign(tb.get(id), changes); calls.updated.push({ id, changes }); }
        }
      }
    },
    NCCore: {
      getOpts: async () => ({ baseUrl: BASE_URL, user: "alice@example.test", appPass: harness.appPass }),
      getConnectionState: async () => ({ reason: "" }),
      getCurrentUserId: async () => harness.userId,
      getCapabilitiesSnapshot: async () => ({ capabilities: { theming: { name: "Example Cloud" } } }),
      runAuthenticatedRequest: ({ request }) => request(),
      onConnectionRestored: { addListener: () => {} }
    },
    NCHostPermissions: { hasOriginPermission: async () => true },
    NCOcs: { buildAuthHeader: (user, pass) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") },
    NCNextcloudDav: {
      fetchWithTimeout: ({ request }) => request(null),
      readResponseText: (response) => response.text()
    },
    fetch: async (url, init) => {
      assert(init.method === "PROPFIND" && init.headers.Depth === "1", "Calendar home must be listed with PROPFIND Depth 1");
      if (harness.failStatus){
        return { status: harness.failStatus, text: async () => "" };
      }
      if (url === `${BASE_URL}/remote.php/dav/addressbooks/users/${harness.userId}/`){
        return { status: 207, text: async () => bookMultistatus(harness.books) };
      }
      assert(url === `${BASE_URL}/remote.php/dav/calendars/${harness.userId}/`, "Calendar home URL must use the subfolder base and user id: " + url);
      return { status: 207, text: async () => multistatus(harness.home) };
    }
  };
  vm.createContext(context);
  loadScript("modules/bgCollectionSync.js", context, "\nglobalThis.__sync = NCCollectionSync;");
  harness.sync = context.__sync;
  harness.reset = () => {
    for (const list of Object.values(calls)) list.length = 0;
  };
  return harness;
}

async function checkDisabled(){
  const h = createHarness({ enabled: false });
  const result = await h.sync.syncNow("test");
  assert(result.skipped === "disabled", "Disabled sync must not touch the server");
  assert(h.calls.created.length === 0, "Disabled sync must not create calendars");
}

async function checkEnabledByDefault(){
  const h = createHarness();
  delete h.storage.calendarSyncEnabled;
  delete h.storage.addressBookSyncEnabled;
  const result = await h.sync.syncNow("test");
  assert(result.calendars?.created === 3 && result.addressBooks?.created === 3, "Calendars and address books sync without an explicit opt-in");
  const status = await h.sync.getStatus();
  assert(status.calendarsEnabled === true && status.addressBooksEnabled === true, "Status reports both switches on by default");
}

async function checkInitialAndSteadyState(){
  const h = createHarness();
  const result = (await h.sync.syncNow("test")).calendars;
  const urls = h.calls.created.map((entry) => entry.url).sort();
  assert(JSON.stringify(urls) === JSON.stringify([
    ORIGIN + HOME + "personal/",
    ORIGIN + HOME + "tasks/",
    ORIGIN + HOME + "team_shared_by_bob/"
  ]), "Only event/task calendars are mirrored, not inbox/outbox/trash/subscriptions/journals: " + urls.join(", "));
  assert(result.created === 3 && result.total === 3, "Initial sync reports created calendars");
  const login = h.calls.logins[0];
  assert(h.calls.logins.length === 1 && login.origin === ORIGIN && login.realm === "Example Cloud"
    && login.username === "alice@example.test" && login.password === "app-pass",
  "Login is stored under origin and theming realm before calendars are created");
  const personal = h.calls.created.find((entry) => entry.url.endsWith("personal/"));
  assert(personal.color === "#0082c9" && personal.username === "alice@example.test", "Color is normalized and username bound");
  assert(h.calls.created.find((entry) => entry.url.includes("shared_by_bob")).readOnly === true, "Shared read-only calendars stay read-only");

  h.reset();
  const again = (await h.sync.syncNow("test")).calendars;
  assert(again.created === 0 && again.removed === 0 && h.calls.updated.length === 0, "Unchanged server state is a no-op");
  assert(h.calls.logins.length === 1, "The login is refreshed on every pass");
}

async function checkAppPasswordAndStatus(){
  const h = createHarness();
  await h.sync.syncNow("test");
  h.appPass = "new-app-pass";
  h.reset();
  await h.sync.syncNow("test");
  assert(h.calls.logins.length === 1 && h.calls.logins[0].password === "new-app-pass",
    "A new app password reaches the stored login without creating anything");
  assert(h.calls.created.length === 0, "A password change does not recreate collections");

  h.failStatus = 503;
  let failed = false;
  await h.sync.syncNow("test").catch(() => { failed = true; });
  const failedStatus = await h.sync.getStatus();
  assert(failed && failedStatus.lastRun?.ok === false && failedStatus.lastRun.error.includes("503"),
    "A failed pass is reported with its error");
  h.failStatus = 0;
  await h.sync.syncNow("test");

  const restarted = createHarness({ storage: h.storage });
  const status = await restarted.sync.getStatus();
  assert(status.lastRun?.ok === true && status.lastRun.calendars?.total === 3,
    "The last result survives a background restart");
}

async function checkStatusCountsWhenSwitchedOff(){
  const h = createHarness();
  await h.sync.syncNow("test");
  h.tb.set("manual-off", { id: "manual-off", type: "caldav", url: ORIGIN + "/other/", name: "Manual", enabled: false });
  [...h.tb.values()].find((entry) => entry.url.endsWith("personal/")).enabled = false;
  h.storage.calendarSyncEnabled = false;
  const status = await h.sync.getStatus();
  assert(status.managed.calendars === 3, "Status counts managed calendars even when the switch is off");
  assert(status.disabledCalendars === 1, "Only managed calendars Thunderbird disabled are reported");
}

async function checkUserRemovalIsRemembered(){
  const h = createHarness();
  await h.sync.syncNow("test");
  const tasks = [...h.tb.values()].find((entry) => entry.url.endsWith("tasks/"));
  h.tb.delete(tasks.id);
  h.reset();
  await h.sync.syncNow("test");
  assert(h.calls.created.length === 0, "A calendar the user removed must not be re-added");
  const status = await h.sync.getStatus();
  assert(status.dismissed === 1, "Removed calendar is tracked as dismissed");
  const home = h.home;
  h.home = [];
  await h.sync.syncNow("test");
  assert((await h.sync.getStatus()).dismissed === 1, "An empty calendar home keeps the dismissed list");
  h.home = home;
  h.reset();
  await h.sync.restoreDismissed();
  assert(h.calls.created.length === 1 && h.calls.created[0].url.endsWith("tasks/"), "Restore adds dismissed calendars again");
}

async function checkServerChanges(){
  const h = createHarness();
  await h.sync.syncNow("test");
  h.home = h.home.filter((entry) => !entry.includes("team_shared_by_bob"))
    .map((entry) => entry.replace(">Persönlich<", ">Privat<"));
  h.home.push(calendarResponse(HOME + "project/", { name: "Projekt" }));
  h.reset();
  const result = (await h.sync.syncNow("test")).calendars;
  assert(result.removed === 1 && h.calls.removed.length === 1, "Calendars deleted on the server are removed");
  assert(result.created === 1 && h.calls.created[0].url.endsWith("project/"), "New server calendars are added");
  assert(h.calls.updated.length === 1 && h.calls.updated[0].changes.name === "Privat", "Server renames are followed");

  h.home = [];
  h.reset();
  const empty = (await h.sync.syncNow("test")).calendars;
  assert(empty.removed === 0, "An empty calendar home never wipes the mirrored calendars");
}

async function checkForeignAndAccountChange(){
  const h = createHarness();
  h.tb.set("manual", { id: "manual", type: "caldav", url: ORIGIN + HOME + "personal/", name: "Mine" });
  await h.sync.syncNow("test");
  assert(!h.calls.created.some((entry) => entry.url.endsWith("personal/")), "Calendars the user added manually are not duplicated");

  h.userId = "carol";
  h.home = [calendarResponse("/nc/remote.php/dav/calendars/carol/personal/", { name: "Carol" })];
  h.reset();
  await h.sync.syncNow("test");
  assert(h.calls.removed.length === 2 && !h.calls.removed.includes("manual"), "Account change removes only managed calendars");
  assert(h.calls.created.length === 1 && h.calls.created[0].url.includes("/carol/"), "New account calendars are added");
}

async function checkAddressBooks(){
  const h = createHarness({ enabled: false, books: true });
  const result = await h.sync.syncNow("test");
  assert(result.calendars === null && h.calls.created.length === 0, "Calendars stay untouched when only address books are enabled");
  const urls = h.calls.books.map((entry) => entry.url).sort();
  assert(JSON.stringify(urls) === JSON.stringify([
    ORIGIN + BOOKS + "contacts/",
    ORIGIN + BOOKS + "kunden_shared_by_bob/",
    ORIGIN + BOOKS + "z-server-generated--system/"
  ]), "Address books are mirrored without the recently contacted one: " + urls.join(", "));
  assert(h.calls.books.find((entry) => entry.url.includes("system")).readOnly === true, "The system address book stays read-only");
  assert(h.calls.logins.length === 1 && h.calls.logins[0].username === "alice@example.test", "Address books reuse the stored login");

  const kunden = [...h.ab.values()].find((entry) => entry.url.includes("kunden"));
  h.ab.delete(kunden.id);
  h.books = h.books.filter((entry) => !entry.includes("contacts/")).map((entry) => entry.replace(">Konten<", ">Mitarbeitende<"));
  h.reset();
  const next = (await h.sync.syncNow("test")).addressBooks;
  assert(h.calls.books.length === 0, "A locally removed address book is not re-added");
  assert(next.removed === 1 && h.calls.booksRemoved.length === 1, "Address books deleted on the server are removed");
  assert(h.calls.booksRenamed.length === 1 && h.calls.booksRenamed[0].name === "Mitarbeitende", "Server renames are followed");
}

function checkExperimentParses(){
  // The parent script runs in Thunderbird only; a syntax error there surfaces
  // as a generic "unexpected error" on every call.
  for (const relativePath of ["experiments/ncDavCollections/parent.js"]){
    try{
      new vm.Script(readText(relativePath), { filename: relativePath });
    }catch(error){
      assert(false, `${relativePath} must parse: ${error.message}`);
    }
  }
}

async function run(){
  checkExperimentParses();
  await checkDisabled();
  await checkEnabledByDefault();
  await checkInitialAndSteadyState();
  await checkAppPasswordAndStatus();
  await checkStatusCountsWhenSwitchedOff();
  await checkUserRemovalIsRemembered();
  await checkServerChanges();
  await checkForeignAndAccountChange();
  await checkAddressBooks();
  console.log("[OK] collection-sync-check passed");
}

run().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
