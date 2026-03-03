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
      console.error("[NCIcal] parseEventData failed", error);
      return out;
    }
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
      console.error("[NCIcal] extractEventAttendees failed", error);
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
      console.error("[NCIcal] applyEventPropertyUpdates failed", {
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
      console.error("[NCIcal] parseVcardComponents failed", error);
      return [];
    }
  }

  const api = {
    ensureIcal,
    stringifyValue,
    parseEventData,
    extractEventAttendees,
    applyEventPropertyUpdates,
    parseVcardComponents
  };

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCIcalContract = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
