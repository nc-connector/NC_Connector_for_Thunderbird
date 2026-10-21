/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/** Read CalDAV Free/Busy for one picker; retain only bounded, anonymous intervals */
(function(global){
  'use strict';

  const DAV = "DAV:";
  const CALDAV = "urn:ietf:params:xml:ns:caldav";
  const CACHE_MS = 2 * 60 * 1000;
  const BATCH_SIZE = 50;
  const MAX_PARALLEL = 2;

  function availabilityError(detail, status){
    const error = new Error(detail);
    error.ncResourceCode = "resource_availability_failed";
    if (status != null) error.status = status;
    return error;
  }

  function aborted(signal){
    if (signal?.aborted) throw new DOMException("Availability request canceled", "AbortError");
  }

  function forInterval(value, start, end){
    const periods = value.periods.filter((period) => period.start < end && period.end > start)
      .map((period) => ({ start: Math.max(start, period.start), end: Math.min(end, period.end) }));
    return { email: value.email, state: value.state === "unknown" ? "unknown" : periods.length ? "busy" : "free", start, end, periods };
  }

  function unknown(email, start, end){
    return { email, state: "unknown", start, end, periods: [] };
  }

  function davTarget(baseUrl, requestUrl, href, prefix = ""){
    if (!href || href.includes("\\") || /[\u0000-\u0020\u007f]/.test(href)
      || /%(?:2f|2e|25|5c)/i.test(href)) throw availabilityError("Invalid scheduling URL");
    const target = new URL(href, requestUrl);
    const root = new URL(`${baseUrl}/remote.php/dav/`);
    const path = decodeURIComponent(target.pathname);
    if (target.origin !== root.origin || target.username || target.password || target.search || target.hash
      || !target.pathname.startsWith(root.pathname + prefix) || /[\u0000-\u001f\u007f\\]/.test(path)){
      throw availabilityError("Scheduling URL escaped the configured DAV endpoint");
    }
    return target;
  }

  function readProperties(xml, url, account){
    const dav = global.NCCalendarResourceDirectory.dav;
    const responses = dav.children(dav.parseXml(xml, DAV, "multistatus"));
    if (responses.length !== 1 || responses[0].namespaceURI !== DAV || responses[0].localName !== "response"){
      throw availabilityError("Expected one scheduling principal response");
    }
    const target = davTarget(account.baseUrl, url, dav.text(dav.child(responses[0], DAV, "href")));
    if (target.pathname.replace(/\/$/, "") !== new URL(url).pathname.replace(/\/$/, "")){
      throw availabilityError("Scheduling principal response did not match the request");
    }
    return dav.successfulProperties(responses[0]);
  }

  function utcMillis(value, raw){
    if (!value || value.isDate || value.zone?.tzid !== "UTC" || typeof raw !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw)){
      throw availabilityError("Free/busy time is not UTC");
    }
    const result = value.toUnixTime() * 1000;
    if (!Number.isFinite(result) || new Date(result).toISOString().replace(".000Z", "Z") !== raw){
      throw availabilityError("Invalid free/busy time");
    }
    return result;
  }

  function oneProperty(component, name){
    const values = component.getAllProperties(name);
    if (values.length !== 1 || values[0].getValues().length !== 1){
      throw availabilityError("Missing or duplicate free/busy property");
    }
    return values[0];
  }

  function checkParameters(line){
    // ical.js keeps only the last duplicate parameter, which could turn BUSY into FREE.
    const names = new Set();
    let quoted = false;
    let start = 0;
    for (let index = 0; index < line.length; index++){
      const character = line[index];
      if (character === '"') quoted = !quoted;
      if (quoted || (character !== ";" && character !== ":")) continue;
      if (start){
        const parameter = line.slice(start, index);
        const equals = parameter.indexOf("=");
        const name = parameter.slice(0, equals).toLowerCase();
        if (equals <= 0 || names.has(name)) throw availabilityError("Invalid or duplicate free/busy parameter");
        names.add(name);
      }
      if (character === ":") return;
      start = index + 1;
    }
    throw availabilityError("Invalid free/busy content line");
  }

  async function parseFreeBusy(payload, email, start, end){
    const ICAL = global.NCIcalContract.ensureIcal();
    // ical.js tolerates extra/mismatched END markers; reject them before interpreting coverage.
    const boundaries = ["BEGIN:VCALENDAR", "BEGIN:VFREEBUSY", "END:VFREEBUSY", "END:VCALENDAR"];
    let boundary = 0;
    for (const line of payload.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)){
      if (!line) continue;
      const upper = line.toUpperCase();
      if (upper.startsWith("BEGIN:") || upper.startsWith("END:")){
        if (upper !== boundaries[boundary++]) throw availabilityError("Invalid free/busy component structure");
      }else if (boundary !== 1 && boundary !== 2 && boundary !== 3){
        throw availabilityError("Unexpected data outside free/busy calendar");
      }else checkParameters(line);
    }
    if (boundary !== 4) throw availabilityError("Incomplete free/busy calendar");
    const parsed = ICAL.parse(payload);
    const calendar = new ICAL.Component(parsed);
    const components = calendar.getAllSubcomponents();
    if (calendar.name !== "vcalendar" || components.length !== 1 || components[0].name !== "vfreebusy"
      || components[0].getAllSubcomponents().length || oneProperty(calendar, "version").getFirstValue() !== "2.0"){
      throw availabilityError("Unexpected free/busy calendar component");
    }
    if (["freebusy", "dtstart", "dtend", "dtstamp", "uid", "attendee"].some((name) => calendar.hasProperty(name))){
      throw availabilityError("Free/busy property is outside its component");
    }
    const component = components[0];
    const uid = oneProperty(component, "uid").getFirstValue();
    if (typeof uid !== "string" || !uid.trim()) throw availabilityError("Missing free/busy identity");
    const times = {};
    for (const name of ["dtstamp", "dtstart", "dtend"]){
      const prop = oneProperty(component, name);
      if (prop.type !== "date-time" || prop.getParameter("tzid")) throw availabilityError("Invalid free/busy time type");
      times[name] = utcMillis(prop.getFirstValue(), prop.toJSON()[3]);
    }
    const attendees = component.getAllProperties("attendee");
    if (attendees.length !== 1) throw availabilityError("Ambiguous free/busy attendee");
    const address = String(attendees[0].getFirstValue() || "");
    if (!address.toLowerCase().startsWith("mailto:")
      || await global.NCCalendarResourceDirectory.dav.normalizeEmail(address.slice(7)) !== email){
      throw availabilityError("Free/busy attendee did not match the requested resource");
    }
    if (times.dtend <= times.dtstart || times.dtstart > start || times.dtend < end){
      throw availabilityError("Free/busy coverage is incomplete");
    }
    if (["rrule", "rdate", "exdate"].some((name) => component.hasProperty(name))){
      throw availabilityError("Unexpected recurrence in free/busy calendar");
    }
    const periods = [];
    for (const prop of component.getAllProperties("freebusy")){
      const type = prop.getParameter("fbtype");
      if (prop.type !== "period" || prop.getParameter("tzid")
        || (type != null && (typeof type !== "string" || !/^[a-z0-9-]+$/i.test(type)))){
        throw availabilityError("Invalid free/busy period type");
      }
      const values = prop.getValues();
      const raw = prop.toJSON().slice(3);
      if (!values.length) throw availabilityError("Empty free/busy periods");
      for (let index = 0; index < values.length; index++){
        const value = values[index];
        const from = utcMillis(value.start, raw[index][0]);
        if (value.duration && (!/^P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/.test(raw[index][1])
          || raw[index][1].endsWith("T"))) throw availabilityError("Invalid free/busy duration");
        const to = value.duration ? from + value.duration.toSeconds() * 1000 : utcMillis(value.end, raw[index][1]);
        if (!Number.isFinite(to) || to <= from || !Number.isFinite(new Date(to).getTime())){
          throw availabilityError("Invalid free/busy period range");
        }
        // RFC 5545 3.2.9: absent or unknown FBTYPE is busy; explicit FREE is not.
        if (String(type || "").toUpperCase() !== "FREE" && from < end && to > start){
          periods.push({ start: Math.max(start, from), end: Math.min(end, to) });
        }
      }
    }
    periods.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const period of periods){
      const last = merged[merged.length - 1];
      if (last && period.start <= last.end) last.end = Math.max(last.end, period.end);
      else merged.push(period);
    }
    return { email, state: merged.length ? "busy" : "free", start, end, periods: merged };
  }

  async function parseSchedule(xml, emails, start, end){
    const dav = global.NCCalendarResourceDirectory.dav;
    const root = dav.parseXml(xml, CALDAV, "schedule-response");
    const responses = new Map();
    for (const response of dav.children(root)){
      const candidates = new Set();
      for (const recipient of dav.children(response).filter((node) => node.namespaceURI === CALDAV && node.localName === "recipient")){
        for (const href of dav.children(recipient).filter((node) => node.namespaceURI === DAV && node.localName === "href")){
          const address = dav.text(href);
          const email = address.toLowerCase().startsWith("mailto:") ? await dav.normalizeEmail(address.slice(7)) : "";
          if (email && emails.includes(email)) candidates.add(email);
        }
      }
      try{
        if (response.namespaceURI !== CALDAV || response.localName !== "response"){
          throw availabilityError("Unexpected scheduling response element");
        }
        const recipient = dav.child(response, CALDAV, "recipient");
        const href = dav.text(dav.child(recipient, DAV, "href"));
        if (!href.toLowerCase().startsWith("mailto:") || candidates.size !== 1){
          throw availabilityError("Unexpected scheduling recipient");
        }
        const email = [...candidates][0];
        responses.set(email, responses.has(email) ? null : response);
      }catch(error){
        // An ambiguous envelope invalidates its recipients, not unrelated batch entries.
        for (const email of candidates) responses.set(email, null);
        global.NCLogContext.safeConsoleError("[NCBG]", "resource scheduling recipient rejected", { name: error.name });
      }
    }
    const values = [];
    for (const email of emails){
      try{
        const response = responses.get(email);
        if (!response || dav.text(dav.child(response, CALDAV, "request-status")).split(";")[0].trim() !== "2.0"){
          throw availabilityError("Scheduling recipient response is missing or unsuccessful");
        }
        values.push(await parseFreeBusy(dav.text(dav.child(response, CALDAV, "calendar-data")), email, start, end));
      }catch(error){
        global.NCLogContext.safeConsoleError("[NCBG]", "resource free/busy response rejected", { name: error.name });
        values.push(unknown(email, start, end));
      }
    }
    return values;
  }

  function requestBody(originator, emails, start, end){
    const ICAL = global.NCIcalContract.ensureIcal();
    const calendar = new ICAL.Component(["vcalendar", [], []]);
    calendar.addPropertyWithValue("version", "2.0");
    calendar.addPropertyWithValue("prodid", "-//NC Connector//Availability//EN");
    calendar.addPropertyWithValue("method", "REQUEST");
    const busy = new ICAL.Component(["vfreebusy", [], []]);
    busy.addPropertyWithValue("uid", crypto.randomUUID());
    busy.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
    busy.addPropertyWithValue("dtstart", ICAL.Time.fromJSDate(new Date(start), true));
    busy.addPropertyWithValue("dtend", ICAL.Time.fromJSDate(new Date(end), true));
    busy.addPropertyWithValue("organizer", `mailto:${originator}`);
    for (const email of emails) busy.addPropertyWithValue("attendee", `mailto:${email}`);
    calendar.addSubcomponent(busy);
    return calendar.toString() + "\r\n";
  }

  function createSession(options){
    const account = { baseUrl: NCCore.normalizeBaseUrl(options?.baseUrl), user: options?.user, appPass: options?.appPass };
    if (!account.baseUrl || !account.user || !account.appPass) throw availabilityError("Nextcloud credentials are incomplete");
    const dav = global.NCCalendarResourceDirectory.dav;
    const authHeader = NCOcs.buildAuthHeader(account.user, account.appPass);
    const cache = new Map();
    const queries = new Set();
    const queue = [];
    let active = 0;
    let identity = null;
    let sequence = 0;
    let disposed = false;

    async function checkAccount(signal){
      aborted(signal);
      const current = await NCCore.getOpts();
      if (current.baseUrl !== account.baseUrl || current.user !== account.user || current.appPass !== account.appPass){
        throw availabilityError("Nextcloud account changed during availability query");
      }
      await NCCore.assertAuthenticationAllowed(account.baseUrl, authHeader, false);
      aborted(signal);
    }

    function requirePermission(){
      return NCHostPermissions.requireOriginPermission(account.baseUrl, { errorFactory: () => {
        const error = new Error(bgI18n("error_host_permission_missing"));
        error.code = "host_permission_missing";
        error.ncUserMessage = error.message;
        return error;
      } });
    }

    function drain(){
      while (active < MAX_PARALLEL && queue.length){
        const entry = queue.shift();
        entry.signal.removeEventListener("abort", entry.onAbort);
        active++;
        Promise.resolve().then(entry.run).then(entry.resolve, entry.reject).finally(() => { active--; drain(); });
      }
    }

    function scheduled(run, signal){
      aborted(signal);
      return new Promise((resolve, reject) => {
        const entry = { run, signal, resolve, reject, onAbort: null };
        entry.onAbort = () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          reject(new DOMException("Availability request canceled", "AbortError"));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
        queue.push(entry);
        drain();
      });
    }

    async function request(url, method, body, signal, headers = {}){
      return scheduled(async () => {
        await checkAccount(signal);
        await requirePermission();
        return NCOcs.runWithTimeout(async (requestSignal) => {
          aborted(requestSignal);
          const response = await NCCore.runAuthenticatedRequest({ url, authHeader, request: () => fetch(url, {
            method, body, signal: requestSignal, credentials: "omit", redirect: "error", cache: "no-store",
            headers: { Authorization: authHeader, Depth: "0", Accept: "application/xml",
              "Content-Type": method === "POST" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8", ...headers }
          }) });
          if (method === "PROPFIND" ? response.status !== 207 : response.status < 200 || response.status >= 300){
            await response.body?.cancel();
            throw availabilityError("CalDAV availability request failed", response.status);
          }
          const xml = await dav.readResponse(response);
          await checkAccount(requestSignal);
          return xml;
        }, { signal, timeoutMs: 30000 });
      }, signal);
    }

    async function discover(signal){
      if (identity) return identity;
      const root = `${account.baseUrl}/remote.php/dav/`;
      const propfind = (props) => `<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop>${props}</d:prop></d:propfind>`;
      const current = readProperties(await request(root, "PROPFIND", propfind("<d:current-user-principal/>"), signal), root, account);
      const principal = davTarget(account.baseUrl, root,
        dav.text(dav.child(dav.property(current, DAV, "current-user-principal"), DAV, "href")), "principals/users/");
      const relativePrincipal = principal.pathname.slice(new URL(root).pathname.length + "principals/users/".length).replace(/\/$/, "");
      if (!relativePrincipal || relativePrincipal.includes("/")) throw availabilityError("Invalid scheduling principal path");
      const props = readProperties(await request(principal.href, "PROPFIND",
        propfind("<c:calendar-user-address-set/><c:schedule-outbox-URL/>"), signal), principal.href, account);
      let originator = "";
      for (const href of dav.children(dav.property(props, CALDAV, "calendar-user-address-set"))){
        const value = dav.text(href);
        if (href.namespaceURI === DAV && href.localName === "href" && value.toLowerCase().startsWith("mailto:")){
          originator = await dav.normalizeEmail(value.slice(7));
          if (originator) break;
        }
      }
      if (!originator) throw availabilityError("Scheduling principal has no usable address");
      const outbox = davTarget(account.baseUrl, principal.href,
        dav.text(dav.child(dav.property(props, CALDAV, "schedule-outbox-URL"), DAV, "href")), "calendars/");
      const relativeOutbox = outbox.pathname.slice(new URL(root).pathname.length + "calendars/".length).replace(/\/$/, "").split("/");
      if (relativeOutbox.length !== 2 || !relativeOutbox[0] || relativeOutbox[1] !== "outbox"){
        throw availabilityError("Invalid scheduling outbox path");
      }
      aborted(signal);
      identity = { originator, outbox: outbox.href };
      return identity;
    }

    async function query(resources, start, end, signal){
      if (disposed) throw new DOMException("Availability session closed", "AbortError");
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
        || !Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(end).getTime())){
        throw availabilityError("A positive UTC interval is required");
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      queries.add(controller);
      const currentSequence = ++sequence;
      try{
        await checkAccount(controller.signal);
        await requirePermission();
        const emails = [];
        for (const resource of resources){
          if (resource?.selectable === false) continue;
          const email = await dav.normalizeEmail(resource?.email);
          if (!email) continue;
          if (!emails.includes(email)) emails.push(email);
        }
        const results = new Map();
        const missing = [];
        for (const email of emails){
          const cached = cache.get(email);
          if (cached && cached.expires > Date.now() && cached.value.start <= start && cached.value.end >= end){
            results.set(email, forInterval(cached.value, start, end));
          }else missing.push(email);
        }
        if (missing.length){
          const scheduling = await discover(controller.signal);
          const requestStart = Math.floor(start / 1000) * 1000;
          const requestEnd = Math.ceil(end / 1000) * 1000;
          const batches = [];
          for (let offset = 0; offset < missing.length; offset += BATCH_SIZE){
            const batch = missing.slice(offset, offset + BATCH_SIZE);
            batches.push((async () => {
              let values;
              try{
                const xml = await request(scheduling.outbox, "POST",
                  requestBody(scheduling.originator, batch, requestStart, requestEnd), controller.signal,
                  { Originator: `mailto:${scheduling.originator}`, Recipient: batch.map((email) => `mailto:${email}`).join(", ") });
                values = await parseSchedule(xml, batch, requestStart, requestEnd);
              }catch(error){
                aborted(controller.signal);
                if (NCCore.isConnectionPausedError(error) || error.code === "host_permission_missing") throw error;
                global.NCLogContext.safeConsoleError("[NCBG]", "resource availability batch failed", { name: error.name, status: error.status });
                values = batch.map((email) => unknown(email, requestStart, requestEnd));
              }
              aborted(controller.signal);
              for (const value of values){
                if (!cache.has(value.email) || cache.get(value.email).sequence <= currentSequence){
                  cache.set(value.email, { value, sequence: currentSequence, expires: value.state === "unknown" ? 0 : Date.now() + CACHE_MS });
                }
                results.set(value.email, forInterval(value, start, end));
              }
            })());
          }
          await Promise.all(batches);
        }
        await checkAccount(controller.signal);
        await requirePermission();
        aborted(controller.signal);
        if (typeof L === "function") L("resource availability completed", { count: emails.length, queried: missing.length });
        return emails.map((email) => results.get(email));
      }catch(error){
        aborted(controller.signal);
        global.NCLogContext.safeConsoleError("[NCBG]", "resource availability query failed", { name: error.name, status: error.status });
        if (NCCore.isConnectionPausedError(error) || error.code === "host_permission_missing") throw error;
        throw availabilityError("Resource availability could not be retrieved", error.status);
      }finally{
        controller.abort();
        queries.delete(controller);
        signal?.removeEventListener("abort", onAbort);
      }
    }

    return Object.freeze({ query, dispose(){
      disposed = true;
      for (const controller of queries) controller.abort();
      cache.clear();
      identity = null;
    } });
  }

  global.NCCalendarResourceAvailability = Object.freeze({ createSession });
})(typeof window !== "undefined" ? window : globalThis);
