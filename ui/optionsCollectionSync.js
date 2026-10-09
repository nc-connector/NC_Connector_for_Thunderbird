/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Calendars & contacts tab; switches are stored immediately, not via footer Save.
 */
(function(global){
  'use strict';

  const i18n = global.NCI18n.translate;
  const MESSAGE_TYPES = Object.freeze({
    getStatus: "collectionSync:getStatus",
    syncNow: "collectionSync:syncNow",
    restoreDismissed: "collectionSync:restoreDismissed"
  });
  const SWITCHES = Object.freeze([
    { input: document.getElementById("calendarSyncEnabled"), storageKey: "calendarSyncEnabled", statusField: "calendarsEnabled" },
    { input: document.getElementById("addressBookSyncEnabled"), storageKey: "addressBookSyncEnabled", statusField: "addressBooksEnabled" }
  ]);

  const statusText = document.getElementById("collectionSyncStatus");
  const statusDot = document.getElementById("collectionSyncStatusDot");
  const syncButton = document.getElementById("collectionSyncNow");
  const restoreButton = document.getElementById("collectionSyncRestore");
  const disabledNotice = document.getElementById("collectionSyncDisabledNotice");
  if (!statusText || !statusDot || !syncButton || !restoreButton || !disabledNotice || SWITCHES.some(({ input }) => !input)){
    return;
  }

  let currentStatus = null;

  function setStatus(text, tone){
    statusText.textContent = text;
    statusDot.dataset.tone = tone || "neutral";
  }

  function describeLastRun(lastRun, managed){
    if (!lastRun?.at){
      return { text: i18n("options_calendar_sync_status_never"), tone: "neutral" };
    }
    if (lastRun.ok === false){
      return { text: i18n("options_calendar_sync_status_error", [lastRun.error || ""]), tone: "error" };
    }
    const kinds = [lastRun.calendars, lastRun.addressBooks].filter(Boolean);
    const sum = (field) => String(kinds.reduce((total, kind) => total + (Number(kind[field]) || 0), 0));
    return {
      text: i18n("options_calendar_sync_status_ok", [
        new Date(lastRun.at).toLocaleString(),
        String(managed?.calendars ?? 0),
        String(managed?.addressBooks ?? 0),
        sum("created"),
        sum("removed")
      ]),
      tone: "success"
    };
  }

  function render(status, { busy = false, error = "" } = {}){
    currentStatus = status || currentStatus;
    const available = !!currentStatus?.available;
    if (busy){
      setStatus(i18n("options_calendar_sync_running"), "warning");
    }else if (error){
      setStatus(i18n("options_calendar_sync_status_error", [error]), "error");
    }else if (!available){
      setStatus(i18n("options_calendar_sync_unavailable"), "warning");
    }else{
      const { text, tone } = describeLastRun(currentStatus.lastRun, currentStatus.managed);
      setStatus(text, tone);
    }
    const disabledCalendars = Number(currentStatus?.disabledCalendars) || 0;
    disabledNotice.hidden = !disabledCalendars;
    disabledNotice.textContent = disabledCalendars
      ? i18n("options_calendar_sync_disabled_notice", [String(disabledCalendars)])
      : "";
    const anyEnabled = SWITCHES.some(({ statusField }) => !!currentStatus?.[statusField]);
    for (const { input, statusField } of SWITCHES){
      input.checked = !!currentStatus?.[statusField];
      input.disabled = busy || !available;
    }
    syncButton.disabled = busy || !available || !anyEnabled;
    restoreButton.disabled = busy || !available || !anyEnabled || !currentStatus?.dismissed;
  }

  async function send(type){
    const response = await browser.runtime.sendMessage({ type });
    if (!response?.ok){
      throw new Error(response?.error || i18n("options_test_failed"));
    }
    return response;
  }

  async function refresh(){
    try{
      const { status } = await send(MESSAGE_TYPES.getStatus);
      render(status);
    }catch(error){
      render(null, { error: error?.message || String(error) });
    }
  }

  async function run(type){
    render(null, { busy: true });
    try{
      const { status } = await send(type);
      render(status);
    }catch(error){
      await refresh();
      render(null, { error: error?.message || String(error) });
    }
  }

  async function onSwitchChange({ input, storageKey }){
    const enabled = input.checked;
    // The permission prompt must be the first await to keep the user gesture.
    if (enabled && currentStatus?.baseUrl && !await NCHostPermissions.ensureOriginPermissionInteractive(currentStatus.baseUrl)){
      input.checked = false;
      render(null, { error: i18n("error_host_permission_missing") });
      return;
    }
    await browser.storage.local.set({ [storageKey]: enabled });
    if (enabled){
      await run(MESSAGE_TYPES.syncNow);
    }else{
      await refresh();
    }
  }

  for (const entry of SWITCHES){
    entry.input.addEventListener("change", () => onSwitchChange(entry));
  }
  syncButton.addEventListener("click", () => run(MESSAGE_TYPES.syncNow));
  restoreButton.addEventListener("click", () => run(MESSAGE_TYPES.restoreDismissed));

  refresh();
})(window);
