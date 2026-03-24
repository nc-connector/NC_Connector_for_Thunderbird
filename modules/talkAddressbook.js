/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Talk system-addressbook module.
 * Owns CardDAV fetch/parsing, cache, and search/status helpers used by Talk.
 */

/**
 * Cache for system addressbook entries to limit CardDAV traffic.
 * Structure:
 * {
 *   contacts: Array<Contact>,
 *   fetchedAt: number,
 *   forceFetchedAt: number,
 *   baseUrl: string,
 *   user: string
 * }
 */
const SYSTEM_ADDRESSBOOK_CACHE = {
  contacts: [],
  fetchedAt: 0,
  forceFetchedAt: 0,
  baseUrl: "",
  user: ""
};
const SYSTEM_ADDRESSBOOK_TTL = 5 * 60 * 1000;
const SYSTEM_ADDRESSBOOK_FORCE_MIN_INTERVAL_MS = 10 * 1000;

/**
 * Resolve shared iCal/vCard parser contract API for Talk module.
 * @returns {object|null}
 */
function getTalkIcalContractApi(){
  if (
    typeof NCIcalContract === "undefined" ||
    !NCIcalContract ||
    typeof NCIcalContract.parseVcardComponents !== "function" ||
    typeof NCIcalContract.stringifyValue !== "function"
  ){
    console.error("[NCTalk] NCIcalContract API missing");
    return null;
  }
  return NCIcalContract;
}

/**
 * Build a normalized parameter map from one parsed vCard property.
 * @param {object} prop
 * @param {object} contract
 * @returns {Record<string,string>}
 */
function getVcardPropertyParams(prop, contract){
  const params = {};
  const raw = prop?.jCal?.[1] && typeof prop.jCal[1] === "object" ? prop.jCal[1] : {};
  for (const [key, value] of Object.entries(raw)){
    const normalized = String(key || "").toUpperCase();
    if (!normalized){
      continue;
    }
    if (Array.isArray(value)){
      params[normalized] = value.map((entry) => contract.stringifyValue(entry)).join(",");
    } else {
      params[normalized] = contract.stringifyValue(value);
    }
  }
  return params;
}

/**
 * Read first text-like property value from a vCard component.
 * @param {object} card
 * @param {string} propertyName
 * @param {object} contract
 * @returns {string}
 */
function readVcardTextProperty(card, propertyName, contract){
  const prop = card?.getFirstProperty(propertyName);
  if (!prop){
    return "";
  }
  return String(contract.stringifyValue(prop.getFirstValue()) || "").trim();
}

/**
 * Build label from N property payload when FN is missing.
 * @param {any} value
 * @returns {string}
 */
function buildLabelFromVcardName(value){
  if (Array.isArray(value)){
    const family = String(value[0] || "").trim();
    const given = String(value[1] || "").trim();
    const additional = String(value[2] || "").trim();
    return [given, additional, family].filter(Boolean).join(" ").trim();
  }
  if (value == null){
    return "";
  }
  const parts = String(value).split(";");
  const family = String(parts[0] || "").trim();
  const given = String(parts[1] || "").trim();
  const additional = String(parts[2] || "").trim();
  return [given, additional, family].filter(Boolean).join(" ").trim();
}

/**
 * Parse the system addressbook vCard export into a contact list.
 * @param {string} data - Raw CardDAV export
 * @returns {Array<{id:string,label:string,email:string,idLower:string,labelLower:string,emailLower:string,avatarDataUrl:string|null}>}
 */
function parseSystemAddressbook(data){
  const contract = getTalkIcalContractApi();
  if (!contract){
    return [];
  }
  const cards = contract.parseVcardComponents(data);
  const contacts = [];
  for (const card of cards){
    const uid = readVcardTextProperty(card, "uid", contract);
    if (!uid){
      continue;
    }
    let fn = readVcardTextProperty(card, "fn", contract);
    if (!fn){
      fn = buildLabelFromVcardName(card.getFirstPropertyValue("n"));
    }
    const nickname = readVcardTextProperty(card, "nickname", contract);
    const displayName =
      readVcardTextProperty(card, "x-nc-share-with-name", contract) ||
      readVcardTextProperty(card, "x-nc-share-with-displayname", contract) ||
      readVcardTextProperty(card, "org", contract);

    const emails = card.getAllProperties("email")
      .map((prop) => {
        const value = String(contract.stringifyValue(prop.getFirstValue()) || "").trim();
        if (!value){
          return null;
        }
        return {
          value,
          params: getVcardPropertyParams(prop, contract)
        };
      })
      .filter(Boolean);

    if (!emails.length){
      continue;
    }

    const preferred = emails.find((entry) => {
      const scope = String(entry.params["X-NC-SCOPE"] || "").toLowerCase();
      return scope === "v2-federated";
    }) || emails[0];
    const email = String(preferred?.value || "").trim();
    if (!email){
      continue;
    }

    const photoProp = card.getFirstProperty("photo");
    let photo = null;
    if (photoProp){
      const photoParams = getVcardPropertyParams(photoProp, contract);
      photo = {
        raw: String(contract.stringifyValue(photoProp.getFirstValue()) || ""),
        encoding: photoParams.ENCODING || "",
        valueType: photoParams.VALUE || "",
        mime: photoParams.TYPE || photoParams.MEDIATYPE || ""
      };
    }
    const label = (fn || nickname || displayName || email || uid).trim() || email;
    const avatar = photo ? createPhotoDataUrl(photo) : null;
    contacts.push({
      id: uid,
      label,
      email,
      idLower: uid.toLowerCase(),
      labelLower: label.toLowerCase(),
      emailLower: email.toLowerCase(),
      avatarDataUrl: avatar ? avatar.dataUrl : null
    });
  }
  contacts.sort((a, b) => {
    const byLabel = a.labelLower.localeCompare(b.labelLower);
    if (byLabel !== 0) return byLabel;
    return a.idLower.localeCompare(b.idLower);
  });
  return contacts;
}

/**
 * Extract a MIME type from a data URL.
 * @param {string} dataUrl
 * @returns {string}
 */
function extractMimeFromDataUrl(dataUrl){
  const match = /^data:([^;,]+)[;,]?/i.exec(dataUrl);
  return match && match[1] ? match[1].toLowerCase() : "";
}

/**
 * Build a photo data URL from a card photo payload.
 * @param {{data?:string, value?:string, mime?:string}|string} photo
 * @returns {{dataUrl:string,mime:string}|null}
 */
function createPhotoDataUrl(photo){
  if (!photo) return null;
  const raw = String(photo.raw || "").trim();
  if (!raw) return null;
  if (raw.startsWith("data:")){
    const mime = extractMimeFromDataUrl(raw) || photo.mime || "";
    return { dataUrl: raw, mime };
  }
  if ((photo.valueType || "") === "uri"){
    if (raw.startsWith("data:")){
      const mime = extractMimeFromDataUrl(raw) || photo.mime || "";
      return { dataUrl: raw, mime };
    }
    return null;
  }
  const encoding = (photo.encoding || "").toLowerCase();
  if (encoding === "b" || encoding === "base64" || !encoding){
    const cleaned = raw.replace(/\s+/g, "");
    if (!cleaned) return null;
    const mime = photo.mime || "image/png";
    const dataUrl = "data:" + (mime || "image/png") + ";base64," + cleaned;
    return { dataUrl, mime, base64: cleaned };
  }
  return null;
}

/**
 * Load and cache the Nextcloud system addressbook as a contact list.
 * @param {boolean} force - Force a refresh when true
 * @returns {Promise<Array<{id:string,label:string,email:string,idLower:string,labelLower:string,emailLower:string,avatarDataUrl:string|null}>>}
 */
async function getSystemAddressbookContacts(force = false){
  const { baseUrl, user, appPass } = await getOpts();
  if (!baseUrl || !user || !appPass) throw localizedError("error_credentials_missing");
  await ensureHostPermission(baseUrl);
  const now = Date.now();
  const cacheMatchesIdentity =
    SYSTEM_ADDRESSBOOK_CACHE.user === user &&
    SYSTEM_ADDRESSBOOK_CACHE.baseUrl === baseUrl;
  if (!force &&
      SYSTEM_ADDRESSBOOK_CACHE.contacts.length &&
      cacheMatchesIdentity &&
      now - SYSTEM_ADDRESSBOOK_CACHE.fetchedAt < SYSTEM_ADDRESSBOOK_TTL){
    L("system addressbook cache hit", {
      entries: SYSTEM_ADDRESSBOOK_CACHE.contacts.length,
      ageMs: now - SYSTEM_ADDRESSBOOK_CACHE.fetchedAt
    });
    return SYSTEM_ADDRESSBOOK_CACHE.contacts;
  }
  if (force &&
      SYSTEM_ADDRESSBOOK_CACHE.contacts.length &&
      cacheMatchesIdentity &&
      now - SYSTEM_ADDRESSBOOK_CACHE.forceFetchedAt < SYSTEM_ADDRESSBOOK_FORCE_MIN_INTERVAL_MS){
    L("system addressbook force refresh throttled", {
      entries: SYSTEM_ADDRESSBOOK_CACHE.contacts.length,
      ageMs: now - SYSTEM_ADDRESSBOOK_CACHE.forceFetchedAt
    });
    return SYSTEM_ADDRESSBOOK_CACHE.contacts;
  }
  const auth = NCOcs.buildAuthHeader(user, appPass);
  const base = baseUrl.replace(/\/$/,"");
  L("system addressbook fetch", { base, user, force: !!force });
  // Access to the server-side system addressbook (CardDAV) requires remote.php permission.
  const addressUrl = base + "/remote.php/dav/addressbooks/users/" + encodeURIComponent(user) + "/z-server-generated--system/?export";
  const res = await fetch(addressUrl, {
    method: "GET",
    headers: {
      "Authorization": auth,
      "Accept": "text/directory",
      "Cache-Control": "no-cache"
    }
  });
  if (!res.ok){
    const text = await res.text().catch((error) => {
      logTalkCoreError("system addressbook response read failed", error);
      return "";
    });
    throw localizedError("error_system_addressbook_failed", [text || (res.status + " " + res.statusText)]);
  }
  const raw = await res.text();
  const contacts = parseSystemAddressbook(raw);
  L("system addressbook fetched", { count: contacts.length, force: !!force });
  SYSTEM_ADDRESSBOOK_CACHE.contacts = contacts;
  SYSTEM_ADDRESSBOOK_CACHE.fetchedAt = now;
  if (force){
    SYSTEM_ADDRESSBOOK_CACHE.forceFetchedAt = now;
  }
  SYSTEM_ADDRESSBOOK_CACHE.user = user;
  SYSTEM_ADDRESSBOOK_CACHE.baseUrl = baseUrl;
  return contacts;
}

/**
 * Filter system addressbook contacts by term and limit.
 * @param {{searchTerm?:string, limit?:number, forceRefresh?:boolean}} param0
 * @returns {Promise<Array<{id:string,label:string,email:string,avatarDataUrl:string|null}>>}
 */
async function searchSystemAddressbook({ searchTerm = "", limit = 200, forceRefresh = false } = {}){
  const contacts = await getSystemAddressbookContacts(forceRefresh);
  const term = String(searchTerm || "").trim().toLowerCase();
  let filtered = contacts;
  if (term){
    filtered = contacts.filter((entry) => {
      return entry.idLower.includes(term) ||
        (entry.labelLower && entry.labelLower.includes(term)) ||
        entry.emailLower.includes(term);
    });
  }
  const limited = typeof limit === "number" && limit > 0 ? filtered.slice(0, limit) : filtered;
  L("search system addressbook", {
    term,
    limit,
    total: contacts.length,
    matches: limited.length
  });
  return limited.map(({ id, label, email, avatarDataUrl }) => ({
    id,
    label,
    email,
    avatarDataUrl: avatarDataUrl || null
  }));
}

/**
 * Check whether the system addressbook is currently reachable.
 * @param {{forceRefresh?:boolean}} param0
 * @returns {Promise<{available:boolean,count:number,error:string}>}
 */
async function getSystemAddressbookStatus({ forceRefresh = false } = {}){
  try{
    const contacts = await getSystemAddressbookContacts(!!forceRefresh);
    return {
      available: true,
      count: Array.isArray(contacts) ? contacts.length : 0,
      error: ""
    };
  }catch(error){
    const detail = error?.message || String(error);
    logTalkCoreError("system addressbook status check failed", error);
    return {
      available: false,
      count: 0,
      error: detail
    };
  }
}
