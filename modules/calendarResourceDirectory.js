/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/** Read the permission-filtered room and resource principals without booking them */
(function(global){
  'use strict';

  const DAV = "DAV:";
  const CALDAV = "urn:ietf:params:xml:ns:caldav";
  const NEXTCLOUD = "http://nextcloud.com/ns";
  const SABRE = "http://sabredav.org/ns";
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const SEARCH_BODY = '<d:principal-property-search xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:n="http://nextcloud.com/ns" xmlns:s="http://sabredav.org/ns">'
    + '<d:property-search><d:prop><s:email-address/></d:prop><d:match>@</d:match></d:property-search><d:prop>'
    + '<d:displayname/><c:calendar-user-type/><c:calendar-user-address-set/><s:email-address/>'
    + '<n:resource-type/><n:room-type/><n:room-seating-capacity/><n:room-building-name/>'
    + '<n:room-building-address/><n:room-building-story/><n:room-building-room-number/><n:room-features/>'
    + '</d:prop></d:principal-property-search>';

  function directoryError(detail, status){
    const error = new Error(detail);
    error.ncResourceCode = "resource_load_failed";
    if (status != null) error.status = status;
    return error;
  }

  function children(node){
    return Array.from(node?.childNodes || []).filter((entry) => entry.nodeType === 1);
  }

  function child(node, namespace, name){
    const matches = children(node).filter((entry) => entry.namespaceURI === namespace && entry.localName === name);
    if (matches.length > 1) throw directoryError("Duplicate DAV element");
    return matches[0] || null;
  }

  function text(node){
    return String(node?.textContent || "").trim();
  }

  function statusCode(value){
    const match = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/.exec(value);
    return match ? Number(match[1]) : 0;
  }

  function successfulProperties(response){
    const result = new Map();
    const responseStatus = text(child(response, DAV, "status"));
    const responseCode = statusCode(responseStatus);
    if (responseStatus && (responseCode < 200 || responseCode >= 300)){
      throw directoryError("DAV principal request was rejected");
    }
    let successful = false;
    for (const propstat of children(response).filter((entry) => entry.namespaceURI === DAV && entry.localName === "propstat")){
      const code = statusCode(text(child(propstat, DAV, "status")));
      // Missing optional properties are normal for native resources and RoomVox.
      if (code === 404) continue;
      if (code < 200 || code >= 300) throw directoryError("DAV principal properties were rejected");
      const prop = child(propstat, DAV, "prop");
      if (!prop) throw directoryError("Missing DAV properties");
      successful = true;
      for (const entry of children(prop)){
        const key = `${entry.namespaceURI}\n${entry.localName}`;
        if (result.has(key)) throw directoryError("Duplicate DAV property");
        result.set(key, entry);
      }
    }
    if (!successful) throw directoryError("No successful DAV properties");
    return result;
  }

  function property(properties, namespace, name){
    return properties.get(`${namespace}\n${name}`) || null;
  }

  function principalPath(requestUrl, href){
    if (!href || href.includes("\\") || /[\u0000-\u0020\u007f]/.test(href)
      || /%(?:2f|2e|25|5c)/i.test(href)){
      throw directoryError("Invalid resource principal URL");
    }
    let target;
    try{
      target = new URL(href, requestUrl);
      if (/[\u0000-\u001f\u007f\\]/.test(decodeURIComponent(target.pathname))){
        throw directoryError("Invalid resource principal URL");
      }
    }catch(error){
      throw directoryError("Invalid resource principal URL");
    }
    const collection = new URL(requestUrl);
    if (target.origin !== collection.origin || target.username || target.password || target.search || target.hash
      || !target.pathname.startsWith(collection.pathname)){
      throw directoryError("Resource principal escaped its collection");
    }
    const remainder = target.pathname.slice(collection.pathname.length).replace(/\/$/, "");
    if (!remainder || remainder.includes("/")) throw directoryError("Invalid resource principal path");
    return target.pathname.replace(/\/$/, "");
  }

  async function normalizeEmail(value){
    const address = String(value || "").trim();
    if (!address || address.indexOf("@") <= 0 || /[\s\u0000-\u001f\u007f;,<>"?]/.test(address)) return "";
    const mailboxes = await browser.messengerUtilities.parseMailboxString(address);
    if (!Array.isArray(mailboxes) || mailboxes.length !== 1 || mailboxes[0].name
      || mailboxes[0].email !== address) return "";
    return address.toLowerCase();
  }

  async function emailAddress(properties){
    const addresses = property(properties, CALDAV, "calendar-user-address-set");
    for (const href of children(addresses)){
      if (href.namespaceURI !== DAV || href.localName !== "href") continue;
      const value = text(href);
      if (value.toLowerCase().startsWith("mailto:")){
        const email = await normalizeEmail(value.slice(7));
        if (email) return email;
      }
    }
    return normalizeEmail(text(property(properties, SABRE, "email-address")));
  }

  function parseXml(xml, namespace, name){
    if (!xml.trim() || xml.length > MAX_RESPONSE_BYTES || /<!DOCTYPE/i.test(xml)){
      throw directoryError("Invalid DAV XML response");
    }
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const root = document.documentElement;
    if (document.doctype || document.getElementsByTagNameNS("*", "parsererror").length
      || root?.namespaceURI !== namespace || root.localName !== name){
      throw directoryError("Invalid DAV response root");
    }
    return root;
  }

  async function parseCollection(xml, requestUrl, kind){
    const root = parseXml(xml, DAV, "multistatus");
    const resources = [];
    const paths = new Set();
    for (const response of children(root)){
      if (response.namespaceURI !== DAV || response.localName !== "response"){
        throw directoryError("Unexpected DAV multistatus element");
      }
      const path = principalPath(requestUrl, text(child(response, DAV, "href")));
      if (paths.has(path)) throw directoryError("Duplicate resource principal");
      paths.add(path);
      const properties = successfulProperties(response);
      const read = (namespace, name) => text(property(properties, namespace, name));
      if (read(CALDAV, "calendar-user-type") !== kind) throw directoryError("Unexpected resource principal kind");
      const email = await emailAddress(properties);
      if (!email) throw directoryError("Resource principal has no usable email address");
      const capacityText = read(NEXTCLOUD, "room-seating-capacity");
      const capacity = /^\d+$/.test(capacityText) ? Number(capacityText) : null;
      const resource = {
        principalPath: path,
        displayName: read(DAV, "displayname"),
        email,
        kind,
        resourceType: read(NEXTCLOUD, "resource-type"),
        roomType: read(NEXTCLOUD, "room-type"),
        capacity: Number.isSafeInteger(capacity) && capacity <= 2147483647 ? capacity : null,
        buildingName: read(NEXTCLOUD, "room-building-name"),
        buildingAddress: read(NEXTCLOUD, "room-building-address"),
        floor: read(NEXTCLOUD, "room-building-story"),
        roomNumber: read(NEXTCLOUD, "room-building-room-number"),
        features: read(NEXTCLOUD, "room-features")
      };
      resource.location = [resource.roomNumber, resource.floor, resource.buildingAddress].filter(Boolean).join(", ");
      resources.push(resource);
    }
    return resources;
  }

  async function readResponse(response){
    const length = Number(response.headers.get("Content-Length"));
    if (length > MAX_RESPONSE_BYTES){
      await response.body?.cancel();
      throw directoryError("DAV response exceeds size limit");
    }
    if (!response.body) throw directoryError("Empty DAV response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let result = "";
    let complete = false;
    try{
      while (true){
        const chunk = await reader.read();
        if (chunk.done){
          complete = true;
          break;
        }
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES){
          throw directoryError("DAV response exceeds size limit");
        }
        result += decoder.decode(chunk.value, { stream: true });
      }
      return result + decoder.decode();
    }finally{
      if (!complete){
        await reader.cancel().catch((error) => {
          global.NCLogContext.safeConsoleError("[NCBG]", "resource response cancellation failed", error);
        });
      }
      reader.releaseLock();
    }
  }

  async function readCollection(options, collection, kind){
    const url = `${options.baseUrl}/remote.php/dav/principals/${collection}/`;
    const authHeader = NCOcs.buildAuthHeader(options.user, options.appPass);
    const xml = await NCOcs.runWithTimeout(async (signal) => {
      const response = await NCCore.runAuthenticatedRequest({
        url,
        authHeader,
        request: () => fetch(url, {
          method: "REPORT",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          headers: { Authorization: authHeader, Depth: "0", Accept: "application/xml", "Content-Type": "application/xml; charset=utf-8" },
          // Unlike depth-one enumeration, email search applies Nextcloud's group restrictions.
          body: SEARCH_BODY,
          signal
        })
      });
      if (response.status !== 207){
        await response.body?.cancel();
        throw directoryError("DAV resource request failed", response.status);
      }
      return readResponse(response);
    });
    const resources = await parseCollection(xml, url, kind);
    if (typeof L === "function") L("resource directory collection read", { kind, count: resources.length });
    return resources;
  }

  async function list(options){
    const current = options || await NCCore.getOpts();
    const baseUrl = NCCore.normalizeBaseUrl(current.baseUrl);
    if (!baseUrl || !current.user || !current.appPass) throw directoryError("Nextcloud credentials are incomplete");
    const account = { ...current, baseUrl };
    await NCHostPermissions.requireOriginPermission(baseUrl, { message: bgI18n("error_host_permission_missing") });
    await NCCore.getRequiredCapabilities(account);
    const resources = await readCollection(account, "calendar-rooms", "ROOM");
    resources.push(...await readCollection(account, "calendar-resources", "RESOURCE"));
    const emails = new Set();
    for (const resource of resources){
      if (emails.has(resource.email)) throw directoryError("Ambiguous resource email address");
      emails.add(resource.email);
    }
    // A completed read cannot return another account's directory after Settings changed.
    const latest = await NCCore.getOpts();
    if (latest.baseUrl !== account.baseUrl || latest.user !== account.user || latest.appPass !== account.appPass){
      throw directoryError("Nextcloud account changed during resource discovery");
    }
    if (typeof L === "function") L("resource directory refreshed", { count: resources.length });
    return resources;
  }

  global.NCCalendarResourceDirectory = Object.freeze({
    list,
    dav: Object.freeze({ children, child, text, successfulProperties, property, normalizeEmail, parseXml, readResponse })
  });
})(typeof window !== "undefined" ? window : globalThis);
