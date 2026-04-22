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

  /**
   * Resolve the DOMPurify global.
   * @returns {any|null}
   */
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
    }catch(_error){
      return null;
    }
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
  function normalizeAnchorTargets(html){
    const parser = createParser();
    if (!parser){
      return String(html || "");
    }
    const parsed = parser.parseFromString(String(html || ""), "text/html");
    const body = parsed?.body;
    if (!body){
      return "";
    }
    for (const anchor of body.querySelectorAll('a[target="_blank"]')){
      const relTokens = new Set(String(anchor.getAttribute("rel") || "").split(/\s+/).filter(Boolean));
      relTokens.add("noopener");
      relTokens.add("noreferrer");
      anchor.setAttribute("rel", Array.from(relTokens).join(" "));
    }
    return body.innerHTML;
  }

  /**
   * Sanitize backend-provided rich HTML.
   * @param {string} value
   * @returns {string}
   */
  function sanitizeHtml(value){
    const dirty = String(value || "").trim();
    if (!dirty){
      return "";
    }
    const purify = resolvePurify();
    if (!purify){
      return plainTextToHtml(htmlToPlainText(dirty));
    }
    const clean = purify.sanitize(dirty, {
      USE_PROFILES: { html: true },
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS,
      ADD_ATTR,
      ADD_TAGS
    });
    return normalizeAnchorTargets(String(clean || ""));
  }

  /**
   * Sanitize talk invitation HTML.
   * @param {string} value
   * @returns {string}
   */
  function sanitizeTalkTemplateHtml(value){
    return sanitizeHtml(value);
  }

  /**
   * Sanitize share block HTML.
   * @param {string} value
   * @returns {string}
   */
  function sanitizeShareTemplateHtml(value){
    return sanitizeHtml(value);
  }

  global.NCHtmlSanitizer = {
    sanitizeHtml,
    sanitizeTalkTemplateHtml,
    sanitizeShareTemplateHtml,
    htmlToPlainText,
    plainTextToHtml
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
