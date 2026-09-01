/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  function targetPath(item){
    return global.NCNextcloudDav.joinPath(item.relativeDir, item.fileName);
  }

  function collectDirectoryTree(paths){
    const directories = new Set();
    for (const rawPath of paths || []){
      const normalized = global.NCNextcloudDav.normalizeRelativePath(rawPath);
      if (!normalized){
        continue;
      }
      const segments = normalized.split('/').filter(Boolean);
      let current = '';
      for (const segment of segments){
        current = current ? `${current}/${segment}` : segment;
        directories.add(current);
      }
    }
    return Object.freeze(Array.from(directories).sort((left, right) => {
      const depth = left.split('/').length - right.split('/').length;
      return depth || left.localeCompare(right);
    }));
  }

  function requireStorageRef(value){
    const providerId = String(value?.providerId || '').trim();
    const storageId = String(value?.storageId || '').trim();
    if (!providerId || !storageId){
      throw new Error(bgI18n('vfs_error_storage_changed'));
    }
    return Object.freeze({ providerId, storageId });
  }

  function normalizeItems(sourceItems, { sanitizeFileName, sanitizeRelativeDir } = {}){
    if (typeof sanitizeFileName !== 'function' || typeof sanitizeRelativeDir !== 'function'){
      throw new Error('file_link_source_normalizers_missing');
    }
    const items = (Array.isArray(sourceItems) ? sourceItems : []).map((source, index) => {
      const sourceKind = ['local', 'nextcloud', 'external-vfs'].includes(source?.sourceKind)
        ? source.sourceKind
        : 'local';
      const kind = source?.kind === 'folder' ? 'folder' : 'file';
      const sourceFile = source?.file || null;
      if (sourceKind === 'external-vfs'
        && kind === 'file'
        && (typeof source?.size !== 'number'
          || !Number.isFinite(source.size)
          || source.size < 0)){
        throw new Error(bgI18n('vfs_error_file_metadata_missing'));
      }
      const sourceName = String(source?.name || sourceFile?.name || 'File');
      const fileName = sanitizeFileName(source?.renamedName || sourceName);
      const relativeDir = sanitizeRelativeDir(source?.relativeDir || '');
      const itemId = String(source?.id || `source-${index + 1}`);
      const item = {
        itemId,
        internalId: `source-${index + 1}-${itemId}`,
        sourceKind,
        sourceLabel: String(source?.sourceLabel || ''),
        kind,
        fileName,
        relativeDir,
        displayPath: String(source?.displayPath || targetPath({ relativeDir, fileName })),
        sourceFile,
        storageRef: sourceKind === 'local' ? null : requireStorageRef(source?.storageRef),
        sourcePath: sourceKind === 'local'
          ? ''
          : global.NCNextcloudDav.normalizeVfsPath(source?.sourcePath, { allowRoot: false }),
        size: Math.max(0, Number(source?.size ?? sourceFile?.size) || 0),
        lastModified: Math.max(0, Number(source?.lastModified ?? sourceFile?.lastModified) || Date.now()),
        contentType: String(source?.contentType || sourceFile?.type || 'application/octet-stream'),
        transferGroupId: String(source?.transferGroupId || ''),
        transferRole: String(source?.transferRole || 'item'),
        transferRoot: source?.transferRoot === true
      };
      if (sourceKind === 'local'){
        if (kind !== 'file' || !sourceFile || typeof sourceFile.slice !== 'function'){
          throw new Error(bgI18n('sharing_status_error'));
        }
      }
      return Object.freeze(item);
    });

    const localFiles = items
      .filter((item) => item.sourceKind === 'local')
      .map((item) => Object.freeze({ ...item }));
    const nextcloudCopies = items.filter((item) =>
      item.sourceKind === 'nextcloud' && item.transferRole === 'copy-root'
    );
    const externalFiles = items.filter((item) =>
      item.sourceKind === 'external-vfs' && item.kind === 'file'
    );
    const externalDirectories = items.filter((item) =>
      item.sourceKind === 'external-vfs' && item.kind === 'folder'
    );
    const directoryPaths = [
      ...externalDirectories.map((item) => targetPath(item)),
      ...externalFiles.map((item) => item.relativeDir),
      ...nextcloudCopies.map((item) => item.relativeDir)
    ];
    const additionalProgressFiles = externalFiles.map((item) => Object.freeze({
      ...item,
      sourceFile: null
    }));
    return Object.freeze({
      items: Object.freeze(items),
      localFiles: Object.freeze(localFiles),
      nextcloudCopies: Object.freeze(nextcloudCopies),
      externalFiles: Object.freeze(externalFiles),
      externalDirectories: Object.freeze(externalDirectories),
      additionalDirectories: collectDirectoryTree(directoryPaths),
      additionalProgressFiles: Object.freeze(additionalProgressFiles)
    });
  }

  function emitItem(onStatus, item, phase, extras = {}){
    onStatus?.(Object.freeze({
      phase,
      itemId: item.itemId,
      fileName: item.fileName,
      displayPath: item.displayPath,
      ...extras
    }));
  }

  function groupMembers(plan, root){
    if (!root.transferGroupId){
      return [root];
    }
    return plan.items.filter((item) => item.transferGroupId === root.transferGroupId);
  }

  async function copyNextcloudSources({
    plan,
    shareRoot,
    signal,
    onStatus
  }){
    if (!plan.nextcloudCopies.length){
      return;
    }
    let completed = 0;
    for (const item of plan.nextcloudCopies){
      global.NCNextcloudDav.throwIfAborted(signal);
      const members = groupMembers(plan, item);
      members.forEach((member) => emitItem(onStatus, member, 'source_copy'));
      onStatus?.({
        phase: 'source_transfer',
        mode: 'copy',
        current: completed,
        total: plan.nextcloudCopies.length
      });
      try{
        await global.NCVfsProviderRuntime.copyIntoShare(item.storageRef, {
          sourcePath: item.sourcePath,
          destinationPath: `/${global.NCNextcloudDav.joinPath(shareRoot, targetPath(item))}`,
          kind: item.kind === 'folder' ? 'directory' : 'file',
          signal
        });
        members.forEach((member) => emitItem(onStatus, member, 'done'));
        completed++;
        onStatus?.({
          phase: 'source_transfer',
          mode: 'copy',
          current: completed,
          total: plan.nextcloudCopies.length
        });
      }catch(error){
        members.forEach((member) => emitItem(onStatus, member, 'error', {
          error: error?.message || bgI18n('sharing_status_error')
        }));
        throw error;
      }
    }
  }

  async function readExternalFile(item, signal, onStatus){
    global.NCNextcloudDav.throwIfAborted(signal);
    emitItem(onStatus, item, 'source_fetch', { percent: 0 });
    const file = await global.NCVfsClientRuntime.readFile({
      path: item.sourcePath,
      storageRef: item.storageRef
    }, {
      signal,
      onProgress: ({ percent }) => {
        emitItem(onStatus, item, 'source_fetch', {
          percent: Math.min(100, Math.max(0, Number(percent) || 0))
        });
      }
    });
    global.NCNextcloudDav.throwIfAborted(signal);
    if (!file || typeof file.slice !== 'function'){
      throw new Error(bgI18n('vfs_error_file_read_failed'));
    }
    if (Number(file.size) !== item.size){
      throw new Error(bgI18n('vfs_error_file_changed'));
    }
    return file;
  }

  async function uploadExternalSources({
    plan,
    davRoot,
    uploadRoot,
    shareRoot,
    authHeader,
    signal,
    log,
    onStatus,
    progress
  }){
    let completed = 0;
    for (const item of plan.externalFiles){
      global.NCNextcloudDav.throwIfAborted(signal);
      onStatus?.({
        phase: 'source_transfer',
        mode: 'fetch',
        current: completed,
        total: plan.externalFiles.length
      });
      let sourceFile = null;
      try{
        sourceFile = await readExternalFile(item, signal, onStatus);
        const uploadFile = Object.freeze({
          ...item,
          sourceFile,
          contentType: sourceFile.type || item.contentType,
          lastModified: Number(sourceFile.lastModified) || item.lastModified
        });
        if (uploadFile.size > global.NCFileLinkUploadPolicy.DIRECT_UPLOAD_LIMIT_BYTES){
          await global.NCFileLinkUpload.uploadChunked({
            file: uploadFile,
            davRoot,
            uploadRoot,
            shareRoot,
            authHeader,
            signal,
            log,
            progress
          });
        }else{
          await global.NCFileLinkUpload.uploadDirect({
            file: uploadFile,
            davRoot,
            shareRoot,
            authHeader,
            signal,
            log,
            progress
          });
        }
        completed++;
        onStatus?.({
          phase: 'source_transfer',
          mode: 'fetch',
          current: completed,
          total: plan.externalFiles.length
        });
      }catch(error){
        emitItem(onStatus, item, 'error', {
          error: error?.message || bgI18n('sharing_status_error')
        });
        throw error;
      }finally{
        sourceFile = null;
      }
    }
  }

  function markExternalDirectoriesDone(plan, onStatus){
    for (const item of plan.externalDirectories){
      emitItem(onStatus, item, 'done');
    }
  }

  async function transferAdditionalSources(context){
    const { plan, onStatus } = context;
    markExternalDirectoriesDone(plan, onStatus);
    await copyNextcloudSources(context);
    await uploadExternalSources(context);
  }

  global.NCFileLinkSources = Object.freeze({
    normalizeItems,
    transferAdditionalSources
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
