/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
const i18n = NCI18n.translate;
const DEFAULT_SHARING_EXPIRE_DAYS = 7;
const DEFAULT_SHARING_SHARE_NAME = i18n("sharing_share_default") || "Freigabename";
const DEFAULT_TALK_TITLE = i18n("ui_default_title") || "Besprechung";
const FALLBACK_POPUP_WIDTH = 520;
const FALLBACK_POPUP_HEIGHT = 320;
const SHARING_KEYS = NCSharingStorage.SHARING_KEYS;

NCTalkDomI18n.translatePage(i18n, { titleKey: "options_title" });
initTabs();
initAbout();

const statusEl = document.getElementById("status");
const baseUrlInput = document.getElementById("baseUrl");
const userInput = document.getElementById("user");
const appPassInput = document.getElementById("appPass");
const sharingBaseInput = document.getElementById("sharingBase");
const sharingDefaultShareNameInput = document.getElementById("sharingDefaultShareName");
const sharingDefaultPermCreateInput = document.getElementById("sharingDefaultPermCreate");
const sharingDefaultPermWriteInput = document.getElementById("sharingDefaultPermWrite");
const sharingDefaultPermDeleteInput = document.getElementById("sharingDefaultPermDelete");
const sharingDefaultPasswordInput = document.getElementById("sharingDefaultPassword");
const sharingDefaultExpireDaysInput = document.getElementById("sharingDefaultExpireDays");
const talkDefaultTitleInput = document.getElementById("talkDefaultTitle");
const talkDefaultLobbyInput = document.getElementById("talkDefaultLobby");
const talkDefaultListableInput = document.getElementById("talkDefaultListable");
const talkDefaultAddParticipantsInput = document.getElementById("talkDefaultAddParticipants");
const talkDefaultPasswordInput = document.getElementById("talkDefaultPassword");
const talkDefaultRoomTypeRadios = Array.from(document.querySelectorAll("input[name='talkDefaultRoomType']"));
const shareBlockLangSelect = document.getElementById("shareBlockLang");
const eventDescriptionLangSelect = document.getElementById("eventDescriptionLang");
const DEFAULT_SHARING_BASE = (typeof NCSharing !== "undefined" ? NCSharing.DEFAULT_BASE_PATH : "90 Freigaben - extern");
let statusTimer = null;
const LANG_OPTIONS = new Set(["default", "en", "de", "fr"]);

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
    SHARING_KEYS.defaultExpireDays,
    "talkDefaultTitle",
    "talkDefaultLobby",
    "talkDefaultListable",
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
  if (sharingDefaultExpireDaysInput){
    const normalizedExpireDays = NCTalkTextUtils.normalizeExpireDays(
      stored[SHARING_KEYS.defaultExpireDays],
      DEFAULT_SHARING_EXPIRE_DAYS
    );
    sharingDefaultExpireDaysInput.value = String(normalizedExpireDays);
  }
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
  if (talkDefaultAddParticipantsInput){
    talkDefaultAddParticipantsInput.checked = stored.talkAddParticipantsDefaultEnabled !== undefined
      ? !!stored.talkAddParticipantsDefaultEnabled
      : false;
  }
  if (talkDefaultPasswordInput){
    talkDefaultPasswordInput.checked = stored.talkPasswordDefaultEnabled !== undefined
      ? !!stored.talkPasswordDefaultEnabled
      : true;
  }
  if (shareBlockLangSelect){
    shareBlockLangSelect.value = normalizeLangChoice(stored.shareBlockLang);
  }
  if (eventDescriptionLangSelect){
    eventDescriptionLangSelect.value = normalizeLangChoice(stored.eventDescriptionLang);
  }
  setTalkDefaultRoomType(stored.talkDefaultRoomType);
  setAuthMode(stored.authMode || "manual");
  updateAuthModeUI();
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
    }catch(_){}
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
  }catch(_){}
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
  const sharingBasePath = (sharingBaseInput?.value?.trim()) || DEFAULT_SHARING_BASE;
  const sharingDefaultShareName = (sharingDefaultShareNameInput?.value || "").trim() || DEFAULT_SHARING_SHARE_NAME;
  const sharingDefaultPermCreate = !!sharingDefaultPermCreateInput?.checked;
  const sharingDefaultPermWrite = !!sharingDefaultPermWriteInput?.checked;
  const sharingDefaultPermDelete = !!sharingDefaultPermDeleteInput?.checked;
  const sharingDefaultPassword = sharingDefaultPasswordInput
    ? !!sharingDefaultPasswordInput.checked
    : true;
  const sharingDefaultExpireDays = NCTalkTextUtils.normalizeExpireDays(sharingDefaultExpireDaysInput?.value, DEFAULT_SHARING_EXPIRE_DAYS);
  const talkDefaultTitle = (talkDefaultTitleInput?.value || "").trim() || DEFAULT_TALK_TITLE;
  const talkDefaultLobby = talkDefaultLobbyInput ? !!talkDefaultLobbyInput.checked : true;
  const talkDefaultListable = talkDefaultListableInput ? !!talkDefaultListableInput.checked : true;
  const talkAddParticipantsDefaultEnabled = talkDefaultAddParticipantsInput ? !!talkDefaultAddParticipantsInput.checked : false;
  const talkPasswordDefaultEnabled = talkDefaultPasswordInput ? !!talkDefaultPasswordInput.checked : true;
  const talkDefaultRoomType = getSelectedTalkDefaultRoomType();
  const shareBlockLang = normalizeLangChoice(shareBlockLangSelect?.value);
  const eventDescriptionLang = normalizeLangChoice(eventDescriptionLangSelect?.value);
  const permissionOk = await ensureOriginPermissionInteractive();
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
    [SHARING_KEYS.defaultExpireDays]: sharingDefaultExpireDays,
    talkDefaultTitle,
    talkDefaultLobby,
    talkDefaultListable,
    talkAddParticipantsDefaultEnabled,
    talkPasswordDefaultEnabled,
    talkDefaultRoomType,
    shareBlockLang,
    eventDescriptionLang
  });
  if (!permissionOk){
    return;
  }
  showStatus(i18n("options_status_saved"));
}

document.getElementById("save").addEventListener("click", async () => {
  try{
    await save();
  }catch(e){
    console.error(e);
    showStatus(e?.message || i18n("options_status_save_failed"), true);
  }
});

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
      console.error(err);
      showStatus(err?.message || i18n("options_test_failed"), true);
    }finally{
      button.disabled = false;
      button.textContent = originalLabel || i18n("options_test_button");
    }
  });
}

load().catch((e) => {
  console.error(e);
  showStatus(e?.message || i18n("options_status_load_failed"), true);
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
  }catch(_){}
  const licenseLink = document.getElementById("licenseLink");
  if (licenseLink && browser?.runtime?.getURL){
    licenseLink.href = browser.runtime.getURL("LICENSE.txt");
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
 * Read the selected default Talk room type.
 * @returns {"normal"|"event"}
 */
function getSelectedTalkDefaultRoomType(){
  const checked = talkDefaultRoomTypeRadios.find((radio) => radio.checked);
  return checked?.value === "normal" ? "normal" : "event";
}

/**
 * Apply the selected default Talk room type to the radio group.
 * @param {string} value
 */
function setTalkDefaultRoomType(value){
  const normalized = value === "normal" ? "normal" : "event";
  talkDefaultRoomTypeRadios.forEach((radio) => {
    radio.checked = radio.value === normalized;
  });
}

/**
 * Normalize a language selection to the supported list.
 * @param {string} value
 * @returns {"default"|"en"|"de"|"fr"}
 */
function normalizeLangChoice(value){
  const normalized = String(value || "default").toLowerCase();
  return LANG_OPTIONS.has(normalized) ? normalized : "default";
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
      console.error(err);
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
    console.error(err);
    showStatus(err?.message || i18n("options_test_failed"), true);
    return { ok:false, error: err?.message || String(err) };
  }
}




