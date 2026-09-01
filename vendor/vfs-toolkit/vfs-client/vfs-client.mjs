/**
 * vfs-client.mjs - for documentation see README.md.
 */

import * as opfsProvider from './opfs-provider.mjs';

const API_VERSION = "1.3";

// ── Internal state ────────────────────────────────────────────────────────────

/** Map<sessionId, { resolve, reject, defaultValue }> */
const pendingPickers = new Map();

// ── External provider port management ────────────────────────────────────────

// Module-level port cache: providerId → { port, pending: Map<id, {resolve,reject}> }
const _providerPorts = new Map();

let _isBackground = false;
let _configStorageKey = null;

// Module-level progress callback map: operationId → onProgress function
const _progressCallbacks = new Map();

const _storageChangedEvent = _createEvent();
const _connectionsChangedEvent = _createEvent();

// ── Action button (set via parseManifest) ─────────────────────────────────────

function _createEvent() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); },
    hasListener(fn) { return listeners.has(fn); },
    removeListener(fn) { listeners.delete(fn); },
    _fire(...args) { for (const fn of listeners) fn(...args); },
  };
}

let _actionButton = null;
const _actionClickedEvent = _createEvent();
let _actionListenerRegistered = false;

// ── Async queue ───────────────────────────────────────────────────────────────

/**
 * Serializes async read-modify-write operations on session storage, preventing
 * race conditions when multiple concurrent callers update the provider list.
 *
 * Operations are executed one at a time in FIFO order. Each call to `push()`
 * either runs immediately (if the queue is idle) or waits until all previously
 * queued operations have completed.
 */
class StorageActivityQueue {
  #queue = [];
  #running = false;

  /**
   * Enqueues an async operation and returns a promise that resolves (or rejects)
   * with the operation's result once it has been executed.
   *
   * @template T
   * @param {() => Promise<T>} fn - The async operation to serialize.
   * @returns {Promise<T>}
   */
  push(fn) {
    return new Promise((resolve, reject) => {
      this.#queue.push(async () => {
        try { resolve(await fn()); }
        catch (e) { reject(e); }
      });
      if (!this.#running) this.#drain();
    });
  }

  /** @returns {Promise<void>} */
  async #drain() {
    this.#running = true;
    while (this.#queue.length > 0) {
      await this.#queue.shift()();
    }
    this.#running = false;
  }
}

const _storageActivityQueue = new StorageActivityQueue();

// Fire local listeners when background broadcasts a storage-changed notification.
browser.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'vfs-storage-changed') {
    _storageChangedEvent._fire(msg.entries || []);
  }
  if (msg?.type === 'vfs-provider-updated' ||
      msg?.type === 'vfs-provider-removed' ||
      msg?.type === 'vfs-remove-connection') {
    _connectionsChangedEvent._fire();
  }
});

// ── Provider discovery ────────────────────────────────────────────────────────

// These functions are gated by their callers to be only called from within the
// background script. Other pages will be routed through runtime messaging.


// Session storage holds: [{ providerId, name, icon, connections: [{ storageId, name, capabilities }] }]

async function _readProviderList() {
  try {
    return browser.storage.session.get({ [_configStorageKey]: [] })
      .then(rv => rv[_configStorageKey]);
  } catch {
    return [];
  }
}

async function _saveProviderList(list) {
  return browser.storage.session.set({ [_configStorageKey]: list });
}

async function _updateProvider(providerId, name, connections = [], icon = null, hasConfig = false) {
  return _storageActivityQueue.push(async () => {
    const list = await _readProviderList();
    const idx = list.findIndex(p => p.providerId === providerId);
    if (idx >= 0) list[idx] = { providerId, name, connections, icon, hasConfig };
    else list.push({ providerId, name, connections, icon, hasConfig });
    await _saveProviderList(list);
    browser.runtime.sendMessage({ type: 'vfs-provider-updated', providerId, name }).catch(() => { });
    _connectionsChangedEvent._fire();
  });
}

async function _removeProvider(id) {
  return _storageActivityQueue.push(async () => {
    const list = await _readProviderList();
    await _saveProviderList(list.filter(p => p.providerId !== id));
    browser.runtime.sendMessage({ type: 'vfs-provider-removed', providerId: id }).catch(() => { });
    _connectionsChangedEvent._fire();
  });
}

async function _removeConnection(providerId, storageId) {
  return _storageActivityQueue.push(async () => {
    const list = await _readProviderList();
    const provider = list.find(p => p.providerId === providerId);
    if (!provider) return;
    provider.connections = provider.connections.filter(c => c.storageId !== storageId);
    await _saveProviderList(list);
    browser.runtime.sendMessage({ type: 'vfs-provider-updated', providerId, name: provider.name }).catch(() => { });
    _connectionsChangedEvent._fire();
  });
}

async function _addConnection(providerId, storageId, name, capabilities) {
  return _storageActivityQueue.push(async () => {
    const list = await _readProviderList();
    const provider = list.find(p => p.providerId === providerId);
    if (!provider) return;
    const idx = provider.connections.findIndex(c => c.storageId === storageId);
    const conn = { storageId, name, capabilities };
    if (idx >= 0) provider.connections[idx] = conn;
    else provider.connections.push(conn);
    await _saveProviderList(list);
    browser.runtime.sendMessage({ type: 'vfs-provider-updated', providerId, name: provider.name }).catch(() => { });
    _connectionsChangedEvent._fire();
  });
}


/**
 * Probes a single extension to check if it is a vfs-toolkit provider.
 *
 * @param {string} id - The extension ID to probe.
 * @param {object} [options={}] - Optional settings.
 * @param {number} [options.delay=0] - Artificial delay in milliseconds before
 *   sending the discovery message. Used to allow a newly started extension to
 *   finish initializing, otherwise the message may be sent before the extension
 *   is ready to respond.
 */
async function _probeExtension(id, options = {}) {
  const delay = options?.delay ?? 0;
  if (id === browser.runtime.id) return;
  try {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    const response = await browser.runtime.sendMessage(id, { type: 'vfs-toolkit-discover' });
    if (response.API_VERSION) {
      if (response.API_VERSION != API_VERSION) {
        console.warn(`[vfs-toolkit] Provider <${id}> uses API_VERSION ${response.API_VERSION} but this client uses API_VERSION ${API_VERSION}. Make sure all extensions use the most recent version of the VFS Toolkit: https://github.com/thunderbird/webext-support/tree/master/modules/vfs-toolkit`);
      }
      if (response?.name) {
        await _updateProvider(id, response.name, response.connections ?? [], response.icon ?? null, response.hasConfig ?? false);
      }
    }
  } catch {
    await _removeProvider(id);
  }
}

/**
 * Initialises vfs-toolkit in the background script. Must be called once from the
 * background script before any other vfs-toolkit API is used.
 *
 * Sets up the storage-change relay so that `vfs.onStorageChanged` listeners work
 * in all extension pages (including the picker).
 *
 * @param {object} [options={}]
 * @param {boolean} [options.enableExternalProviders=false] - Enable support for
 *   external storage backend providers. Requires the `management` and `storage`
 *   permissions. When true, `configStorageKey` is required.
 * @param {string} [options.configStorageKey] - Storage key used to persist provider
 *   connection data. Required when `enableExternalProviders` is true.
 */
export function init(options = {}) {
  const bg = browser.extension.getBackgroundPage();
  if (!bg || bg !== window) {
    throw new Error('[vfs-toolkit] init() must be called from the background script');
  }
  _isBackground = true;

  // Always relay storage-change notifications to all extension pages so that
  // vfs.onStorageChanged.addListener listeners work regardless of which page triggered the change.
  browser.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'vfs-notify-background-storage-changed') {
      browser.runtime.sendMessage({ type: 'vfs-storage-changed', entries: msg.entries }).catch(() => { });
    }
  });

  if (!options.enableExternalProviders) return;

  _configStorageKey = options?.configStorageKey ?? null;
  if (!_configStorageKey) {
    throw new Error('[vfs-toolkit] configStorageKey is required when enableExternalProviders is true.');
  }
  if (typeof browser.management === 'undefined') {
    throw new Error('[vfs-toolkit] The management permission is required when enableExternalProviders is true.');
  }

  browser.management.getAll().then(extensions => {
    for (const ext of extensions) {
      if (ext.enabled) _probeExtension(ext.id);
    }
  });

  browser.management.onInstalled.addListener(ext => _probeExtension(ext.id, { delay: 1000 }));
  browser.management.onEnabled.addListener(ext => _probeExtension(ext.id, { delay: 1000 }));
  browser.management.onDisabled.addListener(ext => _removeProvider(ext.id));
  browser.management.onUninstalled.addListener(ext => _removeProvider(ext.id));

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'vfs-toolkit-get-connections') {
      _readProviderList().then(list =>
        sendResponse(list.map(p => ({
          providerId: p.providerId,
          name: p.name,
          icon: p.icon ?? null,
          hasConfig: p.hasConfig ?? false,
          connections: (p.connections ?? []).map(c => ({
            storageRef: { providerId: p.providerId, storageId: c.storageId },
            name: c.name,
            capabilities: c.capabilities,
          })),
        })))
      );
      return true;
    }
  });

  // Listen for providers reporting new or removed connections.
  browser.runtime.onMessageExternal.addListener((msg, sender) => {
    // Only claim our own message types. Returning false for everything else
    // lets other onMessageExternal listeners respond instead.
    if (msg?.type !== 'vfs-toolkit-add-connection' && msg?.type !== 'vfs-toolkit-remove-connection') {
      return false;
    }
    // Only accept messages from known providers.
    return _readProviderList().then(list => {
      if (!list.some(p => p.providerId === sender.id)) return;
      switch (msg.type) {
        case 'vfs-toolkit-add-connection':
          // New connections are picked up automatically when the user next opens the
          // provider dropdown - no broadcast needed.
          _addConnection(sender.id, msg.storageId, msg.name, msg.capabilities);
          break;
        case 'vfs-toolkit-remove-connection':
          // Removed connections must be broadcast immediately so that any picker
          // currently showing the removed connection can switch away from it.
          _removeConnection(sender.id, msg.storageId).then(() => {
            browser.runtime.sendMessage({ type: 'vfs-remove-connection', providerId: sender.id, storageId: msg.storageId }).catch(() => { });
          });
          break;
      }
    });
  });
}

/**
 * Registers a toolbar action button that appears in every picker popup.
 * Call once from the background script. Independent of enableSupportExternalProviders.
 *
 * Also sets up the internal runtime message listener that drives vfs.action.onClicked,
 * so no additional wiring is required.
 *
 * @param {object} manifest - Partial manifest object.
 * @param {object} manifest.vfs_action - Action button descriptor.
 * @param {string} [manifest.vfs_action.default_label] - Button label (takes precedence over default_title).
 * @param {string} [manifest.vfs_action.default_title] - Fallback label / tooltip.
 * @param {string} [manifest.vfs_action.default_icon]  - Icon URL (use browser.runtime.getURL). When set,
 *   the icon is rendered instead of the label text; the label becomes alt/title text.
 */
export function parseManifest(manifest) {
  const entry = manifest?.vfs_action;
  if (!entry) return;
  const label = entry.default_label ?? entry.default_title ?? '';
  const iconRaw = entry.default_icon ?? null;
  const icon = iconRaw ? new URL(iconRaw, import.meta.url).href : null;
  _actionButton = { id: 'vfs-action', label, ...(icon ? { icon } : {}) };

  if (!_actionListenerRegistered) {
    _actionListenerRegistered = true;
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'vfs-toolkit-button' && msg.buttonId === 'vfs-action') {
        _actionClickedEvent._fire(msg.storageRef ?? null);
      }
      if (msg?.type === 'vfs-toolkit-get-action-button') {
        sendResponse(_actionButton);
        return true;
      }
    });
  }
}

/**
 * WebExtension-style namespace for the picker action button.
 * Mirror of the standard `browser.action` / `messageDisplayAction` shape.
 *
 * @property {object} onClicked - Event fired when the action button is clicked in the picker.
 *   Listeners receive the active StorageRef (or null for OPFS) as their first argument.
 *   @property {function} onClicked.addListener(listener)    - Register a listener.
 *   @property {function} onClicked.hasListener(listener)    - Returns true if listener is registered.
 *   @property {function} onClicked.removeListener(listener) - Unregister a listener.
 */
export const action = {
  onClicked: {
    addListener(fn) { _actionClickedEvent.addListener(fn); },
    hasListener(fn) { return _actionClickedEvent.hasListener(fn); },
    removeListener(fn) { _actionClickedEvent.removeListener(fn); },
  },
};

/**
 * Fetches all known providers and their established connections.
 * Reads session storage directly when called from the background script,
 * sends a runtime message to the background otherwise.
 *
 * @returns {Promise<Array<{providerId: string, name: string, connections: Array<{storageRef: StorageRef, name: string, capabilities: object}>}>>}
 */
export async function fetchProviderConnections() {
  if (_isBackground) {
    return _readProviderList().then(list =>
      list.map(p => ({
        providerId: p.providerId,
        name: p.name,
        icon: p.icon ?? null,
        hasConfig: p.hasConfig ?? false,
        connections: (p.connections ?? []).map(c => ({
          storageRef: { providerId: p.providerId, storageId: c.storageId },
          name: c.name,
          capabilities: c.capabilities,
        })),
      }))
    );
  }
  try {
    return await browser.runtime.sendMessage({ type: 'vfs-toolkit-get-connections' }) ?? [];
  } catch {
    return [];
  }
}

/**
 * Asks the provider to open its setup page as a popup window. Resolves to
 * `{providerId, storageId}` after the user completes the setup, or rejects
 * if the user closes the setup window without completing it.
 *
 * @param {string} providerId
 * @param {string} [addonName]
 * @returns {Promise<StorageRef>}
 */
export async function openProviderSetup(providerId, addonName = '') {
  const addonId = browser.runtime.id;
  const storageId = await _providerSend(providerId, 'openSetup', { addonId, addonName });
  return { providerId, storageId };
}

/**
 * Asks the provider to open its config page for a specific connection.
 *
 * @param {StorageRef} storageRef
 */
export async function openProviderConfig(storageRef) {
  const { providerId, storageId } = storageRef;
  const addonId = browser.runtime.id;
  return _providerSend(providerId, 'openConfig', { addonId, storageId });
}

/**
 * Asks the provider to delete a connection, then removes it from the client's
 * session storage on success.
 *
 * @param {StorageRef} storageRef
 */
export async function deleteProviderConnection(storageRef) {
  const { providerId, storageId } = storageRef;
  const addonId = browser.runtime.id;
  await _providerSend(providerId, 'deleteConnection', { storageId, addonId });
}

/**
 * Event fired when storage contents change. Requires vfs.init() to have been called
 * in the background script. Listeners receive the array of affected path entries.
 *
 * @property {function} addListener(listener)    - Register a listener.
 * @property {function} hasListener(listener)    - Returns true if listener is registered.
 * @property {function} removeListener(listener) - Unregister a listener.
 */
export const onStorageChanged = {
  addListener(fn) { _storageChangedEvent.addListener(fn); },
  hasListener(fn) { return _storageChangedEvent.hasListener(fn); },
  removeListener(fn) { _storageChangedEvent.removeListener(fn); },
};

/**
 * Fires when the set of installed VFS provider connections changes
 * (connection added, removed, or provider removed). Listeners receive
 * no arguments — call `fetchProviderConnections()` to get the current state.
 */
export const onConnectionsChanged = {
  addListener(fn) { _connectionsChangedEvent.addListener(fn); },
  hasListener(fn) { return _connectionsChangedEvent.hasListener(fn); },
  removeListener(fn) { _connectionsChangedEvent.removeListener(fn); },
};

function _getProviderPort(providerId) {
  if (_providerPorts.has(providerId)) return _providerPorts.get(providerId);
  const port = browser.runtime.connect(providerId, { name: 'vfs-toolkit' });
  const pending = new Map();
  port.onMessage.addListener(msg => {
    if (msg.type === 'vfs-progress') {
      _progressCallbacks.get(msg.requestId)?.({
        percent: msg.percent,
        currentFile: msg.currentFile,
        totalFiles: msg.totalFiles,
      });
    } else if (msg.requestId && pending.has(msg.requestId)) {
      const { resolve, reject } = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      _progressCallbacks.delete(msg.requestId);
      if (msg.ok) {
        resolve(msg.result);
      } else {
        const e = new Error(
          msg.errorCode === 'E:AUTH'
          ? 'Unauthorized storage connection.' 
          : msg.error
        );
        if (msg.errorCode) e.code = msg.errorCode;
        if (msg.errorDetails) e.details = msg.errorDetails;
        reject(e);
      }
    } else if (msg.type === 'vfs-storage-changed') {
      // We got a storage changed notification from a provider. Relay the message
      // back to the background and have it broadcasted to all active clients.
      const storageRef = { providerId, storageId: msg.storageId ?? null };
      const entries = (msg.entries || []).map(e => {
        const entry = { kind: e.kind, action: e.action, target: { path: e.target.path, storageRef } };
        if (e.source != null) entry.source = { path: e.source.path, storageRef };
        return entry;
      });
      browser.runtime.sendMessage({ type: 'vfs-notify-background-storage-changed', entries }).catch(() => { });
    }
  });
  port.onDisconnect.addListener(() => {
    _providerPorts.delete(providerId);
    for (const { reject } of pending.values()) {
      reject(new Error('Provider disconnected'));
    }
    pending.clear();
  });
  const entry = { port, pending };
  _providerPorts.set(providerId, entry);
  return entry;
}

async function _providerSend(providerId, cmd, args = {}, onProgress) {
  const { port, pending } = _getProviderPort(providerId);
  const requestId = crypto.randomUUID();
  if (onProgress) _progressCallbacks.set(requestId, onProgress);
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    port.postMessage({ requestId, cmd, ...args });
  });
}

/**
 * Cancels all pending operations for an external provider.
 * Rejects their promises immediately with AbortError and sends a cancel
 * notification to the provider so it can abort early.
 * Has no effect for the built-in OPFS provider (use _cancelRequested instead).
 *
 * @param {StorageRef} storageRef
 */
export function abort(storageRef) {
  if (!storageRef) return;
  const { providerId } = storageRef;
  const entry = _providerPorts.get(providerId);
  if (!entry) return;
  const { port, pending } = entry;
  for (const [requestId, { reject }] of pending) {
    port.postMessage({ cmd: 'cancel', canceledRequestId: requestId });
    _progressCallbacks.delete(requestId);
    reject(new DOMException('Cancelled', 'AbortError'));
  }
  pending.clear();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {null|{providerId: string, storageId: string}} StorageRef
 * Identifies a storage connection. `null` refers to the built-in OPFS backend.
 */

/**
 * @typedef {object} Entry
 * @property {string} path - Absolute path, e.g. "/documents/notes.txt"
 * @property {StorageRef} [storageRef] - null = built-in OPFS, otherwise identifies the external provider and storage slot.
 */

/**
 * Lists the contents of a directory.
 *
 * @param {Entry} [entry={path:'/'}]
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @returns {Promise<Entry[]>} - Each item includes `name`, `kind`, `storageRef`, and (for files) `size` and `lastModified`.
 */
export async function list(entry = {}, options = {}) {
  const { path = '/', storageRef = null } = entry;
  const { providerId, storageId } = storageRef ?? {};
  const { onProgress } = options;
  const items = storageRef
    ? await _providerSend(providerId, 'list', { path, storageId }, onProgress)
    : await opfsProvider.list(path, onProgress);
  return items.map(item => ({ ...item, storageRef }));
}

/**
 * Reads a file and returns a File object.
 *
 * @param {Entry} entry
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @returns {Promise<File>}
 */
export async function readFile(entry, options = {}) {
  const { path, storageRef = null } = entry;
  const { providerId, storageId } = storageRef ?? {};
  const { onProgress } = options;
  if (!storageRef) {
    return opfsProvider.readFile(path, onProgress);
  }
  return _providerSend(providerId, 'readFile', { path, storageId }, onProgress);
}

/**
 * Writes a File or Blob to the given path.
 * Creates intermediate directories as needed.
 *
 * @param {Entry} entry
 * @param {File|Blob} fileOrBlob
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @param {boolean} [options.overwrite=false] - When `true`, silently overwrites an existing file.
 * @returns {Promise<void>}
 */
export async function writeFile(entry, fileOrBlob, options = {}) {
  const { onProgress, overwrite = false } = options;
  try {
    await _writeFile(entry, fileOrBlob, { onProgress, overwrite });
  } finally {
    _notifyStorageChanged({ kind: 'file', action: 'modified', target: { path: entry.path, storageRef: entry.storageRef ?? null } });
  }
}

/**
 * Moves (or renames) a file. Supports cross-provider moves.
 *
 * @param {Entry} from - Source entry
 * @param {Entry|string} to - Destination entry, or a plain path string (same provider as `from`)
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @param {boolean} [options.overwrite=false] - When `true`, silently overwrites an existing file.
 * @returns {Promise<void>}
 */
export async function moveFile(from, to, options = {}) {
  to = _toEntry(to, from);
  const { path: oldPath, storageRef: srcRef = null } = from;
  const { path: newPath, storageRef: dstRef = null } = to;
  const { onProgress, overwrite = false } = options;
  try {
    if (_sameProvider(srcRef, dstRef)) {
      if (!srcRef) {
        await opfsProvider.moveFile(oldPath, newPath, onProgress, { overwrite });
      } else {
        const { providerId, storageId } = srcRef;
        await _providerSend(providerId, 'moveFile', { oldPath, newPath, overwrite, storageId }, onProgress);
      }
    } else {
      const file = await readFile(from, { onProgress });
      await _writeFile(to, file, { overwrite, onProgress });
      await _deleteFile(from, { onProgress });
    }
  } finally {
    _notifyStorageChanged({ kind: 'file', action: 'moved', target: { path: newPath, storageRef: dstRef }, source: { path: oldPath, storageRef: srcRef } });
  }
}

/**
 * Deletes a file. Silent (no error) if the file does not exist.
 *
 * @param {Entry} entry
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @returns {Promise<void>}
 */
export async function deleteFile(entry, options = {}) {
  const { onProgress } = options;
  try {
    await _deleteFile(entry, { onProgress });
  } finally {
    _notifyStorageChanged({ kind: 'file', action: 'deleted', target: { path: entry.path, storageRef: entry.storageRef ?? null } });
  }
}

/**
 * Creates a folder and all intermediate folders.
 * **Throws** an `E:EXIST` error if the folder already exists.
 *
 * @param {Entry} entry
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @returns {Promise<void>}
 */
export async function addFolder(entry, options = {}) {
  const { onProgress } = options;
  try {
    await _addFolder(entry, { onProgress });
  } finally {
    _notifyStorageChanged({ kind: 'directory', action: 'created', target: { path: entry.path, storageRef: entry.storageRef ?? null } });
  }
}

/**
 * Moves (or renames) a folder. Supports cross-provider moves.
 *
 * @param {Entry} from - Source entry
 * @param {Entry|string} to - Destination entry, or a plain path string (same provider as `from`)
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @param {boolean} [options.merge=false] - When `true`, merges with an existing folder instead of throwing.
 * @returns {Promise<void>}
 */
export async function moveFolder(from, to, options = {}) {
  to = _toEntry(to, from);
  await _moveFolder(from, to, options);
  _notifyStorageChanged({ kind: 'directory', action: 'moved', target: { path: to.path, storageRef: to.storageRef ?? null }, source: { path: from.path, storageRef: from.storageRef ?? null } });
}

/**
 * Deletes a folder and all its contents recursively. Silent if not found.
 *
 * @param {Entry} entry
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @returns {Promise<void>}
 */
export async function deleteFolder(entry, options = {}) {
  const { onProgress } = options;
  await _deleteFolder(entry, { onProgress });
  _notifyStorageChanged({ kind: 'directory', action: 'deleted', target: { path: entry.path, storageRef: entry.storageRef ?? null } });
}

/**
 * Copies a file. Supports cross-provider copies.
 *
 * @param {Entry} from
 * @param {Entry|string} to - Destination entry, or a plain path string (same provider as `from`)
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @param {boolean} [options.overwrite=false] - When `true`, silently overwrites an existing file.
 * @returns {Promise<void>}
 */
export async function copyFile(from, to, options = {}) {
  to = _toEntry(to, from);
  const { path: oldPath, storageRef: srcRef = null } = from;
  const { path: newPath, storageRef: dstRef = null } = to;
  const { onProgress, overwrite = false } = options;
  try {
    if (_sameProvider(srcRef, dstRef)) {
      if (!srcRef) {
        await opfsProvider.copyFile(oldPath, newPath, onProgress, { overwrite });
      } else {
        const { providerId, storageId } = srcRef;
        await _providerSend(providerId, 'copyFile', { oldPath, newPath, overwrite, storageId }, onProgress);
      }
    } else {
      const file = await readFile(from, { onProgress });
      await _writeFile(to, file, { overwrite, onProgress });
    }
  } finally {
    _notifyStorageChanged({ kind: 'file', action: 'copied', target: { path: newPath, storageRef: dstRef }, source: { path: oldPath, storageRef: srcRef } });
  }
}

/**
 * Recursively copies a folder. Supports cross-provider copies.
 *
 * @param {Entry} from
 * @param {Entry|string} to - Destination entry, or a plain path string (same provider as `from`)
 * @param {object} [options={}]
 * @param {Function} [options.onProgress]
 * @param {boolean} [options.merge=false] - When `true`, merges with an existing folder instead of throwing.
 * @returns {Promise<void>}
 */
export async function copyFolder(from, to, options = {}) {
  to = _toEntry(to, from);
  const { path: oldPath, storageRef: srcRef = null } = from;
  const { path: newPath, storageRef: dstRef = null } = to;
  const { onProgress, merge = false } = options;
  if (_sameProvider(srcRef, dstRef)) {
    if (!srcRef) {
      await opfsProvider.copyDir(oldPath, newPath, onProgress, { merge });
    } else {
      const { providerId, storageId } = srcRef;
      await _providerSend(providerId, 'copyFolder', { oldPath, newPath, merge, storageId }, onProgress);
    }
  } else {
    const completed = [];
    try {
      await _crossProviderCopyFolder(from, to, merge, onProgress, completed);
    } catch (e) {
      if (completed.length > 0) _notifyStorageChanged(...completed);
      throw e;
    }
  }
  _notifyStorageChanged({ kind: 'directory', action: 'copied', target: { path: newPath, storageRef: dstRef }, source: { path: oldPath, storageRef: srcRef } });
}

/**
 * Recursively copies a folder by processing each entry (file or sub-folder) individually.
 * Unlike `copyFolder`, this function reports progress after every single entry via
 * `onProgress({ percent, currentFile, totalFiles })`, enabling an accurate 0→100% bar.
 * `percent` is size-weighted (falls back to entry count when sizes are unknown). A second
 * callback `onCollect(total)` is fired after each `list()` batch during the initial
 * collection phase so callers can show a growing counter while the tree is being scanned.
 * Fires a single `onStorageChanged` event when the whole operation is complete.
 * Supports cross-provider copies.
 *
 * @param {Entry} from
 * @param {Entry} to - Destination entry (may be on a different provider)
 * @param {object} [options={}]
 * @param {boolean} [options.merge=false] - When `true`, merges with an existing folder instead of throwing.
 * @param {function({percent: number, currentFile: number, totalFiles: number})} [options.onProgress] - Called after each entry. `percent` is size-weighted; falls back to entry count when sizes are unknown.
 * @param {function(number)} [options.onCollect] - Called as `onCollect(total)` after each `list()` batch during collection.
 * @returns {Promise<void>}
 */
export async function copyFolderWithProgress(from, to, options = {}) {
  await _folderOpIndividually(from, to, 'copy', options);
}

/**
 * Recursively moves a folder by processing each entry (file or sub-folder) individually.
 * Unlike `moveFolder`, this function reports progress after every single entry via
 * `onProgress({ percent, currentFile, totalFiles })`, enabling an accurate 0→100% bar.
 * `percent` is size-weighted (falls back to entry count when sizes are unknown). A second
 * callback `onCollect(total)` is fired after each `list()` batch during the initial
 * collection phase so callers can show a growing counter while the tree is being scanned.
 * Fires a single `onStorageChanged` event when the whole operation is complete.
 * Supports cross-provider moves.
 *
 * @param {Entry} from
 * @param {Entry} to - Destination entry (may be on a different provider)
 * @param {object} [options={}]
 * @param {boolean} [options.merge=false] - When `true`, merges with an existing folder instead of throwing.
 * @param {function({percent: number, currentFile: number, totalFiles: number})} [options.onProgress] - Called after each entry. `percent` is size-weighted; falls back to entry count when sizes are unknown.
 * @param {function(number)} [options.onCollect] - Called as `onCollect(total)` after each `list()` batch during collection.
 * @returns {Promise<void>}
 */
export async function moveFolderWithProgress(from, to, options = {}) {
  await _folderOpIndividually(from, to, 'move', options);
}

/**
 * Returns the capabilities of the provider connection, or no capabilities if
 * the connection is not known.
 *
 * @param {StorageRef} [storageRef=null]
 * @returns {Promise<{file: {read,add,modify,delete}, folder: {read,add,modify,delete}}>}
 */
export async function getCapabilities(storageRef = null) {
  if (!storageRef) return opfsProvider.capabilities;
  const { providerId, storageId } = storageRef;
  const providers = await fetchProviderConnections();
  const conn = providers.flatMap(p => p.connections).find(c => c.storageRef?.providerId === providerId && c.storageRef?.storageId === storageId);
  return conn?.capabilities ?? { file: {}, folder: {} };
}

/**
 * Returns current storage usage for the active backend.
 * Providers that do not track usage should return `{ usage: null, quota: null }`.
 *
 * @param {StorageRef} [storageRef=null]
 * @returns {Promise<{usage: number|null, quota: number|null}>}
 */
export async function getStorageUsage(storageRef = null) {
  if (!storageRef) {
    if (!navigator.storage?.estimate) return { usage: null, quota: null };
    try {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage ?? null, quota: quota ?? null };
    } catch {
      return { usage: null, quota: null };
    }
  }
  const { providerId, storageId } = storageRef;
  return _providerSend(providerId, 'storageUsage', { storageId });
}

/**
 * Opens a file picker UI.
 *
 * In a WebExtension context (browser.windows available), opens a popup window.
 * In a plain web context, injects an inline modal overlay into the current page.
 *
 * @param {object} [options]
 * @param {Array<{description?: string, accept: Object<string, string[]>}>} [options.types]
 *   File type filter entries. Each entry has an optional `description` label and
 *   an `accept` map of MIME type → array of extensions (e.g. `{ "image/*": [".png", ".jpg"] }`).
 * @param {boolean} [options.excludeAcceptAllOption=false]
 *   When `true`, the "All files (*)" option is omitted from the type dropdown and
 *   the first type in `types` is pre-selected. Mirrors the native API option.
 * @param {number} [options.width=800]
 * @param {number} [options.height=600]
 * @param {string} [options.id]
 *   An identifier for this picker context. The picker remembers the last-used
 *   directory and storageRef per `id` and restores both on the next open, ignoring `startIn`.
 * @param {string} [options.startIn]
 *   Absolute path to open the picker in initially (e.g. `"/documents"`).
 *   Ignored when `id` is set and has a saved state.
 * @param {StorageRef} [options.storageRef]
 *   Open the picker pre-set to this connection. Ignored when `id` has saved state.
 *   When combined with `lockStorage`, the picker is restricted to this connection
 *   and the saved id-state is ignored.
 * @param {'strict'|'soft'} [options.lockStorage]
 *   Restrict the picker to the connection given by `storageRef`. Ignored when
 *   `storageRef` is not provided.
 *   - 'strict': the provider selector is rendered non-interactive; the user
 *     cannot switch connections.
 *   - 'soft':   the selector remains interactive so the user can copy files
 *     between connections, but the confirm button stays disabled while the
 *     active connection does not match `storageRef`.
 * @param {string} [options.opfsStorageName]
 *   Display name for the built-in OPFS (local storage) option in the provider dropdown.
 *   Has no effect on external providers, which use their own reported name.
 * @param {boolean} [options.multiple=false] - Allow selecting multiple files. When false
 *   (default), the returned array always contains exactly one entry.
 * @returns {Promise<Entry[]|null>} Array of `Entry` objects (each with `path` and `storageRef`), or null if cancelled.
 */
export function showSelectFilePicker(options = {}) {
  // mode=open is the default, no extra param needed
  return new Promise((resolve, reject) => {
    const sessionId = crypto.randomUUID();
    const { types = null, excludeAcceptAllOption = false, width = 800, height = 600, storageRef = null, lockStorage = null, multiple = false, id = null, startIn = null, opfsStorageName = null, buttons = null } = options;

    pendingPickers.set(sessionId, { resolve, reject, defaultValue: [] });

    const pickerParams = new URLSearchParams();
    pickerParams.set('session', sessionId);
    if (types?.length) pickerParams.set('types', JSON.stringify(types));
    if (excludeAcceptAllOption) pickerParams.set('excludeAcceptAll', '1');
    if (storageRef) pickerParams.set('storageRef', JSON.stringify(storageRef));
    if (lockStorage && storageRef) pickerParams.set('lockStorage', lockStorage);
    else if (lockStorage) console.warn('showSelectFilePicker: lockStorage ignored without storageRef');
    if (multiple) pickerParams.set('multiple', '1');
    if (id) pickerParams.set('id', id);
    if (startIn) pickerParams.set('startIn', startIn);
    if (opfsStorageName) pickerParams.set('opfsStorageName', opfsStorageName);
    if (buttons?.length) pickerParams.set('buttons', JSON.stringify(buttons));

    _openPopupWindow(sessionId, pickerParams, width, height).catch(reject);
  });
}

/**
 * Opens a file picker UI in "browse" mode.
 *
 * Same as `showSelectFilePicker` but without the Select/Open footer button.
 * The user can navigate the storage, inspect files in the preview pane, and
 * perform file operations via the context menu (rename, copy, move, delete,
 * create folder, upload). There's no selection result — the promise resolves
 * to `null` when the user closes the picker.
 *
 * @param {object} [options]
 * @param {number} [options.width=800]
 * @param {number} [options.height=600]
 * @param {string} [options.id]
 *   An identifier for this picker context. The picker remembers the last-used
 *   directory and storageRef per `id` and restores both on the next open, ignoring `startIn`.
 * @param {string} [options.startIn]
 *   Absolute path to open the picker in initially (e.g. `"/documents"`).
 *   Ignored when `id` is set and has a saved state.
 * @param {StorageRef} [options.storageRef]
 *   Open the picker pre-set to this connection. Ignored when `id` has saved state.
 *   When combined with `lockStorage`, the picker is restricted to this connection
 *   and the saved id-state is ignored.
 * @param {'strict'|'soft'} [options.lockStorage]
 *   Restrict the picker to the connection given by `storageRef`. Ignored when
 *   `storageRef` is not provided. 'strict' hides the provider selector; 'soft'
 *   keeps it interactive (useful for copying between connections) but has no
 *   confirm-button effect in browse mode since browse has no confirm button.
 * @param {string} [options.opfsStorageName]
 *   Display name for the built-in OPFS (local storage) option in the provider dropdown.
 * @returns {Promise<null>} Always resolves to `null`.
 */
export function showBrowseFilePicker(options = {}) {
  return new Promise((resolve, reject) => {
    const sessionId = crypto.randomUUID();
    const { width = 800, height = 600, storageRef = null, lockStorage = null, id = null, startIn = null, opfsStorageName = null, buttons = null } = options;

    pendingPickers.set(sessionId, { resolve, reject, defaultValue: null });

    const pickerParams = new URLSearchParams();
    pickerParams.set('session', sessionId);
    pickerParams.set('mode', 'browse');
    if (storageRef) pickerParams.set('storageRef', JSON.stringify(storageRef));
    if (lockStorage && storageRef) pickerParams.set('lockStorage', lockStorage);
    else if (lockStorage) console.warn('showBrowseFilePicker: lockStorage ignored without storageRef');
    if (id) pickerParams.set('id', id);
    if (startIn) pickerParams.set('startIn', startIn);
    if (opfsStorageName) pickerParams.set('opfsStorageName', opfsStorageName);
    if (buttons?.length) pickerParams.set('buttons', JSON.stringify(buttons));

    _openPopupWindow(sessionId, pickerParams, width, height).catch(reject);
  });
}

/**
 * Opens a save file picker UI.
 *
 * Same as `showSelectFilePicker` but the picker shows a filename input and a Save
 * button. The result path is the chosen directory joined with the entered filename.
 *
 * @param {object} [options]
 * @param {string} [options.suggestedName] - Pre-filled filename in the save input.
 * @param {Array<{description?: string, accept: Object<string, string[]>}>} [options.types]
 * @param {boolean} [options.excludeAcceptAllOption=false]
 * @param {string} [options.id]
 * @param {string} [options.startIn]
 * @param {StorageRef} [options.storageRef]
 * @param {'strict'|'soft'} [options.lockStorage]
 *   Restrict the picker to the connection given by `storageRef`. See
 *   `showSelectFilePicker` for semantics.
 * @param {string} [options.opfsStorageName]
 * @param {number} [options.width=800]
 * @param {number} [options.height=600]
 * @returns {Promise<Entry|null>}
 */
export function showSaveFilePicker(options = {}) {
  return new Promise((resolve, reject) => {
    const sessionId = crypto.randomUUID();
    const { types = null, excludeAcceptAllOption = false, width = 800, height = 600,
      storageRef = null, lockStorage = null, id = null, startIn = null, opfsStorageName = null,
      suggestedName = null, buttons = null } = options;

    pendingPickers.set(sessionId, { resolve, reject, defaultValue: null });

    const pickerParams = new URLSearchParams();
    pickerParams.set('session', sessionId);
    pickerParams.set('mode', 'save');
    if (types?.length) pickerParams.set('types', JSON.stringify(types));
    if (excludeAcceptAllOption) pickerParams.set('excludeAcceptAll', '1');
    if (storageRef) pickerParams.set('storageRef', JSON.stringify(storageRef));
    if (lockStorage && storageRef) pickerParams.set('lockStorage', lockStorage);
    else if (lockStorage) console.warn('showSaveFilePicker: lockStorage ignored without storageRef');
    if (id) pickerParams.set('id', id);
    if (startIn) pickerParams.set('startIn', startIn);
    if (opfsStorageName) pickerParams.set('opfsStorageName', opfsStorageName);
    if (suggestedName) pickerParams.set('suggestedName', suggestedName);
    if (buttons?.length) pickerParams.set('buttons', JSON.stringify(buttons));

    _openPopupWindow(sessionId, pickerParams, width, height).catch(reject);
  });
}

/**
 * Opens a directory picker UI.
 *
 * The user navigates to a folder and confirms.
 *
 * @param {object} [options]
 * @param {string} [options.id]
 * @param {string} [options.startIn]
 * @param {StorageRef} [options.storageRef]
 * @param {'strict'|'soft'} [options.lockStorage]
 *   Restrict the picker to the connection given by `storageRef`. See
 *   `showSelectFilePicker` for semantics.
 * @param {string} [options.opfsStorageName]
 * @param {number} [options.width=800]
 * @param {number} [options.height=600]
 * @returns {Promise<Entry|null>}
 */
export function showDirectoryPicker(options = {}) {
  return new Promise((resolve, reject) => {
    const sessionId = crypto.randomUUID();
    const { width = 800, height = 600, storageRef = null, lockStorage = null, id = null,
      startIn = null, opfsStorageName = null, buttons = null } = options;

    pendingPickers.set(sessionId, { resolve, reject, defaultValue: null });

    const pickerParams = new URLSearchParams();
    pickerParams.set('session', sessionId);
    pickerParams.set('mode', 'dir');
    if (storageRef) pickerParams.set('storageRef', JSON.stringify(storageRef));
    if (lockStorage && storageRef) pickerParams.set('lockStorage', lockStorage);
    else if (lockStorage) console.warn('showDirectoryPicker: lockStorage ignored without storageRef');
    if (id) pickerParams.set('id', id);
    if (startIn) pickerParams.set('startIn', startIn);
    if (opfsStorageName) pickerParams.set('opfsStorageName', opfsStorageName);
    if (buttons?.length) pickerParams.set('buttons', JSON.stringify(buttons));

    _openPopupWindow(sessionId, pickerParams, width, height).catch(reject);
  });
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Normalises the `to` argument of move/copy functions.
 * Accepts either a full Entry object or a plain path string (legacy form).
 * When a plain string is given, the storageRef is inherited from `from` so the
 * operation stays on the same provider — preserving backward compatibility.
 *
 * @param {Entry|string} to
 * @param {Entry} from
 * @returns {Entry}
 */
function _toEntry(to, from) {
  if (typeof to === 'string') return { path: to, storageRef: from.storageRef ?? null };
  return to;
}

function _sameProvider(a, b) {
  return (a?.providerId ?? null) === (b?.providerId ?? null) &&
         (a?.storageId  ?? null) === (b?.storageId  ?? null);
}

async function _writeFile(entry, fileOrBlob, options = {}) {
  const { path, storageRef = null } = entry;
  const { onProgress, overwrite = false } = options;
  if (!storageRef) {
    await opfsProvider.writeFile(path, fileOrBlob, onProgress, { overwrite });
  } else {
    const { providerId, storageId } = storageRef;
    await _providerSend(providerId, 'writeFile', { path, file: fileOrBlob, overwrite, storageId }, onProgress);
  }
}

async function _deleteFile(entry, options = {}) {
  const { path, storageRef = null } = entry;
  const { onProgress } = options;
  if (!storageRef) {
    await opfsProvider.deleteEntry(path, onProgress);
  } else {
    const { providerId, storageId } = storageRef;
    await _providerSend(providerId, 'deleteFile', { path, storageId }, onProgress);
  }
}

async function _addFolder(entry, options = {}) {
  const { path, storageRef = null } = entry;
  const { onProgress } = options;
  if (!storageRef) {
    await opfsProvider.addFolder(path, onProgress);
  } else {
    const { providerId, storageId } = storageRef;
    await _providerSend(providerId, 'addFolder', { path, storageId }, onProgress);
  }
}

async function _deleteFolder(entry, options = {}) {
  const { path, storageRef = null } = entry;
  const { onProgress } = options;
  if (!storageRef) {
    await opfsProvider.deleteEntry(path, onProgress);
  } else {
    const { providerId, storageId } = storageRef;
    await _providerSend(providerId, 'deleteFolder', { path, storageId }, onProgress);
  }
}

async function _moveFolder(from, to, options = {}) {
  const { path: oldPath, storageRef: srcRef = null } = from;
  const { path: newPath, storageRef: dstRef = null } = to;
  const { onProgress, merge = false } = options;
  if (_sameProvider(srcRef, dstRef)) {
    if (!srcRef) {
      await opfsProvider.moveFolder(oldPath, newPath, onProgress, { merge });
    } else {
      const { providerId, storageId } = srcRef;
      await _providerSend(providerId, 'moveFolder', { oldPath, newPath, merge, storageId }, onProgress);
    }
  } else {
    const completed = [];
    try {
      await _crossProviderCopyFolder(from, to, merge, onProgress, completed);
      await _deleteFolder(from, { onProgress });
    } catch (e) {
      if (completed.length > 0) _notifyStorageChanged(...completed);
      throw e;
    }
  }
}

async function _crossProviderCopyFolder(from, to, merge, onProgress, completed) {
  await _addFolder(to, { onProgress }).catch(e => {
    if (e.code !== 'E:EXIST' || !merge) throw e;
  });
  const entries = await list(from);
  for (const entry of entries) {
    const srcChild = { path: entry.path, storageRef: from.storageRef ?? null };
    const destChild = { path: `${to.path}/${entry.name}`, storageRef: to.storageRef ?? null };
    if (entry.kind === 'directory') {
      await _crossProviderCopyFolder(srcChild, destChild, merge, onProgress, completed);
      completed?.push({ kind: 'directory', action: 'copied',
        target: { path: destChild.path, storageRef: destChild.storageRef },
        source: { path: srcChild.path, storageRef: srcChild.storageRef } });
    } else {
      const file = await readFile(srcChild, { onProgress });
      await _writeFile(destChild, file, { overwrite: merge, onProgress });
      completed?.push({ kind: 'file', action: 'copied',
        target: { path: destChild.path, storageRef: destChild.storageRef },
        source: { path: srcChild.path, storageRef: srcChild.storageRef } });
    }
  }
}

/** Strips a trailing '/' from a path while keeping the root '/' intact. */
function _stripSlash(p) { return p.length > 1 ? p.replace(/\/$/, '') : p; }

/**
 * Recursively collects all entries (files and folders) under srcEntry into the
 * `entries` array, then calls `onCollect(total)` after each directory is listed.
 * Folder paths in the result end with '/' so that the descending sort in
 * _folderOpIndividually places files before their parent directory.
 */
async function _collectEntries(srcEntry, destEntry, entries, onCollect) {
  // list() is called without trailing slash for provider compatibility.
  const items = await list({ path: _stripSlash(srcEntry.path), storageRef: srcEntry.storageRef });
  for (const item of items) {
    const isFile = item.kind === 'file';
    // Ensure folder paths end with '/' so descending sort works correctly.
    const srcPath = isFile ? item.path : (item.path.endsWith('/') ? item.path : item.path + '/');
    const relativePath = srcPath.slice(srcEntry.path.length);
    const destPath = destEntry.path + relativePath;
    entries.push({ srcPath, destPath, isFile, size: item.size ?? 0 });
    if (!isFile) {
      await _collectEntries(
        { path: srcPath, storageRef: srcEntry.storageRef },
        { path: destPath, storageRef: destEntry.storageRef },
        entries, onCollect
      );
    }
  }
  onCollect?.(entries.length);
}

/**
 * Core implementation for copyFolderWithProgress / moveFolderWithProgress.
 *
 * Algorithm:
 *  1. Collect – recursively list all files and folders, firing onCollect(total) per batch.
 *  2. Sort    – descending lexicographic order; because folder paths end with '/' (ASCII 47,
 *               less than any letter/digit), files always sort before their parent folder.
 *  3. Process – for each entry: lazily create the destination directory, then copy/move the
 *               file or (for move) call _moveFolder as a safety net for any files added after
 *               the initial snapshot.
 *  4. Notify  – fire one _notifyStorageChanged for the whole operation.
 */
async function _folderOpIndividually(from, to, mode, options = {}) {
  const { merge = false, onProgress, onCollect } = options;
  const srcRef = from.storageRef ?? null;
  const dstRef = to.storageRef ?? null;

  // Normalise root paths to end with '/' so relative-path slicing is correct.
  const srcRoot = from.path.endsWith('/') ? from.path : from.path + '/';
  const dstRoot = to.path.endsWith('/') ? to.path : to.path + '/';

  // Step 1 – Collect.
  const entries = [];
  await _collectEntries({ path: srcRoot, storageRef: srcRef }, { path: dstRoot, storageRef: dstRef }, entries, onCollect);
  // The source root itself is not returned by list(), so add it manually.
  entries.push({ srcPath: srcRoot, destPath: dstRoot, isFile: false, size: 0 });

  // Step 2 – Sort descending.
  entries.sort((a, b) => b.srcPath < a.srcPath ? -1 : b.srcPath > a.srcPath ? 1 : 0);

  // Step 3 – Process.
  let lastCreatedTargetDir = '';
  let done = 0;
  const total = entries.length;
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  let doneBytes = 0;
  const completed = [];

  try {
    for (const entry of entries) {
      const targetDir = entry.isFile
        ? entry.destPath.slice(0, entry.destPath.lastIndexOf('/') + 1)
        : entry.destPath; // already ends with '/'

      // Lazily create the target directory once per unique path.
      // If lastCreatedTargetDir is a descendant of targetDir, mkdirp already built it.
      if (!lastCreatedTargetDir ||
          !(targetDir === lastCreatedTargetDir || lastCreatedTargetDir.startsWith(targetDir))) {
        await _addFolder({ path: _stripSlash(targetDir), storageRef: dstRef }, {}).catch(e => {
          if (e.code !== 'E:EXIST' || !merge) throw e;
        });
        lastCreatedTargetDir = targetDir;
      }

      if (entry.isFile) {
        const file = await readFile({ path: entry.srcPath, storageRef: srcRef });
        await _writeFile({ path: entry.destPath, storageRef: dstRef }, file, { overwrite: merge });
        if (mode === 'move') {
          await _deleteFile({ path: entry.srcPath, storageRef: srcRef }, {});
        }
      } else {
        if (mode === 'move') {
          // Safety net: move any files that arrived in this folder after the initial list()
          // snapshot, then delete the (now mostly-empty) source folder.
          // Errors are silently ignored — the folder may already be gone.
          await _moveFolder(
            { path: _stripSlash(entry.srcPath), storageRef: srcRef },
            { path: _stripSlash(entry.destPath), storageRef: dstRef },
            { merge: true }
          ).catch(() => {});
        }
      }

      doneBytes += entry.size;
      done++;
      // Use size-weighted percent when total size is known; fall back to entry count.
      const percent = totalBytes > 0
        ? Math.round(doneBytes / totalBytes * 100)
        : Math.round(done / total * 100);
      completed.push(entry.isFile
        ? { kind: 'file',
            action: mode === 'move' ? 'moved' : 'copied',
            target: { path: entry.destPath, storageRef: dstRef },
            source: { path: entry.srcPath, storageRef: srcRef } }
        : { kind: 'directory',
            action: mode === 'move' ? 'moved' : 'created',
            target: { path: _stripSlash(entry.destPath), storageRef: dstRef },
            ...(mode === 'move' && { source: { path: _stripSlash(entry.srcPath), storageRef: srcRef } }) });
      onProgress?.({ percent, currentFile: done, totalFiles: total });
    }
  } catch (e) {
    // Step 4a – Partial abort: fire individual completed events, not the whole-folder event.
    if (completed.length > 0) _notifyStorageChanged(...completed);
    throw e;
  }

  // Step 4b – Full success: single folder-level event.
  _notifyStorageChanged({
    kind: 'directory',
    action: mode === 'move' ? 'moved' : 'copied',
    target: { path: _stripSlash(to.path), storageRef: dstRef },
    source: { path: _stripSlash(from.path), storageRef: srcRef },
  });
}

function _notifyStorageChanged(...entries) {
  // This client made a storage modification, relay this to the background and
  // have it broadcasted to all active client.
  browser.runtime.sendMessage({ type: 'vfs-notify-background-storage-changed', entries }).catch(() => { });
}


function _pickerBaseUrl() {
  // import.meta.url points to vfs-client.mjs itself, so picker.html resolves
  // relative to it.
  return new URL('picker.html', import.meta.url).href;
}

async function _openPopupWindow(sessionId, pickerParams, width, height) {
  // Auto-inject action button registered via parseManifest.
  // When called from a page context (not background), _actionButton is null because
  // parseManifest was called in a different module instance. Ask the background instead.
  let actionBtn = _actionButton;
  if (!actionBtn && !_isBackground) {
    actionBtn = await browser.runtime.sendMessage({ type: 'vfs-toolkit-get-action-button' }).catch(() => null);
  }
  if (actionBtn) {
    const existing = pickerParams.has('buttons') ? JSON.parse(pickerParams.get('buttons')) : [];
    pickerParams.set('buttons', JSON.stringify([...existing, actionBtn]));
  }

  const popupUrl = _pickerBaseUrl() + '?' + pickerParams.toString();
  const { resolve, reject, defaultValue } = pendingPickers.get(sessionId);
  let windowId = null;

  // Listen for result via runtime messaging.
  function messageHandler(msg) {
    if (msg && msg.type === 'vfs-picker-result' && msg.session === sessionId) {
      browser.runtime.onMessage.removeListener(messageHandler);
      pendingPickers.delete(sessionId);
      // The picker window should be closed by the caller.
      resolve(msg.result ?? defaultValue);
    }
  }

  browser.runtime.onMessage.addListener(messageHandler);

  browser.windows.create({
    type: 'popup',
    url: popupUrl,
    width,
    height,
    allowScriptsToClose: true,
  }).then(win => {
    windowId = win.id;

    // If the popup window is closed without a result (user closed it manually),
    // clean up and resolve with the default value.
    function closedHandler(closedWindowId) {
      if (closedWindowId === windowId) {
        browser.windows.onRemoved.removeListener(closedHandler);
        if (pendingPickers.has(sessionId)) {
          browser.runtime.onMessage.removeListener(messageHandler);
          pendingPickers.delete(sessionId);
          resolve(defaultValue);
        }
      }
    }

    browser.windows.onRemoved.addListener(closedHandler);
  }).catch(err => {
    browser.runtime.onMessage.removeListener(messageHandler);
    pendingPickers.delete(sessionId);
    reject(err);
  });
}
