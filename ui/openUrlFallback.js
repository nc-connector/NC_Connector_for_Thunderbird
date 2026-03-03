/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(() => {
  "use strict";

  /**
   * Translate a message key using the WebExtension API.
   * @param {string} key
   * @param {string[]|string} subs
   * @returns {string}
   */
  const i18n = (key, subs) => {
    try{
      return browser.i18n.getMessage(key, subs);
    }catch(error){
      console.error("[NCUI][OpenUrlFallback] i18n lookup failed", { key, error });
      return "";
    }
  };

  NCTalkDomI18n.translatePage(i18n, { titleKey: "open_url_title" });

  const params = new URLSearchParams(window.location.search);
  const url = params.get("url") || "";
  const urlInput = document.getElementById("urlInput");
  const copyBtn = document.getElementById("copyBtn");
  const closeBtn = document.getElementById("closeBtn");
  const statusEl = document.getElementById("status");

  if (urlInput){
    urlInput.value = url;
  }

  /**
   * Update the status line in the fallback dialog.
   * @param {string} key
   * @param {boolean} isError
   */
  function setStatus(key, isError = false){
    if (!statusEl){
      return;
    }
    statusEl.textContent = i18n(key) || "";
    statusEl.style.color = isError ? "#b00020" : "#1f1f1f";
  }

  /**
   * Copy the URL to the clipboard.
   * @returns {Promise<void>}
   */
  async function copyUrl(){
    if (!url){
      return;
    }
    try{
      if (navigator.clipboard && navigator.clipboard.writeText){
        await navigator.clipboard.writeText(url);
        setStatus("open_url_copied");
        return;
      }
    }catch(error){
      console.error("[NCUI][OpenUrlFallback] clipboard.writeText failed", error);
    }
    try{
      if (urlInput){
        urlInput.focus();
        urlInput.select();
      }
      const ok = document.execCommand("copy");
      if (ok){
        setStatus("open_url_copied");
      }else{
        setStatus("open_url_copy_failed", true);
      }
    }catch(error){
      console.error("[NCUI][OpenUrlFallback] execCommand copy failed", error);
      setStatus("open_url_copy_failed", true);
    }
  }

  copyBtn?.addEventListener("click", copyUrl);
  closeBtn?.addEventListener("click", () => window.close());
})();
