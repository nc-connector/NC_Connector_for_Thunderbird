"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assert, readText } = require("./review-check-utils");

const ROOT = path.resolve(__dirname, "..");
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".md", ".yml", ".yaml"]);
const EXCLUDED_DIRECTORIES = new Set([".git", "build", "dist", "node_modules", "vendor"]);
const ADMIN_LINK_PATTERN = /(?:https:\/\/github\.com\/nc-connector\/NC_Connector_for_Thunderbird\/blob\/main\/)?(?:docs\/)?ADMIN\.md#([A-Za-z0-9%._~-]+)/g;
// Published bookmarks and homepage links must survive changes to the guide's structure.
const LEGACY_ADMIN_ANCHORS = [
  "administration-guide-nc-connector-for-thunderbird",
  "administration-guide--nc-connector-for-thunderbird",
  "contents",
  "1-service-scope",
  "2-requirements",
  "21-supported-products",
  "22-network-access",
  "23-nextcloud-administration",
  "3-install-update-and-roll-back",
  "31-individual-installation",
  "32-managed-update",
  "33-rollback",
  "4-initial-configuration",
  "41-nextcloud-connection",
  "42-sharing-and-attachment-automation",
  "vfs-sources-and-provider-access",
  "43-talk-and-system-address-book",
  "44-optional-backend-policies",
  "45-debug-logging",
  "5-filelink-upload-operation",
  "51-user-visible-flow",
  "52-cancellation-and-cleanup",
  "53-saved-drafts",
  "54-retries-and-server-throttling",
  "55-mixed-local-nextcloud-and-vfs-sources",
  "6-enterprise-rollout",
  "61-add-on-id-and-policy-locations",
  "62-force-install-example",
  "63-attachment-policy-example",
  "64-managed-nextcloud-url",
  "65-rollout-verification",
  "66-default-values-source",
  "67-managed-installation-cannot-start-an-action",
  "7-operational-checks",
  "8-troubleshooting",
  "81-upload-is-rejected-before-it-starts",
  "82-progress-remains-at-zero",
  "83-upload-stalls-or-repeatedly-fails",
  "84-insufficient-storage-507",
  "85-folder-name-collision",
  "86-cleanup-did-not-complete",
  "87-a-saved-share-draft-cannot-be-sent",
  "88-public-talk-links-work-only-with-indexphp",
  "9-logging-and-support-data",
  "10-backup-and-recovery",
  "11-nextcloud-pretty-urls",
  "111-quick-check",
  "112-nginx",
  "113-apache"
];

function githubHeadingSlug(heading){
  return String(heading || "")
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .replace(/\s+/g, "-");
}

function collectAdminAnchors(content){
  const anchors = new Set();
  const counts = new Map();
  for (const match of content.matchAll(/<a\b[^>]*\bid=(["'])([^"']+)\1[^>]*>/gi)){
    anchors.add(match[2]);
  }
  for (const line of content.split(/\r?\n/)){
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
  const anchors = collectAdminAnchors(readText("docs/ADMIN.md"));
  const failures = [];
  let linkCount = 0;

  for (const anchor of LEGACY_ADMIN_ANCHORS){
    if (!anchors.has(anchor)){
      failures.push(`docs/ADMIN.md: missing published anchor #${anchor}`);
    }
  }

  for (const file of ["options.html", "ui/talkDialog.html", "ui/nextcloudSharingWizard.html"]){
    const content = readText(file);
    const link = content.match(/<a\b[^>]*\bid="policyWarningAdminLink"[^>]*>/)?.[0] || "";
    assert(link && /\bhidden\b/.test(link), `${file}: license management links must start hidden`);
    assert(!/\bhref\s*=/.test(link), `${file}: license management links must have no static target`);
    assert(/\brel="noopener noreferrer"/.test(link), `${file}: backend links must isolate the opened page`);
    assert(content.includes("is-informational") && content.includes("#b8860b"), `${file}: informational notices must use their yellow warning style`);
  }
  for (const file of ["options.js", "ui/talkDialog.js", "ui/nextcloudSharingWizard.js"]){
    assert(!readText(file).includes("POLICY_ADMIN_URL"), `${file}: license links must use the configured backend rather than a fixed guide`);
  }

  for (const filePath of listTextFiles(ROOT)){
    const content = fs.readFileSync(filePath, "utf8");
    const patterns = [ADMIN_LINK_PATTERN];
    if (filePath === path.join(ROOT, "docs", "ADMIN.md")){
      patterns.push(/\]\(#([^\s)]+)\)/g);
    }
    for (const pattern of patterns){
      for (const match of content.matchAll(pattern)){
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
  }

  assert(linkCount > 0, "No ADMIN section links found");
  assert(failures.length === 0, failures.join("\n"));
  console.log(`[OK] admin-link-check passed (${linkCount} links)`);
}

run();
