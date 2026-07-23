/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(){
  'use strict';
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
  let uploadRenderTimer = null;
  const fileEntriesById = new Map();
  const fileRowsById = new Map();
  const pendingUploadRowIds = new Set();
  const TOTAL_STEPS = 4;
  const ATTACHMENT_DEFAULT_SHARE_NAME = "email_attachment";
  const LOG_SOURCE = 'nextcloudSharingWizard';
  const LOG_LABEL = 'Sharing';
  const LOG_CHANNEL = 'NCUI';
  const LOG_PREFIX = `[${LOG_CHANNEL}][${LOG_LABEL}]`;
  const SHARING_KEYS = NCSharingStorage.SHARING_KEYS;
  const POLICY_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md";
  let disposeDebugFlagMirror = null;

  function logUiError(scope, reportedError){
    globalThis.NCLogContext.safeConsoleError(LOG_PREFIX, scope, reportedError);
  }

  async function refreshPolicyStatus(){
    try{
      const response = await browser.runtime.sendMessage({
        type: "policy:getStatus"
      });
      const status = response?.ok ? (response.status || null) : null;
      const domainState = NCWizardPolicyUi.readPolicyDomain(status, "share");
      state.policy.status = status;
      state.policy.active = domainState.active;
      state.policy.share = domainState.policy;
      state.policy.editable = domainState.editable;
      state.policy.warningVisible = domainState.warningVisible;
      state.policy.warningCode = domainState.warningCode;
      log('Policy status', {
        active: state.policy.active,
        warning: state.policy.warningCode || "",
        mode: status?.mode || ""
      });
    }catch(error){
      logUiError("policy status fetch failed", error);
    }
    NCWizardPolicyUi.applyPolicyWarningUi({
      row: dom.policyWarningRow,
      textElement: dom.policyWarningText,
      warningVisible: state.policy.warningVisible,
      translate: wizardTranslate
    });
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
      passwordDeliveryMode: NCSharePasswordDelivery.MODE_PLAIN,
      expireDays: 7,
      attachmentLinkTarget: NCSharingStorage.DEFAULT_ATTACHMENT_LINK_TARGET
    },
    passwordPolicy: null,
    uploadInProgress: false,
    uploadCompleted: false,
    uploadResult: null,
    uploadPort: null,
    tabId: null,
    launchContextId: null,
    mode: 'default',
    attachmentReason: null,
    debugEnabled: false,
    wizardWindowId: 0,
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
  const wizardTranslate = (key, fallback = "") => i18n(key) || fallback || "";
  const DEFAULT_EXPIRE_DAYS = 7;
  const SHARE_DEFAULT_POLICY_BINDINGS = [
    { name: "shareName", key: "share_name_template", type: "string" },
    { name: "permCreate", key: "share_permission_upload", type: "boolean" },
    { name: "permWrite", key: "share_permission_edit", type: "boolean" },
    { name: "permDelete", key: "share_permission_delete", type: "boolean" },
    { name: "passwordEnabled", key: "share_set_password", type: "boolean" },
    { name: "passwordSeparate", key: "share_send_password_separately", type: "boolean" },
    {
      name: "passwordDeliveryMode",
      key: "share_send_password_mode",
      type: "string",
      fallback: NCSharePasswordDelivery.MODE_PLAIN,
      normalize: (value, fallback) => NCSharePasswordDelivery.coerceMode(value, fallback)
    },
    {
      name: "expireDays",
      key: "share_expire_days",
      type: "int",
      normalize: (value, fallback) => NCTalkTextUtils.normalizeExpireDays(value, fallback)
    },
    {
      name: "attachmentLinkTarget",
      key: "attachment_link_target",
      type: "string",
      fallback: NCSharingStorage.DEFAULT_ATTACHMENT_LINK_TARGET,
      lockedFallback: NCSharingStorage.DEFAULT_ATTACHMENT_LINK_TARGET,
      normalize: (value, fallback) => NCSharingStorage.normalizeAttachmentLinkTarget(value, fallback)
    }
  ];
  const emitDebugLog = typeof NCDebugForwarder?.createUiDebugLogger === 'function'
    ? NCDebugForwarder.createUiDebugLogger({
      source: LOG_SOURCE,
      channel: LOG_CHANNEL,
      label: LOG_LABEL,
      getEnabled: () => state.debugEnabled,
      getIsPageUnloading: () => isPageUnloading,
      onError: logUiError
    })
    : () => {};
  const passwordPolicyActions = NCWizardPolicyUi.createPasswordPolicyActions({
    getPolicy: () => state.passwordPolicy,
    setPolicy: (policy) => {
      state.passwordPolicy = policy;
    },
    sendMessage: (message) => browser.runtime.sendMessage(message),
    passwordGenerator: (options) => NCTalkPassword.generatePassword(options),
    logger: (message, error) => logUiError(message, error),
    logPrefix: LOG_PREFIX,
    fallbackLength: 12
  });

  // Register unload guards early so debug forwarding stops even if the window
  // closes while async init is still running.
  window.addEventListener('pagehide', cleanupPageResources, true);
  window.addEventListener('beforeunload', cleanupPageResources, true);
  window.addEventListener('unload', cleanupPageResources, true);

  document.addEventListener('DOMContentLoaded', init);

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
      await initDebugLogging();
      attachEvents();
      await refreshPolicyStatus();
      if (NCSharingStorage?.migrateLegacySharingKeys){
        await NCSharingStorage.migrateLegacySharingKeys();
      }
      try{
        await loadDefaultSettings();
      }catch(error){
        logUiError('defaults', error);
      }
      setDefaultShareName();
      await passwordPolicyActions.load();
      await applyDefaultSecuritySettings();
      try{
        await loadBasePath();
      }catch(error){
        logUiError('init', error);
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

  function setWizardReady(ready){
    if (!dom.content){
      return;
    }
    dom.content.setAttribute('data-wizard-ready', ready ? 'true' : 'false');
  }

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
    dom.passwordDeliveryModeRow = document.getElementById('passwordDeliveryModeRow');
    dom.passwordDeliveryMode = document.getElementById('passwordDeliveryMode');
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
    dom.overallUploadProgress = document.getElementById('overallUploadProgress');
    dom.overallUploadProgressBar = document.getElementById('overallUploadProgressBar');
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

  function parseTabId(){
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('tabId');
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

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
        dom.passwordInput.value = await passwordPolicyActions.generate();
      }
      invalidateUpload();
      log('password toggle', dom.passwordToggle.checked);
    });
    dom.passwordSeparateToggle?.addEventListener('change', () => {
      applyPasswordToggleState(dom.passwordToggle.checked);
      invalidateUpload();
      log('separate password toggle', dom.passwordSeparateToggle.checked);
    });
    dom.passwordDeliveryMode?.addEventListener('change', () => {
      invalidateUpload();
      log('password delivery mode changed', dom.passwordDeliveryMode.value);
    });
    dom.passwordInput.addEventListener('input', invalidateUpload);
    dom.passwordGenerate.addEventListener('click', async () => {
      dom.passwordToggle.checked = true;
      applyPasswordToggleState(true);
      dom.passwordInput.value = await passwordPolicyActions.generate();
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

  async function loadDefaultSettings(){
    state.defaults.shareName = getDefaultShareName();
    state.defaults.permCreate = false;
    state.defaults.permWrite = false;
    state.defaults.permDelete = false;
    state.defaults.passwordEnabled = true;
    state.defaults.passwordSeparate = false;
    state.defaults.passwordDeliveryMode = NCSharePasswordDelivery.MODE_PLAIN;
    state.defaults.expireDays = DEFAULT_EXPIRE_DAYS;
    state.defaults.attachmentLinkTarget = NCSharingStorage.DEFAULT_ATTACHMENT_LINK_TARGET;
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
      SHARING_KEYS.defaultPasswordDeliveryMode,
      SHARING_KEYS.defaultExpireDays,
      SHARING_KEYS.attachmentsLinkTarget
    ]);
    const localDefaultNames = new Set();
    const storedShareName = stored[SHARING_KEYS.defaultShareName];
    if (storedShareName){
      const trimmed = String(storedShareName).trim();
      if (trimmed){
        state.defaults.shareName = trimmed;
        localDefaultNames.add("shareName");
      }
    }
    if (typeof stored[SHARING_KEYS.defaultPermCreate] === 'boolean'){
      state.defaults.permCreate = stored[SHARING_KEYS.defaultPermCreate];
      localDefaultNames.add("permCreate");
    }
    if (typeof stored[SHARING_KEYS.defaultPermWrite] === 'boolean'){
      state.defaults.permWrite = stored[SHARING_KEYS.defaultPermWrite];
      localDefaultNames.add("permWrite");
    }
    if (typeof stored[SHARING_KEYS.defaultPermDelete] === 'boolean'){
      state.defaults.permDelete = stored[SHARING_KEYS.defaultPermDelete];
      localDefaultNames.add("permDelete");
    }
    if (stored[SHARING_KEYS.defaultPassword] !== undefined){
      state.defaults.passwordEnabled = !!stored[SHARING_KEYS.defaultPassword];
      localDefaultNames.add("passwordEnabled");
    }
    if (stored[SHARING_KEYS.defaultPasswordSeparate] !== undefined){
      state.defaults.passwordSeparate = !!stored[SHARING_KEYS.defaultPasswordSeparate];
      localDefaultNames.add("passwordSeparate");
    }
    if (stored[SHARING_KEYS.defaultPasswordDeliveryMode] !== undefined){
      state.defaults.passwordDeliveryMode = NCSharePasswordDelivery.coerceMode(
        stored[SHARING_KEYS.defaultPasswordDeliveryMode],
        NCSharePasswordDelivery.MODE_PLAIN
      );
      localDefaultNames.add("passwordDeliveryMode");
    }
    state.defaults.expireDays = NCTalkTextUtils.normalizeExpireDays(
      stored[SHARING_KEYS.defaultExpireDays],
      DEFAULT_EXPIRE_DAYS
    );
    if (stored[SHARING_KEYS.defaultExpireDays] !== undefined){
      localDefaultNames.add("expireDays");
    }
    if (NCSharingStorage.isValidAttachmentLinkTarget(stored[SHARING_KEYS.attachmentsLinkTarget])){
      state.defaults.attachmentLinkTarget = NCSharingStorage.normalizeAttachmentLinkTarget(
        stored[SHARING_KEYS.attachmentsLinkTarget]
      );
      localDefaultNames.add("attachmentLinkTarget");
    }
    state.defaults = NCWizardPolicyUi.readPolicyBoundDefaults(
      {
        active: state.policy.active,
        policy: state.policy.share,
        editable: state.policy.editable
      },
      SHARE_DEFAULT_POLICY_BINDINGS,
      state.defaults,
      { localNames: localDefaultNames }
    );
    if (!NCWizardPolicyUi.isSeparatePasswordFeatureAvailable(state.policy.status)){
      state.defaults.passwordSeparate = false;
    }
    if (!state.defaults.passwordSeparate || NCSharePasswordDelivery.isSecretsUnavailable(state.policy.status)){
      state.defaults.passwordDeliveryMode = NCSharePasswordDelivery.MODE_PLAIN;
    }
    log('Password delivery defaults resolved', {
      storedMode: stored[SHARING_KEYS.defaultPasswordDeliveryMode] ?? "",
      defaultMode: state.defaults.passwordDeliveryMode,
      localDefault: localDefaultNames.has("passwordDeliveryMode"),
      policyMode: NCPolicyState.readDomainValue(state.policy.share, "share_send_password_mode"),
      policyEditable: state.policy.editable?.share_send_password_mode,
      secretsUnavailable: NCSharePasswordDelivery.isSecretsUnavailable(state.policy.status),
      separateDefault: !!state.defaults.passwordSeparate
    });
    log('Attachment link target resolved', {
      storedTarget: stored[SHARING_KEYS.attachmentsLinkTarget] ?? "",
      effectiveTarget: state.defaults.attachmentLinkTarget,
      localDefault: localDefaultNames.has("attachmentLinkTarget"),
      policyTarget: NCPolicyState.readDomainValue(state.policy.share, "attachment_link_target"),
      policyEditable: state.policy.editable?.attachment_link_target
    });
  }
  /**
   * Load the configured base path and update the UI.
   * @returns {Promise<string>}
   */
  async function loadBasePath(){
    try{
      const stored = browser?.storage?.local
        ? await browser.storage.local.get([SHARING_KEYS.basePath])
        : {};
      const rawLocalBasePath = String(stored?.[SHARING_KEYS.basePath] || "").trim();
      const localBasePath = rawLocalBasePath || NCSharing.DEFAULT_BASE_PATH;
      const basePath = NCPolicyState.resolveDefaultValue(
        state.policy.status,
        "share",
        "share_base_directory",
        localBasePath,
        !!rawLocalBasePath,
        NCPolicyState.coerceString
      );
      state.basePath = basePath || '';
      if (dom.basePathLabel){
        dom.basePathLabel.textContent = state.basePath || '';
      }
    }catch(error){
      logUiError('basePath', error);
      state.basePath = NCSharing?.DEFAULT_BASE_PATH || '';
      if (dom.basePathLabel){
        dom.basePathLabel.textContent = state.basePath || '';
      }
    }
    return state.basePath;
  }

  /**
   * Mirror the debug flag into the wizard runtime.
   * @returns {Promise<boolean>}
   */
  async function initDebugLogging(){
    disposeDebugFlagMirror?.();
    disposeDebugFlagMirror = null;
    if (typeof NCDebugForwarder?.installDebugEnabledMirror !== 'function'){
      state.debugEnabled = false;
      return state.debugEnabled;
    }
    const control = await NCDebugForwarder.installDebugEnabledMirror({
      onChange: (enabled) => {
        state.debugEnabled = !!enabled;
      },
      onError: logUiError
    });
    disposeDebugFlagMirror = typeof control?.dispose === 'function'
      ? () => control.dispose()
      : null;
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
    }catch(error){
      logUiError('launch context', error);
      log('Launch context error', error?.message || String(error));
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
          error: '',
          speedKbps: 0,
          progressStartedAt: 0
        };
      });
    rebuildFileEntryIndex();
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
    dom.shareName.value = ATTACHMENT_DEFAULT_SHARE_NAME;
    resetShareContext();
    log('Attachment mode defaults set', {
      shareName: dom.shareName.value || '',
      files: state.files.length
    });
  }

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
    }catch(error){
      logUiError("attachment finish guard failed", error);
      setMessage(i18n('sharing_status_error'), 'error');
      log('Attachment finish check failed', error?.message || String(error));
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

  function applyPasswordToggleState(enabled){
    const lockPassword = NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "share_set_password",
      element: dom.passwordToggle,
      row: dom.passwordToggleRow,
      translate: wizardTranslate
    });
    const lockSeparate = NCPolicyState.isEditableLocked(state.policy.active, state.policy.editable, "share_send_password_separately");
    const lockDeliveryMode = NCPolicyState.isEditableLocked(state.policy.active, state.policy.editable, "share_send_password_mode");
    const featureUnavailable = !NCWizardPolicyUi.isSeparatePasswordFeatureAvailable(state.policy.status);
    const secretsUnavailable = NCSharePasswordDelivery.isSecretsUnavailable(state.policy.status);
    const adminHint = NCWizardPolicyUi.getAdminControlledHint(wizardTranslate);
    const separateEnabled = enabled && !featureUnavailable && !!dom.passwordSeparateToggle?.checked;
    const deliveryHint = featureUnavailable
      ? NCWizardPolicyUi.getSeparatePasswordUnavailableHint(state.policy.status, wizardTranslate)
      : (!separateEnabled
        ? (i18n("sharing_password_delivery_enable_separate_tooltip") || "")
        : (secretsUnavailable
          ? (i18n("sharing_password_delivery_unavailable_tooltip") || "")
          : (lockDeliveryMode ? adminHint : "")));
    dom.passwordFields.classList.toggle('hidden', !enabled);
    dom.passwordInput.disabled = !enabled;
    dom.passwordGenerate.disabled = !enabled;
    if (dom.passwordSeparateToggle){
      dom.passwordSeparateToggle.disabled = !enabled || lockSeparate || featureUnavailable;
      dom.passwordSeparateToggle.title = featureUnavailable
        ? NCWizardPolicyUi.getSeparatePasswordUnavailableHint(state.policy.status, wizardTranslate)
        : (lockSeparate ? adminHint : "");
      if (!enabled || featureUnavailable){
        dom.passwordSeparateToggle.checked = false;
      }
    }
    if (dom.passwordSeparateRow){
      dom.passwordSeparateRow.classList.toggle("is-disabled", !enabled || lockSeparate || featureUnavailable);
      dom.passwordSeparateRow.title = featureUnavailable
        ? NCWizardPolicyUi.getSeparatePasswordUnavailableHint(state.policy.status, wizardTranslate)
        : (lockSeparate ? adminHint : "");
    }
    if (dom.passwordDeliveryMode){
      if (secretsUnavailable){
        dom.passwordDeliveryMode.value = NCSharePasswordDelivery.MODE_PLAIN;
      }
      dom.passwordDeliveryMode.disabled = !separateEnabled || lockDeliveryMode || secretsUnavailable;
      dom.passwordDeliveryMode.title = deliveryHint;
    }
    if (dom.passwordDeliveryModeRow){
      dom.passwordDeliveryModeRow.classList.toggle("is-disabled", !separateEnabled || lockDeliveryMode || secretsUnavailable);
      dom.passwordDeliveryModeRow.title = deliveryHint;
    }
    if (!enabled){
      dom.passwordInput.value = '';
    }
  }
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
    if (dom.passwordDeliveryMode){
      dom.passwordDeliveryMode.value = NCSharePasswordDelivery.coerceMode(
        state.defaults.passwordDeliveryMode,
        NCSharePasswordDelivery.MODE_PLAIN
      );
    }
    if (enabled && !dom.passwordInput.value){
      dom.passwordInput.value = await passwordPolicyActions.generate();
    }
    dom.expireToggle.checked = true;
    dom.expireFields.classList.remove('hidden');
    dom.expireDate.value = getDefaultExpireDate();
    applyPolicyControlLocks();
    applyPasswordToggleState(enabled);
  }

  /**
   * Apply admin lock state from backend policy to editable controls.
   */
  function applyPolicyControlLocks(){
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "share_name_template",
      element: dom.shareName,
      row: dom.shareNameRow,
      translate: wizardTranslate
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "share_permission_upload",
      element: dom.permCreate,
      row: dom.permCreateRow,
      translate: wizardTranslate
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "share_permission_edit",
      element: dom.permWrite,
      row: dom.permWriteRow,
      translate: wizardTranslate
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "share_permission_delete",
      element: dom.permDelete,
      row: dom.permDeleteRow,
      translate: wizardTranslate
    });
    const lockExpireDays = NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "share_expire_days",
      element: dom.expireToggle,
      row: dom.expireToggleRow,
      translate: wizardTranslate,
      onLocked: () => {
        dom.expireToggle.checked = true;
      }
    });
    const adminHint = NCWizardPolicyUi.getAdminControlledHint(wizardTranslate);

    if (dom.expireDate){
      const disableDate = lockExpireDays || !dom.expireToggle.checked;
      dom.expireDate.disabled = disableDate;
      dom.expireDate.title = lockExpireDays ? adminHint : "";
    }
  }

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

  async function handleNext(){
    if (state.mode === "attachments"){
      return;
    }
    if (state.uploadInProgress){
      return;
    }
    if (state.currentStep === 1){
      if (!getSanitizedShareName()){
        setMessage(i18n('sharing_message_invalid_share_name'), 'error');
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
        error: '',
        speedKbps: 0,
        progressStartedAt: 0
      };
    });
    state.files.push(...entries);
    rebuildFileEntryIndex();
    pendingUploadScroll = '__bottom__';
    state.selectedFileId = null;
    event.target.value = '';
    invalidateUpload();
  }

  function removeSelectedEntry(){
    if (!state.selectedFileId || state.uploadInProgress){
      return;
    }
    const removed = state.files.find((entry) => entry.id === state.selectedFileId);
    state.files = state.files.filter((entry) => entry.id !== state.selectedFileId);
    rebuildFileEntryIndex();
    state.selectedFileId = null;
    invalidateUpload();
    log('Entry removed', removed?.displayPath || '');
  }

  function rebuildFileEntryIndex(){
    fileEntriesById.clear();
    for (const entry of state.files){
      fileEntriesById.set(entry.id, entry);
    }
  }

  function renderFileTable(){
    fileRowsById.clear();
    pendingUploadRowIds.clear();
    dom.fileTableBody.replaceChildren();
    if (!state.files.length){
      dom.fileEmptyPlaceholder.style.display = 'block';
      ensureUploadListVisible({ targetId: '__top__', force: true });
      return;
    }
    dom.fileEmptyPlaceholder.style.display = 'none';
    const rows = document.createDocumentFragment();
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
        const previousId = state.selectedFileId;
        state.selectedFileId = entry.id;
        fileRowsById.get(previousId)?.classList.remove('selected');
        row.classList.add('selected');
        updateButtons();
      });
      rows.appendChild(row);
      fileRowsById.set(entry.id, row);
    });
    dom.fileTableBody.appendChild(rows);
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

  function formatUploadSpeedKbps(kbps){
    const numeric = Number(kbps);
    const safeValue = Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
    const rounded = String(Math.round(safeValue));
    return i18n('sharing_status_speed_kbps', [rounded]);
  }

  function formatTransferSize(bytes){
    const value = Math.max(0, Number(bytes) || 0);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let scaled = value;
    let unitIndex = 0;
    while (scaled >= 1024 && unitIndex < units.length - 1){
      scaled /= 1024;
      unitIndex++;
    }
    const formatted = unitIndex === 0
      ? String(Math.round(scaled))
      : scaled.toFixed(1);
    return `${formatted} ${units[unitIndex]}`;
  }

  function formatTransferRate(bytesPerSecond){
    return `${formatTransferSize(bytesPerSecond)}/s`;
  }

  function setOverallProgress({ visible = true, indeterminate = false, percent = 0 } = {}){
    if (!dom.overallUploadProgress || !dom.overallUploadProgressBar){
      return;
    }
    dom.overallUploadProgress.hidden = !visible;
    if (!visible || indeterminate){
      dom.overallUploadProgressBar.removeAttribute('value');
      return;
    }
    dom.overallUploadProgressBar.value = Math.min(100, Math.max(0, Number(percent) || 0));
  }

  function patchUploadRow(entry){
    const row = fileRowsById.get(entry?.id);
    if (!row){
      return false;
    }
    row.classList.toggle('uploading', entry.status === 'uploading');
    const statusCell = row.querySelector('.status-cell');
    if (!statusCell){
      return false;
    }
    statusCell.replaceChildren(buildStatusNode(entry));
    return true;
  }

  function scheduleUploadRender(itemIds = [], force = false){
    for (const itemId of itemIds){
      if (itemId){
        pendingUploadRowIds.add(itemId);
      }
    }
    if (force){
      if (uploadRenderTimer){
        clearTimeout(uploadRenderTimer);
        uploadRenderTimer = null;
      }
      renderFileTable();
      return;
    }
    if (uploadRenderTimer){
      return;
    }
    uploadRenderTimer = setTimeout(() => {
      uploadRenderTimer = null;
      const ids = Array.from(pendingUploadRowIds);
      pendingUploadRowIds.clear();
      const missingRow = ids.some((itemId) =>
        !patchUploadRow(fileEntriesById.get(itemId))
      );
      if (missingRow){
        renderFileTable();
      }
    }, 100);
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
      wrapper.className = 'status-upload';
      const progressRow = document.createElement('div');
      progressRow.className = 'status-progress';
      const percentLabel = document.createElement('span');
      percentLabel.className = 'percent';
      percentLabel.textContent = `${percent}%`;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${percent}%`;
      bar.appendChild(fill);
      progressRow.append(percentLabel, bar);
      const speedLabel = document.createElement('div');
      speedLabel.className = 'status-speed';
      speedLabel.textContent = formatUploadSpeedKbps(entry.speedKbps);
      wrapper.append(progressRow, speedLabel);
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

  function invalidateUpload(){
    state.uploadCompleted = false;
    state.uploadResult = null;
    pendingUploadScroll = '__top__';
    state.files.forEach((entry) => {
      resetFileEntry(entry);
    });
    setUploadStatus('');
    setOverallProgress({ visible: false });
    renderFileTable();
    updateButtons();
  }

  /**
   * Run one FileLink job in the background runtime.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async function runBackgroundFileLinkUpload(request){
    return new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: 'nc-filelink-upload' });
      state.uploadPort = port;
      let settled = false;
      const dispose = () => {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        if (state.uploadPort === port){
          state.uploadPort = null;
        }
      };
      const complete = (callback, value) => {
        if (settled){
          return;
        }
        settled = true;
        dispose();
        try{
          port.disconnect();
        }catch(error){
          logUiError("upload port disconnect failed", error);
        }
        callback(value);
      };
      const onMessage = (message) => {
        if (message?.type === 'progress'){
          handleUploadStatus(message.event);
          return;
        }
        if (message?.type === 'result'){
          complete(resolve, message.result);
          return;
        }
        if (message?.type === 'error'){
          const error = new Error(message.error?.message || i18n('sharing_status_error'));
          error.name = message.error?.name || 'Error';
          error.status = Number(message.error?.status) || 0;
          error.code = message.error?.code || '';
          complete(reject, error);
        }
      };
      const onDisconnect = () => {
        const runtimeError = browser.runtime.lastError;
        complete(
          reject,
          new Error(runtimeError?.message || i18n('sharing_status_error'))
        );
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      try{
        port.postMessage({
          type: 'start',
          windowId: state.wizardWindowId,
          tabId: Number(state.tabId) || 0,
          request
        });
      }catch(error){
        complete(reject, error);
      }
    });
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
      setMessage('');
      setUploadStatus(i18n('sharing_status_scanning'));
      setOverallProgress({ visible: true, indeterminate: true });
      state.files.forEach((entry) => {
        resetFileEntry(entry);
        entry.status = 'queued';
      });
    }else{
      setMessage(i18n('sharing_status_creating'), 'info');
      setUploadStatus(i18n('sharing_status_creating'));
      setOverallProgress({ visible: true, indeterminate: true });
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
      const permissions = getPermissions();
      log('Upload permissions', {
        mode: state.mode,
        read: !!permissions.read,
        create: !!permissions.create,
        write: !!permissions.write,
        delete: !!permissions.delete
      });
      const result = await runBackgroundFileLinkUpload({
        shareName: shareContext.sanitizedName,
        basePath: state.basePath,
        shareDate: shareContext.shareDate.toISOString(),
        attachmentMode: state.mode === 'attachments',
        policyShare: state.policy.active ? state.policy.share : null,
        policyEditableShare: state.policy.active ? state.policy.editable : null,
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
        }))
      });
      state.uploadResult = result;
      state.uploadCompleted = true;
      setMessage(i18n('sharing_status_ready'), 'success');
      setUploadStatus(i18n('sharing_status_ready'));
      setOverallProgress({ visible: true, percent: 100 });
      log('Upload completed');
    }catch(error){
      logUiError("upload failed", error);
      state.uploadCompleted = false;
      setMessage(error?.message || i18n('sharing_status_error'), 'error');
      setUploadStatus(error?.message || i18n('sharing_status_error'));
      log('Upload failed', error?.message);
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
    if (!event){
      return;
    }
    if (event.phase === 'scanning'){
      setUploadStatus(i18n('sharing_status_scanning'));
      setOverallProgress({ visible: true, indeterminate: true });
      return;
    }
    if (event.phase === 'folders'){
      const current = Math.max(0, Number(event.current) || 0);
      const total = Math.max(0, Number(event.total) || 0);
      setUploadStatus(i18n('sharing_status_preparing_folders', [String(current), String(total)]));
      setOverallProgress({
        visible: true,
        percent: total > 0 ? Math.round((current / total) * 100) : 100
      });
      return;
    }
    if (event.phase === 'summary'){
      const completedFiles = Math.max(0, Number(event.completedFiles) || 0);
      const totalFiles = Math.max(0, Number(event.totalFiles) || 0);
      const loadedBytes = Math.max(0, Number(event.loadedBytes) || 0);
      const totalBytes = Math.max(0, Number(event.totalBytes) || 0);
      const rawPercent = totalBytes > 0
        ? Math.round((loadedBytes / totalBytes) * 100)
        : (totalFiles > 0 ? Math.round((completedFiles / totalFiles) * 100) : 100);
      const percent = completedFiles < totalFiles ? Math.min(99, rawPercent) : rawPercent;
      setUploadStatus(i18n('sharing_status_uploading_summary', [
        String(completedFiles),
        String(totalFiles),
        formatTransferSize(loadedBytes),
        formatTransferSize(totalBytes),
        formatTransferRate(event.bytesPerSecond)
      ]));
      setOverallProgress({ visible: true, percent });
      return;
    }
    if (event.phase === 'items' && Array.isArray(event.items)){
      const changedIds = [];
      for (const itemEvent of event.items){
        if (applyUploadItemStatus(itemEvent)){
          changedIds.push(itemEvent.itemId);
        }
      }
      scheduleUploadRender(changedIds);
      return;
    }
    if (applyUploadItemStatus(event)){
      scheduleUploadRender([event.itemId]);
    }
  }

  function applyUploadItemStatus(event){
    if (!event?.itemId){
      return false;
    }
    const entry = fileEntriesById.get(event.itemId);
    if (!entry){
      return false;
    }
    if (event.phase === 'start'){
      resetFileEntry(entry);
      entry.status = 'uploading';
      entry.progressStartedAt = Date.now();
    }else if (event.phase === 'progress'){
      entry.status = 'uploading';
      entry.progress = event.percent || 0;
      const loaded = Number(event.loaded) || 0;
      if (loaded > 0){
        if (!Number.isFinite(entry.progressStartedAt) || entry.progressStartedAt <= 0){
          entry.progressStartedAt = Date.now();
        }
        const elapsedSeconds = Math.max(0.001, (Date.now() - entry.progressStartedAt) / 1000);
        entry.speedKbps = loaded / 1024 / elapsedSeconds;
      }
    }else if (event.phase === 'done'){
      entry.status = 'done';
      entry.progress = 100;
      entry.speedKbps = 0;
    }else if (event.phase === 'error'){
      entry.status = 'error';
      entry.error = event.error || '';
      entry.speedKbps = 0;
      log('Upload file error', { name: entry.displayPath || entry.file?.name || entry.id, error: entry.error });
    }else{
      return false;
    }
    return true;
  }

  /**
   * Finalize the share and insert the rendered share content.
   * @returns {Promise<void>}
   */
  async function finalizeShare(){
    if (!state.uploadCompleted || !state.uploadResult?.shareInfo){
      setMessage(i18n('sharing_error_upload_required'), 'error');
      log('Finalize canceled: upload missing');
      return;
    }
    const attachmentMode = state.mode === "attachments";
    const attachmentLinkTarget = attachmentMode
      ? NCSharingStorage.normalizeAttachmentLinkTarget(state.defaults.attachmentLinkTarget)
      : NCSharingStorage.ATTACHMENT_LINK_TARGETS.SHARE_PAGE;
    const zipDownload = attachmentMode
      && NCSharingStorage.isZipDownloadLinkTarget(attachmentLinkTarget);
    const noteEnabled = attachmentMode ? false : !!dom.noteToggle.checked;
    const note = noteEnabled ? dom.noteInput.value.trim() : '';
    const separatePasswordMail = isSeparatePasswordMailEnabled();
    log('Finalize started', {
      attachmentMode,
      noteEnabled,
      attachmentLinkTarget,
      zipDownload,
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
      const renderOptions = {
        policyShare: state.policy.active ? state.policy.share : null,
        policyEditableShare: state.policy.active ? state.policy.editable : null,
        noteEnabled,
        note,
        hidePermissions: attachmentMode,
        zipDownload,
        hidePassword: separatePasswordMail,
        showPasswordSeparateHint: separatePasswordMail
      };
      const html = await NCSharing.buildHtmlBlock(state.uploadResult.shareInfo, renderOptions);
      const plainText = await NCSharing.buildPlainTextBlock(state.uploadResult.shareInfo, renderOptions);
      await armComposeShareCleanup({
        tabId: Number(state.tabId),
        shareId: state.uploadResult.shareInfo?.shareId || "",
        shareLabel: state.uploadResult.shareInfo?.label || getSanitizedShareName(),
        shareUrl: state.uploadResult.shareInfo?.shareUrl || "",
        folderInfo: state.uploadResult.shareInfo?.folderInfo || null
      });
      await insertIntoCompose(html, plainText);
      if (separatePasswordMail){
        const passwordRenderOptions = {
          policyShare: state.policy.active ? state.policy.share : null,
          policyEditableShare: state.policy.active ? state.policy.editable : null,
          passwordOnly: true
        };
        const passwordMailHtml = await NCSharing.buildHtmlBlock(state.uploadResult.shareInfo, passwordRenderOptions);
        const passwordMailPlainText = await NCSharing.buildPlainTextBlock(state.uploadResult.shareInfo, passwordRenderOptions);
        await registerSeparatePasswordDispatch({
          tabId: Number(state.tabId),
          shareLabel: state.uploadResult.shareInfo?.label || getSanitizedShareName(),
          shareUrl: state.uploadResult.shareInfo?.shareUrl || "",
          shareId: state.uploadResult.shareInfo?.shareId || "",
          folderInfo: state.uploadResult.shareInfo?.folderInfo || null,
          password: state.uploadResult.shareInfo?.password || "",
          deliveryMode: getSelectedPasswordDeliveryMode(),
          secretsExpireDays: NCSharePasswordDelivery.resolveSecretsExpireDays(state.policy.status),
          renderShareInfo: state.uploadResult.shareInfo,
          policyShare: state.policy.active ? state.policy.share : null,
          policyEditableShare: state.policy.active ? state.policy.editable : null,
          html: passwordMailHtml,
          plainText: passwordMailPlainText
        });
      }
      await clearWizardRemoteCleanup();
      await closeWizardWindow();
    }catch(error){
      logUiError("finalize share failed", error);
      setMessage(error?.message || i18n('sharing_status_error'), 'error');
      log('Share insert failed', error?.message);
    }
  }

  function isSeparatePasswordMailEnabled(){
    return !!dom.passwordToggle?.checked
      && NCWizardPolicyUi.isSeparatePasswordFeatureAvailable(state.policy.status)
      && !!dom.passwordSeparateToggle?.checked
      && !!state.uploadResult?.shareInfo?.password;
  }

  function getSelectedPasswordDeliveryMode(){
    if (!isSeparatePasswordMailEnabled()){
      log('Password delivery mode resolved', {
        mode: NCSharePasswordDelivery.MODE_PLAIN,
        reason: "separate_password_disabled",
        passwordEnabled: !!dom.passwordToggle?.checked,
        separateFeatureAvailable: NCWizardPolicyUi.isSeparatePasswordFeatureAvailable(state.policy.status),
        separateChecked: !!dom.passwordSeparateToggle?.checked,
        hasPassword: !!state.uploadResult?.shareInfo?.password
      });
      return NCSharePasswordDelivery.MODE_PLAIN;
    }
    if (NCSharePasswordDelivery.isSecretsUnavailable(state.policy.status)){
      log('Password delivery mode resolved', {
        mode: NCSharePasswordDelivery.MODE_PLAIN,
        reason: "secrets_unavailable",
        uiMode: dom.passwordDeliveryMode?.value || ""
      });
      return NCSharePasswordDelivery.MODE_PLAIN;
    }
    const mode = NCSharePasswordDelivery.coerceMode(
      dom.passwordDeliveryMode?.value,
      NCSharePasswordDelivery.MODE_PLAIN
    );
    log('Password delivery mode resolved', {
      mode,
      reason: "ui_selection",
      uiMode: dom.passwordDeliveryMode?.value || ""
    });
    return mode;
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
        wizardWindowId: Number(state.wizardWindowId) || 0,
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
   * @param {{tabId:number,shareLabel:string,shareUrl:string,shareId?:string,folderInfo?:object,password:string,deliveryMode?:string,secretsExpireDays?:number,renderShareInfo?:object,policyShare?:object,policyEditableShare?:object,html:string,plainText?:string}} payload
   * @returns {Promise<void>}
   */
  async function registerSeparatePasswordDispatch(payload = {}){
    const tabId = Number(payload.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0){
      throw new Error("invalid_tab_id");
    }
    const password = String(payload.password || "");
    const html = String(payload.html || "");
    const plainText = String(payload.plainText || "");
    if (!password || !html || !plainText){
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
        deliveryMode: NCSharePasswordDelivery.coerceMode(payload.deliveryMode, NCSharePasswordDelivery.MODE_PLAIN),
        secretsExpireDays: NCSharePasswordDelivery.clampSecretsExpireDays(payload.secretsExpireDays),
        renderShareInfo: payload?.renderShareInfo && typeof payload.renderShareInfo === "object"
          ? payload.renderShareInfo
          : null,
        policyShare: payload?.policyShare && typeof payload.policyShare === "object"
          ? payload.policyShare
          : null,
        policyEditableShare: payload?.policyEditableShare && typeof payload.policyEditableShare === "object"
          ? payload.policyEditableShare
          : null,
        html,
        plainText
      }
    });
    if (!response?.ok){
      throw new Error(response?.error || "password_dispatch_register_failed");
    }
    log('Password dispatch registered', {
      tabId,
      shareLabel: String(payload.shareLabel || ""),
      deliveryMode: NCSharePasswordDelivery.coerceMode(payload.deliveryMode, NCSharePasswordDelivery.MODE_PLAIN)
    });
  }

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
    const minLength = passwordPolicyActions.getMinLength();
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

  function confirmNoFileUpload(){
    const title = i18n('sharing_confirm_no_files_title') || 'Share without upload';
    const body = i18n('sharing_confirm_no_files_message') || 'No files were added. Recipients can only upload their own files. Continue?';
    return window.confirm(`${title}\n\n${body}`);
  }

  function setMessage(text, type = ''){
    dom.messageBar.textContent = text || '';
    dom.messageBar.className = `dialog-message ${type || ''}`.trim();
    log('Message', { text, type });
  }

  function setUploadStatus(text){
    dom.uploadStatus.textContent = text || '';
  }

  /**
   * Insert the generated share block into the compose window.
   * @param {string} html
   * @param {string} plainText
   * @returns {Promise<void>}
   */
  async function insertIntoCompose(html, plainText){
    const tabId = state.tabId;
    if (!tabId){
      throw new Error('tabId missing');
    }
    if (!html || !plainText){
      throw new Error('share_render_payload_invalid');
    }
    const response = await browser.runtime.sendMessage({
      type: 'sharing:insertRenderedBlock',
      payload: {
        tabId,
        html,
        plainText
      }
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
    await closeWizardWindow();
  }

  function getRawShareName(){
    return (dom.shareName?.value || '').trim();
  }

  function getSanitizedShareName(){
    const raw = getRawShareName();
    if (!raw){
      resetShareContext();
      return '';
    }
    const sanitized = NCSharing.sanitizeShareName(raw);
    if (state.shareContext.sanitizedName !== sanitized){
      state.shareContext.sanitizedName = sanitized;
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
    return state.shareContext;
  }

  function getDefaultExpireDate(){
    const days = NCTalkTextUtils.normalizeExpireDays(state.defaults.expireDays, DEFAULT_EXPIRE_DAYS);
    const base = new Date();
    base.setDate(base.getDate() + days);
    return base.toISOString().slice(0, 10);
  }

  function getDefaultShareName(){
    return i18n('sharing_share_default') || 'Share name';
  }

  function log(){
    const args = Array.from(arguments);
    const list = Array.isArray(args) ? args : [];
    emitDebugLog(list[0], ...list.slice(1));
  }
  function createShareContext(){
    return {
      sanitizedName: '',
      shareDate: new Date()
    };
  }

  function resetShareContext(){
    state.shareContext = createShareContext();
  }

  function resetFileEntry(entry){
    entry.status = 'pending';
    entry.progress = 0;
    entry.error = '';
    entry.speedKbps = 0;
    entry.progressStartedAt = 0;
  }

  function applyEntryRename(entry, newName){
    const clean = (newName || '').trim();
    if (!clean){
      return;
    }
    entry.renamedName = clean;
    entry.displayPath = buildDisplayPath(entry.displayDir || entry.relativeDir || '', clean);
  }

  function normalizeDisplayPath(value){
    const raw = String(value || '').trim();
    if (!raw){
      return '';
    }
    return raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  function extractDisplayDir(fullPath){
    const normalized = normalizeDisplayPath(fullPath);
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0){
      return '';
    }
    return normalized.slice(0, idx);
  }

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

  function cleanupPageResources(){
    if (isPageUnloading){
      return;
    }
    // Wizard remote cleanup is handled centrally in background by window removal.
    NCDebugForwarder.markRuntimeContextUnloading?.();
    isPageUnloading = true;
    if (state.uploadPort){
      try{
        state.uploadPort.postMessage({
          type: 'cancel',
          reason: 'wizard_unload'
        });
        state.uploadPort.disconnect();
      }catch(error){
        logUiError("upload port cancellation failed", error);
      }
      state.uploadPort = null;
    }
    if (uploadRenderTimer){
      clearTimeout(uploadRenderTimer);
      uploadRenderTimer = null;
    }
    disposeDebugFlagMirror?.();
    disposeDebugFlagMirror = null;
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
   * Flush pending debug forwards and close the popup window.
   * @returns {Promise<void>}
   */
  async function closeWizardWindow(){
    NCDebugForwarder.markRuntimeContextUnloading?.();
    cleanupPageResources();
    try{
      await NCDebugForwarder.flushPendingDebugLogs?.(120);
    }catch(error){
      logUiError("debug log flush failed", error);
    }
    window.close();
  }

  function getContentHeight(){
    return POPUP_CONTENT_HEIGHT;
  }
})();
