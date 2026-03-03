/**
 * Contract checks for iCal/vCard parser behavior used by NC Connector.
 *
 * Run:
 *   node tools/ical-contract-check.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
global.ICAL = require(path.join(ROOT, "vendor", "ical.js"));
const contract = require(path.join(ROOT, "modules", "icalContract.js"));

/**
 * Read a fixture file as UTF-8 text.
 * @param {string} name
 * @returns {string}
 */
function fixture(name){
  return fs.readFileSync(path.join(ROOT, "tests", "fixtures", name), "utf8");
}

/**
 * Minimal assertion helper.
 * @param {boolean} condition
 * @param {string} message
 */
function assert(condition, message){
  if (!condition){
    throw new Error(message);
  }
}

function run(){
  const thunderbirdIcal = fixture("thunderbird-event.ics");
  const thunderbirdData = contract.parseEventData(thunderbirdIcal);
  assert(thunderbirdData.props.SUMMARY === "TB Meeting", "TB summary mismatch");
  assert(thunderbirdData.props["X-NCTALK-TOKEN"] === "tbtoken123", "TB token mismatch");
  assert(thunderbirdData.dtStart && thunderbirdData.dtStart.value === "20260225T100000", "TB DTSTART mismatch");

  const outlookIcal = fixture("outlook-event.ics");
  const attendees = contract.extractEventAttendees(outlookIcal);
  assert(attendees.length === 2, "Outlook attendee count mismatch");
  assert(attendees[0].value.toLowerCase().includes("mailto:alpha@example.com"), "Outlook attendee value mismatch");
  assert(attendees[1].emailParam === "beta@example.com", "Outlook EMAIL param mismatch");

  const nextcloudIcal = fixture("nextcloud-event.ics");
  const updateResult = contract.applyEventPropertyUpdates(nextcloudIcal, {
    DESCRIPTION: "Updated Description",
    "X-NCTALK-URL": "https://cloud.example/call/newtoken789",
    "X-UNSET": null
  });
  assert(updateResult.changed === true, "Expected changed=true for iCal update");
  const updatedData = contract.parseEventData(updateResult.ical);
  assert(updatedData.props.DESCRIPTION === "Updated Description", "Updated DESCRIPTION mismatch");
  assert(updatedData.props["X-NCTALK-URL"] === "https://cloud.example/call/newtoken789", "Updated URL mismatch");
  assert(updatedData.props["X-CUSTOM-EXTRA"] === "Keep me", "Unknown custom property must be preserved");
  assert(!Object.prototype.hasOwnProperty.call(updatedData.props, "X-UNSET"), "X-UNSET should be removed");

  const noChangeResult = contract.applyEventPropertyUpdates(updateResult.ical, {
    DESCRIPTION: "Updated Description"
  });
  assert(noChangeResult.changed === false, "Expected changed=false when value is identical");

  const cardExport = fixture("system-addressbook.vcf");
  const cards = contract.parseVcardComponents(cardExport);
  assert(cards.length === 2, "vCard component count mismatch");
  const firstUid = contract.stringifyValue(cards[0].getFirstPropertyValue("uid"));
  const secondUid = contract.stringifyValue(cards[1].getFirstPropertyValue("uid"));
  assert(firstUid === "user-1", "First vCard UID mismatch");
  assert(secondUid === "user-2", "Second vCard UID mismatch");

  console.log("[OK] ical-contract-check passed");
}

run();
