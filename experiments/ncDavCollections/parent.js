/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
"use strict";

var {
  ExtensionCommon: { ExtensionAPI },
} = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var {
  ExtensionUtils: { ExtensionError },
} = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
var { CardDAVDirectory } = ChromeUtils.importESModule("resource:///modules/CardDAVDirectory.sys.mjs");

// Thunderbird defaults to 30 minutes.
const REFRESH_INTERVAL_MINUTES = 5;

/**
 * Require a non-empty string argument.
 * @param {*} value
 * @param {string} field
 * @returns {string}
 */
function requireText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new ExtensionError(`${field} is required`);
  }
  return text;
}

/**
 * Require an https collection URL.
 * @param {*} value
 * @returns {nsIURI}
 */
function requireHttpsUri(value) {
  const uri = Services.io.newURI(requireText(value, "url"));
  if (uri.scheme !== "https") {
    throw new ExtensionError("url must use https");
  }
  return uri;
}

/**
 * Accept only https origins without path, matching channel.URI.prePath.
 * @param {*} value
 * @returns {string}
 */
function requireHttpsOrigin(value) {
  const uri = Services.io.newURI(requireText(value, "origin"));
  if (uri.scheme !== "https" || uri.prePath !== value) {
    throw new ExtensionError("origin must be an https origin without path");
  }
  return uri.prePath;
}

/**
 * Resolve a CardDAV directory by UID.
 * @param {string} id
 * @returns {nsIAbDirectory|null}
 */
function getCardDavDirectory(id) {
  const directory = id ? MailServices.ab.getDirectoryFromUID(id) : null;
  return directory?.dirType === Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE ? directory : null;
}

this.ncDavCollections = class extends ExtensionAPI {
  /**
   * Expose the CalDAV/CardDAV setup steps of Thunderbird's own creation
   * dialogs. Synchronization stays with Thunderbird's providers.
   * @returns {object}
   */
  getAPI() {
    return {
      ncDavCollections: {
        /**
         * The DAV providers search the login manager by channel prePath and
         * the server's HTTP-auth realm before they prompt.
         * @param {{origin:string,realm:string,username:string,password:string}} login
         */
        async saveLogin(login) {
          const origin = requireHttpsOrigin(login?.origin);
          const realm = requireText(login?.realm, "realm");
          const username = requireText(login?.username, "username");
          const password = typeof login?.password === "string" ? login.password : "";
          if (!password) {
            throw new ExtensionError("password is required");
          }
          const loginInfo = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
          loginInfo.init(origin, null, realm, username, password, "", "");
          const existing = await Services.logins.searchLoginsAsync({ origin, httpRealm: realm });
          const match = existing.find((entry) => entry.username === username);
          if (!match) {
            await Services.logins.addLoginAsync(loginInfo);
          } else if (match.password !== password) {
            // A new Login Flow app password replaces the stale one in place.
            // ESR 140 only has modifyLogin; later releases only modifyLoginAsync.
            if (typeof Services.logins.modifyLoginAsync === "function") {
              await Services.logins.modifyLoginAsync(match, loginInfo);
            } else {
              Services.logins.modifyLogin(match, loginInfo);
            }
          }
        },

        /**
         * Mirror the network branch of Thunderbird's calendar creation dialog.
         * @param {{url:string,name:string,username:string,color?:string,readOnly?:boolean}} properties
         * @returns {Promise<string>}
         */
        async createCalendar(properties) {
          const uri = requireHttpsUri(properties?.url);
          const calendar = cal.manager.createCalendar("caldav", uri);
          if (!calendar) {
            throw new ExtensionError("Calendar type caldav is unknown");
          }
          calendar.name = requireText(properties.name, "name");
          calendar.setProperty("username", requireText(properties.username, "username"));
          calendar.setProperty("cache.enabled", true);
          calendar.setProperty("refreshInterval", String(REFRESH_INTERVAL_MINUTES));
          if (typeof properties.color === "string" && properties.color) {
            calendar.setProperty("color", properties.color);
          }
          if (properties.readOnly === true) {
            calendar.setProperty("readOnly", true);
          }
          cal.manager.registerCalendar(calendar);
          return calendar.id;
        },

        async listAddressBooks() {
          return MailServices.ab.directories
            .filter((directory) => directory.dirType === Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE)
            .map((directory) => ({
              id: directory.UID,
              url: directory.getStringValue("carddav.url", ""),
              name: directory.dirName,
            }));
        },

        /**
         * Mirror the creation step of Thunderbird's CardDAV dialog.
         * @param {{url:string,name:string,username:string,readOnly?:boolean}} properties
         * @returns {Promise<string>}
         */
        async createAddressBook(properties) {
          const uri = requireHttpsUri(properties?.url);
          const dirPrefId = MailServices.ab.newAddressBook(
            requireText(properties.name, "name"),
            null,
            Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE,
            null
          );
          const book = MailServices.ab.getDirectoryFromId(dirPrefId);
          book.setStringValue("carddav.url", uri.spec);
          book.setStringValue("carddav.username", requireText(properties.username, "username"));
          book.setIntValue("carddav.syncinterval", REFRESH_INTERVAL_MINUTES);
          if (properties.readOnly === true) {
            book.setBoolValue("readOnly", true);
          }
          CardDAVDirectory.forFile(book.fileName)?.fetchAllFromServer().catch(console.error);
          return book.UID;
        },

        async renameAddressBook(id, name) {
          const directory = getCardDavDirectory(id);
          if (!directory) {
            throw new ExtensionError(`Invalid address book id: ${id}`);
          }
          directory.dirName = requireText(name, "name");
        },

        async removeAddressBook(id) {
          const directory = getCardDavDirectory(id);
          if (directory) {
            MailServices.ab.deleteAddressBook(directory.URI);
          }
        },
      },
    };
  }
};
