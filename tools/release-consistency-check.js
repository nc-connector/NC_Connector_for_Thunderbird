"use strict";

const { assert, readJson, readText } = require("./review-check-utils");

function escapeRegExp(value){
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function run(){
  const manifest = readJson("manifest.json");
  const version = String(manifest.version || "").trim();
  const gecko = manifest.browser_specific_settings?.gecko || {};
  const minVersion = String(gecko.strict_min_version || "").trim();
  const maxVersion = String(gecko.strict_max_version || "").trim();
  const changelog = readText("CHANGELOG.md");
  const reviewNotes = readText("docs/ATN_REVIEW_NOTES.md");
  const development = readText("docs/DEVELOPMENT.md");

  assert(/^\d+\.\d+\.\d+$/.test(version), "manifest.json version should use x.y.z format");
  assert(new RegExp(`^##\\s+${escapeRegExp(version)}\\s*$`, "m").test(changelog), "CHANGELOG.md should contain a heading for manifest version");
  assert(reviewNotes.includes(`version ${version}`) || reviewNotes.includes(`- ${version}`) || reviewNotes.includes(`# Reviewer Notes - ${version}`), "ATN_REVIEW_NOTES.md should reference manifest version");

  assert(minVersion === "115.0", "strict_min_version should stay aligned with supported ESR 115");
  assert(maxVersion === "153.*", "strict_max_version should stay aligned with supported ESR 153");
  assert(development.includes(`strict_min_version: "${minVersion}"`), "DEVELOPMENT.md should document strict_min_version");
  assert(development.includes(`strict_max_version: "${maxVersion}"`), "DEVELOPMENT.md should document strict_max_version");
  assert(changelog.includes("Thunderbird ESR 115") && changelog.includes("ESR 153"), "CHANGELOG.md should document supported ESR range");

  console.log("[OK] release-consistency-check passed");
}

run();
