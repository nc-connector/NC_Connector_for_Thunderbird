/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Runtime message router.
 * Centralizes WebExtension message contracts used by options/talk/sharing UIs.
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

/**
 * Read the canonical top-level runtime message context id.
 * Legacy payload-based variants are intentionally not accepted here.
 * @param {any} msg
 * @returns {string}
 */
function readMessageContextId(msg){
  return typeof msg?.contextId === "string" ? msg.contextId.trim() : "";
}

/**
 * Central runtime.onMessage dispatcher.
 * Keep this as the single message contract entrypoint for UI/background calls.
 */
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  return (async () => {
    L("msg", msg.type, { hasPayload: !!msg.payload });
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
    if (DEBUG_ENABLED){
      try{
        console.log(prefix, text, ...extras);
      }catch(error){
        console.error("[NCBG] forwarded debug log failed", error);
      }
    }
    return { ok:true };
  }
  if (msg.type === "passwordPolicy:fetch"){
    const policy = await fetchPasswordPolicy();
    return { ok:true, policy };
  }
  if (msg.type === "passwordPolicy:generate"){
    return await generatePasswordViaPolicy(msg?.payload?.policy || {});
  }
  if (msg.type === "policy:getStatus"){
    try{
      const status = await NCPolicyRuntime.getPolicyStatus();
      return { ok:true, status };
    }catch(e){
      return messageError("policy:getStatus", e);
    }
  }
  if (msg.type === "talk:searchUsers"){
    try{
      const users = await NCTalkCore.searchSystemAddressbook(msg.payload || {});
      return { ok:true, users };
    }catch(e){
      return messageError("talk:searchUsers", e);
    }
  }
  if (msg.type === "talk:getSystemAddressbookStatus"){
    try{
      const status = await NCTalkCore.getSystemAddressbookStatus(msg.payload || {});
      return { ok:true, status };
    }catch(e){
      return messageError("talk:getSystemAddressbookStatus", e);
    }
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
        fieldsPayload.descriptionHtml = fields.descriptionHtml;
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
    }catch(e){
      console.error("[NCBG] talk:applyEventFields error", { contextId, error: e?.message || String(e) });
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "talk:createRoom"){
    try{
      const result = await NCTalkCore.createTalkPublicRoom(msg.payload);
      return { ok:true, result };
    }catch(e){
      return messageError("talk:createRoom", e);
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
    }catch(e){
      return messageError("talk:trackRoom", e);
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
        await setEventTokenEntry(context.item.calendarId, context.item.id, { token: meta.token, url: meta.url || "" });
      }
      return { ok:true };
    }catch(e){
      console.error("[NCBG] talk:applyMetadata error", { contextId, error: e?.message || String(e) });
      if (meta?.token){
        try{
          await NCTalkCore.deleteTalkRoom({ token: meta.token });
          await deleteRoomMeta(meta.token);
        }catch(error){
          console.error("[NCBG] talk:applyMetadata rollback failed", error);
        }
      }
      return { ok:false, error: e?.message || String(e) };
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

      deleteCalendarWizardContext(contextId);
      return { ok:true };
    }catch(e){
      return messageError("talk:registerCleanup", e);
    }
  }
  if (msg.type === "options:testConnection"){
    try{
      const result = await NCCore.testCredentials(msg.payload || {});
      if (result.ok){
        return { ok:true, message: result.message || "", version: result.version || "" };
      }
      return { ok:false, error: result.message || bgI18n("error_credentials_missing"), code: result.code || "" };
    }catch(e){
      return messageError("options:testConnection", e);
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
    }catch(e){
      console.error("[NCBG] options:loginFlowStart", e);
      return { ok:false, error: e?.message || bgI18n("options_loginflow_failed") };
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
    }catch(e){
      console.error("[NCBG] options:loginFlowComplete", e);
      return { ok:false, error: e?.message || bgI18n("options_loginflow_failed") };
    }
  }
  if (msg.type === "sharing:getLaunchContext"){
    try{
      const contextId = typeof msg.payload?.contextId === "string" ? msg.payload.contextId.trim() : "";
      if (!contextId){
        L("sharing:getLaunchContext invalid request (missing contextId)");
        return { ok:false, error: "context_id_missing" };
      }
      const context = takeSharingLaunchContext(contextId);
      if (!context){
        L("sharing:getLaunchContext miss", { contextId: bgShortId(contextId, 24) });
        return { ok:false, error: "context_not_found" };
      }
      L("sharing:getLaunchContext hit", {
        contextId: bgShortId(contextId, 24),
        mode: context?.mode || "",
        attachmentCount: Array.isArray(context?.attachments) ? context.attachments.length : 0
      });
      return { ok:true, context };
    }catch(e){
      console.error("[NCBG] sharing:getLaunchContext", e);
      return { ok:false, error: e?.message || String(e) };
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
    }catch(e){
      console.error("[NCBG] sharing:resolveAttachmentPrompt", e);
      return { ok:false, error: e?.message || String(e) };
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
    }catch(e){
      console.error("[NCBG] sharing:checkAttachmentAutomationAllowed", e);
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "sharing:registerSeparatePasswordDispatch"){
    try{
      const tabId = Number(msg.payload?.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0){
        return { ok:false, error: "tab_id_missing" };
      }
      await registerSeparatePasswordMailDispatch(tabId, msg.payload || {});
      return { ok:true };
    }catch(e){
      console.error("[NCBG] sharing:registerSeparatePasswordDispatch", e);
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "sharing:armComposeShareCleanup"){
    try{
      const tabId = Number(msg.payload?.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0){
        return { ok:false, error: "tab_id_missing" };
      }
      await armComposeShareCleanup(tabId, msg.payload || {});
      return { ok:true };
    }catch(e){
      console.error("[NCBG] sharing:armComposeShareCleanup", e);
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "sharing:armWizardRemoteCleanup"){
    try{
      const windowId = Number(msg.payload?.windowId);
      if (!Number.isInteger(windowId) || windowId <= 0){
        return { ok:false, error: "window_id_missing" };
      }
      await armSharingWizardRemoteCleanup(windowId, msg.payload || {});
      return { ok:true };
    }catch(e){
      console.error("[NCBG] sharing:armWizardRemoteCleanup", e);
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "sharing:clearWizardRemoteCleanup"){
    try{
      const windowId = Number(msg.payload?.windowId);
      if (!Number.isInteger(windowId) || windowId <= 0){
        return { ok:false, error: "window_id_missing" };
      }
      clearSharingWizardRemoteCleanup(windowId, "wizard_finalize");
      return { ok:true };
    }catch(e){
      console.error("[NCBG] sharing:clearWizardRemoteCleanup", e);
      return { ok:false, error: e?.message || String(e) };
    }
  }
  if (msg.type === "sharing:insertHtml"){
    try{
      const tabId = msg.payload?.tabId;
      const html = msg.payload?.html || "";
      if (!tabId || !html){
        return { ok:false, error: "tab/html missing" };
      }
      const details = await browser.compose.getComposeDetails(tabId);
      const currentBody = details.body || "";
      const blockSegment = `<br>${html}<br><br>`;
      const bodyMatch = currentBody.match(/<body[^>]*>/i);
      let newBody = "";
      if (bodyMatch){
        const insertIndex = bodyMatch.index + bodyMatch[0].length;
        newBody = currentBody.slice(0, insertIndex) + blockSegment + currentBody.slice(insertIndex);
      }else{
        newBody = blockSegment + currentBody;
      }
      await browser.compose.setComposeDetails(tabId, { body: newBody, isPlainText: false });
      return { ok:true };
    }catch(e){
      return messageError("sharing:insertHtml", e);
    }
  }
  console.error("[NCBG] unknown runtime message type", {
    type: String(msg.type || ""),
    tabId: Number(sender?.tab?.id) || 0,
    frameId: Number(sender?.frameId) || 0
  });
  return { ok:false, error: "unknown_message_type" };
  })();
});
