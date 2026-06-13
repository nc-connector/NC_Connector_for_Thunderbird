/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const KEY_BYTES = 32;
  const IV_BYTES = 12;

  function randomBytes(length){
    const data = new Uint8Array(length);
    global.crypto.getRandomValues(data);
    return data;
  }

  function bytesToBase64(bytes){
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1){
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async function encryptToSecretsPayload(plainText){
    if (!global.crypto?.subtle || typeof global.crypto.getRandomValues !== "function"){
      throw new Error("Secrets encryption is not available in this runtime.");
    }
    const keyBytes = randomBytes(KEY_BYTES);
    const ivBytes = randomBytes(IV_BYTES);
    const key = await global.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );
    const plainBytes = new TextEncoder().encode(String(plainText ?? ""));
    const encrypted = await global.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: ivBytes },
      key,
      plainBytes
    );
    return {
      encrypted: bytesToBase64(new Uint8Array(encrypted)),
      iv: bytesToBase64(ivBytes),
      key: bytesToBase64(keyBytes)
    };
  }

  const api = { encryptToSecretsPayload };

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCSecretsCrypto = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
