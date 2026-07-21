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

function verifyPolicyTable(policyState, policyUi){
  assert(EDITABLE_POLICY_KEYS.length === 24, "Editable policy key table must contain exactly 24 keys");
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
  const talk = readText("ui/talkDialog.js");
  const sharingWizard = readText("ui/nextcloudSharingWizard.js");
  const sharing = readText("modules/ncSharing.js");
  const passwordDispatch = readText("modules/bgComposePasswordDispatch.js");
  const composeAttachments = readText("modules/bgComposeAttachments.js");
  const calendar = readText("modules/bgCalendar.js");
  const signature = readText("modules/bgSignature.js");

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
    "NCPolicyState.resolveDefaultValue( state.policy.status, \"share\", \"share_base_directory\", localBasePath, !!rawLocalBasePath, NCPolicyState.coerceString )",
    "Share base path must honor editable local values and locked backend values"
  );

  const resolveShareLanguage = functionBody(sharing, "resolveShareBlockLanguage");
  assertCode(resolveShareLanguage, "const editableShare = request?.policyEditableShare;", "Share rendering must consume language editability metadata");
  assertCode(
    resolveShareLanguage,
    "editableShare.language_share_html_block !== false && localSetting.hasLocalValue",
    "Share rendering must allow a stored language to override an editable backend default"
  );
  assertCode(resolveShareLanguage, "? localSetting.value : (policyLang || localSetting.value)", "Share rendering must keep locked/backend language precedence");

  assert(
    count(sharingWizard, "policyEditableShare: state.policy.active ? state.policy.editable : null") >= 4,
    "Sharing wizard must pass editability metadata to upload, rendering, and password dispatch"
  );
  const registerPasswordDispatch = functionBody(sharingWizard, "registerSeparatePasswordDispatch");
  assertCode(
    registerPasswordDispatch,
    "policyEditableShare: payload?.policyEditableShare && typeof payload.policyEditableShare === \"object\" ? payload.policyEditableShare : null",
    "Sharing wizard must forward language editability metadata in the password-dispatch message"
  );
  const storePasswordDispatch = functionBody(passwordDispatch, "registerSeparatePasswordMailDispatch");
  assertCode(
    storePasswordDispatch,
    "policyEditableShare: payload?.policyEditableShare && typeof payload.policyEditableShare === \"object\" ? payload.policyEditableShare : null",
    "Background password dispatch must retain language editability metadata"
  );
  const clonePasswordDispatch = functionBody(passwordDispatch, "clonePasswordDispatch");
  assertCode(
    clonePasswordDispatch,
    "policyEditableShare: dispatch.policyEditableShare && typeof dispatch.policyEditableShare === \"object\" ? { ...dispatch.policyEditableShare } : null",
    "Cloned password dispatches must retain language editability metadata"
  );
  const renderPasswordBodies = functionBody(passwordDispatch, "renderPasswordDispatchBodies");
  assertCode(
    renderPasswordBodies,
    "policyEditableShare: dispatch?.policyEditableShare || null",
    "Password-mail rendering must receive language editability metadata"
  );

  assertCode(
    composeAttachments,
    "NCPolicyState.resolveDefaultValue( policyStatus, \"share\", \"attachments_always_via_ncconnector\"",
    "Compose attachment automation must resolve the editable backend default"
  );
  assertCode(
    composeAttachments,
    "(!hasLocalThreshold || NCPolicyState.isLocked(policyStatus, \"share\", \"attachments_min_size_mb\"))",
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
  assertCode(initialSpecialDefaults, "\"attachments_always_via_ncconnector\"", "Initial options policy resolution must include attachment automation");
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
  verifyPolicyTable(policyState, policyUi);
  verifyConsumerGuards();
  console.log("[OK] policy-editability-check passed (24 editable keys, 4 policy states, consumer guards)");
}

run();
