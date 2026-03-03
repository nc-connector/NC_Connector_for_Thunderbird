/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Background runtime state module.
 * Owns shared constants/maps, startup hydration from storage, and common
 * helpers used by other background runtime modules.
 */

const ROOM_META_KEY = "nctalkRoomMeta";
const EVENT_TOKEN_MAP_KEY = "nctalkEventTokenMap";
let DEBUG_ENABLED = false;
let ROOM_META = {};
let EVENT_TOKEN_MAP = {};
const TALK_LINK_REGEX = /(https?:\/\/[^\s"'<>]+\/call\/([A-Za-z0-9_-]+))/i;
const TALK_POPUP_WIDTH = 540;
const TALK_POPUP_HEIGHT = 860;
const SHARING_POPUP_WIDTH = 660;
const SHARING_POPUP_HEIGHT = 760;
const ATTACHMENT_PROMPT_WIDTH = 560;
const ATTACHMENT_PROMPT_HEIGHT = 260;
const ATTACHMENT_EVAL_DEBOUNCE_MS = 250;
const SHARING_LAUNCH_CONTEXT_TTL_MS = 15 * 60 * 1000;
const CALENDAR_WIZARD_CONTEXT_TTL_MS = 30 * 60 * 1000;
const CALENDAR_WIZARD_CONTEXTS = new Map();
const SHARING_LAUNCH_CONTEXTS = new Map();
const ATTACHMENT_PROMPT_BY_ID = new Map();
const ATTACHMENT_PROMPT_BY_TAB = new Map();
const ATTACHMENT_PROMPT_BY_WINDOW = new Map();
const ATTACHMENT_EVAL_TIMER_BY_TAB = new Map();
const ATTACHMENT_PENDING_ADDED_BY_TAB = new Map();
const ATTACHMENT_SUPPRESSED_TABS = new Set();
const PASSWORD_MAIL_DISPATCH_BY_TAB = new Map();
const COMPOSE_SHARE_CLEANUP_BY_TAB = new Map();
const SHARING_WIZARD_CLEANUP_BY_WINDOW = new Map();
const ATTACHMENT_DEFAULT_THRESHOLD_MB = NCSharingStorage.DEFAULT_ATTACHMENT_THRESHOLD_MB;
const COMPOSE_SHARE_CLEANUP_SEND_GRACE_MS = 15000;
const ROOM_CLEANUP_DELETE_DELAY_MS = 15 * 1000;
const ROOM_CLEANUP_BY_TOKEN = new Map();
const ROOM_CLEANUP_BY_EDITOR = new Map();
const INVITEE_SYNC_IN_FLIGHT = new Set();
const DELEGATION_IN_FLIGHT = new Set();
const FALLBACK_PASSWORD_POLICY = {
  hasPolicy: false,
  minLength: null,
  apiGenerateUrl: null
};
const SHARING_KEYS = NCSharingStorage?.SHARING_KEYS || {};
const bgShortId = NCTalkTextUtils.shortId;
const normalizeAttachmentThresholdMb = NCSharingStorage.normalizeAttachmentThresholdMb;

/**
 * Hydrate runtime state once when the background scripts load.
 */
(async () => {
  try{
    if (NCSharingStorage?.migrateLegacySharingKeys){
      await NCSharingStorage.migrateLegacySharingKeys();
    }
    const stored = await browser.storage.local.get(["debugEnabled", ROOM_META_KEY, EVENT_TOKEN_MAP_KEY]);
    DEBUG_ENABLED = !!stored.debugEnabled;
    ROOM_META = stored[ROOM_META_KEY] || {};
    EVENT_TOKEN_MAP = stored[EVENT_TOKEN_MAP_KEY] || {};
    if (DEBUG_ENABLED){
      try{
        const manifest = browser.runtime.getManifest();
        console.log("[NCBG] startup", {
          version: manifest?.version || "",
          hasApiCalendarItems: !!browser?.calendar?.items,
          hasApiNcCalToolbar: !!browser?.ncCalToolbar,
          hasApiNcCalToolbarGetCurrent: !!browser?.ncCalToolbar?.getCurrent,
          hasApiNcCalToolbarUpdateCurrent: !!browser?.ncCalToolbar?.updateCurrent,
          hasApiNcCalToolbarOnTrackedEditorClosed: !!browser?.ncCalToolbar?.onTrackedEditorClosed
        });
      }catch(e){
        console.error("[NCBG] startup manifest probe failed", e);
      }
    }
  }catch(error){
    console.error("[NCBG] startup init failed", error);
  }
})();

/**
 * Keep hot runtime mirrors in sync with storage updates.
 */
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.prototype.hasOwnProperty.call(changes, "debugEnabled")){
    DEBUG_ENABLED = !!changes.debugEnabled.newValue;
  }
  if (Object.prototype.hasOwnProperty.call(changes, ROOM_META_KEY)){
    ROOM_META = changes[ROOM_META_KEY].newValue || {};
  }
  if (Object.prototype.hasOwnProperty.call(changes, EVENT_TOKEN_MAP_KEY)){
    EVENT_TOKEN_MAP = changes[EVENT_TOKEN_MAP_KEY].newValue || {};
  }
});
/**
 * Log helper gated by the debug flag.
 * @param {...any} a
 */
function L(...a){
  if (!DEBUG_ENABLED) return;
  try{
    console.log("[NCBG]", ...a);
  }catch(error){
    console.error("[NCBG] debug log failed", error);
  }
}

/**
 * Shorten a token for log output.
 * @param {string} token
 * @param {{keepStart?:number, keepEnd?:number}} options
 * @returns {string}
 */
function shortToken(token, { keepStart = 4, keepEnd = 3 } = {}){
  if (!token) return "";
  const str = String(token);
  if (str.length <= keepStart + keepEnd + 3){
    return str;
  }
  return str.slice(0, keepStart) + "..." + str.slice(str.length - keepEnd);
}

/**
 * Create a localized Error using the i18n catalog.
 * @param {string} key
 * @param {Array<string>} substitutions
 * @returns {Error}
 */
function localizedError(key, substitutions = []){
  const message = bgI18n(key, substitutions);
  return new Error(message || key);
}
