/**
 * picker.mjs - VFS file picker UI logic
 *
 * Runs inside picker.html (opened as a WebExtension popup window).
 * Communicates results back via browser.runtime.sendMessage.
 *
 * Uses vfs-client.mjs for all VFS operations.
 */

import * as vfs from './vfs-client.mjs';


// ── Locale resolution ─────────────────────────────────────────────────────────

// Locales that have a corresponding file in locales/. Only these will be
// fetched.
const _AVAILABLE = new Set(['cs', 'de', 'en', 'es', 'fr', 'hu', 'it', 'ja', 'pt', 'ru', 'sv']);
const _lang = browser.i18n.getUILanguage().split('-')[0];

async function _loadLocale(lang) {
  if (!_AVAILABLE.has(lang)) return null;
  try {
    const url = new URL(`./locales/${lang}.json`, import.meta.url);
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Load the requested locale, falling back to 'en' if the file is missing.
const _strings =
  (_lang !== 'en' ? await _loadLocale(_lang) : null) ??
  await _loadLocale('en') ??
  {};

/**
 * Return the localised string for `key`, replacing $1 … $N with the
 * supplied substitution values.
 *
 * @param {string} key
 * @param {...string} subs
 * @returns {string}
 */
function t(key, ...subs) {
  let s = _strings[key] ?? `__MSG_${key}__`;
  subs.forEach((v, i) => { s = s.replaceAll(`$${i + 1}`, v); });
  return s;
}

/**
 * Walk `doc` and apply localised values to every element that carries a
 * `data-i18n-*` attribute, following the same conventions as vendor/i18n.mjs:
 *
 *   data-i18n-content     : element.textContent
 *   data-i18n-title       : element.title
 *   data-i18n-placeholder : element.placeholder
 *   data-i18n-aria-label  : element aria-label attribute
 *
 * @param {Document} [doc]
 */
function localizeDocument(doc = document) {
  const sel = [
    '[data-i18n-content]',
    '[data-i18n-title]',
    '[data-i18n-placeholder]',
    '[data-i18n-aria-label]',
  ].join(',');

  for (const el of doc.querySelectorAll(sel)) {
    for (const { name, value } of [...el.attributes]) {
      const m = name.match(/^data-i18n-(.+)/);
      if (!m) continue;
      const target = m[1];
      const val = t(value);
      if (target === 'content') {
        el.textContent = val;
      } else {
        el.setAttribute(target, val);
      }
    }
  }
}


// ── Communication mode detection ─────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const SESSION_ID = params.get('session');
const MULTIPLE = params.get('multiple') === '1';
const TYPES = params.get('types') ? JSON.parse(params.get('types')) : null;
const EXCLUDE_ACCEPT_ALL = params.get('excludeAcceptAll') === '1';
const PICKER_ID = params.get('id') ?? null;
const START_IN = params.get('startIn') ?? null;
const VFS_PROVIDER_NAME = params.get('opfsStorageName') ?? null;
const MODE = params.get('mode') ?? 'open'; // 'open' | 'save' | 'dir' | 'browse'
const SUGGESTED_NAME = params.get('suggestedName') ?? null;
// Array of { id, label } — rendered as extra toolbar buttons; clicks are sent to
// the client extension background via browser.runtime.sendMessage so the background
// can react (e.g. open a test tab) without any provider involvement.
const BUTTONS = params.get('buttons') ? JSON.parse(params.get('buttons')) : [];
// 'strict' | 'soft' | null. When set, the picker is locked to LOCKED_REF:
// 'strict' hides the provider selector entirely; 'soft' disables the confirm
// button while the user browses a different connection.
const LOCK_STORAGE = params.get('lockStorage') ?? null;
const LOCKED_REF = LOCK_STORAGE && params.has('storageRef')
  ? JSON.parse(params.get('storageRef'))
  : null;

function _isLockedConnection(ref) {
  if (!LOCKED_REF) return true;
  return (ref?.providerId ?? null) === (LOCKED_REF.providerId ?? null) &&
         (ref?.storageId  ?? null) === (LOCKED_REF.storageId  ?? null);
}

// ── Id-state persistence (localStorage, keyed by id only - id enforces the provider) ──

function _idStateKey() {
  return `vfs-picker.id|${PICKER_ID}`;
}

function _loadIdState() {
  if (!PICKER_ID) return null;
  try { return JSON.parse(localStorage.getItem(_idStateKey())); } catch { return null; }
}

function _saveIdState(cwd) {
  if (!PICKER_ID) return;
  try { localStorage.setItem(_idStateKey(), JSON.stringify({ cwd, storageRef: state.storageRef })); } catch { /* quota or private mode */ }
}

// Restore persisted id-state: override provider and initial directory
const _idState = _loadIdState();

/** Send the result back to the opener and close. */
async function sendResult(result) {
  await browser.runtime.sendMessage({ type: 'vfs-picker-result', session: SESSION_ID, result });
  window.close();
}

// ── vfs helpers ───────────────────────────────────────────────────────────────

// Build a vfs Entry for the current provider.
const _e = path => ({ path, storageRef: state.storageRef });

// Build vfs options with an optional progress callback.
// Pass currentFile + totalFiles to include a file counter in the progress display.
function _opts(progressLabel, currentFile, totalFiles) {
  if (!progressLabel) return {};
  _startProgress(progressLabel, currentFile, totalFiles);
  return {
    onProgress: p => {
      if (_cancelRequested) throw new DOMException('Cancelled', 'AbortError');
      if (p.currentFile != null)
        _progressFileInfo = { currentFile: p.currentFile, totalFiles: p.totalFiles };
      if (p.percent === 100) {
        if (!_busy) {
          _clear(); // non-locking caller - auto-clear display
        } else {
          // Inside doWithStatus - reset per-file state for next file, doWithStatus owns the unlock
          if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
          _progressMode = 'spinner';
          _progressPercent = null;
        }
        return;
      }
      _switchToBar(p.percent);
    },
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes === 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function pathJoin(dir, name) {
  if (dir === '/') return '/' + name;
  return dir + '/' + name;
}

function parentPath(path) {
  if (path === '/') return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return '/' + parts.slice(0, -1).join('/');
}

function basename(path) {
  return path.split('/').filter(Boolean).pop() || '/';
}

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  storageRef: LOCKED_REF ?? _idState?.storageRef ?? (params.has('storageRef') ? JSON.parse(params.get('storageRef')) : null),
  cwd: (LOCKED_REF ? null : _idState?.cwd) ?? START_IN ?? '/',
  entries: [],
  selected: new Set(), // Set of selected entry names
  _anchor: null, // last clicked/navigated entry, for shift-range and preview
  lockedUnavailable: false, // true when LOCKED_REF is not present in the providers list
  lockedLabel: null, // resolved "<provider>: <connection>" for LOCKED_REF, set in init()
  filter: '',
  typeIndex: TYPES?.length ? 0 : null,
  clipboard: null, // { entries: Entry[], op: 'cut' | 'copy' }
  dragging: null,
  capabilities: null,
};

// ── DOM Refs ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);


const locationBarEl = $('vfs-location-bar');
const breadcrumbEl = $('vfs-breadcrumb');

// Provider selector - module-level refs so event handlers can update it dynamically
let _providerWrap = null;
let _providerUl = null;
let _providerBtn = null;
const listArea = $('vfs-list-area');
const dropOverlay = $('vfs-drop-overlay');
const filterInput = $('vfs-filter');
const storageInfoEl = $('vfs-storage-info');
const openBtn = $('vfs-open-btn');
const cancelBtn = $('vfs-cancel-btn');
const contextMenu = $('vfs-context-menu');
const saveBarEl = $('vfs-save-bar');
const saveNameInput = $('vfs-save-name');
const previewEl = $('vfs-preview');
const fileInputEl = $('vfs-file-input');

// ── Capabilities ──────────────────────────────────────────────────────────────

function applyCapabilities() {
  const c = state.capabilities || { file: {}, folder: {} };
  $('vfs-btn-new-folder').disabled = !c.folder?.add;
  $('vfs-btn-store').disabled = !c.file?.add;
  $('vfs-btn-rename').disabled = !(c.file?.modify || c.folder?.modify);
  $('vfs-btn-delete').disabled = !(c.file?.delete || c.folder?.delete);
  $('vfs-btn-cut').disabled = !(c.file?.modify || c.folder?.modify);
  $('vfs-btn-copy').disabled = !(c.file?.modify || c.folder?.modify);
  $('vfs-btn-paste').disabled = !(state.clipboard && (c.file?.modify || c.folder?.modify));
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  renderBreadcrumb();
  renderList();
  renderFooter();
}

function renderBreadcrumb() {
  breadcrumbEl.innerHTML = '';
  const parts = state.cwd.split('/').filter(Boolean);
  const segments = [{ label: '/', path: '/' }];
  for (let i = 0; i < parts.length; i++) {
    segments.push({ label: parts[i], path: '/' + parts.slice(0, i + 1).join('/') });
  }
  segments.forEach((seg, idx) => {
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '›';
      breadcrumbEl.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'breadcrumb-item' + (idx === segments.length - 1 ? ' active' : '');
    btn.textContent = seg.label;
    btn.title = seg.path;
    if (idx < segments.length - 1) {
      btn.addEventListener('click', () => navigateTo(seg.path));
    }
    breadcrumbEl.appendChild(btn);
  });
  // Scroll to end
  breadcrumbEl.scrollLeft = breadcrumbEl.scrollWidth;
}

function renderList() {
  listArea.innerHTML = '';

  // Column header
  const header = document.createElement('div');
  header.id = 'vfs-col-header';
  ['colName', 'colSize', 'colModified'].forEach((key, i) => {
    const s = document.createElement('span');
    s.className = 'col-label';
    if (i > 0) s.style.textAlign = 'right';
    s.textContent = t(key);
    header.appendChild(s);
  });
  listArea.appendChild(header);

  // ".." entry for non-root directories
  if (state.cwd !== '/') {
    const parts = state.cwd.split('/').filter(Boolean);
    const parentPathVal = '/' + parts.slice(0, -1).join('/');
    const upRow = document.createElement('div');
    upRow.className = 'vfs-row';
    upRow.dataset.name = '..';
    const upName = document.createElement('div');
    upName.className = 'row-name';
    const upIcon = document.createElement('span'); upIcon.className = 'row-icon'; upIcon.textContent = '📁';
    const upLabel = document.createElement('span'); upLabel.className = 'row-label'; upLabel.textContent = '..';
    upName.append(upIcon, upLabel);
    const upSize = document.createElement('span'); upSize.className = 'row-size';
    const upDate = document.createElement('span'); upDate.className = 'row-date';
    upRow.append(upName, upSize, upDate);
    upRow.addEventListener('click', () => {
      state.selected = new Set();
      state._anchor = null;
      _syncSelectionHighlights();
      renderFooter();
      updatePreview(null);
    });
    upRow.addEventListener('dblclick', () => navigateTo(parentPathVal));
    listArea.appendChild(upRow);
  }

  const filtered = applyFilter(state.entries);

  if (filtered.length === 0) {
    const div = document.createElement('div');
    div.id = 'vfs-empty';
    const emptyIcon = document.createElement('div'); emptyIcon.className = 'empty-icon'; emptyIcon.textContent = '🗂';
    const emptyText = document.createElement('span'); emptyText.textContent = t('emptyFolder');
    div.append(emptyIcon, emptyText);
    listArea.appendChild(div);
    return;
  }

  for (const entry of filtered) {
    listArea.appendChild(buildRow(entry));
  }
}

function applyFilter(entries) {
  let result = entries;

  // Type filter (dropdown)
  if (TYPES && state.typeIndex !== null) {
    const exts = Object.values(TYPES[state.typeIndex].accept)
      .flat()
      .map(e => e.replace(/^\./, '').toLowerCase());
    result = result.filter(e => {
      if (e.kind === 'directory') return true;
      const ext = e.name.includes('.') ? e.name.split('.').pop().toLowerCase() : '';
      return exts.includes(ext);
    });
  }

  // Text filter (filename substring)
  const f = state.filter.trim().toLowerCase();
  if (f) {
    result = result.filter(e => {
      if (e.kind === 'directory') return true;
      return e.name.toLowerCase().includes(f);
    });
  }

  return result;
}

function buildRow(entry) {
  const isDir = entry.kind === 'directory';
  const entryPath = pathJoin(state.cwd, entry.name);
  const isCut = state.clipboard?.op === 'cut' &&
    state.clipboard.entries.some(e => e.path === entryPath);

  const row = document.createElement('div');
  row.className = 'vfs-row' +
    (state.selected.has(entry.name) ? ' selected' : '') +
    (isCut ? ' cut' : '');
  row.dataset.name = entry.name;
  row.dataset.kind = entry.kind;
  row.draggable = true;

  const icon = isDir ? '📁' : getFileIcon(entry.name);

  const rowName = document.createElement('div'); rowName.className = 'row-name';
  const rowIcon = document.createElement('span'); rowIcon.className = 'row-icon'; rowIcon.textContent = icon;
  const rowLabel = document.createElement('span'); rowLabel.className = 'row-label'; rowLabel.textContent = entry.name;
  rowName.append(rowIcon, rowLabel);
  const rowSize = document.createElement('span'); rowSize.className = 'row-size'; rowSize.textContent = isDir ? '' : formatSize(entry.size);
  const rowDate = document.createElement('span'); rowDate.className = 'row-date'; rowDate.textContent = isDir ? '' : formatDate(entry.lastModified);
  row.append(rowName, rowSize, rowDate);

  // Click - select (Ctrl/Meta = toggle, Shift = range, plain = single)
  row.addEventListener('click', e => {
    if (e.target.classList.contains('row-rename-input')) return;
    if (e.ctrlKey || e.metaKey) {
      _toggleSelect(entry.name);
    } else if (e.shiftKey) {
      _rangeSelect(entry.name);
    } else {
      selectEntry(entry.name, isDir ? null : entryPath);
    }
  });

  // Double-click — dirs navigate; files confirm the selection in file-pick modes.
  row.addEventListener('dblclick', e => {
    if (e.target.classList.contains('row-rename-input')) return;
    // Use the render-time `entryPath` instead of recomputing from live
    // `state.cwd`: rapid clicks on a still-visible row while a previous
    // navigation is in flight would otherwise compound the path.
    if (isDir) navigateTo(entryPath);
    else if (MODE !== 'dir' && MODE !== 'browse' && MODE !== 'save') confirmSelection();
  });

  // Context menu
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!state.selected.has(entry.name)) {
      selectEntry(entry.name, isDir ? null : entryPath);
    }
    showContextMenu(e.clientX, e.clientY, entry);
  });

  // Drag source
  row.addEventListener('dragstart', e => {
    state.dragging = entry.name;
    e.dataTransfer.effectAllowed = 'move';
    // If dragging a selected item, carry all selected paths; otherwise just this one
    const names = state.selected.has(entry.name) && state.selected.size > 1
      ? [...state.selected]
      : [entry.name];
    const paths = names.map(n => pathJoin(state.cwd, n));
    e.dataTransfer.setData('application/json', JSON.stringify(paths));
    e.dataTransfer.setData('text/plain', paths[0]);
  });

  row.addEventListener('dragend', () => { state.dragging = null; });

  // Drop target (dirs only)
  if (isDir) {
    row.addEventListener('dragover', e => {
      if (state.dragging && state.dragging !== entry.name) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const destDir = entryPath;

      let srcPaths;
      try { srcPaths = JSON.parse(e.dataTransfer.getData('application/json')); }
      catch { srcPaths = [e.dataTransfer.getData('text/plain')]; }
      srcPaths = srcPaths.filter(p => p && !p.startsWith(destDir));
      if (!srcPaths.length) return;

      await doWithStatus(t('moving'), async () => {
        for (const srcPath of srcPaths) {
          try {
            await _moveEntry(srcPath, destDir, _opts(t('moving')));
          } catch (err) {
            if (!_isConflictError(err)) throw err;
            const srcName = basename(srcPath);
            const srcKind = state.entries.find(e => e.name === srcName)?.kind ?? 'file';
            const { action } = await _promptConflict(srcName, srcKind, false);
            if (action !== 'apply') return;
            const retryExtra = srcKind === 'directory' ? { merge: true } : { overwrite: true };
            await _moveEntry(srcPath, destDir, { ..._opts(t('moving')), ...retryExtra });
          }
        }
      });
    });
  }

  return row;
}

function getFileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const map = {
    txt: '📄', md: '📝', html: '🌐', htm: '🌐', css: '🎨', js: '📜', mjs: '📜',
    ts: '📜', json: '📋', xml: '📋', csv: '📊', pdf: '📕', doc: '📘', docx: '📘',
    xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙', zip: '🗜', tar: '🗜', gz: '🗜',
    png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
    mp3: '🎵', wav: '🎵', mp4: '🎬', webm: '🎬', mov: '🎬',
  };
  return map[ext] || '📄';
}

function renderFooter() {
  openBtn.title = '';
  if (state.lockedUnavailable) {
    openBtn.disabled = true;
    return;
  }
  if (LOCK_STORAGE === 'soft' && !_isLockedConnection(state.storageRef)) {
    openBtn.disabled = true;
    openBtn.title = t('connectionLockedSoftHint');
    return;
  }
  if (MODE === 'dir') {
    // Always enabled — selects the currently open folder.
    openBtn.disabled = false;
  } else if (MODE === 'save') {
    openBtn.disabled = !saveNameInput.value.trim();
  } else if (state.selected.size === 0) {
    openBtn.disabled = true;
  } else if (MULTIPLE) {
    openBtn.disabled = ![...state.selected].every(n => state.entries.find(e => e.name === n)?.kind === 'file');
  } else {
    if (state.selected.size !== 1) { openBtn.disabled = true; return; }
    const name = [...state.selected][0];
    openBtn.disabled = state.entries.find(e => e.name === name)?.kind !== 'file';
  }
}

async function updateStorageInfo() {
  try {
    const { usage, quota } = await vfs.getStorageUsage(state.storageRef);
    if (usage == null) { storageInfoEl.textContent = ''; return; }
    const quotaStr = quota ? formatSize(quota) : null;
    storageInfoEl.textContent = quotaStr
      ? t('storageUsedOf', formatSize(usage), quotaStr)
      : t('storageUsed', formatSize(usage));
  } catch {
    storageInfoEl.textContent = '';
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

// Monotonic counter. Bumped by any operation that commits a state transition
// (navigateTo, _commitRoot). An in-flight async op records its seq at start
// and validates at commit; if the seq has moved it was superseded and must
// discard its result.
let _stateSeq = 0;

async function navigateTo(path) {
  const mySeq = ++_stateSeq;
  const myRef = state.storageRef;   // freeze against provider-switch races

  let entries;
  try {
    entries = await vfs.list({ path, storageRef: myRef }, _opts(t('loading')));
  } catch (err) {
    if (mySeq !== _stateSeq || state.storageRef !== myRef) return;
    if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
    _progressLabel = null; _progressShownAt = null;
    if (_isProviderError(err)) {
      await showDialog({
        title: err.details?.title ?? t('error', err.message),
        message: err.details?.description ?? err.message,
        buttons: [{ id: 'ok', label: t('btnOK') }],
        cancelButton: 'ok',
      });
    } else {
      showStatus(t('errorLoadDir', err.message), true);
    }
    return;
  }

  if (mySeq !== _stateSeq || state.storageRef !== myRef) return;

  // Atomic commit — cwd and entries move together so every downstream
  // handler sees a self-consistent snapshot.
  state.cwd = path;
  state.entries = entries;
  _saveIdState(path);
  state.selected = new Set();
  state._anchor = null;
  updatePreview(null);
  _clear();
  render();
  updateStorageInfo();
}

async function loadDir({ silent = false } = {}) {
  // Snapshot cwd *and* storageRef at call time. Either can change while
  // vfs.list is in flight — a delta-triggered silent refresh can race with
  // a user navigation (cwd change) or a provider switch (storageRef change).
  // Discard our result if either moved; the newer call's result should win.
  const cwdSnapshot = state.cwd;
  const refSnapshot = state.storageRef;
  const isStale = () => state.cwd !== cwdSnapshot || state.storageRef !== refSnapshot;

  try {
    const entries = await vfs.list({ path: cwdSnapshot, storageRef: refSnapshot },
                                   silent ? {} : _opts(t('loading')));
    if (isStale()) return;
    state.entries = entries;
    if (!silent) _clear();
  } catch (err) {
    if (isStale()) return;
    if (!silent) {
      if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
      _progressLabel = null; _progressShownAt = null;
    }
    state.entries = [];
    if (!silent) {
      if (_isProviderError(err)) {
        await showDialog({
          title: err.details?.title ?? t('error', err.message),
          message: err.details?.description ?? err.message,
          buttons: [{ id: 'ok', label: t('btnOK') }],
          cancelButton: 'ok',
        });
      } else {
        showStatus(t('errorLoadDir', err.message), true);
      }
    }
  }
  if (isStale()) return;
  render();
  if (!silent) updateStorageInfo();
}

// ── Selection ─────────────────────────────────────────────────────────────────

function _syncSelectionHighlights() {
  for (const row of listArea.querySelectorAll('.vfs-row')) {
    row.classList.toggle('selected', state.selected.has(row.dataset.name));
  }
}

/** Single-select: clears all others. */
function selectEntry(name, filePath) {
  state.selected = name ? new Set([name]) : new Set();
  state._anchor = name || null;
  _syncSelectionHighlights();
  if (MODE === 'save' && name && state.entries.find(e => e.name === name)?.kind === 'file') {
    saveNameInput.value = name;
  }
  renderFooter();
  updatePreview(filePath || null);
}

/** Ctrl+click: toggle one item in/out of the selection. */
function _toggleSelect(name) {
  if (state.selected.has(name)) {
    state.selected.delete(name);
  } else {
    state.selected.add(name);
    state._anchor = name;
  }
  _syncSelectionHighlights();
  renderFooter();
  // Show preview only for the single remaining file
  const single = state.selected.size === 1 ? [...state.selected][0] : null;
  const singleEntry = single ? state.entries.find(e => e.name === single) : null;
  updatePreview(singleEntry?.kind === 'file' ? pathJoin(state.cwd, single) : null);
}

/** Shift+click: select contiguous range from anchor to name. */
function _rangeSelect(name) {
  const filtered = applyFilter(state.entries);
  const anchorIdx = filtered.findIndex(e => e.name === (state._anchor ?? name));
  const targetIdx = filtered.findIndex(e => e.name === name);
  const lo = Math.min(anchorIdx, targetIdx);
  const hi = Math.max(anchorIdx, targetIdx);
  state.selected = new Set(filtered.slice(lo, hi + 1).map(e => e.name));
  _syncSelectionHighlights();
  renderFooter();
  updatePreview(null);
}

// ── Preview file type sets ────────────────────────────────────────────────────

const _IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
const _AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
const _VIDEO_EXTS = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
const _TEXT_EXTS = ['txt', 'md', 'markdown', 'html', 'htm', 'css', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'json', 'json5', 'xml', 'yaml', 'yml', 'csv',
  'ini', 'toml', 'sh', 'bash', 'py', 'rb', 'rs', 'go', 'java', 'c',
  'cpp', 'h', 'hpp', 'sql', 'log', 'diff', 'patch', 'gitignore',
  'env', 'conf', 'cfg'];

// ── Preview ────────────────────────────────────────────────────────────────────

let _previewObjectUrl = null;

function _revokePreviewUrl() {
  if (_previewObjectUrl) {
    URL.revokeObjectURL(_previewObjectUrl);
    _previewObjectUrl = null;
  }
}

function _showPreviewPlaceholder(text) {
  const el = document.createElement('div');
  el.id = 'vfs-preview-placeholder';
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  previewEl.replaceChildren(el);
}

async function updatePreview(filePath) {
  _revokePreviewUrl();

  if (!filePath) {
    _showPreviewPlaceholder(t('noFileSelected'));
    return;
  }

  const name = filePath.split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';

  const previewContent = document.createElement('div'); previewContent.id = 'vfs-preview-content';
  const previewBody = document.createElement('div'); previewBody.id = 'vfs-preview-body';
  previewContent.appendChild(previewBody);
  previewEl.replaceChildren(previewContent);

  const body = previewBody;

  // Skip read for large files - size is known from the directory listing
  const MAX_PREVIEW_SIZE = 5 * 1024 * 1024;
  const knownEntry = state.entries.find(e => pathJoin(state.cwd, e.name) === filePath);
  if (knownEntry?.size != null && knownEntry.size > MAX_PREVIEW_SIZE) {
    _showLargeFileNotice(body, filePath, name, ext, knownEntry.size);
    return;
  }

  try {
    const file = await vfs.readFile(_e(filePath), _opts(t('loading')));
    _clear();
    await _renderPreviewContent(body, file, name, ext);
  } catch (err) {
    _clear();
    const failMeta = document.createElement('div'); failMeta.className = 'preview-meta';
    const failMsg = document.createElement('div'); failMsg.textContent = t('previewLoadFailed');
    failMeta.appendChild(failMsg);
    body.replaceChildren(failMeta);
  }
}

function _showLargeFileNotice(body, filePath, name, ext, size) {
  const noticeMeta = document.createElement('div'); noticeMeta.className = 'preview-meta';
  const noticeIcon = document.createElement('div'); noticeIcon.className = 'preview-icon'; noticeIcon.textContent = getFileIcon(name);
  const noticeName = document.createElement('div'); noticeName.textContent = name;
  const noticeSize = document.createElement('div'); noticeSize.textContent = formatSize(size);
  const noticeSkip = document.createElement('div'); noticeSkip.style.fontSize = '11px'; noticeSkip.textContent = t('previewSkipped');
  noticeMeta.append(noticeIcon, noticeName, noticeSize, noticeSkip);
  body.replaceChildren(noticeMeta);
  const btn = document.createElement('button');
  btn.className = 'btn-secondary';
  btn.style.cssText = 'margin-top:10px;font-size:11px;padding:4px 12px;';
  btn.textContent = t('previewAnyway');
  btn.addEventListener('click', async () => {
    _showPreviewPlaceholder(t('loading'));
    try {
      const file = await vfs.readFile(_e(filePath), _opts(t('loading')));
      _clear();
      const content = document.createElement('div');
      content.id = 'vfs-preview-content';
      const newBody = document.createElement('div');
      newBody.id = 'vfs-preview-body';
      content.appendChild(newBody);
      previewEl.replaceChildren(content);
      await _renderPreviewContent(newBody, file, name, ext);
    } catch (err) {
      _clear();
      _showPreviewPlaceholder(t('previewLoadFailed'));
    }
  });
  noticeMeta.appendChild(btn);
}

async function _renderPreviewContent(body, file, name, ext) {
  // Do all async work FIRST so whatever is in body stays visible during loading.
  // Only clear body once content is ready.
  _revokePreviewUrl();

  let insert;

  if (_IMAGE_EXTS.includes(ext)) {
    _previewObjectUrl = URL.createObjectURL(file);
    const img = document.createElement('img');
    img.src = _previewObjectUrl;
    img.alt = name;
    insert = () => body.appendChild(img);

  } else if (_AUDIO_EXTS.includes(ext)) {
    _previewObjectUrl = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.src = _previewObjectUrl;
    audio.controls = true;
    insert = () => body.appendChild(audio);

  } else if (_VIDEO_EXTS.includes(ext)) {
    _previewObjectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = _previewObjectUrl;
    video.controls = true;
    insert = () => body.appendChild(video);

  } else if (ext === 'html' || ext === 'htm') {
    _previewObjectUrl = URL.createObjectURL(file);
    const iframe = document.createElement('iframe');
    iframe.src = _previewObjectUrl;
    iframe.setAttribute('sandbox', ''); // no scripts, no navigation
    insert = () => body.appendChild(iframe);

  } else if (_TEXT_EXTS.includes(ext)) {
    const text = await file.text();
    const pre = document.createElement('pre');
    pre.textContent = text;
    insert = () => body.appendChild(pre);

  } else {
    const nopMeta = document.createElement('div'); nopMeta.className = 'preview-meta';
    const nopIcon = document.createElement('div'); nopIcon.className = 'preview-icon'; nopIcon.textContent = getFileIcon(name);
    const nopName = document.createElement('div'); nopName.textContent = name;
    const nopSize = document.createElement('div'); nopSize.textContent = formatSize(file.size);
    const nopMsg = document.createElement('div'); nopMsg.style.fontSize = '11px'; nopMsg.textContent = t('noPreview');
    nopMeta.append(nopIcon, nopName, nopSize, nopMsg);
    insert = () => body.replaceChildren(nopMeta);
  }

  body.innerHTML = '';
  insert();
}

async function confirmSelection() {
  if (MODE === 'browse') return; // no selection in browse mode
  if (state.lockedUnavailable) return;
  if (LOCK_STORAGE === 'soft' && !_isLockedConnection(state.storageRef)) return;
  if (MODE === 'dir') {
    // Select the currently open folder.
    sendResult({ path: state.cwd, name: state.cwd.split('/').filter(Boolean).pop() || '', kind: 'directory', storageRef: state.storageRef });
  } else if (MODE === 'save') {
    const name = saveNameInput.value.trim();
    if (!name) return;
    const exists = state.entries.some(e => e.name === name && e.kind === 'file');
    if (exists) {
      const { button } = await showDialog({
        title: t('dialogTitleOverwrite'),
        message: t('overwriteConfirm', name),
        buttons: [
          { id: 'cancel', label: t('btnCancel') },
          { id: 'overwrite', label: t('btnOverwrite') },
        ],
        cancelButton: 'cancel',
      });
      if (button !== 'overwrite') return;
    }
    sendResult({ path: pathJoin(state.cwd, name), name, kind: 'file', storageRef: state.storageRef });
  } else {
    const results = [...state.selected]
      .map(n => state.entries.find(e => e.name === n))
      .filter(e => e?.kind === 'file')
      .map(e => ({ ...e, storageRef: state.storageRef }));
    if (results.length === 0) return;
    if (!MULTIPLE && results.length !== 1) return;
    sendResult(results);
  }
}

// ── Context Menu ──────────────────────────────────────────────────────────────

function showContextMenu(x, y, entry) {
  contextMenu.innerHTML = '';
  const isDir = entry.kind === 'directory';
  const entryPath = pathJoin(state.cwd, entry.name);

  const items = [];

  if (!isDir) {
    if (MODE !== 'dir' && MODE !== 'browse') items.push({ label: '✅ ' + t('ctxSelect'), action: () => confirmSelection(), disabled: !MULTIPLE && state.selected.size > 1 });
    items.push({ label: '💾 ' + t('ctxSaveAs'), action: () => saveAsLocal(entryPath, entry.name) });
    items.push(null); // separator
  } else {
    items.push({ label: '📂 ' + t('ctxOpen'), action: () => navigateTo(entryPath) });
    items.push(null);
  }

  const c = state.capabilities || { file: {}, folder: {} };
  const canModify = isDir ? c.folder?.modify : c.file?.modify;
  const canDelete = isDir ? c.folder?.delete : c.file?.delete;

  if (state.selected.size > 1) {
    const selEntries = [...state.selected].map(n => state.entries.find(e => e.name === n)).filter(Boolean);
    items.push({ label: '✂️ ' + t('ctxCutMany', state.selected.size), action: () => clipboardCut(selEntries), disabled: !canModify });
    items.push({ label: '📑 ' + t('ctxCopyMany', state.selected.size), action: () => clipboardCopy(selEntries), disabled: !canModify });
    if (state.clipboard) {
      items.push({ label: '📌 ' + t('ctxPaste'), action: () => pasteClipboard(), disabled: !canModify });
    }
    items.push(null);
    items.push({ label: '🗑 ' + t('ctxDeleteMany', state.selected.size), action: () => confirmDeleteSelected(), danger: true, disabled: !canDelete });
  } else {
    items.push({ label: '✏️ ' + t('ctxRename'), action: () => startRename(entry.name), disabled: !canModify });
    items.push({ label: '✂️ ' + t('ctxCut'), action: () => clipboardCut([entry]), disabled: !canModify });
    items.push({ label: '📑 ' + t('ctxCopy'), action: () => clipboardCopy([entry]), disabled: !canModify });
    if (state.clipboard) {
      items.push({ label: '📌 ' + t('ctxPaste'), action: () => pasteClipboard(), disabled: !canModify });
    }
    items.push(null);
    items.push({ label: '🗑 ' + t('ctxDelete'), action: () => confirmDelete(entry.name, entryPath, isDir), danger: true, disabled: !canDelete });
  }

  for (const item of items) {
    if (item === null) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      contextMenu.appendChild(sep);
    } else {
      const el = document.createElement('div');
      el.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
      el.textContent = item.label;
      if (!item.disabled) {
        el.addEventListener('click', () => { hideContextMenu(); item.action(); });
      }
      contextMenu.appendChild(el);
    }
  }

  contextMenu.classList.add('visible');

  // Position - keep inside viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = 170, ch = contextMenu.scrollHeight;
  const cx = x + cw > vw ? vw - cw - 6 : x;
  const cy = y + ch > vh ? vh - ch - 6 : y;
  contextMenu.style.left = cx + 'px';
  contextMenu.style.top = cy + 'px';
}

function hideContextMenu() {
  contextMenu.classList.remove('visible');
}

function showBgContextMenu(x, y) {
  if (!state.clipboard) return;
  const canPaste = state.capabilities?.folder?.modify ?? true;
  contextMenu.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'ctx-item' + (canPaste ? '' : ' disabled');
  el.textContent = '📌 ' + t('ctxPaste');
  if (canPaste) el.addEventListener('click', () => { hideContextMenu(); pasteClipboard(); });
  contextMenu.appendChild(el);
  contextMenu.classList.add('visible');
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = 170, ch = contextMenu.scrollHeight;
  contextMenu.style.left = (x + cw > vw ? vw - cw - 6 : x) + 'px';
  contextMenu.style.top = (y + ch > vh ? vh - ch - 6 : y) + 'px';
}

// ── Save As ───────────────────────────────────────────────────────────────────

async function saveAsLocal(filePath, name) {
  await doWithStatus(t('preparingDownload'), async () => {
    const file = await vfs.readFile(_e(filePath), _opts(t('preparingDownload')));
    const url = URL.createObjectURL(file);
    try {
      await browser.downloads.download({ url, filename: name, saveAs: true });
    } finally {
      // Revoke after a short delay to let the browser fetch the blob URL
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  });
}

// ── Progress / status state ────────────────────────────────────────────────────

let _busy = false;
let _cancelRequested = false;
let _progressLabel = null;
let _progressTimer = null;
let _progressShownAt = null;
let _progressMode = 'spinner'; // 'spinner' | 'bar'
let _progressPercent = null;
let _progressFileInfo = null;
let _pendingStatusClear = null;
let _unlockCallback = null;

let _statusSpinnerEl = null;
let _statusLabelEl = null;
let _statusFileInfoEl = null;
let _statusProgressEl = null;
let _statusCancelEl = null;

function _cancelPendingClear() {
  if (_pendingStatusClear) { clearTimeout(_pendingStatusClear); _pendingStatusClear = null; }
}

function _clearStatusAfter(ms) {
  _cancelPendingClear();
  const run = () => {
    _pendingStatusClear = null;
    _showIdleStatus();
    const cb = _unlockCallback; _unlockCallback = null; cb?.();
  };
  if (ms <= 0) { run(); return; }
  _pendingStatusClear = setTimeout(run, ms);
}

// When no progress or transient message is active, either clear the status bar
// or — when the picker is locked to a different/unavailable connection — show
// the lock banner so the user always knows why actions are restricted.
function _showIdleStatus() {
  if (state.lockedUnavailable) {
    showStatus(t('connectionLockedUnavailable', state.lockedLabel ?? LOCKED_REF?.providerId ?? ''), true);
  } else if (LOCK_STORAGE === 'soft' && !_isLockedConnection(state.storageRef)) {
    showStatus(t('connectionLockedSoftStatus', state.lockedLabel ?? LOCKED_REF?.providerId ?? ''), true);
  } else {
    showStatus('');
  }
}

function _doShow() {
  if (!_progressLabel) return;
  _progressShownAt ??= Date.now();
  if (_progressMode === 'bar' && _progressPercent != null) {
    showProgress(_progressLabel, { percent: _progressPercent, ..._progressFileInfo });
  } else {
    showStatusSpinner(_progressLabel);
  }
}

function _startProgress(label, currentFile, totalFiles) {
  if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
  _progressLabel = label;
  _progressMode = 'spinner';
  _progressPercent = null;
  if (currentFile != null) _progressFileInfo = { currentFile, totalFiles };
  _progressTimer = setTimeout(() => { _progressTimer = null; _doShow(); }, 150);
}

function _switchToBar(percent) {
  _progressMode = 'bar';
  _progressPercent = percent;
  if (_progressShownAt != null) _doShow();
}

function _clear() {
  if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
  _progressLabel = null;
  _progressMode = 'spinner';
  _progressPercent = null;
  _progressFileInfo = null;
  if (_progressShownAt == null) {
    _showIdleStatus();
    const cb = _unlockCallback; _unlockCallback = null; cb?.();
    return;
  }
  const residual = 300 - (Date.now() - _progressShownAt);
  _progressShownAt = null;
  _clearStatusAfter(residual);
}

function _initStatusBar() {
  const el = $('vfs-status');
  if (!el) return;
  _statusSpinnerEl = document.createElement('span');
  _statusSpinnerEl.className = 'vfs-status-spinner';
  _statusSpinnerEl.hidden = true;
  _statusLabelEl = document.createElement('span');
  _statusFileInfoEl = document.createElement('span');
  _statusFileInfoEl.style.fontVariantNumeric = 'tabular-nums';
  _statusFileInfoEl.style.marginLeft = '4px';
  _statusFileInfoEl.hidden = true;
  _statusProgressEl = document.createElement('progress');
  _statusProgressEl.className = 'vfs-progress';
  _statusProgressEl.max = 100;
  _statusProgressEl.style.marginLeft = '4px';
  _statusProgressEl.hidden = true;
  _statusCancelEl = document.createElement('button');
  _statusCancelEl.className = 'vfs-cancel-op';
  _statusCancelEl.title = t('btnCancel');
  _statusCancelEl.textContent = '✕';
  _statusCancelEl.style.marginLeft = '4px';
  _statusCancelEl.hidden = true;
  el.replaceChildren(_statusLabelEl, _statusSpinnerEl, _statusProgressEl, _statusFileInfoEl, _statusCancelEl);
}

function _updateStatusFileInfo() {
  if (!_statusFileInfoEl) return;
  const show = _progressFileInfo && _progressFileInfo.totalFiles > 1;
  _statusFileInfoEl.hidden = !show;
  if (show) _statusFileInfoEl.textContent = `${_progressFileInfo.currentFile}/${_progressFileInfo.totalFiles}`;
}

function showStatus(msg, isError = false) {
  _cancelPendingClear();
  const el = $('vfs-status');
  if (!el) return;
  if (_statusSpinnerEl) _statusSpinnerEl.hidden = true;
  if (_statusProgressEl) _statusProgressEl.hidden = true;
  if (_statusFileInfoEl) _statusFileInfoEl.hidden = true;
  if (_statusCancelEl) _statusCancelEl.hidden = true;
  if (_statusLabelEl) _statusLabelEl.textContent = msg;
  else el.textContent = msg;
  el.style.color = isError ? 'var(--vfs-danger)' : 'var(--vfs-text-muted)';
}

function showStatusSpinner(label) {
  _cancelPendingClear();
  const el = $('vfs-status');
  if (!el) return;
  if (_statusSpinnerEl) _statusSpinnerEl.hidden = false;
  if (_statusLabelEl) _statusLabelEl.textContent = label;
  if (_statusProgressEl) _statusProgressEl.hidden = true;
  if (_statusCancelEl) _statusCancelEl.hidden = false;
  _updateStatusFileInfo();
  el.style.color = 'var(--vfs-text-muted)';
}

function showProgress(label, { percent, currentFile, totalFiles } = {}) {
  _cancelPendingClear();
  const el = $('vfs-status');
  if (!el) return;
  if (currentFile && totalFiles) _progressFileInfo = { currentFile, totalFiles };
  if (_statusSpinnerEl) _statusSpinnerEl.hidden = true;
  if (_statusLabelEl) _statusLabelEl.textContent = percent != null ? label : label + '…';
  if (_statusProgressEl) {
    _statusProgressEl.hidden = percent == null;
    if (percent != null) _statusProgressEl.value = percent;
  }
  if (_statusCancelEl) _statusCancelEl.hidden = false;
  _updateStatusFileInfo();
  el.style.color = 'var(--vfs-text-muted)';
}

// ── Operations ────────────────────────────────────────────────────────────────

async function doWithStatus(msg, fn) {
  if (_busy) return;
  _busy = true;
  _cancelRequested = false;
  _progressFileInfo = null;
  $('vfs-busy-overlay').classList.add('active');
  cancelBtn.disabled = true;
  openBtn.disabled = true;
  _unlockCallback = () => {
    $('vfs-busy-overlay').classList.remove('active');
    cancelBtn.disabled = false;
    renderFooter();
  };
  _startProgress(msg);
  try {
    await fn();
    _clear();
  } catch (err) {
    if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
    _progressLabel = null; _progressShownAt = null; _progressFileInfo = null;
    const cb = _unlockCallback; _unlockCallback = null; cb?.();
    if (err.name === 'AbortError') {
      showStatus(t('cancelled'));
      setTimeout(_showIdleStatus, 2000);
    } else if (_isProviderError(err)) {
      await showDialog({
        title: err.details?.title ?? t('error', err.message),
        message: err.details?.description ?? err.message,
        buttons: [{ id: 'ok', label: t('btnOK') }],
        cancelButton: 'ok',
      });
    } else {
      showStatus(t('error', err.message), true);
      console.error(err);
    }
  } finally {
    _busy = false;
    _cancelRequested = false;
  }
}

/** Inline rename: replaces the label with an input field. */
function startRename(name) {
  const row = listArea.querySelector(`.vfs-row[data-name="${CSS.escape(name)}"]`);
  if (!row) return;
  const labelEl = row.querySelector('.row-label');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'row-rename-input';
  input.value = name;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  const finish = async () => {
    const newName = input.value.trim();
    if (!newName || newName === name) {
      renderList();
      return;
    }
    const srcPath = pathJoin(state.cwd, name);
    const destPath = pathJoin(state.cwd, newName);
    const isDir = state.entries.find(e => e.name === name)?.kind === 'directory';
    await doWithStatus(t('renaming'), async () => {
      try {
        await (isDir
          ? vfs.moveFolder(_e(srcPath), _e(destPath), _opts(t('renaming')))
          : vfs.moveFile(_e(srcPath), _e(destPath), _opts(t('renaming'))));
      } catch (err) {
        if (!_isConflictError(err)) throw err;
        const { action } = await _promptConflict(newName, isDir ? 'directory' : 'file', false);
        if (action !== 'apply') return;
        await (isDir
          ? vfs.moveFolder(_e(srcPath), _e(destPath), { ..._opts(t('renaming')), merge: true })
          : vfs.moveFile(_e(srcPath), _e(destPath), { ..._opts(t('renaming')), overwrite: true }));
      }
    });
    if (state.selected.has(name)) {
      state.selected.delete(name);
      state.selected.add(newName);
      if (state._anchor === name) state._anchor = newName;
    }
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    if (e.key === 'Escape') { renderList(); }
  });
  input.addEventListener('blur', finish);
}

async function confirmDelete(name, path, isDir) {
  const msg = isDir ? t('deleteConfirmFolder', name) : t('deleteConfirmFile', name);
  const { button } = await showDialog({
    title: t('dialogTitleDelete'),
    message: msg,
    buttons: [
      { id: 'cancel', label: t('btnCancel') },
      { id: 'delete', label: t('btnDelete') },
    ],
    cancelButton: 'cancel',
  });
  if (button !== 'delete') return;
  await doWithStatus(t('deleting'), () =>
    isDir ? vfs.deleteFolder(_e(path), _opts(t('deleting'))) : vfs.deleteFile(_e(path), _opts(t('deleting')))
  );
  state.selected.delete(name);
  if (state._anchor === name) state._anchor = null;
  if (state.selected.size === 0) updatePreview(null);
}

async function confirmDeleteSelected() {
  const names = [...state.selected];
  if (names.length === 0) return;
  const msg = names.length === 1
    ? (state.entries.find(e => e.name === names[0])?.kind === 'directory'
      ? t('deleteConfirmFolder', names[0]) : t('deleteConfirmFile', names[0]))
    : t('deleteConfirmMany', names.length);
  const { button } = await showDialog({
    title: t('dialogTitleDelete'),
    message: msg,
    buttons: [
      { id: 'cancel', label: t('btnCancel') },
      { id: 'delete', label: t('btnDelete') },
    ],
    cancelButton: 'cancel',
  });
  if (button !== 'delete') return;
  const total = names.length;
  await doWithStatus(t('deleting'), async () => {
    for (let i = 0; i < names.length; i++) {
      const entry = state.entries.find(e => e.name === names[i]);
      if (!entry) continue;
      const p = pathJoin(state.cwd, names[i]);
      await (entry.kind === 'directory' ? vfs.deleteFolder(_e(p), _opts(t('deleting'), i + 1, total)) : vfs.deleteFile(_e(p), _opts(t('deleting'), i + 1, total)));
    }
  });
  state.selected = new Set();
  state._anchor = null;
  updatePreview(null);
}

function _moveEntry(srcPath, destDirPath, opts = {}) {
  const destPath = pathJoin(destDirPath, basename(srcPath));
  const kind = state.entries.find(e => pathJoin(state.cwd, e.name) === srcPath)?.kind;
  return kind === 'directory'
    ? vfs.moveFolder(_e(srcPath), _e(destPath), opts)
    : vfs.moveFile(_e(srcPath), _e(destPath), opts);
}

function clipboardCut(entries) {
  state.clipboard = { entries, op: 'cut', storageRef: state.storageRef };
  $('vfs-btn-paste').disabled = false;
  showStatus(entries.length === 1 ? t('cutOne', entries[0].name) : t('cutMany', entries.length));
  renderList();
}

function clipboardCopy(entries) {
  state.clipboard = { entries, op: 'copy', storageRef: state.storageRef };
  $('vfs-btn-paste').disabled = false;
  showStatus(entries.length === 1 ? t('copiedOne', entries[0].name) : t('copiedMany', entries.length));
}

/**
 * Paste a single directory entry using per-entry individual operations.
 * Drives the picker progress display directly: spinner with growing counter
 * during collection, then a 0→100 bar during processing.
 */
async function _pasteFolder(src, dest, op, merge) {
  const fn = op === 'copy' ? vfs.copyFolderWithProgress : vfs.moveFolderWithProgress;
  await fn(src, dest, {
    merge,
    onCollect: total => {
      if (_cancelRequested) throw new DOMException('Cancelled', 'AbortError');
      _progressFileInfo = { currentFile: 0, totalFiles: total };
      if (_progressShownAt != null) _doShow();
    },
    onProgress: p => {
      if (_cancelRequested) throw new DOMException('Cancelled', 'AbortError');
      _progressFileInfo = { currentFile: p.currentFile, totalFiles: p.totalFiles };
      _switchToBar(p.percent);
    },
  });
}

async function pasteClipboard() {
  if (!state.clipboard) return;
  const { entries, op, storageRef: srcRef } = state.clipboard;
  const total = entries.length;
  const label = op === 'copy' ? t('copying') : t('moving');
  await doWithStatus(label, async () => {
    let batchDecision = null; // null | 'skip-all' | 'apply-all'
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const destPath = pathJoin(state.cwd, entry.name);
      const remaining = entries.length - i;

      if (batchDecision === 'skip-all') continue;

      const extraOpts = batchDecision === 'apply-all'
        ? (entry.kind === 'directory' ? { merge: true } : { overwrite: true })
        : {};
      const opts = { ..._opts(label, i + 1, total), ...extraOpts };

      const src = { path: entry.path, storageRef: srcRef };

      if (entry.kind === 'directory') {
        // Folder paste: decompose into individual per-entry operations so the picker
        // can show an accurate aggregate progress bar via onCollect / onProgress.
        const merge = batchDecision === 'apply-all';
        try {
          await _pasteFolder(src, _e(destPath), op, merge);
        } catch (err) {
          if (!_isConflictError(err)) throw err;
          const { action, applyToAll } = await _promptConflict(entry.name, entry.kind, remaining > 1);
          if (action === 'cancel') throw new DOMException('Cancelled', 'AbortError');
          if (action === 'skip') { if (applyToAll) batchDecision = 'skip-all'; continue; }
          if (applyToAll) batchDecision = 'apply-all';
          await _pasteFolder(src, _e(destPath), op, true);
        }
      } else {
        const doOp = o => op === 'copy'
          ? vfs.copyFile(src, _e(destPath), o)
          : vfs.moveFile(src, _e(destPath), o);
        try {
          await doOp(opts);
        } catch (err) {
          if (!_isConflictError(err)) throw err;
          const { action, applyToAll } = await _promptConflict(entry.name, entry.kind, remaining > 1);
          if (action === 'cancel') throw new DOMException('Cancelled', 'AbortError');
          if (action === 'skip') { if (applyToAll) batchDecision = 'skip-all'; continue; }
          if (applyToAll) batchDecision = 'apply-all';
          await doOp({ ..._opts(label, i + 1, total), overwrite: true });
        }
      }
    }
    state.clipboard = null;
    $('vfs-btn-paste').disabled = true;
    renderList();
  });
}

// ── New Folder Dialog ─────────────────────────────────────────────────────────

function showNewFolderDialog() {
  showPromptDialog(t('newFolderTitle'), t('newFolderLabel'), t('newFolderDefault'), async name => {
    if (!name) return;
    const newPath = pathJoin(state.cwd, name);
    await doWithStatus(t('creatingFolder'), async () => {
      try {
        await vfs.addFolder(_e(newPath), _opts(t('creatingFolder')));
      } catch (err) {
        if (_isConflictError(err)) {
          await showDialog({ title: t('dialogTitleConflict'), message: t('folderAlreadyExists', name), buttons: [{ id: 'ok', label: t('btnOK') }], cancelButton: 'ok' });
          return;
        }
        throw err;
      }
    });
  });
}

// ── Prompt Dialog ─────────────────────────────────────────────────────────────

function showPromptDialog(title, label, defaultValue, onConfirm) {
  const backdrop = document.createElement('div');
  backdrop.className = 'vfs-dialog-backdrop';

  const dialog = document.createElement('div');
  dialog.className = 'vfs-dialog';

  const h = document.createElement('h3');
  h.textContent = title;

  const p = document.createElement('p');
  p.textContent = label;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue;

  const btns = document.createElement('div');
  btns.className = 'vfs-dialog-buttons';

  const cancelB = document.createElement('button');
  cancelB.className = 'btn-secondary';
  cancelB.textContent = t('btnCancel');
  cancelB.addEventListener('click', () => backdrop.remove());

  const okB = document.createElement('button');
  okB.className = 'btn-primary';
  okB.textContent = t('btnOK');

  const confirm = async () => {
    const value = input.value.trim();
    backdrop.remove();
    await onConfirm(value);
  };

  okB.addEventListener('click', confirm);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') backdrop.remove();
  });

  btns.appendChild(cancelB);
  btns.appendChild(okB);

  dialog.appendChild(h);
  dialog.appendChild(p);
  dialog.appendChild(input);
  dialog.appendChild(btns);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  // Focus & select after mount
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

/**
 * Shows a custom modal dialog and returns a Promise that resolves with
 * { button: string, checked: boolean|null } when the user responds.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {{ label: string }} [opts.checkbox]
 * @param {{ id: string, label: string }[]} opts.buttons  - rendered left→right
 * @param {string} opts.cancelButton - id of the button treated as cancel
 */
function _showToast(message) {
  const backdrop = document.createElement('div');
  backdrop.className = 'vfs-dialog-backdrop';

  const toast = document.createElement('div');
  toast.className = 'vfs-toast';

  const spinner = document.createElement('span');
  spinner.className = 'vfs-dialog-spinner';

  const label = document.createElement('span');
  label.textContent = message;

  toast.append(spinner, label);
  backdrop.appendChild(toast);
  document.body.appendChild(backdrop);

  return () => backdrop.remove();
}

function showDialog({ title, message, checkbox = null, buttons, cancelButton }) {
  if (!buttons.some(b => b.id === cancelButton))
    throw new Error(`cancelButton "${cancelButton}" not found in buttons`);

  return new Promise(resolve => {
    let checkboxEl = null;

    const finish = id => {
      document.removeEventListener('keydown', keyHandler);
      backdrop.remove();
      resolve({ button: id, checked: checkboxEl ? checkboxEl.checked : null });
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'vfs-dialog-backdrop';
    backdrop.addEventListener('click', e => { if (e.target === backdrop) finish(cancelButton); });

    const dialog = document.createElement('div');
    dialog.className = 'vfs-dialog';

    const h = document.createElement('h3');
    h.textContent = title;
    dialog.appendChild(h);

    const p = document.createElement('p');
    p.textContent = message;
    dialog.appendChild(p);

    if (checkbox) {
      const lbl = document.createElement('label');
      lbl.className = 'vfs-dialog-checkbox';
      checkboxEl = document.createElement('input');
      checkboxEl.type = 'checkbox';
      lbl.appendChild(checkboxEl);
      lbl.appendChild(document.createTextNode(' ' + checkbox.label));
      dialog.appendChild(lbl);
    }

    const btns = document.createElement('div');
    btns.className = 'vfs-dialog-buttons';
    for (const btn of buttons) {
      const el = document.createElement('button');
      el.className = btn.id === cancelButton ? 'btn-secondary' : 'btn-primary';
      el.textContent = btn.label;
      el.addEventListener('click', () => finish(btn.id));
      btns.appendChild(el);
    }
    dialog.appendChild(btns);
    backdrop.appendChild(dialog);

    const keyHandler = e => { if (e.key === 'Escape') finish(cancelButton); };
    document.addEventListener('keydown', keyHandler);
    document.body.appendChild(backdrop);
  });
}

function _isConflictError(err) {
  return err.code === 'E:EXIST';
}

function _isProviderError(err) {
  return err.code === 'E:PROVIDER';
}

async function _promptConflict(name, kind, isBatch) {
  const actionLabel = kind === 'directory' ? t('btnMerge') : t('btnOverwrite');
  const buttons = isBatch
    ? [{ id: 'cancel', label: t('btnCancel') },
    { id: 'skip', label: t('btnSkip') },
    { id: 'apply', label: actionLabel }]
    : [{ id: 'cancel', label: t('btnCancel') },
    { id: 'apply', label: actionLabel }];
  const { button, checked } = await showDialog({
    title: t('dialogTitleConflict'),
    message: t('conflictMessage', name),
    checkbox: isBatch ? { label: t('applyToAll') } : null,
    buttons,
    cancelButton: 'cancel',
  });
  return { action: button, applyToAll: checked ?? false };
}

// ── Store files ───────────────────────────────────────────────────────────────

async function handleStoreFiles(files) {
  const total = files.length;
  await doWithStatus(t('storing'), async () => {
    let batchDecision = null; // null | 'skip-all' | 'overwrite-all'
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const destPath = pathJoin(state.cwd, file.name);
      const remaining = files.length - i;

      if (batchDecision === 'skip-all') continue;

      const overwrite = batchDecision === 'overwrite-all';
      try {
        await vfs.writeFile(_e(destPath), file, {
          ..._opts(t('storing'), i + 1, total),
          overwrite,
        });
      } catch (err) {
        if (!_isConflictError(err)) throw err;
        const { action, applyToAll } = await _promptConflict(file.name, 'file', remaining > 1);
        if (action === 'cancel') throw new DOMException('Cancelled', 'AbortError');
        if (action === 'skip') { if (applyToAll) batchDecision = 'skip-all'; continue; }
        // action === 'apply' - overwrite
        if (applyToAll) batchDecision = 'overwrite-all';
        await vfs.writeFile(_e(destPath), file, {
          ..._opts(t('storing'), i + 1, total),
          overwrite: true,
        });
      }
    }
  });
}

// ── Toolbar wiring ────────────────────────────────────────────────────────────

function initToolbar() {
  $('vfs-btn-new-folder').addEventListener('click', showNewFolderDialog);

  $('vfs-btn-store').addEventListener('click', () => fileInputEl.click());

  fileInputEl.addEventListener('change', async () => {
    if (fileInputEl.files.length) {
      await handleStoreFiles(Array.from(fileInputEl.files));
      fileInputEl.value = '';
    }
  });

  $('vfs-btn-rename').addEventListener('click', () => {
    if (state.selected.size === 1) startRename([...state.selected][0]);
  });

  $('vfs-btn-delete').addEventListener('click', async () => {
    if (state.selected.size > 0) await confirmDeleteSelected();
  });

  $('vfs-btn-cut').addEventListener('click', () => {
    if (state.selected.size > 0)
      clipboardCut([...state.selected].map(n => state.entries.find(e => e.name === n)).filter(Boolean));
  });

  $('vfs-btn-copy').addEventListener('click', () => {
    if (state.selected.size > 0)
      clipboardCopy([...state.selected].map(n => state.entries.find(e => e.name === n)).filter(Boolean));
  });

  $('vfs-btn-paste').addEventListener('click', () => pasteClipboard());

  // Custom buttons — rendered from the 'buttons' URL param, separated from built-in
  // toolbar buttons. Each click sends { type: 'vfs-toolkit-button', buttonId } to the
  // client extension background, which can then open a tab or take any other action.
  if (BUTTONS.length) {
    const container = $('vfs-custom-buttons');
    const sep = document.createElement('div');
    sep.className = 'toolbar-sep';
    container.appendChild(sep);
    for (const { id, label, icon } of BUTTONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      if (icon) {
        // Fetch and inline the SVG so it inherits currentColor, matching built-in toolbar buttons.
        fetch(icon).then(r => r.text()).then(svgText => {
          const svg = new DOMParser().parseFromString(svgText.trim(), 'image/svg+xml').querySelector('svg');
          if (svg) {
            svg.setAttribute('width', '14');
            svg.setAttribute('height', '14');
            svg.setAttribute('aria-hidden', 'true');
            btn.appendChild(svg);
          } else {
            btn.textContent = label;
          }
        }).catch(() => { btn.textContent = label; });
      } else {
        btn.textContent = label;
      }
      btn.addEventListener('click', () => {
        browser.runtime.sendMessage({ type: 'vfs-toolkit-button', buttonId: id, storageRef: state.storageRef }).catch(() => {});
      });
      container.appendChild(btn);
    }
  }

  // Type dropdown (only when types were provided by the caller)
  if (TYPES?.length) {
    const select = document.createElement('select');
    select.id = 'vfs-type-select';

    if (!EXCLUDE_ACCEPT_ALL) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t('typeFilterAll');
      select.appendChild(opt);
    }

    TYPES.forEach((type, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = type.description ||
        Object.values(type.accept).flat().join(', ');
      select.appendChild(opt);
    });

    select.value = state.typeIndex !== null ? String(state.typeIndex) : '';
    select.addEventListener('change', () => {
      state.typeIndex = select.value === '' ? null : Number(select.value);
      renderList();
    });

    $('vfs-filter-wrap').parentNode.appendChild(select);
  }

  // Text filter
  filterInput.addEventListener('input', () => {
    state.filter = filterInput.value;
    renderList();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function _pickIconUrl(icons) {
  if (!icons) return null;
  const entries = Array.isArray(icons)
    ? icons.map(i => ({ size: i.size, url: i.url }))
    : Object.entries(icons).map(([size, url]) => ({ size: parseInt(size), url }));
  if (!entries.length) return null;
  entries.sort((a, b) => a.size - b.size);
  return (entries.find(e => e.size >= 32) ?? entries[entries.length - 1]).url;
}

function _getOwnIconUrl() {
  const path = _pickIconUrl(browser.runtime.getManifest().icons);
  return path ? browser.runtime.getURL(path) : null;
}

let _opfsIcon = null;

// Fallback icon for extensions that don't supply their own.
const _FALLBACK_ICON = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#888" stroke-width="1.2" stroke-linecap="round">' +
  '<ellipse cx="8" cy="4.5" rx="5" ry="1.8"/>' +
  '<path d="M3 4.5v7c0 1 2.24 1.8 5 1.8s5-.8 5-1.8v-7"/>' +
  '<path d="M3 8c0 1 2.24 1.8 5 1.8S13 9 13 8"/>' +
  '</svg>'
)}`;

/** Set element content to an optional icon img followed by a text node. Stores label/icon in dataset. */
function _setProviderContent(el, label, icon) {
  el.textContent = '';
  if (icon) {
    const img = document.createElement('img');
    img.className = 'vfs-provider-icon';
    img.src = icon;
    img.alt = '';
    el.appendChild(img);
  }
  el.appendChild(document.createTextNode(label));
}

/**
 * Shared atomic root-commit for provider switches.
 *
 * Fetches the new provider's capabilities + root listing first, then commits
 * `storageRef + cwd + entries + capabilities` together. This avoids the
 * pre-commit window (where state.storageRef said "new provider" while
 * state.entries still held the old provider's rows) that the old
 * `_switchTo{Connection,Opfs}` pattern produced.
 *
 * Participates in `_stateSeq`: any concurrent navigateTo or switch bumps
 * the sequence, and older in-flight operations detect supersession and
 * discard their results.
 */
async function _commitRoot(storageRef) {
  const mySeq = ++_stateSeq;
  let capabilities, entries;
  try {
    capabilities = await vfs.getCapabilities(storageRef);
    if (mySeq !== _stateSeq) return;
    entries = await vfs.list({ path: '/', storageRef }, _opts(t('loading')));
  } catch (err) {
    if (mySeq !== _stateSeq) return;
    if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
    _progressLabel = null; _progressShownAt = null;
    if (_isProviderError(err)) {
      await showDialog({
        title: err.details?.title ?? t('error', err.message),
        message: err.details?.description ?? err.message,
        buttons: [{ id: 'ok', label: t('btnOK') }],
        cancelButton: 'ok',
      });
    } else {
      showStatus(t('errorLoadDir', err.message), true);
    }
    return;
  }

  if (mySeq !== _stateSeq) return;

  // Atomic commit.
  state.storageRef = storageRef;
  state.cwd = '/';
  state.entries = entries;
  state.capabilities = capabilities;
  _saveIdState('/');
  state.selected = new Set();
  state._anchor = null;
  updatePreview(null);
  applyCapabilities();
  _clear();
  render();
  updateStorageInfo();

  // Update provider button/dropdown label post-commit. _refreshProviderButton
  // may itself fetch connections; not awaited so the entries view isn't held
  // back by a slower label update.
  if (storageRef === null) _updateProviderDisplay();
  else _refreshProviderButton().catch(() => { });
}

async function _switchToOpfs() {
  if (state.storageRef === null) return;
  await _commitRoot(null);
}

// Set the provider button label/icon from fresh provider data. Used when the
// dropdown DOM that `_updateProviderDisplay` reads from is stale — e.g. a newly
// added connection or a rename that arrived via `vfs-provider-updated`.
async function _refreshProviderButton() {
  if (!_providerBtn) return;
  const ref = state.storageRef;
  if (!ref) return;
  const providers = await vfs.fetchProviderConnections();
  // Bail out if the active connection changed during the await (e.g. a
  // concurrent `vfs-remove-connection` switched us to OPFS).
  if (state.storageRef !== ref) return;
  const ap = providers.find(p => p.providerId === ref.providerId);
  const ac = ap?.connections.find(c => (c.storageRef.storageId ?? null) === ref.storageId);
  if (ap && ac) {
    const icon = ap.icon ? URL.createObjectURL(ap.icon) : _FALLBACK_ICON;
    _setProviderContent(_providerBtn, `${ap.name}: ${ac.name}`, icon);
  }
}

async function _switchToConnection(storageRef) {
  const nextId = storageRef.storageId ?? null;
  if (state.storageRef?.providerId === storageRef.providerId && state.storageRef?.storageId === nextId) return;
  await _commitRoot({ providerId: storageRef.providerId, storageId: nextId });
}

// Transition the picker into the "locked connection is unavailable" state.
// Used when the locked provider/connection disappears at runtime.
function _enterLockedUnavailable() {
  state.lockedUnavailable = true;
  state.entries = [];
  state.selected = new Set();
  state._anchor = null;
  state.capabilities = { file: {}, folder: {} };
  updatePreview(null);
  applyCapabilities();
  render();
  _showIdleStatus();
}

function _makeProviderLi(value, label, icon = null) {
  const li = document.createElement('li');
  li.dataset.value = value;
  li.dataset.label = label;
  if (icon) li.dataset.icon = icon;
  _setProviderContent(li, label, icon);
  li.addEventListener('click', async () => {
    _providerUl.hidden = true;
    if (!state.storageRef) return;
    await _switchToOpfs();
  });
  return li;
}

function _updateProviderDisplay() {
  if (!_providerBtn || !_providerUl) return;
  let activeLi;
  if (!state.storageRef) {
    activeLi = _providerUl.querySelector('li[data-value=""]');
  } else {
    activeLi = _providerUl.querySelector(
      `li[data-provider-id="${CSS.escape(state.storageRef.providerId)}"][data-storage-id="${CSS.escape(state.storageRef.storageId ?? '')}"]`
    );
  }
  const label = activeLi?.dataset.label ?? (VFS_PROVIDER_NAME ?? t('providerOpfs'));
  const icon = activeLi?.dataset.icon ?? (!state.storageRef ? _opfsIcon : null);
  _setProviderContent(_providerBtn, label, icon);
  _providerUl.querySelectorAll('li').forEach(l => l.classList.toggle('active', l === activeLi));
}

async function _buildDropdown() {
  _providerUl.innerHTML = '';

  const providers = await vfs.fetchProviderConnections();

  // No provider add-ons installed → show a single discovery entry.
  if (providers.length === 0) {
    const li = document.createElement('li');
    li.textContent = t('findProviderAddons');
    li.addEventListener('click', async e => {
      e.stopPropagation();
      _providerUl.hidden = true;
      const tab = await browser.tabs.create({ url: 'https://addons.thunderbird.net/search/?q=VFS' });
      if (tab?.windowId != null) {
        await browser.windows.update(tab.windowId, { focused: true });
      }
    });
    _providerUl.appendChild(li);
    return;
  }

  // 1. OPFS entry (always first)
  _providerUl.appendChild(_makeProviderLi('', VFS_PROVIDER_NAME ?? t('providerOpfs'), _opfsIcon));

  // 2. Established connections
  const providerIconUrls = new Map(providers.map(p => [
    p.providerId,
    p.icon ? URL.createObjectURL(p.icon) : _FALLBACK_ICON,
  ]));
  const valid = providers.flatMap(p =>
    p.connections.map(conn => ({ conn, providerName: p.name, icon: providerIconUrls.get(p.providerId), hasConfig: p.hasConfig ?? false }))
  );

  if (valid.length > 0) {
    _providerUl.appendChild(_makeSep());
    for (const { conn, providerName, icon, hasConfig } of valid) {
      const label = `${providerName}: ${conn.name}`;
      const li = document.createElement('li');
      li.dataset.providerId = conn.storageRef.providerId;
      li.dataset.storageId = conn.storageRef.storageId ?? '';
      li.dataset.label = label;
      if (icon) li.dataset.icon = icon;
      _setProviderContent(li, label, icon);
      li.addEventListener('click', async () => {
        _providerUl.hidden = true;
        await _switchToConnection(conn.storageRef);
      });

      const actWrap = document.createElement('span');
      actWrap.className = 'vfs-conn-actions';

      if (hasConfig) {
        const cfgBtn = document.createElement('button');
        cfgBtn.className = 'vfs-conn-config-btn';
        cfgBtn.title = t('btnConfigure');
        const cfgIcon = document.createElement('span');
        cfgIcon.className = 'vfs-icon-configure';
        cfgBtn.appendChild(cfgIcon);
        cfgBtn.addEventListener('click', async e => {
          e.stopPropagation();
          _providerUl.hidden = true;
          try { await vfs.openProviderConfig(conn.storageRef); } catch { /* no config page */ }
        });
        actWrap.appendChild(cfgBtn);
      }

      const delBtn = document.createElement('button');
      delBtn.className = 'vfs-conn-delete-btn';
      delBtn.title = t('btnDelete');
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', async e => {
        e.stopPropagation();
        _providerUl.hidden = true;
        const { button } = await showDialog({
          title: t('removeConnectionTitle'),
          message: t('removeConnectionMsg', conn.name),
          buttons: [{ id: 'cancel', label: t('btnCancel') }, { id: 'remove', label: t('btnRemove') }],
          cancelButton: 'cancel',
        });
        if (button !== 'remove') return;
        let hideToast;
        try {
          const removed = new Promise(resolve => {
            const listener = msg => {
              if (msg?.type === 'vfs-remove-connection' &&
                  msg.providerId === conn.storageRef.providerId &&
                  msg.storageId === conn.storageRef.storageId) {
                browser.runtime.onMessage.removeListener(listener);
                resolve();
              }
            };
            browser.runtime.onMessage.addListener(listener);
          });
          hideToast = _showToast(t('deletingConnection', conn.name));
          document.body.inert = true;
          await vfs.deleteProviderConnection(conn.storageRef);
          await Promise.all([removed, new Promise(r => setTimeout(r, 1500))]);
        } catch {
          /* provider rejected - leave as-is */
        } finally {
          document.body.inert = false;
          hideToast();
        }
      });
      actWrap.appendChild(delBtn);
      li.appendChild(actWrap);

      _providerUl.appendChild(li);
    }
  }

  // 3. Separator + "Add new connection" submenu
  _providerUl.appendChild(_makeSep());

  const addLi = document.createElement('li');
  addLi.className = 'vfs-provider-submenu-item';
  addLi.textContent = 'Add new connection';

  const subUl = document.createElement('ul');
  subUl.className = 'vfs-provider-submenu';

  for (const p of providers) {
    const subLi = document.createElement('li');
    _setProviderContent(subLi, p.name || p.providerId, providerIconUrls.get(p.providerId));
    subLi.addEventListener('click', async e => {
      e.stopPropagation();
      _providerUl.hidden = true;
      const addonName = browser.runtime.getManifest().name;
      try {
        const storageRef = await vfs.openProviderSetup(p.providerId, addonName);
        await _switchToConnection(storageRef);
      } catch { /* cancelled or no setup page */ }
    });
    subUl.appendChild(subLi);
  }
  addLi.appendChild(subUl);
  _providerUl.appendChild(addLi);

  _updateProviderDisplay();
}

function _makeSep() {
  const li = document.createElement('li');
  li.className = 'vfs-provider-sep';
  return li;
}

async function init() {
  localizeDocument();
  _initStatusBar();

  // Validate state.storageRef against known providers - clears id-state if provider or connection is gone
  const _providers = await vfs.fetchProviderConnections();
  const _refExists = state.storageRef && _providers.some(p =>
    p.providerId === state.storageRef.providerId &&
    p.connections.some(c => c.storageRef.storageId === state.storageRef.storageId)
  );
  if (state.storageRef && !_refExists) {
    if (LOCKED_REF) {
      // Locked to an unavailable connection. Keep the ref so the lock is visible
      // in the UI, but skip the directory load and disable all actions.
      state.lockedUnavailable = true;
    } else {
      if (PICKER_ID) localStorage.removeItem(_idStateKey());
      state.storageRef = null;
      state.cwd = '/';
    }
  }

  // Resolve a human-readable label for LOCKED_REF so it can be shown in status messages.
  if (LOCKED_REF) {
    const _lp = _providers.find(p => p.providerId === LOCKED_REF.providerId);
    const _lc = _lp?.connections.find(c => (c.storageRef.storageId ?? null) === (LOCKED_REF.storageId ?? null));
    if (_lp && _lc) state.lockedLabel = `${_lp.name}: ${_lc.name}`;
  }

  // Fetch and apply capabilities — no-op capabilities when the locked connection is unavailable.
  state.capabilities = state.lockedUnavailable
    ? { file: {}, folder: {} }
    : await vfs.getCapabilities(state.storageRef);

  initToolbar();
  applyCapabilities();
  // Provider selector - always shown, even when no providers are installed
  {
    _providerWrap = document.createElement('div');
    _providerWrap.id = 'vfs-provider-select';

    _providerBtn = document.createElement('button');
    _providerBtn.className = 'vfs-provider-btn';
    _providerBtn.type = 'button';

    _providerUl = document.createElement('ul');
    _providerUl.className = 'vfs-provider-dropdown';
    _providerUl.hidden = true;

    _opfsIcon = _getOwnIconUrl() ?? _FALLBACK_ICON;

    if (LOCK_STORAGE === 'strict') {
      // Strict lock: show the button as a non-interactive label. No dropdown.
      _providerBtn.classList.add('vfs-provider-btn-locked');
      _providerBtn.disabled = true;
      _providerBtn.setAttribute('aria-disabled', 'true');
    } else {
      _providerBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (_providerUl.hidden) {
          await _buildDropdown();
          _providerUl.hidden = false;
        } else {
          _providerUl.hidden = true;
        }
      });
      document.addEventListener('click', e => { if (_providerUl && !_providerWrap?.contains(e.target)) _providerUl.hidden = true; }, { capture: true });
    }

    if (state.storageRef) {
      const ap = _providers.find(p => p.providerId === state.storageRef.providerId);
      const ac = ap?.connections.find(c => (c.storageRef.storageId ?? null) === state.storageRef.storageId);
      if (ac) {
        const icon = ap.icon ? URL.createObjectURL(ap.icon) : _FALLBACK_ICON;
        _setProviderContent(_providerBtn, `${ap.name}: ${ac.name}`, icon);
      } else if (state.lockedUnavailable) {
        // Locked connection is not present — show the unavailable label on the button.
        _setProviderContent(_providerBtn, t('connectionLockedUnavailableShort'), _FALLBACK_ICON);
      } else {
        _setProviderContent(_providerBtn, VFS_PROVIDER_NAME ?? t('providerOpfs'), _opfsIcon);
      }
    } else {
      _setProviderContent(_providerBtn, VFS_PROVIDER_NAME ?? t('providerOpfs'), _opfsIcon);
    }
    _providerWrap.append(_providerBtn);
    // The dropdown is only attached in non-strict mode.
    if (LOCK_STORAGE !== 'strict') _providerWrap.appendChild(_providerUl);
    locationBarEl.insertBefore(_providerWrap, breadcrumbEl);
  }

  // Footer buttons + title
  if (MODE === 'save') {
    document.title = t('pageTitleSave');
    openBtn.querySelector('span').textContent = t('btnSave');
    saveBarEl.hidden = false;
    if (SUGGESTED_NAME) saveNameInput.value = SUGGESTED_NAME;
    saveNameInput.addEventListener('input', () => renderFooter());
    renderFooter(); // update save button enabled state
    setTimeout(() => saveNameInput.focus(), 0);
  } else if (MODE === 'dir') {
    document.title = t('pageTitleDir');
    openBtn.querySelector('span').textContent = t('btnSelectFolder');
  } else if (MODE === 'browse') {
    document.title = t('pageTitleBrowse');
    openBtn.hidden = true;
  } else if (MULTIPLE) {
    document.title = t('pageTitleMultiple');
    openBtn.querySelector('span').textContent = t('btnSelectFiles');
  }
  openBtn.addEventListener('click', confirmSelection);
  cancelBtn.addEventListener('click', () => sendResult(null));

  // Cancel button - mousedown so it fires before the next progress tick replaces the DOM
  $('vfs-status').addEventListener('mousedown', e => {
    if (e.target.classList.contains('vfs-cancel-op')) {
      e.preventDefault();
      _cancelRequested = true;
      if (state.storageRef) vfs.abort(state.storageRef);
    }
  });

  // Close context menu on outside click, suppress default context menu everywhere
  document.addEventListener('click', e => {
    if (!contextMenu.contains(e.target)) hideContextMenu();
  });
  listArea.addEventListener('contextmenu', e => {
    if (!e.target.closest('.vfs-row')) {
      e.preventDefault();
      e.stopPropagation();
      showBgContextMenu(e.clientX, e.clientY);
    }
  });
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
  });

  // External file drop → upload to current folder
  listArea.addEventListener('dragover', e => {
    if (!state.dragging && e.dataTransfer.types.includes('Files') && state.capabilities?.file?.add) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      dropOverlay.classList.add('active');
    }
  });
  listArea.addEventListener('dragleave', e => {
    if (!listArea.contains(e.relatedTarget)) dropOverlay.classList.remove('active');
  });
  listArea.addEventListener('drop', async e => {
    dropOverlay.classList.remove('active');
    if (!state.dragging && e.dataTransfer.files.length && state.capabilities?.file?.add) {
      e.preventDefault();
      await handleStoreFiles(Array.from(e.dataTransfer.files));
      loadDir({ silent: true });
    }
  });

  window.addEventListener('beforeunload', e => {
    if (_busy) e.preventDefault();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (_busy) return;
      if (document.querySelector('.vfs-dialog-backdrop')) return;
      hideContextMenu();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', async e => {
    if (e.target.tagName === 'INPUT') return;
    const single = state.selected.size === 1 ? [...state.selected][0] : null;
    const singleEntry = single ? state.entries.find(en => en.name === single) : null;
    const singleIsDir = singleEntry?.kind === 'directory';
    const kc = state.capabilities || { file: {}, folder: {} };
    const kCanModify = singleEntry ? (singleIsDir ? kc.folder?.modify : kc.file?.modify) : false;

    if (e.key === 'Enter' && singleEntry) {
      // Use the entry's provider-supplied absolute path (immutable since list)
      // rather than recomputing from live `state.cwd`, which may have advanced.
      if (singleIsDir) navigateTo(singleEntry.path || pathJoin(state.cwd, singleEntry.name));
      else confirmSelection();
    }
    if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
      const p = parentPath(state.cwd);
      if (p) navigateTo(p);
    }
    if (e.key === 'F2' && single && kCanModify) startRename(single);
    if (e.key === 'Delete' && state.selected.size > 0) await confirmDeleteSelected();
    if (e.key === 'x' && (e.ctrlKey || e.metaKey) && state.selected.size > 0) {
      clipboardCut([...state.selected].map(n => state.entries.find(e2 => e2.name === n)).filter(Boolean));
    }
    if (e.key === 'c' && (e.ctrlKey || e.metaKey) && state.selected.size > 0) {
      clipboardCopy([...state.selected].map(n => state.entries.find(e2 => e2.name === n)).filter(Boolean));
    }
    if (e.key === 'v' && (e.ctrlKey || e.metaKey) && (kc.file?.modify || kc.folder?.modify)) {
      await pasteClipboard();
    }
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      state.selected = new Set(applyFilter(state.entries).map(en => en.name));
      _syncSelectionHighlights();
      renderFooter();
      updatePreview(null);
    }
    // Arrow key navigation - single-select, moves anchor
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const filtered = applyFilter(state.entries);
      const anchorIdx = filtered.findIndex(en => en.name === (state._anchor ?? single));
      const next = e.key === 'ArrowDown'
        ? Math.min(anchorIdx + 1, filtered.length - 1)
        : Math.max(anchorIdx - 1, 0);
      if (filtered[next]) {
        const en = filtered[next];
        selectEntry(en.name, en.kind === 'file' ? pathJoin(state.cwd, en.name) : null);
        listArea.querySelector(`.vfs-row[data-name="${CSS.escape(en.name)}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  if (state.lockedUnavailable) {
    // Don't attempt to list — the connection is gone. Just render empty state and banner.
    state.entries = [];
    render();
    _showIdleStatus();
  } else {
    await loadDir();
  }

  browser.runtime.onMessage.addListener(msg => {
    if (!msg) return;
    if (msg.type === 'vfs-provider-removed') {
      if (msg.providerId === state.storageRef?.providerId) {
        if (LOCKED_REF) {
          // Lock is in effect — transition to unavailable state instead of dropping it.
          _enterLockedUnavailable();
        } else {
          const reloadUrl = new URL(location.href);
          reloadUrl.searchParams.delete('storageRef');
          location.href = reloadUrl.toString();
        }
      }
    }
    // A connection was added or renamed on the active provider — refresh the button
    // label in case the currently selected connection was the one affected.
    if (msg.type === 'vfs-provider-updated') {
      if (msg.providerId === state.storageRef?.providerId) {
        _refreshProviderButton();
      }
    }
    // Switch to OPFS if the active connection was removed by any picker instance.
    if (msg.type === 'vfs-remove-connection') {
      if (state.storageRef?.providerId === msg.providerId &&
          state.storageRef?.storageId === msg.storageId) {
        if (LOCKED_REF && _isLockedConnection({ providerId: msg.providerId, storageId: msg.storageId })) {
          _enterLockedUnavailable();
        } else {
          _switchToOpfs();
        }
      }
    }
  });

  // Listen for provider push notifications (same-page port - sendMessage excludes own frame)
  vfs.onStorageChanged.addListener(entries => {
    updateStorageInfo();
    if (_pathsAffectCwd(entries)) loadDir({ silent: true });
  });
}

/**
 * Returns true if any of the modified paths affect the currently displayed directory.
 * Triggers a refresh when items are added/removed in cwd, or when cwd itself was
 * moved/deleted (cwd is inside a modified subtree).
 */
function _pathsAffectCwd(entries) {
  if (entries.length === 0) return true; // unknown - refresh to be safe
  const cwd = state.cwd;
  const _matchRef = r => (r?.providerId ?? null) === (state.storageRef?.providerId ?? null) &&
                         (r?.storageId  ?? null) === (state.storageRef?.storageId  ?? null);
  const paths = entries.flatMap(e => {
    const result = [];
    if (_matchRef(e.target.storageRef)) result.push(e.target.path);
    if (e.source && _matchRef(e.source.storageRef)) result.push(e.source.path);
    return result;
  });
  if (paths.length === 0) return false; // all from a different provider
  const cwdNorm = cwd.endsWith('/') ? cwd : cwd + '/';
  const normPaths = paths.map(p => p.endsWith('/') ? p : p + '/');
  // item inside cwd (or equal), or cwd inside item (item is an ancestor)
  return normPaths.some(p => p.startsWith(cwdNorm) || cwdNorm.startsWith(p));
}

init();
