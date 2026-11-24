/* Dashboard web de supervision NetData (section 10 du CDC) */

const REFRESH_MS = 10000;
const ONLINE_MS = 2 * 60 * 1000;   // un téléphone synchronisé il y a moins de 2 min est « en ligne »

let accessToken = sessionStorage.getItem('access_token');
let refreshToken = sessionStorage.getItem('refresh_token');
let timer = null;
let charts = {};
let map = null;
let mapLayer = null;

const CLASS_COLORS = {
  'Normal': '#27ae60',
  'Anomalie réseau': '#f39c12',
  'Menace potentielle': '#e67e22',
  'Menace confirmée': '#c0392b',
};

/* ---------- Utilitaires ---------- */

const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v, digits = 1, unit = '') => (v === null || v === undefined || Number.isNaN(Number(v)) ? 'N/A' : `${Number(v).toFixed(digits)}${unit}`);
const time = ms => new Date(ms).toLocaleTimeString('fr-FR');
const dateTime = v => (v ? new Date(v).toLocaleString('fr-FR') : 'jamais');
const classColor = c => CLASS_COLORS[c] || '#7f8c8d';
const barColor = v => (v < 30 ? '#27ae60' : v < 55 ? '#f39c12' : v < 75 ? '#e67e22' : '#c0392b');
const view = html => { $('#app').innerHTML = html; };
const qs = params => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();

/* ---------- API avec jetons JWT ---------- */

function saveTokens(access, refresh) {
  accessToken = access;
  sessionStorage.setItem('access_token', access);
  if (refresh) {
    refreshToken = refresh;
    sessionStorage.setItem('refresh_token', refresh);
  }
}

function logout() {
  accessToken = refreshToken = null;
  sessionStorage.clear();
  location.hash = '#/login';
  route();
}

async function rawFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(path, { ...options, headers });
}

async function authorizedFetch(path, options = {}) {
  let res = await rawFetch(path, options);
  if (res.status === 401 && refreshToken) {
    const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${refreshToken}` } });
    if (r.ok) {
      saveTokens((await r.json()).access_token);
      res = await rawFetch(path, options);
    }
  }
  if (res.status === 401 || res.status === 422) {
    logout();
    throw new Error('Session expirée');
  }
  return res;
}

async function api(path, options = {}) {
  const res = await authorizedFetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.msg || `Erreur ${res.status}`);
  return body;
}

/* ---------- Navigation ---------- */

function cleanup() {
  clearInterval(timer);
  timer = null;
  Object.values(charts).forEach(c => c.destroy());
  charts = {};
  if (map) {
    map.remove();
    map = null;
    mapLayer = null;
  }
}

function route() {
  cleanup();
  const hash = location.hash || '#/devices';
  $('#topbar').classList.toggle('hidden', !accessToken);
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', hash.startsWith(`#/${a.dataset.nav}`)));

  if (!accessToken) return renderLogin();
  if (hash.startsWith('#/device/')) return renderDevice(decodeURIComponent(hash.slice('#/device/'.length)));
  if (hash === '#/alerts') return renderAlerts();
  if (hash === '#/install') return renderInstall();
  return renderDevices();
}

window.addEventListener('hashchange', route);
$('#logout').addEventListener('click', logout);

/* ---------- Connexion ---------- */

function renderLogin() {
  view(`
    <div class="card login">
      <h1>NetData Supervision</h1>
      <p class="muted">Connexion administrateur</p>
      <form id="login-form">
        <input name="username" placeholder="Utilisateur" value="admin" autocomplete="username" required>
        <input name="password" type="password" placeholder="Mot de passe" autocomplete="current-password" required>
        <button class="primary" type="submit">Se connecter</button>
        <div id="login-error" class="error"></div>
      </form>
    </div>`);

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('#login-error').textContent = body.error || 'Connexion impossible';
      return;
    }
    saveTokens(body.access_token, body.refresh_token);
    location.hash = '#/devices';
    route();
  });
}

/* ---------- Liste des téléphones ---------- */

function deviceCard(d) {
  const online = d.last_sync && Date.now() - new Date(d.last_sync).getTime() < ONLINE_MS;
  const risk = d.risk;
  const model = [d.info?.manufacturer, d.info?.model].filter(Boolean).join(' ');
  return `
    <div class="card device-card ${d.revoked ? 'revoked' : ''}" data-id="${esc(d._id)}">
      <div class="head">
        <div>
          <div class="name">${esc(d.name || d._id)}</div>
          <div class="muted">${esc(model)} · Android ${esc(d.info?.android_version ?? '?')}</div>
        </div>
        ${risk ? `<div class="score" style="color:${classColor(risk.risk_class)}">${Math.round(risk.risk_score)}</div>` : ''}
      </div>
      <div>
        ${d.revoked
          ? '<span class="badge" style="background:#7f8c8d">Révoqué</span>'
          : `<span class="dot" style="background:${online ? '#27ae60' : '#bdc3c7'}"></span>${online ? 'En ligne' : 'Hors ligne'}`}
        ${risk && !d.revoked ? ` · <span class="badge" style="background:${classColor(risk.risk_class)}">${esc(risk.risk_class)}</span>` : ''}
      </div>
      <div class="muted">Dernière synchronisation : ${dateTime(d.last_sync)}</div>
      ${risk && risk.alerts?.length ? `<div class="alert-item">${esc(risk.alerts[0])}${risk.alerts.length > 1 ? ` (+${risk.alerts.length - 1})` : ''}</div>` : ''}
      <div class="actions no-print">
        <button class="secondary" data-action="rename">Renommer</button>
        ${d.revoked ? '' : '<button class="danger" data-action="revoke">Révoquer</button>'}
      </div>
    </div>`;
}

async function renderDevices() {
  view(`
    <div class="toolbar">
      <h1>Téléphones</h1>
      <div class="pairing no-print" style="margin:0">
        <input id="pair-name" placeholder="Nom du téléphone (optionnel)" maxlength="60">
        <button class="primary" id="add-device">+ Ajouter un téléphone</button>
      </div>
    </div>
    <div id="pairing-result"></div>
    <div id="error" class="error"></div>
    <div id="device-list" class="grid">Chargement...</div>`);

  $('#add-device').addEventListener('click', createPairingCode);

  $('#device-list').addEventListener('click', async e => {
    const card = e.target.closest('.device-card');
    if (!card) return;
    const id = card.dataset.id;
    const action = e.target.closest('button')?.dataset.action;
    try {
      if (action === 'rename') {
        const name = prompt('Nouveau nom du téléphone :');
        if (name) await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
        return load();
      }
      if (action === 'revoke') {
        if (confirm('Révoquer ce téléphone ? Il ne pourra plus envoyer de données (un nouveau code sera nécessaire).')) {
          await api(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
        }
        return load();
      }
      location.hash = `#/device/${encodeURIComponent(id)}`;
    } catch (err) {
      $('#error').textContent = err.message;
    }
  });

  const load = async () => {
    try {
      const devices = await api('/api/devices');
      $('#device-list').innerHTML = devices.length ? devices.map(deviceCard).join('') : '<p>Aucun téléphone associé. Clique sur « Ajouter un téléphone ».</p>';
      $('#error').textContent = '';
    } catch (err) {
      $('#error').textContent = err.message;
    }
  };
  await load();
  timer = setInterval(load, REFRESH_MS);
}

async function createPairingCode() {
  try {
    const res = await api('/api/pairing/code', { method: 'POST', body: JSON.stringify({ name: $('#pair-name').value }) });
    const expires = Date.now() + res.expires_in * 1000;
    $('#pairing-result').innerHTML = `
      <div class="card section">
        <h2>Code d'association</h2>
        <div class="pairing">
          <div class="pairing-code">${esc(res.code)}</div>
          <div>
            <div>Dans l'app : <b>Paramètres → Associer ce téléphone</b></div>
            <div>Adresse du serveur : <b>${esc(location.origin)}</b></div>
            <div class="muted">Valable encore <span id="countdown"></span> · utilisable une seule fois</div>
          </div>
        </div>
      </div>`;
    const tick = () => {
      const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
      const el = $('#countdown');
      if (el) el.textContent = left > 0 ? `${Math.floor(left / 60)} min ${String(left % 60).padStart(2, '0')} s` : 'expiré';
    };
    tick();
    const countdown = setInterval(() => (document.body.contains($('#countdown')) ? tick() : clearInterval(countdown)), 1000);
  } catch (err) {
    $('#error').textContent = err.message;
  }
}

/* ---------- Graphiques ---------- */

function lineChart(id, labels, datasets, yOptions = {}) {
  const data = { labels, datasets: datasets.map(ds => ({ pointRadius: 0, borderWidth: 2, tension: 0.3, ...ds })) };
  if (charts[id]) {
    charts[id].data = data;
    charts[id].update('none');
    return;
  }
  charts[id] = new Chart(document.getElementById(id), {
    type: 'line',
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 8 } }, y: yOptions },
      plugins: { legend: { position: 'bottom' } },
    },
  });
}

/* ---------- Détail d'un téléphone ---------- */

const STATE_LABELS = { in_service: 'en service', out_of_service: 'hors service', emergency_only: 'urgences uniquement', power_off: 'radio coupée' };
const REG_LABELS = { registered: 'enregistré', registered_roaming: 'enregistré (itinérance)', searching: 'recherche', denied: 'refusé', not_registered: 'non enregistré' };
const NR_LABELS = { NONE: 'non disponible', RESTRICTED: 'restreinte', NOT_RESTRICTED: 'disponible', CONNECTED: 'connectée' };
const cellText = c => (c ? `${c.tech} ${c.cell_id ?? '?'} (PCI ${c.pci ?? '?'})` : '?');

function eventText(e) {
  if (e.event === 'cell_change') return `${e.change_type === 'handover' ? 'Handover' : 'Resélection'} : ${cellText(e.from_cell)} → ${cellText(e.to_cell)}`;
  if (e.event === 'technology_change') return `Technologie : ${e.from_tech} → ${e.to_tech}${e.downgrade ? ' (rétrogradation)' : ''}`;
  if (e.event === 'registration') return `Enregistrement : ${REG_LABELS[e.from_registration] ?? e.from_registration} → ${REG_LABELS[e.to_registration] ?? e.to_registration}${e.reject_cause ? ` (cause ${e.reject_cause})` : ''}`;
  if (e.event === 'nr_state') return `5G NSA : ${NR_LABELS[e.from_nr_state] ?? e.from_nr_state} → ${NR_LABELS[e.to_nr_state] ?? e.to_nr_state}`;
  return `Service : ${STATE_LABELS[e.from_state] ?? e.from_state} → ${STATE_LABELS[e.to_state] ?? e.to_state}`;
}

function testText(t) {
  if (t.kind === 'dns') return [`DNS ${t.server === 'system' ? 'système' : t.server} (${t.domain})`, `${n(t.avgMs, 0, ' ms')} · échecs ${n(t.failureRate, 0, ' %')}`];
  if (t.kind === 'tcp') return [`TCP ${t.host}:${t.port}`, `latence ${n(t.avgMs, 0, ' ms')} · jitter ${n(t.jitterMs, 1, ' ms')} · perte ${n(t.lossPercent, 0, ' %')}`];
  if (t.kind === 'http') return [`HTTP ${t.url}`, `code ${t.statusCode} · DNS ${n(t.dnsMs, 0)} · TCP ${n(t.tcpMs, 0)} · TLS ${n(t.tlsMs, 0)} · total ${n(t.totalMs, 0, ' ms')}`];
  return [t.kind === 'download' ? 'Débit descendant' : 'Débit montant', n(t.mbps, 2, ' Mbit/s')];
}

function riskHtml(risk) {
  if (!risk) return '<div class="card">Aucune analyse disponible pour ce téléphone.</div>';
  const components = [['ml', 'Machine Learning', '30 %'], ['behavioral', 'Analyse comportementale', '30 %'], ['url', 'Réputation des domaines', '20 %'], ['mobile', 'Métriques mobiles', '20 %']];
  return `
    <div class="grid-3">
      <div class="risk-box" style="background:${classColor(risk.risk_class)}">
        <div class="value">${Math.round(risk.risk_score)}</div>
        <div>/ 100</div>
        <div class="class">${esc(risk.risk_class)}</div>
        <div class="muted" style="color:#fff">Analyse du ${dateTime(risk.timestamp)}</div>
      </div>
      <div class="card">
        <h2>Composantes du score</h2>
        ${components.map(([k, label, w]) => {
          const v = risk.components?.[k] ?? 0;
          return `<div>${label} (${w}) <b style="float:right">${Math.round(v)}</b></div>
                  <div class="bar"><div style="width:${Math.min(100, v)}%;background:${barColor(v)}"></div></div>`;
        }).join('')}
      </div>
      <div class="card">
        <h2>Alertes (${risk.alerts?.length ?? 0})</h2>
        ${risk.alerts?.length ? risk.alerts.map(a => `<div class="alert-item">• ${esc(a)}</div>`).join('') : '<div style="color:#27ae60">Aucune alerte</div>'}
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h2>Domaines suspects</h2>
        ${risk.suspicious_domains?.length
          ? `<table><tr><th>Domaine</th><th>Classe</th><th>Score</th></tr>${risk.suspicious_domains.map(d => `<tr><td>${esc(d.domain)}</td><td>${esc(d.class)}</td><td>${esc(d.score)}</td></tr>`).join('')}</table>`
          : '<div class="muted">Aucun</div>'}
      </div>
      <div class="card">
        <h2>Prédictions et modèles</h2>
        <div>Décharge batterie : ${n(risk.predictions?.battery_drain_per_hour, 1, ' %/h')} · Autonomie : ${n(risk.predictions?.battery_hours_left, 1, ' h')}</div>
        <div>Signal mobile dans 30 min : ${n(risk.predictions?.signal_dbm_30min, 0, ' dBm')}${risk.predictions?.signal_loss_risk ? ' (risque de perte)' : ''}</div>
        <div class="muted" style="margin-top:8px">
          Isolation Forest / One-Class SVM : ${risk.ml?.score !== undefined ? `actifs (${esc(risk.ml.training_windows)} min d'historique)` : esc(risk.ml?.status)}<br>
          Référence adaptative : ${risk.baseline?.score !== undefined ? 'active' : esc(risk.baseline?.status)}<br>
          Classifieur de domaines : ${esc(risk.domain_model)}
        </div>
      </div>
    </div>`;
}

async function renderDevice(id) {
  const q = encodeURIComponent(id);
  view(`
    <div class="toolbar">
      <div>
        <a href="#/devices" class="no-print">← Téléphones</a>
        <h1 id="device-title">${esc(id)}</h1>
        <div class="muted" id="device-sub"></div>
      </div>
      <div class="no-print" style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="export-collection">
          <option value="system_metrics">Métriques système</option>
          <option value="network_metrics">Métriques réseau et tests</option>
          <option value="flow_metrics">Flux réseau (DNS, apps)</option>
          <option value="gps_metrics">Géolocalisation</option>
          <option value="rrc_messages">Signalisation</option>
          <option value="ml_predictions">Analyses de risque</option>
        </select>
        <select id="export-period">
          <option value="3600000">Dernière heure</option>
          <option value="86400000">24 heures</option>
          <option value="604800000">7 jours</option>
        </select>
        <button class="secondary" id="export-csv">Export CSV</button>
        <button class="primary" id="export-pdf">Rapport PDF</button>
      </div>
    </div>
    <div id="error" class="error"></div>

    <div class="section" id="risk"></div>

    <div class="section kpis" id="kpis"></div>

    <div class="grid-2">
      <div class="card"><h2>CPU et RAM (%) – 1 h</h2><div class="chart-box"><canvas id="chart-cpu"></canvas></div></div>
      <div class="card"><h2>Températures (°C) – 1 h</h2><div class="chart-box"><canvas id="chart-temp"></canvas></div></div>
      <div class="card"><h2>Batterie (%) – 1 h</h2><div class="chart-box"><canvas id="chart-battery"></canvas></div></div>
      <div class="card"><h2>Débit réseau (Ko/s) – 1 h</h2><div class="chart-box"><canvas id="chart-net"></canvas></div></div>
    </div>

    <div class="grid-2">
      <div class="card"><h2>Score de risque – 24 h</h2><div class="chart-box"><canvas id="chart-risk"></canvas></div></div>
      <div class="card"><h2>Carte (500 derniers points)</h2><div id="map"></div></div>
    </div>

    <div class="grid-2">
      <div class="card"><h2>Signalisation cellulaire</h2><div id="radio"></div><div class="table-scroll" id="events"></div></div>
      <div class="card"><h2>Tests réseau actifs</h2><div class="table-scroll" id="tests"></div></div>
    </div>

    <div class="grid-2">
      <div class="card"><h2>Domaines les plus contactés – 1 h</h2><div class="table-scroll" id="top-domains"></div></div>
      <div class="card"><h2>Dernières requêtes DNS</h2><div class="table-scroll" id="dns"></div></div>
    </div>`);

  $('#export-pdf').addEventListener('click', () => window.print());
  $('#export-csv').addEventListener('click', async () => {
    try {
      const collection = $('#export-collection').value;
      const since = Date.now() - Number($('#export-period').value);
      const res = await authorizedFetch(`/api/export/${collection}?${qs({ device_id: id, since })}`);
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `${id}_${collection}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      $('#error').textContent = err.message;
    }
  });

  const load = async () => {
    try {
      const hourAgo = Date.now() - 3600 * 1000;
      const [devices, risk, sys, net, tests, dns, gps, events, measures, history] = await Promise.all([
        api('/api/devices'),
        api(`/api/analysis/latest?${qs({ device_id: id })}`).catch(() => null),
        api(`/api/data/system_metrics?${qs({ device_id: id, since: hourAgo, limit: 2000 })}`),
        api(`/api/data/network_metrics?${qs({ device_id: id, kind: 'passive', since: hourAgo, limit: 2000 })}`),
        api(`/api/data/network_metrics?${qs({ device_id: id, kind: 'dns,tcp,http,download,upload', limit: 60 })}`),
        api(`/api/data/flow_metrics?${qs({ device_id: id, kind: 'dns', since: hourAgo, limit: 2000 })}`),
        api(`/api/data/gps_metrics?${qs({ device_id: id, limit: 500 })}`),
        api(`/api/data/rrc_messages?${qs({ device_id: id, kind: 'android_event', limit: 40 })}`),
        api(`/api/data/rrc_messages?${qs({ device_id: id, kind: 'measurement', limit: 1 })}`),
        api(`/api/data/ml_predictions?${qs({ device_id: id, kind: 'risk', since: Date.now() - 86400 * 1000, limit: 2000 })}`),
      ]);

      const device = devices.find(d => d._id === id);
      if (device) {
        $('#device-title').textContent = device.name || id;
        $('#device-sub').textContent = `${device.info?.manufacturer ?? ''} ${device.info?.model ?? ''} · Android ${device.info?.android_version ?? '?'} · dernière synchronisation : ${dateTime(device.last_sync)}`;
      }

      $('#risk').innerHTML = riskHtml(risk);
      renderKpis(sys[0], net[0]);
      renderCharts(sys.slice().reverse(), net.slice().reverse(), history.slice().reverse());
      renderMap(gps.slice().reverse());
      renderSignaling(events, measures[0]);
      renderTests(tests);
      renderDns(dns);
      $('#error').textContent = '';
    } catch (err) {
      $('#error').textContent = err.message;
    }
  };
  await load();
  timer = setInterval(load, REFRESH_MS);
}

function renderKpis(s, net) {
  const kpi = (label, value) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  if (!s) {
    $('#kpis').innerHTML = '<div class="card">Aucune mesure sur la dernière heure.</div>';
    return;
  }
  const mobile = net?.mobile;
  $('#kpis').innerHTML = [
    kpi('CPU', n(Math.max(0, s.cpu_usage), 0, ' %')),
    kpi('RAM', n(s.ram_usage, 0, ' %')),
    kpi('Stockage', n(s.storage_usage, 0, ' %')),
    kpi('Batterie', `${n(s.battery_level, 0, ' %')}${s.battery_charging ? ' ⚡' : ''}`),
    kpi('Temp. CPU', n(s.cpu_temperature, 1, ' °C')),
    kpi('Temp. batterie', n(s.battery_temperature, 1, ' °C')),
    kpi('Connexion', esc(net?.transport ?? 'N/A')),
    kpi('Réseau mobile', esc(mobile ? `${mobile.networkType} · ${mobile.operator || ''}` : 'N/A')),
    kpi('Signal', n(mobile?.signalDbm, 0, ' dBm')),
    kpi('Wi-Fi', esc(net?.wifi ? `${net.wifi.ssid} (${net.wifi.rssi} dBm)` : 'non connecté')),
  ].join('');
}

function renderCharts(sys, net, history) {
  const sysLabels = sys.map(d => time(d.timestamp));
  lineChart('chart-cpu', sysLabels, [
    { label: 'CPU', data: sys.map(d => Math.max(0, d.cpu_usage ?? 0)), borderColor: '#dc3c3c' },
    { label: 'RAM', data: sys.map(d => d.ram_usage), borderColor: '#1e5aa0' },
  ], { min: 0, max: 100 });
  lineChart('chart-temp', sysLabels, [
    { label: 'CPU', data: sys.map(d => d.cpu_temperature), borderColor: '#e67e22' },
    { label: 'Batterie', data: sys.map(d => d.battery_temperature), borderColor: '#8e44ad' },
  ]);
  lineChart('chart-battery', sysLabels, [
    { label: 'Niveau', data: sys.map(d => d.battery_level), borderColor: '#27ae60' },
  ], { min: 0, max: 100 });
  lineChart('chart-net', net.map(d => time(d.timestamp)), [
    { label: 'Reçu', data: net.map(d => (d.rx_bytes_per_second ?? 0) / 1024), borderColor: '#1e5aa0' },
    { label: 'Envoyé', data: net.map(d => (d.tx_bytes_per_second ?? 0) / 1024), borderColor: '#16a085' },
  ], { min: 0 });
  lineChart('chart-risk', history.map(d => time(d.timestamp)), [
    { label: 'Score de risque', data: history.map(d => d.risk_score), borderColor: '#c0392b', stepped: true, tension: 0 },
  ], { min: 0, max: 100 });
}

function renderMap(points) {
  if (!map) {
    map = L.map('map').setView([46.6, 2.4], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
    map.firstFit = true;
  }
  mapLayer.clearLayers();
  if (!points.length) return;
  const coords = points.map(p => [p.latitude, p.longitude]);
  L.polyline(coords, { color: '#1e5aa0', weight: 4 }).addTo(mapLayer);
  points.forEach(p => {
    L.circleMarker([p.latitude, p.longitude], { radius: 4, color: '#dc3c3c' })
      .bindPopup(`<b>${time(p.timestamp)}</b><br>Réseau : ${esc(p.networkType)}<br>Cell ID : ${esc(p.cellId ?? 'N/A')}<br>PCI : ${esc(p.pci ?? 'N/A')}<br>Bande : ${esc(p.band)}`)
      .addTo(mapLayer);
  });
  L.marker(coords[coords.length - 1]).addTo(mapLayer);
  if (map.firstFit) {
    map.fitBounds(coords, { maxZoom: 16, padding: [20, 20] });
    map.firstFit = false;
  }
}

function renderSignaling(events, measure) {
  const reg = measure?.registration;
  const serving = measure?.serving ?? [];
  $('#radio').innerHTML = measure ? `
    <div style="margin-bottom:8px">
      ${serving.map(c => `<div><b>${esc(c.tech)}</b> · Cell ID ${esc(c.cell_id ?? 'N/A')} · PCI ${esc(c.pci ?? 'N/A')} · TAC ${esc(c.tac ?? 'N/A')} ·
        RSRP ${n(c.rsrp, 0, ' dBm')} · RSRQ ${n(c.rsrq, 0, ' dB')} · SINR ${n(c.sinr, 0, ' dB')}</div>`).join('') || '<div class="muted">Aucune cellule servante</div>'}
      ${reg ? `<div class="muted">${esc(reg.operator ?? '')} · ${esc(REG_LABELS[reg.registration] ?? reg.registration ?? 'N/A')} · 5G NSA : ${esc(NR_LABELS[reg.nr_state] ?? reg.nr_state ?? 'N/A')} · ${measure.neighbors?.length ?? 0} cellule(s) voisine(s)</div>` : ''}
    </div>` : '<div class="muted">Aucune mesure radio</div>';

  $('#events').innerHTML = events.length
    ? `<table><tr><th>Heure</th><th>Événement</th></tr>${events.map(e => `<tr><td>${time(e.timestamp)}</td><td>${esc(eventText(e))}</td></tr>`).join('')}</table>`
    : '<div class="muted">Aucun événement</div>';
}

function renderTests(tests) {
  $('#tests').innerHTML = tests.length
    ? `<table><tr><th>Heure</th><th>Test</th><th>Résultat</th></tr>${tests.map(t => {
        const [name, result] = testText(t);
        return `<tr><td>${time(t.timestamp)}</td><td>${esc(name)}</td><td>${esc(result)}</td></tr>`;
      }).join('')}</table>`
    : '<div class="muted">Aucun test lancé depuis l\'app</div>';
}

function renderDns(dns) {
  const stats = {};
  dns.forEach(d => {
    const s = (stats[d.domain] ??= { count: 0, fails: 0, time: 0, apps: new Set() });
    s.count += 1;
    s.fails += d.success ? 0 : 1;
    s.time += d.dns_time ?? 0;
    if (d.app) s.apps.add(d.app);
  });
  const top = Object.entries(stats).sort((a, b) => b[1].count - a[1].count).slice(0, 20);
  $('#top-domains').innerHTML = top.length
    ? `<table><tr><th>Domaine</th><th>Requêtes</th><th>Temps moyen</th><th>Échecs</th><th>Application</th></tr>${top.map(([domain, s]) =>
        `<tr><td>${esc(domain)}</td><td>${s.count}</td><td>${n(s.time / s.count, 0, ' ms')}</td><td>${s.fails}</td><td>${esc([...s.apps].join(', '))}</td></tr>`).join('')}</table>`
    : '<div class="muted">Aucune requête DNS (VPN DNS désactivé sur le téléphone ?)</div>';

  $('#dns').innerHTML = dns.length
    ? `<table><tr><th>Heure</th><th>Domaine</th><th>Type</th><th>Temps</th><th>Application</th></tr>${dns.slice(0, 50).map(d =>
        `<tr><td>${time(d.timestamp)}</td><td>${esc(d.domain)}</td><td>${esc(d.query_type)}</td><td>${n(d.dns_time, 0, ' ms')}</td><td>${esc(d.app ?? '')}</td></tr>`).join('')}</table>`
    : '<div class="muted">Aucune requête DNS</div>';
}

/* ---------- Installation de l'app (QR code + publication d'une version) ---------- */

async function renderInstall() {
  const installUrl = `${location.origin}/install`;
  view(`
    <div class="toolbar"><h1>Installer l'app sur un téléphone</h1></div>
    <div id="error" class="error"></div>
    <div class="grid-2">
      <div class="card">
        <h2>1. Installer</h2>
        <p>Scanne ce QR code avec l'appareil photo du téléphone :</p>
        <div id="qrcode" style="margin:12px 0"></div>
        <div class="muted">ou ouvre <b>${esc(installUrl)}</b></div>
        <div id="release-info" style="margin-top:12px">Chargement...</div>
      </div>
      <div class="card">
        <h2>2. Associer</h2>
        <p>Génère un code, puis saisis-le dans l'app : <b>Paramètres → Associer ce téléphone</b>.</p>
        <div class="pairing no-print">
          <input id="pair-name" placeholder="Nom du téléphone (optionnel)" maxlength="60">
          <button class="primary" id="add-device">Générer un code</button>
        </div>
        <div id="pairing-result"></div>
      </div>
    </div>
    <div class="card">
      <h2>Publier une nouvelle version</h2>
      <form id="upload-form" class="pairing">
        <input type="file" name="apk" accept=".apk" required>
        <input name="version" placeholder="Version (ex : 1.0.1)" maxlength="20" required>
        <button class="primary" type="submit">Publier</button>
        <span id="upload-status" class="muted"></span>
      </form>
      <p class="muted">Le fichier à envoyer : android/app/build/outputs/apk/release/app-release.apk</p>
    </div>`);

  new QRCode($('#qrcode'), { text: installUrl, width: 200, height: 200 });
  $('#add-device').addEventListener('click', createPairingCode);

  const loadRelease = async () => {
    const res = await fetch('/api/app/latest');
    const info = res.ok ? await res.json() : null;
    $('#release-info').innerHTML = info
      ? `Version publiée : <b>${esc(info.version)}</b> · ${(info.size / 1024 / 1024).toFixed(1)} Mo · ${dateTime(info.uploaded_at)}
         <div class="muted" style="word-break:break-all">SHA-256 : ${esc(info.sha256)}</div>`
      : '<span class="error">Aucune version publiée : envoie l\'APK ci-dessous.</span>';
  };
  await loadRelease();

  $('#upload-form').addEventListener('submit', async e => {
    e.preventDefault();
    const button = e.target.querySelector('button');
    button.disabled = true;
    $('#upload-status').textContent = 'Envoi en cours...';
    try {
      const res = await authorizedFetch('/api/app/upload', { method: 'POST', body: new FormData(e.target) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Erreur ${res.status}`);
      $('#upload-status').textContent = `Version ${body.version} publiée`;
      e.target.reset();
      await loadRelease();
    } catch (err) {
      $('#upload-status').textContent = '';
      $('#error').textContent = err.message;
    }
    button.disabled = false;
  });
}

/* ---------- Alertes (tous les téléphones) ---------- */

async function renderAlerts() {
  view(`
    <div class="toolbar"><h1>Alertes</h1><span class="muted">Analyses hors « Normal » des dernières 24 h, tous téléphones</span></div>
    <div id="error" class="error"></div>
    <div class="card"><div id="alerts">Chargement...</div></div>`);

  const load = async () => {
    try {
      const [devices, predictions] = await Promise.all([
        api('/api/devices'),
        api(`/api/data/ml_predictions?${qs({ kind: 'risk', since: Date.now() - 86400 * 1000, limit: 2000 })}`),
      ]);
      const names = Object.fromEntries(devices.map(d => [d._id, d.name || d._id]));
      const alerts = predictions.filter(p => p.risk_class && p.risk_class !== 'Normal');
      $('#alerts').innerHTML = alerts.length
        ? `<table><tr><th>Date</th><th>Téléphone</th><th>Score</th><th>Classe</th><th>Alertes</th></tr>${alerts.map(p => `
            <tr>
              <td>${dateTime(p.timestamp)}</td>
              <td><a href="#/device/${encodeURIComponent(p.device_id)}">${esc(names[p.device_id] ?? p.device_id)}</a></td>
              <td>${Math.round(p.risk_score)}</td>
              <td><span class="badge" style="background:${classColor(p.risk_class)}">${esc(p.risk_class)}</span></td>
              <td>${(p.alerts ?? []).map(esc).join('<br>')}</td>
            </tr>`).join('')}</table>`
        : '<div style="color:#27ae60">Aucune alerte sur les dernières 24 h</div>';
      $('#error').textContent = '';
    } catch (err) {
      $('#error').textContent = err.message;
    }
  };
  await load();
  timer = setInterval(load, REFRESH_MS);
}

route();