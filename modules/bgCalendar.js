/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Calendar runtime module.
 * Handles ncCalToolbar integration, editor-context flows, and persisted
 * calendar item monitoring/synchronization.
 */

const TALK_DIALOG_POPUP_PATH = "ui/talkDialog.html";

void configureTalkCalendarItemPopup();

async function configureTalkCalendarItemPopup(){
  try{
    if (typeof browser.calendarItemAction?.setPopup !== "function"){
      console.error("[NCBG] calendarItemAction.setPopup missing");
      return;
    }
    // Runtime popup assignment avoids the current upstream experiment bug where
    // manifest default_popup can be resolved twice into a broken nested
    // moz-extension://.../moz-extension://... URL. Move this back to the
    // manifest once upstream handles already expanded popup URLs correctly.
    await browser.calendarItemAction.setPopup({ popup: TALK_DIALOG_POPUP_PATH });
    L("calendar item action popup configured", { popup: TALK_DIALOG_POPUP_PATH });
  }catch(error){
    console.error("[NCBG] calendar item action popup configure failed", error);
  }
}

/**
 * Entry point from the official calendar_item_action button.
 * Click context/snapshot is provided by the ncCalToolbar bridge API.
 */
browser.ncCalToolbar?.onClicked?.addListener((snapshot) => {
  return (async () => {
    try{
      const requestedEditorId = typeof snapshot?.editorId === "string" ? snapshot.editorId.trim() : "";
      if (!requestedEditorId || !/^ed-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestedEditorId)){
        console.error("[NCBG] ncCalToolbar.onClicked missing or invalid editorId");
        return;
      }

      // Fire-and-forget preflight only. The wizard performs its own live status
      // refresh, so Talk button responsiveness must not depend on this request.
      void NCTalkCore.getSystemAddressbookStatus({ forceRefresh: false })
        .then((status) => {
          L("system addressbook check on talk click", {
            available: !!status?.available,
            count: Number.isFinite(status?.count) ? status.count : 0,
            hasError: !!status?.error
          });
        })
        .catch((error) => {
          console.error("[NCBG] system addressbook check on talk click failed", error);
        });

      const contextId = createCalendarWizardContextId();
      const context = setCalendarWizardContext(contextId, {
        source: "ncCalToolbar",
        editorId: requestedEditorId,
        item: {
          id: "",
          calendarId: "",
          type: "event"
        },
        event: {},
        metadata: {}
      });
      mergeCalendarSnapshotIntoWizardContext(context, snapshot);
      refreshCalendarWizardContextSnapshot(context);
      setLatestCalendarWizardPopupContext(contextId);
      L("ncCalToolbar.onClicked", {
        hasEditorId: true,
        hasIcal:
          context.item?.format === "ical" &&
          typeof context.item?.item === "string" &&
          !!context.item.item,
        snapshotSource: context.snapshotSource || "",
        hasLiveStart: typeof context.event?.startTimestamp === "number"
      });
      L("talk wizard popup context prepared", {
        source: "ncCalToolbar",
        contextId,
        editorId: context.editorId || "",
        calendarId: context.item?.calendarId || "",
        itemId: context.item?.id || ""
      });
      void hydrateTalkWizardContextFromEditor(requestedEditorId, contextId);
    }catch(error){
      console.error("[NCBG] ncCalToolbar.onClicked error", error);
    }
  })();
});

async function hydrateTalkWizardContextFromEditor(editorId, contextId){
  try{
    const getCurrentApi = browser.ncCalToolbar?.getCurrent;
    if (typeof getCurrentApi !== "function"){
      console.error("[NCBG] ncCalToolbar.getCurrent missing");
      return false;
    }
    const context = getCalendarWizardContext(contextId);
    if (!context){
      return false;
    }
    const currentSnapshot = await getCurrentApi({
      returnFormat: "ical",
      editorId
    });
    if (!currentSnapshot){
      console.error("[NCBG] ncCalToolbar.onClicked missing snapshot");
      return false;
    }
    mergeCalendarSnapshotIntoWizardContext(context, currentSnapshot);
    refreshCalendarWizardContextSnapshot(context);
    L("ncCalToolbar.onClicked snapshot hydrated", {
      contextId,
      hasIcal:
        context.item?.format === "ical" &&
        typeof context.item?.item === "string" &&
        !!context.item.item,
      snapshotSource: context.snapshotSource || "",
      calendarId: context.item?.calendarId || "",
      itemId: context.item?.id || ""
    });
    return true;
  }catch(error){
    console.error("[NCBG] ncCalToolbar snapshot hydration failed", error);
    return false;
  }
}

/**
 * Lifecycle callback for tracked editor close events from ncCalToolbar.
 */
browser.ncCalToolbar?.onTrackedEditorClosed?.addListener((event) => {
  try{
    handleCalendarItemsEditorClosed(event || {});
  }catch(error){
    console.error("[NCBG] ncCalToolbar.onTrackedEditorClosed handler failed", error);
  }
});

// Calendar event editor integration uses the custom `ncCalToolbar` experiment
// for stable editor context, snapshot, and editor-targeted write-back.

/**
 * Build a standard runtime message error response and log the root cause.
 * @param {string} type
 * @param {any} error
 * @returns {{ok:false,error:string}}
 */

async function applyCalendarLobbyUpdate(payload = {}){
  await BG_STATE_READY;
  const token = payload?.token;
  if (!token){
    return { ok:false, error: bgI18n("error_room_token_missing") };
  }
  const meta = getRoomMeta(token) || {};
  const { raw: currentUserRaw, normalized: currentUser } = await getCanonicalCalendarUserId();
  const delegateIdRaw = (payload?.delegateId ?? meta.delegateId ?? "").trim();
  const delegateTarget = delegateIdRaw.toLowerCase();
  const delegated = payload?.delegated === true || meta.delegated === true;
  const incomingStart = typeof payload?.startTimestamp === "number" ? payload.startTimestamp : null;
  const metaStart = typeof meta.startTimestamp === "number" ? meta.startTimestamp : null;

  L("calendar lobby update payload", {
    token: shortToken(token),
    delegate: delegateTarget ? bgShortId(delegateTarget, 20) : "",
    delegated,
    startTimestamp: incomingStart,
    metaStart
  });

  if (payload?.lobbyEnabled === false || meta.lobbyEnabled === false){
    return { ok:false, skipped:true, reason:"lobbyDisabled" };
  }

  if (delegateTarget && currentUser && delegateTarget !== currentUser){
    if (delegated){
      L("calendar lobby update skipped (delegate mismatch)", {
        token: shortToken(token),
        delegate: delegateIdRaw || meta.delegateId || "",
        currentUser: currentUserRaw || ""
      });
      return { ok:false, skipped:true, reason:"delegateMismatch" };
    }
    L("calendar lobby update by owner before delegation", {
      token: shortToken(token),
      delegate: delegateIdRaw || meta.delegateId || "",
      currentUser: currentUserRaw || ""
    });
  }

  if (typeof incomingStart !== "number"){
    console.error("[NCBG] calendar lobby update blocked: X-NCTALK-START missing/invalid", {
      token: shortToken(token),
      startTimestamp: payload?.startTimestamp
    });
    return { ok:false, skipped:true, reason:"missingOrInvalidXTalkStart" };
  }
  const startTs = incomingStart;
  if (metaStart === startTs){
    L("calendar lobby update skipped (unchanged start)", {
      token: shortToken(token),
      startTimestamp: startTs
    });
    return { ok:true, skipped:true, reason:"startUnchanged" };
  }

  L("calendar lobby update apply", { token: shortToken(token), startTimestamp: startTs });
  await NCTalkCore.updateTalkLobby({
    token,
    enableLobby: true,
    startTimestamp: startTs
  });
  await setRoomMeta(token, {
    lobbyEnabled: true,
    startTimestamp: startTs
  });
  L("calendar lobby update success", { token: shortToken(token), startTimestamp: startTs });
  return { ok:true };
}

/**
 * Delegate moderator role after calendar changes when ready.
 * @param {{token:string,delegateId:string,delegateName?:string}} payload
 * @returns {Promise<{ok:boolean,skipped?:boolean,reason?:string,error?:string,result?:object}>}
 */
async function applyCalendarDelegation(payload = {}){
  await BG_STATE_READY;
  const token = payload?.token;
  const delegateId = payload?.delegateId;
  if (!token || !delegateId){
    return { ok:false, error: bgI18n("error_delegation_data_missing") };
  }
  const { normalized: currentNorm } = await getCanonicalCalendarUserId();
  const targetNorm = String(delegateId).trim().toLowerCase();
  if (targetNorm === currentNorm){
    L("calendar delegation skipped (same user)", { token: shortToken(token), delegate: delegateId });
    return {
      ok:true,
      skipped:true,
      reason:"sameUser",
      result: {
        leftSelf: false,
        shouldLeaveSelf: false,
        delegate: delegateId
      }
    };
  }
  const result = await NCTalkCore.delegateRoomModerator({
    token,
    newModerator: delegateId,
    leaveSelf: false
  });
  return { ok:true, result };
}

function getIcalContractApi(){
  if (
    typeof NCIcalContract === "undefined" ||
    !NCIcalContract ||
    typeof NCIcalContract.parseEventData !== "function" ||
    typeof NCIcalContract.parseEventStartUnixSeconds !== "function" ||
    typeof NCIcalContract.extractEventAttendees !== "function" ||
    typeof NCIcalContract.applyEventPropertyUpdates !== "function"
  ){
    console.error("[NCBG] NCIcalContract API missing");
    return null;
  }
  return NCIcalContract;
}

/**
 * Extract an e-mail address from a calendar address value.
 * @param {string} value
 * @returns {Promise<string>}
 */
async function extractEmailFromCalAddress(value){
  if (!value){
    return "";
  }
  let cleaned = String(value).trim();
  if (!cleaned){
    return "";
  }
  if (cleaned.startsWith("<") && cleaned.endsWith(">") && cleaned.length > 2){
    cleaned = cleaned.slice(1, -1).trim();
  }
  const lower = cleaned.toLowerCase();
  if (lower.startsWith("mailto:")){
    cleaned = cleaned.slice(7).trim();
    const queryPos = cleaned.indexOf("?");
    if (queryPos >= 0){
      cleaned = cleaned.slice(0, queryPos).trim();
    }
    try{
      cleaned = decodeURIComponent(cleaned);
    }catch(error){
      console.error("[NCBG] attendee mailto decode failed", {
        value: String(value).slice(0, 120),
        error: error?.message || String(error)
      });
      return "";
    }
  }
  const messengerUtilities = browser?.messengerUtilities;
  if (!messengerUtilities || typeof messengerUtilities.parseMailboxString !== "function"){
    console.error("[NCBG] messengerUtilities.parseMailboxString unavailable");
    return "";
  }
  const parsed = await messengerUtilities.parseMailboxString(cleaned);
  if (!Array.isArray(parsed) || !parsed.length){
    return "";
  }
  const email = String(parsed[0]?.email || "").trim();
  return email;
}

/**
 * Extract attendee e-mail addresses from the first VEVENT in an iCal payload.
 * @param {string} ical
 * @returns {Promise<string[]>}
 */
async function extractIcalAttendees(ical){
  if (!ical) {
    return [];
  }
  const contract = getIcalContractApi();
  if (!contract){
    return [];
  }
  const entries = contract.extractEventAttendees(ical);
  const seen = new Map();
  for (const entry of entries){
    let valueEmail = "";
    let paramEmail = "";
    try{
      valueEmail = await extractEmailFromCalAddress(entry?.value || "");
      paramEmail = await extractEmailFromCalAddress(entry?.emailParam || "");
    }catch(error){
      console.error("[NCBG] attendee mailbox parse failed", {
        value: String(entry?.value || "").slice(0, 120),
        emailParam: String(entry?.emailParam || "").slice(0, 120),
        error: error?.message || String(error)
      });
    }
    const email = valueEmail || paramEmail;
    if (!email) continue;
    const key = email.toLowerCase();
    if (!seen.has(key)){
      seen.set(key, email);
    }
  }
  return Array.from(seen.values());
}

function isRetryableTalkCalendarError(error){
  const status = Number(error?.status) || 0;
  return status === 0
    || status === 408
    || status === 423
    || status === 429
    || (status >= 500 && status <= 599);
}

function createCalendarRetryableError(message, cause, code){
  const error = new Error(message);
  error.cause = cause;
  error.ncCalendarRetryable = true;
  error.ncCalendarRetryCode = code || "";
  return error;
}

/**
 * Add calendar attendees to a Talk room.
 * @param {{token:string,ical:string,addUsers?:boolean,addGuests?:boolean}} payload
 * @returns {Promise<{ok:boolean,total:number,added:number,failed:number}>}
 */
async function addInviteesToTalkRoom({ token, ical, addUsers = true, addGuests = true } = {}){
  if (!token || !ical){
    return { ok:false, total:0, added:0, failed:0 };
  }
  if (!addUsers && !addGuests){
    L("invitees add skipped (disabled)", { token: shortToken(token) });
    return { ok:true, total:0, added:0, failed:0 };
  }
  const attendees = await extractIcalAttendees(ical);
  if (!attendees.length){
    L("invitees add skipped (no attendees)", { token: shortToken(token) });
    return { ok:true, total:0, added:0, failed:0 };
  }
  let contacts = [];
  try{
    if (typeof NCTalkCore?.getSystemAddressbookContacts !== "function"){
      throw new Error("Talk addressbook API unavailable");
    }
    contacts = await NCTalkCore.getSystemAddressbookContacts(false);
  }catch(error){
    console.error("[NCBG] system addressbook lookup failed", error);
    throw createCalendarRetryableError(
      "Talk participant classification failed because the system addressbook is unavailable",
      error,
      "addressbook"
    );
  }
  const emailToUserId = new Map();
  for (const contact of contacts){
    const emailLower = contact?.emailLower;
    const id = contact?.id;
    if (emailLower && id && !emailToUserId.has(emailLower)){
      emailToUserId.set(emailLower, id);
    }
  }
  let added = 0;
  let failed = 0;
  let retryableFailed = 0;
  let users = 0;
  let emails = 0;
  let skippedUsers = 0;
  let skippedGuests = 0;
  for (const email of attendees){
    const lower = email.toLowerCase();
    const userId = emailToUserId.get(lower) || "";
    const source = userId ? "users" : "emails";
    const actorId = userId || email;
    if (userId){
      users += 1;
      if (!addUsers){
        skippedUsers += 1;
        continue;
      }
    }else{
      emails += 1;
      if (!addGuests){
        skippedGuests += 1;
        continue;
      }
    }
    try{
      await NCTalkCore.addTalkParticipant({ token, actorId, source });
      added += 1;
    }catch(error){
      failed += 1;
      if (isRetryableTalkCalendarError(error)){
        retryableFailed += 1;
      }
      console.error("[NCBG] add participant failed", {
        actor: actorId,
        source,
        error: error?.message || String(error)
      });
    }
  }
  L("invitees add result", {
    token: shortToken(token),
    total: attendees.length,
    addUsers,
    addGuests,
    users,
    emails,
    skippedUsers,
    skippedGuests,
    added,
    failed
  });
  return {
    ok: failed === 0,
    total: attendees.length,
    added,
    failed,
    retryableFailed
  };
}

function parseBooleanProp(value){
  if (typeof value === "boolean") return value;
  if (typeof value === "string"){
    const norm = value.trim().toLowerCase();
    if (norm === "true" || norm === "1" || norm === "yes") return true;
    if (norm === "false" || norm === "0" || norm === "no") return false;
  }
  return null;
}

function parseNumberProp(value){
  if (typeof value === "number" && Number.isFinite(value)){
    return value;
  }
  if (typeof value === "string"){
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function parseIcalEventData(ical){
  const contract = getIcalContractApi();
  if (!contract){
    return { props: {}, dtStart: null, dtEnd: null };
  }
  return contract.parseEventData(ical);
}

/**
 * Parse VEVENT DTSTART into unix epoch seconds through the shared parser.
 * Uses explicit timezone resolution only (IANA + mapped Windows TZIDs).
 * If DTSTART cannot be resolved, return null (fail-closed).
 * @param {string} ical
 * @returns {number|null}
 */
function parseEventStartUnixSeconds(ical){
  const contract = getIcalContractApi();
  if (!contract){
    return null;
  }
  return contract.parseEventStartUnixSeconds(ical);
}

/**
 * Extract Talk token/url only from X-NCTALK-* properties.
 * LOCATION/URL are deliberately ignored: generic calendar links must never
 * grant NC Connector ownership over an existing Talk room.
 * @param {object} props
 * @returns {{token:string,url:string}|null}
 */
function extractTalkLinkFromProps(props){
  const propToken = typeof props["X-NCTALK-TOKEN"] === "string" ? props["X-NCTALK-TOKEN"].trim() : "";
  if (propToken){
    const propUrl = typeof props["X-NCTALK-URL"] === "string" ? props["X-NCTALK-URL"].trim() : "";
    return {
      token: propToken,
      url: propUrl || ""
    };
  }
  return null;
}

/**
 * Parse Talk metadata from an iCal VEVENT payload.
 * @param {string} ical
 * @returns {object}
 */
function extractTalkMetadataFromIcal(ical){
  const { props } = parseIcalEventData(ical);
  const link = extractTalkLinkFromProps(props) || {};
  const startProp = parseNumberProp(props["X-NCTALK-START"]);
  const delegateReadyRaw = props["X-NCTALK-DELEGATE-READY"];
  const addParticipantsLegacy = parseBooleanProp(props["X-NCTALK-ADD-PARTICIPANTS"]);
  const hasAddUsers = Object.prototype.hasOwnProperty.call(props, "X-NCTALK-ADD-USERS");
  const hasAddGuests = Object.prototype.hasOwnProperty.call(props, "X-NCTALK-ADD-GUESTS");
  let addUsers = parseBooleanProp(props["X-NCTALK-ADD-USERS"]);
  let addGuests = parseBooleanProp(props["X-NCTALK-ADD-GUESTS"]);
  if (!hasAddUsers && !hasAddGuests && addParticipantsLegacy != null){
    addUsers = addParticipantsLegacy;
    addGuests = addParticipantsLegacy;
  }
  return {
    token: link.token || "",
    url: link.url || "",
    title: props["SUMMARY"] || "",
    lobbyEnabled: parseBooleanProp(props["X-NCTALK-LOBBY"]),
    startTimestamp: startProp,
    eventConversation: (() => {
      const raw = props["X-NCTALK-EVENT"];
      if (!raw) return null;
      return raw.trim().toLowerCase() === "event";
    })(),
    objectId: props["X-NCTALK-OBJECTID"] || "",
    addUsers,
    addGuests,
    delegateId: props["X-NCTALK-DELEGATE"] || "",
    delegateName: props["X-NCTALK-DELEGATE-NAME"] || "",
    delegated: parseBooleanProp(props["X-NCTALK-DELEGATED"]),
    delegateReady: parseBooleanProp(delegateReadyRaw)
  };
}

/**
 * Apply property updates to the first VEVENT in an iCal payload.
 * @param {string} ical
 * @param {Object<string,string|null>} updates
 * @returns {{ical:string,changed:boolean}}
 */
function applyIcalPropertyUpdates(ical, updates){
  const contract = getIcalContractApi();
  if (!contract){
    return { ical, changed: false };
  }
  return contract.applyEventPropertyUpdates(ical, updates);
}

async function updateCalendarItemProps(item, updates){
  if (!item || item.format !== "ical" || !item.item){
    return false;
  }
  const { ical, changed } = applyIcalPropertyUpdates(item.item, updates);
  if (!changed){
    return false;
  }
  try{
    await browser.calendar.items.update(item.calendarId, item.id, {
      format: "ical",
      item: ical,
      returnFormat: "ical"
    });
    return true;
  }catch(error){
    console.error("[NCBG] calendar item update failed", error);
    return false;
  }
}

/**
 * Handle calendar item creates/updates and keep Talk room state in sync.
 * @param {object} item
 * @returns {Promise<void>}
 */
async function handleCalendarItemUpsert(item){
  try{
    await BG_STATE_READY;
    if (!item || item.type !== "event"){
      return;
    }
    const icalPayload = String(item.item || "");
    let meta = extractTalkMetadataFromIcal(icalPayload);
    if (!meta?.token){
      const mapped = getEventTokenEntry(item.calendarId, item.id);
      const mappedToken = String(mapped?.token || "").trim();
      L("calendar upsert skipped (token missing)", {
        calendarId: item.calendarId || "",
        itemId: item.id || "",
        hasMapping: !!mappedToken,
        mappingSource: mapped?.source || ""
      });
      return;
    }
    // Only a calendar event carrying the connector token proves that the
    // editor contents were accepted and stored by Thunderbird.
    removeRoomCleanupEntry(meta.token, "calendar_item_persisted");
    await setEventTokenEntry(item.calendarId, item.id, {
      token: meta.token,
      url: meta.url,
      source: "x-nctalk"
    });
    const persistedMeta = getRoomMeta(meta.token) || {};
    if (meta.lobbyEnabled == null && typeof persistedMeta.lobbyEnabled === "boolean"){
      meta.lobbyEnabled = persistedMeta.lobbyEnabled;
    }
    if (typeof meta.startTimestamp !== "number" && typeof persistedMeta.startTimestamp === "number"){
      meta.startTimestamp = persistedMeta.startTimestamp;
    }
    if (!meta.delegateId && persistedMeta.delegateId){
      meta.delegateId = String(persistedMeta.delegateId);
    }
    if (!meta.delegateName && persistedMeta.delegateName){
      meta.delegateName = String(persistedMeta.delegateName);
    }
    if (meta.delegated == null && typeof persistedMeta.delegated === "boolean"){
      meta.delegated = persistedMeta.delegated;
    }
    const startFromEvent = parseEventStartUnixSeconds(icalPayload);
    if (typeof startFromEvent === "number" && Number.isFinite(startFromEvent)){
      if (meta.startTimestamp !== startFromEvent){
        const synced = await updateCalendarItemProps(item, { "X-NCTALK-START": String(startFromEvent) });
        if (!synced){
          console.error("[NCBG] calendar contract start sync failed", {
            token: shortToken(meta.token),
            from: meta.startTimestamp,
            to: startFromEvent
          });
          return;
        }
        L("calendar contract start synced", {
          token: shortToken(meta.token),
          from: meta.startTimestamp,
          to: startFromEvent
        });
        // Stop this cycle. The follow-up onUpdated from the X-NCTALK-START write
        // is the single path for lobby update and room-meta update.
        return;
      }
      meta.startTimestamp = startFromEvent;
    }else{
      console.error("[NCBG] calendar contract start parse failed", {
        token: shortToken(meta.token)
      });
      // Keep the stored X-NCTALK-START value from metadata when DTSTART
      // cannot be parsed (for example unsupported external TZIDs from other clients).
      if (!(typeof meta.startTimestamp === "number" && Number.isFinite(meta.startTimestamp))){
        meta.startTimestamp = null;
      }
    }
    if (meta.lobbyEnabled !== false){
      if (typeof meta.startTimestamp === "number"){
        await applyCalendarLobbyUpdate({
          token: meta.token,
          startTimestamp: meta.startTimestamp,
          delegateId: meta.delegateId || "",
          delegated: meta.delegated === true,
          lobbyEnabled: meta.lobbyEnabled
        });
      }else{
        console.error("[NCBG] calendar lobby update skipped: X-NCTALK-START missing/invalid", {
          token: shortToken(meta.token),
          startTimestamp: meta.startTimestamp
        });
      }
    }

    const updates = {};
    if (meta.lobbyEnabled != null){
      updates.lobbyEnabled = meta.lobbyEnabled;
    }
    if (meta.eventConversation != null){
      updates.eventConversation = meta.eventConversation;
    }
    if (typeof meta.startTimestamp === "number"){
      updates.startTimestamp = meta.startTimestamp;
    }
    if (meta.delegateId){
      updates.delegateId = meta.delegateId;
      updates.delegateName = meta.delegateName || meta.delegateId;
    }
    if (meta.delegated != null){
      updates.delegated = meta.delegated;
    }
    if (Object.keys(updates).length){
      await setRoomMeta(meta.token, updates);
    }

    if (meta.addUsers === true || meta.addGuests === true){
      try{
        let canSync = true;
        const delegateIdRaw = (meta.delegateId || "").trim();
        if (meta.delegated === true && delegateIdRaw){
          const { raw: currentUserRaw, normalized: currentUser } = await getCanonicalCalendarUserId();
          const delegateId = delegateIdRaw.toLowerCase();
          if (currentUser && delegateId && currentUser !== delegateId){
            // After delegation the current user may no longer moderate the room.
            // Skip participant sync instead of touching another moderator's room.
            canSync = false;
            L("invitee sync skipped (delegate mismatch)", {
              token: shortToken(meta.token),
              delegate: meta.delegateId || "",
              currentUser: currentUserRaw || ""
            });
          }
        }
        if (canSync){
          const inviteeResult = await addInviteesToTalkRoom({
            token: meta.token,
            ical: icalPayload,
            addUsers: meta.addUsers === true,
            addGuests: meta.addGuests === true
          });
          if (!inviteeResult.ok){
            const message =
              `Talk invitee synchronization failed for ${inviteeResult.failed} participant(s)`;
            if (inviteeResult.retryableFailed > 0){
              throw createCalendarRetryableError(message, null, "talk_participant");
            }
            throw new Error(message);
          }
        }
      }catch(error){
        console.error("[NCBG] add invitees failed", error);
        throw error;
      }
    }

    if (meta.delegateId && meta.delegated !== true){
      if (meta.delegateReady === true){
        try{
          const result = await applyCalendarDelegation({
            token: meta.token,
            delegateId: meta.delegateId,
            delegateName: meta.delegateName || meta.delegateId
          });
          if (result?.ok){
            const currentDepartureMeta = getRoomMeta(meta.token) || {};
            const shouldLeaveSelf = result.result?.shouldLeaveSelf === true;
            const departureGeneration =
              (Number(currentDepartureMeta.departureRetryGeneration) || 0) + 1;
            await setRoomMeta(meta.token, {
              delegateId: meta.delegateId,
              delegateName: meta.delegateName || meta.delegateId,
              departurePrepared: true,
              departureShouldLeaveSelf: shouldLeaveSelf,
              departurePending: false,
              departureRetryGeneration: departureGeneration,
              departureRetryAttempts: 0,
              departureNextAttemptAt: 0,
              departureRetryExhausted: false,
              departureCompleted: false,
              departureCalendarId: String(item.calendarId || ""),
              departureItemId: String(item.id || "")
            });
            const localUpdated = await updateCalendarItemProps(item, {
              "X-NCTALK-DELEGATED": "TRUE",
              "X-NCTALK-DELEGATE-READY": null
            });
            if (!localUpdated){
              console.error("[NCBG] calendar delegation retained owner: local event update failed", {
                token: shortToken(meta.token)
              });
              throw createCalendarRetryableError(
                "Calendar delegation write-back failed.",
                null,
                "calendar_writeback"
              );
            }
            await activatePreparedCalendarDeparture({
              token: meta.token,
              generation: departureGeneration,
              shouldLeaveSelf
            });
          }
        }catch(error){
          console.error("[NCBG] calendar delegation failed", error);
          if (error?.ncCalendarRetryable === true){
            throw error;
          }
          if (isRetryableTalkCalendarError(error)){
            throw createCalendarRetryableError(
              error?.message || "Calendar delegation failed.",
              error,
              "talk_delegation"
            );
          }
        }
      }else{
        L("calendar delegation pending (delegate-ready missing/false)", {
          token: shortToken(meta.token),
          delegate: meta.delegateId || ""
        });
      }
    }else if (meta.delegated === true && meta.delegateId){
      if (persistedMeta.departurePending === true){
        ensureCalendarDepartureRetry(meta.token);
      }else if (persistedMeta.departurePrepared === true){
        await activatePreparedCalendarDeparture({
          token: meta.token,
          generation: Math.max(
            0,
            Number(persistedMeta.departureRetryGeneration) || 0
          ),
          shouldLeaveSelf: persistedMeta.departureShouldLeaveSelf === true
        });
      }
    }
  }catch(error){
    console.error("[NCBG] calendar item upsert failed", error);
    throw error;
  }
}

/**
 * Resolve whether deleting an existing saved calendar event may also delete
 * the linked Talk room. Unsaved-editor cleanup is handled separately and stays
 * active so newly created but discarded rooms do not leak.
 * @returns {Promise<boolean>}
 */
async function isSavedEventRoomDeleteEnabled(){
  let localEnabled = false;
  let hasLocalValue = false;
  try{
    const stored = await browser.storage.local.get(["talkDeleteRoomOnEventDelete"]);
    hasLocalValue = typeof stored.talkDeleteRoomOnEventDelete === "boolean";
    localEnabled = hasLocalValue ? stored.talkDeleteRoomOnEventDelete : false;
  }catch(error){
    console.error("[NCBG] talk delete-room option read failed", error);
  }

  try{
    const status = await NCPolicyRuntime.getPolicyStatus();
    return NCPolicyState.resolveDefaultValue(
      status,
      "talk",
      "talk_delete_room_on_event_delete",
      localEnabled,
      hasLocalValue,
      NCPolicyState.coerceBoolean
    );
  }catch(error){
    console.error("[NCBG] talk delete-room policy check failed", error);
  }
  return localEnabled;
}

/**
 * Handle calendar item deletion and remove the Talk room only for trusted
 * NC Connector events when the saved-event cleanup opt-in is enabled.
 * @param {string} calendarId
 * @param {string} id
 * @returns {Promise<void>}
 */
async function handleCalendarItemRemoved(calendarId, id){
  try{
    await BG_STATE_READY;
    const entry = getEventTokenEntry(calendarId, id);
    if (!entry?.token){
      return;
    }
    if (!isTrustedEventTokenEntry(entry)){
      L("calendar item removed: skip room delete (untrusted token mapping)", {
        calendarId,
        itemId: id
      });
      await removeEventTokenEntry(calendarId, id);
      return;
    }
    if (!(await isSavedEventRoomDeleteEnabled())){
      L("calendar item removed: room delete disabled", {
        token: shortToken(entry.token)
      });
      await removeEventTokenEntry(calendarId, id);
      return;
    }
    const token = entry.token;
    if (hasTrustedEventTokenReferenceExcept(token, calendarId, id)){
      await removeEventTokenEntry(calendarId, id);
      L("calendar item removed: room retained by another event mapping", {
        token: shortToken(token),
        calendarId,
        itemId: id
      });
      return;
    }
    const meta = getRoomMeta(token) || {};
    const delegateIdRaw = typeof meta.delegateId === "string" ? meta.delegateId.trim() : "";
    if (meta.delegated === true && delegateIdRaw){
      try{
        const { raw: currentUserRaw, normalized: currentUser } = await getCanonicalCalendarUserId();
        const delegateId = delegateIdRaw.toLowerCase();
        if (!currentUser){
          throw new Error("Canonical Nextcloud user id is unavailable.");
        }
        if (delegateId && currentUser !== delegateId){
          await removeEventTokenEntry(calendarId, id);
          L("calendar item removed: skip room delete (delegated)", {
            token: shortToken(token),
            delegate: delegateIdRaw,
            currentUser: currentUserRaw || ""
          });
          await deleteRoomMeta(token);
          return;
        }
      }catch(error){
        console.error("[NCBG] delegated room ownership check failed", error);
        throw createCalendarRetryableError(
          "Delegated room ownership could not be verified.",
          error,
          "room_delete_owner"
        );
      }
    }
    // Persist the deletion intent before dropping the only durable link from
    // the calendar item to its Talk token. If storage rejects the write, the
    // operation queue can retry with the original mapping still intact.
    await armTalkRoomDeleteRetry({
      token,
      reason: "saved_event_removed",
      delayMs: ROOM_CLEANUP_DELETE_DELAY_MS,
      calendarId,
      itemId: id
    });
    await removeEventTokenEntry(calendarId, id);
  }catch(error){
    console.error("[NCBG] calendar item removed handler failed", error);
    if (error?.ncCalendarRetryable === true){
      throw error;
    }
    if (isRetryableTalkCalendarError(error)){
      throw createCalendarRetryableError(
        error?.message || "Calendar item removal cleanup failed.",
        error,
        "room_delete_schedule"
      );
    }
    throw error;
  }
}

const CALENDAR_OPERATION_QUEUE = [];
const CALENDAR_PENDING_OPERATION_BY_EVENT_KEY = new Map();
const CALENDAR_OPERATION_RETRY_BY_KEY = new Map();
const CALENDAR_EVENT_GENERATION_BY_KEY = new Map();
const CALENDAR_OPERATION_RETRY_DELAYS_MS = [2000, 5000, 10000];
let CALENDAR_OPERATION_QUEUE_RUNNING = false;

function makeCalendarOperationKey(kind, calendarId, itemId){
  const eventKey = makeEventMapKey(calendarId, itemId);
  return eventKey ? `${kind}:${eventKey}` : "";
}

function bumpCalendarEventGeneration(eventKey){
  if (!eventKey){
    return 0;
  }
  const generation = (Number(CALENDAR_EVENT_GENERATION_BY_KEY.get(eventKey)) || 0) + 1;
  CALENDAR_EVENT_GENERATION_BY_KEY.set(eventKey, generation);
  return generation;
}

function isCurrentCalendarEventGeneration(eventKey, generation){
  return !!eventKey
    && Number(generation) > 0
    && CALENDAR_EVENT_GENERATION_BY_KEY.get(eventKey) === generation;
}

function cancelCalendarOperationRetry(eventKey, reason){
  const retry = eventKey ? CALENDAR_OPERATION_RETRY_BY_KEY.get(eventKey) : null;
  if (!retry){
    return;
  }
  clearTimeout(retry.timerId);
  CALENDAR_OPERATION_RETRY_BY_KEY.delete(eventKey);
  L("calendar operation retry canceled", {
    kind: retry.kind || "",
    key: retry.key || eventKey,
    reason: reason || ""
  });
}

function scheduleCalendarOperationRetry(entry, error){
  if (
    !entry.eventKey
    || !isCurrentCalendarEventGeneration(entry.eventKey, entry.generation)
    || CALENDAR_PENDING_OPERATION_BY_EVENT_KEY.has(entry.eventKey)
  ){
    return false;
  }
  const attempt = (Number(entry.retryAttempt) || 0) + 1;
  if (attempt > CALENDAR_OPERATION_RETRY_DELAYS_MS.length){
    L("calendar operation retries exhausted", {
      kind: entry.kind,
      key: entry.key,
      attempts: attempt - 1,
      code: error?.ncCalendarRetryCode || ""
    });
    return false;
  }
  cancelCalendarOperationRetry(entry.eventKey, "reschedule");
  const delayMs = CALENDAR_OPERATION_RETRY_DELAYS_MS[attempt - 1];
  const timerId = setTimeout(() => {
    CALENDAR_OPERATION_RETRY_BY_KEY.delete(entry.eventKey);
    if (!isCurrentCalendarEventGeneration(entry.eventKey, entry.generation)){
      L("calendar operation retry skipped (superseded)", {
        kind: entry.kind,
        key: entry.key,
        generation: entry.generation
      });
      return;
    }
    void enqueueCalendarOperation(entry.kind, entry.payload, {
      isRetry: true,
      retryAttempt: attempt,
      generation: entry.generation
    }).catch((retryError) => {
      console.error("[NCBG] calendar operation retry failed", retryError);
    });
  }, delayMs);
  CALENDAR_OPERATION_RETRY_BY_KEY.set(entry.eventKey, {
    timerId,
    attempt,
    kind: entry.kind,
    payload: entry.payload,
    key: entry.key,
    generation: entry.generation
  });
  L("calendar operation retry scheduled", {
    kind: entry.kind,
    key: entry.key,
    attempt,
    delayMs,
    code: error?.ncCalendarRetryCode || ""
  });
  return true;
}

function enqueueCalendarOperation(kind, payload, options = {}){
  const calendarId = payload?.calendarId;
  const itemId = payload?.id;
  const eventKey = makeEventMapKey(calendarId, itemId);
  const key = makeCalendarOperationKey(kind, calendarId, itemId);
  const isRetry = options.isRetry === true;
  const generation = isRetry
    ? Number(options.generation) || 0
    : bumpCalendarEventGeneration(eventKey);
  if (isRetry && !isCurrentCalendarEventGeneration(eventKey, generation)){
    L("calendar operation retry ignored (superseded)", {
      kind,
      calendarId,
      itemId,
      generation
    });
    return Promise.resolve();
  }
  if (!isRetry){
    cancelCalendarOperationRetry(
      eventKey,
      kind === "remove" ? "item_removed" : "newer_upsert"
    );
  }
  return new Promise((resolve, reject) => {
    const pending = eventKey
      ? CALENDAR_PENDING_OPERATION_BY_EVENT_KEY.get(eventKey)
      : null;
    if (pending?.kind === kind){
      pending.payload = payload;
      pending.generation = generation;
      if (!isRetry){
        pending.retryAttempt = 0;
      }
      pending.waiters.push({ resolve, reject });
      L("calendar operation coalesced", { kind, calendarId, itemId });
      return;
    }
    const entry = {
      kind,
      key,
      eventKey,
      generation,
      payload,
      retryAttempt: Number(options.retryAttempt) || 0,
      waiters: [{ resolve, reject }]
    };
    CALENDAR_OPERATION_QUEUE.push(entry);
    if (eventKey){
      CALENDAR_PENDING_OPERATION_BY_EVENT_KEY.set(eventKey, entry);
    }
    void drainCalendarOperationQueue();
  });
}

async function drainCalendarOperationQueue(){
  if (CALENDAR_OPERATION_QUEUE_RUNNING){
    return;
  }
  CALENDAR_OPERATION_QUEUE_RUNNING = true;
  try{
    while (CALENDAR_OPERATION_QUEUE.length){
      const entry = CALENDAR_OPERATION_QUEUE.shift();
      if (
        entry.eventKey
        && CALENDAR_PENDING_OPERATION_BY_EVENT_KEY.get(entry.eventKey) === entry
      ){
        CALENDAR_PENDING_OPERATION_BY_EVENT_KEY.delete(entry.eventKey);
      }
      try{
        if (entry.kind === "upsert"){
          await handleCalendarItemUpsert(entry.payload);
        }else{
          await handleCalendarItemRemoved(entry.payload.calendarId, entry.payload.id);
        }
        entry.waiters.forEach(({ resolve }) => resolve());
      }catch(error){
        if (error?.ncCalendarRetryable === true){
          scheduleCalendarOperationRetry(entry, error);
        }
        entry.waiters.forEach(({ reject }) => reject(error));
      }
    }
  }finally{
    CALENDAR_OPERATION_QUEUE_RUNNING = false;
  }
}

function queueCalendarItemUpsert(item){
  return enqueueCalendarOperation("upsert", item || {});
}

function queueCalendarItemRemoved(calendarId, id){
  return enqueueCalendarOperation("remove", { calendarId, id });
}

/**
 * Register calendar experiment listeners for event lifecycle changes.
 */
function startCalendarMonitor(){
  if (!browser?.calendar?.items?.onCreated){
    console.warn("[NCBG] calendar experiment not available");
    return;
  }
  browser.calendar.items.onCreated.addListener(queueCalendarItemUpsert, { returnFormat: "ical" });
  browser.calendar.items.onUpdated.addListener(queueCalendarItemUpsert, { returnFormat: "ical" });
  browser.calendar.items.onRemoved.addListener(queueCalendarItemRemoved);
}

// *** IMPORTANT: initialize calendar monitor on startup ***
/**
 * Register persisted calendar item monitoring once at background startup.
 */
try{
  startCalendarMonitor();
  void BG_STATE_READY
    .then(() => Promise.all([
      resumeTalkRoomDeleteRetries(),
      resumeCalendarDepartureRetries()
    ]))
    .catch((error) => console.error("[NCBG] calendar retry init failed", error));
}catch(error){
  console.error("[NCBG] calendar monitor init error", error);
}
