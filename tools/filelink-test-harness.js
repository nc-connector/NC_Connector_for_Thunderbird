"use strict";

const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { loadScript } = require("./review-check-utils");

function createFakeClock(start = 100000){
  let now = Number(start) || 0;
  let nextId = 1;
  const timers = new Map();

  function setTimer(callback, delay = 0){
    const id = nextId++;
    timers.set(id, {
      callback,
      due: now + Math.max(0, Number(delay) || 0)
    });
    return id;
  }

  function clearTimer(id){
    timers.delete(id);
  }

  function advance(milliseconds){
    const target = now + Math.max(0, Number(milliseconds) || 0);
    while (true){
      let selectedId = null;
      let selected = null;
      for (const [id, timer] of timers){
        if (timer.due > target){
          continue;
        }
        if (!selected || timer.due < selected.due || (timer.due === selected.due && id < selectedId)){
          selectedId = id;
          selected = timer;
        }
      }
      if (!selected){
        break;
      }
      timers.delete(selectedId);
      now = selected.due;
      selected.callback();
    }
    now = target;
  }

  return {
    now: () => now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    advance,
    pendingCount: () => timers.size
  };
}

function createClockDate(clock){
  const NativeDate = Date;
  return class ClockDate extends NativeDate{
    constructor(...args){
      super(...(args.length ? args : [clock.now()]));
    }

    static now(){
      return clock.now();
    }

    static parse(value){
      return NativeDate.parse(value);
    }

    static UTC(...args){
      return NativeDate.UTC(...args);
    }
  };
}

function createUploadContext(overrides = {}){
  const context = {
    console,
    Blob,
    TextEncoder,
    TextDecoder,
    ArrayBuffer,
    Uint8Array,
    URL,
    URLSearchParams,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    AbortController,
    DOMException,
    Date,
    Math,
    JSON,
    globalThis: null,
    window: null,
    self: null,
    module: undefined,
    exports: undefined,
    bgI18n: (key) => key,
    NCLogContext: {
      safeConsoleError: () => {}
    },
    ...overrides
  };
  context.globalThis = context;
  context.window = context;
  context.self = context;
  vm.createContext(context);
  return context;
}

function loadUploadModules(context, modules){
  const requested = Array.isArray(modules) ? modules : [];
  for (const relativePath of requested){
    loadScript(relativePath, context);
  }
  return context;
}

function makeDavResponse(status, options = {}){
  const headerValues = new Map(
    Object.entries(options.headers || {}).map(([name, value]) => [
      name.toLowerCase(),
      String(value)
    ])
  );
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: options.statusText || "",
    headers: {
      get: (name) => headerValues.get(String(name || "").toLowerCase()) || null
    },
    text: async () => String(options.body || ""),
    body: {
      cancel: async () => {
        options.onCancel?.();
      }
    }
  };
  return response;
}

async function flushMicrotasks(rounds = 12){
  for (let index = 0; index < rounds; index++){
    await Promise.resolve();
  }
}

async function expectFailure(callback, message){
  let failure = null;
  try{
    await callback();
  }catch(error){
    failure = error;
  }
  if (!failure){
    throw new Error(message);
  }
  return failure;
}

module.exports = {
  createFakeClock,
  createClockDate,
  createUploadContext,
  loadUploadModules,
  makeDavResponse,
  flushMicrotasks,
  expectFailure
};
