"use strict";

const vm = require("node:vm");
const { assert, loadScript } = require("./review-check-utils");

function loadPolicyState(){
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/policyState.js", context, "\nglobalThis.NCPolicyState = NCPolicyState;");
  return context.NCPolicyState;
}

function createActiveStatus(){
  return {
    endpointAvailable: true,
    policyActive: true,
    status: {
      seatAssigned: true,
      isValid: true,
      seatState: "active",
      overlicensed: false,
      mode: "pro"
    },
    policy: {
      share: {
        share_set_password: true,
        share_base_directory: "Team Shares",
        share_send_password_mode: null
      }
    },
    policyEditable: {
      share: {
        share_set_password: false,
        share_base_directory: true,
        share_send_password_mode: false
      }
    },
    policyDomains: {
      share: { available: true, active: true }
    }
  };
}

function loadVfsPolicyRuntime(){
  const context = {
    globalThis: null,
    Date,
    bgI18n: (key) => key,
    NCPolicyRuntime: { getPolicyStatus: async () => createActiveStatus() },
    NCSharingStorage: {
      SHARE_POLICY_KEYS: {
        vfsProviderEnabled: "vfs_provider_enabled",
        vfsExternalProvidersEnabled: "vfs_external_providers_enabled"
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/policyState.js", context, "\nglobalThis.NCPolicyState = NCPolicyState;");
  loadScript("modules/vfsPolicyRuntime.js", context, "\nglobalThis.NCVfsPolicyRuntime = NCVfsPolicyRuntime;");
  return context.NCVfsPolicyRuntime;
}

function loadPolicyRuntime(payload){
  const context = {
    console,
    globalThis: null,
    fetch: async (endpointUrl) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      url: endpointUrl,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(payload)
    }),
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
      runWithTimeout: (callback) => callback(undefined)
    },
    NCLogContext: {
      safeConsoleError: () => {}
    },
    bgI18n: (key) => key,
    L: () => {}
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/policyState.js", context, "\nglobalThis.NCPolicyState = NCPolicyState;");
  loadScript("modules/policyRuntime.js", context, "\nglobalThis.NCPolicyRuntime = NCPolicyRuntime;");
  return context.NCPolicyRuntime;
}

function createOverlicensedPayload(){
  return {
    status: {
      user_id: "alice",
      seat_assigned: true,
      seat_state: "active",
      overlicensed: true,
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
}

async function run(){
  const policy = loadPolicyState();
  const activeStatus = createActiveStatus();

  assert(policy.isSeatUsable(activeStatus.status) === true, "Active assigned seat should be usable");
  assert(policy.hasSeatEntitlement(activeStatus) === true, "Active endpoint and seat should have entitlement");
  assert(policy.hasProSeatEntitlement(activeStatus) === true, "An active Pro seat should unlock Pro features");
  assert(
    policy.getProSeatUnavailableReason({ ...activeStatus, endpointAvailable: false }) === "backend_required",
    "A missing backend must explain that Pro-gated features require the backend"
  );
  assert(
    policy.getProSeatUnavailableReason({
      ...activeStatus,
      status: { ...activeStatus.status, mode: "community" }
    }) === "pro_required",
    "Community mode must not unlock Pro-only VFS sources"
  );
  assert(
    policy.hasSeatEntitlement({ ...activeStatus, status: { ...activeStatus.status, seatState: "ACTIVE" } }) === true,
    "Seat state matching should be case-insensitive"
  );
  assert(policy.isDomainAvailable(activeStatus, "share") === true, "Share domain should be available");
  assert(policy.isDomainActive(activeStatus, "share") === true, "Share domain should be active");

  assert(policy.isLocked(activeStatus, "share", "share_set_password") === true, "Non-editable policy key should be locked");
  assert(
    policy.resolveValue(activeStatus, "share", "share_set_password", false, policy.coerceBoolean) === true,
    "Locked boolean policy value should override local value"
  );
  assert(
    policy.resolveValue(activeStatus, "share", "share_base_directory", "Local Shares", policy.coerceString) === "Local Shares",
    "Editable policy key should preserve local value"
  );

  assert(policy.hasPolicyKey(activeStatus, "share", "share_send_password_mode") === true, "Explicit null policy key should still count as present");
  assert(policy.isExplicitNull(activeStatus, "share", "share_send_password_mode") === true, "Explicit null policy value should be detectable");
  assert(policy.isExplicitNull(activeStatus, "share", "missing_key") === false, "Missing policy key must not be treated as explicit null");

  const inactiveStatus = {
    ...activeStatus,
    policyActive: false,
    policyDomains: {
      share: { available: true, active: false }
    }
  };
  assert(policy.isLocked(inactiveStatus, "share", "share_set_password") === false, "Inactive policy domain must not lock local settings");
  assert(policy.hasSeatEntitlement({ ...activeStatus, endpointAvailable: false }) === false, "Missing backend endpoint must disable seat entitlement");
  assert(policy.isSeatUsable({ ...activeStatus.status, overlicensed: true }) === false, "Overlicensed seat must not be usable");
  assert(
    policy.hasSeatEntitlement({ ...activeStatus, status: { ...activeStatus.status, overlicensed: true } }) === false,
    "Overlicensed seat must not retain backend-only entitlement"
  );

  const domainState = policy.buildDomainState(activeStatus.policy.share, activeStatus.policyEditable.share, true);
  assert(domainState.available === true && domainState.active === true, "Domain state should be active when policy/editable domains and seat are present");
  const missingEditableState = policy.buildDomainState(activeStatus.policy.share, null, true);
  assert(missingEditableState.available === false && missingEditableState.active === false, "Policy domain without editable metadata should be inactive");

  const vfsPolicy = loadVfsPolicyRuntime();
  const oldBackendStatus = createActiveStatus();
  const oldBackendSetting = vfsPolicy.resolveExternalSetting(oldBackendStatus, true, true);
  assert(
    oldBackendSetting.enabled === true && oldBackendSetting.locked === false,
    "A backend without VFS policy keys must preserve the user's local VFS setting"
  );
  const lockedStatus = createActiveStatus();
  lockedStatus.policy.share.vfs_external_providers_enabled = false;
  lockedStatus.policyEditable.share.vfs_external_providers_enabled = false;
  const lockedSetting = vfsPolicy.resolveExternalSetting(lockedStatus, true, true);
  assert(
    lockedSetting.enabled === false && lockedSetting.locked === true,
    "A locked backend policy must override the local external-provider setting"
  );
  const communitySetting = vfsPolicy.resolveExternalSetting({
    ...activeStatus,
    status: { ...activeStatus.status, mode: "community" }
  }, true, true);
  assert(
    communitySetting.enabled === false
      && communitySetting.entitled === false
      && communitySetting.unavailableReason === "pro_required",
    "Community mode must close only the external-provider gate"
  );

  const runtime = loadPolicyRuntime(createOverlicensedPayload());
  const overlicensedStatus = await runtime.getPolicyStatus();
  assert(overlicensedStatus.policyActive === false, "Overlicensed status must disable backend policy");
  assert(overlicensedStatus.mode === "local", "Overlicensed status must select local mode");
  assert(overlicensedStatus.reason === "overlicensed", "Overlicensed status should expose its own mode reason");
  assert(overlicensedStatus.warning?.visible === true, "Overlicensed status should show the policy warning");
  assert(overlicensedStatus.warning?.code === "overlicensed", "Overlicensed status should expose its own warning code");
  for (const domain of ["share", "talk", "email_signature"]){
    assert(overlicensedStatus.policyDomains?.[domain]?.available === true, `Overlicensed ${domain} domain should remain detectable`);
    assert(overlicensedStatus.policyDomains?.[domain]?.active === false, `Overlicensed ${domain} domain must be inactive`);
  }

  console.log("[OK] policy-contract-check passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
