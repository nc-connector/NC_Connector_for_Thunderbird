"use strict";

const {
  runDavProtocolChecks
} = require("./filelink-dav-protocol-suite");
const {
  runShareProtocolChecks
} = require("./filelink-share-protocol-suite");

async function run(){
  await runDavProtocolChecks();
  await runShareProtocolChecks();
  console.log("[OK] filelink-protocol-check passed");
}

run().catch((error) => {
  console.error("[FAIL] filelink-protocol-check", error);
  process.exitCode = 1;
});
