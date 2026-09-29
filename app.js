'use strict';

const STORAGE_KEY = 'gespraechskalender.v1';
const SETTINGS_KEY = 'gespraechskalender.settings';
const DEFAULT_ACCENT = '#4a5d8f';
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];

const $ = (id) => document.getElementById(id);

// Only the SHA-256 hash of the password is stored, not the password itself.
const PASSWORD_SALT = 'zimmer-kalender:';
const DEFAULT_PASSWORD_HASH = 'df67e62339c6338ee68eb6c2931a4ba47452afc54e2060b0aa1266547a514cca';
const SESSION_KEY = 'gespraechskalender.session';

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
  passwordHash: DEFAULT_PASSWORD_HASH,
};

let settings = loadSettings();
let entries = load();
let view = new Date();
view.setDate(1);
let selectedDate = null;
let editingId = null;

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

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
  if (/^[0-9a-f]{64}$/.test(data.passwordHash)) out.passwordHash = data.passwordHash;
  return out;
}

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function kindOf(id) {
  return settings.kinds.find((k) => k.id === id) || { id, name: 'Unbekannt', color: '#888888' };
}

function modeOf(id) {
  return settings.modes.find((m) => m.id === id) || { id, name: 'Unbekannt', icon: '' };
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

function render() {
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

  renderLegend();
  renderStats(monthPrefix, String(year));
}

function renderLegend() {
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
  renderOptions($('kindOptions'), 'kind', settings.kinds, (k) => k.name);
  renderOptions($('modeOptions'), 'mode', settings.modes, (m) => `${prefix(m.icon)}${m.name}`);
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
  entries = entries.filter((e) => e.id !== data.id);
  entries.push(data);
  save();
  selectedDate = data.date;
  const [y, m] = data.date.split('-').map(Number);
  view = new Date(y, m - 1, 1);
  render();
});

$('deleteBtn').addEventListener('click', () => {
  if (!editingId || !confirm('Diesen Eintrag wirklich löschen?')) return;
  entries = entries.filter((e) => e.id !== editingId);
  save();
  $('dlg').close();
  render();
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

$('exportBtn').addEventListener('click', () => {
  const backup = { app: 'gespraechskalender', version: 2, entries, settings };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gespraechskalender-${iso(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('importFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    // Old backups are a plain array of entries, newer ones also contain the settings.
    const list = Array.isArray(data) ? data : data && data.entries;
    if (!Array.isArray(list)) throw new Error('Ungültiges Format');
    const valid = list.filter((e) => e && e.id && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.kind && e.mode);
    const withSettings = !Array.isArray(data) && data.settings;
    const question = `${valid.length} Einträge gefunden. Mit vorhandenen Einträgen zusammenführen?`
      + (withSettings ? '\n\nDie Einstellungen (Terminarten, Formen, Farben, Passwort) werden aus der Sicherung übernommen.' : '');
    if (!confirm(question)) return;
    if (withSettings) {
      const imported = normalizeSettings(data.settings);
      // Keep types that are only known on this device so no entry loses its type.
      for (const k of settings.kinds) if (!imported.kinds.some((x) => x.id === k.id)) imported.kinds.push(k);
      for (const m of settings.modes) if (!imported.modes.some((x) => x.id === m.id)) imported.modes.push(m);
      settings = imported;
      saveSettings();
      try { sessionStorage.setItem(SESSION_KEY, settings.passwordHash); } catch {}
      applyAccent();
      renderSettings();
    }
    const map = new Map(entries.map((e) => [e.id, e]));
    for (const e of valid) map.set(e.id, e);
    entries = [...map.values()];
    save();
    render();
  } catch (err) {
    alert('Die Datei konnte nicht gelesen werden: ' + err.message);
  }
});

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unlock() {
  document.body.classList.remove('locked');
  render();
}

$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('password');
  if (await sha256(PASSWORD_SALT + input.value) === settings.passwordHash) {
    try { sessionStorage.setItem(SESSION_KEY, settings.passwordHash); } catch {}
    input.value = '';
    $('loginError').hidden = true;
    unlock();
  } else {
    $('loginError').hidden = false;
    input.select();
  }
});

$('logoutBtn').addEventListener('click', () => {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  document.body.classList.add('locked');
  $('password').focus();
});

// ---- Settings ----

function applyAccent() {
  const root = document.documentElement.style;
  if (settings.accent.toLowerCase() === DEFAULT_ACCENT) {
    root.removeProperty('--accent');
  } else {
    root.setProperty('--accent', settings.accent);
  }
  document.querySelector('meta[name=theme-color]').content = settings.accent;
}

function settingsChanged() {
  saveSettings();
  render();
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
  input.addEventListener('input', () => onInput(input.value));
  input.addEventListener('change', () => { if (!input.value.trim()) input.focus(); });
  return input;
}

function removeItem(listName, item, field) {
  const used = entries.filter((e) => e[field] === item.id).length;
  if (used) {
    alert(`„${item.name}“ wird in ${used} ${used === 1 ? 'Eintrag' : 'Einträgen'} verwendet und kann nicht gelöscht werden. Du kannst sie aber umbenennen.`);
    return;
  }
  if (settings[listName].length === 1) {
    alert('Es muss mindestens ein Eintrag übrig bleiben.');
    return;
  }
  if (!confirm(`„${item.name}“ löschen?`)) return;
  settings[listName] = settings[listName].filter((x) => x !== item);
  settingsChanged();
  renderSettings();
}

function renderSettings() {
  const kindList = $('kindList');
  kindList.replaceChildren();
  for (const k of settings.kinds) {
    const row = el('div', 'edit-row');
    const color = el('input');
    color.type = 'color';
    color.value = k.color;
    color.setAttribute('aria-label', 'Farbe');
    color.addEventListener('input', () => { k.color = color.value; settingsChanged(); });
    row.append(
      color,
      textInput(k.name, 'Name', (v) => { k.name = v.trim(); settingsChanged(); }, 'grow'),
      deleteButton(() => removeItem('kinds', k, 'kind')),
    );
    kindList.append(row);
  }

  const modeList = $('modeList');
  modeList.replaceChildren();
  for (const m of settings.modes) {
    const row = el('div', 'edit-row');
    row.append(
      textInput(m.icon, '🙂', (v) => { m.icon = v.trim(); settingsChanged(); }, 'icon-input'),
      textInput(m.name, 'Name', (v) => { m.name = v.trim(); settingsChanged(); }, 'grow'),
      deleteButton(() => removeItem('modes', m, 'mode')),
    );
    modeList.append(row);
  }

  $('accentColor').value = settings.accent;
}

const NEW_COLORS = ['#5b7fd6', '#c0587e', '#8a6ad1', '#d9774a', '#4aa3b8', '#7a9a3a'];

$('addKind').addEventListener('click', () => {
  const color = NEW_COLORS[settings.kinds.length % NEW_COLORS.length];
  settings.kinds.push({ id: newId(), name: 'Neue Terminart', color });
  settingsChanged();
  renderSettings();
  const inputs = $('kindList').querySelectorAll('input[type=text]');
  inputs[inputs.length - 1].select();
});

$('addMode').addEventListener('click', () => {
  settings.modes.push({ id: newId(), name: 'Neue Form', icon: '💬' });
  settingsChanged();
  renderSettings();
  const inputs = $('modeList').querySelectorAll('input.grow');
  inputs[inputs.length - 1].select();
});

$('accentColor').addEventListener('input', (ev) => {
  settings.accent = ev.target.value;
  applyAccent();
  saveSettings();
});
$('accentReset').addEventListener('click', () => {
  settings.accent = DEFAULT_ACCENT;
  applyAccent();
  saveSettings();
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
  if (await sha256(PASSWORD_SALT + oldPw) !== settings.passwordHash) {
    showPwMsg('Das aktuelle Passwort stimmt nicht.');
    return;
  }
  if (newPw !== $('pwNew2').value) {
    showPwMsg('Die neuen Passwörter stimmen nicht überein.');
    return;
  }
  settings.passwordHash = await sha256(PASSWORD_SALT + newPw);
  saveSettings();
  try { sessionStorage.setItem(SESSION_KEY, settings.passwordHash); } catch {}
  $('pwForm').reset();
  showPwMsg('Passwort geändert. Es gilt nur auf diesem Gerät.', true);
});

function closeSettings() {
  // Empty names would make entries unreadable, so fall back to a placeholder.
  settings.kinds.forEach((k) => { if (!k.name) k.name = 'Ohne Namen'; });
  settings.modes.forEach((m) => { if (!m.name) m.name = 'Ohne Namen'; });
  settingsChanged();
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

applyAccent();

let loggedIn = false;
try { loggedIn = sessionStorage.getItem(SESSION_KEY) === settings.passwordHash; } catch {}
if (loggedIn) unlock();
