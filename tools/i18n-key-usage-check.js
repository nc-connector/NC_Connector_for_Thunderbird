"use strict";

const path = require("node:path");
const { assert, listFiles, readJson, readText } = require("./review-check-utils");

const MESSAGE_KEYS = new Set(Object.keys(readJson("_locales/en/messages.json")));
const SOURCE_DIRS = [".", "modules", "ui"];
const SKIP_DIRS = new Set([
  ".git",
  ".github",
  ".tmp",
  "node_modules",
  "_locales",
  "docs",
  "experiments",
  "tests",
  "tools",
  "vendor"
]);

function addMatches(source, regex, usedKeys){
  let match = null;
  while ((match = regex.exec(source))){
    const key = match.groups?.key || match[1];
    if (key && !key.startsWith("@@")){
      usedKeys.add(key);
    }
  }
}

function collectSourceFiles(){
  const files = new Set();
  for (const dir of SOURCE_DIRS){
    for (const file of listFiles(dir, {
      extensions: [".js", ".html", ".json"],
      ignoreDirs: SKIP_DIRS
    })){
      if (file === "package.json" || file === "package-lock.json"){
        continue;
      }
      files.add(file);
    }
  }
  return Array.from(files).sort();
}

function collectUsedKeys(){
  const usedKeys = new Map();
  const files = collectSourceFiles();
  for (const file of files){
    const source = readText(file);
    const fileKeys = new Set();

    addMatches(source, /__MSG_(?<key>[A-Za-z0-9_@.-]+?)__/g, fileKeys);
    addMatches(source, /data-i18n(?:-[a-z-]+)?=["'](?<key>[A-Za-z0-9_.-]+)["']/g, fileKeys);
    addMatches(source, /\b(?:i18n|bgI18n)\(\s*["'`](?<key>[A-Za-z0-9_.-]+)["'`]/g, fileKeys);
    addMatches(source, /\bbrowser\.i18n\.getMessage\(\s*["'`](?<key>[A-Za-z0-9_.-]+)["'`]/g, fileKeys);
    addMatches(source, /\bNCI18n(?:Override)?\.(?:translate|tInLang)\(\s*(?:[^,]+,\s*)?["'`](?<key>[A-Za-z0-9_.-]+)["'`]/g, fileKeys);

    for (const key of fileKeys){
      if (!usedKeys.has(key)){
        usedKeys.set(key, []);
      }
      usedKeys.get(key).push(file);
    }
  }
  return usedKeys;
}

function run(){
  const usedKeys = collectUsedKeys();
  const missing = [];
  for (const [key, files] of usedKeys.entries()){
    if (!MESSAGE_KEYS.has(key)){
      missing.push({ key, files });
    }
  }

  if (missing.length){
    for (const item of missing){
      console.error(`[i18n] Missing key ${item.key}`);
      for (const file of item.files){
        console.error(`  ${file}`);
      }
    }
  }

  assert(missing.length === 0, `Missing ${missing.length} used i18n key(s) from _locales/en/messages.json`);
  console.log(`[OK] i18n-key-usage-check passed (${usedKeys.size} literal key(s) checked)`);
}

run();
