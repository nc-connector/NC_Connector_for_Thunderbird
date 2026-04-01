/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
"use strict";
(function(global){
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
    applySystemAddressbookTooltipState
  });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

