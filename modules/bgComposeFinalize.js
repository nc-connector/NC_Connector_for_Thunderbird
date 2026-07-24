/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
'use strict';
/**
 * Background-owned sharing finalize transaction.
 * Send is blocked only while cleanup ownership, optional password dispatch,
 * and the compose block/header mutation are staged.
 */

const COMPOSE_FINALIZE_TIMEOUT_MS = 30000;
const COMPOSE_FINALIZE_BY_TAB = new Map();
const COMPOSE_FINALIZE_BY_WIZARD_WINDOW = new Map();

function isComposeFinalizeTransactionActive(tabId){
  const transaction = COMPOSE_FINALIZE_BY_TAB.get(Number(tabId));
  return !!transaction && !transaction.committed;
}

function clearComposeFinalizeTransaction(transaction, reason = ""){
  if (!transaction){
    return;
  }
  if (transaction.timeoutId){
    clearTimeout(transaction.timeoutId);
    transaction.timeoutId = null;
  }
  if (COMPOSE_FINALIZE_BY_TAB.get(transaction.tabId) === transaction){
    COMPOSE_FINALIZE_BY_TAB.delete(transaction.tabId);
  }
  if (COMPOSE_FINALIZE_BY_WIZARD_WINDOW.get(transaction.wizardWindowId) === transaction){
    COMPOSE_FINALIZE_BY_WIZARD_WINDOW.delete(transaction.wizardWindowId);
  }
  if (transaction.resolveSettled){
    transaction.resolveSettled({
      committed: transaction.committed === true,
      failed: transaction.failed === true,
      reason: reason || ""
    });
    transaction.resolveSettled = null;
  }
  L("sharing finalize transaction released", {
    transactionId: bgShortId(transaction.transactionId, 24),
    tabId: transaction.tabId,
    windowId: transaction.wizardWindowId,
    reason: reason || ""
  });
}

function beginComposeFinalizeTransaction(tabId, wizardWindowId){
  if (!Number.isInteger(tabId) || tabId <= 0){
    throw new Error("invalid_tab_id");
  }
  if (!Number.isInteger(wizardWindowId) || wizardWindowId <= 0){
    throw new Error("invalid_window_id");
  }
  if (COMPOSE_FINALIZE_BY_TAB.has(tabId)
    || COMPOSE_FINALIZE_BY_WIZARD_WINDOW.has(wizardWindowId)){
    throw new Error("sharing_finalize_already_running");
  }
  let resolveSettled;
  const settledPromise = new Promise((resolve) => {
    resolveSettled = resolve;
  });
  const transaction = {
    transactionId: createSecureRuntimeId(),
    tabId,
    wizardWindowId,
    cleanupMutation: null,
    passwordRegistration: null,
    insertMutation: null,
    draftGroupId: "",
    abortRequested: false,
    committed: false,
    rollbackPromise: null,
    timeoutId: null,
    pendingStage: null,
    failed: false,
    settledPromise,
    resolveSettled
  };
  COMPOSE_FINALIZE_BY_TAB.set(tabId, transaction);
  COMPOSE_FINALIZE_BY_WIZARD_WINDOW.set(wizardWindowId, transaction);
  transaction.timeoutId = setTimeout(() => {
    void rollbackComposeFinalizeTransaction(transaction, "transaction_timeout");
  }, COMPOSE_FINALIZE_TIMEOUT_MS);
  L("sharing finalize transaction started", {
    transactionId: bgShortId(transaction.transactionId, 24),
    tabId,
    windowId: wizardWindowId
  });
  return transaction;
}

function captureComposeFinalizeSaveSnapshot(tabId){
  const transaction = COMPOSE_FINALIZE_BY_TAB.get(Number(tabId));
  if (!transaction){
    return {
      active: false,
      insertApplied: false,
      transaction: null
    };
  }
  return {
    active: true,
    insertApplied: transaction.insertMutation?.applied === true,
    transaction
  };
}

async function resolveComposeFinalizeSaveSnapshot(snapshot){
  if (!snapshot?.active || !snapshot.transaction){
    return { active: false, committed: false };
  }
  await snapshot.transaction.settledPromise;
  return {
    active: true,
    committed: snapshot.transaction.committed === true,
    draftGroupId: snapshot.transaction.draftGroupId
  };
}

function throwIfComposeFinalizeAborted(transaction){
  if (transaction?.abortRequested){
    throw new Error("sharing_finalize_aborted");
  }
}

async function runComposeFinalizeStage(transaction, name, operation, assign){
  throwIfComposeFinalizeAborted(transaction);
  const promise = Promise.resolve()
    .then(operation)
    .then((result) => {
      assign(result);
      return result;
    });
  const pendingStage = { name, promise };
  transaction.pendingStage = pendingStage;
  try{
    const result = await promise;
    throwIfComposeFinalizeAborted(transaction);
    return result;
  }finally{
    if (transaction.pendingStage === pendingStage){
      transaction.pendingStage = null;
    }
  }
}

function rollbackComposeFinalizeTransaction(transaction, reason = ""){
  if (!transaction || transaction.committed){
    return Promise.resolve(false);
  }
  if (transaction.rollbackPromise){
    return transaction.rollbackPromise;
  }
  transaction.abortRequested = true;
  if (transaction.cleanupMutation){
    rollbackComposeShareCleanupArm(transaction.cleanupMutation, reason);
  }
  transaction.rollbackPromise = (async () => {
    let rollbackComplete = true;
    if (transaction.pendingStage?.promise){
      try{
        await transaction.pendingStage.promise;
      }catch(error){
        L("sharing finalize pending stage rejected during rollback", {
          transactionId: bgShortId(transaction.transactionId, 24),
          stage: transaction.pendingStage?.name || "",
          error: error?.message || String(error)
        });
      }
    }
    if (transaction.cleanupMutation){
      rollbackComplete = rollbackComposeShareCleanupArm(
        transaction.cleanupMutation,
        reason
      ) || COMPOSE_SHARE_CLEANUP_BY_TAB.get(transaction.tabId) !== transaction.cleanupMutation.stagedState;
    }
    if (transaction.insertMutation?.attempted){
      rollbackComplete = await rollbackSharingInsertMutation(
        transaction.insertMutation
      ) && rollbackComplete;
    }
    if (transaction.passwordRegistration
      && transaction.passwordRegistration.duplicate !== true){
      const removed = unregisterSeparatePasswordMailDispatch(
        transaction.tabId,
        transaction.passwordRegistration.registrationId,
        reason || "finalize_rollback"
      );
      rollbackComplete = removed && rollbackComplete;
    }
    if (transaction.cleanupMutation?.persistenceTransition){
      try{
        await restorePersistentWizardCleanupOwnership(transaction.cleanupMutation);
      }catch(error){
        rollbackComplete = false;
        console.error("[NCBG] sharing finalize persistent cleanup rollback failed", {
          transactionId: bgShortId(transaction.transactionId, 24),
          error: error?.message || String(error)
        });
      }
    }
    if (!rollbackComplete && transaction.draftGroupId){
      const retainedState = COMPOSE_SHARE_CLEANUP_BY_TAB.get(transaction.tabId);
      if (retainedState?.draftGroupId === transaction.draftGroupId){
        retainedState.lifecycleTainted = true;
      }
      try{
        await markPersistentShareCleanupTainted(transaction.draftGroupId);
      }catch(error){
        console.error("[NCBG] sharing finalize taint persistence failed", {
          transactionId: bgShortId(transaction.transactionId, 24),
          error: error?.message || String(error)
        });
      }
    }
    if (rollbackComplete){
      clearComposeFinalizeTransaction(transaction, reason || "rollback");
    }else{
      transaction.failed = true;
      if (transaction.timeoutId){
        clearTimeout(transaction.timeoutId);
        transaction.timeoutId = null;
      }
    }
    L("sharing finalize transaction rolled back", {
      transactionId: bgShortId(transaction.transactionId, 24),
      tabId: transaction.tabId,
      windowId: transaction.wizardWindowId,
      reason: reason || "",
      rollbackComplete
    });
    return rollbackComplete;
  })();
  return transaction.rollbackPromise;
}

function commitComposeFinalizeTransaction(transaction){
  if (!transaction
    || COMPOSE_FINALIZE_BY_TAB.get(transaction.tabId) !== transaction
    || COMPOSE_FINALIZE_BY_WIZARD_WINDOW.get(transaction.wizardWindowId) !== transaction
    || transaction.abortRequested){
    throw new Error("sharing_finalize_commit_invalid");
  }
  if (!completeComposeShareCleanupArm(transaction.cleanupMutation, "finalize_commit")){
    throw new Error("sharing_finalize_cleanup_transfer_failed");
  }
  transaction.committed = true;
  clearComposeFinalizeTransaction(transaction, "commit");
}

function rollbackComposeFinalizeForTab(tabId, reason = ""){
  const transaction = COMPOSE_FINALIZE_BY_TAB.get(Number(tabId));
  if (!transaction){
    return Promise.resolve(false);
  }
  return rollbackComposeFinalizeTransaction(transaction, reason || "tab_closed")
    .finally(() => {
      clearComposeFinalizeTransaction(transaction, reason || "tab_closed");
    });
}

function rollbackComposeFinalizeForWizardWindow(windowId, reason = ""){
  const transaction = COMPOSE_FINALIZE_BY_WIZARD_WINDOW.get(Number(windowId));
  if (!transaction){
    return Promise.resolve(false);
  }
  return rollbackComposeFinalizeTransaction(transaction, reason || "wizard_closed");
}

async function handleSharingFinalizeTransaction(payload = {}){
  const tabId = Number(payload.tabId);
  const wizardWindowId = Number(payload.wizardWindowId);
  const cleanup = payload.cleanup && typeof payload.cleanup === "object"
    ? payload.cleanup
    : null;
  const passwordDispatch = payload.passwordDispatch
    && typeof payload.passwordDispatch === "object"
    ? payload.passwordDispatch
    : null;
  if (!Number.isInteger(tabId)
    || tabId <= 0
    || !Number.isInteger(wizardWindowId)
    || wizardWindowId <= 0
    || !cleanup){
    return {
      ok: false,
      error: bgI18n("sharing_error_insert_failed"),
      canRetry: true
    };
  }

  let policyStatus = null;
  if (passwordDispatch){
    policyStatus = await NCPolicyRuntime.getPolicyStatus();
    if (!NCPolicyState.hasSeatEntitlement(policyStatus)){
      return { ok: false, error: bgI18n("sharing_error_insert_failed") };
    }
  }

  let transaction = null;
  try{
    transaction = beginComposeFinalizeTransaction(tabId, wizardWindowId);
    await runComposeFinalizeStage(
      transaction,
      "resolve_draft_group",
      () => resolveSharingInsertDraftGroupId(tabId),
      (draftGroupId) => {
        transaction.draftGroupId = draftGroupId;
      }
    );

    await runComposeFinalizeStage(
      transaction,
      "stage_cleanup",
      () => armComposeShareCleanup(
        tabId,
        {
          ...cleanup,
          wizardWindowId,
          draftGroupId: transaction.draftGroupId
        },
        {
          draftGroupId: transaction.draftGroupId,
          persist: true,
          transferWizardOwnership: false
        }
      ),
      (mutation) => {
        transaction.cleanupMutation = mutation;
      },
    );

    if (passwordDispatch){
      await runComposeFinalizeStage(
        transaction,
        "stage_password_dispatch",
        () => registerSeparatePasswordMailDispatch(
          tabId,
          passwordDispatch,
          { policyStatus }
        ),
        (registration) => {
          transaction.passwordRegistration = registration;
        }
      );
      await runComposeFinalizeStage(
        transaction,
        "stage_password_handoff",
        async () => {
          const marked = await setComposeSharePasswordHandoffState(
            tabId,
            true,
            false,
            "finalize_password_dispatch_staged"
          );
          if (!marked){
            throw new Error("compose_password_handoff_record_missing");
          }
          return true;
        },
        () => {}
      );
    }

    await runComposeFinalizeStage(
      transaction,
      "insert_block",
      async () => {
        const mutation = await prepareSharingInsertMutation(
          {
            tabId,
            html: payload.html,
            plainText: payload.plainText
          },
          {
            addDraftMarker: true,
            draftGroupId: transaction.draftGroupId
          }
        );
        throwIfComposeFinalizeAborted(transaction);
        transaction.insertMutation = mutation;
        await applySharingInsertMutation(mutation);
        return mutation;
      },
      (mutation) => {
        transaction.insertMutation = mutation;
      }
    );
    commitComposeFinalizeTransaction(transaction);
    return {
      ok: true,
      transactionId: transaction.transactionId,
      draftGroupId: transaction.draftGroupId,
      passwordDispatchDuplicate: transaction.passwordRegistration?.duplicate === true
    };
  }catch(error){
    let rollbackComplete = true;
    if (transaction){
      rollbackComplete = await rollbackComposeFinalizeTransaction(
        transaction,
        error?.message || "finalize_failed"
      );
    }
    globalThis.NCLogContext?.safeConsoleError?.(
      "[NCBG]",
      "sharing finalize transaction failed",
      error,
      {
        tabId,
        windowId: wizardWindowId,
        rollbackComplete
      }
    );
    return {
      ok: false,
      error: bgI18n("sharing_error_insert_failed"),
      canRetry: rollbackComplete
    };
  }
}
