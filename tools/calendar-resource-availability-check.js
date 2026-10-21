'use strict';

const { webcrypto } = require("node:crypto");
const { assert, loadScript } = require("./review-check-utils");
const { createCoreHarness, collectLogText, expectRejected } = require("./network-security-test-utils");
const ICAL = require("../vendor/ical.js");

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const ACCOUNT = { baseUrl: "https://cloud.example.test/subfolder", user: "login-alias", appPass: "availability-secret" };
const ROOT = `${ACCOUNT.baseUrl}/remote.php/dav/`;
const PRINCIPAL = `${ROOT}principals/users/canonical-uid/`;
const OUTBOX = `${ROOT}calendars/canonical-uid/outbox/`;
const START = Date.UTC(2026, 9, 17, 5);
const END = START + 3600000;
const ROOM = { email: "room@resources.invalid", kind: "ROOM" };
const DOCUMENTS = new Map();
let nextDocument = 0;
let assertions = 0;

function check(value, message){
  assert(value, message);
  assertions++;
}

function element(namespaceURI, localName, content = []){
  const childNodes = Array.isArray(content) ? content : [];
  return { nodeType: 1, namespaceURI, localName, childNodes,
    get textContent(){ return Array.isArray(content) ? childNodes.map((node) => node.textContent).join("") : content; } };
}

function documentXml(root, { parserError = false, doctype = null } = {}){
  const xml = `<?xml version="1.0"?><fixture id="${++nextDocument}"/>`;
  DOCUMENTS.set(xml, { documentElement: root, doctype,
    getElementsByTagNameNS: (_namespace, name) => name === "parsererror" && parserError ? [root] : [] });
  return xml;
}

class FixtureDOMParser {
  parseFromString(xml, type){
    check(type === "application/xml", "DAV XML is parsed with native XML mode");
    return DOCUMENTS.get(xml) || { documentElement: element("parsererror", "parsererror"), getElementsByTagNameNS: () => [{}] };
  }
}

function properties(url, values, status = "HTTP/1.1 200 OK"){
  return documentXml(element(DAV, "multistatus", [element(DAV, "response", [
    element(DAV, "href", url), element(DAV, "propstat", [element(DAV, "status", status), element(DAV, "prop", values)])
  ])]));
}

function utc(value){
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function calendar(email, { start = START, end = END, lines = [], transform = (value) => value } = {}){
  return transform([
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Freebusy//EN", "METHOD:REPLY", "BEGIN:VFREEBUSY",
    "UID:free-busy-id", `DTSTAMP:${utc(START)}`, `DTSTART:${utc(start)}`, `DTEND:${utc(end)}`,
    `ATTENDEE:mailto:${email}`, ...lines, "END:VFREEBUSY", "END:VCALENDAR", ""
  ].join("\r\n"));
}

function recipient(email, payload, status = "2.0;Success"){
  return element(CALDAV, "response", [element(CALDAV, "recipient", [element(DAV, "href", `mailto:${email}`)]),
    element(CALDAV, "request-status", status), element(CALDAV, "calendar-data", payload)]);
}

function schedule(responses){
  return documentXml(element(CALDAV, "schedule-response", responses));
}

function response(xml, status = 200, headers = {}){
  return new Response(xml, { status, headers: { "Content-Type": "application/xml", ...headers } });
}

function createHarness(options = {}){
  const storage = { ...ACCOUNT };
  const posts = [];
  const harness = createCoreHarness({ localStorage: storage, fetchImpl: async ({ url, options: request }) => {
    check(request.credentials === "omit" && request.redirect === "error" && request.cache === "no-store", "No ambient auth, redirects or HTTP cache");
    check(request.headers.Authorization === `Basic ${Buffer.from(`${ACCOUNT.user}:${ACCOUNT.appPass}`).toString("base64")}`, "Explicit current-account authentication");
    check(request.headers.Depth === "0" && request.signal instanceof AbortSignal, "Bounded DAV request with cancellation");
    if (options.fetch) return options.fetch(url, request);
    if (request.method === "PROPFIND"){
      if (url === ROOT) return response(properties(options.responseHref || ROOT,
        [element(DAV, "current-user-principal", [element(DAV, "href", options.principal || PRINCIPAL)])], options.propStatus), options.discoveryStatus || 207);
      check(url === PRINCIPAL, "Principal is discovered, not guessed from login alias");
      return response(properties(PRINCIPAL, [
        element(CALDAV, "calendar-user-address-set", [element(DAV, "href", options.originator || "mailto:alice@example.test")]),
        element(CALDAV, "schedule-outbox-URL", [element(DAV, "href", options.outbox || OUTBOX)])
      ]), 207);
    }
    check(request.method === "POST" && url === OUTBOX, "Free/busy POST uses discovered scheduling outbox only");
    const root = new ICAL.Component(ICAL.parse(request.body));
    const busy = root.getFirstSubcomponent("vfreebusy");
    check(root.getFirstPropertyValue("method") === "REQUEST" && root.getAllSubcomponents().length === 1, "Request is only VFREEBUSY, not a booking or invitation");
    check(busy.getFirstPropertyValue("organizer") === "mailto:alice@example.test", "Organizer comes from principal address set");
    const emails = busy.getAllProperties("attendee").map((prop) => prop.getFirstValue().slice(7));
    const start = busy.getFirstPropertyValue("dtstart").toUnixTime() * 1000;
    const end = busy.getFirstPropertyValue("dtend").toUnixTime() * 1000;
    check(emails.length <= 50, "Requests batch at most 50 recipients");
    check(request.headers.Recipient === emails.map((email) => `mailto:${email}`).join(", "), "Recipient header matches body");
    const post = { url, request, emails, start, end };
    posts.push(post);
    if (options.post) return options.post(post, posts.length);
    return response(schedule(emails.map((email) => recipient(email, calendar(email, { start, end })))));
  } });
  harness.context.crypto = webcrypto;
  harness.context.TextDecoder = TextDecoder;
  harness.context.DOMParser = FixtureDOMParser;
  harness.context.browser.messengerUtilities = { parseMailboxString: async (email) => [{ email, name: "" }] };
  harness.context.setTimeout = (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; };
  loadScript("vendor/ical.js", harness.context);
  loadScript("modules/icalContract.js", harness.context);
  loadScript("modules/ocs.js", harness.context);
  loadScript("modules/calendarResourceDirectory.js", harness.context);
  loadScript("modules/calendarResourceAvailability.js", harness.context);
  const session = harness.context.NCCalendarResourceAvailability.createSession(ACCOUNT);
  return { ...harness, storage, posts, session };
}

async function testTransportAndCache(){
  const harness = createHarness();
  const dayStart = Date.UTC(2026, 9, 17);
  const dayEnd = dayStart + 86400000;
  let values = await harness.session.query([ROOM], dayStart, dayEnd);
  check(values.length === 1 && values[0].state === "free", "Complete successful empty free/busy is free");
  check(harness.requests.length === 3 && harness.posts.length === 1, "Two discovery reads then one batched scheduling request");
  values[0].periods.push({ start: START, end: END });
  values = await harness.session.query([ROOM, { ...ROOM, email: ROOM.email.toUpperCase() }], START, END);
  check(values.length === 1 && values[0].state === "free" && values[0].periods.length === 0, "Duplicate addresses collapse and returned data cannot mutate cache");
  check(harness.requests.length === 3, "A fresh complete day result covers an appointment without another request");
  await harness.session.query([ROOM], dayEnd, dayEnd + 3600000);
  check(harness.posts.length === 2 && harness.requests.length === 4, "Different interval reuses identity, not stale availability");
  let clockOffset = 0;
  harness.context.Date = class extends Date { static now(){ return Date.now() + clockOffset; } };
  clockOffset = 121000;
  await harness.session.query([ROOM], dayEnd, dayEnd + 3600000);
  check(harness.posts.length === 3, "Successful cache entries expire after two minutes");
  const other = harness.context.NCCalendarResourceAvailability.createSession(ACCOUNT);
  await other.query([ROOM], START, END);
  check(harness.requests.length === 8, "Picker sessions do not share data or scheduling identity");
  other.dispose();
  harness.session.dispose();
  const failure = await expectRejected(() => harness.session.query([ROOM], START, END), "Closed session must reject");
  check(failure.name === "AbortError", "Disposed picker is an explicit cancellation");
  check(!collectLogText(harness.logs).includes(ACCOUNT.appPass) && !collectLogText(harness.logs).includes(ROOM.email), "Logs contain neither secrets nor resource identifiers");
  const automatic = createHarness();
  const generated = await automatic.session.query([{ email: "mini@roomvox.local", selectable: true, kind: "ROOM" }], START, END);
  check(generated.length === 1 && generated[0].email === "mini@roomvox.local" && generated[0].state === "free",
    "RoomVox's generated local-domain address is scheduled without requiring a manually configured email");
  automatic.session.dispose();
}

async function testPeriods(){
  const harness = createHarness({ post: ({ emails, start, end }) => response(schedule(emails.map((email) => recipient(email, calendar(email, {
    start, end, lines: [
      `FREEBUSY:${utc(START - 3600000)}/${utc(START + 600000)},${utc(START + 300000)}/PT15M`,
      `FREEBUSY;FBTYPE=BUSY-TENTATIVE:${utc(START + 1200000)}/${utc(START + 1800000)}`,
      `FREEBUSY;FBTYPE=BUSY-UNAVAILABLE:${utc(START + 2700000)}/PT15M`,
      `FREEBUSY;FBTYPE=X-UNRECOGNIZED:${utc(END)}/PT1H`,
      `FREEBUSY;FBTYPE=FREE:${utc(START + 1800000)}/PT15M`,
      "COMMENT:Private material must not escape parser"
    ]
  }))))) });
  const [value] = await harness.session.query([ROOM], START, END);
  check(value.state === "busy" && value.periods.length === 2, "Busy types merge overlaps and adjacent ranges, FREE is ignored");
  check(value.periods[0].start === START && value.periods[0].end === START + 1800000, "Busy periods clip at query boundary");
  check(value.periods[1].start === START + 2700000 && value.periods[1].end === END, "Duration periods are interpreted in UTC");
  check(Object.keys(value).sort().join(",") === "email,end,periods,start,state", "Only anonymous periods and resource identity leave parser");
  const [free] = await harness.session.query([ROOM], START + 1800000, START + 2700000);
  check(free.state === "free", "Cached busy day can contain a free half-open subinterval");
  harness.session.dispose();

  const rounded = createHarness({ post: ({ emails, start, end }) => response(schedule(emails.map((email) => recipient(email, calendar(email, {
    start, end, lines: [`FREEBUSY:${utc(START)}/${utc(START + 1000)}`]
  }))))) });
  const [millisecond] = await rounded.session.query([ROOM], START + 400, END - 400);
  check(rounded.posts[0].start === START && rounded.posts[0].end === END, "Wire interval rounds outward to complete UTC seconds");
  check(millisecond.start === START + 400 && millisecond.end === END - 400 && millisecond.periods[0].start === START + 400, "Results return the exact original interval");
  rounded.session.dispose();
}

async function testRejectedData(){
  const transforms = [
    (value) => value.replace(`DTSTART:${utc(START)}`, `DTSTART:${utc(START + 1000)}`),
    (value) => value.replace(`DTEND:${utc(END)}`, `DTEND:${utc(END - 1000)}`),
    (value) => value.replace("VERSION:2.0", "VERSION:1.0"),
    (value) => value.replace("UID:free-busy-id\r\n", ""),
    (value) => value.replace("UID:free-busy-id", "UID:one\r\nUID:two"),
    (value) => value.replace(`DTSTAMP:${utc(START)}\r\n`, ""),
    (value) => value.replace(`DTSTART:${utc(START)}`, "DTSTART:20261317T050000Z"),
    (value) => value.replace(`DTSTART:${utc(START)}`, "DTSTART:20260231T050000Z"),
    (value) => value.replace(`DTSTART:${utc(START)}`, "DTSTART;VALUE=DATE:20261017"),
    (value) => value.replace(`DTSTART:${utc(START)}`, "DTSTART:20261017T050000"),
    (value) => value.replace(`DTSTART:${utc(START)}`, "DTSTART;TZID=Europe/Berlin:20261017T050000Z"),
    (value) => value.replace(`ATTENDEE:mailto:${ROOM.email}`, "ATTENDEE:mailto:other@resources.invalid"),
    (value) => value.replace(`ATTENDEE:mailto:${ROOM.email}`, `ATTENDEE:mailto:${ROOM.email}\r\nATTENDEE:mailto:${ROOM.email}`),
    (value) => value.replace("END:VFREEBUSY", "END:VEVENT"),
    (value) => value + "END:VCALENDAR\r\n",
    (value) => value.replace("END:VFREEBUSY", "BEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VFREEBUSY"),
    (value) => value.replace("END:VFREEBUSY", "RRULE:FREQ=DAILY\r\nEND:VFREEBUSY"),
    (value) => value.replace("END:VFREEBUSY", "FREEBUSY:20261017T050000Z/PT0S\r\nEND:VFREEBUSY"),
    (value) => value.replace("END:VFREEBUSY", "FREEBUSY:20261017T050000Z/-PT1H\r\nEND:VFREEBUSY"),
    (value) => value.replace("END:VFREEBUSY", "FREEBUSY:20261017T050000Z/P1DT\r\nEND:VFREEBUSY"),
    (value) => value.replace("END:VFREEBUSY", "FREEBUSY:20261017T060000Z/20261017T050000Z\r\nEND:VFREEBUSY"),
    (value) => value.replace("END:VFREEBUSY", "FREEBUSY:20261017T050000/20261017T060000\r\nEND:VFREEBUSY"),
    (value) => value.replace("END:VFREEBUSY", "FREEBUSY:20261317T050000Z/PT1H\r\nEND:VFREEBUSY"),
    (value) => value.replace("END:VFREEBUSY", "FREEBUSY;FBTYPE=BUSY;FBTYPE=FREE:20261017T050000Z/PT1H\r\nEND:VFREEBUSY"),
    (value) => value.replace("END:VFREEBUSY", "FREEBUSY;FBTYPE=FREE:invalid\r\nEND:VFREEBUSY"),
    (value) => value.replace("BEGIN:VFREEBUSY", "FREEBUSY:20261017T050000Z/PT1H\r\nBEGIN:VFREEBUSY")
  ];
  for (const [index, transform] of transforms.entries()){
    const harness = createHarness({ post: () => response(schedule([recipient(ROOM.email, calendar(ROOM.email, { transform }))])) });
    const [value] = await harness.session.query([ROOM], START, END);
    check(value.state === "unknown" && value.periods.length === 0, `Malformed/incomplete calendar ${index} is never free`);
    await harness.session.query([ROOM], START, END);
    check(harness.posts.length === 2, `Rejected calendar ${index} is not a successful cache entry`);
    harness.session.dispose();
  }
  for (const body of [schedule([]), schedule([recipient(ROOM.email, "", "3.7;No authority")]),
    schedule([recipient(ROOM.email, calendar(ROOM.email)), recipient(ROOM.email, calendar(ROOM.email))]),
    schedule([recipient("foreign@resources.invalid", calendar(ROOM.email))]),
    "<!DOCTYPE x><x/>", "invalid XML"]){
    const harness = createHarness({ post: () => response(body) });
    check((await harness.session.query([ROOM], START, END))[0].state === "unknown", "Missing, denied, duplicate or malformed schedule is unknown");
    harness.session.dispose();
  }
  const partial = createHarness({ post: () => response(schedule([recipient(ROOM.email, calendar(ROOM.email))])) });
  const mixed = await partial.session.query([ROOM, { email: "missing@resources.invalid" }], START, END);
  check(mixed[0].state === "free" && mixed[1].state === "unknown", "Missing recipient does not invalidate a separate complete response");
  partial.session.dispose();
}

async function testIsolatedRecipients(){
  const middle = "middle@resources.invalid";
  const last = "last@resources.invalid";
  const href = (email) => element(DAV, "href", `mailto:${email}`);
  const middleRecipient = () => element(CALDAV, "recipient", [href(middle)]);
  for (const malformed of [
    element(CALDAV, "response", [element(CALDAV, "recipient", [href(middle), href(middle)])]),
    element(CALDAV, "response", [middleRecipient(), middleRecipient()]),
    element("wrong", "response", [middleRecipient()]),
    recipient(middle, calendar(middle)),
    element(CALDAV, "response", [middleRecipient(), element(CALDAV, "request-status", "2.0;Success"),
      element(CALDAV, "request-status", "2.0;Success"), element(CALDAV, "calendar-data", calendar(middle))])
  ]){
    const test = createHarness({ post: () => response(schedule([
      recipient(ROOM.email, calendar(ROOM.email)), recipient(middle, calendar(middle)), malformed, recipient(last, calendar(last))
    ])) });
    const values = await test.session.query([ROOM, { email: middle }, { email: last }], START, END);
    check(values[0].state === "free" && values[1].state === "unknown" && values[2].state === "free",
      "Malformed or ambiguous recipient envelopes invalidate only their affected room, preserving healthy batch responses");
    test.session.dispose();
  }
  for (const malformed of [
    element(CALDAV, "response", [element(CALDAV, "request-status", "2.0;Success")]),
    recipient("foreign@resources.invalid", calendar(middle)),
    element(CALDAV, "response", [element(CALDAV, "recipient", [element(DAV, "href", "mailto:bad,address@example.test")])])
  ]){
    const test = createHarness({ post: () => response(schedule([
      recipient(ROOM.email, calendar(ROOM.email)), malformed, recipient(last, calendar(last))
    ])) });
    const values = await test.session.query([ROOM, { email: middle }, { email: last }], START, END);
    check(values[0].state === "free" && values[1].state === "unknown" && values[2].state === "free",
      "Unidentified or foreign envelopes do not suppress unrelated requested recipients");
    test.session.dispose();
  }
  const ambiguous = createHarness({ post: () => response(schedule([
    recipient(ROOM.email, calendar(ROOM.email)),
    element(CALDAV, "response", [element(CALDAV, "recipient", [href(ROOM.email), href(middle)])]),
    recipient(last, calendar(last))
  ])) });
  const affected = await ambiguous.session.query([ROOM, { email: middle }, { email: last }], START, END);
  check(affected[0].state === "unknown" && affected[1].state === "unknown" && affected[2].state === "free",
    "A recipient envelope naming multiple requested addresses invalidates all its candidates but not unrelated results");
  ambiguous.session.dispose();
  const inputs = createHarness();
  const values = await inputs.session.query([ROOM, { email: "" }, { email: "bad,address@example.test" },
    { email: "alias@resources.invalid", selectable: false }, null], START, END);
  check(values.length === 1 && values[0].state === "free" && inputs.posts[0].emails.join() === ROOM.email,
    "Malformed and explicitly disabled addresses never enter the scheduling batch or suppress a healthy query");
  inputs.session.dispose();
  const empty = createHarness();
  check((await empty.session.query([{ email: "" }, { email: "alias@resources.invalid", selectable: false }], START, END)).length === 0
    && empty.requests.length === 0, "An all-unbookable query needs no scheduling discovery or POST");
  empty.session.dispose();
}

async function testDiscoverySafety(){
  for (const patch of [
    { principal: "https://evil.example.test/subfolder/remote.php/dav/principals/users/one/" },
    { principal: "/remote.php/dav/principals/users/one/" },
    { principal: `${ROOT}principals/users/a%2fb/` },
    { principal: `${ROOT}principals/users/a%252fb/` },
    { principal: `${ROOT}principals/users/a/?query=1` },
    { principal: `${ROOT}principals/calendar-rooms/one/` },
    { responseHref: `${ROOT}other/` },
    { outbox: "https://evil.example.test/outbox/" },
    { outbox: `${ROOT}calendars/one/calendar/` },
    { outbox: `${ROOT}calendars/one/nested/outbox/` },
    { originator: "mailto:bad\r\nInjected:value@example.test" },
    { discoveryStatus: 403 },
    { propStatus: "HTTP/1.1 403 Forbidden" }
  ]){
    const harness = createHarness(patch);
    const error = await expectRejected(() => harness.session.query([ROOM], START, END), "Unsafe discovery must reject");
    check(error.ncResourceCode === "resource_availability_failed", "Discovery errors map to availability error, not directory error");
    check(harness.posts.length === 0, "Invalid identity/URL prevents scheduling POST");
    harness.session.dispose();
  }
  const forbidden = createHarness();
  forbidden.context.NCHostPermissions.requireOriginPermission = async (_baseUrl, options) => { throw options.errorFactory(); };
  const permissionError = await expectRejected(() => forbidden.session.query([ROOM], START, END), "Host permission must be respected");
  check(permissionError.code === "host_permission_missing" && permissionError.ncUserMessage === "error_host_permission_missing", "Host permission failure preserves shared explanation");
  check(forbidden.requests.length === 0, "No request without host permission");
  forbidden.session.dispose();
  const account = createHarness();
  await account.session.query([ROOM], START, END);
  account.storage.appPass = "replacement-secret";
  await expectRejected(() => account.session.query([ROOM], START, END), "Cached data cannot cross account revision");
  check(account.requests.length === 3, "Changed credentials stop even cache reads before networking");
  account.session.dispose();
  for (const status of [401, 429]){
    const harness = createHarness({ post: () => response("Rejected", status) });
    const error = await expectRejected(() => harness.session.query([ROOM], START, END), "Authentication/cooldown is not a successful availability response");
    check(error.code === (status === 401 ? "auth_required" : "rate_limited") && error.ncUserMessage,
      "Authentication/cooldown retains shared status code and explanation");
    const count = harness.requests.length;
    await expectRejected(() => harness.session.query([ROOM], START, END), "Paused account rejects later queries");
    check(harness.requests.length === count, "Authentication rejection/cooldown blocks later network requests");
    harness.session.dispose();
  }
  const large = createHarness({ post: () => response("small body", 200, { "Content-Length": "5000000" }) });
  check((await large.session.query([ROOM], START, END))[0].state === "unknown", "Oversized response cannot report availability");
  large.session.dispose();
}

function deferred(){
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(checkState){
  for (let attempt = 0; attempt < 200; attempt++){
    if (checkState()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for test request");
}

async function testConcurrencyAndCancellation(){
  const gate = deferred();
  let active = 0;
  let maximum = 0;
  const harness = createHarness({ post: async ({ emails, start, end }) => {
    active++;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active--;
    return response(schedule(emails.map((email) => recipient(email, calendar(email, { start, end })))));
  } });
  const resources = Array.from({ length: 121 }, (_, index) => ({ email: `room-${index}@resources.invalid` }));
  const pending = harness.session.query(resources, START, END);
  await waitFor(() => harness.posts.length === 2);
  check(active === 2, "Two batches can run concurrently");
  gate.resolve();
  const values = await pending;
  check(maximum === 2 && harness.posts.length === 3 && values.length === 121, "Three bounded batches return every visible resource");
  harness.session.dispose();

  for (const close of [false, true]){
    let canceled = 0;
    const canceledHarness = createHarness({ post: ({ request }) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => { canceled++; reject(new DOMException("Canceled", "AbortError")); }, { once: true });
    }) });
    const controller = new AbortController();
    const work = canceledHarness.session.query(resources, START, END, controller.signal);
    const failed = expectRejected(() => work, "Canceled request must reject");
    await waitFor(() => canceledHarness.posts.length === 2);
    if (close) canceledHarness.session.dispose();
    else controller.abort();
    const error = await failed;
    check(error.name === "AbortError" && canceled === 2, "Window close or query cancellation aborts both active requests");
    await new Promise((resolve) => setTimeout(resolve, 5));
    check(canceledHarness.posts.length === 2, "Queued third request never starts after cancellation");
    canceledHarness.session.dispose();
  }

  const oldResponse = deferred();
  const race = createHarness({ post: async ({ emails, start, end }, number) => {
    if (number === 1) await oldResponse.promise;
    if (number === 2) return response(schedule([]));
    return response(schedule(emails.map((email) => recipient(email, calendar(email, { start, end })))));
  } });
  const old = race.session.query([ROOM], START, END);
  await waitFor(() => race.posts.length === 1);
  const fresh = await race.session.query([ROOM], START, END);
  check(fresh[0].state === "unknown", "Newer failed response is unknown");
  oldResponse.resolve();
  await old;
  await race.session.query([ROOM], START, END);
  check(race.posts.length === 3, "Older successful response cannot revive a newer failed cache entry");
  race.session.dispose();
}

(async () => {
  await testTransportAndCache();
  await testPeriods();
  await testRejectedData();
  await testIsolatedRecipients();
  await testDiscoverySafety();
  await testConcurrencyAndCancellation();
  console.log(`Calendar resource availability: ${assertions} assertions passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
