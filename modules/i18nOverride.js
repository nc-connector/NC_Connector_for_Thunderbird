/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
"use strict";
(function(global){
  const cache = new Map();
  const pending = new Map();

  const SUPPORTED_LOCALES = Object.freeze([
    "cs",
    "de",
    "en",
    "es",
    "fr",
    "hu",
    "it",
    "ja",
    "nl",
    "pl",
    "pt_BR",
    "pt_PT",
    "ru",
    "zh_CN",
    "zh_TW"
  ]);
  const SUPPORTED_BY_LOWER = Object.freeze({
    cs: "cs",
    de: "de",
    en: "en",
    es: "es",
    fr: "fr",
    hu: "hu",
    it: "it",
    ja: "ja",
    nl: "nl",
    pl: "pl",
    pt_br: "pt_BR",
    pt_pt: "pt_PT",
    ru: "ru",
    zh_cn: "zh_CN",
    zh_tw: "zh_TW"
  });

  /**
   * Map a language tag to a supported locale folder name.
   *
   * Supported locale folders:
   * - {@link SUPPORTED_LOCALES}
   * @param {string} input
   * @returns {string}
   */
  function normalizeLang(input){
    const raw = String(input || "").trim();
    if (!raw){
      return "en";
    }
    const normalized = raw.toLowerCase().replace(/-/g, "_");
    if (SUPPORTED_BY_LOWER[normalized]){
      return SUPPORTED_BY_LOWER[normalized];
    }
    const parts = normalized.split("_").filter(Boolean);
    const base = parts[0] || "";
    const region = parts[1] || "";

    if (base === "pt"){
      if (region === "br"){
        return "pt_BR";
      }
      if (region === "pt"){
        return "pt_PT";
      }
      return "pt_PT";
    }

    if (base === "zh"){
      if (region === "tw" || region === "hk" || region === "mo" || region === "hant"){
        return "zh_TW";
      }
      if (region === "cn" || region === "sg" || region === "hans"){
        return "zh_CN";
      }
      return "zh_CN";
    }

    if (SUPPORTED_BY_LOWER[base]){
      return SUPPORTED_BY_LOWER[base];
    }

    return "en";
  }

  /**
   * Resolve "default" to the UI language and normalize to supported locales.
   * @param {string} requested
   * @returns {string}
   */
  function getEffectiveLang(requested){
    if (!requested || requested === "default"){
      const ui = global?.browser?.i18n?.getUILanguage
        ? global.browser.i18n.getUILanguage()
        : "en";
      return normalizeLang(ui);
    }
    return normalizeLang(requested);
  }

  /**
   * Load and cache the message bundle for a locale.
   * @param {string} lang
   * @returns {Promise<object>}
   */
  async function loadLocale(lang){
    const normalized = normalizeLang(lang);
    if (cache.has(normalized)){
      return cache.get(normalized);
    }
    if (pending.has(normalized)){
      return pending.get(normalized);
    }
    if (!global?.browser?.runtime?.getURL){
      return {};
    }
    const url = global.browser.runtime.getURL(`_locales/${normalized}/messages.json`);
    const promise = fetch(url)
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}))
      .then((data) => {
        const value = data && typeof data === "object" ? data : {};
        cache.set(normalized, value);
        pending.delete(normalized);
        return value;
      });
    pending.set(normalized, promise);
    return promise;
  }

  /**
   * Replace $1, $2 ... placeholders with substitutions.
   * @param {string} message
   * @param {string[]|string} substitutions
   * @returns {string}
   */
  function applySubstitutions(message, substitutions){
    const text = String(message || "");
    if (!substitutions || (Array.isArray(substitutions) && substitutions.length === 0)){
      return text.replace(/\$\$/g, "$");
    }
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    let out = text.replace(/\$\$/g, "$");
    values.forEach((value, index) => {
      const token = "$" + (index + 1);
      out = out.split(token).join(String(value ?? ""));
    });
    return out;
  }

  /**
   * Translate a key using the selected override language.
   * Falls back to browser.i18n if the key is missing.
   * @param {string} lang
   * @param {string} key
   * @param {string[]|string} substitutions
   * @returns {Promise<string>}
   */
  async function tInLang(lang, key, substitutions){
    const effective = getEffectiveLang(lang);
    const data = await loadLocale(effective);
    let message = "";
    if (data && data[key] && typeof data[key].message === "string"){
      message = data[key].message;
    }
    if (!message && global?.browser?.i18n?.getMessage){
      try{
        message = global.browser.i18n.getMessage(key, substitutions);
      }catch(_){
        message = "";
      }
    }
    return applySubstitutions(message, substitutions);
  }

  const api = {
    supportedLocales: SUPPORTED_LOCALES,
    normalizeLang,
    loadLocale,
    getEffectiveLang,
    tInLang
  };

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCI18nOverride = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
