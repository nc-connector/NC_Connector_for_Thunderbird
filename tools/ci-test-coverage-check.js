"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  assert,
  readText
} = require("./review-check-utils");

const ROOT = path.resolve(__dirname, "..");
const REVIEW_RUNNER = "tools/check-review-clean.js";
const WEBEXT_RUNNER = "tools/webext-linter-check.js";

function checkReviewAggregator(){
  const reviewSource = readText(REVIEW_RUNNER);
  const checkFiles = fs.readdirSync(path.join(ROOT, "tools"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith("-check.js"))
    .map((entry) => `tools/${entry.name}`)
    .filter((relativePath) => ![
      REVIEW_RUNNER,
      WEBEXT_RUNNER
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
      === "npm run webext-linter:update && npm run webext-linter:check",
    "The WebExtension linter command must update and review"
  );
  assert(
    scripts["webext-linter"] === "node node_modules/webext-linter/verify.js --eslint",
    "Direct WebExtension linter reviews must include ESLint"
  );
  assert(!packageJson.overrides, "The linter must use upstream dependency versions without local overrides");
}

function checkWebextLinterArguments(){
  for (const status of [0, 1, 2]){
    const calls = [];
    let exitCode;
    vm.runInNewContext(readText(WEBEXT_RUNNER), {
      __dirname: path.join(ROOT, "tools"),
      console,
      process: {
        argv: [process.execPath, WEBEXT_RUNNER, "candidate.xpi"],
        execPath: process.execPath,
        exit(code){ exitCode = code; }
      },
      require(name){
        if (name === "fs"){
          return {
            existsSync: () => true,
            statSync: () => ({ isDirectory: () => false })
          };
        }
        if (name === "child_process"){
          return {
            spawnSync(command, args, options){
              calls.push({ command, args, options });
              return { status };
            }
          };
        }
        return require(name);
      }
    }, { filename: WEBEXT_RUNNER });
    assert(calls.length === 1, "The WebExtension linter runner must invoke one verifier");
    assert(calls[0].args.includes("--eslint"), "The WebExtension linter runner must enable ESLint");
    assert(calls[0].args.includes("--allow-experiments"), "The WebExtension linter runner must allow the add-on's Experiments");
    assert(calls[0].options.stdio === "inherit", "The WebExtension linter runner must retain all verifier output");
    assert(exitCode === status, "The WebExtension linter runner must retain the verifier exit code");
  }
}

function checkGithubWorkflow(){
  const workflow = readText(".github/workflows/thunderbird-review.yml");
  const requiredCommands = [
    "run: npm run test:review",
    "run: npm run webext-linter:update",
    "run: npm run webext-linter:check"
  ];
  const missing = requiredCommands.filter((command) => !workflow.includes(command));
  assert(
    missing.length === 0,
    `Thunderbird review workflow is missing required commands: ${missing.join(", ")}`
  );
}

function checkWebextPayloadFilter(){
  const context = {
    __dirname: path.join(ROOT, "tools"),
    require,
    process,
    console
  };
  const source = readText(WEBEXT_RUNNER).split("if (!fs.existsSync(linterVerify))")[0];
  vm.runInNewContext(source, context, { filename: WEBEXT_RUNNER });
  for (const relativePath of [
    "WEBEXT-LINTER-CACHE/sources/sources.json",
    "node_modules/webext-linter/verify.js",
    "candidate.xpi.extracted/manifest.json",
    ".tmp/review.log"
  ]){
    assert(!context.shouldCopySource(path.join(ROOT, relativePath)), `Exclude review artifact: ${relativePath}`);
  }
  for (const relativePath of ["manifest.json", "vendor/purify.js", "modules/htmlSanitizer.js"]){
    assert(context.shouldCopySource(path.join(ROOT, relativePath)), `Keep runtime file: ${relativePath}`);
  }
}

checkReviewAggregator();
checkPackageScripts();
checkWebextLinterArguments();
checkWebextPayloadFilter();
checkGithubWorkflow();
console.log("[OK] ci-test-coverage-check passed");
