/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(){
  'use strict';

  const i18n = NCI18n.translate;
  const params = new URLSearchParams(window.location.search);
  const addonId = String(params.get('addonId') || '').trim();
  const addonName = String(params.get('addonName') || addonId).trim();
  const setupToken = String(params.get('setupToken') || '').trim();
  const requestText = document.getElementById('requestText');
  const accountText = document.getElementById('accountText');
  const status = document.getElementById('status');
  const grantButton = document.getElementById('grant');
  const cancelButton = document.getElementById('cancel');

  function setStatus(message, error = false){
    status.textContent = String(message || '');
    status.classList.toggle('error', error);
  }

  async function init(){
    NCTalkDomI18n.translatePage(i18n, { titleKey: 'vfs_setup_title' });
    const consumerLabel = addonName && addonName !== addonId
      ? `${addonName} (${addonId})`
      : addonId;
    requestText.textContent = i18n('vfs_setup_request', [consumerLabel]);
    if (!setupToken){
      grantButton.disabled = true;
      setStatus(i18n('vfs_setup_invalid_request'), true);
      return;
    }
    try{
      const response = await browser.runtime.sendMessage({ type: 'vfs:getStatus' });
      if (!response?.ok || !response.status?.enabled || !response.status?.accountConfigured){
        grantButton.disabled = true;
        setStatus(i18n('vfs_setup_provider_unavailable'), true);
        return;
      }
      accountText.textContent = i18n('vfs_setup_account', [response.status.accountLabel]);
    }catch(error){
      globalThis.NCLogContext.safeConsoleError('[NCUI][VFS]', 'provider status failed', error);
      grantButton.disabled = true;
      setStatus(i18n('vfs_setup_provider_unavailable'), true);
    }
  }

  grantButton.addEventListener('click', async () => {
    grantButton.disabled = true;
    cancelButton.disabled = true;
    setStatus(i18n('vfs_setup_granting'));
    try{
      const response = await browser.runtime.sendMessage({
        type: 'vfs:grantConsumer',
        payload: { setupToken }
      });
      if (!response?.ok){
        throw new Error(response?.error || i18n('vfs_setup_failed'));
      }
      window.close();
    }catch(error){
      globalThis.NCLogContext.safeConsoleError('[NCUI][VFS]', 'provider grant failed', error);
      grantButton.disabled = false;
      cancelButton.disabled = false;
      setStatus(error?.message || i18n('vfs_setup_failed'), true);
    }
  });

  cancelButton.addEventListener('click', () => window.close());
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
})();
