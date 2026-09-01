/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const PROVIDER_STATE_KEY = 'ncVfsProviderStateV1';
  const TOOLKIT_CONNECTIONS_KEY = 'vfs-toolkit-connections';
  const SELF_ADDON_ID = browser.runtime.id;
  const PROVIDER_CAPABILITIES = Object.freeze({
    file: Object.freeze({ read: true, add: true, modify: true, delete: true }),
    folder: Object.freeze({ read: true, add: true, modify: true, delete: true })
  });
  const requestControllers = new Map();
  const storage = global.NCNextcloudVfsStorage.create({
    // NCCore is a classic background-script binding, not a window property.
    // Pass it explicitly so provider startup uses the same core as the add-on.
    core: NCCore,
    log: (...args) => L('VFS provider', ...args),
    // Keep the established upload messages searchable across every caller.
    uploadLog: (message, metadata = {}) => L(message, {
      ...metadata,
      origin: 'vfs_provider'
    })
  });
  let provider = null;
  let providerModule = null;
  let accountReconcileTask = null;

  function createStorageId(){
    return `nc-${crypto.randomUUID()}`;
  }

  async function readState(){
    const stored = await browser.storage.local.get({
      [PROVIDER_STATE_KEY]: null
    });
    const value = stored[PROVIDER_STATE_KEY];
    return {
      enabled: value?.enabled === true,
      accountKey: String(value?.accountKey || ''),
      selfStorageId: String(value?.selfStorageId || '')
    };
  }

  async function writeState(state){
    const value = {
      enabled: state?.enabled === true,
      accountKey: String(state?.accountKey || ''),
      selfStorageId: String(state?.selfStorageId || '')
    };
    await browser.storage.local.set({ [PROVIDER_STATE_KEY]: value });
    return value;
  }

  async function readConnections(){
    const stored = await browser.storage.local.get({
      [TOOLKIT_CONNECTIONS_KEY]: []
    });
    return Array.isArray(stored[TOOLKIT_CONNECTIONS_KEY])
      ? stored[TOOLKIT_CONNECTIONS_KEY].slice()
      : [];
  }

  async function notifyConnectionRemoved(connection){
    const addonId = String(connection?.addonId || '');
    const storageId = String(connection?.storageId || '');
    if (!addonId || !storageId){
      return;
    }
    try{
      const message = {
        type: 'vfs-toolkit-remove-connection',
        storageId
      };
      // The self connection uses the internal runtime channel; only grants for
      // other add-ons are addressed through the cross-extension overload.
      await (addonId === SELF_ADDON_ID
        ? browser.runtime.sendMessage(message)
        : browser.runtime.sendMessage(addonId, message));
    }catch(error){
      L('VFS connection removal notification skipped', {
        addonId: bgShortId(addonId, 32),
        reason: error?.message || String(error)
      });
    }
  }

  async function removeConnections(predicate){
    const connections = await readConnections();
    const removed = connections.filter(predicate);
    if (!removed.length){
      return [];
    }
    const removedIds = new Set(removed.map((entry) => String(entry.storageId || '')));
    await browser.storage.local.set({
      [TOOLKIT_CONNECTIONS_KEY]: connections.filter(
        (entry) => !removedIds.has(String(entry.storageId || ''))
      )
    });
    await Promise.all(removed.map((entry) => notifyConnectionRemoved(entry)));
    return removed;
  }

  function getConnectionLabel(identity){
    try{
      return new URL(identity.baseUrl).host || 'Nextcloud';
    }catch(error){
      console.error('[NCBG] VFS account label could not be parsed', error);
      return 'Nextcloud';
    }
  }

  async function registerSelfConnection(state, identity){
    const connections = await readConnections();
    const current = connections.find((entry) =>
      entry.addonId === SELF_ADDON_ID
      && entry.storageId === state.selfStorageId
    );
    if (current){
      return;
    }
    await providerModule.reportNewConnection(
      SELF_ADDON_ID,
      browser.runtime.getManifest().name,
      state.selfStorageId,
      getConnectionLabel(identity),
      PROVIDER_CAPABILITIES
    );
  }

  async function runAccountReconcile(){
    const identity = await storage.getAccountIdentity();
    let state = await readState();
    const accountChanged = state.accountKey && state.accountKey !== identity.key;
    if (accountChanged){
      const oldSelfStorageId = state.selfStorageId;
      await removeConnections(() => true);
      state = await writeState({
        enabled: state.enabled,
        accountKey: identity.key,
        selfStorageId: createStorageId()
      });
      L('VFS provider account binding changed', {
        previousStorageId: bgShortId(oldSelfStorageId, 12),
        storageId: bgShortId(state.selfStorageId, 12)
      });
    }else if (!state.accountKey || !state.selfStorageId){
      state = await writeState({
        enabled: state.enabled,
        accountKey: identity.key,
        selfStorageId: state.selfStorageId || createStorageId()
      });
    }
    await registerSelfConnection(state, identity);
    return Object.freeze({ state, identity });
  }

  async function reconcileAccount(){
    if (!accountReconcileTask){
      accountReconcileTask = runAccountReconcile().finally(() => {
        accountReconcileTask = null;
      });
    }
    return accountReconcileTask;
  }

  async function requireStorageAccess(storageId){
    const normalizedStorageId = String(storageId || '');
    if (!normalizedStorageId){
      throw global.NCNextcloudVfsStorage.createVfsError('E:AUTH', 'Storage access is missing');
    }
    const { state } = await reconcileAccount();
    if (normalizedStorageId === state.selfStorageId){
      return state;
    }
    if (!state.enabled){
      throw global.NCNextcloudVfsStorage.createVfsError('E:AUTH', 'Nextcloud VFS access is disabled');
    }
    const connections = await readConnections();
    if (!connections.some((entry) =>
      entry.addonId !== SELF_ADDON_ID
      && entry.storageId === normalizedStorageId
    )){
      throw global.NCNextcloudVfsStorage.createVfsError('E:AUTH', 'Storage access was revoked');
    }
    return state;
  }

  async function runRequest(requestId, storageId, callback){
    const state = await requireStorageAccess(storageId);
    const controller = new AbortController();
    requestControllers.set(requestId, controller);
    try{
      return await callback(controller.signal, state.accountKey);
    }finally{
      requestControllers.delete(requestId);
    }
  }

  function reportProgress(requestId, current, total){
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCurrent = Math.min(safeTotal, Math.max(0, Number(current) || 0));
    const percent = safeTotal > 0 ? Math.round((safeCurrent / safeTotal) * 100) : 100;
    provider.reportProgress(requestId, percent, safeCurrent, safeTotal);
  }

  function reportChanges(storageId, result){
    const changes = Array.isArray(result?.changes) ? result.changes : [];
    if (changes.length){
      provider.reportStorageChange(storageId, changes);
    }
  }

  async function runMutation(storageId, callback){
    try{
      await callback();
    }catch(error){
      reportChanges(storageId, { changes: error?.completedChanges });
      throw error;
    }
  }

  async function createProviderImplementation(){
    providerModule = await import(
      browser.runtime.getURL('vendor/vfs-toolkit/vfs-provider/vfs-provider.mjs')
    );
    class NextcloudVfsProvider extends providerModule.VfsProviderImplementation {
      async onCancel(canceledRequestId){
        requestControllers.get(canceledRequestId)?.abort();
      }

      async onStorageUsage(storageId){
        const state = await requireStorageAccess(storageId);
        return storage.storageUsage({ expectedAccountKey: state.accountKey });
      }

      async onList(requestId, storageId, path){
        return runRequest(requestId, storageId, (signal, expectedAccountKey) =>
          storage.list(path, { signal, expectedAccountKey })
        );
      }

      async onReadFile(requestId, storageId, path){
        return runRequest(requestId, storageId, async (signal, expectedAccountKey) => {
          reportProgress(requestId, 0, 1);
          const file = await storage.readFile(path, { signal, expectedAccountKey });
          reportProgress(requestId, 1, 1);
          return file;
        });
      }

      async onWriteFile(requestId, storageId, path, file, overwrite){
        await runMutation(storageId, () => runRequest(requestId, storageId, (signal, expectedAccountKey) =>
          storage.writeFile(path, file, overwrite, {
            signal,
            expectedAccountKey,
            onProgress: ({ loaded, total }) => reportProgress(requestId, loaded, total)
          })
        ));
      }

      async onAddFolder(requestId, storageId, path){
        await runMutation(storageId, () => runRequest(
          requestId,
          storageId,
          (signal, expectedAccountKey) => storage.addFolder(path, { signal, expectedAccountKey })
        ));
      }

      async onMoveFile(requestId, storageId, oldPath, newPath, overwrite){
        await runMutation(storageId, () => runRequest(requestId, storageId, (signal, expectedAccountKey) =>
          storage.moveFile(oldPath, newPath, overwrite, { signal, expectedAccountKey })
        ));
      }

      async onMoveFolder(requestId, storageId, oldPath, newPath, merge){
        await runMutation(storageId, () => runRequest(requestId, storageId, (signal, expectedAccountKey) =>
          storage.moveFolder(oldPath, newPath, merge, {
            signal,
            expectedAccountKey,
            onProgress: (current, total) => reportProgress(requestId, current, total)
          })
        ));
      }

      async onCopyFile(requestId, storageId, oldPath, newPath, overwrite){
        await runMutation(storageId, () => runRequest(requestId, storageId, (signal, expectedAccountKey) =>
          storage.copyFile(oldPath, newPath, overwrite, { signal, expectedAccountKey })
        ));
      }

      async onCopyFolder(requestId, storageId, oldPath, newPath, merge){
        await runMutation(storageId, () => runRequest(requestId, storageId, (signal, expectedAccountKey) =>
          storage.copyFolder(oldPath, newPath, merge, {
            signal,
            expectedAccountKey,
            onProgress: (current, total) => reportProgress(requestId, current, total)
          })
        ));
      }

      async onDeleteFile(requestId, storageId, path){
        await runMutation(storageId, () => runRequest(
          requestId,
          storageId,
          (signal, expectedAccountKey) => storage.deleteFile(path, { signal, expectedAccountKey })
        ));
      }

      async onDeleteFolder(requestId, storageId, path){
        await runMutation(storageId, () => runRequest(
          requestId,
          storageId,
          (signal, expectedAccountKey) => storage.deleteFolder(path, { signal, expectedAccountKey })
        ));
      }
    }

    provider = new NextcloudVfsProvider({
      name: browser.runtime.getManifest().name,
      setupPath: '/ui/vfsProviderSetup.html',
      setupWidth: 520,
      setupHeight: 560
    });
    provider.init();
    try{
      await reconcileAccount();
    }catch(error){
      console.error('[NCBG] Nextcloud VFS provider account initialization failed', error);
    }
    return provider;
  }

  const readyPromise = createProviderImplementation();

  async function getStatus(){
    await readyPromise;
    let account = null;
    try{
      account = await reconcileAccount();
    }catch(error){
      if (error?.code !== 'E:AUTH'){
        console.error('[NCBG] Nextcloud VFS provider status failed', error);
      }
    }
    const state = await readState();
    const connections = await readConnections();
    const grants = connections
      .filter((entry) => entry.addonId !== SELF_ADDON_ID)
      .map((entry) => Object.freeze({
        addonId: String(entry.addonId || ''),
        addonName: String(entry.addonName || entry.addonId || ''),
        storageId: String(entry.storageId || ''),
        access: 'read-write'
      }));
    return Object.freeze({
      enabled: state.enabled,
      accountConfigured: !!account,
      accountLabel: account ? getConnectionLabel(account.identity) : '',
      selfStorageRef: account
        ? Object.freeze({ providerId: SELF_ADDON_ID, storageId: account.state.selfStorageId })
        : null,
      grants: Object.freeze(grants)
    });
  }

  async function setEnabled(enabled){
    await readyPromise;
    const current = await readState();
    await writeState({ ...current, enabled: enabled === true });
    if (enabled !== true){
      await removeConnections((entry) => entry.addonId !== SELF_ADDON_ID);
    }
    return getStatus();
  }

  async function grantConsumer({ setupToken } = {}){
    await readyPromise;
    const normalizedSetupToken = String(setupToken || '').trim();
    if (!normalizedSetupToken){
      throw global.NCNextcloudVfsStorage.createVfsError('E:AUTH', 'Invalid VFS consumer');
    }
    const { state, identity } = await reconcileAccount();
    if (!state.enabled){
      throw global.NCNextcloudVfsStorage.createVfsError('E:AUTH', 'Nextcloud VFS access is disabled');
    }
    const storageId = createStorageId();
    const completed = await provider.completeSetup(
      normalizedSetupToken,
      storageId,
      getConnectionLabel(identity),
      PROVIDER_CAPABILITIES
    );
    let current;
    try{
      current = await reconcileAccount();
    }catch(error){
      await removeConnections((entry) => entry.storageId === storageId);
      throw error;
    }
    if (!current.state.enabled
      || current.state.accountKey !== state.accountKey
      || current.state.selfStorageId !== state.selfStorageId){
      await removeConnections((entry) => entry.storageId === storageId);
      throw global.NCNextcloudVfsStorage.createVfsError(
        'E:AUTH',
        'The Nextcloud VFS authorization changed during setup'
      );
    }
    await removeConnections((entry) =>
      entry.addonId === completed.addonId && entry.storageId !== storageId
    );
    return Object.freeze({ storageId });
  }

  async function revokeGrant(storageId){
    await readyPromise;
    const normalizedStorageId = String(storageId || '');
    const removed = await removeConnections((entry) =>
      entry.addonId !== SELF_ADDON_ID
      && entry.storageId === normalizedStorageId
    );
    return removed.length > 0;
  }

  async function copyIntoShare(storageRef, operation = {}){
    if (String(storageRef?.providerId || '') !== SELF_ADDON_ID){
      throw global.NCNextcloudVfsStorage.createVfsError('E:AUTH', 'Storage access is missing');
    }
    // A queue descriptor is an authorization lease for one concrete account.
    // Revalidate the opaque storage ID and carry its account key into the DAV
    // adapter so an options change cannot redirect an in-flight server copy.
    const state = await requireStorageAccess(storageRef?.storageId);
    return storage.copyIntoShare({
      ...operation,
      expectedAccountKey: state.accountKey
    });
  }

  function connectLocal(){
    if (!provider){
      throw global.NCNextcloudVfsStorage.createVfsError(
        'E:AUTH',
        'Nextcloud VFS provider is not ready'
      );
    }
    return provider.connectLocal();
  }

  global.NCVfsProviderRuntime = Object.freeze({
    PROVIDER_CAPABILITIES,
    ready: () => readyPromise,
    getStatus,
    setEnabled,
    grantConsumer,
    revokeGrant,
    reconcileAccount,
    copyIntoShare,
    connectLocal
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
