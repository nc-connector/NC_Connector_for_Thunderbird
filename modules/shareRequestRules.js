/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const POLICY_KEYS = NCSharingStorage.SHARE_POLICY_KEYS;
  const READ_ONLY_PERMISSIONS = Object.freeze({
    read: true,
    create: false,
    write: false,
    delete: false
  });

  function requestError(code, messageKey){
    const error = new Error(code);
    error.ncUserMessage = bgI18n(messageKey);
    return error;
  }

  function resolveLocked(status, key, current, coerce){
    return NCPolicyState.resolveValue(
      status,
      "share",
      key,
      current,
      coerce
    );
  }

  function normalizePermissions(value){
    return {
      read: true,
      create: value?.create === true,
      write: value?.write === true,
      delete: value?.delete === true
    };
  }

  function buildLockedExpireDate(status){
    const days = NCTalkTextUtils.normalizeExpireDays(
      NCPolicyState.readPolicyValue(status, "share", POLICY_KEYS.expireDays),
      NCSharingStorage.DEFAULT_EXPIRE_DAYS
    );
    const expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + days);
    return expireDate.toISOString().slice(0, 10);
  }

  function isDateOnly(value){
    const text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)){
      return false;
    }
    const parsed = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime())
      && parsed.toISOString().slice(0, 10) === text;
  }

  /**
   * Apply the current locked share policy and the background-owned wizard mode.
   * @param {object} request
   * @param {{policyStatus?:object,attachmentMode?:boolean}} context
   * @returns {object}
   */
  function resolveUploadRequest(request, context = {}){
    const input = request && typeof request === "object" ? request : {};
    const policyStatus = context.policyStatus || null;
    const attachmentMode = context.attachmentMode === true;
    const permissions = normalizePermissions(input.permissions);
    const resolvedPermissions = attachmentMode
      ? READ_ONLY_PERMISSIONS
      : Object.freeze({
        read: true,
        create: resolveLocked(
          policyStatus,
          POLICY_KEYS.permCreate,
          permissions.create,
          NCPolicyState.coerceBoolean
        ),
        write: resolveLocked(
          policyStatus,
          POLICY_KEYS.permWrite,
          permissions.write,
          NCPolicyState.coerceBoolean
        ),
        delete: resolveLocked(
          policyStatus,
          POLICY_KEYS.permDelete,
          permissions.delete,
          NCPolicyState.coerceBoolean
        )
      });
    const passwordEnabled = resolveLocked(
      policyStatus,
      POLICY_KEYS.passwordEnabled,
      input.passwordEnabled === true,
      NCPolicyState.coerceBoolean
    );
    const password = passwordEnabled ? String(input.password || "") : "";
    if (passwordEnabled && !password){
      throw requestError("file_link_password_missing", "sharing_password_policy_error");
    }
    const expireLocked = NCPolicyState.isLocked(
      policyStatus,
      "share",
      POLICY_KEYS.expireDays
    );
    const expireEnabled = expireLocked || input.expireEnabled === true;
    const expireDate = expireLocked
      ? buildLockedExpireDate(policyStatus)
      : (expireEnabled ? String(input.expireDate || "").trim() : "");
    if (expireEnabled && !isDateOnly(expireDate)){
      throw requestError("file_link_expire_date_invalid", "sharing_status_error");
    }
    const noteEnabled = !attachmentMode && input.noteEnabled === true;
    const {
      policyShare: _ignoredPolicyShare,
      policyEditableShare: _ignoredEditableShare,
      ...requestFields
    } = input;
    return Object.freeze({
      ...requestFields,
      attachmentMode,
      basePath: resolveLocked(
        policyStatus,
        POLICY_KEYS.basePath,
        String(input.basePath || NCSharingStorage.DEFAULT_BASE_PATH).trim(),
        NCPolicyState.coerceString
      ),
      shareName: resolveLocked(
        policyStatus,
        POLICY_KEYS.shareName,
        String(input.shareName || "").trim(),
        NCPolicyState.coerceString
      ),
      permissions: resolvedPermissions,
      passwordEnabled,
      password,
      expireEnabled,
      expireDate,
      noteEnabled,
      note: noteEnabled ? String(input.note || "").trim() : ""
    });
  }

  global.NCShareRequestRules = Object.freeze({
    READ_ONLY_PERMISSIONS,
    resolveUploadRequest
  });
})(typeof window !== "undefined" ? window : globalThis);
