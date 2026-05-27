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

  global.NCLogContext = {
    getNormalizedPathname,
    resolveUiLogLabel,
    isAddonUiPath,
    isKnownUiRuntime,
    resolveAddonLogPrefix
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
