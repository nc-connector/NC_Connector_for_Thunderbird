/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  /**
   * Builds localized HTML and plain-text blocks for completed shares.
   */
  function create({ i18n, logInternalError } = {}){
    const BRAND_BLUE = "#0082C9";
    const RIGHTS_SEGMENT_START = NCShareTemplateContract.RIGHTS_SEGMENT_START;
    const RIGHTS_SEGMENT_END = NCShareTemplateContract.RIGHTS_SEGMENT_END;
    let cachedHeaderBase64 = null;

    const escapeHtml = NCTalkTextUtils.escapeHtml;

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
      cachedHeaderBase64 = await loadAssetBase64("ui/assets/header-transparent-164x48.png");
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
      const languageKey = NCSharingStorage.SHARE_POLICY_KEYS.blockLanguage;
      const policyLang = String(request?.policyShare?.[languageKey] || "").trim();
      const editableShare = request?.policyEditableShare;
      const hasEditableMetadata = !!editableShare && typeof editableShare === "object";
      const localMayOverride = hasEditableMetadata
        && editableShare[languageKey] !== false
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
      const downloadLink = `<a href="${escapeHtml(downloadUrl)}" style="color:${BRAND_BLUE};text-decoration:none;">${escapeHtml(downloadUrl)}</a>`;
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
          rows.push(buildTableRow(await tShare(effectiveLang, "sharing_html_expire_label"), encodeNoBreakToken(result.expireDate)));
        }
        if (!request?.hidePermissions){
          rows.push(buildTableRow(await tShare(effectiveLang, "sharing_html_permissions_label"), buildPermissionsBadges(result.permissions, permissionLabels)));
        }
      }
      const nextcloudAnchor = `<a href="https://nextcloud.com/" style="color:${BRAND_BLUE};text-decoration:none;">Nextcloud</a>`;
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
              <td style="padding:0;background-color:${BRAND_BLUE};text-align:center;height:32px;">
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
        <th style="text-align:left;width:12ch;vertical-align:top;padding:6px 10px 6px 0;">${encodeNoBreakToken(label)}</th>
        <td style="padding:6px 0;max-width:50ch;word-break:break-word;">${valueHtml}</td>
      </tr>`;
    }

    function encodeNoBreakToken(value){
      const encoded = escapeHtml(String(value || ""))
        .replace(/ /g, "&nbsp;")
        .replace(/-/g, "&#8209;");
      return `<nobr style="white-space: nowrap;">${encoded}</nobr>`;
    }

    function buildPasswordBadge(password){
      return `<span class="nc-share-password" style="display:inline-block;font-family:'Consolas','Courier New',monospace;padding:2px 6px;border:1px solid #c7c7c7;border-radius:3px;-ms-user-select:all;user-select:all;">${escapeHtml(password || "")}</span>`;
    }

    function buildSecretLinkHtml(secretUrl, linkText){
      const label = String(linkText || "").trim() || "Secret link";
      return `<a href="${escapeHtml(secretUrl || "")}" style="color:${BRAND_BLUE};font-weight:bold;text-decoration:underline;word-break:normal;" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
    }

    function buildPermissionsBadges(perms, labels = {}){
      const safePerms = perms || {};
      const entries = [
        { label: labels.read || i18n("sharing_permission_read"), enabled: !!safePerms.read },
        { label: labels.create || i18n("sharing_permission_create"), enabled: !!safePerms.create },
        { label: labels.write || i18n("sharing_permission_write"), enabled: !!safePerms.write },
        { label: labels.delete || i18n("sharing_permission_delete"), enabled: !!safePerms.delete }
      ];
      const cells = entries.map((entry, index) => {
        const color = entry.enabled ? BRAND_BLUE : "#c62828";
        const padding = index === entries.length - 1 ? "0" : "0 12px 0 0";
        return `<td nowrap="nowrap" valign="middle" style="padding: ${padding}; white-space: nowrap; vertical-align: middle;">
          <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="border-collapse: collapse; width: auto; margin: 0;">
            <tbody>
              <tr>
                <td width="14" height="14" valign="middle" style="width: 14px; height: 14px; padding: 0; vertical-align: middle;">
                  <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="14" height="14" style="border-collapse: collapse; width: 14px; height: 14px; margin: 0;">
                    <tbody>
                      <tr>
                        <td width="14" height="14" align="center" valign="middle" style="width: 14px; height: 14px; border: 1px solid ${color}; color: ${color}; font-size: 11px; font-weight: 700; line-height: 14px; padding: 0; text-align: center; vertical-align: middle;">${entry.enabled ? "&#10003;" : "&#10007;"}</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
                <td nowrap="nowrap" valign="middle" style="padding-left: 5px; white-space: nowrap; font-weight: 600; vertical-align: middle;">${escapeHtml(entry.label)}</td>
              </tr>
            </tbody>
          </table>
        </td>`;
      }).join("");
      return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="border-collapse: collapse; width: auto; margin: 0;"><tbody><tr>${cells}</tr></tbody></table>`;
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

    return Object.freeze({
      buildHtmlBlock,
      buildPlainTextBlock
    });
  }

  global.NCShareBlockRenderer = Object.freeze({ create });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
