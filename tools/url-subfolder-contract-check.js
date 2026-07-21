"use strict";

const vm = require("node:vm");
const { assert, loadScript, readText } = require("./review-check-utils");

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
    sharing_error_zip_url_invalid: "The ZIP download URL could not be derived from the Nextcloud share URL. Nothing was inserted into the message.",
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
    NCLogContext: {
      safeConsoleError: () => {}
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
    shareToken: "abc123",
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
  const sharePageHtml = await context.NCSharing.buildHtmlBlock(shareInfo, {});
  const sharePagePlainText = await context.NCSharing.buildPlainTextBlock(shareInfo, {});
  const indexPhpZipPlainText = await context.NCSharing.buildPlainTextBlock({
    ...shareInfo,
    shareUrl: "https://cloud.example.com/nc/index.php/s/abc123"
  }, renderOptions);
  const trailingSlashZipPlainText = await context.NCSharing.buildPlainTextBlock({
    ...shareInfo,
    shareUrl: "https://cloud.example.com/nc/s/abc123/?source=mail#details"
  }, renderOptions);
  const encodedTokenZipPlainText = await context.NCSharing.buildPlainTextBlock({
    ...shareInfo,
    shareUrl: "https://cloud.example.com/nc/s/abc%20123",
    shareToken: "abc 123"
  }, renderOptions);

  assert(html.includes("https://cloud.example.com/nc/s/abc123/download"), "HTML share block should keep subfolder path in ZIP download URL");
  assert(plainText.includes("ZIP download: https://cloud.example.com/nc/s/abc123/download"), "Plaintext share block should label the attachment URL as a ZIP download");
  assert(plainText.includes("Download the shared files as a ZIP archive"), "Plaintext attachment block should explain ZIP download behavior");
  assert(!html.includes("https://cloud.example.com/s/abc123/download"), "HTML share block must not drop the Nextcloud subfolder path");
  assert(!plainText.includes("https://cloud.example.com/s/abc123/download"), "Plaintext share block must not drop the Nextcloud subfolder path");
  assert(sharePageHtml.includes("https://cloud.example.com/nc/s/abc123"), "Share-page HTML must preserve the canonical URL");
  assert(!sharePageHtml.includes("/abc123/download"), "Share-page HTML must not append the ZIP path");
  assert(sharePagePlainText.includes("Nextcloud link: https://cloud.example.com/nc/s/abc123"), "Share-page plaintext must use the canonical URL and label");
  assert(
    indexPhpZipPlainText.includes("https://cloud.example.com/nc/index.php/s/abc123/download"),
    "ZIP plaintext must preserve subfolder and index.php share paths"
  );
  assert(
    trailingSlashZipPlainText.includes("https://cloud.example.com/nc/s/abc123/download")
      && !trailingSlashZipPlainText.includes("source=mail")
      && !trailingSlashZipPlainText.includes("#details"),
    "ZIP plaintext must accept a trailing slash and remove query or fragment data"
  );
  assert(
    encodedTokenZipPlainText.includes("https://cloud.example.com/nc/s/abc%20123/download"),
    "ZIP token validation must compare the decoded URL path token with the OCS share token"
  );

  const invalidZipUrls = [
    "https://cloud.example.com/public/abc123",
    "ftp://cloud.example.com/nc/s/abc123",
    "https://cloud.example.com/nc/s/abc123/preview"
  ];
  for (const invalidZipUrl of invalidZipUrls){
    for (const builder of [context.NCSharing.buildHtmlBlock, context.NCSharing.buildPlainTextBlock]){
      let visibleError = null;
      try{
        await builder({ ...shareInfo, shareUrl: invalidZipUrl }, renderOptions);
      }catch(error){
        visibleError = error;
      }
      assert(visibleError && typeof visibleError.message === "string", "Invalid ZIP share URLs must stop rendering");
      assert(
        visibleError.message === makeTranslations().sharing_error_zip_url_invalid,
        "Invalid ZIP share URLs must expose the localized user-facing error"
      );
    }
  }

  for (const builder of [context.NCSharing.buildHtmlBlock, context.NCSharing.buildPlainTextBlock]){
    let visibleError = null;
    try{
      await builder({ ...shareInfo, shareUrl: "https://cloud.example.com/nc/s/different" }, renderOptions);
    }catch(error){
      visibleError = error;
    }
    assert(visibleError && typeof visibleError.message === "string", "A ZIP URL/OCS token mismatch must stop rendering");
    assert(
      visibleError.message === makeTranslations().sharing_error_zip_url_invalid,
      "A ZIP URL/OCS token mismatch must expose the localized user-facing error"
    );
  }

  const sharingSource = readText("modules/ncSharing.js");
  assert(
    sharingSource.includes('shareToken: share.token || ""'),
    "The OCS share token must be transported in the share result payload"
  );

  console.log("[OK] url-subfolder-contract-check passed");
}

run().catch((error) => {
  console.error("[FAIL] url-subfolder-contract-check", error);
  process.exitCode = 1;
});
