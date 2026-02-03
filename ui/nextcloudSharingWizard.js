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
  const popupSizer = window.NCTalkPopupSizing?.createPopupSizer({
    fixedWidth: POPUP_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    margin: CONTENT_MARGIN,
    getContentHeight: () => getContentHeight()
  });
  let pendingUploadScroll = null;
  const TOTAL_STEPS = 4;
  const LOG_SOURCE = 'nextcloudSharingWizard';
  const LOG_LABEL = 'Sharing';
  const LOG_CHANNEL = 'NCUI';
  const LOG_PREFIX = `[${LOG_CHANNEL}][${LOG_LABEL}]`;
  const SHARING_KEYS = NCSharingStorage.SHARING_KEYS;
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
      expireDays: 7
    },
    passwordPolicy: null,
    uploadInProgress: false,
    uploadCompleted: false,
    uploadResult: null,
    tabId: null,
    debugEnabled: false,
    remoteFolderCreated: false,
    remoteFolderInfo: null
  };
  const dom = {};
  const i18n = NCI18n.translate;
  const DEFAULT_EXPIRE_DAYS = 7;

  document.addEventListener('DOMContentLoaded', init);

  /**
   * Initialize the sharing wizard UI and state.
   * @returns {Promise<void>}
   */
  async function init(){
    cacheElements();
    NCTalkDomI18n.translatePage(i18n, { titleKey: "sharing_dialog_title" });
    state.tabId = parseTabId();
    attachEvents();
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
    if (browser?.storage?.onChanged){
      browser.storage.onChanged.addListener(handleStorageChange);
    }
    renderFileTable();
    updateStep(1);
    setupWindowSizing();
    log('Wizard initialisiert', { tabId: state.tabId });
  }

  /**
   * Cache DOM elements used by the wizard.
   */
  function cacheElements(){
    dom.content = document.querySelector('.nc-dialog-content');
    dom.steps = Array.from(document.querySelectorAll('.wizard-step'));
    dom.shareName = document.getElementById('shareName');
    dom.permCreate = document.getElementById('permCreate');
    dom.permWrite = document.getElementById('permWrite');
    dom.permDelete = document.getElementById('permDelete');
    dom.passwordToggle = document.getElementById('passwordToggle');
    dom.passwordFields = document.getElementById('passwordFields');
    dom.passwordInput = document.getElementById('passwordInput');
    dom.passwordGenerate = document.getElementById('passwordGenerate');
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
   * Attach UI event handlers for the wizard.
   */
  function attachEvents(){
    dom.shareName.addEventListener('input', () => {
      resetShareContext();
      invalidateUpload();
      log('shareName geÃ¤ndert', dom.shareName.value);
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
      log('passwort toggle', dom.passwordToggle.checked);
    });
    dom.passwordInput.addEventListener('input', invalidateUpload);
    dom.passwordGenerate.addEventListener('click', async () => {
      dom.passwordToggle.checked = true;
      applyPasswordToggleState(true);
      dom.passwordInput.value = await generatePasswordFromPolicy();
      invalidateUpload();
      log('passwort generiert');
    });
    dom.expireToggle.addEventListener('change', () => {
      dom.expireFields.classList.toggle('hidden', !dom.expireToggle.checked);
      if (dom.expireToggle.checked && !dom.expireDate.value){
        dom.expireDate.value = getDefaultExpireDate();
      }
      invalidateUpload();
      log('expire toggle', dom.expireToggle.checked);
    });
    dom.expireDate.addEventListener('change', invalidateUpload);
    dom.noteToggle.addEventListener('change', () => {
      dom.noteFields.classList.toggle('hidden', !dom.noteToggle.checked);
      log('note toggle', dom.noteToggle.checked);
    });
    dom.addFilesBtn.addEventListener('click', () => {
      log('Datei-Dialog geÃ¶ffnet');
      dom.fileInput.click();
    });
    dom.addFolderBtn.addEventListener('click', () => {
      log('Ordner-Dialog geÃ¶ffnet');
      dom.folderInput?.click();
    });
    dom.fileInput.addEventListener('change', (event) => handleFileSelection(event, 'file'));
    dom.folderInput?.addEventListener('change', (event) => handleFileSelection(event, 'folder'));
    dom.removeFileBtn.addEventListener('click', removeSelectedEntry);
    dom.backBtn.addEventListener('click', () => {
      if (state.currentStep > 1 && !state.uploadInProgress){
        updateStep(state.currentStep - 1);
        log('Step zurÃ¼ck', state.currentStep);
      }
    });
    dom.nextBtn.addEventListener('click', handleNext);
    dom.uploadBtn.addEventListener('click', () => {
      if (state.currentStep === 3){
        startUpload();
        log('Upload Button klick');
      }
    });
    dom.finishBtn.addEventListener('click', finalizeShare);
    dom.cancelBtn.addEventListener('click', handleCancel);
    log('Event-Handler registriert');
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
    state.defaults.expireDays = NCTalkTextUtils.normalizeExpireDays(
      stored[SHARING_KEYS.defaultExpireDays],
      DEFAULT_EXPIRE_DAYS
    );
  }
  /**
   * Fetch the live password policy from Nextcloud.
   * @returns {Promise<object>}
   */
  async function loadPasswordPolicy(){
    try{
      const response = await browser.runtime.sendMessage({ type: "passwordPolicy:fetch" });
      if (response?.policy){
        state.passwordPolicy = response.policy;
      }else{
        state.passwordPolicy = { hasPolicy:false, minLength:null, apiGenerateUrl:null, apiValidateUrl:null };
      }
    }catch(err){
      console.error('[NCSHARE-UI] password policy', err);
      state.passwordPolicy = { hasPolicy:false, minLength:null, apiGenerateUrl:null, apiValidateUrl:null };
    }
    return state.passwordPolicy;
  }

  /**
   * Load the configured base path and update the UI.
   * @returns {Promise<string>}
   */
  async function loadBasePath(){
    try{
      const basePath = await NCSharing.getFileLinkBasePath();
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
   * React to changes in local storage while the wizard is open.
   * @param {object} changes
   * @param {string} area
   */
  function handleStorageChange(changes, area){
    if (area !== 'local'){
      return;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'debugEnabled')){
      state.debugEnabled = !!changes.debugEnabled.newValue;
    }
    if (Object.prototype.hasOwnProperty.call(changes, SHARING_KEYS.basePath)){
      state.basePath = changes[SHARING_KEYS.basePath].newValue || '';
      if (dom.basePathLabel){
        dom.basePathLabel.textContent = state.basePath || '';
      }
    }
  }

  /**
   * Read the minimum length from the active policy.
   * @returns {number|null}
   */
  function getPolicyMinLength(){
    const minLength = Number(state.passwordPolicy?.minLength);
    return Number.isFinite(minLength) ? minLength : null;
  }

  /**
   * Generate a password using Nextcloud policy.
   * @returns {Promise<string>}
   */
  async function generatePasswordFromPolicy(){
    try{
      const policy = state.passwordPolicy || { hasPolicy:false, minLength:null, apiGenerateUrl:null, apiValidateUrl:null };
      if (policy?.apiGenerateUrl){
        const response = await browser.runtime.sendMessage({
          type: "passwordPolicy:generate",
          payload: { policy }
        });
        if (response?.ok && response.password){
          return response.password;
        }
      }
    }catch(err){
      console.error('[NCSHARE-UI] password generate', err);
    }
    const targetLength = Math.max(getPolicyMinLength() || 12, 12);
    return NCTalkPassword.generatePassword({
      length: targetLength,
      requireUpper: true,
      requireLower: true,
      requireDigit: true,
      requireSymbol: true
    });
  }

  /**
   * Validate strong password rules for local fallback.
   * @param {string} value
   * @returns {boolean}
   */
  function isStrongPassword(value){
    const pwd = String(value || '');
    return pwd.length >= 12
      && /[A-Z]/.test(pwd)
      && /[a-z]/.test(pwd)
      && /[0-9]/.test(pwd)
      && /[!@#$%^&*()\-_=+\[\]{};:,.?]/.test(pwd);
  }

  /**
   * Apply password toggle state to the UI.
   * @param {boolean} enabled
   */
  function applyPasswordToggleState(enabled){
    dom.passwordFields.classList.toggle('hidden', !enabled);
    dom.passwordInput.disabled = !enabled;
    dom.passwordGenerate.disabled = !enabled;
    if (!enabled){
      dom.passwordInput.value = '';
    }
  }
  /**\r\n   * Apply the default share name to the input if empty.
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
    if (enabled && !dom.passwordInput.value){
      dom.passwordInput.value = await generatePasswordFromPolicy();
    }
    dom.expireToggle.checked = true;
    dom.expireFields.classList.remove('hidden');
    dom.expireDate.value = getDefaultExpireDate();
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
        log('Folder existiert bereits', shareName);
        return false;
      }
      rememberShareFolder(result.folderInfo, shareName);
      setMessage('');
      log('Foldername verfÃƒÂ¼gbar', shareName);
      return true;
    }catch(err){
      setMessage(err?.message || i18n('sharing_status_error'), 'error');
      log('Foldercheck Fehler', err?.message);
      return false;
    }
  }

  /**
   * Handle file or folder input selections.
   * @param {Event} event
   * @param {string} source
   */
  function handleFileSelection(event, source){
    const files = Array.from(event.target.files || []);
    if (!files.length){
      return;
    }
    log('Dateien ausgewÃƒÂ¤hlt', { source, count: files.length });
    const entries = files.map((file) => {
      const relativePath = (file.webkitRelativePath || file.relativePath || '').replace(/\\/g, '/');
      let relativeDir = '';
      if (source === 'folder' && relativePath.includes('/')){
        relativeDir = relativePath.slice(0, relativePath.lastIndexOf('/'));
      }
      const displayPath = relativeDir ? `${relativeDir}/${file.name}` : file.name;
      return {
        id: `entry_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file,
        displayPath,
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
    log('Eintrag entfernt', removed?.displayPath || '');
  }

  /**
   * Render the current file list table.
   */
  function renderFileTable(){
    dom.fileTableBody.innerHTML = '';
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
      const pathCell = document.createElement('td');
      pathCell.textContent = entry.displayPath || entry.file?.name || '';
      const typeCell = document.createElement('td');
      typeCell.textContent = i18n('sharing_file_type_file');
      const statusCell = document.createElement('td');
      statusCell.innerHTML = buildStatusMarkup(entry);
      row.append(pathCell, typeCell, statusCell);
      row.addEventListener('click', () => {
        state.selectedFileId = entry.id;
        renderFileTable();
        updateButtons();
      });
      dom.fileTableBody.appendChild(row);
    });
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
   * Build the status cell markup for a file entry.
   * @param {object} entry
   * @returns {string}
   */
  function buildStatusMarkup(entry){
    if (entry.status === 'uploading'){
      const percent = entry.progress || 0;
      return `<div class="status-progress"><span class="percent">${percent}%</span><div class="bar"><span style="width:${percent}%;"></span></div></div>`;
    }
    if (entry.status === 'done'){
      return `<span>${i18n('sharing_status_done_row')}</span>`;
    }
    if (entry.status === 'error'){
      return `<span title="${NCTalkTextUtils.escapeHtml(entry.error || '')}">${i18n('sharing_status_error_row')}</span>`;
    }
    return `<span>${i18n('sharing_status_waiting')}</span>`;
  }

  /**
   * Reset upload state after changing inputs.
   */
  function invalidateUpload(){
    state.uploadCompleted = false;
    state.uploadResult = null;
    pendingUploadScroll = '__top__';
    state.files.forEach((entry) => {
      entry.status = 'pending';
      entry.progress = 0;
      entry.error = '';
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
    log('Upload gestartet', { files: state.files.length });
    if (!(await ensureShareNameAvailable())){
      log('Upload abgebrochen: shareName unavailable');
      return;
    }
    if (!validatePasswordIfNeeded()){
      log('Upload abgebrochen: Passwort ungÃƒÂ¼ltig');
      return;
    }
    if (!(await ensureUniqueQueueEntries())){
      log('Upload abgebrochen: lokale Duplikate');
      return;
    }
    if (!(await ensureRemoteUniqueness())){
      log('Upload abgebrochen: Server Duplikate');
      return;
    }
    const hasFiles = state.files.length > 0;
    state.uploadInProgress = true;
    if (hasFiles){
      setMessage(i18n('sharing_status_uploading_bulk'), 'info');
      setUploadStatus(i18n('sharing_status_uploading_bulk'));
      state.files.forEach((entry) => {
        entry.status = 'queued';
        entry.progress = 0;
        entry.error = '';
      });
    }else{
      setMessage(i18n('sharing_status_creating'), 'info');
      setUploadStatus('');
    }
    renderFileTable();
    updateButtons();
    const noteEnabled = !!dom.noteToggle.checked;
    const noteValue = noteEnabled ? dom.noteInput.value.trim() : '';
    try{
      const shareContext = getShareContext();
      if (!shareContext){
        throw new Error(i18n('sharing_message_invalid_share_name'));
      }
      if (shareContext.folderInfo){
        state.remoteFolderInfo = { ...shareContext.folderInfo };
        state.remoteFolderCreated = true;
      }
      const result = await NCSharing.createFileLink({
        shareName: shareContext.sanitizedName,
        basePath: state.basePath,
        shareDate: shareContext.shareDate.toISOString(),
        folderInfo: shareContext.folderInfo,
        permissions: getPermissions(),
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
      state.uploadCompleted = true;
      setMessage(i18n('sharing_status_ready'), 'success');
      setUploadStatus(i18n('sharing_status_ready'));
      log('Upload abgeschlossen');
    }catch(err){
      state.uploadCompleted = false;
      setMessage(err?.message || i18n('sharing_status_error'), 'error');
      setUploadStatus(err?.message || i18n('sharing_status_error'));
      log('Upload fehlgeschlagen', err?.message);
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
      entry.status = 'uploading';
      entry.progress = 0;
      entry.error = '';
      log('Upload Datei gestartet', entry.displayPath || entry.file?.name || entry.id);
    }else if (event.phase === 'progress'){
      entry.status = 'uploading';
      entry.progress = event.percent || 0;
    }else if (event.phase === 'done'){
      entry.status = 'done';
      entry.progress = 100;
      log('Upload Datei abgeschlossen', entry.displayPath || entry.file?.name || entry.id);
    }else if (event.phase === 'error'){
      entry.status = 'error';
      entry.error = event.error || '';
      log('Upload Datei Fehler', { name: entry.displayPath || entry.file?.name || entry.id, error: entry.error });
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
      return;
    }
    const noteEnabled = !!dom.noteToggle.checked;
    const note = noteEnabled ? dom.noteInput.value.trim() : '';
    try{
      if (typeof NCSharing.updateShareDetails === 'function'){
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
        noteEnabled,
        note
      });
      await insertIntoCompose(html);
      log('Freigabe eingefÃƒÂ¼gt');
      state.remoteFolderCreated = false;
      state.remoteFolderInfo = null;
      window.close();
    }catch(err){
      setMessage(err?.message || i18n('sharing_status_error'), 'error');
      log('Freigabe EinfÃƒÂ¼gen fehlgeschlagen', err?.message);
    }
  }

  /**
   * Collect permission flags from the UI.
   * @returns {{read:boolean,create:boolean,write:boolean,delete:boolean}}
   */
  function getPermissions(){
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
        log('Lokaler Duplikat-Rename', entry.displayPath);
      }
      seen.add(key);
    }
    renderFileTable();
    return true;
  }

  /**
   * Ensure selected files do not collide with remote paths.
   * @returns {Promise<boolean>}
   */
  async function ensureRemoteUniqueness(){
    const shareContext = getShareContext();
    if (!shareContext){
      return false;
    }
    for (const entry of state.files){
      const relativePath = joinRelative(shareContext.folderInfo.relativeFolder, getTargetRelativePath(entry));
      const exists = await NCSharing.checkRemotePathExists({ relativePath });
      if (exists){
        if (!promptForRename(entry, 'sharing_prompt_rename_existing')){
          return false;
        }
        renderFileTable();
        log('Server Duplikat-Rename', entry.displayPath);
        return ensureRemoteUniqueness();
      }
    }
    return true;
  }

  /**
   * Build a sanitized target path for a file entry.
   * @param {object} entry
   * @returns {string}
   */
  function getTargetRelativePath(entry){
    const sanitizedName = NCSharing.sanitizeFileName(entry.renamedName || entry.file?.name || 'Datei');
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
    }else if (!isStrongPassword(pwd)){
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
    const title = i18n('sharing_confirm_no_files_title') || 'Freigabe ohne Upload';
    const body = i18n('sharing_confirm_no_files_message') || 'Es wurden keine Dateien hinzugefügt. Der Empfänger kann nur eigene Dateien hochladen. Fortfahren?';
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
   * Handle cancel and clean up any temporary server state.
   * @param {Event} event
   * @returns {Promise<void>}
   */
  async function handleCancel(event){
    event?.preventDefault?.();
    await cleanupRemoteFolder('cancel');
    window.close();
  }

  /**
   * Remove the remote folder if it was created during this wizard run.
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async function cleanupRemoteFolder(reason = ''){
    if (!state.remoteFolderCreated || !state.remoteFolderInfo){
      return;
    }
    if (typeof NCSharing?.deleteShareFolder !== 'function'){
      return;
    }
    try{
      await NCSharing.deleteShareFolder({ folderInfo: state.remoteFolderInfo });
      log('Remote Ordner bereinigt', { reason, folder: state.remoteFolderInfo.relativeFolder });
    }catch(err){
      log('Remote Ordner Bereinigung fehlgeschlagen', err?.message || err);
    }finally{
      state.remoteFolderCreated = false;
      state.remoteFolderInfo = null;
    }
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
    return i18n('sharing_share_default') || 'Freigabename';
  }

  /**
   * Join path segments and trim slashes.
   * @param {...string} segments
   * @returns {string}
   */
  function joinRelative(...segments){
    return segments
      .map((segment) => String(segment || '').replace(/^[\\/]+|[\\/]+$/g, ''))
      .filter(Boolean)
      .join('/');
  }

  /**
   * Send a debug log message when enabled.
   */
  function log(){
    if (!state.debugEnabled){
      return;
    }
    const args = Array.from(arguments);
    forwardDebugLog(args);
  }

  /**
   * Forward a debug log payload to the background.
   * @param {any[]} args
   */
  function forwardDebugLog(args){
    if (!browser?.runtime?.sendMessage){
      return;
    }
    const list = Array.isArray(args) ? args : [];
    const payload = {
      source: LOG_SOURCE,
      channel: LOG_CHANNEL,
      label: LOG_LABEL,
      text: formatLogArg(list[0])
    };
    if (list.length > 1){
      payload.details = list.slice(1).map(formatLogArg);
    }
    try{
      browser.runtime.sendMessage({
        type: 'debug:log',
        payload
      }).catch(() => {});
    }catch(_){}
  }

  /**
   * Format a log argument for transport.
   * @param {any} value
   * @returns {string}
   */
  function formatLogArg(value){
    if (value == null){
      return String(value);
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'){
      return String(value);
    }
    if (value instanceof Error){
      return value?.message || value.toString();
    }
    try{
      return JSON.stringify(value);
    }catch(_){}
    try{
      return String(value);
    }catch(__){
      return Object.prototype.toString.call(value);
    }
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
    entry.displayPath = entry.relativeDir ? `${entry.relativeDir}/${clean}` : clean;
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
   * Return the desired content height for popup sizing.
   * @returns {number}
   */
  function getContentHeight(){
    return POPUP_CONTENT_HEIGHT;
  }
})();
















