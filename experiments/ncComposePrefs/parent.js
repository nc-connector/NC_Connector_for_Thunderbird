/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
"use strict";

var {
  ExtensionCommon: { ExtensionAPI },
} = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

const PREF_BIG_ATTACH_NOTIFY = "mail.compose.big_attachments.notify";
const PREF_BIG_ATTACH_THRESHOLD_KB = "mail.compose.big_attachments.threshold_kb";
const DEFAULT_THRESHOLD_KB = 5120;

/**
 * Read compose-related Thunderbird preferences in a deterministic, read-only way.
 */
class NcComposePrefsContext {
  /**
   * @param {object} context
   */
  constructor(context) {
    this.context = context;
  }

  /**
   * Cleanup hook for context.callOnClose().
   */
  close() {
    this.context = null;
  }

  /**
   * Read the current big-attachment settings relevant for NC Connector.
   * @returns {{thresholdMb:number,lockActive:boolean}}
   */
  getBigAttachmentSettings() {
    const notifyEnabled = this._readBoolPref(PREF_BIG_ATTACH_NOTIFY, false);
    const thresholdKb = this._normalizeThresholdKb(
      this._readIntPref(PREF_BIG_ATTACH_THRESHOLD_KB, DEFAULT_THRESHOLD_KB)
    );
    const thresholdMb = Math.max(1, Math.floor(thresholdKb / 1024));
    const lockActive = notifyEnabled;
    return {
      thresholdMb,
      lockActive,
    };
  }

  /**
   * Read a boolean pref if available and type-correct.
   * @param {string} prefName
   * @param {boolean} fallback
   * @returns {boolean}
   */
  _readBoolPref(prefName, fallback) {
    const prefType = Services.prefs.getPrefType(prefName);
    if (prefType !== Ci.nsIPrefBranch.PREF_BOOL) {
      return !!fallback;
    }
    return Services.prefs.getBoolPref(prefName);
  }

  /**
   * Read an integer pref if available and type-correct.
   * @param {string} prefName
   * @param {number} fallback
   * @returns {number}
   */
  _readIntPref(prefName, fallback) {
    const prefType = Services.prefs.getPrefType(prefName);
    if (prefType !== Ci.nsIPrefBranch.PREF_INT) {
      return Number(fallback) || DEFAULT_THRESHOLD_KB;
    }
    return Services.prefs.getIntPref(prefName);
  }

  /**
   * Normalize threshold to a positive integer in KB.
   * @param {number} value
   * @returns {number}
   */
  _normalizeThresholdKb(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return DEFAULT_THRESHOLD_KB;
    }
    return Math.floor(parsed);
  }
}

this.ncComposePrefs = class extends ExtensionAPI {
  /**
   * Expose read-only compose preference API.
   * @param {object} context
   * @returns {object}
   */
  getAPI(context) {
    const apiContext = new NcComposePrefsContext(context);
    context.callOnClose(apiContext);
    return {
      ncComposePrefs: {
        async getBigAttachmentSettings() {
          return apiContext.getBigAttachmentSettings();
        },
      },
    };
  }
};
