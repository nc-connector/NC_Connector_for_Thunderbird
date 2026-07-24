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

function normalizeSharingPermissionMarkers(value){
  return String(value || "")
    .replace(/[✓✔✅☑]/g, "[x]")
    .replace(/[✗✘✕✖❌☒]/g, "[ ]");
}

function normalizeSharingPermissionTerm(value){
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[：:]/g, "")
    .replace(/\s+/g, " ");
}

function isSharingPermissionMarker(line){
  const normalized = normalizeSharingPermissionTerm(line);
  return normalized === "[x]" || normalized === "[ ]";
}

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

function getNextNonEmptySharingLineIndex(lines, fromIndex){
  for (let i = fromIndex; i < lines.length; i += 1){
    if (String(lines[i] || "").trim()){
      return i;
    }
  }
  return -1;
}

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
  // Prefer our explicit rights markers; quoted mail text can contain similar
  // words and must not be compacted as if it were an NC Connector block.
  const scopedPlainText = finalizeSharingRightsSegments(rawPlainText);
  const compactPlainText = scopedPlainText !== null
    ? scopedPlainText.trim()
    : compactSharingPermissionRows(normalizeSharingPermissionMarkers(rawPlainText)).trim();
  if (!compactPlainText){
    throw new Error("sharing_template_plaintext_empty");
  }
  return frameSharingPlainTextBlock(compactPlainText);
}

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

function normalizeComposeCustomHeaders(value){
  const headers = [];
  for (const header of Array.isArray(value) ? value : []){
    const name = String(header?.name || "").trim();
    const headerValue = String(header?.value ?? "");
    if (name){
      headers.push({ name, value: headerValue });
    }
  }
  return headers;
}

function composeCustomHeadersEqual(left, right){
  const leftHeaders = normalizeComposeCustomHeaders(left);
  const rightHeaders = normalizeComposeCustomHeaders(right);
  return leftHeaders.length === rightHeaders.length
    && leftHeaders.every((header, index) => {
      return header.name === rightHeaders[index].name
        && header.value === rightHeaders[index].value;
    });
}

function getComposeShareDraftIds(customHeaders){
  return normalizeComposeCustomHeaders(customHeaders)
    .filter((header) => header.name.toLowerCase() === COMPOSE_SHARE_DRAFT_HEADER.toLowerCase())
    .map((header) => header.value)
    .filter((value) => COMPOSE_SHARE_DRAFT_ID_PATTERN.test(value));
}

function createComposeShareDraftGroupId(){
  return createSecureRuntimeId();
}

function resolveComposeShareDraftGroupId(customHeaders, requestedGroupId = ""){
  const existingIds = [...new Set(getComposeShareDraftIds(customHeaders))];
  if (existingIds.length > 1){
    throw new Error("compose_share_draft_marker_conflict");
  }
  const requested = String(requestedGroupId || "").trim();
  if (requested && !COMPOSE_SHARE_DRAFT_ID_PATTERN.test(requested)){
    throw new Error("compose_share_draft_marker_invalid");
  }
  if (requested && existingIds.length && existingIds[0] !== requested){
    throw new Error("compose_share_draft_marker_mismatch");
  }
  return requested || existingIds[0] || createComposeShareDraftGroupId();
}

function setComposeShareDraftHeader(customHeaders, draftGroupId){
  const filtered = normalizeComposeCustomHeaders(customHeaders).filter((header) => {
    return header.name.toLowerCase() !== COMPOSE_SHARE_DRAFT_HEADER.toLowerCase();
  });
  filtered.push({
    name: COMPOSE_SHARE_DRAFT_HEADER,
    value: draftGroupId
  });
  return filtered;
}

function removeComposeShareDraftHeaders(customHeaders){
  return normalizeComposeCustomHeaders(customHeaders).filter((header) => {
    return header.name.toLowerCase() !== COMPOSE_SHARE_DRAFT_HEADER.toLowerCase();
  });
}

async function resolveSharingInsertDraftGroupId(tabId){
  const normalizedTabId = Number(tabId);
  if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0){
    throw new Error("invalid_tab_id");
  }
  const details = await browser.compose.getComposeDetails(normalizedTabId);
  return resolveComposeShareDraftGroupId(details?.customHeaders);
}

async function prepareSharingInsertMutation(payload = {}, options = {}){
  const tabId = Number(payload?.tabId);
  const html = String(payload?.html || "").trim();
  const plainText = String(payload?.plainText || "").trim();
  if (!Number.isInteger(tabId) || tabId <= 0 || !html || !plainText){
    throw new Error("tab/html/plainText missing");
  }
  const details = await browser.compose.getComposeDetails(tabId);
  const insertionMode = resolveSharingInsertMode(details);
  const addDraftMarker = options.addDraftMarker === true;
  const draftGroupId = addDraftMarker
    ? resolveComposeShareDraftGroupId(details?.customHeaders, options.draftGroupId)
    : "";
  const applyDetails = {};
  const rollbackDetails = {};
  let bodyField = "";
  let insertedSegment = "";

  if (insertionMode.usePlainText){
    const plainBlock = finalizeSharingInsertPlainText(plainText);
    if (insertionMode.editorIsPlainText){
      bodyField = "plainTextBody";
      rollbackDetails.plainTextBody = String(details?.plainTextBody || "");
      insertedSegment = `${plainBlock}\n\n`;
      applyDetails.plainTextBody = `${insertedSegment}${rollbackDetails.plainTextBody}`;
      applyDetails.isPlainText = true;
    }else{
      const plainHtml = buildSharingInsertPlainHtml(plainBlock);
      bodyField = "body";
      rollbackDetails.body = String(details?.body || "");
      insertedSegment = `<br>${plainHtml}<br><br>`;
      applyDetails.body = insertSharingBlockSegment(rollbackDetails.body, plainHtml);
      applyDetails.isPlainText = false;
    }
  }else{
    bodyField = "body";
    rollbackDetails.body = String(details?.body || "");
    insertedSegment = `<br>${html}<br><br>`;
    applyDetails.body = insertSharingBlockSegment(rollbackDetails.body, html);
    applyDetails.isPlainText = false;
  }
  if (addDraftMarker){
    rollbackDetails.customHeaders = normalizeComposeCustomHeaders(details?.customHeaders);
    applyDetails.customHeaders = setComposeShareDraftHeader(details?.customHeaders, draftGroupId);
  }
  return {
    tabId,
    htmlLength: html.length,
    draftGroupId,
    insertionMode,
    bodyField,
    insertedSegment,
    applyDetails,
    rollbackDetails,
    attempted: false,
    applied: false
  };
}

async function applySharingInsertMutation(mutation){
  if (!mutation || !Number.isInteger(mutation.tabId)){
    throw new Error("sharing_insert_mutation_invalid");
  }
  mutation.attempted = true;
  await browser.compose.setComposeDetails(mutation.tabId, mutation.applyDetails);
  mutation.applied = true;
  const insertionMode = mutation.insertionMode;
  L(
    insertionMode.usePlainText
      ? "sharing:insertRenderedBlock converted to plaintext"
      : "sharing:insertRenderedBlock kept html",
    {
      tabId: mutation.tabId,
      reason: insertionMode.reason,
      editorMode: insertionMode.editorIsPlainText ? "plain" : "html",
      deliveryFormat: insertionMode.deliveryFormat || "",
      inputHtmlLength: mutation.htmlLength,
      hasDraftMarker: !!mutation.draftGroupId
    }
  );
}

async function rollbackSharingInsertMutation(mutation){
  if (!mutation?.attempted || !Number.isInteger(mutation.tabId)){
    return true;
  }
  try{
    const details = await browser.compose.getComposeDetails(mutation.tabId);
    const rollbackDetails = {};
    let rollbackComplete = true;
    const bodyField = String(mutation.bodyField || "");
    if (bodyField){
      const currentBody = String(details?.[bodyField] || "");
      const appliedBody = String(mutation.applyDetails?.[bodyField] || "");
      const originalBody = String(mutation.rollbackDetails?.[bodyField] || "");
      if (currentBody === appliedBody){
        rollbackDetails[bodyField] = originalBody;
      }else if (currentBody === originalBody){
        // The compose API did not apply this part of the mutation.
      }else{
        const segment = String(mutation.insertedSegment || "");
        const firstIndex = segment ? currentBody.indexOf(segment) : -1;
        const lastIndex = segment ? currentBody.lastIndexOf(segment) : -1;
        if (firstIndex >= 0 && firstIndex === lastIndex){
          rollbackDetails[bodyField] = currentBody.slice(0, firstIndex)
            + currentBody.slice(firstIndex + segment.length);
        }else{
          rollbackComplete = false;
        }
      }
    }
    if (mutation.draftGroupId){
      const currentHeaders = normalizeComposeCustomHeaders(details?.customHeaders);
      const appliedHeaders = mutation.applyDetails?.customHeaders;
      const originalHeaders = mutation.rollbackDetails?.customHeaders;
      if (composeCustomHeadersEqual(currentHeaders, appliedHeaders)){
        if (!composeCustomHeadersEqual(appliedHeaders, originalHeaders)){
          rollbackDetails.customHeaders = normalizeComposeCustomHeaders(
            originalHeaders
          );
        }
      }else if (!composeCustomHeadersEqual(currentHeaders, originalHeaders)){
        rollbackComplete = false;
      }
    }
    if (Object.keys(rollbackDetails).length){
      await browser.compose.setComposeDetails(mutation.tabId, rollbackDetails);
    }
    mutation.applied = false;
    return rollbackComplete;
  }catch(error){
    console.error("[NCBG] sharing compose insertion rollback failed", {
      tabId: mutation.tabId,
      error: error?.message || String(error)
    });
    return false;
  }
}
