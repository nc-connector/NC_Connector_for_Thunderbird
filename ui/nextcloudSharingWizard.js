/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
(function(){
  const POPUP_CONTENT_WIDTH = 640;
  const POPUP_CONTENT_HEIGHT = 640;
  const MIN_CONTENT_HEIGHT = POPUP_CONTENT_HEIGHT;
  const CONTENT_MARGIN = 0;
  let layoutObserver = null;
  let isPageUnloading = false;
  const popupSizer = window.NCTalkPopupSizing?.createPopupSizer({
    fixedWidth: POPUP_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    margin: CONTENT_MARGIN,
    getContentHeight: () => getContentHeight()
  });
  let pendingUploadScroll = null;
  const TOTAL_STEPS = 4;
  const ATTACHMENT_DEFAULT_SHARE_NAME = "email_attachment";
  const LOG_SOURCE = 'nextcloudSharingWizard';
  const LOG_LABEL = 'Sharing';
  const LOG_CHANNEL = 'NCUI';
  const LOG_PREFIX = `[${LOG_CHANNEL}][${LOG_LABEL}]`;
  const SHARING_KEYS = NCSharingStorage.SHARING_KEYS;
  const POLICY_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md";

  /**
   * Log internal UI errors in a deterministic way.
   * @param {string} scope
   * @param {any} error
   */
  function logUiError(scope, error){
    try{
      console.error(LOG_PREFIX, scope, error);
    }catch(logError){
      console.error(LOG_PREFIX, scope, error?.message || String(error), logError?.message || String(logError));
    }
  }

  /**
   * Return the localized admin-control hint.
   * @returns {string}
   */
  function getAdminControlledHint(){
    return i18n("policy_admin_controlled_tooltip") || "Admin controlled";
  }

  /**
   * Return true when the backend endpoint exists.
   * @returns {boolean}
   */
  function isBackendEndpointAvailable(){
    return !!state.policy.status?.endpointAvailable;
  }

  /**
   * Return true when the current user has an active backend seat.
   * @returns {boolean}
   */
  function hasBackendSeatEntitlement(){
    const status = state.policy.status?.status;
    const seatState = String(status?.seatState || "").trim().toLowerCase();
    return !!(
      isBackendEndpointAvailable()
      && status?.seatAssigned
      && status?.isValid
      && seatState === "active"
    );
  }

  /**
   * Return true when separate password delivery is available.
   * @returns {boolean}
   */
  function isSeparatePasswordFeatureAvailable(){
    return hasBackendSeatEntitlement();
  }

  /**
   * Return the tooltip shown when separate password delivery is unavailable.
   * @returns {string}
   */
  function getSeparatePasswordUnavailableHint(){
    const status = state.policy.status?.status;
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
   * Read one share policy value from runtime state.
   * @param {string} key
   * @returns {any}
   */
  function readPolicyShareValue(key){
    const sharePolicy = state.policy?.share;
    if (!sharePolicy || typeof sharePolicy !== "object"){
      return null;
    }
    return Object.prototype.hasOwnProperty.call(sharePolicy, key)
      ? sharePolicy[key]
      : null;
  }

  /**
   * Return true when a share setting is admin-locked.
   * @param {string} key
   * @returns {boolean}
   */
  function isPolicyLock(key){
    if (!state.policy?.active){
      return false;
    }
    const editable = state.policy?.editable;
    if (!editable || typeof editable !== "object"){
      return false;
    }
    return editable[key] === false;
  }

  /**
   * Convert policy values to booleans with fallback.
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
   * Convert policy values to integers with fallback.
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
   * Convert policy values to non-empty strings with fallback.
   * @param {any} value
   * @param {string} fallback
   * @returns {string}
   */
  function coercePolicyString(value, fallback){
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  /**
   * Render policy warning visibility in the sharing wizard.
   */
  function applyPolicyWarningUi(){
    if (!dom.policyWarningRow){
      return;
    }
    const visible = !!state.policy.warningVisible;
    dom.policyWarningRow.hidden = !visible;
    if (!visible){
      return;
    }
    let warningText = i18n("policy_warning_license_invalid")
      || "Your NC Connector license or seat is currently not valid. Local settings are used. Please contact your Nextcloud administrator.";
    if (state.policy.warningCode === "license_invalid"){
      warningText = i18n("policy_warning_license_invalid")
        || "Your NC Connector license or seat is currently not valid. Local settings are used. Please contact your Nextcloud administrator.";
    }
    if (dom.policyWarningText){
      dom.policyWarningText.textContent = warningText;
    }
  }

  /**
   * Fetch the backend policy status and cache it in wizard state.
   * @returns {Promise<void>}
   */
  async function refreshPolicyStatus(){
    try{
      const response = await browser.runtime.sendMessage({
        type: "policy:getStatus"
      });
      const status = response?.ok ? (response.status || null) : null;
      const sharePolicy = status?.policy?.share;
      const editable = status?.policyEditable?.share;
      const active = !!(
        status?.policyActive
        && sharePolicy
        && typeof sharePolicy === "object"
        && editable
        && typeof editable === "object"
      );
      state.policy.status = status;
      state.policy.active = active;
      state.policy.share = active ? sharePolicy : null;
      state.policy.editable = active ? editable : null;
      state.policy.warningVisible = !!status?.warning?.visible;
      state.policy.warningCode = String(status?.warning?.code || "");
      log('Policy status', {
        active,
        warning: state.policy.warningCode || "",
        mode: status?.mode || ""
      });
    }catch(error){
      logUiError("policy status fetch failed", error);
    }
    applyPolicyWarningUi();
  }

  const state = {
    currentStep: 1,
    files: [],
    selectedFileId: null,
    basePath: '',
    shareContext: createShareContext(),
    defaults: {
      shareName: '',
      permCreate: false,
      permWrite: false,
      permDelete: false,
      passwordEnabled: true,
      passwordSeparate: false,
      expireDays: 7
    },
    passwordPolicy: null,
    uploadInProgress: false,
    uploadCompleted: false,
    uploadResult: null,
    tabId: null,
    launchContextId: null,
    mode: 'default',
    attachmentReason: null,
    debugEnabled: false,
    wizardWindowId: 0,
    remoteFolderInfo: null,
    pathColumnScrollLeft: 0,
    policy: {
      status: null,
      active: false,
      share: null,
      editable: null,
      warningVisible: false,
      warningCode: ""
    }
  };
  const dom = {};
  const i18n = NCI18n.translate;
  const DEFAULT_EXPIRE_DAYS = 7;

  // Register unload guards early so debug forwarding stops even if the window
  // closes while async init is still running.
  window.addEventListener('pagehide', cleanupPageResources, true);
  window.addEventListener('beforeunload', cleanupPageResources, true);
  window.addEventListener('unload', cleanupPageResources, true);

  document.addEventListener('DOMContentLoaded', init);

  /**
   * Initialize the sharing wizard UI and state.
   * @returns {Promise<void>}
   */
  async function init(){
    cacheElements();
    if (dom.policyWarningAdminLink){
      dom.policyWarningAdminLink.href = POLICY_ADMIN_URL;
    }
    setWizardReady(false);
    NCTalkDomI18n.translatePage(i18n, { titleKey: "sharing_dialog_title" });
    try{
      state.tabId = parseTabId();
      state.launchContextId = parseLaunchContextId();
      state.wizardWindowId = await resolveWizardWindowId();
      attachEvents();
      await refreshPolicyStatus();
      if (NCSharingStorage?.migrateLegacySharingKeys){
        await NCSharingStorage.migrateLegacySharingKeys();
      }
      try{
        await loadDefaultSettings();
      }catch(err){
        console.error('[NCSHARE-UI] defaults', err);
      }
      setDefaultShareName();
      await loadPasswordPolicy();
      await applyDefaultSecuritySettings();
      try{
        await Promise.all([loadBasePath(), loadDebugFlag()]);
      }catch(err){
        console.error('[NCSHARE-UI] init', err);
      }
      await loadLaunchContext();
      if (state.mode === "attachments"){
        await applyAttachmentModeDefaults();
      }else{
        setDefaultShareName();
      }
      renderFileTable();
      updateStep(state.mode === "attachments" ? 3 : 1);
      updateAttachmentModeInfo();
      log('Wizard initialized', {
        tabId: state.tabId,
        mode: state.mode,
        launchContextId: state.launchContextId || ""
      });
    }finally{
      setWizardReady(true);
      setupWindowSizing();
    }
  }

  /**
   * Toggle content visibility during async wizard initialization.
   * Prevents initial step flicker before attachment launch context is applied.
   * @param {boolean} ready
   */
  function setWizardReady(ready){
    if (!dom.content){
      return;
    }
    dom.content.setAttribute('data-wizard-ready', ready ? 'true' : 'false');
  }

  /**
   * Cache DOM elements used by the wizard.
   */
  function cacheElements(){
    dom.content = document.querySelector('.nc-dialog-content');
    dom.policyWarningRow = document.getElementById('policyWarningRow');
    dom.policyWarningText = document.getElementById('policyWarningText');
    dom.policyWarningAdminLink = document.getElementById('policyWarningAdminLink');
    dom.steps = Array.from(document.querySelectorAll('.wizard-step'));
    dom.shareNameRow = document.getElementById('shareNameRow');
    dom.shareName = document.getElementById('shareName');
    dom.permReadRow = document.getElementById('permReadRow');
    dom.permCreateRow = document.getElementById('permCreateRow');
    dom.permWriteRow = document.getElementById('permWriteRow');
    dom.permDeleteRow = document.getElementById('permDeleteRow');
    dom.permCreate = document.getElementById('permCreate');
    dom.permWrite = document.getElementById('permWrite');
    dom.permDelete = document.getElementById('permDelete');
    dom.passwordToggleRow = document.getElementById('passwordToggleRow');
    dom.passwordToggle = document.getElementById('passwordToggle');
    dom.passwordSeparateRow = document.getElementById('passwordSeparateRow');
    dom.passwordSeparateToggle = document.getElementById('passwordSeparateToggle');
    dom.passwordFields = document.getElementById('passwordFields');
    dom.passwordInput = document.getElementById('passwordInput');
    dom.passwordGenerate = document.getElementById('passwordGenerate');
    dom.expireToggleRow = document.getElementById('expireToggleRow');
    dom.expireToggle = document.getElementById('expireToggle');
    dom.expireFields = document.getElementById('expireFields');
    dom.expireDate = document.getElementById('expireDate');
    dom.basePathLabel = document.getElementById('basePathLabel');
    dom.addFilesBtn = document.getElementById('addFilesBtn');
    dom.addFolderBtn = document.getElementById('addFolderBtn');
    dom.removeFileBtn = document.getElementById('removeFileBtn');
    dom.fileInput = document.getElementById('fileInput');
    dom.folderInput = document.getElementById('folderInput');
    dom.fileTableBody = document.getElementById('fileTableBody');
    dom.fileTableWrapper = document.querySelector('.file-table-wrapper');
    dom.fileEmptyPlaceholder = document.getElementById('fileEmptyPlaceholder');
    dom.uploadStatus = document.getElementById('uploadStatus');
    dom.attachmentModeInfo = document.getElementById('attachmentModeInfo');
    dom.noteToggle = document.getElementById('noteToggle');
    dom.noteFields = document.getElementById('noteFields');
    dom.noteInput = document.getElementById('noteInput');
    dom.messageBar = document.getElementById('messageBar');
    dom.backBtn = document.getElementById('backBtn');
    dom.nextBtn = document.getElementById('nextBtn');
    dom.uploadBtn = document.getElementById('uploadBtn');
    dom.finishBtn = document.getElementById('finishBtn');
    dom.cancelBtn = document.getElementById('cancelBtn');
  }

  /**
   * Parse the compose tab id from the query string.
   * @returns {number|null}
   */
  function parseTabId(){
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('tabId');
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Parse the launch context id from the query string.
   * @returns {string}
   */
  function parseLaunchContextId(){
    const params = new URLSearchParams(window.location.search);
    const raw = String(params.get('launchContextId') || '').trim();
    return raw || '';
  }

  /**
   * Resolve the current popup window id for background-scoped cleanup tracking.
   * @returns {Promise<number>}
   */
  async function resolveWizardWindowId(){
    try{
      const currentWindow = await browser.windows.getCurrent();
      const windowId = Number(currentWindow?.id);
      return Number.isInteger(windowId) && windowId > 0 ? windowId : 0;
    }catch(error){
      logUiError("resolve wizard window id failed", error);
      return 0;
    }
  }

  /**
   * Attach UI event handlers for the wizard.
   */
  function attachEvents(){
    dom.shareName.addEventListener('input', () => {
      resetShareContext();
      invalidateUpload();
      log('shareName changed', dom.shareName.value);
    });
    [dom.permCreate, dom.permWrite, dom.permDelete].forEach((checkbox) => {
      checkbox.addEventListener('change', invalidateUpload);
    });
    dom.passwordToggle.addEventListener('change', async () => {
      const enabled = dom.passwordToggle.checked;
      applyPasswordToggleState(enabled);
      if (enabled && !dom.passwordInput.value){
        dom.passwordInput.value = await generatePasswordFromPolicy();
      }
      invalidateUpload();
      log('password toggle', dom.passwordToggle.checked);
    });
    dom.passwordSeparateToggle?.addEventListener('change', () => {
      invalidateUpload();
      log('separate password toggle', dom.passwordSeparateToggle.checked);
    });
    dom.passwordInput.addEventListener('input', invalidateUpload);
    dom.passwordGenerate.addEventListener('click', async () => {
      dom.passwordToggle.checked = true;
      applyPasswordToggleState(true);
      dom.passwordInput.value = await generatePasswordFromPolicy();
      invalidateUpload();
      log('password generated');
    });
    dom.expireToggle.addEventListener('change', () => {
      dom.expireFields.classList.toggle('hidden', !dom.expireToggle.checked);
      if (dom.expireToggle.checked && !dom.expireDate.value){
        dom.expireDate.value = getDefaultExpireDate();
      }
      applyPolicyControlLocks();
      invalidateUpload();
      log('expire toggle', dom.expireToggle.checked);
    });
    dom.expireDate.addEventListener('change', invalidateUpload);
    dom.noteToggle.addEventListener('change', () => {
      dom.noteFields.classList.toggle('hidden', !dom.noteToggle.checked);
      log('note toggle', dom.noteToggle.checked);
    });
    dom.addFilesBtn.addEventListener('click', () => {
      log('File dialog opened');
      dom.fileInput.click();
    });
    dom.addFolderBtn.addEventListener('click', () => {
      log('Folder dialog opened');
      dom.folderInput?.click();
    });
    dom.fileInput.addEventListener('change', (event) => handleFileSelection(event, 'file'));
    dom.folderInput?.addEventListener('change', (event) => handleFileSelection(event, 'folder'));
    dom.removeFileBtn.addEventListener('click', removeSelectedEntry);
    dom.backBtn.addEventListener('click', () => {
      if (state.currentStep > 1 && !state.uploadInProgress){
        updateStep(state.currentStep - 1);
        log('Step back', state.currentStep);
      }
    });
    dom.nextBtn.addEventListener('click', handleNext);
    dom.uploadBtn.addEventListener('click', () => {
      if (state.currentStep === 3){
        startUpload();
        log('Upload button click');
      }
    });
    dom.finishBtn.addEventListener('click', () => {
      if (state.mode === "attachments"){
        handleAttachmentModeFinish();
      }else{
        finalizeShare();
      }
    });
    dom.cancelBtn.addEventListener('click', handleCancel);
    log('Event handlers registered');
  }

  /**
   * Load default settings from storage into state.
   * @returns {Promise<void>}
   */
  async function loadDefaultSettings(){
    state.defaults.shareName = getDefaultShareName();
    state.defaults.permCreate = false;
    state.defaults.permWrite = false;
    state.defaults.permDelete = false;
    state.defaults.passwordEnabled = true;
    state.defaults.passwordSeparate = false;
    state.defaults.expireDays = DEFAULT_EXPIRE_DAYS;
    if (!browser?.storage?.local){
      return;
    }
    const stored = await browser.storage.local.get([
      SHARING_KEYS.defaultShareName,
      SHARING_KEYS.defaultPermCreate,
      SHARING_KEYS.defaultPermWrite,
      SHARING_KEYS.defaultPermDelete,
      SHARING_KEYS.defaultPassword,
      SHARING_KEYS.defaultPasswordSeparate,
      SHARING_KEYS.defaultExpireDays
    ]);
    const storedShareName = stored[SHARING_KEYS.defaultShareName];
    if (storedShareName){
      const trimmed = String(storedShareName).trim();
      if (trimmed){
        state.defaults.shareName = trimmed;
      }
    }
    if (typeof stored[SHARING_KEYS.defaultPermCreate] === 'boolean'){
      state.defaults.permCreate = stored[SHARING_KEYS.defaultPermCreate];
    }
    if (typeof stored[SHARING_KEYS.defaultPermWrite] === 'boolean'){
      state.defaults.permWrite = stored[SHARING_KEYS.defaultPermWrite];
    }
    if (typeof stored[SHARING_KEYS.defaultPermDelete] === 'boolean'){
      state.defaults.permDelete = stored[SHARING_KEYS.defaultPermDelete];
    }
    if (stored[SHARING_KEYS.defaultPassword] !== undefined){
      state.defaults.passwordEnabled = !!stored[SHARING_KEYS.defaultPassword];
    }
    if (stored[SHARING_KEYS.defaultPasswordSeparate] !== undefined){
      state.defaults.passwordSeparate = !!stored[SHARING_KEYS.defaultPasswordSeparate];
    }
    state.defaults.expireDays = NCTalkTextUtils.normalizeExpireDays(
      stored[SHARING_KEYS.defaultExpireDays],
      DEFAULT_EXPIRE_DAYS
    );
    if (state.policy.active){
      state.defaults.shareName = coercePolicyString(
        readPolicyShareValue("share_name_template"),
        state.defaults.shareName
      );
      state.defaults.permCreate = coercePolicyBoolean(
        readPolicyShareValue("share_permission_upload"),
        state.defaults.permCreate
      );
      state.defaults.permWrite = coercePolicyBoolean(
        readPolicyShareValue("share_permission_edit"),
        state.defaults.permWrite
      );
      state.defaults.permDelete = coercePolicyBoolean(
        readPolicyShareValue("share_permission_delete"),
        state.defaults.permDelete
      );
      state.defaults.passwordEnabled = coercePolicyBoolean(
        readPolicyShareValue("share_set_password"),
        state.defaults.passwordEnabled
      );
      state.defaults.passwordSeparate = coercePolicyBoolean(
        readPolicyShareValue("share_send_password_separately"),
        state.defaults.passwordSeparate
      );
      state.defaults.expireDays = NCTalkTextUtils.normalizeExpireDays(
        coercePolicyInt(readPolicyShareValue("share_expire_days"), state.defaults.expireDays),
        state.defaults.expireDays
      );
    }
    if (!isSeparatePasswordFeatureAvailable()){
      state.defaults.passwordSeparate = false;
    }
  }
  /**
   * Fetch the live password policy from Nextcloud.
   * @returns {Promise<object>}
   */
  async function loadPasswordPolicy(){
    state.passwordPolicy = await NCPasswordPolicyClient.loadPolicy({
      sendMessage: (message) => browser.runtime.sendMessage(message),
      logger: (message, error) => logUiError(message, error),
      logPrefix: LOG_PREFIX
    });
    return state.passwordPolicy;
  }

  /**
   * Load the configured base path and update the UI.
   * @returns {Promise<string>}
   */
  async function loadBasePath(){
    try{
      const policyBasePath = state.policy.active
        ? coercePolicyString(readPolicyShareValue("share_base_directory"), "")
        : "";
      const basePath = policyBasePath || await NCSharing.getFileLinkBasePath();
      state.basePath = basePath || '';
      if (dom.basePathLabel){
        dom.basePathLabel.textContent = state.basePath || '';
      }
    }catch(err){
      console.error('[NCSHARE-UI] basePath', err);
      state.basePath = NCSharing?.DEFAULT_BASE_PATH || '';
      if (dom.basePathLabel){
        dom.basePathLabel.textContent = state.basePath || '';
      }
    }
    return state.basePath;
  }

  /**
   * Load the debug flag from storage.
   * @returns {Promise<boolean>}
   */
  async function loadDebugFlag(){
    try{
      if (!browser?.storage?.local){
        state.debugEnabled = false;
        return state.debugEnabled;
      }
      const stored = await browser.storage.local.get(['debugEnabled']);
      state.debugEnabled = !!stored.debugEnabled;
    }catch(err){
      console.error('[NCSHARE-UI] debug flag', err);
      state.debugEnabled = false;
    }
    return state.debugEnabled;
  }

  /**
   * Load launch context passed by the background.
   * @returns {Promise<void>}
   */
  async function loadLaunchContext(){
    if (!state.launchContextId){
      log('Launch context not set (normal start)');
      return;
    }
    try{
      log('Request launch context', { contextId: state.launchContextId });
      const response = await browser.runtime.sendMessage({
        type: "sharing:getLaunchContext",
        payload: { contextId: state.launchContextId }
      });
      if (!response?.ok || !response.context){
        log('Launch context not found', state.launchContextId);
        return;
      }
      const context = response.context;
      log('Launch context received', {
        mode: context.mode || '',
        attachmentCount: Array.isArray(context.attachments) ? context.attachments.length : 0
      });
      if (context.mode === "attachments"){
        state.mode = "attachments";
        state.attachmentReason = context.reason || null;
        preloadAttachmentEntries(context.attachments);
      }
    }catch(err){
      console.error('[NCSHARE-UI] launch context', err);
      log('Launch context error', err?.message || String(err));
    }
  }

  /**
   * Fill the upload queue from attachment launch context.
   * @param {Array<object>} attachments
   */
  function preloadAttachmentEntries(attachments){
    const list = Array.isArray(attachments) ? attachments : [];
    const validCount = list.filter((item) => item && item.file instanceof File).length;
    log('Attachment launch context preload', {
      received: list.length,
      valid: validCount
    });
    state.files = list
      .filter((item) => item && item.file instanceof File)
      .map((item) => {
        const file = item.file;
        const fileName = NCSharing.sanitizeFileName(item.name || file.name || 'File');
        const sourceDisplayPath = resolveEntryDisplayPath({
          file,
          source: 'launch',
          fallbackName: fileName,
          providedPath: item.displayPath || item.path || item.fullPath || item.name || file.name || ''
        });
        const displayDir = extractDisplayDir(sourceDisplayPath);
        return {
          id: `entry_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          file,
          displayPath: buildDisplayPath(displayDir, fileName),
          displayDir,
          relativeDir: '',
          renamedName: '',
          status: 'pending',
          progress: 0,
          error: ''
        };
      });
    state.selectedFileId = null;
    log('Attachment queue prepared', { files: state.files.length });
  }

  /**
   * Apply the fixed defaults for attachment-mode launch.
   * @returns {Promise<void>}
   */
  async function applyAttachmentModeDefaults(){
    log('Apply attachment mode defaults');
    dom.noteToggle.checked = false;
    dom.noteFields.classList.add('hidden');
    dom.noteInput.value = '';
    await resolveAttachmentShareName();
    log('Attachment mode defaults set', {
      shareName: dom.shareName.value || '',
      files: state.files.length
    });
  }

  /**
   * Update the explanatory message for attachment-mode launches.
   */
  function updateAttachmentModeInfo(){
    if (!dom.attachmentModeInfo){
      return;
    }
    if (state.mode !== "attachments"){
      dom.attachmentModeInfo.hidden = true;
      dom.attachmentModeInfo.textContent = '';
      return;
    }
    if (state.attachmentReason?.trigger === "threshold"){
      const text = i18n('sharing_attachment_mode_reason_threshold', [
        NCTalkTextUtils.formatSizeMb(state.attachmentReason.totalBytes || 0),
        `${state.attachmentReason.thresholdMb || 0} MB`,
        state.attachmentReason.lastName || i18n('sharing_attachment_prompt_last_unknown'),
        NCTalkTextUtils.formatSizeMb(state.attachmentReason.lastSizeBytes || 0)
      ]);
      dom.attachmentModeInfo.textContent = text;
    }else{
      dom.attachmentModeInfo.textContent = i18n('sharing_attachment_mode_reason_always');
    }
    dom.attachmentModeInfo.hidden = false;
    log('Attachment mode info updated', {
      trigger: state.attachmentReason?.trigger || 'always'
    });
  }

  /**
   * Handle attachment-mode finish button: upload/create/insert in one action.
   * @returns {Promise<void>}
   */
  async function handleAttachmentModeFinish(){
    if (state.uploadInProgress){
      log('Attachment finish ignored (upload running)');
      return;
    }
    const tabId = Number(state.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0){
      setMessage(i18n('sharing_error_insert_failed'), 'error');
      log('Attachment finish canceled (missing tabId)');
      return;
    }
    try{
      const guard = await browser.runtime.sendMessage({
        type: 'sharing:checkAttachmentAutomationAllowed',
        payload: {
          tabId,
          stage: 'wizard_finish'
        }
      });
      if (!guard?.ok){
        const thresholdMb = Number.isFinite(Number(guard?.thresholdMb))
          ? Math.max(1, Math.floor(Number(guard.thresholdMb)))
          : 0;
        setMessage(
          i18n('sharing_attachment_automation_locked_error', [String(thresholdMb)]),
          'error'
        );
        log('Attachment finish blocked (Thunderbird setting active)', {
          thresholdMb,
          error: guard?.error || ''
        });
        return;
      }
    }catch(err){
      logUiError("attachment finish guard failed", err);
      setMessage(i18n('sharing_status_error'), 'error');
      log('Attachment finish check failed', err?.message || String(err));
      return;
    }
    log('Attachment finish started', {
      uploadCompleted: !!state.uploadCompleted,
      files: state.files.length
    });
    if (!state.uploadCompleted){
      await startUpload();
      if (!state.uploadCompleted){
        log('Attachment finish canceled (upload failed)');
        return;
      }
    }
    await finalizeShare();
  }

  /**
   * Read the minimum length from the active policy.
   * @returns {number|null}
   */
  function getPolicyMinLength(){
    return NCPasswordPolicyClient.getPolicyMinLength(state.passwordPolicy);
  }

  /**
   * Generate a password using Nextcloud policy.
   * @returns {Promise<string>}
   */
  async function generatePasswordFromPolicy(){
    return NCPasswordPolicyClient.generatePassword({
      policy: state.passwordPolicy,
      sendMessage: (message) => browser.runtime.sendMessage(message),
      passwordGenerator: (options) => NCTalkPassword.generatePassword(options),
      fallbackLength: 12,
      logger: (message, error) => logUiError(message, error),
      logPrefix: LOG_PREFIX
    });
  }

  /**
   * Apply password toggle state to the UI.
   * @param {boolean} enabled
   */
  function applyPasswordToggleState(enabled){
    const lockPassword = isPolicyLock("share_set_password");
    const lockSeparate = isPolicyLock("share_send_password_separately");
    const featureUnavailable = !isSeparatePasswordFeatureAvailable();
    const adminHint = getAdminControlledHint();
    if (dom.passwordToggle){
      dom.passwordToggle.disabled = lockPassword;
      dom.passwordToggle.title = lockPassword ? adminHint : "";
    }
    if (dom.passwordToggleRow){
      dom.passwordToggleRow.classList.toggle("is-disabled", lockPassword);
      dom.passwordToggleRow.title = lockPassword ? adminHint : "";
    }
    dom.passwordFields.classList.toggle('hidden', !enabled);
    dom.passwordInput.disabled = !enabled;
    dom.passwordGenerate.disabled = !enabled;
    if (dom.passwordSeparateToggle){
      dom.passwordSeparateToggle.disabled = !enabled || lockSeparate || featureUnavailable;
      dom.passwordSeparateToggle.title = featureUnavailable
        ? getSeparatePasswordUnavailableHint()
        : (lockSeparate ? adminHint : "");
      if (!enabled || featureUnavailable){
        dom.passwordSeparateToggle.checked = false;
      }
    }
    if (dom.passwordSeparateRow){
      dom.passwordSeparateRow.classList.toggle("is-disabled", !enabled || lockSeparate || featureUnavailable);
      dom.passwordSeparateRow.title = featureUnavailable
        ? getSeparatePasswordUnavailableHint()
        : (lockSeparate ? adminHint : "");
    }
    if (!enabled){
      dom.passwordInput.value = '';
    }
  }
  /**
   * Apply the default share name to the input if empty.
   */
  function setDefaultShareName(){
    if (!dom.shareName.value){
      dom.shareName.value = state.defaults.shareName || getDefaultShareName();
    }
  }

  /**
   * Apply default permission and password/expire settings to the UI.
   */
  async function applyDefaultSecuritySettings(){
    dom.permCreate.checked = !!state.defaults.permCreate;
    dom.permWrite.checked = !!state.defaults.permWrite;
    dom.permDelete.checked = !!state.defaults.permDelete;
    const enabled = !!state.defaults.passwordEnabled;
    dom.passwordToggle.checked = enabled;
    applyPasswordToggleState(enabled);
    if (dom.passwordSeparateToggle){
      dom.passwordSeparateToggle.checked = enabled && !!state.defaults.passwordSeparate;
    }
    if (enabled && !dom.passwordInput.value){
      dom.passwordInput.value = await generatePasswordFromPolicy();
    }
    dom.expireToggle.checked = true;
    dom.expireFields.classList.remove('hidden');
    dom.expireDate.value = getDefaultExpireDate();
    applyPolicyControlLocks();
  }

  /**
   * Apply admin lock state from backend policy to editable controls.
   */
  function applyPolicyControlLocks(){
    const adminHint = getAdminControlledHint();
    const lockShareName = isPolicyLock("share_name_template");
    const lockPermUpload = isPolicyLock("share_permission_upload");
    const lockPermEdit = isPolicyLock("share_permission_edit");
    const lockPermDelete = isPolicyLock("share_permission_delete");
    const lockExpireDays = isPolicyLock("share_expire_days");

    if (dom.shareName){
      dom.shareName.disabled = lockShareName;
      dom.shareName.title = lockShareName ? adminHint : "";
    }
    if (dom.shareNameRow){
      dom.shareNameRow.classList.toggle("is-disabled", lockShareName);
      dom.shareNameRow.title = lockShareName ? adminHint : "";
    }

    if (dom.permCreate){
      dom.permCreate.disabled = lockPermUpload;
      dom.permCreate.title = lockPermUpload ? adminHint : "";
    }
    if (dom.permWrite){
      dom.permWrite.disabled = lockPermEdit;
      dom.permWrite.title = lockPermEdit ? adminHint : "";
    }
    if (dom.permDelete){
      dom.permDelete.disabled = lockPermDelete;
      dom.permDelete.title = lockPermDelete ? adminHint : "";
    }
    if (dom.permCreateRow){
      dom.permCreateRow.classList.toggle("is-disabled", lockPermUpload);
      dom.permCreateRow.title = lockPermUpload ? adminHint : "";
    }
    if (dom.permWriteRow){
      dom.permWriteRow.classList.toggle("is-disabled", lockPermEdit);
      dom.permWriteRow.title = lockPermEdit ? adminHint : "";
    }
    if (dom.permDeleteRow){
      dom.permDeleteRow.classList.toggle("is-disabled", lockPermDelete);
      dom.permDeleteRow.title = lockPermDelete ? adminHint : "";
    }

    if (dom.expireToggle){
      dom.expireToggle.disabled = lockExpireDays;
      dom.expireToggle.title = lockExpireDays ? adminHint : "";
      if (lockExpireDays){
        dom.expireToggle.checked = true;
      }
    }
    if (dom.expireDate){
      const disableDate = lockExpireDays || !dom.expireToggle.checked;
      dom.expireDate.disabled = disableDate;
      dom.expireDate.title = lockExpireDays ? adminHint : "";
    }
    if (dom.expireToggleRow){
      dom.expireToggleRow.classList.toggle("is-disabled", lockExpireDays);
      dom.expireToggleRow.title = lockExpireDays ? adminHint : "";
    }
  }

  /**
   * Switch the wizard to the given step.
   * @param {number} target
   */
  function updateStep(target){
    const previousStep = state.currentStep;
    state.currentStep = Math.max(1, Math.min(TOTAL_STEPS, target));
    if (dom.content){
      const direction = state.currentStep < previousStep ? 'back' : 'forward';
      dom.content.setAttribute('data-nav', direction);
    }
    dom.steps.forEach((section) => {
      const value = parseInt(section.dataset.step, 10);
      section.classList.toggle('active', value === state.currentStep);
    });
    if (state.currentStep === 3){
      setUploadStatus(state.uploadCompleted ? i18n('sharing_status_ready') : '');
    }else{
      setUploadStatus('');
    }
    updateButtons();
  }

  /**
   * Update navigation and action button states.
   */
  function updateButtons(){
    if (state.mode === "attachments"){
      dom.backBtn.style.visibility = 'hidden';
      dom.nextBtn.style.visibility = 'hidden';
      dom.uploadBtn.style.visibility = 'hidden';
      dom.finishBtn.style.visibility = state.currentStep === 3 ? 'visible' : 'hidden';
      dom.finishBtn.disabled = state.uploadInProgress || (!state.uploadCompleted && state.files.length === 0);
      dom.removeFileBtn.disabled = !state.selectedFileId || state.uploadInProgress;
      return;
    }
    dom.backBtn.disabled = state.currentStep === 1 || state.uploadInProgress;
    dom.nextBtn.style.visibility = state.currentStep >= TOTAL_STEPS ? 'hidden' : 'visible';
    dom.nextBtn.disabled = state.uploadInProgress
      || (state.currentStep === 1 && !getRawShareName())
      || (state.currentStep === 3 && !state.uploadCompleted && !canSkipUpload());
    dom.uploadBtn.style.visibility = state.currentStep === 3 ? 'visible' : 'hidden';
    dom.uploadBtn.disabled = state.uploadInProgress || !state.files.length || state.uploadCompleted;
    dom.finishBtn.style.visibility = state.currentStep === TOTAL_STEPS ? 'visible' : 'hidden';
    dom.finishBtn.disabled = !state.uploadCompleted || state.uploadInProgress;
    dom.removeFileBtn.disabled = !state.selectedFileId || state.uploadInProgress;
  }

  /**
   * Handle the Next button and advance the wizard.
   * @returns {Promise<void>}
   */
  async function handleNext(){
    if (state.mode === "attachments"){
      return;
    }
    if (state.uploadInProgress){
      return;
    }
    if (state.currentStep === 1){
      const ok = await ensureShareNameAvailable();
      if (!ok){
        return;
      }
    }
    if (state.currentStep === 3 && !state.uploadCompleted){
      if (canSkipUpload()){
        if (!confirmNoFileUpload()){
          return;
        }
        await startUpload({ allowEmpty: true });
        if (!state.uploadCompleted){
          return;
        }
      }else{
        return;
      }
    }
    if (state.currentStep < TOTAL_STEPS){
      updateStep(state.currentStep + 1);
    }
  }

  /**
   * Verify that the share folder name is available.
   * @returns {Promise<boolean>}
   */
  async function ensureShareNameAvailable(){
    if (state.mode === "attachments"){
      try{
        await resolveAttachmentShareName();
        return true;
      }catch(err){
        logUiError("resolve attachment share name failed", err);
        setMessage(err?.message || i18n('sharing_error_folder_exists'), 'error');
        log('Attachment shareName error', err?.message || String(err));
        return false;
      }
    }
    const shareName = getSanitizedShareName();
    if (!shareName){
      setMessage(i18n('sharing_message_invalid_share_name'), 'error');
      return false;
    }
    if (state.shareContext.verified && state.shareContext.folderInfo && state.shareContext.sanitizedName === shareName){
      return true;
    }
    setMessage(i18n('sharing_status_checking_folder'), 'info');
    try{
      const result = await NCSharing.checkShareFolderAvailability({
        shareName,
        basePath: state.basePath,
        shareDate: (state.shareContext.shareDate instanceof Date ? state.shareContext.shareDate : new Date()).toISOString()
      });
      if (result.exists){
        setMessage(i18n('sharing_error_folder_exists'), 'error');
        log('Folder already exists', shareName);
        return false;
      }
      rememberShareFolder(result.folderInfo, shareName);
      setMessage('');
      log('Folder name available', shareName);
      return true;
    }catch(err){
      logUiError("ensure share name availability failed", err);
      setMessage(err?.message || i18n('sharing_status_error'), 'error');
      log('Folder check error', err?.message);
      return false;
    }
  }

  /**
   * Handle file or folder input selections.
   * @param {Event} event
   * @param {string} source
   */
  function handleFileSelection(event, source){
    const rawInputValue = String(event?.target?.value || '');
    const selectionRootDir = extractSelectionRootDir(rawInputValue);
    const files = Array.from(event.target.files || []);
    if (!files.length){
      return;
    }
    const first = files[0];
    log('Files selected', {
      source,
      count: files.length,
      inputValueHasPath: /[\\/]/.test(rawInputValue),
      resolvedSelectionRootDir: selectionRootDir || '',
      firstHasWebkitRelativePath: !!first?.webkitRelativePath,
      firstHasMozFullPath: !!first?.mozFullPath,
      firstHasPath: !!first?.path
    });
    const entries = files.map((file) => {
      const relativePath = (file.webkitRelativePath || file.relativePath || '').replace(/\\/g, '/');
      let relativeDir = '';
      if (source === 'folder' && relativePath.includes('/')){
        relativeDir = relativePath.slice(0, relativePath.lastIndexOf('/'));
      }
      const displayPath = resolveEntryDisplayPath({
        file,
        source,
        relativeDir,
        selectionRootDir,
        fallbackName: file.name || 'File'
      });
      const displayDir = extractDisplayDir(displayPath);
      return {
        id: `entry_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file,
        displayPath,
        displayDir,
        relativeDir,
        renamedName: '',
        status: 'pending',
        progress: 0,
        error: ''
      };
    });
    state.files.push(...entries);
    pendingUploadScroll = '__bottom__';
    state.selectedFileId = null;
    event.target.value = '';
    invalidateUpload();
  }

  /**
   * Remove the currently selected file entry.
   */
  function removeSelectedEntry(){
    if (!state.selectedFileId || state.uploadInProgress){
      return;
    }
    const removed = state.files.find((entry) => entry.id === state.selectedFileId);
    state.files = state.files.filter((entry) => entry.id !== state.selectedFileId);
    state.selectedFileId = null;
    invalidateUpload();
    log('Entry removed', removed?.displayPath || '');
  }

  /**
   * Render the current file list table.
   */
  function renderFileTable(){
    dom.fileTableBody.replaceChildren();
    if (!state.files.length){
      dom.fileEmptyPlaceholder.style.display = 'block';
      ensureUploadListVisible({ targetId: '__top__', force: true });
      return;
    }
    dom.fileEmptyPlaceholder.style.display = 'none';
    state.files.forEach((entry) => {
      const row = document.createElement('tr');
      row.dataset.id = entry.id;
      if (state.selectedFileId === entry.id){
        row.classList.add('selected');
      }
      if (entry.status === 'uploading'){
        row.classList.add('uploading');
      }
      const pathCell = document.createElement('td');
      pathCell.className = 'path-cell';
      const pathScroll = document.createElement('div');
      pathScroll.className = 'path-scroll';
      pathScroll.textContent = entry.displayPath || entry.file?.name || '';
      attachPathWheelScroll(pathScroll);
      pathScroll.scrollLeft = state.pathColumnScrollLeft;
      pathCell.appendChild(pathScroll);
      const typeCell = document.createElement('td');
      typeCell.className = 'type-cell';
      typeCell.textContent = i18n('sharing_file_type_file');
      const statusCell = document.createElement('td');
      statusCell.className = 'status-cell';
      statusCell.appendChild(buildStatusNode(entry));
      row.append(pathCell, typeCell, statusCell);
      row.addEventListener('click', () => {
        state.selectedFileId = entry.id;
        renderFileTable();
        updateButtons();
      });
      dom.fileTableBody.appendChild(row);
    });
    applySharedPathColumnScroll(state.pathColumnScrollLeft);
    ensureUploadListVisible();
  }

  /**
   * Ensure the upload list scroll position matches the target.
   * @param {{targetId?:string,force?:boolean}} options
   */
  function ensureUploadListVisible({ targetId = null, force = false } = {}){
    if (!dom.fileTableWrapper){
      return;
    }
    let desiredTarget = targetId || pendingUploadScroll;
    if (!desiredTarget && force){
      desiredTarget = '__top__';
    }
    if (!force && !desiredTarget){
      return;
    }
    const wrapper = dom.fileTableWrapper;
    const tableBody = dom.fileTableBody;
    pendingUploadScroll = null;
    /**
     * Perform the actual scroll adjustment.
     */
    const scrollTask = () => {
      if (desiredTarget === '__top__'){
        wrapper.scrollTop = 0;
        return;
      }
      if (desiredTarget && desiredTarget !== '__bottom__'){
        const row = tableBody?.querySelector(`tr[data-id="${desiredTarget}"]`);
        if (row){
          row.scrollIntoView({ block: 'nearest' });
          return;
        }
      }
      wrapper.scrollTop = wrapper.scrollHeight;
    };
    if (typeof window.requestAnimationFrame === 'function'){
      window.requestAnimationFrame(scrollTask);
    }else{
      window.setTimeout(scrollTask, 0);
    }
  }

  /**
   * Build the status cell DOM for a file entry.
   * @param {object} entry
   * @returns {Node}
   */
  function buildStatusNode(entry){
    if (entry.status === 'uploading'){
      const percent = entry.progress || 0;
      const wrapper = document.createElement('div');
      wrapper.className = 'status-progress';
      const percentLabel = document.createElement('span');
      percentLabel.className = 'percent';
      percentLabel.textContent = `${percent}%`;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${percent}%`;
      bar.appendChild(fill);
      wrapper.append(percentLabel, bar);
      return wrapper;
    }
    const text = document.createElement('span');
    if (entry.status === 'done'){
      text.className = 'status-done';
      text.textContent = i18n('sharing_status_done_row');
      return text;
    }
    if (entry.status === 'error'){
      text.className = 'status-error';
      text.title = String(entry.error || '');
      text.textContent = i18n('sharing_status_error_row');
      return text;
    }
    text.textContent = i18n('sharing_status_waiting');
    return text;
  }

  /**
   * Reset upload state after changing inputs.
   */
  function invalidateUpload(){
    state.uploadCompleted = false;
    state.uploadResult = null;
    pendingUploadScroll = '__top__';
    state.files.forEach((entry) => {
      resetFileEntry(entry);
    });
    renderFileTable();
    updateButtons();
  }

  /**
   * Start uploading files and creating the share.
   * @param {{allowEmpty?:boolean}} options
   * @returns {Promise<void>}
   */
  async function startUpload({ allowEmpty = false } = {}){
    if (state.uploadInProgress){
      return;
    }
    if (!state.files.length && !allowEmpty){
      setMessage(i18n('sharing_message_no_files'), 'error');
      return;
    }
    log('Upload started', { files: state.files.length });
    if (!(await ensureShareNameAvailable())){
      log('Upload canceled: shareName unavailable');
      return;
    }
    if (!validatePasswordIfNeeded()){
      log('Upload cancelled: invalid password');
      return;
    }
    if (!(await ensureUniqueQueueEntries())){
      log('Upload canceled: local duplicates');
      return;
    }
    const hasFiles = state.files.length > 0;
    state.uploadInProgress = true;
    if (hasFiles){
      setMessage(i18n('sharing_status_uploading_bulk'), 'info');
      setUploadStatus(i18n('sharing_status_uploading_bulk'));
      state.files.forEach((entry) => {
        resetFileEntry(entry);
        entry.status = 'queued';
      });
    }else{
      setMessage(i18n('sharing_status_creating'), 'info');
      setUploadStatus('');
    }
    renderFileTable();
    updateButtons();
    const noteEnabled = state.mode === "attachments" ? false : !!dom.noteToggle.checked;
    const noteValue = noteEnabled ? dom.noteInput.value.trim() : '';
    try{
      const shareContext = getShareContext();
      if (!shareContext){
        throw new Error(i18n('sharing_message_invalid_share_name'));
      }
      if (shareContext.folderInfo){
        state.remoteFolderInfo = { ...shareContext.folderInfo };
        await armWizardRemoteCleanup({
          tabId: Number(state.tabId),
          shareLabel: shareContext.sanitizedName || "",
          shareUrl: "",
          shareId: "",
          folderInfo: state.remoteFolderInfo
        });
      }
      const permissions = getPermissions();
      log('Upload permissions', {
        mode: state.mode,
        read: !!permissions.read,
        create: !!permissions.create,
        write: !!permissions.write,
        delete: !!permissions.delete
      });
      const result = await NCSharing.createFileLink({
        shareName: shareContext.sanitizedName,
        basePath: state.basePath,
        shareDate: shareContext.shareDate.toISOString(),
        folderInfo: shareContext.folderInfo,
        policyShare: state.policy.active ? state.policy.share : null,
        permissions,
        passwordEnabled: !!dom.passwordToggle.checked,
        password: dom.passwordInput.value,
        expireEnabled: !!dom.expireToggle.checked,
        expireDate: dom.expireDate.value,
        noteEnabled,
        note: noteValue,
        files: state.files.map((entry) => ({
          id: entry.id,
          file: entry.file,
          displayPath: entry.displayPath,
          renamedName: entry.renamedName,
          relativeDir: entry.relativeDir
        })),
        onUploadStatus: handleUploadStatus
      });
      state.uploadResult = result;
      await armWizardRemoteCleanup({
        tabId: Number(state.tabId),
        shareLabel: String(result?.shareInfo?.label || shareContext.sanitizedName || ""),
        shareUrl: String(result?.shareInfo?.shareUrl || ""),
        shareId: String(result?.shareInfo?.shareId || ""),
        folderInfo: result?.shareInfo?.folderInfo || state.remoteFolderInfo || null
      });
      state.uploadCompleted = true;
      setMessage(i18n('sharing_status_ready'), 'success');
      setUploadStatus(i18n('sharing_status_ready'));
      log('Upload completed');
    }catch(err){
      logUiError("upload failed", err);
      state.uploadCompleted = false;
      setMessage(err?.message || i18n('sharing_status_error'), 'error');
      setUploadStatus(err?.message || i18n('sharing_status_error'));
      log('Upload failed', err?.message);
    }finally{
      state.uploadInProgress = false;
      renderFileTable();
      updateButtons();
    }
  }

  /**
   * Update UI state for upload progress callbacks.
   * @param {object} event
   */
  function handleUploadStatus(event){
    if (!event || !event.itemId){
      return;
    }
    const entry = state.files.find((item) => item.id === event.itemId);
    if (!entry){
      return;
    }
    if (event.phase === 'start'){
      resetFileEntry(entry);
      entry.status = 'uploading';
      log('Upload file started', entry.displayPath || entry.file?.name || entry.id);
    }else if (event.phase === 'progress'){
      entry.status = 'uploading';
      entry.progress = event.percent || 0;
    }else if (event.phase === 'done'){
      entry.status = 'done';
      entry.progress = 100;
      log('Upload file completed', entry.displayPath || entry.file?.name || entry.id);
    }else if (event.phase === 'error'){
      entry.status = 'error';
      entry.error = event.error || '';
      log('Upload file error', { name: entry.displayPath || entry.file?.name || entry.id, error: entry.error });
    }
    pendingUploadScroll = entry.id;
    renderFileTable();
  }

  /**
   * Finalize the share and insert the HTML block.
   * @returns {Promise<void>}
   */
  async function finalizeShare(){
    if (!state.uploadCompleted || !state.uploadResult?.shareInfo){
      setMessage(i18n('sharing_error_upload_required'), 'error');
      log('Finalize canceled: upload missing');
      return;
    }
    const attachmentMode = state.mode === "attachments";
    const noteEnabled = attachmentMode ? false : !!dom.noteToggle.checked;
    const note = noteEnabled ? dom.noteInput.value.trim() : '';
    const separatePasswordMail = isSeparatePasswordMailEnabled();
    log('Finalize started', {
      attachmentMode,
      noteEnabled,
      zipDownload: attachmentMode,
      hidePermissions: attachmentMode,
      separatePasswordMail
    });
    try{
      if (!attachmentMode && typeof NCSharing.updateShareDetails === 'function'){
        await NCSharing.updateShareDetails({
          shareInfo: state.uploadResult.shareInfo,
          noteEnabled,
          note
        });
        state.uploadResult.shareInfo.note = note;
        state.uploadResult.shareInfo.noteEnabled = noteEnabled;
      }
      setMessage(i18n('sharing_status_inserting'), 'info');
      const html = await NCSharing.buildHtmlBlock(state.uploadResult.shareInfo, {
        policyShare: state.policy.active ? state.policy.share : null,
        noteEnabled,
        note,
        hidePermissions: attachmentMode,
        zipDownload: attachmentMode,
        hidePassword: separatePasswordMail,
        showPasswordSeparateHint: separatePasswordMail
      });
      await armComposeShareCleanup({
        tabId: Number(state.tabId),
        shareId: state.uploadResult.shareInfo?.shareId || "",
        shareLabel: state.uploadResult.shareInfo?.label || getSanitizedShareName(),
        shareUrl: state.uploadResult.shareInfo?.shareUrl || "",
        folderInfo: state.uploadResult.shareInfo?.folderInfo || null
      });
      await insertIntoCompose(html);
      if (separatePasswordMail){
        const passwordMailHtml = await NCSharing.buildHtmlBlock(state.uploadResult.shareInfo, {
          policyShare: state.policy.active ? state.policy.share : null,
          passwordOnly: true
        });
        await registerSeparatePasswordDispatch({
          tabId: Number(state.tabId),
          shareLabel: state.uploadResult.shareInfo?.label || getSanitizedShareName(),
          shareUrl: state.uploadResult.shareInfo?.shareUrl || "",
          shareId: state.uploadResult.shareInfo?.shareId || "",
          folderInfo: state.uploadResult.shareInfo?.folderInfo || null,
          password: state.uploadResult.shareInfo?.password || "",
          html: passwordMailHtml
        });
      }
      await clearWizardRemoteCleanup();
      state.remoteFolderInfo = null;
      cleanupPageResources();
      window.close();
    }catch(err){
      logUiError("finalize share failed", err);
      setMessage(err?.message || i18n('sharing_status_error'), 'error');
      log('Share insert failed', err?.message);
    }
  }

  /**
   * Determine whether password dispatch in a separate mail is enabled.
   * @returns {boolean}
   */
  function isSeparatePasswordMailEnabled(){
    return !!dom.passwordToggle?.checked
      && isSeparatePasswordFeatureAvailable()
      && !!dom.passwordSeparateToggle?.checked
      && !!state.uploadResult?.shareInfo?.password;
  }

  /**
   * Arm server-side remote cleanup for this wizard popup window in background.
   * The cleanup is triggered when the popup window closes unless explicitly cleared.
   * @param {{tabId:number,shareId:string,shareLabel:string,shareUrl:string,folderInfo:object}} payload
   * @returns {Promise<void>}
   */
  async function armWizardRemoteCleanup(payload = {}){
    const folderInfo = payload?.folderInfo && typeof payload.folderInfo === "object"
      ? payload.folderInfo
      : null;
    if (!folderInfo || typeof folderInfo.relativeFolder !== "string" || !folderInfo.relativeFolder.trim()){
      throw new Error(i18n('sharing_error_insert_failed'));
    }
    if (!Number.isInteger(state.wizardWindowId) || state.wizardWindowId <= 0){
      state.wizardWindowId = await resolveWizardWindowId();
    }
    if (!Number.isInteger(state.wizardWindowId) || state.wizardWindowId <= 0){
      throw new Error(i18n('sharing_error_insert_failed'));
    }
    const response = await browser.runtime.sendMessage({
      type: "sharing:armWizardRemoteCleanup",
      payload: {
        windowId: state.wizardWindowId,
        tabId: Number(payload.tabId) || 0,
        shareId: String(payload.shareId || ""),
        shareLabel: String(payload.shareLabel || ""),
        shareUrl: String(payload.shareUrl || ""),
        folderInfo: {
          relativeFolder: String(folderInfo.relativeFolder || ""),
          relativeBase: String(folderInfo.relativeBase || ""),
          folderName: String(folderInfo.folderName || "")
        }
      }
    });
    if (!response?.ok){
      log('Wizard remote cleanup arm failed', {
        error: String(response?.error || ""),
        windowId: state.wizardWindowId
      });
      throw new Error(i18n('sharing_error_insert_failed'));
    }
    log('Wizard remote cleanup armed', {
      windowId: state.wizardWindowId,
      relativeFolder: String(folderInfo.relativeFolder || ""),
      shareLabel: String(payload.shareLabel || "")
    });
  }

  /**
   * Clear the armed wizard remote cleanup entry on successful finalize.
   * @returns {Promise<void>}
   */
  async function clearWizardRemoteCleanup(){
    if (!Number.isInteger(state.wizardWindowId) || state.wizardWindowId <= 0){
      state.wizardWindowId = await resolveWizardWindowId();
    }
    if (!Number.isInteger(state.wizardWindowId) || state.wizardWindowId <= 0){
      throw new Error(i18n('sharing_error_insert_failed'));
    }
    const response = await browser.runtime.sendMessage({
      type: "sharing:clearWizardRemoteCleanup",
      payload: {
        windowId: state.wizardWindowId
      }
    });
    if (!response?.ok){
      log('Wizard remote cleanup clear failed', {
        error: String(response?.error || ""),
        windowId: state.wizardWindowId
      });
      throw new Error(i18n('sharing_error_insert_failed'));
    }
    log('Wizard remote cleanup cleared', {
      windowId: state.wizardWindowId
    });
  }

  /**
   * Register compose-share cleanup in the background.
   * The share folder is removed if the compose tab is closed without successful send.
   * @param {{tabId:number,shareId:string,shareLabel:string,shareUrl:string,folderInfo:object}} payload
   * @returns {Promise<void>}
   */
  async function armComposeShareCleanup(payload = {}){
    const tabId = Number(payload.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0){
      throw new Error(i18n('sharing_error_insert_failed'));
    }
    const folderInfo = payload?.folderInfo && typeof payload.folderInfo === "object"
      ? payload.folderInfo
      : null;
    if (!folderInfo || typeof folderInfo.relativeFolder !== "string" || !folderInfo.relativeFolder.trim()){
      throw new Error(i18n('sharing_error_insert_failed'));
    }
    const response = await browser.runtime.sendMessage({
      type: "sharing:armComposeShareCleanup",
      payload: {
        tabId,
        shareId: String(payload.shareId || ""),
        shareLabel: String(payload.shareLabel || ""),
        shareUrl: String(payload.shareUrl || ""),
        folderInfo: {
          relativeFolder: String(folderInfo.relativeFolder || ""),
          relativeBase: String(folderInfo.relativeBase || ""),
          folderName: String(folderInfo.folderName || "")
        }
      }
    });
    if (!response?.ok){
      log('Compose share cleanup arm failed', {
        error: String(response?.error || "")
      });
      throw new Error(i18n('sharing_error_insert_failed'));
    }
    log('Compose share cleanup armed', {
      tabId,
      shareLabel: String(payload.shareLabel || ""),
      relativeFolder: String(folderInfo.relativeFolder || "")
    });
  }

  /**
   * Register a password-only follow-up mail dispatch in the background.
   * The background captures final recipients when the main message is sent.
   * @param {{tabId:number,shareLabel:string,shareUrl:string,shareId?:string,folderInfo?:object,password:string,html:string}} payload
   * @returns {Promise<void>}
   */
  async function registerSeparatePasswordDispatch(payload = {}){
    const tabId = Number(payload.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0){
      throw new Error("invalid_tab_id");
    }
    const password = String(payload.password || "");
    const html = String(payload.html || "");
    if (!password || !html){
      throw new Error("password_dispatch_payload_invalid");
    }
    const response = await browser.runtime.sendMessage({
      type: "sharing:registerSeparatePasswordDispatch",
      payload: {
        tabId,
        shareLabel: String(payload.shareLabel || ""),
        shareUrl: String(payload.shareUrl || ""),
        shareId: String(payload.shareId || ""),
        folderInfo: payload?.folderInfo && typeof payload.folderInfo === "object"
          ? {
            relativeFolder: String(payload.folderInfo.relativeFolder || ""),
            relativeBase: String(payload.folderInfo.relativeBase || ""),
            folderName: String(payload.folderInfo.folderName || "")
          }
          : null,
        password,
        html
      }
    });
    if (!response?.ok){
      throw new Error(response?.error || "password_dispatch_register_failed");
    }
    log('Password dispatch registered', {
      tabId,
      shareLabel: String(payload.shareLabel || "")
    });
  }

  /**
   * Collect permission flags from the UI.
   * @returns {{read:boolean,create:boolean,write:boolean,delete:boolean}}
   */
  function getPermissions(){
    if (state.mode === "attachments"){
      return {
        read: true,
        create: false,
        write: false,
        delete: false
      };
    }
    return {
      read: true,
      create: !!dom.permCreate.checked,
      write: !!dom.permWrite.checked,
      delete: !!dom.permDelete.checked
    };
  }

  /**
   * Ensure selected files are unique within the queue.
   * @returns {Promise<boolean>}
   */
  async function ensureUniqueQueueEntries(){
    const seen = new Set();
    for (const entry of state.files){
      let key = getTargetRelativePath(entry);
      while (seen.has(key)){
        if (!promptForRename(entry, 'sharing_prompt_rename_duplicate')){
          return false;
        }
        key = getTargetRelativePath(entry);
        log('Local duplicate rename', entry.displayPath);
      }
      seen.add(key);
    }
    renderFileTable();
    return true;
  }

  /**
   * Build a sanitized target path for a file entry.
   * @param {object} entry
   * @returns {string}
   */
  function getTargetRelativePath(entry){
    const sanitizedName = NCSharing.sanitizeFileName(entry.renamedName || entry.file?.name || 'File');
    const sanitizedDir = NCSharing.sanitizeRelativeDir(entry.relativeDir || '');
    return sanitizedDir ? `${sanitizedDir}/${sanitizedName}` : sanitizedName;
  }

  /**
   * Validate the password against policy when enabled.
   * @returns {boolean}
   */
  function validatePasswordIfNeeded(){
    if (!dom.passwordToggle.checked){
      return true;
    }
    const raw = dom.passwordInput.value || '';
    const pwd = raw.trim();
    const minLength = getPolicyMinLength();
    if (!pwd){
      setMessage(i18n('sharing_password_policy_error'), 'error');
      return false;
    }
    if (minLength){
      if (pwd.length < minLength){
        setMessage(i18n('sharing_password_policy_error'), 'error');
        return false;
      }
    }else if (!NCPasswordPolicyClient.isStrongPassword(pwd)){
      setMessage(i18n('sharing_password_policy_error'), 'error');
      return false;
    }
    dom.passwordInput.value = pwd;
    return true;
  }

  /**
   * Determine if upload can be skipped (create-only share).
   * @returns {boolean}
   */
  function canSkipUpload(){
    return !!dom.permCreate?.checked && state.files.length === 0;
  }

  /**
   * Confirm that the user wants to proceed without uploads.
   * @returns {boolean}
   */
  function confirmNoFileUpload(){
    const title = i18n('sharing_confirm_no_files_title') || 'Share without upload';
    const body = i18n('sharing_confirm_no_files_message') || 'No files were added. Recipients can only upload their own files. Continue?';
    return window.confirm(`${title}\n\n${body}`);
  }

  /**
   * Show a message in the wizard UI.
   * @param {string} text
   * @param {string} type
   */
  function setMessage(text, type = ''){
    dom.messageBar.textContent = text || '';
    dom.messageBar.className = `dialog-message ${type || ''}`.trim();
    log('Message', { text, type });
  }

  /**
   * Update the upload status line.
   * @param {string} text
   */
  function setUploadStatus(text){
    dom.uploadStatus.textContent = text || '';
    log('Status', text);
  }

  /**
   * Insert the generated HTML block into the compose window.
   * @param {string} html
   * @returns {Promise<void>}
   */
  async function insertIntoCompose(html){
    const tabId = state.tabId;
    if (!tabId){
      throw new Error('tabId missing');
    }
    const response = await browser.runtime.sendMessage({
      type: 'sharing:insertHtml',
      payload: { tabId, html }
    });
    if (!response?.ok){
      throw new Error(response?.error || i18n('sharing_error_insert_failed'));
    }
  }

  /**
   * Handle cancel by closing the wizard.
   * Background owns remote cleanup via the armed wizard window entry.
   * @param {Event} event
   * @returns {Promise<void>}
   */
  async function handleCancel(event){
    event?.preventDefault?.();
    log('Wizard cancel requested');
    cleanupPageResources();
    window.close();
  }

  /**
   * Read the raw share name from the input.
   * @returns {string}
   */
  function getRawShareName(){
    return (dom.shareName?.value || '').trim();
  }

  /**
   * Return the sanitized share name and update share context.
   * @returns {string}
   */
  function getSanitizedShareName(){
    const raw = getRawShareName();
    if (!raw){
      resetShareContext();
      return '';
    }
    const sanitized = NCSharing.sanitizeShareName(raw);
    if (state.shareContext.sanitizedName !== sanitized){
      state.shareContext.sanitizedName = sanitized;
      state.shareContext.folderInfo = null;
      state.shareContext.verified = false;
      state.shareContext.shareDate = new Date();
    }
    return sanitized;
  }

  /**
   * Build or return the cached share context for this run.
   * @returns {object|null}
   */
  function getShareContext(){
    const shareName = getSanitizedShareName();
    if (!shareName){
      return null;
    }
    if (!state.shareContext.folderInfo){
      const info = NCSharing.buildShareFolderInfo(state.basePath, shareName, state.shareContext.shareDate);
      rememberShareFolder(info, shareName);
    }
    return state.shareContext;
  }

  /**
   * Resolve the fixed attachment share name with collision suffixes.
   * Uses `email_attachment`, then `email_attachment_1`, `email_attachment_2`, ...
   * @returns {Promise<string>}
   */
  async function resolveAttachmentShareName(){
    const baseName = ATTACHMENT_DEFAULT_SHARE_NAME;
    const shareDate = state.shareContext.shareDate instanceof Date ? state.shareContext.shareDate : new Date();
    for (let suffix = 0; suffix < 1000; suffix++){
      const candidate = suffix === 0 ? baseName : `${baseName}_${suffix}`;
      log('Check attachment share name', { candidate, suffix });
      const result = await NCSharing.checkShareFolderAvailability({
        shareName: candidate,
        basePath: state.basePath,
        shareDate: shareDate.toISOString()
      });
      if (!result.exists){
        dom.shareName.value = candidate;
        rememberShareFolder(result.folderInfo, candidate);
        log('Attachment share name set', { candidate });
        return candidate;
      }
    }
    log('Attachment share name failed (no free variant found)');
    throw new Error(i18n('sharing_error_folder_exists'));
  }

  /**
   * Compute the default expire date as YYYY-MM-DD.
   * @returns {string}
   */
  function getDefaultExpireDate(){
    const days = NCTalkTextUtils.normalizeExpireDays(state.defaults.expireDays, DEFAULT_EXPIRE_DAYS);
    const base = new Date();
    base.setDate(base.getDate() + days);
    return base.toISOString().slice(0, 10);
  }

  /**
   * Resolve the default share name label.
   * @returns {string}
   */
  function getDefaultShareName(){
    return i18n('sharing_share_default') || 'Share name';
  }

  /**
   * Send a debug log message when enabled.
   */
  function log(){
    if (!state.debugEnabled || isPageUnloading){
      return;
    }
    const args = Array.from(arguments);
    const list = Array.isArray(args) ? args : [];
    NCDebugForwarder.forwardDebugLog({
      enabled: state.debugEnabled,
      isPageUnloading,
      source: LOG_SOURCE,
      channel: LOG_CHANNEL,
      label: LOG_LABEL,
      text: list[0],
      details: list.slice(1),
      onError: logUiError
    });
  }
  /**
   * Create a fresh share context snapshot.
   * @returns {{sanitizedName:string,folderInfo:object|null,shareDate:Date,verified:boolean}}
   */
  function createShareContext(){
    return {
      sanitizedName: '',
      folderInfo: null,
      shareDate: new Date(),
      verified: false
    };
  }

  /**
   * Reset the current share context.
   */
  function resetShareContext(){
    state.shareContext = createShareContext();
  }

  /**
   * Store the verified share folder info in state.
   * @param {object} folderInfo
   * @param {string} shareName
   */
  function rememberShareFolder(folderInfo, shareName){
    state.shareContext.folderInfo = folderInfo || null;
    if (folderInfo?.date instanceof Date){
      state.shareContext.shareDate = folderInfo.date;
    }
    if (shareName){
      state.shareContext.sanitizedName = shareName;
    }
    state.shareContext.verified = !!state.shareContext.folderInfo && !!state.shareContext.sanitizedName;
  }

  /**
   * Reset upload status for a file entry.
   * @param {object} entry
   */
  function resetFileEntry(entry){
    entry.status = 'pending';
    entry.progress = 0;
    entry.error = '';
  }

  /**
   * Apply a rename to the file entry display path.
   * @param {object} entry
   * @param {string} newName
   */
  function applyEntryRename(entry, newName){
    const clean = (newName || '').trim();
    if (!clean){
      return;
    }
    entry.renamedName = clean;
    entry.displayPath = buildDisplayPath(entry.displayDir || entry.relativeDir || '', clean);
  }

  /**
   * Normalize display paths to slash-separated strings.
   * @param {string} value
   * @returns {string}
   */
  function normalizeDisplayPath(value){
    const raw = String(value || '').trim();
    if (!raw){
      return '';
    }
    return raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  /**
   * Return the display-directory portion of a full display path.
   * @param {string} fullPath
   * @returns {string}
   */
  function extractDisplayDir(fullPath){
    const normalized = normalizeDisplayPath(fullPath);
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0){
      return '';
    }
    return normalized.slice(0, idx);
  }

  /**
   * Build one display path from directory + file name.
   * @param {string} displayDir
   * @param {string} fileName
   * @returns {string}
   */
  function buildDisplayPath(displayDir, fileName){
    const safeFileName = String(fileName || '').trim();
    const normalizedDir = normalizeDisplayPath(displayDir).replace(/\/+$/, '');
    if (!normalizedDir){
      return safeFileName;
    }
    return `${normalizedDir}/${safeFileName}`;
  }

  /**
   * Resolve the most useful display path for one file entry.
   * @param {{file:File,source:string,relativeDir?:string,fallbackName:string,providedPath?:string}} options
   * @returns {string}
   */
  function resolveEntryDisplayPath({
    file,
    source,
    relativeDir = '',
    selectionRootDir = '',
    fallbackName = '',
    providedPath = ''
  } = {}){
    const fileName = String(fallbackName || file?.name || 'File').trim() || 'File';
    if (source === 'folder'){
      return buildDisplayPath(relativeDir, fileName);
    }
    const candidates = [
      providedPath,
      file?.webkitRelativePath,
      file?.relativePath,
      file?.mozFullPath,
      file?.path
    ];
    for (const candidate of candidates){
      const normalized = normalizeDisplayPath(candidate);
      if (!normalized){
        continue;
      }
      const normalizedFileName = fileName.toLowerCase();
      const normalizedCandidate = normalized.toLowerCase();
      if (normalizedCandidate.endsWith(`/${normalizedFileName}`) || normalizedCandidate === normalizedFileName){
        return normalized;
      }
      return buildDisplayPath(normalized, fileName);
    }
    if (source === 'file'){
      const root = normalizeDisplayPath(selectionRootDir).replace(/\/+$/, '');
      if (root){
        return buildDisplayPath(root, fileName);
      }
    }
    return buildDisplayPath(relativeDir, fileName);
  }

  /**
   * Try to resolve the selected source directory from the file input value.
   * Works only if Thunderbird exposes a non-sanitized native path.
   * @param {string} inputValue
   * @returns {string}
   */
  function extractSelectionRootDir(inputValue){
    const normalized = normalizeDisplayPath(inputValue);
    if (!normalized || !normalized.includes('/')){
      return '';
    }
    if (normalized.toLowerCase().includes('/fakepath/')){
      return '';
    }
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0){
      return '';
    }
    return normalized.slice(0, idx);
  }

  /**
   * Calculate the shared horizontal scroll limit for all visible path cells.
   * @returns {number}
   */
  function getMaxPathColumnScrollLeft(){
    const nodes = dom.fileTableBody?.querySelectorAll('.path-scroll');
    if (!nodes?.length){
      return 0;
    }
    let max = 0;
    for (const node of nodes){
      const localMax = Math.max(0, (node.scrollWidth || 0) - (node.clientWidth || 0));
      if (localMax > max){
        max = localMax;
      }
    }
    return max;
  }

  /**
   * Apply one shared horizontal scroll position to the whole path column.
   * @param {number} nextScrollLeft
   */
  function applySharedPathColumnScroll(nextScrollLeft){
    const maxScrollLeft = getMaxPathColumnScrollLeft();
    const clamped = Math.min(maxScrollLeft, Math.max(0, Number(nextScrollLeft) || 0));
    state.pathColumnScrollLeft = clamped;
    const nodes = dom.fileTableBody?.querySelectorAll('.path-scroll');
    if (!nodes?.length){
      return;
    }
    for (const node of nodes){
      if (node.scrollLeft !== clamped){
        node.scrollLeft = clamped;
      }
    }
  }

  /**
   * Translate mouse-wheel movement into shared horizontal scrolling for path cells.
   * Wheel input inside the path column updates all path cells in sync.
   * @param {HTMLElement} element
   */
  function attachPathWheelScroll(element){
    if (!element){
      return;
    }
    element.addEventListener('wheel', (event) => {
      const scrollable = element.scrollWidth > element.clientWidth;
      if (!scrollable){
        return;
      }
      const delta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY;
      if (!delta){
        return;
      }
      applySharedPathColumnScroll(state.pathColumnScrollLeft + delta);
      event.preventDefault();
    }, { passive: false });
  }
  /**
   * Prompt the user to rename an entry to avoid collisions.
   * @param {object} entry
   * @param {string} messageKey
   * @returns {boolean}
   */
  function promptForRename(entry, messageKey){
    const suggestion = entry.renamedName || entry.file?.name || '';
    const renamed = prompt(i18n(messageKey, [entry.displayPath]), suggestion);
    if (!renamed){
      setMessage(i18n('sharing_message_rename_cancelled'), 'error');
      return false;
    }
    applyEntryRename(entry, renamed);
    return true;
  }
  /**
   * Setup popup resizing based on content height.
   */
  function setupWindowSizing(){
    if (!popupSizer){
      return;
    }
    popupSizer.scheduleSizeUpdate();
    window.addEventListener('load', popupSizer.scheduleSizeUpdate, { once:true });
    window.addEventListener('resize', popupSizer.scheduleSizeUpdate);
    if (typeof ResizeObserver === 'function'){
      layoutObserver = new ResizeObserver(() => popupSizer.scheduleSizeUpdate());
      layoutObserver.observe(document.documentElement || document.body);
    }
  }

  /**
   * Cleanup listeners/resources when the popup page is closed.
   */
  function cleanupPageResources(){
    if (isPageUnloading){
      return;
    }
    // Wizard remote cleanup is handled centrally in background by window removal.
    isPageUnloading = true;
    state.debugEnabled = false;
    if (popupSizer){
      window.removeEventListener('resize', popupSizer.scheduleSizeUpdate);
    }
    if (layoutObserver){
      layoutObserver.disconnect();
      layoutObserver = null;
    }
    window.removeEventListener('pagehide', cleanupPageResources, true);
    window.removeEventListener('beforeunload', cleanupPageResources, true);
    window.removeEventListener('unload', cleanupPageResources, true);
  }

  /**
   * Return the desired content height for popup sizing.
   * @returns {number}
   */
  function getContentHeight(){
    return POPUP_CONTENT_HEIGHT;
  }
})();
