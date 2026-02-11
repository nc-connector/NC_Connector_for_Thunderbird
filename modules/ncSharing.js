/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
(function(__context){
  const DEFAULT_BASE_PATH = "90 Freigaben - extern";
  const NEXTCLOUD_DEVICE_NAME = "NC Connector for Thunderbird";
  const PERMISSION_FLAGS = {
    read: 1,
    write: 2,
    create: 4,
    delete: 8
  };
  const INVALID_PATH_CHARS = /[\\/:*?"<>|]/g;
  let cachedHeaderBase64 = null;

  /**
   * Debug logger scoped to the sharing module.
   * @param {object} opts
   * @param {...any} args
   */
  function logDebug(opts, ...args){
    if (!opts?.debugEnabled){
      return;
    }
    try{
      console.log("[NCSHARE]", ...args);
    }catch(_){}
  }

  const sharedTranslator = (typeof NCI18n !== "undefined" && typeof NCI18n.translate === "function")
    ? NCI18n.translate
    : null;
  const escapeHtml = NCTalkTextUtils.escapeHtml;

  /**
   * Translate a key with fallback to browser.i18n.
   * @param {string} key
   * @param {string[]|string} substitutions
   * @returns {string}
   */
  function i18n(key, substitutions = []){
    if (sharedTranslator){
      try{
        const translated = sharedTranslator(key, substitutions);
        if (translated){
          return translated;
        }
      }catch(_){}
    }
    try{
      if (typeof browser !== "undefined" && browser?.i18n?.getMessage){
        const fallback = browser.i18n.getMessage(key, substitutions);
        if (fallback){
          return fallback;
        }
      }
    }catch(_){}
    if (Array.isArray(substitutions) && substitutions.length){
      return String(substitutions[0] ?? "");
    }
    return key || "";
  }

  /**
   * Create a host-permission error with a localized message.
   * @returns {Error}
   */
  function hostPermissionError(){
    return new Error(i18n("error_host_permission_missing"));
  }

  /**
   * Ensure the optional host permission for the configured base URL is present.
   * @param {string} baseUrl
   * @returns {Promise<boolean>}
   */
  async function ensureHostPermission(baseUrl){
    if (typeof NCHostPermissions === "undefined" || !NCHostPermissions?.hasOriginPermission){
      return true;
    }
    const ok = await NCHostPermissions.hasOriginPermission(baseUrl);
    if (!ok){
      throw hostPermissionError();
    }
    return true;
  }

  /**
   * Read the configured language override for the sharing HTML block.
   * @returns {Promise<string>}
   */
  async function getShareBlockLang(){
    if (typeof browser === "undefined" || !browser?.storage?.local){
      return "default";
    }
    const stored = await browser.storage.local.get(["shareBlockLang"]);
    return stored.shareBlockLang || "default";
  }

  /**
   * Translate a key in the desired language (override-aware).
   * @param {string} lang
   * @param {string} key
   * @param {string[]|string} substitutions
   * @returns {Promise<string>}
   */
  async function tShare(lang, key, substitutions = []){
    if (typeof NCI18nOverride !== "undefined" && typeof NCI18nOverride.tInLang === "function"){
      const translated = await NCI18nOverride.tInLang(lang, key, substitutions);
      if (translated){
        return translated;
      }
    }
    return i18n(key, substitutions);
  }

  /**
   * Sanitize and normalize a share name for use in folder names.
   * @param {string} value
   * @returns {string}
   */
  function sanitizeShareName(value){
    const fallback = i18n("sharing_share_default") || "Freigabe";
    if (!value) return fallback;
    const normalized = String(value).normalize("NFKC").replace(INVALID_PATH_CHARS, "_").trim();
    return normalized || fallback;
  }

  /**
   * Sanitize file names to avoid invalid path characters.
   * @param {string} value
   * @param {string} fallback
   * @returns {string}
   */
  function sanitizeFileName(value, fallback = "Datei"){
    if (!value && value !== 0) return fallback;
    const normalized = String(value).normalize("NFKC").replace(INVALID_PATH_CHARS, "_").trim();
    return normalized || fallback;
  }

  /**
   * Format a Date as YYYYMMDD for folder naming.
   * @param {Date} date
   * @returns {string}
   */
  function formatDateForFolder(date){
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  /**
   * Normalize a relative path to forward-slash form.
   * @param {string} path
   * @returns {string}
   */
  function normalizeRelativePath(path){
    if (!path) return "";
    return String(path).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  }

  /**
   * Join two relative path segments.
   * @param {string} base
   * @param {string} child
   * @returns {string}
   */
  function joinRelativePath(base, child){
    const normalizedBase = normalizeRelativePath(base);
    const normalizedChild = normalizeRelativePath(child);
    if (!normalizedBase) return normalizedChild;
    if (!normalizedChild) return normalizedBase;
    return normalizedBase + "/" + normalizedChild;
  }

  /**
   * Build the folder info for a share (base folder + date + share name).
   * @param {string} basePath
   * @param {string} shareName
   * @param {Date} referenceDate
   * @returns {{date:Date,folderName:string,relativeBase:string,relativeFolder:string}}
   */
  function buildShareFolderInfo(basePath, shareName, referenceDate){
    const dateObj = referenceDate instanceof Date ? referenceDate : new Date();
    const folderName = `${formatDateForFolder(dateObj)}_${sanitizeShareName(shareName)}`;
    const relativeBase = normalizeRelativePath(basePath || DEFAULT_BASE_PATH);
    const relativeFolder = joinRelativePath(relativeBase, folderName);
    return {
      date: dateObj,
      folderName,
      relativeBase,
      relativeFolder
    };
  }

  /**
   * Normalize and sanitize a relative directory for upload.
   * @param {string} dir
   * @returns {string}
   */
  function sanitizeRelativeDir(dir){
    if (!dir) return "";
    return String(dir)
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((segment) => sanitizeFileName(segment, "Ordner"))
      .join("/");
  }

  /**
   * Check if a DAV path exists.
   * @param {{davRoot:string,relativePath:string,authHeader:string}} options
   * @returns {Promise<boolean>}
   */
  async function pathExists({ davRoot, relativePath, authHeader }){
    const cleanPath = normalizeRelativePath(relativePath || "");
    if (!cleanPath){
      return false;
    }
    const url = davRoot + "/" + encodePath(cleanPath);
    const res = await fetch(url, {
      method: "PROPFIND",
      headers: {
        "Authorization": authHeader,
        "Depth": "0"
      }
    });
    if (res.status === 404){
      return false;
    }
    if (res.status === 207 || res.status === 200){
      return true;
    }
    if (!res.ok){
      const text = await res.text().catch(() => "");
      throw new Error(text || `Path check failed (${res.status})`);
    }
    return true;
  }

  /**
   * Ensure each segment of a relative path exists in WebDAV.
   * @param {string} davRoot
   * @param {string} relativePath
   * @param {string} authHeader
   * @returns {Promise<void>}
   */
  async function ensureFolderExists(davRoot, relativePath, authHeader){
    const segments = normalizeRelativePath(relativePath).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments){
      current = current ? current + "/" + segment : segment;
      const url = davRoot + "/" + encodePath(current);
      const res = await fetch(url, {
        method: "MKCOL",
        headers: {
          "Authorization": authHeader
        }
      });
      if (res.status === 201 || res.status === 405){
        continue;
      }
      if (!res.ok){
        const text = await res.text().catch(() => "");
        throw new Error(text || `MKCOL failed (${res.status})`);
      }
    }
  }

  /**
   * Delete a remote DAV path (file or folder).
   * @param {string} davRoot
   * @param {string} relativePath
   * @param {string} authHeader
   * @returns {Promise<boolean>}
   */
  async function deleteRemotePath(davRoot, relativePath, authHeader){
    const clean = normalizeRelativePath(relativePath);
    if (!clean){
      return false;
    }
    const url = davRoot + "/" + encodePath(clean);
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        "Authorization": authHeader
      }
    });
    if (res.status === 404){
      return false;
    }
    if (!res.ok){
      const text = await res.text().catch(() => "");
      throw new Error(text || `DELETE failed (${res.status})`);
    }
    return true;
  }

  /**
   * Encode each path segment for DAV requests.
   * @param {string} path
   * @returns {string}
   */
  function encodePath(path){
    return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  }

  /**
   * Upload a file with progress callbacks.
   * @param {object} options
   * @returns {Promise<void>}
   */
  async function uploadFile({ davRoot, relativeFolder, fileName, file, authHeader, progressCb, statusCb, displayPath, itemId }){
    const relativePath = joinRelativePath(relativeFolder, fileName);
    const url = davRoot + "/" + encodePath(relativePath);
    if (typeof statusCb === "function"){
      statusCb({ phase: "start", fileName, displayPath, itemId });
    }
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);
      xhr.setRequestHeader("Authorization", authHeader);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable){
          const percent = Math.round((event.loaded / event.total) * 100);
          if (typeof statusCb === "function"){
            statusCb({
              phase: "progress",
              fileName,
              displayPath,
              itemId,
              loaded: event.loaded,
              total: event.total,
              percent
            });
          }
        }
      };
      xhr.onerror = () => {
        if (typeof statusCb === "function"){
          statusCb({ phase: "error", fileName, displayPath, itemId, error: "Network error" });
        }
        reject(new Error("Upload failed (network error)"));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300){
          if (typeof progressCb === "function"){
            progressCb(file.name);
          }
          if (typeof statusCb === "function"){
            statusCb({ phase: "done", fileName, displayPath, itemId });
          }
          resolve();
        }else{
          if (typeof statusCb === "function"){
            statusCb({ phase: "error", fileName, displayPath, itemId, error: `Upload failed (${xhr.status})` });
          }
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      };
      xhr.send(file);
    });
  }

  /**
   * Convert permission flags into a Nextcloud permission mask.
   * @param {{read?:boolean,write?:boolean,create?:boolean,delete?:boolean}} perms
   * @returns {number}
   */
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
   * Create a Nextcloud share via OCS.
   * @param {string} baseUrl
   * @param {string} relativeFolder
   * @param {string} authHeader
   * @param {object} perms
   * @param {string} password
   * @param {string} expireDate
   * @param {boolean} publicUpload
   * @returns {Promise<{url:string,token:string,id:string}>}
   */
  async function requestShare(baseUrl, relativeFolder, authHeader, perms, password, expireDate, publicUpload){
    const url = baseUrl.replace(/\/+$/, "") + "/ocs/v2.php/apps/files_sharing/api/v1/shares";
    const params = new URLSearchParams();
    params.append("path", "/" + normalizeRelativePath(relativeFolder));
    params.append("shareType", "3");
    params.append("permissions", String(buildPermissionMask(perms)));
    if (password){
      params.append("password", password);
    }
    if (expireDate){
      params.append("expireDate", expireDate);
    }
    if (publicUpload){
      params.append("publicUpload", "true");
    }
    const response = await NCOcs.ocsRequest({
      url,
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "OCS-APIREQUEST": "true",
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });
    const raw = response.raw || "";
    const data = response.data;
    if (!response.ok){
      const detail = data?.ocs?.meta?.message || raw || `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return {
      url: data?.ocs?.data?.url || "",
      token: data?.ocs?.data?.token || "",
      id: data?.ocs?.data?.id || ""
    };
  }

  /**
   * Update share metadata (label, note, permissions, expiry, password).
   * @param {object} options
   * @returns {Promise<void>}
   */
  async function updateShareMetadata({ baseUrl, shareId, authHeader, note, permissions, expireDate, password, label }){
    if (!shareId){
      return;
    }
    const url = baseUrl.replace(/\/+$/, "") + `/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}`;
    const payload = {
      permissions: String(buildPermissionMask(permissions || {})),
      attributes: "[]",
      note: typeof note === "string" ? note : "",
      expireDate: expireDate || "",
      label: label || "",
      password: password || "",
      hideDownload: "false"
    };
    const response = await NCOcs.ocsRequest({
      url,
      method: "PUT",
      headers: {
        "Authorization": authHeader,
        "OCS-APIREQUEST": "true",
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const raw = response.raw || "";
    const data = response.data;
    if (!response.ok){
      const detail = data?.ocs?.meta?.message || raw || `HTTP ${response.status}`;
      throw new Error(detail);
    }
  }

  /**
   * Convert an ArrayBuffer to a base64 string.
   * @param {ArrayBuffer} buffer
   * @returns {string}
   */
  function bufferToBase64(buffer){
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++){
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Load a packaged asset and return a base64 payload.
   * Falls back to XHR if fetch is blocked.
   * @param {string} assetPath
   * @returns {Promise<string>}
   */
  async function loadAssetBase64(assetPath){
    if (typeof browser === "undefined" || !browser?.runtime?.getURL){
      return "";
    }
    const url = browser.runtime.getURL(assetPath);
    try{
      const response = await fetch(url);
      if (!response.ok){
        throw new Error(`Asset fetch failed (${response.status})`);
      }
      return bufferToBase64(await response.arrayBuffer());
    }catch(err){
      try{
        const buffer = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url, true);
          xhr.responseType = "arraybuffer";
          xhr.onload = () => {
            if (xhr.status === 200 || xhr.status === 0){
              resolve(xhr.response);
            }else{
              reject(new Error(`Asset XHR failed (${xhr.status})`));
            }
          };
          xhr.onerror = () => reject(new Error("Asset XHR failed"));
          xhr.send();
        });
        return bufferToBase64(buffer);
      }catch(err2){
        console.warn("[NCSHARE] asset base64 failed", assetPath, err2?.message || err2);
        return "";
      }
    }
  }

  /**
   * Load and cache the header image as base64 for HTML insertion.
   * @returns {Promise<string>}
   */
  async function getHeaderBase64(){
    if (cachedHeaderBase64){
      return cachedHeaderBase64;
    }
    cachedHeaderBase64 = await loadAssetBase64("ui/assets/header-solid-blue-164x48.png");
    return cachedHeaderBase64;
  }

  /**
   * Check if the share folder already exists in WebDAV.
   * @param {{shareName:string,basePath:string,shareDate?:Date}} options
   * @returns {Promise<{exists:boolean,folderInfo:object}>}
   */
  async function checkShareFolderAvailability({ shareName, basePath, shareDate } = {}){
    const opts = await NCCore.getOpts();
    if (!opts.baseUrl || !opts.user || !opts.appPass){
      throw new Error(i18n("error_credentials_missing"));
    }
    await ensureHostPermission(opts.baseUrl);
    const info = buildShareFolderInfo(basePath || await getFileLinkBasePath(), shareName, shareDate ? new Date(shareDate) : new Date());
    const authHeader = NCOcs.buildAuthHeader(opts.user, opts.appPass);
    const davRoot = `${opts.baseUrl.replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(opts.user)}`;
    logDebug(opts, "availability:check", {
      shareName,
      basePath: basePath || "",
      relativeFolder: info.relativeFolder
    });
    const exists = await pathExists({
      davRoot,
      relativePath: info.relativeFolder,
      authHeader
    });
    logDebug(opts, "availability:result", {
      relativeFolder: info.relativeFolder,
      exists
    });
    return {
      exists,
      folderInfo: info
    };
  }

  /**
   * Check if a remote file/folder exists under the current user's DAV root.
   * @param {string|{relativePath:string}} input
   * @returns {Promise<boolean>}
   */
  async function checkRemotePathExists(input){
    const opts = await NCCore.getOpts();
    if (!opts.baseUrl || !opts.user || !opts.appPass){
      throw new Error(i18n("error_credentials_missing"));
    }
    await ensureHostPermission(opts.baseUrl);
    const relativePath = typeof input === "string" ? input : input?.relativePath || "";
    const authHeader = NCOcs.buildAuthHeader(opts.user, opts.appPass);
    const davRoot = `${opts.baseUrl.replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(opts.user)}`;
    logDebug(opts, "remotePath:check", { relativePath });
    const exists = await pathExists({ davRoot, relativePath, authHeader });
    logDebug(opts, "remotePath:result", { relativePath, exists });
    return exists;
  }

  /**
   * Build the HTML block inserted into the compose body.
   * @param {object} result
   * @param {object} request
   * @returns {Promise<string>}
   */
  async function buildHtmlBlock(result, request){
    const shareLang = await getShareBlockLang();
    const headerImage = await getHeaderBase64();
    const paragraphs = [];
    if (request?.noteEnabled && request?.note){
      paragraphs.push(`<p style="margin:0 0 14px 0;line-height:1.4;">${escapeHtml(request.note)}</p>`);
    }
    const introLine = await tShare(shareLang, "sharing_html_intro_line");
    if (introLine){
      paragraphs.push(`<p style="margin:0 0 14px 0;line-height:1.4;">${escapeHtml(introLine)}<br /></p>`);
    }
    const downloadLink = `<a href="${escapeHtml(result.shareUrl)}" style="color:#0082C9;text-decoration:none;">${escapeHtml(result.shareUrl)}</a>`;
    const permissionLabels = {
      read: await tShare(shareLang, "sharing_permission_read"),
      create: await tShare(shareLang, "sharing_permission_create"),
      write: await tShare(shareLang, "sharing_permission_write"),
      delete: await tShare(shareLang, "sharing_permission_delete")
    };
    const rows = [];
    rows.push(buildTableRow(await tShare(shareLang, "sharing_html_download_label"), downloadLink));
    if (result.password){
      const badge = `<span style="display:inline-block;font-family:'Consolas','Courier New',monospace;padding:2px 6px;border:1px solid #c7c7c7;border-radius:3px;-ms-user-select:all;user-select:all;" ondblclick="try{window.getSelection().selectAllChildren(this);}catch(e){}" onclick="try{window.getSelection().selectAllChildren(this);}catch(e){}">${escapeHtml(result.password)}</span>`;
      rows.push(buildTableRow(await tShare(shareLang, "sharing_html_password_label"), badge));
    }
    if (result.expireDate){
      rows.push(buildTableRow(await tShare(shareLang, "sharing_html_expire_label"), escapeHtml(result.expireDate)));
    }
    rows.push(buildTableRow(await tShare(shareLang, "sharing_html_permissions_label"), buildPermissionsBadges(result.permissions, permissionLabels)));
    const nextcloudAnchor = `<a href="https://nextcloud.com/" style="color:#0082C9;text-decoration:none;">Nextcloud</a>`;
    const footer = (await tShare(shareLang, "sharing_html_footer", [nextcloudAnchor])) || "";
    return `
<div style="font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:11pt;margin:16px 0;">
  <table role="presentation" width="640" style="border-collapse:separate;border-spacing:0;width:640px;margin:0;background-color:transparent;border:1px solid #d7d7db;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="padding:0;">
        <table role="presentation" width="640" style="border-collapse:collapse;width:640px;margin:0;background-color:transparent;">
          <tr>
            <td style="padding:0;background-color:#0082C9;text-align:center;height:32px;">
              <a href="https://github.com/nc-connector/NC_Connector_for_Thunderbird" style="display:inline-block;text-decoration:none;" target="_blank" rel="noopener">
                <img alt="NC Connector" style="display:block;width:auto;height:32px;max-width:164px;object-fit:contain;border:0;margin:0 auto;" src="data:image/png;base64,${headerImage}" />
              </a>
            </td>
          </tr>
          </table>
        <div style="padding:18px 18px 12px 18px;">
          ${paragraphs.join("\n")}
          <table style="width:100%;border-collapse:collapse;margin-bottom:10px;">
            ${rows.join("\n")}
          </table>
        </div>
        <div style="padding:10px 18px 16px 18px;font-size:9pt;font-style:italic;">
          ${footer}
        </div>
      </td>
    </tr>
  </table>
</div>`;
  }

  /**
   * Build a two-column HTML row for the share block.
   * @param {string} label
   * @param {string} valueHtml
   * @returns {string}
   */
  function buildTableRow(label, valueHtml){
    if (!valueHtml){
      return "";
    }
    return `<tr>
      <th style="text-align:left;width:12ch;vertical-align:top;padding:6px 10px 6px 0;">${escapeHtml(label)}</th>
      <td style="padding:6px 0;max-width:50ch;word-break:break-word;">${valueHtml}</td>
    </tr>`;
  }

  /**
   * Build the permissions badge table for the HTML block.
   * @param {object} perms
   * @param {object} labels
   * @returns {string}
   */
  function buildPermissionsBadges(perms, labels = {}){
    const safePerms = perms || {};
    const entries = [
      { label: labels.read || i18n("sharing_permission_read"), enabled: !!safePerms.read },
      { label: labels.create || i18n("sharing_permission_create"), enabled: !!safePerms.create },
      { label: labels.write || i18n("sharing_permission_write"), enabled: !!safePerms.write },
      { label: labels.delete || i18n("sharing_permission_delete"), enabled: !!safePerms.delete }
    ];
    const cells = entries.map((entry) => {
      const color = entry.enabled ? "#0082C9" : "#c62828";
      return `<td style="padding:0 18px 6px 0;">
        <span style="display:inline-flex;align-items:center;">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:1px solid ${color};color:${color};font-size:13px;font-weight:700;">
            ${entry.enabled ? "&#10003;" : "&#10007;"}
          </span>
          <span style="padding-left:6px;font-weight:600;">${escapeHtml(entry.label)}</span>
        </span>
      </td>`;
    }).join("");
    return `<table style="border-collapse:collapse;"><tr>${cells}</tr></table>`;
  }

  /**
   * Create a Nextcloud share, upload files, and return HTML output.
   * @param {object} request
   * @returns {Promise<{html:string, shareUrl:string, shareInfo:object}>}
   */
  async function createFileLink(request){
    const opts = await NCCore.getOpts();
    logDebug(opts, "createFileLink:start", {
      shareName: request?.shareName || "",
      files: Array.isArray(request?.files) ? request.files.length : 0
    });
    if (!opts.baseUrl || !opts.user || !opts.appPass){
      throw new Error(i18n("error_credentials_missing"));
    }
    await ensureHostPermission(opts.baseUrl);
    const basePathSetting = request?.basePath && request.basePath.trim()
      ? request.basePath.trim()
      : (await getFileLinkBasePath());
    const shareDate = request?.shareDate ? new Date(request.shareDate) : new Date();
    const folderInfo = request?.folderInfo
      ? request.folderInfo
      : buildShareFolderInfo(basePathSetting, request?.shareName, shareDate);
    const relativeBase = folderInfo.relativeBase;
    const relativeFolder = folderInfo.relativeFolder;
    const authHeader = NCOcs.buildAuthHeader(opts.user, opts.appPass);
    const davRoot = `${opts.baseUrl.replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(opts.user)}`;
    logDebug(opts, "folders:ensure", { relativeBase, relativeFolder });
    await ensureFolderExists(davRoot, relativeBase, authHeader);
    await ensureFolderExists(davRoot, relativeFolder, authHeader);
    const noteEnabled = !!request?.noteEnabled;
    const noteValue = noteEnabled ? String(request?.note || "").trim() : "";
    request.note = noteValue;
    request.noteEnabled = noteEnabled;
    const normalizedShareName = sanitizeShareName(request?.shareName) || folderInfo.folderName;

    const onProgress = typeof request?.onProgress === "function" ? request.onProgress : null;
    const statusCallback = typeof request?.onUploadStatus === "function" ? request.onUploadStatus : null;
    const files = Array.isArray(request?.files) ? request.files : [];
    if (files.length){
      let uploaded = 0;
      for (const item of files){
        const displayPath = item.displayPath || item.file?.name || "";
        const sanitizedFileName = sanitizeFileName(item.renamedName || item.file?.name || "Datei");
        const relativeDir = sanitizeRelativeDir(item.relativeDir || "");
        const targetFolder = relativeDir ? joinRelativePath(relativeFolder, relativeDir) : relativeFolder;
        if (relativeDir){
          await ensureFolderExists(davRoot, targetFolder, authHeader);
        }
        logDebug(opts, "upload:start", { file: sanitizedFileName, folder: targetFolder });
        await uploadFile({
          davRoot,
          relativeFolder: targetFolder,
          fileName: sanitizedFileName,
          file: item.file,
          authHeader,
          displayPath,
          itemId: item.id,
          statusCb: statusCallback,
          progressCb: () => {
            uploaded++;
            if (onProgress){
              onProgress({ type: "upload", current: uploaded, total: files.length, fileName: displayPath || sanitizedFileName });
            }
          }
        });
        logDebug(opts, "upload:done", { file: sanitizedFileName });
      }
    }

    const share = await requestShare(
      opts.baseUrl,
      relativeFolder,
      authHeader,
      request.permissions,
      request.passwordEnabled ? (request.password || "") : "",
      request.expireEnabled ? (request.expireDate || "") : "",
      !!request.permissions?.create);
    logDebug(opts, "share:created", { url: share.url });
    if (share.id){
      logDebug(opts, "share:updateRequest", {
        shareId: share.id,
        hasNote: !!(noteEnabled && noteValue),
        label: normalizedShareName
      });
      await updateShareMetadata({
        baseUrl: opts.baseUrl,
        shareId: share.id,
        authHeader,
        note: noteEnabled ? noteValue : "",
        permissions: request.permissions,
        expireDate: request.expireEnabled ? (request.expireDate || "") : "",
        password: request.passwordEnabled ? (request.password || "") : "",
        label: normalizedShareName
      });
      logDebug(opts, "share:metadataUpdated", {
        shareId: share.id,
        hasNote: !!(noteEnabled && noteValue),
        label: normalizedShareName
      });
    }

    const resultPayload = {
      shareUrl: share.url,
      password: request.passwordEnabled ? (request.password || "") : "",
      expireDate: request.expireEnabled ? (request.expireDate || "") : "",
      permissions: request.permissions,
      folderInfo,
      note: noteValue,
      noteEnabled,
      shareId: share.id || "",
      label: normalizedShareName
    };
    let html = "";
    try{
      html = await buildHtmlBlock(resultPayload, request);
    }catch(err){
      console.warn("[NCSHARE] buildHtmlBlock failed", err?.message || err);
      const safeUrl = escapeHtml(share.url || "");
      html = safeUrl
        ? `<p style="margin:0 0 12px 0;"><a href="${safeUrl}" style="color:#0082C9;text-decoration:none;">${safeUrl}</a></p>`
        : "";
    }
    logDebug(opts, "createFileLink:done", { shareUrl: share.url });

    return {
      html,
      shareUrl: share.url,
      shareInfo: resultPayload
    };
  }

  /**
   * Load the configured sharing base path from storage.
   * @returns {Promise<string>}
   */
  async function getFileLinkBasePath(){
    if (typeof browser === "undefined" || !browser?.storage?.local){
      return DEFAULT_BASE_PATH;
    }
    const stored = await browser.storage.local.get(["sharingBasePath"]);
    return stored.sharingBasePath || DEFAULT_BASE_PATH;
  }

  /**
   * Update note/label metadata for an existing share (for example after wizard step 4).
   * @param {{shareInfo:Object,noteEnabled:boolean,note:string}} options
   */
  async function updateShareDetails({ shareInfo, noteEnabled, note } = {}){
    if (!shareInfo?.shareId){
      throw new Error(i18n("sharing_error_upload_required"));
    }
    const opts = await NCCore.getOpts();
    if (!opts.baseUrl || !opts.user || !opts.appPass){
      throw new Error(i18n("error_credentials_missing"));
    }
    await ensureHostPermission(opts.baseUrl);
    const authHeader = NCOcs.buildAuthHeader(opts.user, opts.appPass);
    const normalizedLabel = shareInfo.label || sanitizeShareName(shareInfo.folderInfo?.folderName || shareInfo.shareUrl);
    logDebug(opts, "share:updateMeta", {
      shareId: shareInfo.shareId,
      label: normalizedLabel,
      noteEnabled: !!noteEnabled
    });
    await updateShareMetadata({
      baseUrl: opts.baseUrl,
      shareId: shareInfo.shareId,
      authHeader,
      note: noteEnabled ? (note || "") : "",
      permissions: shareInfo.permissions,
      expireDate: shareInfo.expireDate || "",
      password: shareInfo.password || "",
      label: normalizedLabel
    });
    logDebug(opts, "share:updateMeta:done", { shareId: shareInfo.shareId });
  }

  /**
   * Delete the share folder on the server.
   * @param {{folderInfo:Object}} options
   * @returns {Promise<boolean>}
   */
  async function deleteShareFolder({ folderInfo } = {}){
    if (!folderInfo?.relativeFolder){
      return false;
    }
    const opts = await NCCore.getOpts();
    if (!opts.baseUrl || !opts.user || !opts.appPass){
      throw new Error(i18n("error_credentials_missing"));
    }
    await ensureHostPermission(opts.baseUrl);
    const authHeader = NCOcs.buildAuthHeader(opts.user, opts.appPass);
    const davRoot = `${opts.baseUrl.replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(opts.user)}`;
    logDebug(opts, "folders:delete", { relativeFolder: folderInfo.relativeFolder });
    await deleteRemotePath(davRoot, folderInfo.relativeFolder, authHeader);
    return true;
  }

  const api = {
    DEFAULT_BASE_PATH,
    createFileLink,
    buildHtmlBlock,
    getFileLinkBasePath,
    buildShareFolderInfo,
    checkShareFolderAvailability,
    checkRemotePathExists,
    sanitizeShareName,
    sanitizeFileName,
    sanitizeRelativeDir,
    updateShareDetails,
    deleteShareFolder
  };

  if (__context){
    __context.NCSharing = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
































