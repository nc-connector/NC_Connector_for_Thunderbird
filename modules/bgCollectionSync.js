/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Registers the user's Nextcloud calendars and address books as regular
 * Thunderbird CalDAV/CardDAV collections; content sync stays with Thunderbird.
 */
const NCCollectionSync = (() => {
  const STATE_KEY = "ncCollectionSyncStateV1";
  const SYNC_INTERVAL_MS = 15 * 60 * 1000;
  const STARTUP_DELAY_MS = 20 * 1000;
  const NS_DAV = "DAV:";
  const NS_CALDAV = "urn:ietf:params:xml:ns:caldav";
  const NS_CARDDAV = "urn:ietf:params:xml:ns:carddav";
  const NS_CALSERVER = "http://calendarserver.org/ns/";
  const NS_APPLE = "http://apple.com/ns/ical/";
  // Generated from mail history; only duplicates other contacts.
  const SKIPPED_ADDRESS_BOOKS = new Set(["z-app-generated--contactsinteraction--recent"]);

  const KINDS = Object.freeze({
    calendars: Object.freeze({
      enabledKey: "calendarSyncEnabled",
      homePath: (userId) => `/remote.php/dav/calendars/${encodeURIComponent(userId)}/`,
      propfind: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <a:calendar-color/>
    <c:supported-calendar-component-set/>
    <d:current-user-privilege-set/>
  </d:prop>
</d:propfind>`,
      parse: (xmlText) => parseCalendarHome(xmlText),
      async snapshot(){
        const calendars = await browser.calendar.calendars.query({ type: "caldav" });
        return {
          ids: new Set(calendars.map((calendar) => calendar.id)),
          urls: new Set(calendars.map((calendar) => withSlash(calendar.url)))
        };
      },
      create: (entry, url, username) => browser.ncDavCollections.createCalendar({
        url,
        name: entry.name,
        username,
        color: entry.color || undefined,
        readOnly: entry.readOnly
      }),
      remove: (id) => browser.calendar.calendars.remove(id),
      async applyServerChanges(id, known, entry){
        const changes = {};
        if (known.name !== entry.name) changes.name = entry.name;
        if (known.color !== entry.color && entry.color) changes.color = entry.color;
        if (Object.keys(changes).length){
          await browser.calendar.calendars.update(id, changes);
        }
      }
    }),
    addressBooks: Object.freeze({
      enabledKey: "addressBookSyncEnabled",
      homePath: (userId) => `/remote.php/dav/addressbooks/users/${encodeURIComponent(userId)}/`,
      propfind: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
  </d:prop>
</d:propfind>`,
      parse: (xmlText) => parseAddressBookHome(xmlText),
      async snapshot(){
        const books = await browser.ncDavCollections.listAddressBooks();
        return {
          ids: new Set(books.map((book) => book.id)),
          urls: new Set(books.map((book) => withSlash(book.url)))
        };
      },
      create: (entry, url, username) => browser.ncDavCollections.createAddressBook({
        url,
        name: entry.name,
        username,
        readOnly: entry.readOnly
      }),
      remove: (id) => browser.ncDavCollections.removeAddressBook(id),
      async applyServerChanges(id, known, entry){
        if (known.name !== entry.name){
          await browser.ncDavCollections.renameAddressBook(id, entry.name);
        }
      }
    })
  });

  let inflight = null;
  let timer = null;

  function withSlash(url){
    return String(url || "").replace(/\/?$/, "/");
  }

  function isPlainObject(value){
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  async function readState(){
    const stored = await browser.storage.local.get(STATE_KEY);
    const raw = isPlainObject(stored[STATE_KEY]) ? stored[STATE_KEY] : {};
    const state = {
      account: typeof raw.account === "string" ? raw.account : "",
      lastRun: isPlainObject(raw.lastRun) ? raw.lastRun : null
    };
    for (const kindName of Object.keys(KINDS)){
      const kindState = isPlainObject(raw[kindName]) ? raw[kindName] : {};
      state[kindName] = {
        managed: isPlainObject(kindState.managed) ? kindState.managed : {},
        dismissed: Array.isArray(kindState.dismissed)
          ? kindState.dismissed.filter((href) => typeof href === "string")
          : []
      };
    }
    return state;
  }

  async function writeState(state){
    await browser.storage.local.set({ [STATE_KEY]: state });
  }

  async function readEnabled(){
    const stored = await browser.storage.local.get(Object.values(KINDS).map((kind) => kind.enabledKey));
    return Object.fromEntries(Object.entries(KINDS).map(([kindName, kind]) => [kindName, stored[kind.enabledKey] !== false]));
  }

  function isAvailable(){
    return !!browser?.ncDavCollections?.createCalendar && !!browser?.calendar?.calendars?.query;
  }

  function normalizeColor(value){
    const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(value || "").trim());
    return match ? "#" + match[1].toLowerCase() : "";
  }

  function childrenNS(parent, ns, localName){
    return parent ? Array.from(parent.getElementsByTagNameNS(ns, localName)) : [];
  }

  function firstNS(parent, ns, localName){
    return childrenNS(parent, ns, localName)[0] || null;
  }

  function lastSegment(href){
    return decodeURIComponent(href.replace(/\/+$/, "").split("/").pop() || "");
  }

  function okProp(response){
    for (const propstat of childrenNS(response, NS_DAV, "propstat")){
      const statusText = firstNS(propstat, NS_DAV, "status")?.textContent || "";
      if (/\s200\s/.test(statusText + " ")){
        return firstNS(propstat, NS_DAV, "prop");
      }
    }
    return null;
  }

  function parseCollections(xmlText, typeNs, typeName){
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length){
      throw new Error("Invalid collection list response");
    }
    const collections = [];
    for (const response of childrenNS(doc, NS_DAV, "response")){
      const href = (firstNS(response, NS_DAV, "href")?.textContent || "").trim();
      const prop = okProp(response);
      const resourcetype = firstNS(prop, NS_DAV, "resourcetype");
      if (!href || !resourcetype || !firstNS(resourcetype, typeNs, typeName)){
        continue;
      }
      const privileges = firstNS(prop, NS_DAV, "current-user-privilege-set");
      const canWrite = !privileges
        || !!firstNS(privileges, NS_DAV, "write")
        || !!firstNS(privileges, NS_DAV, "write-content")
        || !!firstNS(privileges, NS_DAV, "all");
      const name = (firstNS(prop, NS_DAV, "displayname")?.textContent || "").trim() || lastSegment(href);
      collections.push({ href: withSlash(href), name, readOnly: !canWrite, prop, resourcetype });
    }
    return collections;
  }

  function parseCalendarHome(xmlText){
    return parseCollections(xmlText, NS_CALDAV, "calendar")
      .filter(({ resourcetype, prop }) => {
        if (firstNS(resourcetype, NS_CALSERVER, "subscribed")){
          return false;
        }
        const components = childrenNS(firstNS(prop, NS_CALDAV, "supported-calendar-component-set"), NS_CALDAV, "comp")
          .map((comp) => String(comp.getAttribute("name") || "").toUpperCase());
        return !components.length || components.includes("VEVENT") || components.includes("VTODO");
      })
      .map(({ href, name, readOnly, prop }) => ({
        href,
        name,
        readOnly,
        color: normalizeColor(firstNS(prop, NS_APPLE, "calendar-color")?.textContent)
      }));
  }

  function parseAddressBookHome(xmlText){
    return parseCollections(xmlText, NS_CARDDAV, "addressbook")
      .filter(({ href }) => !SKIPPED_ADDRESS_BOOKS.has(lastSegment(href)))
      .map(({ href, name, readOnly }) => ({ href, name, readOnly }));
  }

  // Nextcloud uses its theming name as Basic realm; Thunderbird's DAV providers
  // look up the stored login by origin and that realm.
  async function resolveAuthRealm(opts){
    const snapshot = await NCCore.getCapabilitiesSnapshot(opts);
    const name = snapshot?.capabilities?.theming?.name;
    return typeof name === "string" && name.trim() ? name.trim() : "Nextcloud";
  }

  async function fetchServerCollections(kind, opts, userId){
    const homeUrl = opts.baseUrl + kind.homePath(userId);
    const authHeader = NCOcs.buildAuthHeader(opts.user, opts.appPass);
    const response = await NCNextcloudDav.fetchWithTimeout({
      request: (signal) => NCCore.runAuthenticatedRequest({
        url: homeUrl,
        authHeader,
        request: () => fetch(homeUrl, {
          method: "PROPFIND",
          credentials: "omit",
          headers: {
            "Authorization": authHeader,
            "Depth": "1",
            "Content-Type": "application/xml; charset=utf-8"
          },
          body: kind.propfind,
          signal
        })
      })
    });
    const text = await NCNextcloudDav.readResponseText(response);
    if (response.status !== 207){
      const error = new Error(`Collection list failed: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return kind.parse(text);
  }

  async function removeManaged(kind, managed){
    const { ids } = await kind.snapshot();
    for (const entry of Object.values(managed)){
      if (entry?.id && ids.has(entry.id)){
        await kind.remove(entry.id);
      }
    }
  }

  async function syncKind(kind, kindState, serverEntries, { origin, username }){
    const { managed } = kindState;
    const dismissed = new Set(kindState.dismissed);
    const serverHrefs = new Set(serverEntries.map((entry) => entry.href));
    const local = await kind.snapshot();

    // A managed collection missing locally was removed by the user.
    for (const [href, entry] of Object.entries(managed)){
      if (!entry?.id || !local.ids.has(entry.id)){
        delete managed[href];
        dismissed.add(href);
      }
    }

    let removed = 0;
    // An empty home is more likely a server problem than a real state.
    if (serverEntries.length){
      for (const [href, entry] of Object.entries(managed)){
        if (!serverHrefs.has(href)){
          await kind.remove(entry.id);
          delete managed[href];
          removed++;
        }
      }
      for (const href of dismissed){
        if (!serverHrefs.has(href)) dismissed.delete(href);
      }
    }
    kindState.dismissed = [...dismissed];

    let created = 0;
    for (const entry of serverEntries){
      const known = managed[entry.href];
      const color = entry.color || "";
      if (known){
        if (known.name !== entry.name || known.color !== color){
          await kind.applyServerChanges(known.id, known, entry);
          known.name = entry.name;
          known.color = color;
        }
        continue;
      }
      if (dismissed.has(entry.href) || local.urls.has(origin + entry.href)){
        continue;
      }
      const id = await kind.create(entry, origin + entry.href, username);
      managed[entry.href] = { id, name: entry.name, color };
      created++;
    }

    return { total: Object.keys(managed).length, created, removed };
  }

  async function runSync(reason){
    if (!isAvailable()){
      return { skipped: "unavailable" };
    }
    const enabled = await readEnabled();
    if (!Object.values(enabled).some(Boolean)){
      return { skipped: "disabled" };
    }
    const opts = await NCCore.getOpts();
    if (!opts.baseUrl || !opts.user || !opts.appPass){
      return { skipped: "no_credentials" };
    }
    if ((await NCCore.getConnectionState()).reason){
      return { skipped: "connection_paused" };
    }
    if (!await NCHostPermissions.hasOriginPermission(opts.baseUrl)){
      throw new Error(bgI18n("error_host_permission_missing"));
    }

    const userId = await NCCore.getCurrentUserId(opts);
    const origin = new URL(opts.baseUrl).origin;
    const account = JSON.stringify([opts.baseUrl, userId]);
    const state = await readState();
    if (state.account && state.account !== account){
      L("collection sync account changed; removing managed collections");
      for (const [kindName, kind] of Object.entries(KINDS)){
        await removeManaged(kind, state[kindName].managed);
        state[kindName] = { managed: {}, dismissed: [] };
      }
    }
    state.account = account;

    // Every pass, so a new app password reaches existing collections.
    await browser.ncDavCollections.saveLogin({
      origin,
      realm: await resolveAuthRealm(opts),
      username: opts.user,
      password: opts.appPass
    });

    const result = {};
    try{
      for (const [kindName, kind] of Object.entries(KINDS)){
        if (!enabled[kindName]){
          result[kindName] = null;
          continue;
        }
        const serverEntries = await fetchServerCollections(kind, opts, userId);
        result[kindName] = await syncKind(kind, state[kindName], serverEntries, { origin, username: opts.user });
      }
      state.lastRun = { at: Date.now(), ok: true, error: "", ...result };
    }catch(error){
      state.lastRun = { ...state.lastRun, at: Date.now(), ok: false, error: error?.message || String(error) };
      throw error;
    }finally{
      await writeState(state);
    }
    L("collection sync finished", { reason, ...result });
    return result;
  }

  function syncNow(reason = "manual"){
    if (!inflight){
      inflight = runSync(reason)
        .catch((error) => {
          console.error("[NCBG] collection sync failed", error);
          throw error;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  function syncInBackground(reason){
    syncNow(reason).catch(() => {});
  }

  async function restoreDismissed(){
    const state = await readState();
    for (const kindName of Object.keys(KINDS)){
      state[kindName].dismissed = [];
    }
    await writeState(state);
    return syncNow("restore");
  }

  // Thunderbird disables CalDAV calendars after 4xx answers and re-enables
  // them on its next start.
  async function countDisabledCalendars(managed){
    if (!isAvailable()){
      return 0;
    }
    const ids = new Set(Object.values(managed).map((entry) => entry?.id).filter(Boolean));
    const disabled = await browser.calendar.calendars.query({ type: "caldav", enabled: false });
    return disabled.filter((calendar) => ids.has(calendar.id)).length;
  }

  async function getStatus(){
    const state = await readState();
    const { baseUrl } = await NCCore.getOpts();
    const enabled = await readEnabled();
    return {
      baseUrl,
      available: isAvailable(),
      calendarsEnabled: enabled.calendars,
      addressBooksEnabled: enabled.addressBooks,
      dismissed: Object.keys(KINDS).reduce((sum, kindName) => sum + state[kindName].dismissed.length, 0),
      managed: Object.fromEntries(Object.keys(KINDS).map((kindName) => [kindName, Object.keys(state[kindName].managed).length])),
      disabledCalendars: await countDisabledCalendars(state.calendars.managed),
      lastRun: state.lastRun
    };
  }

  function start(){
    if (timer || !isAvailable()){
      return;
    }
    setTimeout(() => syncInBackground("startup"), STARTUP_DELAY_MS);
    timer = setInterval(() => syncInBackground("interval"), SYNC_INTERVAL_MS);
    NCCore.onConnectionRestored.addListener(() => syncInBackground("connection"));
  }

  start();

  return { syncNow, restoreDismissed, getStatus };
})();
