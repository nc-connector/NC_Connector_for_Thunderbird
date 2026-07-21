/**
 * Aggregate local review checks for NC Connector Thunderbird.
 *
 * Run:
 *   node tools/check-review-clean.js
 */
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CHECKS = [
  "tools/ical-contract-check.js",
  "tools/share-plaintext-contract-check.js",
  "tools/policy-contract-check.js",
  "tools/policy-editability-check.js",
  "tools/password-delivery-contract-check.js",
  "tools/url-subfolder-contract-check.js",
  "tools/signature-compose-settle-check.js",
  "tools/i18n-locale-parity-check.js",
  "tools/i18n-no-english-placeholders-check.js",
  "tools/i18n-key-usage-check.js",
  "tools/release-consistency-check.js"
];

/**
 * Execute one node-based check script.
 * @param {string} relativeScriptPath
 * @returns {void}
 */
function runCheck(relativeScriptPath){
  const scriptPath = path.join(ROOT, relativeScriptPath);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    stdio: "inherit"
  });
  if (result.status !== 0){
    throw new Error(`Review check failed: ${relativeScriptPath}`);
  }
}

function run(){
  for (const check of CHECKS){
    runCheck(check);
  }
  console.log("[OK] check-review-clean passed");
}

run();
