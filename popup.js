'use strict';

const GLANCES_PORT   = 61208;
const NODE_EXP_PORT  = 9100;
const ZIMAOS_PORT    = 80;
const ZIMAOS_INFO_PORT = 9527;

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'auto') {
    root.setAttribute('data-theme',
      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', pref);
  }
}

(function initTheme() {
  chrome.storage.local.get({ theme: 'auto' }, ({ theme }) => applyTheme(theme));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    chrome.storage.local.get({ theme: 'auto' }, ({ theme }) => {
      if (theme === 'auto') applyTheme('auto');
    });
  });
})();

// ── Storage ──────────────────────────────────────────────────────────────────

function getServers() {
  return new Promise(resolve => {
    chrome.storage.local.get({ servers: [], activeServerId: '' }, data => resolve(data));
  });
}

function getToken(serverId) {
  return new Promise(resolve => {
    chrome.storage.session.get({ tokens: {} }, data => {
      const t = data.tokens[serverId];
      resolve(t && t.expires > Date.now() ? t.token : null);
    });
  });
}

function saveToken(serverId, token) {
  chrome.storage.session.get({ tokens: {} }, data => {
    data.tokens[serverId] = { token, expires: Date.now() + 8 * 3600 * 1000 };
    chrome.storage.session.set({ tokens: data.tokens });
  });
}

// ── Network ──────────────────────────────────────────────────────────────────

async function fetchTimeout(url, ms = 3000, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function resolveIp(server) {
  for (const ip of [server.localIp, server.tailscaleIp].filter(Boolean)) {
    try {
      await fetchTimeout(`http://${ip}:${GLANCES_PORT}/api/4/cpu`, 2500);
      return ip;
    } catch { /* try next */ }
  }
  return null;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function login(ip, username, password) {
  const res = await fetchTimeout(`http://${ip}:${ZIMAOS_PORT}/v1/users/login`, 5000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json();
  if (json.success !== 200) throw new Error(json.message || 'Login failed');
  // Token is nested: data.token.access_token
  return json.data?.token?.access_token || null;
}

async function getAuthToken(server, ip) {
  const cached = await getToken(server.id);
  if (cached) return cached;

  if (!server.username || !server.password) return null;

  try {
    const token = await login(ip, server.username, server.password);
    if (token) saveToken(server.id, token);
    return token;
  } catch {
    return null;
  }
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function fetchGlances(ip, path) {
  try {
    const res = await fetchTimeout(`http://${ip}:${GLANCES_PORT}/api/4/${path}`, 3000);
    return res.json();
  } catch {
    return null;
  }
}

// ── Gauge tooltip ─────────────────────────────────────────────────────────────

let _dockerData = null;

function setupGaugeTooltip(ip) {
  const tooltip = document.getElementById('gaugeTooltip');
  if (!tooltip) return;

  async function refreshDocker() {
    _dockerData = await fetchGlances(ip, 'containers');
  }
  refreshDocker();
  setInterval(refreshDocker, 5000);

  function getValue(c, type) {
    if (type === 'cpu') return c.cpu?.total ?? 0;
    if (type === 'ram') return c.memory?.usage ?? 0;
    if (type === 'rx')  return c.network_rx ?? 0;
    if (type === 'tx')  return c.network_tx ?? 0;
    return 0;
  }

  function formatValue(c, type) {
    if (type === 'cpu') return (c.cpu?.total ?? 0).toFixed(1) + '%';
    if (type === 'ram') return formatBytes(c.memory?.usage ?? 0);
    if (type === 'rx')  return formatSpeed(c.network_rx ?? 0);
    if (type === 'tx')  return formatSpeed(c.network_tx ?? 0);
    return '—';
  }

  const TITLES = { cpu: 'CPU par container', ram: 'RAM par container', rx: 'Download par container', tx: 'Upload par container' };

  function showTooltip(wrap, type) {
    if (!Array.isArray(_dockerData) || !_dockerData.length) return;
    const containers = [..._dockerData]
      .filter(c => c.status === 'running')
      .sort((a, b) => getValue(b, type) - getValue(a, type))
      .slice(0, 8);

    const rows = containers.map(c => {
      const name = c.name.replace(/^\//, '');
      return `<div class="tooltip-row">
        <span class="tooltip-name">${name}</span>
        <span class="tooltip-val">${formatValue(c, type)}</span>
      </div>`;
    }).join('');

    tooltip.innerHTML = `<div class="tooltip-title">${TITLES[type]}</div>${rows}`;
    tooltip.classList.add('visible');

    const rect = wrap.getBoundingClientRect();
    const tw = 200;
    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    const top = rect.bottom + 6;
    tooltip.style.left = left + 'px';
    tooltip.style.top  = top + 'px';
  }

  function hideTooltip() {
    tooltip.classList.remove('visible');
  }

  [['cpuWrap', 'cpu'], ['ramWrap', 'ram'], ['connNetDownWrap', 'rx'], ['connNetUpWrap', 'tx']].forEach(([id, type]) => {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    wrap.style.cursor = 'default';
    wrap.addEventListener('mouseenter', () => showTooltip(wrap, type));
    wrap.addEventListener('mouseleave', hideTooltip);
  });
}

async function fetchNodeExporter(ip) {
  try {
    // collect[]=filesystem réduit la réponse à ~100 lignes au lieu de 4000+
    const res = await fetchTimeout(
      `http://${ip}:${NODE_EXP_PORT}/metrics?collect[]=filesystem`,
      4000
    );
    const text = await res.text();
    const parsed = parsePrometheusText(text);
    return parsed;
  } catch (e) {
    console.error('[node-exporter] fetch failed:', e?.message);
    return null;
  }
}

async function fetchApps(ip, token) {
  try {
    const headers = token ? { Authorization: token } : {};
    const res = await fetchTimeout(
      `http://${ip}:${ZIMAOS_PORT}/v2/app_management/web/appgrid`,
      6000, { headers }
    );
    const json = await res.json();
    return Array.isArray(json.data) ? json.data : [];
  } catch {
    return [];
  }
}

async function fetchZimaInfo(ip) {
  try {
    const res = await fetchTimeout(`http://${ip}:${ZIMAOS_INFO_PORT}/`, 2000);
    return res.json();
  } catch {
    return null;
  }
}

// ── Prometheus text parser ───────────────────────────────────────────────────

function parsePrometheusText(text) {
  const result = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+([\d.e+\-]+)/);
    if (!m) continue;
    const [, metric, rawLabels, rawValue] = m;
    const labels = {};
    for (const lm of rawLabels.matchAll(/(\w+)="([^"]*)"/g)) labels[lm[1]] = lm[2];
    if (!result[metric]) result[metric] = [];
    result[metric].push({ labels, value: parseFloat(rawValue) });
  }
  return result;
}

function parseDisks(metrics) {
  if (!metrics) return [];
  const PHYSICAL_FS = ['ext4', 'xfs', 'btrfs', 'zfs', 'f2fs'];
  const sizes  = metrics['node_filesystem_size_bytes']  || [];
  const avails = metrics['node_filesystem_avail_bytes'] || [];

  const seen = new Set();
  const disks = [];

  for (const entry of sizes) {
    const { device, fstype, mountpoint } = entry.labels;
    if (!PHYSICAL_FS.includes(fstype)) continue;
    if (seen.has(device)) continue;
    seen.add(device);

    const avail = avails.find(a => a.labels.device === device)?.value ?? 0;
    const size  = entry.value;
    const used  = size - avail;
    const pct   = size > 0 ? (used / size * 100) : 0;
    const label = diskLabel(device, mountpoint);

    disks.push({ device, fstype, mountpoint, size, used, avail, pct, label });
  }

  // Sort by size desc, skip tiny system partitions
  return disks
    .filter(d => d.size > 5 * 1024 * 1024 * 1024)
    .sort((a, b) => b.size - a.size)
    .slice(0, 2);
}

function diskLabel(device, mountpoint) {
  if (/^\/dev\/md/.test(device)) return 'HDD';
  if (/nvme/.test(device)) return 'SSD';
  // Use mountpoint basename for clarity
  const base = mountpoint.split('/').filter(Boolean).pop() || device;
  if (base === 'DATA') return 'SSD';
  if (/safe.storage/i.test(base)) return 'HDD';
  return base.slice(0, 5).toUpperCase();
}

function parseDisksFromGlances(data) {
  if (!Array.isArray(data)) return [];
  const SKIP_TYPES = new Set(['tmpfs', 'devtmpfs', 'overlay', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'squashfs', 'vfat']);
  // Only real host mountpoints — exclude Docker bind-mounts of files/system dirs
  const REAL_MNT = ['/DATA', '/media', '/mnt', '/home', '/srv', '/storage', '/volume'];
  const seen = new Set();
  return data
    .filter(d => {
      if (SKIP_TYPES.has(d.fs_type)) return false;
      if (d.size < 5 * 1024 * 1024 * 1024) return false;
      const isReal = REAL_MNT.some(p => d.mnt_point === p || d.mnt_point.startsWith(p + '/'));
      if (!isReal) return false;
      if (seen.has(d.device_name)) return false;
      seen.add(d.device_name);
      return true;
    })
    .map(d => ({
      device: d.device_name, mountpoint: d.mnt_point,
      size: d.size, used: d.used, avail: d.free,
      pct: d.percent, label: diskLabel(d.device_name, d.mnt_point),
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 2);
}

// ── Network (via Glances api/4/network — donne le débit en temps réel) ────────

function formatSpeed(bps) {
  if (bps < 0) return '—';
  if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
  if (bps >= 1024)        return (bps / 1024).toFixed(0) + ' KB/s';
  return Math.round(bps) + ' B/s';
}

function renderNetwork(data) {
  if (!Array.isArray(data)) return;
  const isPhysical = d => d.interface_name !== 'lo'
    && !/^(docker|veth|br-|virbr|tun|tap|dummy)/.test(d.interface_name);
  const ifaces = data.filter(isPhysical);
  if (!ifaces.length) return;

  const down = ifaces.reduce((s, d) => s + (d.bytes_recv_rate_per_sec || 0), 0);
  const up   = ifaces.reduce((s, d) => s + (d.bytes_sent_rate_per_sec || 0), 0);

  const connNet = document.getElementById('connNet');
  const connNetDown = document.getElementById('connNetDown');
  const connNetUp   = document.getElementById('connNetUp');
  if (connNetDown) connNetDown.textContent = formatSpeed(down);
  if (connNetUp)   connNetUp.textContent   = formatSpeed(up);
  if (connNet)     connNet.style.display   = 'flex';
}

// ── App parsing ──────────────────────────────────────────────────────────────

function parseApps(data, ip) {
  if (!Array.isArray(data)) return [];

  return data
    .filter(app => app.app_type === 'v2app')
    .map(app => {
      const title = app.title?.custom || app.title?.en_us || app.title?.en_US || cleanName(app.name);
      const running = app.status === 'running';

      let url = null;
      if (app.hostname) {
        url = `${app.scheme || 'http'}://${app.hostname}${app.index || ''}`;
      } else if (app.port) {
        url = `${app.scheme || 'http'}://${ip}:${app.port}${app.index || ''}`;
      }

      return { id: app.name, name: title, icon: app.icon || null, url, running };
    })
    .filter(app => app.url)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const NAME_OVERRIDES = {
  'n8n': 'n8n', 'nocodb': 'NocoDB', 'jellyfin': 'Jellyfin',
  'jellyseerr': 'Jellyseerr', 'qbittorrent': 'qBittorrent',
  'filebrowser': 'File Browser', 'nextcloud': 'Nextcloud',
  'radarr': 'Radarr', 'sonarr': 'Sonarr', 'prowlarr': 'Prowlarr',
  'prowlarr-ui': 'Prowlarr', 'jackett': 'Jackett', 'grafana': 'Grafana',
  'prometheus': 'Prometheus', 'tailscale': 'Tailscale', 'glances': 'Glances',
  'immich': 'Immich', 'obsidian': 'Obsidian', 'cloudflared': 'Cloudflare Tunnel',
  'monitoring': 'Monitoring', 'dashboard': 'Dashboard', 'vinted-crm': 'Vinted CRM',
  'work-nas': 'Work NAS', 'jarvis-sms': 'Jarvis SMS',
};

function cleanName(id) {
  const stripped = id.replace(/^big-bear-/, '');
  return NAME_OVERRIDES[id] || NAME_OVERRIDES[stripped]
    || stripped.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Rendering ────────────────────────────────────────────────────────────────

const R = 15.915; // circumference ≈ 100

function setGauge(fillId, pctId, pct, label) {
  const fill = document.getElementById(fillId);
  const pctEl = document.getElementById(pctId);
  if (!fill || !pctEl) return;
  const p = Math.min(100, Math.max(0, pct));
  fill.style.strokeDasharray = `${p} ${100 - p}`;
  fill.className.baseVal = fill.className.baseVal.replace(/\b(warn|crit)\b/g, '');
  if (p >= 90) fill.classList.add('crit');
  else if (p >= 75) fill.classList.add('warn');
  pctEl.textContent = label;
}

function formatBytes(bytes) {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1000) return (gb / 1024).toFixed(1) + 'T';
  if (gb >= 1)    return gb.toFixed(1) + 'G';
  return (bytes / 1024 / 1024).toFixed(0) + 'M';
}

function renderStats(cpu, mem) {
  if (cpu) {
    const p = cpu.total ?? 0;
    setGauge('cpuFill', 'cpuPct', p, p.toFixed(1) + '%');
  }
  if (mem) {
    const p = mem.percent ?? 0;
    setGauge('ramFill', 'ramPct', p, p.toFixed(0) + '%');
    document.getElementById('ramSub').textContent =
      `${formatBytes(mem.used)} / ${formatBytes(mem.total)}`;
  }
}

const DISK_FILLS = ['disk0Fill', 'disk1Fill'];
const DISK_PCTS  = ['disk0Pct',  'disk1Pct'];
const DISK_LBLS  = ['disk0Lbl',  'disk1Lbl'];
const DISK_SUBS  = ['disk0Sub',  'disk1Sub'];
const DISK_WRAPS = ['disk0Wrap', 'disk1Wrap'];

function renderDisks(disks) {
  DISK_WRAPS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Hide the divider if no disks
  const divider = document.querySelector('.stats-divider');

  if (!disks.length) {
    if (divider) divider.style.display = 'none';
    return;
  }

  if (divider) divider.style.display = '';

  disks.forEach((disk, i) => {
    if (i >= 2) return;
    const wrap = document.getElementById(DISK_WRAPS[i]);
    if (wrap) wrap.style.display = 'flex';
    setGauge(DISK_FILLS[i], DISK_PCTS[i], disk.pct, disk.pct.toFixed(0) + '%');
    const lbl = document.getElementById(DISK_LBLS[i]);
    if (lbl) lbl.textContent = disk.label;
    const sub = document.getElementById(DISK_SUBS[i]);
    if (sub) sub.textContent = `${formatBytes(disk.used)} / ${formatBytes(disk.size)}`;
  });
}

function getFavorites() {
  return new Promise(resolve =>
    chrome.storage.local.get({ favorites: [] }, ({ favorites }) => resolve(new Set(favorites)))
  );
}

function setFavorites(favSet) {
  chrome.storage.local.set({ favorites: [...favSet] });
}

async function renderApps(apps) {
  const list  = document.getElementById('appsList');
  const count = document.getElementById('appsCount');

  count.textContent = apps.length;

  if (!apps.length) {
    list.innerHTML = `<div class="error-state">
      <div class="icon">📦</div><p>Aucune application trouvée</p>
    </div>`;
    return;
  }

  const favs = await getFavorites();
  const sorted = [...apps].sort((a, b) => {
    const af = favs.has(a.name) ? 0 : 1;
    const bf = favs.has(b.name) ? 0 : 1;
    return af - bf;
  });

  list.innerHTML = sorted.map(app => `
    <div class="app-card ${app.running ? '' : 'app-stopped'}" data-url="${app.url}" data-name="${app.name}">
      <button class="fav-btn ${favs.has(app.name) ? 'fav-on' : ''}" data-name="${app.name}" title="Favori">★</button>
      <div class="app-card-icon">
        ${app.icon ? `<img src="${app.icon}" alt="" loading="lazy">` : '📦'}
      </div>
      <span class="app-card-name">${app.name}</span>
      <span class="app-status-dot ${app.running ? 'running' : 'stopped'}"></span>
    </div>`).join('');

  list.querySelectorAll('.app-card img').forEach(img => {
    img.addEventListener('error', () => { img.parentNode.textContent = '📦'; });
  });

  list.querySelectorAll('.fav-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const name = btn.dataset.name;
      const favs = await getFavorites();
      favs.has(name) ? favs.delete(name) : favs.add(name);
      setFavorites(favs);
      btn.classList.toggle('fav-on', favs.has(name));
      // re-sort cards in place
      const cards = [...list.querySelectorAll('.app-card')];
      const newFavs = favs;
      cards.sort((a, b) => {
        const af = newFavs.has(a.dataset.name) ? 0 : 1;
        const bf = newFavs.has(b.dataset.name) ? 0 : 1;
        return af - bf;
      });
      cards.forEach(c => list.appendChild(c));
    });
  });

  list.querySelectorAll('.app-card').forEach(el => {
    el.addEventListener('click', () => chrome.tabs.create({ url: el.dataset.url }));
  });
}

function showError(msg, detail = '') {
  document.getElementById('statsSection').style.display = 'none';
  const list = document.getElementById('appsList');
  list.innerHTML = `
    <div class="error-state">
      <div class="icon">⚠️</div>
      <p>${msg}</p>
      <small>${detail}</small>
      <button class="btn-settings-link" id="btnGoSettings">Paramètres</button>
    </div>`;
  document.getElementById('btnGoSettings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('appsCount').textContent = '';
}

// ── NAS switcher ──────────────────────────────────────────────────────────────

function buildSwitcher(servers, activeId) {
  const sel = document.getElementById('nasSwitcher');
  sel.innerHTML = servers.map(s =>
    `<option value="${s.id}" ${s.id === activeId ? 'selected' : ''}>${s.name}</option>`
  ).join('');
  sel.addEventListener('change', () => {
    chrome.storage.local.set({ activeServerId: sel.value }, () => location.reload());
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const dot        = document.getElementById('statusDot');
  const footerIp   = document.getElementById('footerIp');
  const connName   = document.getElementById('connName');
  const statusText = document.getElementById('statusText');

  document.getElementById('btnRefresh').addEventListener('click', () => location.reload());
  document.getElementById('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  const themeToggle = document.getElementById('themeToggle');
  function syncToggle(theme) {
    if (!themeToggle) return;
    const isDark = theme === 'dark' ||
      (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    themeToggle.classList.toggle('dark', isDark);
  }
  chrome.storage.local.get({ theme: 'auto' }, ({ theme }) => syncToggle(theme));
  themeToggle?.addEventListener('click', () => {
    const isDark = themeToggle.classList.contains('dark');
    const next = isDark ? 'light' : 'dark';
    chrome.storage.local.set({ theme: next });
    applyTheme(next);
    syncToggle(next);
  });

  const { servers, activeServerId } = await getServers();

  if (!servers.length) {
    chrome.runtime.openOptionsPage();
    return;
  }

  buildSwitcher(servers, activeServerId);

  const server = servers.find(s => s.id === activeServerId) || servers[0];
  if (connName) connName.textContent = server.name;

  const ip = await resolveIp(server);

  if (!ip) {
    dot.className = 'status-dot offline';
    if (statusText) statusText.textContent = 'Hors ligne';
    footerIp.textContent = 'Inaccessible';
    showError('NAS inaccessible', 'Vérifiez votre réseau ou l\'IP dans les paramètres.');
    return;
  }

  dot.className = 'status-dot online';
  if (statusText) statusText.textContent = 'En ligne';
  footerIp.textContent = ip;
  document.getElementById('btnOpen').addEventListener('click', () => {
    chrome.tabs.create({ url: `http://${ip}` });
  });

  // Fetch everything in parallel
  const [info, cpu, mem, nodeMetrics, glancesFs, netData, token] = await Promise.all([
    fetchZimaInfo(ip),
    fetchGlances(ip, 'cpu'),
    fetchGlances(ip, 'mem'),
    fetchNodeExporter(ip),
    fetchGlances(ip, 'fs'),
    fetchGlances(ip, 'network'),
    getAuthToken(server, ip),
  ]);

  if (info?.os_version) {
    document.getElementById('osVersion').textContent = info.os_version;
  }

  renderStats(cpu, mem);

  let disks = parseDisks(nodeMetrics);
  if (!disks.length) disks = parseDisksFromGlances(glancesFs);
  renderDisks(disks);

  renderNetwork(netData);
  setupGaugeTooltip(ip);

  if (!cpu && !mem && !disks.length) {
    document.getElementById('statsSection').style.display = 'none';
  }

  const appsData = await fetchApps(ip, token);
  const apps = parseApps(appsData, ip);
  renderApps(apps);

  // Rafraîchissement automatique toutes les 5s
  setInterval(async () => {
    const [cpu2, mem2, nodeMetrics2, glancesFs2, netData2] = await Promise.all([
      fetchGlances(ip, 'cpu'),
      fetchGlances(ip, 'mem'),
      fetchNodeExporter(ip),
      fetchGlances(ip, 'fs'),
      fetchGlances(ip, 'network'),
    ]);
    renderStats(cpu2, mem2);
    let d = parseDisks(nodeMetrics2);
    if (!d.length) d = parseDisksFromGlances(glancesFs2);
    renderDisks(d);
    renderNetwork(netData2);
  }, 5000);
}

init();
