"use strict";

const vm = require("node:vm");
const {
  assert,
  loadScript
} = require("./review-check-utils");
const { makeResponse } = require("./network-security-test-utils");

async function run(){
  const timeoutCalls = [];
  let timeoutDepth = 0;
  let bodyReadInsideTimeout = false;
  let requestSignal = null;
  const payload = {
    status: {
      user_id: "alice",
      seat_assigned: true,
      seat_state: "active",
      overlicensed: false,
      is_valid: true
    },
    policy: {
      share: {},
      talk: {},
      email_signature: {}
    },
    policy_editable: {
      share: {},
      talk: {},
      email_signature: {}
    }
  };
  const context = {
    console,
    AbortController,
    globalThis: null,
    window: null,
    NCCore: {
      normalizeBaseUrl: (value) => String(value || "").replace(/\/+$/, ""),
      getOpts: async () => ({
        baseUrl: "https://cloud.example.test",
        user: "alice",
        appPass: "app-password"
      })
    },
    NCHostPermissions: {
      requireOriginPermission: async () => true
    },
    NCOcs: {
      buildAuthHeader: () => "Basic test",
      runWithTimeout: async (callback, options = {}) => {
        const controller = new AbortController();
        timeoutCalls.push({ options, signal: controller.signal });
        timeoutDepth += 1;
        try{
          return await callback(controller.signal);
        }finally{
          timeoutDepth -= 1;
        }
      }
    },
    NCLogContext: {
      safeConsoleError: () => {}
    },
    bgI18n: (key) => key,
    L: () => {},
    fetch: async (_url, options = {}) => {
      requestSignal = options.signal;
      return makeResponse(200, "", {
        text: async () => {
          bodyReadInsideTimeout = timeoutDepth > 0;
          return JSON.stringify(payload);
        }
      });
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("modules/policyState.js", context, ";globalThis.NCPolicyState = NCPolicyState;");
  loadScript("modules/policyRuntime.js", context, ";globalThis.__NCPolicyRuntime = NCPolicyRuntime;");

  const result = await context.__NCPolicyRuntime.getPolicyStatus();
  assert(result.fetchSucceeded === true, "A valid backend status response must still be accepted");
  assert(timeoutCalls.length === 1, "Policy status must use the shared request timeout");
  assert(requestSignal === timeoutCalls[0].signal, "Policy fetch must receive the timeout signal");
  assert(bodyReadInsideTimeout, "Policy response body reads must stay inside the request timeout");
  console.log("[OK] policy-network-timeout-check passed");
}

run().catch((error) => {
  console.error("[FAIL] policy-network-timeout-check", error);
  process.exitCode = 1;
});
