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
    return computeHash(element.innerHTML) === expected;
  }

  function allOwnSignaturesUnchanged(elements){
    return elements.every((element) => isOwnSignatureUnchanged(element));
  }

  function removeElements(elements){
    for (const element of elements){
      element.remove();
    }
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
      wrapper.innerHTML = String(payload?.html || "");
    }
    wrapper.setAttribute("data-nc-connector-signature-hash", computeHash(wrapper.innerHTML));
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
      return Promise.resolve(applySignature(message.payload || {}));
    }catch(error){
      return Promise.resolve({
        ok: false,
        error: error?.message || String(error)
      });
    }
  });
})();
