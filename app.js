'use strict';

const STORAGE_KEY = 'gespraechskalender.v1';
const KINDS = { vor: 'Vorgespräch', see: 'Seelsorgegespräch' };
const MODES = { treffen: 'Persönlich', telefon: 'Telefon' };
const MODE_ICONS = { treffen: '🤝', telefon: '📞' };
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];

const $ = (id) => document.getElementById(id);

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
      const chip = el('span', `chip ${e.kind}`, `${MODE_ICONS[e.mode]} ${e.kind === 'vor' ? 'Vor' : 'Seels.'}`);
      chip.title = `${KINDS[e.kind]} – ${MODES[e.mode]}`;
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
    row.append(el('span', `bar ${e.kind}`));
    const main = el('div', 'main');
    main.append(el('div', 'title', `${MODE_ICONS[e.mode]} ${KINDS[e.kind]}${e.person ? ' – ' + e.person : ''}`));
    main.append(el('div', 'meta', `${formatDate(e.date)}${e.time ? ', ' + e.time + ' Uhr' : ''} · ${MODES[e.mode]}`));
    if (e.note) main.append(el('div', 'note', e.note));
    row.append(main);
    row.addEventListener('click', () => openDialog(e));
    list.append(row);
  }

  renderStats(monthPrefix, String(year));
}

function renderStats(monthPrefix, yearPrefix) {
  const count = (prefix, kind, mode) => entries.filter((e) =>
    e.date.startsWith(prefix) && (!kind || e.kind === kind) && (!mode || e.mode === mode)).length;

  $('statsTitle').textContent = `Übersicht ${MONTHS[view.getMonth()]} / Jahr ${yearPrefix}`;
  const table = $('stats');
  table.replaceChildren();
  const head = el('thead');
  const hr = el('tr');
  ['', '🤝 Persönlich', '📞 Telefon', 'Summe (Monat)', 'Jahr'].forEach((t) => hr.append(el('th', null, t)));
  head.append(hr);
  const body = el('tbody');
  const rows = [['vor', KINDS.vor], ['see', KINDS.see], [null, 'Gesamt']];
  for (const [kind, label] of rows) {
    const tr = el('tr', kind ? null : 'total');
    tr.append(el('td', null, label));
    tr.append(el('td', null, count(monthPrefix, kind, 'treffen')));
    tr.append(el('td', null, count(monthPrefix, kind, 'telefon')));
    tr.append(el('td', null, count(monthPrefix, kind)));
    tr.append(el('td', null, count(yearPrefix, kind)));
    body.append(tr);
  }
  table.append(head, body);
}

function openDialog(entry, date) {
  const form = $('form');
  form.reset();
  editingId = entry ? entry.id : null;
  $('dlgTitle').textContent = entry ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
  $('deleteBtn').hidden = !entry;
  const e = entry || { date: date || selectedDate || iso(new Date()) };
  form.date.value = e.date;
  form.time.value = e.time || '';
  form.person.value = e.person || '';
  form.note.value = e.note || '';
  if (e.kind) form.querySelector(`input[name=kind][value=${e.kind}]`).checked = true;
  if (e.mode) form.querySelector(`input[name=mode][value=${e.mode}]`).checked = true;
  $('dlg').showModal();
}

$('form').addEventListener('submit', () => {
  const f = $('form');
  const data = {
    id: editingId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
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
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
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
    if (!Array.isArray(data)) throw new Error('Ungültiges Format');
    const valid = data.filter((e) => e && e.id && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && KINDS[e.kind] && MODES[e.mode]);
    if (!confirm(`${valid.length} Einträge gefunden. Mit vorhandenen Einträgen zusammenführen?`)) return;
    const map = new Map(entries.map((e) => [e.id, e]));
    for (const e of valid) map.set(e.id, e);
    entries = [...map.values()];
    save();
    render();
  } catch (err) {
    alert('Die Datei konnte nicht gelesen werden: ' + err.message);
  }
});

render();
