/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Recipient parsing and sender identity resolution for password follow-up mail.
 */

/**
 * Normalize compose recipients for beginNew/sendMessage.
 * Accepts string addresses and contact/list references (`id`/`nodeId` + `type`).
 * @param {any} value
 * @returns {Array<string|{type:string,id?:string,nodeId?:string}>}
 */
function normalizeComposeRecipientList(value){
  if (value == null){
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const entry of raw){
    if (typeof entry === "string"){
      const trimmed = entry.trim();
      if (trimmed){
        out.push(trimmed);
      }
      continue;
    }
    if (!entry || typeof entry !== "object"){
      continue;
    }
    const type = String(entry.type || "").trim();
    if (!type){
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id){
      out.push({ type, id });
      continue;
    }
    const nodeId = typeof entry.nodeId === "string" ? entry.nodeId.trim() : "";
    if (nodeId){
      out.push({ type, nodeId });
    }
  }
  return out;
}
function composeRecipientKey(recipient){
  if (typeof recipient === "string"){
    const value = recipient.trim().toLowerCase();
    return value ? `addr:${value}` : "";
  }
  if (!recipient || typeof recipient !== "object"){
    return "";
  }
  const type = String(recipient.type || "").trim().toLowerCase();
  const id = String(recipient.id || "").trim();
  const nodeId = String(recipient.nodeId || "").trim();
  if (type && id){
    return `${type}:id:${id}`;
  }
  if (type && nodeId){
    return `${type}:node:${nodeId}`;
  }
  return "";
}

function countUniquePasswordDispatchRecipients(queue){
  const keys = new Set();
  for (const dispatch of queue){
    const groups = [dispatch?.to, dispatch?.cc, dispatch?.bcc];
    for (const group of groups){
      if (!Array.isArray(group)){
        continue;
      }
      for (const recipient of group){
        const key = composeRecipientKey(recipient);
        if (key){
          keys.add(key);
        }
      }
    }
  }
  return keys.size;
}

function normalizeMailboxEmail(value){
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

function collectParsedMailboxEmails(parsed, target = []){
  for (const mailbox of Array.isArray(parsed) ? parsed : []){
    const email = normalizeMailboxEmail(mailbox?.email || "");
    if (email){
      target.push(email);
    }
    if (Array.isArray(mailbox?.group)){
      collectParsedMailboxEmails(mailbox.group, target);
    }
  }
  return target;
}

async function parseComposeMailboxEmails(value){
  const raw = String(value || "").trim();
  if (!raw){
    return [];
  }
  const messengerUtilities = browser?.messengerUtilities;
  if (!messengerUtilities || typeof messengerUtilities.parseMailboxString !== "function"){
    throw new Error("messenger_utilities_mailbox_parser_unavailable");
  }
  const parsed = await messengerUtilities.parseMailboxString(raw);
  return collectParsedMailboxEmails(parsed);
}

/**
 * Parse the sender mailbox of one compose `from` string.
 * @param {string} value
 * @returns {Promise<string>}
 */
async function extractComposeMailboxEmail(value){
  const raw = String(value || "").trim();
  if (!raw){
    return "";
  }
  try{
    const emails = await parseComposeMailboxEmails(raw);
    if (emails.length){
      return emails[0];
    }
  }catch(error){
    console.error("[NCBG] compose sender mailbox parse failed", {
      value: raw.slice(0, 160),
      error: error?.message || String(error)
    });
  }
  return "";
}

async function buildComposeRecipientValueSet(value){
  const recipients = normalizeComposeRecipientList(value);
  const keys = new Set();
  for (const recipient of recipients){
    if (typeof recipient === "string"){
      const emails = await parseComposeMailboxEmails(recipient);
      if (!emails.length){
        throw new Error("password_mail_recipient_parse_failed");
      }
      for (const email of emails){
        keys.add(`addr:${email}`);
      }
      continue;
    }
    const key = composeRecipientKey(recipient);
    if (!key){
      throw new Error("password_mail_recipient_reference_invalid");
    }
    keys.add(key);
  }
  return keys;
}

async function buildComposeRecipientEnvelope(details = {}){
  const [to, cc, bcc] = await Promise.all([
    buildComposeRecipientValueSet(details?.to),
    buildComposeRecipientValueSet(details?.cc),
    buildComposeRecipientValueSet(details?.bcc)
  ]);
  return {
    to,
    cc,
    bcc,
    count: to.size + cc.size + bcc.size
  };
}

function composeRecipientValueSetsMatch(expected, actual){
  if (!(expected instanceof Set) || !(actual instanceof Set) || expected.size !== actual.size){
    return false;
  }
  for (const key of expected){
    if (!actual.has(key)){
      return false;
    }
  }
  return true;
}

function composeRecipientEnvelopesMatch(expected, actual){
  return composeRecipientValueSetsMatch(expected?.to, actual?.to)
    && composeRecipientValueSetsMatch(expected?.cc, actual?.cc)
    && composeRecipientValueSetsMatch(expected?.bcc, actual?.bcc);
}

function normalizeComposeIdentityRecord(identity, accountId = ""){
  if (!identity || typeof identity !== "object"){
    return null;
  }
  const id = String(identity.id || "").trim();
  const email = normalizeMailboxEmail(identity.email || "");
  if (!id || !email){
    return null;
  }
  return {
    id,
    email,
    accountId: String(identity.accountId || accountId || "").trim(),
    name: String(identity.name || "").trim(),
    label: String(identity.label || "").trim()
  };
}

async function listComposeSenderIdentityRecords(){
  const identityApi = browser?.identities;
  if (identityApi && typeof identityApi.list === "function"){
    try{
      const identities = await identityApi.list();
      return (Array.isArray(identities) ? identities : [])
        .map((identity) => normalizeComposeIdentityRecord(identity))
        .filter(Boolean);
    }catch(error){
      console.error("[NCBG] identities.list failed", {
        error: error?.message || String(error)
      });
    }
  }
  const accountApi = browser?.accounts;
  if (accountApi && typeof accountApi.list === "function"){
    try{
      const accounts = await accountApi.list(false);
      const identities = [];
      for (const account of Array.isArray(accounts) ? accounts : []){
        for (const identity of Array.isArray(account?.identities) ? account.identities : []){
          const normalized = normalizeComposeIdentityRecord(identity, String(account?.id || "").trim());
          if (normalized){
            identities.push(normalized);
          }
        }
      }
      return identities;
    }catch(error){
      console.error("[NCBG] accounts.list failed", {
        error: error?.message || String(error)
      });
    }
  }
  return [];
}

/**
 * Ensure one dispatch has a real Thunderbird identity id for auto-send.
 * @param {object} dispatch
 * @returns {Promise<{identityId:string,fromEmail:string,reason:string,matchCount:number}>}
 */
async function ensureSeparatePasswordDispatchIdentity(dispatch){
  const currentIdentityId = String(dispatch?.identityId || "").trim();
  if (currentIdentityId){
    if (!dispatch.fromEmail){
      dispatch.fromEmail = await extractComposeMailboxEmail(dispatch?.from || "");
    }
    return {
      identityId: currentIdentityId,
      fromEmail: String(dispatch?.fromEmail || "").trim(),
      reason: "identity_present",
      matchCount: 1
    };
  }
  const from = String(dispatch?.from || "").trim();
  if (!from){
    return {
      identityId: "",
      fromEmail: "",
      reason: "from_missing",
      matchCount: 0
    };
  }
  const fromEmail = String(dispatch?.fromEmail || "").trim().toLowerCase()
    || await extractComposeMailboxEmail(from);
  dispatch.fromEmail = fromEmail;
  if (!fromEmail){
    return {
      identityId: "",
      fromEmail: "",
      reason: "sender_email_missing",
      matchCount: 0
    };
  }
  const identities = await listComposeSenderIdentityRecords();
  const matches = identities.filter((identity) => identity.email === fromEmail);
  if (matches.length === 1){
    dispatch.identityId = matches[0].id;
    return {
      identityId: dispatch.identityId,
      fromEmail,
      reason: "resolved_from_sender_email",
      matchCount: 1
    };
  }
  return {
    identityId: "",
    fromEmail,
    reason: matches.length > 1 ? "identity_ambiguous" : "identity_not_found",
    matchCount: matches.length
  };
}
