"use strict";

const {
  runProgressChecks
} = require("./filelink-progress-suite");
const {
  runBackgroundLifecycleChecks
} = require("./filelink-background-lifecycle-suite");

async function run(){
  runProgressChecks();
  await runBackgroundLifecycleChecks();
  console.log("[OK] filelink-lifecycle-check passed");
}

run().catch((error) => {
  console.error("[FAIL] filelink-lifecycle-check", error);
  process.exitCode = 1;
});
