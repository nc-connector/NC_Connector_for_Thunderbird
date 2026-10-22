/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

const FILELINK_UPLOAD_PORT = "nc-filelink-upload";
const FILELINK_UPLOAD_SESSIONS = new Map();
const FILELINK_UPLOAD_SESSION_BY_WINDOW = new Map();
const FILELINK_COMPLETED_BY_CLEANUP = new WeakMap();

function fileLinkTargetDescriptor(item){
  return {
    entry: { id: item.itemId, size: item.size, modified: item.lastModified,
      transferGroupId: item.transferGroupId },
    path: NCNextcloudDav.joinPath(item.relativeDir, item.fileName),
    kind: item.kind
  };
}

async function continueFileLinkUploadSession(session, prepared){
  const owner = getSharingWizardRemoteCleanupEntry(session.windowId, session.tabId);
  const completed = owner && FILELINK_COMPLETED_BY_CLEANUP.get(owner);
  if (!completed) throw new Error("file_link_continuation_missing");
  const items = prepared.sourcePlan.items;
  const pending = items.filter((item) => {
    const descriptor = fileLinkTargetDescriptor(item);
    const previous = completed.targets.find((target) => target.entry.id === item.itemId);
    if (!previous) return true;
    if (previous.path !== descriptor.path || previous.kind !== descriptor.kind
      || previous.entry.size !== descriptor.entry.size
      || previous.entry.modified !== descriptor.entry.modified){
      throw new Error("file_link_continuation_item_changed");
    }
    return !completed.done.has(item.itemId);
  });
  const additions = pending.filter((item) => !completed.targets.some((target) =>
    target.entry.id === item.itemId)).map(fileLinkTargetDescriptor);
  if (NCFileQueuePathConflicts.find([...completed.targets, ...additions])){
    throw new Error("file_link_continuation_target_conflict");
  }
  completed.targets.push(...additions);
  for (const item of pending){
    if (getSharingWizardRemoteCleanupEntry(session.windowId, session.tabId) !== owner){
      throw new Error("file_link_continuation_owner_changed");
    }
    const file = prepared.request.files.find((entry) => String(entry.id) === item.itemId);
    const next = NCSharing.prepareFileLinkRequest({ ...prepared.request, files: [file] });
    await NCSharing.appendFileLink(next, completed);
    completed.done.add(item.itemId);
  }
  return completed.result;
}

function postFileLinkUploadMessage(session, message){
  if (!session || session.disconnected){
    return false;
  }
  try{
    session.port.postMessage(message);
    return true;
  }catch(error){
    session.disconnected = true;
    if (!session.completed && !session.controller.signal.aborted){
      session.controller.abort();
    }
    console.error("[NCBG] FileLink upload port message failed", error);
    return false;
  }
}

function serializeFileLinkUploadError(error){
  const capabilitiesCode = String(error?.ncCapabilitiesCode || "");
  let capabilitiesMessage = "";
  if (capabilitiesCode === "minimum_version"){
    capabilitiesMessage = error?.message || "";
  }else if (capabilitiesCode === "missing"){
    capabilitiesMessage = bgI18n("error_credentials_missing");
  }else if (capabilitiesCode === "auth"){
    capabilitiesMessage = bgI18n("options_test_failed_auth");
  }
  const message = error?.ncUserMessage
    || capabilitiesMessage
    || bgI18n("sharing_status_error");
  return {
    name: String(error?.name || "Error"),
    message: String(message),
    status: Number(error?.status) || 0,
    code: String(error?.ncCapabilitiesCode || "")
  };
}

async function trackFailedFileLinkCleanup(session, cleanupEvent){
  if (cleanupEvent?.cleaned || !cleanupEvent?.root?.folderInfo){
    return;
  }
  await armSharingWizardRemoteCleanup(session.windowId, {
    tabId: session.tabId,
    folderInfo: cleanupEvent.root.folderInfo,
    shareLabel: cleanupEvent.root.shareName || "",
    shareUrl: "",
    shareId: "",
    cleanupTarget: cleanupEvent.root.cleanupTarget || null
  });
  const cleanupId = getSharingWizardRemoteCleanupId(session.windowId);
  if (session.disconnected){
    const removed = await deleteSharingWizardRemoteCleanupNow(
      session.windowId,
      "upload_cleanup_retry",
      cleanupId
    );
    if (!removed){
      scheduleSharingWizardRemoteCleanupRetry(
        session.windowId,
        cleanupId,
        "upload_cleanup_retry_delayed"
      );
    }
  }
}

async function cleanUntrackedFileLinkRoot(session){
  if (!session.root?.folderInfo || session.rootHandled){
    return;
  }
  try{
    await deleteShareCleanupEntry({
      folderInfo: session.root.folderInfo,
      cleanupTarget: session.root.cleanupTarget || null
    });
    session.rootHandled = true;
  }catch(error){
    console.error("[NCBG] FileLink untracked root cleanup failed", error);
    try{
      await trackFailedFileLinkCleanup(session, {
        cleaned: false,
        root: session.root
      });
      session.rootHandled = true;
    }catch(trackError){
      console.error("[NCBG] FileLink cleanup tracking failed", trackError);
    }
  }
}

async function prepareBackgroundFileLinkRequest(session, request){
  const wizardContext = getSharingWizardRequestContext(
    session.windowId,
    session.tabId
  );
  const policyStatus = await NCPolicyRuntime.getPolicyStatus();
  await NCPolicyRuntime.assertManagedAccess(policyStatus);
  const effectiveRequest = NCShareRequestRules.resolveUploadRequest(request, {
    policyStatus,
    attachmentMode: wizardContext.attachmentMode
  });
  L("FileLink request resolved", {
    windowId: session.windowId,
    attachmentMode: wizardContext.attachmentMode,
    policyActive: NCPolicyState.isDomainActive(policyStatus, "share"),
    files: Array.isArray(effectiveRequest.files) ? effectiveRequest.files.length : 0
  });
  return NCSharing.prepareFileLinkRequest({
    ...effectiveRequest,
    signal: session.controller.signal,
    onUploadStatus: (event) => {
      postFileLinkUploadMessage(session, {
        type: "progress",
        event
      });
    },
    onRootCreated: async (root) => {
      session.root = root;
      session.rootHandled = false;
    },
    onRootCleanup: async (event) => {
      if (event?.cleaned){
        session.rootHandled = true;
        return;
      }
      await trackFailedFileLinkCleanup(session, event);
      session.rootHandled = true;
    }
  });
}

async function runFileLinkUploadSession(session, request){
  try{
    const preparedRequest = await prepareBackgroundFileLinkRequest(session, request);
    if (request.append === true){
      session.rootHandled = true;
      const result = await continueFileLinkUploadSession(session, preparedRequest);
      session.completed = true;
      postFileLinkUploadMessage(session, { type: "result", result });
      return;
    }
    if (getSharingWizardRemoteCleanupEntry(session.windowId, session.tabId)){
      throw new Error("file_link_share_already_created");
    }
    const previousCleanupDone = await deleteSharingWizardRemoteCleanupNow(
      session.windowId,
      "before_upload"
    );
    if (!previousCleanupDone){
      throw new Error(bgI18n("sharing_status_error"));
    }
    const result = await NCSharing.createFileLink(preparedRequest);
    await armSharingWizardRemoteCleanup(session.windowId, {
      tabId: session.tabId,
      folderInfo: result?.shareInfo?.folderInfo,
      shareId: result?.shareInfo?.shareId || "",
      shareLabel: result?.shareInfo?.label || "",
      shareUrl: result?.shareInfo?.shareUrl || "",
      cleanupTarget: session.root?.cleanupTarget || null,
      shareDetails: {
        permissions: result?.shareInfo?.permissions,
        expireDate: result?.shareInfo?.expireDate || "",
        password: result?.shareInfo?.password || "",
        noteEnabled: result?.shareInfo?.noteEnabled === true,
        note: result?.shareInfo?.note || "",
        attachmentMode: preparedRequest.request.attachmentMode === true
      }
    });
    const cleanupId = getSharingWizardRemoteCleanupId(session.windowId);
    const owner = getSharingWizardRemoteCleanupEntry(session.windowId, session.tabId);
    FILELINK_COMPLETED_BY_CLEANUP.set(owner, {
      root: session.root, result,
      targets: preparedRequest.sourcePlan.items.map(fileLinkTargetDescriptor),
      done: new Set(preparedRequest.sourcePlan.items.map((item) => item.itemId))
    });
    session.rootHandled = true;
    session.completed = true;
    const delivered = postFileLinkUploadMessage(session, {
      type: "result",
      result
    });
    if (!delivered){
      const removed = await deleteSharingWizardRemoteCleanupNow(
        session.windowId,
        "result_not_delivered",
        cleanupId
      );
      if (!removed){
        scheduleSharingWizardRemoteCleanupRetry(
          session.windowId,
          cleanupId,
          "result_not_delivered_delayed"
        );
      }
    }
  }catch(error){
    await cleanUntrackedFileLinkRoot(session);
    if (error?.name !== "AbortError"){
      console.error("[NCBG] FileLink upload failed", error);
    }
    postFileLinkUploadMessage(session, {
      type: "error",
      error: serializeFileLinkUploadError(error)
    });
  }finally{
    FILELINK_UPLOAD_SESSIONS.delete(session.id);
  }
}

async function startFileLinkUploadSession(session, request){
  const previous = FILELINK_UPLOAD_SESSION_BY_WINDOW.get(session.windowId);
  FILELINK_UPLOAD_SESSION_BY_WINDOW.set(session.windowId, session);
  FILELINK_UPLOAD_SESSIONS.set(session.id, session);
  try{
    if (previous && previous !== session){
      await cancelFileLinkUploadSession(previous, "upload_replaced");
    }
    if (FILELINK_UPLOAD_SESSION_BY_WINDOW.get(session.windowId) !== session
      || session.disconnected
      || session.controller.signal.aborted){
      return;
    }
    await runFileLinkUploadSession(session, request);
  }finally{
    FILELINK_UPLOAD_SESSIONS.delete(session.id);
    if (FILELINK_UPLOAD_SESSION_BY_WINDOW.get(session.windowId) === session){
      FILELINK_UPLOAD_SESSION_BY_WINDOW.delete(session.windowId);
    }
  }
}

function cancelFileLinkUploadSession(session, reason = ""){
  if (!session || session.completed || session.controller.signal.aborted){
    return session?.task || Promise.resolve();
  }
  L("FileLink upload cancellation requested", {
    windowId: session.windowId,
    reason: reason || ""
  });
  session.controller.abort();
  return session.task || Promise.resolve();
}

browser.runtime.onConnect.addListener((port) => {
  if (port?.name !== FILELINK_UPLOAD_PORT){
    return;
  }
  const session = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
    port,
    controller: new AbortController(),
    windowId: 0,
    tabId: 0,
    root: null,
    rootHandled: false,
    completed: false,
    disconnected: false,
    started: false,
    task: null
  };

  port.onMessage.addListener((message) => {
    if (message?.type === "cancel"){
      void cancelFileLinkUploadSession(session, message.reason || "wizard_cancel");
      return;
    }
    if (message?.type !== "start" || session.started){
      return;
    }
    const windowId = Number(message.windowId);
    if (!Number.isInteger(windowId) || windowId <= 0){
      postFileLinkUploadMessage(session, {
        type: "error",
        error: serializeFileLinkUploadError(new Error("invalid_window_id"))
      });
      return;
    }
    session.started = true;
    session.windowId = windowId;
    session.tabId = Number(message.tabId) || 0;
    session.task = startFileLinkUploadSession(session, message.request || {});
  });

  port.onDisconnect.addListener(() => {
    session.disconnected = true;
    void cancelFileLinkUploadSession(session, "port_disconnected");
  });
});

browser.windows.onRemoved.addListener((windowId) => {
  clearSharingWizardRequestContext(windowId);
  for (const session of FILELINK_UPLOAD_SESSIONS.values()){
    if (session.windowId === windowId){
      session.disconnected = true;
      void cancelFileLinkUploadSession(session, "wizard_window_removed");
    }
  }
});
