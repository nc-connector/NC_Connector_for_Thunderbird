/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
const i18n = NCI18n.translate;
const DEFAULT_SHARING_EXPIRE_DAYS = 7;
const DEFAULT_SHARING_ATTACHMENT_THRESHOLD_MB = NCSharingStorage.DEFAULT_ATTACHMENT_THRESHOLD_MB;
const DEFAULT_SHARING_SHARE_NAME = i18n("sharing_share_default") || "Share name";
const DEFAULT_TALK_TITLE = i18n("ui_default_title") || "Meeting";
const FALLBACK_POPUP_WIDTH = 520;
const FALLBACK_POPUP_HEIGHT = 320;
const SHARING_KEYS = NCSharingStorage.SHARING_KEYS;
const normalizeAttachmentThresholdMb = NCSharingStorage.normalizeAttachmentThresholdMb;
const OPTIONS_LOG_PREFIX = "[NCOPT]";
const SYSTEM_ADDRESSBOOK_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md#system-address-book-required-for-user-search-and-moderator-selection";
const POLICY_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md";
const ATTACHMENT_AUTOMATION_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md#47-attachment-automation-prerequisite-disable-competing-thunderbird-compose-features";
const NC_CONNECTOR_HOMEPAGE_URL = "https://nc-connector.de";

/**
 * Log internal options-page errors.
 * @param {string} scope
 * @param {any} error
 */
function logOptionsError(scope, error){
  try{
    console.error(OPTIONS_LOG_PREFIX, scope, error);
  }catch(logError){
    console.error(OPTIONS_LOG_PREFIX, scope, error?.message || String(error), logError?.message || String(logError));
  }
}

NCTalkDomI18n.translatePage(i18n, { titleKey: "options_title" });
initTabs();
initAbout();

const statusEl = document.getElementById("status");
const baseUrlInput = document.getElementById("baseUrl");
const userInput = document.getElementById("user");
const appPassInput = document.getElementById("appPass");
const policyWarningRow = document.getElementById("policyWarningRow");
const policyWarningText = document.getElementById("policyWarningText");
const policyWarningAdminLink = document.getElementById("policyWarningAdminLink");
const sharingBaseRow = document.getElementById("sharingBaseRow");
const sharingDefaultShareNameRow = document.getElementById("sharingDefaultShareNameRow");
const sharingDefaultPermissionsRow = document.getElementById("sharingDefaultPermissionsRow");
const sharingDefaultPasswordRow = document.getElementById("sharingDefaultPasswordRow");
const sharingBaseInput = document.getElementById("sharingBase");
const sharingDefaultShareNameInput = document.getElementById("sharingDefaultShareName");
const sharingDefaultPermCreateInput = document.getElementById("sharingDefaultPermCreate");
const sharingDefaultPermWriteInput = document.getElementById("sharingDefaultPermWrite");
const sharingDefaultPermDeleteInput = document.getElementById("sharingDefaultPermDelete");
const sharingDefaultPasswordInput = document.getElementById("sharingDefaultPassword");
const sharingDefaultPasswordSeparateRow = document.getElementById("sharingDefaultPasswordSeparateRow");
const sharingDefaultPasswordSeparateInput = document.getElementById("sharingDefaultPasswordSeparate");
const sharingDefaultExpireDaysRow = document.getElementById("sharingDefaultExpireDaysRow");
const sharingDefaultExpireDaysInput = document.getElementById("sharingDefaultExpireDays");
const sharingAttachmentsAlwaysNcInput = document.getElementById("sharingAttachmentsAlwaysNc");
const sharingAttachmentsAlwaysRow = document.getElementById("sharingAttachmentsAlwaysRow");
const sharingAttachmentsOfferRow = document.getElementById("sharingAttachmentsOfferRow");
const sharingAttachmentsOfferAboveEnabledInput = document.getElementById("sharingAttachmentsOfferAboveEnabled");
const sharingAttachmentsOfferAboveMbInput = document.getElementById("sharingAttachmentsOfferAboveMb");
const sharingAttachmentsLockBox = document.getElementById("sharingAttachmentsLock");
const sharingAttachmentsLockText = document.getElementById("sharingAttachmentsLockText");
const sharingAttachmentsAdminLink = document.getElementById("sharingAttachmentsAdminLink");
const talkDefaultTitleRow = document.getElementById("talkDefaultTitleRow");
const talkDefaultTitleInput = document.getElementById("talkDefaultTitle");
const talkDefaultLobbyRow = document.getElementById("talkDefaultLobbyRow");
const talkDefaultLobbyInput = document.getElementById("talkDefaultLobby");
const talkDefaultListableRow = document.getElementById("talkDefaultListableRow");
const talkDefaultListableInput = document.getElementById("talkDefaultListable");
const talkDefaultAddUsersInput = document.getElementById("talkDefaultAddUsers");
const talkDefaultAddUsersRow = document.getElementById("talkDefaultAddUsersRow");
const optionsAddUsersTooltipList = document.getElementById("optionsAddUsersTooltipList");
const optionsAddUsersAddressbookLockHint = document.getElementById("optionsAddUsersAddressbookLockHint");
const talkDefaultAddGuestsInput = document.getElementById("talkDefaultAddGuests");
const talkDefaultAddGuestsRow = document.getElementById("talkDefaultAddGuestsRow");
const optionsAddGuestsTooltipList = document.getElementById("optionsAddGuestsTooltipList");
const optionsAddGuestsAddressbookLockHint = document.getElementById("optionsAddGuestsAddressbookLockHint");
const talkAddressbookWarningRow = document.getElementById("talkAddressbookWarningRow");
const optionsTalkAddressbookAdminLink = document.getElementById("optionsTalkAddressbookAdminLink");
const talkDefaultPasswordRow = document.getElementById("talkDefaultPasswordRow");
const talkDefaultPasswordInput = document.getElementById("talkDefaultPassword");
const talkDefaultRoomTypeRow = document.getElementById("talkDefaultRoomTypeRow");
const talkDefaultRoomTypePicker = document.getElementById("talkDefaultRoomTypePicker");
const talkDefaultRoomTypeButton = document.getElementById("talkDefaultRoomTypeButton");
const talkDefaultRoomTypeButtonLabel = document.getElementById("talkDefaultRoomTypeButtonLabel");
const talkDefaultRoomTypeDropdown = document.getElementById("talkDefaultRoomTypeDropdown");
const talkDefaultRoomTypeValueInput = document.getElementById("talkDefaultRoomType");
const talkDefaultRoomTypeOptions = Array.from(document.querySelectorAll(".options-roomtype-option"));
const shareBlockLangRow = document.getElementById("shareBlockLangRow");
const shareBlockLangSelect = document.getElementById("shareBlockLang");
const eventDescriptionLangRow = document.getElementById("eventDescriptionLangRow");
const eventDescriptionLangSelect = document.getElementById("eventDescriptionLang");
const DEFAULT_SHARING_BASE = (typeof NCSharing !== "undefined" ? NCSharing.DEFAULT_BASE_PATH : "NC Connector");
let statusTimer = null;
let composeAttachmentSettingsLocked = false;
let runtimePolicyStatus = null;
let policyLockTalkAddUsers = false;
let policyLockTalkAddGuests = false;
let policyLockSharingAttachmentsAlways = false;
let policyLockSharingAttachmentsThreshold = false;
let talkAddressbookLockActive = false;
let talkAddressbookLockDetail = "";
const SUPPORTED_OVERRIDE_LOCALES = getSupportedOverrideLocales();
const LANG_OPTIONS = new Set(["default", "custom", ...SUPPORTED_OVERRIDE_LOCALES]);
initLanguageOverrideSelects();
initTalkDefaultRoomTypePicker();
if (optionsTalkAddressbookAdminLink){
  optionsTalkAddressbookAdminLink.href = SYSTEM_ADDRESSBOOK_ADMIN_URL;
}
if (policyWarningAdminLink){
  policyWarningAdminLink.href = POLICY_ADMIN_URL;
}
if (sharingAttachmentsAdminLink){
  sharingAttachmentsAdminLink.href = ATTACHMENT_AUTOMATION_ADMIN_URL;
}

/**
 * Toggle one tooltip list between normal and lock-hint entries via shared UI helper.
 * @param {HTMLElement|null} tooltipList
 * @param {boolean} lockActive
 */
function applySharedAddressbookTooltipState(tooltipList, lockActive){
  const applyTooltipState = window.NCAddressbookUi?.applySystemAddressbookTooltipState;
  if (typeof applyTooltipState !== "function"){
    return;
  }
  applyTooltipState(tooltipList, lockActive);
}

/**
 * Read the list of supported locale folders for language override settings.
 * @returns {string[]}
 */
function getSupportedOverrideLocales(){
  try{
    if (typeof NCI18nOverride !== "undefined" && Array.isArray(NCI18nOverride?.supportedLocales) && NCI18nOverride.supportedLocales.length){
      return Array.from(new Set(NCI18nOverride.supportedLocales));
    }
  }catch(error){
    logOptionsError("supported locales detection failed", error);
  }
  return ["en", "de", "fr"];
}

/**
 * Initialize the language override selects in the advanced settings tab.
 */
function initLanguageOverrideSelects(){
  refreshLanguageOverrideSelects();
}

/**
 * Get the UI language (BCP47) used for display names.
 * @returns {string}
 */
function getUiLanguage(){
  try{
    if (typeof browser !== "undefined" && browser?.i18n?.getUILanguage){
      return browser.i18n.getUILanguage() || "en";
    }
  }catch(error){
    logOptionsError("ui language detection failed", error);
  }
  return "en";
}

/**
 * Convert a locale folder name to a BCP47 language tag.
 * @param {string} locale
 * @returns {string}
 */
function toBcp47Tag(locale){
  return String(locale || "").replace(/_/g, "-");
}

/**
 * Create an Intl.DisplayNames instance for language labels.
 * @param {string} uiLang
 * @returns {Intl.DisplayNames|null}
 */
function makeDisplayNames(uiLang){
  if (typeof Intl === "undefined" || typeof Intl.DisplayNames !== "function"){
    return null;
  }
  try{
    return new Intl.DisplayNames([uiLang], { type: "language" });
  }catch(error){
    logOptionsError("Intl.DisplayNames init failed", error);
    return null;
  }
}

/**
 * Create an Intl.Collator instance for locale-aware sorting.
 * @param {string} uiLang
 * @returns {Intl.Collator|null}
 */
function makeCollator(uiLang){
  if (typeof Intl === "undefined" || typeof Intl.Collator !== "function"){
    return null;
  }
  try{
    return new Intl.Collator([uiLang], { sensitivity: "base", numeric: true });
  }catch(error){
    logOptionsError("Intl.Collator init failed", error);
    return null;
  }
}

/**
 * Get a localized display label for a locale.
 * @param {string} locale
 * @param {Intl.DisplayNames|null} displayNames
 * @returns {string}
 */
function getLocaleLabel(locale, displayNames){
  const tag = toBcp47Tag(locale);
  if (displayNames){
    try{
      const label = displayNames.of(tag);
      if (label){
        return label;
      }
    }catch(error){
      logOptionsError("locale label lookup failed", error);
    }
  }
  return tag || String(locale || "");
}

/**
 * Order locales with common languages first, then UI-sorted.
 * @param {string[]} locales
 * @param {Intl.DisplayNames|null} displayNames
 * @param {Intl.Collator|null} collator
 * @returns {string[]}
 */
function orderOverrideLocales(locales, displayNames, collator){
  const list = Array.isArray(locales) ? locales.slice() : [];
  const primary = ["en", "de", "fr"];
  const prioritized = primary.filter((locale) => list.includes(locale));
  const remaining = list.filter((locale) => !prioritized.includes(locale));
  const labelCache = new Map();
  const labelOf = (locale) => {
    if (!labelCache.has(locale)){
      labelCache.set(locale, getLocaleLabel(locale, displayNames));
    }
    return labelCache.get(locale);
  };
  remaining.sort((a, b) => {
    const la = labelOf(a);
    const lb = labelOf(b);
    const cmp = collator ? collator.compare(la, lb) : String(la).localeCompare(String(lb));
    return cmp !== 0 ? cmp : String(a).localeCompare(String(b));
  });
  return [...prioritized, ...remaining];
}

/**
 * Populate a select element with default + supported override locales.
 * @param {HTMLSelectElement|null} selectEl
 * @param {string[]} locales
 * @param {Intl.DisplayNames|null} displayNames
 */
function populateLanguageSelect(selectEl, locales, displayNames, options = {}){
  if (!selectEl){
    return;
  }
  selectEl.textContent = "";
  const showCustom = !!options.showCustom;
  const enableCustom = !!options.enableCustom;

  const defaultOption = document.createElement("option");
  defaultOption.value = "default";
  defaultOption.textContent = i18n("options_lang_default") || "default";
  selectEl.appendChild(defaultOption);

  if (showCustom){
    const customOption = document.createElement("option");
    customOption.value = "custom";
    customOption.textContent = i18n("options_lang_custom") || "Custom (backend template)";
    customOption.disabled = !enableCustom;
    selectEl.appendChild(customOption);
  }

  locales.forEach((locale) => {
    const option = document.createElement("option");
    option.value = locale;
    option.textContent = getLocaleLabel(locale, displayNames);
    selectEl.appendChild(option);
  });
}

/**
 * Show a transient status message in the options UI.
 * @param {string} message
 * @param {boolean} isError
 * @param {boolean} sticky
 * @param {boolean} isSuccess
 */
function showStatus(message, isError = false, sticky = false, isSuccess = false){
  if (statusTimer){
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#b00020" : (isSuccess ? "#11883a" : "");
  if (message && !isError && !sticky){
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
      statusTimer = null;
    }, 2000);
  }
}

/**
 * Return true when backend policy mode is currently active.
 * @returns {boolean}
 */
function isBackendPolicyActive(){
  return !!runtimePolicyStatus?.policyActive;
}

/**
 * Return true when the NC Connector backend endpoint is available.
 * @returns {boolean}
 */
function isBackendEndpointAvailable(){
  return !!runtimePolicyStatus?.endpointAvailable;
}

/**
 * Return true when the current user has an active backend seat.
 * @returns {boolean}
 */
function hasBackendSeatEntitlement(){
  const status = runtimePolicyStatus?.status;
  const seatState = String(status?.seatState || "").trim().toLowerCase();
  return !!(
    runtimePolicyStatus?.endpointAvailable
    && status?.seatAssigned
    && status?.isValid
    && seatState === "active"
  );
}

/**
 * Return the language policy key for one domain.
 * @param {"share"|"talk"} domain
 * @returns {string}
 */
function getPolicyLanguageKey(domain){
  return domain === "talk" ? "language_talk_description" : "language_share_html_block";
}

/**
 * Return the backend template key for one domain.
 * @param {"share"|"talk"} domain
 * @returns {string}
 */
function getPolicyTemplateKey(domain){
  return domain === "talk" ? "talk_invitation_template" : "share_html_block_template";
}

/**
 * Return true when backend-driven custom template mode can be selected for one domain.
 * This requires an active backend policy, language=`custom`, and a non-empty template.
 * @param {"share"|"talk"} domain
 * @returns {boolean}
 */
function isCustomLanguageModeAvailable(domain){
  if (!isBackendEndpointAvailable() || !isBackendPolicyActive()){
    return false;
  }
  const language = normalizeLangChoice(
    coercePolicyString(readBackendPolicyValue(domain, getPolicyLanguageKey(domain)), ""),
    { allowCustom: true }
  );
  const template = coercePolicyString(readBackendPolicyValue(domain, getPolicyTemplateKey(domain)), "");
  return language === "custom" && !!template;
}

/**
 * Return true when separate password delivery is available.
 * @returns {boolean}
 */
function isSeparatePasswordMailFeatureAvailable(){
  return hasBackendSeatEntitlement();
}

/**
 * Return the lock hint for separate password delivery when unavailable.
 * @returns {string}
 */
function getSeparatePasswordUnavailableHint(){
  const status = runtimePolicyStatus?.status;
  const seatState = String(status?.seatState || "").trim().toLowerCase();
  if (!isBackendEndpointAvailable()){
    return i18n("sharing_password_separate_backend_required_tooltip")
      || "This feature requires the Nextcloud backend.";
  }
  if (!status?.seatAssigned){
    return i18n("sharing_password_separate_no_seat_tooltip")
      || "Your administrator must assign an NC Connector seat to your account for this feature.";
  }
  if (!status?.isValid || seatState !== "active"){
    return i18n("sharing_password_separate_paused_tooltip")
      || "Your NC Connector seat is currently paused. Please contact your Nextcloud administrator.";
  }
  return "";
}

/**
 * Repopulate language selects and expose `custom` only when the backend exists.
 * The option stays visible but disabled until the backend policy actually uses
 * a custom template for the respective domain.
 */
function refreshLanguageOverrideSelects(){
  const uiLang = getUiLanguage();
  const displayNames = makeDisplayNames(uiLang);
  const collator = makeCollator(uiLang);
  const orderedLocales = orderOverrideLocales(SUPPORTED_OVERRIDE_LOCALES, displayNames, collator);
  const showCustom = isBackendEndpointAvailable();
  const allowShareCustom = isCustomLanguageModeAvailable("share");
  const allowTalkCustom = isCustomLanguageModeAvailable("talk");
  const currentShareLang = normalizeLangChoice(shareBlockLangSelect?.value, { allowCustom: allowShareCustom });
  const currentTalkLang = normalizeLangChoice(eventDescriptionLangSelect?.value, { allowCustom: allowTalkCustom });
  populateLanguageSelect(shareBlockLangSelect, orderedLocales, displayNames, {
    showCustom,
    enableCustom: allowShareCustom
  });
  populateLanguageSelect(eventDescriptionLangSelect, orderedLocales, displayNames, {
    showCustom,
    enableCustom: allowTalkCustom
  });
  if (shareBlockLangSelect){
    shareBlockLangSelect.value = currentShareLang;
  }
  if (eventDescriptionLangSelect){
    eventDescriptionLangSelect.value = currentTalkLang;
  }
}

/**
 * Read one backend policy value.
 * @param {"share"|"talk"} domain
 * @param {string} key
 * @returns {any}
 */
function readBackendPolicyValue(domain, key){
  const domainPolicy = runtimePolicyStatus?.policy?.[domain];
  if (!domainPolicy || typeof domainPolicy !== "object"){
    return null;
  }
  return Object.prototype.hasOwnProperty.call(domainPolicy, key)
    ? domainPolicy[key]
    : null;
}

/**
 * Return true when a backend policy key exists, even if its value is `null`.
 * @param {"share"|"talk"} domain
 * @param {string} key
 * @returns {boolean}
 */
function hasBackendPolicyKey(domain, key){
  const domainPolicy = runtimePolicyStatus?.policy?.[domain];
  return !!domainPolicy
    && typeof domainPolicy === "object"
    && Object.prototype.hasOwnProperty.call(domainPolicy, key);
}

/**
 * Return true when the backend explicitly disables one setting via `null`.
 * @param {"share"|"talk"} domain
 * @param {string} key
 * @returns {boolean}
 */
function isBackendPolicyExplicitNull(domain, key){
  return hasBackendPolicyKey(domain, key) && readBackendPolicyValue(domain, key) == null;
}

/**
 * Return true when a policy setting is admin-locked.
 * @param {"share"|"talk"} domain
 * @param {string} key
 * @returns {boolean}
 */
function isPolicyLocked(domain, key){
  if (!runtimePolicyStatus?.policyActive){
    return false;
  }
  const editableDomain = runtimePolicyStatus?.policyEditable?.[domain];
  if (!editableDomain || typeof editableDomain !== "object"){
    return false;
  }
  return editableDomain[key] === false;
}

/**
 * Return the localized admin-controlled tooltip text.
 * @returns {string}
 */
function getAdminControlledHint(){
  return i18n("policy_admin_controlled_tooltip") || "Admin controlled";
}

/**
 * Convert a policy value to boolean while keeping a fallback.
 * @param {any} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function coercePolicyBoolean(value, fallback){
  if (value === true){
    return true;
  }
  if (value === false){
    return false;
  }
  return fallback;
}

/**
 * Convert a policy value to integer while keeping a fallback.
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 */
function coercePolicyInt(value, fallback){
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)){
    return fallback;
  }
  return parsed;
}

/**
 * Convert a policy value to non-empty string while keeping a fallback.
 * @param {any} value
 * @param {string} fallback
 * @returns {string}
 */
function coercePolicyString(value, fallback){
  const text = String(value ?? "").trim();
  return text || fallback;
}

/**
 * Resolve one persisted value with policy lock override.
 * @param {"share"|"talk"} domain
 * @param {string} key
 * @param {any} localValue
 * @param {(value:any, fallback:any)=>any} coerce
 * @returns {any}
 */
function resolvePersistedValue(domain, key, localValue, coerce){
  if (!isPolicyLocked(domain, key)){
    return localValue;
  }
  const policyValue = readBackendPolicyValue(domain, key);
  return typeof coerce === "function" ? coerce(policyValue, localValue) : localValue;
}

/**
 * Apply one lock title to row/input elements.
 * @param {HTMLElement|null} row
 * @param {HTMLElement|null} input
 * @param {boolean} locked
 */
function applyLockTitle(row, input, locked){
  const title = locked ? getAdminControlledHint() : "";
  if (row){
    row.title = title;
    row.classList.toggle("is-disabled", !!locked);
  }
  if (input){
    input.title = title;
  }
}

/**
 * Show/hide the policy warning in options.
 */
function applyPolicyWarningUi(){
  if (!policyWarningRow){
    return;
  }
  const warning = runtimePolicyStatus?.warning || {};
  const visible = !!warning.visible;
  policyWarningRow.hidden = !visible;
  if (!visible){
    return;
  }
  let message = i18n("policy_warning_license_invalid");
  if (warning.code === "license_invalid"){
    message = i18n("policy_warning_license_invalid");
  }
  if (policyWarningText){
    policyWarningText.textContent = message || "";
  }
}

/**
 * Refresh backend policy runtime status.
 * @returns {Promise<void>}
 */
async function refreshBackendPolicyStatus(){
  try{
    const response = await browser.runtime.sendMessage({
      type: "policy:getStatus"
    });
    if (response?.ok && response.status){
      runtimePolicyStatus = response.status;
    }
  }catch(error){
    logOptionsError("policy status check failed", error);
  }
  refreshLanguageOverrideSelects();
  applyPolicyWarningUi();
  applyPolicySettingsOverlay();
}

/**
 * Apply policy values and lock states to options controls.
 * Locked controls always show the policy value.
 */
function applyPolicySettingsOverlay(){
  const policyActive = isBackendPolicyActive();
  const lockShareBase = policyActive && isPolicyLocked("share", "share_base_directory");
  const lockShareName = policyActive && isPolicyLocked("share", "share_name_template");
  const lockPermUpload = policyActive && isPolicyLocked("share", "share_permission_upload");
  const lockPermEdit = policyActive && isPolicyLocked("share", "share_permission_edit");
  const lockPermDelete = policyActive && isPolicyLocked("share", "share_permission_delete");
  const lockSharePassword = policyActive && isPolicyLocked("share", "share_set_password");
  const lockSharePasswordSeparate = policyActive && isPolicyLocked("share", "share_send_password_separately");
  const lockShareExpire = policyActive && isPolicyLocked("share", "share_expire_days");
  policyLockSharingAttachmentsAlways = policyActive && isPolicyLocked("share", "attachments_always_via_ncconnector");
  policyLockSharingAttachmentsThreshold = policyActive && isPolicyLocked("share", "attachments_min_size_mb");
  const lockShareLang = policyActive && isPolicyLocked("share", "language_share_html_block");
  const lockTalkTitle = policyActive && isPolicyLocked("talk", "talk_title");
  const lockTalkLobby = policyActive && isPolicyLocked("talk", "talk_lobby_active");
  const lockTalkListable = policyActive && isPolicyLocked("talk", "talk_show_in_search");
  policyLockTalkAddUsers = policyActive && isPolicyLocked("talk", "talk_add_users");
  policyLockTalkAddGuests = policyActive && isPolicyLocked("talk", "talk_add_guests");
  const lockTalkPassword = policyActive && isPolicyLocked("talk", "talk_set_password");
  const lockTalkRoomType = policyActive && isPolicyLocked("talk", "talk_room_type");
  const lockTalkLang = policyActive && isPolicyLocked("talk", "language_talk_description");

  if (lockShareBase && sharingBaseInput){
    sharingBaseInput.value = coercePolicyString(readBackendPolicyValue("share", "share_base_directory"), sharingBaseInput.value || DEFAULT_SHARING_BASE);
  }
  if (lockShareName && sharingDefaultShareNameInput){
    sharingDefaultShareNameInput.value = coercePolicyString(readBackendPolicyValue("share", "share_name_template"), sharingDefaultShareNameInput.value || DEFAULT_SHARING_SHARE_NAME);
  }
  if (lockPermUpload && sharingDefaultPermCreateInput){
    sharingDefaultPermCreateInput.checked = coercePolicyBoolean(readBackendPolicyValue("share", "share_permission_upload"), sharingDefaultPermCreateInput.checked);
  }
  if (lockPermEdit && sharingDefaultPermWriteInput){
    sharingDefaultPermWriteInput.checked = coercePolicyBoolean(readBackendPolicyValue("share", "share_permission_edit"), sharingDefaultPermWriteInput.checked);
  }
  if (lockPermDelete && sharingDefaultPermDeleteInput){
    sharingDefaultPermDeleteInput.checked = coercePolicyBoolean(readBackendPolicyValue("share", "share_permission_delete"), sharingDefaultPermDeleteInput.checked);
  }
  if (lockSharePassword && sharingDefaultPasswordInput){
    sharingDefaultPasswordInput.checked = coercePolicyBoolean(readBackendPolicyValue("share", "share_set_password"), sharingDefaultPasswordInput.checked);
  }
  if (lockSharePasswordSeparate && sharingDefaultPasswordSeparateInput){
    sharingDefaultPasswordSeparateInput.checked = coercePolicyBoolean(readBackendPolicyValue("share", "share_send_password_separately"), sharingDefaultPasswordSeparateInput.checked);
  }
  if (!isSeparatePasswordMailFeatureAvailable() && sharingDefaultPasswordSeparateInput){
    sharingDefaultPasswordSeparateInput.checked = false;
  }
  if (lockShareExpire && sharingDefaultExpireDaysInput){
    sharingDefaultExpireDaysInput.value = String(
      NCTalkTextUtils.normalizeExpireDays(
        coercePolicyInt(readBackendPolicyValue("share", "share_expire_days"), Number.parseInt(sharingDefaultExpireDaysInput.value || "", 10)),
        DEFAULT_SHARING_EXPIRE_DAYS
      )
    );
  }
  if (policyLockSharingAttachmentsAlways && sharingAttachmentsAlwaysNcInput){
    sharingAttachmentsAlwaysNcInput.checked = coercePolicyBoolean(
      readBackendPolicyValue("share", "attachments_always_via_ncconnector"),
      sharingAttachmentsAlwaysNcInput.checked
    );
  }
  if (policyLockSharingAttachmentsThreshold && sharingAttachmentsOfferAboveMbInput){
    const thresholdDisabled = isBackendPolicyExplicitNull("share", "attachments_min_size_mb");
    if (!thresholdDisabled){
      sharingAttachmentsOfferAboveMbInput.value = String(
        normalizeAttachmentThresholdMb(
          coercePolicyInt(
            readBackendPolicyValue("share", "attachments_min_size_mb"),
            Number.parseInt(sharingAttachmentsOfferAboveMbInput.value || "", 10)
          )
        )
      );
    }
    if (sharingAttachmentsOfferAboveEnabledInput){
      sharingAttachmentsOfferAboveEnabledInput.checked = !thresholdDisabled;
    }
  }
  if (lockShareLang && shareBlockLangSelect){
    shareBlockLangSelect.value = normalizeLangChoice(
      coercePolicyString(readBackendPolicyValue("share", "language_share_html_block"), shareBlockLangSelect.value),
      { allowCustom: isCustomLanguageModeAvailable("share") }
    );
  }
  if (lockTalkTitle && talkDefaultTitleInput){
    talkDefaultTitleInput.value = coercePolicyString(readBackendPolicyValue("talk", "talk_title"), talkDefaultTitleInput.value || DEFAULT_TALK_TITLE);
  }
  if (lockTalkLobby && talkDefaultLobbyInput){
    talkDefaultLobbyInput.checked = coercePolicyBoolean(readBackendPolicyValue("talk", "talk_lobby_active"), talkDefaultLobbyInput.checked);
  }
  if (lockTalkListable && talkDefaultListableInput){
    talkDefaultListableInput.checked = coercePolicyBoolean(readBackendPolicyValue("talk", "talk_show_in_search"), talkDefaultListableInput.checked);
  }
  if (policyLockTalkAddUsers && talkDefaultAddUsersInput){
    talkDefaultAddUsersInput.checked = coercePolicyBoolean(readBackendPolicyValue("talk", "talk_add_users"), talkDefaultAddUsersInput.checked);
  }
  if (policyLockTalkAddGuests && talkDefaultAddGuestsInput){
    talkDefaultAddGuestsInput.checked = coercePolicyBoolean(readBackendPolicyValue("talk", "talk_add_guests"), talkDefaultAddGuestsInput.checked);
  }
  if (lockTalkPassword && talkDefaultPasswordInput){
    talkDefaultPasswordInput.checked = coercePolicyBoolean(readBackendPolicyValue("talk", "talk_set_password"), talkDefaultPasswordInput.checked);
  }
  if (lockTalkRoomType){
    const raw = coercePolicyString(readBackendPolicyValue("talk", "talk_room_type"), getSelectedTalkDefaultRoomType());
    setTalkDefaultRoomType(raw === "event" ? "event" : "normal");
  }
  if (lockTalkLang && eventDescriptionLangSelect){
    eventDescriptionLangSelect.value = normalizeLangChoice(
      coercePolicyString(readBackendPolicyValue("talk", "language_talk_description"), eventDescriptionLangSelect.value),
      { allowCustom: isCustomLanguageModeAvailable("talk") }
    );
  }

  if (sharingBaseInput){
    sharingBaseInput.disabled = lockShareBase;
    applyLockTitle(sharingBaseRow, sharingBaseInput, lockShareBase);
  }
  if (sharingDefaultShareNameInput){
    sharingDefaultShareNameInput.disabled = lockShareName;
    applyLockTitle(sharingDefaultShareNameRow, sharingDefaultShareNameInput, lockShareName);
  }
  if (sharingDefaultPermCreateInput){
    sharingDefaultPermCreateInput.disabled = lockPermUpload;
  }
  if (sharingDefaultPermWriteInput){
    sharingDefaultPermWriteInput.disabled = lockPermEdit;
  }
  if (sharingDefaultPermDeleteInput){
    sharingDefaultPermDeleteInput.disabled = lockPermDelete;
  }
  applyLockTitle(
    sharingDefaultPermissionsRow,
    sharingDefaultPermCreateInput,
    lockPermUpload || lockPermEdit || lockPermDelete
  );
  if (sharingDefaultPasswordInput){
    sharingDefaultPasswordInput.disabled = lockSharePassword;
    applyLockTitle(sharingDefaultPasswordRow, sharingDefaultPasswordInput, lockSharePassword);
  }
  if (sharingDefaultExpireDaysInput){
    sharingDefaultExpireDaysInput.disabled = lockShareExpire;
    applyLockTitle(sharingDefaultExpireDaysRow, sharingDefaultExpireDaysInput, lockShareExpire);
  }
  if (shareBlockLangSelect){
    shareBlockLangSelect.disabled = lockShareLang;
    applyLockTitle(shareBlockLangRow, shareBlockLangSelect, lockShareLang);
  }
  if (talkDefaultTitleInput){
    talkDefaultTitleInput.disabled = lockTalkTitle;
    applyLockTitle(talkDefaultTitleRow, talkDefaultTitleInput, lockTalkTitle);
  }
  if (talkDefaultLobbyInput){
    talkDefaultLobbyInput.disabled = lockTalkLobby;
    applyLockTitle(talkDefaultLobbyRow, talkDefaultLobbyInput, lockTalkLobby);
  }
  if (talkDefaultListableInput){
    talkDefaultListableInput.disabled = lockTalkListable;
    applyLockTitle(talkDefaultListableRow, talkDefaultListableInput, lockTalkListable);
  }
  if (talkDefaultPasswordInput){
    talkDefaultPasswordInput.disabled = lockTalkPassword;
    applyLockTitle(talkDefaultPasswordRow, talkDefaultPasswordInput, lockTalkPassword);
  }
  if (eventDescriptionLangSelect){
    eventDescriptionLangSelect.disabled = lockTalkLang;
    applyLockTitle(eventDescriptionLangRow, eventDescriptionLangSelect, lockTalkLang);
  }
  if (talkDefaultRoomTypeButton){
    talkDefaultRoomTypeButton.disabled = lockTalkRoomType;
    applyLockTitle(talkDefaultRoomTypeRow, talkDefaultRoomTypeButton, lockTalkRoomType);
  }
  if (lockTalkRoomType){
    closeTalkDefaultRoomTypeDropdown();
  }

  updateSharingPasswordState();
  updateAttachmentThresholdState();
  applyTalkSystemAddressbookLockState(talkAddressbookLockActive, talkAddressbookLockDetail);
}

/**
 * Load settings from storage and populate the options UI.
 * @returns {Promise<void>}
 */
async function load(){
  if (NCSharingStorage?.migrateLegacySharingKeys){
    await NCSharingStorage.migrateLegacySharingKeys();
  }
  const stored = await browser.storage.local.get([
    "baseUrl",
    "user",
    "appPass",
    "debugEnabled",
    "authMode",
    SHARING_KEYS.basePath,
    SHARING_KEYS.defaultShareName,
    SHARING_KEYS.defaultPermCreate,
    SHARING_KEYS.defaultPermWrite,
    SHARING_KEYS.defaultPermDelete,
    SHARING_KEYS.defaultPassword,
    SHARING_KEYS.defaultPasswordSeparate,
    SHARING_KEYS.defaultExpireDays,
    SHARING_KEYS.attachmentsAlwaysConnector,
    SHARING_KEYS.attachmentsOfferAboveEnabled,
    SHARING_KEYS.attachmentsOfferAboveMb,
    "talkDefaultTitle",
    "talkDefaultLobby",
    "talkDefaultListable",
    "talkAddUsersDefaultEnabled",
    "talkAddGuestsDefaultEnabled",
    "talkAddParticipantsDefaultEnabled",
    "talkPasswordDefaultEnabled",
    "talkDefaultRoomType",
    "shareBlockLang",
    "eventDescriptionLang"
  ]);
  if (stored.baseUrl) baseUrlInput.value = stored.baseUrl;
  if (stored.user) userInput.value = stored.user;
  if (stored.appPass) appPassInput.value = stored.appPass;
  document.getElementById("debugEnabled").checked = !!stored.debugEnabled;
  if (sharingBaseInput){
    sharingBaseInput.value = stored[SHARING_KEYS.basePath] || DEFAULT_SHARING_BASE;
  }
  if (sharingDefaultShareNameInput){
    sharingDefaultShareNameInput.value = stored[SHARING_KEYS.defaultShareName] || DEFAULT_SHARING_SHARE_NAME;
  }
  if (sharingDefaultPermCreateInput){
    sharingDefaultPermCreateInput.checked = typeof stored[SHARING_KEYS.defaultPermCreate] === "boolean"
      ? stored[SHARING_KEYS.defaultPermCreate]
      : false;
  }
  if (sharingDefaultPermWriteInput){
    sharingDefaultPermWriteInput.checked = typeof stored[SHARING_KEYS.defaultPermWrite] === "boolean"
      ? stored[SHARING_KEYS.defaultPermWrite]
      : false;
  }
  if (sharingDefaultPermDeleteInput){
    sharingDefaultPermDeleteInput.checked = typeof stored[SHARING_KEYS.defaultPermDelete] === "boolean"
      ? stored[SHARING_KEYS.defaultPermDelete]
      : false;
  }
  if (sharingDefaultPasswordInput){
    const storedPassword = stored[SHARING_KEYS.defaultPassword];
    sharingDefaultPasswordInput.checked = storedPassword !== undefined
      ? !!storedPassword
      : true;
  }
  if (sharingDefaultPasswordSeparateInput){
    sharingDefaultPasswordSeparateInput.checked = !!stored[SHARING_KEYS.defaultPasswordSeparate];
  }
  updateSharingPasswordState();
  if (sharingDefaultExpireDaysInput){
    const normalizedExpireDays = NCTalkTextUtils.normalizeExpireDays(
      stored[SHARING_KEYS.defaultExpireDays],
      DEFAULT_SHARING_EXPIRE_DAYS
    );
    sharingDefaultExpireDaysInput.value = String(normalizedExpireDays);
  }
  if (sharingAttachmentsAlwaysNcInput){
    sharingAttachmentsAlwaysNcInput.checked = !!stored[SHARING_KEYS.attachmentsAlwaysConnector];
  }
  if (sharingAttachmentsOfferAboveEnabledInput){
    sharingAttachmentsOfferAboveEnabledInput.checked = stored[SHARING_KEYS.attachmentsOfferAboveEnabled] !== undefined
      ? !!stored[SHARING_KEYS.attachmentsOfferAboveEnabled]
      : true;
  }
  if (sharingAttachmentsOfferAboveMbInput){
    sharingAttachmentsOfferAboveMbInput.value = String(
      normalizeAttachmentThresholdMb(stored[SHARING_KEYS.attachmentsOfferAboveMb])
    );
  }
  await refreshComposeAttachmentConflictState();
  updateAttachmentThresholdState();
  if (talkDefaultTitleInput){
    talkDefaultTitleInput.value = stored.talkDefaultTitle || DEFAULT_TALK_TITLE;
  }
  if (talkDefaultLobbyInput){
    talkDefaultLobbyInput.checked = stored.talkDefaultLobby !== undefined
      ? !!stored.talkDefaultLobby
      : true;
  }
  if (talkDefaultListableInput){
    talkDefaultListableInput.checked = stored.talkDefaultListable !== undefined
      ? !!stored.talkDefaultListable
      : true;
  }
  if (talkDefaultAddUsersInput){
    talkDefaultAddUsersInput.checked = stored.talkAddUsersDefaultEnabled !== undefined
      ? !!stored.talkAddUsersDefaultEnabled
      : (stored.talkAddParticipantsDefaultEnabled !== undefined ? !!stored.talkAddParticipantsDefaultEnabled : false);
  }
  if (talkDefaultAddGuestsInput){
    talkDefaultAddGuestsInput.checked = stored.talkAddGuestsDefaultEnabled !== undefined
      ? !!stored.talkAddGuestsDefaultEnabled
      : (stored.talkAddParticipantsDefaultEnabled !== undefined ? !!stored.talkAddParticipantsDefaultEnabled : false);
  }
  if (talkDefaultPasswordInput){
    talkDefaultPasswordInput.checked = stored.talkPasswordDefaultEnabled !== undefined
      ? !!stored.talkPasswordDefaultEnabled
      : true;
  }
  const storedShareBlockLang = stored.shareBlockLang;
  const storedEventDescriptionLang = stored.eventDescriptionLang;
  setTalkDefaultRoomType(stored.talkDefaultRoomType);
  await refreshBackendPolicyStatus();
  if (shareBlockLangSelect){
    shareBlockLangSelect.value = normalizeLangChoice(storedShareBlockLang);
  }
  if (eventDescriptionLangSelect){
    eventDescriptionLangSelect.value = normalizeLangChoice(storedEventDescriptionLang);
  }
  applyPolicySettingsOverlay();
  await refreshTalkSystemAddressbookState({ forceRefresh: true });
  setAuthMode(stored.authMode || "manual");
  updateAuthModeUI();
}

/**
 * Apply system-addressbook lock state to talk-default controls.
 * @param {boolean} locked
 * @param {string} detail
 */
function applyTalkSystemAddressbookLockState(locked, detail = ""){
  talkAddressbookLockActive = !!locked;
  talkAddressbookLockDetail = talkAddressbookLockActive ? (detail || i18n("talk_system_addressbook_required_message")) : "";
  const usersLockActive = talkAddressbookLockActive || policyLockTalkAddUsers;
  const guestsLockActive = talkAddressbookLockActive || policyLockTalkAddGuests;
  const usersDetail = talkAddressbookLockActive
    ? talkAddressbookLockDetail
    : (policyLockTalkAddUsers ? getAdminControlledHint() : "");
  const guestsDetail = talkAddressbookLockActive
    ? talkAddressbookLockDetail
    : (policyLockTalkAddGuests ? getAdminControlledHint() : "");
  if (talkDefaultAddUsersInput){
    talkDefaultAddUsersInput.disabled = usersLockActive;
    talkDefaultAddUsersInput.title = usersDetail;
  }
  if (talkDefaultAddGuestsInput){
    talkDefaultAddGuestsInput.disabled = guestsLockActive;
    talkDefaultAddGuestsInput.title = guestsDetail;
  }
  if (talkDefaultAddUsersRow){
    talkDefaultAddUsersRow.classList.toggle("is-disabled", usersLockActive);
    talkDefaultAddUsersRow.title = usersDetail;
  }
  if (talkDefaultAddGuestsRow){
    talkDefaultAddGuestsRow.classList.toggle("is-disabled", guestsLockActive);
    talkDefaultAddGuestsRow.title = guestsDetail;
  }
  if (optionsAddUsersAddressbookLockHint){
    optionsAddUsersAddressbookLockHint.textContent = talkAddressbookLockDetail || i18n("talk_system_addressbook_required_message");
  }
  if (optionsAddGuestsAddressbookLockHint){
    optionsAddGuestsAddressbookLockHint.textContent = talkAddressbookLockDetail || i18n("talk_system_addressbook_required_message");
  }
  applySharedAddressbookTooltipState(optionsAddUsersTooltipList, talkAddressbookLockActive);
  applySharedAddressbookTooltipState(optionsAddGuestsTooltipList, talkAddressbookLockActive);
  if (talkAddressbookWarningRow){
    talkAddressbookWarningRow.hidden = !talkAddressbookLockActive;
  }
}

/**
 * Read and apply current system-addressbook availability.
 * @param {{forceRefresh?:boolean}} options
 * @returns {Promise<void>}
 */
async function refreshTalkSystemAddressbookState(options = {}){
  const forceRefresh = !!options.forceRefresh;
  try{
    const response = await browser.runtime.sendMessage({
      type: "talk:getSystemAddressbookStatus",
      payload: { forceRefresh }
    });
    const status = response?.status || {};
    const locked = !(response?.ok && status.available !== false);
    const detail = locked
      ? i18n("talk_system_addressbook_required_message")
      : "";
    if (locked && (status.error || response?.error)){
      logOptionsError("system addressbook unavailable", status.error || response.error);
    }
    applyTalkSystemAddressbookLockState(locked, detail);
  }catch(error){
    logOptionsError("system addressbook status check failed", error);
    applyTalkSystemAddressbookLockState(true, i18n("talk_system_addressbook_required_message"));
  }
  applyPolicySettingsOverlay();
}

/**
 * Read Thunderbird compose big-attachment settings and update lock UI.
 * @returns {Promise<void>}
 */
async function refreshComposeAttachmentConflictState(){
  composeAttachmentSettingsLocked = false;
  let thresholdMb = DEFAULT_SHARING_ATTACHMENT_THRESHOLD_MB;
  const readApi = browser?.ncComposePrefs?.getBigAttachmentSettings;
  if (typeof readApi === "function"){
    const settings = await readApi();
    composeAttachmentSettingsLocked = !!settings?.lockActive;
    thresholdMb = normalizeAttachmentThresholdMb(settings?.thresholdMb);
  }
  if (sharingAttachmentsLockText){
    sharingAttachmentsLockText.textContent = composeAttachmentSettingsLocked
      ? i18n("options_sharing_attachments_lock_text", [String(thresholdMb)])
      : "";
  }
  if (sharingAttachmentsLockBox){
    sharingAttachmentsLockBox.hidden = !composeAttachmentSettingsLocked;
  }
}

/**
 * Request optional host permission for the configured base URL.
 * @param {{allowPrompt?:boolean}} options
 * @returns {Promise<boolean>}
 */
async function ensureOriginPermissionInteractive({ allowPrompt = true } = {}){
  const baseUrl = baseUrlInput?.value?.trim() || "";
  if (!baseUrl){
    return true;
  }
  let parsedBaseUrl = null;
  try{
    parsedBaseUrl = new URL(baseUrl);
  }catch(error){
    if (allowPrompt){
      showStatus(i18n("error_baseurl_https_required"), true);
    }
    return false;
  }
  if (parsedBaseUrl.protocol !== "https:"){
    if (allowPrompt){
      showStatus(i18n("error_baseurl_https_required"), true);
    }
    return false;
  }
  if (typeof NCHostPermissions === "undefined" || !NCHostPermissions?.ensureOriginPermissionInteractive){
    return true;
  }
  const ok = await NCHostPermissions.ensureOriginPermissionInteractive(baseUrl, { prompt: allowPrompt });
  if (!ok && allowPrompt){
    showStatus(i18n("options_permission_required"), true, true);
  }
  return ok;
}

/**
 * Open the Nextcloud login URL in the default browser or fallback popup.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function openLoginUrl(url){
  if (!url){
    return false;
  }
  if (browser?.windows?.openDefaultBrowser){
    try{
      await browser.windows.openDefaultBrowser(url);
      return true;
    }catch(error){
      logOptionsError("openDefaultBrowser failed", error);
    }
  }
  try{
    const fallbackUrl = new URL(browser.runtime.getURL("ui/openUrlFallback.html"));
    fallbackUrl.searchParams.set("url", url);
    if (browser?.windows?.create){
      await browser.windows.create({
        url: fallbackUrl.toString(),
        type: "popup",
        width: FALLBACK_POPUP_WIDTH,
        height: FALLBACK_POPUP_HEIGHT
      });
      return true;
    }
    if (typeof window !== "undefined" && typeof window.open === "function"){
      window.open(fallbackUrl.toString(), "_blank", "popup");
      return true;
    }
  }catch(error){
    logOptionsError("open login url fallback failed", error);
  }
  return false;
}

/**
 * Persist options to storage and request host permission if needed.
 * @returns {Promise<void>}
 */
async function save(){
  const baseUrl = baseUrlInput.value.trim();
  const user = userInput.value.trim();
  const appPass = appPassInput.value;
  const debugEnabled = document.getElementById("debugEnabled").checked;
  const authMode = getSelectedAuthMode();
  let sharingBasePath = (sharingBaseInput?.value?.trim()) || DEFAULT_SHARING_BASE;
  let sharingDefaultShareName = (sharingDefaultShareNameInput?.value || "").trim() || DEFAULT_SHARING_SHARE_NAME;
  let sharingDefaultPermCreate = !!sharingDefaultPermCreateInput?.checked;
  let sharingDefaultPermWrite = !!sharingDefaultPermWriteInput?.checked;
  let sharingDefaultPermDelete = !!sharingDefaultPermDeleteInput?.checked;
  let sharingDefaultPassword = sharingDefaultPasswordInput
    ? !!sharingDefaultPasswordInput.checked
    : true;
  let sharingDefaultPasswordSeparate = sharingDefaultPassword
    ? !!sharingDefaultPasswordSeparateInput?.checked
    : false;
  let sharingDefaultExpireDays = NCTalkTextUtils.normalizeExpireDays(sharingDefaultExpireDaysInput?.value, DEFAULT_SHARING_EXPIRE_DAYS);
  let sharingAttachmentsAlwaysConnector = !!sharingAttachmentsAlwaysNcInput?.checked;
  let sharingAttachmentsOfferAboveEnabled = !!sharingAttachmentsOfferAboveEnabledInput?.checked;
  let sharingAttachmentsOfferAboveMb = normalizeAttachmentThresholdMb(sharingAttachmentsOfferAboveMbInput?.value);
  let talkDefaultTitle = (talkDefaultTitleInput?.value || "").trim() || DEFAULT_TALK_TITLE;
  let talkDefaultLobby = talkDefaultLobbyInput ? !!talkDefaultLobbyInput.checked : true;
  let talkDefaultListable = talkDefaultListableInput ? !!talkDefaultListableInput.checked : true;
  let talkAddUsersDefaultEnabled = talkDefaultAddUsersInput ? !!talkDefaultAddUsersInput.checked : false;
  let talkAddGuestsDefaultEnabled = talkDefaultAddGuestsInput ? !!talkDefaultAddGuestsInput.checked : false;
  let talkAddParticipantsDefaultEnabled = talkAddUsersDefaultEnabled || talkAddGuestsDefaultEnabled;
  let talkPasswordDefaultEnabled = talkDefaultPasswordInput ? !!talkDefaultPasswordInput.checked : true;
  let talkDefaultRoomType = getSelectedTalkDefaultRoomType();
  let shareBlockLang = normalizeLangChoice(shareBlockLangSelect?.value);
  let eventDescriptionLang = normalizeLangChoice(eventDescriptionLangSelect?.value);
  const permissionOk = await ensureOriginPermissionInteractive();
  if (!permissionOk){
    return;
  }
  await refreshBackendPolicyStatus();
  sharingBasePath = resolvePersistedValue("share", "share_base_directory", sharingBasePath, coercePolicyString);
  sharingDefaultShareName = resolvePersistedValue("share", "share_name_template", sharingDefaultShareName, coercePolicyString);
  sharingDefaultPermCreate = resolvePersistedValue("share", "share_permission_upload", sharingDefaultPermCreate, coercePolicyBoolean);
  sharingDefaultPermWrite = resolvePersistedValue("share", "share_permission_edit", sharingDefaultPermWrite, coercePolicyBoolean);
  sharingDefaultPermDelete = resolvePersistedValue("share", "share_permission_delete", sharingDefaultPermDelete, coercePolicyBoolean);
  sharingDefaultPassword = resolvePersistedValue("share", "share_set_password", sharingDefaultPassword, coercePolicyBoolean);
  sharingDefaultPasswordSeparate = resolvePersistedValue("share", "share_send_password_separately", sharingDefaultPasswordSeparate, coercePolicyBoolean);
  sharingDefaultExpireDays = NCTalkTextUtils.normalizeExpireDays(
    resolvePersistedValue("share", "share_expire_days", sharingDefaultExpireDays, coercePolicyInt),
    DEFAULT_SHARING_EXPIRE_DAYS
  );
  sharingAttachmentsAlwaysConnector = resolvePersistedValue("share", "attachments_always_via_ncconnector", sharingAttachmentsAlwaysConnector, coercePolicyBoolean);
  sharingAttachmentsOfferAboveMb = normalizeAttachmentThresholdMb(
    resolvePersistedValue("share", "attachments_min_size_mb", sharingAttachmentsOfferAboveMb, coercePolicyInt)
  );
  if (isPolicyLocked("share", "attachments_min_size_mb")){
    sharingAttachmentsOfferAboveEnabled = !isBackendPolicyExplicitNull("share", "attachments_min_size_mb");
  }
  shareBlockLang = normalizeLangChoice(
    resolvePersistedValue("share", "language_share_html_block", shareBlockLang, coercePolicyString),
    { allowCustom: isCustomLanguageModeAvailable("share") }
  );
  talkDefaultTitle = resolvePersistedValue("talk", "talk_title", talkDefaultTitle, coercePolicyString);
  talkDefaultLobby = resolvePersistedValue("talk", "talk_lobby_active", talkDefaultLobby, coercePolicyBoolean);
  talkDefaultListable = resolvePersistedValue("talk", "talk_show_in_search", talkDefaultListable, coercePolicyBoolean);
  talkAddUsersDefaultEnabled = resolvePersistedValue("talk", "talk_add_users", talkAddUsersDefaultEnabled, coercePolicyBoolean);
  talkAddGuestsDefaultEnabled = resolvePersistedValue("talk", "talk_add_guests", talkAddGuestsDefaultEnabled, coercePolicyBoolean);
  talkAddParticipantsDefaultEnabled = talkAddUsersDefaultEnabled || talkAddGuestsDefaultEnabled;
  talkPasswordDefaultEnabled = resolvePersistedValue("talk", "talk_set_password", talkPasswordDefaultEnabled, coercePolicyBoolean);
  talkDefaultRoomType = resolvePersistedValue("talk", "talk_room_type", talkDefaultRoomType, coercePolicyString);
  talkDefaultRoomType = talkDefaultRoomType === "event" ? "event" : "normal";
  eventDescriptionLang = normalizeLangChoice(
    resolvePersistedValue("talk", "language_talk_description", eventDescriptionLang, coercePolicyString),
    { allowCustom: isCustomLanguageModeAvailable("talk") }
  );
  if (!isSeparatePasswordMailFeatureAvailable()){
    sharingDefaultPasswordSeparate = false;
  }
  await browser.storage.local.set({
    baseUrl,
    user,
    appPass,
    debugEnabled,
    authMode,
    [SHARING_KEYS.basePath]: sharingBasePath,
    [SHARING_KEYS.defaultShareName]: sharingDefaultShareName,
    [SHARING_KEYS.defaultPermCreate]: sharingDefaultPermCreate,
    [SHARING_KEYS.defaultPermWrite]: sharingDefaultPermWrite,
    [SHARING_KEYS.defaultPermDelete]: sharingDefaultPermDelete,
    [SHARING_KEYS.defaultPassword]: sharingDefaultPassword,
    [SHARING_KEYS.defaultPasswordSeparate]: sharingDefaultPasswordSeparate,
    [SHARING_KEYS.defaultExpireDays]: sharingDefaultExpireDays,
    [SHARING_KEYS.attachmentsAlwaysConnector]: sharingAttachmentsAlwaysConnector,
    [SHARING_KEYS.attachmentsOfferAboveEnabled]: sharingAttachmentsOfferAboveEnabled,
    [SHARING_KEYS.attachmentsOfferAboveMb]: sharingAttachmentsOfferAboveMb,
    talkDefaultTitle,
    talkDefaultLobby,
    talkDefaultListable,
    talkAddUsersDefaultEnabled,
    talkAddGuestsDefaultEnabled,
    talkAddParticipantsDefaultEnabled,
    talkPasswordDefaultEnabled,
    talkDefaultRoomType,
    shareBlockLang,
    eventDescriptionLang
  });
  await refreshTalkSystemAddressbookState({ forceRefresh: true });
  showStatus(i18n("options_status_saved"));
}

document.getElementById("save").addEventListener("click", async () => {
  try{
    await save();
  }catch(e){
    logOptionsError("save failed", e);
    showStatus(e?.message || i18n("options_status_save_failed"), true);
  }
});

if (sharingAttachmentsOfferAboveEnabledInput){
  sharingAttachmentsOfferAboveEnabledInput.addEventListener("change", () => {
    updateAttachmentThresholdState();
  });
}
if (sharingAttachmentsAlwaysNcInput){
  sharingAttachmentsAlwaysNcInput.addEventListener("change", () => {
    updateAttachmentThresholdState();
  });
}
if (sharingDefaultPasswordInput){
  sharingDefaultPasswordInput.addEventListener("change", () => {
    updateSharingPasswordState();
  });
}

const testButton = document.getElementById("testConnection");
if (testButton){
  testButton.addEventListener("click", async () => {
    const button = testButton;
    if (button.disabled) return;
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = i18n("options_test_running");
    try{
      await runConnectionTest({ showMissing: true });
    }catch(err){
      logOptionsError("test connection failed", err);
      showStatus(err?.message || i18n("options_test_failed"), true);
    }finally{
      button.disabled = false;
      button.textContent = originalLabel || i18n("options_test_button");
    }
  });
}

load().catch((e) => {
  logOptionsError("options load failed", e);
  showStatus(e?.message || i18n("options_status_load_failed"), true);
});

window.addEventListener("focus", async () => {
  try{
    await refreshComposeAttachmentConflictState();
    updateAttachmentThresholdState();
    await refreshBackendPolicyStatus();
    // Focus refresh keeps UI state current, but should prefer cache to avoid
    // repeated forced network probes while switching windows.
    await refreshTalkSystemAddressbookState({ forceRefresh: false });
  }catch(error){
    logOptionsError("options focus refresh failed", error);
  }
});

/**
 * Initialize the tab switcher on the options page.
 */
function initTabs(){
  const buttons = Array.from(document.querySelectorAll(".tab-btn"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));
  const tabContainer = document.querySelector(".tabs");
  const order = buttons.map((btn) => btn.dataset.tab).filter(Boolean);
  let activeId = buttons.find((btn) => btn.classList.contains("active"))?.dataset.tab || order[0] || "";
  /**
   * Measure the tallest tab panel and set a shared min-height.
   */
  const measurePanels = () => {
    if (!tabContainer || !panels.length){
      return;
    }
    const snapshots = panels.map((panel) => ({
      panel,
      display: panel.style.display,
      position: panel.style.position,
      visibility: panel.style.visibility,
      height: panel.style.height
    }));
    panels.forEach((panel) => {
      panel.style.display = "block";
      panel.style.position = "absolute";
      panel.style.visibility = "hidden";
      panel.style.height = "auto";
    });
    let maxHeight = 0;
    panels.forEach((panel) => {
      const rect = panel.getBoundingClientRect();
      const height = Math.max(panel.scrollHeight || 0, rect.height || 0);
      if (height > maxHeight){
        maxHeight = height;
      }
    });
    snapshots.forEach((entry) => {
      entry.panel.style.display = entry.display;
      entry.panel.style.position = entry.position;
      entry.panel.style.visibility = entry.visibility;
      entry.panel.style.height = entry.height;
    });
    if (maxHeight > 0){
      tabContainer.style.setProperty("--tab-panel-min-height", `${Math.ceil(maxHeight)}px`);
    }
  };
  /**
   * Activate the selected tab and panel by id.
   * @param {string} id
   */
  const activate = (id, { initial = false } = {}) => {
    if (tabContainer && !initial && activeId && id){
      const currentIndex = order.indexOf(activeId);
      const nextIndex = order.indexOf(id);
      if (currentIndex !== -1 && nextIndex !== -1){
        tabContainer.setAttribute("data-nav", nextIndex < currentIndex ? "back" : "forward");
      }
    }
    buttons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === id);
    });
    panels.forEach((panel) => {
      panel.classList.toggle("active", panel.id === `tab-${id}`);
    });
    activeId = id;
    if (id === "talk"){
      // Talk tab opens should always refresh addressbook availability once.
      void refreshTalkSystemAddressbookState({ forceRefresh: true }).catch((error) => {
        logOptionsError("talk tab system addressbook refresh failed", error);
      });
    }
  };
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  });
  activate(activeId, { initial: true });
  if (typeof window.requestAnimationFrame === "function"){
    window.requestAnimationFrame(measurePanels);
  }else{
    window.setTimeout(measurePanels, 0);
  }
  window.addEventListener("load", () => {
    if (typeof window.requestAnimationFrame === "function"){
      window.requestAnimationFrame(measurePanels);
    }else{
      window.setTimeout(measurePanels, 0);
    }
  });
  window.addEventListener("resize", () => {
    if (typeof window.requestAnimationFrame === "function"){
      window.requestAnimationFrame(measurePanels);
    }else{
      window.setTimeout(measurePanels, 0);
    }
  });
}

/**
 * Fill the About section with version and license link.
 */
function initAbout(){
  const versionEl = document.getElementById("aboutVersion");
  try{
    const manifest = browser?.runtime?.getManifest?.();
    if (manifest?.version && versionEl){
      versionEl.textContent = manifest.version;
    }
  }catch(error){
    logOptionsError("about version lookup failed", error);
  }
  const licenseLink = document.getElementById("licenseLink");
  if (licenseLink && browser?.runtime?.getURL){
    licenseLink.href = browser.runtime.getURL("LICENSE.txt");
  }
  const homepageLink = document.getElementById("aboutHomepageLink");
  if (homepageLink){
    homepageLink.href = NC_CONNECTOR_HOMEPAGE_URL;
  }
  const moreInfoLink = document.getElementById("aboutMoreInfoLink");
  if (moreInfoLink){
    moreInfoLink.href = NC_CONNECTOR_HOMEPAGE_URL;
  }
}

const authRadios = Array.from(document.querySelectorAll("input[name='authMode']"));
const loginFlowButton = document.getElementById("loginFlowButton");
let loginFlowInProgress = false;

authRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    updateAuthModeUI();
  });
});

/**
 * Read the selected auth mode radio value.
 * @returns {string}
 */
function getSelectedAuthMode(){
  const checked = document.querySelector("input[name='authMode']:checked");
  return checked ? checked.value : "manual";
}

/**
 * Select an auth mode radio button by value.
 * @param {string} mode
 */
function setAuthMode(mode){
  const target = authRadios.find((radio) => radio.value === mode);
  if (target){
    target.checked = true;
  } else if (authRadios.length){
    authRadios[0].checked = true;
  }
}

/**
 * Enable/disable fields based on the selected auth mode.
 */
function updateAuthModeUI(){
  const mode = getSelectedAuthMode();
  const manual = mode === "manual";
  if (userInput) userInput.disabled = !manual;
  if (appPassInput) appPassInput.disabled = !manual;
  if (loginFlowButton){
    loginFlowButton.disabled = loginFlowInProgress || mode !== "loginFlow";
  }
}

/**
 * Initialize the Talk room type picker in options (same behavior as wizard).
 */
function initTalkDefaultRoomTypePicker(){
  if (!talkDefaultRoomTypePicker || !talkDefaultRoomTypeButton || !talkDefaultRoomTypeDropdown || !talkDefaultRoomTypeValueInput){
    return;
  }

  talkDefaultRoomTypeButton.addEventListener("click", (event) => {
    event.preventDefault();
    toggleTalkDefaultRoomTypeDropdown();
  });

  talkDefaultRoomTypeOptions.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      setTalkDefaultRoomType(button.dataset.value || "normal");
      closeTalkDefaultRoomTypeDropdown();
      talkDefaultRoomTypeButton.focus();
    });
  });

  document.addEventListener("click", (event) => {
    if (!talkDefaultRoomTypePicker.contains(event.target)){
      closeTalkDefaultRoomTypeDropdown();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape"){
      closeTalkDefaultRoomTypeDropdown();
    }
  });

  setTalkDefaultRoomType(talkDefaultRoomTypeValueInput.value || "event", { closeDropdown:false });
}

/**
 * Check whether the room type dropdown is currently open.
 * @returns {boolean}
 */
function isTalkDefaultRoomTypeDropdownOpen(){
  return !!(talkDefaultRoomTypeDropdown && talkDefaultRoomTypeDropdown.hidden === false);
}

/**
 * Open the room type dropdown.
 */
function openTalkDefaultRoomTypeDropdown(){
  if (!talkDefaultRoomTypeDropdown){
    return;
  }
  talkDefaultRoomTypeDropdown.hidden = false;
  talkDefaultRoomTypeButton?.setAttribute("aria-expanded", "true");
}

/**
 * Close the room type dropdown.
 */
function closeTalkDefaultRoomTypeDropdown(){
  if (!talkDefaultRoomTypeDropdown){
    return;
  }
  talkDefaultRoomTypeDropdown.hidden = true;
  talkDefaultRoomTypeButton?.setAttribute("aria-expanded", "false");
}

/**
 * Toggle room type dropdown visibility.
 */
function toggleTalkDefaultRoomTypeDropdown(){
  if (isTalkDefaultRoomTypeDropdownOpen()){
    closeTalkDefaultRoomTypeDropdown();
  }else{
    openTalkDefaultRoomTypeDropdown();
  }
}

/**
 * Read the selected default Talk room type.
 * @returns {"normal"|"event"}
 */
function getSelectedTalkDefaultRoomType(){
  const value = talkDefaultRoomTypeValueInput?.value;
  return value === "normal" ? "normal" : "event";
}

/**
 * Apply the selected default Talk room type to the room type picker.
 * @param {string} value
 * @param {{closeDropdown?:boolean}} options
 */
function setTalkDefaultRoomType(value, options = {}){
  const closeDropdown = options.closeDropdown !== false;
  const normalized = value === "normal" ? "normal" : "event";
  if (talkDefaultRoomTypeValueInput){
    talkDefaultRoomTypeValueInput.value = normalized;
  }
  if (talkDefaultRoomTypeButtonLabel){
    talkDefaultRoomTypeButtonLabel.textContent = normalized === "event"
      ? i18n("options_talk_default_roomtype_event")
      : i18n("options_talk_default_roomtype_standard");
  }
  talkDefaultRoomTypeOptions.forEach((button) => {
    const selected = button.dataset.value === normalized;
    button.dataset.selected = selected ? "true" : "false";
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  if (closeDropdown){
    closeTalkDefaultRoomTypeDropdown();
  }
}

/**
 * Normalize a language selection to the supported list.
 * @param {string} value
 * @returns {string}
 */
function normalizeLangChoice(value, options = {}){
  const allowCustom = options.allowCustom !== undefined
    ? !!options.allowCustom
    : isCustomLanguageModeAvailable();
  const raw = String(value || "default").trim();
  const normalizeOverride = typeof NCI18nOverride !== "undefined" && typeof NCI18nOverride.normalizeLanguageOverride === "function"
    ? NCI18nOverride.normalizeLanguageOverride
    : null;
  if (normalizeOverride){
    return normalizeOverride(raw, { allowCustom });
  }
  if (!raw || raw.toLowerCase() === "default"){
    return "default";
  }
  if (raw.toLowerCase() === "custom"){
    return allowCustom ? "custom" : "default";
  }
  let normalized = raw;
  if (typeof NCI18nOverride !== "undefined" && typeof NCI18nOverride.normalizeLang === "function"){
    normalized = NCI18nOverride.normalizeLang(raw);
  }
  return LANG_OPTIONS.has(normalized) ? normalized : "default";
}

/**
 * Enable/disable "password in separate mail" based on password default state.
 */
function updateSharingPasswordState(){
  if (!sharingDefaultPasswordInput || !sharingDefaultPasswordSeparateInput){
    return;
  }
  const lockPassword = isPolicyLocked("share", "share_set_password");
  const lockSeparate = isPolicyLocked("share", "share_send_password_separately");
  const featureUnavailable = !isSeparatePasswordMailFeatureAvailable();
  const passwordEnabled = !!sharingDefaultPasswordInput.checked;
  sharingDefaultPasswordInput.disabled = lockPassword;
  sharingDefaultPasswordSeparateInput.disabled = !passwordEnabled || lockSeparate || featureUnavailable;
  sharingDefaultPasswordSeparateInput.title = featureUnavailable
    ? getSeparatePasswordUnavailableHint()
    : (lockSeparate ? getAdminControlledHint() : "");
  if (sharingDefaultPasswordSeparateRow){
    sharingDefaultPasswordSeparateRow.classList.toggle("is-disabled", !passwordEnabled || lockSeparate || featureUnavailable);
    sharingDefaultPasswordSeparateRow.title = featureUnavailable
      ? getSeparatePasswordUnavailableHint()
      : (lockSeparate ? getAdminControlledHint() : "");
  }
  if (!passwordEnabled || featureUnavailable){
    sharingDefaultPasswordSeparateInput.checked = false;
  }
}

/**
 * Enable or disable the attachment threshold input based on checkbox state.
 */
function updateAttachmentThresholdState(){
  if (!sharingAttachmentsAlwaysNcInput || !sharingAttachmentsOfferAboveEnabledInput || !sharingAttachmentsOfferAboveMbInput){
    return;
  }
  const adminHint = getAdminControlledHint();
  const effectiveAlwaysLock = composeAttachmentSettingsLocked || policyLockSharingAttachmentsAlways;
  const effectiveThresholdLock = composeAttachmentSettingsLocked || policyLockSharingAttachmentsThreshold;
  if (sharingAttachmentsAlwaysRow){
    sharingAttachmentsAlwaysRow.classList.toggle("is-disabled", effectiveAlwaysLock);
    sharingAttachmentsAlwaysRow.title = policyLockSharingAttachmentsAlways ? adminHint : "";
  }
  if (sharingAttachmentsOfferRow){
    sharingAttachmentsOfferRow.classList.toggle("is-disabled", effectiveThresholdLock);
    sharingAttachmentsOfferRow.title = policyLockSharingAttachmentsThreshold ? adminHint : "";
  }
  if (sharingAttachmentsLockBox){
    sharingAttachmentsLockBox.hidden = !composeAttachmentSettingsLocked;
  }
  sharingAttachmentsAlwaysNcInput.disabled = effectiveAlwaysLock;
  sharingAttachmentsAlwaysNcInput.title = policyLockSharingAttachmentsAlways ? adminHint : "";
  if (composeAttachmentSettingsLocked){
    sharingAttachmentsOfferAboveEnabledInput.disabled = true;
    sharingAttachmentsOfferAboveMbInput.disabled = true;
    return;
  }
  if (policyLockSharingAttachmentsThreshold){
    sharingAttachmentsOfferAboveEnabledInput.checked = !isBackendPolicyExplicitNull("share", "attachments_min_size_mb");
  }
  const alwaysViaConnector = !!sharingAttachmentsAlwaysNcInput?.checked;
  if (sharingAttachmentsOfferRow){
    sharingAttachmentsOfferRow.classList.toggle("is-disabled", alwaysViaConnector || effectiveThresholdLock);
  }
  sharingAttachmentsOfferAboveEnabledInput.disabled = alwaysViaConnector || effectiveThresholdLock;
  sharingAttachmentsOfferAboveEnabledInput.title = policyLockSharingAttachmentsThreshold ? adminHint : "";
  const thresholdEnabled = !alwaysViaConnector && !!sharingAttachmentsOfferAboveEnabledInput.checked;
  sharingAttachmentsOfferAboveMbInput.disabled = !thresholdEnabled || effectiveThresholdLock;
  sharingAttachmentsOfferAboveMbInput.title = policyLockSharingAttachmentsThreshold ? adminHint : "";
}

  if (loginFlowButton){
    loginFlowButton.addEventListener("click", async () => {
    if (loginFlowButton.disabled || loginFlowInProgress) return;
    const baseUrl = baseUrlInput.value.trim();
    if (!baseUrl){
      showStatus(i18n("options_loginflow_missing"), true);
      return;
    }
    if (!(await ensureOriginPermissionInteractive())){
      return;
    }
    loginFlowInProgress = true;
    updateAuthModeUI();
    try{
      showStatus(i18n("options_loginflow_starting"), false, true);
      const startResponse = await browser.runtime.sendMessage({
        type: "options:loginFlowStart",
        payload: { baseUrl }
      });
      if (!startResponse?.ok){
        showStatus(startResponse?.error || i18n("options_loginflow_failed"), true);
        return;
      }
      await openLoginUrl(startResponse.loginUrl);
      showStatus(i18n("options_loginflow_browser"), false, true);
      const response = await browser.runtime.sendMessage({
        type: "options:loginFlowComplete",
        payload: {
          pollEndpoint: startResponse.pollEndpoint,
          pollToken: startResponse.pollToken
        }
      });
      if (response?.ok){
        if (response.user) userInput.value = response.user;
        if (response.appPass) appPassInput.value = response.appPass;
        showStatus(i18n("options_loginflow_success"), false, false, true);
        await runConnectionTest({ showMissing: false });
      }else{
        showStatus(response?.error || i18n("options_loginflow_failed"), true);
      }
    }catch(err){
      logOptionsError("login flow failed", err);
      showStatus(err?.message || i18n("options_loginflow_failed"), true);
    }finally{
      loginFlowInProgress = false;
      updateAuthModeUI();
    }
  });
}

/**
 * Run a connection test against the configured Nextcloud instance.
 * @param {{showMissing?:boolean}} options
 * @returns {Promise<object>}
 */
async function runConnectionTest({ showMissing = true } = {}){
  const baseUrl = baseUrlInput.value.trim();
  const user = userInput.value.trim();
  const appPass = appPassInput.value;
  if (!baseUrl || !user || !appPass){
    if (showMissing){
      showStatus(i18n("options_test_missing"), true);
    }
    return { ok:false, skipped:true, reason:"missing" };
  }
  if (!(await ensureOriginPermissionInteractive({ allowPrompt: showMissing }))){
    return { ok:false, skipped:true, reason:"permission" };
  }
  try{
    const response = await browser.runtime.sendMessage({
      type: "options:testConnection",
      payload: { baseUrl, user, appPass }
    });
    if (response?.ok){
      const message = response?.message ? String(response.message) : i18n("options_test_success");
      showStatus(message, false, false, true);
    }else{
      const code = response?.code;
      const fallbackKey = code === "auth" ? "options_test_failed_auth" : "options_test_failed";
      const message = response?.error || i18n(fallbackKey);
      showStatus(message, true);
    }
    return response;
  }catch(err){
    logOptionsError("testConnection runtime failed", err);
    showStatus(err?.message || i18n("options_test_failed"), true);
    return { ok:false, error: err?.message || String(err) };
  }
}





