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
  const message = document.getElementById("connectionRequiredMessage");
  const status = document.getElementById("connectionRequiredStatus");
  const openSettingsButton = document.getElementById("openSettingsBtn");
  const closeButton = document.getElementById("closeBtn");

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
    titleKey: "connection_required_title"
  });
  if (message){
    message.textContent = translate(source === "talk"
      ? "connection_required_talk_message"
      : "connection_required_sharing_message");
  }

  openSettingsButton?.addEventListener("click", async () => {
    openSettingsButton.disabled = true;
    if (status){
      status.textContent = "";
    }
    try{
      const response = await browser.runtime.sendMessage({
        type: "connection:openOptions"
      });
      if (!response?.ok){
        throw new Error(response?.error || "connection_options_open_failed");
      }
      window.close();
    }catch(error){
      globalThis.NCLogContext.safeConsoleError(LOG_PREFIX, "open settings failed", error);
      if (status){
        status.textContent = translate("sharing_vfs_navigation_failed");
      }
      openSettingsButton.disabled = false;
    }
  });

  closeButton?.addEventListener("click", () => window.close());
})();
