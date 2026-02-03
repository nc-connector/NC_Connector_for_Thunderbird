/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Minimal experiment bridge for the calendar dialog.
 * Registers window listeners and exposes a WebExtension bridge.
 */
'use strict';

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

const BRIDGE_SCRIPT_PATH = "ui/calToolbarDialog.js";
const CAL_SHARED_PATH = "ui/calToolbarShared.js";
const CALENDAR_WINDOW_URLS = [
  "chrome://calendar/content/calendar-event-dialog.xhtml",
  "chrome://messenger/content/messenger.xhtml"
];
const WINDOW_LISTENER_ID = "ext-nextcloud-enterprise-thunderbird";

class CalToolbarExperiment {
  constructor(context) {
    this.context = context;
    this.extension = context.extension;
    this.calSharedUrl = "";
    this.stopListening = null;
    this.createHandlers = new Set();
    this.utilityHandlers = new Set();
  }

  close() {
    if (this.stopListening) {
      this.stopListening();
      this.stopListening = null;
    }
    this.createHandlers.clear();
    this.utilityHandlers.clear();
  }

  getAPI() {
    const createEvent = new ExtensionCommon.EventManager({
      context: this.context,
      name: "calToolbar.onCreateRequest",
      register: (fire) => {
        this.createHandlers.add(fire);
        return () => this.createHandlers.delete(fire);
      }
    });
    const utilityEvent = new ExtensionCommon.EventManager({
      context: this.context,
      name: "calToolbar.onUtilityRequest",
      register: (fire) => {
        this.utilityHandlers.add(fire);
        return () => this.utilityHandlers.delete(fire);
      }
    });

    return {
      calToolbar: {
        onCreateRequest: createEvent.api(),
        onUtilityRequest: utilityEvent.api(),
        init: (opts = {}) => this.init(opts),
        invokeWindow: (options = {}) => this.invokeWindow(options)
      }
    };
  }

  i18n(key, substitutions = []) {
    const localeData = this.extension?.localeData;
    if (localeData && typeof localeData.localizeMessage === "function") {
      const message = localeData.localizeMessage(key, substitutions);
      if (message) {
        return message;
      }
    }
    if (Array.isArray(substitutions) && substitutions.length) {
      return String(substitutions[0] ?? "");
    }
    return key;
  }

  ensureCalUtilsInWindow(win) {
    if (!win) return null;
    if (win.NCTalkCalUtils) return win.NCTalkCalUtils;
    if (typeof Services === "undefined" || !Services?.scriptloader) return null;
    const url = this.calSharedUrl || (this.extension?.getURL ? this.extension.getURL(CAL_SHARED_PATH) : "");
    if (!url) return null;
    this.calSharedUrl = url;
    try {
      Services.scriptloader.loadSubScript(url, win, "UTF-8");
    } catch (e) {
      console.error("[NCExp] shared utils window load failed", e);
      return null;
    }
    return win.NCTalkCalUtils || null;
  }

  async dispatchHandlers(set, payload) {
    if (!set || set.size === 0) return null;
    for (const fire of set) {
      try {
        const result = await fire.async(payload);
        if (result !== undefined) {
          return result;
        }
      } catch (e) {
        console.error("[NCExp] handler error", e);
      }
    }
    return null;
  }

  createBridgeAPI(init = {}) {
    const state = {
      label: init.label || this.i18n("ui_insert_button_label"),
      tooltip: init.tooltip || this.i18n("ui_toolbar_tooltip"),
      windowId: init.windowId || null
    };
    return {
      get label() { return state.label; },
      get tooltip() { return state.tooltip; },
      get windowId() { return state.windowId; },
      updateInit: (opts = {}) => {
        if (typeof opts.label === "string") state.label = opts.label;
        if (typeof opts.tooltip === "string") state.tooltip = opts.tooltip;
        if (typeof opts.windowId === "number") state.windowId = opts.windowId;
      },
      i18n: (key, subs) => this.i18n(key, subs),
      getURL: (path) => this.extension?.getURL?.(path || "") || "",
      requestCreate: (payload) => this.dispatchHandlers(this.createHandlers, payload || {}),
      requestUtility: (payload = {}) => this.dispatchHandlers(this.utilityHandlers, payload),
      openDialog: async () => {
        const windowId = state.windowId || null;
        return this.dispatchHandlers(this.utilityHandlers, {
          type: "openDialog",
          windowId
        });
      }
    };
  }

  dispatchBridgeRefresh(win) {
    const eventCtor = win?.CustomEvent || win?.Event;
    if (typeof win?.dispatchEvent === "function" && typeof eventCtor === "function") {
      win.dispatchEvent(new eventCtor("nctalk-bridge-refresh"));
    }
  }

  /**
   * Inject the calendar bridge API and dialog helpers into a window.
   * @param {Window} win
   * @param {object} init
   * @returns {boolean}
   */
  installBridge(win, init) {
    if (!win || !win.document) return false;
    const windowId = this.getWindowIdFromWindow(win);
    const initWithId = Object.assign({}, init, { windowId });
    const api = this.createBridgeAPI(initWithId);
    const utils = this.ensureCalUtilsInWindow(win);
    if (!utils) {
      console.error("[NCExp] shared utils missing in window");
    }
    if (win.NCTalkBridge && typeof win.NCTalkBridge.updateInit === "function") {
      win.NCTalkBridge.updateInit(initWithId);
      this.dispatchBridgeRefresh(win);
    } else {
      Object.defineProperty(win, "NCTalkBridge", {
        value: api,
        configurable: true
      });
    }
    if (win.NCTalkBridgeLoaded) {
      this.dispatchBridgeRefresh(win);
      return true;
    }
    try {
      Services.scriptloader.loadSubScript(
        this.extension.getURL(BRIDGE_SCRIPT_PATH),
        win,
        "UTF-8"
      );
      win.NCTalkBridgeLoaded = true;
      this.dispatchBridgeRefresh(win);
      return true;
    } catch (e) {
      console.error("[NCExp] bridge script load failed", e);
      return false;
    }
  }

  registerWindowListener(init) {
    /**
     * Inject the bridge into a newly opened calendar-related window.
     * @param {Window} win
     */
    const onLoadWindow = (win) => {
      if (!win) return;
      /**
       * Inject the dialog bridge after the window finishes loading.
       */
      const inject = () => {
        if (this.installBridge(win, init)) {
          console.log("[NCExp] bridge injected window");
        }
      };
      if (win.document?.readyState === "complete") {
        inject();
      } else {
        /**
         * Wait for the window to finish loading before injecting.
         */
        const onLoad = () => {
          win.removeEventListener("load", onLoad);
          inject();
        };
        win.addEventListener("load", onLoad, { once: true });
      }
    };

    ExtensionSupport.registerWindowListener(WINDOW_LISTENER_ID, {
      chromeURLs: CALENDAR_WINDOW_URLS,
      onLoadWindow
    });

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      try {
        ExtensionSupport.unregisterWindowListener(WINDOW_LISTENER_ID);
      } catch (e) {
        console.error("[NCExp] window listener cleanup failed", e);
      }
    };
  }

  async init(opts = {}) {
    const label = opts.label || this.i18n("ui_insert_button_label");
    const tooltip = opts.tooltip || this.i18n("ui_toolbar_tooltip");
    try {
      if (this.stopListening) {
        this.stopListening();
        this.stopListening = null;
      }
      this.stopListening = this.registerWindowListener({ label, tooltip });
      return true;
    } catch (e) {
      console.error("[NCExp] init error", e);
      if (this.stopListening) {
        this.stopListening();
        this.stopListening = null;
      }
      return false;
    }
  }

  resolveManagedWindow(win) {
    if (!win) return null;
    const windowType = win.document?.documentElement?.getAttribute("windowtype") || "";
    if (this.isWindowManagerType(windowType)) {
      return win;
    }
    let current = win;
    for (let depth = 0; depth < 4; depth++) {
      const opener = current?.opener;
      if (!opener || opener === current) return null;
      const openerType = opener?.document?.documentElement?.getAttribute("windowtype") || "";
      if (this.isWindowManagerType(openerType)) {
        return opener;
      }
      current = opener;
    }
    return null;
  }

  /**
   * Resolve the WebExtension window id for a given Thunderbird window.
   * @param {Window} win
   * @returns {number|null}
   */
  getWindowIdFromWindow(win) {
    const manager = this.extension?.windowManager;
    if (!manager || typeof manager.getWrapper !== "function") return null;
    const targetWindow = this.resolveManagedWindow(win);
    if (!targetWindow) return null;
    const wrapper = manager.getWrapper(targetWindow);
    if (!wrapper) return null;
    const id = wrapper.id;
    return typeof id === "number" ? id : null;
  }

  isWindowManagerType(windowType) {
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

  resolveActionWindow(win, payload) {
    if (!payload || typeof payload !== "object") {
      return win;
    }
    const outerId = payload._dialogOuterId;
    if (typeof outerId !== "number") {
      return win;
    }
    if (typeof Services === "undefined" || !Services?.wm?.getOuterWindowWithId) {
      console.error("[NCExp] dialog window lookup unavailable");
      return null;
    }
    const dialogWin = Services.wm.getOuterWindowWithId(outerId);
    if (dialogWin && !dialogWin.closed) {
      return dialogWin;
    }
    console.error("[NCExp] dialog window not available", outerId);
    return null;
  }

  /**
   * Look up a native window by WebExtension window id.
   * @param {number} windowId
   * @returns {Window|null}
   */
  getWindowById(windowId) {
    if (typeof windowId !== "number") return null;
    const windowObject = this.extension.windowManager.get(windowId);
    if (!windowObject) return null;
    return windowObject.window;
  }
  /**
   * Dispatch a request to a specific window and execute an action in that context.
   * @param {{windowId:number,action:string,payload?:object}} options
   * @returns {Promise<any>}
   */
  async invokeWindow(options = {}) {
    const windowId = options.windowId;
    const action = options.action;
    const payload = options.payload || {};
    if (typeof windowId !== "number" || !action) {
      throw new Error("windowId and action are required");
    }
    const win = this.getWindowById(windowId);
    if (!win || win.closed) {
      throw new Error("target window not available");
    }
    return await this.executeWindowAction(win, action, payload);
  }

  /**
   * Execute an action against a target window using injected shared utils.
   * @param {Window} win
   * @param {string} action
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async executeWindowAction(win, action, payload) {
    const actionPayload = payload && typeof payload === "object" ? { ...payload } : payload;
    if (actionPayload && typeof actionPayload === "object" && "_dialogOuterId" in actionPayload) {
      delete actionPayload._dialogOuterId;
    }
    const targetWin = this.resolveActionWindow(win, payload);
    if (!targetWin || targetWin.closed) {
      return { ok: false, error: "target_window_unavailable" };
    }
    const utils = this.ensureCalUtilsInWindow(targetWin);
    if (!utils) {
      return { ok: false, error: "cal_utils_unavailable" };
    }
    switch (action) {
      case "ping":
        return { ok: true };
      case "getTalkMetadata":
        return { ok: true, metadata: utils.readTalkMetadataFromDocument(targetWin.document) || {} };
      case "setTalkMetadata":
        return utils.setTalkMetadataOnWindow(targetWin, actionPayload || {});
      case "getEventSnapshot":
        return utils.getEventSnapshotFromWindow(targetWin) || { ok: false, error: "snapshot_failed" };
      case "applyEventFields":
        return utils.applyEventFieldsOnWindow(targetWin, actionPayload || {}, { preferExecForDescription: true })
          || { ok: false, error: "apply_failed" };
      case "registerCleanup":
        if (typeof targetWin.NCTalkRegisterCleanup === "function") {
          return await targetWin.NCTalkRegisterCleanup(actionPayload || {});
        }
        return { ok: false, error: "register_cleanup_unavailable" };
      default:
        return { ok: false, error: "unknown_action" };
    }
  }
}

this.calToolbar = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const impl = new CalToolbarExperiment(context);
    context.callOnClose(impl);
    return impl.getAPI();
  }
};



