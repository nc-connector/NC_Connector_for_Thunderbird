/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(() => {
  'use strict';
  const MESSAGE_TYPE = "nc-signature:apply";
  const PING_TYPE = "nc-signature:ping";
  const SIGNATURE_SELECTOR = '[data-nc-connector-signature="true"]';
  const SIGNATURE_SPACER_SELECTOR = '[data-nc-connector-signature-spacer="true"]';
  const FOREIGN_SIGNATURE_SELECTOR = '.moz-signature:not([data-nc-connector-signature="true"]), [data-signature-switch-id]';
  const QUOTE_ANCHOR_SELECTOR = '.moz-cite-prefix, blockquote[type="cite"], .moz-forward-container';
  const QUOTED_CONTENT_SELECTOR = 'blockquote[type="cite"], .moz-forward-container';
  const LATE_SIGNATURE_SETTLE_WINDOW_MS = 2000;
  const LATE_SIGNATURE_DEBOUNCE_MS = 50;
  let lateSignatureObserver = null;
  let lateSignatureStopTimer = null;
  let lateSignatureApplyTimer = null;
  let lateSignaturePayload = null;

  function getComposeRoot(){
    return document.body || document.documentElement;
  }

  function computeHash(value){
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1){
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function serializeSignatureContent(element){
    if (!element){
      return "";
    }
    const serializer = new XMLSerializer();
    return Array.from(element.childNodes).map((node) => {
      return serializer.serializeToString(node);
    }).join("");
  }

  function appendSanitizedSignatureHtml(wrapper, html){
    const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
    const nodes = Array.from(parsed.body?.childNodes || []);
    for (const node of nodes){
      wrapper.appendChild(document.importNode(node, true));
    }
  }

  function listElements(selector){
    return Array.from(document.querySelectorAll(selector));
  }

  function findQuoteAnchor(){
    return document.querySelector(QUOTE_ANCHOR_SELECTOR);
  }

  function isInsideQuotedContent(element){
    return !!element?.closest?.(QUOTED_CONTENT_SELECTOR);
  }

  function isAfterQuoteAnchor(element, quoteAnchor){
    if (!element || !quoteAnchor){
      return false;
    }
    if (element === quoteAnchor || quoteAnchor.contains(element)){
      return true;
    }
    return !!(quoteAnchor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function isActiveComposeSignature(element, quoteAnchor){
    if (!element?.parentNode || isInsideQuotedContent(element)){
      return false;
    }
    // Quoted mail can contain .moz-signature too; only the author area owns the signature slot.
    return !isAfterQuoteAnchor(element, quoteAnchor);
  }

  function listActiveSignatureElements(selector){
    const quoteAnchor = findQuoteAnchor();
    return listElements(selector).filter((element) => isActiveComposeSignature(element, quoteAnchor));
  }

  function isOwnSignatureUnchanged(element){
    if (!element){
      return false;
    }
    const expected = String(element.getAttribute("data-nc-connector-signature-hash") || "");
    if (!expected){
      return false;
    }
    return computeHash(serializeSignatureContent(element)) === expected;
  }

  function allOwnSignaturesUnchanged(elements){
    return elements.every((element) => isOwnSignatureUnchanged(element));
  }

  function removeElements(elements){
    for (const element of elements){
      element.remove();
    }
  }

  function logSignatureDebug(payload, message, details = {}){
    if (payload?.debugEnabled === true){
      console.debug("[NCUI][Signature]", message, details);
    }
  }

  function stopLateSignatureWatch(){
    lateSignatureObserver?.disconnect();
    lateSignatureObserver = null;
    if (lateSignatureStopTimer !== null){
      clearTimeout(lateSignatureStopTimer);
      lateSignatureStopTimer = null;
    }
    if (lateSignatureApplyTimer !== null){
      clearTimeout(lateSignatureApplyTimer);
      lateSignatureApplyTimer = null;
    }
    lateSignaturePayload = null;
  }

  function replaceLateSignature(){
    lateSignatureApplyTimer = null;
    const payload = lateSignaturePayload;
    if (!payload){
      return;
    }
    const foreignSignatures = listActiveSignatureElements(FOREIGN_SIGNATURE_SELECTOR);
    if (!foreignSignatures.length){
      return;
    }
    const result = applySignature(payload);
    logSignatureDebug(payload, "late local signature handled", {
      foreignCount: foreignSignatures.length,
      changed: result?.changed === true,
      result: String(result?.reason || result?.error || "")
    });
    if (!result?.ok || result?.reason === "own_signature_modified"){
      stopLateSignatureWatch();
    }
  }

  function queueLateSignatureReplacement(){
    if (lateSignatureApplyTimer !== null
      || !listActiveSignatureElements(FOREIGN_SIGNATURE_SELECTOR).length){
      return;
    }
    lateSignatureApplyTimer = setTimeout(replaceLateSignature, LATE_SIGNATURE_DEBOUNCE_MS);
  }

  function startLateSignatureWatch(payload){
    stopLateSignatureWatch();
    const root = getComposeRoot();
    if (payload?.desired !== true
      || payload?.clearForeign === false
      || !root
      || typeof MutationObserver !== "function"){
      return;
    }

    // Thunderbird can append file-based signatures after the compose tab event.
    lateSignaturePayload = { ...payload, placeCursorAtStart: false };
    lateSignatureObserver = new MutationObserver(queueLateSignatureReplacement);
    lateSignatureObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-signature-switch-id", "data-nc-connector-signature"]
    });
    lateSignatureStopTimer = setTimeout(stopLateSignatureWatch, LATE_SIGNATURE_SETTLE_WINDOW_MS);
    logSignatureDebug(payload, "late local signature watch started", {
      durationMs: LATE_SIGNATURE_SETTLE_WINDOW_MS
    });
  }

  function placeCursorAtAuthorStart(payload){
    if (payload?.placeCursorAtStart !== true){
      return false;
    }
    try{
      const root = getComposeRoot();
      root?.focus?.();
      const range = document.createRange();
      range.setStart(root, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }catch(error){
      return false;
    }
  }

  function buildSignatureElement(payload){
    const wrapper = document.createElement("div");
    wrapper.className = "moz-signature";
    wrapper.setAttribute("data-nc-connector-signature", "true");
    if (payload?.plainTextMode){
      wrapper.style.whiteSpace = "pre-wrap";
      wrapper.textContent = String(payload?.plainText || "");
    }else{
      // ESR 140 has no setHTML(); import sanitized nodes from an inert parser document.
      appendSanitizedSignatureHtml(wrapper, payload?.html || "");
    }
    wrapper.setAttribute("data-nc-connector-signature-hash", computeHash(serializeSignatureContent(wrapper)));
    return wrapper;
  }

  function buildSignatureSpacer(){
    const spacer = document.createElement("div");
    spacer.setAttribute("data-nc-connector-signature-spacer", "true");
    spacer.appendChild(document.createElement("br"));
    return spacer;
  }

  function findInsertionAnchor(ownSignatures, foreignSignatures){
    const candidates = ownSignatures.concat(foreignSignatures);
    for (const candidate of candidates){
      if (candidate?.parentNode){
        return {
          parent: candidate.parentNode,
          before: candidate
        };
      }
    }
    const quoteAnchor = findQuoteAnchor();
    if (quoteAnchor?.parentNode){
      return {
        parent: quoteAnchor.parentNode,
        before: quoteAnchor
      };
    }
    return {
      parent: getComposeRoot(),
      before: null
    };
  }

  function applySignature(payload){
    const desired = payload?.desired === true;
    const clearForeign = payload?.clearForeign !== false;
    const clearOwnOnly = payload?.clearOwnOnly === true;
    const requireExistingOwnUnchanged = payload?.requireExistingOwnUnchanged === true;
    const ownSignatures = listActiveSignatureElements(SIGNATURE_SELECTOR);
    const ownSpacers = listActiveSignatureElements(SIGNATURE_SPACER_SELECTOR);
    const foreignSignatures = clearForeign ? listActiveSignatureElements(FOREIGN_SIGNATURE_SELECTOR) : [];

    if (requireExistingOwnUnchanged && !ownSignatures.length){
      return { ok: true, changed: false, managed: false, reason: "own_signature_missing" };
    }
    if (ownSignatures.length && !allOwnSignaturesUnchanged(ownSignatures)){
      return { ok: true, changed: false, managed: true, reason: "own_signature_modified" };
    }

    if (desired && !clearOwnOnly){
      const anchor = findInsertionAnchor(ownSignatures, foreignSignatures);
      const signatureElement = buildSignatureElement(payload);
      const signatureSpacer = buildSignatureSpacer();
      anchor.parent.insertBefore(signatureElement, anchor.before);
      anchor.parent.insertBefore(signatureSpacer, anchor.before);
      removeElements(ownSignatures);
      removeElements(ownSpacers);
      removeElements(foreignSignatures);
      const cursorPlaced = placeCursorAtAuthorStart(payload);
      return {
        ok: true,
        changed: true,
        managed: true,
        reason: "signature_inserted",
        htmlLength: String(payload?.html || "").length,
        plainTextLength: String(payload?.plainText || "").length,
        cursorPlaced
      };
    }

    removeElements(ownSignatures);
    removeElements(ownSpacers);
    if (!clearOwnOnly){
      removeElements(foreignSignatures);
    }
    const cursorPlaced = placeCursorAtAuthorStart(payload);

    return {
      ok: true,
      changed: ownSignatures.length > 0 || ownSpacers.length > 0 || (!clearOwnOnly && foreignSignatures.length > 0),
      managed: !clearOwnOnly,
      reason: clearOwnOnly ? "own_signature_cleared" : "signature_cleared",
      cursorPlaced
    };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === PING_TYPE){
      return Promise.resolve({ ok: true });
    }
    if (message?.type !== MESSAGE_TYPE){
      return false;
    }
    try{
      const payload = message.payload || {};
      const result = applySignature(payload);
      if (result?.ok && result?.reason === "signature_inserted"){
        startLateSignatureWatch(payload);
      }else{
        stopLateSignatureWatch();
      }
      return Promise.resolve(result);
    }catch(error){
      stopLateSignatureWatch();
      return Promise.resolve({
        ok: false,
        error: error?.message || String(error)
      });
    }
  });

  window.addEventListener("unload", stopLateSignatureWatch, { once: true });
})();
