/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Compose share insertion runtime module.
 * Owns mode-aware insertion and plain-text normalization for sharing blocks.
 */

/**
 * Normalize permission markers for plain-text rendering.
 * @param {string} value
 * @returns {string}
 */
function normalizeSharingPermissionMarkers(value){
  return String(value || "")
    .replace(/[✓✔✅☑]/g, "[x]")
    .replace(/[✗✘✕✖❌☒]/g, "[ ]");
}

/**
 * Normalize text for case-insensitive permission matching.
 * @param {string} value
 * @returns {string}
 */
function normalizeSharingPermissionTerm(value){
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[：:]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isSharingPermissionMarker(line){
  const normalized = normalizeSharingPermissionTerm(line);
  return normalized === "[x]" || normalized === "[ ]";
}

/**
 * Build localized permission action terms.
 * @returns {Set<string>}
 */
function getSharingPermissionActionTerms(){
  const terms = new Set([
    "read",
    "upload",
    "modify",
    "delete",
    "create",
    "write"
  ]);
  const keys = [
    "sharing_permission_read",
    "sharing_permission_create",
    "sharing_permission_write",
    "sharing_permission_delete"
  ];
  if (typeof bgI18n === "function"){
    for (const key of keys){
      const translated = normalizeSharingPermissionTerm(bgI18n(key));
      if (translated){
        terms.add(translated);
      }
    }
  }
  return terms;
}

/**
 * Check if one line is likely a permission action label.
 * Works with localized terms and a language-neutral fallback.
 * @param {string} line
 * @param {Set<string>} actionTerms
 * @returns {boolean}
 */
function isLikelySharingPermissionActionLine(line, actionTerms){
  const normalized = normalizeSharingPermissionTerm(line);
  if (!normalized){
    return false;
  }
  if (isSharingPermissionMarker(normalized)){
    return false;
  }
  if (actionTerms.has(normalized)){
    return true;
  }
  for (const term of actionTerms){
    if (term && (normalized === term || normalized.startsWith(`${term} `) || normalized.includes(` ${term}`))){
      return true;
    }
  }
  if (normalized.length > 24){
    return false;
  }
  if (/https?:|www\.|[@/]/i.test(normalized)){
    return false;
  }
  if (/[0-9]/.test(normalized)){
    return false;
  }
  if (/[,.;:!?，。；：、]/.test(line)){
    return false;
  }
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount > 3){
    return false;
  }
  return true;
}

/**
 * @param {string[]} lines
 * @param {number} fromIndex
 * @returns {number}
 */
function getNextNonEmptySharingLineIndex(lines, fromIndex){
  for (let i = fromIndex; i < lines.length; i += 1){
    if (String(lines[i] || "").trim()){
      return i;
    }
  }
  return -1;
}

/**
 * @param {string[]} lines
 * @param {Set<string>} actionTerms
 * @returns {{start:number,end:number,entries:string[]}|null}
 */
function findSharingPermissionBlock(lines, actionTerms){
  for (let i = 0; i < lines.length; i += 1){
    const marker = String(lines[i] || "").trim();
    if (!isSharingPermissionMarker(marker)){
      continue;
    }
    const labelIndex = getNextNonEmptySharingLineIndex(lines, i + 1);
    if (labelIndex < 0){
      continue;
    }
    const firstLabel = String(lines[labelIndex] || "").trim();
    if (!isLikelySharingPermissionActionLine(firstLabel, actionTerms)){
      continue;
    }

    const entries = [];
    let cursor = i;
    while (true){
      const markerIndex = getNextNonEmptySharingLineIndex(lines, cursor);
      if (markerIndex < 0){
        break;
      }
      const markerLine = String(lines[markerIndex] || "").trim();
      if (isSharingPermissionMarker(markerLine)){
        const nextLabelIndex = getNextNonEmptySharingLineIndex(lines, markerIndex + 1);
        if (nextLabelIndex < 0){
          break;
        }
        const labelLine = String(lines[nextLabelIndex] || "").trim();
        if (!isLikelySharingPermissionActionLine(labelLine, actionTerms)){
          break;
        }
        entries.push(`${markerLine} ${labelLine}`);
        cursor = nextLabelIndex + 1;
        continue;
      }
      if (entries.length > 0 && isLikelySharingPermissionActionLine(markerLine, actionTerms)){
        entries.push(`[ ] ${markerLine}`);
        cursor = markerIndex + 1;
        continue;
      }
      break;
    }
    if (entries.length >= 2){
      return { start: i, end: cursor, entries };
    }
  }
  return null;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isLikelySharingPermissionHeadingLine(line){
  const normalized = normalizeSharingPermissionTerm(line);
  if (!normalized || normalized.length > 32){
    return false;
  }
  if (isSharingPermissionMarker(normalized)){
    return false;
  }
  if (/https?:|www\.|[@/]/i.test(normalized)){
    return false;
  }
  if (/[0-9]/.test(normalized)){
    return false;
  }
  if (/[,.;!?，。；、]/.test(line)){
    return false;
  }
  return true;
}

/**
 * Find the nearest heading line before a permission marker block.
 * @param {string[]} lines
 * @param {number} markerStart
 * @returns {number}
 */
function findSharingPermissionHeadingIndex(lines, markerStart){
  let index = markerStart - 1;
  while (index >= 0 && !String(lines[index] || "").trim()){
    index -= 1;
  }
  if (index < 0){
    return -1;
  }
  return isLikelySharingPermissionHeadingLine(String(lines[index] || "").trim()) ? index : -1;
}

/**
 * Compact permission rows into a single line in the detected permission block.
 * @param {string} value
 * @returns {string}
 */
function compactSharingPermissionRows(value){
  const lines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  if (!lines.length){
    return value;
  }

  const actionTerms = getSharingPermissionActionTerms();
  const block = findSharingPermissionBlock(lines, actionTerms);
  if (!block){
    return lines.join("\n");
  }

  const headingIndex = findSharingPermissionHeadingIndex(lines, block.start);
  const compactEntries = block.entries.join(" | ");
  if (headingIndex < 0){
    return [
      ...lines.slice(0, block.start),
      compactEntries,
      ...lines.slice(block.end)
    ].join("\n");
  }

  const headingLine = String(lines[headingIndex] || "").trim().replace(/\s*[:：]\s*$/, "");
  if (!headingLine){
    return lines.join("\n");
  }

  const compactLine = `${headingLine}: ${compactEntries}`;
  return [
    ...lines.slice(0, headingIndex),
    compactLine,
    ...lines.slice(block.end)
  ].join("\n");
}

/**
 * Render top/bottom hash separators around the plain-text sharing block.
 * Border width is fixed to 60 hash characters.
 * @param {string} plainText
 * @returns {string}
 */
function frameSharingPlainTextBlock(plainText){
  const lines = String(plainText || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const border = "#".repeat(60);
  return [border, ...lines, border].join("\n");
}

/**
 * Convert a sharing block to plain text for plain-text compose.
 * Fail closed: converter missing or empty output aborts insertion.
 * @param {string} sourceHtml
 * @returns {string}
 */
function buildSharingInsertPlainText(sourceHtml){
  if (typeof NCHtmlSanitizer?.htmlToPlainText !== "function"){
    throw new Error("sharing_template_plaintext_converter_unavailable");
  }
  const plainTextRaw = String(NCHtmlSanitizer.htmlToPlainText(String(sourceHtml || "")) || "").trim();
  const normalizedMarkers = normalizeSharingPermissionMarkers(plainTextRaw);
  const plainText = compactSharingPermissionRows(normalizedMarkers).trim();
  if (!plainText){
    throw new Error("sharing_template_plaintext_empty");
  }
  return frameSharingPlainTextBlock(plainText);
}

/**
 * Convert plain text to lightweight HTML for HTML compose editors.
 * @param {string} plainText
 * @returns {string}
 */
function buildSharingInsertPlainHtml(plainText){
  if (typeof NCHtmlSanitizer?.plainTextToHtml !== "function"){
    throw new Error("sharing_template_plainhtml_converter_unavailable");
  }
  const plainHtml = String(NCHtmlSanitizer.plainTextToHtml(String(plainText || "")) || "").trim();
  if (!plainHtml){
    throw new Error("sharing_template_plainhtml_empty");
  }
  return plainHtml;
}

/**
 * Resolve whether sharing insertion should target plain text or HTML.
 * @param {object} details
 * @returns {{usePlainText:boolean,editorIsPlainText:boolean,reason:string,deliveryFormat:string}}
 */
function resolveSharingInsertMode(details = {}){
  const editorIsPlainText = details?.isPlainText === true;
  const deliveryFormat = typeof details?.deliveryFormat === "string"
    ? details.deliveryFormat.trim().toLowerCase()
    : "";
  if (editorIsPlainText){
    return {
      usePlainText: true,
      editorIsPlainText: true,
      reason: "compose_plaintext_mode",
      deliveryFormat
    };
  }
  if (deliveryFormat === "plaintext"){
    return {
      usePlainText: true,
      editorIsPlainText: false,
      reason: "delivery_format_plaintext",
      deliveryFormat
    };
  }
  return {
    usePlainText: false,
    editorIsPlainText: false,
    reason: "compose_html_mode",
    deliveryFormat
  };
}

/**
 * Insert one HTML block segment near compose body start.
 * @param {string} currentBody
 * @param {string} blockHtml
 * @returns {string}
 */
function insertSharingBlockSegment(currentBody, blockHtml){
  const body = String(currentBody || "");
  const segment = `<br>${blockHtml}<br><br>`;
  const bodyMatch = body.match(/<body[^>]*>/i);
  if (bodyMatch){
    const insertIndex = bodyMatch.index + bodyMatch[0].length;
    return body.slice(0, insertIndex) + segment + body.slice(insertIndex);
  }
  return segment + body;
}

/**
 * Runtime message handler for `sharing:insertHtml`.
 * @param {{tabId?:number|string,html?:string}} payload
 * @returns {Promise<{ok:boolean,error?:string}>}
 */
async function handleSharingInsertHtmlMessage(payload = {}){
  const tabId = Number(payload?.tabId);
  const html = String(payload?.html || "").trim();
  if (!Number.isInteger(tabId) || tabId <= 0 || !html){
    return { ok:false, error: "tab/html missing" };
  }

  const sourceHtml = html;
  const details = await browser.compose.getComposeDetails(tabId);
  const insertionMode = resolveSharingInsertMode(details);

  if (insertionMode.usePlainText){
    const plainBlock = buildSharingInsertPlainText(sourceHtml);
    if (insertionMode.editorIsPlainText){
      const currentPlainText = String(details?.plainTextBody || "");
      const newPlainText = `${plainBlock}\n\n${currentPlainText}`;
      await browser.compose.setComposeDetails(tabId, {
        plainTextBody: newPlainText,
        isPlainText: true
      });
    }else{
      const plainHtml = buildSharingInsertPlainHtml(plainBlock);
      const newBody = insertSharingBlockSegment(String(details?.body || ""), plainHtml);
      await browser.compose.setComposeDetails(tabId, { body: newBody, isPlainText: false });
    }
    L("sharing:insertHtml converted to plaintext", {
      tabId,
      reason: insertionMode.reason,
      editorMode: insertionMode.editorIsPlainText ? "plain" : "html",
      deliveryFormat: insertionMode.deliveryFormat || "",
      inputHtmlLength: html.length,
      sourceHtmlLength: sourceHtml.length,
      plainTextLength: plainBlock.length
    });
    return { ok:true };
  }

  const newBody = insertSharingBlockSegment(String(details?.body || ""), sourceHtml);
  L("sharing:insertHtml kept html", {
    tabId,
    reason: insertionMode.reason,
    editorMode: "html",
    deliveryFormat: insertionMode.deliveryFormat || "",
    inputHtmlLength: html.length,
    sourceHtmlLength: sourceHtml.length
  });
  await browser.compose.setComposeDetails(tabId, { body: newBody, isPlainText: false });
  return { ok:true };
}
