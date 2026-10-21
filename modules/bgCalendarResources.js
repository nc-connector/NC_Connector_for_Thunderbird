/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0; see LICENSE.txt.
 */
/**
 * Resource picker access, selection, and draft updates.
 * Catalog choices stay in memory and never create bookings outside the editor.
 */
'use strict';

const NCCalendarResources = (() => {
  const selections = new WeakMap();
  const activeSessions = new Set();
  const selectionLifetimeMs = 10 * 60 * 1000;
  let accountRevision = 0;

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "managed" || (area === "local"
      && ["baseUrl", "user", "appPass", "authMode"].some((key) => Object.hasOwn(changes, key)))){
      accountRevision++;
      for (const session of activeSessions) disposeSession(session);
    }
  });

  function cancelRequests(session, lane, requestId){
    for (const name of lane ? [lane] : ["interval", "day"]){
      const request = session.requests?.[name];
      if (!request || (requestId != null && request.id !== requestId)) continue;
      request.controller.abort();
      delete session.requests[name];
    }
  }

  function disposeSession(session){
    if (!session || session.closed) return;
    session.closed = true;
    cancelRequests(session);
    session.availability?.dispose();
    session.availability = null;
    session.resources?.clear();
    session.snapshot = null;
    clearTimeout(session.expiryTimer);
    activeSessions.delete(session);
  }

  function pickerError(code){
    const error = new Error(code);
    error.code = code;
    error.ncUserMessage = bgI18n(code);
    return error;
  }

  function contextFor(contextId){
    const context = getCalendarWizardContext(contextId);
    if (!context?.editorId) throw pickerError("resource_context_expired");
    return context;
  }

  function assertAccount(revision){
    if (revision !== accountRevision) throw pickerError("resource_connection_changed");
  }

  async function readAccess(){
    const revision = accountRevision;
    const options = await NCCore.getOpts();
    const policy = await NCPolicyRuntime.getPolicyStatus(options);
    assertAccount(revision);
    const talk = NCPolicyState.getActionAccessState(policy, bgI18n);
    const resources = NCPolicyState.getActionAccessState(policy, bgI18n, true);
    return { options, revision, talk, resources, policyStatus: policy };
  }

  async function readEditor(context){
    const snapshot = await browser.ncCalToolbar.getCurrent({ editorId: context.editorId, returnFormat: "ical" });
    if (!snapshot || snapshot.editorId !== context.editorId) throw pickerError("resource_context_expired");
    if (!snapshot.canEditAttendees || snapshot.type !== "event" || !Array.isArray(snapshot.attendees)){
      throw pickerError("resource_readonly");
    }
    return snapshot;
  }

  function assertResourceAccess(access){
    if (!access.resources.enabled){
      const error = new Error(access.resources.code);
      error.code = access.resources.code;
      error.ncUserMessage = access.resources.notice;
      throw error;
    }
  }

  function attendeeRecord(value){
    // Native serialization contains folded lines and trailing CRLF; parse a
    // component so those separators cannot become part of the calendar address.
    const component = new ICAL.Component(ICAL.parse(`BEGIN:VEVENT\r\n${value}\r\nEND:VEVENT\r\n`));
    const properties = component.getAllProperties();
    if (component.getAllSubcomponents().length || properties.length !== 1 || properties[0].name !== "attendee"){
      throw pickerError("resource_selection_changed");
    }
    const property = properties[0];
    const address = String(property.getFirstValue() || "");
    const email = address.toLowerCase().startsWith("mailto:") ? address.slice(7).toLowerCase() : "";
    const kind = String(property.getParameter("cutype") || "").toUpperCase();
    return { property, email, kind, resource: kind === "ROOM" || kind === "RESOURCE" };
  }

  async function actionState(contextId){
    const context = contextFor(contextId);
    const access = await readAccess();
    if (access.resources.enabled){
      try{
        await readEditor(context);
      }catch(error){
        access.resources = { enabled: false, code: error.code || "resource_readonly",
          notice: error.ncUserMessage || bgI18n("resource_readonly") };
        console.error("[NCBG] resource editor unavailable", { code: access.resources.code });
      }
    }
    return { ok: true, talk: access.talk, resources: access.resources };
  }

  async function list(contextId){
    const context = contextFor(contextId);
    // A second load invalidates earlier results, including an in-flight request.
    disposeSession(selections.get(context));
    const session = { token: crypto.randomUUID(), loading: true, requests: {}, created: Date.now() };
    selections.set(context, session);
    activeSessions.add(session);
    session.expiryTimer = setTimeout(() => disposeSession(session), selectionLifetimeMs);
    try{
      const access = await readAccess();
      assertResourceAccess(access);
      await readEditor(context);
      const resources = await NCCalendarResourceDirectory.list(access.options);
      const snapshot = await readEditor(context);
      assertAccount(access.revision);
      if (contextFor(contextId) !== context || selections.get(context) !== session || session.closed){
        throw pickerError("resource_context_expired");
      }
      // Unusable/ambiguous addresses stay visible but never enter scheduling or draft updates.
      const byEmail = new Map(resources.filter((resource) => resource.selectable && resource.email)
        .map((resource) => [resource.email.toLowerCase(), resource]));
      const selectedEmails = snapshot.attendees.map(attendeeRecord)
        .filter((attendee) => attendee.resource && byEmail.has(attendee.email))
        .map((attendee) => attendee.email);
      Object.assign(session, { loading: false, resources: byEmail, snapshot, created: Date.now(),
        revision: access.revision, interval: snapshotInterval(snapshot),
        availability: NCCalendarResourceAvailability.createSession(access.options) });
      clearTimeout(session.expiryTimer);
      session.expiryTimer = setTimeout(() => disposeSession(session), selectionLifetimeMs);
      L("resource directory ready", { count: resources.length, selectedCount: selectedEmails.length });
      // Display the status already checked for this catalog; warnings do not grant or deny access.
      return { ok: true, resources, selectedEmails: [...new Set(selectedEmails)], selectionToken: session.token,
        policyStatus: access.policyStatus, interval: session.interval };
    }catch(error){
      disposeSession(session);
      throw error;
    }
  }

  function sessionFor(contextId, selectionToken){
    const context = contextFor(contextId);
    const session = selections.get(context);
    if (session?.revision != null) assertAccount(session.revision);
    if (!session || session.closed || session.loading || session.token !== selectionToken
      || Date.now() - session.created >= selectionLifetimeMs){
      if (session && Date.now() - session.created >= selectionLifetimeMs) disposeSession(session);
      throw pickerError("resource_context_expired");
    }
    return { context, session };
  }

  function snapshotInterval(snapshot){
    const interval = snapshot.availabilityInterval;
    if (!interval || !Number.isSafeInteger(interval.start) || !Number.isSafeInteger(interval.end)
      || interval.end <= interval.start || typeof interval.timeZone !== "string" || !interval.timeZone) return null;
    // Reuse Talk's Windows/IANA mapping for Outlook-created appointments.
    // Native UTC bounds are already correct; normalize only the display/day zone.
    // Keep other Intl-supported aliases, but never substitute the machine zone.
    const timeZone = NCIcalContract.resolveRuntimeTimeZone(interval.timeZone) || interval.timeZone;
    try{
      new Intl.DateTimeFormat("en", { timeZone }).format(interval.start);
      return { start: interval.start, end: interval.end, timeZone };
    }catch(error){
      L("resource interval unavailable", { reason: "unsupported_timezone" });
      return null;
    }
  }

  function sameInterval(left, right){
    return left?.start === right?.start && left?.end === right?.end && left?.timeZone === right?.timeZone;
  }

  async function currentInterval(contextId, selectionToken){
    const { context, session } = sessionFor(contextId, selectionToken);
    const snapshot = await readEditor(context);
    sessionFor(contextId, selectionToken);
    const interval = snapshotInterval(snapshot);
    if (!sameInterval(session.interval, interval)){
      session.interval = interval;
      cancelRequests(session);
    }
    return { ok: true, interval };
  }

  function dayRange(date, timeZone){
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw pickerError("resource_invalid_selection");
    const day = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) throw pickerError("resource_invalid_selection");
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    function wallTime(value){
      const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
      return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second));
    }
    function midnight(target){
      // Try both neighboring offsets so an overlap uses its first midnight.
      const candidates = [-86400000, 0, 86400000].map((delta) => {
        const sample = target + delta;
        return target - (wallTime(sample) - sample);
      }).filter((value) => wallTime(value) === target);
      if (candidates.length) return Math.min(...candidates);
      // Some zones advance at midnight; the day then starts at its first valid time.
      let lower = (target - 86400000) / 1000;
      let upper = (target + 86400000) / 1000;
      while (lower < upper){
        const middle = Math.floor((lower + upper) / 2);
        if (wallTime(middle * 1000) < target) lower = middle + 1;
        else upper = middle;
      }
      const result = lower * 1000;
      return wallTime(result) < target + 86400000 ? result : null;
    }
    const start = midnight(day);
    const end = midnight(day + 86400000);
    if (start == null || end == null || end <= start) throw pickerError("resource_availability_failed");
    return { start, end };
  }

  async function availability(contextId, selectionToken, requestId, email, date){
    const { context, session } = sessionFor(contextId, selectionToken);
    if ((typeof requestId !== "string" && !Number.isSafeInteger(requestId))
      || (email != null && (typeof email !== "string" || !session.resources.has(email.toLowerCase())))
      || (email == null && date != null)) throw pickerError("resource_invalid_selection");
    const lane = email == null ? "interval" : "day";
    cancelRequests(session, lane);
    const request = { id: requestId, controller: new AbortController() };
    session.requests[lane] = request;
    function assertCurrent(){
      sessionFor(contextId, selectionToken);
      if (session.requests[lane] !== request || request.controller.signal.aborted){
        throw new DOMException("Resource request canceled", "AbortError");
      }
    }
    try{
      const access = await readAccess();
      assertResourceAccess(access);
      assertCurrent();
      const snapshot = await readEditor(context);
      assertCurrent();
      const interval = snapshotInterval(snapshot);
      if (!sameInterval(session.interval, interval)){
        session.interval = interval;
        cancelRequests(session, lane === "interval" ? "day" : "interval");
      }
      if (!interval) return { ok: true, interval: null, range: null, results: [], requestId };
      const range = lane === "day" ? dayRange(date, interval.timeZone) : { start: interval.start, end: interval.end };
      const resources = lane === "day" ? [session.resources.get(email.toLowerCase())] : [...session.resources.values()];
      const results = await session.availability.query(resources, range.start, range.end, request.controller.signal);
      assertCurrent();
      const latestAccess = await readAccess();
      assertResourceAccess(latestAccess);
      const latestSnapshot = await readEditor(context);
      assertCurrent();
      if (!sameInterval(interval, snapshotInterval(latestSnapshot))){
        cancelRequests(session);
        throw new DOMException("Resource interval changed", "AbortError");
      }
      L("resource availability ready", { count: results.length, lane });
      return { ok: true, interval, range, results, requestId };
    }finally{
      if (session.requests[lane] === request) delete session.requests[lane];
    }
  }

  function cancel(contextId, selectionToken, lane, requestId){
    const { session } = sessionFor(contextId, selectionToken);
    if (lane != null && lane !== "interval" && lane !== "day") throw pickerError("resource_invalid_selection");
    cancelRequests(session, lane, requestId);
    return { ok: true };
  }

  function close(contextId, selectionToken){
    const context = getCalendarWizardContext(contextId);
    const session = context && selections.get(context);
    if (session && (session.token === selectionToken || (session.loading && !selectionToken))){
      disposeSession(session);
      selections.delete(context);
    }
    return { ok: true };
  }

  function buildSelection(session, selectedEmails){
    if (!Array.isArray(selectedEmails) || selectedEmails.some((email) => typeof email !== "string")){
      throw pickerError("resource_invalid_selection");
    }
    const selected = new Set(selectedEmails.map((email) => email.toLowerCase()));
    if (selected.size !== selectedEmails.length
      || [...selected].some((email) => !session.resources.has(email))
      || [...selected].filter((email) => session.resources.get(email).kind === "ROOM").length > 1){
      throw pickerError("resource_invalid_selection");
    }
    const before = session.snapshot.attendees;
    const after = [];
    const retained = new Set();
    const previousRooms = [];
    for (const value of before){
      const attendee = attendeeRecord(value);
      const resource = session.resources.get(attendee.email);
      if (resource?.kind === "ROOM" && attendee.resource) previousRooms.push(resource);
      if (!resource || (!attendee.resource && !selected.has(attendee.email))){
        after.push(value);
        continue;
      }
      if (!selected.has(attendee.email) || retained.has(attendee.email)) continue;
      // Keep response status, delegations, and every unrelated participant parameter.
      if (attendee.kind === resource.kind){
        after.push(value);
      }else{
        attendee.property.setParameter("cutype", resource.kind);
        after.push(attendee.property.toICALString());
      }
      retained.add(attendee.email);
    }
    for (const email of selected){
      if (retained.has(email)) continue;
      const resource = session.resources.get(email);
      const property = new ICAL.Property("attendee");
      property.setValue(`mailto:${resource.email}`);
      property.setParameter("cn", resource.displayName);
      property.setParameter("cutype", resource.kind);
      property.setParameter("role", "REQ-PARTICIPANT");
      property.setParameter("partstat", "NEEDS-ACTION");
      after.push(property.toICALString());
    }
    const room = [...selected].map((email) => session.resources.get(email)).find((resource) => resource.kind === "ROOM");
    const location = session.snapshot.location || "";
    const fields = {};
    if (room?.location){
      fields.location = room.location;
    }else if (previousRooms.some((previous) => previous.email !== room?.email
      && previous.location && previous.location === location)){
      // Remove only the exact former room location; keep a manually edited location.
      fields.location = "";
    }
    return { fields, attendees: { before, after, beforeLocation: location,
      beforeCalendarId: session.snapshot.calendarId } };
  }

  async function apply(contextId, selectionToken, selectedEmails){
    const { context, session } = sessionFor(contextId, selectionToken);
    if (session.busy){
      throw pickerError("resource_context_expired");
    }
    assertAccount(session.revision);
    const update = buildSelection(session, selectedEmails);
    session.busy = true;
    try{
      const access = await readAccess();
      assertResourceAccess(access);
      sessionFor(contextId, selectionToken);
      if (contextFor(contextId) !== context || selections.get(context) !== session){
        throw pickerError("resource_context_expired");
      }
      // The bridge checks live attendees, calendar, and location atomically and rolls back failures.
      const snapshot = await browser.ncCalToolbar.updateCurrent({ editorId: context.editorId,
        ...update, returnFormat: "ical" });
      if (!snapshot) throw pickerError("resource_context_expired");
      disposeSession(session);
      selections.delete(context);
      mergeCalendarSnapshotIntoWizardContext(context, snapshot);
      L("resources applied to open draft", { selectedCount: selectedEmails.length });
      return { ok: true };
    }finally{
      session.busy = false;
    }
  }

  function errorResponse(error, fallbackKey){
    if (error?.name === "AbortError") return { ok: false, canceled: true };
    const code = error?.code || error?.ncResourceCode || "";
    const editorErrors = new Set(["resource_readonly", "resource_selection_changed", "resource_selection_invalid"]);
    const editorCode = editorErrors.has(error?.message) ? error.message : "";
    const translatedCode = editorCode === "resource_selection_invalid" ? "resource_invalid_selection" : editorCode;
    console.error("[NCBG] calendar resource operation failed", { code: code || editorCode || fallbackKey,
      status: Number(error?.status) || 0, reason: error?.ncResourceReason || "" });
    return { ok: false, error: error?.ncUserMessage || bgI18n(translatedCode || fallbackKey),
      code: code || translatedCode || fallbackKey, status: Number(error?.status) || 0,
      retryAt: Number(error?.retryAt) || 0 };
  }

  return { actionState, list, apply, currentInterval, availability, cancel, close, errorResponse };
})();
