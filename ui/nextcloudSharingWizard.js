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
  let queueView = null;
  const fileEntriesById = new Map();
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
    shareFolderCheckInProgress: false,
    sourceSelectionInProgress: false,
    sourceSelectionPort: null,
    vfsPickerReturnFocusSeen: false,
    skipNextVfsFocusRefresh: false,
    vfsAvailability: {
      nextcloud: false,
      external: false,
      destinationRef: ''
    },
    destinationStorage: {
      status: 'idle',
      state: 'unknown',
      usage: null,
      quota: null,
      available: null,
      fetchedAt: 0,
      requestId: 0
    },
    uploadInProgress: false,
    uploadCompleted: false,
    uploadResult: null,
    uploadPort: null,
    finalizeStarted: false,
    finalizeInProgress: false,
    finalizeRetryAllowed: false,
    finalizeCloseOnly: false,
    finalized: false,
    finalizeProgress: {
      composeCleanupArmed: false,
      blockInserted: false,
      passwordDispatchRegistered: false,
      wizardCleanupCleared: false
    },
    tabId: null,
    launchContextId: null,
    launchContextAdopted: false,
    mode: 'default',
    attachmentReason: null,
    debugEnabled: false,
    wizardWindowId: 0,
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
  const SHARE_POLICY_KEYS = NCSharingStorage.SHARE_POLICY_KEYS;
  const DEFAULT_EXPIRE_DAYS = NCSharingStorage.DEFAULT_EXPIRE_DAYS;
  const SHARE_DEFAULT_POLICY_BINDINGS = [
    { name: "shareName", key: SHARE_POLICY_KEYS.shareName, type: "string" },
    { name: "permCreate", key: SHARE_POLICY_KEYS.permCreate, type: "boolean" },
    { name: "permWrite", key: SHARE_POLICY_KEYS.permWrite, type: "boolean" },
    { name: "permDelete", key: SHARE_POLICY_KEYS.permDelete, type: "boolean" },
    { name: "passwordEnabled", key: SHARE_POLICY_KEYS.passwordEnabled, type: "boolean" },
    { name: "passwordSeparate", key: SHARE_POLICY_KEYS.passwordSeparate, type: "boolean" },
    {
      name: "passwordDeliveryMode",
      key: SHARE_POLICY_KEYS.passwordDeliveryMode,
      type: "string",
      fallback: NCSharePasswordDelivery.MODE_PLAIN,
      normalize: (value, fallback) => NCSharePasswordDelivery.coerceMode(value, fallback)
    },
    {
      name: "expireDays",
      key: SHARE_POLICY_KEYS.expireDays,
      type: "int",
      normalize: (value, fallback) => NCTalkTextUtils.normalizeExpireDays(value, fallback)
    },
    {
      name: "attachmentLinkTarget",
      key: SHARE_POLICY_KEYS.attachmentLinkTarget,
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
    dom.vfsConnectionList?.setAttribute('aria-label', i18n('sharing_vfs_connection_label'));
    initializeQueueView();
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
      const launchContextLoaded = await loadLaunchContext();
      if (!launchContextLoaded){
        return;
      }
      await refreshVfsSourceAvailability();
      if (state.mode === "attachments"){
        await applyAttachmentModeDefaults();
      }else{
        setDefaultShareName();
      }
      renderFileQueue();
      updateStep(state.mode === "attachments" ? 3 : 1);
      updateAttachmentModeInfo();
      const launchContextAdopted = await adoptAttachmentLaunchContext();
      if (!launchContextAdopted){
        return;
      }
      log('Wizard initialized', {
        tabId: state.tabId,
        mode: state.mode,
        launchContextId: state.launchContextId || ""
      });
    }catch(error){
      if (!state.launchContextId || state.launchContextAdopted){
        throw error;
      }
      logUiError('attachment wizard bootstrap', error);
      await rejectAttachmentLaunchContext(
        error?.message || 'attachment_wizard_bootstrap_failed'
      );
      await closeWizardWindow();
    }finally{
      if (!isPageUnloading){
        setWizardReady(true);
        setupWindowSizing();
      }
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
    dom.localSourceAction = document.getElementById('localSourceAction');
    dom.nextcloudSourceAction = document.getElementById('nextcloudSourceAction');
    dom.externalSourceAction = document.getElementById('externalSourceAction');
    dom.localSourceSummary = dom.localSourceAction?.querySelector('summary') || null;
    dom.nextcloudSourceSummary = dom.nextcloudSourceAction?.querySelector('summary') || null;
    dom.externalSourceSummary = dom.externalSourceAction?.querySelector('summary') || null;
    dom.addNextcloudFilesBtn = document.getElementById('addNextcloudFilesBtn');
    dom.addNextcloudFolderBtn = document.getElementById('addNextcloudFolderBtn');
    dom.addExternalFilesBtn = document.getElementById('addExternalFilesBtn');
    dom.addExternalFolderBtn = document.getElementById('addExternalFolderBtn');
    dom.fileInput = document.getElementById('fileInput');
    dom.folderInput = document.getElementById('folderInput');
    dom.vfsConnectionDialog = document.getElementById('vfsConnectionDialog');
    dom.vfsConnectionList = document.getElementById('vfsConnectionList');
    dom.vfsProviderFallbackIcon = document.getElementById('vfsProviderFallbackIcon');
    dom.queueSummaryBar = document.getElementById('queueSummaryBar');
    dom.queueSummaryText = document.getElementById('queueSummaryText');
    dom.queueStorageText = document.getElementById('queueStorageText');
    dom.fileQueueTree = document.getElementById('fileQueueTree');
    dom.fileQueueWrapper = document.getElementById('fileQueueWrapper');
    dom.fileEmptyPlaceholder = document.getElementById('fileEmptyPlaceholder');
    dom.queueToggleIcon = document.getElementById('queueToggleIcon');
    dom.queueRemoveIcon = document.getElementById('queueRemoveIcon');
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

  function cloneTemplateContent(template){
    return template?.content?.firstElementChild?.cloneNode(true) || null;
  }

  function getQueueSourceIcon(source){
    const summary = source?.kind === 'nextcloud'
      ? dom.nextcloudSourceSummary
      : (source?.kind === 'external-vfs'
        ? dom.externalSourceSummary
        : dom.localSourceSummary);
    const icon = summary?.querySelector('.source-icon')?.cloneNode(true) || null;
    icon?.classList.remove('source-icon');
    return icon;
  }

  function initializeQueueView(){
    if (!globalThis.NCSharingQueueTree?.createView){
      throw new Error('sharing_queue_tree_runtime_unavailable');
    }
    queueView = NCSharingQueueTree.createView({
      container: dom.fileQueueTree,
      scrollContainer: dom.fileQueueWrapper,
      getSourceLabel: getEntrySourceLabel,
      getTargetPath: getTargetRelativePath,
      formatSize: formatTransferSize,
      buildStatusNode,
      canRemove: () => true,
      onRemove: (_node, removalTarget) => removeQueueEntry(removalTarget),
      getSourceIcon: getQueueSourceIcon,
      getToggleContent: () => cloneTemplateContent(dom.queueToggleIcon),
      getRemoveContent: () => cloneTemplateContent(dom.queueRemoveIcon),
      getSourceAriaLabel: (source) => i18n('sharing_queue_source_group', [source.label]),
      getExpandAriaLabel: (node) => i18n('sharing_queue_expand_folder', [node.label]),
      getCollapseAriaLabel: (node) => i18n('sharing_queue_collapse_folder', [node.label]),
      getRemoveAriaLabel: (node) => i18n('sharing_queue_remove_item', [node.label])
    });
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
      setMessage('');
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
      closeSourceMenus();
      log('File dialog opened');
      dom.fileInput.click();
    });
    dom.addFolderBtn.addEventListener('click', () => {
      closeSourceMenus();
      log('Folder dialog opened');
      dom.folderInput?.click();
    });
    dom.addNextcloudFilesBtn?.addEventListener('click', () => {
      closeSourceMenus();
      void startVfsSelection({ sourceKind: 'nextcloud', entryKind: 'file' });
    });
    dom.addNextcloudFolderBtn?.addEventListener('click', () => {
      closeSourceMenus();
      void startVfsSelection({ sourceKind: 'nextcloud', entryKind: 'folder' });
    });
    dom.addExternalFilesBtn?.addEventListener('click', () => {
      closeSourceMenus();
      void startVfsSelection({ sourceKind: 'external-vfs', entryKind: 'file' });
    });
    dom.addExternalFolderBtn?.addEventListener('click', () => {
      closeSourceMenus();
      void startVfsSelection({ sourceKind: 'external-vfs', entryKind: 'folder' });
    });
    [
      dom.localSourceSummary,
      dom.nextcloudSourceSummary,
      dom.externalSourceSummary
    ].forEach((summary) => {
      summary?.addEventListener('click', (event) => {
        if (summary.getAttribute('aria-disabled') === 'true'){
          event.preventDefault();
        }
      });
    });
    dom.fileInput.addEventListener('change', (event) => handleFileSelection(event, 'file'));
    dom.folderInput?.addEventListener('change', (event) => handleFileSelection(event, 'folder'));
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
    window.addEventListener('focus', handleWindowFocus);
    log('Event handlers registered');
  }

  function handleWindowFocus(){
    if (state.sourceSelectionInProgress){
      state.vfsPickerReturnFocusSeen = true;
      return;
    }
    if (state.skipNextVfsFocusRefresh){
      state.skipNextVfsFocusRefresh = false;
      return;
    }
    if (!state.uploadInProgress && !state.finalizeStarted){
      void refreshVfsSourceAvailability();
    }
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
      policyMode: NCPolicyState.readDomainValue(
        state.policy.share,
        SHARE_POLICY_KEYS.passwordDeliveryMode
      ),
      policyEditable: state.policy.editable?.[SHARE_POLICY_KEYS.passwordDeliveryMode],
      secretsUnavailable: NCSharePasswordDelivery.isSecretsUnavailable(state.policy.status),
      separateDefault: !!state.defaults.passwordSeparate
    });
    log('Attachment link target resolved', {
      storedTarget: stored[SHARING_KEYS.attachmentsLinkTarget] ?? "",
      effectiveTarget: state.defaults.attachmentLinkTarget,
      localDefault: localDefaultNames.has("attachmentLinkTarget"),
      policyTarget: NCPolicyState.readDomainValue(
        state.policy.share,
        SHARE_POLICY_KEYS.attachmentLinkTarget
      ),
      policyEditable: state.policy.editable?.[SHARE_POLICY_KEYS.attachmentLinkTarget]
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
        SHARE_POLICY_KEYS.basePath,
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
   * @returns {Promise<boolean>}
   */
  async function loadLaunchContext(){
    if (!state.launchContextId){
      log('Launch context not set (normal start)');
      return true;
    }
    try{
      log('Request launch context', { contextId: state.launchContextId });
      const response = await browser.runtime.sendMessage({
        type: "sharing:getLaunchContext",
        payload: {
          contextId: state.launchContextId,
          tabId: state.tabId,
          windowId: state.wizardWindowId
        }
      });
      if (!response?.ok || !response.context){
        throw new Error(response?.error || 'attachment_launch_context_missing');
      }
      const context = response.context;
      log('Launch context received', {
        mode: context.mode || '',
        attachmentCount: Array.isArray(context.attachments) ? context.attachments.length : 0
      });
      if (context.mode !== "attachments"){
        throw new Error('attachment_launch_context_mode_invalid');
      }
      const expectedCount = Number(context.expectedAttachmentCount);
      preloadAttachmentEntries(context.attachments, expectedCount);
      state.mode = "attachments";
      state.attachmentReason = context.reason || null;
      return true;
    }catch(error){
      logUiError('launch context', error);
      log('Launch context error', error?.message || String(error));
      await rejectAttachmentLaunchContext(error?.message || 'attachment_launch_context_invalid');
      await closeWizardWindow();
      return false;
    }
  }

  async function adoptAttachmentLaunchContext(){
    if (!state.launchContextId || state.mode !== "attachments"){
      return true;
    }
    try{
      const response = await browser.runtime.sendMessage({
        type: "sharing:adoptAttachmentLaunchContext",
        payload: {
          contextId: state.launchContextId,
          tabId: state.tabId,
          windowId: state.wizardWindowId,
          attachmentCount: state.files.length
        }
      });
      if (!response?.ok){
        throw new Error(response?.error || 'attachment_launch_context_adoption_failed');
      }
      state.launchContextAdopted = true;
      log('Attachment launch context adopted', { files: state.files.length });
      return true;
    }catch(error){
      logUiError('launch context adoption', error);
      await rejectAttachmentLaunchContext(error?.message || 'attachment_launch_context_adoption_failed');
      await closeWizardWindow();
      return false;
    }
  }

  async function rejectAttachmentLaunchContext(reason){
    if (!state.launchContextId || state.launchContextAdopted){
      return;
    }
    try{
      await browser.runtime.sendMessage({
        type: "sharing:rejectAttachmentLaunchContext",
        payload: {
          contextId: state.launchContextId,
          tabId: state.tabId,
          windowId: state.wizardWindowId,
          reason: String(reason || 'attachment_launch_context_rejected')
        }
      });
    }catch(error){
      logUiError('launch context rejection', error);
    }
  }

  /**
   * Fill the upload queue from attachment launch context.
   * @param {Array<object>} attachments
   * @param {number} expectedCount
   */
  function preloadAttachmentEntries(attachments, expectedCount){
    const list = Array.isArray(attachments) ? attachments : [];
    const validCount = list.filter((item) => item && item.file instanceof File).length;
    log('Attachment launch context preload', {
      received: list.length,
      valid: validCount
    });
    if (!Number.isInteger(expectedCount)
      || expectedCount <= 0
      || list.length !== expectedCount
      || validCount !== expectedCount){
      throw new Error('attachment_launch_context_incomplete');
    }
    state.files = list.map((item) => {
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
    if (state.files.length !== expectedCount){
      throw new Error('attachment_launch_queue_incomplete');
    }
    rebuildFileEntryIndex();
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
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: SHARE_POLICY_KEYS.passwordEnabled,
      element: dom.passwordToggle,
      row: dom.passwordToggleRow,
      translate: wizardTranslate
    });
    const lockSeparate = NCPolicyState.isEditableLocked(
      state.policy.active,
      state.policy.editable,
      SHARE_POLICY_KEYS.passwordSeparate
    );
    const lockDeliveryMode = NCPolicyState.isEditableLocked(
      state.policy.active,
      state.policy.editable,
      SHARE_POLICY_KEYS.passwordDeliveryMode
    );
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
      key: SHARE_POLICY_KEYS.shareName,
      element: dom.shareName,
      row: dom.shareNameRow,
      translate: wizardTranslate
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: SHARE_POLICY_KEYS.permCreate,
      element: dom.permCreate,
      row: dom.permCreateRow,
      translate: wizardTranslate
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: SHARE_POLICY_KEYS.permWrite,
      element: dom.permWrite,
      row: dom.permWriteRow,
      translate: wizardTranslate
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: SHARE_POLICY_KEYS.permDelete,
      element: dom.permDelete,
      row: dom.permDeleteRow,
      translate: wizardTranslate
    });
    const lockExpireDays = NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: SHARE_POLICY_KEYS.expireDays,
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
      void refreshDestinationStorageUsage();
    }else{
      setUploadStatus('');
    }
    updateButtons();
  }

  function updateButtons(){
    const busy = state.shareFolderCheckInProgress
      || state.sourceSelectionInProgress
      || state.uploadInProgress
      || state.finalizeInProgress;
    const sourceControlsDisabled = state.finalizeStarted || busy;
    queueView?.setRemovalDisabled(sourceControlsDisabled);
    [
      dom.addFilesBtn,
      dom.addFolderBtn
    ].forEach((control) => {
      if (control){
        control.disabled = sourceControlsDisabled;
      }
    });
    [dom.addNextcloudFilesBtn, dom.addNextcloudFolderBtn].forEach((control) => {
      if (control){
        control.disabled = sourceControlsDisabled || !state.vfsAvailability.nextcloud;
      }
    });
    [dom.addExternalFilesBtn, dom.addExternalFolderBtn].forEach((control) => {
      if (control){
        control.disabled = sourceControlsDisabled || !state.vfsAvailability.external;
      }
    });
    setSourceActionState({
      action: dom.localSourceAction,
      summary: dom.localSourceSummary,
      disabled: sourceControlsDisabled
    });
    setSourceActionState({
      action: dom.nextcloudSourceAction,
      summary: dom.nextcloudSourceSummary,
      disabled: sourceControlsDisabled || !state.vfsAvailability.nextcloud,
      unavailableTitle: i18n('sharing_vfs_nextcloud_unavailable_tooltip')
    });
    setSourceActionState({
      action: dom.externalSourceAction,
      summary: dom.externalSourceSummary,
      disabled: sourceControlsDisabled || !state.vfsAvailability.external,
      unavailableTitle: i18n('sharing_vfs_external_unavailable_tooltip')
    });
    if (sourceControlsDisabled){
      closeSourceMenus();
    }
    dom.cancelBtn.disabled = state.finalizeInProgress;
    const insufficientStorage = hasInsufficientDestinationStorage();
    if (state.mode === "attachments"){
      dom.backBtn.style.visibility = 'hidden';
      dom.nextBtn.style.visibility = 'hidden';
      dom.uploadBtn.style.visibility = 'hidden';
      dom.finishBtn.style.visibility = state.currentStep === 3 ? 'visible' : 'hidden';
      dom.finishBtn.disabled = busy
        || (state.finalizeStarted && !state.finalizeRetryAllowed)
        || state.finalized
        || (!state.uploadCompleted && insufficientStorage)
        || (!state.uploadCompleted && state.files.length === 0);
      setPrimaryAction(dom.finishBtn);
      return;
    }
    dom.backBtn.disabled = state.finalizeStarted || state.currentStep === 1 || busy;
    dom.nextBtn.style.visibility = state.currentStep >= TOTAL_STEPS ? 'hidden' : 'visible';
    dom.nextBtn.disabled = state.finalizeStarted
      || busy
      || (state.currentStep === 1 && !getRawShareName())
      || (state.currentStep === 3 && !state.uploadCompleted && !canSkipUpload());
    dom.uploadBtn.style.visibility = state.currentStep === 3 ? 'visible' : 'hidden';
    dom.uploadBtn.disabled = state.finalizeStarted
      || busy
      || insufficientStorage
      || !state.files.length
      || state.uploadCompleted;
    dom.finishBtn.style.visibility = state.currentStep === TOTAL_STEPS ? 'visible' : 'hidden';
    dom.finishBtn.disabled = !state.uploadCompleted
      || busy
      || (state.finalizeStarted && !state.finalizeRetryAllowed)
      || state.finalized;
    const primaryAction = state.currentStep === 3
      ? (state.uploadCompleted || !state.files.length ? dom.nextBtn : dom.uploadBtn)
      : (state.currentStep === TOTAL_STEPS ? dom.finishBtn : dom.nextBtn);
    setPrimaryAction(primaryAction);
  }

  function setPrimaryAction(primaryButton){
    [dom.backBtn, dom.nextBtn, dom.uploadBtn, dom.finishBtn].forEach((button) => {
      button?.classList.toggle('primary', button === primaryButton);
    });
  }

  function setSourceActionState({ action, summary, disabled, unavailableTitle = '' } = {}){
    const isDisabled = disabled === true;
    action?.classList.toggle('is-disabled', isDisabled);
    action?.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
    summary?.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
    if (summary){
      const availabilityBlocked = unavailableTitle
        && ((action === dom.nextcloudSourceAction && !state.vfsAvailability.nextcloud)
          || (action === dom.externalSourceAction && !state.vfsAvailability.external));
      summary.title = availabilityBlocked
        ? unavailableTitle
        : String(summary.querySelector('span')?.textContent || '').trim();
    }
    if (isDisabled && action){
      action.open = false;
    }
  }

  async function refreshVfsSourceAvailability(){
    const [nextcloudResponse, externalResponse] = await Promise.all([
      browser.runtime.sendMessage({ type: 'vfs:getStatus' }).catch((error) => {
        logUiError('Nextcloud VFS availability failed', error);
        return null;
      }),
      browser.runtime.sendMessage({ type: 'vfs:listExternalConnections' }).catch((error) => {
        logUiError('External VFS availability failed', error);
        return null;
      })
    ]);
    const nextcloudStatus = nextcloudResponse?.ok ? nextcloudResponse.status : null;
    const externalConnections = externalResponse?.ok && Array.isArray(externalResponse.connections)
      ? externalResponse.connections
      : [];
    state.vfsAvailability.nextcloud = nextcloudStatus?.accountConfigured === true
      && !!nextcloudStatus?.selfStorageRef?.providerId
      && !!nextcloudStatus?.selfStorageRef?.storageId;
    state.vfsAvailability.external = externalConnections.length > 0;
    const destinationRef = state.vfsAvailability.nextcloud
      ? `${nextcloudStatus.selfStorageRef.providerId}:${nextcloudStatus.selfStorageRef.storageId}`
      : '';
    if (state.vfsAvailability.destinationRef !== destinationRef){
      state.vfsAvailability.destinationRef = destinationRef;
      resetDestinationStorageUsage();
    }
    updateButtons();
  }

  async function handleNext(){
    if (state.mode === "attachments"){
      return;
    }
    if (state.shareFolderCheckInProgress || state.uploadInProgress){
      return;
    }
    if (state.currentStep === 1){
      if (!getSanitizedShareName()){
        setMessage(i18n('sharing_message_invalid_share_name'), 'error');
        return;
      }
      if (!(await preflightShareFolder())){
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
   * Check the exact manual share target before leaving wizard step one.
   * The upload path repeats an atomic reservation to close the race window.
   * @returns {Promise<boolean>}
   */
  async function preflightShareFolder(){
    const shareContext = getShareContext();
    if (!shareContext){
      setMessage(i18n('sharing_message_invalid_share_name'), 'error');
      return false;
    }
    const snapshot = {
      shareName: shareContext.sanitizedName,
      shareDate: shareContext.shareDate.toISOString(),
      basePath: state.basePath
    };
    state.shareFolderCheckInProgress = true;
    updateButtons();
    try{
      const response = await browser.runtime.sendMessage({
        type: "sharing:checkFolderExists",
        payload: snapshot
      });
      const currentContext = getShareContext();
      const inputUnchanged = currentContext
        && currentContext.sanitizedName === snapshot.shareName
        && currentContext.shareDate.toISOString() === snapshot.shareDate
        && state.basePath === snapshot.basePath;
      if (!inputUnchanged){
        return false;
      }
      if (!response?.ok){
        setMessage(response?.error || i18n('sharing_status_error'), 'error');
        return false;
      }
      if (response.exists){
        setMessage(i18n('sharing_error_folder_exists'), 'error');
        return false;
      }
      setMessage('');
      return true;
    }catch(error){
      logUiError("share folder preflight failed", error);
      setMessage(error?.message || i18n('sharing_status_error'), 'error');
      return false;
    }finally{
      state.shareFolderCheckInProgress = false;
      updateButtons();
    }
  }

  function closeSourceMenus(){
    if (dom.localSourceAction){
      dom.localSourceAction.open = false;
    }
    if (dom.nextcloudSourceAction){
      dom.nextcloudSourceAction.open = false;
    }
    if (dom.externalSourceAction){
      dom.externalSourceAction.open = false;
    }
  }

  async function selectExternalStorage(){
    const response = await browser.runtime.sendMessage({
      type: 'vfs:listExternalConnections'
    });
    if (!response?.ok){
      throw new Error(response?.error || i18n('sharing_vfs_external_unavailable'));
    }
    const connections = Array.isArray(response.connections) ? response.connections : [];
    if (!connections.length){
      throw new Error(i18n('sharing_vfs_external_unavailable'));
    }
    if (connections.length === 1){
      return connections[0];
    }
    if (!dom.vfsConnectionDialog || !dom.vfsConnectionList){
      throw new Error(i18n('sharing_status_error'));
    }
    dom.vfsConnectionList.replaceChildren();
    const iconUrls = [];
    let selectedConnection = null;
    connections.forEach((connection) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vfs-connection-choice';
      button.setAttribute('role', 'option');
      button.appendChild(createExternalConnectionIcon(connection, iconUrls));

      const text = document.createElement('span');
      text.className = 'vfs-connection-choice-text';
      const title = document.createElement('strong');
      title.textContent = String(
        connection?.storageName
        || connection?.label
        || connection?.providerName
        || ''
      );
      text.appendChild(title);
      const providerName = String(connection?.providerName || '').trim();
      if (providerName && providerName !== title.textContent){
        const provider = document.createElement('small');
        provider.textContent = providerName;
        text.appendChild(provider);
      }
      button.appendChild(text);
      button.addEventListener('click', () => {
        selectedConnection = connection;
        dom.vfsConnectionDialog.close('accept');
      });
      dom.vfsConnectionList.appendChild(button);
    });
    return new Promise((resolve) => {
      const onClose = () => {
        dom.vfsConnectionDialog.removeEventListener('close', onClose);
        for (const iconUrl of iconUrls){
          URL.revokeObjectURL(iconUrl);
        }
        resolve(dom.vfsConnectionDialog.returnValue === 'accept' ? selectedConnection : null);
      };
      dom.vfsConnectionDialog.addEventListener('close', onClose);
      dom.vfsConnectionDialog.showModal();
    });
  }

  function createExternalConnectionIcon(connection, iconUrls){
    const holder = document.createElement('span');
    holder.className = 'vfs-provider-icon';
    if (typeof Blob !== 'undefined' && connection?.icon instanceof Blob){
      try{
        const iconUrl = URL.createObjectURL(connection.icon);
        iconUrls.push(iconUrl);
        const image = document.createElement('img');
        image.src = iconUrl;
        image.alt = '';
        holder.appendChild(image);
        return holder;
      }catch(error){
        logUiError('VFS provider icon unavailable', error);
      }
    }
    const fallback = dom.vfsProviderFallbackIcon?.content?.firstElementChild?.cloneNode(true);
    if (fallback){
      holder.appendChild(fallback);
    }
    return holder;
  }

  function runVfsSourceSelection(request){
    return NCSharingPortRequest.run({
      portName: 'nc-vfs-source-selection',
      startMessage: { type: 'start', request },
      fallbackErrorMessage: i18n('sharing_status_error'),
      onProgress: (message) => {
        const current = Math.max(0, Number(message.current) || 0);
        setMessage(i18n('sharing_vfs_scanning_source', [String(current)]), 'info');
      },
      mapResult: (message) => message,
      mapError: (message) => new Error(message.error || i18n('sharing_status_error')),
      onPortOpened: (port) => {
        state.sourceSelectionPort = port;
      },
      onPortClosed: (port) => {
        if (state.sourceSelectionPort === port){
          state.sourceSelectionPort = null;
        }
      },
      onDisconnectError: (error) => {
        logUiError('VFS selection port disconnect failed', error);
      }
    });
  }

  function createRemoteQueueEntry(source, index){
    const sourceKind = source?.sourceKind === 'nextcloud' ? 'nextcloud' : 'external-vfs';
    const kind = source?.kind === 'folder' ? 'folder' : 'file';
    const name = String(source?.name || '').trim();
    if (!name){
      throw new Error(i18n('sharing_status_error'));
    }
    const relativeDir = String(source?.relativeDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const displayPath = normalizeDisplayPath(source?.displayPath)
      || buildDisplayPath(relativeDir, name);
    return {
      id: `entry_${Date.now()}_${index}_${Math.random().toString(36).slice(2)}`,
      sourceKind,
      sourceLabel: String(source?.sourceLabel || '').trim(),
      kind,
      name,
      file: null,
      storageRef: source?.storageRef && typeof source.storageRef === 'object'
        ? {
            providerId: String(source.storageRef.providerId || ''),
            storageId: String(source.storageRef.storageId || '')
          }
        : null,
      sourcePath: String(source?.sourcePath || ''),
      size: kind === 'file' && source?.size != null && Number.isFinite(Number(source.size))
        ? Math.max(0, Number(source.size))
        : null,
      lastModified: Math.max(0, Number(source?.lastModified) || 0),
      contentType: String(source?.contentType || 'application/octet-stream'),
      transferGroupId: String(source?.transferGroupId || ''),
      transferRole: String(source?.transferRole || 'item'),
      transferRoot: source?.transferRoot === true,
      displayPath,
      displayDir: extractDisplayDir(displayPath),
      relativeDir,
      renamedName: '',
      status: 'pending',
      progress: 0,
      error: '',
      speedKbps: 0,
      progressStartedAt: 0
    };
  }

  async function startVfsSelection({ sourceKind, entryKind } = {}){
    if (state.sourceSelectionInProgress || state.uploadInProgress || state.finalizeStarted){
      return;
    }
    state.sourceSelectionInProgress = true;
    updateButtons();
    setMessage(i18n('sharing_vfs_opening_picker'), 'info');
    try{
      let storageRef = null;
      if (sourceKind === 'external-vfs'){
        const connection = await selectExternalStorage();
        if (!connection){
          setMessage('');
          return;
        }
        storageRef = connection.storageRef || null;
      }
      state.vfsPickerReturnFocusSeen = false;
      state.skipNextVfsFocusRefresh = false;
      const result = await runVfsSourceSelection({
        sourceKind,
        entryKind,
        storageRef
      });
      // The Toolkit resolves before Thunderbird finishes removing the picker
      // actor. Its return-focus must not broadcast status requests to that actor.
      state.skipNextVfsFocusRefresh = !state.vfsPickerReturnFocusSeen;
      if (result?.cancelled){
        setMessage('');
        return;
      }
      const sources = Array.isArray(result?.entries) ? result.entries : [];
      if (!sources.length){
        setMessage('');
        return;
      }
      const entries = sources.map((source, index) => createRemoteQueueEntry(source, index));
      state.files.push(...entries);
      rebuildFileEntryIndex();
      pendingUploadScroll = '__bottom__';
      invalidateUpload();
      setMessage('');
      log('VFS source selection completed', {
        sourceKind,
        entryKind,
        entries: entries.length
      });
    }catch(error){
      logUiError('VFS source selection failed', error);
      setMessage(error?.message || i18n('sharing_status_error'), 'error');
    }finally{
      state.sourceSelectionInProgress = false;
      updateButtons();
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
    // Local folder grouping is presentation-only. VFS transfer groups carry
    // copy semantics in the background and must not be reused for local files.
    const queueGroupId = source === 'folder'
      ? `local-folder-${Date.now()}-${Math.random().toString(36).slice(2)}`
      : '';
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
        sourceKind: 'local',
        sourceLabel: '',
        kind: 'file',
        name: file.name || 'File',
        file,
        displayPath,
        displayDir,
        relativeDir,
        queueGroupId,
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
    event.target.value = '';
    invalidateUpload();
  }

  function removeQueueEntry(removalTarget){
    if (state.sourceSelectionInProgress || state.uploadInProgress || state.finalizeStarted){
      return;
    }
    const kind = String(removalTarget?.kind || '');
    const entryId = String(removalTarget?.entryId || '');
    const groupId = String(removalTarget?.groupId || '');
    const belongsToGroup = (entry) =>
      String(entry?.queueGroupId || entry?.transferGroupId || '') === groupId;
    const removed = kind === 'group'
      ? state.files.filter(belongsToGroup)
      : state.files.filter((entry) => entry.id === entryId);
    if (!removed.length){
      return;
    }
    state.files = kind === 'group'
      ? state.files.filter((entry) => !belongsToGroup(entry))
      : state.files.filter((entry) => entry.id !== entryId);
    rebuildFileEntryIndex();
    invalidateUpload();
    log('Queue selection removed', {
      entries: removed.length,
      path: removed[0]?.displayPath || removed[0]?.name || ''
    });
  }

  function rebuildFileEntryIndex(){
    fileEntriesById.clear();
    for (const entry of state.files){
      fileEntriesById.set(entry.id, entry);
    }
  }

  function renderFileQueue(){
    pendingUploadRowIds.clear();
    const model = queueView.render(state.files);
    if (!state.files.length){
      dom.fileEmptyPlaceholder.style.display = 'block';
      dom.fileQueueTree.hidden = true;
      renderQueueSummary(model);
      ensureUploadListVisible({ targetId: '__top__', force: true });
      return;
    }
    dom.fileEmptyPlaceholder.style.display = 'none';
    dom.fileQueueTree.hidden = false;
    renderQueueSummary(model);
    ensureUploadListVisible();
  }

  function getEntrySourceLabel(entry){
    if (entry?.sourceKind === 'nextcloud'){
      return i18n('sharing_source_nextcloud');
    }
    if (entry?.sourceKind === 'external-vfs'){
      return String(entry.sourceLabel || i18n('sharing_source_external'));
    }
    return i18n('sharing_source_local');
  }

  function getQueueSummary(model = queueView?.getModel()){
    return NCSharingQueueTree.summarize(model || NCSharingQueueTree.buildModel([], {}));
  }

  function setQueueStorageSummary(text, displayState){
    dom.queueStorageText.textContent = text;
    dom.queueStorageText.title = text;
    dom.queueStorageText.dataset.state = displayState;
  }

  function renderQueueSummary(model = queueView?.getModel()){
    if (!dom.queueSummaryText || !dom.queueStorageText){
      return;
    }
    const summary = getQueueSummary(model);
    const sizeValue = summary.hasUnknownSize
      ? (summary.knownFileBytes > 0
        ? `≥ ${formatTransferSize(summary.knownFileBytes)}`
        : i18n('sharing_queue_size_unknown'))
      : formatTransferSize(summary.knownFileBytes);
    dom.queueSummaryText.textContent = [
      i18n('sharing_queue_entries_summary', [String(summary.entryCount)]),
      i18n('sharing_queue_sources_summary', [String(summary.sourceCount)]),
      i18n('sharing_queue_total_summary', [sizeValue])
    ].join(' · ');

    const destination = state.destinationStorage;
    if (!state.vfsAvailability.destinationRef){
      setQueueStorageSummary(i18n('sharing_queue_storage_unknown'), 'unknown');
      return;
    }
    if (destination.status === 'idle' || destination.status === 'loading'){
      setQueueStorageSummary(i18n('sharing_queue_storage_loading'), 'loading');
      return;
    }
    if (destination.state === 'unlimited'){
      setQueueStorageSummary(i18n('sharing_queue_storage_unlimited'), 'unlimited');
      return;
    }
    if (destination.state !== 'finite'){
      setQueueStorageSummary(i18n('sharing_queue_storage_unknown'), 'unknown');
      return;
    }
    if (NCSharingQueueTree.evaluateCapacity(summary, destination).blocked){
      setQueueStorageSummary(i18n('sharing_queue_storage_insufficient', [
        formatTransferSize(summary.knownFileBytes),
        formatTransferSize(destination.available)
      ]), 'insufficient');
      return;
    }
    setQueueStorageSummary(i18n('sharing_queue_storage_available', [
      formatTransferSize(destination.available),
      formatTransferSize(destination.quota)
    ]), 'finite');
  }

  function hasInsufficientDestinationStorage(){
    return NCSharingQueueTree.evaluateCapacity(
      getQueueSummary(),
      state.destinationStorage
    ).blocked;
  }

  function resetDestinationStorageUsage(){
    state.destinationStorage.requestId++;
    state.destinationStorage.status = 'idle';
    state.destinationStorage.state = 'unknown';
    state.destinationStorage.usage = null;
    state.destinationStorage.quota = null;
    state.destinationStorage.available = null;
    state.destinationStorage.fetchedAt = 0;
    renderQueueSummary();
  }

  async function refreshDestinationStorageUsage({ force = false } = {}){
    const destination = state.destinationStorage;
    if (!state.vfsAvailability.destinationRef){
      resetDestinationStorageUsage();
      return;
    }
    const fresh = destination.fetchedAt > 0
      && Date.now() - destination.fetchedAt < 5 * 60 * 1000;
    if (destination.status === 'loading' || (!force && fresh)){
      return;
    }
    const requestId = ++destination.requestId;
    destination.status = 'loading';
    renderQueueSummary();
    try{
      const response = await browser.runtime.sendMessage({
        type: 'sharing:getDestinationStorageUsage'
      });
      if (requestId !== destination.requestId){
        return;
      }
      const usage = response?.ok ? response.usage : null;
      const usageState = String(usage?.state || 'unknown');
      if (usageState === 'finite'
        && Number.isFinite(usage?.usage)
        && Number.isFinite(usage?.quota)
        && Number.isFinite(usage?.available)
        && usage.usage >= 0
        && usage.quota >= 0
        && usage.available >= 0){
        destination.state = 'finite';
        destination.usage = usage.usage;
        destination.quota = usage.quota;
        destination.available = usage.available;
      }else if (usageState === 'unlimited' && Number.isFinite(usage?.usage)){
        destination.state = 'unlimited';
        destination.usage = Math.max(0, usage.usage);
        destination.quota = null;
        destination.available = null;
      }else{
        destination.state = 'unknown';
        destination.usage = Number.isFinite(usage?.usage) ? Math.max(0, usage.usage) : null;
        destination.quota = null;
        destination.available = null;
      }
      destination.status = 'ready';
      destination.fetchedAt = Date.now();
    }catch(error){
      if (requestId !== destination.requestId){
        return;
      }
      destination.status = 'ready';
      destination.state = 'unknown';
      destination.usage = null;
      destination.quota = null;
      destination.available = null;
      destination.fetchedAt = Date.now();
      log('Destination storage usage unavailable', {
        reason: error?.message || String(error)
      });
    }finally{
      if (requestId === destination.requestId){
        renderQueueSummary();
        updateButtons();
      }
    }
  }

  /**
   * Ensure the upload list scroll position matches the target.
   * @param {{targetId?:string,force?:boolean}} options
   */
  function ensureUploadListVisible({ targetId = null, force = false } = {}){
    if (!queueView){
      return;
    }
    let desiredTarget = targetId || pendingUploadScroll;
    if (!desiredTarget && force){
      desiredTarget = '__top__';
    }
    if (!force && !desiredTarget){
      return;
    }
    pendingUploadScroll = null;
    queueView.scrollTo(desiredTarget);
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
    return queueView?.patchEntry(entry) === true;
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
      renderFileQueue();
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
        renderFileQueue();
      }
    }, 100);
  }

  /**
   * Build the status cell DOM for a file entry.
   * @param {object} entry
   * @returns {Node}
   */
  function buildStatusNode(entry){
    if (entry.status === 'fetching'){
      const text = document.createElement('span');
      const percent = Math.min(100, Math.max(0, Number(entry.progress) || 0));
      text.textContent = `${i18n('sharing_status_fetching_source')} ${percent}%`;
      return text;
    }
    if (entry.status === 'copying'){
      const text = document.createElement('span');
      text.textContent = i18n('sharing_status_copying_source');
      return text;
    }
    if (entry.status === 'preparing'){
      const text = document.createElement('span');
      text.textContent = i18n('sharing_status_preparing_source');
      return text;
    }
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
    renderFileQueue();
    updateButtons();
  }

  /**
   * Run one FileLink job in the background runtime.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async function runBackgroundFileLinkUpload(request){
    return NCSharingPortRequest.run({
      portName: 'nc-filelink-upload',
      startMessage: {
        type: 'start',
        windowId: state.wizardWindowId,
        tabId: Number(state.tabId) || 0,
        request
      },
      fallbackErrorMessage: i18n('sharing_status_error'),
      onProgress: (message) => handleUploadStatus(message.event),
      mapResult: (message) => message.result,
      mapError: (message) => {
        const error = new Error(message.error?.message || i18n('sharing_status_error'));
        error.name = message.error?.name || 'Error';
        error.status = Number(message.error?.status) || 0;
        error.code = message.error?.code || '';
        return error;
      },
      onPortOpened: (port) => {
        state.uploadPort = port;
      },
      onPortClosed: (port) => {
        if (state.uploadPort === port){
          state.uploadPort = null;
        }
      },
      onDisconnectError: (error) => {
        logUiError("upload port disconnect failed", error);
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
    if (hasInsufficientDestinationStorage()){
      setMessage(i18n('sharing_insufficient_storage'), 'error');
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
    renderFileQueue();
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
        permissions,
        passwordEnabled: !!dom.passwordToggle.checked,
        password: dom.passwordInput.value,
        expireEnabled: !!dom.expireToggle.checked,
        expireDate: dom.expireDate.value,
        noteEnabled,
        note: noteValue,
        files: state.files.map((entry) => ({
          id: entry.id,
          sourceKind: entry.sourceKind || 'local',
          sourceLabel: entry.sourceLabel || '',
          kind: entry.kind || 'file',
          name: entry.name || entry.file?.name || 'File',
          file: entry.file,
          storageRef: entry.storageRef || null,
          sourcePath: entry.sourcePath || '',
          size: entry.sourceKind === 'local'
            ? (Number(entry.file?.size) || 0)
            : entry.size,
          lastModified: Number(entry.lastModified ?? entry.file?.lastModified) || 0,
          contentType: entry.contentType || entry.file?.type || 'application/octet-stream',
          transferGroupId: entry.transferGroupId || '',
          transferRole: entry.transferRole || 'item',
          transferRoot: entry.transferRoot === true,
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
      renderFileQueue();
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
    if (event.phase === 'checksums'){
      const current = Math.max(0, Number(event.current) || 0);
      const total = Math.max(0, Number(event.total) || 0);
      setUploadStatus(i18n('sharing_status_calculating_checksums', [
        String(current),
        String(total)
      ]));
      setOverallProgress({
        visible: true,
        percent: total > 0 ? Math.round((current / total) * 100) : 100
      });
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
    if (event.phase === 'source_transfer'){
      const current = Math.max(0, Number(event.current) || 0);
      const total = Math.max(0, Number(event.total) || 0);
      const displayCurrent = total > 0 && current < total ? current + 1 : current;
      const key = event.mode === 'copy'
        ? 'sharing_status_copying_sources'
        : 'sharing_status_fetching_sources';
      setUploadStatus(i18n(key, [String(displayCurrent), String(total)]));
      setOverallProgress({ visible: true, indeterminate: true });
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
    if (event.phase === 'source_fetch'){
      if (entry.status !== 'fetching'){
        resetFileEntry(entry);
      }
      entry.status = 'fetching';
      entry.progress = Math.min(100, Math.max(0, Number(event.percent) || 0));
    }else if (event.phase === 'source_copy'){
      resetFileEntry(entry);
      entry.status = 'copying';
    }else if (event.phase === 'source_prepare'){
      resetFileEntry(entry);
      entry.status = 'preparing';
    }else if (event.phase === 'start'){
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
      log('Upload file error', { name: entry.displayPath || entry.name || entry.file?.name || entry.id, error: entry.error });
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
    if (state.finalized || state.finalizeInProgress){
      log('Finalize ignored', {
        finalized: state.finalized,
        inProgress: state.finalizeInProgress
      });
      return;
    }
    if (!state.uploadCompleted || !state.uploadResult?.shareInfo){
      setMessage(i18n('sharing_error_upload_required'), 'error');
      log('Finalize canceled: upload missing');
      return;
    }
    state.finalizeStarted = true;
    state.finalizeInProgress = true;
    state.finalizeRetryAllowed = false;
    state.finalizeCloseOnly = false;
    lockFinalizeInputs();
    updateButtons();
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
      let html = "";
      let plainText = "";
      let passwordMailHtml = "";
      let passwordMailPlainText = "";
      if (!state.finalizeProgress.blockInserted){
        html = await NCSharing.buildHtmlBlock(state.uploadResult.shareInfo, renderOptions);
        plainText = await NCSharing.buildPlainTextBlock(state.uploadResult.shareInfo, renderOptions);
      }
      if (separatePasswordMail && !state.finalizeProgress.passwordDispatchRegistered){
        const passwordRenderOptions = {
          policyShare: state.policy.active ? state.policy.share : null,
          policyEditableShare: state.policy.active ? state.policy.editable : null,
          passwordOnly: true
        };
        passwordMailHtml = await NCSharing.buildHtmlBlock(
          state.uploadResult.shareInfo,
          passwordRenderOptions
        );
        passwordMailPlainText = await NCSharing.buildPlainTextBlock(
          state.uploadResult.shareInfo,
          passwordRenderOptions
        );
      }
      if (!state.finalizeProgress.blockInserted){
        await finalizeRenderedShare({
          tabId: Number(state.tabId),
          html,
          plainText,
          cleanup: {
            shareId: state.uploadResult.shareInfo?.shareId || "",
            shareLabel: state.uploadResult.shareInfo?.label || getSanitizedShareName(),
            shareUrl: state.uploadResult.shareInfo?.shareUrl || "",
            folderInfo: state.uploadResult.shareInfo?.folderInfo || null
          },
          shareNote: {
            noteEnabled,
            note
          },
          passwordDispatch: separatePasswordMail
            ? {
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
            }
            : null
        });
        state.finalizeProgress.composeCleanupArmed = true;
        state.finalizeProgress.passwordDispatchRegistered = true;
        state.finalizeProgress.blockInserted = true;
        state.finalizeProgress.wizardCleanupCleared = true;
      }
      state.finalized = true;
      await closeWizardWindow();
    }catch(error){
      logUiError("finalize share failed", error);
      if (error?.canRetry === true){
        state.finalizeRetryAllowed = true;
        setMessage(i18n('sharing_error_insert_failed'), 'error');
      }else{
        state.finalizeRetryAllowed = false;
        state.finalizeCloseOnly = true;
        setMessage(
          i18n('sharing_error_insert_failed_close')
            || i18n('sharing_error_insert_failed'),
          'error'
        );
      }
      log('Share insert failed', {
        canRetry: error?.canRetry === true
      });
    }finally{
      state.finalizeInProgress = false;
      updateButtons();
    }
  }

  function lockFinalizeInputs(){
    setFinalizeInputsDisabled(true);
  }

  function setFinalizeInputsDisabled(disabled){
    const controls = [
      dom.shareName,
      dom.permCreate,
      dom.permWrite,
      dom.permDelete,
      dom.passwordToggle,
      dom.passwordSeparateToggle,
      dom.passwordDeliveryMode,
      dom.passwordInput,
      dom.passwordGenerate,
      dom.expireToggle,
      dom.expireDate,
      dom.noteToggle,
      dom.noteInput,
      dom.addFilesBtn,
      dom.addFolderBtn,
      dom.addNextcloudFilesBtn,
      dom.addNextcloudFolderBtn,
      dom.addExternalFilesBtn,
      dom.addExternalFolderBtn,
      dom.fileInput,
      dom.folderInput
    ];
    for (const control of controls){
      if (control){
        control.disabled = !!disabled;
      }
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

  async function finalizeRenderedShare(payload = {}){
    if (!Number.isInteger(state.wizardWindowId) || state.wizardWindowId <= 0){
      state.wizardWindowId = await resolveWizardWindowId();
    }
    const tabId = Number(payload.tabId);
    const folderInfo = payload?.cleanup?.folderInfo;
    if (!Number.isInteger(tabId)
      || tabId <= 0
      || !Number.isInteger(state.wizardWindowId)
      || state.wizardWindowId <= 0
      || !folderInfo?.relativeFolder
      || !String(payload.html || "").trim()
      || !String(payload.plainText || "").trim()){
      throw new Error(i18n('sharing_error_insert_failed'));
    }
    const response = await browser.runtime.sendMessage({
      type: "sharing:finalizeRenderedShare",
      payload: {
        tabId,
        wizardWindowId: state.wizardWindowId,
        html: String(payload.html || ""),
        plainText: String(payload.plainText || ""),
        cleanup: {
          shareId: String(payload.cleanup.shareId || ""),
          shareLabel: String(payload.cleanup.shareLabel || ""),
          shareUrl: String(payload.cleanup.shareUrl || ""),
          folderInfo: {
            relativeFolder: String(folderInfo.relativeFolder || ""),
            relativeBase: String(folderInfo.relativeBase || ""),
            folderName: String(folderInfo.folderName || "")
          }
        },
        shareNote: {
          noteEnabled: payload.shareNote?.noteEnabled === true,
          note: String(payload.shareNote?.note || "")
        },
        passwordDispatch: payload.passwordDispatch || null
      }
    });
    if (!response?.ok){
      const finalizeError = new Error(i18n('sharing_error_insert_failed'));
      finalizeError.canRetry = response?.canRetry === true;
      throw finalizeError;
    }
    log('Share finalize committed', {
      tabId,
      windowId: state.wizardWindowId,
      draftGroupId: String(response.draftGroupId || ""),
      passwordDispatchDuplicate: response.passwordDispatchDuplicate === true
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
    while (true){
      const conflict = findQueuePathConflict();
      if (!conflict){
        break;
      }
      if (conflict.type === 'exact'){
        if (!promptForRename(
          getCollisionRenameTarget(conflict.duplicateEntry),
          'sharing_prompt_rename_duplicate'
        )){
          return false;
        }
        log('Local duplicate rename', conflict.path);
        continue;
      }
      if (!promptForRename(
        getCollisionRenameTarget(conflict.fileEntry),
        'sharing_prompt_rename_file_directory_conflict'
      )){
        return false;
      }
      log('Local file-directory conflict rename', {
        filePath: conflict.filePath,
        nestedPath: conflict.nestedPath
      });
    }
    renderFileQueue();
    return true;
  }

  function findQueuePathConflict(){
    const entries = state.files.map((entry) => ({
      entry,
      path: getTargetRelativePath(entry),
      kind: entry.kind || 'file'
    }));
    if (!globalThis.NCFileQueuePathConflicts?.find){
      throw new Error("file_queue_path_conflict_runtime_unavailable");
    }
    return NCFileQueuePathConflicts.find(entries);
  }

  /**
   * Build a sanitized target path for a file entry.
   * @param {object} entry
   * @returns {string}
   */
  function getTargetRelativePath(entry){
    const sanitizedName = NCSharing.sanitizeFileName(
      entry.renamedName || entry.name || entry.file?.name || 'File'
    );
    const sanitizedDir = NCSharing.sanitizeRelativeDir(entry.relativeDir || '');
    return sanitizedDir ? `${sanitizedDir}/${sanitizedName}` : sanitizedName;
  }

  function getCollisionRenameTarget(entry){
    if (entry?.sourceKind !== 'nextcloud'
      || !entry.transferGroupId
      || entry.transferRoot){
      return entry;
    }
    return state.files.find((candidate) =>
      candidate.transferGroupId === entry.transferGroupId && candidate.transferRoot
    ) || entry;
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
   * Handle cancel by closing the wizard.
   * Background owns remote cleanup via the armed wizard window entry.
   * @param {Event} event
   * @returns {Promise<void>}
   */
  async function handleCancel(event){
    event?.preventDefault?.();
    if (state.finalizeInProgress){
      log('Wizard cancel ignored during finalize');
      return;
    }
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
    if (entry.kind === 'folder' && entry.transferGroupId){
      const oldRoot = normalizeDisplayPath(entry.displayPath);
      const newRoot = buildDisplayPath(entry.displayDir || entry.relativeDir || '', clean);
      for (const member of state.files){
        if (member.transferGroupId !== entry.transferGroupId){
          continue;
        }
        const currentPath = normalizeDisplayPath(member.displayPath);
        if (member === entry){
          member.renamedName = clean;
          member.displayPath = newRoot;
          member.displayDir = extractDisplayDir(newRoot);
          continue;
        }
        if (!oldRoot || !currentPath.startsWith(`${oldRoot}/`)){
          continue;
        }
        const updatedPath = `${newRoot}${currentPath.slice(oldRoot.length)}`;
        member.displayPath = updatedPath;
        member.displayDir = extractDisplayDir(updatedPath);
        member.relativeDir = member.displayDir;
      }
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

  /**
   * Prompt the user to rename an entry to avoid collisions.
   * @param {object} entry
   * @param {string} messageKey
   * @returns {boolean}
   */
  function promptForRename(entry, messageKey){
    const suggestion = entry.renamedName || entry.name || entry.file?.name || '';
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
      NCSharingPortRequest.cancel(state.uploadPort, {
        reason: 'wizard_unload',
        onError: (error) => logUiError("upload port cancellation failed", error)
      });
      state.uploadPort = null;
    }
    if (state.sourceSelectionPort){
      NCSharingPortRequest.cancel(state.sourceSelectionPort, {
        reason: 'wizard_unload',
        onError: (error) => logUiError('VFS selection cancellation failed', error)
      });
      state.sourceSelectionPort = null;
    }
    if (uploadRenderTimer){
      clearTimeout(uploadRenderTimer);
      uploadRenderTimer = null;
    }
    queueView?.dispose();
    queueView = null;
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
    window.removeEventListener('focus', handleWindowFocus);
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
