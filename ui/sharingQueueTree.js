/**
 * Copyright (c) 2025 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0.
 * See LICENSE.txt for details.
 */
(function(global){
  'use strict';

  const FILE_GLYPHS = Object.freeze({
    txt: '📄', md: '📝', html: '🌐', htm: '🌐', css: '🎨', js: '📜', mjs: '📜',
    ts: '📜', json: '📋', xml: '📋', csv: '📊', pdf: '📕', doc: '📘', docx: '📘',
    xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙', zip: '🗜', tar: '🗜', gz: '🗜',
    png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
    mp3: '🎵', wav: '🎵', mp4: '🎬', webm: '🎬', mov: '🎬'
  });

  function normalizePath(value){
    return String(value || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment && segment !== '.')
      .join('/');
  }

  function sourceKey(entry){
    if (entry?.sourceKind === 'local'){
      return 'local';
    }
    const providerId = String(entry?.storageRef?.providerId || '');
    const storageId = String(entry?.storageRef?.storageId || '');
    return `${String(entry?.sourceKind || 'external-vfs')}:${providerId}:${storageId}`;
  }

  function entryGroupId(entry){
    return String(entry?.queueGroupId || entry?.transferGroupId || '');
  }

  function getEntrySize(entry){
    if (!entry || entry.kind === 'folder'){
      return null;
    }
    const raw = entry.file && typeof entry.file.size === 'number'
      ? entry.file.size
      : entry.size;
    if (raw == null){
      return null;
    }
    const size = Number(raw);
    return Number.isFinite(size) && size >= 0 ? size : null;
  }

  function getFileGlyph(name){
    const value = String(name || '');
    const extension = value.includes('.') ? value.split('.').pop().toLowerCase() : '';
    return FILE_GLYPHS[extension] || '📄';
  }

  function getGlyph(item){
    return item?.kind === 'folder' ? '📁' : getFileGlyph(item?.name || item?.label);
  }

  function createNode({
    key,
    name,
    kind,
    depth,
    source,
    groupId = '',
    entry = null,
    synthetic = false
  }){
    return {
      key,
      name,
      label: name,
      kind,
      depth,
      source,
      groupId,
      entry,
      synthetic,
      children: [],
      removalTarget: null
    };
  }

  function sortNodes(nodes){
    nodes.sort((left, right) => {
      if (left.kind !== right.kind){
        return left.kind === 'folder' ? -1 : 1;
      }
      return left.label.localeCompare(right.label, undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    });
    nodes.forEach((node) => sortNodes(node.children));
  }

  function buildGroupedNodes(entries, groupId, source, getTargetPath){
    const roots = [];
    const nodesByPath = new Map();
    const orderedEntries = entries.slice().sort((left, right) => {
      const leftPath = normalizePath(getTargetPath(left));
      const rightPath = normalizePath(getTargetPath(right));
      return leftPath.split('/').length - rightPath.split('/').length;
    });

    function ensureFolder(parts, depth){
      const path = parts.slice(0, depth + 1).join('/');
      if (nodesByPath.has(path)){
        return nodesByPath.get(path);
      }
      const parent = depth > 0 ? ensureFolder(parts, depth - 1) : null;
      const node = createNode({
        key: `${source.key}|${groupId}|${path}`,
        name: parts[depth],
        kind: 'folder',
        depth,
        source,
        groupId,
        synthetic: true
      });
      nodesByPath.set(path, node);
      (parent ? parent.children : roots).push(node);
      return node;
    }

    for (const entry of orderedEntries){
      const targetPath = normalizePath(getTargetPath(entry))
        || normalizePath(entry?.name || entry?.file?.name || '');
      const parts = targetPath.split('/').filter(Boolean);
      if (!parts.length){
        continue;
      }
      const path = parts.join('/');
      const isFolder = entry.kind === 'folder';
      let node = nodesByPath.get(path) || null;
      if (isFolder){
        node = ensureFolder(parts, parts.length - 1);
        node.entry = entry;
        node.synthetic = false;
      }else{
        const parent = parts.length > 1 ? ensureFolder(parts, parts.length - 2) : null;
        node = createNode({
          key: `${source.key}|${groupId}|${path}|${entry.id}`,
          name: parts[parts.length - 1],
          kind: 'file',
          depth: parts.length - 1,
          source,
          groupId,
          entry
        });
        (parent ? parent.children : roots).push(node);
      }
    }

    const removable = roots.find((node) => node.entry?.transferRoot) || roots[0] || null;
    if (removable){
      removable.removalTarget = Object.freeze({
        kind: 'group',
        groupId
      });
    }
    return roots;
  }

  function buildModel(entries, options = {}){
    const getSourceLabel = typeof options.getSourceLabel === 'function'
      ? options.getSourceLabel
      : (entry) => String(entry?.sourceLabel || entry?.sourceKind || '');
    const getTargetPath = typeof options.getTargetPath === 'function'
      ? options.getTargetPath
      : (entry) => String(entry?.displayPath || entry?.name || '');
    const sourcesByKey = new Map();
    const sourceOrder = [];

    for (const entry of Array.isArray(entries) ? entries : []){
      const key = sourceKey(entry);
      let source = sourcesByKey.get(key);
      if (!source){
        source = {
          key,
          kind: String(entry?.sourceKind || 'local'),
          label: getSourceLabel(entry),
          storageRef: entry?.storageRef || null,
          entries: [],
          nodes: []
        };
        sourcesByKey.set(key, source);
        sourceOrder.push(source);
      }
      source.entries.push(entry);
    }

    for (const source of sourceOrder){
      const grouped = new Map();
      const standalone = [];
      for (const entry of source.entries){
        const groupId = entryGroupId(entry);
        if (!groupId){
          standalone.push(entry);
          continue;
        }
        if (!grouped.has(groupId)){
          grouped.set(groupId, []);
        }
        grouped.get(groupId).push(entry);
      }
      for (const [groupId, groupEntries] of grouped){
        source.nodes.push(...buildGroupedNodes(groupEntries, groupId, source, getTargetPath));
      }
      for (const entry of standalone){
        const name = normalizePath(getTargetPath(entry)).split('/').pop()
          || String(entry?.name || entry?.file?.name || '');
        const node = createNode({
          key: `${source.key}|entry|${entry.id}`,
          name,
          kind: entry?.kind === 'folder' ? 'folder' : 'file',
          depth: 0,
          source,
          entry
        });
        node.removalTarget = Object.freeze({ kind: 'entry', entryId: entry.id });
        source.nodes.push(node);
      }
      sortNodes(source.nodes);
    }

    return Object.freeze({ sources: sourceOrder });
  }

  function summarize(model){
    let entryCount = 0;
    let knownFileBytes = 0;
    let hasUnknownSize = false;
    function visit(node){
      entryCount++;
      if (node.kind === 'file'){
        const size = getEntrySize(node.entry);
        if (size == null){
          hasUnknownSize = true;
        }else{
          knownFileBytes += size;
        }
      }
      node.children.forEach(visit);
    }
    for (const source of model?.sources || []){
      source.nodes.forEach(visit);
    }
    return Object.freeze({
      entryCount,
      sourceCount: model?.sources?.length || 0,
      knownFileBytes,
      hasUnknownSize
    });
  }

  function evaluateCapacity(summary, storage){
    const available = Number(storage?.available);
    const finite = storage?.state === 'finite'
      && storage?.available != null
      && Number.isFinite(available)
      && available >= 0;
    return Object.freeze({
      blocked: finite && summary.knownFileBytes > available,
      state: finite ? 'finite' : String(storage?.state || 'unknown'),
      required: summary.knownFileBytes,
      available: finite ? available : null
    });
  }

  function appendContent(target, content){
    if (typeof Node !== 'undefined' && content instanceof Node){
      target.appendChild(content);
    }else if (content != null){
      target.textContent = String(content);
    }
  }

  function createView(options = {}){
    const container = options.container;
    const scrollContainer = options.scrollContainer || container;
    if (!container){
      throw new Error('Queue tree container is required');
    }
    const expandedKeys = new Set();
    const knownFolderKeys = new Set();
    const rowsByEntryId = new Map();
    let removalDisabled = false;
    let model = buildModel([], options);

    function folderLabel(node, expanded){
      const callback = expanded ? options.getCollapseAriaLabel : options.getExpandAriaLabel;
      return callback ? callback(node) : node.label;
    }

    function renderNode(node){
      const item = document.createElement('li');
      item.className = `sharing-queue-tree-item is-${node.kind}`;
      if (node.synthetic){
        item.classList.add('is-synthetic');
      }
      const row = document.createElement('div');
      row.className = 'sharing-queue-tree-row';
      if (node.entry?.id){
        row.dataset.entryId = node.entry.id;
        rowsByEntryId.set(node.entry.id, row);
      }
      row.classList.toggle(
        'uploading',
        ['uploading', 'fetching', 'copying', 'preparing'].includes(node.entry?.status)
      );

      const expandable = node.kind === 'folder' && node.children.length > 0;
      if (expandable){
        if (!knownFolderKeys.has(node.key)){
          knownFolderKeys.add(node.key);
          if (node.depth === 0){
            expandedKeys.add(node.key);
          }
        }
        const expanded = expandedKeys.has(node.key);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'sharing-queue-tree-toggle';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.setAttribute('aria-label', folderLabel(node, expanded));
        appendContent(toggle, options.getToggleContent?.(node, expanded) || '›');
        toggle.addEventListener('click', () => {
          if (expandedKeys.has(node.key)){
            expandedKeys.delete(node.key);
          }else{
            expandedKeys.add(node.key);
          }
          renderCurrent();
        });
        row.appendChild(toggle);
      }else{
        const spacer = document.createElement('span');
        spacer.className = 'sharing-queue-tree-spacer';
        row.appendChild(spacer);
      }

      const glyph = document.createElement('span');
      glyph.className = 'sharing-queue-tree-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = getGlyph(node);
      row.appendChild(glyph);

      const content = document.createElement('span');
      content.className = 'sharing-queue-tree-content';
      const label = document.createElement('span');
      label.className = 'sharing-queue-tree-label';
      label.textContent = node.label;
      label.title = node.label;
      content.appendChild(label);
      row.appendChild(content);

      const size = document.createElement('span');
      size.className = 'sharing-queue-tree-size';
      const entrySize = getEntrySize(node.entry);
      size.textContent = entrySize == null || node.kind === 'folder'
        ? ''
        : options.formatSize?.(entrySize) || String(entrySize);
      row.appendChild(size);

      const status = document.createElement('div');
      status.className = 'sharing-queue-tree-status';
      if (node.entry && options.buildStatusNode){
        status.appendChild(options.buildStatusNode(node.entry));
      }
      row.appendChild(status);

      const actions = document.createElement('div');
      actions.className = 'sharing-queue-tree-actions';
      if (node.removalTarget && options.canRemove?.(node) !== false){
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'sharing-queue-tree-remove';
        remove.disabled = removalDisabled;
        remove.setAttribute(
          'aria-label',
          options.getRemoveAriaLabel?.(node) || node.label
        );
        appendContent(remove, options.getRemoveContent?.(node) || '×');
        remove.addEventListener('click', (event) => {
          options.onRemove?.(node, node.removalTarget, event);
        });
        actions.appendChild(remove);
      }
      row.appendChild(actions);
      item.appendChild(row);

      if (node.children.length){
        const children = document.createElement('ul');
        children.className = 'sharing-queue-tree-children';
        children.hidden = !expandedKeys.has(node.key);
        node.children.forEach((child) => children.appendChild(renderNode(child)));
        item.appendChild(children);
      }
      return item;
    }

    function renderCurrent(){
      rowsByEntryId.clear();
      const root = document.createElement('div');
      root.className = 'nc-sharing-queue-tree';
      for (const source of model.sources){
        const section = document.createElement('section');
        section.className = 'sharing-queue-source';
        section.setAttribute('aria-label', options.getSourceAriaLabel?.(source) || source.label);
        const heading = document.createElement('div');
        heading.className = 'sharing-queue-source-heading';
        const icon = document.createElement('span');
        icon.className = 'sharing-queue-source-icon';
        appendContent(icon, options.getSourceIcon?.(source) || '●');
        const text = document.createElement('span');
        text.textContent = source.label;
        heading.append(icon, text);
        section.appendChild(heading);
        const list = document.createElement('ul');
        list.className = 'sharing-queue-tree-list';
        source.nodes.forEach((node) => list.appendChild(renderNode(node)));
        section.appendChild(list);
        root.appendChild(section);
      }
      container.replaceChildren(root);
    }

    function render(entries){
      model = buildModel(entries, options);
      const liveFolderKeys = new Set();
      function collect(node){
        if (node.kind === 'folder'){
          liveFolderKeys.add(node.key);
        }
        node.children.forEach(collect);
      }
      model.sources.forEach((source) => source.nodes.forEach(collect));
      for (const key of Array.from(expandedKeys)){
        if (!liveFolderKeys.has(key)){
          expandedKeys.delete(key);
        }
      }
      for (const key of Array.from(knownFolderKeys)){
        if (!liveFolderKeys.has(key)){
          knownFolderKeys.delete(key);
        }
      }
      renderCurrent();
      return model;
    }

    function patchEntry(entry){
      const row = rowsByEntryId.get(entry?.id);
      if (!row){
        return false;
      }
      row.classList.toggle(
        'uploading',
        ['uploading', 'fetching', 'copying', 'preparing'].includes(entry.status)
      );
      const status = row.querySelector('.sharing-queue-tree-status');
      if (!status || !options.buildStatusNode){
        return false;
      }
      status.replaceChildren(options.buildStatusNode(entry));
      return true;
    }

    function scrollTo(target){
      if (!scrollContainer){
        return;
      }
      const task = () => {
        if (target === '__top__'){
          scrollContainer.scrollTop = 0;
          return;
        }
        if (target && target !== '__bottom__'){
          const row = rowsByEntryId.get(target);
          if (row){
            row.scrollIntoView({ block: 'nearest' });
            return;
          }
        }
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      };
      if (typeof requestAnimationFrame === 'function'){
        requestAnimationFrame(task);
      }else{
        setTimeout(task, 0);
      }
    }

    function dispose(){
      model = buildModel([], options);
      rowsByEntryId.clear();
      expandedKeys.clear();
      knownFolderKeys.clear();
      container.replaceChildren();
    }

    function setRemovalDisabled(disabled){
      removalDisabled = disabled === true;
      container.querySelectorAll('.sharing-queue-tree-remove').forEach((button) => {
        button.disabled = removalDisabled;
      });
    }

    return Object.freeze({
      render,
      patchEntry,
      scrollTo,
      setRemovalDisabled,
      dispose,
      getModel: () => model
    });
  }

  global.NCSharingQueueTree = Object.freeze({
    buildModel,
    summarize,
    evaluateCapacity,
    getEntrySize,
    getFileGlyph,
    getGlyph,
    createView
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
