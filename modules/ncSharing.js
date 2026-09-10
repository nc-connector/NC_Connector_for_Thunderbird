/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(__context){
  'use strict';
  const DEFAULT_BASE_PATH = NCSharingStorage.DEFAULT_BASE_PATH;
  const PERMISSION_FLAGS = {
    read: 1,
    write: 2,
    create: 4,
    delete: 8
  };
  const INVALID_PATH_CHARS = /[\\/:*?"<>|]/g;

  function getSharingRuntimePrefix(){
    return typeof L === "function" ? "[NCBG]" : "[NCUI][Sharing]";
  }

  function logDebug(opts, ...args){
    if (typeof L === "function"){
      try{
        L(...args);
        return;
      }catch(error){
        console.error("[NCBG] debug log failed", error);
      }
    }
    const mirroredDebugEnabled =
      typeof globalThis.NCDebugForwarder?.getMirroredDebugEnabled === "function"
        ? globalThis.NCDebugForwarder.getMirroredDebugEnabled()
        : null;
    const debugEnabled = typeof mirroredDebugEnabled === "boolean"
      ? mirroredDebugEnabled
      : !!opts?.debugEnabled;
    if (!debugEnabled){
      return;
    }
    if (globalThis.NCDebugForwarder?.forwardDebugLog){
      try{
        globalThis.NCDebugForwarder.forwardDebugLog({
          enabled: debugEnabled,
          isPageUnloading: false,
          source: "ncSharing",
          channel: "NCUI",
          label: "Sharing",
          text: args[0],
          details: args.slice(1)
        });
        return;
      }catch(error){
        logInternalError("ui debug log forward failed", error);
      }
    }
    try{
      console.log(getSharingRuntimePrefix(), ...args);
    }catch(error){
      logInternalError("debug log failed", error);
    }
  }

  function logInternalError(scope, reportedError){
    globalThis.NCLogContext.safeConsoleError(getSharingRuntimePrefix(), scope, reportedError);
  }

  const sharedTranslator = (typeof NCI18n !== "undefined" && typeof NCI18n.translate === "function")
    ? NCI18n.translate
    : null;
  function i18n(key, substitutions = []){
    if (sharedTranslator){
      try{
        const translated = sharedTranslator(key, substitutions);
        if (translated){
          return translated;
        }
      }catch(error){
        logInternalError("shared i18n translation failed", error);
      }
    }
    try{
      if (typeof browser !== "undefined" && browser?.i18n?.getMessage){
        const fallback = browser.i18n.getMessage(key, substitutions);
        if (fallback){
          return fallback;
        }
      }
    }catch(error){
      logInternalError("browser.i18n.getMessage failed", error);
    }
    if (Array.isArray(substitutions) && substitutions.length){
      return String(substitutions[0] ?? "");
    }
    return key || "";
  }

  function hostPermissionError(){
    return new Error(i18n("error_host_permission_missing"));
  }

  /**
   * Ensure the optional host permission for the configured base URL is present.
   * @param {string} baseUrl
   * @returns {Promise<boolean>}
   */
  async function ensureHostPermission(baseUrl){
    if (typeof NCHostPermissions === "undefined" || !NCHostPermissions?.requireOriginPermission){
      return true;
    }
    return NCHostPermissions.requireOriginPermission(baseUrl, {
      errorFactory: hostPermissionError,
      scope: "host permission missing",
      logMissing: false
    });
  }

  function sanitizeShareName(value){
    const fallback = i18n("sharing_share_default") || "Share";
    if (!value) return fallback;
    const normalized = String(value)
      .normalize("NFKC")
      .replace(INVALID_PATH_CHARS, "_")
      .replace(/[\u0000-\u001f\u007f]/g, "_")
      .trim();
    if (normalized === "." || normalized === ".."){
      return normalized.replace(/\./g, "_");
    }
    return normalized || fallback;
  }

  function sanitizeFileName(value, fallback = "File"){
    if (!value && value !== 0) return fallback;
    const normalized = String(value)
      .normalize("NFKC")
      .replace(INVALID_PATH_CHARS, "_")
      .replace(/[\u0000-\u001f\u007f]/g, "_")
      .trim();
    if (normalized === "." || normalized === ".."){
      return normalized.replace(/\./g, "_");
    }
    return normalized || fallback;
  }

  function formatDateForFolder(date){
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  function normalizeRelativePath(path){
    if (!path) return "";
    return String(path).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  }

  function joinRelativePath(base, child){
    const normalizedBase = normalizeRelativePath(base);
    const normalizedChild = normalizeRelativePath(child);
    if (!normalizedBase) return normalizedChild;
    if (!normalizedChild) return normalizedBase;
    return normalizedBase + "/" + normalizedChild;
  }

  /**
   * Build folder info for one share (base folder, date, share name)
   * @param {string} basePath
   * @param {string} shareName
   * @param {Date} referenceDate
   * @returns {{date:Date,folderName:string,relativeBase:string,relativeFolder:string}}
   */
  function buildShareFolderInfo(basePath, shareName, referenceDate){
    const dateObj = referenceDate instanceof Date ? referenceDate : new Date();
    const folderName = `${formatDateForFolder(dateObj)}_${sanitizeShareName(shareName)}`;
    const relativeBase = sanitizeRelativeDir(basePath || DEFAULT_BASE_PATH)
      || sanitizeRelativeDir(DEFAULT_BASE_PATH);
    const relativeFolder = joinRelativePath(relativeBase, folderName);
    return {
      date: dateObj,
      folderName,
      relativeBase,
      relativeFolder
    };
  }

  function sanitizeRelativeDir(dir){
    if (!dir) return "";
    return String(dir)
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((segment) => sanitizeFileName(segment, "Folder"))
      .join("/");
  }

  function buildPermissionMask(perms){
    let mask = 0;
    if (perms?.read) mask |= PERMISSION_FLAGS.read;
    if (perms?.write) mask |= PERMISSION_FLAGS.write;
    if (perms?.create) mask |= PERMISSION_FLAGS.create;
    if (perms?.delete) mask |= PERMISSION_FLAGS.delete;
    if (!mask){
      mask = PERMISSION_FLAGS.read;
    }
    return mask;
  }

  /**
   * Update mutable share metadata through the documented OCS update endpoint.
   * @param {object} options
   * @returns {Promise<void>}
   */
  async function updateShareMetadata({ baseUrl, shareId, authHeader, note, permissions, expireDate, password }){
    if (!shareId){
      return;
    }
    const url = baseUrl.replace(/\/+$/, "") + `/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}`;
    const payload = new URLSearchParams();
    // Nextcloud treats legacy publicUpload as an override, so preserve the exact permission mask.
    payload.append("permissions", String(buildPermissionMask(permissions || {})));
    payload.append("note", typeof note === "string" ? note : "");
    payload.append("attributes", "[]");
    if (expireDate){
      payload.append("expireDate", expireDate);
    }
    if (password){
      payload.append("password", password);
    }
    const response = await NCOcs.ocsRequest({
      url,
      method: "PUT",
      headers: {
        "Authorization": authHeader,
        "OCS-APIREQUEST": "true",
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: payload
    });
    if (!NCOcs.isExplicitSuccess(response)){
      throw new Error(
        NCOcs.getFailureMessage(response, `HTTP ${response.status || 0}`)
      );
    }
  }

  const {
    buildHtmlBlock,
    buildPlainTextBlock
  } = NCShareBlockRenderer.create({ i18n, logInternalError });

  /**
   * Resolve the authenticated DAV target shared by wizard preflight and upload.
   * @param {object} opts
   * @param {object} request
   * @param {{requireCapabilities?:boolean}} options
   * @returns {Promise<object>}
   */
  async function resolveFileLinkDavContext(opts, request, { requireCapabilities = false } = {}){
    if (!opts.baseUrl || !opts.user || !opts.appPass){
      throw new Error(i18n("error_credentials_missing"));
    }
    NCNextcloudDav.throwIfAborted(request?.signal);
    await ensureHostPermission(opts.baseUrl);
    NCNextcloudDav.throwIfAborted(request?.signal);
    const requestOptions = {
      ...opts,
      signal: request?.signal || null
    };
    const capabilities = requireCapabilities
      ? await NCCore.getRequiredCapabilities(requestOptions)
      : null;
    const userId = await NCCore.getCurrentUserId(requestOptions);
    const rawBasePath = request?.basePath && request.basePath.trim()
      ? request.basePath.trim()
      : (await getFileLinkBasePath());
    const basePathSetting = sanitizeRelativeDir(rawBasePath)
      || sanitizeRelativeDir(DEFAULT_BASE_PATH);
    const shareDate = request?.shareDate ? new Date(request.shareDate) : new Date();
    const account = NCCore.buildDavAccountContext({ ...opts, userId });
    return {
      capabilities,
      basePathSetting,
      shareDate,
      authHeader: account.authHeader,
      davRoot: account.davRoot,
      uploadRoot: account.uploadRoot,
      bulkUrl: account.bulkUrl
    };
  }

  /**
   * Check whether the exact manual FileLink target already exists.
   * Upload still reserves the target atomically to protect against races.
   * @param {object} request
   * @returns {Promise<boolean>}
   */
  async function checkFileLinkFolderExists(request){
    const opts = await NCCore.getOpts();
    const context = await resolveFileLinkDavContext(opts, request);
    const folderInfo = buildShareFolderInfo(
      context.basePathSetting,
      request?.shareName,
      context.shareDate
    );
    logDebug(opts, "folders:preflight", {
      relativeFolder: folderInfo.relativeFolder
    });
    const probe = await NCNextcloudDav.probePath({
      url: NCNextcloudDav.buildFileUrl(context.davRoot, folderInfo.relativeFolder),
      authHeader: context.authHeader,
      signal: request?.signal || null,
      log: (...args) => logDebug(opts, ...args)
    });
    return probe.exists;
  }

  function prepareFileLinkRequest(request){
    if (!request || typeof request !== "object"){
      throw new Error("file_link_request_missing");
    }
    const shareName = sanitizeShareName(request.shareName);
    if (!shareName){
      const error = new Error("file_link_share_name_missing");
      error.ncUserMessage = i18n("sharing_message_invalid_share_name");
      throw error;
    }
    const sourcePlan = NCFileLinkSources.normalizeItems(request.files, {
      sanitizeFileName,
      sanitizeRelativeDir
    });
    return Object.freeze({
      request: Object.freeze({ ...request, shareName }),
      sourcePlan
    });
  }

  /**
   * Create a Nextcloud share from one validated upload request.
   * @param {{request:object,sourcePlan:object}} prepared
   * @returns {Promise<{shareUrl:string, shareInfo:object}>}
   */
  async function createFileLink(prepared){
    if (!prepared?.request || !prepared?.sourcePlan){
      throw new Error("file_link_request_not_prepared");
    }
    const request = prepared.request;
    const sourcePlan = prepared.sourcePlan;
    if (sourcePlan.externalFiles.length || sourcePlan.externalDirectories.length){
      await NCVfsClientRuntime.assertExternalAccess({ refresh: true });
    }
    const opts = await NCCore.getOpts();
    logDebug(opts, "createFileLink:start", {
      shareName: request?.shareName || "",
      files: Array.isArray(request?.files) ? request.files.length : 0
    });
    const davContext = await resolveFileLinkDavContext(
      opts,
      request,
      { requireCapabilities: true }
    );
    const {
      capabilities,
      basePathSetting,
      shareDate,
      authHeader,
      davRoot,
      uploadRoot,
      bulkUrl
    } = davContext;
    const noteEnabled = !!request?.noteEnabled;
    const noteValue = noteEnabled ? String(request?.note || "").trim() : "";
    const statusCallback = typeof request?.onUploadStatus === "function" ? request.onUploadStatus : null;
    const baseShareName = request.shareName;
    const candidateLimit = request?.attachmentMode ? 1000 : 1;
    const rootCandidates = Array.from({ length: candidateLimit }, (_, suffix) => {
      const shareName = suffix === 0 ? baseShareName : `${baseShareName}_${suffix}`;
      return {
        shareName,
        folderInfo: buildShareFolderInfo(basePathSetting, shareName, shareDate)
      };
    });
    let preparedRoot = null;
    const buildTrackedRoot = (root) => {
      const cleanupResolution = root?.cleanupResolution || null;
      return Object.freeze({
        ...root,
        cleanupTarget: Object.freeze({
          url: NCNextcloudDav.buildFileUrl(davRoot, root.folderInfo.relativeFolder),
          authHeader,
          baseUrl: opts.baseUrl,
          relativeFolder: root.folderInfo.relativeFolder,
          reservationUrl: String(cleanupResolution?.reservationUrl || ""),
          targetUrl: String(cleanupResolution?.targetUrl || "")
        })
      });
    };
    try{
      const transfer = await NCFileLinkUpload.prepareAndUpload({
        files: sourcePlan.localFiles,
        bulkSupported: capabilities.bulkUploadSupported,
        fixedRequestCount: normalizeRelativePath(basePathSetting).split("/").filter(Boolean).length + 2,
        davRoot,
        uploadRoot,
        bulkUrl,
        basePath: basePathSetting,
        rootCandidates,
        authHeader,
        signal: request?.signal || null,
        log: (...args) => logDebug(opts, ...args),
        onStatus: statusCallback,
        additionalDirectories: sourcePlan.additionalDirectories,
        additionalUploadFiles: sourcePlan.deferredUploadFiles,
        serverCopyCount: sourcePlan.nextcloudCopies.length,
        transferAdditionalSources: (context) => NCFileLinkSources.transferAdditionalSources({
          ...context,
          plan: sourcePlan
        }),
        collisionMessage: i18n("sharing_error_folder_exists"),
        onRootCreated: async (root) => {
          preparedRoot = buildTrackedRoot(root);
          if (typeof request?.onRootCreated === "function"){
            await request.onRootCreated(preparedRoot);
          }
        }
      });
      preparedRoot = preparedRoot || buildTrackedRoot(transfer.root);
      const relativeFolder = preparedRoot.folderInfo.relativeFolder;
      const normalizedShareName = preparedRoot.shareName;
      const share = await NCFileLinkShare.create({
        baseUrl: opts.baseUrl,
        relativeFolder,
        authHeader,
        permissionMask: buildPermissionMask(request.permissions),
        password: request.passwordEnabled ? (request.password || "") : "",
        expireDate: request.expireEnabled ? (request.expireDate || "") : "",
        label: normalizedShareName,
        note: noteValue,
        signal: request?.signal || null
      });
      logDebug(opts, "share:created", { shareId: share.id || "" });

      const resultPayload = {
        shareUrl: share.url,
        shareToken: share.token || "",
        password: request.passwordEnabled ? (request.password || "") : "",
        expireDate: request.expireEnabled ? (request.expireDate || "") : "",
        permissions: request.permissions,
        folderInfo: preparedRoot.folderInfo,
        note: noteValue,
        noteEnabled,
        shareId: share.id || "",
        label: normalizedShareName
      };
      logDebug(opts, "createFileLink:done", {
        shareId: share.id || "",
        files: sourcePlan.items.length
      });
      return {
        shareUrl: share.url,
        shareInfo: resultPayload
      };
    }catch(error){
      if (preparedRoot?.folderInfo?.relativeFolder){
        let cleaned = false;
        try{
          await NCNextcloudDav.deleteTrackedRoot({
            url: preparedRoot.cleanupTarget?.url
              || NCNextcloudDav.buildFileUrl(davRoot, preparedRoot.folderInfo.relativeFolder),
            reservationUrl: preparedRoot.cleanupTarget?.reservationUrl || "",
            targetUrl: preparedRoot.cleanupTarget?.targetUrl || "",
            authHeader,
            log: (...args) => logDebug(opts, ...args)
          });
          cleaned = true;
        }catch(cleanupError){
          logInternalError("Share root cleanup failed", cleanupError);
        }
        if (cleaned){
          await NCFileLinkShare.clearIndeterminate({
            baseUrl: opts.baseUrl,
            relativeFolder: preparedRoot.folderInfo.relativeFolder,
            authHeader
          });
        }
        if (typeof request?.onRootCleanup === "function"){
          await request.onRootCleanup({ root: preparedRoot, cleaned });
        }
      }
      throw error;
    }
  }

  async function getFileLinkBasePath(){
    if (typeof browser === "undefined" || !browser?.storage?.local){
      return DEFAULT_BASE_PATH;
    }
    const stored = await browser.storage.local.get(["sharingBasePath"]);
    return stored.sharingBasePath || DEFAULT_BASE_PATH;
  }

  /**
   * Update one existing share note with the account captured by its upload.
   * @param {object} options
   */
  async function updateShareNote({
    baseUrl,
    authHeader,
    shareId,
    permissions,
    expireDate,
    password,
    noteEnabled,
    note
  } = {}){
    const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
    const normalizedAuthHeader = String(authHeader || "").trim();
    const normalizedShareId = String(shareId || "").trim();
    if (!normalizedShareId){
      throw new Error(i18n("sharing_error_upload_required"));
    }
    if (!normalizedBaseUrl || !normalizedAuthHeader){
      throw new Error(i18n("error_credentials_missing"));
    }
    await ensureHostPermission(normalizedBaseUrl);
    logDebug(null, "share:updateNote", {
      shareId: normalizedShareId,
      noteEnabled: !!noteEnabled
    });
    await updateShareMetadata({
      baseUrl: normalizedBaseUrl,
      shareId: normalizedShareId,
      authHeader: normalizedAuthHeader,
      note: noteEnabled ? (note || "") : "",
      permissions,
      expireDate: expireDate || "",
      password: password || ""
    });
    logDebug(null, "share:updateNote:done", { shareId: normalizedShareId });
  }

  const api = {
    DEFAULT_BASE_PATH,
    prepareFileLinkRequest,
    createFileLink,
    checkFileLinkFolderExists,
    buildHtmlBlock,
    buildPlainTextBlock,
    getFileLinkBasePath,
    buildShareFolderInfo,
    sanitizeShareName,
    sanitizeFileName,
    sanitizeRelativeDir,
    updateShareNote
  };

  if (__context){
    __context.NCSharing = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
