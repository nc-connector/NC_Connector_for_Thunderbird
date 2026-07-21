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
  const ATTACHMENT_LINK_TARGETS = Object.freeze({
    ZIP_DOWNLOAD: "zip_download",
    SHARE_PAGE: "share_page"
  });
  const DEFAULT_ATTACHMENT_LINK_TARGET = ATTACHMENT_LINK_TARGETS.ZIP_DOWNLOAD;
  const SHARING_KEYS = {
    basePath: "sharingBasePath",
    defaultShareName: "sharingDefaultShareName",
    defaultPermCreate: "sharingDefaultPermCreate",
    defaultPermWrite: "sharingDefaultPermWrite",
    defaultPermDelete: "sharingDefaultPermDelete",
    defaultPassword: "sharingDefaultPassword",
    defaultPasswordSeparate: "sharingDefaultPasswordSeparate",
    defaultPasswordDeliveryMode: "sharingDefaultPasswordDeliveryMode",
    defaultExpireDays: "sharingDefaultExpireDays",
    attachmentsLinkTarget: "sharingAttachmentsLinkTarget",
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
    defaultPasswordDeliveryMode: "filelinkDefaultPasswordDeliveryMode",
    defaultExpireDays: "filelinkDefaultExpireDays"
  };
  const ALL_KEYS = Object.values(SHARING_KEYS).concat(Object.values(LEGACY_KEYS));

  function normalizeAttachmentThresholdMb(value){
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed < 1){
      return DEFAULT_ATTACHMENT_THRESHOLD_MB;
    }
    return parsed;
  }

  function isValidAttachmentLinkTarget(value){
    const normalized = String(value ?? "").trim();
    return normalized === ATTACHMENT_LINK_TARGETS.ZIP_DOWNLOAD
      || normalized === ATTACHMENT_LINK_TARGETS.SHARE_PAGE;
  }

  function normalizeAttachmentLinkTarget(value, fallback = DEFAULT_ATTACHMENT_LINK_TARGET){
    const normalized = String(value ?? "").trim();
    if (isValidAttachmentLinkTarget(normalized)){
      return normalized;
    }
    const normalizedFallback = String(fallback ?? "").trim();
    return isValidAttachmentLinkTarget(normalizedFallback)
      ? normalizedFallback
      : DEFAULT_ATTACHMENT_LINK_TARGET;
  }

  function isZipDownloadLinkTarget(value){
    return normalizeAttachmentLinkTarget(value) === ATTACHMENT_LINK_TARGETS.ZIP_DOWNLOAD;
  }

  function isStorageUnset(value){
    return value === undefined || value === null;
  }

  function hasStoredKey(value){
    return value !== undefined;
  }

  /**
   * Migrate legacy filelink keys to sharing keys and clean up leftovers
   * @returns {Promise<void>}
   */
  async function migrateLegacySharingKeys(){
    if (typeof browser === "undefined" || !browser?.storage?.local){
      return;
    }
    const stored = await browser.storage.local.get(ALL_KEYS);
    const migration = {};
    if (isStorageUnset(stored[SHARING_KEYS.basePath]) && stored[LEGACY_KEYS.basePath]){
      migration[SHARING_KEYS.basePath] = stored[LEGACY_KEYS.basePath];
    }
    if (isStorageUnset(stored[SHARING_KEYS.defaultShareName]) && stored[LEGACY_KEYS.defaultShareName]){
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
    if (!hasStoredKey(stored[SHARING_KEYS.defaultPassword])
        && hasStoredKey(stored[LEGACY_KEYS.defaultPassword])){
      migration[SHARING_KEYS.defaultPassword] = stored[LEGACY_KEYS.defaultPassword];
    }
    if (!hasStoredKey(stored[SHARING_KEYS.defaultPasswordSeparate])
        && hasStoredKey(stored[LEGACY_KEYS.defaultPasswordSeparate])){
      migration[SHARING_KEYS.defaultPasswordSeparate] = stored[LEGACY_KEYS.defaultPasswordSeparate];
    }
    if (!hasStoredKey(stored[SHARING_KEYS.defaultPasswordDeliveryMode])
        && hasStoredKey(stored[LEGACY_KEYS.defaultPasswordDeliveryMode])){
      migration[SHARING_KEYS.defaultPasswordDeliveryMode] = stored[LEGACY_KEYS.defaultPasswordDeliveryMode];
    }
    if (isStorageUnset(stored[SHARING_KEYS.defaultExpireDays])
        && hasStoredKey(stored[LEGACY_KEYS.defaultExpireDays])){
      migration[SHARING_KEYS.defaultExpireDays] = stored[LEGACY_KEYS.defaultExpireDays];
    }
    if (Object.keys(migration).length){
      await browser.storage.local.set(migration);
    }
    const legacyKeys = Object.values(LEGACY_KEYS);
    if (legacyKeys.some((key) => hasStoredKey(stored[key]))){
      await browser.storage.local.remove(legacyKeys);
    }
  }

  return {
    DEFAULT_ATTACHMENT_THRESHOLD_MB,
    ATTACHMENT_LINK_TARGETS,
    DEFAULT_ATTACHMENT_LINK_TARGET,
    SHARING_KEYS,
    normalizeAttachmentThresholdMb,
    isValidAttachmentLinkTarget,
    normalizeAttachmentLinkTarget,
    isZipDownloadLinkTarget,
    migrateLegacySharingKeys
  };
})();
