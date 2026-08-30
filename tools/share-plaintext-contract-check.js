'use strict';

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const RIGHTS_SEGMENT_START = "[[NCSHARE_RIGHTS_START]]";
const RIGHTS_SEGMENT_END = "[[NCSHARE_RIGHTS_END]]";

function assert(condition, message){
  if (!condition){
    throw new Error(message);
  }
}

function parseHtmlAttributes(source){
  const attributes = {};
  const expression = /([^\s=]+)(?:\s*=\s*"([^"]*)")?/g;
  let match = null;
  while ((match = expression.exec(String(source || "")))){
    attributes[match[1].toLowerCase()] = match[2] ?? "";
  }
  return attributes;
}

function parseHtmlFragment(source){
  const root = { tagName: "#root", attributes: {}, children: [], text: "" };
  const stack = [root];
  const expression = /<\/?([a-z][a-z0-9:-]*)\b([^>]*)>/gi;
  let cursor = 0;
  let match = null;
  while ((match = expression.exec(String(source || "")))){
    stack[stack.length - 1].text += source.slice(cursor, match.index);
    const closing = match[0].startsWith("</");
    const tagName = match[1].toLowerCase();
    if (closing){
      assert(stack.length > 1 && stack[stack.length - 1].tagName === tagName, `Unexpected closing </${tagName}> in generated Rights HTML`);
      stack.pop();
    }else{
      const node = {
        tagName,
        attributes: parseHtmlAttributes(match[2]),
        children: [],
        text: ""
      };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
    cursor = expression.lastIndex;
  }
  stack[stack.length - 1].text += String(source || "").slice(cursor);
  assert(stack.length === 1, "Generated Rights HTML must close every element");
  return root;
}

function elementChildren(node, tagName){
  const normalizedTagName = String(tagName || "").toLowerCase();
  return node.children.filter((child) => child.tagName === normalizedTagName);
}

function collectElements(node, tagName, output = []){
  const normalizedTagName = String(tagName || "").toLowerCase();
  for (const child of node.children){
    if (child.tagName === normalizedTagName){
      output.push(child);
    }
    collectElements(child, normalizedTagName, output);
  }
  return output;
}

function nodeText(node){
  return node.text + node.children.map((child) => nodeText(child)).join("");
}

function parseStyle(value){
  const properties = {};
  for (const declaration of String(value || "").split(";")){
    const separator = declaration.indexOf(":");
    if (separator < 0){
      continue;
    }
    const name = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim().replace(/\s+/g, " ");
    if (name){
      properties[name] = propertyValue;
    }
  }
  return properties;
}

function countOccurrences(value, token){
  return String(value || "").split(token).length - 1;
}

function assertPresentationTable(name, table){
  assert(table.attributes.role === "presentation", `${name} must use role=presentation`);
  assert(table.attributes.border === "0", `${name} must use border=0`);
  assert(table.attributes.cellspacing === "0", `${name} must use cellspacing=0`);
  assert(table.attributes.cellpadding === "0", `${name} must use cellpadding=0`);
  const style = parseStyle(table.attributes.style);
  assert(style["border-collapse"] === "collapse", `${name} must collapse borders`);
  assert(style.width === "auto", `${name} must grow naturally`);
  assert(style.margin === "0", `${name} must not add margins`);
}

function assertIconPresentationTable(name, table){
  assert(table.attributes.role === "presentation", `${name} must use role=presentation`);
  assert(table.attributes.border === "0", `${name} must use border=0`);
  assert(table.attributes.cellspacing === "0", `${name} must use cellspacing=0`);
  assert(table.attributes.cellpadding === "0", `${name} must use cellpadding=0`);
  assert(table.attributes.width === "14" && table.attributes.height === "14", `${name} must use fixed 14x14 attributes`);
  const style = parseStyle(table.attributes.style);
  assert(style["border-collapse"] === "collapse", `${name} must collapse borders`);
  assert(style.width === "14px" && style.height === "14px", `${name} must use fixed 14px dimensions`);
  assert(style.margin === "0", `${name} must not add margins`);
}

function assertPermissionsHtmlContract(caseName, html, labels, enabledStates){
  const normalizedHtml = String(html || "");
  const lowerHtml = normalizedHtml.toLowerCase();
  assert(!/display\s*:\s*(?:inline-)?flex/.test(lowerHtml), `${caseName} must not use flexbox`);
  assert(!/display\s*:\s*(?:inline-)?grid/.test(lowerHtml), `${caseName} must not use CSS grid`);
  assert(countOccurrences(normalizedHtml, "&#10003;") === enabledStates.filter(Boolean).length, `${caseName} must emit one check entity per enabled permission`);
  assert(countOccurrences(normalizedHtml, "&#10007;") === enabledStates.filter((enabled) => !enabled).length, `${caseName} must emit one cross entity per disabled permission`);

  const root = parseHtmlFragment(normalizedHtml);
  assert(root.children.length === 1 && root.children[0].tagName === "table", `${caseName} must contain one outer Rights table`);
  assert(collectElements(root, "table").length === 9, `${caseName} must contain one outer, four permission-group, and four icon tables`);
  assert(collectElements(root, "tbody").length === 9, `${caseName} must contain one tbody per table`);
  assert(collectElements(root, "tr").length === 9, `${caseName} must contain one outer, four permission-group, and four icon rows`);
  assert(collectElements(root, "td").length === 16, `${caseName} must contain four permission wrappers, four icon wrappers, four icon cells, and four labels`);

  const outerTable = root.children[0];
  assertPresentationTable(`${caseName} outer table`, outerTable);
  const outerBodies = elementChildren(outerTable, "tbody");
  assert(outerBodies.length === 1, `${caseName} must contain one outer tbody`);
  const outerRows = elementChildren(outerBodies[0], "tr");
  assert(outerRows.length === 1, `${caseName} must keep all permissions in one parent row`);
  const permissionCells = elementChildren(outerRows[0], "td");
  assert(permissionCells.length === 4, `${caseName} must contain exactly four parent permission cells`);

  permissionCells.forEach((permissionCell, index) => {
    assert(permissionCell.attributes.nowrap === "nowrap", `${caseName} item ${index + 1} must use nowrap=nowrap`);
    assert(permissionCell.attributes.valign === "middle", `${caseName} item ${index + 1} must use valign=middle`);
    const parentStyle = parseStyle(permissionCell.attributes.style);
    const expectedPadding = index === permissionCells.length - 1 ? "0" : "0 12px 0 0";
    assert(parentStyle.padding === expectedPadding, `${caseName} item ${index + 1} must use padding ${expectedPadding}`);
    assert(parentStyle["white-space"] === "nowrap", `${caseName} item ${index + 1} must prevent wrapping`);
    assert(parentStyle["vertical-align"] === "middle", `${caseName} item ${index + 1} must align vertically`);

    assert(!Object.prototype.hasOwnProperty.call(parentStyle, "border"), `${caseName} item ${index + 1} permission wrapper must not carry the icon border`);

    const nestedTables = elementChildren(permissionCell, "table");
    assert(nestedTables.length === 1, `${caseName} item ${index + 1} must contain one nested permission-group table`);
    assertPresentationTable(`${caseName} permission-group table ${index + 1}`, nestedTables[0]);
    const nestedBodies = elementChildren(nestedTables[0], "tbody");
    assert(nestedBodies.length === 1, `${caseName} item ${index + 1} must contain one nested tbody`);
    const nestedRows = elementChildren(nestedBodies[0], "tr");
    assert(nestedRows.length === 1, `${caseName} item ${index + 1} must contain one nested row`);
    const iconAndLabelCells = elementChildren(nestedRows[0], "td");
    assert(iconAndLabelCells.length === 2, `${caseName} item ${index + 1} must contain one icon wrapper and one label cell`);

    const iconWrapperCell = iconAndLabelCells[0];
    assert(iconWrapperCell.attributes.width === "14" && iconWrapperCell.attributes.height === "14", `${caseName} icon wrapper ${index + 1} must be 14x14`);
    assert(iconWrapperCell.attributes.valign === "middle", `${caseName} icon wrapper ${index + 1} must use valign=middle`);
    const iconWrapperStyle = parseStyle(iconWrapperCell.attributes.style);
    assert(iconWrapperStyle.width === "14px" && iconWrapperStyle.height === "14px", `${caseName} icon wrapper ${index + 1} must use fixed 14px dimensions`);
    assert(iconWrapperStyle.padding === "0", `${caseName} icon wrapper ${index + 1} must have no padding`);
    assert(iconWrapperStyle["vertical-align"] === "middle", `${caseName} icon wrapper ${index + 1} must align vertically`);
    assert(!Object.prototype.hasOwnProperty.call(iconWrapperStyle, "border"), `${caseName} icon wrapper ${index + 1} must remain unbordered`);

    const iconTables = elementChildren(iconWrapperCell, "table");
    assert(iconTables.length === 1, `${caseName} icon wrapper ${index + 1} must contain one icon-only table`);
    assertIconPresentationTable(`${caseName} icon table ${index + 1}`, iconTables[0]);
    const iconBodies = elementChildren(iconTables[0], "tbody");
    assert(iconBodies.length === 1, `${caseName} icon table ${index + 1} must contain one tbody`);
    const iconRows = elementChildren(iconBodies[0], "tr");
    assert(iconRows.length === 1, `${caseName} icon table ${index + 1} must contain one row`);
    const iconCells = elementChildren(iconRows[0], "td");
    assert(iconCells.length === 1, `${caseName} icon table ${index + 1} must contain one bordered icon cell`);

    const iconCell = iconCells[0];
    const expectedColor = enabledStates[index] ? "#0082C9" : "#c62828";
    const expectedSymbol = enabledStates[index] ? "&#10003;" : "&#10007;";
    assert(iconCell.attributes.width === "14" && iconCell.attributes.height === "14", `${caseName} icon ${index + 1} must be 14x14`);
    assert(iconCell.attributes.align === "center" && iconCell.attributes.valign === "middle", `${caseName} icon ${index + 1} must use legacy center alignment attributes`);
    const iconStyle = parseStyle(iconCell.attributes.style);
    assert(iconStyle.width === "14px" && iconStyle.height === "14px", `${caseName} icon ${index + 1} must use fixed 14px dimensions`);
    assert(iconStyle.border === `1px solid ${expectedColor}`, `${caseName} icon ${index + 1} must use the state border colour`);
    assert(iconStyle.color === expectedColor, `${caseName} icon ${index + 1} must use the state foreground colour`);
    assert(iconStyle["font-size"] === "11px", `${caseName} icon ${index + 1} must use an 11px symbol`);
    assert(iconStyle["font-weight"] === "700", `${caseName} icon ${index + 1} must use bold symbol weight`);
    assert(iconStyle["line-height"] === "14px", `${caseName} icon ${index + 1} must use a 14px line height`);
    assert(iconStyle.padding === "0", `${caseName} icon ${index + 1} must have no padding`);
    assert(!Object.prototype.hasOwnProperty.call(iconStyle, "mso-line-height-rule"), `${caseName} icon ${index + 1} must not use an MSO line-height rule`);
    assert(iconStyle["text-align"] === "center" && iconStyle["vertical-align"] === "middle", `${caseName} icon ${index + 1} must center the symbol`);
    assert(nodeText(iconCell).trim() === expectedSymbol, `${caseName} icon ${index + 1} must contain the correct state symbol`);

    const labelCell = iconAndLabelCells[1];
    assert(labelCell.attributes.nowrap === "nowrap" && labelCell.attributes.valign === "middle", `${caseName} label ${index + 1} must use no-wrap alignment attributes`);
    const labelStyle = parseStyle(labelCell.attributes.style);
    assert(labelStyle["padding-left"] === "5px", `${caseName} label ${index + 1} must be spaced 5px from its icon`);
    assert(!Object.prototype.hasOwnProperty.call(labelStyle, "padding"), `${caseName} label ${index + 1} must not use padding shorthand`);
    assert(labelStyle["white-space"] === "nowrap", `${caseName} label ${index + 1} must prevent wrapping`);
    assert(labelStyle["font-weight"] === "600", `${caseName} label ${index + 1} must use the required weight`);
    assert(labelStyle["vertical-align"] === "middle", `${caseName} label ${index + 1} must align vertically`);
    assert(!Object.prototype.hasOwnProperty.call(labelStyle, "font-family"), `${caseName} label ${index + 1} must inherit its font family`);
    assert(!Object.prototype.hasOwnProperty.call(labelStyle, "font-size"), `${caseName} label ${index + 1} must inherit its font size`);
    assert(nodeText(labelCell).trim() === escapeHtml(labels[index]), `${caseName} label ${index + 1} must be localized and HTML-escaped`);
  });
}

function read(relPath){
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function escapeHtml(value){
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripTags(value){
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeShareTemplateHtml(value){
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+=\"[^\"]*\"/gi, "")
    .replace(/\son[a-z]+='[^']*'/gi, "");
}

function htmlToPlainText(value){
  return String(value || "")
    .replace(/<a[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const plainText = stripTags(text).replace(/\s+/g, " ").trim();
      if (!plainText){
        return href;
      }
      return plainText === href ? plainText : `${plainText} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<img[^>]*alt=\"([^\"]*)\"[^>]*>/gi, "$1")
    .replace(/<img[^>]*alt='([^']*)'[^>]*>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainTextToHtml(value){
  return escapeHtml(String(value || "")).replace(/\r?\n/g, "<br />");
}

function extractBodyHtml(source){
  const bodyMatch = String(source || "").match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : String(source || "");
}

class FakeTemplateElement {
  constructor(body, startIndex, endIndex, innerHtml){
    this._body = body;
    this._startIndex = startIndex;
    this._endIndex = endIndex;
    this._innerHtml = innerHtml;
    this._removed = false;
  }

  get isConnected(){
    return !this._removed;
  }

  get innerHTML(){
    return this._innerHtml;
  }

  remove(){
    if (this._removed){
      return;
    }
    this._body._html = this._body._html.slice(0, this._startIndex) + this._body._html.slice(this._endIndex);
    this._removed = true;
  }
}

class FakeTemplateBody {
  constructor(html){
    this._html = extractBodyHtml(html);
  }

  get innerHTML(){
    return this._html;
  }

  querySelectorAll(selector){
    const tags = String(selector || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const matches = [];
    for (const tag of tags){
      const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
      let match = null;
      while ((match = expression.exec(this._html))){
        matches.push(new FakeTemplateElement(this, match.index, expression.lastIndex, match[1]));
      }
    }
    matches.sort((left, right) => left._startIndex - right._startIndex);
    return matches;
  }
}

class FakeDOMParser {
  parseFromString(source){
    return { body: new FakeTemplateBody(source) };
  }
}

function makeTranslations(){
  return {
    sharing_permission_read: "Read",
    sharing_permission_create: "Upload",
    sharing_permission_write: "Modify",
    sharing_permission_delete: "Delete",
    sharing_html_password_separate_hint: "Password will be sent in a separate email.",
    sharing_html_password_mail_intro: "Use the following password to access the share.",
    sharing_html_intro_line: "Open the Nextcloud link below to view the share.",
    sharing_html_zip_download_intro: "Download the shared files as a ZIP archive using the link below.",
    sharing_html_download_label: "ZIP download",
    sharing_html_share_link_label: "Nextcloud link",
    sharing_html_password_label: "Password",
    sharing_html_expire_label: "Valid until",
    sharing_html_permissions_label: "Permissions",
    sharing_html_footer: "Shared securely via {0}",
    error_host_permission_missing: "Host permission missing"
  };
}

function makeGermanTranslations(){
  return {
    sharing_permission_read: "Lesen",
    sharing_permission_create: "Hochladen",
    sharing_permission_write: "Bearbeiten",
    sharing_permission_delete: "Löschen",
    sharing_html_password_separate_hint: "Das Passwort wird in einer separaten E-Mail gesendet.",
    sharing_html_intro_line: "Die Dateien wurden sicher und datenschutzkonform über Nextcloud bereitgestellt. Öffnen Sie den untenstehenden Nextcloud-Link, um die Freigabe aufzurufen.",
    sharing_html_zip_download_intro: "Die Dateien wurden sicher und datenschutzkonform über Nextcloud bereitgestellt. Laden Sie die freigegebenen Dateien über den untenstehenden Link als ZIP-Archiv herunter.",
    sharing_html_download_label: "ZIP-Download",
    sharing_html_share_link_label: "Nextcloud-Link",
    sharing_html_password_label: "Passwort",
    sharing_html_expire_label: "Ablaufdatum",
    sharing_html_permissions_label: "Ihre Berechtigungen"
  };
}

function translate(translations, key, substitutions = []){
  let value = translations[key] || key || "";
  const args = Array.isArray(substitutions) ? substitutions : [substitutions];
  args.forEach((replacement, index) => {
    value = value.split(`{${index}}`).join(String(replacement ?? ""));
  });
  return value;
}

function loadScriptIntoContext(relPath, context){
  const script = read(relPath);
  vm.runInContext(script, context, { filename: relPath });
}

function createHarness(){
  const translations = makeTranslations();
  const translationsByLanguage = {
    de: { ...translations, ...makeGermanTranslations() }
  };
  const storageState = { shareBlockLang: "default" };
  const composeState = {
    detailsByTab: new Map(),
    setCalls: []
  };
  const context = {
    console,
    URL,
    DOMParser: FakeDOMParser,
    setTimeout,
    clearTimeout,
    window: null,
    global: null,
    globalThis: null,
    NCShareTemplateContract: undefined,
    NCTalkTextUtils: { escapeHtml },
    NCI18n: {
      translate: (key, substitutions = []) => translate(translations, key, substitutions)
    },
    NCI18nOverride: {
      normalizeLanguageOverride: (value, options = {}) => {
        const normalized = String(value || "").trim().toLowerCase();
        if (!normalized){
          return "default";
        }
        if (normalized === "custom" && options.allowCustom){
          return "custom";
        }
        return normalized;
      },
      tInLang: async (lang, key, substitutions = []) => translate(
        translationsByLanguage[String(lang || "").trim().toLowerCase()] || translations,
        key,
        substitutions
      )
    },
    NCHtmlSanitizer: {
      sanitizeShareTemplateHtml,
      htmlToPlainText,
      plainTextToHtml
    },
    browser: {
      i18n: {
        getMessage: (key, substitutions = []) => translate(translations, key, substitutions)
      },
      storage: {
        local: {
          get: async (keys) => {
            const response = {};
            const requested = Array.isArray(keys) ? keys : Object.keys(keys || {});
            requested.forEach((key) => {
              if (Object.prototype.hasOwnProperty.call(storageState, key)){
                response[key] = storageState[key];
              }
            });
            return response;
          }
        }
      },
      compose: {
        getComposeDetails: async (tabId) => {
          return composeState.detailsByTab.get(Number(tabId)) || {
            isPlainText: false,
            deliveryFormat: "html",
            body: "",
            plainTextBody: ""
          };
        },
        setComposeDetails: async (tabId, details) => {
          composeState.setCalls.push({ tabId: Number(tabId), details });
          const current = composeState.detailsByTab.get(Number(tabId)) || {};
          composeState.detailsByTab.set(Number(tabId), { ...current, ...details });
        }
      }
    },
    bgI18n: (key) => translate(translations, key),
    L: () => {}
  };
  context.window = context;
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  loadScriptIntoContext("modules/shareTemplateContract.js", context);
  loadScriptIntoContext("modules/ncSharing.js", context);
  loadScriptIntoContext("modules/bgComposeShareInsert.js", context);
  return { context, storageState, composeState, translations };
}

async function buildPermissionsHtml(permissions, translationOverrides = {}){
  const { context, storageState, translations } = createHarness();
  Object.assign(translations, translationOverrides);
  storageState.shareBlockLang = "custom";
  return context.NCSharing.buildHtmlBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "",
    permissions
  }, {
    permissions,
    policyShare: {
      share_html_block_template_v2: "{RIGHTS}"
    }
  });
}

async function testPermissionsHtmlContract(){
  const defaultLabels = ["Read", "Upload", "Modify", "Delete"];
  const cases = [
    {
      name: "read-only Rights HTML",
      permissions: { read: true, create: false, write: false, delete: false },
      labels: defaultLabels,
      translations: {}
    },
    {
      name: "all-enabled Rights HTML",
      permissions: { read: true, create: true, write: true, delete: true },
      labels: defaultLabels,
      translations: {}
    },
    {
      name: "all-disabled Rights HTML",
      permissions: { read: false, create: false, write: false, delete: false },
      labels: defaultLabels,
      translations: {}
    },
    {
      name: "mixed Rights HTML",
      permissions: { read: false, create: true, write: false, delete: true },
      labels: defaultLabels,
      translations: {}
    },
    {
      name: "long translated Rights HTML",
      permissions: { read: true, create: false, write: true, delete: false },
      labels: [
        "Leseberechtigung für sehr lange Übersetzung",
        "Hochladen und neue Dateien erstellen",
        "Vorhandene Dokumente vollständig bearbeiten",
        "Freigegebene Inhalte dauerhaft löschen"
      ],
      translations: {
        sharing_permission_read: "Leseberechtigung für sehr lange Übersetzung",
        sharing_permission_create: "Hochladen und neue Dateien erstellen",
        sharing_permission_write: "Vorhandene Dokumente vollständig bearbeiten",
        sharing_permission_delete: "Freigegebene Inhalte dauerhaft löschen"
      }
    },
    {
      name: "escaped Rights HTML",
      permissions: { read: true, create: false, write: false, delete: true },
      labels: ["Read & <inspect>", "Upload", "Modify", "Delete"],
      translations: {
        sharing_permission_read: "Read & <inspect>"
      }
    }
  ];

  for (const testCase of cases){
    const html = await buildPermissionsHtml(testCase.permissions, testCase.translations);
    const enabledStates = [
      !!testCase.permissions.read,
      !!testCase.permissions.create,
      !!testCase.permissions.write,
      !!testCase.permissions.delete
    ];
    assertPermissionsHtmlContract(testCase.name, html, testCase.labels, enabledStates);
  }
}

async function testPermissionsCrossSanitizerBoundary(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  let sanitizerInput = "";
  context.NCHtmlSanitizer.sanitizeShareTemplateHtml = (html) => {
    sanitizerInput = String(html || "");
    return sanitizeShareTemplateHtml(sanitizerInput);
  };

  const html = await context.NCSharing.buildHtmlBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "",
    permissions: { read: true, create: false, write: true, delete: false }
  }, {
    permissions: { read: true, create: false, write: true, delete: false },
    policyShare: {
      share_html_block_template_v2: "<div>{RIGHTS}</div>"
    }
  });

  assert(sanitizerInput.includes('<table role="presentation"'), "Custom-template Rights HTML must reach the sanitizer after placeholder replacement");
  assert(sanitizerInput.includes('nowrap="nowrap"'), "Custom-template Rights HTML must carry its no-wrap compatibility attributes into the sanitizer");
  assert(html.includes('nowrap="nowrap"'), "The configured sanitizer boundary must preserve Rights no-wrap attributes");
}

async function testBuiltInNoBreakValues(){
  const { context } = createHarness();
  const html = await context.NCSharing.buildHtmlBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "2026-05-01",
    permissions: { read: true, create: false, write: false, delete: false }
  }, {
    permissions: { read: true, create: false, write: false, delete: false }
  });

  assert(
    html.includes('<nobr style="white-space: nowrap;">Nextcloud&nbsp;link</nobr>'),
    "Built-in link label must remain one visual token"
  );
  assert(
    html.includes('<nobr style="white-space: nowrap;">2026&#8209;05&#8209;01</nobr>'),
    "Built-in expiration date must remain one visual token"
  );
}

async function testCustomTemplateValuesStayAttributeSafe(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const html = await context.NCSharing.buildHtmlBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "2026-05-01",
    permissions: { read: true, create: false, write: false, delete: false }
  }, {
    permissions: { read: true, create: false, write: false, delete: false },
    policyShare: {
      share_html_block_template_v2: '<time datetime="{EXPIRATIONDATE}">{EXPIRATIONDATE}</time><span title="{LINK_LABEL}">{LINK_LABEL}</span>'
    }
  });

  assert(html.includes('datetime="2026-05-01"'), "Custom-template expiration date must remain valid in attributes");
  assert(html.includes('title="Nextcloud link"'), "Custom-template link label must remain valid in attributes");
  assert(!html.includes("<nobr"), "Generic custom-template replacements must stay context-neutral");
}

function testTransparentHeaderAssetContract(){
  const asset = fs.readFileSync(path.join(ROOT, "ui", "assets", "header-transparent-164x48.png"));
  const sha256 = crypto.createHash("sha256").update(asset).digest("hex").toUpperCase();
  assert(sha256 === "311203D7DDE3501D630D5EB756D40F04789183EB09D2645EBC6617EBD2C85947", "Mail header must use the reviewed transparent branding asset");
  assert(asset.subarray(1, 4).toString("ascii") === "PNG", "Mail header asset must be a PNG");
  assert(asset.readUInt32BE(16) === 164 && asset.readUInt32BE(20) === 48, "Mail header asset must remain 164x48 pixels");
  assert(asset[25] === 6, "Mail header PNG must carry an alpha channel");
  const sharingSource = read("modules/ncSharing.js");
  assert(sharingSource.includes('loadAssetBase64("ui/assets/header-transparent-164x48.png")'), "Share rendering must embed the transparent mail header asset");
}

async function testLocalPlainTextBuildSkipsSanitizer(){
  const { context } = createHarness();
  let sanitizeCalls = 0;
  context.NCHtmlSanitizer.sanitizeShareTemplateHtml = (html) => {
    sanitizeCalls += 1;
    return sanitizeShareTemplateHtml(html);
  };
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "Secret123",
    expireDate: "2026-05-01",
    permissions: { read: true, create: false, write: true, delete: false }
  }, {
    noteEnabled: true,
    note: "Please review the files.",
    permissions: { read: true, create: false, write: true, delete: false }
  });

  assert(sanitizeCalls === 0, "Local plaintext build must not invoke backend sanitizer");
  assert(plainText.includes("Nextcloud link: https://cloud.example/s/abc123"), "Local plaintext build must label the normal share-page URL as a Nextcloud link");
  assert(plainText.includes("Password: Secret123"), "Local plaintext build must include password field");
  assert(plainText.includes(RIGHTS_SEGMENT_START), "Local plaintext build must preserve explicit rights markers for final insertion");
}

async function testCustomTemplatePrunesEmptyPasswordAndSanitizes(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "Secret123",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  }, {
    hidePassword: true,
    showPasswordSeparateHint: false,
    permissions: { read: true, create: false, write: false, delete: false },
    policyShare: {
      share_html_block_template: "<div>Download: {URL}</div><p>Password: {PASSWORD}</p><div>{RIGHTS}</div><script>alert(1)</script>"
    }
  });

  assert(plainText.includes("Download: https://cloud.example/s/abc123"), "Custom plaintext build must include replaced URL");
  assert(!plainText.includes("Password:"), "Empty PASSWORD placeholder should prune its wrapper");
  assert(!plainText.includes("alert(1)"), "Custom plaintext build must sanitize backend template content");
}

async function testCustomTemplateUsesSeparatePasswordHint(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "Secret123",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  }, {
    hidePassword: true,
    showPasswordSeparateHint: true,
    permissions: { read: true, create: false, write: false, delete: false },
    policyShare: {
      share_html_block_template: "<p>Password info: {PASSWORD}</p>"
    }
  });

  assert(plainText.includes("Password info: Password will be sent in a separate email."), "Custom plaintext build must inject separate password hint when configured");
}

async function testBackendEffectiveLanguageLocalizesCustomTemplateCopy(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const shareInfo = {
    shareUrl: "https://cloud.example/s/abc123",
    password: "Secret123",
    expireDate: "2026-05-01",
    permissions: { read: true, create: true, write: true, delete: true }
  };
  const policyShare = {
    language_share_html_block: "custom",
    share_html_block_effective_language: "de",
    share_html_block_template_v2: "<p>{LINK_INTRO}</p><p>{LINK_LABEL}: {URL}</p><p>{PASSWORD}</p><p>{RIGHTS}</p>"
  };
  const request = {
    hidePassword: true,
    showPasswordSeparateHint: true,
    permissions: shareInfo.permissions,
    policyShare
  };

  const html = await context.NCSharing.buildHtmlBlock(shareInfo, request);
  const plainText = await context.NCSharing.buildPlainTextBlock(shareInfo, request);

  for (const output of [html, plainText]){
    assert(output.includes("Öffnen Sie den untenstehenden Nextcloud-Link"), "Backend template language must localize LINK_INTRO");
    assert(output.includes("Nextcloud-Link"), "Backend template language must localize LINK_LABEL");
    assert(output.includes("Das Passwort wird in einer separaten E-Mail gesendet."), "Backend template language must localize the separate-password hint");
    assert(output.includes("Lesen") && output.includes("Hochladen") && output.includes("Bearbeiten") && output.includes("Löschen"), "Backend template language must localize permission names");
  }
}

async function testEditableShareLanguageUsesLocalOverride(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "de";
  const shareInfo = {
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  };
  const request = {
    hidePermissions: true,
    policyShare: {
      language_share_html_block: "custom",
      share_html_block_template_v2: "<p>BACKEND-MARKER {URL}</p>"
    },
    policyEditableShare: {
      language_share_html_block: true
    }
  };

  const html = await context.NCSharing.buildHtmlBlock(shareInfo, request);
  const plainText = await context.NCSharing.buildPlainTextBlock(shareInfo, request);
  assert(!html.includes("BACKEND-MARKER") && !plainText.includes("BACKEND-MARKER"), "Editable Share language must let a stored local language bypass the backend template mode");
  assert(html.includes("Öffnen Sie den untenstehenden Nextcloud-Link"), "Editable Share language should render the local German HTML copy");
  assert(plainText.includes("Öffnen Sie den untenstehenden Nextcloud-Link"), "Editable Share language should render the local German plaintext copy");
}

async function testEditableShareLanguageWithoutLocalUsesBackendDefault(){
  const { context, storageState } = createHarness();
  delete storageState.shareBlockLang;
  const request = {
    hidePermissions: true,
    policyShare: {
      language_share_html_block: "custom",
      share_html_block_template_v2: "<p>BACKEND-MARKER {URL}</p>"
    },
    policyEditableShare: {
      language_share_html_block: true
    }
  };
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  }, request);
  assert(plainText.includes("BACKEND-MARKER"), "Editable Share language without a local value must use the backend default");
}

async function testLockedShareLanguageOverridesLocalValue(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "de";
  const request = {
    hidePermissions: true,
    policyShare: {
      language_share_html_block: "custom",
      share_html_block_template_v2: "<p>BACKEND-MARKER {URL}</p>"
    },
    policyEditableShare: {
      language_share_html_block: false
    }
  };
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  }, request);
  assert(plainText.includes("BACKEND-MARKER"), "Locked Share language must override a stored local language");
}

async function testCustomTemplateResolvesModeAwareLinkVariables(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const shareInfo = {
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  };
  const policyShare = {
    share_html_block_template: "<p>Legacy template: {URL}</p>",
    share_html_block_template_v2: "<p>{LINK_INTRO}</p><p>{LINK_LABEL}: {URL}</p>"
  };

  const normalHtml = await context.NCSharing.buildHtmlBlock(shareInfo, {
    hidePermissions: true,
    policyShare
  });
  const zipHtml = await context.NCSharing.buildHtmlBlock(shareInfo, {
    hidePermissions: true,
    zipDownload: true,
    policyShare
  });
  const normal = await context.NCSharing.buildPlainTextBlock(shareInfo, {
    hidePermissions: true,
    policyShare
  });
  const zip = await context.NCSharing.buildPlainTextBlock(shareInfo, {
    hidePermissions: true,
    zipDownload: true,
    policyShare
  });

  assert(normal.includes("Open the Nextcloud link below to view the share."), "Normal custom template must resolve LINK_INTRO for the share page");
  assert(normal.includes("Nextcloud link: https://cloud.example/s/abc123"), "Normal custom template must resolve LINK_LABEL without changing the URL");
  assert(zip.includes("Download the shared files as a ZIP archive"), "Attachment custom template must resolve LINK_INTRO for ZIP mode");
  assert(zip.includes("ZIP download: https://cloud.example/s/abc123/download"), "Attachment custom template must resolve LINK_LABEL and ZIP URL together");
  assert(normalHtml.includes("Open the Nextcloud link below to view the share."), "Normal custom HTML must use the versioned template");
  assert(zipHtml.includes("ZIP download"), "Attachment custom HTML must resolve the versioned template in ZIP mode");
  assert(!normal.includes("Legacy template") && !normalHtml.includes("Legacy template"), "Versioned custom template must take precedence over the compatibility template");
}

async function testOlderBackendModeAwareTemplateStillRenders(){
  const { context, storageState } = createHarness();
  storageState.shareBlockLang = "custom";
  const plainText = await context.NCSharing.buildPlainTextBlock({
    shareUrl: "https://cloud.example/s/abc123",
    password: "",
    expireDate: "",
    permissions: { read: true, create: false, write: false, delete: false }
  }, {
    hidePermissions: true,
    policyShare: {
      share_html_block_template: "<p>{LINK_INTRO}</p><p>{LINK_LABEL}: {URL}</p>"
    }
  });

  assert(plainText.includes("Open the Nextcloud link below to view the share."), "Older backend template field must still resolve LINK_INTRO");
  assert(plainText.includes("Nextcloud link: https://cloud.example/s/abc123"), "Older backend template field must still resolve LINK_LABEL");
}

async function testPlainTextInsertCompactsMarkedRightsSegment(){
  const { context, composeState } = createHarness();
  composeState.detailsByTab.set(7, {
    isPlainText: true,
    deliveryFormat: "plaintext",
    body: "",
    plainTextBody: "Existing body"
  });
  const plainText = [
    "Download link: https://cloud.example/s/abc123",
    `${RIGHTS_SEGMENT_START}Permissions`,
    "[x]",
    "Read",
    "[ ]",
    "Write",
    `${RIGHTS_SEGMENT_END}`
  ].join("\n");

  const mutation = await context.prepareSharingInsertMutation({
    tabId: 7,
    html: "<p>ignored for plaintext compose</p>",
    plainText
  });
  await context.applySharingInsertMutation(mutation);

  assert(composeState.setCalls.length === 1, "Plaintext insert must write compose details exactly once");
  const writtenBody = composeState.setCalls[0].details.plainTextBody;
  assert(writtenBody.includes("Permissions: [x] Read | [ ] Write"), "Marked rights segment must compact to one permission line");
  assert(!writtenBody.includes(RIGHTS_SEGMENT_START), "Final plaintext insert must not leak rights markers");
  assert(/^#{60}/.test(writtenBody), "Plaintext insert must frame the block with separators");
}

async function testInsertRejectsMissingPlainTextVariant(){
  const { context } = createHarness();
  let message = "";
  try{
    await context.prepareSharingInsertMutation({
      tabId: 7,
      html: "<p>share block</p>"
    });
  }catch(error){
    message = error?.message || String(error);
  }
  assert(
    message === "tab/html/plainText missing",
    "Insert mutation must reject a missing plaintext render variant"
  );
}

async function run(){
  testTransparentHeaderAssetContract();
  await testPermissionsHtmlContract();
  await testPermissionsCrossSanitizerBoundary();
  await testBuiltInNoBreakValues();
  await testCustomTemplateValuesStayAttributeSafe();
  await testLocalPlainTextBuildSkipsSanitizer();
  await testCustomTemplatePrunesEmptyPasswordAndSanitizes();
  await testCustomTemplateUsesSeparatePasswordHint();
  await testBackendEffectiveLanguageLocalizesCustomTemplateCopy();
  await testEditableShareLanguageUsesLocalOverride();
  await testEditableShareLanguageWithoutLocalUsesBackendDefault();
  await testLockedShareLanguageOverridesLocalValue();
  await testCustomTemplateResolvesModeAwareLinkVariables();
  await testOlderBackendModeAwareTemplateStillRenders();
  await testPlainTextInsertCompactsMarkedRightsSegment();
  await testInsertRejectsMissingPlainTextVariant();
  console.log("[OK] share-plaintext-contract-check passed");
}

run().catch((error) => {
  console.error("[FAIL] share-plaintext-contract-check", error);
  process.exitCode = 1;
});
