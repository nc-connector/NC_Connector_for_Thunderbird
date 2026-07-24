"use strict";

const vm = require("node:vm");
const {
  assert,
  loadScript
} = require("./review-check-utils");

function makeResponse(status, body, options = {}){
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: options.statusText || (status === 200 ? "OK" : "Error"),
    url: options.url || "",
    headers: {
      get: () => options.contentType || "application/json"
    },
    text: options.text || (async () => String(body || ""))
  };
}

function formatLogValue(value, seen = new WeakSet()){
  if (value == null || typeof value !== "object"){
    return String(value ?? "");
  }
  if (typeof value.message === "string"){
    return `${value.name || "Error"}: ${value.message}`;
  }
  if (seen.has(value)){
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)){
    return value.map((entry) => formatLogValue(entry, seen)).join(" ");
  }
  return Object.entries(value)
    .map(([key, entry]) => `${key}=${formatLogValue(entry, seen)}`)
    .join(" ");
}

function collectLogText(logs){
  return logs
    .flatMap((entry) => entry)
    .map((entry) => formatLogValue(entry))
    .join("\n");
}

async function expectRejected(callback, label){
  let failure = null;
  try{
    await callback();
  }catch(error){
    failure = error;
  }
  assert(failure, label);
  return failure;
}

function createCoreHarness({
  fetchImpl,
  clock = null,
  localStorage = {},
  managedSetup = undefined
} = {}){
  const logs = [];
  const requests = [];
  const timeoutCalls = [];
  let timeoutDepth = 0;
  const testConsole = {
    error: (...args) => logs.push(args),
    log: () => {},
    warn: () => {}
  };
  const context = {
    console: testConsole,
    URL,
    Buffer,
    AbortController,
    DOMException,
    globalThis: null,
    window: null,
    Date: clock ? { now: () => clock.now } : Date,
    setTimeout: clock
      ? ((callback, delayMs) => {
        clock.now += Math.max(0, Number(delayMs) || 0);
        callback();
        return 1;
      })
      : setTimeout,
    clearTimeout: clock ? (() => {}) : clearTimeout,
    browser: {
      i18n: {
        getMessage: (key) => key
      },
      storage: {
        local: {
          get: async () => localStorage
        }
      }
    },
    NCTalkTextUtils: {
      normalizeBaseUrl: (value) => {
        const normalized = String(value || "").trim().replace(/\/+$/, "");
        return normalized.startsWith("https://") ? normalized : "";
      },
      shortId: (value) => String(value || "").slice(0, 24)
    },
    NCOcs: {
      buildAuthHeader: (user, password) =>
        "Basic " + Buffer.from(`${user}:${password}`, "utf8").toString("base64"),
      runWithTimeout: async (callback, options = {}) => {
        const controller = new AbortController();
        timeoutCalls.push({
          options,
          signal: controller.signal
        });
        timeoutDepth += 1;
        try{
          return await callback(controller.signal);
        }finally{
          timeoutDepth -= 1;
        }
      }
    },
    NCHostPermissions: {
      requireOriginPermission: async () => true
    },
    NCManagedSetup: managedSetup,
    bgI18n: (key) => key,
    L: () => {},
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (typeof fetchImpl !== "function"){
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return fetchImpl({
        url,
        options,
        insideTimeout: () => timeoutDepth > 0,
        requestIndex: requests.length - 1
      });
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("modules/logContext.js", context);
  loadScript("modules/nccore.js", context, ";globalThis.__NCCore = NCCore;");
  return {
    core: context.__NCCore,
    logs,
    requests,
    timeoutCalls
  };
}

module.exports = {
  makeResponse,
  collectLogText,
  expectRejected,
  createCoreHarness
};
