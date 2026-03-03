/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Shared password policy client used by Talk and Sharing UIs.
 */
(function(global){
  "use strict";

  const LOCAL_STRONG_PASSWORD_MIN_LENGTH = 12;
  const LOCAL_STRONG_PASSWORD_SYMBOL_RE = /[!@#$%^&*()\-_=+\[\]{};:,.?]/;

  const EMPTY_POLICY = Object.freeze({
    hasPolicy: false,
    minLength: null,
    apiGenerateUrl: null,
    apiValidateUrl: null
  });

  /**
   * Build a mutable empty policy object.
   * @returns {{hasPolicy:boolean,minLength:number|null,apiGenerateUrl:string|null,apiValidateUrl:string|null}}
   */
  function createEmptyPolicy(){
    return {
      hasPolicy: false,
      minLength: null,
      apiGenerateUrl: null,
      apiValidateUrl: null
    };
  }

  /**
   * Normalize policy payload into a stable object shape.
   * @param {any} policy
   * @returns {{hasPolicy:boolean,minLength:number|null,apiGenerateUrl:string|null,apiValidateUrl:string|null}}
   */
  function normalizePolicy(policy){
    if (!policy || typeof policy !== "object"){
      return createEmptyPolicy();
    }
    const minLength = Number(policy.minLength);
    return {
      hasPolicy: !!policy.hasPolicy,
      minLength: Number.isFinite(minLength) ? minLength : null,
      apiGenerateUrl: policy.apiGenerateUrl ? String(policy.apiGenerateUrl) : null,
      apiValidateUrl: policy.apiValidateUrl ? String(policy.apiValidateUrl) : null
    };
  }

  /**
   * Read minimum password length from policy.
   * @param {any} policy
   * @returns {number|null}
   */
  function getPolicyMinLength(policy){
    const normalized = normalizePolicy(policy);
    const minLength = Number(normalized.minLength);
    return Number.isFinite(minLength) ? minLength : null;
  }

  /**
   * Validate a locally generated password against baseline strength rules.
   * Used when no server-side password policy is available.
   * @param {string} value
   * @param {{minLength?:number}} options
   * @returns {boolean}
   */
  function isStrongPassword(value, options = {}){
    const pwd = String(value || "");
    const minLength = Math.max(1, Number(options.minLength) || LOCAL_STRONG_PASSWORD_MIN_LENGTH);
    return pwd.length >= minLength
      && /[A-Z]/.test(pwd)
      && /[a-z]/.test(pwd)
      && /[0-9]/.test(pwd)
      && LOCAL_STRONG_PASSWORD_SYMBOL_RE.test(pwd);
  }

  /**
   * Log internal errors in a consistent way.
   * @param {(message:string,error:any)=>void|null} logger
   * @param {string} scope
   * @param {string} message
   * @param {any} error
   */
  function logError(logger, scope, message, error){
    const prefix = scope || "[NCUI][PasswordPolicy]";
    if (typeof logger === "function"){
      logger(message, error);
      return;
    }
    try{
      console.error(prefix, message, error);
    }catch(logError){
      console.error(prefix, message, error?.message || String(error), logError?.message || String(logError));
    }
  }

  /**
   * Fetch password policy from background.
   * @param {{sendMessage?:(message:any)=>Promise<any>,logger?:(message:string,error:any)=>void,logPrefix?:string}} options
   * @returns {Promise<{hasPolicy:boolean,minLength:number|null,apiGenerateUrl:string|null,apiValidateUrl:string|null}>}
   */
  async function loadPolicy(options = {}){
    const sendMessage = options.sendMessage || ((message) => browser.runtime.sendMessage(message));
    const logger = options.logger || null;
    const logPrefix = options.logPrefix || "[NCUI][PasswordPolicy]";
    try{
      const response = await sendMessage({ type: "passwordPolicy:fetch" });
      return normalizePolicy(response?.policy);
    }catch(error){
      logError(logger, logPrefix, "password policy fetch failed", error);
      return createEmptyPolicy();
    }
  }

  /**
   * Generate a password based on policy and fallback generator.
   * @param {{
   *  policy:any,
   *  sendMessage?:(message:any)=>Promise<any>,
   *  passwordGenerator:(options:any)=>string,
   *  fallbackLength?:number,
   *  logger?:(message:string,error:any)=>void,
   *  logPrefix?:string
   * }} options
   * @returns {Promise<string>}
   */
  async function generatePassword(options = {}){
    const normalizedPolicy = normalizePolicy(options.policy);
    const sendMessage = options.sendMessage || ((message) => browser.runtime.sendMessage(message));
    const passwordGenerator = options.passwordGenerator;
    const fallbackLength = Math.max(1, Number(options.fallbackLength) || 12);
    const logger = options.logger || null;
    const logPrefix = options.logPrefix || "[NCUI][PasswordPolicy]";

    if (normalizedPolicy.apiGenerateUrl){
      try{
        const response = await sendMessage({
          type: "passwordPolicy:generate",
          payload: { policy: normalizedPolicy }
        });
        if (response?.ok && response.password){
          return String(response.password);
        }
      }catch(error){
        logError(logger, logPrefix, "password generate failed", error);
      }
    }

    if (typeof passwordGenerator !== "function"){
      throw new Error("passwordGenerator is required");
    }
    const targetLength = Math.max(getPolicyMinLength(normalizedPolicy) || fallbackLength, fallbackLength);
    return passwordGenerator({
      length: targetLength,
      requireUpper: true,
      requireLower: true,
      requireDigit: true,
      requireSymbol: true
    });
  }

  global.NCPasswordPolicyClient = {
    EMPTY_POLICY,
    createEmptyPolicy,
    normalizePolicy,
    getPolicyMinLength,
    isStrongPassword,
    loadPolicy,
    generatePassword
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
