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

const BASE_COMMIT = "3476faa0870bb6dbe63c7c72fc3dab2b67731f4e";
const APPLIED_PR_COMMITS = Object.freeze([
  "e1a6a69dfaf7cee34999987dff1b63ba710d9409",
  "95f9a744fef07f2b8fb89b39d23b3a49672ef3ca",
  "7bfe56256d11d430c66a9bf4a4a321b4d70f2b7f",
  "a82f2b767f4183f582ed33e81cd35a1c45639430",
  "979429022cc074122c655d7210a9d746f7e33f05",
  "f50d445dc52c4b4a0b79f7b7a5e7984144d1958c",
  "baf1c7673ec22208a563afc02b9c7c7bb97c8d3d"
]);
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
  "vfs-client/picker.css": "DA375628F769E336B74B4311130DE1324E8AE2221AC1A803776793DE3802A5F1",
  "vfs-client/picker.html": "7E2F34DCC449CBB9A9F6183B0E7221D1DE6D5A547303A174B34846DC27AB85C7",
  "vfs-client/picker.mjs": "185A0AF304C3F176DAB42A96FB6A6A416AFA50F19B91B7C6CA9FB03E52799199",
  "vfs-client/vfs-client.mjs": "4ED076F703F7AB4A0E5E660094EA0A6954385FD3C7FD67C3DB0223ECB5B9561B",
  "vfs-provider/vfs-provider.mjs": "CDF9BED9683AF96505C2AAE8F3798CC3BD0D835388A8C9F908B17BF67596329D"
});

function sha256(buffer){
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function placeholders(value){
  return Array.from(String(value || "").matchAll(/\$\d+/g), (match) => match[0])
    .sort();
}

function checkPickerIntegration(){
  const client = readText(`${VENDOR_ROOT}/vfs-client/vfs-client.mjs`);
  const picker = readText(`${VENDOR_ROOT}/vfs-client/picker.mjs`);
  const pickerCss = readText(`${VENDOR_ROOT}/vfs-client/picker.css`);
  const pickerHtml = readText(`${VENDOR_ROOT}/vfs-client/picker.html`);
  assert(
    /#vfs-toolbar\s*\{[^}]*display:\s*flex\s*;/s.test(pickerCss)
      && !/#vfs-toolbar\s*\{[^}]*display:\s*none\s*;/s.test(pickerCss),
    "The vendored picker must not contain the removed local toolbar CSS patch"
  );
  assert(
    (client.match(/pickerParams\.set\('showToolbarActions', '0'\)/g) || []).length === 4
      && (client.match(/pickerParams\.set\('showContextMenu', '0'\)/g) || []).length === 4
      && picker.includes("const SHOW_TOOLBAR_ACTIONS = params.get('showToolbarActions') !== '0';")
      && picker.includes("const SHOW_CONTEXT_MENU = params.get('showContextMenu') !== '0';")
      && pickerCss.includes("html.toolbar-actions-hidden #vfs-toolbar .vfs-toolbar-action")
      && pickerHtml.includes('class="vfs-toolbar-action"'),
    "The vendored picker must expose the upstream toolbar and context-menu options"
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

function checkProviderFeatures(){
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
  assert(vendorDoc.includes(BASE_COMMIT), "VENDOR.md must record the exact VFS Toolkit base commit");
  for (const commit of APPLIED_PR_COMMITS){
    assert(vendorDoc.includes(commit), `VENDOR.md must record applied upstream commit ${commit}`);
  }
  assert(vendorDoc.includes("API version: `1.3`"), "VENDOR.md must record VFS Toolkit API version 1.3");
  assert(vendorDoc.includes("License: MPL-2.0"), "VENDOR.md must record the VFS Toolkit license");

  for (const [relativePath, vendoredHash] of Object.entries(VENDORED_SHA256)){
    const tableRow = `| \`${relativePath}\` | \`${vendoredHash}\` | \`${vendoredHash}\` |`;
    assert(vendorDoc.includes(tableRow), `VENDOR.md must record both hashes for ${relativePath}`);
  }
}

function run(){
  checkFiles();
  checkProviderFeatures();
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
