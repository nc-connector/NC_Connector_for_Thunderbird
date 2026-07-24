/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
const i18n = NCI18n.translate;
const DEFAULT_SHARING_EXPIRE_DAYS = 7;
const DEFAULT_SHARING_ATTACHMENT_THRESHOLD_MB = NCSharingStorage.DEFAULT_ATTACHMENT_THRESHOLD_MB;
const DEFAULT_SHARING_ATTACHMENT_LINK_TARGET = NCSharingStorage.DEFAULT_ATTACHMENT_LINK_TARGET;
const DEFAULT_SHARING_SHARE_NAME = i18n("sharing_share_default") || "Share name";
const DEFAULT_TALK_TITLE = i18n("ui_default_title") || "Meeting";
const FALLBACK_POPUP_WIDTH = 520;
const FALLBACK_POPUP_HEIGHT = 320;
const SHARING_KEYS = NCSharingStorage.SHARING_KEYS;
const normalizeAttachmentThresholdMb = NCSharingStorage.normalizeAttachmentThresholdMb;
const normalizeAttachmentLinkTarget = NCSharingStorage.normalizeAttachmentLinkTarget;
const OPTIONS_LOG_PREFIX = "[NCUI][Options]";
const SYSTEM_ADDRESSBOOK_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md#43-talk-and-system-address-book";
const POLICY_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md";
const ATTACHMENT_AUTOMATION_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md#63-attachment-policy-example";
const NC_CONNECTOR_HOMEPAGE_URL = "https://nc-connector.de";
const EMAIL_SIGNATURE_KEYS = {
  onCompose: "emailSignatureOnCompose",
  onReply: "emailSignatureOnReply",
  onForward: "emailSignatureOnForward"
};

NCTalkDomI18n.translatePage(i18n, { titleKey: "options_title" });
initTabs();
initAbout();

const statusEl = document.getElementById("status");
const baseUrlInput = document.getElementById("baseUrl");
const baseUrlManagedPolicyMarker = document.getElementById("baseUrlManagedPolicyMarker");
const baseUrlManagedPolicyTooltip = document.getElementById("baseUrlManagedPolicyTooltip");
const authBlock = document.getElementById("authBlock");
const userInput = document.getElementById("user");
const appPassInput = document.getElementById("appPass");
const saveButton = document.getElementById("save");
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
const sharingDefaultPasswordDeliveryModeRow = document.getElementById("sharingDefaultPasswordDeliveryModeRow");
const sharingDefaultPasswordDeliveryModeSelect = document.getElementById("sharingDefaultPasswordDeliveryMode");
const sharingDefaultExpireDaysRow = document.getElementById("sharingDefaultExpireDaysRow");
const sharingDefaultExpireDaysInput = document.getElementById("sharingDefaultExpireDays");
const sharingAttachmentsLinkTargetRow = document.getElementById("sharingAttachmentsLinkTargetRow");
const sharingAttachmentsLinkTargetSelect = document.getElementById("sharingAttachmentsLinkTarget");
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
const talkDeleteRoomOnEventDeleteRow = document.getElementById("talkDeleteRoomOnEventDeleteRow");
const talkDeleteRoomOnEventDeleteInput = document.getElementById("talkDeleteRoomOnEventDelete");
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
const emailSignaturePolicyHint = document.getElementById("emailSignaturePolicyHint");
const emailSignatureOnComposeRow = document.getElementById("emailSignatureOnComposeRow");
const emailSignatureOnComposeInput = document.getElementById("emailSignatureOnCompose");
const emailSignatureOnReplyRow = document.getElementById("emailSignatureOnReplyRow");
const emailSignatureOnReplyInput = document.getElementById("emailSignatureOnReply");
const emailSignatureOnForwardRow = document.getElementById("emailSignatureOnForwardRow");
const emailSignatureOnForwardInput = document.getElementById("emailSignatureOnForward");
const DEFAULT_SHARING_BASE = (typeof NCSharing !== "undefined" ? NCSharing.DEFAULT_BASE_PATH : "NC Connector");
const OPTION_SHARE_POLICY_BINDINGS = [
  {
    name: "sharingBasePath",
    storageKey: SHARING_KEYS.basePath,
    domain: "share",
    key: "share_base_directory",
    element: sharingBaseInput,
    row: sharingBaseRow,
    property: "value",
    type: "string",
    fallback: DEFAULT_SHARING_BASE
  },
  {
    name: "sharingDefaultShareName",
    storageKey: SHARING_KEYS.defaultShareName,
    domain: "share",
    key: "share_name_template",
    element: sharingDefaultShareNameInput,
    row: sharingDefaultShareNameRow,
    property: "value",
    type: "string",
    fallback: DEFAULT_SHARING_SHARE_NAME
  },
  {
    name: "sharingDefaultPermCreate",
    storageKey: SHARING_KEYS.defaultPermCreate,
    domain: "share",
    key: "share_permission_upload",
    element: sharingDefaultPermCreateInput,
    property: "checked",
    type: "boolean"
  },
  {
    name: "sharingDefaultPermWrite",
    storageKey: SHARING_KEYS.defaultPermWrite,
    domain: "share",
    key: "share_permission_edit",
    element: sharingDefaultPermWriteInput,
    property: "checked",
    type: "boolean"
  },
  {
    name: "sharingDefaultPermDelete",
    storageKey: SHARING_KEYS.defaultPermDelete,
    domain: "share",
    key: "share_permission_delete",
    element: sharingDefaultPermDeleteInput,
    property: "checked",
    type: "boolean"
  },
  {
    name: "sharingDefaultPassword",
    storageKey: SHARING_KEYS.defaultPassword,
    domain: "share",
    key: "share_set_password",
    element: sharingDefaultPasswordInput,
    row: sharingDefaultPasswordRow,
    property: "checked",
    type: "boolean"
  },
  {
    name: "sharingDefaultPasswordSeparate",
    storageKey: SHARING_KEYS.defaultPasswordSeparate,
    domain: "share",
    key: "share_send_password_separately",
    element: sharingDefaultPasswordSeparateInput,
    property: "checked",
    type: "boolean"
  },
  {
    name: "sharingDefaultPasswordDeliveryMode",
    storageKey: SHARING_KEYS.defaultPasswordDeliveryMode,
    domain: "share",
    key: "share_send_password_mode",
    element: sharingDefaultPasswordDeliveryModeSelect,
    row: sharingDefaultPasswordDeliveryModeRow,
    property: "value",
    type: "string",
    fallback: NCSharePasswordDelivery.MODE_PLAIN,
    normalize: (value, fallback) => NCSharePasswordDelivery.coerceMode(value, fallback)
  },
  {
    name: "sharingDefaultExpireDays",
    storageKey: SHARING_KEYS.defaultExpireDays,
    domain: "share",
    key: "share_expire_days",
    element: sharingDefaultExpireDaysInput,
    row: sharingDefaultExpireDaysRow,
    property: "value",
    type: "int",
    normalize: (value, fallback) => NCTalkTextUtils.normalizeExpireDays(value, fallback || DEFAULT_SHARING_EXPIRE_DAYS)
  },
  {
    name: "sharingAttachmentsLinkTarget",
    storageKey: SHARING_KEYS.attachmentsLinkTarget,
    domain: "share",
    key: "attachment_link_target",
    element: sharingAttachmentsLinkTargetSelect,
    row: sharingAttachmentsLinkTargetRow,
    property: "value",
    type: "string",
    fallback: DEFAULT_SHARING_ATTACHMENT_LINK_TARGET,
    lockedFallback: DEFAULT_SHARING_ATTACHMENT_LINK_TARGET,
    normalize: (value, fallback) => normalizeAttachmentLinkTarget(value, fallback),
    isValid: (value) => NCSharingStorage.isValidAttachmentLinkTarget(value)
  },
  {
    name: "shareBlockLang",
    storageKey: "shareBlockLang",
    domain: "share",
    key: "language_share_html_block",
    element: shareBlockLangSelect,
    row: shareBlockLangRow,
    property: "value",
    type: "string",
    normalize: (value) => normalizeLangChoice(value, { allowCustom: isCustomLanguageModeAvailable("share") })
  }
];
const OPTION_TALK_POLICY_BINDINGS = [
  {
    name: "talkDefaultTitle",
    storageKey: "talkDefaultTitle",
    domain: "talk",
    key: "talk_title",
    element: talkDefaultTitleInput,
    row: talkDefaultTitleRow,
    property: "value",
    type: "string",
    fallback: DEFAULT_TALK_TITLE
  },
  {
    name: "talkDefaultLobby",
    storageKey: "talkDefaultLobby",
    domain: "talk",
    key: "talk_lobby_active",
    element: talkDefaultLobbyInput,
    row: talkDefaultLobbyRow,
    property: "checked",
    type: "boolean"
  },
  {
    name: "talkDefaultListable",
    storageKey: "talkDefaultListable",
    domain: "talk",
    key: "talk_show_in_search",
    element: talkDefaultListableInput,
    row: talkDefaultListableRow,
    property: "checked",
    type: "boolean"
  },
  {
    name: "talkAddUsersDefaultEnabled",
    storageKey: "talkAddUsersDefaultEnabled",
    legacyStorageKey: "talkAddParticipantsDefaultEnabled",
    domain: "talk",
    key: "talk_add_users",
    element: talkDefaultAddUsersInput,
    property: "checked",
    type: "boolean"
  },
  {
    name: "talkAddGuestsDefaultEnabled",
    storageKey: "talkAddGuestsDefaultEnabled",
    legacyStorageKey: "talkAddParticipantsDefaultEnabled",
    domain: "talk",
    key: "talk_add_guests",
    element: talkDefaultAddGuestsInput,
    property: "checked",
    type: "boolean"
  },
  {
    name: "talkPasswordDefaultEnabled",
    storageKey: "talkPasswordDefaultEnabled",
    domain: "talk",
    key: "talk_set_password",
    element: talkDefaultPasswordInput,
    row: talkDefaultPasswordRow,
    property: "checked",
    type: "boolean"
  },
  {
    name: "talkDeleteRoomOnEventDelete",
    storageKey: "talkDeleteRoomOnEventDelete",
    domain: "talk",
    key: "talk_delete_room_on_event_delete",
    element: talkDeleteRoomOnEventDeleteInput,
    row: talkDeleteRoomOnEventDeleteRow,
    property: "checked",
    type: "boolean"
  },
  {
    name: "eventDescriptionLang",
    storageKey: "eventDescriptionLang",
    domain: "talk",
    key: "language_talk_description",
    element: eventDescriptionLangSelect,
    row: eventDescriptionLangRow,
    property: "value",
    type: "string",
    normalize: (value) => normalizeLangChoice(value, { allowCustom: isCustomLanguageModeAvailable("talk") })
  }
];
let statusTimer = null;
let composeAttachmentSettingsLocked = false;
let runtimePolicyStatus = null;
let policyLockTalkAddUsers = false;
let policyLockTalkAddGuests = false;
let policyLockSharingAttachmentsAlways = false;
let policyLockSharingAttachmentsThreshold = false;
let talkAddressbookLockActive = false;
let talkAddressbookLockDetail = "";
let managedSetupPolicy = typeof NCManagedSetup !== "undefined" && NCManagedSetup?.emptyPolicy
  ? NCManagedSetup.emptyPolicy()
  : null;
let managedSetupPolicyReady = false;
let emailSignatureStoredState = {
  hasOnCompose: false,
  hasOnReply: false,
  hasOnForward: false
};
const SUPPORTED_OVERRIDE_LOCALES = getSupportedOverrideLocales();
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

function getSupportedOverrideLocales(){
  try{
    if (Array.isArray(NCI18nOverride.supportedLocales) && NCI18nOverride.supportedLocales.length){
      return Array.from(new Set(NCI18nOverride.supportedLocales));
    }
  }catch(error){
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "supported locales detection failed", error);
  }
  return ["en", "de", "fr"];
}

function initLanguageOverrideSelects(){
  refreshLanguageOverrideSelects();
}

function getUiLanguage(){
  try{
    if (typeof browser !== "undefined" && browser?.i18n?.getUILanguage){
      return browser.i18n.getUILanguage() || "en";
    }
  }catch(error){
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "ui language detection failed", error);
  }
  return "en";
}

function toBcp47Tag(locale){
  return String(locale || "").replace(/_/g, "-");
}

function makeDisplayNames(uiLang){
  if (typeof Intl === "undefined" || typeof Intl.DisplayNames !== "function"){
    return null;
  }
  try{
    return new Intl.DisplayNames([uiLang], { type: "language" });
  }catch(error){
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "Intl.DisplayNames init failed", error);
    return null;
  }
}

function makeCollator(uiLang){
  if (typeof Intl === "undefined" || typeof Intl.Collator !== "function"){
    return null;
  }
  try{
    return new Intl.Collator([uiLang], { sensitivity: "base", numeric: true });
  }catch(error){
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "Intl.Collator init failed", error);
    return null;
  }
}

function getLocaleLabel(locale, displayNames){
  const tag = toBcp47Tag(locale);
  if (displayNames){
    try{
      const label = displayNames.of(tag);
      if (label){
        return label;
      }
    }catch(error){
      globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "locale label lookup failed", error);
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
function getPolicyLanguageKey(domain){
  return domain === "talk" ? "language_talk_description" : "language_share_html_block";
}

function getPolicyTemplateKeys(domain){
  return domain === "talk"
    ? ["talk_invitation_template"]
    : ["share_html_block_template_v2", "share_html_block_template"];
}

/**
 * Return true when backend custom template mode can be selected
 * This requires an active backend policy, language=`custom`, and a non-empty template.
 * @param {"share"|"talk"|"email_signature"} domain
 * @returns {boolean}
 */
function isCustomLanguageModeAvailable(domain){
  if (!NCPolicyState.isEndpointAvailable(runtimePolicyStatus) || !NCPolicyState.isDomainActive(runtimePolicyStatus, domain)){
    return false;
  }
  const language = normalizeLangChoice(
    NCPolicyState.coerceString(NCPolicyState.readPolicyValue(runtimePolicyStatus, domain, getPolicyLanguageKey(domain)), ""),
    { allowCustom: true }
  );
  const hasTemplate = getPolicyTemplateKeys(domain).some((key) => (
    !!NCPolicyState.coerceString(NCPolicyState.readPolicyValue(runtimePolicyStatus, domain, key), "")
  ));
  return language === "custom" && hasTemplate;
}

function isSeparatePasswordMailFeatureAvailable(){
  return NCWizardPolicyUi.isSeparatePasswordFeatureAvailable(runtimePolicyStatus);
}

function getSeparatePasswordUnavailableHint(){
  return NCWizardPolicyUi.getSeparatePasswordUnavailableHint(runtimePolicyStatus, i18n);
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
  const showCustom = NCPolicyState.isEndpointAvailable(runtimePolicyStatus);
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

function getAdminControlledHint(){
  return NCWizardPolicyUi.getAdminControlledHint(i18n);
}

async function refreshManagedSetupPolicy(){
  if (typeof NCManagedSetup === "undefined" || !NCManagedSetup?.read){
    managedSetupPolicy = null;
    managedSetupPolicyReady = true;
    return managedSetupPolicy;
  }
  const policy = await NCManagedSetup.read();
  managedSetupPolicy = policy;
  managedSetupPolicyReady = true;
  return managedSetupPolicy;
}

function getEffectiveBaseUrl(localBaseUrl){
  if (!managedSetupPolicyReady){
    return "";
  }
  if (typeof NCManagedSetup === "undefined" || !NCManagedSetup?.resolveBaseUrl){
    return String(localBaseUrl || "").trim();
  }
  return NCManagedSetup.resolveBaseUrl(localBaseUrl, managedSetupPolicy);
}

function isManagedBaseUrlLocked(){
  return !!(managedSetupPolicy?.hasNextcloudUrl && managedSetupPolicy?.nextcloudUrlLocked);
}

/**
 * Apply one lock title to row/input elements.
 * @param {HTMLElement|null} row
 * @param {HTMLElement|null} input
 * @param {boolean} locked
 */
function applyOptionPolicyBindings(bindings){
  const locks = {};
  bindings.forEach((binding) => {
    locks[binding.name] = NCWizardPolicyUi.applyPolicyBinding(runtimePolicyStatus, binding, i18n);
  });
  return locks;
}

function hasValidStoredBindingValue(stored, binding){
  if (!binding?.storageKey){
    return false;
  }
  let value = stored?.[binding.storageKey];
  if (value === undefined && binding.legacyStorageKey){
    value = stored?.[binding.legacyStorageKey];
  }
  if (typeof binding.isValid === "function"){
    return binding.isValid(value);
  }
  if (binding.type === "boolean"){
    return typeof value === "boolean";
  }
  if (binding.type === "int"){
    return Number.isFinite(Number.parseInt(String(value ?? ""), 10));
  }
  if (binding.type === "string"){
    return typeof value === "string" && !!value.trim();
  }
  return value !== undefined;
}

/**
 * Apply backend defaults once during initial options loading. Editable values
 * keep valid local storage values; locked values always use the backend.
 * @param {Array<object>} bindings
 * @param {object} stored
 */
function applyInitialPolicyDefaults(bindings, stored){
  const domains = new Set(bindings.map((binding) => binding.domain).filter(Boolean));
  domains.forEach((domain) => {
    const domainBindings = bindings.filter((binding) => binding.domain === domain && binding.element && binding.property);
    const currentValues = {};
    const localNames = new Set();
    domainBindings.forEach((binding) => {
      currentValues[binding.name] = binding.element[binding.property];
      if (hasValidStoredBindingValue(stored, binding)){
        localNames.add(binding.name);
      }
    });
    const resolved = NCWizardPolicyUi.readPolicyBoundDefaults(
      NCWizardPolicyUi.readPolicyDomain(runtimePolicyStatus, domain),
      domainBindings,
      currentValues,
      { localNames }
    );
    domainBindings.forEach((binding) => {
      binding.element[binding.property] = resolved[binding.name];
    });
  });
}

function applyInitialSpecialPolicyDefaults(stored){
  const hasLocalRoomType = stored?.talkDefaultRoomType === "normal" || stored?.talkDefaultRoomType === "event";
  const roomType = NCPolicyState.resolveDefaultValue(
    runtimePolicyStatus,
    "talk",
    "talk_room_type",
    getSelectedTalkDefaultRoomType(),
    hasLocalRoomType,
    NCPolicyState.coerceString
  );
  setTalkDefaultRoomType(roomType === "normal" ? "normal" : "event");

  const hasLocalAlways = typeof stored?.[SHARING_KEYS.attachmentsAlwaysConnector] === "boolean";
  if (sharingAttachmentsAlwaysNcInput){
    sharingAttachmentsAlwaysNcInput.checked = NCPolicyState.resolveDefaultValue(
      runtimePolicyStatus,
      "share",
      "attachments_always_via_ncconnector",
      !!sharingAttachmentsAlwaysNcInput.checked,
      hasLocalAlways,
      NCPolicyState.coerceBoolean
    );
  }

  const hasLocalThreshold = typeof stored?.[SHARING_KEYS.attachmentsOfferAboveEnabled] === "boolean"
    || stored?.[SHARING_KEYS.attachmentsOfferAboveMb] !== undefined;
  const usePolicyThreshold = NCPolicyState.isDomainActive(runtimePolicyStatus, "share")
    && (!hasLocalThreshold || NCPolicyState.isLocked(runtimePolicyStatus, "share", "attachments_min_size_mb"))
    && NCPolicyState.hasPolicyKey(runtimePolicyStatus, "share", "attachments_min_size_mb");
  if (usePolicyThreshold){
    const rawThreshold = NCPolicyState.readPolicyValue(runtimePolicyStatus, "share", "attachments_min_size_mb");
    if (sharingAttachmentsOfferAboveEnabledInput){
      sharingAttachmentsOfferAboveEnabledInput.checked = rawThreshold != null;
    }
    if (rawThreshold != null && sharingAttachmentsOfferAboveMbInput){
      sharingAttachmentsOfferAboveMbInput.value = String(normalizeAttachmentThresholdMb(rawThreshold));
    }
  }
}

function normalizeEmailAddress(value){
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

function getEmailSignatureUnavailableHint(){
  const status = runtimePolicyStatus?.status;
  const seatState = String(status?.seatState || "").trim().toLowerCase();
  if (!NCPolicyState.isEndpointAvailable(runtimePolicyStatus)){
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
  if (!NCPolicyState.isDomainAvailable(runtimePolicyStatus, "email_signature")){
    return i18n("options_signature_backend_update_required_tooltip")
      || "Please update the NC Connector backend. This backend version does not support central email signatures yet.";
  }
  if (!NCPolicyState.isDomainActive(runtimePolicyStatus, "email_signature")
    || !String(NCPolicyState.readPolicyValue(runtimePolicyStatus, "email_signature", "email_signature_template") || "").trim()
    || !normalizeEmailAddress(NCPolicyState.readPolicyValue(runtimePolicyStatus, "email_signature", "user_email"))){
    return i18n("options_signature_backend_inactive_tooltip")
      || "Central signature policy is inactive or incomplete.";
  }
  return "";
}

function isEmailSignatureRuntimeAvailable(){
  return !getEmailSignatureUnavailableHint();
}

function applyEmailSignatureRowState(row, input, disabled, title){
  if (row){
    row.classList.toggle("is-disabled", !!disabled);
    row.title = title || "";
  }
  if (input){
    input.disabled = !!disabled;
    input.title = title || "";
  }
}

function applyEmailSignatureSettingsOverlay(){
  const runtimeAvailable = isEmailSignatureRuntimeAvailable();
  const backendOnCompose = NCPolicyState.readPolicyValue(runtimePolicyStatus, "email_signature", "email_signature_on_compose") === true;
  const backendOnReply = NCPolicyState.readPolicyValue(runtimePolicyStatus, "email_signature", "email_signature_on_reply") === true;
  const backendOnForward = NCPolicyState.readPolicyValue(runtimePolicyStatus, "email_signature", "email_signature_on_forward") === true;
  const lockOnCompose = NCPolicyState.isLocked(runtimePolicyStatus, "email_signature", "email_signature_on_compose");
  const lockOnReply = NCPolicyState.isLocked(runtimePolicyStatus, "email_signature", "email_signature_on_reply");
  const lockOnForward = NCPolicyState.isLocked(runtimePolicyStatus, "email_signature", "email_signature_on_forward");
  const inactiveHint = getEmailSignatureUnavailableHint();
  const adminHint = getAdminControlledHint();

  if (emailSignaturePolicyHint){
    emailSignaturePolicyHint.textContent = inactiveHint || "";
    emailSignaturePolicyHint.hidden = !inactiveHint;
  }

  if (emailSignatureOnComposeInput){
    if (!runtimeAvailable){
      emailSignatureOnComposeInput.checked = false;
    }else if (lockOnCompose || !emailSignatureStoredState.hasOnCompose){
      emailSignatureOnComposeInput.checked = backendOnCompose;
    }
    applyEmailSignatureRowState(
      emailSignatureOnComposeRow,
      emailSignatureOnComposeInput,
      !runtimeAvailable || lockOnCompose,
      !runtimeAvailable ? inactiveHint : (lockOnCompose ? adminHint : "")
    );
  }

  const composeEnabled = runtimeAvailable && emailSignatureOnComposeInput?.checked === true;
  if (emailSignatureOnReplyInput){
    if (!composeEnabled){
      emailSignatureOnReplyInput.checked = false;
    }else if (lockOnReply || !emailSignatureStoredState.hasOnReply){
      emailSignatureOnReplyInput.checked = backendOnReply;
    }
    applyEmailSignatureRowState(
      emailSignatureOnReplyRow,
      emailSignatureOnReplyInput,
      !composeEnabled || lockOnReply,
      !runtimeAvailable ? inactiveHint : (lockOnReply ? adminHint : "")
    );
  }
  if (emailSignatureOnForwardInput){
    if (!composeEnabled){
      emailSignatureOnForwardInput.checked = false;
    }else if (lockOnForward || !emailSignatureStoredState.hasOnForward){
      emailSignatureOnForwardInput.checked = backendOnForward;
    }
    applyEmailSignatureRowState(
      emailSignatureOnForwardRow,
      emailSignatureOnForwardInput,
      !composeEnabled || lockOnForward,
      !runtimeAvailable ? inactiveHint : (lockOnForward ? adminHint : "")
    );
  }
}

function applyPolicyWarningUi(){
  const warning = runtimePolicyStatus?.warning || {};
  NCWizardPolicyUi.applyPolicyWarningUi({
    row: policyWarningRow,
    textElement: policyWarningText,
    warningVisible: warning.visible,
    translate: i18n
  });
}

async function refreshBackendPolicyStatus(credentials = null){
  try{
    const response = credentials
      ? await browser.runtime.sendMessage({
        type: "options:testConnection",
        payload: {
          baseUrl: credentials.baseUrl,
          user: credentials.user,
          appPass: credentials.appPass
        }
      })
      : await browser.runtime.sendMessage({
        type: "policy:getStatus"
      });
    runtimePolicyStatus = response?.ok
      ? (credentials ? (response.policyStatus || null) : (response.status || null))
      : null;
  }catch(error){
    runtimePolicyStatus = null;
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "policy status check failed", error);
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
  const shareLocks = applyOptionPolicyBindings(OPTION_SHARE_POLICY_BINDINGS);
  const talkLocks = applyOptionPolicyBindings(OPTION_TALK_POLICY_BINDINGS);
  const lockPermUpload = !!shareLocks.sharingDefaultPermCreate;
  const lockPermEdit = !!shareLocks.sharingDefaultPermWrite;
  const lockPermDelete = !!shareLocks.sharingDefaultPermDelete;
  const lockTalkRoomType = NCPolicyState.isLocked(runtimePolicyStatus, "talk", "talk_room_type");
  policyLockSharingAttachmentsAlways = NCPolicyState.isLocked(runtimePolicyStatus, "share", "attachments_always_via_ncconnector");
  policyLockSharingAttachmentsThreshold = NCPolicyState.isLocked(runtimePolicyStatus, "share", "attachments_min_size_mb");
  policyLockTalkAddUsers = !!talkLocks.talkAddUsersDefaultEnabled;
  policyLockTalkAddGuests = !!talkLocks.talkAddGuestsDefaultEnabled;

  if (!isSeparatePasswordMailFeatureAvailable() && sharingDefaultPasswordSeparateInput){
    sharingDefaultPasswordSeparateInput.checked = false;
  }
  if (policyLockSharingAttachmentsAlways && sharingAttachmentsAlwaysNcInput){
    sharingAttachmentsAlwaysNcInput.checked = NCPolicyState.coerceBoolean(
      NCPolicyState.readPolicyValue(runtimePolicyStatus, "share", "attachments_always_via_ncconnector"),
      sharingAttachmentsAlwaysNcInput.checked
    );
  }
  if (policyLockSharingAttachmentsThreshold && sharingAttachmentsOfferAboveMbInput){
    const thresholdDisabled = NCPolicyState.isExplicitNull(runtimePolicyStatus, "share", "attachments_min_size_mb");
    if (!thresholdDisabled){
      sharingAttachmentsOfferAboveMbInput.value = String(
        normalizeAttachmentThresholdMb(
          NCPolicyState.coerceInt(
            NCPolicyState.readPolicyValue(runtimePolicyStatus, "share", "attachments_min_size_mb"),
            Number.parseInt(sharingAttachmentsOfferAboveMbInput.value || "", 10)
          )
        )
      );
    }
    if (sharingAttachmentsOfferAboveEnabledInput){
      sharingAttachmentsOfferAboveEnabledInput.checked = !thresholdDisabled;
    }
  }
  if (lockTalkRoomType){
    const raw = NCPolicyState.coerceString(NCPolicyState.readPolicyValue(runtimePolicyStatus, "talk", "talk_room_type"), getSelectedTalkDefaultRoomType());
    setTalkDefaultRoomType(raw === "event" ? "event" : "normal");
  }
  NCWizardPolicyUi.applyDisabledState({
    row: sharingDefaultPermissionsRow,
    disabled: lockPermUpload || lockPermEdit || lockPermDelete,
    title: lockPermUpload || lockPermEdit || lockPermDelete ? getAdminControlledHint() : ""
  });
  NCWizardPolicyUi.applyDisabledState({
    element: talkDefaultRoomTypeButton,
    row: talkDefaultRoomTypeRow,
    disabled: lockTalkRoomType,
    title: lockTalkRoomType ? getAdminControlledHint() : ""
  });
  if (lockTalkRoomType){
    closeTalkDefaultRoomTypeDropdown();
  }

  applyEmailSignatureSettingsOverlay();
  updateSharingPasswordState();
  updateAttachmentThresholdState();
  applyTalkSystemAddressbookLockState(talkAddressbookLockActive, talkAddressbookLockDetail);
}

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
    SHARING_KEYS.defaultPasswordDeliveryMode,
    SHARING_KEYS.defaultExpireDays,
    SHARING_KEYS.attachmentsLinkTarget,
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
    "talkDeleteRoomOnEventDelete",
    "talkDefaultRoomType",
    "shareBlockLang",
    "eventDescriptionLang",
    EMAIL_SIGNATURE_KEYS.onCompose,
    EMAIL_SIGNATURE_KEYS.onReply,
    EMAIL_SIGNATURE_KEYS.onForward
  ]);
  // Hydrate local credentials before the managed-policy read. A genuine
  // policy backend failure still keeps all actions fail-closed, but must not
  // make existing local settings look as if they had been deleted.
  if (stored.baseUrl) baseUrlInput.value = stored.baseUrl;
  if (stored.user) userInput.value = stored.user;
  if (stored.appPass) appPassInput.value = stored.appPass;
  await refreshManagedSetupPolicy();
  const effectiveBaseUrl = getEffectiveBaseUrl(stored.baseUrl || "");
  if (effectiveBaseUrl) baseUrlInput.value = effectiveBaseUrl;
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
  if (sharingDefaultPasswordDeliveryModeSelect){
    sharingDefaultPasswordDeliveryModeSelect.value = NCSharePasswordDelivery.coerceMode(
      stored[SHARING_KEYS.defaultPasswordDeliveryMode],
      NCSharePasswordDelivery.MODE_PLAIN
    );
  }
  updateSharingPasswordState();
  if (sharingDefaultExpireDaysInput){
    const normalizedExpireDays = NCTalkTextUtils.normalizeExpireDays(
      stored[SHARING_KEYS.defaultExpireDays],
      DEFAULT_SHARING_EXPIRE_DAYS
    );
    sharingDefaultExpireDaysInput.value = String(normalizedExpireDays);
  }
  if (sharingAttachmentsLinkTargetSelect){
    sharingAttachmentsLinkTargetSelect.value = normalizeAttachmentLinkTarget(
      stored[SHARING_KEYS.attachmentsLinkTarget],
      DEFAULT_SHARING_ATTACHMENT_LINK_TARGET
    );
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
  if (talkDeleteRoomOnEventDeleteInput){
    talkDeleteRoomOnEventDeleteInput.checked = stored.talkDeleteRoomOnEventDelete === true;
  }
  emailSignatureStoredState = {
    hasOnCompose: typeof stored[EMAIL_SIGNATURE_KEYS.onCompose] === "boolean",
    hasOnReply: typeof stored[EMAIL_SIGNATURE_KEYS.onReply] === "boolean",
    hasOnForward: typeof stored[EMAIL_SIGNATURE_KEYS.onForward] === "boolean"
  };
  if (emailSignatureOnComposeInput){
    emailSignatureOnComposeInput.checked = emailSignatureStoredState.hasOnCompose
      ? !!stored[EMAIL_SIGNATURE_KEYS.onCompose]
      : true;
  }
  if (emailSignatureOnReplyInput){
    emailSignatureOnReplyInput.checked = emailSignatureStoredState.hasOnReply
      ? !!stored[EMAIL_SIGNATURE_KEYS.onReply]
      : false;
  }
  if (emailSignatureOnForwardInput){
    emailSignatureOnForwardInput.checked = emailSignatureStoredState.hasOnForward
      ? !!stored[EMAIL_SIGNATURE_KEYS.onForward]
      : false;
  }
  const storedShareBlockLang = stored.shareBlockLang;
  const storedEventDescriptionLang = stored.eventDescriptionLang;
  setTalkDefaultRoomType(stored.talkDefaultRoomType);
  await refreshBackendPolicyStatus();
  if (shareBlockLangSelect){
    shareBlockLangSelect.value = normalizeLangChoice(storedShareBlockLang, {
      allowCustom: isCustomLanguageModeAvailable("share")
    });
  }
  if (eventDescriptionLangSelect){
    eventDescriptionLangSelect.value = normalizeLangChoice(storedEventDescriptionLang, {
      allowCustom: isCustomLanguageModeAvailable("talk")
    });
  }
  applyInitialPolicyDefaults(OPTION_SHARE_POLICY_BINDINGS.concat(OPTION_TALK_POLICY_BINDINGS), stored);
  applyInitialSpecialPolicyDefaults(stored);
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
  window.NCAddressbookUi?.applySystemAddressbookTooltipState(optionsAddUsersTooltipList, talkAddressbookLockActive);
  window.NCAddressbookUi?.applySystemAddressbookTooltipState(optionsAddGuestsTooltipList, talkAddressbookLockActive);
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
      globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "system addressbook unavailable", status.error || response.error);
    }
    applyTalkSystemAddressbookLockState(locked, detail);
  }catch(error){
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "system addressbook status check failed", error);
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
      globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "openDefaultBrowser failed", error);
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
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "open login url fallback failed", error);
  }
  return false;
}

/**
 * Persist options to storage and request host permission if needed.
 * @returns {Promise<void>}
 */
async function save(){
  if (!managedSetupPolicyReady){
    throw new Error(i18n("options_status_load_failed"));
  }
  const baseUrl = getEffectiveBaseUrl(baseUrlInput.value.trim());
  if (baseUrlInput && isManagedBaseUrlLocked()){
    baseUrlInput.value = baseUrl;
  }
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
  let sharingDefaultPasswordDeliveryMode = NCSharePasswordDelivery.coerceMode(
    sharingDefaultPasswordDeliveryModeSelect?.value,
    NCSharePasswordDelivery.MODE_PLAIN
  );
  let sharingDefaultExpireDays = NCTalkTextUtils.normalizeExpireDays(sharingDefaultExpireDaysInput?.value, DEFAULT_SHARING_EXPIRE_DAYS);
  let sharingAttachmentsLinkTarget = normalizeAttachmentLinkTarget(
    sharingAttachmentsLinkTargetSelect?.value,
    DEFAULT_SHARING_ATTACHMENT_LINK_TARGET
  );
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
  let talkDeleteRoomOnEventDelete = talkDeleteRoomOnEventDeleteInput ? !!talkDeleteRoomOnEventDeleteInput.checked : false;
  let talkDefaultRoomType = getSelectedTalkDefaultRoomType();
  let shareBlockLang = normalizeLangChoice(shareBlockLangSelect?.value, {
    allowCustom: isCustomLanguageModeAvailable("share")
  });
  let eventDescriptionLang = normalizeLangChoice(eventDescriptionLangSelect?.value, {
    allowCustom: isCustomLanguageModeAvailable("talk")
  });
  let emailSignatureOnCompose = emailSignatureOnComposeInput ? !!emailSignatureOnComposeInput.checked : false;
  let emailSignatureOnReply = emailSignatureOnReplyInput ? !!emailSignatureOnReplyInput.checked : false;
  let emailSignatureOnForward = emailSignatureOnForwardInput ? !!emailSignatureOnForwardInput.checked : false;
  const permissionOk = await ensureOriginPermissionInteractive();
  if (!permissionOk){
    return;
  }
  await refreshBackendPolicyStatus({ baseUrl, user, appPass });
  const policyValues = NCWizardPolicyUi.resolvePolicyBoundValues(
    runtimePolicyStatus,
    OPTION_SHARE_POLICY_BINDINGS.concat(OPTION_TALK_POLICY_BINDINGS),
    {
      sharingBasePath,
      sharingDefaultShareName,
      sharingDefaultPermCreate,
      sharingDefaultPermWrite,
      sharingDefaultPermDelete,
      sharingDefaultPassword,
      sharingDefaultPasswordSeparate,
      sharingDefaultPasswordDeliveryMode,
      sharingDefaultExpireDays,
      sharingAttachmentsLinkTarget,
      shareBlockLang,
      talkDefaultTitle,
      talkDefaultLobby,
      talkDefaultListable,
      talkAddUsersDefaultEnabled,
      talkAddGuestsDefaultEnabled,
      talkPasswordDefaultEnabled,
      talkDeleteRoomOnEventDelete,
      eventDescriptionLang
    }
  );
  ({
    sharingBasePath,
    sharingDefaultShareName,
    sharingDefaultPermCreate,
    sharingDefaultPermWrite,
    sharingDefaultPermDelete,
    sharingDefaultPassword,
    sharingDefaultPasswordSeparate,
    sharingDefaultPasswordDeliveryMode,
    sharingDefaultExpireDays,
    sharingAttachmentsLinkTarget,
    shareBlockLang,
    talkDefaultTitle,
    talkDefaultLobby,
    talkDefaultListable,
    talkAddUsersDefaultEnabled,
    talkAddGuestsDefaultEnabled,
    talkPasswordDefaultEnabled,
    talkDeleteRoomOnEventDelete,
    eventDescriptionLang
  } = policyValues);
  sharingAttachmentsAlwaysConnector = NCPolicyState.resolveValue(runtimePolicyStatus, "share", "attachments_always_via_ncconnector", sharingAttachmentsAlwaysConnector, NCPolicyState.coerceBoolean);
  sharingAttachmentsOfferAboveMb = normalizeAttachmentThresholdMb(
    NCPolicyState.resolveValue(runtimePolicyStatus, "share", "attachments_min_size_mb", sharingAttachmentsOfferAboveMb, NCPolicyState.coerceInt)
  );
  if (NCPolicyState.isLocked(runtimePolicyStatus, "share", "attachments_min_size_mb")){
    sharingAttachmentsOfferAboveEnabled = !NCPolicyState.isExplicitNull(runtimePolicyStatus, "share", "attachments_min_size_mb");
  }
  talkAddParticipantsDefaultEnabled = talkAddUsersDefaultEnabled || talkAddGuestsDefaultEnabled;
  talkDefaultRoomType = NCPolicyState.resolveValue(runtimePolicyStatus, "talk", "talk_room_type", talkDefaultRoomType, NCPolicyState.coerceString);
  talkDefaultRoomType = talkDefaultRoomType === "event" ? "event" : "normal";
  if (!isEmailSignatureRuntimeAvailable()){
    emailSignatureOnCompose = false;
    emailSignatureOnReply = false;
    emailSignatureOnForward = false;
  }else{
    emailSignatureOnCompose = NCPolicyState.resolveValue(runtimePolicyStatus,
      "email_signature",
      "email_signature_on_compose",
      emailSignatureOnCompose,
      NCPolicyState.coerceBoolean
    );
    if (!emailSignatureOnCompose){
      emailSignatureOnReply = false;
      emailSignatureOnForward = false;
    }else{
      emailSignatureOnReply = NCPolicyState.resolveValue(runtimePolicyStatus,
        "email_signature",
        "email_signature_on_reply",
        emailSignatureOnReply,
        NCPolicyState.coerceBoolean
      );
      emailSignatureOnForward = NCPolicyState.resolveValue(runtimePolicyStatus,
        "email_signature",
        "email_signature_on_forward",
        emailSignatureOnForward,
        NCPolicyState.coerceBoolean
      );
    }
  }
  if (!isSeparatePasswordMailFeatureAvailable()){
    sharingDefaultPasswordSeparate = false;
  }
  if (!sharingDefaultPasswordSeparate || NCSharePasswordDelivery.isSecretsUnavailable(runtimePolicyStatus)){
    sharingDefaultPasswordDeliveryMode = NCSharePasswordDelivery.MODE_PLAIN;
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
    [SHARING_KEYS.defaultPasswordDeliveryMode]: sharingDefaultPasswordDeliveryMode,
    [SHARING_KEYS.defaultExpireDays]: sharingDefaultExpireDays,
    [SHARING_KEYS.attachmentsLinkTarget]: sharingAttachmentsLinkTarget,
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
    talkDeleteRoomOnEventDelete,
    talkDefaultRoomType,
    shareBlockLang,
    eventDescriptionLang,
    [EMAIL_SIGNATURE_KEYS.onCompose]: emailSignatureOnCompose,
    [EMAIL_SIGNATURE_KEYS.onReply]: emailSignatureOnReply,
    [EMAIL_SIGNATURE_KEYS.onForward]: emailSignatureOnForward
  });
  emailSignatureStoredState = {
    hasOnCompose: true,
    hasOnReply: true,
    hasOnForward: true
  };
  // First setup stores credentials only here; reload policy so backend locks/defaults show immediately.
  await refreshBackendPolicyStatus();
  await refreshTalkSystemAddressbookState({ forceRefresh: true });
  showStatus(i18n("options_status_saved"));
}

if (saveButton){
  saveButton.addEventListener("click", async () => {
    try{
      await save();
    }catch(error){
      globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "save failed", error);
      showStatus(error?.message || i18n("options_status_save_failed"), true);
    }finally{
      updateAuthModeUI();
    }
  });
}

if (sharingAttachmentsOfferAboveEnabledInput){
  sharingAttachmentsOfferAboveEnabledInput.addEventListener("change", () => {
    updateAttachmentThresholdState();
  });
}
if (emailSignatureOnComposeInput){
  emailSignatureOnComposeInput.addEventListener("change", () => {
    emailSignatureStoredState.hasOnCompose = true;
    applyEmailSignatureSettingsOverlay();
  });
}
if (emailSignatureOnReplyInput){
  emailSignatureOnReplyInput.addEventListener("change", () => {
    emailSignatureStoredState.hasOnReply = true;
  });
}
if (emailSignatureOnForwardInput){
  emailSignatureOnForwardInput.addEventListener("change", () => {
    emailSignatureStoredState.hasOnForward = true;
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
if (sharingDefaultPasswordSeparateInput){
  sharingDefaultPasswordSeparateInput.addEventListener("change", () => {
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
    }catch(error){
      globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "test connection failed", error);
      showStatus(error?.message || i18n("options_test_failed"), true);
    }finally{
      button.textContent = originalLabel || i18n("options_test_button");
      updateAuthModeUI();
    }
  });
}
if (appPassInput){
  appPassInput.addEventListener("input", updateAuthModeUI);
}
if (baseUrlInput){
  baseUrlInput.addEventListener("input", updateAuthModeUI);
}
if (userInput){
  userInput.addEventListener("input", updateAuthModeUI);
}

load().catch((error) => {
  globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "options load failed", error);
  showStatus(error?.message || i18n("options_status_load_failed"), true);
  updateAuthModeUI();
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
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "options focus refresh failed", error);
  }
});

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
        globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "talk tab system addressbook refresh failed", error);
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

function initAbout(){
  const versionEl = document.getElementById("aboutVersion");
  try{
    const manifest = browser?.runtime?.getManifest?.();
    if (manifest?.version && versionEl){
      versionEl.textContent = manifest.version;
    }
  }catch(error){
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "about version lookup failed", error);
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

function getSelectedAuthMode(){
  const checked = document.querySelector("input[name='authMode']:checked");
  return checked ? checked.value : "manual";
}

function setAuthMode(mode){
  const target = authRadios.find((radio) => radio.value === mode);
  if (target){
    target.checked = true;
  } else if (authRadios.length){
    authRadios[0].checked = true;
  }
}

function updateAuthModeUI(){
  const mode = getSelectedAuthMode();
  const manual = mode === "manual";
  const managedSetupUnavailable = !managedSetupPolicyReady;
  const managedBaseUrlLocked = isManagedBaseUrlLocked();
  const hasBaseUrl = !!getEffectiveBaseUrl(baseUrlInput?.value || "");
  const hasUser = !!String(userInput?.value || "").trim();
  const hasAppPass = !!String(appPassInput?.value || "").trim();
  const hasConnectionSettings = hasBaseUrl && hasUser && hasAppPass;
  if (baseUrlInput){
    const managedHint = managedBaseUrlLocked
      ? (i18n("options_managed_nextcloud_url_tooltip") || getAdminControlledHint())
      : "";
    baseUrlInput.classList.toggle("needs-attention", !hasBaseUrl);
    baseUrlInput.disabled = managedBaseUrlLocked;
    baseUrlInput.title = managedHint;
    if (baseUrlManagedPolicyMarker){
      baseUrlManagedPolicyMarker.hidden = !managedBaseUrlLocked;
      baseUrlManagedPolicyMarker.title = managedHint;
      baseUrlManagedPolicyMarker.setAttribute("aria-label", managedHint || "");
    }
    if (baseUrlManagedPolicyTooltip){
      baseUrlManagedPolicyTooltip.hidden = !managedBaseUrlLocked;
    }
  }
  if (authBlock){
    authBlock.disabled = managedSetupUnavailable || !hasBaseUrl || loginFlowInProgress;
    authBlock.classList.toggle("is-disabled", managedSetupUnavailable || !hasBaseUrl);
  }
  authRadios.forEach((radio) => {
    radio.disabled = managedSetupUnavailable || !hasBaseUrl || loginFlowInProgress;
  });
  if (userInput) userInput.disabled = managedSetupUnavailable || !hasBaseUrl || !manual || loginFlowInProgress;
  if (appPassInput) appPassInput.disabled = managedSetupUnavailable || !hasBaseUrl || !manual || loginFlowInProgress;
  if (loginFlowButton){
    loginFlowButton.disabled = managedSetupUnavailable || loginFlowInProgress || !hasBaseUrl || mode !== "loginFlow";
  }
  if (testButton){
    testButton.disabled = managedSetupUnavailable || loginFlowInProgress || !hasConnectionSettings;
  }
  if (saveButton){
    saveButton.disabled = managedSetupUnavailable || loginFlowInProgress || !hasConnectionSettings;
  }
}

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

function openTalkDefaultRoomTypeDropdown(){
  if (!talkDefaultRoomTypeDropdown){
    return;
  }
  talkDefaultRoomTypeDropdown.hidden = false;
  talkDefaultRoomTypeButton?.setAttribute("aria-expanded", "true");
}

function closeTalkDefaultRoomTypeDropdown(){
  if (!talkDefaultRoomTypeDropdown){
    return;
  }
  talkDefaultRoomTypeDropdown.hidden = true;
  talkDefaultRoomTypeButton?.setAttribute("aria-expanded", "false");
}

function toggleTalkDefaultRoomTypeDropdown(){
  if (isTalkDefaultRoomTypeDropdownOpen()){
    closeTalkDefaultRoomTypeDropdown();
  }else{
    openTalkDefaultRoomTypeDropdown();
  }
}

function getSelectedTalkDefaultRoomType(){
  const value = talkDefaultRoomTypeValueInput?.value;
  return value === "normal" ? "normal" : "event";
}

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

function normalizeLangChoice(value, options = {}){
  const allowCustom = options.allowCustom !== undefined
    ? !!options.allowCustom
    : false;
  const raw = String(value || "default").trim();
  return NCI18nOverride.normalizeLanguageOverride(raw, { allowCustom });
}

function updateSharingPasswordState(){
  if (!sharingDefaultPasswordInput || !sharingDefaultPasswordSeparateInput){
    return;
  }
  const lockPassword = NCPolicyState.isLocked(runtimePolicyStatus, "share", "share_set_password");
  const lockSeparate = NCPolicyState.isLocked(runtimePolicyStatus, "share", "share_send_password_separately");
  const lockDeliveryMode = NCPolicyState.isLocked(runtimePolicyStatus, "share", "share_send_password_mode");
  const featureUnavailable = !isSeparatePasswordMailFeatureAvailable();
  const secretsUnavailable = NCSharePasswordDelivery.isSecretsUnavailable(runtimePolicyStatus);
  const passwordEnabled = !!sharingDefaultPasswordInput.checked;
  const separateEnabled = passwordEnabled && !featureUnavailable && !!sharingDefaultPasswordSeparateInput.checked;
  const deliveryHint = featureUnavailable
    ? getSeparatePasswordUnavailableHint()
    : (!separateEnabled
      ? (i18n("sharing_password_delivery_enable_separate_tooltip") || "")
      : (secretsUnavailable
        ? (i18n("sharing_password_delivery_unavailable_tooltip") || "")
        : (lockDeliveryMode ? getAdminControlledHint() : "")));
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
  if (sharingDefaultPasswordDeliveryModeSelect){
    if (secretsUnavailable){
      sharingDefaultPasswordDeliveryModeSelect.value = NCSharePasswordDelivery.MODE_PLAIN;
    }
    sharingDefaultPasswordDeliveryModeSelect.disabled = !separateEnabled || lockDeliveryMode || secretsUnavailable;
    sharingDefaultPasswordDeliveryModeSelect.title = deliveryHint;
  }
  if (sharingDefaultPasswordDeliveryModeRow){
    sharingDefaultPasswordDeliveryModeRow.classList.toggle("is-disabled", !separateEnabled || lockDeliveryMode || secretsUnavailable);
    sharingDefaultPasswordDeliveryModeRow.title = deliveryHint;
  }
}

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
    sharingAttachmentsOfferAboveEnabledInput.checked = !NCPolicyState.isExplicitNull(runtimePolicyStatus, "share", "attachments_min_size_mb");
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
    if (!managedSetupPolicyReady){
      showStatus(i18n("options_status_load_failed"), true, true);
      updateAuthModeUI();
      return;
    }
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
    }catch(error){
      globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "login flow failed", error);
      showStatus(error?.message || i18n("options_loginflow_failed"), true);
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
  if (!managedSetupPolicyReady){
    if (showMissing){
      showStatus(i18n("options_status_load_failed"), true, true);
    }
    return { ok:false, skipped:true, reason:"managed_setup_unavailable" };
  }
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
  }catch(error){
    globalThis.NCLogContext.safeConsoleError(OPTIONS_LOG_PREFIX, "testConnection runtime failed", error);
    showStatus(error?.message || i18n("options_test_failed"), true);
    return { ok:false, error: error?.message || String(error) };
  }
}
