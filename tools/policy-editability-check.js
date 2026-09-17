"use strict";

const vm = require("node:vm");
const { assert, loadScript, readText } = require("./review-check-utils");

const EDITABLE_POLICY_KEYS = [
  { domain: "share", key: "share_base_directory", type: "string" },
  { domain: "share", key: "share_name_template", type: "string" },
  { domain: "share", key: "share_permission_upload", type: "boolean" },
  { domain: "share", key: "share_permission_edit", type: "boolean" },
  { domain: "share", key: "share_permission_delete", type: "boolean" },
  { domain: "share", key: "share_set_password", type: "boolean" },
  { domain: "share", key: "share_send_password_separately", type: "boolean" },
  { domain: "share", key: "share_send_password_mode", type: "string" },
  { domain: "share", key: "share_expire_days", type: "int" },
  { domain: "share", key: "attachment_link_target", type: "string" },
  { domain: "share", key: "language_share_html_block", type: "string" },
  { domain: "share", key: "attachments_always_via_ncconnector", type: "boolean" },
  { domain: "share", key: "attachments_min_size_mb", type: "int" },
  { domain: "talk", key: "talk_title", type: "string" },
  { domain: "talk", key: "talk_lobby_active", type: "boolean" },
  { domain: "talk", key: "talk_show_in_search", type: "boolean" },
  { domain: "talk", key: "talk_add_users", type: "boolean" },
  { domain: "talk", key: "talk_add_guests", type: "boolean" },
  { domain: "talk", key: "talk_set_password", type: "boolean" },
  { domain: "talk", key: "talk_delete_room_on_event_delete", type: "boolean" },
  { domain: "talk", key: "language_talk_description", type: "string" },
  { domain: "talk", key: "talk_room_type", type: "string" },
  { domain: "email_signature", key: "email_signature_on_compose", type: "boolean" },
  { domain: "email_signature", key: "email_signature_on_reply", type: "boolean" },
  { domain: "email_signature", key: "email_signature_on_forward", type: "boolean" }
];

function loadPolicyApis(){
  const context = {
    console,
    URL,
    Date,
    globalThis: null,
    window: null
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("modules/policyState.js", context, "\nglobalThis.NCPolicyState = NCPolicyState;");
  loadScript("ui/wizardPolicyUi.js", context);
  return {
    policyState: context.NCPolicyState,
    policyUi: context.NCWizardPolicyUi
  };
}

function loadSharingStorage(){
  const context = {
    console,
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  loadScript("modules/sharingStorage.js", context, "\nglobalThis.NCSharingStorage = NCSharingStorage;");
  return context.NCSharingStorage;
}

function createStatus(entry, editable, active = true){
  return {
    endpointAvailable: true,
    policyActive: active,
    policy: {
      [entry.domain]: {
        [entry.key]: entry.backendValue
      }
    },
    policyEditable: {
      [entry.domain]: {
        [entry.key]: editable
      }
    },
    policyDomains: {
      [entry.domain]: {
        available: true,
        active
      }
    }
  };
}

function getValues(entry){
  if (entry.type === "boolean"){
    return { localValue: false, backendValue: true };
  }
  if (entry.type === "int"){
    return { localValue: 9, backendValue: 31 };
  }
  if (entry.key === "share_send_password_mode"){
    return { localValue: "plain", backendValue: "secrets" };
  }
  if (entry.key === "attachment_link_target"){
    return { localValue: "zip_download", backendValue: "share_page" };
  }
  if (entry.key === "talk_room_type"){
    return { localValue: "normal", backendValue: "event" };
  }
  if (entry.key.startsWith("language_")){
    return { localValue: "default", backendValue: "de" };
  }
  return { localValue: "Local value", backendValue: "Backend value" };
}

function getCoerce(policyState, type){
  if (type === "boolean"){
    return policyState.coerceBoolean;
  }
  if (type === "int"){
    return policyState.coerceInt;
  }
  return policyState.coerceString;
}

function assertEqual(actual, expected, message){
  assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function verifyPolicyNoticeUi(policyState, policyUi){
  const makeStatus = (fields = {}) => ({
    endpointAvailable: true,
    endpointUrl: "https://cloud.example.test/nextcloud/apps/ncc_backend_4mc/api/v1/status",
    status: { seatAssigned: true, seatState: "active", isValid: true, mode: "pro", ...fields }
  });
  const translate = (key) => key;
  const messages = [
    [{ accessStatus: "EXPIRED", isValid: false }, "policy_license_expired"],
    [{ accessStatus: "INACTIVE", isValid: false }, "policy_license_inactive"],
    [{ accessStatus: "INVALID", isValid: false }, "policy_license_invalid"],
    [{ accessStatus: "ACTIVATION_REQUIRED", licenseActivationState: "conflict", isValid: false }, "policy_license_activation_conflict"],
    [{ accessStatus: "ACTIVATION_REQUIRED", licenseActivationState: "proof_required", isValid: false }, "policy_license_activation_required"],
    [{ accessStatus: "OFFLINE_EXPIRED", isValid: false }, "policy_license_offline_expired"],
    [{ isValid: false }, "policy_warning_license_invalid"],
    [{ overlicensed: true }, "policy_warning_overlicensed"],
    [{ seatState: "suspended_overlimit" }, "policy_warning_seat_suspended"],
    [{ seatState: "revoked" }, "policy_warning_seat_unavailable"],
    [{ seatAssigned: false }, "sharing_password_separate_no_seat_tooltip"],
    [{ accessStatus: "GRACE" }, "policy_license_grace"],
    [{ licenseConnectionError: true }, "policy_license_connection_error"]
  ];
  for (const [fields, key] of messages){
    const status = makeStatus(fields);
    const message = policyUi.getPolicyWarningMessage(status, translate);
    assert(message.startsWith(key), `${key}: banner must explain the actual status`);
    if (!policyState.hasSeatEntitlement(status)){
      assertEqual(policyUi.getSeparatePasswordUnavailableHint(status, translate), message, `${key}: password hint must match the banner`);
      assertEqual(policyUi.getVfsExternalUnavailableHint(policyState.getProSeatUnavailableReason(status), translate, policyState.getStatusNotice(status)), message, `${key}: VFS hint must match the banner`);
    }else{
      assertEqual(policyUi.getSeparatePasswordUnavailableHint(status, translate), "", `${key}: informational notices must not disable password delivery`);
    }
  }
  assertEqual(policyUi.getPolicyWarningMessage(makeStatus(), translate), "", "Active licenses need no banner");
  assertEqual(policyUi.getVfsExternalUnavailableHint("seat_paused", translate), "policy_warning_license_invalid", "Legacy VFS reason alone must not claim that a seat is suspended");
  assertEqual(policyUi.getVfsExternalUnavailableHint("admin_controlled", translate, policyState.getStatusNotice(makeStatus({ accessStatus: "GRACE" }))), "policy_admin_controlled_tooltip", "Locked feature policy must keep its own explanation");
  assertEqual(policyUi.getVfsExternalUnavailableHint("", translate, policyState.getStatusNotice(makeStatus({ accessStatus: "GRACE" }))), "", "An available VFS feature must not get an unavailable hint");

  const catalog = JSON.parse(readText("_locales/en/messages.json"));
  const calls = [];
  const localize = (key, substitutions) => {
    calls.push({ key, substitutions });
    assert(catalog[key]?.message, `Notice localization key ${key} must exist`);
    assert(substitutions === undefined || Array.isArray(substitutions), "Notice text must use native i18n substitutions, not fallback text");
    return catalog[key].message.replace(/\$(\d+)/g, (match, index) => String(substitutions?.[Number(index) - 1] ?? match));
  };
  const graceUntilIso = "2026-09-30T12:00:00Z";
  const lastSyncAtIso = "2026-09-16T12:00:00Z";
  const offlineUntilIso = "2026-09-30T11:00:00Z";
  const graceStatus = makeStatus({ accessStatus: "GRACE", graceUntilIso });
  const graceMessage = policyUi.getPolicyWarningMessage(graceStatus, localize);
  assert(graceMessage.includes(new Date(graceUntilIso).toLocaleString()) && !graceMessage.includes("$1"), "Grace must substitute a localized date");
  assert(calls.some((call) => call.key === "policy_license_grace_format" && call.substitutions.length === 1), "Grace must pass its date as a substitution");
  const expired = makeStatus({
    accessStatus: "EXPIRED", isValid: false, licenseConnectionError: true,
    licenseLastSyncAtIso: lastSyncAtIso, licenseOfflineUntilIso: offlineUntilIso, graceUntilIso
  });
  const expiredMessage = policyUi.getPolicyWarningMessage(expired, localize);
  assert(expiredMessage.startsWith(catalog.policy_license_expired.message), "Sync details must follow the blocking license cause");
  assert(expiredMessage.includes(catalog.policy_license_connection_error.message), "Sync failures must remain distinct secondary context");
  assert(expiredMessage.includes(new Date(lastSyncAtIso).toLocaleString()) && expiredMessage.includes(new Date(offlineUntilIso).toLocaleString()), "Sync dates must use localized substitutions");
  assert(!expiredMessage.includes(catalog.policy_license_grace.message), "Future dates must not produce a grace promise after expiry");
  for (const value of [null, "", "not-a-date", {}, []]){
    const message = policyUi.getPolicyWarningMessage(makeStatus({ accessStatus: "GRACE", graceUntilIso: value }), localize);
    assert(message.startsWith(catalog.policy_license_grace.message), "Invalid dates must use the date-free grace explanation");
    assert(!message.includes("Invalid Date") && !message.includes("$1"), "Invalid dates must never leak into notice text");
  }

  const classes = new Set();
  const attributes = {};
  const row = {
    hidden: true,
    classList: { toggle(name, enabled){ enabled ? classes.add(name) : classes.delete(name); } },
    setAttribute(name, value){ attributes[name] = value; }
  };
  const textElement = { textContent: "" };
  Object.defineProperty(textElement, "innerHTML", { set(){ throw new Error("Notice text must not be written as HTML"); } });
  const adminLink = {
    hidden: false,
    href: "https://stale.example.test/",
    removeAttribute(name){ delete this[name]; }
  };
  const show = (policyStatus, messageTranslate = translate) => policyUi.applyPolicyWarningUi({ row, textElement, adminLink, policyStatus, translate: messageTranslate });
  const adminStatus = makeStatus({ accessStatus: "GRACE", canManageLicense: true });
  show(adminStatus);
  assert(!row.hidden && classes.has("is-informational") && attributes.role === "status", "Grace must use an informational banner");
  assert(!adminLink.hidden && adminLink.href === "https://cloud.example.test/nextcloud/index.php/settings/admin/ncc_backend_4mc", "Admins must get their own backend license page");
  assert(textElement.textContent.includes("policy_license_admin_hint") && !textElement.textContent.includes("policy_license_user_hint"), "Admins must receive their own action guidance");
  show(makeStatus({ accessStatus: "GRACE", canManageLicense: true, seatAssigned: false }));
  assert(!adminLink.hidden && textElement.textContent.includes("sharing_password_separate_no_seat_tooltip"), "Grace for an administrator without a seat must also explain the missing personal assignment");
  show(makeStatus({ accessStatus: "EXPIRED", isValid: false }));
  assert(!classes.has("is-informational") && attributes.role === "alert", "Blocking errors must clear an old informational style");
  assert(adminLink.hidden && !Object.prototype.hasOwnProperty.call(adminLink, "href"), "Normal users must lose both the visible admin link and its href");
  assert(textElement.textContent.includes("policy_license_user_hint"), "Normal users must receive administrator-contact guidance");
  show(makeStatus({ accessStatus: "EXPIRED", isValid: false }), () => "<img src=x onerror=alert(1)>");
  assert(textElement.textContent.includes("<img src=x onerror=alert(1)>"), "Notice rendering must keep translated content as plain text");
  for (const canManageLicense of [undefined, null, false, "true", 1, {}]){
    show(makeStatus({ accessStatus: "EXPIRED", isValid: false, canManageLicense }));
    assert(adminLink.hidden && !Object.prototype.hasOwnProperty.call(adminLink, "href"), "Only an explicit full-admin flag may show a management link");
  }
  show(makeStatus());
  assert(row.hidden && textElement.textContent === "" && adminLink.hidden, "Returning to active status must clear stale notice UI");
  show({ endpointAvailable: false, reason: "endpoint_missing", fetchSucceeded: false });
  assert(row.hidden, "A missing optional backend must have no banner");
  show({ endpointAvailable: false, reason: "network_error", fetchSucceeded: false });
  assert(!row.hidden && textElement.textContent === "policy_warning_backend_unavailable" && adminLink.hidden, "Network failure must not display a license-management action");

  const suffix = "/index.php/settings/admin/ncc_backend_4mc";
  for (const prefix of ["https://cloud.example.test", "https://cloud.example.test/nextcloud", "https://cloud.example.test:8443/team/cloud"]){
    for (const endpointPath of ["/apps/ncc_backend_4mc/api/v1/status", "/index.php/apps/ncc_backend_4mc/api/v1/status"]){
      assertEqual(policyUi.getLicenseAdminUrl({ ...adminStatus, endpointUrl: prefix + endpointPath }), prefix + suffix, "Admin links must preserve the configured HTTPS origin and subdirectory");
    }
  }
  for (const endpointUrl of [
    "", "/apps/ncc_backend_4mc/api/v1/status", "http://cloud.example.test/apps/ncc_backend_4mc/api/v1/status",
    "javascript:alert(1)", "https://user:password@cloud.example.test/apps/ncc_backend_4mc/api/v1/status",
    "https://cloud.example.test/apps/ncc_backend_4mc/api/v1/status?next=evil", "https://cloud.example.test/apps/ncc_backend_4mc/api/v1/status#evil",
    "https://cloud.example.test/?next=/apps/ncc_backend_4mc/api/v1/status", "https://cloud.example.test/#/apps/ncc_backend_4mc/api/v1/status",
    "https://cloud.example.test/unrelated/status"
  ]){
    assertEqual(policyUi.getLicenseAdminUrl({ ...adminStatus, endpointUrl }), "", "Unsafe or unrelated endpoint URLs must not produce an admin link");
  }
  assertEqual(policyUi.getLicenseAdminUrl({ ...makeStatus(), endpointUrl: adminStatus.endpointUrl }), "", "Non-admins must not get an admin URL");
}

function verifyAttachmentLinkTargetValues(sharingStorage){
  assertEqual(
    sharingStorage.DEFAULT_ATTACHMENT_LINK_TARGET,
    "zip_download",
    "Attachment-link target fallback must remain ZIP download"
  );
  assertEqual(
    sharingStorage.normalizeAttachmentLinkTarget("share_page"),
    "share_page",
    "Share-page attachment target must remain valid"
  );
  assertEqual(
    sharingStorage.normalizeAttachmentLinkTarget("zip_download"),
    "zip_download",
    "ZIP attachment target must remain valid"
  );
  assertEqual(
    sharingStorage.normalizeAttachmentLinkTarget("unsupported"),
    "zip_download",
    "Unknown attachment target must fall back to ZIP download"
  );
  assertEqual(
    sharingStorage.normalizeAttachmentLinkTarget(undefined),
    "zip_download",
    "Missing attachment target must fall back to ZIP download"
  );
}

function verifySharePolicyKeyRegistry(sharingStorage){
  const expected = {
    basePath: "share_base_directory",
    shareName: "share_name_template",
    permCreate: "share_permission_upload",
    permWrite: "share_permission_edit",
    permDelete: "share_permission_delete",
    passwordEnabled: "share_set_password",
    passwordSeparate: "share_send_password_separately",
    passwordDeliveryMode: "share_send_password_mode",
    secretsExpireDays: "share_secrets_expire_days",
    expireDays: "share_expire_days",
    attachmentLinkTarget: "attachment_link_target",
    attachmentsAlwaysConnector: "attachments_always_via_ncconnector",
    attachmentsMinSizeMb: "attachments_min_size_mb",
    vfsProviderEnabled: "vfs_provider_enabled",
    vfsExternalProvidersEnabled: "vfs_external_providers_enabled",
    blockLanguage: "language_share_html_block"
  };
  assertEqual(
    JSON.stringify(sharingStorage.SHARE_POLICY_KEYS),
    JSON.stringify(expected),
    "Share policy keys must have one shared registry"
  );
  assertEqual(
    sharingStorage.DEFAULT_EXPIRE_DAYS,
    7,
    "Sharing expiry must have one shared fallback"
  );
}

function verifyAttachmentLinkTargetLockedFallback(sharingStorage, policyUi){
  const key = "attachment_link_target";
  const fallback = sharingStorage.DEFAULT_ATTACHMENT_LINK_TARGET;
  const binding = {
    name: "attachmentLinkTarget",
    domain: "share",
    key,
    property: "value",
    type: "string",
    fallback,
    lockedFallback: fallback,
    normalize: (value, bindingFallback) => sharingStorage.normalizeAttachmentLinkTarget(value, bindingFallback)
  };
  const lockedInvalidStatus = createStatus({
    domain: "share",
    key,
    backendValue: "unsupported"
  }, false);
  const lockedMissingStatus = createStatus({
    domain: "share",
    key,
    backendValue: "placeholder"
  }, false);
  delete lockedMissingStatus.policy.share[key];

  for (const [label, status] of [
    ["invalid", lockedInvalidStatus],
    ["missing", lockedMissingStatus]
  ]){
    const domainState = policyUi.readPolicyDomain(status, "share");
    assertEqual(
      policyUi.readPolicyBoundDefaults(
        domainState,
        [binding],
        { attachmentLinkTarget: "share_page" },
        { localNames: new Set(["attachmentLinkTarget"]) }
      ).attachmentLinkTarget,
      fallback,
      `Locked ${label} attachment-link policy must ignore a stored share-page value while reading defaults`
    );
    assertEqual(
      policyUi.resolvePolicyBoundValues(status, [binding], { attachmentLinkTarget: "share_page" }).attachmentLinkTarget,
      fallback,
      `Locked ${label} attachment-link policy must use ZIP while resolving saved values`
    );

    const element = { value: "share_page", disabled: false, title: "" };
    const locked = policyUi.applyPolicyBinding(status, { ...binding, element }, () => "Admin controlled");
    assert(locked, `Locked ${label} attachment-link policy must lock its options control`);
    assertEqual(
      element.value,
      fallback,
      `Locked ${label} attachment-link policy must show ZIP in its options control`
    );
  }

  const genericBinding = {
    name: "value",
    domain: "share",
    key: "generic_setting",
    property: "value",
    type: "string",
    fallback: "generic fallback"
  };
  const genericStatus = createStatus({
    domain: "share",
    key: "generic_setting",
    backendValue: ""
  }, false);
  assertEqual(
    policyUi.resolvePolicyBoundValues(genericStatus, [genericBinding], { value: "local value" }).value,
    "local value",
    "Bindings without lockedFallback must retain their existing invalid-policy fallback semantics"
  );
}

function verifyPolicyTable(policyState, policyUi){
  assert(EDITABLE_POLICY_KEYS.length === 25, "Editable policy key table must contain exactly 25 keys");
  assert(
    new Set(EDITABLE_POLICY_KEYS.map((entry) => `${entry.domain}:${entry.key}`)).size === EDITABLE_POLICY_KEYS.length,
    "Editable policy key table must not contain duplicate keys"
  );

  for (const baseEntry of EDITABLE_POLICY_KEYS){
    const values = getValues(baseEntry);
    const entry = { ...baseEntry, ...values };
    const editableStatus = createStatus(entry, true);
    const lockedStatus = createStatus(entry, false);
    const inactiveStatus = createStatus(entry, false, false);
    const coerce = getCoerce(policyState, entry.type);
    const label = `${entry.domain}.${entry.key}`;

    assertEqual(
      policyState.resolveDefaultValue(editableStatus, entry.domain, entry.key, entry.localValue, true, coerce),
      entry.localValue,
      `${label}: editable policy must preserve an existing local value`
    );
    assertEqual(
      policyState.resolveDefaultValue(editableStatus, entry.domain, entry.key, entry.localValue, false, coerce),
      entry.backendValue,
      `${label}: editable policy must seed an absent local value from the backend`
    );
    assertEqual(
      policyState.resolveDefaultValue(lockedStatus, entry.domain, entry.key, entry.localValue, true, coerce),
      entry.backendValue,
      `${label}: locked policy must override an existing local value`
    );
    assertEqual(
      policyState.resolveDefaultValue(inactiveStatus, entry.domain, entry.key, entry.localValue, true, coerce),
      entry.localValue,
      `${label}: inactive policy must preserve the local value`
    );

    const binding = {
      name: "value",
      domain: entry.domain,
      key: entry.key,
      type: entry.type
    };
    const editableDomain = policyUi.readPolicyDomain(editableStatus, entry.domain);
    const lockedDomain = policyUi.readPolicyDomain(lockedStatus, entry.domain);
    const inactiveDomain = policyUi.readPolicyDomain(inactiveStatus, entry.domain);
    assertEqual(
      policyUi.readPolicyBoundDefaults(
        editableDomain,
        [binding],
        { value: entry.localValue },
        { localNames: new Set(["value"]) }
      ).value,
      entry.localValue,
      `${label}: wizard defaults must preserve editable local values`
    );
    assertEqual(
      policyUi.readPolicyBoundDefaults(editableDomain, [binding], { value: entry.localValue }).value,
      entry.backendValue,
      `${label}: wizard defaults must use the backend when no local value exists`
    );
    assertEqual(
      policyUi.readPolicyBoundDefaults(
        lockedDomain,
        [binding],
        { value: entry.localValue },
        { localNames: new Set(["value"]) }
      ).value,
      entry.backendValue,
      `${label}: wizard defaults must enforce locked backend values`
    );
    assertEqual(
      policyUi.readPolicyBoundDefaults(
        inactiveDomain,
        [binding],
        { value: entry.localValue },
        { localNames: new Set(["value"]) }
      ).value,
      entry.localValue,
      `${label}: inactive wizard policy must preserve local values`
    );
    assertEqual(
      policyUi.resolvePolicyBoundValues(editableStatus, [binding], { value: entry.localValue }).value,
      entry.localValue,
      `${label}: editable save/event values must remain local`
    );
    assertEqual(
      policyUi.resolvePolicyBoundValues(lockedStatus, [binding], { value: entry.localValue }).value,
      entry.backendValue,
      `${label}: locked save/event values must be resolved to the backend value`
    );
  }
}

function compact(source){
  return String(source || "").replace(/\s+/g, " ").trim();
}

function assertCode(source, expectedCode, message){
  assert(compact(source).includes(compact(expectedCode)), message);
}

function functionBody(source, functionName){
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert(start >= 0, `Function ${functionName} must exist`);
  const nextFunction = source.indexOf("\n  function ", start + marker.length);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

function count(source, value){
  return source.split(value).length - 1;
}

function verifyConsumerGuards(){
  const options = readText("options.js");
  const sharingStorage = readText("modules/sharingStorage.js");
  const talk = readText("ui/talkDialog.js");
  const sharingWizard = readText("ui/nextcloudSharingWizard.js");
  const shareBlockRenderer = readText("modules/shareBlockRenderer.js");
  const shareRequestRules = readText("modules/shareRequestRules.js");
  const composeFinalize = readText("modules/bgComposeFinalize.js");
  const passwordDelivery = readText("modules/bgComposePasswordDelivery.js");
  const passwordDispatch = readText("modules/bgComposePasswordDispatch.js");
  const composeAttachments = readText("modules/bgComposeAttachments.js");
  const calendar = readText("modules/bgCalendar.js");
  const signature = readText("modules/bgSignature.js");

  for (const [name, source, status, link] of [
    ["options", options, "runtimePolicyStatus", "policyWarningAdminLink"],
    ["Talk", talk, "state.policy.status", "policyWarningAdminLink"],
    ["Sharing", sharingWizard, "state.policy.status", "dom.policyWarningAdminLink"]
  ]){
    const warningCall = source.match(/NCWizardPolicyUi\.applyPolicyWarningUi\(\{([\s\S]*?)\}\)/)?.[1] || "";
    assertCode(warningCall, `policyStatus: ${status}`, `${name} must pass the complete policy status to its banner`);
    assertCode(warningCall, `adminLink: ${link}`, `${name} must let the shared banner control its admin link`);
    assert(!warningCall.includes("warningVisible:"), `${name} must not reduce a notice to a legacy visibility flag`);
    assert(!source.includes("POLICY_ADMIN_URL"), `${name} must not retain a fixed license-guide URL`);
  }
  assertCode(sharingWizard, "getVfsExternalUnavailableHint(reason, wizardTranslate, external.notice)", "Sharing must pass the background VFS notice to the shared formatter");
  assertCode(readText("ui/optionsVfs.js"), "currentState?.external?.notice", "VFS options must consume the background notice");

  assertCode(talk, "const localRuntimeNames = new Set();", "Talk runtime policy defaults must track local values");
  assertCode(talk, "localRuntimeNames.add(\"descriptionLanguage\");", "Talk language must mark its stored value as local");
  assertCode(talk, "{ localNames: localRuntimeNames }", "Talk runtime policy resolution must receive its local-value metadata");
  assertCode(talk, "const localDefaultNames = new Set();", "Talk wizard defaults must track local values");
  assertCode(talk, "localDefaultNames.add(\"addUsersEnabled\"); localDefaultNames.add(\"addGuestsEnabled\");", "Legacy Talk participant storage must count as a local value for both split controls");
  assertCode(talk, "editable: state.policy.editable", "Talk wizard defaults must receive policy editability metadata");
  assertCode(talk, "{ localNames: localDefaultNames }", "Talk wizard defaults must receive local-value metadata");

  const applyTalkDefaults = functionBody(talk, "applyDefaultsToUi");
  for (const metadataField of ["lobbyEnabled", "listable", "eventConversation", "addUsers", "addGuests"]){
    assert(
      applyTalkDefaults.includes(`meta.${metadataField}`),
      `Stored Talk event metadata ${metadataField} must be included before policy resolution`
    );
  }
  assertCode(
    applyTalkDefaults,
    "NCWizardPolicyUi.resolvePolicyBoundValues( state.policy.status, TALK_DEFAULT_POLICY_BINDINGS, candidateValues )",
    "Stored Talk event metadata must pass through locked-policy resolution"
  );
  assertCode(applyTalkDefaults, "titleInput.value = resolvedValues.title", "Talk UI must use policy-resolved event values");
  const handlePasswordToggle = functionBody(talk, "handlePasswordToggle");
  assertCode(
    handlePasswordToggle,
    "enabled && passwordInput && !passwordInput.value",
    "Enabling Talk password protection must generate a password when the field is empty"
  );
  const applyPasswordToggleState = functionBody(talk, "applyPasswordToggleState");
  assertCode(
    applyPasswordToggleState,
    "passwordGenerateBtn.disabled = !enabled",
    "The manual Talk password generator must remain available while password protection is enabled"
  );

  const loadBasePath = functionBody(sharingWizard, "loadBasePath");
  assertCode(
    loadBasePath,
    "NCPolicyState.resolveDefaultValue( state.policy.status, \"share\", SHARE_POLICY_KEYS.basePath, localBasePath, !!rawLocalBasePath, NCPolicyState.coerceString )",
    "Share base path must honor editable local values and locked backend values"
  );
  assertCode(
    sharingStorage,
    "const DEFAULT_ATTACHMENT_LINK_TARGET = ATTACHMENT_LINK_TARGETS.ZIP_DOWNLOAD;",
    "Missing attachment-link target values must default to ZIP download"
  );
  assert(
    !sharingStorage.includes("migration[SHARING_KEYS.attachmentsLinkTarget]")
      && !sharingStorage.includes("runtime.onInstalled"),
    "Attachment-link target must not use install or update migration"
  );
  assertCode(
    options,
    "name: \"sharingAttachmentsLinkTarget\", storageKey: SHARING_KEYS.attachmentsLinkTarget, domain: \"share\", key: SHARE_POLICY_KEYS.attachmentLinkTarget",
    "Options must bind the attachment-link target to the shared backend key"
  );
  assertCode(
    options,
    "isValid: (value) => NCSharingStorage.isValidAttachmentLinkTarget(value)",
    "Invalid stored attachment-link targets must not block an editable backend default"
  );
  assertCode(
    options,
    "lockedFallback: DEFAULT_SHARING_ATTACHMENT_LINK_TARGET",
    "Options must force the ZIP fallback when locked attachment-link policy is missing or invalid"
  );
  assertCode(
    sharingWizard,
    "name: \"attachmentLinkTarget\", key: SHARE_POLICY_KEYS.attachmentLinkTarget",
    "Sharing wizard must resolve the attachment-link target from the shared backend key"
  );
  assertCode(
    sharingWizard,
    "lockedFallback: NCSharingStorage.DEFAULT_ATTACHMENT_LINK_TARGET",
    "Sharing wizard must force the ZIP fallback when locked attachment-link policy is missing or invalid"
  );
  const finalizeShare = functionBody(sharingWizard, "finalizeShare");
  assertCode(
    finalizeShare,
    "const zipDownload = attachmentMode && NCSharingStorage.isZipDownloadLinkTarget(attachmentLinkTarget);",
    "Only attachment mode may use the configured ZIP target"
  );
  assertCode(
    finalizeShare,
    ": NCSharingStorage.ATTACHMENT_LINK_TARGETS.SHARE_PAGE;",
    "Manual shares must always use the share-page target"
  );

  const resolveShareLanguage = functionBody(shareBlockRenderer, "resolveShareBlockLanguage");
  assertCode(resolveShareLanguage, "const editableShare = request?.policyEditableShare;", "Share rendering must consume language editability metadata");
  assertCode(
    resolveShareLanguage,
    "editableShare[languageKey] !== false && localSetting.hasLocalValue",
    "Share rendering must allow a stored language to override an editable backend default"
  );
  assertCode(resolveShareLanguage, "? localSetting.value : (policyLang || localSetting.value)", "Share rendering must keep locked/backend language precedence");

  assert(
    count(sharingWizard, "policyEditableShare: state.policy.active ? state.policy.editable : null") >= 3,
    "Sharing wizard must pass editability metadata to rendering and password dispatch"
  );
  const startUpload = functionBody(sharingWizard, "startUpload");
  assert(
    !startUpload.includes("policyShare:") && !startUpload.includes("policyEditableShare:"),
    "FileLink upload must not trust a wizard policy snapshot"
  );
  const resolveUploadRequest = functionBody(shareRequestRules, "resolveUploadRequest");
  assertCode(
    resolveUploadRequest,
    "resolveLocked( policyStatus, POLICY_KEYS.permWrite",
    "Background upload must reapply locked share permissions"
  );
  assertCode(
    finalizeShare,
    "policyEditableShare: state.policy.active ? state.policy.editable : null",
    "Sharing wizard must forward language editability metadata in the finalize transaction"
  );
  const finalizeTransaction = functionBody(composeFinalize, "handleSharingFinalizeTransaction");
  assertCode(
    finalizeTransaction,
    "registerSeparatePasswordMailDispatch( tabId, passwordDispatch, { policyStatus } )",
    "The finalize transaction must register the prepared password-mail dispatch"
  );
  const storePasswordDispatch = functionBody(passwordDispatch, "registerSeparatePasswordMailDispatch");
  assertCode(
    storePasswordDispatch,
    "policyEditableShare: payload?.policyEditableShare && typeof payload.policyEditableShare === \"object\" ? payload.policyEditableShare : null",
    "Background password dispatch must retain language editability metadata"
  );
  const clonePasswordDispatch = functionBody(passwordDelivery, "clonePasswordDispatch");
  assertCode(
    clonePasswordDispatch,
    "policyEditableShare: dispatch.policyEditableShare && typeof dispatch.policyEditableShare === \"object\" ? { ...dispatch.policyEditableShare } : null",
    "Cloned password dispatches must retain language editability metadata"
  );
  const renderPasswordBodies = functionBody(passwordDelivery, "renderPasswordDispatchBodies");
  assertCode(
    renderPasswordBodies,
    "policyEditableShare: dispatch?.policyEditableShare || null",
    "Password-mail rendering must receive language editability metadata"
  );

  assertCode(
    composeAttachments,
    "NCPolicyState.resolveDefaultValue( policyStatus, \"share\", NCSharingStorage.SHARE_POLICY_KEYS.attachmentsAlwaysConnector",
    "Compose attachment automation must resolve the editable backend default"
  );
  assertCode(
    composeAttachments,
    "(!hasLocalThreshold || NCPolicyState.isLocked( policyStatus, \"share\", NCSharingStorage.SHARE_POLICY_KEYS.attachmentsMinSizeMb ))",
    "Compose attachment threshold must preserve editable local values"
  );
  assertCode(
    calendar,
    "NCPolicyState.resolveDefaultValue( status, \"talk\", \"talk_delete_room_on_event_delete\"",
    "Calendar cleanup must resolve the editable backend default"
  );

  const initialPolicyDefaults = functionBody(options, "applyInitialPolicyDefaults");
  assertCode(initialPolicyDefaults, "const localNames = new Set();", "Initial options policy resolution must track stored local values");
  assertCode(initialPolicyDefaults, "NCWizardPolicyUi.readPolicyBoundDefaults(", "Initial options values must use the shared editability resolver");
  assertCode(initialPolicyDefaults, "{ localNames }", "Initial options values must pass local-value presence to the resolver");
  const initialSpecialDefaults = functionBody(options, "applyInitialSpecialPolicyDefaults");
  assertCode(initialSpecialDefaults, "\"talk_room_type\"", "Initial options policy resolution must include the Talk room type");
  assertCode(initialSpecialDefaults, "SHARE_POLICY_KEYS.attachmentsAlwaysConnector", "Initial options policy resolution must include attachment automation");
  assertCode(initialSpecialDefaults, "!hasLocalThreshold || NCPolicyState.isLocked", "Initial attachment threshold must use backend only when local is absent or locked");
  assertCode(
    options,
    "applyInitialPolicyDefaults(OPTION_SHARE_POLICY_BINDINGS.concat(OPTION_TALK_POLICY_BINDINGS), stored); applyInitialSpecialPolicyDefaults(stored);",
    "Options loading must apply backend defaults after local-value presence is known"
  );
  assertCode(options, "allowCustom: isCustomLanguageModeAvailable(\"share\")", "Share custom-language normalization must use the Share domain");
  assertCode(options, "allowCustom: isCustomLanguageModeAvailable(\"talk\")", "Talk custom-language normalization must use the Talk domain");
  assertCode(options, "[\"share_html_block_template_v2\", \"share_html_block_template\"]", "Custom Share language availability must accept the versioned template");
  assertCode(
    options,
    "await refreshBackendPolicyStatus({ baseUrl, user, appPass });",
    "Saving changed credentials must resolve policy against the form credentials"
  );

  const resolveSignaturePolicy = functionBody(signature, "resolveSignaturePolicy");
  assert(
    count(resolveSignaturePolicy, "NCPolicyState.resolveDefaultValue(") === 3,
    "Effective signature policy must resolve all three editable compose switches"
  );
  for (const key of ["email_signature_on_compose", "email_signature_on_reply", "email_signature_on_forward"]){
    assert(resolveSignaturePolicy.includes(`\"${key}\"`), `Effective signature policy must resolve ${key}`);
  }
  assertCode(resolveSignaturePolicy, "if (!onCompose)", "Signature activation must use the effective compose value");
  const resolveShouldInsert = functionBody(signature, "resolveShouldInsert");
  assertCode(resolveShouldInsert, "if (!policy?.onCompose)", "Signature insertion must use effective compose policy");
  assertCode(resolveShouldInsert, "return policy.onReply === true", "Reply signatures must use the effective reply value");
  assertCode(resolveShouldInsert, "return policy.onForward === true", "Forward signatures must use the effective forward value");

  assertCode(
    options,
    "name: \"talkPasswordDefaultEnabled\", storageKey: \"talkPasswordDefaultEnabled\", domain: \"talk\", key: \"talk_set_password\"",
    "Options must bind Talk password protection to talk_set_password"
  );
  assertCode(
    applyTalkDefaults,
    "enabled && passwordInput && !passwordInput.value",
    "An initially enabled Talk password must generate a password when the field is empty"
  );
}

function run(){
  const { policyState, policyUi } = loadPolicyApis();
  const sharingStorage = loadSharingStorage();
  verifyAttachmentLinkTargetValues(sharingStorage);
  verifySharePolicyKeyRegistry(sharingStorage);
  verifyAttachmentLinkTargetLockedFallback(sharingStorage, policyUi);
  verifyPolicyTable(policyState, policyUi);
  verifyPolicyNoticeUi(policyState, policyUi);
  verifyConsumerGuards();
  console.log("[OK] policy-editability-check passed (25 editable keys, 4 policy states, consumer guards)");
}

run();
