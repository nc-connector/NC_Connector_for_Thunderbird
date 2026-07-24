/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Persistent remote-share cleanup store.
 * Records are keyed by opaque lifecycle IDs and contain only verified DAV
 * resource descriptors. Credentials are resolved again for every delete.
 */

const SHARE_CLEANUP_STORE_KEY = "nccShareCleanupGroupsV1";
const SHARE_CLEANUP_STORE_VERSION = 1;
const PERSISTED_SHARE_CLEANUP_RETRY_DELAYS_MS = Object.freeze([
  2000,
  5000,
  10000,
  30000,
  60000
]);
const PERSISTED_SHARE_CLEANUP_RETRY_TIMER_BY_GROUP = new Map();
let PERSISTED_SHARE_CLEANUP_GROUPS = {};
let PERSISTED_SHARE_CLEANUP_WRITE_QUEUE = Promise.resolve();
let PERSISTED_SHARE_CLEANUP_LOAD_ERROR = null;

function normalizePersistedCleanupRelativePath(value){
  const normalized = NCFileLinkDav.normalizeRelativePath(String(value || ""));
  if (!normalized){
    return "";
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")){
    return "";
  }
  return segments.join("/");
}

function normalizePersistedCleanupBaseUrl(value){
  const normalized = NCCore.normalizeBaseUrl(String(value || ""));
  if (!normalized){
    return "";
  }
  try{
    const parsed = new URL(normalized);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  }catch(error){
    return "";
  }
}

function parsePersistedDavCleanupUrl(value, expectedBaseUrl){
  const raw = String(value || "").trim();
  const normalizedBaseUrl = normalizePersistedCleanupBaseUrl(expectedBaseUrl);
  if (!raw || !normalizedBaseUrl){
    return null;
  }
  try{
    const parsed = new URL(raw);
    const base = new URL(normalizedBaseUrl);
    if (parsed.protocol !== base.protocol || parsed.origin !== base.origin){
      return null;
    }
    if (parsed.search || parsed.hash || parsed.username || parsed.password){
      return null;
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    const davPrefix = `${basePath}/remote.php/dav/files/`.replace(/\/{2,}/g, "/");
    if (!parsed.pathname.startsWith(davPrefix)){
      return null;
    }
    const encodedSegments = parsed.pathname.slice(davPrefix.length)
      .split("/")
      .filter(Boolean);
    if (encodedSegments.length < 2){
      return null;
    }
    const decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment));
    const userId = String(decodedSegments.shift() || "").trim();
    const relativePath = normalizePersistedCleanupRelativePath(decodedSegments.join("/"));
    if (!userId || !relativePath){
      return null;
    }
    return { userId, relativePath };
  }catch(error){
    return null;
  }
}

function persistedCleanupDescriptorKey(descriptor){
  return descriptor
    ? [
      descriptor.baseUrl,
      descriptor.userId,
      descriptor.relativeFolder,
      descriptor.reservationRelativeFolder || "",
      descriptor.targetRelativeFolder || ""
    ].join("|")
    : "";
}

function createPersistedShareCleanupDescriptor(entry){
  const cleanupTarget = entry?.cleanupTarget;
  if (!cleanupTarget || typeof cleanupTarget !== "object"){
    return null;
  }
  const baseUrl = normalizePersistedCleanupBaseUrl(cleanupTarget.baseUrl);
  const relativeFolder = normalizePersistedCleanupRelativePath(
    cleanupTarget.relativeFolder || entry?.folderInfo?.relativeFolder
  );
  const directTarget = parsePersistedDavCleanupUrl(cleanupTarget.url, baseUrl);
  if (!baseUrl
    || !relativeFolder
    || !directTarget
    || directTarget.relativePath !== relativeFolder){
    return null;
  }
  const reservationUrl = String(cleanupTarget.reservationUrl || "").trim();
  const targetUrl = String(cleanupTarget.targetUrl || "").trim();
  if (!!reservationUrl !== !!targetUrl){
    return null;
  }
  let reservationRelativeFolder = "";
  let targetRelativeFolder = "";
  if (reservationUrl){
    const reservation = parsePersistedDavCleanupUrl(reservationUrl, baseUrl);
    const finalTarget = parsePersistedDavCleanupUrl(targetUrl, baseUrl);
    if (!reservation
      || !finalTarget
      || reservation.userId !== directTarget.userId
      || finalTarget.userId !== directTarget.userId
      || finalTarget.relativePath !== relativeFolder){
      return null;
    }
    reservationRelativeFolder = reservation.relativePath;
    targetRelativeFolder = finalTarget.relativePath;
  }
  return Object.freeze({
    baseUrl,
    userId: directTarget.userId,
    relativeFolder,
    reservationRelativeFolder,
    targetRelativeFolder
  });
}

function normalizePersistedShareCleanupDescriptor(value){
  if (!value || typeof value !== "object"){
    return null;
  }
  const baseUrl = normalizePersistedCleanupBaseUrl(value.baseUrl);
  const userId = String(value.userId || "").trim();
  const relativeFolder = normalizePersistedCleanupRelativePath(value.relativeFolder);
  const reservationRelativeFolder = normalizePersistedCleanupRelativePath(
    value.reservationRelativeFolder
  );
  const targetRelativeFolder = normalizePersistedCleanupRelativePath(
    value.targetRelativeFolder
  );
  if (!baseUrl || !userId || !relativeFolder){
    return null;
  }
  if (!!reservationRelativeFolder !== !!targetRelativeFolder
    || (targetRelativeFolder && targetRelativeFolder !== relativeFolder)){
    return null;
  }
  return Object.freeze({
    baseUrl,
    userId,
    relativeFolder,
    reservationRelativeFolder,
    targetRelativeFolder
  });
}

function collectPersistedCleanupDescriptors(entries){
  const descriptors = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []){
    const descriptor = entry?.cleanupDescriptor
      ? normalizePersistedShareCleanupDescriptor(entry.cleanupDescriptor)
      : createPersistedShareCleanupDescriptor(entry);
    if (!descriptor){
      throw new Error("share_cleanup_descriptor_invalid");
    }
    const key = persistedCleanupDescriptorKey(descriptor);
    if (!seen.has(key)){
      seen.add(key);
      descriptors.push(descriptor);
    }
  }
  if (!descriptors.length){
    throw new Error("share_cleanup_descriptor_missing");
  }
  return descriptors;
}

function normalizePersistedShareCleanupGroup(groupId, value){
  if (!value || typeof value !== "object" || Number(value.version) !== SHARE_CLEANUP_STORE_VERSION){
    return null;
  }
  const ownerKind = String(value.ownerKind || "").trim();
  const state = String(value.state || "").trim();
  if (!["wizard", "compose"].includes(ownerKind)
    || !["active", "saved", "send_pending", "pending", "exhausted"].includes(state)){
    return null;
  }
  const resources = [];
  const seen = new Set();
  for (const candidate of Array.isArray(value.resources) ? value.resources : []){
    const descriptor = normalizePersistedShareCleanupDescriptor(candidate);
    const key = persistedCleanupDescriptorKey(descriptor);
    if (descriptor && key && !seen.has(key)){
      seen.add(key);
      resources.push(descriptor);
    }
  }
  if (!resources.length){
    return null;
  }
  // Password dispatch payloads are intentionally not persisted. Saved drafts
  // receive explicit manual password drafts before their compose tab can close.
  if (Array.isArray(value.dispatches) && value.dispatches.length){
    return null;
  }
  return {
    version: SHARE_CLEANUP_STORE_VERSION,
    groupId,
    ownerKind,
    state,
    saved: value.saved === true,
    passwordHandoffRequired: value.passwordHandoffRequired === true,
    passwordHandoffComplete: value.passwordHandoffRequired !== true
      || value.passwordHandoffComplete === true,
    templateUnsupported: value.templateUnsupported === true,
    lifecycleTainted: value.lifecycleTainted === true,
    savePendingChanges: value.savePendingChanges === true,
    sendPending: state === "send_pending" || value.sendPending === true,
    sendPendingPreviousState: ["active", "saved"].includes(
      String(value.sendPendingPreviousState || "")
    )
      ? String(value.sendPendingPreviousState)
      : "",
    messageIds: (Array.isArray(value.messageIds) ? value.messageIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0),
    resources,
    dispatches: [],
    attempt: Math.max(0, Number(value.attempt) || 0),
    created: Math.max(0, Number(value.created) || Date.now()),
    updated: Math.max(0, Number(value.updated) || Date.now())
  };
}

function persistedShareCleanupSnapshot(groups = PERSISTED_SHARE_CLEANUP_GROUPS){
  const snapshot = {};
  for (const [groupId, group] of Object.entries(groups)){
    snapshot[groupId] = {
      version: SHARE_CLEANUP_STORE_VERSION,
      ownerKind: group.ownerKind,
      state: group.state,
      saved: group.saved === true,
      passwordHandoffRequired: group.passwordHandoffRequired === true,
      passwordHandoffComplete: group.passwordHandoffRequired !== true
        || group.passwordHandoffComplete === true,
      templateUnsupported: group.templateUnsupported === true,
      lifecycleTainted: group.lifecycleTainted === true,
      savePendingChanges: group.savePendingChanges === true,
      sendPending: group.state === "send_pending" || group.sendPending === true,
      sendPendingPreviousState: ["active", "saved"].includes(
        String(group.sendPendingPreviousState || "")
      )
        ? String(group.sendPendingPreviousState)
        : "",
      messageIds: group.messageIds.slice(),
      resources: group.resources.map((descriptor) => ({ ...descriptor })),
      dispatches: [],
      attempt: group.attempt,
      created: group.created,
      updated: group.updated
    };
  }
  return snapshot;
}

function assertPersistedShareCleanupHasNoSecrets(value){
  if (!value || typeof value !== "object"){
    return;
  }
  for (const [key, child] of Object.entries(value)){
    if (/^(authHeader|appPass|password|html|plainText|body)$/i.test(key)){
      throw new Error("share_cleanup_store_contains_sensitive_field");
    }
    if (child && typeof child === "object"){
      assertPersistedShareCleanupHasNoSecrets(child);
    }
  }
}

function assertPersistentShareCleanupStoreAvailable(){
  if (PERSISTED_SHARE_CLEANUP_LOAD_ERROR){
    throw new Error("share_cleanup_store_unavailable");
  }
}

function queuePersistentShareCleanupMutation(mutate){
  const operation = PERSISTED_SHARE_CLEANUP_WRITE_QUEUE
    .catch(() => {})
    .then(async () => {
      assertPersistentShareCleanupStoreAvailable();
      const candidateGroups = structuredClone(PERSISTED_SHARE_CLEANUP_GROUPS);
      const outcome = mutate(candidateGroups);
      if (!outcome || typeof outcome !== "object"){
        throw new Error("share_cleanup_mutation_result_invalid");
      }
      if (outcome.changed !== true){
        return outcome.value;
      }
      const snapshot = persistedShareCleanupSnapshot(candidateGroups);
      assertPersistedShareCleanupHasNoSecrets(snapshot);
      await browser.storage.local.set({
        [SHARE_CLEANUP_STORE_KEY]: snapshot
      });
      PERSISTED_SHARE_CLEANUP_GROUPS = candidateGroups;
      return outcome.value;
    });
  PERSISTED_SHARE_CLEANUP_WRITE_QUEUE = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

const PERSISTED_SHARE_CLEANUP_READY = (async () => {
  try{
    const stored = await browser.storage.local.get([SHARE_CLEANUP_STORE_KEY]);
    const source = stored?.[SHARE_CLEANUP_STORE_KEY];
    const groups = {};
    for (const [groupId, value] of Object.entries(
      source && typeof source === "object" && !Array.isArray(source) ? source : {}
    )){
      const normalizedId = String(groupId || "").trim();
      const group = COMPOSE_SHARE_DRAFT_ID_PATTERN.test(normalizedId)
        ? normalizePersistedShareCleanupGroup(normalizedId, value)
        : null;
      if (group){
        groups[normalizedId] = group;
      }
    }
    PERSISTED_SHARE_CLEANUP_GROUPS = groups;
  }catch(error){
    PERSISTED_SHARE_CLEANUP_LOAD_ERROR = error;
    console.error("[NCBG] share cleanup store hydration failed", error);
  }
})();

async function persistWizardShareCleanupGroup(entry){
  await PERSISTED_SHARE_CLEANUP_READY;
  const groupId = String(entry?.cleanupId || "").trim();
  if (!COMPOSE_SHARE_DRAFT_ID_PATTERN.test(groupId)){
    throw new Error("share_cleanup_group_id_invalid");
  }
  const resources = collectPersistedCleanupDescriptors([entry]);
  return queuePersistentShareCleanupMutation((groups) => {
    groups[groupId] = {
      version: SHARE_CLEANUP_STORE_VERSION,
      groupId,
      ownerKind: "wizard",
      state: "active",
      saved: false,
      passwordHandoffRequired: false,
      passwordHandoffComplete: true,
      templateUnsupported: false,
      lifecycleTainted: false,
      savePendingChanges: false,
      sendPending: false,
      sendPendingPreviousState: "",
      messageIds: [],
      resources,
      dispatches: [],
      attempt: 0,
      created: Date.now(),
      updated: Date.now()
    };
    return { changed: true, value: groupId };
  });
}

async function stagePersistentComposeCleanupGroup(
  wizardGroupId,
  composeGroupId,
  entries
){
  await PERSISTED_SHARE_CLEANUP_READY;
  const sourceId = String(wizardGroupId || "").trim();
  const targetId = String(composeGroupId || "").trim();
  if (!COMPOSE_SHARE_DRAFT_ID_PATTERN.test(targetId)){
    throw new Error("compose_share_draft_group_invalid");
  }
  const resources = collectPersistedCleanupDescriptors(entries);
  return queuePersistentShareCleanupMutation((groups) => {
    const previousWizard = sourceId && groups[sourceId]
      ? structuredClone(groups[sourceId])
      : null;
    const previousCompose = groups[targetId]
      ? structuredClone(groups[targetId])
      : null;
    const expectedResourceKeys = new Set([
      ...(previousCompose?.resources || []),
      ...(previousWizard?.resources || [])
    ].map(persistedCleanupDescriptorKey));
    const resourceKeys = new Set(resources.map(persistedCleanupDescriptorKey));
    if (!previousWizard
      || previousWizard.ownerKind !== "wizard"
      || previousWizard.state !== "active"
      || expectedResourceKeys.size !== resourceKeys.size
      || [...expectedResourceKeys].some((key) => !resourceKeys.has(key))){
      throw new Error("wizard_cleanup_persistence_mismatch");
    }
    const now = Date.now();
    const hasSavedBaseline = previousCompose?.ownerKind === "compose"
      && previousCompose.saved === true
      && ["saved", "send_pending"].includes(previousCompose.state);
    groups[targetId] = {
      version: SHARE_CLEANUP_STORE_VERSION,
      groupId: targetId,
      ownerKind: "compose",
      state: hasSavedBaseline ? "saved" : "active",
      saved: hasSavedBaseline,
      passwordHandoffRequired: previousCompose?.passwordHandoffRequired === true,
      passwordHandoffComplete: previousCompose?.passwordHandoffRequired !== true
        || previousCompose?.passwordHandoffComplete === true,
      templateUnsupported: previousCompose?.templateUnsupported === true,
      lifecycleTainted: previousCompose?.lifecycleTainted === true,
      savePendingChanges: hasSavedBaseline,
      sendPending: false,
      sendPendingPreviousState: "",
      messageIds: hasSavedBaseline
        ? (previousCompose?.messageIds || []).slice()
        : [],
      resources,
      dispatches: [],
      attempt: 0,
      created: Number(previousCompose?.created) || now,
      updated: now
    };
    if (sourceId && sourceId !== targetId){
      delete groups[sourceId];
    }
    return {
      changed: true,
      value: {
        wizardGroupId: sourceId,
        composeGroupId: targetId,
        previousWizard,
        previousCompose
      }
    };
  });
}

async function rollbackPersistentComposeCleanupGroup(transition){
  await PERSISTED_SHARE_CLEANUP_READY;
  if (!transition){
    return;
  }
  await queuePersistentShareCleanupMutation((groups) => {
    if (transition.previousCompose){
      groups[transition.composeGroupId] = structuredClone(
        transition.previousCompose
      );
    }else{
      delete groups[transition.composeGroupId];
    }
    if (transition.previousWizard){
      groups[transition.wizardGroupId] = structuredClone(
        transition.previousWizard
      );
    }
    return { changed: true, value: undefined };
  });
}

async function markPersistentComposeCleanupSaved(
  groupId,
  messageIds = [],
  options = {}
){
  await PERSISTED_SHARE_CLEANUP_READY;
  const normalizedId = String(groupId || "").trim();
  const normalizedMessageIds = (Array.isArray(messageIds) ? messageIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  return queuePersistentShareCleanupMutation((groups) => {
    const group = groups[normalizedId];
    if (!group || group.ownerKind !== "compose"){
      return { changed: false, value: false };
    }
    group.state = "saved";
    group.saved = true;
    group.passwordHandoffRequired = options.passwordHandoffRequired === true;
    group.passwordHandoffComplete = group.passwordHandoffRequired !== true
      || options.passwordHandoffComplete === true;
    group.templateUnsupported = group.templateUnsupported === true
      || options.templateUnsupported === true;
    group.savePendingChanges = false;
    group.sendPending = false;
    group.sendPendingPreviousState = "";
    group.messageIds = normalizedMessageIds;
    group.attempt = 0;
    group.updated = Date.now();
    return { changed: true, value: true };
  });
}

async function markPersistentComposePasswordHandoff(
  groupId,
  required,
  complete
){
  await PERSISTED_SHARE_CLEANUP_READY;
  const normalizedId = String(groupId || "").trim();
  return queuePersistentShareCleanupMutation((groups) => {
    const group = groups[normalizedId];
    if (!group || group.ownerKind !== "compose"){
      return { changed: false, value: false };
    }
    group.passwordHandoffRequired = required === true;
    group.passwordHandoffComplete = required !== true || complete === true;
    group.updated = Date.now();
    return { changed: true, value: true };
  });
}

async function markPersistentComposeSendPending(groupId, pending){
  await PERSISTED_SHARE_CLEANUP_READY;
  const normalizedId = String(groupId || "").trim();
  return queuePersistentShareCleanupMutation((groups) => {
    const group = groups[normalizedId];
    if (!group || group.ownerKind !== "compose"){
      return { changed: false, value: false };
    }
    if (pending === true){
      if (group.state !== "send_pending"){
        if (!["active", "saved"].includes(group.state)){
          return { changed: false, value: false };
        }
        group.sendPendingPreviousState = group.state;
      }
      group.state = "send_pending";
      group.sendPending = true;
    }else{
      if (group.state !== "send_pending" && group.sendPending !== true){
        return { changed: false, value: true };
      }
      const previousState = ["active", "saved"].includes(
        String(group.sendPendingPreviousState || "")
      )
        ? group.sendPendingPreviousState
        : (group.saved === true ? "saved" : "active");
      group.state = previousState;
      group.sendPending = false;
      group.sendPendingPreviousState = "";
    }
    group.updated = Date.now();
    return { changed: true, value: true };
  });
}

async function removePersistentShareCleanupGroup(groupId){
  await PERSISTED_SHARE_CLEANUP_READY;
  const normalizedId = String(groupId || "").trim();
  const removed = await queuePersistentShareCleanupMutation((groups) => {
    if (!groups[normalizedId]){
      return { changed: false, value: false };
    }
    delete groups[normalizedId];
    return { changed: true, value: true };
  });
  if (removed){
    const timerId = PERSISTED_SHARE_CLEANUP_RETRY_TIMER_BY_GROUP.get(normalizedId);
    if (timerId){
      clearTimeout(timerId);
      PERSISTED_SHARE_CLEANUP_RETRY_TIMER_BY_GROUP.delete(normalizedId);
    }
  }
  return removed;
}

function getPersistedComposeCleanupEntries(groupId){
  const normalizedId = String(groupId || "").trim();
  const group = PERSISTED_SHARE_CLEANUP_GROUPS[normalizedId];
  if (!group || group.ownerKind !== "compose"){
    return [];
  }
  return group.resources.map((descriptor) => Object.freeze({
    folderInfo: Object.freeze({
      relativeFolder: descriptor.relativeFolder
    }),
    cleanupDescriptor: descriptor,
    cleanupTarget: null,
    shareId: "",
    shareLabel: "",
    shareUrl: "",
    created: group.created
  }));
}

function getPersistentShareCleanupGroup(groupId){
  const normalizedId = String(groupId || "").trim();
  return PERSISTED_SHARE_CLEANUP_GROUPS[normalizedId] || null;
}

async function removePersistentShareCleanupDescriptor(groupId, descriptor){
  await PERSISTED_SHARE_CLEANUP_READY;
  const normalizedId = String(groupId || "").trim();
  const targetKey = persistedCleanupDescriptorKey(descriptor);
  const outcome = await queuePersistentShareCleanupMutation((groups) => {
    const group = groups[normalizedId];
    if (!group){
      return { changed: false, value: { removed: false, groupRemoved: false } };
    }
    const resources = group.resources.filter((candidate) => {
      return persistedCleanupDescriptorKey(candidate) !== targetKey;
    });
    if (resources.length === group.resources.length){
      return { changed: false, value: { removed: false, groupRemoved: false } };
    }
    if (!resources.length){
      delete groups[normalizedId];
      return { changed: true, value: { removed: true, groupRemoved: true } };
    }
    group.resources = resources;
    group.updated = Date.now();
    return { changed: true, value: { removed: true, groupRemoved: false } };
  });
  if (outcome.groupRemoved){
    const timerId = PERSISTED_SHARE_CLEANUP_RETRY_TIMER_BY_GROUP.get(normalizedId);
    if (timerId){
      clearTimeout(timerId);
      PERSISTED_SHARE_CLEANUP_RETRY_TIMER_BY_GROUP.delete(normalizedId);
    }
  }
  return outcome.removed;
}

async function deletePersistedShareCleanupDescriptor(descriptor){
  const normalized = normalizePersistedShareCleanupDescriptor(descriptor);
  if (!normalized){
    throw new Error("share_cleanup_descriptor_invalid");
  }
  const opts = await NCCore.getOpts();
  const currentBaseUrl = normalizePersistedCleanupBaseUrl(opts?.baseUrl);
  if (!currentBaseUrl || currentBaseUrl !== normalized.baseUrl){
    throw new Error("share_cleanup_account_base_mismatch");
  }
  if (!opts?.user || !opts?.appPass){
    throw new Error("share_cleanup_credentials_missing");
  }
  if (NCHostPermissions?.requireOriginPermission){
    const permitted = await NCHostPermissions.requireOriginPermission(currentBaseUrl, {
      message: bgI18n("error_host_permission_missing"),
      scope: "share cleanup host permission missing"
    });
    if (!permitted){
      throw new Error("share_cleanup_host_permission_missing");
    }
  }
  const currentUserId = await NCCore.getCurrentUserId(opts);
  if (String(currentUserId || "").trim() !== normalized.userId){
    throw new Error("share_cleanup_account_user_mismatch");
  }
  const authHeader = NCOcs.buildAuthHeader(opts.user, opts.appPass);
  const davRoot = `${currentBaseUrl}/remote.php/dav/files/${encodeURIComponent(currentUserId)}`;
  await NCFileLinkDav.deleteTrackedRoot({
    url: NCFileLinkDav.buildFileUrl(davRoot, normalized.relativeFolder),
    reservationUrl: normalized.reservationRelativeFolder
      ? NCFileLinkDav.buildFileUrl(davRoot, normalized.reservationRelativeFolder)
      : "",
    targetUrl: normalized.targetRelativeFolder
      ? NCFileLinkDav.buildFileUrl(davRoot, normalized.targetRelativeFolder)
      : "",
    authHeader,
    log: (...args) => L(...args)
  });
  await NCFileLinkShare.clearIndeterminate({
    baseUrl: currentBaseUrl,
    relativeFolder: normalized.relativeFolder,
    authHeader
  });
}

async function runPersistedShareCleanupAttempt(groupId, reason = ""){
  await PERSISTED_SHARE_CLEANUP_READY;
  const group = PERSISTED_SHARE_CLEANUP_GROUPS[groupId];
  if (!group || group.state !== "pending"){
    return true;
  }
  if (globalThis.navigator?.onLine === false){
    L("persistent share cleanup paused while offline", {
      groupId: bgShortId(groupId, 24),
      reason: reason || ""
    });
    return false;
  }
  try{
    for (const descriptor of group.resources.slice()){
      await deletePersistedShareCleanupDescriptor(descriptor);
      await removePersistentShareCleanupDescriptor(groupId, descriptor);
    }
    L("persistent share cleanup done", {
      groupId: bgShortId(groupId, 24),
      reason: reason || ""
    });
    return true;
  }catch(error){
    const currentState = await queuePersistentShareCleanupMutation((groups) => {
      const current = groups[groupId];
      if (!current){
        return { changed: false, value: null };
      }
      current.attempt += 1;
      current.state = current.attempt >= PERSISTED_SHARE_CLEANUP_RETRY_DELAYS_MS.length
        ? "exhausted"
        : "pending";
      current.updated = Date.now();
      return {
        changed: true,
        value: {
          attempt: current.attempt,
          state: current.state
        }
      };
    });
    if (!currentState){
      return true;
    }
    console.error("[NCBG] persistent share cleanup failed", {
      groupId: bgShortId(groupId, 24),
      reason: reason || "",
      attempt: currentState.attempt,
      exhausted: currentState.state === "exhausted",
      error: error?.message || String(error)
    });
    if (currentState.state === "pending"){
      schedulePersistedShareCleanupRetry(groupId, reason);
    }
    return false;
  }
}

function schedulePersistedShareCleanupRetry(groupId, reason = ""){
  const group = PERSISTED_SHARE_CLEANUP_GROUPS[groupId];
  if (!group
    || group.state !== "pending"
    || PERSISTED_SHARE_CLEANUP_RETRY_TIMER_BY_GROUP.has(groupId)){
    return false;
  }
  const retryIndex = Math.max(0, Math.min(
    PERSISTED_SHARE_CLEANUP_RETRY_DELAYS_MS.length - 1,
    group.attempt
  ));
  const timerId = setTimeout(() => {
    PERSISTED_SHARE_CLEANUP_RETRY_TIMER_BY_GROUP.delete(groupId);
    void runPersistedShareCleanupAttempt(groupId, reason);
  }, PERSISTED_SHARE_CLEANUP_RETRY_DELAYS_MS[retryIndex]);
  PERSISTED_SHARE_CLEANUP_RETRY_TIMER_BY_GROUP.set(groupId, timerId);
  return true;
}

async function markPersistentShareCleanupPending(groupId, reason = "", options = {}){
  await PERSISTED_SHARE_CLEANUP_READY;
  const normalizedId = String(groupId || "").trim();
  const marked = await queuePersistentShareCleanupMutation((groups) => {
    const group = groups[normalizedId];
    if (!group
      || group.saved === true
      || ["saved", "send_pending"].includes(group.state)
      || (group.state === "exhausted" && options.resetAttempts !== true)){
      return { changed: false, value: false };
    }
    group.state = "pending";
    group.saved = false;
    group.sendPending = false;
    group.sendPendingPreviousState = "";
    if (options.resetAttempts === true){
      group.attempt = 0;
    }
    group.updated = Date.now();
    return { changed: true, value: true };
  });
  if (marked && options.schedule !== false){
    schedulePersistedShareCleanupRetry(normalizedId, reason);
  }
  return marked;
}

async function markPersistentShareCleanupExhausted(groupId){
  await PERSISTED_SHARE_CLEANUP_READY;
  const normalizedId = String(groupId || "").trim();
  return queuePersistentShareCleanupMutation((groups) => {
    const group = groups[normalizedId];
    if (!group){
      return { changed: false, value: false };
    }
    group.state = "exhausted";
    group.saved = false;
    group.sendPending = false;
    group.sendPendingPreviousState = "";
    group.attempt = PERSISTED_SHARE_CLEANUP_RETRY_DELAYS_MS.length;
    group.updated = Date.now();
    return { changed: true, value: true };
  });
}

async function markPersistentShareCleanupTainted(groupId){
  await PERSISTED_SHARE_CLEANUP_READY;
  const normalizedId = String(groupId || "").trim();
  return queuePersistentShareCleanupMutation((groups) => {
    const group = groups[normalizedId];
    if (!group){
      return { changed: false, value: false };
    }
    group.state = "exhausted";
    group.lifecycleTainted = true;
    group.sendPending = false;
    group.sendPendingPreviousState = "";
    group.attempt = PERSISTED_SHARE_CLEANUP_RETRY_DELAYS_MS.length;
    group.updated = Date.now();
    return { changed: true, value: true };
  });
}

async function resumePersistedShareCleanup(reason = "", options = {}){
  await PERSISTED_SHARE_CLEANUP_READY;
  if (PERSISTED_SHARE_CLEANUP_LOAD_ERROR){
    return;
  }
  await queuePersistentShareCleanupMutation((groups) => {
    let changed = false;
    for (const group of Object.values(groups)){
      if (options.recoverActive === true
        && group.state === "active"
        && group.saved !== true){
        const passwordRecoveryRequired = group.passwordHandoffRequired === true
          && group.passwordHandoffComplete !== true;
        group.state = passwordRecoveryRequired ? "exhausted" : "pending";
        group.attempt = passwordRecoveryRequired
          ? PERSISTED_SHARE_CLEANUP_RETRY_DELAYS_MS.length
          : 0;
        group.updated = Date.now();
        changed = true;
      }
    }
    return { changed, value: undefined };
  });
  for (const group of Object.values(PERSISTED_SHARE_CLEANUP_GROUPS)){
    if (group.state === "pending"){
      schedulePersistedShareCleanupRetry(group.groupId, reason);
    }
  }
}

browser.runtime.onStartup.addListener(() => {
  void resumePersistedShareCleanup(
    "runtime_startup",
    { recoverActive: true }
  );
});

if (typeof globalThis.addEventListener === "function"){
  globalThis.addEventListener("online", () => {
    void resumePersistedShareCleanup(
      "online",
      { recoverActive: false }
    );
  });
}

setTimeout(() => {
  void resumePersistedShareCleanup(
    "background_start",
    { recoverActive: true }
  );
}, 0);
