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

function loadPolicyRuntime(payload, response = {}){
  const context = {
    console,
    globalThis: null,
    fetch: async (endpointUrl) => {
      if (response.fallbackError && endpointUrl.includes("/index.php/")){
        throw response.fallbackError;
      }
      if (response.error){
        throw response.error;
      }
      return {
        ok: !response.status || response.status === 200,
        status: response.status || 200,
        statusText: "Fixture response",
        url: endpointUrl,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify(payload)
      };
    },
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

function verifyStatusNotices(policy, vfsPolicy){
  const cases = [
    { name: "active", fields: { licenseStatus: "ACTIVE", accessStatus: "ACTIVE" }, code: "", usable: true },
    { name: "grace", fields: { licenseStatus: "EXPIRED", accessStatus: "GRACE" }, code: "license_grace", usable: true },
    { name: "expired", fields: { isValid: false, licenseStatus: "EXPIRED", accessStatus: "EXPIRED" }, code: "license_expired" },
    { name: "inactive", fields: { isValid: false, licenseStatus: "INACTIVE", accessStatus: "INACTIVE" }, code: "license_inactive" },
    { name: "invalid", fields: { isValid: false, licenseStatus: "INVALID", accessStatus: "INVALID" }, code: "license_invalid_explicit" },
    { name: "activation conflict", fields: { isValid: false, licenseStatus: "ACTIVE", accessStatus: "ACTIVATION_REQUIRED", licenseActivationState: "conflict" }, code: "license_activation_conflict" },
    { name: "activation missing", fields: { isValid: false, licenseStatus: "ACTIVE", accessStatus: "ACTIVATION_REQUIRED", licenseActivationState: "proof_required" }, code: "license_activation_required" },
    { name: "credentials changed with enforcement off", fields: { isValid: false, licenseStatus: "INVALID", accessStatus: "INVALID", licenseActivationState: "credentials_changed" }, code: "license_invalid_explicit" },
    { name: "offline expired", fields: { isValid: false, licenseStatus: "ACTIVE", accessStatus: "OFFLINE_EXPIRED", licenseConnectionError: true }, code: "license_offline_expired" },
    { name: "sync failure", fields: { licenseStatus: "ACTIVE", accessStatus: "ACTIVE", licenseConnectionError: true }, code: "license_connection_error", usable: true },
    { name: "legacy active", fields: {}, code: "", usable: true },
    { name: "legacy invalid", fields: { isValid: false }, code: "license_invalid" },
    { name: "overlicensed", fields: { overlicensed: true }, code: "overlicensed" },
    { name: "suspended seat", fields: { seatState: "suspended_overlimit" }, code: "seat_paused", seat: true },
    { name: "unavailable seat", fields: { seatState: "revoked" }, code: "seat_unavailable", seat: true }
  ];
  for (const entry of cases){
    for (const canManageLicense of [false, true]){
      for (const seatAssigned of [false, true]){
        const status = createActiveStatus();
        Object.assign(status.status, entry.fields, { seatAssigned, canManageLicense });
        const before = JSON.stringify(status);
        const notice = policy.getStatusNotice(status);
        const expected = !seatAssigned && (!canManageLicense || !entry.code || entry.seat)
          ? "no_seat"
          : entry.code;
        const label = `${entry.name}, admin=${canManageLicense}, seat=${seatAssigned}`;
        assert(notice.code === expected, `${label}: expected ${expected}, got ${notice.code}`);
        assert(notice.canManageLicense === canManageLicense, `${label}: keep the verified admin role`);
        const usable = seatAssigned && entry.usable === true;
        assert(policy.hasSeatEntitlement(status) === usable, `${label}: notice metadata must not change seat access`);
        assert(policy.hasProSeatEntitlement(status) === usable, `${label}: notice metadata must not change Pro access`);
        const vfs = vfsPolicy.resolveExternalSetting(status, true, true);
        assert(vfs.enabled === usable && vfs.entitled === usable, `${label}: VFS must retain the existing gate`);
        assert(vfs.notice?.code === expected, `${label}: VFS must carry the shared notice`);
        assert(vfs.unavailableReason === policy.getProSeatUnavailableReason(status), `${label}: VFS reason codes must remain unchanged`);
        assert(JSON.stringify(status) === before, `${label}: classification must not mutate policy state`);
      }
    }
  }
  for (const metadata of [
    { accessStatus: "GRACE", licenseStatus: "EXPIRED" },
    { accessStatus: "ACTIVE", licenseStatus: "ACTIVE" },
    { accessStatus: "OFFLINE_EXPIRED", licenseStatus: "ACTIVE" }
  ]){
    const status = createActiveStatus();
    Object.assign(status.status, metadata, { seatState: "suspended_overlimit", isValid: true });
    assert(policy.hasSeatEntitlement(status) === false, "License metadata cannot restore a suspended seat");
    if (metadata.accessStatus === "GRACE"){
      assert(policy.getStatusNotice(status).code === "seat_paused", "A suspended seat must not promise grace access");
    }
  }
  for (const value of [undefined, null, false, 0, 1, "true", "false", {}, []]){
    const status = createActiveStatus();
    Object.assign(status.status, { seatAssigned: false, isValid: false, accessStatus: "EXPIRED", canManageLicense: value });
    const notice = policy.getStatusNotice(status);
    assert(notice.code === "no_seat" && notice.canManageLicense === false, "Only boolean true may select administrator guidance");
  }
  for (const graceUntilIso of [null, "not-a-date", "2000-01-01T00:00:00Z", "2999-01-01T00:00:00Z"]){
    const status = createActiveStatus();
    Object.assign(status.status, { isValid: false, accessStatus: "EXPIRED", licenseStatus: "EXPIRED", graceUntilIso });
    assert(policy.getStatusNotice(status).code === "license_expired", "Local dates cannot reopen an expired license");
    assert(!policy.hasSeatEntitlement(status), "A future display date cannot grant entitlement");
  }
  for (const accessStatus of ["EXPIRED", "INACTIVE", "INVALID", "ACTIVATION_REQUIRED", "OFFLINE_EXPIRED"]){
    const status = createActiveStatus();
    Object.assign(status.status, { isValid: false, accessStatus, licenseStatus: "ACTIVE", licenseConnectionError: true });
    const notice = policy.getStatusNotice(status);
    assert(notice.code !== "license_connection_error", "Synchronization failure must not replace the blocking cause");
    assert(notice.connectionError === true, "The primary cause must retain secondary synchronization context");
  }
}

async function verifyRuntimeMetadata(policy){
  const payload = createOverlicensedPayload();
  Object.assign(payload.status, {
    overlicensed: false,
    mode: "pro",
    license_status: " expired ",
    access_status: " grace ",
    can_manage_license: true,
    license_activation: { state: " ACTIVATED " },
    license_connection_error: true,
    grace_until_iso: "2026-09-30T12:00:00Z",
    license_last_sync_at_iso: "2026-09-16T12:00:00Z",
    license_offline_until_iso: "2026-09-30T12:00:00Z"
  });
  const result = await loadPolicyRuntime(payload).getPolicyStatus();
  const expected = {
    licenseStatus: "EXPIRED", accessStatus: "GRACE", canManageLicense: true,
    licenseActivationState: "activated", licenseConnectionError: true,
    licenseLastSyncAtIso: payload.status.license_last_sync_at_iso,
    licenseOfflineUntilIso: payload.status.license_offline_until_iso
  };
  for (const [field, value] of Object.entries(expected)){
    assert(result.status[field] === value, `Runtime must normalize ${field}`);
  }
  assert(result.policyActive === true, "Informational grace must preserve active policy domains");
  assert(result.warning.visible === true && result.warning.code === "license_grace", "Runtime warning metadata must expose grace");
  const notice = policy.getStatusNotice(result);
  assert(notice.graceUntilIso === payload.status.grace_until_iso, "Notice must carry the backend grace date");
  assert(notice.lastSyncAtIso === expected.licenseLastSyncAtIso && notice.offlineUntilIso === expected.licenseOfflineUntilIso, "Notice must carry synchronization dates");
  for (const malformed of [undefined, null, 1, {}, []]){
    const fixture = createOverlicensedPayload();
    Object.assign(fixture.status, {
      overlicensed: false,
      license_status: malformed, access_status: malformed, license_activation: malformed,
      can_manage_license: malformed, license_connection_error: malformed,
      license_last_sync_at_iso: malformed, license_offline_until_iso: malformed
    });
    const normalized = await loadPolicyRuntime(fixture).getPolicyStatus();
    assert(normalized.status.licenseStatus === "" && normalized.status.accessStatus === "" && normalized.status.licenseActivationState === "", "Malformed optional status labels must stay empty");
    assert(normalized.status.canManageLicense === false && normalized.status.licenseConnectionError === false, "Optional boolean metadata must be strict");
    assert(normalized.status.licenseLastSyncAtIso === null && normalized.status.licenseOfflineUntilIso === null, "Malformed optional dates must stay absent");
    assert(normalized.policyActive === true && normalized.warning.visible === false, "Missing optional metadata must preserve legacy active behavior");
  }
  for (const value of ["true", "false", 1]){
    const fixture = createOverlicensedPayload();
    Object.assign(fixture.status, { overlicensed: false, can_manage_license: value, license_connection_error: value });
    const normalized = await loadPolicyRuntime(fixture).getPolicyStatus();
    assert(normalized.status.canManageLicense === false && normalized.status.licenseConnectionError === false, "Truthy metadata must not grant admin guidance or fabricate a connection failure");
  }
  const missing = await loadPolicyRuntime(null, { status: 404 }).getPolicyStatus();
  assert(missing.warning.visible === false && policy.getStatusNotice(missing).code === "", "An optional missing backend must remain silent");
  for (const response of [{ error: new Error("Fixture network failure") }, { status: 503 }, { status: 404, fallbackError: new Error("Fixture fallback failure") }, {}]){
    const failed = await loadPolicyRuntime(null, response).getPolicyStatus();
    assert(failed.warning.visible === true && failed.warning.code === "backend_unavailable", "A failed backend request must remain distinct from a license refusal");
    assert(policy.getStatusNotice(failed).license === false, "Transport failure must not claim an invalid license");
  }
  const setup = await loadPolicyRuntime(null).probePolicyStatus({});
  assert(setup.warning.visible === false && policy.getStatusNotice(setup).code === "", "Missing credentials must not fabricate a license warning");
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
  const defaultProviderSetting = vfsPolicy.resolveProviderSetting(oldBackendStatus, false, false);
  assert(
    defaultProviderSetting.enabled === true
      && defaultProviderSetting.localEnabled === true
      && defaultProviderSetting.configured === false,
    "The built-in NC Connector VFS provider must start enabled"
  );
  const disabledProviderSetting = vfsPolicy.resolveProviderSetting(oldBackendStatus, false, true);
  assert(
    disabledProviderSetting.enabled === false
      && disabledProviderSetting.localEnabled === false
      && disabledProviderSetting.configured === true,
    "An explicit local choice must be able to disable the NC Connector VFS provider"
  );
  const defaultExternalSetting = vfsPolicy.resolveExternalSetting(oldBackendStatus, false, false);
  assert(
    defaultExternalSetting.enabled === false && defaultExternalSetting.entitled === true,
    "External VFS providers must remain disabled until the user enables them"
  );
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

  verifyStatusNotices(policy, vfsPolicy);
  await verifyRuntimeMetadata(policy);

  console.log("[OK] policy-contract-check passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
