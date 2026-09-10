/**
 * opfs-provider.mjs - OPFS provider module
 *
 * A vfs-toolkit provider implementation for the Origin Private Virtual Filesystem.
 */

// ── Capabilities ──────────────────────────────────────────────────────────────

export const capabilities = {
  file: { read: true, add: true, modify: true, delete: true },
  folder: { read: true, add: true, modify: true, delete: true },
};

// ── Low-level OPFS helpers ────────────────────────────────────────────────────

/** Returns root FileSystemDirectoryHandle */
export async function getRoot() {
  return navigator.storage.getDirectory();
}

/**
 * Resolves a path string to a FileSystemHandle.
 * @param {string} path - e.g. "/docs/notes.txt"
 * @param {'file'|'dir'|'auto'} kind
 */
export async function resolveHandle(path, kind = 'auto') {
  const root = await getRoot();
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return root;
  let handle = root;
  for (let i = 0; i < parts.length - 1; i++) {
    handle = await handle.getDirectoryHandle(parts[i]);
  }
  const last = parts[parts.length - 1];
  if (kind === 'dir') return handle.getDirectoryHandle(last);
  if (kind === 'file') return handle.getFileHandle(last);
  // auto: try dir first
  try {
    return await handle.getDirectoryHandle(last);
  } catch {
    return handle.getFileHandle(last);
  }
}

/**
 * Lists entries of a directory path.
 * Returns [{name, kind, size?, lastModified?}]
 */
async function listDir(path) {
  const dir = await resolveHandle(path, 'dir');
  const entries = [];
  for await (const [name, handle] of dir) {
    if (handle.kind === 'file') {
      let size = 0, lastModified = 0;
      try {
        const f = await handle.getFile();
        size = f.size;
        lastModified = f.lastModified;
      } catch (_) { }
      entries.push({ name, kind: 'file', size, lastModified });
    } else {
      entries.push({ name, kind: 'directory' });
    }
  }
  // Directories first, then files, both alphabetically
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/**
 * Creates a folder at the given path, creating any missing parent directories.
 * **Throws** an `E:EXIST` error if the folder already exists.
 *
 * @param {string} path
 * @param {Function} [onProgress]
 */
export async function addFolder(path, onProgress) {
  try {
    await resolveHandle(path, 'dir');
    throw Object.assign(new Error(`Folder already exists: ${path}`), { code: 'E:EXIST' });
  } catch (e) {
    if (e.code === 'E:EXIST') throw e;
    if (e.name !== 'NotFoundError') throw e;
  }
  await mkdirp(path, onProgress);
}

/** Creates directory (and parents) for a given path. */
export async function mkdirp(path, onProgress) {
  const root = await getRoot();
  const parts = path.split('/').filter(Boolean);
  let handle = root;
  for (let i = 0; i < parts.length; i++) {
    handle = await handle.getDirectoryHandle(parts[i], { create: true });
    onProgress?.({ percent: Math.round(((i + 1) / parts.length) * 100) });
  }
  return handle;
}

/** Deletes a file or directory (recursively) at path. */
export async function remove(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error('Cannot delete root');
  const name = parts[parts.length - 1];
  const root = await getRoot();
  const parentParts = parts.slice(0, -1);
  let parent = root;
  for (const p of parentParts) {
    parent = await parent.getDirectoryHandle(p);
  }
  await parent.removeEntry(name, { recursive: true });
}

/** Copies a single file to an exact destination path. */
export async function copyFile(srcPath, destPath, onProgress, { overwrite = false } = {}) {
  const srcHandle = await resolveHandle(srcPath, 'file');
  const file = await srcHandle.getFile();
  const destParts = destPath.split('/').filter(Boolean);
  const destName = destParts[destParts.length - 1];
  const destDir = '/' + destParts.slice(0, -1).join('/');
  const destDirHandle = await mkdirp(destDir);
  if (!overwrite) {
    try {
      await destDirHandle.getFileHandle(destName);
      throw Object.assign(new Error(`Target already exists: ${destPath}`), { code: 'E:EXIST' });
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }
  const destHandle = await destDirHandle.getFileHandle(destName, { create: true });
  await _writeBlob(await destHandle.createWritable(), file, onProgress);
}

/** Recursively copies a directory. */
export async function copyDir(srcPath, destPath, onProgress, { merge = false } = {}) {
  const srcHandle = await resolveHandle(srcPath, 'dir');
  if (!merge) {
    const destParts = destPath.split('/').filter(Boolean);
    const destName = destParts[destParts.length - 1];
    const destParentHandle = await mkdirp('/' + destParts.slice(0, -1).join('/'));
    try {
      await destParentHandle.getDirectoryHandle(destName);
      throw Object.assign(new Error(`Target already exists: ${destPath}`), { code: 'E:EXIST' });
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }
  const total = await _countFiles(srcHandle);
  const state = { current: 0, total };
  await mkdirp(destPath);
  const destHandle = await resolveHandle(destPath, 'dir');
  const completed = [];
  try {
    await _copyDirHandles(srcHandle, destHandle, onProgress, state,
      srcPath.endsWith('/') ? srcPath : srcPath + '/',
      destPath.endsWith('/') ? destPath : destPath + '/',
      completed);
  } catch (e) {
    if (completed.length > 0) _notifyCompleted(completed);
    throw e;
  }
}

/** Writes a File/Blob to the given path, creating parents. */
export async function writeFile(path, blob, onProgress, { overwrite = false } = {}) {
  const parts = path.split('/').filter(Boolean);
  const name = parts[parts.length - 1];
  const dir = await mkdirp('/' + parts.slice(0, -1).join('/'));
  if (!overwrite) {
    try {
      await dir.getFileHandle(name);
      throw Object.assign(new Error(`File already exists: ${path}`), { code: 'E:EXIST' });
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }
  const fileHandle = await dir.getFileHandle(name, { create: true });
  await _writeBlob(await fileHandle.createWritable(), blob, onProgress);
}

// ── Public API operations ─────────────────────────────────────────────────────

/**
 * Lists the contents of a directory in OPFS.
 * Returns [{name, path, kind, size?, lastModified?}] sorted dirs-first.
 *
 * @param {string} [path="/"]
 * @returns {Promise<Array<{name: string, path: string, kind: 'file'|'directory', size?: number, lastModified?: number}>>}
 */
export async function list(path = '/', onProgress) {
  const base = path.replace(/\/$/, '');
  const entries = (await listDir(path)).map(e => ({ ...e, path: base + '/' + e.name }));
  onProgress?.({ percent: 100 });
  return entries;
}

/**
 * Reads a file from OPFS and returns a File object.
 * If onProgress is provided, reads in chunks and reports byte progress.
 *
 * @param {string} path - Absolute path, e.g. "/folder/file.txt"
 * @param {Function} [onProgress]
 * @returns {Promise<File>}
 */
export async function readFile(path, onProgress) {
  const handle = await resolveHandle(path, 'file');
  const opfsFile = await handle.getFile();
  const reader = opfsFile.stream().getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ percent: Math.round(loaded / (opfsFile.size || 1) * 100) });
  }
  return new File(chunks, opfsFile.name, { type: opfsFile.type, lastModified: opfsFile.lastModified });
}


/**
 * Moves (or renames) a file. Throws if the target already exists.
 *
 * @param {string} oldPath - Absolute source path
 * @param {string} newPath - Absolute destination path
 * @param {Function} [onProgress]
 * @returns {Promise<void>}
 */
export async function moveFile(oldPath, newPath, onProgress, { overwrite = false } = {}) {
  const newParts = newPath.split('/').filter(Boolean);
  if (newParts.length === 0) throw new TypeError('newPath must point to a file.');
  const newName = newParts[newParts.length - 1];
  const newDirHandle = await mkdirp('/' + newParts.slice(0, -1).join('/'));
  if (!overwrite) {
    try {
      await newDirHandle.getFileHandle(newName);
      throw Object.assign(new Error(`Target already exists: ${newPath}`), { code: 'E:EXIST' });
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }
  const srcFile = await readFile(oldPath, onProgress);
  const destHandle = await newDirHandle.getFileHandle(newName, { create: true });
  await _writeBlob(await destHandle.createWritable(), srcFile, onProgress);
  await remove(oldPath);
}

/**
 * Deletes a file or folder. Silent (no error) if it does not exist.
 *
 * @param {string} path - Absolute path
 * @param {Function} [onProgress]
 * @returns {Promise<void>}
 */
export async function deleteEntry(path, onProgress) {
  if (!path.split('/').filter(Boolean).length) throw new TypeError('Cannot delete the root.');
  try { await remove(path); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  onProgress?.({ percent: 100 });
}

/**
 * Moves (or renames) a folder to an exact new path.
 * Throws if the target already exists.
 *
 * @param {string} oldPath - Absolute source path
 * @param {string} newPath - Absolute destination path (not a parent - the actual new path)
 * @param {Function} [onProgress]
 * @returns {Promise<void>}
 */
export async function moveFolder(oldPath, newPath, onProgress, { merge = false } = {}) {
  const newParts = newPath.split('/').filter(Boolean);
  if (newParts.length === 0) throw new TypeError('newPath must not be the root.');
  const newName = newParts[newParts.length - 1];
  const newParentHandle = await mkdirp('/' + newParts.slice(0, -1).join('/'));
  if (!merge) {
    try {
      await newParentHandle.getDirectoryHandle(newName);
      throw Object.assign(new Error(`Target already exists: ${newPath}`), { code: 'E:EXIST' });
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }
  // Count total files first for progress reporting
  const srcHandle = await resolveHandle(oldPath, 'dir');
  const total = await _countFiles(srcHandle);
  const state = { current: 0, total };
  // Recursively copy source to target then delete source
  const destHandle = await newParentHandle.getDirectoryHandle(newName, { create: true });
  const completed = [];
  try {
    await _copyDirHandles(srcHandle, destHandle, onProgress, state,
      oldPath.endsWith('/') ? oldPath : oldPath + '/',
      newPath.endsWith('/') ? newPath : newPath + '/',
      completed);
    await remove(oldPath);
  } catch (e) {
    // Files copied before the error are at dest but source not deleted — report as 'copied'
    if (completed.length > 0) _notifyCompleted(completed);
    throw e;
  }
}


// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Recursively counts the total number of files in a directory handle.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {Promise<number>}
 */
async function _countFiles(dirHandle) {
  let count = 0;
  for await (const [, handle] of dirHandle) {
    if (handle.kind === 'file') {
      count++;
    } else {
      count += await _countFiles(handle);
    }
  }
  return count;
}

/**
 * Writes a Blob to an already-opened FileSystemWritableFileStream in 1 MB chunks,
 * reporting byte progress, then closes the writable.
 */
async function _writeBlob(writable, blob, onProgress) {
  const CHUNK = 1024 * 1024;
  let offset = 0;
  try {
    while (offset < blob.size) {
      await writable.write(blob.slice(offset, offset + CHUNK));
      offset = Math.min(offset + CHUNK, blob.size);
      onProgress?.({ percent: Math.round(offset / (blob.size || 1) * 100) });
    }
    if (blob.size === 0) onProgress?.({ percent: 100 });
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => { });
    throw err;
  }
}

/**
 * Recursively copies from one FileSystemDirectoryHandle to another.
 * Accepts an optional onProgress callback and a mutable state object
 * { current, total } that is updated as files are processed.
 *
 * @param {FileSystemDirectoryHandle} srcDir
 * @param {FileSystemDirectoryHandle} destDir
 * @param {Function} [onProgress]
 * @param {{ current: number, total: number }} [state]
 */
async function _copyDirHandles(srcDir, destDir, onProgress, state, srcDirPath, destDirPath, completed) {
  for await (const [name, handle] of srcDir) {
    const childSrc = srcDirPath + name;
    const childDest = destDirPath + name;
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      const destFile = await destDir.getFileHandle(name, { create: true });
      const writable = await destFile.createWritable();
      await writable.write(file);
      await writable.close();
      completed?.push({ kind: 'file', action: 'copied',
        target: { path: childDest, storageRef: null },
        source: { path: childSrc, storageRef: null } });
      if (state) {
        state.current++;
        const percent = state.total > 0
          ? Math.round(state.current / state.total * 100)
          : 100;
        onProgress?.({ percent, currentFile: state.current, totalFiles: state.total });
      }
    } else {
      const destSub = await destDir.getDirectoryHandle(name, { create: true });
      await _copyDirHandles(handle, destSub, onProgress, state, childSrc + '/', childDest + '/', completed);
      completed?.push({ kind: 'directory', action: 'copied',
        target: { path: childDest + '/', storageRef: null },
        source: { path: childSrc + '/', storageRef: null } });
    }
  }
}

/** Fires individual completed-entry events via the background relay. */
function _notifyCompleted(entries) {
  browser.runtime.sendMessage({ type: 'vfs-notify-background-storage-changed', entries }).catch(() => {});
}
