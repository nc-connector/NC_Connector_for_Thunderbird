/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

/**
 * Reads Thunderbird Enterprise Policy values exposed through storage.managed.
 * Thunderbird does not expose platform registry backends to extensions directly.
 */
const NCManagedSetup = (() => {
  const MANAGED_KEYS = [
    "NextcloudUrl",
    "NextcloudUrlLocked",
    "nextcloudUrl",
    "nextcloudUrlLocked",
    "baseUrl",
    "baseUrlLocked",
    "adminSettings"
  ];

  function emptyPolicy(){
    return {
      hasNextcloudUrl: false,
      nextcloudUrl: "",
      nextcloudUrlLocked: false,
      source: ""
    };
  }

  function normalizeNextcloudUrl(value){
    return NCTalkTextUtils.normalizeBaseUrl(value);
  }

  function readBoolean(value){
    if (value === true || value === 1){
      return true;
    }
    if (typeof value === "string"){
      const normalized = value.trim().toLowerCase();
      return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
    }
    return false;
  }

  function firstValue(values, keys){
    for (const key of keys){
      if (Object.prototype.hasOwnProperty.call(values || {}, key)){
        return values[key];
      }
    }
    return undefined;
  }

  function unwrapValues(values){
    if (values?.adminSettings && typeof values.adminSettings === "object" && !Array.isArray(values.adminSettings)){
      return Object.assign({}, values.adminSettings, values);
    }
    return values || {};
  }

  function createManagedSetupReadError(error){
    const localizedMessage = globalThis.browser?.i18n?.getMessage?.("options_status_load_failed")
      || "Settings could not be loaded.";
    const failure = new Error(localizedMessage);
    failure.name = "ManagedSetupReadError";
    failure.code = "managed_setup_read_failed";
    const loggedError = new Error("Managed setup policy read failed.");
    loggedError.name = failure.name;
    const prefix = globalThis.NCLogContext?.resolveAddonLogPrefix?.("ManagedSetup")
      || "[NCBG]";
    globalThis.NCLogContext?.safeConsoleError?.(
      prefix,
      "managed setup policy read failed",
      loggedError,
      {
        errorName: String(error?.name || "Error")
      }
    );
    return failure;
  }

  function isManagedStorageNotConfigured(error){
    const message = String(error?.message || error || "")
      .trim()
      .replace(/[.!]+$/, "")
      .toLowerCase();
    return message === "managed storage manifest not found";
  }

  async function read(){
    const managedStorage = globalThis.browser?.storage?.managed;
    if (!managedStorage?.get){
      return emptyPolicy();
    }
    let values = {};
    try{
      values = await managedStorage.get(MANAGED_KEYS);
    }catch(error){
      // Firefox and Thunderbird reject storage.managed.get() when no native
      // manifest or 3rdparty enterprise policy exists (Bug 1868153). This is
      // the normal unmanaged state, not a failed policy read.
      if (isManagedStorageNotConfigured(error)){
        return emptyPolicy();
      }
      throw createManagedSetupReadError(error);
    }
    const policyValues = unwrapValues(values);
    const nextcloudUrl = normalizeNextcloudUrl(firstValue(policyValues, ["NextcloudUrl", "nextcloudUrl", "baseUrl"]));
    if (!nextcloudUrl){
      return emptyPolicy();
    }
    return {
      hasNextcloudUrl: true,
      nextcloudUrl,
      nextcloudUrlLocked: readBoolean(firstValue(policyValues, ["NextcloudUrlLocked", "nextcloudUrlLocked", "baseUrlLocked"])),
      source: "storage.managed"
    };
  }

  function resolveBaseUrl(localBaseUrl, policy){
    const local = String(localBaseUrl || "").trim();
    const managed = policy || emptyPolicy();
    if (managed.hasNextcloudUrl && (managed.nextcloudUrlLocked || !local)){
      return managed.nextcloudUrl;
    }
    return local;
  }

  return {
    emptyPolicy,
    normalizeNextcloudUrl,
    read,
    resolveBaseUrl
  };
})();
