'use strict';

const vm = require("node:vm");
const ICAL = require("../vendor/ical.js");
const { assert, loadScript } = require("./review-check-utils");

let assertions = 0;
function check(value, message){ assert(value, message); assertions++; }
const PERSON = "ATTENDEE;CN=Alice;PARTSTAT=ACCEPTED;ROLE=OPT-PARTICIPANT;X-KEEP=yes:mailto:alice@example.test";
const ROOM = "ATTENDEE;CN=Original;PARTSTAT=ACCEPTED;RSVP=FALSE;CUTYPE=ROOM;ROLE=REQ-PARTICIPANT;X-KEEP=yes:mailto:room@resources.invalid";
const EQUIPMENT = "ATTENDEE;CN=Device;PARTSTAT=TENTATIVE;CUTYPE=RESOURCE;ROLE=OPT-PARTICIPANT:mailto:device@resources.invalid";
const UNKNOWN = "ATTENDEE;CN=Foreign;CUTYPE=ROOM;PARTSTAT=ACCEPTED:mailto:foreign@example.test";
const CATALOG = [
  { email: "room@resources.invalid", kind: "ROOM", displayName: 'Room, A; "quoted"\nFloor', location: "EG, Main Street 3" },
  { email: "room2@resources.invalid", kind: "ROOM", displayName: "Other room", location: "2, Other Street" },
  { email: "device@resources.invalid", kind: "RESOURCE", displayName: "Projector", location: "" },
  { email: "device2@resources.invalid", kind: "RESOURCE", displayName: "Whiteboard", location: "" }
].map((resource, index) => ({ ...resource, selectable: true, principalPath: `/principals/${resource.kind}/${index}` }));
const INTERVAL = { start: Date.parse("2026-10-17T08:00:00Z"), end: Date.parse("2026-10-17T08:30:00Z"), timeZone: "Europe/Berlin" };

function policy(mode = "community", managed = false, patch = {}){
  return {
    endpointAvailable: true, endpointChecked: true, fetchSucceeded: true, reason: "",
    managedSetup: { isEnterpriseRollout: managed },
    status: { mode, seatAssigned: true, isValid: true, seatState: "active", licenseStatus: mode === "community" ? "COMMUNITY" : "ACTIVE" },
    ...patch
  };
}

function deferred(){
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function reject(operation, code, label){
  let failure;
  try{ await operation(); }catch(error){ failure = error; }
  check(!!failure, label || `Expected ${code}`);
  if (code) check(failure.code === code || failure.message === code, `Expected ${code}, received ${failure?.code || failure?.message}`);
  return failure;
}

function harness({ mode = "community", managed = false, attendees = [PERSON], location = "Manual location", resources = CATALOG } = {}){
  const state = {
    policy: policy(mode, managed), options: { baseUrl: "https://cloud.example.test", user: "alice", appPass: "secret" },
    snapshot: { editorId: "editor-one", type: "event", canEditAttendees: true, calendarId: "calendar-one", location,
      availabilityInterval: { ...INTERVAL }, attendees: [...attendees] },
    contexts: new Map([["context-one", { editorId: "editor-one" }]]), resources,
    calls: { policy: 0, directory: 0, read: 0, update: 0, merge: 0 }, writes: [], logs: [], now: 1000,
    onPolicy: null, onDirectory: null, onRead: null, onUpdate: null, onAvailability: null,
    availabilityQueries: [], availabilitySessions: [], timers: new Map()
  };
  let storageListener;
  let router;
  let sequence = 0;
  const context = {
    URL, ICAL, Map, Set, WeakMap, Object, Array, Number, String, Promise, Intl, AbortController, DOMException,
    setTimeout: (callback) => { const id = ++sequence; state.timers.set(id, callback); return id; },
    clearTimeout: (id) => state.timers.delete(id),
    Date: class extends Date { static now(){ return state.now; } },
    crypto: { randomUUID: () => `token-${++sequence}` },
    bgI18n: (key) => `translated:${key}`,
    L: (...args) => state.logs.push(args),
    console: { error: (...args) => state.logs.push(args) },
    getCalendarWizardContext: (id) => state.contexts.get(id),
    mergeCalendarSnapshotIntoWizardContext: () => { state.calls.merge++; },
    NCCore: { getOpts: async () => ({ ...state.options }) },
    NCPolicyRuntime: { getPolicyStatus: async () => {
      state.calls.policy++;
      await state.onPolicy?.(state.calls.policy);
      return state.policy;
    } },
    NCCalendarResourceDirectory: { list: async (options) => {
      state.calls.directory++;
      check(options.baseUrl === state.options.baseUrl, "Discovery receives the checked account snapshot");
      await state.onDirectory?.(state.calls.directory);
      return state.resources;
    } },
    NCCalendarResourceAvailability: { createSession: (options) => {
      check(options.baseUrl === state.options.baseUrl, "Availability session uses the authenticated catalog account");
      const service = { disposed: false, dispose(){ service.disposed = true; },
        async query(resources, start, end, signal){
          const query = { resources, start, end, signal };
          state.availabilityQueries.push(query);
          await state.onAvailability?.(query);
          return resources.map((resource) => ({ email: resource.email, state: "free", start, end, periods: [] }));
        } };
      state.availabilitySessions.push(service);
      return service;
    } },
    browser: {
      storage: { onChanged: { addListener: (listener) => { storageListener = listener; } } },
      runtime: { id: "test-addon", getURL: (path) => `moz-extension://test-instance/${path}`,
        onMessage: { addListener: (listener) => { router = listener; } } },
      ncCalToolbar: {
        getCurrent: async () => {
          state.calls.read++;
          await state.onRead?.(state.calls.read);
          return { ...state.snapshot, attendees: [...state.snapshot.attendees] };
        },
        updateCurrent: async (update) => {
          state.calls.update++;
          await state.onUpdate?.(update);
          // The native bridge's transaction is tested separately; this boundary
          // rejects stale snapshots and records the exact production payload.
          if (JSON.stringify(update.attendees.before) !== JSON.stringify(state.snapshot.attendees)
            || update.attendees.beforeLocation !== state.snapshot.location
            || update.attendees.beforeCalendarId !== state.snapshot.calendarId){
            throw new Error("resource_selection_changed");
          }
          state.writes.push(update);
          state.snapshot = { ...state.snapshot, ...update.fields, attendees: [...update.attendees.after] };
          return { ...state.snapshot };
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/icalContract.js", context);
  loadScript("modules/policyState.js", context);
  loadScript("modules/bgCalendarResources.js", context, "\nglobalThis.resourceRuntime = NCCalendarResources;");
  loadScript("modules/bgRouter.js", context);
  return {
    state, context, api: context.resourceRuntime,
    changed: (changes = { appPass: { oldValue: "secret", newValue: "new" } }, area = "local") => storageListener(changes, area),
    route: (type, sender, extras = {}) => router({ type, contextId: "context-one", ...extras }, sender),
    sender: { id: "test-addon", url: "moz-extension://test-instance/ui/calendarResources.html?contextId=context-one" }
  };
}

async function checkAccessMatrix(){
  for (const mode of ["community", "pro"]){
    for (const managed of [false, true]){
      const base = policy(mode, managed);
      const cases = [
        ["active", {}, true, true],
        ["globally overlicensed but personally active", { status: { ...base.status, overlicensed: true } }, true, true],
        ["missing seat", { status: { ...base.status, seatAssigned: false, seatState: "none" } }, !managed, false],
        ["paused seat", { status: { ...base.status, seatState: "suspended_overlimit" } }, !managed, false],
        ["invalid access", { status: { ...base.status, isValid: false, licenseStatus: "INVALID" } }, !managed, false],
        ["grace", { status: { ...base.status, licenseStatus: "EXPIRED", accessStatus: "GRACE" } }, true, true],
        ["confirmed synchronization warning", { status: { ...base.status, licenseConnectionError: true } }, true, true],
        ["grace with paused seat", { status: { ...base.status, licenseStatus: "EXPIRED", accessStatus: "GRACE", seatState: "suspended_overlimit" } }, !managed, false],
        ["synchronization warning without seat", { status: { ...base.status, licenseConnectionError: true, seatAssigned: false, seatState: "none" } }, !managed, false],
        ["synchronization warning with invalid access", { status: { ...base.status, licenseConnectionError: true, isValid: false, accessStatus: "INVALID" } }, !managed, false],
        ["missing backend", { endpointAvailable: false, fetchSucceeded: false, reason: "endpoint_missing" }, !managed, false],
        ["unknown backend state", { endpointAvailable: false, fetchSucceeded: false, reason: "network" }, !managed, false],
        ["authentication pause", { connectionState: { reason: "auth_required" } }, false, false],
        ["rate pause", { connectionState: { reason: "rate_limited" } }, false, false]
      ];
      for (const [label, patch, talkAllowed, resourcesAllowed] of cases){
        const test = harness({ mode, managed });
        test.state.policy = { ...base, ...patch };
        const access = await test.api.actionState("context-one");
        check(access.talk.enabled === talkAllowed, `${mode}/${managed}/${label}: Talk follows shared managed access`);
        check(access.resources.enabled === resourcesAllowed, `${mode}/${managed}/${label}: resource gate uses a valid assigned seat`);
        if (!resourcesAllowed){
          check(!!access.resources.notice, "Disabled action has a shared localized explanation");
          await reject(() => test.api.list("context-one"));
          check(test.state.calls.directory === 0, "Denied access makes no resource query");
        }
      }
    }
  }
  const readonly = harness();
  readonly.state.snapshot.canEditAttendees = false;
  const access = await readonly.api.actionState("context-one");
  check(access.resources.code === "resource_readonly" && !access.resources.enabled, "Read-only editor disables only the resource action");
  check(access.talk.enabled, "Resource read-only check does not change Talk entitlement");
}

async function checkPolicyWarningSnapshot(){
  for (const mode of ["community", "pro"]){
    for (const managed of [false, true]){
      for (const warning of [
        {},
        { licenseStatus: "EXPIRED", accessStatus: "GRACE", graceUntilIso: "2026-10-28T12:00:00Z" },
        { licenseConnectionError: true, licenseLastSyncAtIso: "2026-10-14T08:00:00Z",
          licenseOfflineUntilIso: "2026-10-28T08:00:00Z", canManageLicense: true }
      ]){
        const test = harness({ mode, managed });
        Object.assign(test.state.policy.status, warning);
        test.state.policy.endpointUrl = "https://cloud.example.test/nextcloud/index.php/apps/ncc_backend_4mc/api/v1/status";
        const response = await test.route("resource:list", test.sender);
        check(response.ok && response.policyStatus === test.state.policy,
          "A successful list must carry the exact checked policy snapshot for shared warning rendering");
        check(JSON.stringify(response.policyStatus) === JSON.stringify(test.state.policy)
          && !Object.hasOwn(response, "options") && !JSON.stringify(response).includes(test.state.options.appPass),
        "Warning metadata must retain the existing status fields without exposing the authenticated options");
        check(test.state.calls.policy === 1 && test.state.calls.directory === 1 && test.state.calls.read === 2,
          "Returning the warning snapshot must not introduce another policy or directory request");
        const applied = await test.route("resource:apply", test.sender, {
          selectionToken: response.selectionToken, selectedEmails: [CATALOG[0].email]
        });
        check(applied.ok && test.state.calls.policy === 2 && test.state.calls.update === 1,
          "Active, grace, and confirmed synchronization states must remain usable through the fresh apply guard");
      }

      for (const refusal of [
        { seatAssigned: false, seatState: "none" },
        { seatState: "suspended_overlimit" },
        { isValid: false, accessStatus: "INVALID" }
      ]){
        const test = harness({ mode, managed });
        Object.assign(test.state.policy.status, {
          licenseStatus: "EXPIRED", accessStatus: "GRACE", licenseConnectionError: true
        });
        const response = await test.route("resource:list", test.sender);
        check(response.ok, "An initially confirmed active seat can load resources despite informational warnings");
        Object.assign(test.state.policy.status, refusal);
        const rejected = await test.route("resource:apply", test.sender, {
          selectionToken: response.selectionToken, selectedEmails: [CATALOG[0].email]
        });
        check(!rejected.ok && !!rejected.code && !!rejected.error && test.state.calls.update === 0,
          "A warning snapshot must never override a newly missing, paused, or invalid seat at apply");
        check(!Object.hasOwn(rejected, "policyStatus"),
          "A rejected operation must not carry stale informational warning metadata as a successful snapshot");
      }
    }
  }
}

function parsed(lines, email){
  return lines.map((line) => new ICAL.Component(ICAL.parse(`BEGIN:VEVENT\r\n${line}\r\nEND:VEVENT\r\n`)).getFirstProperty("attendee"))
    .find((property) => String(property.getFirstValue()).toLowerCase() === `mailto:${email}`);
}

async function checkSelection(){
  const test = harness({ attendees: [PERSON, ROOM, EQUIPMENT, UNKNOWN], location: CATALOG[0].location });
  const loaded = await test.api.list("context-one");
  check(loaded.selectedEmails.length === 2 && loaded.selectedEmails.includes(CATALOG[0].email), "Existing known ROOM/RESOURCE attendees are selected");
  await test.api.apply("context-one", loaded.selectionToken, [CATALOG[0].email, CATALOG[2].email, CATALOG[3].email]);
  const update = test.state.writes[0];
  check(update.attendees.after.includes(PERSON) && update.attendees.after.includes(UNKNOWN), "Ordinary participants and foreign resources remain byte-for-byte unchanged");
  const room = parsed(update.attendees.after, CATALOG[0].email);
  check(room.getParameter("partstat") === "ACCEPTED" && room.getParameter("rsvp") === "FALSE"
    && room.getParameter("x-keep") === "yes" && room.getParameter("cn") === "Original", "Retained resource parameters and response status are preserved");
  const equipment = parsed(update.attendees.after, CATALOG[2].email);
  check(equipment.getParameter("role") === "OPT-PARTICIPANT" && equipment.getParameter("partstat") === "TENTATIVE", "Retained equipment role and status remain intact");
  check(update.attendees.after.length === 5 && test.state.calls.merge === 1, "Only the one missing resource is added and the draft context is refreshed");
  check(update.returnFormat === "ical" && update.editorId === "editor-one", "Apply targets only the original unsaved editor");
  await reject(() => test.api.apply("context-one", loaded.selectionToken, []), "resource_context_expired", "Applied token cannot be replayed");

  const fresh = harness();
  const freshList = await fresh.api.list("context-one");
  await fresh.api.apply("context-one", freshList.selectionToken, [CATALOG[0].email, CATALOG[2].email, CATALOG[3].email]);
  const created = parsed(fresh.state.writes[0].attendees.after, CATALOG[0].email);
  check(created.getParameter("cn") === CATALOG[0].displayName, "Bundled iCal parser round-trips quotes, separators, and newlines in display names");
  check(created.getParameter("cutype") === "ROOM" && created.getParameter("partstat") === "NEEDS-ACTION"
    && created.getParameter("role") === "REQ-PARTICIPANT", "New room has the native resource attendee parameters");
  check(fresh.state.snapshot.location === CATALOG[0].location, "Selected room location is copied");
  check(!created.getParameter("schedule-agent"), "Picker does not change Thunderbird scheduling ownership");

  const nativePerson = PERSON + "\r\n";
  const nativeRoom = ROOM.replace("mailto:room", "mailto:ro\r\n om") + "\r\n";
  const nativeDevice = EQUIPMENT.replace(";PARTSTAT", ";\r\n PARTSTAT") + "\r\n";
  const native = harness({ attendees: [nativePerson, nativeRoom, nativeDevice] });
  const nativeList = await native.api.list("context-one");
  check(nativeList.selectedEmails.length === 2 && nativeList.selectedEmails.includes(CATALOG[0].email)
    && nativeList.selectedEmails.includes(CATALOG[2].email), "Native folded properties and trailing CRLF do not contaminate email identity");
  await native.api.apply("context-one", nativeList.selectionToken, [CATALOG[0].email, CATALOG[2].email]);
  check(native.state.snapshot.attendees.length === 3, "Native line endings do not create duplicate attendees");
  check(native.state.snapshot.attendees[0] === nativePerson && native.state.snapshot.attendees[1] === nativeRoom
    && native.state.snapshot.attendees[2] === nativeDevice, "Unchanged native attendees retain their exact serialization");
  const injected = harness({ attendees: [PERSON + "\r\nSUMMARY:injected"] });
  await reject(() => injected.api.list("context-one"), "resource_selection_changed", "Snapshot attendee cannot smuggle another property");

  const promotedLine = ROOM.replace(";CUTYPE=ROOM", "");
  const promoted = harness({ attendees: [PERSON, promotedLine] });
  const promotion = await promoted.api.list("context-one");
  await promoted.api.apply("context-one", promotion.selectionToken, [CATALOG[0].email]);
  check(promoted.state.snapshot.attendees.length === 2, "Explicit resource promotion does not duplicate the same email");
  const promotedProperty = parsed(promoted.state.snapshot.attendees, CATALOG[0].email);
  promotedProperty.removeParameter("cutype");
  check(promotedProperty.toICALString() === ICAL.Property.fromString(promotedLine).toICALString(), "Promotion changes only CUTYPE, preserving other parameters");

  for (const selected of [[CATALOG[0].email, CATALOG[1].email], [CATALOG[2].email, CATALOG[2].email.toUpperCase()], ["foreign@example.test"], [null], "room@resources.invalid"]){
    const invalid = harness();
    const list = await invalid.api.list("context-one");
    await reject(() => invalid.api.apply("context-one", list.selectionToken, selected), "resource_invalid_selection");
    check(invalid.state.calls.update === 0, "Invalid selection cannot reach the editor bridge");
  }
}

async function checkLocations(){
  for (const [location, expected] of [[CATALOG[0].location, ""], ["Manually changed", "Manually changed"]]){
    const test = harness({ attendees: [PERSON, ROOM], location });
    const list = await test.api.list("context-one");
    await test.api.apply("context-one", list.selectionToken, []);
    check(test.state.snapshot.location === expected, "Removing a room clears only its exact unedited location");
    check(test.state.snapshot.attendees.length === 1 && test.state.snapshot.attendees[0] === PERSON, "Removing resources does not remove people");
  }
  const noLocation = harness({ resources: [{ ...CATALOG[0], location: "" }] });
  const list = await noLocation.api.list("context-one");
  await noLocation.api.apply("context-one", list.selectionToken, [CATALOG[0].email]);
  check(noLocation.state.snapshot.location === "Manual location", "A room without a stored location does not erase a manual location");
  const replacing = harness({ attendees: [PERSON, ROOM], location: CATALOG[0].location,
    resources: [CATALOG[0], { ...CATALOG[1], location: "" }] });
  const replacement = await replacing.api.list("context-one");
  await replacing.api.apply("context-one", replacement.selectionToken, [CATALOG[1].email]);
  check(replacing.state.snapshot.location === "", "A replacement room without an address does not retain the previous room's address");
}

async function checkUnbookableCatalogEntries(){
  const unknown = { ...CATALOG[1], principalPath: "/principals/calendar-rooms/missing", displayName: "Missing address", email: "", selectable: false };
  const alias = { ...CATALOG[2], principalPath: "/principals/calendar-resources/alias", selectable: false };
  for (const resources of [[CATALOG[0], unknown, alias, { ...alias, principalPath: alias.principalPath + "2" }], [unknown, alias]]){
    const test = harness({ resources, attendees: [PERSON, EQUIPMENT] });
    const loaded = await test.api.list("context-one");
    check(loaded.resources.length === resources.length && loaded.selectedEmails.length === 0,
      "Missing and duplicate addresses remain visible without preselecting ambiguous attendees");
    const available = await test.api.availability("context-one", loaded.selectionToken, 1);
    const expected = resources.filter((entry) => entry.selectable).map((entry) => entry.email);
    check(available.results.map((entry) => entry.email).join() === expected.join(), "Only usable unique catalog addresses reach availability batches");
    for (const email of ["", alias.email]){
      await reject(() => test.api.apply("context-one", loaded.selectionToken, [email]), "resource_invalid_selection");
      await reject(() => test.api.availability("context-one", loaded.selectionToken, 2, email, "2026-10-17"), "resource_invalid_selection");
      check(test.state.calls.update === 0 && test.state.availabilityQueries.length === 1,
        "Unbookable direct requests cannot mutate recipients or query a day");
    }
    await test.api.apply("context-one", loaded.selectionToken, expected);
    check(test.state.snapshot.attendees.includes(EQUIPMENT), "Applying healthy entries preserves an existing ambiguous attendee unchanged");
    check(expected.every((email) => !!parsed(test.state.snapshot.attendees, email)), "Healthy rooms remain applicable beside malformed entries");
  }
}

async function checkLifecycle(){
  for (const stage of ["policy", "directory", "read"]){
    const test = harness();
    test.state[`on${stage[0].toUpperCase()}${stage.slice(1)}`] = async () => test.changed();
    await reject(() => test.api.list("context-one"), "resource_connection_changed", `Account change during ${stage} await is rejected`);
    check(test.state.calls.update === 0, "Changed account does not edit a draft");
  }
  const changed = harness();
  const loaded = await changed.api.list("context-one");
  changed.changed({ NextcloudUrl: { newValue: "https://other.example.test" } }, "managed");
  await reject(() => changed.api.apply("context-one", loaded.selectionToken, []), "resource_connection_changed");
  const changingApply = harness();
  const beforeChange = await changingApply.api.list("context-one");
  changingApply.state.onPolicy = async () => changingApply.changed();
  await reject(() => changingApply.api.apply("context-one", beforeChange.selectionToken, []), "resource_connection_changed");
  check(changingApply.state.calls.update === 0, "Account change while apply awaits access cannot edit the draft");

  const revoked = harness();
  const beforeRevoke = await revoked.api.list("context-one");
  revoked.state.policy.status.seatAssigned = false;
  await reject(() => revoked.api.apply("context-one", beforeRevoke.selectionToken, [CATALOG[0].email]), "no_seat");
  check(revoked.state.calls.update === 0 && revoked.state.calls.policy === 2, "Apply refreshes access and refuses a revoked seat");

  for (const mutate of [
    (test) => { test.state.now += 600001; },
    (test) => { test.state.contexts.delete("context-one"); },
    (test) => { test.state.contexts.set("context-one", { editorId: "editor-two" }); }
  ]){
    const test = harness();
    const list = await test.api.list("context-one");
    mutate(test);
    await reject(() => test.api.apply("context-one", list.selectionToken, []), "resource_context_expired");
    check(test.state.calls.update === 0, "Expired or replaced editor context cannot apply");
  }
  const token = harness();
  await token.api.list("context-one");
  await reject(() => token.api.apply("context-one", "forged-token", []), "resource_context_expired");

  const racing = harness();
  const started = deferred();
  const release = deferred();
  racing.state.onDirectory = async (count) => { if (count === 1){ started.resolve(); await release.promise; } };
  const first = racing.api.list("context-one");
  await started.promise;
  const second = await racing.api.list("context-one");
  release.resolve();
  await reject(() => first, "resource_context_expired", "Older discovery cannot replace newer selection");
  await racing.api.apply("context-one", second.selectionToken, []);
  check(racing.state.writes.length === 1, "Newest selection remains usable after stale discovery finishes");

  const reentry = harness();
  const selection = await reentry.api.list("context-one");
  const entered = deferred();
  const finish = deferred();
  reentry.state.onPolicy = async () => { entered.resolve(); await finish.promise; };
  const applying = reentry.api.apply("context-one", selection.selectionToken, []);
  await entered.promise;
  await reject(() => reentry.api.apply("context-one", selection.selectionToken, []), "resource_context_expired");
  finish.resolve();
  await applying;
  check(reentry.state.calls.update === 1, "Reentry performs exactly one editor transaction");

  for (const field of ["location", "calendarId", "attendees"]){
    const test = harness();
    const list = await test.api.list("context-one");
    test.state.snapshot[field] = field === "attendees" ? [PERSON, UNKNOWN] : "changed";
    await reject(() => test.api.apply("context-one", list.selectionToken, []), "resource_selection_changed");
    check(test.state.writes.length === 0, "Native snapshot refusal leaves edits untouched");
  }
  const retry = harness();
  const retryList = await retry.api.list("context-one");
  retry.state.onUpdate = async () => { throw new Error("resource_selection_changed"); };
  await reject(() => retry.api.apply("context-one", retryList.selectionToken, []), "resource_selection_changed");
  retry.state.onUpdate = null;
  await retry.api.apply("context-one", retryList.selectionToken, []);
  check(retry.state.writes.length === 1, "A failed atomic bridge write releases the busy guard for retry");
}

async function checkRouter(){
  const test = harness();
  for (const page of ["calendarAction.html", "calendarResources.html"]){
    const response = await test.route("calendar:actionState", { ...test.sender, url: `moz-extension://test-instance/ui/${page}?contextId=context-one#fragment` });
    check(response.ok === true && response.resources.enabled, "Exact extension picker/action page can request state despite opaque URL origin");
  }
  for (const sender of [
    { ...test.sender, id: "foreign-addon" },
    { ...test.sender, url: "moz-extension://other-instance/ui/calendarResources.html" },
    { ...test.sender, url: "https://example.test/ui/calendarResources.html" },
    { ...test.sender, url: "moz-extension://test-instance/options.html" },
    { ...test.sender, url: "moz-extension://test-instance/ui/calendarResources.html/untrusted" },
    { id: "test-addon" }
  ]){
    const response = await test.route("resource:list", sender);
    check(response.ok === false, "Resource router rejects foreign or unrelated sender pages");
  }
  check(test.state.calls.directory === 0, "Rejected senders never load a directory");
  const error = test.api.errorResponse(new Error("resource_selection_invalid"), "resource_apply_failed");
  check(error.code === "resource_invalid_selection" && error.error === "translated:resource_invalid_selection", "Bridge errors map to localized picker messages");
}

async function checkAvailability(){
  const test = harness();
  const loaded = await test.api.list("context-one");
  check(JSON.stringify(loaded.interval) === JSON.stringify(INTERVAL), "Catalog includes the live interval in UTC milliseconds");
  const response = await test.api.availability("context-one", loaded.selectionToken, 1);
  check(response.ok && response.results.length === CATALOG.length && response.requestId === 1,
    "Interval query covers exactly the visible catalog and echoes its generation");
  check(response.range.start === INTERVAL.start && response.range.end === INTERVAL.end,
    "Interval query preserves the exact event bounds");
  check(test.state.availabilityQueries.length === 1 && test.state.calls.update === 0,
    "Free/busy inspection never writes the draft");

  for (const [date, timeZone, hours, expectedStart] of [
    ["2026-03-29", "Europe/Berlin", 23, "2026-03-28T23:00:00Z"],
    ["2026-10-25", "Europe/Berlin", 25, "2026-10-24T22:00:00Z"],
    ["2026-03-29", "W. Europe Standard Time", 23, "2026-03-28T23:00:00Z"],
    ["2026-10-25", "W. Europe Standard Time", 25, "2026-10-24T22:00:00Z"],
    ["2026-03-08", "Eastern Standard Time", 23, "2026-03-08T05:00:00Z"],
    ["2026-11-01", "Eastern Standard Time", 25, "2026-11-01T04:00:00Z"],
    ["2026-09-06", "America/Santiago", 23, "2026-09-06T04:00:00Z"],
    ["2026-10-17", "Asia/Kathmandu", 24, "2026-10-16T18:15:00Z"],
    ["2026-10-17", "UTC", 24, "2026-10-17T00:00:00Z"]
  ]){
    test.state.snapshot.availabilityInterval.timeZone = timeZone;
    const day = await test.api.availability("context-one", loaded.selectionToken, date, CATALOG[1].email.toUpperCase(), date);
    check(day.range.end - day.range.start === hours * 3600000 && day.range.start === Date.parse(expectedStart),
      `${timeZone}/${date}: day endpoints follow the appointment zone and daylight-saving transition`);
    check(day.results.length === 1 && day.results[0].email === CATALOG[1].email,
      "Day query includes only the requested catalog resource");
  }
  for (const [email, date] of [["foreign@example.test", "2026-10-17"], [CATALOG[0].email, "2026-02-30"],
    [CATALOG[0].email, "bad"], [undefined, "2026-10-17"]]){
    const before = test.state.availabilityQueries.length;
    await reject(() => test.api.availability("context-one", loaded.selectionToken, 7, email, date), "resource_invalid_selection");
    check(test.state.availabilityQueries.length === before, "Invalid day/resource input makes no DAV query");
  }
  await reject(() => test.api.availability("context-one", "foreign-token", 8), "resource_context_expired");
  for (const interval of [null, { ...INTERVAL, end: INTERVAL.start }, { ...INTERVAL, timeZone: "Unknown/Zone" },
    { ...INTERVAL, timeZone: "Customized Time Zone" }, { ...INTERVAL, timeZone: "floating" },
    { ...INTERVAL, start: "1792224000000" }]){
    test.state.snapshot.availabilityInterval = interval;
    const before = test.state.availabilityQueries.length;
    const result = await test.api.availability("context-one", loaded.selectionToken, 9);
    check(result.interval === null && result.results.length === 0 && test.state.availabilityQueries.length === before,
      "Invalid or missing live interval stays unknown without falling back to stale iCal or machine time");
  }
}

async function checkOutlookTimeZones(){
  for (const [source, expected] of [
    ["W. Europe Standard Time", "Europe/Berlin"],
    [" w. EUROPE Standard Time ", "Europe/Berlin"],
    ["Eastern Standard Time", "America/New_York"],
    ["Nepal Standard Time", "Asia/Katmandu"],
    ["Europe/Berlin", "Europe/Berlin"],
    ["UTC", "UTC"],
    ["GMT", "GMT"]
  ]){
    const test = harness();
    const original = { ...INTERVAL, timeZone: source };
    test.state.snapshot.availabilityInterval = original;
    const loaded = await test.api.list("context-one");
    check(loaded.interval?.timeZone === expected, `${source}: list exposes the shared runtime time zone`);
    const current = await test.api.currentInterval("context-one", loaded.selectionToken);
    check(current.interval?.timeZone === expected, `${source}: interval polling uses the same normalized zone`);
    const result = await test.api.availability("context-one", loaded.selectionToken, 1);
    check(result.interval?.timeZone === expected && result.results.length === CATALOG.length,
      `${source}: mapped zones permit availability queries and remain usable by the UI`);
    check(test.state.availabilityQueries[0]?.start === INTERVAL.start
      && test.state.availabilityQueries[0]?.end === INTERVAL.end,
    `${source}: native UTC timestamps are never reinterpreted or shifted`);
    check(original.timeZone === source && test.state.calls.update === 0,
      `${source}: normalization changes neither the editor snapshot nor the appointment`);
  }
}

async function checkAvailabilityLifecycle(){
  for (const mutation of ["seat", "account", "interval", "timezone", "closed", "expired", "replaced"]){
    const test = harness();
    const loaded = await test.api.list("context-one");
    const started = deferred();
    const release = deferred();
    test.state.onAvailability = async () => { started.resolve(); await release.promise; };
    const pending = test.api.availability("context-one", loaded.selectionToken, 1);
    await started.promise;
    if (mutation === "seat") test.state.policy.status.seatAssigned = false;
    if (mutation === "account") test.changed();
    if (mutation === "interval") test.state.snapshot.availabilityInterval = { ...INTERVAL, end: INTERVAL.end + 3600000 };
    if (mutation === "timezone") test.state.snapshot.availabilityInterval = { ...INTERVAL, timeZone: "Eastern Standard Time" };
    if (mutation === "closed") test.api.close("context-one", loaded.selectionToken);
    if (mutation === "expired") test.state.now += 600001;
    if (mutation === "replaced") await test.api.list("context-one");
    release.resolve();
    const error = await reject(() => pending, null, `${mutation}: stale availability cannot be published`);
    if (mutation === "seat") check(error.code === "no_seat", "Late explicit seat denial overrides a successful DAV reply");
    if (["interval", "timezone"].includes(mutation)) check(error.name === "AbortError", "Changed live time or zone cancels stale results even before the next UI poll");
    if (["account", "closed", "expired", "replaced"].includes(mutation)){
      check(test.state.availabilitySessions[0].disposed && test.state.availabilityQueries[0].signal.aborted,
        `${mutation}: pending work is aborted and its service cache disposed`);
    }
  }

  const lanes = harness();
  const loaded = await lanes.api.list("context-one");
  const intervalStarted = deferred();
  const dayStarted = deferred();
  const release = deferred();
  lanes.state.onAvailability = async (query) => {
    (query.resources.length === 1 ? dayStarted : intervalStarted).resolve();
    await release.promise;
  };
  const interval = lanes.api.availability("context-one", loaded.selectionToken, "interval-1");
  await intervalStarted.promise;
  const day = lanes.api.availability("context-one", loaded.selectionToken, "day-1", CATALOG[0].email, "2026-10-17");
  await dayStarted.promise;
  const current = await lanes.api.currentInterval("context-one", loaded.selectionToken);
  check(current.interval.start === INTERVAL.start && lanes.state.availabilityQueries.every((query) => !query.signal.aborted),
    "Unchanged interval polls and a day query do not cancel an in-flight interval query");
  lanes.api.cancel("context-one", loaded.selectionToken, "day", "obsolete-request");
  check(!lanes.state.availabilityQueries[1].signal.aborted, "A stale cancel cannot cancel a newer request");
  lanes.api.cancel("context-one", loaded.selectionToken, "day", "day-1");
  check(lanes.state.availabilityQueries[1].signal.aborted && !lanes.state.availabilityQueries[0].signal.aborted,
    "Closing a day overview cancels only its lane");
  release.resolve();
  check((await interval).ok, "The independent interval request still finishes");
  check((await reject(() => day)).name === "AbortError", "Canceled day results are discarded");

  const racing = harness();
  const selection = await racing.api.list("context-one");
  const entered = deferred();
  const finish = deferred();
  racing.state.onAvailability = async () => {
    if (racing.state.availabilityQueries.length === 1){ entered.resolve(); await finish.promise; }
  };
  const previous = racing.api.availability("context-one", selection.selectionToken, 1);
  await entered.promise;
  check((await racing.api.availability("context-one", selection.selectionToken, 2)).ok, "New generation can finish before an old transport returns");
  finish.resolve();
  check((await reject(() => previous)).name === "AbortError", "Old generation never overwrites its successor");
  racing.state.snapshot.location = "User changed the location";
  await racing.api.currentInterval("context-one", selection.selectionToken);
  await reject(() => racing.api.apply("context-one", selection.selectionToken, []), "resource_selection_changed",
    "Interval refresh does not replace the original atomic attendee/location snapshot");
  racing.api.close("context-one", selection.selectionToken);
  racing.api.close("context-one", selection.selectionToken);
  check(racing.state.timers.size === 0, "Repeated close releases the expiry timer");

  const closing = harness();
  const loading = deferred();
  const complete = deferred();
  closing.state.onDirectory = async () => { loading.resolve(); await complete.promise; };
  const list = closing.api.list("context-one");
  await loading.promise;
  closing.api.close("context-one");
  complete.resolve();
  await reject(() => list, "resource_context_expired", "Pagehide while loading invalidates the pending catalog before a token exists");
  check(closing.state.availabilitySessions.length === 0 && closing.state.timers.size === 0,
    "Closing during catalog load leaves no availability session or timer");
}

(async () => {
  await checkAccessMatrix();
  await checkPolicyWarningSnapshot();
  await checkSelection();
  await checkLocations();
  await checkUnbookableCatalogEntries();
  await checkLifecycle();
  await checkRouter();
  await checkOutlookTimeZones();
  await checkAvailability();
  await checkAvailabilityLifecycle();
  console.log(`Calendar resource runtime: ${assertions} assertions passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
