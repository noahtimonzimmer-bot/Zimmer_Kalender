'use strict';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];
const DEFAULT_ACCENT = '#4a5d8f';
const SESSION_KEY = 'gespraechskalender.session';
// Data from the earlier version that stored everything only on the device.
const LEGACY_ENTRIES_KEY = 'gespraechskalender.v1';
const LEGACY_SETTINGS_KEY = 'gespraechskalender.settings';

const AUTH_SALT = 'zimmer-kalender/auth/v1';
const PBKDF2_ROUNDS = 200000;

const DEFAULT_SETTINGS = {
  kinds: [
    { id: 'vor', name: 'Vorgespräch', color: '#e0a030' },
    { id: 'see', name: 'Seelsorgegespräch', color: '#3f8f7a' },
  ],
  modes: [
    { id: 'treffen', name: 'Persönlich', icon: '🤝' },
    { id: 'telefon', name: 'Telefon', icon: '📞' },
  ],
  accent: DEFAULT_ACCENT,
};

const $ = (id) => document.getElementById(id);

let state = { entries: [], settings: structuredClone(DEFAULT_SETTINGS) };
let session = null; // { token, key: CryptoKey, keyRaw, encSalt }
let version = 0;
let pendingOps = [];
let saving = false;
let saveTimer = null;
let migrateLegacy = false;

let view = new Date();
view.setDate(1);
let selectedDate = null;
let editingId = null;

// ---- Helpers ----

function normalizeSettings(data) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!data || typeof data !== 'object') return out;
  if (Array.isArray(data.kinds) && data.kinds.length) {
    out.kinds = data.kinds.filter((k) => k && k.id).map((k) => ({
      id: String(k.id), name: String(k.name || ''), color: /^#[0-9a-f]{6}$/i.test(k.color) ? k.color : '#888888',
    }));
  }
  if (Array.isArray(data.modes) && data.modes.length) {
    out.modes = data.modes.filter((m) => m && m.id).map((m) => ({
      id: String(m.id), name: String(m.name || ''), icon: String(m.icon || ''),
    }));
  }
  if (/^#[0-9a-f]{6}$/i.test(data.accent)) out.accent = data.accent;
  return out;
}

function normalizeState(data) {
  return {
    entries: Array.isArray(data && data.entries) ? data.entries.filter(validEntry) : [],
    settings: normalizeSettings(data && data.settings),
  };
}

function validEntry(e) {
  return e && e.id && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.kind && e.mode;
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function kindOf(id) {
  return state.settings.kinds.find((k) => k.id === id) || { id, name: 'Unbekannt', color: '#888888' };
}

function modeOf(id) {
  return state.settings.modes.find((m) => m.id === id) || { id, name: 'Unbekannt', icon: '' };
}

// Pick black or white text depending on how light the background is.
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) > 170 ? '#1f2330' : '#ffffff';
}

function colorize(node, kind) {
  node.style.background = kind.color;
  node.style.color = textOn(kind.color);
}

function prefix(icon) {
  return icon ? icon + ' ' : '';
}

function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatDate(isoStr) {
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function byDateTime(a, b) {
  return (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---- Encryption ----
// The password never leaves the device. From it we derive
// - an auth key that the server checks (it only stores a hash of it) and
// - an encryption key; the server only ever receives encrypted data.

function toB64(bytes) {
  const arr = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function pbkdf2Bits(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ROUNDS }, base, 256);
}

async function deriveAuthKey(password) {
  return toB64(await pbkdf2Bits(password, new TextEncoder().encode(AUTH_SALT)));
}

async function deriveEncKey(password, encSalt) {
  const raw = await pbkdf2Bits(password, fromB64(encSalt));
  return { key: await importEncKey(raw), keyRaw: toB64(raw) };
}

function importEncKey(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptState(data, key, encSalt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(data));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { encSalt, iv: toB64(iv), ciphertext: toB64(cipher) };
}

async function decryptVault(vault, key) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(vault.iv) }, key, fromB64(vault.ciphertext));
  return normalizeState(JSON.parse(new TextDecoder().decode(plain)));
}

// ---- Server ----

class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(method, path, body, token = session && session.token) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') {
    sessionExpired();
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function storeSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      token: session.token, keyRaw: session.keyRaw, encSalt: session.encSalt,
    }));
  } catch {}
}

function setStatus(kind) {
  const texts = {
    saved: '☁︎ Gespeichert',
    saving: '☁︎ Speichert …',
    offline: '⚠︎ Nicht gespeichert – keine Verbindung',
    error: '⚠︎ Speichern fehlgeschlagen',
  };
  const node = $('syncStatus');
  node.textContent = texts[kind] || '';
  node.dataset.kind = kind;
}

// Applies a change locally right away and saves it in the background.
// The change is a function so it can be re-applied if another device saved in between.
function mutate(op) {
  op(state);
  pendingOps.push(op);
  render();
  scheduleSave();
}

function scheduleSave(delay = 400) {
  clearTimeout(saveTimer);
  setStatus('saving');
  saveTimer = setTimeout(flush, delay);
}

async function fetchVault() {
  const vault = await api('GET', 'data');
  const remote = vault.ciphertext ? await decryptVault(vault, session.key) : normalizeState(null);
  return { vault, remote };
}

async function flush() {
  if (saving || !session || !pendingOps.length) return;
  saving = true;
  try {
    for (let attempt = 0; attempt < 5 && pendingOps.length; attempt++) {
      const sent = pendingOps.length;
      const payload = await encryptState(state, session.key, session.encSalt);
      try {
        const res = await api('PUT', 'data', { baseVersion: version, ...payload });
        version = res.version;
        pendingOps = pendingOps.slice(sent);
      } catch (err) {
        if (err.status !== 409) throw err;
        // Another device saved first: take its data and re-apply our changes on top.
        const { vault, remote } = await fetchVault();
        version = vault.version;
        state = remote;
        for (const op of pendingOps) op(state);
        applyAccent();
        render();
      }
    }
    if (pendingOps.length) throw new Error('too many conflicts');
    setStatus('saved');
    if (migrateLegacy) {
      migrateLegacy = false;
      try {
        localStorage.removeItem(LEGACY_ENTRIES_KEY);
        localStorage.removeItem(LEGACY_SETTINGS_KEY);
      } catch {}
    }
  } catch (err) {
    if (session) setStatus(err instanceof ApiError ? 'error' : 'offline');
  } finally {
    saving = false;
  }
  if (pendingOps.length && session && $('syncStatus').dataset.kind === 'saving') scheduleSave();
}

async function refresh() {
  if (!session || saving || pendingOps.length) return;
  try {
    const vault = await api('GET', 'data');
    if (vault.version === version) return;
    state = vault.ciphertext ? await decryptVault(vault, session.key) : normalizeState(null);
    version = vault.version;
    applyAccent();
    render();
    setStatus('saved');
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (pendingOps.length) flush();
    else refresh();
  }
});
window.addEventListener('online', () => { if (pendingOps.length) flush(); });
window.addEventListener('beforeunload', (ev) => {
  if (pendingOps.length) ev.preventDefault();
});

// ---- Rendering ----

function render() {
  const { entries, settings } = state;
  const year = view.getFullYear();
  const month = view.getMonth();
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  $('monthTitle').textContent = `${MONTHS[month]} ${year}`;

  const byDate = {};
  for (const e of entries) (byDate[e.date] ||= []).push(e);
  for (const list of Object.values(byDate)) list.sort(byDateTime);

  // Calendar grid, weeks starting Monday
  const grid = $('grid');
  grid.replaceChildren();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  const todayIso = iso(new Date());
  const weeks = Math.ceil((offset + new Date(year, month + 1, 0).getDate()) / 7);

  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dIso = iso(d);
    const cell = el('button', 'day');
    cell.type = 'button';
    if (d.getMonth() !== month) cell.classList.add('other');
    if (dIso === todayIso) cell.classList.add('today');
    if (dIso === selectedDate) cell.classList.add('selected');
    cell.append(el('span', 'num', d.getDate()));
    const chips = el('div', 'chips');
    for (const e of byDate[dIso] || []) {
      const kind = kindOf(e.kind);
      const mode = modeOf(e.mode);
      const label = `${prefix(mode.icon)}${e.time ? e.time + ' ' : ''}${kind.name}${e.person ? ' · ' + e.person : ''}`;
      const chip = el('span', 'chip', label);
      colorize(chip, kind);
      chip.title = `${kind.name} – ${mode.name}`;
      chips.append(chip);
    }
    cell.append(chips);
    cell.addEventListener('click', () => {
      if (selectedDate === dIso || !(byDate[dIso] || []).length) {
        openDialog(null, dIso);
      }
      selectedDate = dIso;
      if (d.getMonth() !== month) view = new Date(d.getFullYear(), d.getMonth(), 1);
      render();
    });
    grid.append(cell);
  }

  // Entry list: selected day, otherwise whole month
  const listEntries = selectedDate && selectedDate.startsWith(monthPrefix)
    ? (byDate[selectedDate] || [])
    : entries.filter((e) => e.date.startsWith(monthPrefix)).sort(byDateTime);
  $('listTitle').textContent = selectedDate && selectedDate.startsWith(monthPrefix)
    ? `Einträge am ${formatDate(selectedDate)}`
    : `Einträge im ${MONTHS[month]}`;

  const list = $('list');
  list.replaceChildren();
  if (!listEntries.length) {
    list.append(el('p', 'empty', 'Keine Einträge. Tippe auf einen Tag, um einen Eintrag hinzuzufügen.'));
  }
  for (const e of listEntries) {
    const row = el('div', 'entry');
    const kind = kindOf(e.kind);
    const mode = modeOf(e.mode);
    const bar = el('span', 'bar');
    bar.style.background = kind.color;
    row.append(bar);
    const main = el('div', 'main');
    main.append(el('div', 'title', `${prefix(mode.icon)}${kind.name}${e.person ? ' – ' + e.person : ''}`));
    main.append(el('div', 'meta', `${formatDate(e.date)}${e.time ? ', ' + e.time + ' Uhr' : ''} · ${mode.name}`));
    if (e.note) main.append(el('div', 'note', e.note));
    row.append(main);
    row.addEventListener('click', () => openDialog(e));
    list.append(row);
  }

  renderLegend(settings);
  renderStats(monthPrefix, String(year));
}

function renderLegend(settings) {
  const legend = $('legend');
  legend.replaceChildren();
  for (const k of settings.kinds) {
    const item = el('span');
    const dot = el('i', 'dot');
    dot.style.background = k.color;
    item.append(dot, k.name);
    legend.append(item);
  }
  for (const m of settings.modes) legend.append(el('span', null, `${prefix(m.icon)}${m.name}`));
}

function renderStats(monthPrefix, yearPrefix) {
  const { entries, settings } = state;
  const count = (prefix, kind, mode) => entries.filter((e) =>
    e.date.startsWith(prefix) && (!kind || e.kind === kind) && (!mode || e.mode === mode)).length;

  $('statsTitle').textContent = `Übersicht ${MONTHS[view.getMonth()]} / Jahr ${yearPrefix}`;
  const table = $('stats');
  table.replaceChildren();
  const head = el('thead');
  const hr = el('tr');
  hr.append(el('th'));
  for (const m of settings.modes) {
    const th = el('th', null, m.icon || m.name.slice(0, 3));
    th.title = m.name;
    hr.append(th);
  }
  hr.append(el('th', null, 'Monat'), el('th', null, 'Jahr'));
  head.append(hr);
  const body = el('tbody');
  const rows = [...settings.kinds.map((k) => [k.id, k.name]), [null, 'Gesamt']];
  for (const [kind, label] of rows) {
    const tr = el('tr', kind ? null : 'total');
    tr.append(el('td', null, label));
    for (const m of settings.modes) tr.append(el('td', null, count(monthPrefix, kind, m.id)));
    tr.append(el('td', null, count(monthPrefix, kind)));
    tr.append(el('td', null, count(yearPrefix, kind)));
    body.append(tr);
  }
  table.append(head, body);
}

// ---- Entry dialog ----

function renderOptions(container, name, items, labelOf) {
  container.replaceChildren();
  items.forEach((item, i) => {
    const label = el('label');
    const input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = item.id;
    if (i === 0) input.required = true;
    label.append(input, el('span', null, labelOf(item)));
    container.append(label);
  });
}

function openDialog(entry, date) {
  const form = $('form');
  renderOptions($('kindOptions'), 'kind', state.settings.kinds, (k) => k.name);
  renderOptions($('modeOptions'), 'mode', state.settings.modes, (m) => `${prefix(m.icon)}${m.name}`);
  form.reset();
  editingId = entry ? entry.id : null;
  $('dlgTitle').textContent = entry ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
  $('deleteBtn').hidden = !entry;
  const e = entry || { date: date || selectedDate || iso(new Date()) };
  form.date.value = e.date;
  form.time.value = e.time || '';
  form.person.value = e.person || '';
  form.note.value = e.note || '';
  for (const input of form.querySelectorAll('input[name=kind], input[name=mode]')) {
    input.checked = input.value === e[input.name];
  }
  $('dlg').showModal();
}

$('form').addEventListener('submit', () => {
  const f = $('form');
  const data = {
    id: editingId || newId(),
    date: f.date.value,
    time: f.time.value,
    kind: f.kind.value,
    mode: f.mode.value,
    person: f.person.value.trim(),
    note: f.note.value.trim(),
  };
  selectedDate = data.date;
  const [y, m] = data.date.split('-').map(Number);
  view = new Date(y, m - 1, 1);
  mutate((s) => {
    s.entries = s.entries.filter((e) => e.id !== data.id);
    s.entries.push(data);
  });
});

$('deleteBtn').addEventListener('click', () => {
  if (!editingId || !confirm('Diesen Eintrag wirklich löschen?')) return;
  const id = editingId;
  $('dlg').close();
  mutate((s) => { s.entries = s.entries.filter((e) => e.id !== id); });
});

$('cancelBtn').addEventListener('click', () => $('dlg').close());

$('prev').addEventListener('click', () => {
  view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
  selectedDate = null;
  render();
});
$('next').addEventListener('click', () => {
  view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
  selectedDate = null;
  render();
});
$('todayBtn').addEventListener('click', () => {
  const t = new Date();
  view = new Date(t.getFullYear(), t.getMonth(), 1);
  selectedDate = iso(t);
  render();
});
$('addBtn').addEventListener('click', () => openDialog(null));

// ---- Backup ----

$('exportBtn').addEventListener('click', () => {
  const backup = { app: 'gespraechskalender', version: 3, entries: state.entries, settings: state.settings };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gespraechskalender-${iso(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// Adds entries (and optionally types/forms) without removing anything that exists.
function mergeOp(list, importedSettings) {
  return (s) => {
    if (importedSettings) {
      const imported = normalizeSettings(importedSettings);
      for (const k of imported.kinds) if (!s.settings.kinds.some((x) => x.id === k.id)) s.settings.kinds.push(k);
      for (const m of imported.modes) if (!s.settings.modes.some((x) => x.id === m.id)) s.settings.modes.push(m);
    }
    const map = new Map(s.entries.map((e) => [e.id, e]));
    for (const e of list) map.set(e.id, e);
    s.entries = [...map.values()];
  };
}

$('importFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    // Old backups are a plain array of entries, newer ones also contain the settings.
    const list = Array.isArray(data) ? data : data && data.entries;
    if (!Array.isArray(list)) throw new Error('Ungültiges Format');
    const valid = list.filter(validEntry);
    if (!confirm(`${valid.length} Einträge gefunden. Mit vorhandenen Einträgen zusammenführen?`)) return;
    mutate(mergeOp(valid, Array.isArray(data) ? null : data.settings));
    renderSettings();
  } catch (err) {
    alert('Die Datei konnte nicht gelesen werden: ' + err.message);
  }
});

// ---- Login ----

function readLegacy() {
  try {
    const entries = JSON.parse(localStorage.getItem(LEGACY_ENTRIES_KEY));
    const settings = JSON.parse(localStorage.getItem(LEGACY_SETTINGS_KEY));
    return {
      entries: Array.isArray(entries) ? entries.filter(validEntry) : [],
      settings,
      exists: entries != null || settings != null,
    };
  } catch {
    return { entries: [], settings: null, exists: false };
  }
}

function showLoginError(text) {
  const node = $('loginError');
  node.textContent = text;
  node.hidden = false;
}

async function startSession(token, key, keyRaw, encSalt, vault) {
  session = { token, key, keyRaw, encSalt };
  storeSession();
  version = vault.version || 0;
  state = vault.ciphertext ? await decryptVault(vault, key) : normalizeState(null);
  document.body.classList.remove('locked');
  applyAccent();
  render();
  setStatus('saved');
}

$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('password');
  const button = $('loginForm').querySelector('button');
  $('loginError').hidden = true;
  button.disabled = true;
  button.textContent = 'Anmelden …';
  try {
    const password = input.value;
    const authKey = await deriveAuthKey(password);
    let res;
    try {
      res = await api('POST', 'login', { authKey }, null);
    } catch (err) {
      if (err.status === 401) return showLoginError('Falsches Passwort.');
      if (err.status === 429) {
        return showLoginError(`Zu viele Versuche. Bitte in ${err.body.minutes} Minuten nochmal probieren.`);
      }
      if (err instanceof ApiError) return showLoginError('Der Server antwortet nicht richtig. Bitte später nochmal.');
      return showLoginError('Keine Verbindung zum Internet.');
    }
    const vault = res.vault;
    const encSalt = vault.encSalt || toB64(crypto.getRandomValues(new Uint8Array(16)));
    const { key, keyRaw } = await deriveEncKey(password, encSalt);
    try {
      await startSession(res.token, key, keyRaw, encSalt, vault);
    } catch {
      return showLoginError('Die gespeicherten Daten konnten nicht entschlüsselt werden.');
    }
    input.value = '';

    // Bring over what was stored only on this device by the earlier version.
    const legacy = readLegacy();
    if (!vault.ciphertext) {
      const settings = legacy.settings ? normalizeSettings(legacy.settings) : null;
      const entries = legacy.entries;
      migrateLegacy = legacy.exists;
      mutate((s) => {
        if (settings && !s.entries.length) s.settings = structuredClone(settings);
        mergeOp(entries)(s);
      });
    } else if (legacy.entries.length) {
      if (confirm(`Auf diesem Gerät sind noch ${legacy.entries.length} Einträge nur lokal gespeichert. Jetzt hochladen, damit sie überall sichtbar sind?`)) {
        migrateLegacy = true;
        mutate(mergeOp(legacy.entries, legacy.settings));
      }
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Anmelden';
  }
});

function lock() {
  session = null;
  pendingOps = [];
  clearTimeout(saveTimer);
  state = { entries: [], settings: structuredClone(DEFAULT_SETTINGS) };
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  document.body.classList.add('locked');
  applyAccent();
  $('password').focus();
}

function sessionExpired() {
  if (!session) return;
  lock();
  showLoginError('Bitte erneut anmelden.');
}

$('logoutBtn').addEventListener('click', async () => {
  if (pendingOps.length && !confirm('Es werden gerade noch Änderungen gespeichert. Trotzdem abmelden?')) return;
  const token = session && session.token;
  lock();
  if (token) api('POST', 'logout', {}, token).catch(() => {});
});

// ---- Settings ----

function applyAccent() {
  const accent = state.settings.accent;
  const root = document.documentElement.style;
  if (accent.toLowerCase() === DEFAULT_ACCENT) {
    root.removeProperty('--accent');
  } else {
    root.setProperty('--accent', accent);
  }
  document.querySelector('meta[name=theme-color]').content = accent;
}

function updateItem(listName, id, changes) {
  mutate((s) => {
    const item = s.settings[listName].find((x) => x.id === id);
    if (item) Object.assign(item, changes);
  });
}

function deleteButton(onClick) {
  const btn = el('button', 'btn danger icon', '🗑');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Löschen');
  btn.addEventListener('click', onClick);
  return btn;
}

function textInput(value, placeholder, onInput, cls) {
  const input = el('input', cls);
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value.trim()));
  return input;
}

function removeItem(listName, item, field) {
  const used = state.entries.filter((e) => e[field] === item.id).length;
  if (used) {
    alert(`„${item.name}“ wird in ${used} ${used === 1 ? 'Eintrag' : 'Einträgen'} verwendet und kann nicht gelöscht werden. Du kannst sie aber umbenennen.`);
    return;
  }
  if (state.settings[listName].length === 1) {
    alert('Es muss mindestens ein Eintrag übrig bleiben.');
    return;
  }
  if (!confirm(`„${item.name}“ löschen?`)) return;
  mutate((s) => { s.settings[listName] = s.settings[listName].filter((x) => x.id !== item.id); });
  renderSettings();
}

function renderSettings() {
  const kindList = $('kindList');
  kindList.replaceChildren();
  for (const k of state.settings.kinds) {
    const row = el('div', 'edit-row');
    const color = el('input');
    color.type = 'color';
    color.value = k.color;
    color.setAttribute('aria-label', 'Farbe');
    color.addEventListener('input', () => updateItem('kinds', k.id, { color: color.value }));
    row.append(
      color,
      textInput(k.name, 'Name', (v) => updateItem('kinds', k.id, { name: v }), 'grow'),
      deleteButton(() => removeItem('kinds', k, 'kind')),
    );
    kindList.append(row);
  }

  const modeList = $('modeList');
  modeList.replaceChildren();
  for (const m of state.settings.modes) {
    const row = el('div', 'edit-row');
    row.append(
      textInput(m.icon, '🙂', (v) => updateItem('modes', m.id, { icon: v }), 'icon-input'),
      textInput(m.name, 'Name', (v) => updateItem('modes', m.id, { name: v }), 'grow'),
      deleteButton(() => removeItem('modes', m, 'mode')),
    );
    modeList.append(row);
  }

  $('accentColor').value = state.settings.accent;
}

const NEW_COLORS = ['#5b7fd6', '#c0587e', '#8a6ad1', '#d9774a', '#4aa3b8', '#7a9a3a'];

$('addKind').addEventListener('click', () => {
  const kind = { id: newId(), name: 'Neue Terminart', color: NEW_COLORS[state.settings.kinds.length % NEW_COLORS.length] };
  mutate((s) => { s.settings.kinds.push({ ...kind }); });
  renderSettings();
  const inputs = $('kindList').querySelectorAll('input[type=text]');
  inputs[inputs.length - 1].select();
});

$('addMode').addEventListener('click', () => {
  const mode = { id: newId(), name: 'Neue Form', icon: '💬' };
  mutate((s) => { s.settings.modes.push({ ...mode }); });
  renderSettings();
  const inputs = $('modeList').querySelectorAll('input.grow');
  inputs[inputs.length - 1].select();
});

function setAccent(accent) {
  mutate((s) => { s.settings.accent = accent; });
  applyAccent();
}

$('accentColor').addEventListener('input', (ev) => setAccent(ev.target.value));
$('accentReset').addEventListener('click', () => {
  setAccent(DEFAULT_ACCENT);
  renderSettings();
});

function showPwMsg(text, ok) {
  const msg = $('pwMsg');
  msg.textContent = text;
  msg.className = ok ? 'pw-msg ok' : 'pw-msg';
  msg.hidden = false;
}

$('pwForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const oldPw = $('pwOld').value;
  const newPw = $('pwNew').value;
  if (newPw !== $('pwNew2').value) {
    showPwMsg('Die neuen Passwörter stimmen nicht überein.');
    return;
  }
  const button = $('pwForm').querySelector('button');
  button.disabled = true;
  showPwMsg('Wird gespeichert …', true);
  try {
    clearTimeout(saveTimer);
    await flush();
    if (pendingOps.length) {
      showPwMsg('Es gibt noch ungespeicherte Änderungen. Bitte prüfe die Verbindung.');
      return;
    }
    const encSalt = toB64(crypto.getRandomValues(new Uint8Array(16)));
    const [oldAuthKey, newAuthKey, enc] = await Promise.all([
      deriveAuthKey(oldPw), deriveAuthKey(newPw), deriveEncKey(newPw, encSalt),
    ]);
    const payload = await encryptState(state, enc.key, encSalt);
    const res = await api('POST', 'password', { oldAuthKey, newAuthKey, baseVersion: version, ...payload });
    version = res.version;
    session = { ...session, key: enc.key, keyRaw: enc.keyRaw, encSalt };
    storeSession();
    $('pwForm').reset();
    showPwMsg('Passwort geändert. Es gilt jetzt auf allen Geräten, die anderen Geräte wurden abgemeldet.', true);
  } catch (err) {
    if (err.status === 403) showPwMsg('Das aktuelle Passwort stimmt nicht.');
    else if (err.status === 409) {
      showPwMsg('Ein anderes Gerät hat gerade gespeichert. Bitte nochmal versuchen.');
      refresh();
    } else showPwMsg('Das hat nicht geklappt. Bitte prüfe die Verbindung.');
  } finally {
    button.disabled = false;
  }
});

function closeSettings() {
  // Empty names would make entries unreadable, so fall back to a placeholder.
  const unnamed = (x) => !x.name;
  if (state.settings.kinds.some(unnamed) || state.settings.modes.some(unnamed)) {
    mutate((s) => {
      s.settings.kinds.forEach((k) => { if (!k.name) k.name = 'Ohne Namen'; });
      s.settings.modes.forEach((m) => { if (!m.name) m.name = 'Ohne Namen'; });
    });
  }
  $('settingsDlg').close();
}

$('settingsBtn').addEventListener('click', () => {
  renderSettings();
  $('pwForm').reset();
  $('pwMsg').hidden = true;
  $('settingsDlg').showModal();
});
$('settingsClose').addEventListener('click', closeSettings);
$('settingsDlg').addEventListener('cancel', (ev) => { ev.preventDefault(); closeSettings(); });

// ---- Start ----

(async function resume() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch {}
  if (!saved || !saved.token || !saved.keyRaw) return;
  try {
    const key = await importEncKey(fromB64(saved.keyRaw));
    session = { token: saved.token, key, keyRaw: saved.keyRaw, encSalt: saved.encSalt };
    const vault = await api('GET', 'data');
    await startSession(saved.token, key, saved.keyRaw, vault.encSalt || saved.encSalt, vault);
  } catch {
    if (session) lock();
  }
})();
