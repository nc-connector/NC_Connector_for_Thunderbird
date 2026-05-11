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
  const FOREIGN_SIGNATURE_SELECTOR = '.moz-signature:not([data-nc-connector-signature="true"]), [data-signature-switch-id]';

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
    const quoteAnchor = document.querySelector('.moz-cite-prefix, blockquote[type="cite"], .moz-forward-container');
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
    const ownSignatures = listElements(SIGNATURE_SELECTOR);
    const foreignSignatures = clearForeign ? listElements(FOREIGN_SIGNATURE_SELECTOR) : [];

    if (requireExistingOwnUnchanged && !ownSignatures.length){
      return { ok: true, changed: false, managed: false, reason: "own_signature_missing" };
    }
    if (ownSignatures.length && !allOwnSignaturesUnchanged(ownSignatures)){
      return { ok: true, changed: false, managed: true, reason: "own_signature_modified" };
    }

    if (desired && !clearOwnOnly){
      const anchor = findInsertionAnchor(ownSignatures, foreignSignatures);
      const signatureElement = buildSignatureElement(payload);
      anchor.parent.insertBefore(signatureElement, anchor.before);
      removeElements(ownSignatures);
      removeElements(foreignSignatures);
      return {
        ok: true,
        changed: true,
        managed: true,
        reason: "signature_inserted",
        htmlLength: String(payload?.html || "").length,
        plainTextLength: String(payload?.plainText || "").length
      };
    }

    removeElements(ownSignatures);
    if (!clearOwnOnly){
      removeElements(foreignSignatures);
    }

    return {
      ok: true,
      changed: ownSignatures.length > 0 || (!clearOwnOnly && foreignSignatures.length > 0),
      managed: !clearOwnOnly,
      reason: clearOwnOnly ? "own_signature_cleared" : "signature_cleared"
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
