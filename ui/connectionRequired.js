/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(() => {
  'use strict';

  const LOG_PREFIX = "[NCUI][ConnectionRequired]";
  const params = new URLSearchParams(window.location.search);
  const source = params.get("source") === "talk" ? "talk" : "sharing";
  const notice = params.get("notice") || "";
  const reauthenticate = notice && params.get("reauthenticate") === "1";
  const message = document.getElementById("connectionRequiredMessage");
  const status = document.getElementById("connectionRequiredStatus");
  const openSettingsButton = document.getElementById("openSettingsBtn");
  const closeButton = document.getElementById("closeBtn");
  let settingsOpening = false;
  let settingsOpened = false;

  function translate(key){
    try{
      return browser.i18n.getMessage(key) || "";
    }catch(error){
      globalThis.NCLogContext.safeConsoleError(LOG_PREFIX, "i18n lookup failed", {
        key,
        error
      });
      return "";
    }
  }

  NCTalkDomI18n.translatePage(translate, {
    titleKey: notice ? "extName" : "connection_required_title"
  });
  if (params.get("native") === "1") document.body.classList.add("native-popup");
  if (message){
    // This is display-only text from the entry check; no operation resumes here.
    message.textContent = notice || translate(source === "talk"
      ? "connection_required_talk_message"
      : "connection_required_sharing_message");
    message.classList.toggle("is-error", !!notice);
  }
  if (notice){
    document.getElementById("connectionRequiredTitle").hidden = true;
    document.getElementById("accessNoticeIcon").hidden = false;
    openSettingsButton.hidden = !reauthenticate;
    if (reauthenticate) openSettingsButton.textContent = translate("connection_reauthenticate");
    closeButton.textContent = translate("ui_button_ok");
    closeButton.focus();
  }

  async function openSettings(){
    if (settingsOpening || settingsOpened){
      return;
    }
    settingsOpening = true;
    if (openSettingsButton){
      openSettingsButton.disabled = true;
    }
    if (status){
      status.textContent = "";
    }
    try{
      const response = await browser.runtime.sendMessage({
        type: "connection:openOptions",
        reauthenticate: !!reauthenticate
      });
      if (!response?.ok){
        throw new Error(response?.error || "connection_options_open_failed");
      }
      if (response.opened === true){
        settingsOpened = true;
        window.close();
      }
    }catch(error){
      globalThis.NCLogContext.safeConsoleError(LOG_PREFIX, "open settings failed", error);
      if (status){
        status.textContent = translate("sharing_vfs_navigation_failed");
      }
    }finally{
      settingsOpening = false;
      if (openSettingsButton){
        openSettingsButton.disabled = settingsOpened;
      }
    }
  }

  openSettingsButton?.addEventListener("click", openSettings);
  closeButton?.addEventListener("click", () => window.close());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") window.close();
  });
})();
