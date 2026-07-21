"use strict";

const vm = require("node:vm");
const { assert, loadScript } = require("./review-check-utils");

function createHarness({ capabilityGenerateUrl = null, generatedPassword = "Server-Password-1!" } = {}){
  const baseUrl = "https://cloud.example.test/nextcloud";
  const requests = [];
  const context = {
    console,
    globalThis: null,
    L: () => {},
    module: undefined,
    NCCore: {
      normalizeBaseUrl: (value) => String(value || "").replace(/\/+$/, ""),
      getOpts: async () => ({
        baseUrl,
        user: "alice",
        appPass: "app-password"
      })
    },
    NCHostPermissions: {
      hasOriginPermission: async () => true
    },
    NCOcs: {
      buildAuthHeader: () => "Basic test",
      ocsRequest: async (request) => {
        requests.push(request);
        if (request.url.includes("/ocs/v2.php/cloud/capabilities")){
          return {
            ok: true,
            status: 200,
            data: {
              ocs: {
                data: {
                  capabilities: {
                    password_policy: {
                      minLength: 16,
                      api: {
                        generate: capabilityGenerateUrl
                      }
                    }
                  }
                }
              }
            }
          };
        }
        return {
          ok: true,
          status: 200,
          data: {
            ocs: {
              data: {
                password: generatedPassword
              }
            }
          }
        };
      }
    },
    NCLogContext: {
      safeConsoleError: () => {}
    },
    URL,
    window: null
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  loadScript(
    "modules/passwordPolicyRuntime.js",
    context,
    "\nglobalThis.NCPasswordPolicyRuntime = NCPasswordPolicyRuntime;"
  );
  loadScript("ui/passwordPolicyClient.js", context);
  return {
    baseUrl,
    client: context.NCPasswordPolicyClient,
    requests,
    runtime: context.NCPasswordPolicyRuntime
  };
}

async function run(){
  const foreignCapability = createHarness({
    capabilityGenerateUrl: "https://passwords.example.test/generate"
  });
  const foreignPolicy = await foreignCapability.runtime.fetchPolicy();
  assert(foreignPolicy.hasPolicy === true, "Password policy metadata should still be available");
  assert(foreignPolicy.apiGenerateUrl === null, "Foreign generator URL must be removed from policy metadata");
  assert(foreignCapability.requests.length === 1, "Policy fetch should only call the Nextcloud capabilities endpoint");
  assert(
    foreignCapability.requests[0].url.startsWith(foreignCapability.baseUrl),
    "Policy fetch must remain on the configured Nextcloud base"
  );

  const foreignRequest = createHarness();
  let localCalls = 0;
  const localPassword = await foreignRequest.client.generatePassword({
    policy: {
      hasPolicy: true,
      minLength: 18,
      apiGenerateUrl: "https://passwords.example.test/generate"
    },
    sendMessage: (message) => foreignRequest.runtime.generatePassword(message.payload.policy),
    passwordGenerator: ({ length }) => {
      localCalls++;
      assert(length === 18, "Local fallback should retain the policy minimum length");
      return "Local-Password-1!";
    },
    fallbackLength: 12
  });
  assert(localPassword === "Local-Password-1!", "Foreign generator URL must use local password generation");
  assert(localCalls === 1, "Foreign generator URL should call the local generator once");
  assert(foreignRequest.requests.length === 0, "Foreign generator URL must not start an authenticated request");

  const sameOrigin = createHarness({ generatedPassword: "Same-Origin-Password-1!" });
  let sameOriginLocalCalls = 0;
  const sameOriginPassword = await sameOrigin.client.generatePassword({
    policy: {
      hasPolicy: true,
      minLength: 16,
      apiGenerateUrl: "https://cloud.example.test/index.php/apps/password_policy/api/v1/generate"
    },
    sendMessage: (message) => sameOrigin.runtime.generatePassword(message.payload.policy),
    passwordGenerator: () => {
      sameOriginLocalCalls++;
      return "Local-Password-1!";
    },
    fallbackLength: 12
  });
  assert(sameOriginPassword === "Same-Origin-Password-1!", "Same-origin generator should return the server password");
  assert(sameOriginLocalCalls === 0, "Same-origin generator should not call the local fallback");
  assert(sameOrigin.requests.length === 1, "Same-origin generator should start one request");
  assert(sameOrigin.requests[0].headers.Authorization === "Basic test", "Same-origin generator request should include Basic Auth");

  const relativeCapability = createHarness({
    capabilityGenerateUrl: "/ocs/v2.php/apps/password_policy/api/v1/generate"
  });
  const relativePolicy = await relativeCapability.runtime.fetchPolicy();
  assert(
    relativePolicy.apiGenerateUrl === "https://cloud.example.test/ocs/v2.php/apps/password_policy/api/v1/generate",
    "Relative generator URL should resolve on the configured Nextcloud origin"
  );

  console.log("[OK] password-policy-runtime-check passed");
}

run().catch((error) => {
  console.error("[FAIL] password-policy-runtime-check", error);
  process.exitCode = 1;
});
