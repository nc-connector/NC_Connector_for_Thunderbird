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
const RIGHTS_SEGMENT_START = NCShareTemplateContract.RIGHTS_SEGMENT_START;
const RIGHTS_SEGMENT_END = NCShareTemplateContract.RIGHTS_SEGMENT_END;

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
 * Normalize explicitly marked rights segments without touching unrelated text.
 * @param {string} value
 * @returns {string|null}
 */
function finalizeSharingRightsSegments(value){
  let output = String(value || "");
  let changed = false;
  while (true){
    const startIndex = output.indexOf(RIGHTS_SEGMENT_START);
    if (startIndex < 0){
      break;
    }
    const endIndex = output.indexOf(RIGHTS_SEGMENT_END, startIndex + RIGHTS_SEGMENT_START.length);
    if (endIndex < 0){
      break;
    }
    const rawSegment = output.slice(startIndex + RIGHTS_SEGMENT_START.length, endIndex);
    const normalizedSegment = compactSharingPermissionRows(normalizeSharingPermissionMarkers(rawSegment)).trim();
    output = output.slice(0, startIndex) + normalizedSegment + output.slice(endIndex + RIGHTS_SEGMENT_END.length);
    changed = true;
  }
  if (!changed){
    return null;
  }
  return output
    .split(RIGHTS_SEGMENT_START).join("")
    .split(RIGHTS_SEGMENT_END).join("");
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
 * @param {string} plainText
 * @returns {string}
 */
function finalizeSharingInsertPlainText(plainText){
  const rawPlainText = String(plainText || "").trim();
  const scopedPlainText = finalizeSharingRightsSegments(rawPlainText);
  const compactPlainText = scopedPlainText !== null
    ? scopedPlainText.trim()
    : compactSharingPermissionRows(normalizeSharingPermissionMarkers(rawPlainText)).trim();
  if (!compactPlainText){
    throw new Error("sharing_template_plaintext_empty");
  }
  return frameSharingPlainTextBlock(compactPlainText);
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
 * @param {{tabId?:number|string,html?:string,plainText?:string}} payload
 * @returns {Promise<{ok:boolean,error?:string}>}
 */
async function handleSharingInsertHtmlMessage(payload = {}){
  const tabId = Number(payload?.tabId);
  const html = String(payload?.html || "").trim();
  const plainText = String(payload?.plainText || "").trim();
  if (!Number.isInteger(tabId) || tabId <= 0 || !html || !plainText){
    return { ok:false, error: "tab/html/plainText missing" };
  }

  const details = await browser.compose.getComposeDetails(tabId);
  const insertionMode = resolveSharingInsertMode(details);

  if (insertionMode.usePlainText){
    const plainBlock = finalizeSharingInsertPlainText(plainText);
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
      plainTextLength: plainBlock.length
    });
    return { ok:true };
  }

  const newBody = insertSharingBlockSegment(String(details?.body || ""), html);
  L("sharing:insertHtml kept html", {
    tabId,
    reason: insertionMode.reason,
    editorMode: "html",
    deliveryFormat: insertionMode.deliveryFormat || "",
    inputHtmlLength: html.length
  });
  await browser.compose.setComposeDetails(tabId, { body: newBody, isPlainText: false });
  return { ok:true };
}
