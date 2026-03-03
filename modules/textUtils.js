/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Text helpers for HTML escaping and expiry normalization.
 */
(function(global){
  "use strict";

  /**
   * Escape HTML special characters.
   * @param {any} value
   * @returns {string}
   */
  function escapeHtml(value){
    if (value == null) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Normalize a day count with a fallback value.
   * @param {any} value
   * @param {any} fallbackDays
   * @returns {number}
   */
  function normalizeExpireDays(value, fallbackDays){
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0){
      return parsed;
    }
    const fallback = parseInt(fallbackDays, 10);
    if (Number.isFinite(fallback) && fallback > 0){
      return fallback;
    }
    return 0;
  }

  /**
   * Format a byte value as a localized MB string.
   * @param {any} value
   * @param {{minimumFractionDigits?:number, maximumFractionDigits?:number}} options
   * @returns {string}
   */
  function formatSizeMb(value, options = {}){
    const bytes = Math.max(0, Number(value) || 0);
    const minimumFractionDigits = Number.isInteger(options?.minimumFractionDigits)
      ? options.minimumFractionDigits
      : 1;
    const maximumFractionDigits = Number.isInteger(options?.maximumFractionDigits)
      ? options.maximumFractionDigits
      : 1;
    const formatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits,
      maximumFractionDigits
    });
    return formatter.format(bytes / (1024 * 1024)) + " MB";
  }

  /**
   * Shorten a string for compact log output.
   * @param {any} value
   * @param {number} max
   * @returns {string}
   */
  function shortId(value, max = 12){
    if (value == null){
      return "";
    }
    const str = String(value);
    if (str.length <= max){
      return str;
    }
    return str.slice(0, max) + "...";
  }

  global.NCTalkTextUtils = { escapeHtml, normalizeExpireDays, formatSizeMb, shortId };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
