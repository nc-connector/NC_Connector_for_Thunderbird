/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const i18n = global.NCI18n.translate;
  const LOG_PREFIX = "[NCUI][Options]";
  const MESSAGE_TYPES = Object.freeze({
    getState: "vfs:options:getState",
    updateSettings: "vfs:options:updateSettings",
    requestExternalPermission: "vfs:options:requestExternalProviderPermission",
    revokeGrant: "vfs:options:revokeGrant",
    connectProvider: "vfs:options:connectProvider",
    disconnectConnection: "vfs:options:disconnectConnection",
    refreshConnections: "vfs:options:refreshConnections"
  });
  const PROVIDER_STATUSES = new Set(["active", "inactive", "connection_required", "error"]);
  const CONNECTION_STATUSES = new Set(["connected", "available", "unavailable", "error"]);

  const runtimeNotice = document.getElementById("vfsRuntimeNotice");
  const providerEnabledInput = document.getElementById("vfsProviderEnabled");
  const providerStatusDot = document.getElementById("vfsProviderStatusDot");
  const providerStatus = document.getElementById("vfsProviderStatus");
  const grantList = document.getElementById("vfsGrantList");
  const noGrants = document.getElementById("vfsNoGrants");
  const externalEnabledInput = document.getElementById("vfsExternalProvidersEnabled");
  const externalPermissionStatus = document.getElementById("vfsExternalPermissionStatus");
  const requestExternalPermissionButton = document.getElementById("vfsRequestExternalPermission");
  const refreshConnectionsButton = document.getElementById("vfsRefreshConnections");
  const connectionList = document.getElementById("vfsConnectionList");
  const noConnections = document.getElementById("vfsNoConnections");

  let runtimeAvailable = false;
  let currentState = null;
  let settingsDirty = false;
  let actionPending = false;

  function showNotice(key){
    if (!runtimeNotice){
      return;
    }
    runtimeNotice.textContent = i18n(key);
    runtimeNotice.hidden = false;
  }

  function hideNotice(){
    if (runtimeNotice){
      runtimeNotice.hidden = true;
    }
  }

  function setTone(element, tone){
    if (element){
      element.dataset.tone = tone || "neutral";
    }
  }

  function normalizeText(value){
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizeState(value){
    if (!value || typeof value !== "object"){
      throw new Error("invalid_vfs_options_state");
    }
    const provider = value.provider;
    const external = value.external;
    if (!provider || typeof provider !== "object" || !external || typeof external !== "object"){
      throw new Error("invalid_vfs_options_state");
    }

    const grants = Array.isArray(provider.grants)
      ? provider.grants.map((grant) => ({
        grantId: normalizeText(grant?.grantId),
        addonId: normalizeText(grant?.addonId),
        addonName: normalizeText(grant?.addonName)
      })).filter((grant) => grant.grantId && grant.addonId)
      : [];
    const connections = Array.isArray(external.connections)
      ? external.connections.map((connection) => ({
        connectionId: normalizeText(connection?.connectionId),
        providerId: normalizeText(connection?.providerId),
        storageId: normalizeText(connection?.storageId),
        providerName: normalizeText(connection?.providerName),
        storageName: normalizeText(connection?.storageName),
        status: CONNECTION_STATUSES.has(connection?.status) ? connection.status : "error"
      })).filter((connection) => connection.connectionId && connection.providerId && connection.storageId)
      : [];
    const providers = Array.isArray(external.providers)
      ? external.providers.map((providerInfo) => ({
        providerId: normalizeText(providerInfo?.providerId),
        providerName: normalizeText(providerInfo?.providerName),
        connectionCount: Math.max(0, Number(providerInfo?.connectionCount) || 0)
      })).filter((providerInfo) => providerInfo.providerId)
      : [];

    return {
      provider: {
        enabled: provider.enabled === true,
        connectionReady: provider.connectionReady === true,
        status: PROVIDER_STATUSES.has(provider.status) ? provider.status : "error",
        grants
      },
      external: {
        enabled: external.enabled === true,
        permissionGranted: external.permissionGranted === true,
        connections,
        providers
      }
    };
  }

  async function requestState(type, payload){
    const response = await browser.runtime.sendMessage({ type, payload });
    if (!response?.ok){
      throw new Error(normalizeText(response?.error) || "vfs_options_request_failed");
    }
    return normalizeState(response.state);
  }

  function providerStatusPresentation(status){
    switch (status){
      case "active":
        return { key:"options_vfs_provider_status_active", tone:"success" };
      case "inactive":
        return { key:"options_vfs_provider_status_inactive", tone:"neutral" };
      case "connection_required":
        return { key:"options_vfs_provider_status_connection_required", tone:"warning" };
      default:
        return { key:"options_vfs_provider_status_error", tone:"error" };
    }
  }

  function connectionStatusPresentation(status){
    switch (status){
      case "connected":
        return { key:"options_vfs_connection_status_connected", tone:"success" };
      case "available":
        return { key:"options_vfs_connection_status_available", tone:"neutral" };
      case "unavailable":
        return { key:"options_vfs_connection_status_unavailable", tone:"warning" };
      default:
        return { key:"options_vfs_connection_status_error", tone:"error" };
    }
  }

  function createPrimaryText(name, id){
    const primary = document.createElement("div");
    primary.className = "vfs-list-primary";
    const title = document.createElement("strong");
    title.textContent = name || id;
    primary.appendChild(title);
    if (name && id){
      const identifier = document.createElement("small");
      identifier.textContent = id;
      primary.appendChild(identifier);
    }
    return primary;
  }

  function renderGrants(grants){
    if (!grantList || !noGrants){
      return;
    }
    grantList.replaceChildren();
    grants.forEach((grant) => {
      const row = document.createElement("div");
      row.className = "vfs-list-row";
      row.setAttribute("role", "listitem");
      row.appendChild(createPrimaryText(grant.addonName, grant.addonId));

      const access = document.createElement("span");
      access.className = "vfs-badge";
      access.dataset.tone = "success";
      access.textContent = i18n("options_vfs_access_read_write");
      row.appendChild(access);

      const revokeButton = document.createElement("button");
      revokeButton.type = "button";
      revokeButton.className = "vfs-action-button";
      revokeButton.textContent = i18n("options_vfs_revoke_button");
      revokeButton.disabled = actionPending;
      revokeButton.addEventListener("click", () => {
        void revokeGrant(grant, revokeButton);
      });
      row.appendChild(revokeButton);
      grantList.appendChild(row);
    });
    noGrants.hidden = grants.length > 0;
  }

  function renderConnections(connections, providers){
    if (!connectionList || !noConnections){
      return;
    }
    connectionList.replaceChildren();
    providers.forEach((providerInfo) => {
      const row = document.createElement("div");
      row.className = "vfs-list-row";
      row.setAttribute("role", "listitem");
      row.appendChild(createPrimaryText(providerInfo.providerName, providerInfo.providerId));

      const status = document.createElement("span");
      status.className = "vfs-badge";
      status.dataset.tone = providerInfo.connectionCount > 0 ? "success" : "neutral";
      status.textContent = i18n(providerInfo.connectionCount > 0
        ? "options_vfs_connection_status_connected"
        : "options_vfs_connection_status_available");
      row.appendChild(status);

      const connectButton = document.createElement("button");
      connectButton.type = "button";
      connectButton.className = "vfs-action-button";
      connectButton.textContent = i18n("options_vfs_connect_button");
      connectButton.disabled = actionPending;
      connectButton.addEventListener("click", () => {
        void connectProvider(providerInfo, connectButton);
      });
      row.appendChild(connectButton);
      connectionList.appendChild(row);
    });
    connections.forEach((connection) => {
      const row = document.createElement("div");
      row.className = "vfs-list-row";
      row.setAttribute("role", "listitem");
      row.appendChild(createPrimaryText(
        connection.storageName || connection.providerName,
        connection.storageName ? connection.providerName : connection.providerId
      ));

      const presentation = connectionStatusPresentation(connection.status);
      const status = document.createElement("span");
      status.className = "vfs-badge";
      status.dataset.tone = presentation.tone;
      status.textContent = i18n(presentation.key);
      row.appendChild(status);

      const disconnectButton = document.createElement("button");
      disconnectButton.type = "button";
      disconnectButton.className = "vfs-action-button";
      disconnectButton.textContent = i18n("options_vfs_disconnect_button");
      disconnectButton.disabled = actionPending;
      disconnectButton.addEventListener("click", () => {
        void disconnectConnection(connection, disconnectButton);
      });
      row.appendChild(disconnectButton);
      connectionList.appendChild(row);
    });
    noConnections.hidden = connections.length > 0 || providers.length > 0;
  }

  function updateControls(){
    const providerConnectionReady = currentState?.provider?.connectionReady === true;
    const permissionGranted = currentState?.external?.permissionGranted === true;
    if (providerEnabledInput){
      providerEnabledInput.disabled = !runtimeAvailable || !providerConnectionReady || actionPending;
    }
    if (externalEnabledInput){
      externalEnabledInput.disabled = !runtimeAvailable
        || actionPending
        || (!permissionGranted && currentState?.external?.enabled !== true);
    }
    if (requestExternalPermissionButton){
      requestExternalPermissionButton.disabled = !runtimeAvailable || permissionGranted || actionPending;
    }
    if (refreshConnectionsButton){
      refreshConnectionsButton.disabled = !runtimeAvailable
        || !permissionGranted
        || currentState?.external?.enabled !== true
        || actionPending;
    }
    grantList?.querySelectorAll("button").forEach((button) => {
      button.disabled = actionPending;
    });
    connectionList?.querySelectorAll("button").forEach((button) => {
      button.disabled = actionPending;
    });
  }

  function renderState(state, options = {}){
    const preserveSettings = options.preserveSettings === true;
    currentState = state;
    runtimeAvailable = true;
    if (!preserveSettings){
      if (providerEnabledInput){
        providerEnabledInput.checked = state.provider.enabled;
      }
      if (externalEnabledInput){
        externalEnabledInput.checked = state.external.enabled;
      }
      settingsDirty = false;
    }

    const providerPresentation = providerStatusPresentation(state.provider.status);
    if (providerStatus){
      providerStatus.textContent = i18n(providerPresentation.key);
    }
    setTone(providerStatusDot, providerPresentation.tone);

    if (externalPermissionStatus){
      externalPermissionStatus.textContent = i18n(state.external.permissionGranted
        ? "options_vfs_external_permission_granted"
        : "options_vfs_external_permission_required");
      setTone(externalPermissionStatus, state.external.permissionGranted ? "success" : "warning");
    }

    renderGrants(state.provider.grants);
    renderConnections(state.external.connections, state.external.providers);
    hideNotice();
    updateControls();
  }

  function renderUnavailable(){
    runtimeAvailable = false;
    currentState = null;
    settingsDirty = false;
    if (providerEnabledInput){
      providerEnabledInput.checked = false;
    }
    if (externalEnabledInput){
      externalEnabledInput.checked = false;
    }
    if (providerStatus){
      providerStatus.textContent = i18n("options_vfs_runtime_unavailable");
    }
    setTone(providerStatusDot, "error");
    if (externalPermissionStatus){
      externalPermissionStatus.textContent = i18n("options_vfs_external_permission_required");
      setTone(externalPermissionStatus, "warning");
    }
    renderGrants([]);
    renderConnections([], []);
    showNotice("options_vfs_runtime_unavailable");
    updateControls();
  }

  async function refresh(options = {}){
    const hadRuntime = runtimeAvailable;
    try{
      const state = await requestState(MESSAGE_TYPES.getState);
      renderState(state, { preserveSettings: options.preserveSettings === true });
      return true;
    }catch(error){
      global.NCLogContext.safeConsoleError(LOG_PREFIX, "VFS options state load failed", error);
      if (hadRuntime){
        showNotice("options_vfs_action_failed");
        updateControls();
      }else{
        renderUnavailable();
      }
      return false;
    }
  }

  async function runAction(button, type, payload){
    actionPending = true;
    updateControls();
    if (button){
      button.disabled = true;
    }
    try{
      const state = await requestState(type, payload);
      renderState(state, { preserveSettings: settingsDirty });
    }catch(error){
      global.NCLogContext.safeConsoleError(LOG_PREFIX, `VFS options action failed (${type})`, error);
      showNotice("options_vfs_action_failed");
    }finally{
      actionPending = false;
      updateControls();
    }
  }

  async function revokeGrant(grant, button){
    const displayName = grant.addonName || grant.addonId;
    if (!global.confirm(i18n("options_vfs_revoke_confirm", displayName))){
      return;
    }
    await runAction(button, MESSAGE_TYPES.revokeGrant, { grantId: grant.grantId });
  }

  async function connectProvider(providerInfo, button){
    await runAction(button, MESSAGE_TYPES.connectProvider, {
      providerId: providerInfo.providerId
    });
  }

  async function disconnectConnection(connection, button){
    const displayName = connection.storageName || connection.providerName || connection.providerId;
    if (!global.confirm(i18n("options_vfs_disconnect_confirm", displayName))){
      return;
    }
    await runAction(button, MESSAGE_TYPES.disconnectConnection, {
      providerId: connection.providerId,
      storageId: connection.storageId
    });
  }

  async function save(){
    if (!runtimeAvailable || !settingsDirty || actionPending){
      return;
    }
    actionPending = true;
    updateControls();
    try{
      const state = await requestState(MESSAGE_TYPES.updateSettings, {
        providerEnabled: providerEnabledInput?.checked === true,
        externalProvidersEnabled: externalEnabledInput?.checked === true
      });
      renderState(state);
    }catch(error){
      global.NCLogContext.safeConsoleError(LOG_PREFIX, "VFS options settings update failed", error);
      showNotice("options_vfs_action_failed");
      throw new Error(i18n("options_vfs_action_failed"));
    }finally{
      actionPending = false;
      updateControls();
    }
  }

  function markSettingsDirty(){
    settingsDirty = true;
    updateControls();
  }

  providerEnabledInput?.addEventListener("change", markSettingsDirty);
  externalEnabledInput?.addEventListener("change", markSettingsDirty);
  requestExternalPermissionButton?.addEventListener("click", () => {
    void (async () => {
      actionPending = true;
      updateControls();
      try{
        const granted = await browser.permissions.request({ permissions: ["management"] });
        if (!granted){
          showNotice("options_vfs_action_failed");
          return;
        }
        const state = await requestState(MESSAGE_TYPES.requestExternalPermission);
        renderState(state, { preserveSettings: settingsDirty });
        if (state.external.enabled){
          global.setTimeout(() => browser.runtime.reload(), 250);
        }
      }catch(error){
        global.NCLogContext.safeConsoleError(LOG_PREFIX, "VFS permission request failed", error);
        showNotice("options_vfs_action_failed");
      }finally{
        actionPending = false;
        updateControls();
      }
    })();
  });
  refreshConnectionsButton?.addEventListener("click", () => {
    void runAction(refreshConnectionsButton, MESSAGE_TYPES.refreshConnections);
  });
  global.addEventListener("focus", () => {
    if (runtimeAvailable && !actionPending){
      void refresh({ preserveSettings: settingsDirty });
    }
  });

  global.NCVfsOptions = Object.freeze({
    MESSAGE_TYPES,
    refresh,
    save
  });

  void refresh();
})(typeof window !== "undefined" ? window : globalThis);
