"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assert, readText } = require("./review-check-utils");

const ROOT = path.resolve(__dirname, "..");
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".md", ".yml", ".yaml"]);
const EXCLUDED_DIRECTORIES = new Set([".git", "build", "dist", "node_modules", "vendor"]);
const ADMIN_LINK_PATTERN = /(?:https:\/\/github\.com\/nc-connector\/NC_Connector_for_Thunderbird\/blob\/main\/)?docs\/ADMIN\.md#([A-Za-z0-9%._~-]+)/g;

function githubHeadingSlug(heading){
  return String(heading || "")
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .replace(/\s+/g, "-");
}

function collectAdminAnchors(){
  const anchors = new Set();
  const counts = new Map();
  for (const line of readText("docs/ADMIN.md").split(/\r?\n/)){
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match){
      continue;
    }
    const base = githubHeadingSlug(match[2]);
    if (!base){
      continue;
    }
    const duplicateIndex = counts.get(base) || 0;
    counts.set(base, duplicateIndex + 1);
    anchors.add(duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`);
  }
  return anchors;
}

function listTextFiles(directory){
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })){
    if (entry.isDirectory()){
      if (!EXCLUDED_DIRECTORIES.has(entry.name)){
        files.push(...listTextFiles(path.join(directory, entry.name)));
      }
      continue;
    }
    if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())){
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function run(){
  const anchors = collectAdminAnchors();
  const failures = [];
  let linkCount = 0;

  for (const filePath of listTextFiles(ROOT)){
    const content = fs.readFileSync(filePath, "utf8");
    for (const match of content.matchAll(ADMIN_LINK_PATTERN)){
      linkCount++;
      let anchor = "";
      try{
        anchor = decodeURIComponent(match[1]).toLowerCase();
      }catch(error){
        failures.push(`${path.relative(ROOT, filePath)}: invalid encoded anchor ${match[1]}`);
        continue;
      }
      if (!anchors.has(anchor)){
        failures.push(`${path.relative(ROOT, filePath)}: missing ADMIN anchor #${anchor}`);
      }
    }
  }

  assert(linkCount > 0, "No ADMIN section links found");
  assert(failures.length === 0, failures.join("\n"));
  console.log(`[OK] admin-link-check passed (${linkCount} links)`);
}

run();
