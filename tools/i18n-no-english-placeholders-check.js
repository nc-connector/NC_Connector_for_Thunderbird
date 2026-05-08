/**
 * Guard check for accidental English placeholders in non-English locales.
 *
 * Run:
 *   node tools/i18n-no-english-placeholders-check.js
 *
 * Rules:
 * - Fail when a non-English locale copies an English message verbatim,
 *   unless that key is explicitly allowlisted.
 * - Fail when placeholder markers are found (TODO/TBD/TRANSLATE_ME/FIXME).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOCALES_DIR = path.join(ROOT, "_locales");
const EN_FILE = path.join(LOCALES_DIR, "en", "messages.json");

const ALLOWED_IDENTICAL_KEYS_GLOBAL = new Set([
  "extName",
  "ui_button_ok",
  "ui_description_help_url",
  "talk_dialog_title",
  "sharing_password_mail_notify_title",
  "options_base_url_placeholder",
  "options_about_license_value",
  "options_sharing_attachments_offer_suffix",
  "options_about_homepage_link"
]);

const ALLOWED_IDENTICAL_KEYS_BY_LOCALE = {
  cs: new Set([
    "options_about_copyright_label"
  ]),
  de: new Set([
    "ui_create_password_placeholder",
    "options_about_version_label",
    "options_about_copyright_label",
    "options_about_homepage_label",
    "sharing_files_table_status"
  ]),
  es: new Set([
    "options_tab_general",
    "sharing_status_error_row"
  ]),
  fr: new Set([
    "options_tab_signature"
  ]),
  it: new Set([
    "options_tab_debug",
    "options_about_copyright_label",
    "sharing_file_type_file"
  ]),
  nl: new Set([
    "sharing_files_table_type",
    "sharing_files_table_status"
  ]),
  pl: new Set([
    "sharing_files_table_status"
  ]),
  pt_BR: new Set([
    "sharing_files_table_status"
  ])
};

const PLACEHOLDER_MARKER = /(^|[^A-Z])(TODO|TBD|TRANSLATE_ME|PLACEHOLDER|FIXME)([^A-Z]|$)/;

/**
 * Read and parse a locale catalog.
 * @param {string} filePath
 * @returns {Record<string, {message?: string}>}
 */
function readJson(filePath){
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Return sorted locale folders containing messages.json.
 * @returns {string[]}
 */
function getLocaleFolders(){
  const entries = fs.readdirSync(LOCALES_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(LOCALES_DIR, name, "messages.json")))
    .sort();
}

/**
 * Normalize string for equality comparison.
 * @param {unknown} value
 * @returns {string}
 */
function normalize(value){
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Check whether one key is allowed to be identical to en for this locale.
 * @param {string} locale
 * @param {string} key
 * @returns {boolean}
 */
function isAllowedIdentical(locale, key){
  if (ALLOWED_IDENTICAL_KEYS_GLOBAL.has(key)){
    return true;
  }
  return !!ALLOWED_IDENTICAL_KEYS_BY_LOCALE[locale]?.has(key);
}

function run(){
  const en = readJson(EN_FILE);
  const enKeys = Object.keys(en);
  const locales = getLocaleFolders().filter((locale) => locale !== "en");

  const identicalViolations = [];
  const placeholderViolations = [];

  for (const locale of locales){
    const localeFile = path.join(LOCALES_DIR, locale, "messages.json");
    const data = readJson(localeFile);

    for (const key of enKeys){
      const enMsg = normalize(en[key]?.message);
      const localeMsg = normalize(data[key]?.message);

      if (!localeMsg){
        continue;
      }

      if (PLACEHOLDER_MARKER.test(localeMsg)){
        placeholderViolations.push({ locale, key, message: localeMsg });
      }

      if (enMsg && localeMsg === enMsg && !isAllowedIdentical(locale, key)){
        identicalViolations.push({ locale, key, message: localeMsg });
      }
    }
  }

  if (identicalViolations.length){
    console.error("[i18n] non-en messages identical to en (not allowlisted):");
    for (const violation of identicalViolations){
      console.error(`  - ${violation.locale} :: ${violation.key} :: ${violation.message}`);
    }
  }

  if (placeholderViolations.length){
    console.error("[i18n] placeholder markers found in locale messages:");
    for (const violation of placeholderViolations){
      console.error(`  - ${violation.locale} :: ${violation.key} :: ${violation.message}`);
    }
  }

  if (identicalViolations.length || placeholderViolations.length){
    throw new Error(
      `i18n english-placeholder check failed: ` +
      `${identicalViolations.length} identical violation(s), ` +
      `${placeholderViolations.length} placeholder violation(s).`
    );
  }

  console.log("[OK] i18n-no-english-placeholders-check passed");
}

run();
