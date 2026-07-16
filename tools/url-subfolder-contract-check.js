"use strict";

const vm = require("node:vm");
const { assert, loadScript } = require("./review-check-utils");

function escapeHtml(value){
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeTranslations(){
  return {
    sharing_permission_read: "Read",
    sharing_permission_create: "Create",
    sharing_permission_write: "Write",
    sharing_permission_delete: "Delete",
    sharing_html_intro_line: "Open the Nextcloud link below to view the share.",
    sharing_html_zip_download_intro: "Download the shared files as a ZIP archive using the link below.",
    sharing_html_download_label: "ZIP download",
    sharing_html_share_link_label: "Nextcloud link",
    sharing_html_password_label: "Password",
    sharing_html_expire_label: "Valid until",
    sharing_html_permissions_label: "Permissions",
    sharing_html_footer: "Shared securely via {0}",
    sharing_share_default: "Share",
    error_host_permission_missing: "Host permission missing"
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

function createHarness(){
  const translations = makeTranslations();
  const context = {
    console,
    URL,
    window: null,
    globalThis: null,
    NCShareTemplateContract: undefined,
    NCI18n: {
      translate: (key, substitutions = []) => translate(translations, key, substitutions)
    },
    NCI18nOverride: {
      normalizeLanguageOverride: (value) => String(value || "default").trim() || "default",
      tInLang: async (_lang, key, substitutions = []) => translate(translations, key, substitutions)
    },
    NCHtmlSanitizer: {
      htmlToPlainText: (value) => String(value || "").replace(/<[^>]+>/g, " ").trim(),
      plainTextToHtml: (value) => escapeHtml(value).replace(/\r?\n/g, "<br />"),
      sanitizeShareTemplateHtml: (value) => String(value || "")
    },
    browser: {
      i18n: {
        getMessage: (key, substitutions = []) => translate(translations, key, substitutions)
      },
      storage: {
        local: {
          get: async () => ({ shareBlockLang: "default" })
        }
      }
    },
    bgI18n: (key) => translate(translations, key),
    L: () => {}
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/shareTemplateContract.js", context);
  loadScript("modules/textUtils.js", context);
  loadScript("modules/ncSharing.js", context);
  return context;
}

async function run(){
  const context = createHarness();

  assert(context.NCTalkTextUtils.normalizeBaseUrl("https://cloud.example.com/nc/") === "https://cloud.example.com/nc", "Base URL normalization must preserve subfolder path");
  assert(context.NCTalkTextUtils.normalizeBaseUrl("http://cloud.example.com/nc") === "", "Base URL normalization must reject non-HTTPS URLs");

  const referenceDate = vm.runInContext("new Date('2026-07-03T12:00:00Z')", context);
  const folderInfo = context.NCSharing.buildShareFolderInfo("Team Shares", "Client/Project", referenceDate);
  assert(folderInfo.relativeFolder === "Team Shares/20260703_Client_Project", "Share folder info should keep base folder and sanitize share name");

  const shareInfo = {
    shareUrl: "https://cloud.example.com/nc/s/abc123",
    password: "Secret123",
    expireDate: "2026-07-31",
    permissions: { read: true, create: false, write: true, delete: false }
  };
  const renderOptions = {
    zipDownload: true,
    permissions: shareInfo.permissions
  };

  const html = await context.NCSharing.buildHtmlBlock(shareInfo, renderOptions);
  const plainText = await context.NCSharing.buildPlainTextBlock(shareInfo, renderOptions);

  assert(html.includes("https://cloud.example.com/nc/s/abc123/download"), "HTML share block should keep subfolder path in ZIP download URL");
  assert(plainText.includes("ZIP download: https://cloud.example.com/nc/s/abc123/download"), "Plaintext share block should label the attachment URL as a ZIP download");
  assert(plainText.includes("Download the shared files as a ZIP archive"), "Plaintext attachment block should explain ZIP download behavior");
  assert(!html.includes("https://cloud.example.com/s/abc123/download"), "HTML share block must not drop the Nextcloud subfolder path");
  assert(!plainText.includes("https://cloud.example.com/s/abc123/download"), "Plaintext share block must not drop the Nextcloud subfolder path");

  console.log("[OK] url-subfolder-contract-check passed");
}

run().catch((error) => {
  console.error("[FAIL] url-subfolder-contract-check", error);
  process.exitCode = 1;
});
