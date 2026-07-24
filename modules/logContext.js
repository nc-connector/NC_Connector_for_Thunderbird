/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';
  const UI_RUNTIME_LABELS = Object.freeze([
    { suffix: "/ui/talkdialog.html", label: "Talk" },
    { suffix: "/ui/nextcloudsharingwizard.html", label: "Sharing" },
    { suffix: "/ui/composeattachmentprompt.html", label: "Sharing" },
    { suffix: "/ui/openurlfallback.html", label: "OpenUrlFallback" },
    { suffix: "/options.html", label: "Options" }
  ]);
  const SENSITIVE_LOG_KEY = /(?:actor(?:id)?|apppass|authorization|cookie|credential|delegate(?:id)?|email|fromemail|identity(?:id)?|loginname|mailbox|passphrase|password|recipient|searchterm|secret|token|user(?:id|name)?)/i;

  /**
   * Return the normalized current document pathname when available.
   * @returns {string}
   */
  function getNormalizedPathname(){
    try{
      return String(global.location?.pathname || "")
        .replace(/\\/g, "/")
        .trim()
        .toLowerCase();
    }catch(error){
      return "";
    }
  }

  function isAddonUiPath(pathname){
    const normalized = String(pathname || "").trim().toLowerCase();
    return normalized.endsWith("/options.html") || normalized.includes("/ui/");
  }

  /**
   * Resolve the UI label for the current extension page.
   * @param {string} fallbackLabel
   * @returns {string}
   */
  function resolveUiLogLabel(fallbackLabel = "UI"){
    const pathname = getNormalizedPathname();
    for (const entry of UI_RUNTIME_LABELS){
      if (pathname.endsWith(entry.suffix)){
        return entry.label;
      }
    }
    const fallback = String(fallbackLabel || "").trim();
    return fallback || "UI";
  }

  function isKnownUiRuntime(){
    const pathname = getNormalizedPathname();
    return UI_RUNTIME_LABELS.some((entry) => pathname.endsWith(entry.suffix));
  }

  /**
   * Resolve the standard add-on console prefix for the current runtime.
   * Background uses `[NCBG]`, while known UI pages use `[NCUI][...]`.
   * @param {string} fallbackUiLabel
   * @returns {string}
   */
  function resolveAddonLogPrefix(fallbackUiLabel = "UI"){
    const pathname = getNormalizedPathname();
    if (isKnownUiRuntime()){
      return `[NCUI][${resolveUiLogLabel(fallbackUiLabel)}]`;
    }
    if (isAddonUiPath(pathname)){
      return `[NCUI][${resolveUiLogLabel(fallbackUiLabel)}]`;
    }
    return "[NCBG]";
  }

  function redactSensitiveText(value){
    return String(value ?? "")
      .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
      .replace(/\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]*/gi, "Cookie: [redacted]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
      .replace(/(\/(?:s|call)\/)[^/?#\s]+/gi, "$1[redacted]")
      .replace(
        /(\/remote\.php\/dav\/(?:files|uploads)\/)[^/?#\s]+/gi,
        "$1[redacted]"
      )
      .replace(
        /(\/remote\.php\/dav\/addressbooks\/users\/)[^/?#\s]+/gi,
        "$1[redacted]"
      )
      .replace(
        /(\/ocs\/v2\.php\/apps\/spreed\/api\/v\d+\/room\/)[^/?#\s]+/gi,
        "$1[redacted]"
      )
      .replace(
        /(\/apps\/secrets\/share\/)[^/?#\s]+(?:#[^\s]*)?/gi,
        "$1[redacted]"
      )
      .replace(
        /((?:appPass|appPassword|app_password|authorization|cookie|credential|loginName|passphrase|password|pollToken|secret|token|userName)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s}&]+)/gi,
        "$1[redacted]"
      )
      .replace(
        /([?&](?:appPass|appPassword|app_password|authorization|cookie|credential|loginName|passphrase|password|pollToken|secret|token|userName)=)[^&#\s]+/gi,
        "$1[redacted]"
      );
  }

  function redactSensitiveLogValue(value, key = "", seen = new WeakSet()){
    if (SENSITIVE_LOG_KEY.test(String(key || ""))){
      return "[redacted]";
    }
    if (value == null || typeof value === "number" || typeof value === "boolean"){
      return value;
    }
    if (typeof value === "string"){
      return redactSensitiveText(value);
    }
    if (
      value instanceof Error
      || Object.prototype.toString.call(value) === "[object Error]"
      || (
        typeof value?.name === "string"
        && typeof value?.message === "string"
        && Object.keys(value).length === 0
      )
    ){
      const safeError = new Error(redactSensitiveText(value.message || String(value)));
      safeError.name = String(value.name || "Error");
      return safeError;
    }
    if (typeof value !== "object"){
      return redactSensitiveText(value);
    }
    if (seen.has(value)){
      return "[circular]";
    }
    seen.add(value);
    if (Array.isArray(value)){
      return value.map((entry) => redactSensitiveLogValue(entry, "", seen));
    }
    const sanitized = {};
    for (const [entryKey, entryValue] of Object.entries(value)){
      sanitized[entryKey] = redactSensitiveLogValue(entryValue, entryKey, seen);
    }
    return sanitized;
  }

  function writeFallbackConsoleError(prefix, scope, reportedError, loggingErrorMessage){
    try{
      console.error(
        prefix,
        scope,
        reportedError?.message || String(reportedError),
        "logging failed:",
        loggingErrorMessage
      );
    }catch(error){
      // Runtime teardown can invalidate console while a popup is closing.
    }
  }

  function safeConsoleError(prefix, scope, reportedError, details = undefined){
    let safeError;
    let safeDetails;
    try{
      safeError = redactSensitiveLogValue(reportedError);
      safeDetails = details === undefined
        ? undefined
        : redactSensitiveLogValue(details);
    }catch(error){
      safeError = new Error("Log details could not be sanitized.");
      safeDetails = undefined;
    }
    try{
      if (safeDetails !== undefined){
        console.error(prefix, scope, safeError, safeDetails);
        return;
      }
      console.error(prefix, scope, safeError);
    }catch(error){
      writeFallbackConsoleError(prefix, scope, safeError, error?.message || String(error));
    }
  }

  global.NCLogContext = {
    getNormalizedPathname,
    resolveUiLogLabel,
    isAddonUiPath,
    isKnownUiRuntime,
    resolveAddonLogPrefix,
    redactSensitiveText,
    redactSensitiveLogValue,
    safeConsoleError
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
