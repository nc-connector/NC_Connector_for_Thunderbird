/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  /**
   * Find a file path that is also the directory prefix of another queue item.
   * Exact-path lookup plus slash-boundary scans are linear in total path length.
   * @param {Array<{entry:object,path:string}>} entries
   * @returns {{conflict:object|null,neighborChecks:number}}
   */
  function analyze(entries){
    const candidates = (Array.isArray(entries) ? entries : [])
      .map((candidate) => ({
        entry: candidate?.entry || null,
        path: String(candidate?.path || "")
      }))
      .filter((candidate) => candidate.entry && candidate.path);
    const entriesByPath = new Map();
    for (const candidate of candidates){
      if (!entriesByPath.has(candidate.path)){
        entriesByPath.set(candidate.path, candidate.entry);
      }
    }
    let neighborChecks = 0;
    for (const candidate of candidates){
      let slashIndex = candidate.path.indexOf("/");
      while (slashIndex > 0){
        neighborChecks += 1;
        const prefix = candidate.path.slice(0, slashIndex);
        const prefixEntry = entriesByPath.get(prefix);
        if (prefixEntry){
          return {
            conflict: {
              fileEntry: prefixEntry,
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
