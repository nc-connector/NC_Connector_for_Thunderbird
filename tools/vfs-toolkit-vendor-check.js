"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROOT,
  assert,
  listFiles,
  readText
} = require("./review-check-utils");

const PINNED_COMMIT = "3476faa0870bb6dbe63c7c72fc3dab2b67731f4e";
const VENDOR_ROOT = "vendor/vfs-toolkit";
const VENDORED_SHA256 = Object.freeze({
  "LICENSE": "1F256ECAD192880510E84AD60474EAB7589218784B9A50BC7CEEE34C2B91F1D5",
  "vfs-client/icon-configure.svg": "342E9E9627EA98D308874F3C3D72C319FAD7919E2C22F1EEC6150705701CACDD",
  "vfs-client/locales/cs.json": "C85CC8F343E2970135AC823C567AD9D6A6A6AA6787995C2F79E56F499FB708C6",
  "vfs-client/locales/de.json": "3F2AD3DA930E3639EF1B35F3D343BE9C75B6B92C65AD6B1071DA50F2D39EAAF8",
  "vfs-client/locales/en.json": "2FD211CE65F498415923F8CC338C9C8B381763CB25082A40BFD69E6CB3DF911B",
  "vfs-client/locales/es.json": "CE2CA52E4099828600710E9F6EE66AB16F1AF3AFFDFB115FA846A5EB354D2D0B",
  "vfs-client/locales/fr.json": "83B7D7F94713FD3630F03E72BBDC09C260A374C74320C685CF4C16F5FCD39CBF",
  "vfs-client/locales/hu.json": "DB41C82FCB05045C9E1E98F848DE2657C1296AD31833181AF52B3139154C47A6",
  "vfs-client/locales/it.json": "C57F3AF7DF20D66ACB23280616470497BF7E302B7DBF36CD1D06971FF717A5FC",
  "vfs-client/locales/ja.json": "FEF7A3C12A714E51E748AEBADF47E9E045FB560F3D980AA3DDEED54C3B06BB7E",
  "vfs-client/locales/nl.json": "1DC9DB9B88AE69CE5627D8D70FC09ED3AE782404BAD673F459D3F48967C2A022",
  "vfs-client/locales/pl.json": "CD9B58C640AFB698AC0F69B74D853E7CB5B3DE961C76B6B7E96D8538999C40BB",
  "vfs-client/locales/pt.json": "609046036B6A8EAEB2B2B87F2778CA6B412F647339E0FF1B9360B0C7E43F4DAE",
  "vfs-client/locales/ru.json": "135445974363054187A52100D882995DB3CF1D2FC1112A1E656D950E6081235A",
  "vfs-client/locales/sv.json": "71140065A0528C22949781DD31A8DC2F89103C52EF5B80F2EAC96199158E43A7",
  "vfs-client/locales/zh_CN.json": "20B309D382D7EAE6223A2DB1A54F8BE7DDA73F26A21AEE01919F29B873F9325D",
  "vfs-client/locales/zh_TW.json": "050785EE513CCB848C2EF173598D1B1BB4E3F73BADF5068653137FBD56E288DE",
  "vfs-client/opfs-provider.mjs": "2EC8C521071101624D39EC03E1F8D59DD0C0DC39C9CE564397DBE9B86B6A9F8B",
  "vfs-client/picker.css": "72B87D51DB12DAB2A2ED05F51F93674611E539837F96A27AD0BC731A663A7137",
  "vfs-client/picker.html": "C1AE76743748E346A1766AFE2A8CF94B196F1533D5417EBF0302A37B8590EDC7",
  "vfs-client/picker.mjs": "D81DBE7DBA8346EBD3A0D57E2FDA5EA8892AC4968844A712DB3CE325B8E32F42",
  "vfs-client/vfs-client.mjs": "D0C65EE761944526F956A1DB43D4E71F9A7FF69241197218F8AB9B3B392A0EE7",
  "vfs-provider/vfs-provider.mjs": "CDF9BED9683AF96505C2AAE8F3798CC3BD0D835388A8C9F908B17BF67596329D"
});
const UPSTREAM_SHA256 = Object.freeze({
  "vfs-client/locales/nl.json": null,
  "vfs-client/locales/pl.json": null,
  "vfs-client/locales/zh_CN.json": null,
  "vfs-client/locales/zh_TW.json": null,
  "vfs-client/picker.css": "41211B8092E588C2468BC08A1F41C0FC362E64CFC21E09A6D5E6AA4190CD5B95",
  "vfs-client/picker.mjs": "6DA0F305C3BE9FBFD9541437F3E3948E0D99447F1EBA93FBCE1032877F0DD924",
  "vfs-client/vfs-client.mjs": "7C69AD748EAC21680E2C97C98FE8725549B6D2406E388A407A09A29DFAF54DFA",
  "vfs-provider/vfs-provider.mjs": "0A9D4F9F5841254F6AA517EC5CD7A7D87B557EB2D3814B670529BF66BEDE73E9"
});

function sha256(buffer){
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function placeholders(value){
  return Array.from(String(value || "").matchAll(/\$\d+/g), (match) => match[0])
    .sort();
}

function checkPickerIntegration(){
  const picker = readText(`${VENDOR_ROOT}/vfs-client/picker.mjs`);
  const pickerCss = readText(`${VENDOR_ROOT}/vfs-client/picker.css`);
  assert(
    /#vfs-toolbar\s*\{[^}]*display:\s*none\s*;/s.test(pickerCss),
    "The source-selection picker must hide the VFS management toolbar"
  );
  for (const locale of ["nl", "pl", "zh_CN", "zh_TW"]){
    assert(picker.includes(`'${locale}'`), `The picker must advertise locale ${locale}`);
  }
  assert(
    picker.includes("_uiLocale.region") && picker.includes("_uiLocale.language"),
    "Picker locale resolution must preserve regional locale tags"
  );

  const english = JSON.parse(readText(`${VENDOR_ROOT}/vfs-client/locales/en.json`));
  const expectedKeys = Object.keys(english).sort();
  for (const locale of ["nl", "pl", "zh_CN", "zh_TW"]){
    const localized = JSON.parse(readText(`${VENDOR_ROOT}/vfs-client/locales/${locale}.json`));
    assert(
      JSON.stringify(Object.keys(localized).sort()) === JSON.stringify(expectedKeys),
      `Picker locale ${locale} must match the English key set`
    );
    for (const key of expectedKeys){
      assert(
        JSON.stringify(placeholders(localized[key])) === JSON.stringify(placeholders(english[key])),
        `Picker locale ${locale} must preserve placeholders for ${key}`
      );
    }
  }
}

function checkFiles(){
  const expectedFiles = Object.keys(VENDORED_SHA256).sort();
  const actualFiles = listFiles(VENDOR_ROOT)
    .map((relativePath) => relativePath.slice(`${VENDOR_ROOT}/`.length))
    .sort();
  assert(
    JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
    "The vendored VFS Toolkit file set must match the reviewed pinned runtime files"
  );

  for (const [relativePath, expectedHash] of Object.entries(VENDORED_SHA256)){
    const file = fs.readFileSync(path.join(ROOT, VENDOR_ROOT, relativePath));
    assert(sha256(file) === expectedHash, `${relativePath} must match its reviewed SHA-256`);
    assert(!file.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), `${relativePath} must not use a UTF-8 BOM`);
    assert(!file.includes(Buffer.from("\r\n")), `${relativePath} must use LF line endings`);
  }
}

function checkSelfProviderPatch(){
  const client = readText(`${VENDOR_ROOT}/vfs-client/vfs-client.mjs`);
  const provider = readText(`${VENDOR_ROOT}/vfs-provider/vfs-provider.mjs`);

  assert(client.includes('const API_VERSION = "1.3";'), "The VFS client API version must remain 1.3");
  assert(provider.includes('const API_VERSION = "1.3";'), "The VFS provider API version must remain 1.3");
  assert(
    !client.includes("_probeExtension(browser.runtime.id)"),
    "A provider in the same background must not rely on a runtime self-probe"
  );
  const externalReturnIndex = client.indexOf("if (!options.enableExternalProviders) return;");
  const configKeyIndex = client.indexOf("_configStorageKey = options?.configStorageKey ?? null;");
  const getConnectionsIndex = client.indexOf("msg?.type === 'vfs-toolkit-get-connections'");
  const localProviderIndex = client.indexOf("export async function registerLocalProvider(descriptor, connect)");
  const managementCheckIndex = client.indexOf("if (typeof browser.management === 'undefined')");
  const externalConnectionIndex = client.indexOf("browser.runtime.onMessageExternal.addListener(_handleConnectionMessage);");
  assert(externalReturnIndex >= 0, "External provider support must keep its explicit feature gate");
  for (const [name, index] of [
    ["provider storage key", configKeyIndex],
    ["connection query", getConnectionsIndex]
  ]){
    assert(index >= 0 && index < externalReturnIndex, `The ${name} must initialize without management access`);
  }
  assert(localProviderIndex >= 0, "The co-located provider registration API must be present");
  assert(
    managementCheckIndex > externalReturnIndex && externalConnectionIndex > managementCheckIndex,
    "External provider discovery and connection updates must remain management-gated"
  );
  assert(
    client.includes("if (id === browser.runtime.id) return;"),
    "External provider discovery must exclude the add-on's self provider"
  );
  assert(
    client.includes("_localProviders.set(providerId, { connect });")
      && client.includes("const localProvider = _localProviders.get(providerId);")
      && provider.includes("connectLocal()")
      && provider.includes("_createLocalPortPair()"),
    "A provider in the client background must use the reviewed local Toolkit port"
  );
  assert(
    client.includes("async function _providerSend(providerId, cmd, args = {}, onProgress, signal = null)")
      && client.includes("canceledRequestId: requestId")
      && client.includes("signal?.addEventListener('abort', abortHandler, { once: true })"),
    "Provider requests must support request-scoped cancellation"
  );
  assert(
    client.includes("_openPopupWindow(sessionId, pickerParams, width, height, signal)")
      && client.includes("browser.windows.remove(windowId).catch(() => { })"),
    "Picker cancellation must close only its own popup"
  );
  assert(
    client.includes("browser.runtime.onMessageExternal.addListener(_handleConnectionMessage);")
      && client.includes("if (sender.id !== browser.runtime.id) return false;")
      && client.includes("return _handleConnectionMessage(msg, sender);"),
    "Connection updates must accept known external providers and the co-located provider only"
  );
  assert(
    client.includes("return _addConnection(sender.id, msg.storageId, msg.name, msg.capabilities);")
      && client.includes("return _removeConnection(sender.id, msg.storageId).then(() =>"),
    "Connection messages must acknowledge only after the client session record is updated"
  );
  assert(
    provider.includes("browser.runtime.onMessageExternal.addListener((msg, sender, sendResponse) =>")
      && provider.includes("msg?.type === 'vfs-toolkit-discover'"),
    "Provider discovery must remain on the external discovery channel"
  );
  assert(
    provider.includes("browser.runtime.onConnectExternal.addListener(connectionPortHandler);")
      && provider.includes("browser.runtime.onConnect.addListener(connectionPortHandler);"),
    "Provider ports must use the same handler for external and internal connections"
  );
  assert(
    provider.includes("const consumerId = String(port.sender?.id ?? '')")
      && provider.includes("c.addonId === consumerId && c.storageId === storageId"),
    "Provider access must bind a storage connection to the verified port sender"
  );
  assert(
    provider.includes("async completeSetup(setupToken, storageId, name, capabilities)")
      && provider.includes("return owner.completeSetup("),
    "Provider setup grants must be completed through their verified setup token"
  );
  assert(
    provider.includes("const targetPort = this.#requestPorts.get(args.canceledRequestId)")
      && provider.includes("if (targetPort !== originPort)"),
    "Provider cancellation must be restricted to requests from the same port"
  );
  assert(
    provider.includes("API 1.3 clients originally sent cancel without a request ID of its own")
      && provider.includes("cmd === 'cancel' && (typeof requestId !== 'string' || !requestId)"),
    "The provider must keep accepting the API 1.3 legacy cancel envelope"
  );
  assert(
    client.includes("if (providerId === browser.runtime.id)")
      && client.includes("await _handleConnectionMessage(message, { id: providerId })"),
    "Deleting a co-located connection must update the client session in the sending background"
  );
}

function checkDocumentation(){
  const vendorDoc = readText("VENDOR.md");
  assert(vendorDoc.includes(PINNED_COMMIT), "VENDOR.md must record the exact VFS Toolkit commit");
  assert(vendorDoc.includes("API version: `1.3`"), "VENDOR.md must record VFS Toolkit API version 1.3");
  assert(vendorDoc.includes("License: MPL-2.0"), "VENDOR.md must record the VFS Toolkit license");

  for (const [relativePath, vendoredHash] of Object.entries(VENDORED_SHA256)){
    const hasExplicitUpstreamHash = Object.prototype.hasOwnProperty.call(UPSTREAM_SHA256, relativePath);
    const upstreamHash = hasExplicitUpstreamHash ? UPSTREAM_SHA256[relativePath] : vendoredHash;
    const upstreamCell = upstreamHash === null ? "—" : `\`${upstreamHash}\``;
    const tableRow = `| \`${relativePath}\` | ${upstreamCell} | \`${vendoredHash}\` |`;
    assert(vendorDoc.includes(tableRow), `VENDOR.md must record both hashes for ${relativePath}`);
  }
}

function run(){
  checkFiles();
  checkSelfProviderPatch();
  checkPickerIntegration();
  checkDocumentation();
  console.log("[OK] vfs-toolkit-vendor-check passed");
}

try{
  run();
}catch(error){
  console.error("[FAIL] vfs-toolkit-vendor-check", error);
  process.exitCode = 1;
}
