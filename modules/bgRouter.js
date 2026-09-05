/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Runtime message router.
 * Centralizes WebExtension message types used by options/talk/sharing UIs.
 */

/**
 * Build a standard runtime message error response and log the root cause.
 * @param {string} type
 * @param {any} error
 * @returns {{ok:false,error:string}}
 */
function messageError(type, error){
  console.error("[NCBG] " + type, error);
  return { ok:false, error: error?.message || String(error) };
}

function readMessageContextId(msg){
  return typeof msg?.contextId === "string" ? msg.contextId.trim() : "";
}

// The vendored Toolkit owns these messages through its own listeners. Claiming
// them here would replace Toolkit responses with our unknown-message envelope.
const VFS_TOOLKIT_INTERNAL_MESSAGE_TYPES = new Set([
  "vfs-notify-background-storage-changed",
  "vfs-picker-result",
  "vfs-provider-removed",
  "vfs-provider-updated",
  "vfs-remove-connection",
  "vfs-storage-changed",
  "vfs-toolkit-add-connection",
  "vfs-toolkit-button",
  "vfs-toolkit-discover",
  "vfs-toolkit-get-action-button",
  "vfs-toolkit-get-connections",
  "vfs-toolkit-remove-connection"
]);

async function getVfsOptionsState(){
  const [providerStatus, externalStatus] = await Promise.all([
    NCVfsProviderRuntime.getStatus(),
    NCVfsClientRuntime.getStatus()
  ]);
  return Object.freeze({
    provider: Object.freeze({
      enabled: providerStatus.enabled === true,
      connectionReady: providerStatus.accountConfigured === true,
      status: providerStatus.accountConfigured
        ? (providerStatus.enabled ? "active" : "inactive")
        : "connection_required",
      grants: Object.freeze((providerStatus.grants || []).map((grant) => Object.freeze({
        grantId: String(grant.storageId || ""),
        addonId: String(grant.addonId || ""),
        addonName: String(grant.addonName || grant.addonId || "")
      })))
    }),
    external: Object.freeze({
      enabled: externalStatus.enabled === true,
      permissionGranted: externalStatus.permissionGranted === true,
      connections: Object.freeze((externalStatus.connections || []).map((connection) => Object.freeze({
        connectionId: JSON.stringify([
          connection.storageRef?.providerId || "",
          connection.storageRef?.storageId || ""
        ]),
        providerId: String(connection.storageRef?.providerId || ""),
        storageId: String(connection.storageRef?.storageId || ""),
        providerName: String(connection.providerName || ""),
        storageName: String(connection.storageName || ""),
        status: "connected"
      }))),
      providers: Object.freeze((externalStatus.providers || []).map((providerInfo) => Object.freeze({
        providerId: String(providerInfo.providerId || ""),
        providerName: String(providerInfo.providerName || providerInfo.providerId || ""),
        connectionCount: Math.max(0, Number(providerInfo.connectionCount) || 0)
      })))
    })
  });
}

/**
 * Central runtime.onMessage dispatcher for NC Connector UI/background calls.
 * Vendored Toolkit traffic remains owned by its dedicated runtime listeners.
 */
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  if (VFS_TOOLKIT_INTERNAL_MESSAGE_TYPES.has(String(msg.type))){
    return;
  }
  return (async () => {
    if (msg.type !== "debug:log"){
      L("msg", msg.type, { hasPayload: !!msg.payload });
    }
    if (msg.type === "debug:log"){
      const source = msg.payload?.source ? String(msg.payload.source) : "frontend";
      const text = msg.payload?.text ? String(msg.payload.text) : "";
      const extras = Array.isArray(msg.payload?.details)
        ? msg.payload.details
        : (msg.payload?.details != null ? [msg.payload.details] : []);
      const channelRaw = msg.payload?.channel ? String(msg.payload.channel) : "NCDBG";
      const channel = channelRaw.toUpperCase();
      const label = msg.payload?.label ? String(msg.payload.label) : source;
      const prefix = label ? `[${channel}][${label}]` : `[${channel}]`;
      if (typeof logBackgroundDebugLine === "function"){
        try{
          logBackgroundDebugLine(prefix, text, ...extras);
        }catch(error){
          console.error("[NCBG] forwarded debug log failed", error);
        }
      }
      return { ok:true };
    }
    if (msg.type === "passwordPolicy:fetch"){
      const policy = await NCPasswordPolicyRuntime.fetchPolicy();
      return { ok:true, policy };
    }
    if (msg.type === "passwordPolicy:generate"){
      return await NCPasswordPolicyRuntime.generatePassword(msg?.payload?.policy || {});
    }
    if (msg.type === "policy:getStatus"){
      try{
        const status = await NCPolicyRuntime.getPolicyStatus();
        return { ok:true, status };
      }catch(error){
        return messageError("policy:getStatus", error);
      }
    }
    if (msg.type === "vfs:getStatus"){
      try{
        return { ok:true, status: await NCVfsProviderRuntime.getStatus() };
      }catch(error){
        return messageError("vfs:getStatus", error);
      }
    }
    if (msg.type === "sharing:getDestinationStorageUsage"){
      try{
        const usage = await NCVfsProviderRuntime.getDestinationStorageUsage();
        return { ok:true, usage };
      }catch(error){
        return messageError("sharing:getDestinationStorageUsage", error);
      }
    }
    if (msg.type === "vfs:grantConsumer"){
      try{
        const result = await NCVfsProviderRuntime.grantConsumer({
          setupToken: msg.payload?.setupToken
        });
        return { ok:true, ...result };
      }catch(error){
        return messageError("vfs:grantConsumer", error);
      }
    }
    if (msg.type === "vfs:listExternalConnections"){
      try{
        const connections = await NCVfsClientRuntime.listExternalConnections();
        return { ok:true, connections };
      }catch(error){
        return messageError("vfs:listExternalConnections", error);
      }
    }
    if (msg.type === "vfs:options:getState"
      || msg.type === "vfs:options:refreshConnections"){
      try{
        return { ok:true, state: await getVfsOptionsState() };
      }catch(error){
        return messageError(msg.type, error);
      }
    }
    if (msg.type === "vfs:options:updateSettings"){
      try{
        const external = await NCVfsClientRuntime.setExternalEnabled(
          msg.payload?.externalProvidersEnabled === true
        );
        await NCVfsProviderRuntime.setEnabled(msg.payload?.providerEnabled === true);
        const state = await getVfsOptionsState();
        return {
          ok:true,
          state,
          reloadRequired: external.reloadRequired === true
        };
      }catch(error){
        return messageError("vfs:options:updateSettings", error);
      }
    }
    if (msg.type === "vfs:options:requestExternalProviderPermission"){
      try{
        const permissionGranted = await browser.permissions.contains({
          permissions: ["management"]
        });
        if (!permissionGranted){
          throw new Error(bgI18n("vfs_error_management_permission_missing"));
        }
        return { ok:true, state: await getVfsOptionsState() };
      }catch(error){
        return messageError("vfs:options:requestExternalProviderPermission", error);
      }
    }
    if (msg.type === "vfs:options:revokeGrant"){
      try{
        const grantId = String(msg.payload?.grantId || "").trim();
        if (!grantId){
          throw new Error("invalid_vfs_grant");
        }
        await NCVfsProviderRuntime.revokeGrant(grantId);
        return { ok:true, state: await getVfsOptionsState() };
      }catch(error){
        return messageError("vfs:options:revokeGrant", error);
      }
    }
    if (msg.type === "vfs:options:connectProvider"){
      try{
        await NCVfsClientRuntime.connectExternalProvider(msg.payload?.providerId);
        return { ok:true, state: await getVfsOptionsState() };
      }catch(error){
        return messageError("vfs:options:connectProvider", error);
      }
    }
    if (msg.type === "vfs:options:disconnectConnection"){
      try{
        await NCVfsClientRuntime.disconnectExternalConnection({
          providerId: msg.payload?.providerId,
          storageId: msg.payload?.storageId
        });
        return { ok:true, state: await getVfsOptionsState() };
      }catch(error){
        return messageError("vfs:options:disconnectConnection", error);
      }
    }
  if (msg.type === "talk:searchUsers"){
    try{
      const users = await NCTalkCore.searchSystemAddressbook(msg.payload || {});
      return { ok:true, users };
    }catch(error){
      return messageError("talk:searchUsers", error);
    }
  }
  if (msg.type === "talk:getSystemAddressbookStatus"){
    try{
      const status = await NCTalkCore.getSystemAddressbookStatus(msg.payload || {});
      return { ok:true, status };
    }catch(error){
      return messageError("talk:getSystemAddressbookStatus", error);
    }
  }
  if (msg.type === "talk:claimPopupContext"){
    const contextId = consumeLatestCalendarWizardPopupContext();
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    L("talk popup context claimed", { contextId });
    return { ok:true, contextId };
  }
  if (msg.type === "talk:initDialog"){
    const contextId = readMessageContextId(msg);
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    refreshCalendarWizardContextSnapshot(context);
    return { ok:true };
  }
  if (msg.type === "talk:getEventSnapshot"){
    const contextId = readMessageContextId(msg);
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    refreshCalendarWizardContextSnapshot(context);
    return {
      ok:true,
      event: context.event || {},
      metadata: context.metadata || {}
    };
  }
  if (msg.type === "talk:applyEventFields"){
    const contextId = readMessageContextId(msg);
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    const fields = msg.fields ?? msg?.payload?.fields ?? {};
    try{
      L("talk:applyEventFields", {
        contextId,
        calendarId: context.item?.calendarId || "",
        itemId: context.item?.id || "",
        hasTitle: typeof fields.title === "string",
        hasLocation: typeof fields.location === "string",
        hasDescription: typeof fields.description === "string",
        hasDescriptionHtml: typeof fields.descriptionHtml === "string"
      });

      if (!browser?.ncCalToolbar?.updateCurrent){
        console.error("[NCBG] ncCalToolbar.updateCurrent missing");
        throw localizedError("talk_error_apply_failed");
      }
      const editorId = typeof context.editorId === "string" ? context.editorId.trim() : "";
      if (!editorId){
        throw new Error(bgI18n("talk_error_editor_context_missing"));
      }
      const fieldsPayload = {};
      if (typeof fields.title === "string"){
        fieldsPayload.title = fields.title;
      }
      if (typeof fields.location === "string"){
        fieldsPayload.location = fields.location;
      }
      if (typeof fields.description === "string"){
        fieldsPayload.description = fields.description;
      }
      if (typeof fields.descriptionHtml === "string"){
        if (typeof NCHtmlSanitizer === "undefined"
          || typeof NCHtmlSanitizer.sanitizeTalkTemplateHtml !== "function"){
          // This bridge writes into the privileged calendar editor.
          // Raw backend HTML must not cross it.
          console.error("[NCBG] talk:applyEventFields sanitizer unavailable");
          throw localizedError("talk_error_apply_failed");
        }
        fieldsPayload.descriptionHtml = NCHtmlSanitizer.sanitizeTalkTemplateHtml(fields.descriptionHtml);
      }
      const applyResponse = await browser.ncCalToolbar.updateCurrent({
        editorId,
        fields: fieldsPayload,
        returnFormat: "ical"
      });
      if (!applyResponse || applyResponse.format !== "ical" || typeof applyResponse.item !== "string"){
        throw new Error(bgI18n("talk_error_apply_failed"));
      }
      context.item.item = applyResponse.item;
      refreshCalendarWizardContextSnapshot(context);
      return { ok:true };
    }catch(error){
      console.error("[NCBG] talk:applyEventFields error", { contextId, error: error?.message || String(error) });
      return { ok:false, error: error?.message || String(error) };
    }
  }
  if (msg.type === "talk:createRoom"){
    const contextId = readMessageContextId(msg);
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    if (context.roomCreateInProgress){
      return { ok:false, error: bgI18n("talk_error_existing_room_linked") };
    }
    context.roomCreateInProgress = true;
    try{
      const hydrated = await hydrateTalkWizardContextFromEditor(context.editorId, contextId);
      if (!hydrated){
        return { ok:false, error: bgI18n("talk_error_snapshot_failed") };
      }
      refreshCalendarWizardContextSnapshot(context);
      if (context.metadata?.token){
        return { ok:false, error: bgI18n("talk_error_existing_room_linked") };
      }
      const result = await NCTalkCore.createTalkPublicRoom(msg.payload);
      return { ok:true, result };
    }catch(error){
      return messageError("talk:createRoom", error);
    }finally{
      context.roomCreateInProgress = false;
    }
  }
  if (msg.type === "talk:deleteRoom"){
    try{
      const payload = msg.payload || {};
      const token = msg.token ?? payload.token;
      if (!token){
        return { ok:false, error: "token required" };
      }
      await NCTalkCore.deleteTalkRoom({ token });
      await deleteRoomMeta(token);
      return { ok:true };
    }catch(error){
      return messageError("talk:deleteRoom", error);
    }
  }
  if (msg.type === "talk:trackRoom"){
    try{
      const payload = msg.payload || {};
      const token = msg.token ?? payload.token;
      if (!token){
        return { ok:false, error: "token required" };
      }
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(msg, "lobbyEnabled") || Object.prototype.hasOwnProperty.call(payload, "lobbyEnabled")){
        updates.lobbyEnabled = !!(msg.lobbyEnabled ?? payload.lobbyEnabled);
      }
      if (Object.prototype.hasOwnProperty.call(msg, "eventConversation") || Object.prototype.hasOwnProperty.call(payload, "eventConversation")){
        updates.eventConversation = !!(msg.eventConversation ?? payload.eventConversation);
      }
      const startRaw = msg.startTimestamp ?? payload.startTimestamp;
      if (typeof startRaw === "number" && Number.isFinite(startRaw)){
        updates.startTimestamp = startRaw;
      }
      await setRoomMeta(token, updates);
      return { ok:true };
    }catch(error){
      return messageError("talk:trackRoom", error);
    }
  }
  if (msg.type === "talk:applyMetadata"){
    const contextId = readMessageContextId(msg);
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    const meta = msg.metadata ?? msg?.payload?.metadata ?? {};
    try{
      L("talk:applyMetadata", {
        contextId,
        calendarId: context.item?.calendarId || "",
        itemId: context.item?.id || "",
        hasToken: typeof meta?.token === "string" && !!meta.token,
        hasUrl: typeof meta?.url === "string" && !!meta.url,
        lobby: Object.prototype.hasOwnProperty.call(meta, "lobbyEnabled") ? !!meta.lobbyEnabled : null,
        hasStart: typeof meta?.startTimestamp === "number" && Number.isFinite(meta.startTimestamp)
      });
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(meta, "token")){
        updates["X-NCTALK-TOKEN"] = meta.token ? String(meta.token) : null;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "url")){
        updates["X-NCTALK-URL"] = meta.url ? String(meta.url) : null;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "lobbyEnabled")){
        updates["X-NCTALK-LOBBY"] = meta.lobbyEnabled ? "TRUE" : "FALSE";
      }
      if (Object.prototype.hasOwnProperty.call(meta, "startTimestamp")){
        if (typeof meta.startTimestamp === "number" && Number.isFinite(meta.startTimestamp)){
          updates["X-NCTALK-START"] = String(Math.floor(meta.startTimestamp));
        }else{
          updates["X-NCTALK-START"] = null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(meta, "eventConversation")){
        updates["X-NCTALK-EVENT"] = meta.eventConversation ? "event" : "standard";
      }
      if (Object.prototype.hasOwnProperty.call(meta, "objectId")){
        updates["X-NCTALK-OBJECTID"] = meta.objectId ? String(meta.objectId) : null;
      }
      const hasAddUsers = Object.prototype.hasOwnProperty.call(meta, "addUsers");
      const hasAddGuests = Object.prototype.hasOwnProperty.call(meta, "addGuests");
      if (hasAddUsers){
        updates["X-NCTALK-ADD-USERS"] = meta.addUsers ? "TRUE" : "FALSE";
      }
      if (hasAddGuests){
        updates["X-NCTALK-ADD-GUESTS"] = meta.addGuests ? "TRUE" : "FALSE";
      }
      if (hasAddUsers || hasAddGuests){
        updates["X-NCTALK-ADD-PARTICIPANTS"] = (meta.addUsers || meta.addGuests) ? "TRUE" : "FALSE";
      }else if (Object.prototype.hasOwnProperty.call(meta, "addParticipants")){
        updates["X-NCTALK-ADD-PARTICIPANTS"] = meta.addParticipants ? "TRUE" : "FALSE";
      }
      if (Object.prototype.hasOwnProperty.call(meta, "delegateId")){
        updates["X-NCTALK-DELEGATE"] = meta.delegateId ? String(meta.delegateId) : null;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "delegateName")){
        updates["X-NCTALK-DELEGATE-NAME"] = meta.delegateName ? String(meta.delegateName) : null;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "delegated")){
        updates["X-NCTALK-DELEGATED"] = meta.delegated ? "TRUE" : "FALSE";
      }
      if (meta?.delegateId && meta.delegated !== true){
        updates["X-NCTALK-DELEGATE-READY"] = "TRUE";
      }

      const baseIcal = context.item?.item || "";
      const { ical } = applyIcalPropertyUpdates(baseIcal, updates);
      context.item.item = ical;
      refreshCalendarWizardContextSnapshot(context);

      if (!browser?.ncCalToolbar?.updateCurrent){
        console.error("[NCBG] ncCalToolbar.updateCurrent missing");
        throw localizedError("talk_error_apply_failed");
      }
      const editorId = typeof context.editorId === "string" ? context.editorId.trim() : "";
      if (!editorId){
        throw new Error(bgI18n("talk_error_editor_context_missing"));
      }
      const propResponse = await browser.ncCalToolbar.updateCurrent({
        editorId,
        properties: updates,
        returnFormat: "ical"
      });
      if (!propResponse || propResponse.format !== "ical" || typeof propResponse.item !== "string"){
        throw new Error(bgI18n("talk_error_apply_failed"));
      }

      if (meta?.token && context.item?.calendarId && context.item?.id){
        await setEventTokenEntry(context.item.calendarId, context.item.id, {
          token: meta.token,
          url: meta.url || "",
          source: "x-nctalk"
        });
      }
      return { ok:true };
    }catch(error){
      console.error("[NCBG] talk:applyMetadata error", { contextId, error: error?.message || String(error) });
      if (meta?.token){
        try{
          await NCTalkCore.deleteTalkRoom({ token: meta.token });
          await deleteRoomMeta(meta.token);
        }catch(error){
          console.error("[NCBG] talk:applyMetadata rollback failed", error);
        }
      }
      return { ok:false, error: error?.message || String(error) };
    }
  }
  if (msg.type === "talk:registerCleanup"){
    const contextId = readMessageContextId(msg);
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return { ok:false, error: bgI18n("talk_error_context_reference") };
    }
    const token = msg.token ?? msg?.payload?.token;
    if (!token){
      return { ok:false, error: "token required" };
    }
    const keepContext = !!(msg.keepContext ?? msg?.payload?.keepContext);
    const info = msg.info ?? msg?.payload?.info ?? {};
    try{
      const editorId = typeof context.editorId === "string" ? context.editorId.trim() : "";
      const editorKey = makeRoomCleanupEditorKey(editorId);
      if (!editorKey){
        return { ok:false, error: bgI18n("talk_error_editor_context_missing") };
      }

      const previousToken = ROOM_CLEANUP_BY_EDITOR.get(editorKey);
      if (previousToken && previousToken !== token){
        scheduleRoomCleanupDelete(previousToken, "superseded", 0);
      }

      ROOM_CLEANUP_BY_EDITOR.set(editorKey, token);
      ROOM_CLEANUP_BY_TOKEN.set(token, {
        token,
        editorKey,
        info: info || {},
        registered: Date.now(),
        timerId: null
      });

      if (!browser?.ncCalToolbar?.getCurrent){
        console.error("[NCBG] ncCalToolbar.getCurrent missing");
        removeRoomCleanupEntry(token, "registerRoomCleanup_missing");
        return { ok:false, error: bgI18n("talk_error_apply_failed") };
      }
      const snapshot = await browser.ncCalToolbar.getCurrent({
        editorId,
        returnFormat: "ical"
      });
      if (!snapshot){
        console.error("[NCBG] ncCalToolbar.getCurrent for cleanup returned null");
        removeRoomCleanupEntry(token, "registerRoomCleanup_failed");
        return { ok:false, error: bgI18n("talk_error_apply_failed") };
      }

      if (!keepContext){
        deleteCalendarWizardContext(contextId);
      }
      return { ok:true };
    }catch(error){
      return messageError("talk:registerCleanup", error);
    }
  }
  if (msg.type === "talk:releaseContext"){
    const contextId = readMessageContextId(msg);
    if (!contextId){
      return { ok:false, error: bgI18n("talk_error_context_id_missing") };
    }
    deleteCalendarWizardContext(contextId);
    return { ok:true };
  }
  if (msg.type === "options:testConnection"){
    try{
      const result = await NCCore.testCredentials(msg.payload || {});
      if (result.ok){
        let policyStatus = null;
        try{
          if (typeof NCPolicyRuntime !== "undefined" && NCPolicyRuntime?.probePolicyStatus){
            policyStatus = await NCPolicyRuntime.probePolicyStatus({
              ...(msg.payload || {}),
              source: "options_test"
            });
          }else{
            L("options test connection policy probe skipped", { reason: "policy_runtime_unavailable" });
          }
        }catch(error){
          console.error("[NCBG] options:testConnection policy probe failed", error);
        }
        return {
          ok: true,
          message: result.message || "",
          version: result.version || "",
          userId: result.userId || "",
          policyStatus
        };
      }
      return { ok:false, error: result.message || bgI18n("error_credentials_missing"), code: result.code || "" };
    }catch(error){
      return messageError("options:testConnection", error);
    }
  }
  if (msg.type === "options:loginFlowStart"){
    try{
      const rawBaseUrl = String(msg.payload?.baseUrl || "").trim();
      if (!rawBaseUrl){
        return { ok:false, error: bgI18n("options_loginflow_missing") };
      }
      const baseUrl = NCCore.normalizeBaseUrl(rawBaseUrl);
      if (!baseUrl){
        return { ok:false, error: bgI18n("error_baseurl_https_required"), code: "https_required" };
      }
      const start = await NCCore.startLoginFlow(baseUrl);
      return {
        ok:true,
        loginUrl: start.loginUrl,
        pollEndpoint: start.pollEndpoint,
        pollToken: start.pollToken
      };
    }catch(error){
      console.error("[NCBG] options:loginFlowStart", error);
      return { ok:false, error: error?.message || bgI18n("options_loginflow_failed") };
    }
  }
  if (msg.type === "options:loginFlowComplete"){
    try{
      const pollEndpoint = msg.payload?.pollEndpoint || "";
      const pollToken = msg.payload?.pollToken || "";
      if (!pollEndpoint || !pollToken){
        return { ok:false, error: bgI18n("options_loginflow_failed") };
      }
      const creds = await NCCore.completeLoginFlow({ pollEndpoint, pollToken });
      return { ok:true, user: creds.loginName, appPass: creds.appPassword };
    }catch(error){
      console.error("[NCBG] options:loginFlowComplete", error);
      return { ok:false, error: error?.message || bgI18n("options_loginflow_failed") };
    }
  }
  if (msg.type === "sharing:checkFolderExists"){
    try{
      const shareName = typeof msg.payload?.shareName === "string"
        ? msg.payload.shareName.trim()
        : "";
      if (!shareName){
        return { ok:false, error: bgI18n("sharing_message_invalid_share_name") };
      }
      const exists = await NCSharing.checkFileLinkFolderExists({
        shareName,
        basePath: typeof msg.payload?.basePath === "string"
          ? msg.payload.basePath
          : "",
        shareDate: typeof msg.payload?.shareDate === "string"
          ? msg.payload.shareDate
          : ""
      });
      return { ok:true, exists };
    }catch(error){
      console.error("[NCBG] sharing:checkFolderExists", error);
      return {
        ok:false,
        error: error?.ncUserMessage || error?.message || bgI18n("sharing_status_error")
      };
    }
  }
  if (msg.type === "sharing:getLaunchContext"){
    try{
      const contextId = typeof msg.payload?.contextId === "string" ? msg.payload.contextId.trim() : "";
      if (!contextId){
        L("sharing:getLaunchContext invalid request (missing contextId)");
        return { ok:false, error: "context_id_missing" };
      }
      const response = await getComposeAttachmentLaunchContext(
        contextId,
        Number(msg.payload?.tabId),
        Number(msg.payload?.windowId)
      );
      if (!response.ok){
        L("sharing:getLaunchContext miss", { contextId: bgShortId(contextId, 24) });
        return response;
      }
      const context = response.context;
      L("sharing:getLaunchContext hit", {
        contextId: bgShortId(contextId, 24),
        mode: context?.mode || "",
        attachmentCount: Array.isArray(context?.attachments) ? context.attachments.length : 0
      });
      return { ok:true, context };
    }catch(error){
      console.error("[NCBG] sharing:getLaunchContext", error);
      return { ok:false, error: error?.message || String(error) };
    }
  }
  if (msg.type === "sharing:adoptAttachmentLaunchContext"){
    try{
      const contextId = typeof msg.payload?.contextId === "string" ? msg.payload.contextId.trim() : "";
      if (!contextId){
        return { ok:false, error:"context_id_missing" };
      }
      return adoptComposeAttachmentLaunchContext(
        contextId,
        Number(msg.payload?.tabId),
        Number(msg.payload?.windowId),
        Number(msg.payload?.attachmentCount)
      );
    }catch(error){
      return messageError("sharing:adoptAttachmentLaunchContext", error);
    }
  }
  if (msg.type === "sharing:rejectAttachmentLaunchContext"){
    try{
      const contextId = typeof msg.payload?.contextId === "string" ? msg.payload.contextId.trim() : "";
      if (!contextId){
        return { ok:false, error:"context_id_missing" };
      }
      return await rejectComposeAttachmentLaunchContext(
        contextId,
        Number(msg.payload?.tabId),
        Number(msg.payload?.windowId),
        String(msg.payload?.reason || "")
      );
    }catch(error){
      return messageError("sharing:rejectAttachmentLaunchContext", error);
    }
  }
  if (msg.type === "sharing:resolveAttachmentPrompt"){
    try{
      const promptId = typeof msg.payload?.promptId === "string" ? msg.payload.promptId.trim() : "";
      const decision = typeof msg.payload?.decision === "string" ? msg.payload.decision.trim() : "";
      if (!promptId){
        L("sharing:resolveAttachmentPrompt invalid request (missing promptId)");
        return { ok:false, error: "prompt_id_missing" };
      }
      const allowed = new Set(["share", "remove_last", "dismiss"]);
      const normalizedDecision = allowed.has(decision) ? decision : "dismiss";
      L("sharing:resolveAttachmentPrompt", {
        promptId: bgShortId(promptId, 24),
        decision: normalizedDecision
      });
      const resolved = resolveAttachmentPrompt(promptId, normalizedDecision, "runtime_message");
      return { ok:resolved };
    }catch(error){
      console.error("[NCBG] sharing:resolveAttachmentPrompt", error);
      return { ok:false, error: error?.message || String(error) };
    }
  }
  if (msg.type === "sharing:checkAttachmentAutomationAllowed"){
    try{
      const tabId = Number(msg.payload?.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0){
        return { ok:false, error: "tab_id_missing" };
      }
      const stage = typeof msg.payload?.stage === "string" ? msg.payload.stage.trim() : "";
      const guard = await assertAttachmentAutomationAllowed(stage || "wizard_finish", tabId, {
        source: "sharing_wizard"
      });
      if (!guard.ok){
        return {
          ok:false,
          error: "tb_big_attachment_setting_active",
          thresholdMb: guard.thresholdMb
        };
      }
      return { ok:true, thresholdMb: guard.thresholdMb };
    }catch(error){
      console.error("[NCBG] sharing:checkAttachmentAutomationAllowed", error);
      return { ok:false, error: error?.message || String(error) };
    }
  }
  if (msg.type === "sharing:finalizeRenderedShare"){
    return handleSharingFinalizeTransaction(msg.payload || {});
  }
  console.error("[NCBG] unknown runtime message type", {
    type: String(msg.type || ""),
    tabId: Number(sender?.tab?.id) || 0,
    frameId: Number(sender?.frameId) || 0
  });
  return { ok:false, error: "unknown_message_type" };
  })();
});
