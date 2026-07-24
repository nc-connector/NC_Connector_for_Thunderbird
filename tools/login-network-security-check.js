"use strict";

const { assert } = require("./review-check-utils");
const {
  makeResponse,
  collectLogText,
  expectRejected,
  createCoreHarness
} = require("./network-security-test-utils");

async function checkStartRequest(){
  let bodyReadInsideTimeout = false;
  const harness = createCoreHarness({
    fetchImpl: ({ insideTimeout }) => makeResponse(200, "", {
      text: async () => {
        bodyReadInsideTimeout = insideTimeout();
        return JSON.stringify({
          login: "https://cloud.example.test/login/flow/abc",
          poll: {
            endpoint: "/index.php/login/v2/poll",
            token: "poll-secret"
          }
        });
      }
    })
  });
  const start = await harness.core.startLoginFlow("https://cloud.example.test/nextcloud/");
  assert(bodyReadInsideTimeout, "Login Flow start must read the response body inside runWithTimeout");
  assert(harness.timeoutCalls.length === 1, "Login Flow start must use one bounded request");
  assert(
    harness.requests[0].options.signal === harness.timeoutCalls[0].signal,
    "Login Flow start must pass the timeout signal to fetch"
  );
  assert(
    start.pollEndpoint === "https://cloud.example.test/nextcloud/index.php/login/v2/poll",
    "Login Flow start must preserve a configured Nextcloud subfolder"
  );
}

async function checkCredentialLogging(){
  const leakedAuth = "dXNlcjpsZWFrZWQtcGFzcw==";
  const leakedPassword = "plain-secret-value";
  const leakedCookie = "ncc_session=plain-secret-cookie";
  const leakedPublicToken = "public-share-token";
  const leakedSecretKey = "secret-fragment-key";
  const networkHarness = createCoreHarness({
    fetchImpl: async () => {
      throw new Error(
        `Authorization: Basic ${leakedAuth} appPassword=${leakedPassword} `
          + `Cookie: ${leakedCookie}\n`
          + `https://cloud.example.test/s/${leakedPublicToken} `
          + `https://cloud.example.test/index.php/apps/secrets/share/id#${leakedSecretKey}`
      );
    }
  });
  const networkFailure = await expectRejected(
    () => networkHarness.core.startLoginFlow("https://cloud.example.test"),
    "A failed Login Flow start request must reject"
  );
  const networkLog = collectLogText(networkHarness.logs);
  assert(networkFailure.ncLoginFlowFatal === true, "Login Flow network failures must use the generic fatal error");
  assert(!networkLog.includes(leakedAuth), "Basic Auth values must be redacted from core logs");
  assert(!networkLog.includes(leakedPassword), "Password fields must be redacted from core logs");
  assert(!networkLog.includes(leakedCookie), "Cookie values must be redacted from core logs");
  assert(!networkLog.includes(leakedPublicToken), "Public-share tokens must be redacted from core logs");
  assert(!networkLog.includes(leakedSecretKey), "Secrets fragment keys must be redacted from core logs");
  assert(networkLog.includes("[redacted]"), "Credential redaction should remain visible in diagnostics");

  const rawSecret = "response-app-password";
  const rawToken = "response-poll-token";
  const rejectedHarness = createCoreHarness({
    fetchImpl: () => makeResponse(
      500,
      JSON.stringify({
        appPassword: rawSecret,
        pollToken: rawToken,
        loginName: "alice@example.test"
      })
    )
  });
  const rejectedFailure = await expectRejected(
    () => rejectedHarness.core.startLoginFlow("https://cloud.example.test"),
    "A rejected Login Flow start response must fail"
  );
  const rejectedLog = collectLogText(rejectedHarness.logs);
  assert(!rejectedFailure.message.includes(rawSecret), "Credential response bodies must not escape through errors");
  assert(!rejectedLog.includes(rawSecret), "Credential response bodies must not be logged");
  assert(!rejectedLog.includes(rawToken), "Poll tokens must not be logged");
}

async function checkPollDeadline(){
  const clock = { now: 0 };
  let bodyReads = 0;
  const harness = createCoreHarness({
    clock,
    fetchImpl: ({ insideTimeout }) => makeResponse(404, "", {
      text: async () => {
        assert(insideTimeout(), "Login Flow poll must read 404 response bodies inside runWithTimeout");
        bodyReads += 1;
        return "";
      }
    })
  });
  await expectRejected(
    () => harness.core.completeLoginFlow({
      pollEndpoint: "https://cloud.example.test/index.php/login/v2/poll",
      pollToken: "poll-secret",
      timeoutMs: 100,
      intervalMs: 60
    }),
    "Login Flow poll must stop at its total deadline"
  );
  assert(bodyReads === 2, "The poll loop should issue only requests that start before the deadline");
  assert(clock.now === 100, "The polling delay must not extend beyond the total deadline");
  assert(
    harness.timeoutCalls[0].options.timeoutMs === 100
      && harness.timeoutCalls[1].options.timeoutMs === 40,
    "Each poll request timeout must be capped by the remaining total deadline"
  );
  for (let index = 0; index < harness.requests.length; index++){
    assert(
      harness.requests[index].options.signal === harness.timeoutCalls[index].signal,
      "Every Login Flow poll request must receive its timeout signal"
    );
  }
}

async function run(){
  await checkStartRequest();
  await checkCredentialLogging();
  await checkPollDeadline();
  console.log("[OK] login-network-security-check passed");
}

run().catch((error) => {
  console.error("[FAIL] login-network-security-check", error);
  process.exitCode = 1;
});
