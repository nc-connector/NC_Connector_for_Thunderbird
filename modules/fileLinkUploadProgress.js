/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const UI_INTERVAL_MS = 100;
  const LOG_INTERVAL_MS = 5000;

  function create({ files, onStatus, log } = {}){
    const sourceFiles = Array.isArray(files) ? files : [];
    const loadedById = new Map(sourceFiles.map((file) => [file.internalId, 0]));
    const completedIds = new Set();
    const pendingItems = new Map();
    const totalBytes = sourceFiles.reduce(
      (sum, file) => sum + Math.max(0, Number(file?.size) || 0),
      0
    );
    const startedAt = Date.now();
    let lastUiAt = 0;
    let lastLogAt = 0;
    let timer = null;
    let stopped = false;

    function getLoadedBytes(){
      let total = 0;
      for (const loaded of loadedById.values()){
        total += Math.max(0, Number(loaded) || 0);
      }
      return Math.min(totalBytes, total);
    }

    function getSnapshot(){
      const loadedBytes = getLoadedBytes();
      const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      return Object.freeze({
        phase: "summary",
        completedFiles: completedIds.size,
        totalFiles: sourceFiles.length,
        loadedBytes,
        totalBytes,
        bytesPerSecond: loadedBytes / elapsedSeconds
      });
    }

    function emit(force = false){
      if (stopped){
        return;
      }
      const now = Date.now();
      const remaining = UI_INTERVAL_MS - (now - lastUiAt);
      if (!force && remaining > 0){
        if (!timer){
          timer = setTimeout(() => {
            timer = null;
            emit(true);
          }, remaining);
        }
        return;
      }
      if (timer){
        clearTimeout(timer);
        timer = null;
      }
      const snapshot = getSnapshot();
      lastUiAt = now;
      if (pendingItems.size){
        onStatus?.(Object.freeze({
          phase: "items",
          items: Object.freeze(Array.from(pendingItems.values()))
        }));
        pendingItems.clear();
      }
      onStatus?.(snapshot);
      if (typeof log === "function" && now - lastLogAt >= LOG_INTERVAL_MS){
        lastLogAt = now;
        log("Upload progress", {
          files: `${snapshot.completedFiles}/${snapshot.totalFiles}`,
          bytes: `${snapshot.loadedBytes}/${snapshot.totalBytes}`
        });
      }
    }

    function setLoaded(file, loaded){
      if (!file?.internalId || !loadedById.has(file.internalId)){
        return;
      }
      const size = Math.max(0, Number(file.size) || 0);
      loadedById.set(
        file.internalId,
        Math.min(size, Math.max(0, Number(loaded) || 0))
      );
      emit();
    }

    function reset(file){
      if (!file?.internalId){
        return;
      }
      completedIds.delete(file.internalId);
      loadedById.set(file.internalId, 0);
      emit();
    }

    function complete(file){
      if (!file?.internalId){
        return;
      }
      completedIds.add(file.internalId);
      loadedById.set(file.internalId, Math.max(0, Number(file.size) || 0));
      emit();
    }

    function reportItem(event){
      const itemId = String(event?.itemId || "");
      if (!itemId){
        return;
      }
      pendingItems.set(itemId, Object.freeze({ ...event, itemId }));
      emit();
    }

    function stop(){
      if (timer){
        clearTimeout(timer);
        timer = null;
      }
      if (!stopped){
        emit(true);
      }
      stopped = true;
    }

    emit(true);
    return Object.freeze({
      setLoaded,
      reset,
      complete,
      reportItem,
      snapshot: getSnapshot,
      flush: () => emit(true),
      stop
    });
  }

  global.NCFileLinkUploadProgress = Object.freeze({
    UI_INTERVAL_MS,
    LOG_INTERVAL_MS,
    create
  });
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
