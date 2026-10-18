"use strict";

const vm = require("node:vm");
const assert = require("node:assert/strict");
const ICAL = require("../vendor/ical.js");
const { loadScript, readJson } = require("./review-check-utils");

// These fakes expose the native calIcalComponent/CalAttendee surface used by
// the production bridge; actual parsing runs through the bundled ical.js.
class NativeComponent {
  constructor(component) {
    this.component = component;
  }
  get componentType() { return this.component.name.toUpperCase(); }
  getFirstSubcomponent() {
    this.components = this.component.getAllSubcomponents()[Symbol.iterator]();
    return this.getNextSubcomponent();
  }
  getNextSubcomponent() {
    const value = this.components.next().value;
    return value ? new NativeComponent(value) : null;
  }
  getFirstProperty() {
    this.properties = this.component.getAllProperties()[Symbol.iterator]();
    return this.getNextProperty();
  }
  getNextProperty() {
    const value = this.properties.next().value;
    return value ? { propertyName: value.name.toUpperCase(), value } : null;
  }
}

class NativeAttendee {
  constructor(line) {
    this.parameters = {};
    this.isOrganizer = false;
    if (line) {
      this.icalProperty = { value: ICAL.Property.fromString(line.trim()) };
    }
  }
  set icalProperty({ value }) {
    this.id = String(value.getFirstValue());
    this.isOrganizer = value.name === "organizer";
    this.parameters = { ...value.toJSON()[1] };
  }
  get userType() { return this.parameters.cutype || null; }
  set userType(value) {
    if (value) { this.parameters.cutype = value; }
    else { delete this.parameters.cutype; }
  }
  get commonName() { return this.parameters.cn || null; }
  set commonName(value) { this.parameters.cn = value; }
  get icalString() {
    const parameters = {};
    // CalAttendee serializes promoted parameters in this native order.
    for (const key of ["rsvp", "cn", "partstat", "cutype", "role"]) {
      if (this.parameters[key]) { parameters[key] = this.parameters[key]; }
    }
    for (const [key, value] of Object.entries(this.parameters)) {
      if (!(key in parameters)) { parameters[key] = value; }
    }
    return new ICAL.Property([
      this.isOrganizer ? "organizer" : "attendee", parameters, "cal-address", this.id
    ]).toICALString() + "\r\n";
  }
  clone() { return new NativeAttendee(this.icalString); }
}

const PERSON = "ATTENDEE;CN=Alice;PARTSTAT=ACCEPTED;ROLE=OPT-PARTICIPANT;X-KEEP=yes:mailto:alice@example.invalid";
const ROOM = "ATTENDEE;CN=Room;PARTSTAT=NEEDS-ACTION;CUTYPE=ROOM;ROLE=REQ-PARTICIPANT:mailto:room@resources.invalid";
const RESOURCE = "ATTENDEE;CN=Projector;PARTSTAT=NEEDS-ACTION;CUTYPE=RESOURCE;ROLE=REQ-PARTICIPANT:mailto:projector@resources.invalid";

function editor(attendees = []) {
  const values = { LOCATION: "saved old location" };
  const controls = Object.fromEntries(["title", "location", "description"].map(key => [
    `item-${key}`, { value: key === "location" ? "live location" : key, focus() {} }
  ]));
  const calendar = {
    id: "calendar-a", readOnly: false,
    getProperty(name) {
      return { organizerId: "mailto:owner@example.invalid", organizerCN: "Owner" }[name] ?? null;
    }
  };
  const item = {
    calendar, id: "item-a", icalString: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
    isEvent: () => true, isTodo: () => false,
    getProperty: name => values[name] ?? null,
    setProperty: (name, value) => { values[name] = value; },
    deleteProperty: name => { delete values[name]; }
  };
  const window = {
    calendarItem: item, attendees: attendees.map(line => new NativeAttendee(line)),
    organizer: null, mode: "new", closed: false, gIsReadOnly: false,
    document: { getElementById: id => controls[id] || null },
    getCurrentCalendar: () => calendar,
    updateAttendeeInterface() {
      window.uiUpdates++;
      window.nativeIcons = window.attendees.map(attendee => attendee.userType);
    },
    uiUpdates: 0,
    location: { href: "chrome://calendar/content/calendar-item-iframe.xhtml" }
  };
  return { window, item, calendar, values, controls };
}

function harness() {
  class ExtensionAPI {}
  class ExtensionError extends Error {}
  class EventManager { api() { return {}; } }
  const permissions = { writable: true, add: true, modify: true, invitation: false };
  const cal = {
    dtz: { defaultTimezone: { tzid: "Europe/Berlin", offset: value => {
      const day = Date.UTC(value.year, value.month, value.day);
      return day >= Date.UTC(2026, 2, 30) && day < Date.UTC(2026, 9, 26) ? 120 : 60;
    } } },
    acl: {
      isCalendarWritable: calendar => permissions.writable && !calendar.readOnly,
      userCanAddItemsToCalendar: () => permissions.add,
      userCanModifyItem: () => permissions.modify
    },
    itip: { isInvitation: () => permissions.invitation },
    email: { removeMailTo: value => value.toLowerCase().startsWith("mailto:") ? value.slice(7) : value },
    icsService: { parseICS: value => new NativeComponent(new ICAL.Component(ICAL.parse(value))) }
  };
  const context = vm.createContext({
    ChromeUtils: { importESModule(url) {
      if (url.includes("ExtensionCommon")) {
        return { ExtensionCommon: { ExtensionAPI, EventManager, makeWidgetId: value => value } };
      }
      if (url.includes("ExtensionUtils")) { return { ExtensionUtils: { ExtensionError } }; }
      if (url.includes("CalAttendee")) { return { CalAttendee: NativeAttendee }; }
      return { cal };
    } },
    console
  });
  loadScript("experiments/ncCalToolbar/parent.js", context);
  const implementation = new context.ncCalToolbar();
  const editors = new Map();
  const errors = [];
  implementation._bridge = () => ({ normalizeEditorId: value => value });
  implementation._resolveEditorWindow = id => editors.get(id)?.window || null;
  implementation._getEditedItem = window => window.calendarItem;
  implementation._ensureLifecycleWatch = () => {};
  implementation._logError = (...args) => errors.push(args);
  implementation._dispatchInputEvent = () => {};
  const api = implementation.getAPI({}).ncCalToolbar;
  return { api, implementation, editors, errors, permissions, cal };
}

class NativeDateTime {
  constructor(year, month, day, hour, timezone, isDate = false) {
    Object.assign(this, { year, month, day, hour, minute: 0, second: 0, timezone, isDate });
  }
  clone() { return Object.assign(new NativeDateTime(), this); }
  get nativeTime() {
    const wall = Date.UTC(this.year, this.month, this.day, this.hour, this.minute, this.second);
    return (wall - (this.timezone.offset?.(this) || 0) * 60000) * 1000;
  }
}

async function checkAvailabilityInterval() {
  const h = harness();
  const entry = editor();
  h.editors.set("interval", entry);
  const floating = { tzid: "floating", isFloating: true };
  const berlin = h.cal.dtz.defaultTimezone;
  const utc = { tzid: "Etc/UTC", isUTC: true };
  const ny = { tzid: "America/New_York" };
  entry.controls["event-all-day"] = { checked: false };
  entry.window.gStartTime = new NativeDateTime(2026, 9, 17, 10, berlin);
  entry.window.gEndTime = new NativeDateTime(2026, 9, 17, 11, berlin);
  entry.window.gStartTimezone = ny;
  const original = JSON.stringify([entry.window.gStartTime, entry.window.gEndTime]);
  const snapshot = await h.api.getCurrent({ editorId: "interval" });
  assert.equal(snapshot.availabilityInterval.start, Date.parse("2026-10-17T08:00:00Z"));
  assert.equal(snapshot.availabilityInterval.end, Date.parse("2026-10-17T09:00:00Z"));
  assert.equal(snapshot.availabilityInterval.timeZone, "America/New_York",
    "Event zone comes from gStartTimezone, not the default-zone gStartTime value");
  assert.equal(snapshot.startTimestamp, snapshot.availabilityInterval.start / 1000,
    "Existing Talk timestamp units and meaning stay unchanged");
  assert.equal(JSON.stringify([entry.window.gStartTime, entry.window.gEndTime]), original,
    "Availability snapshots never mutate live date objects");

  for (const [month, day, hours, expectedStart] of [
    [2, 29, 23, "2026-03-28T23:00:00Z"], [9, 25, 25, "2026-10-24T22:00:00Z"],
    [0, 31, 24, "2026-01-30T23:00:00Z"]
  ]) {
    entry.window.gStartTime = new NativeDateTime(2026, month, day, 0, floating, true);
    entry.window.gEndTime = entry.window.gStartTime.clone();
    entry.window.gStartTimezone = floating;
    entry.controls["event-all-day"].checked = true;
    const result = await h.api.getCurrent({ editorId: "interval" });
    assert.equal(result.availabilityInterval.start, Date.parse(expectedStart));
    assert.equal(result.availabilityInterval.end - result.availabilityInterval.start, hours * 3600000,
      "All-day availability includes the displayed end day with the correct local DST bounds");
    assert.equal(result.availabilityInterval.timeZone, "Europe/Berlin");
    assert.equal(entry.window.gEndTime.day, day, "Exclusive end adjustment stays on the clone");
    assert.equal(entry.window.gEndTime.isDate, true);
    assert.equal(result.startTimestamp, result.endTimestamp,
      "New resource interval does not change existing Talk all-day snapshot behavior");
  }
  entry.controls["event-all-day"].checked = false;
  entry.window.gStartTime = new NativeDateTime(2026, 9, 17, 10, floating);
  entry.window.gEndTime = new NativeDateTime(2026, 9, 17, 11, floating);
  assert.equal((await h.api.getCurrent({ editorId: "interval" })).availabilityInterval.start,
    Date.parse("2026-10-17T08:00:00Z"), "Floating wall times use the configured calendar default zone");
  entry.window.gStartTimezone = utc;
  entry.window.gStartTime = new NativeDateTime(2026, 9, 17, 10, utc);
  entry.window.gEndTime = new NativeDateTime(2026, 9, 17, 11, utc);
  assert.equal((await h.api.getCurrent({ editorId: "interval" })).availabilityInterval.timeZone, "UTC");

  const host = { document: { getElementById: id => id === "calendar-item-panel-iframe"
    ? { contentWindow: entry.window } : null }, calendarItem: entry.item };
  h.editors.set("tab-interval", { window: host });
  assert.equal((await h.api.getCurrent({ editorId: "tab-interval" })).availabilityInterval.start,
    Date.parse("2026-10-17T10:00:00Z"), "Embedded tab editor reads the same live interval path");
  entry.window.gStartTimezone = null;
  assert.equal((await h.api.getCurrent({ editorId: "interval" })).availabilityInterval, undefined,
    "Missing live zone does not fall back to a stale saved event");
}

async function expectUnchanged(h, entry, options, code) {
  const attendees = entry.window.attendees;
  const organizer = entry.window.organizer;
  const location = entry.controls["item-location"].value;
  await assert.rejects(h.api.updateCurrent(options), code ? { message: code } : undefined);
  assert.strictEqual(entry.window.attendees, attendees);
  assert.strictEqual(entry.window.organizer, organizer);
  assert.equal(entry.controls["item-location"].value, location);
}

async function main() {
  await checkAvailabilityInterval();
  const schema = readJson("experiments/ncCalToolbar/schema.json")[0];
  const updateSchema = schema.functions.find(fn => fn.name === "updateCurrent");
  assert.equal(updateSchema.parameters[0].properties.attendees.$ref, "CurrentItemAttendeesUpdate");
  const intervalSchema = schema.types.find(type => type.id === "CurrentItemSnapshot").properties.availabilityInterval;
  assert.equal(intervalSchema.properties.start.type, "number");
  assert.equal(intervalSchema.properties.timeZone.type, "string");
  const h = harness();
  const folded = h.implementation._parseAttendee(
    "ATTENDEE;CN=Room;CUTYPE=ROOM;X-NOTE=folded\r\n value:mailto:folded@resources.invalid\r\n"
  );
  assert.equal(folded.id, "mailto:folded@resources.invalid");
  assert.equal(folded.parameters["x-note"], "foldedvalue");
  const entry = editor([PERSON]);
  h.editors.set("first", entry);
  const second = editor([]);
  h.editors.set("second", second);
  const snapshot = await h.api.getCurrent({ editorId: "first" });
  assert.equal(snapshot.canEditAttendees, true);
  assert.equal(snapshot.attendees.length, 1);
  assert.equal(snapshot.location, "live location");
  const originalPerson = entry.window.attendees[0];
  const originalSource = entry.item.icalString;
  const after = [...snapshot.attendees, ROOM, RESOURCE];
  const updated = await h.api.updateCurrent({
    editorId: "first", fields: { location: "Room address" }, properties: { "X-TEST": "value" },
    attendees: { before: snapshot.attendees, after, beforeLocation: "live location", beforeCalendarId: "calendar-a" }
  });
  assert.equal(updated.attendees.length, 3);
  assert.strictEqual(entry.window.attendees[0], originalPerson);
  assert.equal(entry.window.organizer.id, "owner@example.invalid");
  assert.equal(entry.window.organizer.isOrganizer, true);
  assert.equal(entry.controls["item-location"].value, "Room address");
  assert.equal(entry.values["X-TEST"], "value");
  assert.equal(entry.item.icalString, originalSource, "Source item must not be saved or overwritten");
  assert.deepEqual(Array.from(entry.window.nativeIcons), [null, "ROOM", "RESOURCE"]);
  assert.equal(second.window.attendees.length, 0, "Target editor ID must isolate other open windows");

  const organizer = entry.window.organizer;
  const room = entry.window.attendees[1];
  await h.api.updateCurrent({ editorId: "first", attendees: { before: updated.attendees, after: updated.attendees } });
  assert.strictEqual(entry.window.organizer, organizer, "Reapplying must keep existing organizer");
  assert.strictEqual(entry.window.attendees[1], room, "Repeated application must keep native attendee objects");
  assert.equal(entry.window.attendees.length, 3);

  await expectUnchanged(h, entry, {
    editorId: "first", fields: { location: "wrong" },
    attendees: { before: snapshot.attendees, after }
  }, "resource_selection_changed");
  for (const stale of [{ beforeLocation: "old location" }, { beforeCalendarId: "calendar-b" }]) {
    await expectUnchanged(h, entry, {
      editorId: "first", fields: { location: "wrong" },
      attendees: { before: updated.attendees, after: updated.attendees, ...stale }
    }, "resource_selection_changed");
  }
  for (const [key, value] of [["writable", false], ["add", false], ["invitation", true]]) {
    h.permissions[key] = value;
    assert.equal((await h.api.getCurrent({ editorId: "first" })).canEditAttendees, false);
    await expectUnchanged(h, entry, {
      editorId: "first", attendees: { before: updated.attendees, after: updated.attendees }
    }, "resource_readonly");
    h.permissions[key] = !value;
  }
  entry.window.mode = "modify";
  h.permissions.modify = false;
  await expectUnchanged(h, entry, {
    editorId: "first", attendees: { before: updated.attendees, after: updated.attendees }
  }, "resource_readonly");
  h.permissions.modify = true;
  entry.item.isEvent = () => false;
  assert.equal((await h.api.getCurrent({ editorId: "first" })).canEditAttendees, false);
  entry.item.isEvent = () => true;
  const getCalendarProperty = entry.calendar.getProperty;
  entry.window.organizer = null;
  entry.calendar.getProperty = () => null;
  assert.equal((await h.api.getCurrent({ editorId: "first" })).canEditAttendees, false);
  entry.calendar.getProperty = getCalendarProperty;
  entry.window.organizer = organizer;

  for (const invalidAfter of [
    [ROOM], [...updated.attendees, PERSON],
    [...updated.attendees, "ATTENDEE:mailto:new-person@example.invalid"],
    [...updated.attendees, "ORGANIZER:mailto:other@example.invalid"],
    [...updated.attendees, ROOM + "\r\nLOCATION:injected"],
    [...updated.attendees, "not ical"]
  ]) {
    await expectUnchanged(h, entry, {
      editorId: "first", fields: { location: "wrong" },
      attendees: { before: updated.attendees, after: invalidAfter }
    });
  }

  const promotedEntry = editor([PERSON]);
  h.editors.set("promote", promotedEntry);
  const personBefore = promotedEntry.window.attendees[0];
  const promoted = personBefore.clone();
  promoted.userType = "ROOM";
  const comparable = promoted.clone();
  comparable.userType = personBefore.userType;
  assert.equal(comparable.icalString, personBefore.icalString);
  await h.api.updateCurrent({ editorId: "promote", attendees: {
    before: [personBefore.icalString], after: [promoted.icalString]
  } });
  assert.equal(personBefore.userType, null, "Promotion must not mutate original attendee");
  assert.equal(promotedEntry.window.attendees[0].userType, "ROOM");
  assert.equal(promotedEntry.window.attendees[0].parameters["x-keep"], "yes");
  assert.equal(promotedEntry.window.attendees[0].parameters.partstat, "ACCEPTED");
  const refused = editor([PERSON]);
  h.editors.set("refused", refused);
  promoted.parameters.partstat = "NEEDS-ACTION";
  await expectUnchanged(h, refused, { editorId: "refused", attendees: {
    before: [personBefore.icalString], after: [promoted.icalString]
  } }, "resource_selection_invalid");

  for (const failure of ["field", "property", "attendee-ui", "snapshot"]) {
    const failing = editor([PERSON]);
    failing.values["X-TEST"] = "before";
    h.editors.set("failure", failing);
    const before = failing.window.attendees;
    const nativeWrite = h.implementation._writeField;
    const nativeSnapshot = h.implementation._snapshotItem;
    let thrown = false;
    if (failure === "field") {
      h.implementation._writeField = function(...args) {
        nativeWrite.apply(this, args);
        if (!thrown) { thrown = true; throw new Error("input listener failed"); }
      };
    }
    if (failure === "property") {
      failing.item.setProperty = (name, value) => {
        if (name === "X-FAIL") { throw new Error("setter failed"); }
        failing.values[name] = value;
      };
    }
    if (failure === "attendee-ui") {
      const updateUi = failing.window.updateAttendeeInterface;
      failing.window.updateAttendeeInterface = () => {
        updateUi();
        if (!thrown) { thrown = true; throw new Error("UI refresh failed"); }
      };
    }
    if (failure === "snapshot") {
      h.implementation._snapshotItem = () => { throw new Error("snapshot failed"); };
    }
    await expectUnchanged(h, failing, {
      editorId: "failure", fields: { location: "new" },
      properties: { "X-TEST": "after", ...(failure === "property" ? { "X-FAIL": "bad" } : {}) },
      attendees: { before: before.map(attendee => attendee.icalString), after: [before[0].icalString, ROOM] }
    });
    assert.equal(failing.values["X-TEST"], "before", `${failure}: properties must roll back`);
    h.implementation._writeField = nativeWrite;
    h.implementation._snapshotItem = nativeSnapshot;
  }

  const tab = editor([]);
  const host = { document: { getElementById(id) {
    return id === "calendar-item-panel-iframe"
      ? { contentWindow: tab.window, contentDocument: tab.window.document } : null;
  } }, calendarItem: tab.item };
  h.editors.set("tab", { window: host });
  await h.api.updateCurrent({ editorId: "tab", fields: { location: "tab room" }, attendees: { before: [], after: [ROOM] } });
  assert.equal(tab.window.attendees.length, 1);
  assert.equal(tab.controls["item-location"].value, "tab room");
  tab.controls["item-location"].value = "";
  assert.equal((await h.api.getCurrent({ editorId: "tab" })).location, "", "Cleared live location must not revive saved location");
  h.editors.delete("tab");
  assert.equal(await h.api.getCurrent({ editorId: "tab" }), null);
  await assert.rejects(h.api.updateCurrent({ editorId: "tab", attendees: { before: [], after: [ROOM] } }));
  console.log("[OK] calendar-resource-editor-check passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
