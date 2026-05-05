'use strict';

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getState() {
  return new Promise(resolve => {
    chrome.storage.local.get({ servers: [], activeServerId: '' }, resolve);
  });
}

function saveState(servers, activeServerId) {
  return new Promise(resolve => {
    chrome.storage.local.set({ servers, activeServerId }, resolve);
  });
}

// ── Render server list ────────────────────────────────────────────────────────

function renderList(servers, activeServerId) {
  const container = document.getElementById('serversList');

  if (!servers.length) {
    container.innerHTML = `<div class="empty-state">
      Aucun serveur configuré.<br>Cliquez sur "+ Ajouter" pour commencer.
    </div>`;
    return;
  }

  container.innerHTML = servers.map(s => {
    const isActive = s.id === activeServerId;
    const details = [s.localIp, s.tailscaleIp].filter(Boolean).join(' · ');
    return `
      <div class="server-card" data-id="${s.id}">
        <div class="server-card-info">
          <div class="server-name">
            ${s.name}
            ${isActive ? '<span class="server-badge">Actif</span>' : ''}
          </div>
          <div class="server-details">${details || 'Aucune IP configurée'}
            ${s.username ? ` · @${s.username}` : ''}
          </div>
        </div>
        <div class="server-actions">
          ${!isActive ? `<button class="btn-set-active" data-id="${s.id}">Activer</button>` : ''}
          <button class="btn-edit" data-id="${s.id}">Modifier</button>
          <button class="btn-delete" data-id="${s.id}">✕</button>
        </div>
      </div>`;
  }).join('');

  // Events
  container.querySelectorAll('.btn-set-active').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { servers } = await getState();
      await saveState(servers, btn.dataset.id);
      refresh();
    });
  });
  container.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { servers } = await getState();
      const server = servers.find(s => s.id === btn.dataset.id);
      if (server) openForm(server);
    });
  });
  container.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer ce serveur ?')) return;
      let { servers, activeServerId } = await getState();
      servers = servers.filter(s => s.id !== btn.dataset.id);
      if (activeServerId === btn.dataset.id) {
        activeServerId = servers[0]?.id || '';
      }
      await saveState(servers, activeServerId);
      refresh();
    });
  });
}

// ── Form ─────────────────────────────────────────────────────────────────────

function openForm(server = null) {
  const formCard  = document.getElementById('formCard');
  const formTitle = document.getElementById('formTitle');

  document.getElementById('editId').value       = server?.id || '';
  document.getElementById('fName').value        = server?.name || '';
  document.getElementById('fLocalIp').value     = server?.localIp || '';
  document.getElementById('fTailscaleIp').value = server?.tailscaleIp || '';
  document.getElementById('fUsername').value    = server?.username || '';
  document.getElementById('fPassword').value    = server?.password || '';
  document.getElementById('fPortGlances').value = server?.portGlances || '';
  document.getElementById('fPortZimaos').value  = server?.portZimaos || '';

  formTitle.textContent = server ? 'Modifier le serveur' : 'Nouveau serveur';
  formCard.style.display = 'block';
  formCard.scrollIntoView({ behavior: 'smooth' });
  document.getElementById('fName').focus();
}

function closeForm() {
  document.getElementById('formCard').style.display = 'none';
}

async function saveForm() {
  const id          = document.getElementById('editId').value;
  const name        = document.getElementById('fName').value.trim() || 'Mon NAS';
  const localIp     = document.getElementById('fLocalIp').value.trim();
  const tailscaleIp = document.getElementById('fTailscaleIp').value.trim();
  const username    = document.getElementById('fUsername').value.trim();
  const password    = document.getElementById('fPassword').value;
  const portGlances = parseInt(document.getElementById('fPortGlances').value) || null;
  const portZimaos  = parseInt(document.getElementById('fPortZimaos').value) || null;

  let { servers, activeServerId } = await getState();

  if (id) {
    // Edit
    const idx = servers.findIndex(s => s.id === id);
    if (idx >= 0) servers[idx] = { id, name, localIp, tailscaleIp, username, password, portGlances, portZimaos };
  } else {
    // Add
    const newServer = { id: uuid(), name, localIp, tailscaleIp, username, password, portGlances, portZimaos };
    servers.push(newServer);
    if (!activeServerId) activeServerId = newServer.id;
  }

  await saveState(servers, activeServerId);
  closeForm();
  refresh();
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function refresh() {
  const { servers, activeServerId } = await getState();
  renderList(servers, activeServerId);
}

document.getElementById('btnAdd').addEventListener('click', () => openForm());
document.getElementById('btnSave').addEventListener('click', saveForm);
document.getElementById('btnCancel').addEventListener('click', closeForm);

refresh();
