/**
 * Locale parity checks for NC Connector i18n catalogs.
 *
 * Run:
 *   node tools/i18n-locale-parity-check.js
 *
 * Fails when any locale misses keys from `_locales/en/messages.json`.
 * Extra locale keys are reported as warnings.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOCALES_DIR = path.join(ROOT, "_locales");
const EN_FILE = path.join(LOCALES_DIR, "en", "messages.json");

/**
 * Read and parse JSON file.
 * @param {string} filePath
 * @returns {any}
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Return sorted locale folders containing a messages.json.
 * @returns {string[]}
 */
function getLocaleFolders() {
  const entries = fs.readdirSync(LOCALES_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(LOCALES_DIR, name, "messages.json")))
    .sort();
}

function run() {
  const en = readJson(EN_FILE);
  const enKeys = Object.keys(en);
  const locales = getLocaleFolders();
  let missingKeyCount = 0;

  for (const locale of locales) {
    if (locale === "en") {
      continue;
    }
    const file = path.join(LOCALES_DIR, locale, "messages.json");
    const data = readJson(file);
    const keys = Object.keys(data);

    const missing = enKeys.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !enKeys.includes(key));

    if (missing.length) {
      missingKeyCount += missing.length;
      console.error(`[i18n] ${locale}: missing ${missing.length} key(s)`);
      console.error("  " + missing.join(", "));
    }
    if (extra.length) {
      console.warn(`[i18n] ${locale}: extra ${extra.length} key(s)`);
      console.warn("  " + extra.join(", "));
    }
  }

  if (missingKeyCount > 0) {
    throw new Error(`i18n parity failed: ${missingKeyCount} missing locale key(s).`);
  }

  console.log("[OK] i18n-locale-parity-check passed");
}

run();

