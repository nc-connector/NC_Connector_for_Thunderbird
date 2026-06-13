/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const CREATE_SECRET_PATH = "/ocs/v2.php/apps/secrets/api/v1/secrets";

  function normalizeBaseUrl(value){
    return String(value || "").replace(/\/+$/, "");
  }

  function readOcsData(payload){
    const data = payload?.ocs?.data;
    return data && typeof data === "object" ? data : {};
  }

  function readSecretUuid(data){
    const uuid = String(data?.uuid || data?.id || "").trim();
    return uuid || "";
  }

  function normalizeSecretTitle(value){
    const title = String(value || "").trim();
    return title || "NCC share password";
  }

  function parseExpires(value){
    const raw = String(value || "").trim();
    if (!raw){
      return null;
    }
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  async function ensureHostPermission(baseUrl){
    if (typeof NCHostPermissions === "undefined" || !NCHostPermissions?.requireOriginPermission){
      return true;
    }
    const message = typeof bgI18n === "function"
      ? bgI18n("error_host_permission_missing")
      : "Host permission missing.";
    return NCHostPermissions.requireOriginPermission(baseUrl, {
      message,
      scope: "secrets host permission missing",
      logMissing: false
    });
  }

  async function createSecretLink({ plainText, title, expireDays } = {}){
    const opts = await NCCore.getOpts();
    if (!opts.baseUrl || !opts.user || !opts.appPass){
      const message = typeof bgI18n === "function"
        ? bgI18n("error_credentials_missing")
        : "Credentials missing.";
      throw new Error(message);
    }
    const baseUrl = normalizeBaseUrl(opts.baseUrl);
    if (!baseUrl){
      throw new Error("Secrets link creation failed: base URL is invalid.");
    }
    const secretText = String(plainText || "");
    if (!secretText){
      throw new Error("Secrets link creation failed: secret content is empty.");
    }
    await ensureHostPermission(baseUrl);

    const expire = NCSharePasswordDelivery.clampSecretsExpireDays(expireDays);
    const encrypted = await NCSecretsCrypto.encryptToSecretsPayload(secretText);
    const url = `${baseUrl}${CREATE_SECRET_PATH}`;
    const payload = {
      title: normalizeSecretTitle(title),
      encrypted: encrypted.encrypted,
      iv: encrypted.iv,
      expires: new Date(Date.now() + expire * 24 * 60 * 60 * 1000).toISOString()
    };
    if (typeof L === "function"){
      L("secrets password link create prepared", {
        expireDays: expire,
        hasTitle: !!payload.title
      });
    }
    const response = await NCOcs.ocsRequest({
      url,
      method: "POST",
      headers: {
        Authorization: NCOcs.buildAuthHeader(opts.user, opts.appPass),
        "OCS-APIRequest": "true",
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (response.status !== 201){
      const detail = response.errorMessage || `HTTP ${response.status}`;
      throw new Error(`Secrets link creation failed: ${detail}`);
    }
    const data = readOcsData(response.data);
    const uuid = readSecretUuid(data);
    if (!uuid){
      throw new Error("Secrets link creation failed: response did not contain a UUID.");
    }
    const shareUrl = `${baseUrl}/index.php/apps/secrets/share/${encodeURIComponent(uuid)}#${encrypted.key}`;
    if (typeof L === "function"){
      L("secrets password link create succeeded", {
        hasUuid: true,
        hasExpires: !!parseExpires(data?.expires)
      });
    }
    return {
      uuid,
      shareUrl,
      expires: parseExpires(data?.expires)
    };
  }

  const api = { createSecretLink };

  if (typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
  global.NCSecrets = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
