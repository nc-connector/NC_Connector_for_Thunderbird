"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { assert } = require("./review-check-utils");

const ROOT = path.resolve(__dirname, "..");
const LINTER_PACKAGE = path.join(
  ROOT,
  "node_modules",
  "@thunderbirdops",
  "webext-linter",
  "package.json"
);

function readJson(filePath){
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseVersion(value){
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || ""));
  assert(match, `Invalid package version: ${value}`);
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right){
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++){
    if (a[index] !== b[index]){
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

function resolveDependencyVersion(requireFromLinter, packageName){
  const packagePath = requireFromLinter.resolve(`${packageName}/package.json`);
  return {
    packagePath,
    version: readJson(packagePath).version
  };
}

function run(){
  assert(fs.existsSync(LINTER_PACKAGE), "Current Thunderbird webext-linter is not installed");
  const requireFromLinter = createRequire(LINTER_PACKAGE);
  const admZip = resolveDependencyVersion(requireFromLinter, "adm-zip");
  const fastUri = resolveDependencyVersion(requireFromLinter, "fast-uri");

  assert(
    compareVersions(admZip.version, "0.6.0") >= 0,
    `webext-linter resolves vulnerable adm-zip ${admZip.version}`
  );
  assert(
    compareVersions(fastUri.version, "3.1.4") >= 0,
    `webext-linter resolves vulnerable fast-uri ${fastUri.version}`
  );

  console.log(
    `[OK] webext-linter dependency check passed `
      + `(adm-zip ${admZip.version}, fast-uri ${fastUri.version})`
  );
}

run();
