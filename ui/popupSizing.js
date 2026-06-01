/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
/**
 * Popup sizing helpers for fixed-width and dynamic-height dialogs.
 */
(() => {
  'use strict';

  const globalScope = typeof window !== "undefined"
    ? window
    : (typeof globalThis !== "undefined" ? globalThis : this);
  const LOG_PREFIX = "[NCUI][PopupSizing]";

  if (globalScope.NCTalkPopupSizing){
    return;
  }

  function createPopupSizer(options = {}){
    const fixedWidth = Number(options.fixedWidth) || 0;
    const minHeight = Number(options.minHeight) || 0;
    const margin = Number(options.margin) || 0;
    const getContentHeight = typeof options.getContentHeight === "function"
      ? options.getContentHeight
      : () => minHeight;
    const delayMs = Number(options.delayMs) || 75;
    let resizeTimer = null;
    let boundsPromise = null;

    function getFrameWidth(){
      if (typeof window.outerWidth === "number" && typeof window.innerWidth === "number"){
        return Math.max(0, window.outerWidth - window.innerWidth);
      }
      const docWidth = document.documentElement?.clientWidth || document.body?.clientWidth || fixedWidth;
      const winWidth = typeof window.outerWidth === "number" ? window.outerWidth : docWidth;
      return Math.max(0, winWidth - docWidth);
    }

    function getFrameHeight(){
      if (typeof window.outerHeight === "number" && typeof window.innerHeight === "number"){
        return Math.max(0, window.outerHeight - window.innerHeight);
      }
      const docHeight = document.documentElement?.clientHeight || document.body?.clientHeight || minHeight;
      const winHeight = typeof window.outerHeight === "number" ? window.outerHeight : docHeight;
      return Math.max(0, winHeight - docHeight);
    }

    function enforceFixedWidth(){
      if (!fixedWidth) return;
      try{
        const frame = getFrameWidth();
        const targetOuter = fixedWidth + frame;
        const currentOuter = typeof window.outerWidth === "number"
          ? window.outerWidth
          : (window.innerWidth + frame);
        if (Math.abs(currentOuter - targetOuter) > 2){
          const outerHeight = typeof window.outerHeight === "number"
            ? window.outerHeight
            : (window.innerHeight + getFrameHeight());
          window.resizeTo(targetOuter, outerHeight);
        }
      }catch(error){
        globalScope.NCLogContext.safeConsoleError(LOG_PREFIX, "enforceFixedWidth failed", error);
      }
    }

    function enforceMinHeight(){
      if (!minHeight && !margin) return;
      try{
        const docHeight = getContentHeight();
        const targetInner = Math.max(minHeight, docHeight + margin);
        const frame = getFrameHeight();
        const targetOuter = targetInner + frame;
        const currentOuter = typeof window.outerHeight === "number"
          ? window.outerHeight
          : (window.innerHeight + frame);
        if (Math.abs(currentOuter - targetOuter) > 6){
          const width = typeof window.outerWidth === "number"
            ? window.outerWidth
            : (fixedWidth + getFrameWidth());
          window.resizeTo(width, targetOuter);
        }
      }catch(error){
        globalScope.NCLogContext.safeConsoleError(LOG_PREFIX, "enforceMinHeight failed", error);
      }
    }

    function getDesiredOuterSize(){
      const frameWidth = getFrameWidth();
      const frameHeight = getFrameHeight();
      const desiredWidth = fixedWidth ? fixedWidth + frameWidth : frameWidth;
      const docHeight = getContentHeight();
      const desiredInnerHeight = Math.max(minHeight, docHeight + margin);
      const desiredHeight = desiredInnerHeight + frameHeight;
      return { desiredWidth, desiredHeight };
    }

    function enforceWindowBoundsAsync(){
      if (!browser?.windows?.getCurrent || !browser?.windows?.update){
        return;
      }
      if (boundsPromise){
        return;
      }
      boundsPromise = (async () => {
        try{
          const { desiredWidth, desiredHeight } = getDesiredOuterSize();
          const win = await browser.windows.getCurrent();
          if (!win){
            boundsPromise = null;
            return;
          }
          const updates = {};
          const currentWidth = win.width ?? desiredWidth;
          const currentHeight = win.height ?? desiredHeight;
          if (win.state === "maximized"){
            updates.state = "normal";
          }
          if (fixedWidth && Math.abs(currentWidth - desiredWidth) > 2){
            updates.width = desiredWidth;
          }
          if (Math.abs(currentHeight - desiredHeight) > 6){
            updates.height = desiredHeight;
          }
          if (Object.keys(updates).length){
            if (!updates.state){
              updates.state = "normal";
            }
            await browser.windows.update(win.id, updates);
          }
        }catch(error){
          globalScope.NCLogContext.safeConsoleError(LOG_PREFIX, "enforceWindowBoundsAsync failed", error);
        }
        boundsPromise = null;
      })();
    }

    function scheduleSizeUpdate(){
      if (resizeTimer){
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        enforceFixedWidth();
        enforceMinHeight();
        enforceWindowBoundsAsync();
        resizeTimer = null;
      }, delayMs);
    }

    return {
      scheduleSizeUpdate,
      getFrameWidth,
      getFrameHeight,
      enforceFixedWidth,
      enforceMinHeight,
      enforceWindowBoundsAsync,
      getDesiredOuterSize
    };
  }

  globalScope.NCTalkPopupSizing = { createPopupSizer };
})();
