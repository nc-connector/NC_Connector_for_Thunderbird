/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Password generator with configurable requirements.
 */
(function(global){
  "use strict";

  const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const LOWER = "abcdefghijkmnopqrstuvwxyz";
  const DIGITS = "23456789";
  const DEFAULT_SYMBOLS = "!@#$%^&*()-_=+?";

  /**
   * Return a random integer in the range [0, max).
   * @param {number} max
   * @returns {number}
   */
  function getRandomInt(max){
    if (max <= 0){
      return 0;
    }
    if (global.crypto && typeof global.crypto.getRandomValues === "function"){
      const buffer = new Uint32Array(1);
      global.crypto.getRandomValues(buffer);
      return buffer[0] % max;
    }
    return Math.floor(Math.random() * max);
  }

  function pick(set){
    return set.charAt(getRandomInt(set.length));
  }

  function shuffle(values){
    for (let i = values.length - 1; i > 0; i--){
      const j = getRandomInt(i + 1);
      const tmp = values[i];
      values[i] = values[j];
      values[j] = tmp;
    }
  }

  /**
   * Generate a password with configurable rules.
   * @param {{length?:number,requireUpper?:boolean,requireLower?:boolean,requireDigit?:boolean,requireSymbol?:boolean,symbolsSet?:string}} options
   * @returns {string}
   */
  function generatePassword(options){
    const opts = options || {};
    const length = Number.isFinite(opts.length) ? Math.max(1, opts.length) : 10;
    const requireUpper = opts.requireUpper !== false;
    const requireLower = opts.requireLower !== false;
    const requireDigit = opts.requireDigit !== false;
    const requireSymbol = opts.requireSymbol !== false;
    const symbolsSet = typeof opts.symbolsSet === "string" && opts.symbolsSet
      ? opts.symbolsSet
      : DEFAULT_SYMBOLS;

    const required = [];
    const pools = [];

    if (requireUpper){
      pools.push(UPPER);
      required.push(pick(UPPER));
    }
    if (requireLower){
      pools.push(LOWER);
      required.push(pick(LOWER));
    }
    if (requireDigit){
      pools.push(DIGITS);
      required.push(pick(DIGITS));
    }
    if (requireSymbol && symbolsSet){
      pools.push(symbolsSet);
      required.push(pick(symbolsSet));
    }

    const all = pools.length ? pools.join("") : (UPPER + LOWER + DIGITS + symbolsSet);
    const targetLength = Math.max(length, required.length);
    const chars = required.slice();
    while (chars.length < targetLength){
      chars.push(pick(all));
    }
    shuffle(chars);
    return chars.join("");
  }

  global.NCTalkPassword = { generatePassword };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
