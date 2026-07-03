"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function assert(condition, message){
  if (!condition){
    throw new Error(message);
  }
}

function readText(relativePath){
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath){
  return JSON.parse(readText(relativePath));
}

function listFiles(relativeDir, options = {}){
  const baseDir = path.join(ROOT, relativeDir);
  const ignoreDirs = new Set(options.ignoreDirs || []);
  const results = [];

  function walk(currentDir){
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })){
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(ROOT, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()){
        if (!ignoreDirs.has(entry.name)){
          walk(fullPath);
        }
        continue;
      }
      if (!options.extensions || options.extensions.includes(path.extname(entry.name))){
        results.push(relativePath);
      }
    }
  }

  walk(baseDir);
  return results.sort();
}

function loadScript(relativePath, context, suffix = ""){
  const source = readText(relativePath) + suffix;
  vm.runInContext(source, context, { filename: relativePath });
}

module.exports = {
  ROOT,
  assert,
  readText,
  readJson,
  listFiles,
  loadScript
};
