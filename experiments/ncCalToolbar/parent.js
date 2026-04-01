/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
"use strict";

var {
  ExtensionCommon: { ExtensionAPI, EventManager, makeWidgetId },
} = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var {
  ExtensionUtils: { ExtensionError },
} = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

const EVENT_DIALOG_URL = "chrome://calendar/content/calendar-event-dialog.xhtml";
const EVENT_TAB_IFRAME_URL = "chrome://calendar/content/calendar-item-iframe.xhtml";
const MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";
const EVENT_PANEL_IFRAME_ID = "calendar-item-panel-iframe";
const OPAQUE_EDITOR_ID_PATTERN =
  /^ed-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRIDGE_SYMBOL = Symbol("nc-cal-toolbar-editor-context-bridge");
const TAB_EDITOR_MODES = new Set(["calendarEvent", "calendarTask"]);
const STARTUP_RETRY_DELAYS_MS = [40, 80, 150, 300, 500, 800, 1200, 1800];

/**
 * Create an opaque editor identifier.
 * @returns {string}
 */
function createEditorId() {
  const uuid = Services.uuid
    .generateUUID()
    .toString()
    .slice(1, -1)
    .toLowerCase();
  return `ed-${uuid}`;
}

/**
 * Maintains deterministic mapping between UI targets (dialog/tab) and opaque editor IDs.
 */
class EditorContextBridge {
  /**
   * @param {object} extension
   */
  constructor(extension) {
    this.extension = extension;
    this.targetToEditorId = new Map();
    this.editorIdToTarget = new Map();
  }

  /**
   * Validate and normalize an opaque editor identifier.
   * @param {string} editorId
   * @returns {string}
   */
  normalizeEditorId(editorId) {
    if (typeof editorId != "string") {
      return "";
    }
    const value = editorId.trim();
    if (!value) {
      return "";
    }
    return OPAQUE_EDITOR_ID_PATTERN.test(value) ? value : "";
  }

  /**
   * Register a target and assign a stable editorId.
   * @param {"tab"|"dialog"} kind
   * @param {number} id
   * @param {number} instanceId
   * @returns {string}
   */
  _register(kind, id, instanceId = 0) {
    if (
      (kind != "tab" && kind != "dialog") ||
      !Number.isInteger(id) ||
      !Number.isInteger(instanceId)
    ) {
      return "";
    }
    const key = `${kind}:${id}:${instanceId}`;
    const existing = this.targetToEditorId.get(key);
    if (existing) {
      return existing;
    }
    const editorId = createEditorId();
    this.targetToEditorId.set(key, editorId);
    this.editorIdToTarget.set(editorId, { key, kind, id, instanceId });
    return editorId;
  }

  /**
   * Register a tab-based editor target.
   * @param {number} tabId
   * @param {number} editorOuterId
   * @returns {string}
   */
  registerTabTarget(tabId, editorOuterId = 0) {
    return this._register("tab", tabId, editorOuterId);
  }

  /**
   * Register a dialog-based editor target.
   * @param {number} dialogOuterId
   * @returns {string}
   */
  registerDialogTarget(dialogOuterId) {
    return this._register("dialog", dialogOuterId, dialogOuterId);
  }

  /**
   * Resolve an editorId back to its target mapping.
   * @param {string} editorId
   * @returns {{kind:"tab"|"dialog",id:number,instanceId:number}|null}
   */
  resolveTarget(editorId) {
    const normalized = this.normalizeEditorId(editorId);
    if (!normalized) {
      return null;
    }
    const target = this.editorIdToTarget.get(normalized);
    if (!target) {
      return null;
    }
    return { kind: target.kind, id: target.id, instanceId: target.instanceId };
  }

  /**
   * Release all bridge entries for one editorId.
   * @param {string} editorId
   */
  releaseEditorId(editorId) {
    const normalized = this.normalizeEditorId(editorId);
    if (!normalized) {
      return;
    }
    const target = this.editorIdToTarget.get(normalized);
    if (!target) {
      return;
    }
    this.editorIdToTarget.delete(normalized);
    this.targetToEditorId.delete(target.key);
  }

  /**
   * Clear bridge state and detach from extension context.
   */
  clear() {
    this.targetToEditorId.clear();
    this.editorIdToTarget.clear();
    if (this.extension[BRIDGE_SYMBOL] == this) {
      delete this.extension[BRIDGE_SYMBOL];
    }
  }
}

/**
 * Get or create the editor context bridge bound to extension context.
 * @param {object} extension
 * @returns {EditorContextBridge}
 */
function getEditorBridge(extension) {
  let bridge = extension[BRIDGE_SYMBOL];
  if (!bridge || !(bridge instanceof EditorContextBridge)) {
    bridge = new EditorContextBridge(extension);
    extension[BRIDGE_SYMBOL] = bridge;
  }
  return bridge;
}

this.ncCalToolbar = class extends ExtensionAPI {
  /**
   * Register window listeners and initialize existing windows.
   */
  onStartup() {
    this._listenerId = "ext-ncCalToolbar-" + this.extension.id;
    this._listenerRegistered = false;
    this._startupRetryCount = 0;
    this._startupRetryPending = false;
    this._startupRetryTimer = null;
    this._registerWindowListenerWhenReady();
  }

  /**
   * Unregister listeners and cleanup injected UI/hooks.
   */
  onShutdown() {
    const extensionSupport = this._getExtensionSupport();
    if (this._listenerId && this._listenerRegistered && extensionSupport) {
      extensionSupport.unregisterWindowListener(this._listenerId);
      this._listenerRegistered = false;
    } else if (this._listenerId && this._listenerRegistered && !extensionSupport) {
      this._logError("shutdown: ExtensionSupport unavailable during unregister", null, {
        listenerId: this._listenerId,
      });
      this._listenerRegistered = false;
    }
    if (this._listenerId) {
      this._listenerId = null;
    }
    this._clearStartupRetryTimer();
    this._startupRetryPending = false;
    this._startupRetryCount = 0;
    const openWindows = extensionSupport?.openWindows || [];
    for (const window of openWindows) {
      try {
        this._restoreMessengerHook(window);
      } catch (error) {
        this._logError("shutdown: restore messenger hook failed", error, {
          href: window?.location?.href || "",
        });
      }
      try {
        this._cleanupLifecycleInWindow(window);
      } catch (error) {
        this._logError("shutdown: cleanup lifecycle in window failed", error, {
          href: window?.location?.href || "",
        });
      }
      try {
        this._removeButton(window);
      } catch (error) {
        this._logError("shutdown: remove button failed", error, {
          href: window?.location?.href || "",
        });
      }
    }
    if (this._editorClosedListeners) {
      this._editorClosedListeners.clear();
    }
    if (this._onClickedByContext) {
      this._onClickedByContext = null;
    }
    if (this._clickedListeners) {
      this._clickedListeners.clear();
    }
    if (this._onClosedByContext) {
      this._onClosedByContext = null;
    }
    if (this._apiContextCloseByContext) {
      this._apiContextCloseByContext = null;
    }
    if (this._editorBridge) {
      this._editorBridge.clear();
      this._editorBridge = null;
    }
  }

  /**
   * Return the global ExtensionSupport object if it is fully available.
   * Uses the experiment global directly (no local module re-import).
   * @returns {object|null}
   */
  _getExtensionSupport() {
    const extensionSupport = globalThis.ExtensionSupport;
    if (!extensionSupport) {
      return null;
    }
    if (
      typeof extensionSupport.registerWindowListener != "function" ||
      typeof extensionSupport.unregisterWindowListener != "function" ||
      !extensionSupport.openWindows
    ) {
      return null;
    }
    return extensionSupport;
  }

  /**
   * Register the experiment window listener when ExtensionSupport becomes available.
   * Avoids intermittent startup crashes when the global is not yet initialized.
   */
  _registerWindowListenerWhenReady() {
    if (this._listenerRegistered || !this._listenerId) {
      return;
    }
    this._clearStartupRetryTimer();
    const extensionSupport = this._getExtensionSupport();
    if (!extensionSupport) {
      this._startupRetryCount = Number(this._startupRetryCount || 0) + 1;
      const delayIndex = Math.min(
        this._startupRetryCount - 1,
        STARTUP_RETRY_DELAYS_MS.length - 1
      );
      const delayMs = STARTUP_RETRY_DELAYS_MS[delayIndex];
      if (this._startupRetryCount == 1 || this._startupRetryCount % 10 == 0) {
        this._logError("startup: ExtensionSupport unavailable, retry scheduled", null, {
          attempt: this._startupRetryCount,
          delayMs,
        });
      }
      if (this._startupRetryCount >= 120) {
        this._logError("startup: ExtensionSupport unavailable after retry limit", null, {
          attempts: this._startupRetryCount,
        });
        return;
      }
      if (this._startupRetryPending) {
        return;
      }
      this._startupRetryPending = true;
      this._scheduleStartupRetry(delayMs);
      return;
    }
    extensionSupport.registerWindowListener(this._listenerId, {
      chromeURLs: [EVENT_DIALOG_URL, MESSENGER_URL],
      onLoadWindow: window => this._ensureWindow(window),
    });
    this._listenerRegistered = true;
    this._startupRetryCount = 0;
    for (const window of extensionSupport.openWindows) {
      const href = window?.location?.href || "";
      if (href.startsWith(EVENT_DIALOG_URL) || href.startsWith(MESSENGER_URL)) {
        this._ensureWindow(window);
      }
    }
  }

  /**
   * Log experiment errors with a consistent prefix.
   * @param {string} message
   * @param {any} error
   * @param {object|null} details
   */
  _logError(message, error, details = null) {
    if (details) {
      console.error(`[ncCalToolbar] ${message}`, details, error);
      return;
    }
    console.error(`[ncCalToolbar] ${message}`, error);
  }

  /**
   * Register context-scoped cleanup handler for this API surface.
   * @param {object} context
   */
  _registerApiContextClose(context) {
    if (!context || typeof context.callOnClose != "function") {
      return;
    }
    if (!this._apiContextCloseByContext) {
      this._apiContextCloseByContext = new WeakMap();
    }
    if (this._apiContextCloseByContext.has(context)) {
      return;
    }
    const closer = {
      close: () => this._onApiContextClose(context),
    };
    this._apiContextCloseByContext.set(context, closer);
    context.callOnClose(closer);
  }

  /**
   * Cleanup listeners and references bound to one extension API context.
   * @param {object} context
   */
  _onApiContextClose(context) {
    const clickListeners = this._onClickedByContext?.get(context) || null;
    if (clickListeners) {
      for (const listener of clickListeners) {
        this._removeClickedListener(listener);
      }
      this._onClickedByContext.delete(context);
    }

    const listeners = this._onClosedByContext?.get(context) || null;
    if (listeners) {
      for (const listener of listeners) {
        this._removeEditorClosedListener(listener);
      }
      this._onClosedByContext.delete(context);
    }
    this._apiContextCloseByContext?.delete(context);
  }

  /**
   * Return the lazily initialized editor bridge.
   * @returns {EditorContextBridge}
   */
  _bridge() {
    if (!this._editorBridge) {
      this._editorBridge = getEditorBridge(this.extension);
    }
    return this._editorBridge;
  }

  /**
   * Compute extension-scoped id of the official calendarItemAction toolbarbutton.
   * @returns {string}
   */
  _buttonId() {
    return `${makeWidgetId(this.extension.id)}-calendarItemAction-toolbarbutton`;
  }

  /**
   * Check whether a window is a calendar editor (dialog or tab iframe).
   * @param {Window} window
   * @returns {boolean}
   */
  _isEditorWindow(window) {
    const href = window?.location?.href || "";
    return href.startsWith(EVENT_DIALOG_URL) || href.startsWith(EVENT_TAB_IFRAME_URL);
  }

  /**
   * Check whether a tabInfo references a calendar editor tab.
   * @param {object} tabInfo
   * @returns {boolean}
   */
  _isEditorTab(tabInfo) {
    const mode = tabInfo?.mode?.name || "";
    if (TAB_EDITOR_MODES.has(mode)) {
      return true;
    }
    const win = tabInfo?.iframe?.contentWindow || tabInfo?.iframe?.contentDocument?.defaultView || null;
    return this._isEditorWindow(win);
  }

  /**
   * Resolve toolbar ID for dialog or messenger window.
   * @param {Window} window
   * @returns {string}
   */
  _toolbarId(window) {
    const href = window?.location?.href || "";
    if (href.startsWith(EVENT_DIALOG_URL)) {
      return "event-toolbar";
    }
    if (href.startsWith(MESSENGER_URL)) {
      return "event-tab-toolbar";
    }
    return "";
  }

  /**
   * Get selected tabInfo from messenger tabmail.
   * @param {Window} window
   * @returns {object|null}
   */
  _selectedTabInfo(window) {
    const tabmail = window?.tabmail || null;
    const infos = Array.isArray(tabmail?.tabInfo) ? tabmail.tabInfo : [];
    if (!infos.length) {
      return null;
    }
    const index = tabmail?.tabContainer?.selectedIndex;
    if (Number.isInteger(index) && index >= 0 && index < infos.length) {
      return infos[index];
    }
    return tabmail.currentTabInfo || null;
  }

  /**
   * Resolve managed tab id from tabInfo.
   * @param {object} tabInfo
   * @returns {number|null}
   */
  _managedTabId(tabInfo) {
    const manager = this.extension?.tabManager;
    if (!manager || typeof manager.getWrapper != "function") {
      return null;
    }
    if (!this._isEditorTab(tabInfo)) {
      return null;
    }
    try {
      const id = manager.getWrapper(tabInfo)?.id;
      return typeof id == "number" ? id : null;
    } catch (error) {
      this._logError("managed tab id resolution failed", error);
      return null;
    }
  }

  /**
   * Resolve outer window ID for event dialog windows.
   * @param {Window} window
   * @returns {number|null}
   */
  _dialogOuterId(window) {
    const windowType = window?.document?.documentElement?.getAttribute?.("windowtype") || "";
    if (windowType != "Calendar:EventDialog" && windowType != "Calendar:EventSummaryDialog") {
      return null;
    }
    const outerId = window?.docShell?.outerWindowID ?? window?.windowUtils?.outerWindowID;
    return typeof outerId == "number" ? outerId : null;
  }

  /**
   * Resolve generic editor outer window ID.
   * @param {Window} window
   * @returns {number|null}
   */
  _editorOuterId(window) {
    const outerId = window?.docShell?.outerWindowID ?? window?.windowUtils?.outerWindowID;
    return typeof outerId == "number" ? outerId : null;
  }

  /**
   * Find tabInfo corresponding to an editor iframe window.
   *
   * Temporary ESR bridge:
   * - This explicit iframe -> tabInfo correlation is required to derive a stable
   *   editor identity for tab editors on ESR 140.
   * - A manual window/context mapping already existed in add-on 2.2.7
   *   (`windowId`/`dialogOuterId` based).
   * - Reason for hardening in 3.0.0: in tab-editor flows, `windowId` could only
   *   identify the 3-pane host window, while editor operations resolved through
   *   selected `currentTabInfo`. After tab switches or with multiple open editor
   *   tabs, this could target the wrong editor context.
   * - In 3.0.0 this was tightened to opaque `editorId` mapping to achieve a
   *   deterministic API contract aligned with upstream PR #65.
   * - Remove this correlation once upstream calendar APIs provide the same
   *   deterministic editor-targeting contract.
   *
   * @param {Window} window
   * @returns {object|null}
   */
  _tabInfoForEditorWindow(window) {
    if (!this._isEditorWindow(window)) {
      return null;
    }
    const owner = window?.ownerGlobal || null;
    if (!owner || owner.location?.href != MESSENGER_URL) {
      return null;
    }
    const infos = owner.tabmail && Array.isArray(owner.tabmail.tabInfo) ? owner.tabmail.tabInfo : [];
    for (const tabInfo of infos) {
      if (!this._isEditorTab(tabInfo)) {
        continue;
      }
      const tabWindow = tabInfo.iframe?.contentWindow || tabInfo.iframe?.contentDocument?.defaultView || null;
      if (tabWindow == window) {
        return tabInfo;
      }
    }
    return null;
  }

  /**
   * Resolve editorId for the selected editor tab from messenger context.
   *
   * Note:
   * - This uses explicit tab/iframe resolution instead of generic active-tab
   *   heuristics to keep click/context targeting deterministic.
   * - The logic is intentionally scoped to calendar editor surfaces only.
   *
   * @param {Window} window
   * @returns {string}
   */
  _tabEditorIdFromMessenger(window) {
    if (window?.location?.href != MESSENGER_URL) {
      return "";
    }
    const tabInfo = this._selectedTabInfo(window);
    if (!this._isEditorTab(tabInfo)) {
      return "";
    }
    const tabId = this._managedTabId(tabInfo);
    if (typeof tabId != "number") {
      return "";
    }
    const tabWindow = tabInfo?.iframe?.contentWindow || tabInfo?.iframe?.contentDocument?.defaultView || null;
    const outerId = this._editorOuterId(tabWindow);
    if (typeof outerId != "number") {
      return "";
    }
    return this._bridge().registerTabTarget(tabId, outerId);
  }

  /**
   * Resolve editorId for a known editor iframe window.
   * @param {Window} window
   * @returns {string}
   */
  _tabEditorIdFromEditorWindow(window) {
    const tabInfo = this._tabInfoForEditorWindow(window);
    if (!tabInfo) {
      return "";
    }
    const tabId = this._managedTabId(tabInfo);
    if (typeof tabId != "number") {
      return "";
    }
    const tabWindow = tabInfo?.iframe?.contentWindow || tabInfo?.iframe?.contentDocument?.defaultView || null;
    const outerId = this._editorOuterId(tabWindow);
    if (typeof outerId != "number") {
      return "";
    }
    return this._bridge().registerTabTarget(tabId, outerId);
  }

  /**
   * Ensure dialog unload listener releases assigned editorId.
   * @param {Window} window
   * @param {string} editorId
   */
  _ensureDialogReleaseListener(window, editorId) {
    if (!window || !editorId) {
      return;
    }
    if (!this._dialogReleaseByWindow) {
      this._dialogReleaseByWindow = new WeakMap();
    }
    const previous = this._dialogReleaseByWindow.get(window);
    if (previous?.editorId == editorId) {
      return;
    }
    if (previous?.onUnload) {
      window.removeEventListener("unload", previous.onUnload, true);
      this._bridge().releaseEditorId(previous.editorId);
    }
    const onUnload = () => {
      this._bridge().releaseEditorId(editorId);
      window.removeEventListener("unload", onUnload, true);
      this._dialogReleaseByWindow.delete(window);
    };
    window.addEventListener("unload", onUnload, true);
    this._dialogReleaseByWindow.set(window, { editorId, onUnload });
  }

  /**
   * Resolve a currently open native editor window by editorId.
   * @param {string} editorId
   * @returns {Window|null}
   */
  _resolveEditorWindow(editorId) {
    const bridge = this._bridge();
    const normalized = bridge.normalizeEditorId(editorId);
    if (!normalized) {
      return null;
    }
    const target = bridge.resolveTarget(normalized);
    if (!target) {
      return null;
    }
    if (target.kind == "dialog") {
      try {
        const win = Services.wm.getOuterWindowWithId(target.id);
        if (win && !win.closed && win.location?.href?.startsWith(EVENT_DIALOG_URL)) {
          return win;
        }
      } catch (error) {
        this._logError("resolve dialog editor window failed", error, {
          editorId: normalized,
          targetId: target.id,
        });
      }
      bridge.releaseEditorId(normalized);
      return null;
    }
    if (target.kind == "tab") {
      const manager = this.extension?.tabManager;
      if (!manager || typeof manager.get != "function") {
        bridge.releaseEditorId(normalized);
        return null;
      }
      try {
        const nativeTab = manager.get(target.id)?.nativeTab || null;
        if (!this._isEditorTab(nativeTab)) {
          bridge.releaseEditorId(normalized);
          return null;
        }
        const win = nativeTab.iframe?.contentWindow || nativeTab.iframe?.contentDocument?.defaultView || null;
        if (!this._isEditorWindow(win) || win.closed) {
          bridge.releaseEditorId(normalized);
          return null;
        }
        if (target.instanceId > 0 && this._editorOuterId(win) != target.instanceId) {
          bridge.releaseEditorId(normalized);
          return null;
        }
        return win;
      } catch (error) {
        this._logError("resolve tab editor window failed", error, {
          editorId: normalized,
          tabId: target.id,
          instanceId: target.instanceId,
        });
        bridge.releaseEditorId(normalized);
        return null;
      }
    }
    bridge.releaseEditorId(normalized);
    return null;
  }

  /**
   * Build click context with deterministic editorId.
   * @param {Window} window
   * @returns {{editorType:"dialog"|"tab",editorId:string}|null}
   */
  _clickContext(window) {
    const href = window?.location?.href || "";
    if (href == MESSENGER_URL) {
      const editorId = this._tabEditorIdFromMessenger(window);
      return editorId ? { editorType: "tab", editorId } : null;
    }
    if (href == EVENT_DIALOG_URL) {
      const tabEditorId = this._tabEditorIdFromEditorWindow(window);
      if (tabEditorId) {
        return { editorType: "tab", editorId: tabEditorId };
      }
      const outerId = this._dialogOuterId(window);
      if (typeof outerId != "number") {
        return null;
      }
      const editorId = this._bridge().registerDialogTarget(outerId);
      if (!editorId) {
        return null;
      }
      this._ensureDialogReleaseListener(window, editorId);
      return { editorType: "dialog", editorId };
    }
    return null;
  }

  /**
   * Resolve edited calendar item from editor window context.
   * @param {Window} window
   * @returns {object|null}
   */
  _getEditedItem(window) {
    if (!this._isEditorWindow(window)) {
      return null;
    }
    const fromWindow = win => {
      if (!win) {
        return null;
      }
      if (win.calendarItem) {
        return win.calendarItem;
      }
      if (win.gEvent?.event) {
        return win.gEvent.event;
      }
      const arg0 = Array.isArray(win.arguments) ? win.arguments[0] : null;
      return arg0?.calendarItem || arg0?.calendarEvent || null;
    };
    const direct = fromWindow(window);
    if (direct) {
      return direct;
    }
    const panelWindow =
      window.document?.getElementById(EVENT_PANEL_IFRAME_ID)?.contentWindow ||
      window.document?.getElementById(EVENT_PANEL_IFRAME_ID)?.contentDocument?.defaultView ||
      null;
    return fromWindow(panelWindow);
  }

  /**
   * Build API snapshot payload from a calendar item.
   * @param {object} item
   * @param {string} editorId
   * @param {"dialog"|"tab"|""} editorType
   * @returns {object|null}
   */
  _snapshotItem(item, editorId, editorType = "") {
    if (!item) {
      return null;
    }
    const ical = typeof item.icalString == "string" ? item.icalString : String(item.icalString || "");
    if (!ical) {
      return null;
    }
    const snapshot = {
      editorId,
      calendarId: item.calendar?.id ? String(item.calendar.id) : "",
      id: item.id ? String(item.id) : "",
      type: typeof item.isTodo == "function" && item.isTodo() ? "task" : "event",
      format: "ical",
      item: ical,
    };
    if (editorType == "tab" || editorType == "dialog") {
      snapshot.editorType = editorType;
    }
    return snapshot;
  }

  /**
   * Initialize supported window by installing hooks and button.
   * @param {Window} window
   */
  _ensureWindow(window) {
    if (!window || !window.location) {
      return;
    }
    if (window.location.href.startsWith(MESSENGER_URL)) {
      this._ensureMessengerHook(window);
    }
    this._ensureButton(window);
  }

  /**
   * Hook messenger panel-load method to re-ensure toolbar button.
   * @param {Window} window
   */
  _ensureMessengerHook(window) {
    if (window?.location?.href != MESSENGER_URL) {
      return;
    }
    if (window._ncCalToolbarOrigOnLoadCalendarItemPanel || typeof window.onLoadCalendarItemPanel != "function") {
      return;
    }
    const original = window.onLoadCalendarItemPanel;
    window._ncCalToolbarOrigOnLoadCalendarItemPanel = original;
    window.onLoadCalendarItemPanel = (...args) => {
      const result = original.apply(window, args);
      this._ensureButton(window);
      return result;
    };
  }

  /**
   * Restore original messenger panel-load hook.
   * @param {Window} window
   */
  _restoreMessengerHook(window) {
    if (window?.location?.href != MESSENGER_URL) {
      return;
    }
    if (window._ncCalToolbarOrigOnLoadCalendarItemPanel) {
      window.onLoadCalendarItemPanel = window._ncCalToolbarOrigOnLoadCalendarItemPanel;
      window._ncCalToolbarOrigOnLoadCalendarItemPanel = null;
    }
  }

  /**
   * Ensure command listener is bound to the official calendarItemAction button.
   * @param {Window} window
   */
  _ensureButton(window) {
    const toolbarId = this._toolbarId(window);
    if (!toolbarId) {
      return;
    }
    const toolbar = window.document.getElementById(toolbarId);
    if (!toolbar) {
      if ((window.location?.href || "").startsWith(EVENT_DIALOG_URL)) {
        const observer = new window.MutationObserver(() => {
          observer.disconnect();
          this._ensureButton(window);
        });
        observer.observe(window.document.documentElement, { childList: true, subtree: true });
        window.setTimeout(() => observer.disconnect(), 5000);
      }
      return;
    }
    const buttonId = this._buttonId();
    const button = window.document.getElementById(buttonId);
    if (!button) {
      if ((window.location?.href || "").startsWith(EVENT_DIALOG_URL)) {
        const observer = new window.MutationObserver(() => {
          observer.disconnect();
          this._ensureButton(window);
        });
        observer.observe(window.document.documentElement, { childList: true, subtree: true });
        window.setTimeout(() => observer.disconnect(), 5000);
      }
      return;
    }

    if (!this._commandBindingByWindow) {
      this._commandBindingByWindow = new WeakMap();
    }
    const currentBinding = this._commandBindingByWindow.get(window);
    if (currentBinding?.button == button) {
      return;
    }
    if (currentBinding?.button && currentBinding?.onCommand) {
      currentBinding.button.removeEventListener("command", currentBinding.onCommand);
    }

    const onCommand = () => {
      const click = this._clickContext(window);
      if (!click) {
        console.error("[ncCalToolbar] click ignored: could not resolve editor context");
        return;
      }
      const editorWindow = this._resolveEditorWindow(click.editorId);
      if (!editorWindow) {
        console.error("[ncCalToolbar] click ignored: target editor not resolvable");
        return;
      }
      const snapshot = this._snapshotItem(this._getEditedItem(editorWindow), click.editorId, click.editorType);
      if (!snapshot) {
        console.error("[ncCalToolbar] click ignored: no editable item");
        return;
      }
      this._emitClicked(snapshot);
    };
    button.addEventListener("command", onCommand);
    this._commandBindingByWindow.set(window, { button, onCommand });
  }

  /**
   * Remove button command listener from one window.
   * @param {Window} window
   */
  _removeButton(window) {
    const binding = this._commandBindingByWindow?.get(window) || null;
    if (binding?.button && binding?.onCommand) {
      binding.button.removeEventListener("command", binding.onCommand);
    }
    this._commandBindingByWindow?.delete(window);
  }

  /**
   * Register one onClicked listener.
   * @param {(snapshot:object) => void} listener
   */
  _addClickedListener(listener) {
    if (!this._clickedListeners) {
      this._clickedListeners = new Set();
    }
    this._clickedListeners.add(listener);
  }

  /**
   * Unregister one onClicked listener.
   * @param {(snapshot:object) => void} listener
   */
  _removeClickedListener(listener) {
    this._clickedListeners?.delete(listener);
  }

  /**
   * Emit one click snapshot to active onClicked listeners.
   * @param {object} snapshot
   */
  _emitClicked(snapshot) {
    for (const listener of this._clickedListeners || []) {
      try {
        listener(snapshot);
      } catch (e) {
        console.error("[ncCalToolbar] onClicked listener failed", e);
      }
    }
  }

  /**
   * Register one onTrackedEditorClosed listener.
   * @param {(info:object) => void} listener
   */
  _addEditorClosedListener(listener) {
    if (!this._editorClosedListeners) {
      this._editorClosedListeners = new Set();
    }
    this._editorClosedListeners.add(listener);
  }

  /**
   * Unregister one onTrackedEditorClosed listener.
   * @param {(info:object) => void} listener
   */
  _removeEditorClosedListener(listener) {
    this._editorClosedListeners?.delete(listener);
  }

  /**
   * Emit onTrackedEditorClosed payload to active listeners.
   * @param {object} info
   */
  _emitEditorClosed(info) {
    for (const listener of this._editorClosedListeners || []) {
      try {
        listener(info);
      } catch (e) {
        console.error("[ncCalToolbar] onTrackedEditorClosed listener failed", e);
      }
    }
  }

  /**
   * Cleanup lifecycle bookkeeping for one tracked target.
   * @param {Window} target
   */
  _cleanupLifecycleState(target) {
    if (!target) {
      return;
    }
    if (!this._editorLifecycleByTarget) {
      this._editorLifecycleByTarget = new WeakMap();
    }
    const state = this._editorLifecycleByTarget.get(target);
    if (!state) {
      return;
    }
    this._editorLifecycleByTarget.delete(target);
    if (state.editorId) {
      this._bridge().releaseEditorId(state.editorId);
    }
    while (state.cleanup.length) {
      const fn = state.cleanup.pop();
      try {
        fn();
      } catch (error) {
        this._logError("lifecycle cleanup callback failed", error, {
          editorId: state.editorId || "",
        });
      }
    }
  }

  /**
   * Cleanup lifecycle bookkeeping for all tracked targets in one window.
   * @param {Window} window
   */
  _cleanupLifecycleInWindow(window) {
    const href = window?.location?.href || "";
    if (href.startsWith(EVENT_DIALOG_URL)) {
      this._cleanupLifecycleState(window);
      return;
    }
    if (!href.startsWith(MESSENGER_URL)) {
      return;
    }
    const infos = window.tabmail && Array.isArray(window.tabmail.tabInfo) ? window.tabmail.tabInfo : [];
    for (const tabInfo of infos) {
      if (!this._isEditorTab(tabInfo)) {
        continue;
      }
      const target = tabInfo.iframe?.contentWindow || tabInfo.iframe?.contentDocument?.defaultView || null;
      this._cleanupLifecycleState(target);
    }
  }

  /**
   * Attach close lifecycle listeners for one editor target.
   * @param {Window} window
   * @param {string} editorId
   */
  _ensureLifecycleWatch(window, editorId) {
    if (!this._isEditorWindow(window)) {
      return;
    }
    const normalized = this._bridge().normalizeEditorId(editorId);
    if (!normalized) {
      return;
    }
    if (!this._editorLifecycleByTarget) {
      this._editorLifecycleByTarget = new WeakMap();
    }
    const previous = this._editorLifecycleByTarget.get(window);
    if (previous && previous.editorId == normalized) {
      return;
    }
    if (previous) {
      this._emitEditorClosed({
        editorId: previous.editorId || "",
        action: "superseded",
        reason: "re-bound",
      });
      this._cleanupLifecycleState(window);
    }
    const state = { editorId: normalized, cleanup: [], closed: false };
    this._editorLifecycleByTarget.set(window, state);

    const emitOnce = (action, reason) => {
      if (state.closed) {
        return;
      }
      state.closed = true;
      const info = { editorId: normalized, action };
      if (reason) {
        info.reason = reason;
      }
      this._emitEditorClosed(info);
      this._cleanupLifecycleState(window);
    };
    const add = (type, handler, options) => {
      window.addEventListener(type, handler, options);
      state.cleanup.push(() => window.removeEventListener(type, handler, options));
    };
    if ((window.location?.href || "").startsWith(EVENT_DIALOG_URL)) {
      add("dialogaccept", () => emitOnce("persisted", "dialogaccept"), true);
      add("dialogextra1", () => emitOnce("persisted", "dialogextra1"), true);
      add("dialogcancel", () => emitOnce("discarded", "dialogcancel"), true);
      add("dialogextra2", () => emitOnce("discarded", "dialogextra2"), true);
    }
    add("unload", () => emitOnce("discarded", "unload"), true);
  }

  /**
   * Ensure target editor window is still open.
   * @param {Window} window
   * @param {string} operation
   */
  _assertWindowOpen(window, operation) {
    if (!window || window.closed) {
      throw new ExtensionError(`Editor window closed during ${operation}`);
    }
  }

  /**
   * Collect all relevant editor documents (main + panel iframe).
   * @param {Window} window
   * @returns {Document[]}
   */
  _editorDocs(window) {
    const docs = [window?.document].filter(Boolean);
    const panelDoc = window?.document?.getElementById(EVENT_PANEL_IFRAME_ID)?.contentDocument || null;
    if (panelDoc) {
      docs.push(panelDoc);
    }
    return docs;
  }

  /**
   * Resolve writable element for an editor field.
   * @param {Window} window
   * @param {"title"|"location"|"description"} key
   * @returns {{kind:"value"|"html-body",element:any,host?:any}}
   */
  _resolveWritableField(window, key) {
    const idMap = {
      title: "item-title",
      location: "item-location",
      description: "item-description",
    };
    const id = idMap[key];
    for (const doc of this._editorDocs(window)) {
      const host = doc.getElementById(id);
      if (!host) {
        continue;
      }
      if (key == "description") {
        const inputField = host.inputField || null;
        if (inputField && "value" in inputField) {
          return { kind: "value", element: inputField };
        }
        if ("value" in host) {
          return { kind: "value", element: host };
        }
        const body = host.contentDocument?.body || null;
        if (body) {
          return { kind: "html-body", element: body, host };
        }
      } else if ("value" in host) {
        return { kind: "value", element: host };
      }
    }
    console.error("[ncCalToolbar] field resolution failed", { field: key, elementId: id });
    throw new ExtensionError(`Could not resolve writable ${key} field`);
  }

  /**
   * Read current value from resolved field target.
   * @param {{kind:string,element:any}|undefined} target
   * @returns {string}
   */
  _readField(target) {
    if (!target?.element) {
      return "";
    }
    if (target.kind == "value") {
      return String(target.element.value ?? "");
    }
    return String(target.element.innerHTML ?? "");
  }

  /**
   * Dispatch input event to notify editor UI of value changes.
   * @param {any} element
   */
  _dispatchInputEvent(element) {
    if (!element) {
      return;
    }
    const doc = element.ownerDocument || element.document;
    const win = doc?.defaultView;
    if (win) {
      element.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
  }

  /**
   * Cancel a pending startup retry timer.
   */
  _clearStartupRetryTimer() {
    if (!this._startupRetryTimer) {
      return;
    }
    try {
      this._startupRetryTimer.cancel();
    } catch (error) {
      this._logError("startup: retry timer cancel failed", error);
    }
    this._startupRetryTimer = null;
  }

  /**
   * Schedule the next startup retry with an XPCOM timer because the
   * experiment parent context does not provide a global setTimeout reliably.
   * @param {number} delayMs
   */
  _scheduleStartupRetry(delayMs) {
    try {
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.initWithCallback(() => {
        this._startupRetryTimer = null;
        this._startupRetryPending = false;
        this._registerWindowListenerWhenReady();
      }, delayMs, Ci.nsITimer.TYPE_ONE_SHOT);
      this._startupRetryTimer = timer;
    } catch (error) {
      this._startupRetryPending = false;
      this._startupRetryTimer = null;
      this._logError("startup: retry timer schedule failed", error, {
        delayMs,
      });
    }
  }

  /**
   * Build a document fragment from HTML for the rich event editor.
   * @param {Document} doc
   * @param {string} html
   * @returns {DocumentFragment}
   */
  _createHtmlFragment(doc, html) {
    const container = doc.createElement("div");
    container.innerHTML = String(html ?? "");
    const fragment = doc.createDocumentFragment();
    while (container.firstChild) {
      fragment.appendChild(container.firstChild);
    }
    return fragment;
  }

  /**
   * Synchronize Thunderbird's item description state for HTML-backed editors.
   * Thunderbird persists rich descriptions as HTML plus a plain DESCRIPTION
   * companion, so both have to stay in sync with the editor content.
   * @param {object} item
   * @param {{text:string,html:string}} description
   */
  _applyDescriptionState(item, description) {
    if (!item || !description) {
      return;
    }
    const text = String(description.text ?? "");
    const html = String(description.html ?? "");
    if (cal?.item?.setItemProperty) {
      cal.item.setItemProperty(item, "DESCRIPTION", text);
    } else if (typeof item.setProperty == "function") {
      item.setProperty("DESCRIPTION", text);
    }
    item.descriptionHTML = html;
  }

  /**
   * Write a value into one resolved editor field.
   * @param {{kind:string,element:any}} target
   * @param {string} value
   * @param {{html?:boolean}} options
   */
  _writeField(target, value, options = {}) {
    if (!target?.element) {
      throw new ExtensionError("Resolved editor field is not writable");
    }
    if (target.kind == "value") {
      target.element.focus?.();
      target.element.value = value;
      this._dispatchInputEvent(target.element);
      return;
    }
    if (options?.html) {
      const host = target.host || null;
      const doc = host?.contentDocument || target.element.ownerDocument || null;
      const editor = host?.getHTMLEditor?.(host.contentWindow) || null;
      if (!doc || !editor?.rootElement) {
        throw new ExtensionError("Could not write HTML description field");
      }
      target.element.focus?.();
      editor.flags =
        editor.eEditorMailMask | editor.eEditorNoCSSMask | editor.eEditorAllowInteraction;
      editor.enableUndo(false);
      editor.forceCompositionEnd();
      editor.rootElement.replaceChildren(this._createHtmlFragment(doc, value));
      // Thunderbird reinitializes the rich editor after a DOM replacement with
      // one no-op editor command. This also marks the document as modified so
      // saveDialog() persists descriptionHTML.
      editor.insertText("");
      editor.enableUndo(true);
      this._dispatchInputEvent(target.element);
      return;
    }
    const doc = target.element.ownerDocument || null;
    if (!doc || typeof doc.execCommand != "function") {
      throw new ExtensionError("Could not write description field");
    }
    target.element.focus?.();
    doc.execCommand("selectAll", false, null);
    const insertOk = doc.execCommand("insertText", false, value);
    if (!insertOk && String(target.element.textContent ?? "") != String(value ?? "")) {
      throw new ExtensionError("Could not write description field");
    }
    this._dispatchInputEvent(target.element);
  }

  /**
   * Snapshot current property values before mutation.
   * @param {object} item
   * @param {object} properties
   * @returns {Record<string, string|null>}
   */
  _snapshotProperties(item, properties) {
    const out = {};
    for (const name of Object.keys(properties || {})) {
      if (!name || typeof name != "string") {
        throw new ExtensionError("Property names must be non-empty strings");
      }
      try {
        const current = item.getProperty(name);
        out[name] = current == null ? null : String(current);
      } catch (error) {
        this._logError("property snapshot failed", error, { property: name });
        throw new ExtensionError(`Could not snapshot property ${name}`);
      }
    }
    return out;
  }

  /**
   * Apply iCal property updates to the edited item.
   * @param {object} item
   * @param {object} properties
   * @returns {string[]}
   */
  _applyProperties(item, properties) {
    const names = [];
    for (const [name, value] of Object.entries(properties || {})) {
      if (!name || typeof name != "string") {
        throw new ExtensionError("Property names must be non-empty strings");
      }
      try {
        if (value == null) {
          if (typeof item.deleteProperty == "function") {
            item.deleteProperty(name);
          } else {
            item.setProperty(name, "");
          }
        } else {
          item.setProperty(name, String(value));
        }
        names.push(name);
      } catch (error) {
        this._logError("property update failed", error, { property: name });
        throw new ExtensionError(`Could not update property ${name}`);
      }
    }
    return names;
  }

  /**
   * Roll back previously applied iCal property updates.
   * @param {object} item
   * @param {Record<string, string|null>} snapshot
   * @param {string[]} names
   */
  _rollbackProperties(item, snapshot, names) {
    for (let i = names.length - 1; i >= 0; i--) {
      const name = names[i];
      const previous = Object.prototype.hasOwnProperty.call(snapshot, name) ? snapshot[name] : null;
      try {
        if (previous == null) {
          if (typeof item.deleteProperty == "function") {
            item.deleteProperty(name);
          } else {
            item.setProperty(name, "");
          }
        } else {
          item.setProperty(name, String(previous));
        }
      } catch (error) {
        this._logError("property rollback failed", error, { property: name });
        throw new ExtensionError(`Could not rollback property ${name}`);
      }
    }
  }

  /**
   * Expose the ncCalToolbar experiment API.
   * @param {object} context
   * @returns {object}
   */
  getAPI(context) {
    this._registerApiContextClose(context);
    return {
      ncCalToolbar: {
        onClicked: new EventManager({
          context,
          name: "ncCalToolbar.onClicked",
          register: fire => {
            const listener = snapshot => fire.sync(snapshot);
            this._addClickedListener(listener);
            if (!this._onClickedByContext) {
              this._onClickedByContext = new WeakMap();
            }
            let contextListeners = this._onClickedByContext.get(context);
            if (!contextListeners) {
              contextListeners = new Set();
              this._onClickedByContext.set(context, contextListeners);
            }
            contextListeners.add(listener);
            return () => {
              this._removeClickedListener(listener);
              const listeners = this._onClickedByContext?.get(context);
              if (!listeners) {
                return;
              }
              listeners.delete(listener);
              if (!listeners.size) {
                this._onClickedByContext.delete(context);
              }
            };
          },
        }).api(),

        onTrackedEditorClosed: new EventManager({
          context,
          name: "ncCalToolbar.onTrackedEditorClosed",
          register: fire => {
            const listener = info => fire.sync(info);
            this._addEditorClosedListener(listener);
            if (!this._onClosedByContext) {
              this._onClosedByContext = new WeakMap();
            }
            let contextListeners = this._onClosedByContext.get(context);
            if (!contextListeners) {
              contextListeners = new Set();
              this._onClosedByContext.set(context, contextListeners);
            }
            contextListeners.add(listener);
            return () => {
              this._removeEditorClosedListener(listener);
              const listeners = this._onClosedByContext?.get(context);
              if (!listeners) {
                return;
              }
              listeners.delete(listener);
              if (!listeners.size) {
                this._onClosedByContext.delete(context);
              }
            };
          },
        }).api(),

        getCurrent: async options => {
          const editorId = this._bridge().normalizeEditorId(options?.editorId);
          if (!editorId) {
            throw new ExtensionError("editorId must be a non-empty opaque editor identifier");
          }
          const window = this._resolveEditorWindow(editorId);
          if (!window) {
            return null;
          }
          const item = this._getEditedItem(window);
          if (!item) {
            return null;
          }
          this._ensureLifecycleWatch(window, editorId);
          return this._snapshotItem(item, editorId);
        },

        updateCurrent: async updateOptions => {
          const editorId = this._bridge().normalizeEditorId(updateOptions?.editorId);
          if (!editorId) {
            throw new ExtensionError("editorId must be a non-empty opaque editor identifier");
          }
          const window = this._resolveEditorWindow(editorId);
          if (!window) {
            throw new ExtensionError("Could not resolve target editor window");
          }
          const item = this._getEditedItem(window);
          if (!item) {
            throw new ExtensionError("Could not find current editor item");
          }
          this._ensureLifecycleWatch(window, editorId);

          const fields =
            updateOptions?.fields && typeof updateOptions.fields == "object"
              ? updateOptions.fields
              : {};
          const properties =
            updateOptions?.properties && typeof updateOptions.properties == "object"
              ? updateOptions.properties
              : {};
          if (!Object.keys(fields).length && !Object.keys(properties).length) {
            throw new ExtensionError("updateCurrent requires at least one field or property update");
          }

          this._assertWindowOpen(window, "updateCurrent");
          const targets = {};
          for (const key of ["title", "location", "description"]) {
            if (
              typeof fields[key] == "string"
              || (key == "description" && typeof fields.descriptionHtml == "string")
            ) {
              targets[key] = this._resolveWritableField(window, key);
            }
          }
          const beforeFields = {
            title: this._readField(targets.title),
            location: this._readField(targets.location),
            description: this._readField(targets.description),
          };
          const beforeDescriptionState =
            typeof fields.descriptionHtml == "string"
              ? {
                  text: String(item.descriptionText ?? ""),
                  html: String(item.descriptionHTML ?? ""),
                }
              : null;
          const appliedFields = { title: false, location: false, description: false };

          try {
            for (const key of ["title", "location", "description"]) {
              if (typeof fields[key] == "string" || (key == "description" && typeof fields.descriptionHtml == "string")) {
                const writeHtml =
                  key == "description"
                  && targets[key]?.kind == "html-body"
                  && typeof fields.descriptionHtml == "string";
                const value = writeHtml ? fields.descriptionHtml : fields[key];
                this._writeField(targets[key], value, { html: writeHtml });
                if (writeHtml) {
                  this._applyDescriptionState(item, {
                    text: typeof fields.description == "string" ? fields.description : "",
                    html: typeof fields.descriptionHtml == "string" ? fields.descriptionHtml : "",
                  });
                }
                appliedFields[key] = true;
              }
            }
          } catch (fieldError) {
            this._logError("updateCurrent field write failed", fieldError, {
              editorId,
            });
            for (const key of ["description", "location", "title"]) {
              if (!appliedFields[key]) {
                continue;
              }
              try {
                this._writeField(targets[key], beforeFields[key] ?? "", {
                  html: key == "description" && targets[key]?.kind == "html-body",
                });
                if (key == "description" && beforeDescriptionState) {
                  this._applyDescriptionState(item, beforeDescriptionState);
                }
              } catch (rollbackError) {
                this._logError("updateCurrent field rollback failed", rollbackError, {
                  editorId,
                  field: key,
                });
              }
            }
            throw fieldError;
          }

          const beforeProps = this._snapshotProperties(item, properties);
          let appliedProps = [];
          try {
            appliedProps = this._applyProperties(item, properties);
          } catch (propertyError) {
            this._logError("updateCurrent property write failed", propertyError, {
              editorId,
            });
            try {
              this._rollbackProperties(item, beforeProps, appliedProps);
            } catch (rollbackError) {
              this._logError("updateCurrent property rollback failed", rollbackError, {
                editorId,
              });
            }
            try {
              for (const key of ["description", "location", "title"]) {
                if (appliedFields[key]) {
                  this._writeField(targets[key], beforeFields[key] ?? "", {
                    html: key == "description" && targets[key]?.kind == "html-body",
                  });
                  if (key == "description" && beforeDescriptionState) {
                    this._applyDescriptionState(item, beforeDescriptionState);
                  }
                }
              }
            } catch (rollbackFieldError) {
              this._logError("updateCurrent field rollback failed", rollbackFieldError, {
                editorId,
              });
            }
            throw propertyError;
          }

          return this._snapshotItem(item, editorId);
        },
      },
    };
  }
};
