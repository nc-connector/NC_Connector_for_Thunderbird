/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';

/**
 * Storage helpers for sharing defaults and legacy key migration.
 */
const NCSharingStorage = (() => {
  const DEFAULT_ATTACHMENT_THRESHOLD_MB = 5;
  const SHARING_KEYS = {
    basePath: "sharingBasePath",
    defaultShareName: "sharingDefaultShareName",
    defaultPermCreate: "sharingDefaultPermCreate",
    defaultPermWrite: "sharingDefaultPermWrite",
    defaultPermDelete: "sharingDefaultPermDelete",
    defaultPassword: "sharingDefaultPassword",
    defaultPasswordSeparate: "sharingDefaultPasswordSeparate",
    defaultExpireDays: "sharingDefaultExpireDays",
    attachmentsAlwaysConnector: "sharingAttachmentsAlwaysConnector",
    attachmentsOfferAboveEnabled: "sharingAttachmentsOfferAboveEnabled",
    attachmentsOfferAboveMb: "sharingAttachmentsOfferAboveMb"
  };
  const LEGACY_KEYS = {
    basePath: "fileLinkBasePath",
    defaultShareName: "filelinkDefaultShareName",
    defaultPermCreate: "filelinkDefaultPermCreate",
    defaultPermWrite: "filelinkDefaultPermWrite",
    defaultPermDelete: "filelinkDefaultPermDelete",
    defaultPassword: "filelinkDefaultPassword",
    defaultPasswordSeparate: "filelinkDefaultPasswordSeparate",
    defaultExpireDays: "filelinkDefaultExpireDays"
  };
  const ALL_KEYS = Object.values(SHARING_KEYS).concat(Object.values(LEGACY_KEYS));

  /**
   * Normalize configured attachment threshold (MB) to a positive integer.
   * @param {any} value
   * @returns {number}
   */
  function normalizeAttachmentThresholdMb(value){
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed < 1){
      return DEFAULT_ATTACHMENT_THRESHOLD_MB;
    }
    return parsed;
  }

  /**
   * Migrate legacy filelink storage keys to sharing keys and clean up old entries.
   * @returns {Promise<void>}
   */
  async function migrateLegacySharingKeys(){
    if (typeof browser === "undefined" || !browser?.storage?.local){
      return;
    }
    const stored = await browser.storage.local.get(ALL_KEYS);
    const migration = {};
    if (stored[SHARING_KEYS.basePath] == null && stored[LEGACY_KEYS.basePath]){
      migration[SHARING_KEYS.basePath] = stored[LEGACY_KEYS.basePath];
    }
    if (stored[SHARING_KEYS.defaultShareName] == null && stored[LEGACY_KEYS.defaultShareName]){
      migration[SHARING_KEYS.defaultShareName] = stored[LEGACY_KEYS.defaultShareName];
    }
    if (typeof stored[SHARING_KEYS.defaultPermCreate] !== "boolean"
        && typeof stored[LEGACY_KEYS.defaultPermCreate] === "boolean"){
      migration[SHARING_KEYS.defaultPermCreate] = stored[LEGACY_KEYS.defaultPermCreate];
    }
    if (typeof stored[SHARING_KEYS.defaultPermWrite] !== "boolean"
        && typeof stored[LEGACY_KEYS.defaultPermWrite] === "boolean"){
      migration[SHARING_KEYS.defaultPermWrite] = stored[LEGACY_KEYS.defaultPermWrite];
    }
    if (typeof stored[SHARING_KEYS.defaultPermDelete] !== "boolean"
        && typeof stored[LEGACY_KEYS.defaultPermDelete] === "boolean"){
      migration[SHARING_KEYS.defaultPermDelete] = stored[LEGACY_KEYS.defaultPermDelete];
    }
    if (stored[SHARING_KEYS.defaultPassword] === undefined
        && stored[LEGACY_KEYS.defaultPassword] !== undefined){
      migration[SHARING_KEYS.defaultPassword] = stored[LEGACY_KEYS.defaultPassword];
    }
    if (stored[SHARING_KEYS.defaultPasswordSeparate] === undefined
        && stored[LEGACY_KEYS.defaultPasswordSeparate] !== undefined){
      migration[SHARING_KEYS.defaultPasswordSeparate] = stored[LEGACY_KEYS.defaultPasswordSeparate];
    }
    if (stored[SHARING_KEYS.defaultExpireDays] == null
        && stored[LEGACY_KEYS.defaultExpireDays] !== undefined){
      migration[SHARING_KEYS.defaultExpireDays] = stored[LEGACY_KEYS.defaultExpireDays];
    }
    if (Object.keys(migration).length){
      await browser.storage.local.set(migration);
    }
    const legacyKeys = Object.values(LEGACY_KEYS);
    if (legacyKeys.some((key) => stored[key] !== undefined)){
      await browser.storage.local.remove(legacyKeys);
    }
  }

  return {
    DEFAULT_ATTACHMENT_THRESHOLD_MB,
    SHARING_KEYS,
    normalizeAttachmentThresholdMb,
    migrateLegacySharingKeys
  };
})();
