/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const UNCLEAR_HTTP_STATUSES = Object.freeze([408, 502, 503, 504]);
  const INDETERMINATE_PATHS = new Map();
  const CREATE_INFLIGHT = new Map();
  const RECOVERY_SALT = (() => {
    const bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  })();

  function normalizeSharePath(value){
    const path = String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    return path ? `/${path}` : "/";
  }

  function readShareData(value){
    if (!value || typeof value !== "object"){
      return null;
    }
    const url = String(value.url || "").trim();
    const token = String(value.token || "").trim();
    const id = String(value.id ?? "").trim();
    if (!url || !token || !id){
      return null;
    }
    return Object.freeze({ url, token, id });
  }

  function buildHeaders(authHeader){
    return {
      "Authorization": authHeader,
      "OCS-APIRequest": "true",
      "Accept": "application/json"
    };
  }

  async function lookupShare({
    endpoint,
    relativeFolder,
    authHeader,
    signal
  } = {}){
    const expectedPath = normalizeSharePath(relativeFolder);
    const query = new URLSearchParams({
      path: expectedPath,
      reshares: "false",
      subfiles: "false"
    });
    const response = await NCOcs.ocsRequest({
      url: `${endpoint}?${query.toString()}`,
      method: "GET",
      headers: buildHeaders(authHeader),
      signal
    });
    if (!NCOcs.isExplicitSuccess(response)){
      return Object.freeze({ known: false, share: null });
    }
    const rawItems = response.data?.ocs?.data;
    const items = Array.isArray(rawItems)
      ? rawItems
      : (rawItems && typeof rawItems === "object" ? Object.values(rawItems) : []);
    const matches = items.filter((item) => {
      const shareType = Number(item?.share_type ?? item?.shareType);
      return shareType === 3 && normalizeSharePath(item?.path) === expectedPath;
    });
    if (matches.length > 1){
      return Object.freeze({ known: false, share: null });
    }
    const share = matches.length === 1 ? readShareData(matches[0]) : null;
    if (matches.length === 1 && !share){
      return Object.freeze({ known: false, share: null });
    }
    return Object.freeze({
      known: true,
      share
    });
  }

  async function sendCreate({ endpoint, authHeader, payload, signal } = {}){
    return NCOcs.ocsRequest({
      url: endpoint,
      method: "POST",
      headers: {
        ...buildHeaders(authHeader),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: payload,
      signal
    });
  }

  function responseError(response){
    const detail = NCOcs.getFailureMessage(
      response,
      `HTTP ${response?.status || 0}`
    );
    return NCFileLinkDav.createTechnicalError(
      String(detail || "Share creation failed"),
      Number(response?.status) || 0
    );
  }

  function getCreateKey(endpoint, relativeFolder, accountFingerprint){
    return `${endpoint}\n${normalizeSharePath(relativeFolder)}\n${accountFingerprint}`;
  }

  async function fingerprintValue(value){
    const bytes = new TextEncoder().encode(`${RECOVERY_SALT}\n${String(value || "")}`);
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(
      new Uint8Array(digest),
      (value) => value.toString(16).padStart(2, "0")
    ).join("");
  }

  async function fingerprintPayload(payload, accountFingerprint){
    return fingerprintValue(`${accountFingerprint}\n${payload.toString()}`);
  }

  function buildCreatePayload({
    relativeFolder,
    permissionMask,
    password = "",
    expireDate = "",
    label = "",
    note = ""
  } = {}){
    const payload = new URLSearchParams();
    payload.append("path", normalizeSharePath(relativeFolder));
    payload.append("shareType", "3");
    payload.append("permissions", String(permissionMask));
    if (password) payload.append("password", password);
    if (expireDate) payload.append("expireDate", expireDate);
    if (label) payload.append("label", label);
    if (note) payload.append("note", note);
    return payload;
  }

  async function createOnce(options, endpoint, createKey, fingerprint){
    const {
      relativeFolder,
      authHeader,
      signal
    } = options;
    const payload = buildCreatePayload(options);

    if (INDETERMINATE_PATHS.has(createKey)){
      const previousFingerprint = INDETERMINATE_PATHS.get(createKey);
      let previous;
      try{
        previous = await lookupShare({
          endpoint,
          relativeFolder,
          authHeader,
          signal
        });
      }catch(error){
        if (signal?.aborted || error?.name === "AbortError"){
          throw NCFileLinkDav.createAbortError();
        }
        const lookupError = NCFileLinkDav.createTechnicalError(
          error?.message || String(error)
        );
        lookupError.cause = error;
        throw lookupError;
      }
      if (previous.share){
        if (previousFingerprint !== fingerprint){
          throw NCFileLinkDav.createTechnicalError(
            "Existing share settings could not be verified"
          );
        }
        INDETERMINATE_PATHS.delete(createKey);
        return previous.share;
      }
      if (!previous.known){
        throw NCFileLinkDav.createTechnicalError(
          "Share creation result is unknown"
        );
      }
      INDETERMINATE_PATHS.delete(createKey);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++){
      let unclear = false;
      let response = null;
      try{
        response = await sendCreate({
          endpoint,
          authHeader,
          payload: new URLSearchParams(payload),
          signal
        });
        if (NCOcs.isExplicitSuccess(response)){
          const share = readShareData(response.data?.ocs?.data);
          if (share){
            INDETERMINATE_PATHS.delete(createKey);
            return share;
          }
          unclear = true;
          lastError = NCFileLinkDav.createTechnicalError(
            "Share creation returned incomplete data"
          );
        }else{
          lastError = responseError(response);
          unclear = UNCLEAR_HTTP_STATUSES.includes(Number(response.status))
            && !NCOcs.hasExplicitResult(response);
          if (!unclear){
            throw lastError;
          }
        }
      }catch(error){
        if (signal?.aborted || error?.name === "AbortError"){
          INDETERMINATE_PATHS.set(createKey, fingerprint);
          throw NCFileLinkDav.createAbortError();
        }
        if (error === lastError && !unclear){
          throw error;
        }
        lastError = error?.ncUserMessage
          ? error
          : NCFileLinkDav.createTechnicalError(
            error?.message || String(error)
          );
        unclear = true;
      }

      if (!unclear){
        throw lastError || NCFileLinkDav.createTechnicalError(
          "Share creation failed"
        );
      }

      INDETERMINATE_PATHS.set(createKey, fingerprint);
      let lookup;
      try{
        lookup = await lookupShare({
          endpoint,
          relativeFolder,
          authHeader,
          signal
        });
      }catch(error){
        if (signal?.aborted || error?.name === "AbortError"){
          throw NCFileLinkDav.createAbortError();
        }
        throw lastError || error;
      }
      if (lookup.share){
        INDETERMINATE_PATHS.delete(createKey);
        return lookup.share;
      }
      if (!lookup.known){
        throw lastError || NCFileLinkDav.createTechnicalError(
          "Share creation result is unknown"
        );
      }
      INDETERMINATE_PATHS.delete(createKey);
      if (attempt >= 2){
        throw lastError || NCFileLinkDav.createTechnicalError(
          "Share creation failed"
        );
      }
    }
    throw lastError || NCFileLinkDav.createTechnicalError(
      "Share creation failed"
    );
  }

  function subscribeToCreate(entry, signal){
    entry.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value, aborted = false) => {
        if (settled){
          return;
        }
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        entry.waiters = Math.max(0, entry.waiters - 1);
        if (aborted && entry.waiters === 0 && !entry.controller.signal.aborted){
          entry.controller.abort();
        }
        callback(value);
      };
      const onAbort = () => finish(
        reject,
        NCFileLinkDav.createAbortError(),
        true
      );
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted){
        onAbort();
        return;
      }
      entry.request.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
  }

  async function create(options = {}){
    const normalizedOptions = {
      ...options,
      baseUrl: String(options.baseUrl || "")
    };
    const normalizedEndpoint = `${normalizedOptions.baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/files_sharing/api/v1/shares`;
    const payload = buildCreatePayload(normalizedOptions);
    const accountFingerprint = await fingerprintValue(normalizedOptions.authHeader);
    const fingerprint = await fingerprintPayload(payload, accountFingerprint);
    const createKey = getCreateKey(
      normalizedEndpoint,
      normalizedOptions.relativeFolder,
      accountFingerprint
    );
    const inflight = CREATE_INFLIGHT.get(createKey);
    if (inflight){
      if (inflight.fingerprint !== fingerprint){
        throw NCFileLinkDav.createTechnicalError(
          "Share creation already uses different settings"
        );
      }
      return subscribeToCreate(inflight, normalizedOptions.signal);
    }
    const controller = new AbortController();
    const request = createOnce(
      {
        ...normalizedOptions,
        signal: controller.signal
      },
      normalizedEndpoint,
      createKey,
      fingerprint
    );
    const entry = {
      fingerprint,
      request,
      controller,
      waiters: 0
    };
    CREATE_INFLIGHT.set(createKey, entry);
    request.then(() => {
      if (CREATE_INFLIGHT.get(createKey) === entry){
        CREATE_INFLIGHT.delete(createKey);
      }
    }, () => {
      if (CREATE_INFLIGHT.get(createKey) === entry){
        CREATE_INFLIGHT.delete(createKey);
      }
    });
    return subscribeToCreate(entry, normalizedOptions.signal);
  }

  async function clearIndeterminate({
    baseUrl,
    relativeFolder,
    authHeader
  } = {}){
    if (!authHeader){
      return false;
    }
    const endpoint = `${String(baseUrl || "").replace(/\/+$/, "")}/ocs/v2.php/apps/files_sharing/api/v1/shares`;
    const accountFingerprint = await fingerprintValue(authHeader);
    return INDETERMINATE_PATHS.delete(
      getCreateKey(endpoint, relativeFolder, accountFingerprint)
    );
  }

  global.NCFileLinkShare = Object.freeze({
    create,
    clearIndeterminate
  });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
