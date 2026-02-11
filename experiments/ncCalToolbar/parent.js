/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */

var { ExtensionCommon: { ExtensionAPI, EventManager, makeWidgetId } } =
  ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

this.ncCalToolbar = class extends ExtensionAPI {
  _roomCleanupKey() {
    return "_ncCalToolbarRoomCleanup";
  }

  onStartup() {
    const listenerId = "ext-ncCalToolbar-" + this.extension.id;
    this._listenerId = listenerId;

    ExtensionSupport.registerWindowListener(listenerId, {
      chromeURLs: [
        "chrome://calendar/content/calendar-event-dialog.xhtml",
        "chrome://messenger/content/messenger.xhtml"
      ],
      onLoadWindow: (window) => {
        try {
          this._ensureWindow(window);
        } catch (e) {
          console.error("[NCCalToolbar] ensure button failed", e);
        }
      }
    });

    // Also try to install into already open windows (e.g. hot reload during development).
    for (const window of ExtensionSupport.openWindows) {
      try {
        if (
          window.location?.href?.startsWith("chrome://calendar/content/calendar-event-dialog.xhtml") ||
          window.location?.href?.startsWith("chrome://messenger/content/messenger.xhtml")
        ) {
          this._ensureWindow(window);
        }
      } catch (e) {
        console.error("[NCCalToolbar] ensure button failed (openWindows)", e);
      }
    }
  }

  onShutdown() {
    if (this._listenerId) {
      ExtensionSupport.unregisterWindowListener(this._listenerId);
    }
    for (const window of ExtensionSupport.openWindows) {
      try {
        this._restoreMessengerHook(window);
        this._cleanupRoomCleanupInWindow(window);
        this._removeButton(window);
      } catch (e) {
        console.error("[NCCalToolbar] remove button failed", e);
      }
    }
  }

  _ensureWindow(window) {
    if (!window || !window.location) {
      return;
    }
    if (window.location.href.startsWith("chrome://messenger/content/messenger.xhtml")) {
      this._ensureMessengerHook(window);
    }
    this._ensureButton(window);
  }

  _ensureMessengerHook(window) {
    if (!window || !window.location) {
      return;
    }
    if (!window.location.href.startsWith("chrome://messenger/content/messenger.xhtml")) {
      return;
    }
    if (window._ncCalToolbarOrigOnLoadCalendarItemPanel) {
      return;
    }
    if (typeof window.onLoadCalendarItemPanel !== "function") {
      return;
    }
    const orig = window.onLoadCalendarItemPanel;
    window._ncCalToolbarOrigOnLoadCalendarItemPanel = orig;
    window.onLoadCalendarItemPanel = (...args) => {
      const res = orig.apply(window, args);
      try {
        this._ensureButton(window);
      } catch (e) {
        console.error("[NCCalToolbar] ensure button failed (onLoadCalendarItemPanel)", e);
      }
      return res;
    };
  }

  _restoreMessengerHook(window) {
    if (!window || !window.location) {
      return;
    }
    if (!window.location.href.startsWith("chrome://messenger/content/messenger.xhtml")) {
      return;
    }
    if (window._ncCalToolbarOrigOnLoadCalendarItemPanel) {
      window.onLoadCalendarItemPanel = window._ncCalToolbarOrigOnLoadCalendarItemPanel;
      window._ncCalToolbarOrigOnLoadCalendarItemPanel = null;
    }
  }

  _cleanupRoomCleanupTarget(targetWin) {
    if (!targetWin) {
      return;
    }
    const key = this._roomCleanupKey();
    const state = targetWin[key];
    if (!state || !Array.isArray(state.cleanup)) {
      targetWin[key] = null;
      return;
    }
    while (state.cleanup.length) {
      const fn = state.cleanup.pop();
      try {
        fn();
      } catch (_e) {}
    }
    targetWin[key] = null;
  }

  _cleanupRoomCleanupInWindow(window) {
    if (!window || !window.location) {
      return;
    }
    if (window.location.href.startsWith("chrome://calendar/content/calendar-event-dialog.xhtml")) {
      this._cleanupRoomCleanupTarget(window);
      return;
    }
    if (!window.location.href.startsWith("chrome://messenger/content/messenger.xhtml")) {
      return;
    }
    const tabmail = window.tabmail;
    const tabInfoList = tabmail && Array.isArray(tabmail.tabInfo) ? tabmail.tabInfo : [];
    for (const tabInfo of tabInfoList) {
      try {
        if (tabInfo?.mode?.name !== "calendarEvent") {
          continue;
        }
        const targetWin = tabInfo.iframe?.contentWindow || tabInfo.iframe?.contentDocument?.defaultView || null;
        this._cleanupRoomCleanupTarget(targetWin);
      } catch (e) {
        console.error("[NCCalToolbar] cleanup room state failed", e);
      }
    }
  }

  _buttonId() {
    const widgetId = makeWidgetId(this.extension.id);
    return `${widgetId}-ncCalToolbar-button`;
  }

  _toolbarIdForWindow(window) {
    if (!window || !window.location) {
      return null;
    }
    if (window.location.href.startsWith("chrome://calendar/content/calendar-event-dialog.xhtml")) {
      return "event-toolbar";
    }
    if (window.location.href.startsWith("chrome://messenger/content/messenger.xhtml")) {
      return "event-tab-toolbar";
    }
    return null;
  }

  _getEditedItemForWindow(window) {
    if (!window || !window.location) {
      return null;
    }
    if (window.location.href.startsWith("chrome://calendar/content/calendar-event-dialog.xhtml")) {
      const fromWindow = (win) => {
        if (!win) {
          return null;
        }
        // TB 140 dialog editor: the edited item is typically exposed on the dialog window.
        if (win.calendarItem) {
          return win.calendarItem;
        }
        // Some editor flows use gEvent.event.
        if (win.gEvent?.event) {
          return win.gEvent.event;
        }
        // Some editor flows pass the item via window.arguments[0].
        const arg0 = Array.isArray(win.arguments) ? win.arguments[0] : null;
        if (arg0?.calendarItem) {
          return arg0.calendarItem;
        }
        if (arg0?.calendarEvent) {
          return arg0.calendarEvent;
        }
        return null;
      };

      // Prefer the dialog window itself, then fall back to the embedded panel iframe.
      const direct = fromWindow(window);
      if (direct) {
        return direct;
      }
      const panelIframe = window.document?.getElementById?.("calendar-item-panel-iframe") || null;
      const panelWin = panelIframe?.contentWindow || panelIframe?.contentDocument?.defaultView || null;
      return fromWindow(panelWin);
    }
    if (window.location.href.startsWith("chrome://messenger/content/messenger.xhtml")) {
      const tabInfo = window.tabmail?.currentTabInfo || null;
      // Only act in the calendar event editor tab mode.
      if (tabInfo?.mode?.name !== "calendarEvent") {
        return null;
      }
      return tabInfo.iframe?.contentWindow?.calendarItem || null;
    }
    return null;
  }

  _getCleanupTargetWindow(window) {
    if (!window || !window.location) {
      return null;
    }
    if (window.location.href.startsWith("chrome://calendar/content/calendar-event-dialog.xhtml")) {
      return window;
    }
    if (window.location.href.startsWith("chrome://messenger/content/messenger.xhtml")) {
      const tabInfo = window.tabmail?.currentTabInfo || null;
      if (tabInfo?.mode?.name !== "calendarEvent") {
        return null;
      }
      return tabInfo.iframe?.contentWindow || tabInfo.iframe?.contentDocument?.defaultView || null;
    }
    return null;
  }

  _getDialogOuterId(window) {
    try {
      const windowType = window?.document?.documentElement?.getAttribute?.("windowtype") || "";
      if (windowType !== "Calendar:EventDialog" && windowType !== "Calendar:EventSummaryDialog") {
        return null;
      }
      const outerId = window?.docShell?.outerWindowID ?? window?.windowUtils?.outerWindowID;
      return typeof outerId === "number" ? outerId : null;
    } catch (e) {
      console.error("[NCCalToolbar] get dialog outer id failed", e);
      return null;
    }
  }

  _isWindowManagerType(windowType) {
    switch (windowType) {
      case "mail:3pane":
      case "msgcompose":
      case "mail:messageWindow":
      case "mail:extensionPopup":
        return true;
      default:
        return false;
    }
  }

  _getManagedWindowId(window) {
    try {
      const manager = this.extension?.windowManager;
      if (!manager || typeof manager.getWrapper !== "function") {
        return null;
      }
      const windowType = window?.document?.documentElement?.getAttribute?.("windowtype") || "";
      if (!this._isWindowManagerType(windowType)) {
        return null;
      }
      const wrapper = manager.getWrapper(window);
      const id = wrapper?.id;
      return typeof id === "number" ? id : null;
    } catch (e) {
      console.error("[NCCalToolbar] get managed window id failed", e);
      return null;
    }
  }

  _makeSnapshotFromItem(window, item) {
    if (!item) {
      return null;
    }
    const windowId = this._getManagedWindowId(window);
    const dialogOuterId = this._getDialogOuterId(window);
    const calendarId = item.calendar?.id ? String(item.calendar.id) : "";
    const id = item.id ? String(item.id) : "";
    const isTask = typeof item.isTodo === "function" ? item.isTodo() : false;
    const type = isTask ? "task" : "event";
    const ical = typeof item.icalString === "string" ? item.icalString : String(item.icalString || "");

    if (!ical) {
      return null;
    }
    const snapshot = { calendarId, id, type, format: "ical", item: ical };
    if (typeof windowId === "number") {
      snapshot.windowId = windowId;
    }
    if (typeof dialogOuterId === "number") {
      snapshot.dialogOuterId = dialogOuterId;
    }
    return snapshot;
  }

  _fireRoomCleanupEvent(evt) {
    if (typeof this._fireRoomCleanup !== "function") {
      return;
    }
    try {
      this._fireRoomCleanup(evt);
    } catch (e) {
      console.error("[NCCalToolbar] onRoomCleanup fire failed", e);
    }
  }

  _registerRoomCleanup(targetWin, token) {
    if (!targetWin || !token) {
      return { ok: false, error: "invalid_args" };
    }
    const key = this._roomCleanupKey();
    let state = targetWin[key];
    if (!state) {
      state = { token: null, cleanup: [] };
      targetWin[key] = state;
    }

    const cleanupState = () => this._cleanupRoomCleanupTarget(targetWin);

    const addListener = (type, handler, options) => {
      try {
        targetWin.addEventListener(type, handler, options);
        state.cleanup.push(() => {
          try {
            targetWin.removeEventListener(type, handler, options);
          } catch (_e) {}
        });
      } catch (e) {
        console.error("[NCCalToolbar] registerRoomCleanup addListener failed", e);
      }
    };

    if (state.token && state.token !== token) {
      this._fireRoomCleanupEvent({
        token: state.token,
        action: "superseded",
        reason: "re-registered"
      });
      cleanupState();
      state = { token: null, cleanup: [] };
      targetWin[key] = state;
    } else {
      cleanupState();
      state = { token: null, cleanup: [] };
      targetWin[key] = state;
    }

    state.token = token;

    const emitOnce = (action, reason) => {
      const current = state.token;
      if (!current) {
        return;
      }
      state.token = null;
      this._fireRoomCleanupEvent({ token: current, action, reason: reason || "" });
      cleanupState();
    };

    // Dialog editor: we can detect "saved" (dialogaccept) vs "discarded" (unload/cancel).
    const isDialog = !!(targetWin.location?.href || "").startsWith("chrome://calendar/content/calendar-event-dialog.xhtml");
    if (isDialog) {
      addListener("dialogaccept", () => emitOnce("persisted", "dialogaccept"), true);
      addListener("dialogextra1", () => emitOnce("persisted", "dialogextra1"), true);
      addListener("dialogcancel", () => emitOnce("discarded", "dialogcancel"), true);
      addListener("dialogextra2", () => emitOnce("discarded", "dialogextra2"), true);
    }

    // "unload" covers both dialog and tab editor close.
    addListener("unload", () => emitOnce("discarded", "unload"), true);

    return { ok: true };
  }

  _collectEventDocs(window) {
    const docs = [];
    const pushDoc = (doc) => {
      if (!doc || docs.includes(doc)) {
        return;
      }
      docs.push(doc);
    };

    try {
      pushDoc(window?.document || null);
    } catch (_e) {}

    try {
      if (window?.location?.href?.startsWith("chrome://calendar/content/calendar-event-dialog.xhtml")) {
        const iframe = window.document?.getElementById?.("calendar-item-panel-iframe") || null;
        pushDoc(iframe?.contentDocument || null);
      }
    } catch (_e) {}

    try {
      if (window?.location?.href?.startsWith("chrome://messenger/content/messenger.xhtml")) {
        const tabInfo = window.tabmail?.currentTabInfo || null;
        if (tabInfo?.mode?.name !== "calendarEvent") {
          return docs;
        }
        pushDoc(tabInfo.iframe?.contentDocument || null);
      }
    } catch (_e) {}

    return docs;
  }

  _findField(docs, selectors) {
    for (const doc of docs) {
      if (!doc || typeof doc.querySelector !== "function") {
        continue;
      }
      for (const selector of selectors) {
        try {
          const element = doc.querySelector(selector);
          if (element) {
            return element;
          }
        } catch (_e) {}
      }
    }
    return null;
  }

  _findDescriptionFieldInDocs(docs) {
    for (const doc of docs) {
      try {
        // TB 140: #item-description is the dedicated identifier. If changed in future TB, add a second selector and annotate the TB version.
        const host = doc.querySelector?.("editor#item-description") || null;
        let target = null;
        if (host) {
          target = host.inputField || host.contentDocument?.body || host;
        }
        if (!target) {
          // Future fallback (only if needed): "textarea#item-description"
          const fallback = doc.querySelector?.("textarea#item-description") || null;
          if (fallback) {
            target = fallback;
          }
        }
        if (target) {
          return target;
        }
      } catch (_e) {}
    }
    return null;
  }

  _dispatchInputEvent(field) {
    if (!field) {
      return;
    }
    try {
      const doc = field.ownerDocument || field.document;
      const win = doc?.defaultView;
      if (win) {
        field.dispatchEvent(new win.Event("input", { bubbles: true }));
      }
    } catch (_e) {}
  }

  _setFieldValue(field, value, opts = {}) {
    if (!field) {
      return;
    }
    const doc = field.ownerDocument || field.document || field.contentDocument || null;
    const execPreferred = opts.preferExec === true;

    const tryExecCommand = () => {
      if (!doc || typeof doc.execCommand !== "function") {
        return false;
      }
      try {
        field.focus?.();
        doc.execCommand("selectAll", false, null);
        doc.execCommand("insertText", false, value);
        return true;
      } catch (_e) {
        return false;
      }
    };

    if (execPreferred && tryExecCommand()) {
      this._dispatchInputEvent(field);
      return;
    }

    if ("value" in field) {
      try {
        field.focus?.();
      } catch (_e) {}
      field.value = value;
      this._dispatchInputEvent(field);
      return;
    }

    if ((field.isContentEditable || field.tagName?.toLowerCase?.() === "body") && tryExecCommand()) {
      this._dispatchInputEvent(field);
      return;
    }

    if (field.textContent !== undefined) {
      field.textContent = value;
      this._dispatchInputEvent(field);
    }
  }

  _resolveEditorWindow(editor) {
    const ref = editor && typeof editor === "object" ? editor : {};
    const dialogOuterId = ref.dialogOuterId;
    const windowId = ref.windowId;

    if (typeof dialogOuterId === "number") {
      if (typeof Services === "undefined" || !Services?.wm?.getOuterWindowWithId) {
        return null;
      }
      try {
        const win = Services.wm.getOuterWindowWithId(dialogOuterId);
        return win && !win.closed ? win : null;
      } catch (e) {
        console.error("[NCCalToolbar] resolve dialog window failed", e);
        return null;
      }
    }

    if (typeof windowId === "number") {
      const manager = this.extension?.windowManager;
      if (!manager || typeof manager.get !== "function") {
        return null;
      }
      try {
        const winObj = manager.get(windowId);
        const win = winObj?.window || null;
        return win && !win.closed ? win : null;
      } catch (e) {
        console.error("[NCCalToolbar] resolve windowId failed", e);
        return null;
      }
    }

    return null;
  }

  _ensureButton(window) {
    const toolbarId = this._toolbarIdForWindow(window);
    if (!toolbarId) {
      return;
    }
    const { document } = window;
    const toolbar = document.getElementById(toolbarId);
    if (!toolbar) {
      // In the event dialog, wait briefly for the toolbar to appear.
      if (window.location?.href?.startsWith("chrome://calendar/content/calendar-event-dialog.xhtml")) {
        const observer = new window.MutationObserver(() => {
          try {
            observer.disconnect();
          } catch (e) {
            console.error("[NCCalToolbar] observer disconnect failed", e);
          }
          try {
            this._ensureButton(window);
          } catch (e) {
            console.error("[NCCalToolbar] ensure button failed (observer)", e);
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.setTimeout(() => {
          try {
            observer.disconnect();
          } catch (e) {
            console.error("[NCCalToolbar] observer disconnect failed (timeout)", e);
          }
        }, 5000);
      }
      return;
    }

    const buttonId = this._buttonId();
    if (document.getElementById(buttonId)) {
      return;
    }

    const button = document.createXULElement("toolbarbutton");
    button.id = buttonId;
    button.setAttribute("class", "toolbarbutton-1");
    button.setAttribute("label", this.extension.localize("__MSG_ui_insert_button_label__"));
    button.setAttribute("tooltiptext", this.extension.localize("__MSG_ui_insert_button_label__"));
    button.setAttribute("type", "button");
    button.setAttribute("image", this.extension.getURL("icons/app-16.png"));

    button.addEventListener("command", () => {
      try {
        const item = this._getEditedItemForWindow(window);
        const snapshot = this._makeSnapshotFromItem(window, item);
        if (!snapshot) {
          console.error("[NCCalToolbar] click without editable item snapshot");
          return;
        }
        if (typeof this._fireClicked === "function") {
          this._fireClicked(snapshot);
        }
      } catch (e) {
        console.error("[NCCalToolbar] click handler failed", e);
      }
    });

    // Place the button rightmost.
    toolbar.appendChild(button);
  }

  _removeButton(window) {
    if (!window || !window.document) {
      return;
    }
    const id = this._buttonId();
    const node = window.document.getElementById(id);
    if (node) {
      node.remove();
    }
  }

  getAPI(context) {
    return {
      ncCalToolbar: {
        onClicked: new EventManager({
          context,
          name: "ncCalToolbar.onClicked",
          register: (fire) => {
            this._fireClicked = (snapshot) => fire.async(snapshot);
            return () => {
              this._fireClicked = null;
            };
          }
        }).api(),
        onRoomCleanup: new EventManager({
          context,
          name: "ncCalToolbar.onRoomCleanup",
          register: (fire) => {
            this._fireRoomCleanup = (evt) => fire.async(evt);
            return () => {
              this._fireRoomCleanup = null;
            };
          }
        }).api(),
        applyEventFields: async (details) => {
          const editor = details?.editor || {};
          const fields = details?.fields || {};
          const win = this._resolveEditorWindow(editor);
          if (!win) {
            return { ok: false, error: "target_window_unavailable" };
          }
          const docs = this._collectEventDocs(win);
          const titleField = this._findField(docs, ["#item-title"]);
          const locationField = this._findField(docs, ["#item-location"]);
          const descField = this._findDescriptionFieldInDocs(docs);

          if (typeof fields.title === "string" && titleField) {
            this._setFieldValue(titleField, fields.title);
          }
          if (typeof fields.location === "string" && locationField) {
            this._setFieldValue(locationField, fields.location);
          }
          if (typeof fields.description === "string" && descField) {
            this._setFieldValue(descField, fields.description, { preferExec: true });
          }

          return {
            ok: true,
            applied: {
              title: !!titleField && typeof fields.title === "string",
              location: !!locationField && typeof fields.location === "string",
              description: !!descField && typeof fields.description === "string"
            }
          };
        },
        setItemProperties: async (details) => {
          const editor = details?.editor || {};
          const properties = details?.properties && typeof details.properties === "object" ? details.properties : {};
          const win = this._resolveEditorWindow(editor);
          if (!win) {
            return { ok: false, error: "target_window_unavailable" };
          }
          const item = this._getEditedItemForWindow(win);
          if (!item || typeof item.setProperty !== "function") {
            return { ok: false, error: "no_calendar_item" };
          }

          const setProp = (name, value) => {
            try {
              if (value == null || value === "") {
                if (typeof item.deleteProperty === "function") {
                  item.deleteProperty(name);
                } else {
                  item.setProperty(name, "");
                }
              } else {
                item.setProperty(name, String(value));
              }
            } catch (_e) {}
          };

          for (const [name, value] of Object.entries(properties)) {
            if (!name) {
              continue;
            }
            setProp(name, value);
          }
          return { ok: true };
        },
        registerRoomCleanup: async (details) => {
          const editor = details?.editor || {};
          const token = (details?.token || "").trim();
          if (!token) {
            return { ok: false, error: "token_missing" };
          }
          const win = this._resolveEditorWindow(editor);
          if (!win) {
            return { ok: false, error: "target_window_unavailable" };
          }
          const target = this._getCleanupTargetWindow(win);
          if (!target) {
            return { ok: false, error: "no_editor_context" };
          }
          return this._registerRoomCleanup(target, token);
        }
      }
    };
  }
};
