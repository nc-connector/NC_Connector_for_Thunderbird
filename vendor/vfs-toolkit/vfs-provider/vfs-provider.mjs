/**
 * vfs-provider.mjs - for documentation see README.md.
 */

const API_VERSION = "1.3";
const CONNECTIONS_KEY = 'vfs-toolkit-connections';

function _createLocalEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

function _createLocalPortPair() {
  const clientMessages = _createLocalEvent();
  const providerMessages = _createLocalEvent();
  const clientDisconnect = _createLocalEvent();
  const providerDisconnect = _createLocalEvent();
  let disconnected = false;
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    queueMicrotask(() => {
      clientDisconnect.emit();
      providerDisconnect.emit();
    });
  };
  const deliver = (event, message) => {
    if (disconnected) throw new Error('Attempt to postMessage on disconnected port');
    queueMicrotask(() => {
      if (!disconnected) event.emit(message);
    });
  };
  const clientPort = {
    name: 'vfs-toolkit',
    onMessage: clientMessages,
    onDisconnect: clientDisconnect,
    postMessage(message) { deliver(providerMessages, message); },
    disconnect,
  };
  const providerPort = {
    name: 'vfs-toolkit',
    sender: { id: browser.runtime.id },
    onMessage: providerMessages,
    onDisconnect: providerDisconnect,
    postMessage(message) { deliver(clientMessages, message); },
    disconnect,
  };
  return { clientPort, providerPort };
}

function _pickIconUrl(icons) {
  if (!icons) return null;
  const entries = Array.isArray(icons)
    ? icons.map(i => ({ size: i.size, url: i.url }))
    : Object.entries(icons).map(([size, url]) => ({ size: parseInt(size), url }));
  if (!entries.length) return null;
  entries.sort((a, b) => a.size - b.size);
  return (entries.find(e => e.size >= 32) ?? entries[entries.length - 1]).url;
}

async function _fetchOwnIconBlob() {
  try {
    const url = _pickIconUrl(browser.runtime.getManifest().icons);
    if (!url) return null;
    const resp = await fetch(browser.runtime.getURL(url));
    return resp.ok ? await resp.blob() : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} Entry
 * @property {string} name - File or folder name (without path).
 * @property {string} path - Absolute path, e.g. `"/documents/notes.txt"`.
 * @property {'file'|'directory'} kind - Item type.
 * @property {number} [size] - File size in bytes (files only).
 * @property {number} [lastModified] - Last-modified timestamp in ms since epoch (files only).
 */

/**
 * @typedef {object} StorageChangeEntry
 * @property {'file'|'directory'} kind - Item type.
 * @property {'created'|'modified'|'deleted'|'moved'|'copied'} action - What happened to the item.
 * @property {{ path: string }} target - Destination location (or the affected location for non-move/copy actions).
 * @property {{ path: string }} [source] - Source location (present only for 'moved' and 'copied' actions).
 */

/**
 * @typedef {object} StorageUsage
 * @property {number|null} usage - Bytes used, or `null` if unavailable.
 * @property {number|null} quota - Total bytes available, or `null` if unavailable.
 */

/**
 * @typedef {object} CapabilityFlags
 * @property {boolean} read - Whether listing/reading is supported.
 * @property {boolean} add - Whether creating new entries is supported.
 * @property {boolean} modify - Whether modifying existing entries is supported.
 * @property {boolean} delete - Whether deleting entries is supported.
 */

/**
 * @typedef {object} Capabilities
 * @property {CapabilityFlags} file - Capabilities for file operations.
 * @property {CapabilityFlags} folder - Capabilities for folder operations.
 */

export class VfsProviderImplementation {
  #name;
  #setupPath;
  #setupWidth;
  #setupHeight;
  #configPath;
  #configWidth;
  #configHeight;
  #requestPorts = new Map();
  #activePorts = new Set();
  #pendingSetups = new Map();
  #connectionPortHandler = null;

  /**
   * @param {object} options
   * @param {string} options.name - Human-readable provider name shown in the picker.
   * @param {string} [options.setupPath] - Path to the setup page (e.g. '/setup/setup.html').
   * @param {number} [options.setupWidth] - Width of the setup popup window in pixels.
   * @param {number} [options.setupHeight] - Height of the setup popup window in pixels.
   * @param {string} [options.configPath] - Path to the config page (e.g. '/config/config.html').
   * @param {number} [options.configWidth] - Width of the config popup window in pixels.
   * @param {number} [options.configHeight] - Height of the config popup window in pixels.
   */
  constructor(options = {}) {
    this.#name = options?.name ?? browser.runtime.getManifest().name;
    this.#setupPath = options?.setupPath ?? null;
    this.#setupWidth = options?.setupWidth ?? 480;
    this.#setupHeight = options?.setupHeight ?? 300;
    this.#configPath = options?.configPath ?? null;
    this.#configWidth = options?.configWidth ?? 480;
    this.#configHeight = options?.configHeight ?? 300;
  }

  /**
   * Called when a running request should be canceled.
   *
   * @param {string} canceledRequestId - The request ID of the operation to cancel.
   */
  async onCancel(canceledRequestId) {
    throw new Error(`Not Implemented: onCancel`);
  }

  /**
   * Returns information about the storage usage of the provider.
   *
   * @param {string} storageId - The storage ID.
   * @returns {Promise<StorageUsage>}
   */
  async onStorageUsage(storageId) {
    throw new Error(`Not Implemented: onStorageUsage`);
  }

  /**
   * Lists files and folders at the specified path.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} path - The path to list.
   * @returns {Promise<Array<Entry>>}
   */
  async onList(requestId, storageId, path) {
    throw new Error(`Not Implemented: onList`);
  }

  /**
   * Reads a file from the specified path.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} path - The file path.
   * @returns {Promise<File|Blob>} The file content.
   */
  async onReadFile(requestId, storageId, path) {
    throw new Error(`Not Implemented: onReadFile`);
  }

  /**
   * Writes a file to the specified path.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} path - The destination path.
   * @param {File|Blob} file - The file content to write.
   * @param {boolean} overwrite - Whether the function should throw an E:EXIST
   *    error or overwrite the target file, if it exists already.
   */
  async onWriteFile(requestId, storageId, path, file, overwrite) {
    throw new Error(`Not Implemented: onWriteFile`);
  }

  /**
   * Creates a new folder at the specified path.
   * **Throws** an `E:EXIST` error if the folder already exists.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} path - The folder path to create.
   */
  async onAddFolder(requestId, storageId, path) {
    throw new Error(`Not Implemented: onAddFolder`);
  }

  /**
   * Moves a file to a new location.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} oldPath - The current file path.
   * @param {string} newPath - The full destination path.
   * @param {boolean} overwrite - Whether the function should throw an E:EXIST
   *    error or overwrite the target file, if it exists already.
   */
  async onMoveFile(requestId, storageId, oldPath, newPath, overwrite) {
    throw new Error(`Not Implemented: onMoveFile`);
  }

  /**
   * Moves a folder to a new location.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} oldPath - The current folder path.
   * @param {string} newPath - The full destination path.
   * @param {boolean} merge - Whether the function should throw an E:EXIST
   *    error or merge the folder contents, if the target folder exists already.
   */
  async onMoveFolder(requestId, storageId, oldPath, newPath, merge) {
    throw new Error(`Not Implemented: onMoveFolder`);
  }

  /**
   * Copies a file to a new location.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} oldPath - The source file path.
   * @param {string} newPath - The full destination path.
   * @param {boolean} overwrite - Whether the function should throw an E:EXIST
   *    error or overwrite the target file, if it exists already.
   */
  async onCopyFile(requestId, storageId, oldPath, newPath, overwrite) {
    throw new Error(`Not Implemented: onCopyFile`);
  }

  /**
   * Copies a folder to a new location.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} oldPath - The source folder path.
   * @param {string} newPath - The full destination path.
   * @param {boolean} merge - Whether the function should throw an E:EXIST
   *    error or merge the folder contents, if the target folder exists already.
   */
  async onCopyFolder(requestId, storageId, oldPath, newPath, merge) {
    throw new Error(`Not Implemented: onCopyFolder`);
  }

  /**
   * Deletes a file.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} path - The file path to delete.
   */
  async onDeleteFile(requestId, storageId, path) {
    throw new Error(`Not Implemented: onDeleteFile`);
  }

  /**
   * Deletes a folder.
   *
   * @param {string} requestId - The ID of the request.
   * @param {string} storageId - The storage ID.
   * @param {string} path - The folder path to delete.
   */
  async onDeleteFolder(requestId, storageId, path) {
    throw new Error(`Not Implemented: onDeleteFolder`);
  }

  /**
   * Sends a progress update to the client that initiated the given request.
   * Call from within an `on*` handler during long-running operations.
   *
   * @param {string} requestId - The request ID passed to the active `on*` handler.
   * @param {number} percent - Completion percentage, 0–100.
   * @param {number} [currentFile] - 1-based index of the file currently being processed (batch operations).
   * @param {number} [totalFiles] - Total number of files in the batch (batch operations).
   */
  reportProgress(requestId, percent, currentFile, totalFiles) {
    const port = this.#requestPorts.get(requestId);
    port.postMessage({
      type: 'vfs-progress',
      requestId,
      percent,
      currentFile,
      totalFiles,
    });
  }

  /**
   * Broadcasts a storage-changed notification to all connected vfs-toolkit clients.
   * Call this when the provider detects an out-of-band change (e.g. a background
   * sync) that was not triggered by a client request.
   *
   * @param {string} storageId - The storage ID of the affected connection.
   * @param {StorageChangeEntry[]} entries - Entries describing what changed.
   */
  reportStorageChange(storageId, entries) {
    for (const port of this.#activePorts) {
      port.postMessage({ type: 'vfs-storage-changed', storageId, entries });
    }
  }

  /**
   * Connects a client hosted in the same background document.
   */
  connectLocal() {
    if (!this.#connectionPortHandler) {
      throw new Error('Provider is not initialized');
    }
    const { clientPort, providerPort } = _createLocalPortPair();
    this.#connectionPortHandler(providerPort);
    return clientPort;
  }

  /**
   * Registers the provider with the browser extension runtime.
   * Call this once from your extension's background script.
   * Sets up the discovery listener (`vfs-toolkit-discover` message) and
   * the port listener for all vfs-toolkit client connections.
   */
  init() {
    // ── Setup completion listeners ─────────────────────────────────────────────────

    // The setup page reports success by calling reportNewConnection(..., setupToken),
    // which dispatches this in-extension runtime message. Resolve the matching entry.
    browser.runtime.onMessage.addListener(msg => {
      if (msg?.type !== 'vfs-provider-setup-completed') return;
      const entry = this.#pendingSetups.get(msg.setupToken);
      if (!entry) return;
      this.#pendingSetups.delete(msg.setupToken);
      entry.resolve(msg.storageId);
    });

    // If the setup window closes without a completion message, reject after a short
    // grace so the success path (reportNewConnection then window.close) can land first.
    browser.windows.onRemoved.addListener(winId => {
      for (const [token, entry] of this.#pendingSetups) {
        if (entry.windowId !== winId) continue;
        setTimeout(() => {
          const still = this.#pendingSetups.get(token);
          if (!still) return;
          this.#pendingSetups.delete(token);
          still.reject(new Error('Setup cancelled'));
        }, 500);
      }
    });

    // ── Discovery listener ─────────────────────────────────────────────────────────

    browser.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'vfs-toolkit-discover') {
        Promise.all([
          browser.storage.local.get({ [CONNECTIONS_KEY]: [] }),
          _fetchOwnIconBlob(),
        ]).then(([rv, icon]) => {
          const connections = rv[CONNECTIONS_KEY]
            .filter(c => c.addonId === sender.id)
            .map(({ storageId, name, capabilities }) => ({ storageId, name, capabilities }));
          sendResponse({ name: this.#name, API_VERSION, connections, icon, hasConfig: !!this.#configPath });
        });
        return true;
      }
    });

    // ── Port listener ──────────────────────────────────────────────────────────────

    const connectionPortHandler = port => {
      if (port.name !== 'vfs-toolkit') return;

      this.#activePorts.add(port);
      port.onDisconnect.addListener(() => this.#activePorts.delete(port));

      port.onMessage.addListener(async msg => {
        const { requestId, cmd, ...args } = msg;

        this.#requestPorts.set(requestId, port);
        try {
          const result = await handleCommand(cmd, args, requestId);
          port.postMessage({ requestId, ok: true, result });
        } catch (err) {
          port.postMessage({ requestId, ok: false, error: err.message, errorCode: err.code, errorDetails: err.details });
        }
        this.#requestPorts.delete(requestId);
      });
    };
    this.#connectionPortHandler = connectionPortHandler;
    browser.runtime.onConnectExternal.addListener(connectionPortHandler);
    browser.runtime.onConnect.addListener(connectionPortHandler);

    // ── Command handling────────────────────────────────────────────────────────────

    const handleCommand = async (cmd, args, requestId) => {
      switch (cmd) {

        case 'cancel': {
          await this.onCancel(args.canceledRequestId);
          return;
        }

        case 'storageUsage': {
          return this.onStorageUsage(args.storageId);
        }

        case 'list': {
          return this.onList(requestId, args.storageId, args.path);
        }

        case 'readFile': {
          return this.onReadFile(requestId, args.storageId, args.path);
        }

        case 'writeFile': {
          await this.onWriteFile(requestId, args.storageId, args.path, args.file, args.overwrite);
          return;
        }

        case 'addFolder': {
          await this.onAddFolder(requestId, args.storageId, args.path);
          return;
        }

        case 'moveFile': {
          await this.onMoveFile(requestId, args.storageId, args.oldPath, args.newPath, args.overwrite);
          return;
        }

        case 'moveFolder': {
          await this.onMoveFolder(requestId, args.storageId, args.oldPath, args.newPath, args.merge);
          return;
        }

        case 'copyFile': {
          await this.onCopyFile(requestId, args.storageId, args.oldPath, args.newPath, args.overwrite);
          return;
        }

        case 'copyFolder': {
          await this.onCopyFolder(requestId, args.storageId, args.oldPath, args.newPath, args.merge);
          return;
        }

        case 'deleteFile': {
          await this.onDeleteFile(requestId, args.storageId, args.path);
          return;
        }

        case 'deleteFolder': {
          await this.onDeleteFolder(requestId, args.storageId, args.path);
          return;
        }

        case 'deleteConnection': {
          const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
          await browser.storage.local.set({
            [CONNECTIONS_KEY]: rv[CONNECTIONS_KEY].filter(
              c => !(c.addonId === args.addonId && c.storageId === args.storageId)
            )
          });
          browser.runtime.sendMessage(args.addonId, { type: 'vfs-toolkit-remove-connection', storageId: args.storageId }).catch(() => { });
          return;
        }

        case 'openSetup': {
          if (!this.#setupPath) throw new Error('Provider has no setup page');
          const setupToken = crypto.randomUUID();
          const url = new URL(browser.runtime.getURL(this.#setupPath));
          if (args.addonId) url.searchParams.set('addonId', args.addonId);
          if (args.addonName) url.searchParams.set('addonName', args.addonName);
          url.searchParams.set('setupToken', setupToken);
          const win = await browser.windows.create({ url: url.toString(), type: 'popup', width: this.#setupWidth, height: this.#setupHeight });
          return new Promise((resolve, reject) => {
            this.#pendingSetups.set(setupToken, { resolve, reject, windowId: win.id });
          });
        }

        case 'openConfig': {
          if (!this.#configPath) throw new Error('Provider has no config page');
          const url = new URL(browser.runtime.getURL(this.#configPath));
          if (args.addonId) url.searchParams.set('addonId', args.addonId);
          if (args.storageId) url.searchParams.set('storageId', args.storageId);
          browser.windows.create({ url: url.toString(), type: 'popup', width: this.#configWidth, height: this.#configHeight });
          return null;
        }

        default:
          throw new Error(`Unknown command: ${cmd}`);
      }
    }
  }
}

/**
 * Inform the consumer add-on identified by add-on id, that a new connection has
 * been established. Persists the connection in the provider's local storage so
 * it can be included in future `vfs-toolkit-discover` handshake responses.
 *
 * @param {string} addonId
 * @param {string} addonName
 * @param {string} storageId
 * @param {string} name
 * @param {object} [capabilities]
 * @param {string} [setupToken] - The token from the setup page URL. When present,
 *   resolves the picker-side `openProviderSetup` promise so the picker can switch
 *   to the new connection.
 */
export async function reportNewConnection(addonId, addonName, storageId, name, capabilities, setupToken) {
  const rv = await browser.storage.local.get({ [CONNECTIONS_KEY]: [] });
  const list = rv[CONNECTIONS_KEY];
  const idx = list.findIndex(c => c.addonId === addonId && c.storageId === storageId);
  const entry = { addonId, addonName, storageId, name, capabilities };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  await browser.storage.local.set({ [CONNECTIONS_KEY]: list });
  await browser.runtime.sendMessage(addonId, { type: 'vfs-toolkit-add-connection', storageId, name, capabilities }).catch(() => { });
  if (setupToken) {
    browser.runtime.sendMessage({ type: 'vfs-provider-setup-completed', setupToken, storageId }).catch(() => { });
  }
}
