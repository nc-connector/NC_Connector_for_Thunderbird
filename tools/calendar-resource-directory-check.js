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
    element(SABRE, "email-address", email),
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
  harness.context.L = (...args) => harness.logs.push(args);
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
  const roomsRoot = "/subfolder/remote.php/dav/principals/calendar-rooms/";
  const resourcesRoot = "/subfolder/remote.php/dav/principals/calendar-resources/";
  const harness = createHarness({
    room: multistatus([
      principal("ROOM", { href: roomsRoot, properties: [] }),
      principal("ROOM", { href: roomsRoot + "mini/", email: "mini@resources.invalid" }),
      principal("ROOM", { href: roomsRoot + "mini-copy/", email: "mini-copy@resources.invalid" }),
      principal("ROOM", { href: roomsRoot + "vehicle/", email: "car@resources.invalid", properties: [
        element(DAV, "displayname", "Mini vehicle"), element(CALDAV, "calendar-user-type", "ROOM"),
        element(SABRE, "email-address", "car@resources.invalid"), element(NC, "resource-type", "car")
      ] })
    ]),
    resource: multistatus([
      principal("RESOURCE", { href: ACCOUNT.baseUrl + "/remote.php/dav/principals/calendar-resources", properties: [] }),
      principal("RESOURCE"),
      principal("RESOURCE", { href: resourcesRoot + "native-vehicle/", properties: [
        element(DAV, "displayname", "Native vehicle"), element(CALDAV, "calendar-user-type", "RESOURCE"),
        element(SABRE, "email-address", "native-car@resources.invalid"), element(NC, "resource-type", "vehicle")
      ] })
    ])
  });
  const resources = await harness.directory.list(ACCOUNT);
  check(resources.length === 5, "Collection roots are excluded while both Mini rooms, equipment, and vehicles are discovered");
  const room = resources[0];
  check(room.displayName === "Elefantenraum" && room.email === "mini@resources.invalid" && room.kind === "ROOM", "Room identity is preserved");
  check(room.roomType === "meeting-room" && room.resourceType === "projector" && room.capacity === 18, "Room classification and capacity are preserved");
  check(room.buildingName === "Headquarters" && room.buildingAddress === "Main Street 3"
    && room.floor === "2" && room.roomNumber === "5" && room.features === "projector, TV", "Room metadata is preserved");
  check(room.location === "5, 2, Main Street 3", "Location matches Nextcloud without a duplicate building name");
  check(resources[1].email === "mini-copy@resources.invalid", "Both Mini principals are listed without an email search predicate");
  check(resources[2].kind === "ROOM" && resources[2].resourceType === "car", "RoomVox vehicles retain the server ROOM classification");
  check(resources[3].kind === "RESOURCE", "Equipment remains a resource");
  check(resources[4].kind === "RESOURCE" && resources[4].resourceType === "vehicle", "Native vehicles retain the server RESOURCE classification");
  check(harness.requests.length === 2, "Each discovery uses exactly two fresh PROPFINDs");
  const calendarProperties = [
    "d:displayname", "c:calendar-user-type", "c:calendar-user-address-set", "d:principal-URL", "d:alternate-URI-set", "s:email-address", "n:language",
    "n:resource-type", "n:resource-vehicle-type", "n:resource-vehicle-make", "n:resource-vehicle-model", "n:resource-vehicle-is-electric",
    "n:resource-vehicle-range", "n:resource-vehicle-seating-capacity", "n:resource-contact-person", "n:resource-contact-person-vcard", "n:room-type",
    "n:room-seating-capacity", "n:room-building-name", "n:room-building-address", "n:room-building-story", "n:room-building-room-number", "n:room-features"
  ];
  for (const request of harness.requests){
    const options = request.options;
    check(options.method === "PROPFIND" && options.headers.Depth === "1", "Discovery matches Calendar 6.6.2 depth-one collection enumeration");
    const properties = Array.from(options.body.matchAll(/<([a-z]:[a-zA-Z-]+)\/>/g), (match) => match[1]);
    check(properties.join("\n") === calendarProperties.join("\n"), "Requested properties exactly match cdav 2.7.0 resource-booking principal properties");
    check(options.body.startsWith('<d:propfind xmlns:d="DAV:"') && options.body.endsWith("</d:prop></d:propfind>")
      && !options.body.includes("property-search") && !options.body.includes("<d:match>"), "Collection request has no principal search filter");
    check(options.credentials === "omit" && options.redirect === "error" && options.cache === "no-store", "Requests isolate credentials and reject redirects and stale cache");
    check(request.url.startsWith(ACCOUNT.baseUrl + "/remote.php/dav/principals/"), "Subfolder base URL is retained");
    check(options.signal && options.headers.Authorization, "Shared auth and deadline are passed to fetch");
  }
  await harness.directory.list(ACCOUNT);
  check(harness.requests.length === 4, "Reopening never returns a cached directory");
  check(!JSON.stringify(resources).includes(ACCOUNT.appPass), "DTO carries no credentials");
  const restricted = createHarness({ room: multistatus([principal("ROOM", { href: roomsRoot, properties: [] })]), resource: multistatus() });
  check((await restricted.directory.list(ACCOUNT)).length === 0, "Principals omitted by the server remain absent without a second search path");
}

async function checkInvalidResponses(){
  for (const [label, room] of [
    ["malformed XML", "<broken>"],
    ["DTD", '<!DOCTYPE x [<!ENTITY x "expanded">]><d:multistatus/>'],
    ["non-DAV root", documentXml(element("wrong", "multistatus"))]
  ]){
    const harness = createHarness({ room });
    const error = await expectRejected(() => harness.directory.list(ACCOUNT), label);
    check(error.ncResourceCode === "resource_load_failed", `${label} fails without returning a partial directory`);
    check(harness.requests.length === 1, `${label} does not query further collections`);
    const logs = collectLogText(harness.logs);
    check(!logs.includes(ACCOUNT.appPass) && !logs.includes("<d:"), "Errors do not log credentials or XML bodies");
  }
  for (const [label, bad] of [
    ["unexpected multistatus child", element(DAV, "collection")],
    ...[
      ["foreign principal", "https://other.example.test/subfolder/remote.php/dav/principals/calendar-rooms/one/"],
      ["foreign collection root", "https://other.example.test/subfolder/remote.php/dav/principals/calendar-rooms/"],
      ["credential-bearing collection root", "https://intruder@cloud.example.test/subfolder/remote.php/dav/principals/calendar-rooms/"],
      ["query-bearing collection root", "/subfolder/remote.php/dav/principals/calendar-rooms/?query=1"],
      ["fragment-bearing collection root", "/subfolder/remote.php/dav/principals/calendar-rooms/#fragment"],
      ["escaped collection", "/remote.php/dav/principals/calendar-rooms/one/"],
      ["nested principal", "/subfolder/remote.php/dav/principals/calendar-rooms/one/two/"],
      ["normalized collection traversal", "/subfolder/remote.php/dav/principals/calendar-rooms/one/../"],
      ["encoded separator", "/subfolder/remote.php/dav/principals/calendar-rooms/one%2Ftwo/"],
      ["encoded traversal", "/subfolder/remote.php/dav/principals/calendar-rooms/%252e%252e/"]
    ].map(([label, href]) => [label, principal("ROOM", { href })]),
    ["duplicate href", principal("ROOM", { extra: [element(DAV, "href", "/other")] })],
    ["rejected individual response", principal("ROOM", { extra: [element(DAV, "status", "HTTP/1.1 403 Forbidden")] })],
    ["malformed successful propstat", principal("ROOM", { propstats: [element(DAV, "propstat", [element(DAV, "status", "HTTP/1.1 200 OK")])] })]
  ]){
    const good = principal("ROOM", { href: "/subfolder/remote.php/dav/principals/calendar-rooms/good/", email: "good@resources.invalid" });
    const harness = createHarness({ room: multistatus([good, bad]) });
    const resources = await harness.directory.list(ACCOUNT);
    check(resources.length === 2 && resources[0].email === "good@resources.invalid" && resources[0].selectable,
      `${label}: one bad entry cannot hide an unrelated room or the resource collection`);
    check(harness.requests.length === 2 && collectLogText(harness.logs).includes("resource directory principal skipped"),
      `${label}: rejected record is diagnosed and discovery continues`);
    check((await createHarness({ room: multistatus([bad]), resource: multistatus() }).directory.list(ACCOUNT)).length === 0,
      `${label}: an all-rejected catalog remains a usable empty list`);
  }
  const duplicate = createHarness({ resource: multistatus([principal("RESOURCE", { email: "ROOM@resources.invalid" })]) });
  const aliases = await duplicate.directory.list(ACCOUNT);
  check(aliases.length === 2 && aliases.every((entry) => !entry.selectable), "Duplicate addresses remain visible but cannot become ambiguous recipients");
  const repeated = await createHarness({ room: multistatus([principal(), principal()]), resource: multistatus() }).directory.list(ACCOUNT);
  check(repeated.length === 1 && repeated[0].selectable, "A repeated principal href is deduplicated without becoming an address alias");
  const recovered = await createHarness({ room: multistatus([principal("ROOM", { properties: [] }), principal()]),
    resource: multistatus() }).directory.list(ACCOUNT);
  check(recovered.length === 1 && recovered[0].selectable && recovered[0].email === "room@resources.invalid",
    "A valid later response replaces an incomplete response for the same principal path");
}

async function checkOptionalMetadata(){
  const automatic = await createHarness({ room: multistatus([principal("ROOM", { properties: [
    element(DAV, "displayname", "Mini automatic address"),
    element(SABRE, "email-address", "mini@roomvox.local")
  ] })]), resource: multistatus() }).directory.list(ACCOUNT);
  check(automatic.length === 1 && automatic[0].email === "mini@roomvox.local" && automatic[0].selectable,
    "A RoomVox automatically generated Sabre address remains selectable without a calendar-user-address-set property");
  const properties = [element(CALDAV, "calendar-user-type", "ROOM"), element(SABRE, "email-address", "ROOM@resources.invalid")];
  const harness = createHarness({ room: multistatus([principal("ROOM", { propstats: [propstat(properties), propstat([element(NC, "room-features")], "HTTP/1.1 404 Not Found")] })]), resource: multistatus() });
  const resources = await harness.directory.list(ACCOUNT);
  check(resources.length === 1 && resources[0].email === "room@resources.invalid" && resources[0].selectable, "Calendar's Sabre scheduling address is normalized");
  check(resources[0].capacity === null && resources[0].location === "" && resources[0].features === "", "Absent optional fields are not fabricated");
  const empty = createHarness({ room: multistatus(), resource: multistatus() });
  check((await empty.directory.list(ACCOUNT)).length === 0, "Permission-filtered empty collections are a valid result");
  const roomRoot = "/subfolder/remote.php/dav/principals/calendar-rooms/";
  const mixed = createHarness({ room: multistatus([
    principal("ROOM", { href: roomRoot + "good/", properties: [
      element(DAV, "displayname", "Healthy"), element(CALDAV, "calendar-user-type", "RESOURCE"),
      element(CALDAV, "calendar-user-address-set", [element(DAV, "href", "mailto:wrong@resources.invalid")]),
      element(SABRE, "email-address", "RIGHT@resources.invalid"), element(NC, "room-seating-capacity", "12 seats")
    ] }),
    principal("ROOM", { href: roomRoot + "missing/", properties: [element(DAV, "displayname", "Missing address")] }),
    principal("ROOM", { href: roomRoot + "injected/", properties: [element(DAV, "displayname", "Invalid address"),
      element(SABRE, "email-address", "room@example.test,person@example.test")] }),
    principal("ROOM", { href: roomRoot + "optional/", propstats: [propstat([
      element(DAV, "displayname", "Optional rejected"), element(SABRE, "email-address", "optional@resources.invalid")
    ]), propstat([element(NC, "room-features")], "HTTP/1.1 403 Forbidden")] }),
    principal("ROOM", { href: roomRoot + "all-optional-missing/", propstats: [propstat([], "HTTP/1.1 404 Not Found")] }),
    principal("ROOM", { href: roomRoot + "duplicate-property/", properties: [
      element(SABRE, "email-address", "old@resources.invalid"), element(SABRE, "email-address", "last@resources.invalid")
    ] })
  ]), resource: multistatus() });
  const entries = await mixed.directory.list(ACCOUNT);
  check(entries.length === 6 && entries[0].email === "right@resources.invalid" && entries[0].kind === "ROOM" && entries[0].capacity === 12,
    "Calendar Sabre priority, collection classification, and capacity parsing tolerate independent optional metadata");
  check(entries[1].displayName === "Missing address" && entries[1].email === "" && !entries[1].selectable
    && entries[2].displayName === "Invalid address" && !entries[2].selectable,
  "Missing and malformed scheduling addresses retain named, unselectable rows");
  check(entries[3].selectable && entries[3].features === "" && !entries[4].selectable,
    "Rejected optional properties never suppress healthy properties or poison other rows");
  check(entries[5].email === "last@resources.invalid", "Repeated DAV properties use the final value like cdav");
  const emptyAddresses = await createHarness({ room: multistatus([
    principal("ROOM", { href: roomRoot + "empty1/", properties: [] }), principal("ROOM", { href: roomRoot + "empty2/", properties: [] })
  ]), resource: multistatus() }).directory.list(ACCOUNT);
  check(emptyAddresses.length === 2 && emptyAddresses.every((entry) => entry.email === "" && !entry.selectable),
    "Multiple addressless rooms remain distinct and do not break an all-unbookable catalog");
  const parserFailure = createHarness({ room: multistatus([principal()]), resource: multistatus() });
  parserFailure.context.browser.messengerUtilities.parseMailboxString = async () => { throw new Error("Malformed mailbox"); };
  const unreadable = await parserFailure.directory.list(ACCOUNT);
  check(unreadable.length === 1 && !unreadable[0].selectable, "An individual mailbox parser refusal keeps the room visible without a recipient");
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
