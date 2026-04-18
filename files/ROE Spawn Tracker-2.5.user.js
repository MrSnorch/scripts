// ==UserScript==
// @name         ROE Spawn Tracker
// @namespace    roe.spawntracker
// @version      2.5
// @description  Tracks mob spawns and resources with filters, tracking system, auto-refresh and resizable panel
// @match        https://vq-roe-test.vercel.app/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────
  let prevEnemies = {};
  let knownTypes  = new Set();
  let knownZones  = new Set();

  let lastStateByZone     = {};
  let lastResourcesByZone = {};
  let knownResNames       = new Set();

  // ─── Tracking ────────────────────────────────────────────────────────────────
  let trackedResources          = new Map();
  let trackedMobs               = new Map();
  let trackIdCounter            = 0;
  let previousTrackedStates     = new Map();
  let previousTrackedMobStates  = new Map();

  // ─── Auto-refresh ────────────────────────────────────────────────────────────
  let _hooked_socket         = null;
  let _autoRefreshInterval   = null;
  let _autoRefreshEnabled    = true;
  let _autoRefreshIntervalMs = 30000;

  function startAutoRefresh() {
    if (_autoRefreshInterval) clearInterval(_autoRefreshInterval);
    _autoRefreshInterval = setInterval(() => {
      if (_autoRefreshEnabled && _hooked_socket && _hooked_socket.connected) {
        _hooked_socket.emit('request_spawn_state');
      }
    }, _autoRefreshIntervalMs);
  }

  function stopAutoRefresh() {
    if (_autoRefreshInterval) { clearInterval(_autoRefreshInterval); _autoRefreshInterval = null; }
  }

  // ─── Storage keys ────────────────────────────────────────────────────────────
  const TRACK_STORAGE_KEY          = 'roeSpawnMonitor_tracked';
  const WORLD_SNAPSHOT_STORAGE_KEY = 'roeSpawnMonitor_worldSnapshot';
  const STORAGE_KEY                = 'roeSpawnMonitor_filters';
  const NOTIFY_STORAGE_KEY         = 'roeSpawnMonitor_notifyPrefs';
  const TAB_ORDER_STORAGE_KEY      = 'roeSpawnMonitor_tabOrder';
  const PANEL_STORAGE_KEY          = 'roeSpawnMonitor_panel';
  const AUTO_REFRESH_STORAGE_KEY   = 'roeSpawnMonitor_autoRefresh';
  const PANEL_SIZE_STORAGE_KEY     = 'roeSpawnMonitor_panelSize';

  // ─── Serializers ─────────────────────────────────────────────────────────────
  function serializeTrackedNodes(nodes) {
    return (Array.isArray(nodes) ? nodes : []).map(n => ({
      idx:   typeof n.idx === 'number' ? n.idx : null,
      id:    n.id ?? null,
      active: n.active === true,
      alive:  n.alive  === true,
      hp:    Number(n.hp)    || 0,
      maxHp: Number(n.maxHp) || 0,
      pos:   { x: Number(n?.pos?.x) || 0, y: Number(n?.pos?.y) || 0 }
    }));
  }

  function serializeWorldEnemies(enemies) {
    return (Array.isArray(enemies) ? enemies : []).map(e => ({
      id:       e.id ?? null,
      statsKey: e.statsKey || '',
      type:     e.type     || '',
      alive:    e.alive    === true,
      hp:    Number(e.hp)    || 0,
      maxHp: Number(e.maxHp) || 0,
      pos:   { x: Number(e?.pos?.x) || 0, y: Number(e?.pos?.y) || 0 }
    }));
  }

  function serializeWorldResources(resources) {
    return (Array.isArray(resources) ? resources : []).map((r, idx) => ({
      idx:      typeof r.idx === 'number' ? r.idx : idx,
      id:       r.id       ?? null,
      resource: r.resource || '',
      type:     r.type     || '',
      rarity:   r.rarity   || '',
      weakness: r.weakness || '',
      active:   r.active   === true,
      hp:    Number(r.hp)    || 0,
      maxHp: Number(r.maxHp) || 0,
      pos:   { x: Number(r?.pos?.x) || 0, y: Number(r?.pos?.y) || 0 }
    }));
  }

  function rebuildPrevEnemiesFromSnapshot() {
    const restored = { __zones: {} };
    Object.entries(lastStateByZone).forEach(([zone, enemies]) => {
      restored.__zones[zone] = true;
      enemies.forEach(e => { if (e && e.id != null) restored[e.id] = { ...e }; });
    });
    prevEnemies = restored;
  }

  // ─── World snapshot ──────────────────────────────────────────────────────────
  function saveWorldSnapshot() {
    try {
      const sz = {}, rz = {};
      Object.entries(lastStateByZone).forEach(([z, e])     => { sz[z] = serializeWorldEnemies(e); });
      Object.entries(lastResourcesByZone).forEach(([z, r]) => { rz[z] = serializeWorldResources(r); });
      localStorage.setItem(WORLD_SNAPSHOT_STORAGE_KEY, JSON.stringify({
        lastStateByZone: sz, lastResourcesByZone: rz,
        knownZones:    Array.from(knownZones),
        knownTypes:    Array.from(knownTypes),
        knownResNames: Array.from(knownResNames)
      }));
    } catch (e) {}
  }

  function loadWorldSnapshot() {
    try {
      const raw = localStorage.getItem(WORLD_SNAPSHOT_STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      const rsz = {}, rrz = {};
      Object.entries(p.lastStateByZone     || {}).forEach(([z, e]) => { rsz[z] = serializeWorldEnemies(e); });
      Object.entries(p.lastResourcesByZone || {}).forEach(([z, r]) => { rrz[z] = serializeWorldResources(r); });
      lastStateByZone = rsz; lastResourcesByZone = rrz;
      knownZones    = new Set(Array.isArray(p.knownZones)    ? p.knownZones    : []);
      knownTypes    = new Set(Array.isArray(p.knownTypes)    ? p.knownTypes    : []);
      knownResNames = new Set(Array.isArray(p.knownResNames) ? p.knownResNames : []);
      Object.keys(rsz).forEach(z => knownZones.add(z));
      Object.keys(rrz).forEach(z => knownZones.add(z));
      Object.values(rsz).forEach(es => es.forEach(e => knownTypes.add(e.statsKey)));
      Object.values(rrz).forEach(rs => rs.forEach(r => knownResNames.add(r.resource)));
      rebuildPrevEnemiesFromSnapshot();
    } catch (e) {}
  }

  // ─── Tracked save/load ───────────────────────────────────────────────────────
  function saveTracked() {
    try {
      const resources = [], mobs = [];
      trackedResources.forEach((v, k) => resources.push({
        id: k, zone: v.zone, resource: v.resource, type: v.type,
        rarity: v.rarity, weakness: v.weakness, notifyOnSpawn: v.notifyOnSpawn,
        nodes: serializeTrackedNodes(v.nodes)
      }));
      trackedMobs.forEach((v, k) => mobs.push({
        id: k, zone: v.zone, statsKey: v.statsKey, type: v.type,
        notifyOnSpawn: v.notifyOnSpawn, nodes: serializeTrackedNodes(v.nodes)
      }));
      localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify({ resources, mobs, counter: trackIdCounter }));
    } catch (e) {}
  }

  function loadTracked() {
    try {
      const raw = localStorage.getItem(TRACK_STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      const resources = Array.isArray(p.resources) ? p.resources : (p.arr || []);
      const mobs      = Array.isArray(p.mobs)      ? p.mobs      : [];
      trackIdCounter  = p.counter || 0;
      resources.forEach(item => {
        const nodes = serializeTrackedNodes(item.nodes);
        trackedResources.set(item.id, { kind: 'resource', zone: item.zone, resource: item.resource,
          type: item.type, rarity: item.rarity, weakness: item.weakness,
          notifyOnSpawn: item.notifyOnSpawn !== false, nodes });
        previousTrackedStates.set(item.id, { activeCount: nodes.filter(n => n.active).length });
      });
      mobs.forEach(item => {
        const nodes = serializeTrackedNodes(item.nodes);
        trackedMobs.set(item.id, { kind: 'mob', zone: item.zone, statsKey: item.statsKey,
          type: item.type, notifyOnSpawn: item.notifyOnSpawn !== false, nodes });
        previousTrackedMobStates.set(item.id, { aliveCount: nodes.filter(n => n.alive).length });
      });
    } catch (e) {}
  }

  // ─── Panel size save/load ─────────────────────────────────────────────────────
  function savePanelSize() {
    try {
      localStorage.setItem(PANEL_SIZE_STORAGE_KEY, JSON.stringify({
        width:  panel.offsetWidth,
        height: panel.offsetHeight
      }));
    } catch (e) {}
  }

  function loadPanelSize() {
    try {
      const raw = localStorage.getItem(PANEL_SIZE_STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      // ← CHANGE: threshold lowered from 320 to 120
      if (p.width  && p.width  > 120) panel.style.width  = p.width  + 'px';
      if (p.height && p.height > 200) {
        panel.style.height    = p.height + 'px';
        panel.style.maxHeight = 'none';
      }
    } catch (e) {}
  }

  // ─── Filters ─────────────────────────────────────────────────────────────────
  let filterZone   = 'ALL';
  let filterType   = 'ALL';
  let filterStatus = 'ALL';

  let resFilterZone   = 'ALL';
  let resFilterType   = 'ALL';
  let resFilterName   = 'ALL';
  let resFilterStatus = 'ALL';



  function saveFilters() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        filterZone, filterType, filterStatus,
        resFilterZone, resFilterType, resFilterName, resFilterStatus,
        resSearch: document.getElementById('roeResSearch')?.value || ''
      }));
    } catch (e) {}
  }

  const DEFAULT_NOTIFY_PREFS = { soundEnabled: true, desktopEnabled: false };

  function loadNotifyPrefs() {
    try {
      const raw = localStorage.getItem(NOTIFY_STORAGE_KEY);
      const p   = raw ? JSON.parse(raw) : {};
      return {
        soundEnabled:   p.soundEnabled !== false,
        desktopEnabled: p.desktopEnabled === true &&
          typeof Notification !== 'undefined' && Notification.permission === 'granted'
      };
    } catch (e) { return { ...DEFAULT_NOTIFY_PREFS }; }
  }

  function saveNotifyPrefs() {
    try { localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(notificationPrefs)); } catch (e) {}
  }

  function loadPanelState()  { return null; }
  function clearPanelState() { try { localStorage.removeItem(PANEL_STORAGE_KEY); } catch (e) {} }

  const notificationPrefs = loadNotifyPrefs();

  loadTracked();
  loadWorldSnapshot();

  // ─── Style helpers ───────────────────────────────────────────────────────────
  function btnStyle(bg) {
    return `background:${bg};color:#ccc;border:1px solid #444;border-radius:4px;
            padding:3px 8px;cursor:pointer;font-size:11px;font-family:monospace;`;
  }
  function selStyle() {
    return `background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:4px;
            padding:2px 4px;font-size:11px;font-family:monospace;`;
  }
  function tabStyle(active) {
    return `flex:1;padding:5px 2px;border:none;cursor:pointer;font-size:11px;font-family:monospace;
            background:${active ? '#1a1a2e' : '#0d0d0d'};
            color:${active ? '#7b8fff' : '#666'};
            border-bottom:2px solid ${active ? '#7b8fff' : 'transparent'};
            overflow:hidden;white-space:nowrap;`;
  }

  // ─── Panel ───────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'roeSpawnPanel';
  // ← CHANGE: min-width reduced from 320px to 120px
  panel.style.cssText = `
    position:fixed;top:10px;right:10px;width:520px;
    background:rgba(10,10,10,0.97);color:#e0e0e0;
    font-family:'Consolas',monospace;font-size:12px;
    z-index:999999;border:1px solid #333;border-radius:6px;
    display:flex;flex-direction:column;
    box-shadow:0 4px 24px rgba(0,0,0,0.7);
    user-select:none;min-width:120px;min-height:120px;max-height:90vh;
    overflow:hidden;
  `;

  // ─── Header ──────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = `
    padding:6px 8px;background:#1a1a2e;border-bottom:1px solid #333;
    border-radius:6px 6px 0 0;display:flex;align-items:center;gap:4px;
    flex-wrap:wrap;cursor:move;flex-shrink:0;
  `;
  header.innerHTML = `
    <span id="roeTitle" style="color:#7b8fff;font-weight:bold;font-size:12px;white-space:nowrap">ROE</span>
    <span id="roeSpawnCount" style="color:#888;font-size:10px;white-space:nowrap">0 ev</span>
    <span style="flex:1;min-width:4px"></span>
    <button id="roeMinBtn" style="${btnStyle('#222')}padding:2px 6px;">▼</button>
  `;

  // ─── Hidden filter inputs ────────────────────────────────────────────────────
  const filterBar = document.createElement('div');
  filterBar.id = 'roeMobFilterBar';
  filterBar.style.cssText = 'display:none;height:0;padding:0;margin:0;border:none;overflow:hidden;';
  filterBar.innerHTML = `
    <select id="roeZoneFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeMobFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeStatusFilter"><option value="ALL" selected>ALL</option></select>
    <input type="checkbox" id="roeOnlyNew">
    <input id="roeSearch" type="text" value="">
  `;

  const resFilterBar = document.createElement('div');
  resFilterBar.id = 'roeResFilterBar';
  resFilterBar.style.cssText = 'display:none;height:0;padding:0;margin:0;border:none;overflow:hidden;';
  resFilterBar.innerHTML = `
    <select id="roeResZoneFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeResTypeFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeResNameFilter"><option value="ALL" selected>ALL</option></select>
    <select id="roeResStatusFilter"><option value="ALL" selected>ALL</option></select>
    <input id="roeResSearch" type="text" value="">
  `;

  // ─── Tabs ────────────────────────────────────────────────────────────────────
  const tabBar = document.createElement('div');
  tabBar.style.cssText = `display:flex;background:#0d0d0d;border-bottom:1px solid #222;flex-shrink:0;`;

  // Tab labels: [id, icon, short label]
  const TAB_DEFS = [
    ['tabState', '👾', 'Mobs'],
    ['tabRes',   '🌿', 'Res'],
    ['tabTrack', '🔔', 'Track'],
  ];
  TAB_DEFS.forEach(([id, icon, label]) => {
    const btn = document.createElement('button');
    btn.id = id;
    btn.style.cssText = tabStyle(id === 'tabLog');
    btn.dataset.icon  = icon;
    btn.dataset.label = label;
    btn.textContent   = `${icon} ${label}`;
    tabBar.appendChild(btn);
  });

  // ─── Content ─────────────────────────────────────────────────────────────────
  const content = document.createElement('div');
  content.style.cssText = `flex:1;overflow-y:auto;padding:6px;min-height:0;`;

  const statePane = document.createElement('div'); statePane.id = 'roeStatePane';
  const resPane   = document.createElement('div'); resPane.id   = 'roeResPane';   resPane.style.display   = 'none';
  const trackPane = document.createElement('div'); trackPane.id = 'roeTrackPane'; trackPane.style.display = 'none';

  content.appendChild(statePane);
  content.appendChild(resPane);
  content.appendChild(trackPane);

  // ─── Resize handle ───────────────────────────────────────────────────────────
  const resizeHandle = document.createElement('div');
  resizeHandle.style.cssText = `
    position:absolute;bottom:0;right:0;width:18px;height:18px;
    cursor:se-resize;z-index:10;opacity:0.5;
    background:
      linear-gradient(135deg, transparent 40%, #7b8fff 40%, #7b8fff 50%, transparent 50%),
      linear-gradient(135deg, transparent 60%, #7b8fff 60%, #7b8fff 70%, transparent 70%),
      linear-gradient(135deg, transparent 80%, #7b8fff 80%, #7b8fff 90%, transparent 90%);
  `;
  resizeHandle.title = 'Drag to resize';

  panel.appendChild(header);
  panel.appendChild(filterBar);
  panel.appendChild(resFilterBar);
  panel.appendChild(tabBar);
  panel.appendChild(content);
  panel.appendChild(resizeHandle);
  document.body.appendChild(panel);

  // Load saved size after appending to DOM
  loadPanelSize();

  // ─── Compact mode via ResizeObserver ─────────────────────────────────────────
  // Breakpoints: < 200px → micro, < 320px → compact, >= 320px → full
  let _compactMode = 'full'; // 'full' | 'compact' | 'micro'

  function applyCompactMode(mode) {
    if (mode === _compactMode) return;
    _compactMode = mode;

    const isMicro   = mode === 'micro';
    const isCompact = mode === 'compact' || isMicro;

    // Header title
    document.getElementById('roeTitle').textContent = isMicro ? 'R' : 'ROE';
    document.getElementById('roeSpawnCount').style.display = isMicro ? 'none' : '';

    // Tabs: icon-only in compact/micro, full text in full
    tabBar.querySelectorAll('button').forEach(btn => {
      const icon  = btn.dataset.icon;
      const label = btn.dataset.label;
      if (!icon) return;
      btn.textContent = isCompact ? icon : `${icon} ${label}`;
    });

    // Content padding
    content.style.padding = isCompact ? '4px 2px' : '6px';
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      applyCompactMode(w < 200 ? 'micro' : w < 320 ? 'compact' : 'full');
    }).observe(panel);
  }

  // ─── Panel position helpers ──────────────────────────────────────────────────
  let panelPinned = false;

  function clampPanelPosition(left, top) {
    const maxLeft = Math.max(0, window.innerWidth  - panel.offsetWidth);
    const maxTop  = Math.max(0, window.innerHeight - panel.offsetHeight);
    return { left: Math.min(Math.max(0, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) };
  }
  function movePanel(left, top) {
    const pos = clampPanelPosition(left, top);
    panel.style.left = pos.left + 'px'; panel.style.top = pos.top + 'px'; panel.style.right = 'auto';
  }
  function getPanelPosition() { return { left: Math.round(panel.offsetLeft), top: Math.round(panel.offsetTop) }; }

  window.addEventListener('resize', () => { const p = getPanelPosition(); movePanel(p.left, p.top); });

  // ─── Drag & Resize ───────────────────────────────────────────────────────────
  let dragging      = false, dragX = 0, dragY = 0;
  let resizing      = false;
  let resizeStartX  = 0, resizeStartY = 0, resizeStartW = 0, resizeStartH = 0;

  header.onmousedown = e => {
    if (e.target.closest('button,input,select,label')) return;
    dragging = true;
    dragX = e.clientX - panel.offsetLeft;
    dragY = e.clientY - panel.offsetTop;
  };

  resizeHandle.onmousedown = e => {
    e.stopPropagation();
    e.preventDefault();
    resizing     = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = panel.offsetWidth;
    resizeStartH = panel.offsetHeight;
  };

  document.onmousemove = e => {
    if (dragging) {
      movePanel(e.clientX - dragX, e.clientY - dragY);
    }
    if (resizing) {
      // ← CHANGE: min-width reduced from 320 to 120
      const newW = Math.max(120, resizeStartW + (e.clientX - resizeStartX));
      const newH = Math.max(200, resizeStartH + (e.clientY - resizeStartY));
      panel.style.width     = newW + 'px';
      panel.style.height    = newH + 'px';
      panel.style.maxHeight = 'none';
    }
  };

  document.onmouseup = () => {
    if (resizing) savePanelSize();
    dragging = false;
    resizing = false;
  };

  // ─── Tab switching ───────────────────────────────────────────────────────────
  let activeTab = 'log';

  function setTab(tab) {
    activeTab = tab;
    statePane.style.display = tab === 'state' ? 'block' : 'none';
    resPane.style.display   = tab === 'res'   ? 'block' : 'none';
    trackPane.style.display = tab === 'track' ? 'block' : 'none';
    document.getElementById('tabState').style.cssText = tabStyle(tab === 'state');
    document.getElementById('tabRes').style.cssText   = tabStyle(tab === 'res');
    document.getElementById('tabTrack').style.cssText = tabStyle(tab === 'track');
    // Restore data attributes after style reset
    TAB_DEFS.forEach(([id, icon, label]) => {
      const btn = document.getElementById(id);
      if (btn) { btn.dataset.icon = icon; btn.dataset.label = label; }
    });
    // Re-apply compact text
    applyCompactMode(_compactMode === 'full' ? 'full' : _compactMode);
    if (tab === 'state') renderStatePane();
    if (tab === 'res')   renderResPane();
    if (tab === 'track') renderTrackPane();
  }

  document.getElementById('tabState').onclick = () => setTab('state');
  document.getElementById('tabRes').onclick   = () => setTab('res');
  document.getElementById('tabTrack').onclick = () => setTab('track');

  // ─── Tab reorder ─────────────────────────────────────────────────────────────
  const TAB_IDS       = ['tabState', 'tabRes', 'tabTrack'];
  const TAB_ID_TO_KEY = { tabState: 'state', tabRes: 'res', tabTrack: 'track' };
  let draggedTabId    = null;

  function getFirstTabKey() {
    const firstBtn = tabBar.querySelector('button');
    return TAB_ID_TO_KEY[firstBtn?.id] || 'state';
  }
  function saveTabOrder() {
    try {
      localStorage.setItem(TAB_ORDER_STORAGE_KEY,
        JSON.stringify(Array.from(tabBar.querySelectorAll('button')).map(b => b.id)));
    } catch (e) {}
  }
  function applySavedTabOrder() {
    try {
      const raw = localStorage.getItem(TAB_ORDER_STORAGE_KEY);
      const order = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(order)) return;
      order.forEach(id => { const btn = document.getElementById(id); if (btn) tabBar.appendChild(btn); });
    } catch (e) {}
  }
  function clearTabDragState() {
    TAB_IDS.forEach(id => { const b = document.getElementById(id); if (b) { b.style.opacity = ''; b.style.boxShadow = ''; } });
  }
  function initTabReorder() {
    TAB_IDS.forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.draggable   = true;
      btn.ondragstart = () => { draggedTabId = id; btn.style.opacity = '0.55'; };
      btn.ondragover  = e => {
        e.preventDefault();
        if (!draggedTabId || draggedTabId === id) return;
        const before = e.clientX < btn.getBoundingClientRect().left + btn.getBoundingClientRect().width / 2;
        btn.style.boxShadow = before ? 'inset 2px 0 0 #7b8fff' : 'inset -2px 0 0 #7b8fff';
      };
      btn.ondragleave = () => { btn.style.boxShadow = ''; };
      btn.ondrop = e => {
        e.preventDefault();
        if (!draggedTabId || draggedTabId === id) return;
        const draggedBtn = document.getElementById(draggedTabId);
        if (!draggedBtn) return;
        const before = e.clientX < btn.getBoundingClientRect().left + btn.getBoundingClientRect().width / 2;
        tabBar.insertBefore(draggedBtn, before ? btn : btn.nextSibling);
        saveTabOrder(); clearTabDragState();
      };
      btn.ondragend = () => { draggedTabId = null; clearTabDragState(); };
    });
  }

  applySavedTabOrder();
  initTabReorder();
  setTab(getFirstTabKey());

  // ─── Minimize ────────────────────────────────────────────────────────────────
  let minimized = false;
  document.getElementById('roeMinBtn').onclick = () => {
    minimized = !minimized;
    tabBar.style.display  = minimized ? 'none'  : 'flex';
    content.style.display = minimized ? 'none'  : 'block';
    resizeHandle.style.display = minimized ? 'none' : 'block';
    document.getElementById('roeMinBtn').textContent = minimized ? '▲' : '▼';
  };

  // ─── Auto-refresh (always on, 30s, no UI) ────────────────────────────────────
  function applySavedAutoRefreshUI() {
    startAutoRefresh();
  }

  // ─── Filter handlers ─────────────────────────────────────────────────────────
  document.getElementById('roeZoneFilter').onchange   = e => { filterZone   = e.target.value; saveFilters(); applyFilters(); };
  document.getElementById('roeMobFilter').onchange    = e => { filterType   = e.target.value; saveFilters(); applyFilters(); };
  document.getElementById('roeStatusFilter').onchange = e => { filterStatus = e.target.value; saveFilters(); applyFilters(); };

  document.getElementById('roeResZoneFilter').onchange   = e => { resFilterZone   = e.target.value; saveFilters(); renderResPane(); };
  document.getElementById('roeResTypeFilter').onchange   = e => { resFilterType   = e.target.value; saveFilters(); renderResPane(); };
  document.getElementById('roeResNameFilter').onchange   = e => { resFilterName   = e.target.value; saveFilters(); renderResPane(); };
  document.getElementById('roeResStatusFilter').onchange = e => { resFilterStatus = e.target.value; saveFilters(); renderResPane(); };
  document.getElementById('roeResSearch').oninput        = ()  => { saveFilters(); renderResPane(); };

  // ─── applyFilters ────────────────────────────────────────────────────────────
  function applyFilters() {
    if (activeTab === 'state') renderStatePane();
  }

  // ─── Refresh dropdowns ───────────────────────────────────────────────────────
  function refreshSelects() {
    const zs = document.getElementById('roeZoneFilter');
    const ms = document.getElementById('roeMobFilter');
    const prevZ = zs.value, prevM = ms.value;
    zs.innerHTML = '<option value="ALL">All zones</option>';
    knownZones.forEach(z => { zs.innerHTML += `<option value="${z}">${z}</option>`; });
    zs.value = prevZ !== 'ALL' ? prevZ : filterZone;
    ms.innerHTML = '<option value="ALL">All mobs</option>';
    knownTypes.forEach(t => { ms.innerHTML += `<option value="${t}">${t}</option>`; });
    ms.value = prevM !== 'ALL' ? prevM : filterType;
  }

  function refreshResSelects() {
    const zs = document.getElementById('roeResZoneFilter');
    const ns = document.getElementById('roeResNameFilter');
    const prevZ = zs.value, prevN = ns.value;
    zs.innerHTML = '<option value="ALL">All zones</option>';
    knownZones.forEach(z => { zs.innerHTML += `<option value="${z}">${z}</option>`; });
    zs.value = prevZ !== 'ALL' ? prevZ : resFilterZone;
    ns.innerHTML = '<option value="ALL">All resources</option>';
    knownResNames.forEach(n => { ns.innerHTML += `<option value="${n}">${n}</option>`; });
    ns.value = prevN !== 'ALL' ? prevN : resFilterName;
  }

  // ─── Color helpers ───────────────────────────────────────────────────────────
  function zoneColor(zone) {
    const map = { Forest: '#4caf50', Mines: '#9c7bb5', Town: '#5b9bd5', Desert: '#c49a3c', Dungeon: '#c44' };
    return map[zone] || '#888';
  }
  function resTypeColor(type) { return type === 'Ore' ? '#c49a3c' : type === 'Tree' ? '#6d9e4b' : '#5b9bd5'; }
  function resIcon(type)      { return type === 'Ore' ? '⛏' : type === 'Tree' ? '🌲' : '🌿'; }
  function rarityColor(rarity) {
    return { Common: '#aaa', Uncommon: '#4caf50', Rare: '#5b9bd5', Mystical: '#c678dd' }[rarity] || '#aaa';
  }
  function hpBar(hp, maxHp) {
    if (!maxHp) return '';
    const pct = Math.round((hp / maxHp) * 100);
    const col = pct > 60 ? '#4caf50' : pct > 30 ? '#f0a500' : '#e53935';
    return `<span style="display:inline-block;width:40px;height:5px;background:#333;border-radius:3px;vertical-align:middle;margin:0 3px"><span style="display:block;width:${pct}%;height:100%;background:${col};border-radius:3px"></span></span><span style="color:${col};font-size:10px">${pct}%</span>`;
  }

  function getTrackedResourceNodes(zone, resource) {
    return (lastResourcesByZone[zone] || []).map((r, i) => ({ ...r, idx: i })).filter(r => r.resource === resource);
  }
  function getTrackedMobNodes(zone, statsKey) {
    return (lastStateByZone[zone] || []).map((e, i) => ({ ...e, idx: i })).filter(e => e.statsKey === statsKey);
  }

  function appendLogNode(node) {
    // tracking notifications still log to statePane area — but we just discard log entries silently now
    // (Log tab removed; tracked spawn events shown as toasts only)
  }

  // ─── Render "Mobs" tab ───────────────────────────────────────────────────────
  function renderStatePane() {
    const searchEl = document.getElementById('roeSearch');
    const search = searchEl ? searchEl.value.toLowerCase() : '';
    statePane.innerHTML = '';

    Object.entries(lastStateByZone).forEach(([zone, enemies]) => {
      if (filterZone !== 'ALL' && zone !== filterZone) return;
      const filtered = enemies.filter(e => {
        if (filterType   !== 'ALL' && e.statsKey !== filterType) return false;
        if (filterStatus !== 'ALL') {
          if (filterStatus === 'alive' && !e.alive) return false;
          if (filterStatus === 'dead'  &&  e.alive) return false;
        }
        if (search && !e.statsKey.toLowerCase().includes(search) && !e.type.toLowerCase().includes(search)) return false;
        return true;
      });
      if (!filtered.length) return;

      const zc = zoneColor(zone);
      const zh = document.createElement('div');
      zh.style.cssText = `color:${zc};font-weight:bold;padding:3px 6px;background:#111;border-left:3px solid ${zc};margin-bottom:2px;margin-top:6px;font-size:11px;`;
      zh.textContent = `${zone} — ${filtered.length}`;
      statePane.appendChild(zh);

      const groups = {};
      filtered.forEach(e => { (groups[e.statsKey] = groups[e.statsKey] || []).push(e); });

      Object.entries(groups).forEach(([key, mobs]) => {
        const alive   = mobs.filter(m => m.alive).length;
        const tracked = isMobTracked(zone, key);

        const row = document.createElement('div');
        row.style.cssText = `padding:3px 8px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:5px;cursor:pointer`;

        const addBtn = document.createElement('button');
        addBtn.title = tracked ? 'Already tracked' : 'Add to tracking';
        addBtn.style.cssText = `
          background:${tracked ? '#3a261a' : '#1a2e3a'};
          color:${tracked ? '#ffb74d' : '#5b9bd5'};
          border:1px solid ${tracked ? '#4a3626' : '#2a3e4a'};
          border-radius:4px;padding:1px 5px;cursor:pointer;
          font-size:12px;font-family:monospace;flex-shrink:0;transition:all 0.15s;
        `;
        addBtn.textContent = tracked ? '✓' : '+';
        if (!tracked) {
          addBtn.onmouseover = () => { addBtn.style.background = '#1e4060'; addBtn.style.color = '#7bbfff'; };
          addBtn.onmouseout  = () => { addBtn.style.background = '#1a2e3a'; addBtn.style.color = '#5b9bd5'; };
          addBtn.onclick = e => { e.stopPropagation(); addMobToTracking(zone, key, mobs[0].type); renderStatePane(); };
        }

        row.innerHTML = `
          <span style="color:#ddd;flex:1;font-size:11px">${key}</span>
          <span>
            <span style="color:#81c784">▲${alive}</span>
            <span style="color:#e57373;margin-left:4px">▼${mobs.length - alive}</span>
          </span>
        `;
        row.insertBefore(addBtn, row.firstChild);

        row.onclick = () => {
          const detail = statePane.querySelector(`[data-group="${zone}_${key}"]`);
          if (detail) { detail.style.display = detail.style.display === 'none' ? '' : 'none'; return; }
          const dl = document.createElement('div');
          dl.dataset.group = `${zone}_${key}`;
          dl.style.cssText = `background:#0a0a0a;padding:3px 14px;margin-bottom:2px`;
          mobs.forEach(m => {
            const mr = document.createElement('div');
            mr.style.cssText = `padding:2px 0;font-size:11px;color:${m.alive ? '#81c784' : '#e57373'};border-bottom:1px solid #111`;
            mr.innerHTML = `<span style="color:#555">${m.id}</span>  x:${m.pos.x.toFixed(1)} y:${m.pos.y.toFixed(1)}  ${hpBar(m.hp, m.maxHp)}`;
            dl.appendChild(mr);
          });
          row.parentNode.insertBefore(dl, row.nextSibling);
        };
        statePane.appendChild(row);
      });
    });

    if (!statePane.children.length)
      statePane.innerHTML = `<div style="color:#555;padding:20px;text-align:center">No data / filtered out</div>`;
  }

  // ─── Tracking helpers ────────────────────────────────────────────────────────
  function isTracked(zone, resource) {
    for (const [, v] of trackedResources) { if (v.zone === zone && v.resource === resource) return true; }
    return false;
  }
  function isMobTracked(zone, statsKey) {
    for (const [, v] of trackedMobs) { if (v.zone === zone && v.statsKey === statsKey) return true; }
    return false;
  }

  function addToTracking(zone, resource, type, rarity, weakness) {
    if (isTracked(zone, resource)) { notifyTrack(null, `[${zone}] ${resource} is already in tracking`); return; }
    const id = ++trackIdCounter;
    const nodes = getTrackedResourceNodes(zone, resource);
    trackedResources.set(id, { kind: 'resource', zone, resource, type, rarity, weakness, notifyOnSpawn: true, nodes });
    previousTrackedStates.set(id, { activeCount: nodes.filter(n => n.active).length });
    saveTracked();
    if (activeTab === 'track') renderTrackPane();
    notifyTrack(null, `Added to tracking: [${zone}] ${resource}`);
    updateTrackTab();
  }

  function addMobToTracking(zone, statsKey, type) {
    if (isMobTracked(zone, statsKey)) { notifyTrack(null, `[${zone}] ${statsKey} is already in tracking`); return; }
    const id = ++trackIdCounter;
    const nodes = getTrackedMobNodes(zone, statsKey);
    trackedMobs.set(id, { kind: 'mob', zone, statsKey, type, notifyOnSpawn: true, nodes });
    previousTrackedMobStates.set(id, { aliveCount: nodes.filter(n => n.alive).length });
    saveTracked();
    if (activeTab === 'track') renderTrackPane();
    notifyTrack(null, `Added to tracking: [${zone}] ${statsKey}`);
    updateTrackTab();
  }

  function removeFromTracking(id) {
    trackedResources.delete(id); previousTrackedStates.delete(id);
    saveTracked(); if (activeTab === 'track') renderTrackPane(); updateTrackTab();
  }
  function removeMobFromTracking(id) {
    trackedMobs.delete(id); previousTrackedMobStates.delete(id);
    saveTracked(); if (activeTab === 'track') renderTrackPane(); updateTrackTab();
  }

  function updateTrackTab() {
    const btn = document.getElementById('tabTrack');
    const count = trackedResources.size + trackedMobs.size;
    const isCompact = _compactMode !== 'full';
    btn.textContent = count > 0
      ? (isCompact ? `🔔${count}` : `🔔 Track (${count})`)
      : (isCompact ? '🔔' : '🔔 Track');
    btn.dataset.icon  = count > 0 ? `🔔${count}` : '🔔';
    btn.dataset.label = count > 0 ? `Track (${count})` : 'Track';
  }

  // ─── Render "Resources" tab ──────────────────────────────────────────────────
  function renderResPane() {
    const search = document.getElementById('roeResSearch').value.toLowerCase();
    resPane.innerHTML = '';
    let totalShown = 0;

    Object.entries(lastResourcesByZone).forEach(([zone, resources]) => {
      if (resFilterZone !== 'ALL' && zone !== resFilterZone) return;

      const filtered = resources.filter(r => {
        if (resFilterType   !== 'ALL' && r.type     !== resFilterType)   return false;
        if (resFilterName   !== 'ALL' && r.resource !== resFilterName)   return false;
        if (resFilterStatus !== 'ALL') {
          if (resFilterStatus === 'active'   && !r.active) return false;
          if (resFilterStatus === 'depleted' &&  r.active) return false;
        }
        if (search && !r.resource.toLowerCase().includes(search) && !r.type.toLowerCase().includes(search)) return false;
        return true;
      });
      if (!filtered.length) return;
      totalShown += filtered.length;

      const zc = zoneColor(zone);
      const activeCount = filtered.filter(r => r.active).length;

      const zh = document.createElement('div');
      zh.style.cssText = `color:${zc};font-weight:bold;padding:3px 6px;background:#0e1a12;border-left:3px solid ${zc};margin-bottom:2px;margin-top:6px;display:flex;justify-content:space-between;font-size:11px;`;
      zh.innerHTML = `
        <span>${zone}</span>
        <span style="font-weight:normal;font-size:10px">
          <span style="color:#4caf50">✦${activeCount}</span>
          <span style="color:#555;margin-left:4px">✧${filtered.length - activeCount}</span>
        </span>
      `;
      resPane.appendChild(zh);

      const groups = {};
      filtered.forEach(r => { (groups[r.resource] = groups[r.resource] || []).push(r); });

      Object.entries(groups).forEach(([resName, nodes]) => {
        const tc      = resTypeColor(nodes[0].type);
        const rc      = rarityColor(nodes[0].rarity);
        const activeN = nodes.filter(n => n.active).length;
        const tracked = isTracked(zone, resName);

        const row = document.createElement('div');
        row.style.cssText = `padding:3px 8px;border-bottom:1px solid #1a2e1a;display:flex;align-items:center;gap:5px;cursor:pointer;`;

        const addBtn = document.createElement('button');
        addBtn.title = tracked ? 'Already tracked' : 'Add to tracking';
        addBtn.style.cssText = `
          background:${tracked ? '#1a3a1a' : '#1a2e3a'};
          color:${tracked ? '#4caf50' : '#5b9bd5'};
          border:1px solid ${tracked ? '#2a4a2a' : '#2a3e4a'};
          border-radius:4px;padding:1px 5px;cursor:pointer;
          font-size:12px;font-family:monospace;flex-shrink:0;transition:all 0.15s;
        `;
        addBtn.textContent = tracked ? '✓' : '+';
        if (!tracked) {
          addBtn.onmouseover = () => { addBtn.style.background = '#1e4060'; addBtn.style.color = '#7bbfff'; };
          addBtn.onmouseout  = () => { addBtn.style.background = '#1a2e3a'; addBtn.style.color = '#5b9bd5'; };
          addBtn.onclick = e => {
            e.stopPropagation();
            addToTracking(zone, resName, nodes[0].type, nodes[0].rarity, nodes[0].weakness);
            renderResPane();
          };
        }

        row.innerHTML = `
          <span style="color:${tc};font-size:12px">${resIcon(nodes[0].type)}</span>
          <span style="color:#ddd;flex:1;font-size:11px">${resName}</span>
          <span style="color:${rc};font-size:10px">${nodes[0].rarity}</span>
          <span>
            <span style="color:#4caf50">✦${activeN}</span>
            <span style="color:#555;margin-left:3px">✧${nodes.length - activeN}</span>
          </span>
        `;
        row.insertBefore(addBtn, row.firstChild);

        row.onclick = e => {
          if (e.target === addBtn) return;
          const gkey = `res_${zone}_${resName}`;
          const detail = resPane.querySelector(`[data-resgroup="${gkey}"]`);
          if (detail) { detail.style.display = detail.style.display === 'none' ? '' : 'none'; return; }
          const dl = document.createElement('div');
          dl.dataset.resgroup = gkey;
          dl.style.cssText = `background:#080e08;padding:3px 14px;margin-bottom:2px`;
          nodes.forEach(n => {
            const nr = document.createElement('div');
            nr.style.cssText = `padding:2px 0;font-size:10px;color:${n.active ? '#4caf50' : '#555'};border-bottom:1px solid #111;display:flex;gap:6px;align-items:center`;
            nr.innerHTML = `
              <span>${n.active ? '✦' : '✧'}</span>
              <span>x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)}</span>
              ${hpBar(n.hp, n.maxHp)}
            `;
            dl.appendChild(nr);
          });
          row.parentNode.insertBefore(dl, row.nextSibling);
        };
        resPane.appendChild(row);
      });
    });

    if (!totalShown)
      resPane.innerHTML = `<div style="color:#555;padding:20px;text-align:center">No resources / filtered out</div>`;
  }

  // ─── Render "Tracking" tab ───────────────────────────────────────────────────
  function getDesktopNotifyStatus() { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; }
  function getDesktopNotifyLabel()  {
    const s = getDesktopNotifyStatus();
    return s === 'granted' ? 'enabled' : s === 'denied' ? 'blocked' : s === 'default' ? 'need permission' : 'unsupported';
  }

  function renderTrackSettings() {
    const wrap = document.createElement('div');
    wrap.style.cssText = `padding:5px 8px;margin-bottom:5px;background:#101216;border:1px solid #20242e;border-radius:5px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;`;
    wrap.innerHTML = `<span style="color:#7b8fff;font-size:10px">Notify</span>`;

    const soundLabel = document.createElement('label');
    soundLabel.style.cssText = `display:flex;align-items:center;gap:4px;font-size:10px;color:#bbb;cursor:pointer;`;
    const soundCb = document.createElement('input');
    soundCb.type = 'checkbox'; soundCb.checked = notificationPrefs.soundEnabled;
    soundCb.onchange = () => {
      notificationPrefs.soundEnabled = soundCb.checked; saveNotifyPrefs();
      if (soundCb.checked) playTrackNotificationSound({ kind: 'mob', nodes: [], zone: '' });
    };
    soundLabel.appendChild(soundCb);
    soundLabel.appendChild(document.createTextNode('Sound'));
    wrap.appendChild(soundLabel);

    const desktopLabel = document.createElement('label');
    desktopLabel.style.cssText = `display:flex;align-items:center;gap:4px;font-size:10px;color:#bbb;cursor:pointer;`;
    const desktopCb = document.createElement('input');
    desktopCb.type = 'checkbox'; desktopCb.checked = notificationPrefs.desktopEnabled;
    desktopCb.disabled = typeof Notification === 'undefined';
    desktopCb.onchange = async () => {
      if (!desktopCb.checked) {
        notificationPrefs.desktopEnabled = false; saveNotifyPrefs();
        notifyTrack(null, 'Desktop notifications disabled'); renderTrackPane(); return;
      }
      const permission = await requestDesktopNotificationPermission();
      if (permission !== 'granted') {
        notificationPrefs.desktopEnabled = false; saveNotifyPrefs();
        desktopCb.checked = false;
        notifyTrack(null, permission === 'denied' ? 'Browser blocked desktop notifications' : 'Permission not granted');
        renderTrackPane(); return;
      }
      notificationPrefs.desktopEnabled = true; saveNotifyPrefs();
      notifyTrack(null, 'Desktop notifications enabled'); renderTrackPane();
    };
    desktopLabel.appendChild(desktopCb);
    desktopLabel.appendChild(document.createTextNode('Desktop'));
    wrap.appendChild(desktopLabel);

    const status = document.createElement('span');
    status.style.cssText = `color:#555;font-size:10px;`;
    status.textContent = getDesktopNotifyLabel();
    wrap.appendChild(status);
    return wrap;
  }

  function makeTrackSection(title, color) {
    const s = document.createElement('div');
    s.style.cssText = `padding:3px 10px 2px;color:${color};font-size:10px;text-transform:uppercase;letter-spacing:0.06em;`;
    s.textContent = title;
    return s;
  }

  function renderTrackedResourceRow(id, v) {
    const tc = resTypeColor(v.type), rc = rarityColor(v.rarity);
    const activeN = v.nodes.filter(n => n.active).length, totalN = v.nodes.length;

    const row = document.createElement('div');
    row.style.cssText = `padding:4px 8px;border-bottom:1px solid #1a1a2a;display:flex;flex-direction:column;gap:3px;`;

    const top = document.createElement('div');
    top.style.cssText = `display:flex;align-items:center;gap:5px;`;
    top.innerHTML = `
      <span style="color:${tc};font-size:12px">${resIcon(v.type)}</span>
      <span style="color:#ddd;flex:1;font-weight:bold;font-size:11px">${v.resource}</span>
      <span style="color:${rc};font-size:10px">${v.rarity}</span>
      <span style="font-size:11px">
        <span style="color:#4caf50">♦${activeN}</span>
        <span style="color:#555;margin-left:3px">◇${totalN - activeN}</span>
      </span>
    `;

    const notifyLabel = document.createElement('label');
    notifyLabel.style.cssText = `cursor:pointer;display:flex;align-items:center;gap:4px;font-size:10px;color:#666;`;
    const notifyCb = document.createElement('input');
    notifyCb.type = 'checkbox'; notifyCb.checked = v.notifyOnSpawn; notifyCb.style.cursor = 'pointer';
    notifyCb.onchange = e => { v.notifyOnSpawn = e.target.checked; saveTracked(); };
    notifyLabel.appendChild(notifyCb);
    notifyLabel.appendChild(document.createTextNode('Notify'));
    top.appendChild(notifyLabel);

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕'; delBtn.title = 'Remove from tracking';
    delBtn.style.cssText = `${btnStyle('#3d1a1a')}font-size:10px;padding:1px 4px;`;
    delBtn.onclick = () => removeFromTracking(id);
    top.appendChild(delBtn);
    row.appendChild(top);

    if (totalN > 0) {
      const bar = document.createElement('div');
      bar.style.cssText = `display:flex;gap:2px;padding:2px 0 0 18px;flex-wrap:wrap;align-items:center;`;
      v.nodes.forEach(n => {
        const dot = document.createElement('span');
        dot.title = `x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)} HP:${n.hp}/${n.maxHp}`;
        dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:2px;cursor:default;background:${n.active ? '#4caf50' : '#2a2a2a'};border:1px solid ${n.active ? '#5dba6e' : '#333'};`;
        bar.appendChild(dot);
      });
      const leg = document.createElement('span');
      leg.style.cssText = `font-size:10px;color:#444;margin-left:5px;`;
      leg.textContent = `${activeN}/${totalN}`;
      bar.appendChild(leg);
      row.appendChild(bar);
    } else {
      const nd = document.createElement('div');
      nd.style.cssText = `font-size:10px;color:#333;padding-left:18px;`;
      nd.textContent = 'Waiting...';
      row.appendChild(nd);
    }
    return row;
  }

  function renderTrackedMobRow(id, v) {
    const aliveN = v.nodes.filter(n => n.alive).length, totalN = v.nodes.length;

    const row = document.createElement('div');
    row.style.cssText = `padding:4px 8px;border-bottom:1px solid #24180d;display:flex;flex-direction:column;gap:3px;`;

    const top = document.createElement('div');
    top.style.cssText = `display:flex;align-items:center;gap:5px;`;
    top.innerHTML = `
      <span style="color:#ff9800;font-size:12px">👾</span>
      <span style="color:#ddd;flex:1;font-weight:bold;font-size:11px">${v.statsKey}</span>
      <span style="font-size:11px">
        <span style="color:#81c784">▲${aliveN}</span>
        <span style="color:#e57373;margin-left:3px">▼${totalN - aliveN}</span>
      </span>
    `;

    const notifyLabel = document.createElement('label');
    notifyLabel.style.cssText = `cursor:pointer;display:flex;align-items:center;gap:4px;font-size:10px;color:#666;`;
    const notifyCb = document.createElement('input');
    notifyCb.type = 'checkbox'; notifyCb.checked = v.notifyOnSpawn; notifyCb.style.cursor = 'pointer';
    notifyCb.onchange = e => { v.notifyOnSpawn = e.target.checked; saveTracked(); };
    notifyLabel.appendChild(notifyCb);
    notifyLabel.appendChild(document.createTextNode('Notify'));
    top.appendChild(notifyLabel);

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕'; delBtn.title = 'Remove from tracking';
    delBtn.style.cssText = `${btnStyle('#3d1a1a')}font-size:10px;padding:1px 4px;`;
    delBtn.onclick = () => removeMobFromTracking(id);
    top.appendChild(delBtn);
    row.appendChild(top);

    if (totalN > 0) {
      const bar = document.createElement('div');
      bar.style.cssText = `display:flex;gap:2px;padding:2px 0 0 18px;flex-wrap:wrap;align-items:center;`;
      v.nodes.forEach(n => {
        const dot = document.createElement('span');
        dot.title = `x:${n.pos.x.toFixed(1)} y:${n.pos.y.toFixed(1)} HP:${n.hp}/${n.maxHp}`;
        dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:2px;cursor:default;background:${n.alive ? '#ff9800' : '#2a2a2a'};border:1px solid ${n.alive ? '#ffb74d' : '#333'};`;
        bar.appendChild(dot);
      });
      const leg = document.createElement('span');
      leg.style.cssText = `font-size:10px;color:#444;margin-left:5px;`;
      leg.textContent = `${aliveN}/${totalN}`;
      bar.appendChild(leg);
      row.appendChild(bar);
    } else {
      const nd = document.createElement('div');
      nd.style.cssText = `font-size:10px;color:#333;padding-left:18px;`;
      nd.textContent = 'Waiting...';
      row.appendChild(nd);
    }
    return row;
  }

  function renderTrackPane() {
    trackPane.innerHTML = '';
    trackPane.appendChild(renderTrackSettings());

    const totalTracked = trackedResources.size + trackedMobs.size;
    if (totalTracked === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `color:#555;padding:20px;text-align:center;line-height:1.8`;
      empty.innerHTML = `Tracking empty.<br><span style="font-size:11px">Click <span style="color:#5b9bd5;font-weight:bold">+</span> in 👾 or 🌿 tabs.</span>`;
      trackPane.appendChild(empty);
      return;
    }

    const hdr = document.createElement('div');
    hdr.style.cssText = `padding:5px 8px;background:#0e1018;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;`;
    hdr.innerHTML = `
      <span style="color:#7b8fff;font-size:10px">Tracked: ${totalTracked}</span>
      <span style="color:#666;font-size:10px">👾${trackedMobs.size} 🌿${trackedResources.size}</span>
      <button id="roeTrackClearAll" style="${btnStyle('#3d1a1a')}font-size:10px;padding:1px 6px;">Clear all</button>
    `;
    trackPane.appendChild(hdr);
    document.getElementById('roeTrackClearAll').onclick = () => {
      trackedResources.clear(); trackedMobs.clear();
      previousTrackedStates.clear(); previousTrackedMobStates.clear();
      saveTracked(); renderTrackPane(); updateTrackTab();
    };

    const zones = new Set();
    trackedResources.forEach(v => zones.add(v.zone));
    trackedMobs.forEach(v => zones.add(v.zone));

    Array.from(zones).sort().forEach(zone => {
      const mobEntries = [], resEntries = [];
      trackedMobs.forEach((v, k)      => { if (v.zone === zone) mobEntries.push([k, v]); });
      trackedResources.forEach((v, k) => { if (v.zone === zone) resEntries.push([k, v]); });
      if (!mobEntries.length && !resEntries.length) return;

      const zc = zoneColor(zone);
      const zh = document.createElement('div');
      zh.style.cssText = `color:${zc};font-weight:bold;padding:4px 8px;background:#0e1018;border-left:3px solid ${zc};margin-top:5px;margin-bottom:2px;font-size:11px;`;
      zh.textContent = zone;
      trackPane.appendChild(zh);

      if (mobEntries.length) {
        trackPane.appendChild(makeTrackSection('Mobs', '#ff9800'));
        mobEntries.forEach(([id, v]) => trackPane.appendChild(renderTrackedMobRow(id, v)));
      }
      if (resEntries.length) {
        trackPane.appendChild(makeTrackSection('Resources', '#4caf50'));
        resEntries.forEach(([id, v]) => trackPane.appendChild(renderTrackedResourceRow(id, v)));
      }
    });
  }

  // ─── Counter ─────────────────────────────────────────────────────────────────
  function updateCount() {
    // count shown in header is now zone count
    const zoneCount = Object.keys(lastStateByZone).length;
    const el = document.getElementById('roeSpawnCount');
    if (el) el.textContent = _compactMode === 'micro' ? zoneCount : `${zoneCount} zones`;
  }

  // ─── Toast (tracking) ────────────────────────────────────────────────────────
  let _trackToastOffset = 0;
  let trackAudioCtx     = null;

  function ensureTrackAudioContext() {
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return null;
    if (!trackAudioCtx) trackAudioCtx = new A();
    return trackAudioCtx;
  }
  function unlockTrackAudio() {
    const ctx = ensureTrackAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  function playTrackNotificationSound(trackEntry) {
    if (!notificationPrefs.soundEnabled) return;
    const ctx = ensureTrackAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); if (ctx.state === 'suspended') return; }
    const tones = trackEntry?.kind === 'mob' ? [880, 660] : [740, 988];
    const startAt = ctx.currentTime;
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      const start = startAt + i * 0.16, stop = start + 0.14;
      osc.type = 'sine'; osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.055, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, stop);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(start); osc.stop(stop);
    });
  }
  async function requestDesktopNotificationPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied')  return 'denied';
    try { return await Notification.requestPermission(); } catch (e) { return 'denied'; }
  }
  function pushTrackDesktopNotification(trackEntry) {
    if (!notificationPrefs.desktopEnabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const count = trackEntry.kind === 'mob'
      ? `${trackEntry.nodes.filter(n => n.alive).length}/${trackEntry.nodes.length} alive`
      : `${trackEntry.nodes.filter(n => n.active).length}/${trackEntry.nodes.length} active`;
    const name = trackEntry.kind === 'mob' ? trackEntry.statsKey : trackEntry.resource;
    const note = new Notification('ROE Spawn Tracker', {
      body: `[${trackEntry.zone}] ${name}\n${count}`,
      tag:  `roe-track-${trackEntry.kind}-${trackEntry.zone}-${name}`
    });
    note.onclick = () => { window.focus(); note.close(); };
    setTimeout(() => note.close(), 8000);
  }

  window.addEventListener('pointerdown', unlockTrackAudio, { passive: true });
  window.addEventListener('keydown',     unlockTrackAudio);

  function notifyTrack(trackEntry, msg) {
    const offset     = _trackToastOffset;
    _trackToastOffset += 64;
    const isMob   = !!trackEntry && trackEntry.kind === 'mob';
    const accent  = isMob ? '#ff9800' : '#4caf50';
    const bg      = isMob ? '#1a1410' : '#0e1a12';
    const shadow  = isMob ? 'rgba(255,152,0,0.3)' : 'rgba(76,175,80,0.3)';

    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed;bottom:${20 + offset}px;left:20px;z-index:9999999;
      background:${bg};border:1px solid ${accent};border-radius:6px;
      padding:10px 14px;color:${accent};font-family:monospace;font-size:12px;
      box-shadow:0 2px 12px ${shadow};transition:opacity 0.5s;pointer-events:none;max-width:320px;
    `;

    if (trackEntry) {
      playTrackNotificationSound(trackEntry);
      pushTrackDesktopNotification(trackEntry);
      if (isMob) {
        toast.innerHTML = `👾 <b style="color:#ffb74d">${trackEntry.statsKey}</b> [${trackEntry.zone}]<br>
          <span style="color:#888;font-size:10px">${trackEntry.nodes.filter(n => n.alive).length}/${trackEntry.nodes.length} alive</span>`;
      } else {
        const tc = resTypeColor(trackEntry.type);
        toast.innerHTML = `${resIcon(trackEntry.type)} <b style="color:${tc}">${trackEntry.resource}</b> [${trackEntry.zone}]<br>
          <span style="color:#888;font-size:10px">${trackEntry.nodes.filter(n => n.active).length}/${trackEntry.nodes.length} active</span>`;
      }
    } else {
      toast.innerHTML = `<span style="color:#9cf">${msg}</span>`;
    }

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => { toast.remove(); _trackToastOffset = Math.max(0, _trackToastOffset - 64); }, 500);
    }, 3500);
  }

  // ─── Check tracked on new data ───────────────────────────────────────────────
  function checkTrackedResources(zone, resources) {
    let changed = false;
    trackedResources.forEach((v, id) => {
      if (v.zone !== zone) return;
      changed = true;
      const newNodes   = resources.map((r, i) => ({ ...r, idx: i })).filter(r => r.resource === v.resource);
      v.nodes          = newNodes;
      const activeCount = newNodes.filter(n => n.active).length;
      const prev        = previousTrackedStates.get(id) || { activeCount: 0 };
      if (v.notifyOnSpawn && activeCount > prev.activeCount) {
        notifyTrack(v, null);
        const time = new Date().toLocaleTimeString();
        const lr = document.createElement('div');
        lr.style.cssText = `padding:3px 6px;border-bottom:1px solid #1a2a1a;background:rgba(76,175,80,0.07);border-left:3px solid #4caf50;margin-bottom:1px;`;
        lr.innerHTML = `
          <span style="color:#555;font-size:10px">${time}</span>
          <span style="color:#4caf50;margin:0 4px">[${zone}]</span>
          <span>${resIcon(v.type)}</span>
          <span style="color:#ddd;margin:0 3px;font-size:11px">${v.resource}</span>
          <span style="color:#4caf50;font-size:10px">▲+${activeCount - prev.activeCount} (${activeCount}/${newNodes.length})</span>
        `;
        appendLogNode(lr);
      }
      previousTrackedStates.set(id, { activeCount });
    });
    if (changed) saveTracked();
  }

  function checkTrackedMobs(zone, enemies) {
    let changed = false;
    trackedMobs.forEach((v, id) => {
      if (v.zone !== zone) return;
      changed = true;
      const newNodes  = enemies.map((e, i) => ({ ...e, idx: i })).filter(e => e.statsKey === v.statsKey);
      v.nodes         = newNodes;
      const aliveCount = newNodes.filter(n => n.alive).length;
      const prev       = previousTrackedMobStates.get(id) || { aliveCount: 0 };
      if (v.notifyOnSpawn && aliveCount > prev.aliveCount) {
        notifyTrack(v, null);
        const time = new Date().toLocaleTimeString();
        const lr = document.createElement('div');
        lr.style.cssText = `padding:3px 6px;border-bottom:1px solid #2a1c10;background:rgba(255,152,0,0.08);border-left:3px solid #ff9800;margin-bottom:1px;`;
        lr.innerHTML = `
          <span style="color:#555;font-size:10px">${time}</span>
          <span style="color:#ff9800;margin:0 4px">[${zone}]</span>
          <span>👾</span>
          <span style="color:#ddd;margin:0 3px;font-size:11px">${v.statsKey}</span>
          <span style="color:#ff9800;font-size:10px">▲+${aliveCount - prev.aliveCount} (${aliveCount}/${newNodes.length})</span>
        `;
        appendLogNode(lr);
      }
      previousTrackedMobStates.set(id, { aliveCount });
    });
    if (changed) saveTracked();
  }

  // ─── Main data handler ───────────────────────────────────────────────────────
  function handleSpawnState(data) {
    const zone      = data.zone;
    const enemies   = data.enemies   || [];
    const resources = data.resources || [];

    knownZones.add(zone);
    lastStateByZone[zone] = enemies;
    enemies.forEach(e => knownTypes.add(e.statsKey));
    checkTrackedMobs(zone, enemies);

    if (!prevEnemies.__zones) prevEnemies.__zones = {};
    prevEnemies.__zones[zone] = true;
    enemies.forEach(e => { prevEnemies[e.id] = { ...e }; });

    lastResourcesByZone[zone] = resources;
    resources.forEach(r => knownResNames.add(r.resource));
    saveWorldSnapshot();
    refreshResSelects();
    checkTrackedResources(zone, resources);
    if (activeTab === 'res')   renderResPane();

    refreshSelects();
    updateCount();
    applyFilters();
    if (activeTab === 'state') renderStatePane();
    if (activeTab === 'track') renderTrackPane();
  }

  // ─── Hook socket.io ──────────────────────────────────────────────────────────
  function hookSocket() {
    if (!window.io) { setTimeout(hookSocket, 500); return; }
    const originalIo = window.io;
    window.io = function (...args) {
      const socket = originalIo.apply(this, args);
      _hooked_socket = socket;
      socket.onAny((event, ...data) => {
        if (event === 'spawn_state' && data[0]) handleSpawnState(data[0]);
      });
      return socket;
    };
    addStatus('✅ Socket.io hooked');
  }

  function addStatus(msg) {
    console.log(`[ROE] ${msg}`);
  }

  // ─── Init ────────────────────────────────────────────────────────────────────
  updateTrackTab();
  applySavedAutoRefreshUI();
  hookSocket();
  addStatus('🟡 Waiting for socket.io...');

})();