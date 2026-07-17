#!/usr/bin/env node
/**
 * Runs Thunderbird's review linter against a clean add-on folder payload.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const linterVerify = path.join(
  projectRoot,
  "node_modules",
  "@thunderbirdops",
  "webext-linter",
  "verify.js"
);

function run(command, args, cwd = projectRoot){
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit"
  });
  if (result.status !== 0){
    process.exit(result.status || 1);
  }
}

function resolveTarget(){
  const explicit = process.argv[2] || ".";
  return path.resolve(projectRoot, explicit);
}

function shouldCopySource(source){
  const rel = path.relative(projectRoot, source).replace(/\\/g, "/");
  if (!rel){
    return true;
  }
  const first = rel.split("/")[0];
  if (
      first === "node_modules" ||
      first === "tools" ||
      first === ".tmp" ||
      first === ".git" ||
      first === ".github" ||
      first === ".cdn-lookup-cache" ||
    first === ".experiments-cache" ||
    first === ".library-hashes-cache" ||
    first === ".schema-cache"
  ){
    return false;
  }
  const name = path.basename(source);
  return (
    !name.startsWith(".") &&
    name !== "package.json" &&
    name !== "package-lock.json" &&
    !name.endsWith(".xpi") &&
    !/^webext-linter-.*\.json$/i.test(name) &&
    !/^npm-debug\.log/i.test(name)
  );
}

function prepareFolderTarget(target){
  if (!fs.statSync(target).isDirectory()){
    return {
      target,
      cwd: projectRoot,
      cleanup: () => {}
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nc4tb-webext-linter-"));
  fs.cpSync(target, tempRoot, {
    recursive: true,
    filter: shouldCopySource
  });
  return {
    target: tempRoot,
    cwd: tempRoot,
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true })
  };
}

if (!fs.existsSync(linterVerify)){
  console.error("[webext-linter] Current main package is missing. Run `npm run webext-linter:update` first.");
  process.exit(1);
}

const requestedTarget = resolveTarget();
if (!fs.existsSync(requestedTarget)){
  console.error(`[webext-linter] Target not found: ${requestedTarget}`);
  process.exit(1);
}

const prepared = prepareFolderTarget(requestedTarget);
try{
  run(process.execPath, [
    linterVerify,
    prepared.target,
    "--allow-experiments",
    "--report-format",
    "text"
  ], prepared.cwd);
}finally{
  prepared.cleanup();
}
