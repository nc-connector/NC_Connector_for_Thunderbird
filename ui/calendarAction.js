/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0; see LICENSE.txt.
 */
(() => {
  'use strict';

  const i18n = NCI18n.translate;
  const status = document.getElementById('status');
  const main = document.querySelector('main');
  const talk = document.getElementById('talk');
  const resources = document.getElementById('resources');
  const reauthenticate = document.getElementById('reauthenticate');
  let contextId = '';
  let unloading = false;
  let actions = null;

  function showAccessNotice(action){
    const query = new URLSearchParams({ source: 'talk', notice: action.notice, native: '1' });
    if (action.code === 'auth_required') query.set('reauthenticate', '1');
    window.location.replace(`connectionRequired.html?${query}`);
  }

  async function init(){
    NCTalkDomI18n.translatePage(i18n, { titleKey: 'calendar_action_title' });
    status.textContent = i18n('calendar_action_loading');
    try{
      // Native popups can load before the editor click bridge finishes its snapshot.
      for (const delay of [0, 40, 80, 160, 320, 640]){
        if (delay) await new Promise(resolve => window.setTimeout(resolve, delay));
        if (unloading) return;
        const response = await browser.runtime.sendMessage({ type: 'calendar:claimPopupContext' });
        if (response?.ok && typeof response.contextId === 'string' && response.contextId.trim()){
          contextId = response.contextId.trim();
          break;
        }
      }
      if (!contextId){
        status.textContent = i18n('resource_context_expired');
        status.classList.add('is-error');
        return;
      }
      const response = await browser.runtime.sendMessage({ type: 'calendar:actionState', contextId });
      if (unloading) return;
      if (!response?.ok){
        status.textContent = response?.error || i18n('calendar_action_error');
        status.classList.add('is-error');
        reauthenticate.hidden = response?.code !== 'auth_required';
        return;
      }
      for (const action of [response.talk, response.resources]){
        if (typeof action?.enabled !== 'boolean' || typeof action.code !== 'string'
          || typeof action.notice !== 'string'
          || (action.enabled ? action.code || action.notice : !action.code.trim() || !action.notice.trim())){
          throw new Error('Invalid action access response');
        }
      }
      actions = response;
      if (response.talk?.enabled === false && response.resources?.enabled === false
        && response.talk.code === response.resources.code && response.talk.notice){
        showAccessNotice(response.talk);
        return;
      }
      for (const [button, noticeElement, action] of [
        [talk, document.getElementById('talkNotice'), response.talk],
        [resources, document.getElementById('resourceNotice'), response.resources]
      ]){
        // A policy refusal remains invocable for its explanation, not execution.
        button.disabled = !action || ['resource_readonly', 'resource_context_expired'].includes(action.code);
        const notice = action?.notice || '';
        button.title = notice;
        noticeElement.textContent = button.disabled ? notice : '';
        noticeElement.hidden = !noticeElement.textContent;
      }
      status.textContent = '';
    }catch(error){
      if (unloading) return;
      NCLogContext.safeConsoleError('[NCUI][Calendar]', 'action menu initialization failed', error);
      status.textContent = i18n('calendar_action_error');
      status.classList.add('is-error');
    }finally{
      main.setAttribute('aria-busy', 'false');
    }
  }

  talk.addEventListener('click', () => {
    if (!talk.disabled && contextId){
      if (actions.talk.enabled !== true){
        showAccessNotice(actions.talk);
        return;
      }
      window.location.replace(`talkDialog.html?contextId=${encodeURIComponent(contextId)}`);
    }
  });
  resources.addEventListener('click', () => {
    if (!resources.disabled && contextId){
      if (actions.resources.enabled !== true){
        showAccessNotice(actions.resources);
        return;
      }
      window.location.replace(`calendarResources.html?contextId=${encodeURIComponent(contextId)}`);
    }
  });
  reauthenticate.addEventListener('click', async () => {
    reauthenticate.disabled = true;
    try{
      await browser.runtime.sendMessage({ type: 'connection:openOptions', reauthenticate: true });
      window.close();
    }catch(error){
      NCLogContext.safeConsoleError('[NCUI][Calendar]', 'open sign-in settings failed', error);
      status.textContent = i18n('calendar_action_error');
      status.classList.add('is-error');
      reauthenticate.disabled = false;
    }
  });
  document.getElementById('cancel').addEventListener('click', () => window.close());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') window.close();
  });
  window.addEventListener('pagehide', () => { unloading = true; }, { once: true });
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
})();
