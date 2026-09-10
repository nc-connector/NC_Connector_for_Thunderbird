"use strict";

const vm = require("node:vm");
const { assert, loadScript } = require("./review-check-utils");

function makePolicyStatus(policy = {}, editable = {}){
  return {
    endpointAvailable: true,
    policyActive: true,
    policyDomains: {
      share: { available: true, active: true }
    },
    policy: { share: policy },
    policyEditable: { share: editable }
  };
}

function createContext(){
  const context = {
    console,
    URL,
    Date,
    File,
    globalThis: null,
    window: null,
    browser: {
      i18n: {
        getMessage: (key, substitutions = []) => {
          const values = Array.isArray(substitutions) ? substitutions : [substitutions];
          return [key, ...values].join(":");
        }
      }
    },
    bgI18n: (key, substitutions = []) => {
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      return [key, ...values].join(":");
    },
    NCNextcloudDav: {
      joinPath: (...parts) => parts
        .map((part) => String(part || "").replace(/^\/+|\/+$/g, ""))
        .filter(Boolean)
        .join("/"),
      normalizeRelativePath: (value) => String(value || "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, ""),
      normalizeVfsPath: (value) => `/${String(value || "").replace(/^\/+|\/+$/g, "")}`
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  loadScript("modules/sharingStorage.js", context);
  loadScript("modules/textUtils.js", context);
  loadScript("modules/policyState.js", context);
  loadScript("modules/shareRequestRules.js", context);
  loadScript("modules/fileQueuePathConflicts.js", context);
  loadScript("modules/fileLinkSources.js", context);
  return context;
}

function createLocalFile(name, content = "test"){
  return new File([content], name, { type: "text/plain", lastModified: 1 });
}

function checkBackgroundRequestRules(context){
  const attachment = context.NCShareRequestRules.resolveUploadRequest({
    shareName: "Attachments",
    basePath: "Local Base",
    permissions: { read: true, create: true, write: true, delete: true },
    passwordEnabled: false,
    expireEnabled: false,
    noteEnabled: true,
    note: "must not survive",
    policyShare: { share_permission_edit: true },
    policyEditableShare: { share_permission_edit: false },
    files: []
  }, {
    policyStatus: null,
    attachmentMode: true
  });
  assert(
    JSON.stringify(attachment.permissions)
      === JSON.stringify({ read: true, create: false, write: false, delete: false }),
    "Attachment mode must remain read-only in the background"
  );
  assert(
    attachment.noteEnabled === false && attachment.note === "",
    "Attachment mode must remove share notes in the background"
  );
  assert(
    !("policyShare" in attachment) && !("policyEditableShare" in attachment),
    "Wizard policy snapshots must not enter the upload service"
  );

  const status = makePolicyStatus({
    share_base_directory: "Managed Base",
    share_name_template: "Managed Name",
    share_permission_upload: true,
    share_permission_edit: false,
    share_permission_delete: true,
    share_set_password: false,
    share_expire_days: 14
  }, {
    share_base_directory: false,
    share_name_template: false,
    share_permission_upload: false,
    share_permission_edit: false,
    share_permission_delete: false,
    share_set_password: false,
    share_expire_days: false
  });
  const managed = context.NCShareRequestRules.resolveUploadRequest({
    shareName: "Stale Name",
    basePath: "Stale Base",
    permissions: { read: true, create: false, write: true, delete: false },
    passwordEnabled: true,
    password: "not-used",
    expireEnabled: false,
    files: []
  }, {
    policyStatus: status,
    attachmentMode: false
  });
  assert(
    managed.basePath === "Managed Base" && managed.shareName === "Managed Name",
    "Locked folder and share names must override a stale wizard request"
  );
  assert(
    managed.permissions.create === true
      && managed.permissions.write === false
      && managed.permissions.delete === true,
    "Locked permissions must override a stale wizard request"
  );
  assert(
    managed.passwordEnabled === false && managed.password === "",
    "A locked disabled password must remove the submitted password"
  );
  assert(
    managed.expireEnabled === true && /^\d{4}-\d{2}-\d{2}$/.test(managed.expireDate),
    "Locked expiry days must produce an effective expiry date"
  );
}

function checkQueueRules(context){
  const normalize = (items) => context.NCFileLinkSources.normalizeItems(items, {
    sanitizeFileName: (value) => String(value || "File").trim(),
    sanitizeRelativeDir: (value) => String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
  });
  let exactFailure = null;
  try{
    normalize([
      { id: "one", file: createLocalFile("one.txt"), name: "same.txt" },
      { id: "two", file: createLocalFile("two.txt"), renamedName: "same.txt" }
    ]);
  }catch(error){
    exactFailure = error;
  }
  assert(
    exactFailure?.message === "file_link_queue_path_conflict",
    "The normalized queue must reject exact target duplicates"
  );

  let prefixFailure = null;
  try{
    normalize([
      { id: "file", file: createLocalFile("folder"), name: "folder" },
      { id: "nested", file: createLocalFile("nested.txt"), name: "nested.txt", relativeDir: "folder" }
    ]);
  }catch(error){
    prefixFailure = error;
  }
  assert(
    prefixFailure?.message === "file_link_queue_path_conflict",
    "The normalized queue must reject file/directory prefix collisions"
  );

  const sharedFolder = context.NCFileQueuePathConflicts.find([
    {
      entry: { transferGroupId: "folder-group" },
      path: "folder",
      kind: "folder"
    },
    {
      entry: { transferGroupId: "folder-group" },
      path: "folder/nested.txt",
      kind: "file"
    }
  ]);
  assert(
    sharedFolder === null,
    "One provider folder transfer may contain its own nested entries"
  );
}

function run(){
  const context = createContext();
  checkBackgroundRequestRules(context);
  checkQueueRules(context);
  console.log("[OK] share-request-rules-check passed");
}

run();
