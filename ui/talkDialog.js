/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(() => {
  "use strict";

  const POPUP_CONTENT_WIDTH = 520;
  const MIN_CONTENT_HEIGHT = 0;
  const CONTENT_MARGIN = 0;
  let layoutObserver = null;
  const dialogRoot = document.querySelector(".dialog");
  const popupSizer = window.NCTalkPopupSizing?.createPopupSizer({
    fixedWidth: POPUP_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    margin: CONTENT_MARGIN,
    getContentHeight: () => getContentHeight()
  });

  const LOG_PREFIX = "[NCUI][Talk]";
  const params = new URLSearchParams(window.location.search);
  const contextId = (params.get("contextId") || "").trim();
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
  const messageBar = document.getElementById("messageBar");
  const okBtn = document.getElementById("okBtn");
  const cancelBtn = document.getElementById("cancelBtn");

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
    }catch(_){ }
    return fallback || "";
  };

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
    }
  };

  (async () => {
    try{
      const stored = await browser.storage.local.get(["debugEnabled"]);
      state.debugEnabled = !!stored.debugEnabled;
      logDebug("popup init", {
        contextId: state.contextId || ""
      });
    }catch(_){ }
  })();
  try{
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.prototype.hasOwnProperty.call(changes, "debugEnabled")){
        state.debugEnabled = !!changes.debugEnabled.newValue;
      }
    });
  }catch(_){ }

  if (passwordInput){
    passwordInput.setAttribute("placeholder", t("ui_create_password_placeholder"));
  }

  bindEvents();
  if (!state.contextId){
    setMessage(t("talk_error_context_id_missing"), true);
  }else{
    init();
  }
  if (popupSizer){
    popupSizer.scheduleSizeUpdate();
    window.addEventListener("load", popupSizer.scheduleSizeUpdate, { once:true });
    window.addEventListener("resize", popupSizer.scheduleSizeUpdate);
    if (typeof ResizeObserver === "function"){
      layoutObserver = new ResizeObserver(() => popupSizer.scheduleSizeUpdate());
      layoutObserver.observe(document.documentElement || document.body);
    }
  }

  /**
   * Attach UI event handlers for the dialog.
   */
  function bindEvents(){
    okBtn?.addEventListener("click", handleOk);
    cancelBtn?.addEventListener("click", () => {
      if (!state.busy){
        window.close();
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
        }catch(_){ }
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
      await loadPasswordPolicy();
      await loadSnapshot();
    }catch(error){
      setMessage(error?.message || String(error), true);
    }
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
      const rawTitle = (stored.talkDefaultTitle || "").trim();
      if (rawTitle){
        defaults.title = rawTitle;
      }
      if (typeof stored.talkDefaultLobby === "boolean"){
        defaults.lobby = stored.talkDefaultLobby;
      }
      if (typeof stored.talkDefaultListable === "boolean"){
        defaults.listable = stored.talkDefaultListable;
      }
      if (typeof stored.talkAddUsersDefaultEnabled === "boolean"){
        defaults.addUsersEnabled = stored.talkAddUsersDefaultEnabled;
      }
      if (typeof stored.talkAddGuestsDefaultEnabled === "boolean"){
        defaults.addGuestsEnabled = stored.talkAddGuestsDefaultEnabled;
      }
      if (typeof stored.talkAddParticipantsDefaultEnabled === "boolean"
        && typeof stored.talkAddUsersDefaultEnabled !== "boolean"
        && typeof stored.talkAddGuestsDefaultEnabled !== "boolean"){
        defaults.addUsersEnabled = stored.talkAddParticipantsDefaultEnabled;
        defaults.addGuestsEnabled = stored.talkAddParticipantsDefaultEnabled;
      }
      if (typeof stored.talkPasswordDefaultEnabled === "boolean"){
        defaults.passwordEnabled = stored.talkPasswordDefaultEnabled;
      }
      if (stored.talkDefaultRoomType === "normal"){
        defaults.roomType = "normal";
      }else if (stored.talkDefaultRoomType === "event"){
        defaults.roomType = "event";
      }
    }catch(error){
      console.error(LOG_PREFIX, "load defaults failed", error);
    }
    return defaults;
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
    }catch(error){
      console.error(LOG_PREFIX, "password policy fetch failed", error);
      state.passwordPolicy = { hasPolicy:false, minLength:null, apiGenerateUrl:null, apiValidateUrl:null };
    }
    return state.passwordPolicy;
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
   * Apply password toggle state to the UI.
   * @param {boolean} enabled
   */
  function applyPasswordToggleState(enabled){
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
      passwordInput.value = await generatePasswordFromPolicy();
    }
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
    }catch(error){
      console.error(LOG_PREFIX, "password generate failed", error);
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
    const pwd = String(value || "");
    return pwd.length >= 12
      && /[A-Z]/.test(pwd)
      && /[a-z]/.test(pwd)
      && /[0-9]/.test(pwd)
      && /[!@#$%^&*()\-_=+\[\]{};:,.?]/.test(pwd);
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
      setMessage(error?.message || String(error), true);
    }
  }

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
    if (titleInput){
      titleInput.value = eventTitle || metaTitle || fallbackTitle;
    }

    const lobbyValue = meta.lobbyEnabled;
    const listableValue = meta.listable;
    const eventValue = meta.eventConversation;
    const addUsersValue = meta.addUsers;
    const addGuestsValue = meta.addGuests;
    if (lobbyToggle){
      lobbyToggle.checked = lobbyValue == null ? !!effectiveDefaults.lobby : !!lobbyValue;
    }
    if (listableToggle){
      listableToggle.checked = listableValue == null ? !!effectiveDefaults.listable : !!listableValue;
    }
    if (addUsersToggle){
      addUsersToggle.checked = addUsersValue == null
        ? !!effectiveDefaults.addUsersEnabled
        : !!addUsersValue;
    }
    if (addGuestsToggle){
      addGuestsToggle.checked = addGuestsValue == null
        ? !!effectiveDefaults.addGuestsEnabled
        : !!addGuestsValue;
    }
    const eventMode = eventValue == null ? effectiveDefaults.roomType !== "normal" : !!eventValue;
    setRoomTypeValue(eventMode ? "event" : "normal", { closeDropdown:false });
      if (passwordToggle){
        const enabled = effectiveDefaults.passwordEnabled !== false;
        passwordToggle.checked = enabled;
        applyPasswordToggleState(enabled);
        if (enabled && passwordInput && !passwordInput.value && state.passwordPolicy){
          generatePasswordFromPolicy().then((pwd) => {
            if (pwd && passwordInput && !passwordInput.value){
              passwordInput.value = pwd;
            }
          }).catch(() => {});
        }
      }
      hydrateDelegateFromMetadata(meta);
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
      window.close();
    }catch(error){
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
    const objectMeta = buildEventObjectMetadata(startTimestamp, endTimestamp);
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
      objectType: type === "event" ? objectMeta.objectType : undefined,
      objectId: type === "event" ? objectMeta.objectId : undefined,
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
    const generated = await generatePasswordFromPolicy();
    passwordInput.value = generated;
    try{
      passwordInput.setSelectionRange(0, generated.length);
    }catch(_){ }
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
      hasDescription: !!description
    });
    const applyFieldsResponse = await browser.runtime.sendMessage({
      type: "talk:applyEventFields",
      contextId: state.contextId,
      fields: {
        title: payload.title,
        location: result.url,
        description
      }
    });
    if (!applyFieldsResponse?.ok){
      throw new Error(applyFieldsResponse?.error || t("talk_error_apply_failed"));
    }
    await browser.runtime.sendMessage({
      type: "talk:trackRoom",
      token: result.token,
      lobbyEnabled: metadata.lobbyEnabled,
      eventConversation: metadata.eventConversation,
      startTimestamp: metadata.startTimestamp ?? null
    });
    const cleanupResponse = await browser.runtime.sendMessage({
      type: "talk:registerCleanup",
      contextId: state.contextId,
      token: result.token,
      info: {
        objectId: metadata.objectId || null,
        eventConversation: metadata.eventConversation,
        fallback: !!result.fallback
      }
    });
    if (!cleanupResponse?.ok){
      throw new Error(cleanupResponse?.error || t("talk_error_apply_failed"));
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
    const minLength = getPolicyMinLength();
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
      }catch(_){ }
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
        }catch(_){ }
        return false;
      }
    } else if (!isStrongPassword(trimmed)){
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
      }catch(_){ }
      return false;
    }
    passwordInput.value = trimmed;
    return true;
  }

  /**
   * Normalize a timestamp to unix seconds.
   * @param {number} value
   * @returns {number|null}
   */
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
    const seed = [state.event?.title || "", Date.now(), Math.random()].join("|");
    return { objectType: "event", objectId: `tb-${hashStringToHex(seed)}` };
  }

  /**
   * Hash a string into a short hex identifier.
   * @param {string} value
   * @returns {string}
   */
  function hashStringToHex(value){
    const input = String(value ?? "");
    let hash = 0;
    for (let i = 0; i < input.length; i++){
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  /**
   * Compose the event description with Talk details.
   * @param {string} baseText
   * @param {string} url
   * @param {string} password
   * @returns {Promise<string>}
   */
  async function composeDescription(baseText, url, password){
    const parts = [];
    const clean = (baseText || "").trim();
    if (clean){
      parts.push(clean);
    }
    const buildStandard = window.NCTalkCore && typeof window.NCTalkCore.buildStandardTalkDescription === "function"
      ? window.NCTalkCore.buildStandardTalkDescription
      : null;
    if (buildStandard){
      try{
        parts.push(await buildStandard(url, password));
      }catch(_){}
    }
    return parts.join("\n\n").trim();
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

  /**
   * Update the delegate status hint line.
   * @param {string} text
   * @param {boolean} isError
   */
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
        return;
      }
      console.error("[NCUI][Talk] delegate search failed", error);
      updateDelegateStatus(error?.message || t("ui_delegate_status_error"), true);
      state.delegate.suggestions = [];
      hideDelegateDropdown(true);
    }
  }

  /**
   * Render the delegate suggestions dropdown.
   */
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

  /**
   * Update the active highlight row in the dropdown.
   */
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

  /**
   * Hide the delegate dropdown menu.
   * @param {boolean} resetActive
   */
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

  /**
   * Handle keyboard navigation for delegate suggestions.
   * @param {KeyboardEvent} event
   */
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

  /**
   * Select a delegate suggestion by index.
   * @param {number} index
   */
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
    }catch(_){ }
  }

  /**
   * Build a display label for a delegate entry.
   * @param {string} label
   * @param {string} email
   * @returns {string}
   */
  function formatDelegateDisplay(label, email){
    if (label && email && label !== email){
      return `${label} <${email}>`;
    }
    return label || email || "";
  }

  /**
   * Compute initials for a label.
   * @param {string} source
   * @returns {string}
   */
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

  /**
   * Normalize a delegate label for display.
   * @param {string} value
   * @returns {string}
   */
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

  /**
   * Store the current delegate label for alerts.
   * @param {string} value
   */
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

  /**
   * Update the selected delegate preview card.
   */
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
            }catch(_){ }
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
        /**
         * Close modal when clicking outside the dialog.
         * @param {MouseEvent} event
         */
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
          }catch(_){ }
        }, 0);
      }catch(_){
        try{
          window.alert?.(message);
        }catch(__){ }
        resolve("fallback");
      }
    });
  }

  /**
   * Measure dialog content height for popup sizing.
   * @returns {number}
   */
  function getContentHeight(){
    try{
      const rect = dialogRoot?.getBoundingClientRect?.();
      if (rect && rect.height){
        const styles = window.getComputedStyle(document.body);
        const paddingTop = parseFloat(styles?.paddingTop || "0") || 0;
        const paddingBottom = parseFloat(styles?.paddingBottom || "0") || 0;
        return Math.max(MIN_CONTENT_HEIGHT, Math.ceil(rect.height + paddingTop + paddingBottom));
      }
    }catch(_){ }
    const fallback = document.documentElement?.scrollHeight || document.body?.scrollHeight || MIN_CONTENT_HEIGHT;
    return Math.max(MIN_CONTENT_HEIGHT, fallback);
  }

  /**
   * Show a status message in the dialog.
   * @param {string} text
   * @param {boolean} isError
   */
  function setMessage(text, isError){
    if (!messageBar){
      return;
    }
    messageBar.textContent = text || "";
    messageBar.style.color = isError ? "#b00020" : "#1f1f1f";
  }

  /**
   * Send a debug log to the console and background.
   * @param {string} label
   * @param {any} data
   */
  function logDebug(label, data){
    if (!state.debugEnabled){
      return;
    }
    const details = data || "";
    try{
      console.log(LOG_PREFIX, label, details);
    }catch(_){}
    try{
      browser.runtime.sendMessage({
        type: "debug:log",
        payload: {
          channel: "NCUI",
          label: "Talk",
          text: label,
          details
        }
      }).catch(() => {});
    }catch(_){}
  }
})();










