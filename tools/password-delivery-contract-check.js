"use strict";

const vm = require("node:vm");
const { assert, loadScript } = require("./review-check-utils");

function loadDeliveryApi(){
  const context = {
    console,
    module: undefined,
    window: null,
    globalThis: null
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/policyState.js", context, "\nglobalThis.NCPolicyState = NCPolicyState;");
  loadScript("modules/sharePasswordDelivery.js", context);
  return context.NCSharePasswordDelivery;
}

function createStatus(modeValue, expireDays = 30){
  return {
    policyActive: true,
    policyDomains: {
      share: { available: true, active: true }
    },
    policy: {
      share: {
        share_send_password_mode: modeValue,
        share_secrets_expire_days: expireDays
      }
    },
    policyEditable: {
      share: {
        share_send_password_mode: true,
        share_secrets_expire_days: false
      }
    }
  };
}

function run(){
  const delivery = loadDeliveryApi();

  assert(delivery.normalizeMode("secrets") === "secrets", "secrets mode should be accepted");
  assert(delivery.normalizeMode(" SECRETS ") === "secrets", "secrets mode should be case-insensitive");
  assert(delivery.normalizeMode("plain") === "plain", "plain mode should be accepted");
  assert(delivery.normalizeMode("other") === "plain", "Unknown mode should fall back to plain");

  assert(delivery.coerceMode(null, "secrets") === "secrets", "Missing mode should use fallback");
  assert(delivery.coerceMode("", "plain") === "plain", "Empty mode should use fallback");
  assert(delivery.coerceMode("secrets", "plain") === "secrets", "Explicit mode should override fallback");

  assert(delivery.clampSecretsExpireDays("0") === 1, "Secrets expiry should clamp to minimum");
  assert(delivery.clampSecretsExpireDays("366") === 365, "Secrets expiry should clamp to maximum");
  assert(delivery.clampSecretsExpireDays("abc") === 7, "Invalid expiry should use default");
  assert(delivery.coerceSecretsExpireDays(null, 14) === 14, "Missing expiry should use fallback");

  assert(delivery.isSecretsUnavailable(createStatus(null)) === true, "Explicit null mode from active backend should mean Secrets unavailable");
  assert(delivery.isSecretsUnavailable(createStatus("secrets")) === false, "Explicit secrets mode should be available");
  assert(delivery.isSecretsUnavailable({ ...createStatus(null), policyDomains: { share: { available: true, active: false } } }) === false, "Inactive policy domain should not block Secrets");
  assert(delivery.isSecretsUnavailable({ policyActive: true, policy: { share: {} }, policyEditable: { share: {} } }) === false, "Missing mode key should remain backward-compatible");

  assert(delivery.resolveSecretsExpireDays(createStatus("secrets", 21)) === 21, "Policy expiry should be used");
  assert(delivery.resolveSecretsExpireDays(createStatus("secrets", null)) === 7, "Null policy expiry should use default");
  assert(delivery.resolveSecretsExpireDays({ policy: { share: {} }, policyEditable: { share: {} } }) === 7, "Missing policy expiry key should use default");

  console.log("[OK] password-delivery-contract-check passed");
}

run();
