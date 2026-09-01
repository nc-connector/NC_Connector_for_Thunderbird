/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  /**
   * Find exact target duplicates and file/directory prefix collisions.
   * Exact lookup plus slash-boundary scans are linear in total path length.
   * @param {Array<{entry:object,path:string,kind?:string}>} entries
   * @returns {{conflict:object|null,neighborChecks:number}}
   */
  function analyze(entries){
    const candidates = (Array.isArray(entries) ? entries : [])
      .map((candidate) => ({
        entry: candidate?.entry || null,
        path: String(candidate?.path || ""),
        kind: candidate?.kind === "folder" ? "folder" : "file"
      }))
      .filter((candidate) => candidate.entry && candidate.path);
    const entriesByPath = new Map();
    let neighborChecks = 0;
    for (const candidate of candidates){
      const existing = entriesByPath.get(candidate.path);
      if (existing){
        return {
          conflict: {
            type: "exact",
            path: candidate.path,
            entry: existing.entry,
            duplicateEntry: candidate.entry
          },
          neighborChecks
        };
      }
      entriesByPath.set(candidate.path, candidate);
    }
    for (const candidate of candidates){
      let slashIndex = candidate.path.indexOf("/");
      while (slashIndex > 0){
        neighborChecks += 1;
        const prefix = candidate.path.slice(0, slashIndex);
        const prefixEntry = entriesByPath.get(prefix);
        const sharedTransferGroup = prefixEntry?.entry?.transferGroupId
          && prefixEntry.entry.transferGroupId === candidate.entry.transferGroupId;
        if (prefixEntry && (prefixEntry.kind !== "folder" || !sharedTransferGroup)){
          return {
            conflict: {
              type: "file-prefix",
              fileEntry: prefixEntry.entry,
              filePath: prefix,
              nestedPath: candidate.path
            },
            neighborChecks
          };
        }
        slashIndex = candidate.path.indexOf("/", slashIndex + 1);
      }
      if (slashIndex === 0){
        neighborChecks += 1;
      }
    }
    return { conflict: null, neighborChecks };
  }

  global.NCFileQueuePathConflicts = Object.freeze({
    analyze,
    find(entries){
      return analyze(entries).conflict;
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
