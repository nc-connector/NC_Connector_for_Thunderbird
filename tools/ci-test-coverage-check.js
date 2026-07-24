"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  assert,
  readText
} = require("./review-check-utils");

const ROOT = path.resolve(__dirname, "..");
const REVIEW_RUNNER = "tools/check-review-clean.js";
const WEBEXT_RUNNER = "tools/webext-linter-check.js";
const WEBEXT_DEPENDENCY_CHECK = "tools/webext-linter-dependency-check.js";

function checkReviewAggregator(){
  const reviewSource = readText(REVIEW_RUNNER);
  const checkFiles = fs.readdirSync(path.join(ROOT, "tools"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith("-check.js"))
    .map((entry) => `tools/${entry.name}`)
    .filter((relativePath) => ![
      REVIEW_RUNNER,
      WEBEXT_RUNNER,
      WEBEXT_DEPENDENCY_CHECK
    ].includes(relativePath))
    .sort();

  const missing = checkFiles.filter((relativePath) => !reviewSource.includes(`"${relativePath}"`));
  assert(
    missing.length === 0,
    `All tool checks must run through test:review; missing: ${missing.join(", ")}`
  );
}

function checkPackageScripts(){
  const packageJson = JSON.parse(readText("package.json"));
  const scripts = packageJson.scripts || {};
  assert(
    scripts.test === "npm run test:review && npm run test:webext-linter",
    "The default npm test command must run the complete review and WebExtension linter"
  );
  assert(
    scripts["test:ci-coverage"] === "node tools/ci-test-coverage-check.js",
    "The CI coverage check needs an explicit package script"
  );
  assert(
    scripts["test:webext-linter"]
      === "npm run webext-linter:update && npm run webext-linter:audit && npm run webext-linter:check",
    "The WebExtension linter command must update, audit, and review"
  );
}

function checkGithubWorkflow(){
  const workflow = readText(".github/workflows/thunderbird-review.yml");
  const requiredCommands = [
    "run: npm run test:review",
    "run: npm run webext-linter:update",
    "run: npm run webext-linter:audit",
    "run: npm run webext-linter:check"
  ];
  const missing = requiredCommands.filter((command) => !workflow.includes(command));
  assert(
    missing.length === 0,
    `Thunderbird review workflow is missing required commands: ${missing.join(", ")}`
  );
}

checkReviewAggregator();
checkPackageScripts();
checkGithubWorkflow();
console.log("[OK] ci-test-coverage-check passed");
