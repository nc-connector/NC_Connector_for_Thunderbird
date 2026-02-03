/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Shared helpers for the calendar event dialog integration.
 */
(() => {
  "use strict";

  const globalScope = typeof window !== "undefined"
    ? window
    : (typeof globalThis !== "undefined" ? globalThis : this);

  if (globalScope.NCTalkCalUtils){
    return;
  }

  const TALK_PROP_TOKEN = "X-NCTALK-TOKEN";
  const TALK_PROP_URL = "X-NCTALK-URL";
  const TALK_PROP_LOBBY = "X-NCTALK-LOBBY";
  const TALK_PROP_START = "X-NCTALK-START";
  const TALK_PROP_EVENT = "X-NCTALK-EVENT";
  const TALK_PROP_OBJECT_ID = "X-NCTALK-OBJECTID";
  const TALK_PROP_ADD_PARTICIPANTS = "X-NCTALK-ADD-PARTICIPANTS";
  const TALK_PROP_DELEGATE = "X-NCTALK-DELEGATE";
  const TALK_PROP_DELEGATE_NAME = "X-NCTALK-DELEGATE-NAME";
  const TALK_PROP_DELEGATED = "X-NCTALK-DELEGATED";
  const TALK_PROP_DELEGATE_READY = "X-NCTALK-DELEGATE-READY";

  /**
   * Normalize a string value, returning null for empty strings.
   * @param {any} value
   * @returns {string|null}
   */
  function safeString(value){
    return typeof value === "string" && value.length ? value : null;
  }

  /**
   * Parse boolean-like values from calendar properties.
   * @param {any} value
   * @returns {boolean|null}
   */
  function parseBooleanProp(value){
    if (typeof value === "boolean") return value;
    if (typeof value === "string"){
      const norm = value.trim().toLowerCase();
      if (norm === "true" || norm === "1" || norm === "yes") return true;
      if (norm === "false" || norm === "0" || norm === "no") return false;
    }
    return null;
  }

  /**
   * Parse integer-like values from calendar properties.
   * @param {any} value
   * @returns {number|null}
   */
  function parseNumberProp(value){
    if (typeof value === "number" && Number.isFinite(value)){
      return value;
    }
    if (typeof value === "string"){
      const trimmed = value.trim();
      if (!trimmed) return null;
      const parsed = parseInt(trimmed, 10);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  /**
   * Convert a boolean value to a calendar property string.
   * @param {any} value
   * @returns {string}
   */
  function boolToProp(value){
    if (typeof value === "string"){
      const norm = value.trim().toLowerCase();
      if (norm === "true" || norm === "1" || norm === "yes") return "TRUE";
      if (norm === "false" || norm === "0" || norm === "no") return "FALSE";
    }
    return value ? "TRUE" : "FALSE";
  }

  /**
   * Locate the calendar item from a dialog document.
   * @param {Document} doc
   * @returns {object|null}
   */
  function getCalendarItem(doc){
    try{
      const win = doc?.defaultView || globalScope;
      if (win?.calendarItem) return win.calendarItem;
      if (win?.gEvent?.event) return win.gEvent.event;
      if (Array.isArray(win?.arguments) && win.arguments[0]){
        const arg = win.arguments[0];
        if (arg.calendarItem) return arg.calendarItem;
        if (arg.calendarEvent) return arg.calendarEvent;
      }
    }catch(_){}
    return null;
  }

  /**
   * Resolve a document from a window or document target.
   * @param {Window|Document} target
   * @returns {Document|null}
   */
  function resolveDocument(target){
    if (!target) return null;
    if (target.document) return target.document;
    if (target.nodeType === 9) return target;
    if (target.defaultView && target.defaultView.document) return target.defaultView.document;
    return null;
  }

  /**
   * Collect documents for the dialog and its iframe (if present).
   * @param {Window|Document} target
   * @returns {Document[]}
   */
  function collectEventDocs(target){
    const docs = [];
    const doc = resolveDocument(target);
    if (!doc) return docs;
    /**
     * Push a document if it is not already in the list.
     * @param {Document} entry
     */
    const pushDoc = (entry) => {
      if (entry && docs.indexOf(entry) === -1){
        docs.push(entry);
      }
    };
    try{
      pushDoc(doc);
    }catch(_){}
    try{
      const iframe = doc.getElementById && doc.getElementById("calendar-item-panel-iframe");
      if (iframe?.contentDocument){
        pushDoc(iframe.contentDocument);
      }
    }catch(_){}
    try{
      // TB 140 (tab editor): calendar-item-iframe.xhtml is hosted in an iframe in the 3pane.
      const tabIframe = doc.querySelector && doc.querySelector("iframe[src=\"chrome://calendar/content/calendar-item-iframe.xhtml\"]");
      if (tabIframe?.contentDocument){
        pushDoc(tabIframe.contentDocument);
      }
    }catch(_){ }
    return docs;
  }

  /**
   * Find a field element across multiple documents.
   * @param {Document[]} docs
   * @param {string[]} selectors
   * @returns {Element|null}
   */
  function findField(docs, selectors){
    for (const doc of docs){
      if (!doc || typeof doc.querySelector !== "function") continue;
      for (const sel of selectors){
        try{
          const element = doc.querySelector(sel);
          if (element) return element;
        }catch(_){}
      }
    }
    return null;
  }

  /**
   * Locate the event description field across dialog variants and editors.
   * @param {Document[]} docs
   * @returns {Element|null}
   */
  function findDescriptionFieldInDocs(docs){
    for (const doc of docs){
      try{
        // TB 140: #item-description is the dedicated identifier. If changed in future TB, add a second selector and annotate the TB version.
        const host = doc.querySelector && doc.querySelector("editor#item-description");
        let target = null;
        if (host){
          target = host.inputField || host.contentDocument?.body || host;
        }
        if (!target){
          // Future fallback (only if needed): "textarea#item-description"
          const fallback = doc.querySelector && doc.querySelector("textarea#item-description");
          if (fallback){
            target = fallback;
          }
        }
        if (target) return target;
      }catch(_){ }
    }
    return null;
  }

  /**
   * Dispatch an input event on an edited field.
   * @param {Element} field
   */
  function dispatchInputEvent(field){
    if (!field) return;
    try{
      const doc = field.ownerDocument || field.document;
      const win = doc?.defaultView;
      if (win){
        const evt = new win.Event("input", { bubbles:true });
        field.dispatchEvent(evt);
      }
    }catch(_){}
  }

  /**
   * Set the value of a field using editor-aware fallbacks.
   * @param {Element} field
   * @param {string} value
   * @param {object} opts
   */
  function setFieldValue(field, value, opts = {}){
    if (!field) return;
    const doc = field.ownerDocument || field.document || field.contentDocument || null;
    const execPreferred = opts.preferExec === true;

    /**
     * Attempt an execCommand-based update for rich editors.
     * @returns {boolean}
     */
    const tryExecCommand = () => {
      if (!doc || typeof doc.execCommand !== "function"){
        return false;
      }
      try{
        field.focus?.();
        doc.execCommand("selectAll", false, null);
        doc.execCommand("insertText", false, value);
        return true;
      }catch(_){
        return false;
      }
    };

    if (execPreferred && tryExecCommand()){
      dispatchInputEvent(field);
      return;
    }

    if ("value" in field){
      try{ field.focus?.(); }catch(_){}
      field.value = value;
      dispatchInputEvent(field);
      return;
    }

    if ((field.isContentEditable || field.tagName?.toLowerCase() === "body") && tryExecCommand()){
      dispatchInputEvent(field);
      return;
    }

    if (field.textContent !== undefined){
      field.textContent = value;
      dispatchInputEvent(field);
    }
  }

  /**
   * Read the current value from a field.
   * @param {Element} field
   * @returns {string}
   */
  function getFieldValue(field){
    if (!field) return "";
    if ("value" in field){
      return field.value || "";
    }
    if (field.textContent != null){
      return field.textContent;
    }
    return "";
  }

  /**
   * Read Talk metadata properties from the calendar item in a document.
   * @param {Document} doc
   * @returns {object}
   */
  function readTalkMetadataFromDocument(doc){
    try{
      let item = getCalendarItem(doc);
      if (!item || typeof item.getProperty !== "function"){
        try{
          // TB 140: calendar-item-panel-iframe (dialog) and calendar-item-iframe.xhtml (tab) host the editor item.
          const dialogIframe = doc?.getElementById && doc.getElementById("calendar-item-panel-iframe");
          const tabIframe = doc?.querySelector && doc.querySelector("iframe[src=\"chrome://calendar/content/calendar-item-iframe.xhtml\"]");
          const candidates = [dialogIframe?.contentDocument, tabIframe?.contentDocument];
          for (const candidate of candidates){
            if (!candidate) continue;
            const candidateItem = getCalendarItem(candidate);
            if (candidateItem && typeof candidateItem.getProperty === "function"){
              item = candidateItem;
              break;
            }
          }
        }catch(_){ }
      }
      if (!item || typeof item.getProperty !== "function"){
        return {};
      }
      /**
       * Read a string property from the calendar item.
       * @param {string} name
       * @returns {string|null}
       */
      const get = (name) => {
        try{
          return safeString(item.getProperty(name));
        }catch(_){
          return null;
        }
      };
      return {
        token: get(TALK_PROP_TOKEN),
        url: get(TALK_PROP_URL),
        lobbyEnabled: (() => {
          const raw = get(TALK_PROP_LOBBY);
          return raw == null ? null : parseBooleanProp(raw);
        })(),
        startTimestamp: parseNumberProp(get(TALK_PROP_START)),
        eventConversation: (() => {
          const raw = get(TALK_PROP_EVENT);
          if (!raw) return null;
          return raw.trim().toLowerCase() === "event";
        })(),
        objectId: get(TALK_PROP_OBJECT_ID),
        addParticipants: (() => {
          const raw = get(TALK_PROP_ADD_PARTICIPANTS);
          return raw == null ? null : parseBooleanProp(raw);
        })(),
        delegateId: get(TALK_PROP_DELEGATE),
        delegateName: get(TALK_PROP_DELEGATE_NAME),
        delegated: (() => {
          const raw = get(TALK_PROP_DELEGATED);
          if (raw == null) return false;
          return parseBooleanProp(raw);
        })(),
        delegateReady: (() => {
          const raw = get(TALK_PROP_DELEGATE_READY);
          if (raw == null) return null;
          return parseBooleanProp(raw);
        })()
      };
    }catch(_){
      return {};
    }
  }

  /**
   * Write Talk metadata properties to the calendar item in a document.
   * @param {Document} doc
   * @param {object} meta
   * @returns {{ok:boolean, error?:string}}
   */
  function writeTalkMetadataToDocument(doc, meta = {}){
    const item = getCalendarItem(doc);
    if (!item || typeof item.setProperty !== "function"){
      return { ok:false, error:"no_calendar_item" };
    }
    /**
     * Set or clear a calendar item property.
     * @param {string} name
     * @param {any} value
     */
    const setProp = (name, value) => {
      try{
        if (value == null || value === ""){
          if (typeof item.deleteProperty === "function"){
            item.deleteProperty(name);
          }else{
            item.setProperty(name, "");
          }
        }else{
          item.setProperty(name, String(value));
        }
      }catch(_){}
    };
    if ("token" in meta) setProp(TALK_PROP_TOKEN, meta.token);
    if ("url" in meta) setProp(TALK_PROP_URL, meta.url);
    if ("lobbyEnabled" in meta) setProp(TALK_PROP_LOBBY, boolToProp(meta.lobbyEnabled));
    if ("startTimestamp" in meta && meta.startTimestamp != null){
      const ts = Number(meta.startTimestamp);
      if (Number.isFinite(ts)){
        setProp(TALK_PROP_START, String(Math.floor(ts)));
      }
    }
    if ("eventConversation" in meta){
      setProp(TALK_PROP_EVENT, meta.eventConversation ? "event" : "standard");
    }
    if ("objectId" in meta) setProp(TALK_PROP_OBJECT_ID, meta.objectId);
    if ("addParticipants" in meta) setProp(TALK_PROP_ADD_PARTICIPANTS, boolToProp(!!meta.addParticipants));
    if ("delegateId" in meta) setProp(TALK_PROP_DELEGATE, meta.delegateId);
    if ("delegateName" in meta) setProp(TALK_PROP_DELEGATE_NAME, meta.delegateName);
    if ("delegated" in meta) setProp(TALK_PROP_DELEGATED, boolToProp(!!meta.delegated));
    if ("delegateReady" in meta){
      const ready = meta.delegateReady;
      if (ready == null){
        setProp(TALK_PROP_DELEGATE_READY, "");
      }else{
        setProp(TALK_PROP_DELEGATE_READY, boolToProp(!!ready));
      }
    }
    return { ok:true };
  }

  /**
   * Convenience wrapper to set Talk metadata on a document or window.
   * @param {Window|Document} target
   * @param {object} payload
   * @returns {{ok:boolean,error?:string}}
   */
  function setTalkMetadataOnWindow(target, payload = {}){
    let doc = resolveDocument(target);
    let meta = payload;
    if (!doc){
      meta = target || {};
      doc = resolveDocument(globalScope);
    }
    if (!doc){
      return { ok:false, error:"no_document" };
    }
    return writeTalkMetadataToDocument(doc, meta);
  }

  /**
   * Collect event fields and Talk metadata from the event dialog window.
   * @param {Window|Document} target
   * @param {object} options
   * @returns {object}
   */
  function getEventSnapshotFromWindow(target, options = {}){
    let doc = resolveDocument(target);
    let opts = options;
    if (!doc){
      opts = target || {};
      doc = resolveDocument(globalScope);
    }
    if (!doc){
      return { ok:false, error:"no_document" };
    }
    const metadata = opts.metadata
      || (typeof opts.readMetadata === "function" ? opts.readMetadata(doc) : readTalkMetadataFromDocument(doc));
    const docs = collectEventDocs(doc);
    // TB 140: #item-title is the dedicated identifier. If changed in future TB, add a second selector and annotate the TB version.
    const titleField = findField(docs, ["#item-title"]);
    // TB 140: #item-location is the dedicated identifier. If changed in future TB, add a second selector and annotate the TB version.
    const locationField = findField(docs, ["#item-location"]);
    const descField = findDescriptionFieldInDocs(docs);
    const event = {
      title: getFieldValue(titleField) || metadata?.title || "",
      location: getFieldValue(locationField) || "",
      description: getFieldValue(descField) || "",
      startTimestamp: metadata?.startTimestamp || null,
      endTimestamp: metadata?.endTimestamp || null
    };
    return { ok:true, event, metadata };
  }

  /**
   * Apply title, location, and description with editor-aware fallbacks.
   * @param {Window|Document} target
   * @param {object} payload
   * @param {object} options
   * @returns {object}
   */
  function applyEventFieldsOnWindow(target, payload = {}, options = {}){
    let doc = resolveDocument(target);
    let fields = payload;
    let opts = options;
    if (!doc){
      doc = resolveDocument(globalScope);
      fields = target || {};
      opts = payload || {};
    }
    if (!doc){
      return { ok:false, error:"no_document" };
    }
    const hasFieldOptions = opts
      && !opts.titleOptions
      && !opts.locationOptions
      && !opts.descriptionOptions
      && !opts.preferExecForDescription;
    const baseOptions = hasFieldOptions ? opts : null;
    const titleOptions = opts.titleOptions || baseOptions || {};
    const locationOptions = opts.locationOptions || baseOptions || {};
    let descriptionOptions = opts.descriptionOptions || baseOptions || {};
    if (opts.preferExecForDescription === true && !opts.descriptionOptions){
      descriptionOptions = Object.assign({}, descriptionOptions, { preferExec:true });
    }
    const docs = collectEventDocs(doc);
    // TB 140: #item-title is the dedicated identifier. If changed in future TB, add a second selector and annotate the TB version.
    const titleField = findField(docs, ["#item-title"]);
    // TB 140: #item-location is the dedicated identifier. If changed in future TB, add a second selector and annotate the TB version.
    const locationField = findField(docs, ["#item-location"]);
    const descField = findDescriptionFieldInDocs(docs);
    if (typeof fields.title === "string" && titleField){
      setFieldValue(titleField, fields.title, titleOptions);
    }
    if (typeof fields.location === "string" && locationField){
      setFieldValue(locationField, fields.location, locationOptions);
    }
    if (typeof fields.description === "string" && descField){
      setFieldValue(descField, fields.description, descriptionOptions);
    }
    return {
      ok:true,
      applied: {
        title: !!titleField,
        location: !!locationField,
        description: !!descField
      }
    };
  }

  /**
   * Inject the Talk button into the TB 140 tab editor toolbar.
   * @param {Document} doc
   * @param {{label?:string, tooltip?:string, iconUrl?:string, onClick?:Function}} handlers
   * @returns {boolean}
   */
  function injectTalkButtonIntoTabEditor(doc, handlers = {}){
    if (!doc) return false;
    if (doc.getElementById("ncTalkActionButton")) return true;
    let actionContainer = doc.getElementById("event-tab-toolbar");
    if (!actionContainer){
      const topDoc = doc.defaultView?.top?.document;
      if (topDoc && topDoc !== doc){
        actionContainer = topDoc.getElementById("event-tab-toolbar");
      }
    }
    if (!actionContainer) return false;
    const useXul = typeof doc.createXULElement === "function";
    const label = handlers.label || "Talk";
    const tooltip = handlers.tooltip || label;
    const iconUrl = handlers.iconUrl || "";
    let btn = null;
    if (useXul){
      btn = doc.createXULElement("toolbarbutton");
      btn.setAttribute("id", "ncTalkActionButton");
      btn.setAttribute("class", "toolbarbutton-1");
      btn.setAttribute("label", label);
      btn.setAttribute("tooltiptext", tooltip);
      if (iconUrl){
        btn.setAttribute("image", iconUrl);
      }
    }else{
      btn = doc.createElement("button");
      btn.id = "ncTalkActionButton";
      btn.type = "button";
      btn.title = tooltip;
      btn.className = "nc-talk-action-btn";
      Object.assign(btn.style, {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 10px"
      });
      if (iconUrl){
        const img = doc.createElement("img");
        img.alt = "";
        img.width = 20;
        img.height = 20;
        img.src = iconUrl;
        btn.appendChild(img);
      }
      const span = doc.createElement("span");
      span.textContent = label;
      btn.appendChild(span);
    }
    if (typeof handlers.onClick === "function"){
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handlers.onClick();
      });
    }
    actionContainer.appendChild(btn);
    return true;
  }

  globalScope.NCTalkCalUtils = {
    getCalendarItemFromDocument: getCalendarItem,
    safeString,
    parseBooleanProp,
    parseNumberProp,
    boolToProp,
    collectEventDocs,
    findField,
    findDescriptionFieldInDocs,
    getFieldValue,
    setFieldValue,
    readTalkMetadataFromDocument,
    writeTalkMetadataToDocument,
    setTalkMetadataOnWindow,
    getEventSnapshotFromWindow,
    applyEventFieldsOnWindow,
    injectTalkButtonIntoTabEditor
  };
})();













