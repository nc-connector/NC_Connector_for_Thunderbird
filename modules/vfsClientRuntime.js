/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const EXTERNAL_ENABLED_KEY = 'ncVfsExternalProvidersEnabled';
  const CLIENT_CONFIG_KEY = 'ncVfsClientProvidersV1';
  const SOURCE_SELECTION_PORT = 'nc-vfs-source-selection';
  const SELF_ADDON_ID = browser.runtime.id;
  let client = null;
  let externalDiscoveryInitialized = false;

  function createAbortError(){
    return new DOMException('Cancelled', 'AbortError');
  }

  function throwIfAborted(signal){
    if (signal?.aborted){
      throw createAbortError();
    }
  }

  async function hasManagementPermission(){
    return browser.permissions.contains({ permissions: ['management'] });
  }

  async function readExternalEnabled(){
    const stored = await browser.storage.local.get({ [EXTERNAL_ENABLED_KEY]: false });
    return stored[EXTERNAL_ENABLED_KEY] === true;
  }

  async function initializeClient(){
    await global.NCVfsProviderRuntime.ready();
    client = await import(
      browser.runtime.getURL('vendor/vfs-toolkit/vfs-client/vfs-client.mjs')
    );
    const permissionGranted = await hasManagementPermission();
    const externalEnabled = await readExternalEnabled();
    externalDiscoveryInitialized = permissionGranted && externalEnabled;
    await client.init({
      enableExternalProviders: externalDiscoveryInitialized,
      configStorageKey: CLIENT_CONFIG_KEY
    });
    await syncOwnProvider(await global.NCVfsProviderRuntime.getStatus());
    return client;
  }

  const readyPromise = initializeClient();

  function normalizeStorageRef(value){
    const providerId = String(value?.providerId || '').trim();
    const storageId = String(value?.storageId || '').trim();
    if (!providerId || !storageId){
      return null;
    }
    return Object.freeze({ providerId, storageId });
  }

  function sameStorageRef(left, right){
    return left?.providerId === right?.providerId
      && left?.storageId === right?.storageId;
  }

  async function syncOwnProvider(status){
    const storageRef = normalizeStorageRef(status?.selfStorageRef);
    const storageName = String(status?.accountLabel || 'Nextcloud');
    await client.registerLocalProvider({
      providerId: SELF_ADDON_ID,
      name: browser.runtime.getManifest().name,
      connections: status?.accountConfigured === true && storageRef
        ? [{
            storageId: storageRef.storageId,
            name: storageName,
            capabilities: global.NCVfsProviderRuntime.PROVIDER_CAPABILITIES
          }]
        : [],
      icon: null,
      hasConfig: false
    }, () => global.NCVfsProviderRuntime.connectLocal());
  }

  function normalizeEntryPath(value, { allowRoot = true } = {}){
    const path = String(value || '');
    if (!path.startsWith('/')
      || path.includes('\\')
      || path.includes('\0')
      || path.includes('//')){
      throw new Error(bgI18n('vfs_error_invalid_path'));
    }
    const segments = path.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '.' || segment === '..')){
      throw new Error(bgI18n('vfs_error_invalid_path'));
    }
    if (!allowRoot && !segments.length){
      throw new Error(bgI18n('vfs_error_root_not_selectable'));
    }
    return segments.length ? `/${segments.join('/')}` : '/';
  }

  function parentPath(path){
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
  }

  function pathName(path){
    return path.split('/').filter(Boolean).pop() || '';
  }

  function relativePath(rootPath, entryPath){
    const rootParent = parentPath(rootPath);
    if (rootParent === '/'){
      return entryPath.slice(1);
    }
    if (!entryPath.startsWith(`${rootParent}/`)){
      throw new Error(bgI18n('vfs_error_invalid_path'));
    }
    return entryPath.slice(rootParent.length + 1);
  }

  function splitTargetPath(path){
    const normalized = String(path || '').replace(/^\/+|\/+$/g, '');
    const index = normalized.lastIndexOf('/');
    return Object.freeze({
      name: index >= 0 ? normalized.slice(index + 1) : normalized,
      relativeDir: index >= 0 ? normalized.slice(0, index) : ''
    });
  }

  async function listConnections(){
    const toolkit = await readyPromise;
    return toolkit.fetchProviderConnections();
  }

  function flattenConnections(providers){
    const entries = [];
    for (const providerInfo of providers || []){
      for (const connection of providerInfo?.connections || []){
        const storageRef = normalizeStorageRef(connection.storageRef);
        if (!storageRef){
          continue;
        }
        const providerName = String(providerInfo.name || providerInfo.providerId || '');
        const storageName = String(connection.name || '');
        entries.push(Object.freeze({
          storageRef,
          icon: providerInfo.icon || null,
          providerName,
          storageName,
          label: storageName && storageName !== providerName
            ? `${providerName} · ${storageName}`
            : (providerName || storageName),
          capabilities: connection.capabilities || null
        }));
      }
    }
    return entries;
  }

  async function listExternalConnections(){
    if (!(await readExternalEnabled()) || !(await hasManagementPermission())){
      return [];
    }
    const providers = await listConnections();
    return flattenConnections(
      providers.filter((providerInfo) => providerInfo.providerId !== SELF_ADDON_ID)
    );
  }

  async function listExternalProviders(){
    if (!(await readExternalEnabled()) || !(await hasManagementPermission())){
      return [];
    }
    const providers = await listConnections();
    return providers
      .filter((providerInfo) => providerInfo.providerId !== SELF_ADDON_ID)
      .map((providerInfo) => Object.freeze({
        providerId: String(providerInfo.providerId || ''),
        providerName: String(providerInfo.name || providerInfo.providerId || ''),
        connectionCount: Array.isArray(providerInfo.connections)
          ? providerInfo.connections.length
          : 0
      }))
      .filter((providerInfo) => providerInfo.providerId);
  }

  async function connectExternalProvider(providerId){
    if (!(await readExternalEnabled()) || !(await hasManagementPermission())){
      throw new Error(bgI18n('vfs_error_management_permission_missing'));
    }
    const normalizedProviderId = String(providerId || '').trim();
    if (!normalizedProviderId || normalizedProviderId === SELF_ADDON_ID){
      throw new Error(bgI18n('vfs_error_external_connection_missing'));
    }
    const toolkit = await readyPromise;
    const providerInfo = (await listConnections()).find((entry) =>
      entry.providerId === normalizedProviderId
    );
    if (!providerInfo){
      throw new Error(bgI18n('vfs_error_external_connection_missing'));
    }
    const storageRef = await toolkit.openProviderSetup(
      normalizedProviderId,
      browser.runtime.getManifest().name
    );
    return resolveExternalConnection(storageRef);
  }

  async function disconnectExternalConnection(storageRef){
    if (!(await readExternalEnabled()) || !(await hasManagementPermission())){
      throw new Error(bgI18n('vfs_error_management_permission_missing'));
    }
    const normalized = normalizeStorageRef(storageRef);
    if (!normalized || normalized.providerId === SELF_ADDON_ID){
      throw new Error(bgI18n('vfs_error_external_connection_missing'));
    }
    const toolkit = await readyPromise;
    const existing = (await listExternalConnections()).some((connection) =>
      sameStorageRef(connection.storageRef, normalized)
    );
    if (!existing){
      throw new Error(bgI18n('vfs_error_external_connection_missing'));
    }

    // Provider-side deletion and the Toolkit's local connection update are two
    // messages. Listen before deleting, then verify the exact storage ref so
    // the options UI never reports success while a stale connection remains.
    let settled = false;
    let timeoutId = 0;
    let resolveChanged;
    const changed = new Promise((resolve) => {
      resolveChanged = resolve;
    });
    const finish = () => {
      if (settled){
        return;
      }
      settled = true;
      global.clearTimeout(timeoutId);
      toolkit.onConnectionsChanged.removeListener(onConnectionsChanged);
      resolveChanged();
    };
    const verifyRemoved = async () => {
      const stillConnected = (await listExternalConnections()).some((connection) =>
        sameStorageRef(connection.storageRef, normalized)
      );
      if (!stillConnected){
        finish();
      }
    };
    const onConnectionsChanged = () => {
      void verifyRemoved().catch(() => finish());
    };
    toolkit.onConnectionsChanged.addListener(onConnectionsChanged);
    timeoutId = global.setTimeout(finish, 5000);
    try{
      await toolkit.deleteProviderConnection(normalized);
      await verifyRemoved();
      await changed;
      const stillConnected = (await listExternalConnections()).some((connection) =>
        sameStorageRef(connection.storageRef, normalized)
      );
      if (stillConnected){
        throw new Error(bgI18n('options_vfs_action_failed'));
      }
    }finally{
      finish();
    }
  }

  async function resolveExternalConnection(storageRef){
    const normalized = normalizeStorageRef(storageRef);
    if (!normalized || normalized.providerId === SELF_ADDON_ID){
      throw new Error(bgI18n('vfs_error_external_connection_missing'));
    }
    const connection = (await listExternalConnections()).find((candidate) =>
      sameStorageRef(candidate.storageRef, normalized)
    );
    if (!connection){
      throw new Error(bgI18n('vfs_error_external_connection_missing'));
    }
    return connection;
  }

  async function resolveOwnConnection(){
    await readyPromise;
    const status = await global.NCVfsProviderRuntime.getStatus();
    // Provider state and Toolkit picker state live in separate stores. Refresh
    // the co-located descriptor immediately before locking a picker to it.
    await syncOwnProvider(status);
    const storageRef = normalizeStorageRef(status.selfStorageRef);
    if (!status.accountConfigured || !storageRef){
      throw new Error(bgI18n('error_credentials_missing'));
    }
    return Object.freeze({
      storageRef,
      providerName: browser.runtime.getManifest().name,
      storageName: status.accountLabel,
      label: status.accountLabel
    });
  }

  async function collectDirectory(toolkit, rootEntry, selection, postProgress){
    const storageRef = normalizeStorageRef(rootEntry.storageRef);
    const rootPath = normalizeEntryPath(rootEntry.path, { allowRoot: false });
    const pending = [rootPath];
    let pendingIndex = 0;
    const visited = new Set();
    const entryPaths = new Set([rootPath]);
    const entries = [{
      path: rootPath,
      name: pathName(rootPath),
      kind: 'directory',
      storageRef
    }];
    while (pendingIndex < pending.length){
      throwIfAborted(selection.controller.signal);
      const currentPath = pending[pendingIndex++];
      if (visited.has(currentPath)){
        continue;
      }
      visited.add(currentPath);
      const children = await toolkit.list(
        { path: currentPath, storageRef },
        {
          signal: selection.controller.signal,
          onProgress: ({ currentFile, totalFiles }) => {
            if (Number.isFinite(currentFile)){
              postProgress(entries.length + Number(currentFile), Number(totalFiles) || 0);
            }
          }
        }
      );
      throwIfAborted(selection.controller.signal);
      for (const child of children){
        const childStorageRef = normalizeStorageRef(child.storageRef);
        if (!sameStorageRef(storageRef, childStorageRef)){
          throw new Error(bgI18n('vfs_error_storage_changed'));
        }
        const childPath = normalizeEntryPath(child.path, { allowRoot: false });
        if (!childPath.startsWith(`${rootPath}/`) || parentPath(childPath) !== currentPath){
          throw new Error(bgI18n('vfs_error_invalid_path'));
        }
        if (entryPaths.has(childPath)){
          throw new Error(bgI18n('vfs_error_duplicate_path'));
        }
        entryPaths.add(childPath);
        if (child.kind !== 'directory' && child.kind !== 'file'){
          throw new Error(bgI18n('vfs_error_invalid_path'));
        }
        const kind = child.kind;
        entries.push({
          path: childPath,
          name: pathName(childPath),
          kind,
          size: kind === 'file'
            && typeof child.size === 'number'
            && Number.isFinite(child.size)
            ? Math.max(0, child.size)
            : null,
          lastModified: Math.max(0, Number(child.lastModified) || 0),
          storageRef
        });
        if (kind === 'directory'){
          pending.push(childPath);
        }
      }
      postProgress(entries.length, 0);
    }
    return entries;
  }

  function buildQueueDescriptors({
    sourceKind,
    connection,
    selectedRoot,
    entries,
    folderSelection
  }){
    const storageRef = connection.storageRef;
    const groupId = `vfs-${crypto.randomUUID()}`;
    const rootPath = normalizeEntryPath(selectedRoot.path, { allowRoot: false });
    return entries.map((entry) => {
      const sourcePath = normalizeEntryPath(entry.path, { allowRoot: false });
      const targetPath = folderSelection
        ? relativePath(rootPath, sourcePath)
        : pathName(sourcePath);
      const target = splitTargetPath(targetPath);
      const directory = entry.kind === 'directory';
      if (sourceKind === 'external-vfs'
        && !directory
        && (typeof entry.size !== 'number'
          || !Number.isFinite(entry.size)
          || entry.size < 0)){
        throw new Error(bgI18n('vfs_error_file_metadata_missing'));
      }
      let transferRole = 'item';
      if (sourceKind === 'nextcloud'){
        transferRole = sourcePath === rootPath ? 'copy-root' : 'copy-child';
      }else if (directory){
        transferRole = 'directory';
      }
      return Object.freeze({
        sourceKind,
        sourceLabel: sourceKind === 'nextcloud' ? '' : connection.label,
        kind: directory ? 'folder' : 'file',
        name: target.name,
        storageRef,
        sourcePath,
        size: directory
          ? 0
          : (Number.isFinite(Number(entry.size)) ? Math.max(0, Number(entry.size)) : null),
        lastModified: directory ? 0 : Math.max(0, Number(entry.lastModified) || 0),
        contentType: 'application/octet-stream',
        transferGroupId: groupId,
        transferRole,
        transferRoot: sourcePath === rootPath,
        displayPath: targetPath,
        relativeDir: target.relativeDir
      });
    });
  }

  async function selectSources(request, selection, postProgress){
    const toolkit = await readyPromise;
    const sourceKind = request?.sourceKind === 'nextcloud'
      ? 'nextcloud'
      : 'external-vfs';
    const entryKind = request?.entryKind === 'folder' ? 'folder' : 'file';
    const connection = sourceKind === 'nextcloud'
      ? await resolveOwnConnection()
      : await resolveExternalConnection(request?.storageRef);
    throwIfAborted(selection.controller.signal);
    const pickerOptions = {
      storageRef: connection.storageRef,
      lockStorage: 'strict',
      width: 860,
      height: 640,
      id: `nc-connector-${sourceKind}-${entryKind}`,
      showToolbarActions: false,
      showContextMenu: false,
      signal: selection.controller.signal
    };
    const selected = entryKind === 'folder'
      ? await toolkit.showDirectoryPicker(pickerOptions)
      : await toolkit.showSelectFilePicker({ ...pickerOptions, multiple: true });
    throwIfAborted(selection.controller.signal);
    if (!selected || (Array.isArray(selected) && !selected.length)){
      return Object.freeze({ cancelled: true, entries: [] });
    }
    const selectedEntries = Array.isArray(selected) ? selected : [selected];
    const queueEntries = [];
    for (const selectedEntry of selectedEntries){
      const selectedStorageRef = normalizeStorageRef(selectedEntry.storageRef);
      if (!sameStorageRef(connection.storageRef, selectedStorageRef)){
        throw new Error(bgI18n('vfs_error_storage_changed'));
      }
      const selectedPath = normalizeEntryPath(selectedEntry.path, { allowRoot: false });
      const expectedKind = entryKind === 'folder' ? 'directory' : 'file';
      if (selectedEntry.kind !== expectedKind){
        throw new Error(bgI18n('vfs_error_invalid_path'));
      }
      const normalizedSelection = {
        ...selectedEntry,
        path: selectedPath,
        name: pathName(selectedPath),
        storageRef: selectedStorageRef,
        kind: expectedKind
      };
      const entries = entryKind === 'folder'
        ? await collectDirectory(toolkit, normalizedSelection, selection, postProgress)
        : [normalizedSelection];
      queueEntries.push(...buildQueueDescriptors({
        sourceKind,
        connection,
        selectedRoot: normalizedSelection,
        entries,
        folderSelection: entryKind === 'folder'
      }));
    }
    return Object.freeze({ cancelled: false, entries: Object.freeze(queueEntries) });
  }

  async function getStatus(){
    await readyPromise;
    const enabled = await readExternalEnabled();
    const permissionGranted = await hasManagementPermission();
    const connections = enabled && permissionGranted
      ? await listExternalConnections()
      : [];
    const providers = enabled && permissionGranted
      ? await listExternalProviders()
      : [];
    return Object.freeze({
      enabled,
      permissionGranted,
      initialized: externalDiscoveryInitialized,
      connections: Object.freeze(connections),
      providers: Object.freeze(providers)
    });
  }

  async function setExternalEnabled(enabled){
    const nextEnabled = enabled === true;
    const permissionGranted = await hasManagementPermission();
    if (nextEnabled && !permissionGranted){
      throw new Error(bgI18n('vfs_error_management_permission_missing'));
    }
    await browser.storage.local.set({ [EXTERNAL_ENABLED_KEY]: nextEnabled });
    return Object.freeze({
      reloadRequired: nextEnabled !== externalDiscoveryInitialized,
      enabled: nextEnabled,
      permissionGranted
    });
  }

  browser.runtime.onConnect.addListener((port) => {
    if (port?.name !== SOURCE_SELECTION_PORT){
      return;
    }
    const selection = {
      controller: new AbortController(),
      started: false,
      completed: false
    };
    const cancel = () => {
      if (!selection.controller.signal.aborted){
        selection.controller.abort();
      }
    };
    port.onMessage.addListener((message) => {
      if (message?.type === 'cancel'){
        cancel();
        return;
      }
      if (message?.type !== 'start' || selection.started){
        return;
      }
      selection.started = true;
      void selectSources(
        message.request || {},
        selection,
        (current, total) => {
          if (!selection.controller.signal.aborted && !selection.completed){
            try{
              port.postMessage({ type: 'progress', current, total });
            }catch(error){
              cancel();
            }
          }
        }
      ).then((result) => {
        selection.completed = true;
        try{
          port.postMessage({ type: 'result', ...result });
        }catch(error){
          cancel();
        }
      }).catch((error) => {
        if (error?.name === 'AbortError'){
          return;
        }
        console.error('[NCBG] VFS source selection failed', error);
        try{
          port.postMessage({
            type: 'error',
            error: error?.message || bgI18n('sharing_status_error')
          });
        }catch(error){
          cancel();
        }
      });
    });
    port.onDisconnect.addListener(() => {
      cancel();
    });
  });

  global.NCVfsClientRuntime = Object.freeze({
    ready: () => readyPromise,
    getStatus,
    setExternalEnabled,
    listExternalConnections,
    listExternalProviders,
    connectExternalProvider,
    disconnectExternalConnection,
    readFile: async (entry, options) => {
      const toolkit = await readyPromise;
      return toolkit.readFile(entry, options);
    }
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
