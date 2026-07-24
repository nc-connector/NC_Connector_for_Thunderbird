/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(__context){
  'use strict';
  const DEFAULT_BASE_PATH = "NC Connector";
  const PERMISSION_FLAGS = {
    read: 1,
    write: 2,
    create: 4,
    delete: 8
  };
  const RIGHTS_SEGMENT_START = NCShareTemplateContract.RIGHTS_SEGMENT_START;
  const RIGHTS_SEGMENT_END = NCShareTemplateContract.RIGHTS_SEGMENT_END;
  const INVALID_PATH_CHARS = /[\\/:*?"<>|]/g;
  let cachedHeaderBase64 = null;

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
  const escapeHtml = NCTalkTextUtils.escapeHtml;

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

  async function getShareBlockLanguageSetting(){
    if (typeof browser === "undefined" || !browser?.storage?.local){
      return { value: "default", hasLocalValue: false };
    }
    const stored = await browser.storage.local.get(["shareBlockLang"]);
    const hasLocalValue = typeof stored.shareBlockLang === "string" && !!stored.shareBlockLang.trim();
    return {
      value: hasLocalValue ? stored.shareBlockLang : "default",
      hasLocalValue
    };
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
  async function updateShareMetadata({ baseUrl, shareId, authHeader, note, permissions, expireDate, password, publicUpload }){
    if (!shareId){
      return;
    }
    const url = baseUrl.replace(/\/+$/, "") + `/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}`;
    const payload = new URLSearchParams();
    payload.append("permissions", String(buildPermissionMask(permissions || {})));
    payload.append("publicUpload", publicUpload ? "true" : "false");
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

  function bufferToBase64(buffer){
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++){
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

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
    }catch(error){
      logInternalError(`asset base64 failed (${assetPath})`, error);
      return "";
    }
  }

  async function getHeaderBase64(){
    if (cachedHeaderBase64){
      return cachedHeaderBase64;
    }
    cachedHeaderBase64 = await loadAssetBase64("ui/assets/header-solid-blue-164x48.png");
    return cachedHeaderBase64;
  }

  /**
   * Resolve the effective share-block language from policy and local storage.
   * Legacy callers without editability metadata keep the historical policy-first behavior.
   * @param {object} request
   * @returns {Promise<string>}
   */
  async function resolveShareBlockLanguage(request){
    const localSetting = await getShareBlockLanguageSetting();
    const policyLang = String(request?.policyShare?.language_share_html_block || "").trim();
    const editableShare = request?.policyEditableShare;
    const hasEditableMetadata = !!editableShare && typeof editableShare === "object";
    const localMayOverride = hasEditableMetadata
      && editableShare.language_share_html_block !== false
      && localSetting.hasLocalValue;
    const selectedLang = localMayOverride
      ? localSetting.value
      : (policyLang || localSetting.value);
    if (typeof NCI18nOverride !== "undefined" && typeof NCI18nOverride.normalizeLanguageOverride === "function"){
      return NCI18nOverride.normalizeLanguageOverride(selectedLang, { allowCustom: true });
    }
    return selectedLang;
  }

  async function resolveShareLinkPresentation(lang, zipDownload){
    const zipMode = !!zipDownload;
    return {
      intro: await tShare(lang, zipMode ? "sharing_html_zip_download_intro" : "sharing_html_intro_line"),
      label: await tShare(lang, zipMode ? "sharing_html_download_label" : "sharing_html_share_link_label")
    };
  }

  /**
   * Resolve a custom policy template for the current rendering mode.
   * @param {object} request
   * @param {boolean} passwordOnly
   * @param {string} shareLang
   * @returns {string}
   */
  function getPolicyTemplate(request, passwordOnly, shareLang){
    if (String(shareLang || "").toLowerCase() !== "custom"){
      return "";
    }
    const policyShare = request?.policyShare;
    if (!policyShare || typeof policyShare !== "object"){
      return "";
    }
    // New backends keep the original key placeholder-free for clients that predate mode-aware link text.
    const keys = passwordOnly
      ? ["share_password_template"]
      : ["share_html_block_template_v2", "share_html_block_template"];
    for (const key of keys){
      const template = String(policyShare[key] || "").trim();
      if (template){
        return template;
      }
    }
    return "";
  }

  function resolveShareRenderLanguage(request, shareLang, customTemplate){
    if (String(shareLang || "").toLowerCase() !== "custom"){
      return shareLang;
    }
    if (!customTemplate){
      return "default";
    }

    // `custom` selects the backend template; it is not the language of client-generated labels.
    const backendLanguage = String(request?.policyShare?.share_html_block_effective_language || "").trim();
    if (!backendLanguage || backendLanguage.toLowerCase() === "custom"){
      return shareLang;
    }
    if (typeof NCI18nOverride !== "undefined" && typeof NCI18nOverride.normalizeLanguageOverride === "function"){
      return NCI18nOverride.normalizeLanguageOverride(backendLanguage);
    }
    return backendLanguage;
  }

  function buildPermissionsTemplateHtml(perms, labels = {}){
    return buildPermissionsBadges(perms, labels);
  }

  function buildPermissionsPlainTextDisplay(perms, labels = {}){
    const safePerms = perms || {};
    const entries = [
      { label: labels.read || i18n("sharing_permission_read"), enabled: !!safePerms.read },
      { label: labels.create || i18n("sharing_permission_create"), enabled: !!safePerms.create },
      { label: labels.write || i18n("sharing_permission_write"), enabled: !!safePerms.write },
      { label: labels.delete || i18n("sharing_permission_delete"), enabled: !!safePerms.delete }
    ];
    return entries
      .map((entry) => `${entry.enabled ? "[x]" : "[ ]"} ${entry.label}`)
      .join(" | ");
  }

  function wrapPermissionsPlainTextSegment(value){
    const plain = String(value || "").trim();
    if (!plain){
      return "";
    }
    return `${RIGHTS_SEGMENT_START}${plain}${RIGHTS_SEGMENT_END}`;
  }

  function normalizePlainTextBlock(value){
    return String(value || "")
      .replace(/\u00A0/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function plainTextToTemplateHtml(value){
    return escapeHtml(String(value || "")).replace(/\r?\n/g, "<br />");
  }

  /**
   * Convert trusted or sanitized HTML to plain text.
   * @param {string} html
   * @returns {string}
   */
  function htmlToPlainTextOrThrow(html){
    if (typeof NCHtmlSanitizer?.htmlToPlainText !== "function"){
      const error = new Error("sharing_template_plaintext_converter_unavailable");
      logInternalError("html->plaintext converter unavailable", error);
      throw error;
    }
    return normalizePlainTextBlock(NCHtmlSanitizer.htmlToPlainText(String(html || "")));
  }

  function buildPlainTextField(label, value){
    const normalizedValue = String(value || "").trim();
    if (!normalizedValue){
      return "";
    }
    const normalizedLabel = String(label || "").trim();
    return normalizedLabel
      ? `${normalizedLabel}: ${normalizedValue}`
      : normalizedValue;
  }

  /**
   * Create an inert parser for backend template pruning.
   * @returns {DOMParser|null}
   */
  function createTemplateParser(){
    if (typeof DOMParser !== "function"){
      const error = new Error("share_template_parser_unavailable");
      logInternalError("DOMParser unavailable for template pruning", error);
      throw error;
    }
    try{
      return new DOMParser();
    }catch(error){
      logInternalError("DOMParser init failed for template pruning", error);
      throw new Error("share_template_parser_unavailable");
    }
  }

  /**
   * Remove one placeholder container from a backend HTML template.
   * Uses block-like wrappers when possible and falls back to token removal.
   * @param {string} template
   * @param {string} placeholder
   * @returns {string}
   */
  function pruneTemplatePlaceholder(template, placeholder){
    const token = `{${String(placeholder || "").trim()}}`;
    if (!token || token === "{}"){
      return String(template || "");
    }
    const source = String(template || "");
    if (!source.includes(token)){
      return source;
    }
    const parser = createTemplateParser();
    const parsed = parser.parseFromString(source, "text/html");
    const body = parsed?.body;
    if (!body){
      throw new Error("share_template_parser_unavailable");
    }
    const candidates = Array.from(body.querySelectorAll("tr,li,p,div,section,article,aside,header,footer")).reverse();
    let removed = false;
    for (const candidate of candidates){
      if (!candidate?.isConnected){
        continue;
      }
      if (!String(candidate.innerHTML || "").includes(token)){
        continue;
      }
      candidate.remove();
      removed = true;
    }
    const output = String(body.innerHTML || "");
    if (removed){
      return output.includes(token) ? output.split(token).join("") : output;
    }
    return output.split(token).join("");
  }

  function pruneEmptyTemplatePlaceholders(template, placeholders = []){
    return placeholders.reduce((output, placeholder) => {
      return pruneTemplatePlaceholder(output, placeholder);
    }, String(template || ""));
  }

  function applyTemplateReplacements(template, replacements){
    let output = String(template || "");
    Object.keys(replacements || {}).forEach((key) => {
      const token = `{${key}}`;
      output = output.split(token).join(String(replacements[key] || ""));
    });
    return output;
  }

  /**
   * Sanitize backend-provided share HTML after all placeholders were resolved.
   * @param {string} html
   * @returns {string}
   */
  function sanitizeCustomTemplateHtml(html){
    if (typeof NCHtmlSanitizer !== "undefined"
      && typeof NCHtmlSanitizer.sanitizeShareTemplateHtml === "function"){
      return NCHtmlSanitizer.sanitizeShareTemplateHtml(html);
    }
    const error = new Error("share_template_sanitizer_unavailable");
    logInternalError("custom share template sanitizer unavailable", error);
    throw error;
  }

  /**
   * Build the HTML block inserted into the compose body.
   * @param {object} result
   * @param {object} request
   * @returns {Promise<string>}
   */
  async function buildHtmlBlock(result, request){
    const shareLang = await resolveShareBlockLanguage(request);
    const headerImage = await getHeaderBase64();
    const passwordOnly = !!request?.passwordOnly;
    const secretLink = !!request?.secretLink;
    const hidePassword = !!request?.hidePassword;
    const showPasswordSeparateHint = !!request?.showPasswordSeparateHint;
    const customTemplate = getPolicyTemplate(request, passwordOnly, shareLang);
    const effectiveLang = resolveShareRenderLanguage(request, shareLang, customTemplate);
    const shareUrl = String(result?.shareUrl || "");
    const downloadUrl = request?.zipDownload
      ? buildZipDownloadUrl(shareUrl, result?.shareToken)
      : shareUrl;
    const linkPresentation = passwordOnly
      ? { intro: "", label: "" }
      : await resolveShareLinkPresentation(effectiveLang, request?.zipDownload);
    const permissionLabels = {
      read: await tShare(effectiveLang, "sharing_permission_read"),
      create: await tShare(effectiveLang, "sharing_permission_create"),
      write: await tShare(effectiveLang, "sharing_permission_write"),
      delete: await tShare(effectiveLang, "sharing_permission_delete")
    };
    const permissionsHtml = request?.hidePermissions
      ? ""
      : buildPermissionsTemplateHtml(result.permissions, permissionLabels);
    const noteText = (!passwordOnly && request?.noteEnabled && request?.note)
      ? escapeHtml(String(request.note || "")).replace(/\r?\n/g, "<br />")
      : "";
    let passwordText = "";
    if (passwordOnly){
      passwordText = secretLink
        ? buildSecretLinkHtml(result.password || "", await tShare(effectiveLang, "sharing_html_secret_link_label"))
        : escapeHtml(result.password || "");
    }else if (hidePassword && showPasswordSeparateHint && result.password){
      passwordText = escapeHtml(await tShare(effectiveLang, "sharing_html_password_separate_hint"));
    }else if (!hidePassword){
      passwordText = escapeHtml(result.password || "");
    }
    if (customTemplate){
      const emptyPlaceholders = [];
      if (!downloadUrl){
        emptyPlaceholders.push("URL");
      }
      if (!passwordText){
        emptyPlaceholders.push("PASSWORD");
      }
      if (!result.expireDate){
        emptyPlaceholders.push("EXPIRATIONDATE");
      }
      if (!permissionsHtml){
        emptyPlaceholders.push("RIGHTS");
      }
      if (!noteText){
        emptyPlaceholders.push("NOTE");
      }
      const effectiveTemplate = pruneEmptyTemplatePlaceholders(customTemplate, emptyPlaceholders);
      return sanitizeCustomTemplateHtml(applyTemplateReplacements(effectiveTemplate, {
        URL: escapeHtml(downloadUrl || ""),
        PASSWORD: passwordText,
        EXPIRATIONDATE: escapeHtml(result.expireDate || ""),
        RIGHTS: permissionsHtml,
        NOTE: noteText,
        LINK_INTRO: escapeHtml(linkPresentation.intro),
        LINK_LABEL: escapeHtml(linkPresentation.label)
      }));
    }

    const paragraphs = [];
    if (noteText){
      paragraphs.push(`<p style="margin:0 0 14px 0;line-height:1.4;">${noteText}</p>`);
    }
    const introLine = passwordOnly
      ? await tShare(effectiveLang, secretLink ? "sharing_html_secret_mail_intro" : "sharing_html_password_mail_intro")
      : linkPresentation.intro;
    if (introLine){
      paragraphs.push(`<p style="margin:0 0 14px 0;line-height:1.4;">${escapeHtml(introLine)}<br /></p>`);
    }
    const downloadLink = `<a href="${escapeHtml(downloadUrl)}" style="color:#0082C9;text-decoration:none;">${escapeHtml(downloadUrl)}</a>`;
    const rows = [];
    if (passwordOnly){
      const valueHtml = secretLink
        ? buildSecretLinkHtml(result.password || "", await tShare(effectiveLang, "sharing_html_secret_link_label"))
        : buildPasswordBadge(result.password || "");
      rows.push(buildTableRow(await tShare(effectiveLang, "sharing_html_password_label"), valueHtml));
    }else{
      rows.push(buildTableRow(linkPresentation.label, downloadLink));
      if (result.password && !hidePassword){
        const badge = buildPasswordBadge(result.password);
        rows.push(buildTableRow(await tShare(effectiveLang, "sharing_html_password_label"), badge));
      }
      if (showPasswordSeparateHint && result.password){
        rows.push(buildTableRow(await tShare(effectiveLang, "sharing_html_password_label"), escapeHtml(await tShare(effectiveLang, "sharing_html_password_separate_hint"))));
      }
      if (result.expireDate){
        rows.push(buildTableRow(await tShare(effectiveLang, "sharing_html_expire_label"), escapeHtml(result.expireDate)));
      }
      if (!request?.hidePermissions){
        rows.push(buildTableRow(await tShare(effectiveLang, "sharing_html_permissions_label"), buildPermissionsBadges(result.permissions, permissionLabels)));
      }
    }
    const nextcloudAnchor = `<a href="https://nextcloud.com/" style="color:#0082C9;text-decoration:none;">Nextcloud</a>`;
    const footer = passwordOnly
      ? ""
      : ((await tShare(effectiveLang, "sharing_html_footer", [nextcloudAnchor])) || "");
    const footerHtml = footer
      ? `<div style="padding:10px 18px 16px 18px;font-size:9pt;font-style:italic;">
          ${footer}
        </div>`
      : "";
    return `
<div style="font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:11pt;margin:16px 0;">
  <table role="presentation" width="640" style="border-collapse:separate;border-spacing:0;width:640px;margin:0;background-color:transparent;border:1px solid #d7d7db;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="padding:0;">
        <table role="presentation" width="640" style="border-collapse:collapse;width:640px;margin:0;background-color:transparent;">
          <tr>
            <td style="padding:0;background-color:#0082C9;text-align:center;height:32px;">
              <a href="https://nc-connector.de" style="display:inline-block;text-decoration:none;" target="_blank" rel="noopener">
                <img style="display:block;width:auto;height:32px;max-width:164px;object-fit:contain;border:0;margin:0 auto;" src="data:image/png;base64,${headerImage}" />
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
        ${footerHtml}
      </td>
    </tr>
  </table>
</div>`;
  }

  /**
   * Build the plain-text block inserted into the compose body.
   * Local templates are rendered directly as text.
   * Backend templates are sanitized first and then flattened to plain text.
   * @param {object} result
   * @param {object} request
   * @returns {Promise<string>}
   */
  async function buildPlainTextBlock(result, request){
    const shareLang = await resolveShareBlockLanguage(request);
    const passwordOnly = !!request?.passwordOnly;
    const secretLink = !!request?.secretLink;
    const hidePassword = !!request?.hidePassword;
    const showPasswordSeparateHint = !!request?.showPasswordSeparateHint;
    const customTemplate = getPolicyTemplate(request, passwordOnly, shareLang);
    const effectiveLang = resolveShareRenderLanguage(request, shareLang, customTemplate);
    const shareUrl = String(result?.shareUrl || "");
    const downloadUrl = request?.zipDownload
      ? buildZipDownloadUrl(shareUrl, result?.shareToken)
      : shareUrl;
    const linkPresentation = passwordOnly
      ? { intro: "", label: "" }
      : await resolveShareLinkPresentation(effectiveLang, request?.zipDownload);
    const permissionLabels = {
      read: await tShare(effectiveLang, "sharing_permission_read"),
      create: await tShare(effectiveLang, "sharing_permission_create"),
      write: await tShare(effectiveLang, "sharing_permission_write"),
      delete: await tShare(effectiveLang, "sharing_permission_delete")
    };
    const permissionsPlain = request?.hidePermissions
      ? ""
      : wrapPermissionsPlainTextSegment(buildPermissionsPlainTextDisplay(result.permissions, permissionLabels));
    const noteText = (!passwordOnly && request?.noteEnabled && request?.note)
      ? normalizePlainTextBlock(String(request.note || ""))
      : "";
    let passwordText = "";
    if (passwordOnly){
      passwordText = String(result.password || "").trim();
    }else if (hidePassword && showPasswordSeparateHint && result.password){
      passwordText = String(await tShare(effectiveLang, "sharing_html_password_separate_hint") || "").trim();
    }else if (!hidePassword){
      passwordText = String(result.password || "").trim();
    }

    if (customTemplate){
      const emptyPlaceholders = [];
      if (!downloadUrl){
        emptyPlaceholders.push("URL");
      }
      if (!passwordText){
        emptyPlaceholders.push("PASSWORD");
      }
      if (!result.expireDate){
        emptyPlaceholders.push("EXPIRATIONDATE");
      }
      if (!permissionsPlain){
        emptyPlaceholders.push("RIGHTS");
      }
      if (!noteText){
        emptyPlaceholders.push("NOTE");
      }
      const effectiveTemplate = pruneEmptyTemplatePlaceholders(customTemplate, emptyPlaceholders);
      const renderedTemplate = applyTemplateReplacements(effectiveTemplate, {
        URL: plainTextToTemplateHtml(downloadUrl || ""),
        PASSWORD: plainTextToTemplateHtml(passwordText),
        EXPIRATIONDATE: plainTextToTemplateHtml(String(result.expireDate || "")),
        RIGHTS: plainTextToTemplateHtml(permissionsPlain),
        NOTE: plainTextToTemplateHtml(noteText),
        LINK_INTRO: plainTextToTemplateHtml(linkPresentation.intro),
        LINK_LABEL: plainTextToTemplateHtml(linkPresentation.label)
      });
      const plainText = htmlToPlainTextOrThrow(sanitizeCustomTemplateHtml(renderedTemplate));
      if (!plainText){
        throw new Error("sharing_template_plaintext_empty");
      }
      return plainText;
    }

    const sections = [];
    if (noteText){
      sections.push(noteText);
    }
    const introLine = passwordOnly
      ? await tShare(effectiveLang, secretLink ? "sharing_html_secret_mail_intro" : "sharing_html_password_mail_intro")
      : linkPresentation.intro;
    if (introLine){
      sections.push(normalizePlainTextBlock(introLine));
    }

    const fields = [];
    if (passwordOnly){
      fields.push(buildPlainTextField(await tShare(effectiveLang, "sharing_html_password_label"), passwordText));
    }else{
      fields.push(buildPlainTextField(linkPresentation.label, downloadUrl));
      if (result.password && !hidePassword){
        fields.push(buildPlainTextField(await tShare(effectiveLang, "sharing_html_password_label"), String(result.password || "")));
      }
      if (showPasswordSeparateHint && result.password){
        fields.push(buildPlainTextField(
          await tShare(effectiveLang, "sharing_html_password_label"),
          await tShare(effectiveLang, "sharing_html_password_separate_hint")
        ));
      }
      if (result.expireDate){
        fields.push(buildPlainTextField(await tShare(effectiveLang, "sharing_html_expire_label"), String(result.expireDate || "")));
      }
      if (!request?.hidePermissions){
        fields.push(buildPlainTextField(await tShare(effectiveLang, "sharing_html_permissions_label"), permissionsPlain));
      }
    }
    const fieldsText = fields.filter(Boolean).join("\n");
    if (fieldsText){
      sections.push(fieldsText);
    }

    const footer = passwordOnly
      ? ""
      : ((await tShare(effectiveLang, "sharing_html_footer", ["Nextcloud"])) || "");
    if (footer){
      sections.push(normalizePlainTextBlock(footer));
    }

    const plainText = normalizePlainTextBlock(sections.filter(Boolean).join("\n\n"));
    if (!plainText){
      throw new Error("sharing_template_plaintext_empty");
    }
    return plainText;
  }

  function buildTableRow(label, valueHtml){
    if (!valueHtml){
      return "";
    }
    return `<tr>
      <th style="text-align:left;width:12ch;vertical-align:top;padding:6px 10px 6px 0;">${escapeHtml(label)}</th>
      <td style="padding:6px 0;max-width:50ch;word-break:break-word;">${valueHtml}</td>
    </tr>`;
  }

  function buildPasswordBadge(password){
    return `<span class="nc-share-password" style="display:inline-block;font-family:'Consolas','Courier New',monospace;padding:2px 6px;border:1px solid #c7c7c7;border-radius:3px;-ms-user-select:all;user-select:all;">${escapeHtml(password || "")}</span>`;
  }

  function buildSecretLinkHtml(secretUrl, linkText){
    const label = String(linkText || "").trim() || "Secret link";
    return `<a href="${escapeHtml(secretUrl || "")}" style="color:#0082C9;font-weight:bold;text-decoration:underline;word-break:normal;" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  }

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

  function buildZipDownloadUrl(shareUrl, shareToken){
    const base = String(shareUrl || "").trim();
    const expectedToken = String(shareToken || "").trim();
    if (!base){
      const error = new Error("Nextcloud public share URL is empty");
      logInternalError("buildZipDownloadUrl failed", error);
      throw new Error(i18n("sharing_error_zip_url_invalid"));
    }
    try{
      const parsed = new URL(base);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:"){
        throw new Error("Invalid Nextcloud public share URL scheme");
      }
      const pathSegments = parsed.pathname.split("/").filter(Boolean);
      const shareSegmentIndex = pathSegments.length - 2;
      if (shareSegmentIndex < 0 || pathSegments[shareSegmentIndex] !== "s"){
        throw new Error("Invalid Nextcloud public share URL");
      }
      const encodedToken = pathSegments[shareSegmentIndex + 1];
      if (!encodedToken){
        throw new Error("Invalid Nextcloud public share URL token");
      }
      const token = decodeURIComponent(encodedToken);
      if (expectedToken && token !== expectedToken){
        throw new Error("Nextcloud public share URL token does not match the OCS share token");
      }
      const normalized = pathSegments.slice();
      normalized.push("download");
      parsed.pathname = "/" + normalized.join("/");
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }catch(error){
      logInternalError("buildZipDownloadUrl failed", error);
      throw new Error(i18n("sharing_error_zip_url_invalid"));
    }
  }

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
    NCFileLinkDav.throwIfAborted(request?.signal);
    await ensureHostPermission(opts.baseUrl);
    NCFileLinkDav.throwIfAborted(request?.signal);
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
    const authHeader = NCOcs.buildAuthHeader(opts.user, opts.appPass);
    const davBase = opts.baseUrl.replace(/\/+$/, "");
    return {
      capabilities,
      basePathSetting,
      shareDate,
      authHeader,
      davRoot: `${davBase}/remote.php/dav/files/${encodeURIComponent(userId)}`,
      uploadRoot: `${davBase}/remote.php/dav/uploads/${encodeURIComponent(userId)}`,
      bulkUrl: `${davBase}/remote.php/dav/bulk`
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
    const probe = await NCFileLinkDav.probePath({
      url: NCFileLinkDav.buildFileUrl(context.davRoot, folderInfo.relativeFolder),
      authHeader: context.authHeader,
      signal: request?.signal || null,
      log: (...args) => logDebug(opts, ...args)
    });
    return probe.exists;
  }

  /**
   * Create a Nextcloud share, upload files, and return HTML output.
   * @param {object} request
   * @returns {Promise<{shareUrl:string, shareInfo:object}>}
   */
  async function createFileLink(request){
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
    const sourceItems = Array.isArray(request?.files) ? request.files : [];
    const files = sourceItems.map((item, index) => {
      const sourceFile = item?.file;
      if (!sourceFile || typeof sourceFile.slice !== "function"){
        throw new Error(i18n("sharing_status_error"));
      }
      const fileName = sanitizeFileName(item.renamedName || sourceFile.name || "File");
      return {
        itemId: item.id || `file-${index + 1}`,
        sourceFile,
        fileName,
        displayPath: item.displayPath || sourceFile.name || fileName,
        relativeDir: sanitizeRelativeDir(item.relativeDir || ""),
        size: Number(sourceFile.size) || 0,
        lastModified: Number(sourceFile.lastModified) || Date.now(),
        contentType: sourceFile.type || "application/octet-stream"
      };
    });
    const baseShareName = sanitizeShareName(request?.shareName) || sanitizeShareName(i18n("sharing_share_default"));
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
          url: NCFileLinkDav.buildFileUrl(davRoot, root.folderInfo.relativeFolder),
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
        files,
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
        files: files.length
      });
      return {
        shareUrl: share.url,
        shareInfo: resultPayload
      };
    }catch(error){
      if (preparedRoot?.folderInfo?.relativeFolder){
        let cleaned = false;
        try{
          await NCFileLinkDav.deleteTrackedRoot({
            url: preparedRoot.cleanupTarget?.url
              || NCFileLinkDav.buildFileUrl(davRoot, preparedRoot.folderInfo.relativeFolder),
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
   * Update note and label metadata for one existing share
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
      publicUpload: !!shareInfo.permissions?.create
    });
    logDebug(opts, "share:updateMeta:done", { shareId: shareInfo.shareId });
  }

  async function deleteShareFolder({ folderInfo } = {}){
    if (!folderInfo?.relativeFolder){
      return false;
    }
    const opts = await NCCore.getOpts();
    if (!opts.baseUrl || !opts.user || !opts.appPass){
      throw new Error(i18n("error_credentials_missing"));
    }
    await ensureHostPermission(opts.baseUrl);
    const userId = await NCCore.getCurrentUserId(opts);
    const authHeader = NCOcs.buildAuthHeader(opts.user, opts.appPass);
    const davRoot = `${opts.baseUrl.replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(userId)}`;
    logDebug(opts, "folders:delete", { relativeFolder: folderInfo.relativeFolder });
    return NCFileLinkDav.deleteRemotePath({
      url: NCFileLinkDav.buildFileUrl(davRoot, folderInfo.relativeFolder),
      authHeader,
      log: (...args) => logDebug(opts, ...args)
    });
  }

  const api = {
    DEFAULT_BASE_PATH,
    createFileLink,
    checkFileLinkFolderExists,
    buildHtmlBlock,
    buildPlainTextBlock,
    getFileLinkBasePath,
    buildShareFolderInfo,
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
