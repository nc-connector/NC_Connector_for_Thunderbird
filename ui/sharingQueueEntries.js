/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  /**
   * Owns the queue entry descriptors and their path/rename rules.
   */
  function create({ sanitizeFileName, sanitizeRelativeDir, findPathConflict } = {}){
    function normalizeDisplayPath(value){
      const raw = String(value || '').trim();
      if (!raw){
        return '';
      }
      return raw.replace(/\\/g, '/').replace(/\/+/g, '/');
    }

    function extractDisplayDir(fullPath){
      const normalized = normalizeDisplayPath(fullPath);
      const idx = normalized.lastIndexOf('/');
      if (idx <= 0){
        return '';
      }
      return normalized.slice(0, idx);
    }

    function buildDisplayPath(displayDir, fileName){
      const safeFileName = String(fileName || '').trim();
      const normalizedDir = normalizeDisplayPath(displayDir).replace(/\/+$/, '');
      if (!normalizedDir){
        return safeFileName;
      }
      return `${normalizedDir}/${safeFileName}`;
    }

    function resolveDisplayPath({
      file,
      source,
      relativeDir = '',
      selectionRootDir = '',
      fallbackName = '',
      providedPath = ''
    } = {}){
      const fileName = String(fallbackName || file?.name || 'File').trim() || 'File';
      if (source === 'folder'){
        return buildDisplayPath(relativeDir, fileName);
      }
      const candidates = [
        providedPath,
        file?.webkitRelativePath,
        file?.relativePath,
        file?.mozFullPath,
        file?.path
      ];
      for (const candidate of candidates){
        const normalized = normalizeDisplayPath(candidate);
        if (!normalized){
          continue;
        }
        const normalizedFileName = fileName.toLowerCase();
        const normalizedCandidate = normalized.toLowerCase();
        if (normalizedCandidate.endsWith(`/${normalizedFileName}`) || normalizedCandidate === normalizedFileName){
          return normalized;
        }
        return buildDisplayPath(normalized, fileName);
      }
      if (source === 'file'){
        const root = normalizeDisplayPath(selectionRootDir).replace(/\/+$/, '');
        if (root){
          return buildDisplayPath(root, fileName);
        }
      }
      return buildDisplayPath(relativeDir, fileName);
    }

    function extractSelectionRootDir(inputValue){
      const normalized = normalizeDisplayPath(inputValue);
      if (!normalized || !normalized.includes('/')){
        return '';
      }
      if (normalized.toLowerCase().includes('/fakepath/')){
        return '';
      }
      const idx = normalized.lastIndexOf('/');
      if (idx <= 0){
        return '';
      }
      return normalized.slice(0, idx);
    }

    function createAttachmentEntry(item){
      const file = item.file;
      const fileName = sanitizeFileName(item.name || file.name || 'File');
      const sourceDisplayPath = resolveDisplayPath({
        file,
        source: 'launch',
        fallbackName: fileName,
        providedPath: item.displayPath || item.path || item.fullPath || item.name || file.name || ''
      });
      const displayDir = extractDisplayDir(sourceDisplayPath);
      return {
        id: `entry_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file,
        displayPath: buildDisplayPath(displayDir, fileName),
        displayDir,
        relativeDir: '',
        renamedName: '',
        status: 'pending',
        progress: 0,
        error: '',
        speedKbps: 0,
        progressStartedAt: 0
      };
    }

    function createLocalEntry(file, {
      source,
      relativeDir = '',
      selectionRootDir = '',
      queueGroupId = ''
    } = {}){
      const displayPath = resolveDisplayPath({
        file,
        source,
        relativeDir,
        selectionRootDir,
        fallbackName: file.name || 'File'
      });
      const displayDir = extractDisplayDir(displayPath);
      return {
        id: `entry_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        sourceKind: 'local',
        sourceLabel: '',
        kind: 'file',
        name: file.name || 'File',
        file,
        displayPath,
        displayDir,
        relativeDir,
        queueGroupId,
        renamedName: '',
        status: 'pending',
        progress: 0,
        error: '',
        speedKbps: 0,
        progressStartedAt: 0
      };
    }

    function createRemoteEntry(source, index, { invalidNameMessage = '' } = {}){
      const sourceKind = source?.sourceKind === 'nextcloud' ? 'nextcloud' : 'external-vfs';
      const kind = source?.kind === 'folder' ? 'folder' : 'file';
      const name = String(source?.name || '').trim();
      if (!name){
        throw new Error(invalidNameMessage);
      }
      const relativeDir = String(source?.relativeDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const displayPath = normalizeDisplayPath(source?.displayPath)
        || buildDisplayPath(relativeDir, name);
      return {
        id: `entry_${Date.now()}_${index}_${Math.random().toString(36).slice(2)}`,
        sourceKind,
        sourceLabel: String(source?.sourceLabel || '').trim(),
        kind,
        name,
        file: null,
        storageRef: source?.storageRef && typeof source.storageRef === 'object'
          ? {
              providerId: String(source.storageRef.providerId || ''),
              storageId: String(source.storageRef.storageId || '')
            }
          : null,
        sourcePath: String(source?.sourcePath || ''),
        size: kind === 'file' && source?.size != null && Number.isFinite(Number(source.size))
          ? Math.max(0, Number(source.size))
          : null,
        lastModified: Math.max(0, Number(source?.lastModified) || 0),
        contentType: String(source?.contentType || 'application/octet-stream'),
        transferGroupId: String(source?.transferGroupId || ''),
        transferRole: String(source?.transferRole || 'item'),
        transferRoot: source?.transferRoot === true,
        displayPath,
        displayDir: extractDisplayDir(displayPath),
        relativeDir,
        renamedName: '',
        status: 'pending',
        progress: 0,
        error: '',
        speedKbps: 0,
        progressStartedAt: 0
      };
    }

    function getTargetRelativePath(entry){
      const sanitizedName = sanitizeFileName(
        entry.renamedName || entry.name || entry.file?.name || 'File'
      );
      const sanitizedDir = sanitizeRelativeDir(entry.relativeDir || '');
      return sanitizedDir ? `${sanitizedDir}/${sanitizedName}` : sanitizedName;
    }

    function findConflict(entries){
      if (typeof findPathConflict !== 'function'){
        throw new Error('file_queue_path_conflict_runtime_unavailable');
      }
      return findPathConflict((Array.isArray(entries) ? entries : []).map((entry) => ({
        entry,
        path: getTargetRelativePath(entry),
        kind: entry.kind || 'file'
      })));
    }

    function getCollisionRenameTarget(entries, entry){
      if (entry?.sourceKind !== 'nextcloud'
        || !entry.transferGroupId
        || entry.transferRoot){
        return entry;
      }
      return (Array.isArray(entries) ? entries : []).find((candidate) =>
        candidate.transferGroupId === entry.transferGroupId && candidate.transferRoot
      ) || entry;
    }

    function resetTransferState(entry){
      entry.status = 'pending';
      entry.progress = 0;
      entry.error = '';
      entry.speedKbps = 0;
      entry.progressStartedAt = 0;
    }

    function renameEntry(entries, entry, newName){
      const clean = (newName || '').trim();
      if (!clean){
        return;
      }
      if (entry.kind === 'folder' && entry.transferGroupId){
        const oldRoot = normalizeDisplayPath(entry.displayPath);
        const newRoot = buildDisplayPath(entry.displayDir || entry.relativeDir || '', clean);
        for (const member of Array.isArray(entries) ? entries : []){
          if (member.transferGroupId !== entry.transferGroupId){
            continue;
          }
          const currentPath = normalizeDisplayPath(member.displayPath);
          if (member === entry){
            member.renamedName = clean;
            member.displayPath = newRoot;
            member.displayDir = extractDisplayDir(newRoot);
            continue;
          }
          if (!oldRoot || !currentPath.startsWith(`${oldRoot}/`)){
            continue;
          }
          const updatedPath = `${newRoot}${currentPath.slice(oldRoot.length)}`;
          member.displayPath = updatedPath;
          member.displayDir = extractDisplayDir(updatedPath);
          member.relativeDir = member.displayDir;
        }
        return;
      }
      entry.renamedName = clean;
      entry.displayPath = buildDisplayPath(entry.displayDir || entry.relativeDir || '', clean);
    }

    return Object.freeze({
      normalizeDisplayPath,
      extractDisplayDir,
      buildDisplayPath,
      resolveDisplayPath,
      extractSelectionRootDir,
      createAttachmentEntry,
      createLocalEntry,
      createRemoteEntry,
      getTargetRelativePath,
      findConflict,
      getCollisionRenameTarget,
      resetTransferState,
      renameEntry
    });
  }

  global.NCSharingQueueEntries = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
