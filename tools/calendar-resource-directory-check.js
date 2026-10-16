'use strict';

const { assert, loadScript } = require("./review-check-utils");
const { createCoreHarness, collectLogText, expectRejected } = require("./network-security-test-utils");

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const NC = "http://nextcloud.com/ns";
const SABRE = "http://sabredav.org/ns";
const ACCOUNT = { baseUrl: "https://cloud.example.test/subfolder", user: "alice", appPass: "secret-not-for-logs" };
const DOCUMENTS = new Map();
let documentId = 0;
let assertions = 0;

function check(value, message){
  assert(value, message);
  assertions++;
}

function element(namespaceURI, localName, content = []){
  const childNodes = Array.isArray(content) ? content : [];
  return {
    nodeType: 1, namespaceURI, localName, childNodes,
    get textContent(){ return Array.isArray(content) ? childNodes.map((node) => node.textContent).join("") : content; }
  };
}

function documentXml(root, { parserError = false, doctype = null } = {}){
  // Only the native DOM boundary is mocked; fixtures expose actual namespace and child-node shapes.
  const xml = `<?xml version="1.0"?><fixture id="${++documentId}"/>`;
  DOCUMENTS.set(xml, {
    documentElement: root,
    doctype,
    getElementsByTagNameNS: (_namespace, name) => name === "parsererror" && parserError ? [root] : []
  });
  return xml;
}

class FixtureDOMParser {
  parseFromString(xml, type){
    check(type === "application/xml", "DAV uses the native XML parser mode");
    return DOCUMENTS.get(xml) || {
      documentElement: element("http://www.mozilla.org/newlayout/xml/parsererror.xml", "parsererror"),
      getElementsByTagNameNS: () => [{}]
    };
  }
}

function propstat(properties, status = "HTTP/1.1 200 OK"){
  return element(DAV, "propstat", [element(DAV, "status", status), element(DAV, "prop", properties)]);
}

function principal(kind = "ROOM", patch = {}){
  const email = patch.email || (kind === "ROOM" ? "room@resources.invalid" : "device@resources.invalid");
  const collection = kind === "ROOM" ? "calendar-rooms" : "calendar-resources";
  const properties = patch.properties || [
    element(DAV, "displayname", kind === "ROOM" ? "Elefantenraum" : "Eule"),
    element(CALDAV, "calendar-user-type", kind),
    element(CALDAV, "calendar-user-address-set", [element(DAV, "href", `mailto:${email}`)]),
    element(SABRE, "email-address", "unused-fallback@resources.invalid"),
    element(NC, "resource-type", "projector"),
    element(NC, "room-type", "meeting-room"),
    element(NC, "room-seating-capacity", "18"),
    element(NC, "room-building-name", "Headquarters"),
    element(NC, "room-building-address", "Main Street 3"),
    element(NC, "room-building-story", "2"),
    element(NC, "room-building-room-number", "5"),
    element(NC, "room-features", "projector, TV")
  ];
  return element(DAV, "response", [
    element(DAV, "href", patch.href || `/subfolder/remote.php/dav/principals/${collection}/one/`),
    ...(patch.propstats || [propstat(properties)]),
    ...(patch.extra || [])
  ]);
}

function multistatus(responses = []){
  return documentXml(element(DAV, "multistatus", responses));
}

function createHarness({ room = multistatus([principal()]), resource = multistatus([principal("RESOURCE")]), status = 207,
  responseLength, onFetch, responseFactory } = {}){
  const storage = { ...ACCOUNT };
  const harness = createCoreHarness({ localStorage: storage, fetchImpl: async ({ url, options, insideTimeout }) => {
    check(insideTimeout(), "Response and body reads have a bounded request lifetime");
    onFetch?.(url, options);
    if (responseFactory) return responseFactory(url, options);
    const response = new Response(url.includes("calendar-rooms") ? room : resource, {
      status,
      headers: { "Content-Type": "application/xml", ...(responseLength ? { "Content-Length": String(responseLength) } : {}) }
    });
    return response;
  } });
  harness.context.TextDecoder = TextDecoder;
  harness.context.setTimeout = (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return timer;
  };
  harness.context.DOMParser = FixtureDOMParser;
  harness.context.browser.messengerUtilities = {
    parseMailboxString: async (value) => [{ name: "", email: value }]
  };
  harness.context.browser.permissions = { contains: async () => true };
  harness.core.getRequiredCapabilities = async () => ({ versionMajor: 32 });
  loadScript("modules/calendarResourceDirectory.js", harness.context);
  return { ...harness, storage, directory: harness.context.NCCalendarResourceDirectory };
}

async function checkDiscovery(){
  const harness = createHarness();
  const resources = await harness.directory.list(ACCOUNT);
  check(resources.length === 2, "Rooms and resources are both discovered");
  const room = resources[0];
  check(room.displayName === "Elefantenraum" && room.email === "room@resources.invalid" && room.kind === "ROOM", "Room identity is preserved");
  check(room.roomType === "meeting-room" && room.resourceType === "projector" && room.capacity === 18, "Room classification and capacity are preserved");
  check(room.buildingName === "Headquarters" && room.buildingAddress === "Main Street 3"
    && room.floor === "2" && room.roomNumber === "5" && room.features === "projector, TV", "Room metadata is preserved");
  check(room.location === "5, 2, Main Street 3", "Location matches Nextcloud without a duplicate building name");
  check(resources[1].kind === "RESOURCE", "Equipment remains a resource");
  check(harness.requests.length === 2, "Each discovery uses exactly two fresh REPORTs");
  for (const request of harness.requests){
    const options = request.options;
    check(options.method === "REPORT" && options.headers.Depth === "0", "Discovery uses permission-filtered depth-zero REPORT");
    check(options.body.includes("<s:email-address/>") && options.body.includes("<d:match>@</d:match>"), "Email property search activates server group filtering");
    check(options.credentials === "omit" && options.redirect === "error" && options.cache === "no-store", "Requests isolate credentials and reject redirects and stale cache");
    check(request.url.startsWith(ACCOUNT.baseUrl + "/remote.php/dav/principals/"), "Subfolder base URL is retained");
    check(options.signal && options.headers.Authorization, "Shared auth and deadline are passed to fetch");
  }
  await harness.directory.list(ACCOUNT);
  check(harness.requests.length === 4, "Reopening never returns a cached directory");
  check(!JSON.stringify(resources).includes(ACCOUNT.appPass), "DTO carries no credentials");
}

async function checkInvalidResponses(){
  const failures = [
    ["malformed XML", "<broken>"],
    ["DTD", '<!DOCTYPE x [<!ENTITY x "expanded">]><d:multistatus/>'],
    ["non-DAV root", documentXml(element("wrong", "multistatus"))],
    ["unexpected multistatus child", multistatus([element(DAV, "collection")])],
    ["foreign principal", multistatus([principal("ROOM", { href: "https://other.example.test/subfolder/remote.php/dav/principals/calendar-rooms/one/" })])],
    ["escaped collection", multistatus([principal("ROOM", { href: "/remote.php/dav/principals/calendar-rooms/one/" })])],
    ["nested principal", multistatus([principal("ROOM", { href: "/subfolder/remote.php/dav/principals/calendar-rooms/one/two/" })])],
    ["encoded separator", multistatus([principal("ROOM", { href: "/subfolder/remote.php/dav/principals/calendar-rooms/one%2Ftwo/" })])],
    ["encoded traversal", multistatus([principal("ROOM", { href: "/subfolder/remote.php/dav/principals/calendar-rooms/%252e%252e/" })])],
    ["duplicate principal", multistatus([principal(), principal()])],
    ["duplicate href", multistatus([principal("ROOM", { extra: [element(DAV, "href", "/other")] })])],
    ["wrong principal kind", multistatus([principal("RESOURCE", { href: "/subfolder/remote.php/dav/principals/calendar-rooms/one/" })])],
    ["duplicate property", multistatus([principal("ROOM", { properties: [element(CALDAV, "calendar-user-type", "ROOM"), element(CALDAV, "calendar-user-type", "ROOM")] })])],
    ["rejected properties", multistatus([principal("ROOM", { propstats: [propstat([], "HTTP/1.1 403 Forbidden")] })])],
    ["missing successful properties", multistatus([principal("ROOM", { propstats: [propstat([], "HTTP/1.1 404 Not Found")] })])],
    ["mailbox injection", multistatus([principal("ROOM", { email: "room@example.test,person@example.test", properties: [element(CALDAV, "calendar-user-type", "ROOM"), element(SABRE, "email-address", "room@example.test,person@example.test")] })])]
  ];
  for (const [label, room] of failures){
    const harness = createHarness({ room });
    const error = await expectRejected(() => harness.directory.list(ACCOUNT), label);
    check(error.ncResourceCode === "resource_load_failed", `${label} fails without returning a partial directory`);
    check(harness.requests.length === 1, `${label} does not query further collections`);
    const logs = collectLogText(harness.logs);
    check(!logs.includes(ACCOUNT.appPass) && !logs.includes("<d:"), "Errors do not log credentials or XML bodies");
  }
  const duplicate = createHarness({ resource: multistatus([principal("RESOURCE", { email: "ROOM@resources.invalid" })]) });
  await expectRejected(() => duplicate.directory.list(ACCOUNT), "Duplicate email across rooms and resources");
  assertions++;
}

async function checkOptionalMetadata(){
  const properties = [element(CALDAV, "calendar-user-type", "ROOM"), element(SABRE, "email-address", "ROOM@resources.invalid")];
  const harness = createHarness({ room: multistatus([principal("ROOM", { propstats: [propstat(properties), propstat([element(NC, "room-features")], "HTTP/1.1 404 Not Found")] })]), resource: multistatus() });
  const resources = await harness.directory.list(ACCOUNT);
  check(resources.length === 1 && resources[0].email === "room@resources.invalid", "Sabre email fallback is normalized");
  check(resources[0].capacity === null && resources[0].location === "" && resources[0].features === "", "Absent optional fields are not fabricated");
  const empty = createHarness({ room: multistatus(), resource: multistatus() });
  check((await empty.directory.list(ACCOUNT)).length === 0, "Permission-filtered empty collections are a valid result");
}

async function checkNetworkGuards(){
  for (const status of [404, 403, 500, 200, 302, 401, 429]){
    const harness = createHarness({ status });
    const error = await expectRejected(() => harness.directory.list(ACCOUNT), `HTTP ${status}`);
    check(error.status === status || status === 401 && error.ncAuthenticationPaused || status === 429 && error.ncRateLimited, `HTTP ${status} retains its failure category`);
    check(harness.requests.length === 1, `HTTP ${status} never becomes an empty successful directory`);
    if (status === 401 || status === 429){
      await expectRejected(() => harness.directory.list(ACCOUNT), "Persistent auth/rate pause");
      check(harness.requests.length === 1, "Shared pause blocks the next request before network access");
    }
  }
  const headerLarge = createHarness({ responseLength: 4 * 1024 * 1024 + 1 });
  await expectRejected(() => headerLarge.directory.list(ACCOUNT), "Oversized Content-Length");
  assertions++;
  const bodyLarge = createHarness({ room: "x".repeat(4 * 1024 * 1024 + 1) });
  await expectRejected(() => bodyLarge.directory.list(ACCOUNT), "Oversized streamed body");
  assertions++;
  const changed = createHarness({ onFetch: (url) => { if (url.includes("calendar-resources")) changed.storage.appPass = "replacement"; } });
  await expectRejected(() => changed.directory.list(ACCOUNT), "Account changed during request");
  assertions++;
  const permission = createHarness();
  permission.context.NCHostPermissions.requireOriginPermission = async () => { throw new Error("denied"); };
  await expectRejected(() => permission.directory.list(ACCOUNT), "Host permission absent");
  check(permission.requests.length === 0, "Host permission checked before directory access");
  const stale = createHarness();
  await expectRejected(() => stale.directory.list({ ...ACCOUNT, appPass: "old" }), "Stale credential snapshot");
  check(stale.requests.length === 0, "Shared authentication guard refuses stale credentials");
}

(async () => {
  await checkDiscovery();
  await checkInvalidResponses();
  await checkOptionalMetadata();
  await checkNetworkGuards();
  console.log(`Calendar resource directory: ${assertions} assertions passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
