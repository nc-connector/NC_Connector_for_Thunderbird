"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { assert } = require("./review-check-utils");

const ROOT = path.resolve(__dirname, "..");
const LOG_CONTEXT_SOURCE = fs.readFileSync(
  path.join(ROOT, "modules", "logContext.js"),
  "utf8"
);
const BG_STATE_SOURCE = fs.readFileSync(
  path.join(ROOT, "modules", "bgState.js"),
  "utf8"
);

function createStateHarness(storageGet){
  const logs = [];
  const context = vm.createContext({
    URL,
    Uint8Array,
    clearTimeout,
    crypto: webcrypto,
    globalThis: null,
    setTimeout,
    console: {
      log(...args){
        logs.push(["log", ...args]);
      },
      error(...args){
        logs.push(["error", ...args]);
      }
    },
    browser: {
      runtime: {
        getManifest(){
          return { version: "3.2.3" };
        }
      },
      storage: {
        local: {
          get: storageGet
        },
        onChanged: {
          addListener(){}
        }
      }
    },
    NCSharingStorage: {
      DEFAULT_ATTACHMENT_THRESHOLD_MB: 20,
      async migrateLegacySharingKeys(){},
      normalizeAttachmentThresholdMb(value){
        return Number(value) || 20;
      }
    },
    NCTalkTextUtils: {
      shortId(value){
        return String(value || "").slice(0, 8);
      }
    }
  });
  context.globalThis = context;
  vm.runInContext(LOG_CONTEXT_SOURCE, context, {
    filename: "modules/logContext.js"
  });
  vm.runInContext(BG_STATE_SOURCE, context, {
    filename: "modules/bgState.js"
  });
  return { context, logs };
}

async function checkHydrationFailsClosed(){
  const failure = new Error("storage unavailable");
  const harness = createStateHarness(async () => {
    throw failure;
  });
  let rejected = null;
  try{
    await vm.runInContext("BG_STATE_READY", harness.context);
  }catch(error){
    rejected = error;
  }
  assert(rejected === failure, "Background hydration must propagate storage read failures");
}

async function checkBackgroundDebugRedaction(){
  const harness = createStateHarness(async () => ({
    debugEnabled: true,
    nctalkRoomMeta: {},
    nctalkEventTokenMap: {},
    nctalkRoomDeleteRetry: {}
  }));
  await vm.runInContext("BG_STATE_READY", harness.context);
  vm.runInContext(
    `L("privacy probe", {
      userId: "alice",
      actor: "alice@example.test",
      endpoint: "https://cloud.example.test/remote.php/dav/files/alice/Folder",
      roomUrl: "https://cloud.example.test/ocs/v2.php/apps/spreed/api/v4/room/full-room-token"
    })`,
    harness.context
  );
  const output = harness.logs
    .flatMap((entry) => entry.slice(1))
    .map((entry) => {
      try{
        return typeof entry === "string" ? entry : JSON.stringify(entry);
      }catch(error){
        return String(entry);
      }
    })
    .join("\n");
  for (const forbidden of [
    "alice@example.test",
    "/files/alice/",
    "full-room-token",
    '"userId":"alice"'
  ]){
    assert(!output.includes(forbidden), `Background debug logs must redact ${forbidden}`);
  }
  assert(output.includes("[redacted]"), "Background debug logs must retain redaction markers");
}

async function run(){
  await checkHydrationFailsClosed();
  await checkBackgroundDebugRedaction();
  console.log("[OK] background-state-security-check passed");
}

run().catch((error) => {
  console.error("[FAIL] background-state-security-check", error);
  process.exitCode = 1;
});
