/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  function getSystemAddressbookUiState(status = {}, translate, responseError = ""){
    const configured = status.configured !== false;
    const checked = configured && status.checked !== false;
    const available = checked && status.available === true;
    const unavailable = checked && !available;
    const detail = available ? ""
      : (!configured ? translate("connection_required_talk_message")
        : (status.error || responseError || translate("talk_system_addressbook_unavailable_message")));
    return { configured, checked, available, unavailable, detail };
  }

  /**
   * Toggle one tooltip list between normal and lock-hint entries.
   * @param {HTMLElement|null} tooltipList
   * @param {boolean} lockActive
   */
  function applySystemAddressbookTooltipState(tooltipList, lockActive){
    if (!tooltipList){
      return;
    }
    const rows = tooltipList.querySelectorAll("li");
    rows.forEach((row) => {
      const isLockHint = row.dataset.lockHint === "true";
      row.hidden = isLockHint ? !lockActive : lockActive;
    });
  }

  global.NCAddressbookUi = Object.freeze({
    getSystemAddressbookUiState,
    applySystemAddressbookTooltipState
  });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

