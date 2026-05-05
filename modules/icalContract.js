/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Shared iCalendar/vCard parser contract based on vendored ical.js.
 * This module provides deterministic parser/writer operations used by
 * background and UI code paths.
 */
(function(global){
  "use strict";
  const ICAL_LOG_PREFIX =
    global.NCLogContext?.resolveAddonLogPrefix?.("Ical")
    || "[NCBG]";
  const WINDOWS_TZID_TO_IANA = Object.freeze({
    "afghanistan standard time": "Asia/Kabul",
    "alaskan standard time": "America/Anchorage",
    "aleutian standard time": "America/Adak",
    "altai standard time": "Asia/Barnaul",
    "arab standard time": "Asia/Riyadh",
    "arabian standard time": "Asia/Dubai",
    "arabic standard time": "Asia/Baghdad",
    "argentina standard time": "America/Buenos_Aires",
    "astrakhan standard time": "Europe/Astrakhan",
    "atlantic standard time": "America/Halifax",
    "aus central standard time": "Australia/Darwin",
    "aus central w. standard time": "Australia/Eucla",
    "aus eastern standard time": "Australia/Sydney",
    "azerbaijan standard time": "Asia/Baku",
    "azores standard time": "Atlantic/Azores",
    "bahia standard time": "America/Bahia",
    "bangladesh standard time": "Asia/Dhaka",
    "belarus standard time": "Europe/Minsk",
    "bougainville standard time": "Pacific/Bougainville",
    "canada central standard time": "America/Regina",
    "cape verde standard time": "Atlantic/Cape_Verde",
    "caucasus standard time": "Asia/Yerevan",
    "cen. australia standard time": "Australia/Adelaide",
    "central america standard time": "America/Guatemala",
    "central asia standard time": "Asia/Bishkek",
    "central brazilian standard time": "America/Cuiaba",
    "central europe standard time": "Europe/Budapest",
    "central european standard time": "Europe/Warsaw",
    "central pacific standard time": "Pacific/Guadalcanal",
    "central standard time": "America/Chicago",
    "central standard time (mexico)": "America/Mexico_City",
    "chatham islands standard time": "Pacific/Chatham",
    "china standard time": "Asia/Shanghai",
    "cuba standard time": "America/Havana",
    "dateline standard time": "Etc/GMT+12",
    "e. africa standard time": "Africa/Nairobi",
    "e. australia standard time": "Australia/Brisbane",
    "e. europe standard time": "Europe/Chisinau",
    "e. south america standard time": "America/Sao_Paulo",
    "easter island standard time": "Pacific/Easter",
    "eastern standard time": "America/New_York",
    "eastern standard time (mexico)": "America/Cancun",
    "egypt standard time": "Africa/Cairo",
    "ekaterinburg standard time": "Asia/Yekaterinburg",
    "fiji standard time": "Pacific/Fiji",
    "fle standard time": "Europe/Kiev",
    "georgian standard time": "Asia/Tbilisi",
    "gmt standard time": "Europe/London",
    "greenland standard time": "America/Godthab",
    "greenwich standard time": "Atlantic/Reykjavik",
    "gtb standard time": "Europe/Bucharest",
    "haiti standard time": "America/Port-au-Prince",
    "hawaiian standard time": "Pacific/Honolulu",
    "india standard time": "Asia/Calcutta",
    "iran standard time": "Asia/Tehran",
    "israel standard time": "Asia/Jerusalem",
    "jordan standard time": "Asia/Amman",
    "kaliningrad standard time": "Europe/Kaliningrad",
    "korea standard time": "Asia/Seoul",
    "libya standard time": "Africa/Tripoli",
    "line islands standard time": "Pacific/Kiritimati",
    "lord howe standard time": "Australia/Lord_Howe",
    "magadan standard time": "Asia/Magadan",
    "magallanes standard time": "America/Punta_Arenas",
    "marquesas standard time": "Pacific/Marquesas",
    "mauritius standard time": "Indian/Mauritius",
    "middle east standard time": "Asia/Beirut",
    "montevideo standard time": "America/Montevideo",
    "morocco standard time": "Africa/Casablanca",
    "mountain standard time": "America/Denver",
    "mountain standard time (mexico)": "America/Mazatlan",
    "myanmar standard time": "Asia/Rangoon",
    "n. central asia standard time": "Asia/Novosibirsk",
    "namibia standard time": "Africa/Windhoek",
    "nepal standard time": "Asia/Katmandu",
    "new zealand standard time": "Pacific/Auckland",
    "newfoundland standard time": "America/St_Johns",
    "norfolk standard time": "Pacific/Norfolk",
    "north asia east standard time": "Asia/Irkutsk",
    "north asia standard time": "Asia/Krasnoyarsk",
    "north korea standard time": "Asia/Pyongyang",
    "omsk standard time": "Asia/Omsk",
    "pacific sa standard time": "America/Santiago",
    "pacific standard time": "America/Los_Angeles",
    "pacific standard time (mexico)": "America/Tijuana",
    "pakistan standard time": "Asia/Karachi",
    "paraguay standard time": "America/Asuncion",
    "qyzylorda standard time": "Asia/Qyzylorda",
    "romance standard time": "Europe/Paris",
    "russia time zone 10": "Asia/Srednekolymsk",
    "russia time zone 11": "Asia/Kamchatka",
    "russia time zone 3": "Europe/Samara",
    "russian standard time": "Europe/Moscow",
    "sa eastern standard time": "America/Cayenne",
    "sa pacific standard time": "America/Bogota",
    "sa western standard time": "America/La_Paz",
    "saint pierre standard time": "America/Miquelon",
    "sakhalin standard time": "Asia/Sakhalin",
    "samoa standard time": "Pacific/Apia",
    "sao tome standard time": "Africa/Sao_Tome",
    "saratov standard time": "Europe/Saratov",
    "se asia standard time": "Asia/Bangkok",
    "singapore standard time": "Asia/Singapore",
    "south africa standard time": "Africa/Johannesburg",
    "sri lanka standard time": "Asia/Colombo",
    "sudan standard time": "Africa/Khartoum",
    "syria standard time": "Asia/Damascus",
    "taipei standard time": "Asia/Taipei",
    "tasmania standard time": "Australia/Hobart",
    "tocantins standard time": "America/Araguaina",
    "tokyo standard time": "Asia/Tokyo",
    "tomsk standard time": "Asia/Tomsk",
    "tonga standard time": "Pacific/Tongatapu",
    "transbaikal standard time": "Asia/Chita",
    "turkey standard time": "Europe/Istanbul",
    "turks and caicos standard time": "America/Grand_Turk",
    "u.s. eastern standard time": "America/Indianapolis",
    "u.s. mountain standard time": "America/Phoenix",
    "utc": "Etc/UTC",
    "utc-02": "Etc/GMT+2",
    "utc-08": "Etc/GMT+8",
    "utc-09": "Etc/GMT+9",
    "utc-11": "Etc/GMT+11",
    "utc+12": "Etc/GMT-12",
    "utc+13": "Etc/GMT-13",
    "venezuela standard time": "America/Caracas",
    "vladivostok standard time": "Asia/Vladivostok",
    "volgograd standard time": "Europe/Volgograd",
    "w. australia standard time": "Australia/Perth",
    "w. central africa standard time": "Africa/Lagos",
    "w. europe standard time": "Europe/Berlin",
    "w. mongolia standard time": "Asia/Hovd",
    "west asia standard time": "Asia/Tashkent",
    "west bank standard time": "Asia/Hebron",
    "west pacific standard time": "Pacific/Port_Moresby",
    "yakutsk standard time": "Asia/Yakutsk",
    "yukon standard time": "America/Whitehorse"
  });

  /**
   * Resolve the global ical.js API and fail loudly if it is missing.
   * @returns {object}
   */
  function ensureIcal(){
    if (!global?.ICAL || typeof global.ICAL.parse !== "function" || typeof global.ICAL.Component !== "function"){
      throw new Error("ICAL library not available. Ensure vendor/ical.js is loaded before modules/icalContract.js.");
    }
    return global.ICAL;
  }

  /**
   * Normalize an iCal property name.
   * @param {string} name
   * @returns {string}
   */
  function normalizePropertyName(name){
    if (name == null){
      return "";
    }
    return String(name).trim().toUpperCase();
  }

  /**
   * Convert a parsed property value into deterministic string form.
   * @param {any} value
   * @returns {string}
   */
  function stringifyValue(value){
    if (value == null){
      return "";
    }
    if (typeof value === "string"){
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean"){
      return String(value);
    }
    if (typeof value.toICALString === "function"){
      return String(value.toICALString());
    }
    if (Array.isArray(value)){
      return value.map((entry) => stringifyValue(entry)).join(";");
    }
    return String(value);
  }

  /**
   * Determine whether a timezone id looks like an IANA timezone identifier.
   * @param {string} value
   * @returns {boolean}
   */
  function isIanaTimeZone(value){
    if (typeof value !== "string"){
      return false;
    }
    const tzid = value.trim();
    if (!tzid){
      return false;
    }
    if (tzid.toUpperCase() === "UTC"){
      return true;
    }
    return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(tzid);
  }

  /**
   * Resolve a calendar TZID to a deterministic runtime timezone id.
   * @param {string} tzid
   * @returns {string}
   */
  function resolveRuntimeTimeZone(tzid){
    const raw = String(tzid || "").trim();
    if (!raw){
      return "";
    }
    if (isIanaTimeZone(raw)){
      return raw.toUpperCase() === "UTC" ? "UTC" : raw;
    }
    return WINDOWS_TZID_TO_IANA[raw.toLowerCase()] || "";
  }

  /**
   * Calculate timezone offset in milliseconds for one instant and timezone id.
   * @param {string} timeZone
   * @param {Date} instant
   * @returns {number|null}
   */
  function getTimeZoneOffsetMs(timeZone, instant){
    const tz = String(timeZone || "").trim();
    if (!tz){
      return null;
    }
    try{
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
      const parts = formatter.formatToParts(instant);
      const values = {};
      for (const part of parts){
        if (part.type !== "literal"){
          values[part.type] = part.value;
        }
      }
      const asUtc = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second)
      );
      return asUtc - instant.getTime();
    }catch{
      return null;
    }
  }

  /**
   * Convert date/time parts interpreted in a target timezone into unix seconds.
   * Uses a short fixed-point iteration for DST boundary stability.
   * @param {number} year
   * @param {number} month
   * @param {number} day
   * @param {number} hour
   * @param {number} minute
   * @param {number} second
   * @param {string} timeZone
   * @returns {number|null}
   */
  function zonedDateTimeToUnixSeconds(year, month, day, hour, minute, second, timeZone){
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
    if (!Number.isFinite(utcGuess)){
      return null;
    }
    let current = utcGuess;
    for (let i = 0; i < 3; i += 1){
      const offset = getTimeZoneOffsetMs(timeZone, new Date(current));
      if (offset == null){
        return null;
      }
      const next = utcGuess - offset;
      if (next === current){
        break;
      }
      current = next;
    }
    const unix = current / 1000;
    return Number.isFinite(unix) ? Math.floor(unix) : null;
  }

  /**
   * Convert unresolved/floating ICAL.Time values using explicit TZID mapping.
   * @param {any} value
   * @param {string} tzid
   * @returns {number|null}
   */
  function convertFloatingValueToUnixSeconds(value, tzid){
    if (!value || typeof value.year !== "number" || typeof value.month !== "number" || typeof value.day !== "number"){
      return null;
    }
    const resolvedZone = resolveRuntimeTimeZone(tzid);
    if (!resolvedZone){
      return null;
    }
    const hour = value.isDate ? 0 : Number(value.hour || 0);
    const minute = value.isDate ? 0 : Number(value.minute || 0);
    const second = value.isDate ? 0 : Number(value.second || 0);
    if (resolvedZone === "UTC"){
      const unix = Date.UTC(value.year, value.month - 1, value.day, hour, minute, second) / 1000;
      return Number.isFinite(unix) ? Math.floor(unix) : null;
    }
    return zonedDateTimeToUnixSeconds(
      value.year,
      value.month,
      value.day,
      hour,
      minute,
      second,
      resolvedZone
    );
  }

  /**
   * Parse iCal/vCard payload into ICAL.Component objects.
   * @param {string} payload
   * @returns {object[]}
   */
  function parseComponents(payload){
    if (typeof payload !== "string" || !payload.trim()){
      return [];
    }
    const ICAL = ensureIcal();
    const parsed = ICAL.parse(payload);
    if (!Array.isArray(parsed)){
      return [];
    }
    if (typeof parsed[0] === "string"){
      return [new ICAL.Component(parsed)];
    }
    return parsed.map((entry) => new ICAL.Component(entry));
  }

  /**
   * Resolve first VEVENT context from an iCal payload.
   * @param {string} ical
   * @returns {{root:any,event:any}|null}
   */
  function resolveFirstEventContext(ical){
    const components = parseComponents(ical);
    for (const component of components){
      if (!component){
        continue;
      }
      if (component.name === "vevent"){
        return { root: component, event: component };
      }
      if (component.name === "vcalendar"){
        const event = component.getFirstSubcomponent("vevent");
        if (event){
          return { root: component, event };
        }
      }
    }
    return null;
  }

  /**
   * Parse first VEVENT and return property bag + DTSTART/DTEND metadata.
   * Contract:
   * - props keys are uppercase property names
   * - props values are deterministic strings
   * - dtStart/dtEnd are { value, tzid } or null
   *
   * @param {string} ical
   * @returns {{props:object,dtStart:{value:string,tzid:string|null}|null,dtEnd:{value:string,tzid:string|null}|null}}
   */
  function parseEventData(ical){
    const out = { props: {}, dtStart: null, dtEnd: null };
    try{
      const context = resolveFirstEventContext(ical);
      if (!context?.event){
        return out;
      }
      for (const prop of context.event.getAllProperties()){
        const name = normalizePropertyName(prop?.name);
        if (!name){
          continue;
        }
        const firstValue = prop.getFirstValue();
        const valueText = stringifyValue(firstValue);
        out.props[name] = valueText;
        if (name === "DTSTART" || name === "DTEND"){
          const dateMeta = {
            value: valueText,
            tzid: prop.getParameter("tzid") || null
          };
          if (name === "DTSTART"){
            out.dtStart = dateMeta;
          } else {
            out.dtEnd = dateMeta;
          }
        }
      }
      return out;
    }catch(error){
      console.error(ICAL_LOG_PREFIX, "parseEventData failed", error);
      return out;
    }
  }

  /**
   * Parse one VEVENT date/datetime property into unix epoch seconds.
   * Parsing relies on the vendored ical.js behavior without custom timezone
   * heuristics in this contract module.
   *
   * @param {string} ical
   * @param {"dtstart"|"dtend"} propertyName
   * @returns {number|null}
   */
  function parseEventPropertyUnixSeconds(ical, propertyName){
    try{
      const context = resolveFirstEventContext(ical);
      if (!context?.event){
        return null;
      }
      const targetName = propertyName === "dtend" ? "dtend" : "dtstart";
      const prop = context.event.getFirstProperty(targetName);
      if (!prop){
        return null;
      }
      const value = prop.getFirstValue();
      if (!value || typeof value.toUnixTime !== "function"){
        return null;
      }
      const tzid = String(prop.getParameter("tzid") || "").trim();
      const resolvedZoneId = String(value?.zone?.tzid || "").trim().toLowerCase();
      const unresolvedZone = !resolvedZoneId || resolvedZoneId === "floating" || resolvedZoneId === "local";
      if (tzid && unresolvedZone){
        return convertFloatingValueToUnixSeconds(value, tzid);
      }
      const unix = value.toUnixTime();
      if (!Number.isFinite(unix)){
        return null;
      }
      return Math.floor(unix);
    }catch(error){
      console.error(ICAL_LOG_PREFIX, "parseEventPropertyUnixSeconds failed", {
        propertyName
      }, error);
      return null;
    }
  }

  /**
   * Parse DTSTART of the first VEVENT into unix epoch seconds.
   * @param {string} ical
   * @returns {number|null}
   */
  function parseEventStartUnixSeconds(ical){
    return parseEventPropertyUnixSeconds(ical, "dtstart");
  }

  /**
   * Parse DTEND of the first VEVENT into unix epoch seconds.
   * @param {string} ical
   * @returns {number|null}
   */
  function parseEventEndUnixSeconds(ical){
    return parseEventPropertyUnixSeconds(ical, "dtend");
  }

  /**
   * Extract attendee values from the first VEVENT.
   * Returns raw values + EMAIL parameter to allow consumer-side normalization.
   *
   * @param {string} ical
   * @returns {Array<{value:string,emailParam:string}>}
   */
  function extractEventAttendees(ical){
    try{
      const context = resolveFirstEventContext(ical);
      if (!context?.event){
        return [];
      }
      return context.event.getAllProperties("attendee").map((prop) => ({
        value: stringifyValue(prop.getFirstValue()),
        emailParam: stringifyValue(prop.getParameter("email") || "")
      }));
    }catch(error){
      console.error(ICAL_LOG_PREFIX, "extractEventAttendees failed", error);
      return [];
    }
  }

  /**
   * Apply property updates to first VEVENT and serialize updated iCal payload.
   * Contract:
   * - update key normalization: uppercase input keys
   * - null/undefined value => property removal
   * - existing properties updated in-place; missing properties are created
   *
   * @param {string} ical
   * @param {Record<string, string|null|undefined>} updates
   * @returns {{ical:string,changed:boolean}}
   */
  function applyEventPropertyUpdates(ical, updates){
    if (typeof ical !== "string" || !updates || typeof updates !== "object"){
      return { ical, changed: false };
    }
    let normalizedUpdates = null;
    try{
      normalizedUpdates = {};
      for (const [rawKey, rawValue] of Object.entries(updates)){
        const key = normalizePropertyName(rawKey);
        if (!key){
          continue;
        }
        normalizedUpdates[key] = rawValue === undefined ? null : rawValue;
      }
      if (!Object.keys(normalizedUpdates).length){
        return { ical, changed: false };
      }

      const context = resolveFirstEventContext(ical);
      if (!context?.event){
        return { ical, changed: false };
      }

      const event = context.event;
      let changed = false;
      for (const [key, rawValue] of Object.entries(normalizedUpdates)){
        const lowerName = key.toLowerCase();
        const existing = event.getAllProperties(lowerName);
        if (rawValue == null){
          if (existing.length){
            for (const prop of existing){
              event.removeProperty(prop);
            }
            changed = true;
          }
          continue;
        }

        const desired = String(rawValue);
        if (!existing.length){
          event.addPropertyWithValue(lowerName, desired);
          changed = true;
          continue;
        }

        for (const prop of existing){
          const current = stringifyValue(prop.getFirstValue());
          if (current !== desired){
            changed = true;
          }
          prop.setValue(desired);
        }
      }

      if (!changed){
        return { ical, changed: false };
      }
      return {
        ical: context.root.toString(),
        changed: true
      };
    }catch(error){
      console.error(ICAL_LOG_PREFIX, "applyEventPropertyUpdates failed", {
        keys: normalizedUpdates ? Object.keys(normalizedUpdates) : []
      }, error);
      return { ical, changed: false };
    }
  }

  /**
   * Parse all top-level vCard components from a CardDAV export payload.
   * @param {string} data
   * @returns {object[]}
   */
  function parseVcardComponents(data){
    try{
      return parseComponents(data).filter((component) => component?.name === "vcard");
    }catch(error){
      console.error(ICAL_LOG_PREFIX, "parseVcardComponents failed", error);
      return [];
    }
  }

  const api = {
    ensureIcal,
    stringifyValue,
    parseEventData,
    parseEventStartUnixSeconds,
    parseEventEndUnixSeconds,
    extractEventAttendees,
    applyEventPropertyUpdates,
    parseVcardComponents
  };

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCIcalContract = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
