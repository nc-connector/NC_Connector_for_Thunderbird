/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Shared HTML sanitization helpers for backend-provided rich templates.
 *
 * DOMPurify is intentionally bundled for Thunderbird review compliance:
 * backend-controlled HTML must be sanitized before use, and privileged chrome
 * code must not parse raw remote HTML via innerHTML.
 */
(function(global){
  "use strict";

  const FORBID_TAGS = [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "link",
    "meta",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "svg",
    "math"
  ];

  const ADD_ATTR = [
    "style",
    "target",
    "rel",
    "role",
    "width",
    "height",
    "colspan",
    "rowspan",
    "cellpadding",
    "cellspacing",
    "align",
    "valign"
  ];

  const ADD_TAGS = [
    "section",
    "article",
    "header",
    "footer"
  ];

  function resolveInternalLogPrefix(){
    return global.NCLogContext?.resolveAddonLogPrefix?.("Sanitizer")
      || "[NCBG]";
  }

  function resolvePurify(){
    if (global.DOMPurify && typeof global.DOMPurify.sanitize === "function"){
      return global.DOMPurify;
    }
    if (global.window?.DOMPurify && typeof global.window.DOMPurify.sanitize === "function"){
      return global.window.DOMPurify;
    }
    return null;
  }

  /**
   * Return whether debug logging is currently enabled in this runtime.
   * UI pages use the shared debug forwarder mirror, while background reuses
   * the centralized background debug flag helper from `bgState.js`.
   * @returns {boolean}
   */
  function isDebugLoggingEnabled(){
    if (typeof global.NCDebugForwarder?.getMirroredDebugEnabled === "function"){
      return !!global.NCDebugForwarder.getMirroredDebugEnabled();
    }
    if (typeof global.isBackgroundDebugEnabled === "function"){
      return !!global.isBackgroundDebugEnabled();
    }
    return false;
  }

  /**
   * Resolve the existing debug-log label for the current runtime path.
   * @param {string} templateType
   * @returns {{channel:string,label:string,source:string}}
   */
  function resolveSanitizerDebugTarget(templateType){
    const normalizedType = String(templateType || "").trim().toLowerCase();
    if (normalizedType === "talk"){
      return {
        channel: "NCUI",
        label: "Talk",
        source: "htmlSanitizer"
      };
    }
    if (normalizedType === "share"){
      return {
        channel: "NCUI",
        label: "Sharing",
        source: "htmlSanitizer"
      };
    }
    return {
      channel: "NCUI",
      label: "Sanitizer",
      source: "htmlSanitizer"
    };
  }

  /**
   * Forward one sanitizer debug entry through the existing add-on debug paths.
   * Background uses `L(...)`, while UI pages use the structured `debug:log` flow.
   * @param {string} templateType
   * @param {string} text
   * @param {object} details
   */
  function emitSanitizerDebugLog(templateType, text, details){
    const debugEnabled = isDebugLoggingEnabled();
    if (!debugEnabled){
      return;
    }
    if (typeof global.L === "function"){
      try{
        global.L(text, details || {});
        return;
      }catch(error){
        console.error(resolveInternalLogPrefix(), "background debug log failed", error);
      }
    }
    const target = resolveSanitizerDebugTarget(templateType);
    if (global.NCDebugForwarder?.forwardDebugLog){
      try{
        global.NCDebugForwarder.forwardDebugLog({
          enabled: debugEnabled,
          isPageUnloading: false,
          source: target.source,
          channel: target.channel,
          label: target.label,
          text,
          details: details || {}
        });
        return;
      }catch(error){
        console.error(resolveInternalLogPrefix(), "ui debug log forward failed", error);
      }
    }
    try{
      console.log(`[${target.channel}][${target.label}]`, text, details || {});
    }catch(error){
      console.error(resolveInternalLogPrefix(), "fallback debug log failed", error);
    }
  }

  /**
   * Resolve a DOMParser constructor from the current environment.
   * @returns {DOMParser|null}
   */
  function createParser(){
    const ParserCtor = global.DOMParser || global.window?.DOMParser || null;
    if (!ParserCtor){
      return null;
    }
    try{
      return new ParserCtor();
    }catch(error){
      console.error(resolveInternalLogPrefix(), "DOMParser init failed", error);
      return null;
    }
  }

  function createStructureStats(){
    return {
      available: false,
      elementCount: 0,
      attributeCount: 0,
      tagCounts: Object.create(null),
      attributeCounts: Object.create(null)
    };
  }

  function incrementCount(counts, key){
    const normalizedKey = String(key || "").trim().toLowerCase();
    if (!normalizedKey){
      return;
    }
    counts[normalizedKey] = (counts[normalizedKey] || 0) + 1;
  }

  /**
   * Analyze element/attribute counts for sanitizer debug summaries.
   * @param {string} html
   * @returns {{available:boolean,elementCount:number,attributeCount:number,tagCounts:Object<string,number>,attributeCounts:Object<string,number>}}
   */
  function analyzeHtmlStructure(html){
    const stats = createStructureStats();
    const source = String(html || "").trim();
    if (!source){
      stats.available = true;
      return stats;
    }
    const parser = createParser();
    if (!parser){
      return stats;
    }
    try{
      const parsed = parser.parseFromString(source, "text/html");
      const body = parsed?.body;
      if (!body){
        return stats;
      }
      stats.available = true;
      for (const element of body.querySelectorAll("*")){
        stats.elementCount += 1;
        incrementCount(stats.tagCounts, element.tagName);
        for (const attribute of Array.from(element.attributes || [])){
          stats.attributeCount += 1;
          incrementCount(stats.attributeCounts, attribute?.name || "");
        }
      }
    }catch(error){
      console.error(resolveInternalLogPrefix(), "html structure analysis failed", error);
    }
    return stats;
  }

  /**
   * Format removed tags/attributes for sanitizer debug output.
   * @param {Object<string,number>} inputCounts
   * @param {Object<string,number>} outputCounts
   * @param {number} maxEntries
   * @returns {string}
   */
  function formatRemovedEntries(inputCounts, outputCounts, maxEntries){
    const inputKeys = Object.keys(inputCounts || {});
    if (!inputKeys.length){
      return "none";
    }
    const removed = [];
    for (const key of inputKeys){
      const delta = Number(inputCounts[key] || 0) - Number(outputCounts?.[key] || 0);
      if (delta > 0){
        removed.push({ key, delta });
      }
    }
    if (!removed.length){
      return "none";
    }
    return removed
      .sort((left, right) => {
        if (right.delta !== left.delta){
          return right.delta - left.delta;
        }
        return left.key.localeCompare(right.key);
      })
      .slice(0, Math.max(1, Number(maxEntries) || 8))
      .map((entry) => `${entry.key}:-${entry.delta}`)
      .join(";");
  }

  /**
   * Log one compact sanitizer summary similar to the Outlook add-in.
   * @param {string} templateType
   * @param {string} inputHtml
   * @param {string} sanitizedHtml
   * @param {string} normalizedHtml
   * @param {object} inputStats
   * @param {object} outputStats
   * @param {{anchorRelAdjustments:number}} normalizationReport
   * @param {boolean} emptied
   */
  function logSanitizationSummary(
    templateType,
    inputHtml,
    sanitizedHtml,
    normalizedHtml,
    inputStats,
    outputStats,
    normalizationReport,
    emptied
  ){
    const safeInputStats = inputStats || createStructureStats();
    const safeOutputStats = outputStats || createStructureStats();
    const removedTags = (safeInputStats.available && safeOutputStats.available)
      ? formatRemovedEntries(safeInputStats.tagCounts, safeOutputStats.tagCounts, 8)
      : "n/a";
    const removedAttrs = (safeInputStats.available && safeOutputStats.available)
      ? formatRemovedEntries(safeInputStats.attributeCounts, safeOutputStats.attributeCounts, 8)
      : "n/a";
    const changed = String(inputHtml || "") !== String(normalizedHtml || "");
    emitSanitizerDebugLog(
      templateType,
      emptied ? "Template sanitization emptied" : "Template sanitization completed",
      {
        templateType: templateType || "generic",
        inputLen: String(inputHtml || "").length,
        sanitizedLen: String(sanitizedHtml || "").length,
        normalizedLen: String(normalizedHtml || "").length,
        inputElements: safeInputStats.elementCount,
        outputElements: safeOutputStats.elementCount,
        inputAttrs: safeInputStats.attributeCount,
        outputAttrs: safeOutputStats.attributeCount,
        removedTags,
        removedAttrs,
        anchorRelAdjustments: Number(normalizationReport?.anchorRelAdjustments || 0),
        changed
      }
    );
  }

  /**
   * Escape plain text for a safe HTML fallback.
   * @param {any} value
   * @returns {string}
   */
  function escapeHtml(value){
    if (value == null){
      return "";
    }
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Convert plain text paragraphs into lightweight HTML.
   * @param {string} value
   * @returns {string}
   */
  function plainTextToHtml(value){
    const normalized = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!normalized){
      return "";
    }
    const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    return paragraphs.map((part) => {
      const escaped = escapeHtml(part).replace(/\n/g, "<br>");
      return `<p>${escaped}</p>`;
    }).join("\n");
  }

  /**
   * Convert lightweight HTML into plain text using an inert parser.
   * @param {string} value
   * @returns {string}
   */
  function htmlToPlainText(value){
    const html = String(value || "").trim();
    if (!html){
      return "";
    }
    const parser = createParser();
    if (!parser){
      return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\u00A0/g, " ")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    const parsed = parser.parseFromString(html, "text/html");
    const body = parsed?.body;
    if (!body){
      return "";
    }
    for (const anchor of body.querySelectorAll("a[href]")){
      const href = String(anchor.getAttribute("href") || "").trim();
      const text = String(anchor.textContent || "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!href){
        continue;
      }
      const replacement = !text
        ? href
        : (text === href ? text : `${text} (${href})`);
      anchor.replaceWith(replacement);
    }
    for (const br of body.querySelectorAll("br")){
      br.replaceWith("\n");
    }
    for (const block of body.querySelectorAll("p,div,section,article,li,tr,h1,h2,h3,h4,h5,h6")){
      if (block.lastChild?.nodeValue !== "\n"){
        block.append("\n");
      }
    }
    return String(body.textContent || "")
      .replace(/\u00A0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Enforce noopener/noreferrer on target=_blank anchors after sanitization.
   * @param {string} html
   * @returns {string}
   */
  function normalizeAnchorTargetsWithReport(html){
    const report = {
      html: String(html || ""),
      anchorRelAdjustments: 0
    };
    const parser = createParser();
    if (!parser){
      return report;
    }
    const parsed = parser.parseFromString(String(html || ""), "text/html");
    const body = parsed?.body;
    if (!body){
      report.html = "";
      return report;
    }
    for (const anchor of body.querySelectorAll('a[target="_blank"]')){
      const relTokens = new Set(String(anchor.getAttribute("rel") || "").split(/\s+/).filter(Boolean));
      const previousRel = Array.from(relTokens).sort().join(" ");
      relTokens.add("noopener");
      relTokens.add("noreferrer");
      const nextRel = Array.from(relTokens).join(" ");
      if (nextRel !== previousRel){
        report.anchorRelAdjustments += 1;
      }
      anchor.setAttribute("rel", nextRel);
    }
    report.html = body.innerHTML;
    return report;
  }

  /**
   * Sanitize backend-provided rich HTML.
   * @param {string} value
   * @returns {string}
   */
  function sanitizeHtml(value, templateType = "generic"){
    const dirty = String(value || "").trim();
    if (!dirty){
      return "";
    }
    const purify = resolvePurify();
    if (!purify){
      throw new Error("html_sanitizer_unavailable");
    }
    const collectDebugStats = isDebugLoggingEnabled();
    const inputStats = collectDebugStats ? analyzeHtmlStructure(dirty) : null;
    const clean = purify.sanitize(dirty, {
      USE_PROFILES: { html: true },
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS,
      ADD_ATTR,
      ADD_TAGS
    });
    const sanitized = String(clean || "");
    const normalizationReport = normalizeAnchorTargetsWithReport(sanitized);
    const normalized = String(normalizationReport.html || "");
    if (collectDebugStats){
      const outputStats = analyzeHtmlStructure(normalized);
      logSanitizationSummary(
        templateType,
        dirty,
        sanitized,
        normalized,
        inputStats,
        outputStats,
        normalizationReport,
        !normalized.trim()
      );
    }
    return normalized;
  }

  /**
   * Sanitize talk invitation HTML.
   * @param {string} value
   * @returns {string}
   */
  function sanitizeTalkTemplateHtml(value){
    return sanitizeHtml(value, "talk");
  }

  /**
   * Sanitize share block HTML.
   * @param {string} value
   * @returns {string}
   */
  function sanitizeShareTemplateHtml(value){
    return sanitizeHtml(value, "share");
  }

  global.NCHtmlSanitizer = {
    sanitizeHtml,
    sanitizeTalkTemplateHtml,
    sanitizeShareTemplateHtml,
    htmlToPlainText,
    plainTextToHtml
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
