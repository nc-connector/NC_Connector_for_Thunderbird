/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  /**
   * Reserves and moves a unique FileLink share root without overwriting existing folders.
   */
  async function reserveRoot({
    davRoot,
    candidates,
    authHeader,
    signal,
    log,
    collisionMessage
  } = {}){
    const createCollisionError = () => {
      const message = collisionMessage || "Share folder already exists";
      const error = new Error(message);
      error.ncUserMessage = message;
      return error;
    };
    const list = Array.isArray(candidates) ? candidates : [];
    if (!list.length){
      throw createCollisionError();
    }
    const relativeBase = list[0]?.folderInfo?.relativeBase || "";
    const reservationPath = NCNextcloudDav.joinPath(
      relativeBase,
      `_${NCNextcloudDav.createFileLinkId()}`
    );
    const reservationUrl = NCNextcloudDav.buildFileUrl(davRoot, reservationPath);
    let reservationPresent = true;
    let attemptedTargetUrl = "";
    let attemptedCandidate = null;
    let reservationFailure = null;
    let recoveredRootCleanupError = null;
    try{
      try{
        await NCNextcloudDav.createCollection({
          url: reservationUrl,
          authHeader,
          signal,
          log,
          operation: "share_root_reservation",
          allowExisting: true
        });
      }catch(error){
        if (signal?.aborted || error?.name === "AbortError"){
          throw error;
        }
        const probe = await NCNextcloudDav.probePath({
          url: reservationUrl,
          authHeader,
          signal,
          log
        });
        if (!probe.exists || !probe.collection){
          throw error;
        }
      }

      for (const candidate of list){
        NCNextcloudDav.throwIfAborted(signal);
        attemptedCandidate = candidate;
        const targetUrl = NCNextcloudDav.buildFileUrl(
          davRoot,
          candidate.folderInfo.relativeFolder
        );
        attemptedTargetUrl = targetUrl;
        const moved = await moveRootReservation({
          reservationUrl,
          targetUrl,
          authHeader,
          signal,
          log
        });
        if (moved){
          reservationPresent = false;
          return candidate;
        }
      }
      throw createCollisionError();
    }catch(error){
      reservationFailure = error;
      throw error;
    }finally{
      if (reservationPresent){
        if (attemptedTargetUrl){
          const cleanupController = new AbortController();
          const cleanupTimer = setTimeout(
            () => cleanupController.abort(),
            NCNextcloudDav.CLEANUP_TIMEOUT_MS
          );
          try{
            const [sourceResult, targetResult] = await Promise.allSettled([
              NCNextcloudDav.probePath({
                url: reservationUrl,
                authHeader,
                signal: cleanupController.signal,
                log
              }),
              NCNextcloudDav.probePath({
                url: attemptedTargetUrl,
                authHeader,
                signal: cleanupController.signal,
                log
              })
            ]);
            if (sourceResult.status !== "fulfilled"
              || targetResult.status !== "fulfilled"){
              throw sourceResult.reason || targetResult.reason;
            }
            const source = sourceResult.value;
            const target = targetResult.value;
            if (!source.exists && target.exists){
              reservationPresent = false;
              const cleaned = await NCNextcloudDav.deleteBestEffort({
                url: attemptedTargetUrl,
                authHeader,
                log,
                scope: "Moved share root cleanup failed"
              });
              if (!cleaned && attemptedCandidate){
                const cleanupError = NCNextcloudDav.createTechnicalError(
                  "Moved share root could not be cleaned"
                );
                cleanupError.cause = reservationFailure;
                cleanupError.ncRecoveredRootCandidate = attemptedCandidate;
                recoveredRootCleanupError = cleanupError;
              }
            }
          }catch(error){
            global.NCLogContext?.safeConsoleError?.(
              "[NCBG][FileLink]",
              "Share root move cleanup probe failed",
              error
            );
            if (attemptedCandidate && attemptedTargetUrl){
              reservationPresent = false;
              const cleanupError = NCNextcloudDav.createTechnicalError(
                "Share root move state requires cleanup"
              );
              cleanupError.cause = reservationFailure || error;
              cleanupError.ncRecoveredRootCandidate = Object.freeze({
                ...attemptedCandidate,
                cleanupResolution: Object.freeze({
                  reservationUrl,
                  targetUrl: attemptedTargetUrl
                })
              });
              recoveredRootCleanupError = cleanupError;
            }
          }finally{
            clearTimeout(cleanupTimer);
          }
          if (recoveredRootCleanupError){
            throw recoveredRootCleanupError;
          }
        }
      }
      if (reservationPresent){
        const cleaned = await NCNextcloudDav.deleteBestEffort({
          url: reservationUrl,
          authHeader,
          log,
          scope: "Share root reservation cleanup failed"
        });
        if (!cleaned){
          const cleanupError = NCNextcloudDav.createTechnicalError(
            "Share root reservation could not be cleaned"
          );
          cleanupError.cause = reservationFailure;
          cleanupError.ncRecoveredRootCandidate = Object.freeze({
            shareName: "",
            folderInfo: Object.freeze({
              relativeBase,
              relativeFolder: reservationPath,
              folderName: reservationPath.split("/").filter(Boolean).pop() || ""
            })
          });
          throw cleanupError;
        }
      }
    }
  }

  async function moveRootReservation({
    reservationUrl,
    targetUrl,
    authHeader,
    signal,
    log
  } = {}){
    const resolveUnclearResult = async () => {
      const [source, target] = await Promise.all([
        NCNextcloudDav.probePath({
          url: reservationUrl,
          authHeader,
          signal,
          log
        }),
        NCNextcloudDav.probePath({
          url: targetUrl,
          authHeader,
          signal,
          log
        })
      ]);
      if (!source.exists && target.exists && target.collection){
        return true;
      }
      if (source.exists && source.collection && target.exists){
        return false;
      }
      return null;
    };

    let response;
    try{
      response = await NCNextcloudDav.fetchWithTimeout({
        signal,
        timeoutMs: NCNextcloudDav.CONTROL_REQUEST_TIMEOUT_MS,
        request: (requestSignal) => fetch(reservationUrl, {
          method: "MOVE",
          headers: {
            "Authorization": authHeader,
            "Destination": targetUrl,
            "Overwrite": "F"
          },
          signal: requestSignal
        })
      });
    }catch(error){
      if (signal?.aborted || error?.name === "AbortError"){
        throw NCNextcloudDav.createAbortError();
      }
      const resolved = await resolveUnclearResult();
      if (resolved != null){
        return resolved;
      }
      const uploadError = NCNextcloudDav.createTechnicalError(
        error?.message || String(error)
      );
      uploadError.cause = error;
      throw uploadError;
    }
    if (response.ok){
      await NCNextcloudDav.closeResponse(response);
      return true;
    }
    const status = Number(response.status) || 0;
    if (status === 412){
      await NCNextcloudDav.closeResponse(response);
      return false;
    }
    let detail = "";
    try{
      detail = await NCNextcloudDav.readResponseText(response, signal);
    }catch(error){
      if ([405, 408, 409, 502, 503, 504].includes(status)){
        const resolved = await resolveUnclearResult();
        if (resolved != null){
          return resolved;
        }
      }
      throw error;
    }
    if ([405, 408, 409, 502, 503, 504].includes(status)){
      const resolved = await resolveUnclearResult();
      if (resolved != null){
        return resolved;
      }
    }
    throw NCNextcloudDav.createUploadError(status, detail);
  }

  global.NCFileLinkRootReservation = Object.freeze({
    moveRootReservation,
    reserveRoot
  });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
