'use strict';

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const RIGHTS_SEGMENT_START = "[[NCSHARE_RIGHTS_START]]";
const RIGHTS_SEGMENT_END = "[[NCSHARE_RIGHTS_END]]";

function assert(condition, message){
  if (!condition){
    throw new Error(message);
  }
}

function read(relPath){
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function escapeHtml(value){
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripTags(value){
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeShareTemplateHtml(value){
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+=\"[^\"]*\"/gi, "")
    .replace(/\son[a-z]+='[^']*'/gi, "");
}

function htmlToPlainText(value){
  return String(value || "")
    .replace(/<a[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const plainText = stripTags(text).replace(/\s+/g, " ").trim();
      if (!plainText){
        return href;
      }
      return plainText === href ? plainText : `${plainText} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<img[^>]*alt=\"([^\"]*)\"[^>]*>/gi, "$1")
    .replace(/<img[^>]*alt='([^']*)'[^>]*>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainTextToHtml(value){
  return escapeHtml(String(value || "")).replace(/\r?\n/g, "<br />");
}

function extractBodyHtml(source){
  const bodyMatch = String(source || "").match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : String(source || "");
}

class FakeTemplateElement {
  constructor(body, startIndex, endIndex, innerHtml){
    this._body = body;
    this._startIndex = startIndex;
    this._endIndex = endIndex;
    this._innerHtml = innerHtml;
    this._removed = false;
  }

  get isConnected(){
    return !this._removed;
  }

  get innerHTML(){
    return this._innerHtml;
  }

  remove(){
    if (this._removed){
      return;
    }
    this._body._html = this._body._html.slice(0, this._startIndex) + this._body._html.slice(this._endIndex);
    this._removed = true;
  }
}

class FakeTemplateBody {
  constructor(html){
    this._html = extractBodyHtml(html);
  }

  get innerHTML(){
    return this._html;
  }

  querySelectorAll(selector){
    const tags = String(selector || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const matches = [];
    for (const tag of tags){
      const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
      let match = null;
      while ((match = expression.exec(this._html))){
        matches.push(new FakeTemplateElement(this, match.index, expression.lastIndex, match[1]));
      }
    }
    matches.sort((left, right) => left._startIndex - right._startIndex);
    return matches;
  }
}

class FakeDOMParser {
  parseFromString(source){
    return { body: new FakeTemplateBody(source) };
  }
}

function makeTranslations(){
  return {
    sharing_permission_read: "Read",
    sharing_permission_create: "Create",
    sharing_permission_write: "Write",
    sharing_permission_delete: "Delete",
    sharing_html_password_separate_hint: "Password will be sent in a separate email.",
    sharing_html_password_mail_intro: "Use the following password to access the share.",
    sharing_html_intro_line: "Open the Nextcloud link below to view the share.",
    sharing_html_zip_download_intro: "Download the shared files as a ZIP archive using the link below.",
    sharing_html_download_label: "ZIP download",
    sharing_html_share_link_label: "Nextcloud link",
    sharing_html_password_label: "Password",
    sharing_html_expire_label: "Valid until",
    sharing_html_permissions_label: "Permissions",
    sharing_html_footer: "Shared securely via {0}",
    error_host_permission_missing: "Host permission missing"
  };
}

function makeGermanTranslations(){
  return {
    sharing_permission_read: "Lesen",
    sharing_permission_create: "Hochladen",
    sharing_permission_write: "Bearbeiten",
    sharing_permission_delete: "Löschen",
    sharing_html_password_separate_hint: "Das Passwort wird in einer separaten E-Mail gesendet.",
    sharing_html_intro_line: "Die Dateien wurden sicher und datenschutzkonform über Nextcloud bereitgestellt. Öffnen Sie den untenstehenden Nextcloud-Link, um die Freigabe aufzurufen.",
    sharing_html_zip_download_intro: "Die Dateien wurden sicher und datenschutzkonform über Nextcloud bereitgestellt. Laden Sie die freigegebenen Dateien über den untenstehenden Link als ZIP-Archiv herunter.",
    sharing_html_download_label: "ZIP-Download",
    sharing_html_share_link_label: "Nextcloud-Link",
    sharing_html_password_label: "Passwort",
    sharing_html_expire_label: "Ablaufdatum",
    sharing_html_permissions_label: "Ihre Berechtigungen"
  };
}

function translate(translations, key, substitutions = []){
  let value = translations[key] || key || "";
  const args = Array.isArray(substitutions) ? substitutions : [substitutions];
  args.forEach((replacement, index) => {
    value = value.split(`{${index}}`).join(String(replacement ?? ""));
  });
  return value;
}

function loadScriptIntoContext(relPath, context){
  const script = read(relPath);
  vm.runInContext(script, context, { filename: relPath });
}

function createHarness(){
  const translations = makeTranslations();
  const translationsByLanguage = {
    de: { ...translations, ...makeGermanTranslations() }
  };
  const storageState = { shareBlockLang: "default" };
  const composeState = {
    detailsByTab: new Map(),
    setCalls: []
  };
  const context = {
    console,
    URL,
    DOMParser: FakeDOMParser,
    setTimeout,
    clearTimeout,
    window: null,
    global: null,
    globalThis: null,
    NCShareTemplateContract: undefined,
    NCTalkTextUtils: { escapeHtml },
    NCI18n: {
      translate: (key, substitutions = []) => translate(translations, key, substitutions)
    },
    NCI18nOverride: {
      normalizeLanguageOverride: (value, options = {}) => {
        const normalized = String(value || "").trim().toLowerCase();
        if (!normalized){
          return "default";
        }
        if (normalized === "custom" && options.allowCustom){
          return "custom";
        }
        return normalized;
      },
      tInLang: async (lang, key, substitutions = []) => translate(
        translationsByLanguage[String(lang || "").trim().toLowerCase()] || translations,
        key,
        substitutions
      )
    },
    NCHtmlSanitizer: {
      sanitizeShareTemplateHtml,
      htmlToPlainText,
      plainTextToHtml
    },
    browser: {
      i18n: {
        getMessage: (key, substitutions = []) => translate(translations, key, substitutions)
      },
      storage: {
        local: {
          get: async (keys) => {
            const response = {};
            const requested = Array.isArray(keys) ? keys : Object.keys(keys || {});
            requested.forEach((key) => {
              if (Object.prototype.hasOwnProperty.call(storageState, key)){
                response[key] = storageState[key];
              }
            });
            return response;
          }
        }
      },
      compose: {
        getComposeDetails: async (tabId) => {
          return composeState.detailsByTab.get(Number(tabId)) || {
            isPlainText: false,
            deliveryFormat: "html",
            body: "",
            plainTextBody: ""
          };
        },
        setComposeDetails: async (tabId, details) => {
          composeState.setCalls.push({ tabId: Number(tabId), details });
          const current = composeState.detailsByTab.get(Number(tabId)) || {};
          composeState.detailsByTab.set(Number(tabId), { ...current, ...details });
        }
      }
    },
    bgI18n: (key) => translate(translations, key),
    L: () => {}
  };
  context.window = context;
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  loadScriptIntoContext("modules/shareTemplateContract.js", context);
  loadScriptIntoContext("modules/ncSharing.js", context);
  loadScriptIntoContext("modules/bgComposeShareInsert.js", context);
  return { context, storageState, composeState };
}

async function testLocalPlainTextBuildSkipsSanitizer(){
  const { context } = createHarness();
  let sanitizeCalls = 0;
  context.NCHtmlSanitizer.sanitizeShareTemplateHtml = (html) => {
    sanitizeCalls += 1;
    return sanitizeShareTemplateHtml(html);
  };
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "Secret123",
    expireDate: "2026-05-01",
    permissions: { read: true, create: false, write: true, delete: false }
  }, {
    noteEnabled: true,
    note: "Please review the files.",
    permissions: { read: true, create: false, write: true, delete: false }
  });

  assert(sanitizeCalls === 0, "Local plaintext build must not invoke backend sanitizer");
  assert(plainText.includes("Nextcloud link: https://cloud.example/s/abc123"), "Local plaintext build must label the normal share-page URL as a Nextcloud link");
  assert(plainText.includes("Password: Secret123"), "Local plaintext build must include password field");
  assert(plainText.includes(RIGHTS_SEGMENT_START), "Local plaintext build must preserve explicit rights markers for final insertion");
}

async function testCustomTemplatePrunesEmptyPasswordAndSanitizes(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "Secret123",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  }, {
    hidePassword: true,
    showPasswordSeparateHint: false,
    permissions: { read: true, create: false, write: false, delete: false },
    policyShare: {
      share_html_block_template: "<div>Download: {URL}</div><p>Password: {PASSWORD}</p><div>{RIGHTS}</div><script>alert(1)</script>"
    }
  });

  assert(plainText.includes("Download: https://cloud.example/s/abc123"), "Custom plaintext build must include replaced URL");
  assert(!plainText.includes("Password:"), "Empty PASSWORD placeholder should prune its wrapper");
  assert(!plainText.includes("alert(1)"), "Custom plaintext build must sanitize backend template content");
}

async function testCustomTemplateUsesSeparatePasswordHint(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "Secret123",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  }, {
    hidePassword: true,
    showPasswordSeparateHint: true,
    permissions: { read: true, create: false, write: false, delete: false },
    policyShare: {
      share_html_block_template: "<p>Password info: {PASSWORD}</p>"
    }
  });

  assert(plainText.includes("Password info: Password will be sent in a separate email."), "Custom plaintext build must inject separate password hint when configured");
}

async function testBackendEffectiveLanguageLocalizesCustomTemplateCopy(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const shareInfo = {
    shareUrl: "https://cloud.example/s/abc123",
    password: "Secret123",
    expireDate: "2026-05-01",
    permissions: { read: true, create: true, write: true, delete: true }
  };
  const policyShare = {
    language_share_html_block: "custom",
    share_html_block_effective_language: "de",
    share_html_block_template_v2: "<p>{LINK_INTRO}</p><p>{LINK_LABEL}: {URL}</p><p>{PASSWORD}</p><p>{RIGHTS}</p>"
  };
  const request = {
    hidePassword: true,
    showPasswordSeparateHint: true,
    permissions: shareInfo.permissions,
    policyShare
  };

  const html = await context.NCSharing.buildHtmlBlock(shareInfo, request);
  const plainText = await context.NCSharing.buildPlainTextBlock(shareInfo, request);

  for (const output of [html, plainText]){
    assert(output.includes("Öffnen Sie den untenstehenden Nextcloud-Link"), "Backend template language must localize LINK_INTRO");
    assert(output.includes("Nextcloud-Link"), "Backend template language must localize LINK_LABEL");
    assert(output.includes("Das Passwort wird in einer separaten E-Mail gesendet."), "Backend template language must localize the separate-password hint");
    assert(output.includes("Lesen") && output.includes("Hochladen") && output.includes("Bearbeiten") && output.includes("Löschen"), "Backend template language must localize permission names");
  }
}

async function testCustomTemplateResolvesModeAwareLinkVariables(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const shareInfo = {
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  };
  const policyShare = {
    share_html_block_template: "<p>Legacy template: {URL}</p>",
    share_html_block_template_v2: "<p>{LINK_INTRO}</p><p>{LINK_LABEL}: {URL}</p>"
  };

  const normalHtml = await context.NCSharing.buildHtmlBlock(shareInfo, {
    hidePermissions: true,
    policyShare
  });
  const zipHtml = await context.NCSharing.buildHtmlBlock(shareInfo, {
    hidePermissions: true,
    zipDownload: true,
    policyShare
  });
  const normal = await context.NCSharing.buildPlainTextBlock(shareInfo, {
    hidePermissions: true,
    policyShare
  });
  const zip = await context.NCSharing.buildPlainTextBlock(shareInfo, {
    hidePermissions: true,
    zipDownload: true,
    policyShare
  });

  assert(normal.includes("Open the Nextcloud link below to view the share."), "Normal custom template must resolve LINK_INTRO for the share page");
  assert(normal.includes("Nextcloud link: https://cloud.example/s/abc123"), "Normal custom template must resolve LINK_LABEL without changing the URL");
  assert(zip.includes("Download the shared files as a ZIP archive"), "Attachment custom template must resolve LINK_INTRO for ZIP mode");
  assert(zip.includes("ZIP download: https://cloud.example/s/abc123/download"), "Attachment custom template must resolve LINK_LABEL and ZIP URL together");
  assert(normalHtml.includes("Open the Nextcloud link below to view the share."), "Normal custom HTML must use the versioned template");
  assert(zipHtml.includes("ZIP download"), "Attachment custom HTML must resolve the versioned template in ZIP mode");
  assert(!normal.includes("Legacy template") && !normalHtml.includes("Legacy template"), "Versioned custom template must take precedence over the compatibility template");
}

async function testOlderBackendModeAwareTemplateStillRenders(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  }, {
    hidePermissions: true,
    policyShare: {
      share_html_block_template: "<p>{LINK_INTRO}</p><p>{LINK_LABEL}: {URL}</p>"
    }
  });

  assert(plainText.includes("Open the Nextcloud link below to view the share."), "Older backend template field must still resolve LINK_INTRO");
  assert(plainText.includes("Nextcloud link: https://cloud.example/s/abc123"), "Older backend template field must still resolve LINK_LABEL");
}

async function testPlainTextInsertCompactsMarkedRightsSegment(){
  const { context, composeState } = createHarness();
  composeState.detailsByTab.set(7, {
    isPlainText: true,
    deliveryFormat: "plaintext",
    body: "",
    plainTextBody: "Existing body"
  });
  const plainText = [
    "Download link: https://cloud.example/s/abc123",
    `${RIGHTS_SEGMENT_START}Permissions`,
    "[x]",
    "Read",
    "[ ]",
    "Write",
    `${RIGHTS_SEGMENT_END}`
  ].join("\n");

  const result = await context.handleSharingInsertHtmlMessage({
    tabId: 7,
    html: "<p>ignored for plaintext compose</p>",
    plainText
  });

  assert(result.ok === true, "Plaintext insert handler should succeed with explicit render variants");
  assert(composeState.setCalls.length === 1, "Plaintext insert must write compose details exactly once");
  const writtenBody = composeState.setCalls[0].details.plainTextBody;
  assert(writtenBody.includes("Permissions: [x] Read | [ ] Write"), "Marked rights segment must compact to one permission line");
  assert(!writtenBody.includes(RIGHTS_SEGMENT_START), "Final plaintext insert must not leak rights markers");
  assert(/^#{60}/.test(writtenBody), "Plaintext insert must frame the block with separators");
}

async function testInsertRejectsMissingPlainTextVariant(){
  const { context } = createHarness();
  const result = await context.handleSharingInsertHtmlMessage({
    tabId: 7,
    html: "<p>share block</p>"
  });
  assert(result.ok === false, "Insert handler must reject missing plainText render variant");
  assert(result.error === "tab/html/plainText missing", "Insert handler should report the explicit missing-variant rule");
}

async function run(){
  await testLocalPlainTextBuildSkipsSanitizer();
  await testCustomTemplatePrunesEmptyPasswordAndSanitizes();
  await testCustomTemplateUsesSeparatePasswordHint();
  await testBackendEffectiveLanguageLocalizesCustomTemplateCopy();
  await testCustomTemplateResolvesModeAwareLinkVariables();
  await testOlderBackendModeAwareTemplateStillRenders();
  await testPlainTextInsertCompactsMarkedRightsSegment();
  await testInsertRejectsMissingPlainTextVariant();
  console.log("[OK] share-plaintext-contract-check passed");
}

run().catch((error) => {
  console.error("[FAIL] share-plaintext-contract-check", error);
  process.exitCode = 1;
});
