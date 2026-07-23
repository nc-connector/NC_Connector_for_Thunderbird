/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(() => {
  'use strict';

  const POPUP_CONTENT_WIDTH = 520;
  const MIN_CONTENT_HEIGHT = 0;
  const CONTENT_MARGIN = 0;
  const POPUP_CONTEXT_RETRY_DELAYS_MS = [0, 40, 80, 160, 320, 640];
  let layoutObserver = null;
  let isPageUnloading = false;
  let disposeDebugFlagMirror = null;
  const dialogRoot = document.querySelector(".dialog");
  const popupSizer = window.NCTalkPopupSizing?.createPopupSizer({
    fixedWidth: POPUP_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    margin: CONTENT_MARGIN,
    getContentHeight: () => getContentHeight()
  });

  const LOG_PREFIX = "[NCUI][Talk]";
  const SYSTEM_ADDRESSBOOK_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md#43-talk-and-system-address-book";
  const POLICY_ADMIN_URL = "https://github.com/nc-connector/NC_Connector_for_Thunderbird/blob/main/docs/ADMIN.md";
  const params = new URLSearchParams(window.location.search);
  const contextId = (params.get("contextId") || "").trim();
  const policyWarningRow = document.getElementById("policyWarningRow");
  const policyWarningText = document.getElementById("policyWarningText");
  const policyWarningAdminLink = document.getElementById("policyWarningAdminLink");
  const titleInput = document.getElementById("titleInput");
  const passwordInput = document.getElementById("passwordInput");
  const passwordToggle = document.getElementById("passwordToggle");
  const passwordFields = document.getElementById("passwordFields");
  const passwordGenerateBtn = document.getElementById("passwordGenerateBtn");
  const addUsersToggle = document.getElementById("addUsersToggle");
  const addGuestsToggle = document.getElementById("addGuestsToggle");
  const lobbyToggle = document.getElementById("lobbyToggle");
  const listableToggle = document.getElementById("listableToggle");
  const roomTypePicker = document.getElementById("roomTypePicker");
  const roomTypeButton = document.getElementById("roomTypeButton");
  const roomTypeButtonLabel = document.getElementById("roomTypeButtonLabel");
  const roomTypeDropdown = document.getElementById("roomTypeDropdown");
  const roomTypeValue = document.getElementById("roomTypeValue");
  const roomTypeOptions = Array.from(document.querySelectorAll(".roomtype-option"));
  const delegateInput = document.getElementById("delegateInput");
  const delegateClearBtn = document.getElementById("delegateClearBtn");
  const delegateStatus = document.getElementById("delegateStatus");
  const delegateSelected = document.getElementById("delegateSelected");
  const delegateSelectedName = document.getElementById("delegateSelectedName");
  const delegateSelectedMeta = document.getElementById("delegateSelectedMeta");
  const delegateSelectedDescription = document.getElementById("delegateSelectedDescription");
  const delegateAvatarImg = document.getElementById("delegateAvatarImg");
  const delegateAvatarInitials = document.getElementById("delegateAvatarInitials");
  const delegateDropdown = document.getElementById("delegateDropdown");
  const delegateSection = document.querySelector(".delegate-section");
  const addUsersToggleRow = document.getElementById("addUsersToggleRow");
  const addUsersTooltipList = document.getElementById("addUsersTooltipList");
  const addGuestsToggleRow = document.getElementById("addGuestsToggleRow");
  const addGuestsTooltipList = document.getElementById("addGuestsTooltipList");
  const addUsersAddressbookLockHint = document.getElementById("addUsersAddressbookLockHint");
  const addGuestsAddressbookLockHint = document.getElementById("addGuestsAddressbookLockHint");
  const delegateInputLabel = document.getElementById("delegateInputLabel");
  const delegateTooltipList = document.getElementById("delegateTooltipList");
  const delegateAddressbookLockHint = document.getElementById("delegateAddressbookLockHint");
  const delegateAddressbookHelp = document.getElementById("delegateAddressbookHelp");
  const systemAddressbookAdminLinkDelegateInline = document.getElementById("systemAddressbookAdminLinkDelegateInline");
  const messageBar = document.getElementById("messageBar");
  const okBtn = document.getElementById("okBtn");
  const cancelBtn = document.getElementById("cancelBtn");
  const titleSection = titleInput?.closest(".section");
  const roomTypeSection = roomTypePicker?.closest(".section");
  const lobbyToggleRow = lobbyToggle?.closest(".checkbox-row");
  const listableToggleRow = listableToggle?.closest(".checkbox-row");
  const passwordToggleRow = passwordToggle?.closest(".checkbox-row");
  let i18nLookupErrorLogged = false;

  function logUiError(scope, reportedError){
    globalThis.NCLogContext.safeConsoleError(LOG_PREFIX, scope, reportedError);
  }

  function waitForPopupContextRetry(delayMs){
    const delay = Math.max(0, Number(delayMs) || 0);
    if (!delay){
      return Promise.resolve();
    }
    return new Promise(resolve => window.setTimeout(resolve, delay));
  }

  async function claimNativePopupContext(){
    if (state.contextId){
      return true;
    }
    for (const delayMs of POPUP_CONTEXT_RETRY_DELAYS_MS){
      await waitForPopupContextRetry(delayMs);
      try{
        const response = await browser.runtime.sendMessage({
          type: "talk:claimPopupContext"
        });
        if (response?.ok && typeof response.contextId === "string" && response.contextId.trim()){
          state.contextId = response.contextId.trim();
          logDebug("popup context claimed", {
            contextId: state.contextId
          });
          return true;
        }
      }catch(error){
        logUiError("claim popup context failed", error);
      }
    }
    return false;
  }

  /**
   * Translate a key with optional fallback/substitutions.
   * @param {string} key
   * @param {string|Array|object} fallbackOrSubstitutions
   * @param {Array|object} substitutions
   * @returns {string}
   */
  const t = (key, fallbackOrSubstitutions = "", substitutions = undefined) => {
    let fallback = fallbackOrSubstitutions;
    let subs = substitutions;
    if (Array.isArray(fallbackOrSubstitutions) || (fallbackOrSubstitutions && typeof fallbackOrSubstitutions === "object" && !Array.isArray(substitutions))){
      subs = fallbackOrSubstitutions;
      fallback = "";
    }
    try{
      const value = subs !== undefined
        ? browser.i18n.getMessage(key, subs)
        : browser.i18n.getMessage(key);
      if (value){
        return value;
      }
    }catch(error){
      if (!i18nLookupErrorLogged){
        i18nLookupErrorLogged = true;
        logUiError("i18n lookup failed", error);
      }
    }
    return fallback || "";
  };
  const wizardTranslate = (key, fallback = "") => t(key, fallback);
  const TALK_POLICY_RUNTIME_BINDINGS = [
    {
      name: "descriptionLanguage",
      key: "language_talk_description",
      type: "string",
      normalize: (value) => normalizeDescriptionLanguage(value)
    },
    {
      name: "descriptionType",
      key: "event_description_type",
      normalize: (value) => normalizeEventDescriptionType(value)
    },
    { name: "invitationTemplate", key: "talk_invitation_template", type: "string" }
  ];
  const TALK_DEFAULT_POLICY_BINDINGS = [
    { name: "title", domain: "talk", key: "talk_title", type: "string" },
    { name: "lobby", domain: "talk", key: "talk_lobby_active", type: "boolean" },
    { name: "listable", domain: "talk", key: "talk_show_in_search", type: "boolean" },
    { name: "addUsersEnabled", domain: "talk", key: "talk_add_users", type: "boolean" },
    { name: "addGuestsEnabled", domain: "talk", key: "talk_add_guests", type: "boolean" },
    { name: "passwordEnabled", domain: "talk", key: "talk_set_password", type: "boolean" },
    {
      name: "roomType",
      domain: "talk",
      key: "talk_room_type",
      type: "string",
      normalize: (value) => value === "event" ? "event" : "normal"
    }
  ];

  NCTalkDomI18n.translatePage((key, subs) => browser.i18n.getMessage(key, subs), {
    titleKey: "talk_dialog_title"
  });

  const state = {
    contextId: contextId || null,
    metadata: null,
    event: null,
    passwordPolicy: null,
    debugEnabled: false,
    busy: false,
    delegate: {
      selected: null,
      suggestions: [],
      activeIndex: -1,
      visible: false,
      searchTimer: null,
      searchSeq: 0,
      alertLabel: ""
    },
    systemAddressbook: {
      checked: false,
      available: true,
      error: ""
    },
    policy: {
      status: null,
      active: false,
      talk: null,
      editable: null,
      warningVisible: false,
      warningCode: "",
      descriptionLanguage: "",
      descriptionType: "plain_text",
      invitationTemplate: ""
    }
  };
  const emitDebugLog = typeof NCDebugForwarder?.createUiDebugLogger === "function"
    ? NCDebugForwarder.createUiDebugLogger({
      source: "talkDialog",
      channel: "NCUI",
      label: "Talk",
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

  [systemAddressbookAdminLinkDelegateInline].forEach((link) => {
    if (link){
      link.href = SYSTEM_ADDRESSBOOK_ADMIN_URL;
    }
  });
  if (policyWarningAdminLink){
    policyWarningAdminLink.href = POLICY_ADMIN_URL;
  }

  function normalizeDescriptionLanguage(value){
    return NCI18nOverride.normalizeLanguageOverride(value, { allowCustom: true });
  }

  function normalizeEventDescriptionType(value){
    return String(value ?? "").trim().toLowerCase() === "html"
      ? "html"
      : "plain_text";
  }

  async function refreshPolicyStatus(){
    try{
      const response = await browser.runtime.sendMessage({
        type: "policy:getStatus"
      });
      const status = response?.ok ? (response.status || null) : null;
      const domainState = NCWizardPolicyUi.readPolicyDomain(status, "talk");
      state.policy.status = status;
      state.policy.active = domainState.active;
      state.policy.talk = domainState.policy;
      state.policy.editable = domainState.editable;
      state.policy.warningVisible = domainState.warningVisible;
      state.policy.warningCode = domainState.warningCode;
      const runtimeDefaults = {
        descriptionLanguage: "",
        descriptionType: "plain_text",
        invitationTemplate: ""
      };
      const localRuntimeNames = new Set();
      if (browser?.storage?.local){
        const stored = await browser.storage.local.get("eventDescriptionLang");
        if (typeof stored.eventDescriptionLang === "string" && stored.eventDescriptionLang.trim()){
          runtimeDefaults.descriptionLanguage = normalizeDescriptionLanguage(stored.eventDescriptionLang);
          localRuntimeNames.add("descriptionLanguage");
        }
      }
      Object.assign(state.policy, NCWizardPolicyUi.readPolicyBoundDefaults(
        domainState,
        TALK_POLICY_RUNTIME_BINDINGS,
        runtimeDefaults,
        { localNames: localRuntimeNames }
      ));
      logDebug("policy status", {
        active: state.policy.active,
        warning: state.policy.warningCode || "",
        mode: status?.mode || ""
      });
    }catch(error){
      logUiError("policy status fetch failed", error);
    }
    NCWizardPolicyUi.applyPolicyWarningUi({
      row: policyWarningRow,
      textElement: policyWarningText,
      warningVisible: state.policy.warningVisible,
      translate: wizardTranslate
    });
  }
  window.addEventListener("pagehide", cleanupPageResources, true);
  window.addEventListener("beforeunload", cleanupPageResources, true);
  window.addEventListener("unload", cleanupPageResources, true);

  if (passwordInput){
    passwordInput.setAttribute("placeholder", t("ui_create_password_placeholder"));
  }

  void bootstrapDialog();
  if (popupSizer){
    popupSizer.scheduleSizeUpdate();
    window.addEventListener("load", popupSizer.scheduleSizeUpdate, { once:true });
    window.addEventListener("resize", popupSizer.scheduleSizeUpdate);
    if (typeof ResizeObserver === "function"){
      layoutObserver = new ResizeObserver(() => popupSizer.scheduleSizeUpdate());
      layoutObserver.observe(document.documentElement || document.body);
    }
  }

  function bindEvents(){
    okBtn?.addEventListener("click", handleOk);
    cancelBtn?.addEventListener("click", () => {
      if (!state.busy){
        void closeDialogWindow();
      }
    });
    passwordGenerateBtn?.addEventListener("click", handlePasswordGenerate);
    passwordToggle?.addEventListener("change", handlePasswordToggle);
    initRoomTypePicker();
    initDelegateField();
  }

  function initRoomTypePicker(){
    if (!roomTypePicker || !roomTypeButton || !roomTypeDropdown || !roomTypeValue){
      return;
    }

    roomTypeButton.addEventListener("click", (event) => {
      event.preventDefault();
      if (state.busy){
        return;
      }
      toggleRoomTypeDropdown();
    });

    roomTypeOptions.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (state.busy){
          return;
        }
        setRoomTypeValue(button.dataset.value || "normal");
        closeRoomTypeDropdown();
        try{
          roomTypeButton.focus();
        }catch(error){
          logUiError("room type button focus failed", error);
        }
      });
    });

    document.addEventListener("click", (event) => {
      if (!roomTypePicker.contains(event.target)){
        closeRoomTypeDropdown();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape"){
        closeRoomTypeDropdown();
      }
    });

    setRoomTypeValue(roomTypeValue.value || "event", { closeDropdown:false });
  }

  function isRoomTypeDropdownOpen(){
    return !!(roomTypeDropdown && roomTypeDropdown.hidden === false);
  }

  function openRoomTypeDropdown(){
    if (!roomTypeDropdown){
      return;
    }
    roomTypeDropdown.hidden = false;
    roomTypeButton?.setAttribute("aria-expanded", "true");
  }

  function closeRoomTypeDropdown(){
    if (!roomTypeDropdown){
      return;
    }
    roomTypeDropdown.hidden = true;
    roomTypeButton?.setAttribute("aria-expanded", "false");
  }

  function toggleRoomTypeDropdown(){
    if (isRoomTypeDropdownOpen()){
      closeRoomTypeDropdown();
    }else{
      openRoomTypeDropdown();
    }
  }

  /**
   * Apply and render the selected room type.
   * @param {string} value
   * @param {{closeDropdown?:boolean}} options
   */
  function setRoomTypeValue(value, options = {}){
    const closeDropdown = options.closeDropdown !== false;
    const normalized = value === "event" ? "event" : "normal";
    if (roomTypeValue){
      roomTypeValue.value = normalized;
    }
    if (roomTypeButtonLabel){
      roomTypeButtonLabel.textContent = normalized === "event"
        ? t("ui_create_mode_event")
        : t("ui_create_mode_standard");
    }
    roomTypeOptions.forEach((button) => {
      const selected = button.dataset.value === normalized;
      button.dataset.selected = selected ? "true" : "false";
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    if (closeDropdown){
      closeRoomTypeDropdown();
    }
  }

  /**
   * Initialize the dialog by fetching event data.
   * @returns {Promise<void>}
   */
  async function init(){
    try{
      const check = await browser.runtime.sendMessage({
        type: "talk:initDialog",
        contextId: state.contextId
      });
      if (!check?.ok){
        throw new Error(check?.error || t("talk_error_init_failed"));
      }
      await refreshPolicyStatus();
      await passwordPolicyActions.load();
      await loadSnapshot();
      await refreshSystemAddressbookAvailability({ forceRefresh: true });
    }catch(error){
      logUiError("init failed", error);
      setMessage(error?.message || String(error), true);
    }
  }

  /**
   * Initialize debug logging first, then continue with the dialog bootstrap.
   * @returns {Promise<void>}
   */
  async function bootstrapDialog(){
    await initDebugLogging();
    bindEvents();
    if (!state.contextId && !(await claimNativePopupContext())){
      setMessage(t("talk_error_context_id_missing"), true);
      return;
    }
    await init();
  }

  /**
   * Mirror the debug flag into the Talk dialog runtime.
   * @returns {Promise<void>}
   */
  async function initDebugLogging(){
    disposeDebugFlagMirror?.();
    disposeDebugFlagMirror = null;
    if (typeof NCDebugForwarder?.installDebugEnabledMirror !== "function"){
      state.debugEnabled = false;
      return;
    }
    const control = await NCDebugForwarder.installDebugEnabledMirror({
      onChange: (enabled) => {
        state.debugEnabled = !!enabled;
      },
      onError: logUiError
    });
    disposeDebugFlagMirror = typeof control?.dispose === "function"
      ? () => control.dispose()
      : null;
    logDebug("popup init", {
      contextId: state.contextId || ""
    });
  }

  /**
   * Load stored Talk defaults from local storage.
   * @returns {Promise<{title:string,lobby:boolean,listable:boolean,roomType:string}>}
   */
  async function loadTalkDefaults(){
    const defaults = {
      title: t("ui_default_title"),
      lobby: true,
      listable: true,
      roomType: "event",
      passwordEnabled: true,
      addUsersEnabled: false,
      addGuestsEnabled: false
    };
    if (!browser?.storage?.local){
      return defaults;
    }
    try{
      const stored = await browser.storage.local.get([
        "talkDefaultTitle",
        "talkDefaultLobby",
        "talkDefaultListable",
        "talkAddUsersDefaultEnabled",
        "talkAddGuestsDefaultEnabled",
        "talkAddParticipantsDefaultEnabled",
        "talkDefaultRoomType",
        "talkPasswordDefaultEnabled"
      ]);
      const localDefaultNames = new Set();
      const rawTitle = (stored.talkDefaultTitle || "").trim();
      if (rawTitle){
        defaults.title = rawTitle;
        localDefaultNames.add("title");
      }
      if (typeof stored.talkDefaultLobby === "boolean"){
        defaults.lobby = stored.talkDefaultLobby;
        localDefaultNames.add("lobby");
      }
      if (typeof stored.talkDefaultListable === "boolean"){
        defaults.listable = stored.talkDefaultListable;
        localDefaultNames.add("listable");
      }
      if (typeof stored.talkAddUsersDefaultEnabled === "boolean"){
        defaults.addUsersEnabled = stored.talkAddUsersDefaultEnabled;
        localDefaultNames.add("addUsersEnabled");
      }
      if (typeof stored.talkAddGuestsDefaultEnabled === "boolean"){
        defaults.addGuestsEnabled = stored.talkAddGuestsDefaultEnabled;
        localDefaultNames.add("addGuestsEnabled");
      }
      if (typeof stored.talkAddParticipantsDefaultEnabled === "boolean"
        && typeof stored.talkAddUsersDefaultEnabled !== "boolean"
        && typeof stored.talkAddGuestsDefaultEnabled !== "boolean"){
        defaults.addUsersEnabled = stored.talkAddParticipantsDefaultEnabled;
        defaults.addGuestsEnabled = stored.talkAddParticipantsDefaultEnabled;
        localDefaultNames.add("addUsersEnabled");
        localDefaultNames.add("addGuestsEnabled");
      }
      if (typeof stored.talkPasswordDefaultEnabled === "boolean"){
        defaults.passwordEnabled = stored.talkPasswordDefaultEnabled;
        localDefaultNames.add("passwordEnabled");
      }
      if (stored.talkDefaultRoomType === "normal"){
        defaults.roomType = "normal";
        localDefaultNames.add("roomType");
      }else if (stored.talkDefaultRoomType === "event"){
        defaults.roomType = "event";
        localDefaultNames.add("roomType");
      }
      Object.assign(defaults, NCWizardPolicyUi.readPolicyBoundDefaults(
        {
          active: state.policy.active,
          policy: state.policy.talk,
          editable: state.policy.editable
        },
        TALK_DEFAULT_POLICY_BINDINGS,
        defaults,
        { localNames: localDefaultNames }
      ));
    }catch(error){
      logUiError("load defaults failed", error);
    }
    return defaults;
  }

  function applyPasswordToggleState(enabled){
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "talk_set_password",
      element: passwordToggle,
      row: passwordToggleRow,
      translate: wizardTranslate
    });
    if (passwordFields){
      passwordFields.classList.toggle("hidden", !enabled);
    }
    if (passwordInput){
      passwordInput.disabled = !enabled;
      if (!enabled){
        passwordInput.value = "";
      }
    }
    if (passwordGenerateBtn){
      passwordGenerateBtn.disabled = !enabled;
    }
  }

  /**
   * Handle toggling password creation.
   */
  async function handlePasswordToggle(){
    const enabled = !!passwordToggle?.checked;
    applyPasswordToggleState(enabled);
    if (enabled && passwordInput && !passwordInput.value){
      passwordInput.value = await passwordPolicyActions.generate();
    }
  }

  /**
   * Load the current event snapshot and populate the UI.
   * @returns {Promise<void>}
   */
  async function loadSnapshot(){
    try{
      const response = await browser.runtime.sendMessage({
        type: "talk:getEventSnapshot",
        contextId: state.contextId
      });
      if (!response?.ok){
        throw new Error(response?.error || t("talk_error_snapshot_failed"));
      }
      state.metadata = response.metadata || {};
      state.event = response.event || {};
      const defaults = await loadTalkDefaults();
      applyDefaultsToUi(defaults, state.event, state.metadata);
      popupSizer?.scheduleSizeUpdate();
    }catch(error){
      logUiError("load snapshot failed", error);
      setMessage(error?.message || String(error), true);
    }
  }

  /**
   * Apply default values and optional event metadata to dialog controls.
   * @param {object} defaults
   * @param {object|null} event
   * @param {object|null} metadata
   */
  function applyDefaultsToUi(defaults, event = null, metadata = null){
    const effectiveDefaults = defaults || {
      title: t("ui_default_title"),
      lobby: true,
      listable: true,
      roomType: "event",
      passwordEnabled: true,
      addUsersEnabled: false,
      addGuestsEnabled: false
    };
    const ev = event || {};
    const meta = metadata || {};

    const eventTitle = (ev.title || "").trim();
    const metaTitle = (meta.title || "").trim();
    const fallbackTitle = effectiveDefaults.title || t("ui_default_title");
    const lobbyValue = meta.lobbyEnabled;
    const listableValue = meta.listable;
    const eventValue = meta.eventConversation;
    const addUsersValue = meta.addUsers;
    const addGuestsValue = meta.addGuests;
    const candidateValues = {
      title: eventTitle || metaTitle || fallbackTitle,
      lobby: lobbyValue == null ? !!effectiveDefaults.lobby : !!lobbyValue,
      listable: listableValue == null ? !!effectiveDefaults.listable : !!listableValue,
      addUsersEnabled: addUsersValue == null ? !!effectiveDefaults.addUsersEnabled : !!addUsersValue,
      addGuestsEnabled: addGuestsValue == null ? !!effectiveDefaults.addGuestsEnabled : !!addGuestsValue,
      passwordEnabled: effectiveDefaults.passwordEnabled !== false,
      roomType: (eventValue == null ? effectiveDefaults.roomType !== "normal" : !!eventValue) ? "event" : "normal"
    };
    const resolvedValues = NCWizardPolicyUi.resolvePolicyBoundValues(
      state.policy.status,
      TALK_DEFAULT_POLICY_BINDINGS,
      candidateValues
    );
    if (titleInput){
      titleInput.value = resolvedValues.title;
    }

    if (lobbyToggle){
      lobbyToggle.checked = !!resolvedValues.lobby;
    }
    if (listableToggle){
      listableToggle.checked = !!resolvedValues.listable;
    }
    if (addUsersToggle){
      addUsersToggle.checked = !!resolvedValues.addUsersEnabled;
    }
    if (addGuestsToggle){
      addGuestsToggle.checked = !!resolvedValues.addGuestsEnabled;
    }
    setRoomTypeValue(resolvedValues.roomType, { closeDropdown:false });
      if (passwordToggle){
        const enabled = resolvedValues.passwordEnabled !== false;
        passwordToggle.checked = enabled;
        applyPasswordToggleState(enabled);
        if (enabled && passwordInput && !passwordInput.value){
          passwordPolicyActions.generate().then((pwd) => {
            if (pwd && passwordInput && !passwordInput.value){
              passwordInput.value = pwd;
            }
          }).catch((error) => {
            logUiError("password bootstrap failed", error);
          });
        }
      }
      hydrateDelegateFromMetadata(meta);
      applyPolicyControlLocks();
      if (state.systemAddressbook.checked){
        applySystemAddressbookAvailability(state.systemAddressbook.available, state.systemAddressbook.error);
      }
  }

  /**
   * Apply static lock-state UI for policy-controlled controls.
   */
  function applyPolicyControlLocks(){
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "talk_title",
      element: titleInput,
      row: titleSection,
      translate: wizardTranslate
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "talk_room_type",
      element: roomTypeButton,
      row: roomTypeSection,
      translate: wizardTranslate,
      onLocked: closeRoomTypeDropdown
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "talk_lobby_active",
      element: lobbyToggle,
      row: lobbyToggleRow,
      translate: wizardTranslate
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "talk_show_in_search",
      element: listableToggle,
      row: listableToggleRow,
      translate: wizardTranslate
    });
    NCWizardPolicyUi.applyEditableLock({
      active: state.policy.active,
      editable: state.policy.editable,
      key: "talk_set_password",
      element: passwordToggle,
      row: passwordToggleRow,
      translate: wizardTranslate
    });
  }

  /**
   * Handle the OK button and create/update the Talk room.
   * @returns {Promise<void>}
   */
  async function handleOk(){
    if (state.busy){
      return;
    }
    logDebug("handleOk start", {
      contextId: state.contextId || ""
    });
    if (!(await ensureValidPassword())){
      return;
    }
    if (!titleInput.value.trim()){
      setMessage(t("talk_error_title_missing"), true);
      return;
    }
    state.busy = true;
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    setMessage(t("ui_button_create_progress"), false);
    try{
      const payload = buildCreatePayload();
      const response = await browser.runtime.sendMessage({
        type: "talk:createRoom",
        payload
      });
      if (!response?.ok){
        throw new Error(response?.error || t("talk_error_create_failed"));
      }
      logDebug("createRoom success", {
        includeEvent: payload.eventConversation,
        contextId: state.contextId || ""
      });
      await applyCreateResult(payload, response.result || {});
      await closeDialogWindow();
    }catch(error){
      logUiError("handleOk failed", error);
      setMessage(error?.message || String(error), true);
      state.busy = false;
      okBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  }

  /**
   * Build the payload for the create-room request.
   * @returns {object}
   */
  function buildCreatePayload(){
    const startTimestamp = ensureUnixSeconds(state.event?.startTimestamp || state.metadata?.startTimestamp);
    const endTimestamp = ensureUnixSeconds(state.event?.endTimestamp || state.metadata?.endTimestamp || state.event?.startTimestamp);
    const type = roomTypeValue?.value === "event" ? "event" : "normal";
    const objectMeta = type === "event" ? buildEventObjectMetadata(startTimestamp, endTimestamp) : null;
    logDebug("event object metadata", {
      type,
      hasObjectId: !!objectMeta?.objectId,
      startTimestamp,
      endTimestamp,
      existingObjectId: !!state.metadata?.objectId
    });
    if (type === "event" && !objectMeta?.objectId){
      throw new Error(t("talk_error_event_context_missing"));
    }
    const delegateId = delegateInput?.value.trim() || "";
    const delegateSelection = getDelegateSelectionPreview();
    const normalizedDelegateName = delegateId
      ? normalizeDelegateLabel(delegateSelection?.displayLabel || delegateId)
      : "";
    const passwordEnabled = !!passwordToggle?.checked;
    const passwordValue = passwordEnabled ? (passwordInput?.value || "").trim() : "";
    const addUsers = !!addUsersToggle?.checked;
    const addGuests = !!addGuestsToggle?.checked;
    setDelegateAlertLabel(normalizedDelegateName || delegateId || state.delegate.alertLabel || delegateInput?.value);
    return {
      title: titleInput.value.trim(),
      password: passwordEnabled ? (passwordValue || undefined) : undefined,
      enableLobby: !!lobbyToggle.checked,
      enableListable: !!listableToggle.checked,
      addUsers,
      addGuests,
      description: state.event?.description || "",
      startTimestamp: startTimestamp ?? null,
      eventConversation: type === "event",
      objectType: objectMeta?.objectType,
      objectId: objectMeta?.objectId,
      delegateId: delegateId || undefined,
      delegateName: normalizedDelegateName || undefined
    };
  }

  /**
   * Generate and insert a new password into the input.
   */
  async function handlePasswordGenerate(){
    if (!passwordInput || state.busy){
      return;
    }
    if (!passwordToggle?.checked){
      return;
    }
    const generated = await passwordPolicyActions.generate();
    passwordInput.value = generated;
    try{
      passwordInput.setSelectionRange(0, generated.length);
    }catch(error){
      logUiError("password selection range failed", error);
    }
    passwordInput.focus();
  }

  /**
   * Apply the create result to calendar metadata and description.
   * @param {object} payload
   * @param {object} result
   * @returns {Promise<void>}
   */
  async function applyCreateResult(payload, result){
    if (!result?.token || !result?.url){
      throw new Error(t("ui_create_failed", [t("talk_error_create_missing_data")]));
    }
    let cleanupRegistered = false;
    try{
      const delegationInfo = await handleDelegationAfterCreate(result, payload);
      const metadata = {
        token: result.token,
        url: result.url,
        lobbyEnabled: !!payload.enableLobby,
        startTimestamp: payload.startTimestamp ?? state.metadata?.startTimestamp ?? null,
        eventConversation: !!payload.eventConversation,
        addUsers: !!payload.addUsers,
        addGuests: !!payload.addGuests,
        objectId: payload.objectId || state.metadata?.objectId || null
      };
      if (payload.delegateId){
        metadata.delegateId = payload.delegateId;
        metadata.delegateName = payload.delegateName || payload.delegateId;
        metadata.delegated = delegationInfo.delegated || false;
        metadata.delegateReady = false;
      }
      const applyMetaResponse = await browser.runtime.sendMessage({
        type: "talk:applyMetadata",
        contextId: state.contextId,
        metadata
      });
      if (!applyMetaResponse?.ok){
        throw new Error(applyMetaResponse?.error || t("talk_error_apply_failed"));
      }
      await registerCreatedRoomCleanup(result.token, metadata);
      cleanupRegistered = true;

      const description = await composeDescription(state.event?.description || "", result.url, payload.password);
      if (!state.contextId){
        logDebug("missing contextId for talk:applyEventFields", {
          contextId: state.contextId
        });
        throw new Error(t("talk_error_context_reference"));
      }
      logDebug("send talk:applyEventFields", {
        contextId: state.contextId,
        title: payload.title,
        hasDescription: !!description?.text,
        hasDescriptionHtml: !!description?.html
      });
      const applyFieldsResponse = await browser.runtime.sendMessage({
        type: "talk:applyEventFields",
        contextId: state.contextId,
        fields: {
          title: payload.title,
          location: result.url,
          description: description?.text || "",
          ...(description?.html ? { descriptionHtml: description.html } : {})
        }
      });
      if (!applyFieldsResponse?.ok){
        throw new Error(applyFieldsResponse?.error || t("talk_error_apply_failed"));
      }
      // Re-apply metadata after field writes so X-NCTALK-* properties stay current.
      const reapplyMetaResponse = await browser.runtime.sendMessage({
        type: "talk:applyMetadata",
        contextId: state.contextId,
        metadata
      });
      if (!reapplyMetaResponse?.ok){
        throw new Error(reapplyMetaResponse?.error || t("talk_error_apply_failed"));
      }
      await releaseTalkContextAfterApply();
    }catch(error){
      if (!cleanupRegistered){
        await deleteCreatedRoomAfterApplyFailure(result.token);
      }
      throw error;
    }
  }

  async function registerCreatedRoomCleanup(token, metadata){
    const trackResponse = await browser.runtime.sendMessage({
      type: "talk:trackRoom",
      token,
      lobbyEnabled: metadata.lobbyEnabled,
      eventConversation: metadata.eventConversation,
      startTimestamp: metadata.startTimestamp ?? null
    });
    if (!trackResponse?.ok){
      throw new Error(trackResponse?.error || t("talk_error_apply_failed"));
    }
    const cleanupResponse = await browser.runtime.sendMessage({
      type: "talk:registerCleanup",
      contextId: state.contextId,
      token,
      keepContext: true,
      info: {
        objectId: metadata.objectId || null,
        eventConversation: metadata.eventConversation
      }
    });
    if (!cleanupResponse?.ok){
      throw new Error(cleanupResponse?.error || t("talk_error_apply_failed"));
    }
  }

  async function releaseTalkContextAfterApply(){
    const releaseResponse = await browser.runtime.sendMessage({
      type: "talk:releaseContext",
      contextId: state.contextId
    });
    if (!releaseResponse?.ok){
      logUiError("talk context release failed", new Error(releaseResponse?.error || "talk context release failed"));
    }
  }

  async function deleteCreatedRoomAfterApplyFailure(token){
    const deleteResponse = await browser.runtime.sendMessage({
      type: "talk:deleteRoom",
      token
    });
    if (!deleteResponse?.ok){
      logUiError("created room rollback failed", new Error(deleteResponse?.error || "talk room delete failed"));
    }
  }

  /**
   * Handle delegation flow after room creation.
   * @param {object} result
   * @param {object} payload
   * @returns {Promise<{delegated:boolean}>}
   */
  async function handleDelegationAfterCreate(result, payload){
    if (!payload.delegateId){
      return { delegated: false };
    }
    logDebug("handleDelegation payload", {
      delegateId: payload.delegateId,
      delegateName: payload.delegateName || "",
      mode: payload.eventConversation ? "event" : "standard"
    });
    const labelForAlert = getDelegateAlertLabel(payload);
    const msg = t("ui_alert_pending_delegation", [labelForAlert]);
    if (msg){
      await showDelegateNotice(msg, "info");
    }
    logDebug("delegation deferred to calendar flow", {
      token: result.token,
      delegateId: payload.delegateId
    });
    return { delegated: false };
  }

  /**
   * Validate password input and show errors if needed.
   * @returns {Promise<boolean>}
   */
  async function ensureValidPassword(){
    if (!passwordInput){
      return true;
    }
    if (!passwordToggle?.checked){
      passwordInput.value = "";
      return true;
    }
    const raw = passwordInput.value || "";
    const trimmed = raw.trim();
    const minLength = passwordPolicyActions.getMinLength();
    if (!trimmed){
      await showInlineModal({
        title: t("ui_password_error_title"),
        message: t("talk_password_policy_error", [String(minLength || 12)]),
        variant: "error",
        buttons: [
          { label: t("ui_button_ok"), role: "confirm", primary: true }
        ]
      });
      try{
        passwordInput.focus();
      }catch(error){
        logUiError("password focus failed (empty)", error);
      }
      return false;
    }
    if (minLength){
      if (trimmed.length < minLength){
        await showInlineModal({
          title: t("ui_password_error_title"),
          message: t("talk_password_policy_error", [String(minLength)]),
          variant: "error",
          buttons: [
            { label: t("ui_button_ok"), role: "confirm", primary: true }
          ]
        });
        try{
          passwordInput.focus();
          passwordInput.setSelectionRange(0, raw.length);
        }catch(error){
          logUiError("password focus/select failed (min length)", error);
        }
        return false;
      }
    } else if (!NCPasswordPolicyClient.isStrongPassword(trimmed)){
      await showInlineModal({
        title: t("ui_password_error_title"),
        message: t("talk_password_policy_error", ["12"]),
        variant: "error",
        buttons: [
          { label: t("ui_button_ok"), role: "confirm", primary: true }
        ]
      });
      try{
        passwordInput.focus();
        passwordInput.setSelectionRange(0, raw.length);
      }catch(error){
        logUiError("password focus/select failed (strength)", error);
      }
      return false;
    }
    passwordInput.value = trimmed;
    return true;
  }

  function ensureUnixSeconds(value){
    if (typeof value === "number" && Number.isFinite(value)){
      return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    return null;
  }

  /**
   * Build the event object metadata for Talk rooms.
   * @param {number|null} startTs
   * @param {number|null} endTs
   * @returns {{objectType:string,objectId:string}}
   */
  function buildEventObjectMetadata(startTs, endTs){
    if (state.metadata?.objectId){
      return { objectType: "event", objectId: state.metadata.objectId };
    }
    const start = ensureUnixSeconds(startTs);
    let stop = ensureUnixSeconds(endTs);
    if (stop != null && start != null && stop < start){
      stop = start;
    }
    if (start != null){
      const rangeEnd = stop != null ? stop : start;
      return { objectType: "event", objectId: `${start}#${rangeEnd}` };
    }
    return null;
  }

  /**
   * Compose the event description with Talk details.
   * @param {string} baseText
   * @param {string} url
   * @param {string} password
   * @returns {Promise<{text:string, html:string}>}
   */
  async function composeDescription(baseText, url, password){
    const clean = String(baseText || "").trim();
    let talkBlockText = "";
    let talkBlockHtml = "";
    let useHtml = false;
    try{
      const talkBlock = await buildPolicyAwareTalkDescription(url, password);
      talkBlockText = String(talkBlock?.text || "").trim();
      talkBlockHtml = String(talkBlock?.html || "").trim();
      useHtml = !!talkBlockHtml;
    }catch(error){
      logUiError("composeDescription buildPolicyAwareTalkDescription failed", error);
    }
    if (useHtml && !talkBlockText && talkBlockHtml){
      // Thunderbird persists rich calendar descriptions as HTML plus a plain-text
      // DESCRIPTION fallback. Keep the backend HTML untouched, but derive the
      // required text companion for storage and later re-opening.
      talkBlockText = htmlToPlainText(talkBlockHtml);
    }

    const textParts = [];
    if (clean){
      textParts.push(clean);
    }
    if (talkBlockText){
      textParts.push(talkBlockText);
    }

    const result = {
      text: textParts.join("\n\n").trim(),
      html: ""
    };
    if (!useHtml){
      return result;
    }

    const htmlParts = [];
    if (clean){
      htmlParts.push(plainTextToHtml(clean));
    }
    if (talkBlockHtml){
      htmlParts.push(talkBlockHtml);
    }
    result.html = htmlParts.join("\n").trim();
    return result;
  }

  /**
   * Build the Talk description block honoring backend policy values/templates.
   * @param {string} url
   * @param {string} password
   * @returns {Promise<{text:string,html:string}>}
   */
  async function buildPolicyAwareTalkDescription(url, password){
    const buildStandard = window.NCTalkCore && typeof window.NCTalkCore.buildStandardTalkDescription === "function"
      ? window.NCTalkCore.buildStandardTalkDescription
      : null;
    const policyLang = String(state.policy.descriptionLanguage || "").trim().toLowerCase();
    const descriptionType = normalizeEventDescriptionType(state.policy.descriptionType);
    const policyTemplate = String(state.policy.invitationTemplate || "");
    if (state.policy.active && policyLang === "custom" && policyTemplate){
      return renderTalkInvitationTemplate(policyTemplate, url, password, descriptionType);
    }
    if (!buildStandard){
      return { text:"", html:"" };
    }
    if (policyLang && policyLang !== "default" && policyLang !== "custom"){
      const text = await buildStandard(url, password, policyLang);
      return { text, html:"" };
    }
    const text = await buildStandard(url, password);
    return { text, html:"" };
  }

  /**
   * Render a custom invitation template with placeholder replacement.
   * @param {string} template
   * @param {string} meetingUrl
   * @param {string} password
   * @returns {{text:string,html:string}}
   */
  function renderTalkInvitationTemplate(template, meetingUrl, password, descriptionType = "plain_text"){
    const normalizedType = normalizeEventDescriptionType(descriptionType);
    if (normalizedType === "html"){
      const safeUrl = NCTalkTextUtils.escapeHtml(meetingUrl || "");
      const safePassword = NCTalkTextUtils.escapeHtml(password || "");
      const rawHtml = String(template || "")
        .split("{MEETING_URL}").join(safeUrl)
        .split("{PASSWORD}").join(safePassword);
      if (typeof window.NCHtmlSanitizer?.sanitizeTalkTemplateHtml !== "function"){
        logUiError("talk template sanitizer unavailable", "talk_template_sanitizer_unavailable");
        throw new Error("talk_template_sanitizer_unavailable");
      }
      const html = window.NCHtmlSanitizer.sanitizeTalkTemplateHtml(rawHtml);
      return {
        text: htmlToPlainText(html),
        html: html.trim()
      };
    }
    return {
      text: String(template || "")
        .split("{MEETING_URL}").join(meetingUrl || "")
        .split("{PASSWORD}").join(password || "")
        .trim(),
      html: ""
    };
  }

  /**
   * Convert plain text paragraphs into lightweight HTML for the rich event editor.
   * @param {string} value
   * @returns {string}
   */
  function plainTextToHtml(value){
    if (typeof window.NCHtmlSanitizer?.plainTextToHtml === "function"){
      return window.NCHtmlSanitizer.plainTextToHtml(value);
    }
    const normalized = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!normalized){
      return "";
    }
    const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    return paragraphs.map((part) => {
      const escaped = NCTalkTextUtils.escapeHtml(part).replace(/\n/g, "<br>");
      return `<p>${escaped}</p>`;
    }).join("\n");
  }

  /**
   * Convert lightweight HTML into a plain-text fallback for Thunderbird's
   * DESCRIPTION storage.
   * @param {string} value
   * @returns {string}
   */
  function htmlToPlainText(value){
    if (typeof window.NCHtmlSanitizer?.htmlToPlainText === "function"){
      return window.NCHtmlSanitizer.htmlToPlainText(value);
    }
    const html = String(value || "").trim();
    if (!html){
      return "";
    }
    const parser = typeof DOMParser === "function" ? new DOMParser() : null;
    if (!parser){
      return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\u00A0/g, " ")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    const doc = parser.parseFromString(html, "text/html");
    for (const br of doc.body.querySelectorAll("br")){
      br.replaceWith("\n");
    }
    for (const block of doc.body.querySelectorAll("p,div,section,article,li,tr,h1,h2,h3,h4,h5,h6")){
      if (block.lastChild?.nodeValue !== "\n"){
        block.append("\n");
      }
    }
    return String(doc.body.textContent || "")
      .replace(/\u00A0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Initialize the delegate selection field interactions.
   */
  function initDelegateField(){
    if (!delegateInput){
      return;
    }
    delegateInput.addEventListener("focus", () => {
      if (!delegateInput.value){
        state.delegate.selected = null;
        updateDelegateSelectedDisplay();
      }
      scheduleDelegateSearch(delegateInput.value.trim());
    });
    delegateInput.addEventListener("input", () => {
      state.delegate.selected = null;
      updateDelegateSelectedDisplay();
      setDelegateAlertLabel(delegateInput.value);
      scheduleDelegateSearch(delegateInput.value.trim());
    });
    delegateInput.addEventListener("keydown", handleDelegateKeyDown);
    delegateInput.addEventListener("blur", () => {
      window.setTimeout(() => hideDelegateDropdown(true), 120);
    });
    delegateClearBtn?.addEventListener("click", () => {
      if (state.busy){
        return;
      }
      delegateInput.value = "";
      state.delegate.selected = null;
      updateDelegateSelectedDisplay();
      updateDelegateStatus("");
      setDelegateAlertLabel("");
      scheduleDelegateSearch("");
      delegateInput.focus();
    });
    document.addEventListener("mousedown", (event) => {
      if (!delegateSection?.contains(event.target)){
        hideDelegateDropdown(true);
      }
    }, true);
    scheduleDelegateSearch("");
  }

  /**
   * Populate delegate UI fields from stored metadata.
   * @param {object} meta
   */
  function hydrateDelegateFromMetadata(meta){
    if (!delegateInput){
      return;
    }
    const delegateId = meta?.delegateId || "";
    const delegateName = meta?.delegateName || "";
    delegateInput.value = delegateId || "";
    if (delegateId || delegateName){
      state.delegate.selected = {
        id: delegateId || delegateName,
        email: "",
        avatarDataUrl: "",
        displayLabel: delegateName || delegateId,
        initials: computeInitials(delegateName || delegateId)
      };
    }else{
      state.delegate.selected = null;
    }
    setDelegateAlertLabel(delegateName || delegateId || "");
    updateDelegateSelectedDisplay();
    updateDelegateStatus("");
  }

  function updateDelegateStatus(text = "", isError = false){
    if (!delegateStatus){
      return;
    }
    delegateStatus.textContent = text || "";
    delegateStatus.style.color = isError ? "#b00020" : "#5a5a5a";
  }

  /**
   * Debounce delegate search requests.
   * @param {string} term
   */
  function scheduleDelegateSearch(term){
    if (!delegateInput){
      return;
    }
    if (state.systemAddressbook.checked && !state.systemAddressbook.available){
      updateDelegateStatus("");
      hideDelegateDropdown(true);
      return;
    }
    if (state.delegate.searchTimer){
      window.clearTimeout(state.delegate.searchTimer);
    }
    state.delegate.searchTimer = window.setTimeout(() => performDelegateSearch(term), 250);
  }

  /**
   * Search for delegates and render suggestions.
   * @param {string} term
   * @returns {Promise<void>}
   */
  async function performDelegateSearch(term){
    if (!delegateInput){
      return;
    }
    if (state.systemAddressbook.checked && !state.systemAddressbook.available){
      updateDelegateStatus("");
      hideDelegateDropdown(true);
      return;
    }
    state.delegate.searchTimer = null;
    const seq = ++state.delegate.searchSeq;
    const trimmed = (term || "").trim();
    updateDelegateStatus(trimmed
      ? t("ui_delegate_status_searching")
      : t("ui_delegate_status_loading"));
    try{
      const response = await browser.runtime.sendMessage({
        type: "talk:searchUsers",
        payload: { searchTerm: trimmed, limit: 200 }
      });
      if (seq !== state.delegate.searchSeq){
        return;
      }
      applySystemAddressbookAvailability(true, "");
      let items = [];
      if (response){
        if (response.ok && Array.isArray(response.users)){
          items = response.users;
        }else if (Array.isArray(response.result)){
          items = response.result;
        }else if (response.error){
          throw new Error(response.error);
        }
      }
      const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      const normalized = items
        .map((item) => {
          if (!item){
            return null;
          }
          const rawId = typeof item.id === "string" ? item.id.trim() : "";
          const rawLabel = typeof item.label === "string" ? item.label.trim() : "";
          const rawEmail = typeof item.email === "string" ? item.email.trim() : "";
          const id = rawId || rawEmail || rawLabel;
          if (!id){
            return null;
          }
          const email = emailPattern.test(rawEmail) ? rawEmail : "";
          const label = rawLabel || rawId || rawEmail || id;
          const displayLabel = formatDelegateDisplay(label, email) || label || id;
          return {
            id,
            email,
            avatarDataUrl: item.avatarDataUrl || "",
            displayLabel,
            initials: computeInitials(label || id)
          };
        })
        .filter(Boolean);
      const termLower = trimmed.toLowerCase();
      const filtered = termLower
        ? normalized.filter((entry) => {
          const idLower = entry.id.toLowerCase();
          const labelLower = (entry.displayLabel || "").toLowerCase();
          const emailLower = (entry.email || "").toLowerCase();
          return idLower.includes(termLower) || labelLower.includes(termLower) || emailLower.includes(termLower);
        })
        : normalized;
      state.delegate.suggestions = filtered;
      state.delegate.activeIndex = filtered.length ? 0 : -1;
      if (!filtered.length){
        updateDelegateStatus(trimmed
          ? t("ui_delegate_status_none_with_email")
          : t("ui_delegate_status_none_found"));
        hideDelegateDropdown(true);
        return;
      }
      const summary = filtered.length === 1
        ? t("ui_delegate_status_single")
        : t("ui_delegate_status_many", [filtered.length]);
      updateDelegateStatus(summary);
      renderDelegateDropdown();
    }catch(error){
      if (seq !== state.delegate.searchSeq){
        logUiError("delegate search failed (stale request)", error);
        return;
      }
      const detail = t("talk_system_addressbook_required_message");
      logUiError("delegate search unavailable", error);
      applySystemAddressbookAvailability(false, detail);
      updateDelegateStatus("");
      state.delegate.suggestions = [];
      hideDelegateDropdown(true);
    }
  }

  /**
   * Apply system-addressbook availability to Talk controls.
   * @param {boolean} available
   * @param {string} detail
   */
  function applySystemAddressbookAvailability(available, detail = ""){
    const lockActive = !available;
    const usersPolicyLock = NCPolicyState.isEditableLocked(state.policy.active, state.policy.editable, "talk_add_users");
    const guestsPolicyLock = NCPolicyState.isEditableLocked(state.policy.active, state.policy.editable, "talk_add_guests");
    const usersLockActive = lockActive || usersPolicyLock;
    const guestsLockActive = lockActive || guestsPolicyLock;
    const adminHint = NCWizardPolicyUi.getAdminControlledHint(wizardTranslate);
    state.systemAddressbook.checked = true;
    state.systemAddressbook.available = !!available;
    state.systemAddressbook.error = lockActive
      ? (detail || t("talk_system_addressbook_required_message"))
      : "";

    if (addUsersToggle){
      if (lockActive){
        addUsersToggle.checked = false;
      }
      addUsersToggle.disabled = usersLockActive;
      addUsersToggle.title = lockActive
        ? state.systemAddressbook.error
        : (usersPolicyLock ? adminHint : "");
    }
    if (addGuestsToggle){
      if (lockActive){
        addGuestsToggle.checked = false;
      }
      addGuestsToggle.disabled = guestsLockActive;
      addGuestsToggle.title = lockActive
        ? state.systemAddressbook.error
        : (guestsPolicyLock ? adminHint : "");
    }
    if (delegateInput){
      delegateInput.disabled = lockActive;
    }
    if (delegateClearBtn){
      delegateClearBtn.disabled = lockActive;
    }
    if (addUsersAddressbookLockHint){
      addUsersAddressbookLockHint.textContent = state.systemAddressbook.error || t("talk_system_addressbook_required_message");
    }
    if (addGuestsAddressbookLockHint){
      addGuestsAddressbookLockHint.textContent = state.systemAddressbook.error || t("talk_system_addressbook_required_message");
    }
    if (delegateAddressbookLockHint){
      delegateAddressbookLockHint.textContent = state.systemAddressbook.error || t("talk_system_addressbook_required_message");
    }
    window.NCAddressbookUi?.applySystemAddressbookTooltipState(addUsersTooltipList, lockActive);
    window.NCAddressbookUi?.applySystemAddressbookTooltipState(addGuestsTooltipList, lockActive);
    window.NCAddressbookUi?.applySystemAddressbookTooltipState(delegateTooltipList, lockActive);
    if (delegateAddressbookHelp){
      delegateAddressbookHelp.hidden = !lockActive;
    }
    if (addUsersToggleRow){
      addUsersToggleRow.classList.toggle("is-disabled", usersLockActive);
      addUsersToggleRow.title = lockActive
        ? state.systemAddressbook.error
        : (usersPolicyLock ? adminHint : "");
    }
    if (addGuestsToggleRow){
      addGuestsToggleRow.classList.toggle("is-disabled", guestsLockActive);
      addGuestsToggleRow.title = lockActive
        ? state.systemAddressbook.error
        : (guestsPolicyLock ? adminHint : "");
    }
    if (delegateInputLabel){
      delegateInputLabel.classList.toggle("is-disabled", lockActive);
      delegateInputLabel.title = lockActive ? state.systemAddressbook.error : "";
    }
    if (lockActive){
      updateDelegateStatus("");
    }
    if (lockActive){
      state.delegate.suggestions = [];
      state.delegate.activeIndex = -1;
      hideDelegateDropdown(true);
    }
    popupSizer?.scheduleSizeUpdate();
  }

  /**
   * Query background for current system-addressbook reachability.
   * @param {{forceRefresh?:boolean}} options
   * @returns {Promise<boolean>}
   */
  async function refreshSystemAddressbookAvailability(options = {}){
    const forceRefresh = !!options.forceRefresh;
    try{
      const response = await browser.runtime.sendMessage({
        type: "talk:getSystemAddressbookStatus",
        payload: { forceRefresh }
      });
      const status = response?.status || {};
      const available = !!(response?.ok && status.available !== false);
      const detail = available ? "" : t("talk_system_addressbook_required_message");
      if (!available && (status.error || response?.error)){
        logUiError("system addressbook unavailable", status.error || response.error);
      }
      applySystemAddressbookAvailability(available, detail);
      logDebug("system addressbook status", {
        available,
        count: Number.isFinite(status.count) ? status.count : 0,
        hasError: !!detail
      });
      return available;
    }catch(error){
      logUiError("system addressbook status failed", error);
      applySystemAddressbookAvailability(false, t("talk_system_addressbook_required_message"));
      return false;
    }
  }

  function renderDelegateDropdown(){
    if (!delegateDropdown || !delegateInput){
      return;
    }
    delegateDropdown.textContent = "";
    if (!state.delegate.suggestions.length || document.activeElement !== delegateInput){
      hideDelegateDropdown(true);
      return;
    }
    state.delegate.visible = true;
    delegateDropdown.style.display = "block";
    state.delegate.suggestions.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "row" + (index === state.delegate.activeIndex ? " active" : "");
      row.dataset.index = String(index);
      const avatar = document.createElement("div");
      avatar.className = "row-avatar";
      if (item.avatarDataUrl){
        const img = document.createElement("img");
        img.src = item.avatarDataUrl;
        img.style.display = "block";
        avatar.appendChild(img);
      }else if (item.initials){
        avatar.textContent = item.initials;
      }else{
        avatar.style.visibility = "hidden";
      }
      const textBox = document.createElement("div");
      textBox.className = "row-text";
      const primary = document.createElement("div");
      primary.className = "primary";
      primary.textContent = item.displayLabel || item.id;
      textBox.appendChild(primary);
      if (item.email && item.email !== item.displayLabel){
        const secondary = document.createElement("div");
        secondary.className = "secondary";
        secondary.textContent = item.email;
        textBox.appendChild(secondary);
      }
      row.appendChild(avatar);
      row.appendChild(textBox);
      row.addEventListener("mouseenter", () => {
        state.delegate.activeIndex = index;
        updateDelegateRowHighlight();
      });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectDelegateSuggestion(index);
      });
      row.addEventListener("click", (event) => {
        event.preventDefault();
        selectDelegateSuggestion(index);
      });
      delegateDropdown.appendChild(row);
    });
    updateDelegateRowHighlight();
  }

  function updateDelegateRowHighlight(){
    if (!delegateDropdown){
      return;
    }
    const rows = delegateDropdown.querySelectorAll(".row");
    rows.forEach((row) => {
      const idx = Number(row.dataset.index);
      if (idx === state.delegate.activeIndex){
        row.classList.add("active");
      }else{
        row.classList.remove("active");
      }
    });
  }

  function hideDelegateDropdown(resetActive){
    if (!delegateDropdown){
      return;
    }
    delegateDropdown.style.display = "none";
    state.delegate.visible = false;
    if (resetActive){
      state.delegate.activeIndex = -1;
    }
  }

  function handleDelegateKeyDown(event){
    if (!state.delegate.visible || !state.delegate.suggestions.length){
      return;
    }
    if (event.key === "ArrowDown"){
      event.preventDefault();
      const count = state.delegate.suggestions.length;
      state.delegate.activeIndex = (state.delegate.activeIndex + 1 + count) % count;
      updateDelegateRowHighlight();
    }else if (event.key === "ArrowUp"){
      event.preventDefault();
      const count = state.delegate.suggestions.length;
      state.delegate.activeIndex = (state.delegate.activeIndex - 1 + count) % count;
      updateDelegateRowHighlight();
    }else if (event.key === "Enter"){
      event.preventDefault();
      if (state.delegate.activeIndex >= 0){
        selectDelegateSuggestion(state.delegate.activeIndex);
      }
    }else if (event.key === "Escape"){
      hideDelegateDropdown(true);
    }
  }

  function selectDelegateSuggestion(index){
    const suggestion = state.delegate.suggestions[index];
    if (!suggestion || !delegateInput){
      return;
    }
    delegateInput.value = suggestion.id;
    state.delegate.selected = suggestion;
    setDelegateAlertLabel(suggestion.displayLabel || suggestion.email || suggestion.id || "");
    hideDelegateDropdown(true);
    updateDelegateSelectedDisplay();
    updateDelegateStatus("");
    logDebug("delegate selected", {
      id: suggestion.id,
      label: suggestion.displayLabel || "",
      email: suggestion.email || ""
    });
    try{
      const len = delegateInput.value.length;
      delegateInput.setSelectionRange?.(len, len);
    }catch(error){
      logUiError("delegate selection range failed", error);
    }
  }

  function formatDelegateDisplay(label, email){
    if (label && email && label !== email){
      return `${label} <${email}>`;
    }
    return label || email || "";
  }

  function computeInitials(source){
    const text = (source || "").trim();
    if (!text){
      return "";
    }
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length === 1){
      return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }

  function normalizeDelegateLabel(value){
    if (typeof value === "string"){
      const trimmed = value.trim();
      if (trimmed){
        const lowered = trimmed.toLowerCase();
        if (lowered === "null" || lowered === "undefined"){
          return "";
        }
        return trimmed;
      }
    }
    return "";
  }

  function setDelegateAlertLabel(value){
    state.delegate.alertLabel = normalizeDelegateLabel(value) || "";
  }

  /**
   * Resolve a label for delegation alert dialogs.
   * @param {object} payload
   * @returns {string}
   */
  function getDelegateAlertLabel(payload){
    const fallback = t("ui_delegate_selected_title");
    const candidates = [
      state.delegate.alertLabel,
      payload?.delegateName,
      payload?.delegateId,
      state.delegate.selected?.displayLabel,
      state.delegate.selected?.email,
      state.delegate.selected?.id,
      delegateInput?.value
    ];
    for (const candidate of candidates){
      const normalized = normalizeDelegateLabel(candidate);
      if (normalized){
        return normalized;
      }
    }
    return fallback;
  }

  function updateDelegateSelectedDisplay(){
    if (!delegateSelected || !delegateAvatarImg || !delegateAvatarInitials || !delegateSelectedName || !delegateSelectedMeta){
      return;
    }
    const selection = getDelegateSelectionPreview();
    if (!selection){
      delegateSelected.hidden = true;
      delegateAvatarImg.style.display = "none";
      delegateAvatarInitials.style.display = "none";
      delegateAvatarInitials.textContent = "";
      delegateSelectedName.textContent = "";
      delegateSelectedMeta.textContent = "";
      if (delegateSelectedDescription){
        delegateSelectedDescription.textContent = "";
      }
      return;
    }
    delegateSelected.hidden = false;
    delegateSelectedName.textContent = selection.displayLabel || selection.id || "";
    const metaLine = selection.email && selection.email !== selection.displayLabel ? selection.email : "";
    delegateSelectedMeta.textContent = metaLine;
    if (delegateSelectedDescription){
      delegateSelectedDescription.textContent = t("ui_delegate_selected_description");
    }
    if (selection.avatarDataUrl){
      delegateAvatarImg.src = selection.avatarDataUrl;
      delegateAvatarImg.style.display = "block";
      delegateAvatarInitials.style.display = "none";
      delegateAvatarInitials.textContent = "";
    }else if (selection.initials){
      delegateAvatarImg.style.display = "none";
      delegateAvatarInitials.style.display = "block";
      delegateAvatarInitials.textContent = selection.initials;
    }else{
      delegateAvatarImg.style.display = "none";
      delegateAvatarInitials.style.display = "none";
      delegateAvatarInitials.textContent = "";
    }
  }

  /**
   * Build a preview object for the current delegate selection.
   * @returns {object|null}
   */
  function getDelegateSelectionPreview(){
    if (state.delegate.selected){
      return state.delegate.selected;
    }
    if (!delegateInput){
      return null;
    }
    const raw = delegateInput.value.trim();
    if (!raw){
      return null;
    }
    const email = raw.includes("@") ? raw : "";
    return {
      id: raw,
      email,
      avatarDataUrl: "",
      displayLabel: raw,
      initials: computeInitials(raw)
    };
  }

  /**
   * Show a delegate notice dialog.
   * @param {string} message
   * @param {string} variant
   * @returns {Promise<string>}
   */
  function showDelegateNotice(message, variant = "info"){
    if (!message){
      return Promise.resolve();
    }
    const title = t("ui_delegate_modal_title");
    return showInlineModal({
      title,
      message,
      variant,
      buttons: [
        { label: t("ui_button_cancel"), role: "cancel", className: "secondary" },
        { label: t("ui_button_ok"), role: "confirm", primary: true }
      ]
    });
  }

  /**
   * Show an inline modal dialog and resolve when closed.
   * @param {{title:string,message:string,variant?:string,buttons?:Array}} options
   * @returns {Promise<string>}
   */
  function showInlineModal({ title, message, variant = "info", buttons }){
    const finalButtons = Array.isArray(buttons) && buttons.length
      ? buttons
      : [{ label: t("ui_button_ok"), role: "confirm", primary: true }];
    return new Promise((resolve) => {
      try{
        const overlay = document.createElement("div");
        overlay.className = "delegate-modal-overlay";
        if (variant){
          overlay.dataset.variant = variant;
        }
        overlay.tabIndex = -1;
        const modal = document.createElement("div");
        modal.className = "delegate-modal";
        modal.setAttribute("role", "alertdialog");
        modal.setAttribute("aria-modal", "true");
        const heading = document.createElement("div");
        heading.className = "delegate-modal-title";
        heading.textContent = title || "";
        const text = document.createElement("div");
        text.className = "delegate-modal-text";
        text.textContent = message || "";
        const actions = document.createElement("div");
        actions.className = "delegate-modal-actions";
        const existing = document.body.querySelector(".delegate-modal-overlay");
        if (existing){
          existing.remove();
        }
        const previousActive = document.activeElement;
        /**
         * Tear down the modal and resolve with a result.
         * @param {string} result
         */
        const cleanup = (result) => {
          overlay.removeEventListener("keydown", keyHandler, true);
          overlay.removeEventListener("click", overlayHandler);
          overlay.remove();
          if (previousActive && typeof previousActive.focus === "function"){
            try{
              previousActive.focus();
            }catch(error){
              logUiError("modal restore focus failed", error);
            }
          }
          resolve(result);
        };
        /**
         * Handle keyboard shortcuts for the modal.
         * @param {KeyboardEvent} event
         */
        const keyHandler = (event) => {
          if (event.key === "Escape"){
            event.preventDefault();
            cleanup("dismiss");
          }else if (event.key === "Enter"){
            const primaryBtn = actions.querySelector("button.primary");
            if (primaryBtn){
              event.preventDefault();
              primaryBtn.click();
            }
          }
        };
        const overlayHandler = (event) => {
          if (event.target === overlay){
            cleanup("dismiss");
          }
        };
        finalButtons.forEach((btn) => {
          const button = document.createElement("button");
          button.type = "button";
          const classes = ["modal-btn"];
          if (btn.primary){
            classes.push("primary");
          }else{
            classes.push("secondary");
          }
          if (btn.className){
            classes.push(btn.className);
          }
          button.className = classes.join(" ");
          button.textContent = btn.label || "";
          button.addEventListener("click", () => cleanup(btn.role || "confirm"));
          actions.appendChild(button);
        });
        modal.appendChild(heading);
        modal.appendChild(text);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        overlay.addEventListener("keydown", keyHandler, true);
        overlay.addEventListener("click", overlayHandler);
        document.body.appendChild(overlay);
        window.setTimeout(() => {
          try{
            const focusTarget = actions.querySelector("button.primary") || actions.querySelector("button");
            focusTarget?.focus();
          }catch(error){
            logUiError("modal initial focus failed", error);
          }
        }, 0);
      }catch(error){
        logUiError("inline modal failed", error);
        try{
          window.alert?.(message);
        }catch(error){
          logUiError("window.alert fallback failed", error);
        }
        resolve("fallback");
      }
    });
  }

  function getContentHeight(){
    try{
      const rect = dialogRoot?.getBoundingClientRect?.();
      if (rect && rect.height){
        const styles = window.getComputedStyle(document.body);
        const paddingTop = parseFloat(styles?.paddingTop || "0") || 0;
        const paddingBottom = parseFloat(styles?.paddingBottom || "0") || 0;
        return Math.max(MIN_CONTENT_HEIGHT, Math.ceil(rect.height + paddingTop + paddingBottom));
      }
    }catch(error){
      logUiError("content height measure failed", error);
    }
    const fallback = document.documentElement?.scrollHeight || document.body?.scrollHeight || MIN_CONTENT_HEIGHT;
    return Math.max(MIN_CONTENT_HEIGHT, fallback);
  }

  function setMessage(text, isError){
    if (!messageBar){
      return;
    }
    messageBar.textContent = text || "";
    messageBar.style.color = isError ? "#b00020" : "#1f1f1f";
  }

  function cleanupPageResources(){
    if (isPageUnloading){
      return;
    }
    NCDebugForwarder.markRuntimeContextUnloading?.();
    isPageUnloading = true;
    disposeDebugFlagMirror?.();
    disposeDebugFlagMirror = null;
    state.debugEnabled = false;
    if (popupSizer){
      window.removeEventListener("resize", popupSizer.scheduleSizeUpdate);
    }
    if (layoutObserver){
      layoutObserver.disconnect();
      layoutObserver = null;
    }
    window.removeEventListener("pagehide", cleanupPageResources, true);
    window.removeEventListener("beforeunload", cleanupPageResources, true);
    window.removeEventListener("unload", cleanupPageResources, true);
  }

  /**
   * Flush pending debug forwards and close the dialog window.
   * @returns {Promise<void>}
   */
  async function closeDialogWindow(){
    NCDebugForwarder.markRuntimeContextUnloading?.();
    cleanupPageResources();
    try{
      await NCDebugForwarder.flushPendingDebugLogs?.(120);
    }catch(error){
      logUiError("debug log flush failed", error);
    }
    window.close();
  }

  function logDebug(label, data){
    emitDebugLog(label, data || "");
  }
})();
