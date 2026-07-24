"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROOT,
  assert,
  readText
} = require("./review-check-utils");

function run(){
  const purifyPath = path.join(ROOT, "vendor", "purify.js");
  const source = fs.readFileSync(purifyPath);
  const sha256 = crypto.createHash("sha256").update(source).digest("hex").toUpperCase();
  const vendorDoc = readText("VENDOR.md");
  const manifest = JSON.parse(readText("manifest.json"));
  assert(
    source.toString("utf8", 0, 80).includes("DOMPurify 3.4.12"),
    "The bundled sanitizer must identify DOMPurify 3.4.12"
  );
  assert(
    sha256 === "0CB2FF0EB405F7D675FFF04AE98ED277BB9FB10D3DF33F29AA8BE398E6E9F1B2",
    "The bundled sanitizer must match the official DOMPurify 3.4.12 browser distribution"
  );
  assert(vendorDoc.includes("dompurify/-/dompurify-3.4.12.tgz"), "VENDOR.md must link the exact DOMPurify package");
  assert(vendorDoc.includes(sha256), "VENDOR.md must record the bundled DOMPurify SHA-256");
  const backgroundScripts = manifest?.background?.scripts || [];
  assert(
    backgroundScripts.indexOf("vendor/purify.js") >= 0
      && backgroundScripts.indexOf("vendor/purify.js") < backgroundScripts.indexOf("modules/htmlSanitizer.js"),
    "Background must load local DOMPurify before the sanitizer wrapper"
  );
  for (const relativeHtmlPath of [
    "options.html",
    "ui/talkDialog.html",
    "ui/nextcloudSharingWizard.html"
  ]){
    const html = readText(relativeHtmlPath);
    const purifyIndex = html.indexOf("vendor/purify.js");
    const sanitizerIndex = html.indexOf("modules/htmlSanitizer.js");
    assert(
      purifyIndex >= 0 && sanitizerIndex > purifyIndex,
      `${relativeHtmlPath} must load local DOMPurify before the sanitizer wrapper`
    );
  }
  console.log("[OK] vendor-security-check passed");
}

try{
  run();
}catch(error){
  console.error("[FAIL] vendor-security-check", error);
  process.exitCode = 1;
}
