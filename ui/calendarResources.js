/**
 * Copyright (c) 2026 Bastian Kleinschmidt
 * Licensed under the GNU Affero General Public License v3.0; see LICENSE.txt.
 */
(() => {
  'use strict';

  const i18n = NCI18n.translate;
  const contextId = new URLSearchParams(window.location.search).get('contextId') || '';
  const search = document.getElementById('search');
  const apply = document.getElementById('apply');
  const cancel = document.getElementById('cancel');
  const retry = document.getElementById('retry');
  const status = document.getElementById('status');
  const details = document.getElementById('details');
  const reauthenticate = document.getElementById('reauthenticate');
  const selectionCount = document.getElementById('selectionCount');
  const policyWarningRow = document.getElementById('policyWarningRow');
  const policyWarningText = document.getElementById('policyWarningText');
  const policyWarningAdminLink = document.getElementById('policyWarningAdminLink');
  const main = document.querySelector('main');
  const building = document.getElementById('building');
  const floor = document.getElementById('floor');
  const capacity = document.getElementById('capacity');
  const featuresButton = document.getElementById('featuresButton');
  const featuresMenu = document.getElementById('featuresMenu');
  const onlyAvailable = document.getElementById('onlyAvailable');
  const grouping = document.getElementById('grouping');
  const expandAll = document.getElementById('expandAll');
  const clearFilters = document.getElementById('clearFilters');
  const dayView = document.getElementById('dayView');
  const dayDate = document.getElementById('dayDate');
  const dateControl = document.getElementById('dateControl');
  const datePopover = document.getElementById('datePopover');
  const calendarDays = document.getElementById('calendarDays');
  let calendarCursor = null;
  const resourceMenu = document.getElementById('resourceMenu');
  const availability = new Map();
  const selectedFeatures = new Set();
  const collapsed = new Map();
  const statusKeys = { free: 'resource_available', busy: 'resource_busy', unknown: 'resource_unknown', checking: 'resource_checking' };
  const preferenceKeys = ['calendarResourceGrouping', 'calendarResourceGroupsExpanded'];
  let groupsExpanded = true;
  let preferredGrouping = 'none';
  let preferenceWrites = Promise.resolve();
  let interval = null;
  let intervalTimer = null;
  let readingInterval = false;
  let queryRevision = 0;
  let dayRevision = 0;
  let loadRevision = 0;
  let dayResource = null;
  let menuResource = null;
  let returnFocus = null;
  let resources = [];
  let selected = new Set();
  let selectionToken = '';
  let currentPrincipalPath = '';
  let busy = true;
  let applying = false;
  let unloading = false;

  const fields = [
    ['resource_name', 'displayName'], ['resource_type', 'kind'],
    ['resource_email', 'email'], ['resource_room_type', 'roomType'],
    ['resource_resource_type', 'resourceType'], ['resource_capacity', 'capacity'],
    ['resource_building', 'buildingName'], ['resource_address', 'buildingAddress'],
    ['resource_floor', 'floor'], ['resource_room_number', 'roomNumber'],
    ['resource_features', 'features'], ['resource_location', 'location']
  ];

  function setBusy(value){
    busy = value;
    main.setAttribute('aria-busy', String(value));
    search.disabled = value || !selectionToken;
    apply.disabled = value || !selectionToken || selectedRoomCount() > 1;
    cancel.disabled = value && !!selectionToken;
    retry.disabled = value;
    for (const element of [building, floor, capacity, featuresButton, onlyAvailable, grouping, expandAll, clearFilters,
      ...document.querySelectorAll('.resource-row input,.calendar-button,.resource-group-heading')]){
      element.disabled = value || !selectionToken || element.dataset.resourceUnavailable === 'true';
    }
  }

  function selectedRoomCount(){
    return resources.filter(resource => resource.selectable && resource.kind === 'ROOM' && selected.has(resource.email)).length;
  }

  function displayValue(resource, name){
    if (name === 'kind') return i18n(resource.kind === 'ROOM' ? 'resource_room' : 'resource_resource');
    const value = resource[name];
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    return text.trim() || i18n('resource_not_provided');
  }

  function showDetails(resource){
    currentPrincipalPath = resource?.principalPath || '';
    details.replaceChildren();
    document.getElementById('detailsTitle').textContent = resource?.displayName || i18n('resource_details');
    if (resource){
      for (const [key, name] of fields){
        if (name === 'roomType' && resource.kind !== 'ROOM') continue;
        if (name === 'resourceType' && resource.kind === 'ROOM') continue;
        const term = document.createElement('dt');
        term.textContent = i18n(key);
        const value = document.createElement('dd');
        value.textContent = displayValue(resource, name);
        details.append(term, value);
      }
    }
    for (const row of document.querySelectorAll('.resource-row')){
      row.classList.toggle('is-current', row.dataset.principalPath === currentPrincipalPath);
    }
  }

  function updateSelection(){
    for (const row of document.querySelectorAll('.resource-row')){
      const checked = row.dataset.resourceUnavailable !== 'true' && selected.has(row.dataset.email);
      row.querySelector('input').checked = checked;
      row.classList.toggle('is-selected', checked);
    }
    selectionCount.textContent = i18n('resource_selected_count', [String(selected.size)]);
    apply.disabled = busy || !selectionToken || selectedRoomCount() > 1;
  }

  function createRow(resource){
    const row = document.createElement('div');
    row.className = 'resource-row resource-grid';
    row.dataset.email = resource.email;
    row.dataset.principalPath = resource.principalPath;
    row.dataset.resourceUnavailable = String(!resource.selectable);
    if (!resource.selectable) row.tabIndex = 0;
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = resource.selectable && selected.has(resource.email);
    checkbox.dataset.resourceUnavailable = String(!resource.selectable);
    checkbox.disabled = busy || !selectionToken || !resource.selectable;
    const icon = document.getElementById(resource.kind === 'ROOM' ? 'roomIcon' : 'resourceIcon');
    const text = document.createElement('span');
    text.className = 'resource-label';
    const title = document.createElement('span');
    title.textContent = resource.displayName || resource.email || i18n('resource_not_provided');
    text.append(title);
    label.append(checkbox, icon.content.cloneNode(true), text);
    const calendarButton = document.createElement('button');
    calendarButton.type = 'button';
    calendarButton.className = 'calendar-button';
    calendarButton.append(document.getElementById('calendarIcon').content.cloneNode(true));
    calendarButton.title = `${i18n('resource_show_availability')}: ${resource.displayName || resource.email}`;
    calendarButton.setAttribute('aria-label', calendarButton.title);
    calendarButton.dataset.resourceUnavailable = String(!resource.selectable);
    calendarButton.disabled = busy || !selectionToken || !resource.selectable;
    calendarButton.addEventListener('click', () => openDay(resource, calendarButton));
    checkbox.addEventListener('focus', () => showDetails(resource));
    checkbox.addEventListener('change', () => {
      if (busy || !resource.selectable) return;
      if (checkbox.checked){
        // Keep the selection outside the filtered DOM; a hidden room must also be deselected.
        if (resource.kind === 'ROOM'){
          for (const room of resources){
            if (room.kind === 'ROOM') selected.delete(room.email);
          }
        }
        selected.add(resource.email);
      }else{
        selected.delete(resource.email);
      }
      showDetails(resource);
      updateSelection();
      status.textContent = '';
    });
    const type = document.createElement('span');
    type.textContent = resource.kind === 'ROOM' ? resource.roomType || '—' : '—';
    const place = document.createElement('span');
    place.textContent = resource.buildingName || '—';
    const seats = document.createElement('span');
    seats.className = 'resource-seats';
    if (resource.capacity != null){
      const figure = document.createElement('span');
      figure.className = 'seat-icon';
      figure.textContent = '♟';
      figure.setAttribute('aria-hidden', 'true');
      const number = document.createElement('span');
      number.textContent = String(resource.capacity);
      seats.append(figure, number);
    }else seats.textContent = '—';
    const state = resource.selectable ? availability.get(resource.email)?.state || 'unknown' : 'unknown';
    const available = document.createElement('span');
    available.className = `availability-${state}`;
    available.textContent = `${state === 'unknown' ? '○' : state === 'checking' ? '◌' : '●'} ${i18n(statusKeys[state])}`;
    row.append(label, type, place, seats, available, calendarButton);
    row.addEventListener('click', () => showDetails(resource));
    row.addEventListener('focus', () => showDetails(resource));
    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      showResourceMenu(resource, checkbox, event.clientX, event.clientY);
    });
    row.addEventListener('keydown', event => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu'){
        event.preventDefault();
        const bounds = checkbox.getBoundingClientRect();
        showResourceMenu(resource, checkbox, bounds.left, bounds.bottom);
      }
    });
    return row;
  }

  function metadataValue(resource, field){ return String(resource[field] ?? '').trim(); }

  function featureValues(resource){
    const values = Array.isArray(resource.features) ? resource.features : String(resource.features || '').split(',');
    return values.map(value => value.trim()).filter(Boolean);
  }

  function filterOptions(control, values, selectedValue = control.value){
    const any = document.createElement('option');
    any.value = '*';
    any.textContent = i18n('resource_filter_any');
    const options = [...new Set(values)].sort((left, right) => left.localeCompare(right)).map(value => {
      const option = document.createElement('option');
      option.value = JSON.stringify(value);
      option.textContent = value || i18n('resource_without_information');
      return option;
    });
    control.replaceChildren(any, ...options);
    control.value = options.some(option => option.value === selectedValue) ? selectedValue : '*';
  }

  function matchesMetadata(resource, field, value){
    return value === '*' || JSON.stringify(metadataValue(resource, field)) === value;
  }

  function updateFloors(){
    filterOptions(floor, resources.filter(resource => matchesMetadata(resource, 'buildingName', building.value))
      .map(resource => metadataValue(resource, 'floor')));
  }

  function updateFeaturesLabel(){
    featuresButton.textContent = `${i18n(selectedFeatures.size ? 'resource_features_selected' : 'resource_filter_any', [String(selectedFeatures.size)])} ▾`;
  }

  function configureFilters(){
    filterOptions(building, resources.map(resource => metadataValue(resource, 'buildingName')));
    updateFloors();
    const options = [['none', 'resource_grouping_none']];
    for (const [name, field, key] of [['building', 'buildingName', 'resource_building'], ['floor', 'floor', 'resource_floor'], ['room-type', 'roomType', 'resource_room_type']]){
      if (resources.some(resource => metadataValue(resource, field))) options.push([name, key]);
    }
    grouping.replaceChildren(...options.map(([value, key]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = i18n(key);
      return option;
    }));
    grouping.value = options.some(([value]) => value === preferredGrouping) ? preferredGrouping : 'none';
    const features = new Map();
    for (const resource of resources){
      for (const feature of featureValues(resource)) features.set(feature.toLocaleLowerCase(), feature);
    }
    for (const feature of selectedFeatures){ if (!features.has(feature)) selectedFeatures.delete(feature); }
    featuresMenu.replaceChildren(...[...features].sort((left, right) => left[1].localeCompare(right[1])).map(([key, title]) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selectedFeatures.has(key);
      input.addEventListener('change', () => {
        if (input.checked) selectedFeatures.add(key); else selectedFeatures.delete(key);
        updateFeaturesLabel();
        render();
      });
      const text = document.createElement('span');
      text.textContent = title;
      label.append(input, text);
      return label;
    }));
    updateFeaturesLabel();
  }

  function groupEntries(entries, field){
    const values = new Map();
    for (const resource of entries){
      const value = metadataValue(resource, field);
      if (!values.has(value)) values.set(value, []);
      values.get(value).push(resource);
    }
    return [...values].sort((left, right) => left[0].localeCompare(right[0], undefined, { numeric: true }));
  }

  function createGroup(key, title, entries, children){
    const group = document.createElement('section');
    group.className = 'resource-group';
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = 'resource-group-heading';
    heading.disabled = busy || !selectionToken;
    heading.dataset.groupKey = key;
    const body = document.createElement('div');
    const isCollapsed = collapsed.has(key) ? collapsed.get(key) : !groupsExpanded;
    const update = value => {
      collapsed.set(key, value);
      heading.textContent = `${value ? '▸' : '▾'} ${title} (${entries.length})`;
      heading.setAttribute('aria-expanded', String(!value));
      heading.title = i18n(value ? 'resource_expand_group' : 'resource_collapse_group');
      body.hidden = value;
    };
    update(isCollapsed);
    heading.addEventListener('click', () => update(!body.hidden));
    heading.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight'){
        event.preventDefault();
        update(event.key === 'ArrowLeft');
      }
    });
    body.append(...(children || entries.map(createRow)));
    group.append(heading, body);
    return group;
  }

  function render(){
    const term = search.value.trim().toLocaleLowerCase();
    const minimum = Math.max(0, Number(capacity.value) || 0);
    const visible = resources.filter(resource => fields.some(([, name]) => displayValue(resource, name).toLocaleLowerCase().includes(term))
      && matchesMetadata(resource, 'buildingName', building.value) && matchesMetadata(resource, 'floor', floor.value)
      && (!minimum || (resource.capacity != null && resource.capacity >= minimum))
      && [...selectedFeatures].every(feature => featureValues(resource).some(value => value.toLocaleLowerCase() === feature))
      && (!onlyAvailable.checked || resource.selectable && availability.get(resource.email)?.state === 'free'));
    const focusedPrincipalPath = document.activeElement?.closest?.('.resource-row')?.dataset.principalPath;
    const focusedClass = document.activeElement?.className;
    const focusedGroup = document.activeElement?.dataset?.groupKey;
    const groups = [];
    if (grouping.value === 'building'){
      for (const [name, entries] of groupEntries(visible, 'buildingName')){
        const key = JSON.stringify(['building', name]);
        const children = groupEntries(entries, 'floor').map(([level, rooms]) => createGroup(JSON.stringify(['building', name, level]),
          `${i18n('resource_floor')} ${level || i18n('resource_without_information')}`, rooms));
        groups.push(createGroup(key, name || i18n('resource_without_information'), entries, children));
      }
    }else{
      for (const [kind, key] of [['ROOM', 'resource_rooms'], ['RESOURCE', 'resource_resources']]){
        const entries = visible.filter(resource => resource.kind === kind);
        if (!entries.length) continue;
        const field = grouping.value === 'floor' ? 'floor' : grouping.value === 'room-type' && kind === 'ROOM' ? 'roomType' : '';
        const children = field ? groupEntries(entries, field).map(([name, rooms]) =>
          createGroup(JSON.stringify([grouping.value, kind, name]), name || i18n('resource_without_information'), rooms)) : null;
        groups.push(createGroup(JSON.stringify([grouping.value, kind]), i18n(key), entries, children));
      }
    }
    document.getElementById('groups').replaceChildren(...groups);
    const empty = document.getElementById('empty');
    empty.hidden = visible.length !== 0;
    empty.textContent = i18n(onlyAvailable.checked && [...availability.values()].some(value => value.state === 'checking')
      ? 'resource_checking' : resources.length ? 'resource_no_matches' : 'resource_empty');
    showDetails(visible.find(resource => resource.principalPath === currentPrincipalPath) || visible[0]);
    updateSelection();
    expandAll.textContent = i18n(groupsExpanded ? 'resource_collapse_all' : 'resource_expand_all');
    if (focusedPrincipalPath){
      const row = [...document.querySelectorAll('.resource-row')].find(entry => entry.dataset.principalPath === focusedPrincipalPath);
      if (row?.dataset.resourceUnavailable === 'true') row.focus();
      else row?.querySelector(focusedClass === 'calendar-button' ? 'button' : 'input')?.focus();
    }
    if (focusedGroup){
      [...document.querySelectorAll('.resource-group-heading')].find(heading => heading.dataset.groupKey === focusedGroup)?.focus();
    }
  }

  function showFailure(response, fallbackKey){
    // An earlier grace notice must not accompany a later access refusal or failed refresh.
    policyWarningRow.hidden = true;
    status.textContent = response?.error || i18n(fallbackKey);
    status.classList.add('is-error');
    reauthenticate.hidden = response?.code !== 'auth_required';
  }

  function sameInterval(left, right){
    return left === right || !!(left && right && left.start === right.start && left.end === right.end && left.timeZone === right.timeZone);
  }

  function validInterval(value){
    if (!value || !Number.isFinite(value.start) || !Number.isFinite(value.end) || value.end <= value.start || typeof value.timeZone !== 'string') return null;
    try{
      new Intl.DateTimeFormat(undefined, { timeZone: value.timeZone }).format(value.start);
      return value;
    }catch(error){
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'invalid appointment time zone', error);
      return null;
    }
  }

  function formatTime(value, date = false){
    return new Intl.DateTimeFormat(undefined, { timeZone: interval.timeZone,
      ...(date ? { dateStyle: 'short', timeStyle: 'short' } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }).format(value);
  }

  function setInterval(value){
    const current = validInterval(value);
    const changed = !sameInterval(interval, current);
    interval = current;
    if (changed){ queryRevision++; availability.clear(); }
    document.getElementById('interval').textContent = `${i18n('resource_appointment_interval')}: ${interval
      ? `${formatTime(interval.start, true)} – ${formatTime(interval.end, true)} · ${interval.timeZone}` : i18n('resource_unknown')}`;
    return changed;
  }

  async function cancelQuery(lane){
    if (!selectionToken) return;
    try{
      await browser.runtime.sendMessage({ type: 'resource:cancel', contextId, selectionToken, lane });
    }catch(error){
      if (!unloading) NCLogContext.safeConsoleError('[NCUI][Resources]', 'availability cancellation failed', error);
    }
  }

  function rejectAccess(response){
    if (applying) return;
    if (!response || ['resource_availability_failed', 'resource_request_cancelled'].includes(response.code)) return;
    if (response.code){
      showFailure(response, 'resource_load_failed');
      closeSession(selectionToken);
      selectionToken = '';
      queryRevision++;
      dayRevision++;
      availability.clear();
      retry.hidden = response.code === 'resource_context_expired';
      setBusy(false);
      render();
    }
  }

  async function checkAvailability(){
    const revision = ++queryRevision;
    const token = selectionToken;
    const window = interval;
    availability.clear();
    for (const resource of resources){
      if (resource.selectable) availability.set(resource.email, { state: window ? 'checking' : 'unknown' });
    }
    render();
    if (!window || !token){ await cancelQuery('interval'); return; }
    try{
      const response = await browser.runtime.sendMessage({ type: 'resource:availability', contextId, selectionToken: token, requestId: `interval-${revision}` });
      if (unloading || revision !== queryRevision || token !== selectionToken) return;
      if (!response?.ok){
        rejectAccess(response);
      }else if (!sameInterval(window, response.interval)){
        setInterval(response.interval);
        void checkAvailability();
        return;
      }
      const results = new Map((response?.ok && Array.isArray(response.results) ? response.results : []).map(value => [value.email, value]));
      for (const resource of resources){
        if (!resource.selectable) continue;
        const result = results.get(resource.email);
        const state = result && ['free', 'busy'].includes(result.state) && result.start <= window.start && result.end >= window.end ? result.state : 'unknown';
        availability.set(resource.email, { state });
      }
    }catch(error){
      if (unloading || revision !== queryRevision) return;
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'availability query failed', error);
      for (const resource of resources) availability.set(resource.email, { state: 'unknown' });
    }
    if (!unloading && revision === queryRevision) render();
  }

  async function refreshInterval(){
    if (unloading || busy || !selectionToken || readingInterval) return;
    readingInterval = true;
    const token = selectionToken;
    const revision = loadRevision;
    try{
      const response = await browser.runtime.sendMessage({ type: 'resource:interval', contextId, selectionToken: token });
      if (unloading || applying || token !== selectionToken || revision !== loadRevision) return;
      if (!response?.ok){
        rejectAccess(response);
        setInterval(null);
        availability.clear();
        dayRevision++;
        void cancelQuery();
        if (dayResource) void loadDay();
        render();
      }else if (setInterval(response.interval)){
        void checkAvailability();
        if (dayResource) void loadDay();
      }
    }catch(error){
      if (unloading || applying || token !== selectionToken || revision !== loadRevision) return;
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'appointment interval refresh failed', error);
      setInterval(null);
      availability.clear();
      dayRevision++;
      void cancelQuery();
      if (dayResource) void loadDay();
      render();
    }finally{ readingInterval = false; }
  }

  function savePreferences(){
    const values = { calendarResourceGrouping: grouping.value, calendarResourceGroupsExpanded: groupsExpanded };
    preferenceWrites = preferenceWrites.then(() => browser.storage.local.set(values)).catch(error => {
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'resource view preference save failed', error);
      if (!unloading){ status.textContent = i18n('resource_grouping_save_failed'); status.classList.add('is-error'); }
    });
  }

  function showResourceMenu(resource, source, x, y){
    if (busy || !selectionToken || !resource.selectable) return;
    menuResource = resource;
    returnFocus = source;
    resourceMenu.hidden = false;
    resourceMenu.style.left = `${Math.max(0, Math.min(x, document.documentElement.clientWidth - resourceMenu.offsetWidth))}px`;
    resourceMenu.style.top = `${Math.max(0, Math.min(y, document.documentElement.clientHeight - resourceMenu.offsetHeight))}px`;
    document.getElementById('showAvailability').focus();
  }

  function dateInZone(value){
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: interval.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
    const get = type => parts.find(part => part.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function openDay(resource, source){
    if (busy || !selectionToken || !resource.selectable) return;
    dayResource = resource;
    returnFocus = source;
    resourceMenu.hidden = true;
    dayView.hidden = false;
    main.inert = true;
    document.querySelector('footer').inert = true;
    document.getElementById('dayTitle').textContent = `${i18n('resource_availability_title')} · ${resource.displayName || resource.email}`;
    closeDatePicker();
    setDayDate(interval ? dateInZone(interval.start) : '');
    dayDate.focus();
    void loadDay();
  }

  function closeDay(){
    closeDatePicker();
    dayRevision++;
    dayResource = null;
    dayView.hidden = true;
    main.inert = false;
    document.querySelector('footer').inert = false;
    void cancelQuery('day');
    if (returnFocus?.isConnected) returnFocus.focus(); else search.focus();
  }

  function setDayDate(value){
    dayDate.value = value;
    dayDate.textContent = value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
      .format(new Date(`${value}T12:00:00Z`)) : i18n('resource_unknown');
    dayDate.append(document.getElementById('calendarIcon').content.cloneNode(true));
    dayDate.disabled = !value;
  }

  function closeDatePicker(restoreFocus = false){
    datePopover.hidden = true;
    dayDate.setAttribute('aria-expanded', 'false');
    if (restoreFocus) dayDate.focus();
  }

  function renderDatePicker(focusDate = false){
    const year = calendarCursor.getUTCFullYear(), month = calendarCursor.getUTCMonth();
    const first = new Date(calendarCursor);
    first.setUTCDate(1);
    const offset = (first.getUTCDay() + 6) % 7;
    const cursorIso = calendarCursor.toISOString().slice(0, 10);
    const todayIso = interval ? dateInZone(Date.now()) : '';
    const monthText = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const weekdayText = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
    const fullDayText = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' });
    document.getElementById('calendarMonth').textContent = monthText.format(first);
    document.getElementById('previousMonth').disabled = year === 1 && month === 0;
    document.getElementById('nextMonth').disabled = year === 9999 && month === 11;
    const weekdays = document.getElementById('calendarWeekdays');
    weekdays.replaceChildren();
    for (let index = 0; index < 7; index++){
      const day = new Date(first);
      day.setUTCDate(1 - offset + index);
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = weekdayText.format(day);
      cell.setAttribute('aria-label', new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(day));
      weekdays.append(cell);
    }
    calendarDays.replaceChildren();
    for (let week = 0; week < 6; week++){
      const row = document.createElement('tr');
      for (let column = 0; column < 7; column++){
        const date = new Date(first);
        date.setUTCDate(1 - offset + week * 7 + column);
        const cell = document.createElement('td');
        if (date.getUTCMonth() === month){
          const value = date.toISOString().slice(0, 10);
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'calendar-date';
          button.classList.toggle('is-selected', value === dayDate.value);
          button.dataset.date = value;
          button.tabIndex = value === cursorIso ? 0 : -1;
          button.textContent = new Intl.NumberFormat().format(date.getUTCDate());
          button.setAttribute('aria-label', fullDayText.format(date));
          if (value === todayIso) button.setAttribute('aria-current', 'date');
          cell.setAttribute('aria-selected', String(value === dayDate.value));
          button.addEventListener('click', () => {
            setDayDate(value);
            closeDatePicker(true);
            void loadDay();
          });
          cell.append(button);
        }
        row.append(cell);
      }
      calendarDays.append(row);
    }
    if (focusDate) [...calendarDays.querySelectorAll('button')].find(button => button.dataset.date === cursorIso)?.focus();
  }

  function moveCalendarMonth(step, focusDate = false){
    const date = new Date(calendarCursor);
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + step);
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
    const end = new Date(date);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(day, end.getUTCDate()));
    calendarCursor = date;
    renderDatePicker(focusDate);
  }

  function drawDay(range, result){
    const timeline = document.getElementById('timeline');
    timeline.replaceChildren();
    if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start || !interval) return false;
    const known = result && ['free', 'busy'].includes(result.state) && result.start <= range.start && result.end >= range.end && Array.isArray(result.periods);
    const duration = range.end - range.start;
    timeline.style.height = `${duration / 3600000 * 36}px`;
    const track = document.createElement('div');
    track.className = `day-track${known ? '' : ' is-unknown'}`;
    timeline.append(track);
    for (let at = range.start; at < range.end; at += 3600000){
      const hour = document.createElement('div');
      hour.className = 'day-hour';
      hour.style.top = `${(at - range.start) / duration * 100}%`;
      hour.textContent = formatTime(at);
      timeline.append(hour);
    }
    const block = (start, end, className) => {
      const from = Math.max(range.start, start), to = Math.min(range.end, end);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
      const entry = document.createElement('div');
      entry.className = className;
      entry.style.top = `${(from - range.start) / duration * 100}%`;
      entry.style.height = `${(to - from) / duration * 100}%`;
      entry.title = `${i18n(className === 'day-busy' ? 'resource_busy' : 'resource_appointment_interval')}: ${formatTime(from)} – ${formatTime(to)}`;
      entry.setAttribute('aria-label', entry.title);
      timeline.append(entry);
    };
    if (known) for (const period of result.periods) block(period.start, period.end, 'day-busy');
    block(interval.start, interval.end, 'day-appointment');
    document.getElementById('dayScroll').scrollTop = Math.max(0, (interval.start >= range.start && interval.start < range.end
      ? (interval.start - range.start) / 3600000 - 1 : 7) * 36);
    return known;
  }

  async function loadDay(){
    const revision = ++dayRevision;
    const token = selectionToken;
    const resource = dayResource;
    if (!resource) return;
    document.getElementById('timeline').replaceChildren();
    const dayStatus = document.getElementById('dayStatus');
    dayStatus.textContent = i18n(interval ? 'resource_checking' : 'resource_unknown');
    document.getElementById('dayZone').textContent = `${i18n('resource_time_zone')}: ${interval?.timeZone || i18n('resource_unknown')}`;
    if (!interval || !dayDate.value || !token){ await cancelQuery('day'); return; }
    try{
      const response = await browser.runtime.sendMessage({ type: 'resource:availability', contextId, selectionToken: token,
        requestId: `day-${revision}`, email: resource.email, date: dayDate.value });
      if (unloading || revision !== dayRevision || token !== selectionToken) return;
      if (!response?.ok){ rejectAccess(response); dayStatus.textContent = response?.error || i18n('resource_availability_failed'); return; }
      if (!sameInterval(interval, response.interval)){
        setInterval(response.interval);
        void checkAvailability();
        void loadDay();
        return;
      }
      const result = Array.isArray(response.results) ? response.results.find(value => value.email === resource.email) : null;
      dayStatus.textContent = drawDay(response.range, result) ? '' : i18n('resource_availability_failed');
    }catch(error){
      if (unloading || revision !== dayRevision) return;
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'day availability query failed', error);
      dayStatus.textContent = i18n('resource_availability_failed');
    }
  }

  async function load(){
    const revision = ++loadRevision;
    queryRevision++;
    dayRevision++;
    policyWarningRow.hidden = true;
    setBusy(true);
    await cancelQuery();
    if (unloading || revision !== loadRevision) return;
    selectionToken = '';
    setBusy(true);
    retry.hidden = true;
    reauthenticate.hidden = true;
    status.classList.remove('is-error');
    status.textContent = i18n('resource_loading');
    if (!contextId){
      showFailure(null, 'resource_context_expired');
      setBusy(false);
      return;
    }
    try{
      const response = await browser.runtime.sendMessage({ type: 'resource:list', contextId });
      if (unloading || revision !== loadRevision) return;
      if (!response?.ok){
        showFailure(response, 'resource_load_failed');
        retry.hidden = response?.code === 'resource_context_expired';
        return;
      }
      if (!Array.isArray(response.resources) || !Array.isArray(response.selectedEmails)
        || typeof response.selectionToken !== 'string' || !response.selectionToken){
        throw new Error('Invalid resource list response');
      }
      resources = response.resources.slice().sort((left, right) => Number(left.kind !== 'ROOM') - Number(right.kind !== 'ROOM')
        || String(left.displayName || left.email).localeCompare(String(right.displayName || right.email)));
      const known = new Set(resources.filter(resource => resource.selectable).map(resource => resource.email));
      selected = new Set(response.selectedEmails.filter(email => known.has(email)));
      selectionToken = response.selectionToken;
      configureFilters();
      setInterval(response.interval);
      NCWizardPolicyUi.applyPolicyWarningUi({
        row: policyWarningRow,
        textElement: policyWarningText,
        adminLink: policyWarningAdminLink,
        policyStatus: response.policyStatus,
        translate: i18n
      });
      status.textContent = selectedRoomCount() > 1 ? i18n('resource_invalid_selection') : '';
      render();
      void checkAvailability();
    }catch(error){
      if (unloading || revision !== loadRevision) return;
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'resource list failed', error);
      showFailure(null, 'resource_load_failed');
      retry.hidden = false;
    }finally{
      if (!unloading && revision === loadRevision){
        setBusy(false);
        if (selectionToken) search.focus();
      }
    }
  }

  apply.addEventListener('click', async () => {
    if (busy || !selectionToken || selectedRoomCount() > 1) return;
    applying = true;
    queryRevision++;
    dayRevision++;
    setBusy(true);
    status.classList.remove('is-error');
    status.textContent = i18n('resource_applying');
    try{
      await cancelQuery();
      if (unloading) return;
      const response = await browser.runtime.sendMessage({
        type: 'resource:apply', contextId, selectionToken, selectedEmails: Array.from(selected)
      });
      if (unloading) return;
      if (!response?.ok){
        showFailure(response, 'resource_apply_failed');
        // Never repeat an uncertain editor write against the previous snapshot.
        closeSession(selectionToken);
        selectionToken = '';
        retry.hidden = response?.code === 'resource_context_expired';
        return;
      }
      window.close();
    }catch(error){
      if (unloading) return;
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'resource selection write failed', error);
      closeSession(selectionToken);
      selectionToken = '';
      showFailure(null, 'resource_apply_failed');
      retry.hidden = false;
    }finally{
      applying = false;
      setBusy(false);
    }
  });
  reauthenticate.addEventListener('click', async () => {
    reauthenticate.disabled = true;
    try{
      await browser.runtime.sendMessage({ type: 'connection:openOptions', reauthenticate: true });
      window.close();
    }catch(error){
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'open sign-in settings failed', error);
      showFailure(null, 'resource_load_failed');
      reauthenticate.disabled = false;
    }
  });
  search.addEventListener('input', render);
  building.addEventListener('change', () => { updateFloors(); render(); });
  floor.addEventListener('change', render);
  capacity.addEventListener('input', render);
  onlyAvailable.addEventListener('change', render);
  grouping.addEventListener('change', () => {
    preferredGrouping = grouping.value;
    render();
    savePreferences();
  });
  expandAll.addEventListener('click', () => {
    groupsExpanded = !groupsExpanded;
    collapsed.clear();
    render();
    savePreferences();
  });
  clearFilters.addEventListener('click', () => {
    search.value = '';
    building.value = '*';
    floor.value = '*';
    capacity.value = '0';
    onlyAvailable.checked = false;
    selectedFeatures.clear();
    configureFilters();
    render();
  });
  featuresButton.addEventListener('click', () => {
    featuresMenu.hidden = !featuresMenu.hidden;
    featuresButton.setAttribute('aria-expanded', String(!featuresMenu.hidden));
    if (!featuresMenu.hidden) featuresMenu.querySelector('input')?.focus();
  });
  document.addEventListener('click', event => {
    if (!featuresMenu.contains(event.target) && event.target !== featuresButton){
      featuresMenu.hidden = true;
      featuresButton.setAttribute('aria-expanded', 'false');
    }
    if (!resourceMenu.contains(event.target)) resourceMenu.hidden = true;
    if (!dateControl.contains(event.target)) closeDatePicker();
  });
  document.getElementById('showAvailability').addEventListener('click', () => {
    if (menuResource) openDay(menuResource, returnFocus);
    resourceMenu.hidden = true;
  });
  document.getElementById('dayClose').addEventListener('click', closeDay);
  dayDate.addEventListener('click', () => {
    if (!datePopover.hidden){ closeDatePicker(true); return; }
    calendarCursor = new Date(`${dayDate.value}T12:00:00Z`);
    if (!Number.isFinite(calendarCursor.getTime())) return;
    datePopover.hidden = false;
    datePopover.style.maxHeight = `${Math.max(0, dayView.getBoundingClientRect().bottom - dayDate.getBoundingClientRect().bottom - 10)}px`;
    dayDate.setAttribute('aria-expanded', 'true');
    renderDatePicker(true);
  });
  document.getElementById('calendarClose').addEventListener('click', () => closeDatePicker(true));
  document.getElementById('previousMonth').addEventListener('click', () => moveCalendarMonth(-1));
  document.getElementById('nextMonth').addEventListener('click', () => moveCalendarMonth(1));
  dateControl.addEventListener('focusout', event => {
    // Native focus changes can expose body before the destination receives focus.
    if (dateControl.contains(event.relatedTarget)) return;
    // Grid redraws replace the focused button before focusing its successor.
    void Promise.resolve().then(() => {
      if (!dateControl.contains(document.activeElement)) closeDatePicker();
    });
  });
  calendarDays.addEventListener('keydown', event => {
    const button = event.target.closest('.calendar-date');
    if (!button) return;
    const date = new Date(`${button.dataset.date}T12:00:00Z`);
    const weekday = (date.getUTCDay() + 6) % 7;
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
    if (Object.hasOwn(steps, event.key)){
      event.preventDefault();
      date.setUTCDate(date.getUTCDate() + steps[event.key]);
      if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
      calendarCursor = date;
      renderDatePicker(true);
    }else if (event.key === 'PageUp' || event.key === 'PageDown'){
      event.preventDefault();
      calendarCursor = date;
      moveCalendarMonth((event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1), true);
    }
  });
  for (const [id, step] of [['previousDay', -1], ['nextDay', 1]]){
    document.getElementById(id).addEventListener('click', () => {
      const date = new Date(`${dayDate.value}T12:00:00Z`);
      if (!Number.isFinite(date.getTime())) return;
      date.setUTCDate(date.getUTCDate() + step);
      if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
      closeDatePicker();
      setDayDate(date.toISOString().slice(0, 10));
      void loadDay();
    });
  }
  document.getElementById('today').addEventListener('click', () => {
    if (!interval) return;
    closeDatePicker();
    setDayDate(dateInZone(Date.now()));
    void loadDay();
  });
  retry.addEventListener('click', () => void load());
  cancel.addEventListener('click', () => { if (!cancel.disabled) window.close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape'){
      event.preventDefault();
      if (!resourceMenu.hidden){ resourceMenu.hidden = true; returnFocus?.focus(); }
      else if (!featuresMenu.hidden){
        featuresMenu.hidden = true;
        featuresButton.setAttribute('aria-expanded', 'false');
        featuresButton.focus();
      }else if (!datePopover.hidden) closeDatePicker(true);
      else if (!dayView.hidden) closeDay();
      else if (!cancel.disabled) window.close();
    }
    if (event.key === 'Tab' && !dayView.hidden){
      const scope = datePopover.hidden ? dayView : datePopover;
      const controls = [...scope.querySelectorAll('button,input,[tabindex="0"]')]
        .filter(element => !element.disabled && element.tabIndex >= 0 && !element.closest('[hidden]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first){ event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last){ event.preventDefault(); first.focus(); }
    }
  });
  function closeSession(token){
    void browser.runtime.sendMessage({ type: 'resource:close', contextId, selectionToken: token || null }).catch(error => {
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'resource session cleanup failed', error);
    });
  }
  window.addEventListener('pagehide', () => {
    unloading = true;
    clearTimeout(intervalTimer);
    queryRevision++;
    dayRevision++;
    closeSession(selectionToken);
  }, { once: true });
  async function initialize(){
    try{
      const preferences = await browser.storage.local.get(preferenceKeys);
      if (['none', 'building', 'floor', 'room-type'].includes(preferences.calendarResourceGrouping)) preferredGrouping = preferences.calendarResourceGrouping;
      if (typeof preferences.calendarResourceGroupsExpanded === 'boolean') groupsExpanded = preferences.calendarResourceGroupsExpanded;
    }catch(error){
      NCLogContext.safeConsoleError('[NCUI][Resources]', 'resource preferences unavailable', error);
    }
    if (unloading) return;
    await load();
    const poll = async () => {
      if (unloading) return;
      await refreshInterval();
      if (!unloading) intervalTimer = setTimeout(poll, 2000);
    };
    if (!unloading) intervalTimer = setTimeout(poll, 2000);
  }
  document.addEventListener('DOMContentLoaded', () => {
    NCTalkDomI18n.translatePage(i18n, { titleKey: 'resource_title' });
    for (const [id, key] of [['previousDay', 'resource_previous_day'], ['nextDay', 'resource_next_day'],
      ['previousMonth', 'resource_previous_month'], ['nextMonth', 'resource_next_month']]){
      const button = document.getElementById(id);
      button.title = i18n(key);
      button.setAttribute('aria-label', i18n(key));
    }
    void initialize();
  }, { once: true });
})();
