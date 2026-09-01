const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

function assert(condition, message){
  if (!condition){
    throw new Error(message);
  }
}

function loadScript(relativePath, context){
  const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  vm.runInNewContext(source, context, { filename: relativePath });
}

async function expectFailure(callback, predicate, message){
  try{
    await callback();
  }catch(error){
    assert(predicate(error), `${message}: unexpected ${error?.name || "Error"} ${error?.code || ""}`);
    return error;
  }
  throw new Error(`${message}: operation unexpectedly succeeded`);
}

function createResponse(status, raw = ""){
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => "" },
    body: { cancel: async () => {} },
    text: async () => raw,
    blob: async () => new Blob([raw], { type: "application/octet-stream" })
  };
}

function createContext(fetchImpl = async () => createResponse(204)){
  return {
    console,
    URL,
    Blob,
    File: global.File,
    AbortController,
    DOMException,
    TextEncoder,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    bgI18n: (key) => key,
    NCFileLinkUploadPolicy: {
      MAX_ATTEMPTS: 3,
      MAX_PARALLEL_REQUESTS: 2,
      RETRY_AFTER_LIMIT_MS: 60000,
      isRetryStatus: (status) => [429, 500, 502, 503, 504].includes(status)
    },
    NCLogContext: {
      safeConsoleError(){ }
    }
  };
}

async function checkStrictPathsAndServerCopy(){
  const requests = [];
  const context = createContext(async (url, options) => {
    requests.push({ url, options });
    return createResponse(201);
  });
  loadScript("modules/nextcloudDav.js", context);
  const dav = context.NCNextcloudDav;
  const root = "https://cloud.example.test/nextcloud/remote.php/dav/files/canonical-user";

  assert(dav.normalizeVfsPath("/") === "/", "VFS root must stay canonical");
  assert(dav.normalizeVfsPath("/Folder/100%.txt") === "/Folder/100%.txt", "Literal percent filenames must remain valid");
  assert(
    dav.buildVfsFileUrl(root, "/Folder/My File.txt")
      === `${root}/Folder/My%20File.txt`,
    "VFS URL builder must encode each path segment"
  );
  assert(
    dav.hrefToVfsPath(root, "/nextcloud/remote.php/dav/files/canonical-user/Folder/My%20File.txt")
      === "/Folder/My File.txt",
    "DAV href must map back to the canonical VFS path"
  );

  for (const invalid of [
    "relative.txt",
    "/../secret.txt",
    "/Folder/./file.txt",
    "/Folder//file.txt",
    "/Folder/",
    "/%2e%2e/secret.txt",
    "/Folder%2Fsecret.txt",
    "/Folder\\secret.txt"
  ]){
    await expectFailure(
      () => Promise.resolve(dav.normalizeVfsPath(invalid)),
      (error) => error.code === "E:PROVIDER",
      `Strict VFS path validation must reject ${invalid}`
    );
  }
  await expectFailure(
    () => Promise.resolve(dav.hrefToVfsPath(root, "https://other.example.test/file.txt")),
    (error) => error.code === "E:PROVIDER",
    "DAV href must not escape to another origin"
  );
  await expectFailure(
    () => Promise.resolve(dav.hrefToVfsPath(root, "/nextcloud/remote.php/dav/files/canonical-user-2/file.txt")),
    (error) => error.code === "E:PROVIDER",
    "DAV href prefix must remain segment-bound"
  );

  await dav.copyWithinDavRoot({
    davRoot: root,
    sourcePath: "/Source/My File.txt",
    destinationPath: "/Shares/Target/My File.txt",
    kind: "file",
    authHeader: "Basic redacted",
    overwrite: false
  });
  assert(requests.length === 1, "Server-side file copy must use one DAV request");
  assert(requests[0].options.method === "COPY", "Server-side file copy must use COPY");
  assert(requests[0].options.headers.Overwrite === "F", "Server-side share copy must refuse overwrites");
  assert(requests[0].options.headers.Depth === "0", "File copy must use Depth: 0");
  assert(
    requests[0].options.headers.Destination === `${root}/Shares/Target/My%20File.txt`,
    "COPY Destination must be built below the same DAV root"
  );

  await dav.copyWithinDavRoot({
    davRoot: root,
    sourcePath: "/Source/Empty Folder",
    destinationPath: "/Shares/Target/Empty Folder",
    kind: "directory",
    authHeader: "Basic redacted",
    overwrite: false
  });
  assert(requests[1].options.headers.Depth === "infinity", "Folder copy must preserve empty folders with Depth: infinity");
}

function createStorageHarness(){
  const context = createContext();
  loadScript("modules/nextcloudDav.js", context);
  loadScript("modules/nextcloudVfsStorage.js", context);

  const state = {
    opts: {
      baseUrl: "https://cloud.example.test/nextcloud",
      user: "login@example.test",
      appPass: "first-secret"
    },
    userId: "canonical-user",
    requests: [],
    xhrRequests: [],
    copies: [],
    parseQueue: [],
    quota: { usage: 10, quota: 100 },
    requestHandler: null,
    xhrHandler: null,
    copyHandler: null,
    hostChecks: 0,
    fetchRequests: []
  };

  const core = {
    normalizeBaseUrl(value){
      return String(value || "").replace(/\/+$/, "");
    },
    async getOpts(){
      return { ...state.opts };
    },
    async getCurrentUserId(options){
      assert(options.user === state.opts.user, "Canonical UID lookup must use the configured login");
      return state.userId;
    }
  };
  const ocs = {
    buildAuthHeader(user, password){
      assert(user === state.opts.user && password === state.opts.appPass, "DAV auth must use the effective NC Connector account");
      return "Basic internal-only";
    }
  };
  const hostPermissions = {
    async requireOriginPermission(baseUrl){
      state.hostChecks++;
      assert(baseUrl === state.opts.baseUrl, "Host permission must be checked for the effective Nextcloud URL");
      return true;
    }
  };
  const baseDav = context.NCNextcloudDav;
  const dav = {
    ...baseDav,
    async requestPath(options){
      state.requests.push(options);
      if (state.requestHandler){
        return state.requestHandler(options);
      }
      return { ok: true, status: 207, raw: "dav-response", headers: null };
    },
    parseDavMultiStatus(){
      return state.parseQueue.length ? state.parseQueue.shift() : [];
    },
    parseDavQuota(){
      return state.quota;
    },
    async xhrRequest(options){
      state.xhrRequests.push(options);
      if (state.xhrHandler){
        return state.xhrHandler(options);
      }
      return { status: 201, statusText: "Created", responseText: "", getHeader: () => "" };
    },
    async copyWithinDavRoot(options){
      state.copies.push(options);
      if (state.copyHandler){
        return state.copyHandler(options);
      }
      return { ok: true, status: 201, raw: "" };
    },
    async fetchWithTimeout({ request, signal }){
      return request(signal);
    },
    async readResponseText(response){
      return response.text();
    },
    async readResponseBlob(response){
      return response.blob();
    }
  };
  context.fetch = async (url, options) => {
    state.fetchRequests.push({ url, options });
    return createResponse(200, "file-content");
  };
  const storage = context.NCNextcloudVfsStorage.create({ core, ocs, dav, hostPermissions });
  return { context, state, storage };
}

async function checkIdentityAndListing(){
  const { state, storage } = createStorageHarness();
  const first = await storage.getAccountIdentity();
  assert(first.baseUrl === state.opts.baseUrl, "Account identity must expose the normalized base URL internally");
  assert(first.userId === state.userId, "Account identity must use the canonical UID");
  assert(!JSON.stringify(first).includes(state.opts.appPass), "Account identity must never contain the app password");
  assert(!("authHeader" in first), "Account identity must never expose the authorization header");
  assert(storage.resolveContext === undefined, "Credential-bearing DAV context must remain private to the adapter");

  state.opts.appPass = "rotated-secret";
  state.opts.user = "another-login-alias@example.test";
  const passwordRotation = await storage.getAccountIdentity();
  assert(passwordRotation.key === first.key, "App-password or login-alias changes must not rotate account identity");
  state.userId = "other-canonical-user";
  const accountChange = await storage.getAccountIdentity();
  assert(accountChange.key !== first.key, "Canonical account changes must rotate account identity");
  const requestsBeforeMismatch = state.requests.length;
  await expectFailure(
    () => storage.list("/", { expectedAccountKey: first.key }),
    (error) => error.code === "E:AUTH",
    "A granted storage operation must not cross into a changed Nextcloud account"
  );
  assert(
    state.requests.length === requestsBeforeMismatch,
    "Account identity mismatch must fail before the DAV operation"
  );

  state.userId = "canonical-user";
  state.parseQueue.push([
    { path: "/", name: "", kind: "directory" },
    { path: "/Projects", name: "Projects", kind: "directory" },
    { path: "/report.pdf", name: "report.pdf", kind: "file", size: 42, lastModified: 123 },
    { path: "/Projects/nested.txt", name: "nested.txt", kind: "file", size: 1 }
  ]);
  const entries = await storage.list("/");
  assert(entries.length === 2, "Depth-1 listing must expose immediate children only");
  assert(entries[0].kind === "directory" && entries[0].path === "/Projects", "Listing must sort folders first");
  assert(state.requests.at(-1).method === "PROPFIND", "Listing must use PROPFIND");
  assert(state.requests.at(-1).headers.Depth === "1", "Listing must be live Depth: 1");
  assert(state.hostChecks >= 4, "Every independent operation must validate the active host permission");
}

async function checkReadWriteAndMutations(){
  const { state, storage } = createStorageHarness();

  const read = await storage.readFile("/Folder/My File.txt");
  assert(read instanceof Blob, "Read must return File or Blob content");
  assert(state.fetchRequests[0].options.method === "GET", "Read must use GET");
  assert(
    state.fetchRequests[0].url.endsWith("/Folder/My%20File.txt"),
    "Read path must remain encoded below the canonical DAV root"
  );

  const upload = new Blob(["content"], { type: "text/plain" });
  await storage.writeFile("/Folder/new.txt", upload, false);
  assert(state.xhrRequests[0].headers["If-None-Match"] === "*", "Non-overwrite write must be atomic");
  await storage.writeFile("/Folder/existing.txt", upload, true);
  assert(!("If-None-Match" in state.xhrRequests[1].headers), "Overwrite write must not send create-only condition");

  state.xhrHandler = async () => ({
    status: 412,
    statusText: "Precondition Failed",
    responseText: "",
    getHeader: () => ""
  });
  await expectFailure(
    () => storage.writeFile("/Folder/existing.txt", upload, false),
    (error) => error.code === "E:EXIST" && error.status === 412,
    "Conditional write conflicts must map to E:EXIST"
  );
  state.xhrHandler = null;

  state.requestHandler = async (options) => {
    if (options.method === "MKCOL"){
      return { ok: true, status: 201, raw: "" };
    }
    if (options.method === "MOVE" || options.method === "DELETE"){
      return { ok: true, status: 204, raw: "" };
    }
    return { ok: true, status: 207, raw: "" };
  };
  await storage.addFolder("/Folder/New");
  assert(state.requests.filter((request) => request.method === "MKCOL").length === 1, "Folder creation must not create parents implicitly");
  await storage.moveFile("/Folder/a.txt", "/Folder/b.txt", false);
  const move = state.requests.find((request) => request.method === "MOVE");
  assert(move.headers.Overwrite === "F", "Non-overwrite move must send Overwrite: F");
  assert(move.headers.Destination.endsWith("/Folder/b.txt"), "MOVE Destination must remain below the same DAV root");

  await storage.copyFile("/Folder/a.txt", "/Folder/c.txt", false);
  assert(state.copies.at(-1).kind === "file", "File copy must use the common server-side copy helper");
  assert(state.copies.at(-1).overwrite === false, "File copy must preserve overwrite semantics");
  await storage.copyFolder("/Folder/Empty", "/Folder/Empty Copy", false);
  assert(state.copies.at(-1).kind === "directory", "Folder copy must use a server-side Depth: infinity copy");
  assert(state.copies.at(-1).overwrite === false, "Non-merge folder copy must refuse overwrite");

  const deletion = await storage.deleteFile("/Folder/a.txt");
  assert(deletion.deleted === true, "Successful DELETE must report deletion");
  const deleteRequest = state.requests.find((request) => request.method === "DELETE");
  assert(deleteRequest.url.endsWith("/Folder/a.txt"), "DELETE must target the exact validated path");
}

async function checkMergeAndShareCopy(){
  const { state, storage } = createStorageHarness();
  state.requestHandler = async (options) => {
    if (options.method === "PROPFIND"){
      return { ok: true, status: 207, raw: "dav-response" };
    }
    if (options.method === "MKCOL"){
      return { ok: true, status: 201, raw: "" };
    }
    return { ok: true, status: 204, raw: "" };
  };
  state.parseQueue.push(
    [{ path: "/Source", name: "Source", kind: "directory" }],
    [
      { path: "/Source", name: "Source", kind: "directory" },
      { path: "/Source/Empty", name: "Empty", kind: "directory" },
      { path: "/Source/file.txt", name: "file.txt", kind: "file", size: 4 }
    ],
    [{ path: "/Source/Empty", name: "Empty", kind: "directory" }]
  );
  const merged = await storage.copyFolder("/Source", "/Target", true);
  const mkcols = state.requests.filter((request) => request.method === "MKCOL");
  assert(mkcols.some((request) => request.url.endsWith("/Target")), "Folder merge must create the destination root");
  assert(mkcols.some((request) => request.url.endsWith("/Target/Empty")), "Folder merge must preserve empty folders");
  assert(state.copies.some((copy) => copy.sourcePath === "/Source/file.txt" && copy.destinationPath === "/Target/file.txt"), "Folder merge must copy files server-side");
  assert(merged.changes.some((change) => change.target.path === "/Target/Empty"), "Folder merge must report created empty folders");

  state.copies.length = 0;
  const shareCopy = await storage.copyIntoShare({
    sourcePath: "/Source/Empty",
    destinationPath: "/NC Connector/Share/Empty",
    kind: "directory",
    expectedAccountKey: (await storage.getAccountIdentity()).key
  });
  assert(shareCopy.serverSide === true, "Same-Nextcloud share materialization must stay server-side");
  assert(state.copies.length === 1, "Same-Nextcloud share materialization must use one COPY request");
  assert(state.copies[0].kind === "directory" && state.copies[0].overwrite === false, "Share folder copy must preserve empty folders and refuse overwrite");

  const usage = await storage.storageUsage();
  assert(usage.usage === 10 && usage.quota === 100, "Storage usage must return parsed Nextcloud quota values");

  const controller = new AbortController();
  controller.abort();
  await expectFailure(
    () => storage.list("/", { signal: controller.signal }),
    (error) => error.name === "AbortError",
    "Canceled storage operations must stop before network access"
  );

  const partial = createStorageHarness();
  partial.state.requestHandler = state.requestHandler;
  partial.state.parseQueue.push(
    [{ path: "/Source", name: "Source", kind: "directory" }],
    [
      { path: "/Source", name: "Source", kind: "directory" },
      { path: "/Source/first.txt", name: "first.txt", kind: "file" },
      { path: "/Source/second.txt", name: "second.txt", kind: "file" }
    ]
  );
  let copyCount = 0;
  partial.state.copyHandler = async () => {
    copyCount++;
    if (copyCount === 2){
      throw Object.assign(new Error("copy failed"), { status: 507 });
    }
    return { ok: true, status: 201, raw: "" };
  };
  const partialError = await expectFailure(
    () => partial.storage.copyFolder("/Source", "/Target", true),
    (error) => error.code === "E:PROVIDER" && error.status === 507,
    "Folder merge must surface the original DAV failure"
  );
  assert(
    partialError.completedChanges.some((change) => change.target.path === "/Target/first.txt"),
    "Folder merge errors must retain completed changes for provider notification"
  );
}

async function run(){
  await checkStrictPathsAndServerCopy();
  await checkIdentityAndListing();
  await checkReadWriteAndMutations();
  await checkMergeAndShareCopy();
  console.log("[OK] nextcloud-vfs-storage-check passed");
}

run().catch((error) => {
  console.error("[FAIL] nextcloud-vfs-storage-check", error);
  process.exitCode = 1;
});
