(() => {
'use strict';

const STORAGE_KEY = 'cutlist-calc-v1';
const EPS = 1e-6;

const $ = (id) => document.getElementById(id);
const stockRows = $('stockRows');
const cutRows = $('cutRows');

/* ---------------- parsing & formatting ---------------- */

// "48" | "0.75" | ".75" | "3/4" | "1 1/2" | "1-1/2" -> number; junk -> NaN
function parseInches(s) {
  let m = s.match(/^(\d+(?:\.\d+)?|\.\d+)$/);
  if (m) return parseFloat(m[1]);
  m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return +m[2] ? +m[1] / +m[2] : NaN;
  m = s.match(/^(\d+)[\s-]+(\d+)\s*\/\s*(\d+)$/);
  if (m) return +m[3] ? +m[1] + (+m[2] / +m[3]) : NaN;
  return NaN;
}

const stripInchMark = (s) => s.replace(/\s*(?:"|″|in\.?|inch(?:es)?)$/, '').trim();

// Inches, optionally with a feet part: 48 | 3/4 | 1 1/2 | 6" | 12' | 4'6" |
// 4 ft 6 1/2 in  -> total inches; "" -> null; junk -> NaN
function parseMeasure(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const ft = s.match(/^(\d+(?:\.\d+)?|\.\d+)\s*(?:'|′|ft\.?|feet|foot)\s*(.*)$/);
  if (ft) {
    const rest = stripInchMark(ft[2]);
    if (!rest) return parseFloat(ft[1]) * 12;
    const inches = parseInches(rest);
    return Number.isNaN(inches) ? NaN : parseFloat(ft[1]) * 12 + inches;
  }
  const plain = stripInchMark(s);
  return plain ? parseInches(plain) : NaN;
}

function parsePrice(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^\$/, '');
  if (!s) return null;
  return /^(\d+(?:\.\d+)?|\.\d+)$/.test(s) ? parseFloat(s) : NaN;
}

function parseQty(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
}

const fmt = (n) => String(Math.round(n * 1000) / 1000);
const money = (n) => '$' + n.toFixed(2);

function describeDims(item) {
  let s = `${fmt(item.length)}″`;
  if (item.width != null || item.thickness != null) {
    s += ` × ${item.width != null ? fmt(item.width) + '″' : '?'}`;
    s += ` × ${item.thickness != null ? fmt(item.thickness) + '″' : '?'}`;
    s += ' (L×W×T)';
  } else {
    s += ' long';
  }
  return s;
}

/* ---------------- table rows ---------------- */

const STOCK_COLS = [
  { key: 'length', label: 'Length (in) *', mode: 'decimal' },
  { key: 'width', label: 'Width (in)', mode: 'decimal' },
  { key: 'thickness', label: 'Thickness (in)', mode: 'decimal' },
  { key: 'price', label: 'Price ($)', mode: 'decimal' },
];
const CUT_COLS = [
  { key: 'length', label: 'Length (in) *', mode: 'decimal' },
  { key: 'width', label: 'Width (in)', mode: 'decimal' },
  { key: 'thickness', label: 'Thickness (in)', mode: 'decimal' },
  { key: 'qty', label: 'Qty *', mode: 'numeric' },
];

function addRow(container, cols, values = {}) {
  const row = document.createElement('div');
  row.className = 'row';
  for (const col of cols) {
    const cell = document.createElement('label');
    cell.className = 'cell';
    const span = document.createElement('span');
    span.textContent = col.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = col.mode;
    input.autocomplete = 'off';
    input.dataset.key = col.key;
    input.enterKeyHint = 'next';
    input.value = values[col.key] ?? '';
    input.addEventListener('input', () => {
      input.classList.remove('invalid');
      saveState();
    });
    input.addEventListener('keydown', handleEnterKey);
    cell.append(span, input);
    row.appendChild(cell);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Remove row');
  del.addEventListener('click', () => {
    row.remove();
    if (!container.children.length) addRow(container, cols);
    saveState();
  });
  row.appendChild(del);
  container.appendChild(row);
  return row;
}

function readRows(container) {
  return [...container.querySelectorAll('.row')].map((row) => {
    const rec = { _inputs: {} };
    for (const input of row.querySelectorAll('input')) {
      rec[input.dataset.key] = input.value;
      rec._inputs[input.dataset.key] = input;
    }
    return rec;
  });
}

const rowHasContent = (rec, keys) => keys.some((k) => String(rec[k]).trim() !== '');

/* Enter/Return jumps to the next empty field; when none remain ahead, it
   adds a fresh row to the table the cursor is in and moves into it. */
function handleEnterKey(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const inputs = [...document.querySelectorAll('main input[type="text"]')];
  const next = inputs.slice(inputs.indexOf(e.target) + 1).find((el) => !el.value.trim());
  if (next) {
    next.focus();
    return;
  }
  const container = e.target.closest('#stockRows, #cutRows');
  if (!container) {
    e.target.blur();
    return;
  }
  const isStock = container.id === 'stockRows';
  const row = addRow(container, isStock ? STOCK_COLS : CUT_COLS, isStock ? {} : { qty: '1' });
  saveState();
  row.querySelector('input').focus();
}

/* ---------------- persistence ---------------- */

function saveState() {
  const strip = (rows, keys) =>
    rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
  const data = {
    stock: strip(readRows(stockRows), ['length', 'width', 'thickness', 'price']),
    cuts: strip(readRows(cutRows), ['length', 'width', 'thickness', 'qty']),
    kerf: $('kerfInput').value,
    allowLarger: $('allowLarger').checked,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* private mode */ }
}

function loadState() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { /* ignore */ }
  if (data) {
    $('kerfInput').value = data.kerf ?? '1/8';
    $('allowLarger').checked = !!data.allowLarger;
    for (const rec of data.stock?.length ? data.stock : [{}]) addRow(stockRows, STOCK_COLS, rec);
    for (const rec of data.cuts?.length ? data.cuts : [{}]) addRow(cutRows, CUT_COLS, rec);
  } else {
    addRow(stockRows, STOCK_COLS);
    addRow(cutRows, CUT_COLS, { qty: '1' });
  }
}

/* ---------------- CSV import / export ---------------- */

const CSV_HEADER = ['section', 'length', 'width', 'thickness', 'price', 'qty'];

// dimensions carry inch marks (4' 6"), which are the CSV quote char — so quote properly
const csvEscape = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = (rows) => rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';

// RFC 4180-ish, but tolerant of bare inch marks inside an unquoted field
function parseCsv(text) {
  const s = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (s[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function buildCsv() {
  const rows = [CSV_HEADER];
  for (const r of readRows(stockRows)) {
    if (rowHasContent(r, ['length', 'width', 'thickness', 'price'])) {
      rows.push(['stock', r.length, r.width, r.thickness, r.price, '']);
    }
  }
  for (const r of readRows(cutRows)) {
    if (rowHasContent(r, ['length', 'width', 'thickness'])) {
      rows.push(['cut', r.length, r.width, r.thickness, '', r.qty]);
    }
  }
  rows.push(['setting', 'kerf', $('kerfInput').value, '', '', '']);
  rows.push(['setting', 'allowLarger', $('allowLarger').checked ? 'yes' : 'no', '', '', '']);
  return toCsv(rows);
}

function exportCsv() {
  const blob = new Blob([buildCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cut-list-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// spreadsheet-friendly column names, so a hand-made list imports too
const CSV_ALIASES = {
  section: 'section', type: 'section', kind: 'section', category: 'section',
  length: 'length', len: 'length', l: 'length', long: 'length',
  width: 'width', w: 'width', wide: 'width',
  thickness: 'thickness', thick: 'thickness', t: 'thickness', depth: 'thickness',
  price: 'price', cost: 'price', each: 'price',
  qty: 'qty', quantity: 'qty', count: 'qty', pieces: 'qty', num: 'qty',
};

const normHeader = (h) =>
  CSV_ALIASES[
    String(h).toLowerCase().replace(/\(.*?\)/g, '').replace(/[*_"″]/g, '').replace(/\s+/g, ' ').trim()
  ] || null;

const SECTIONS = { stock: 'stock', board: 'stock', boards: 'stock', cut: 'cut', cuts: 'cut', piece: 'cut', setting: 'setting', settings: 'setting' };

// Accepts our own export, or a plain spreadsheet of cuts/boards with a header row.
function readCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'That file is empty.' };

  let cols = rows[0].map(normHeader);
  let data;
  if (cols.some((c) => c === 'length')) {
    data = rows.slice(1);
  } else {
    // no header row: assume our column order if rows are tagged, else a bare cut list
    data = rows;
    cols = SECTIONS[String(rows[0][0]).toLowerCase().trim()]
      ? CSV_HEADER
      : ['length', 'width', 'thickness', 'qty'];
  }
  const hasSection = cols.includes('section');
  const fallback = cols.includes('qty') || !cols.includes('price') ? 'cut' : 'stock';

  const stock = [];
  const cuts = [];
  const settings = {};
  let skipped = 0;
  for (const row of data) {
    const vals = {};
    cols.forEach((c, i) => { if (c) vals[c] = String(row[i] ?? '').trim(); });
    let section = fallback;
    if (hasSection) {
      const tag = SECTIONS[String(vals.section ?? '').toLowerCase()];
      if (!tag) { skipped++; continue; }
      section = tag;
    }
    if (section === 'setting') {
      if (vals.length) settings[String(vals.length).trim()] = String(vals.width ?? '').trim();
    } else if (section === 'stock') {
      stock.push({ length: vals.length ?? '', width: vals.width ?? '', thickness: vals.thickness ?? '', price: vals.price ?? '' });
    } else {
      cuts.push({ length: vals.length ?? '', width: vals.width ?? '', thickness: vals.thickness ?? '', qty: vals.qty || '1' });
    }
  }
  // a file of unrelated text would otherwise import as rows of nonsense
  const usable = [...stock, ...cuts].some((r) => {
    const len = parseMeasure(r.length);
    return len != null && !Number.isNaN(len) && len > 0;
  });
  if (!usable) {
    return { error: 'No board or cut lengths found in that file. Expected a header row with at least a “length” column.' };
  }
  return { stock, cuts, settings, skipped };
}

function applyCsv({ stock, cuts, settings }) {
  stockRows.innerHTML = '';
  cutRows.innerHTML = '';
  for (const rec of stock.length ? stock : [{}]) addRow(stockRows, STOCK_COLS, rec);
  for (const rec of cuts.length ? cuts : [{ qty: '1' }]) addRow(cutRows, CUT_COLS, rec);
  if (settings.kerf) $('kerfInput').value = settings.kerf;
  const larger = settings.allowLarger ?? settings.allowlarger;
  if (larger != null && larger !== '') $('allowLarger').checked = /^(y|yes|true|1|on)$/i.test(larger);
  saveState();
}

function importCsv(text) {
  const res = readCsv(text);
  const notice = $('noticeBox');
  if (res.error) {
    $('errorBox').textContent = res.error;
    $('errorBox').hidden = false;
    notice.hidden = true;
    return;
  }
  const current = [
    ...readRows(stockRows).filter((r) => rowHasContent(r, ['length', 'width', 'thickness', 'price'])),
    ...readRows(cutRows).filter((r) => rowHasContent(r, ['length', 'width', 'thickness'])),
  ];
  if (current.length && !confirm('Replace the current stock boards and cuts with the file?')) return;
  applyCsv(res);
  const parts = [
    `${res.stock.length} stock board${res.stock.length === 1 ? '' : 's'}`,
    `${res.cuts.length} cut${res.cuts.length === 1 ? '' : 's'}`,
  ];
  notice.textContent = `Imported ${parts.join(' and ')}.${res.skipped ? ` ${res.skipped} row${res.skipped === 1 ? '' : 's'} skipped.` : ''}`;
  notice.hidden = false;
  $('errorBox').hidden = true;
  $('results').hidden = true;
}

/* ---------------- validation ---------------- */

function collectInputs() {
  const errors = [];
  const stock = [];
  const cuts = [];

  const kerf = parseMeasure($('kerfInput').value);
  if (kerf == null || Number.isNaN(kerf) || kerf < 0) {
    errors.push('Enter a valid saw kerf (use 0 for no kerf).');
    $('kerfInput').classList.add('invalid');
  }

  readRows(stockRows).forEach((rec, i) => {
    if (!rowHasContent(rec, ['length', 'width', 'thickness', 'price'])) return;
    const item = {
      length: parseMeasure(rec.length),
      width: parseMeasure(rec.width),
      thickness: parseMeasure(rec.thickness),
      price: parsePrice(rec.price),
      row: i + 1,
    };
    for (const k of ['length', 'width', 'thickness', 'price']) {
      const bad =
        Number.isNaN(item[k]) ||
        (k === 'length' && (item[k] == null || item[k] <= 0)) ||
        (item[k] != null && item[k] < 0) ||
        ((k === 'width' || k === 'thickness') && item[k] != null && item[k] <= 0);
      if (bad) {
        errors.push(`Stock row ${i + 1}: invalid ${k === 'price' ? 'price' : k}.`);
        rec._inputs[k].classList.add('invalid');
        item.bad = true;
      }
    }
    if (!item.bad) stock.push(item);
  });

  readRows(cutRows).forEach((rec, i) => {
    // qty is pre-filled with "1", so it alone doesn't make a row "in use"
    if (!rowHasContent(rec, ['length', 'width', 'thickness'])) return;
    const item = {
      length: parseMeasure(rec.length),
      width: parseMeasure(rec.width),
      thickness: parseMeasure(rec.thickness),
      qty: parseQty(rec.qty),
      row: i + 1,
    };
    if (item.qty == null) item.qty = 1;
    for (const k of ['length', 'width', 'thickness', 'qty']) {
      const bad =
        Number.isNaN(item[k]) ||
        (k === 'length' && (item[k] == null || item[k] <= 0)) ||
        (k === 'qty' && item[k] < 1) ||
        ((k === 'width' || k === 'thickness') && item[k] != null && item[k] <= 0);
      if (bad) {
        errors.push(`Cut row ${i + 1}: invalid ${k}.`);
        rec._inputs[k].classList.add('invalid');
        item.bad = true;
      }
    }
    if (!item.bad) cuts.push(item);
  });

  if (!errors.length) {
    if (!stock.length) errors.push('Add at least one stock board (length is required).');
    if (!cuts.length) errors.push('Add at least one cut (length is required).');
  }
  return { errors, stock, cuts, kerf: kerf || 0 };
}

/* ---------------- solver (1D cutting stock) ---------------- */

function dimCompatible(cutDim, stockDim, allowLarger) {
  if (cutDim == null || stockDim == null) return true; // blank = wildcard
  return allowLarger ? cutDim <= stockDim + EPS : Math.abs(cutDim - stockDim) <= EPS;
}

// Thickness always has to match: you buy 3/4″ stock for a 3/4″ piece, you don't
// plane a 1.5″ board down. "Allow larger" only ever means ripping a board narrower.
function pieceFitsType(piece, type, allowLarger) {
  return (
    piece.length <= type.length + EPS &&
    dimCompatible(piece.width, type.width, allowLarger) &&
    dimCompatible(piece.thickness, type.thickness, false)
  );
}

// Fill one board of `type` greedily (largest compatible piece first).
function fillOne(remaining, type, kerf, allowLarger) {
  let used = 0;
  const taken = [];
  for (const p of remaining) {
    if (!pieceFitsType(p, type, allowLarger)) continue;
    const need = taken.length ? kerf + p.length : p.length;
    if (used + need <= type.length + EPS) {
      taken.push(p);
      used += need;
    }
  }
  return { taken, used };
}

function costOf(bins) {
  return bins.reduce((s, b) => s + (b.stock.price ?? 0), 0);
}

// Greedy: repeatedly open the board with the best marginal cost per used inch.
// preferFill=true breaks toward the fullest board instead of the cheapest inch.
function packGreedy(pieces, types, kerf, allowLarger, preferFill) {
  let remaining = [...pieces].sort((a, b) => b.length - a.length);
  const bins = [];
  while (remaining.length) {
    let best = null;
    for (const type of types) {
      const sim = fillOne(remaining, type, kerf, allowLarger);
      if (!sim.taken.length) continue;
      const price = type.price ?? 0;
      const score = preferFill ? -sim.used / type.length : price / sim.used;
      if (
        !best ||
        score < best.score - EPS ||
        (Math.abs(score - best.score) <= EPS && sim.used > best.sim.used + EPS)
      ) {
        best = { type, sim, score };
      }
    }
    if (!best) return null; // shouldn't happen: fit is validated upfront
    bins.push({ stock: best.type, cuts: best.sim.taken, used: best.sim.used });
    const takenSet = new Set(best.sim.taken);
    remaining = remaining.filter((p) => !takenSet.has(p));
  }
  return bins;
}

// First-fit-decreasing using only one stock type (valid only if it fits every piece).
function packSingleType(pieces, type, kerf, allowLarger) {
  if (!pieces.every((p) => pieceFitsType(p, type, allowLarger))) return null;
  const sorted = [...pieces].sort((a, b) => b.length - a.length);
  const bins = [];
  for (const p of sorted) {
    let placed = false;
    for (const b of bins) {
      const need = kerf + p.length;
      if (b.used + need <= type.length + EPS) {
        b.cuts.push(p);
        b.used += need;
        placed = true;
        break;
      }
    }
    if (!placed) bins.push({ stock: type, cuts: [p], used: p.length });
  }
  return bins;
}

function solve(stock, cuts, kerf, allowLarger) {
  const pieces = [];
  cuts.forEach((c, ci) => {
    for (let i = 0; i < c.qty; i++) {
      pieces.push({ length: c.length, width: c.width, thickness: c.thickness, cutRow: c.row });
    }
  });

  // every piece must fit at least one stock type
  const misfits = [];
  for (const c of cuts) {
    const p = { length: c.length, width: c.width, thickness: c.thickness };
    if (stock.some((t) => pieceFitsType(p, t, allowLarger))) continue;
    const thickOk = stock.filter((t) => dimCompatible(c.thickness, t.thickness, false));
    const widthOk = thickOk.filter((t) => dimCompatible(c.width, t.width, allowLarger));
    let why;
    if (!thickOk.length) {
      why = 'no board has a matching thickness.';
    } else if (!widthOk.length) {
      why = allowLarger
        ? 'no board of that thickness is wide enough.'
        : 'no board matches its width. Tip: enable “allow cuts from wider stock” if ripping down is OK.';
    } else {
      why = 'it is longer than every matching board.';
    }
    misfits.push(`Cut row ${c.row} (${describeDims(c)}) fits no stock board — ${why}`);
  }
  if (misfits.length) return { errors: misfits };

  const candidates = [];
  const greedy = packGreedy(pieces, stock, kerf, allowLarger, false);
  if (greedy) candidates.push(greedy);
  const filled = packGreedy(pieces, stock, kerf, allowLarger, true);
  if (filled) candidates.push(filled);
  for (const type of stock) {
    const single = packSingleType(pieces, type, kerf, allowLarger);
    if (single) candidates.push(single);
  }

  candidates.sort((a, b) => {
    const dc = costOf(a) - costOf(b);
    if (Math.abs(dc) > EPS) return dc;
    if (a.length !== b.length) return a.length - b.length; // fewer boards
    const stockLen = (bins) => bins.reduce((s, x) => s + x.stock.length, 0);
    return stockLen(a) - stockLen(b); // less material
  });
  return { bins: candidates[0] };
}

/* ---------------- rendering ---------------- */

// Give each scaled board a height matching its length:width ratio, clamped so a
// 12′ 1×6 stays readable and a plywood sheet doesn't fill the screen.
// the max is set so ordinary sheet goods (a 2:1 4×8 sheet, say) come out exactly
// to scale at normal page widths; only near-square stock gets squashed
const BAR_MIN_H = 42;
const BAR_MAX_H = 360;

function sizeBars() {
  for (const bar of document.querySelectorAll('.bar-scaled')) {
    const ratio = parseFloat(bar.dataset.ratio);
    if (!(ratio > 0)) continue;
    const h = Math.min(BAR_MAX_H, Math.max(BAR_MIN_H, bar.clientWidth / ratio));
    bar.style.height = `${Math.round(h)}px`;
  }
}

function renderResults(bins, kerf, pricedMode) {
  const results = $('results');
  results.hidden = false;

  const totalCost = costOf(bins);
  const unpriced = bins.filter((b) => b.stock.price == null).length;
  const totalStockLen = bins.reduce((s, b) => s + b.stock.length, 0);
  const totalCutLen = bins.reduce((s, b) => s + b.cuts.reduce((x, c) => x + c.length, 0), 0);
  const totalLeftover = bins.reduce((s, b) => s + (b.stock.length - b.used), 0);
  const totalPieces = bins.reduce((s, b) => s + b.cuts.length, 0);

  // when every board and piece has a width, measure utilization by area so rip
  // waste counts against it; otherwise fall back to length only
  const haveWidths = bins.every((b) => b.stock.width != null && b.cuts.every((c) => c.width != null));
  const usedArea = bins.reduce((s, b) => s + b.cuts.reduce((x, c) => x + c.length * c.width, 0), 0);
  const stockArea = bins.reduce((s, b) => s + b.stock.length * b.stock.width, 0);
  const utilization = haveWidths ? usedArea / stockArea : totalCutLen / totalStockLen;

  const stats = pricedMode ? [['Total cost', money(totalCost)]] : [];
  stats.push(
    ['Boards to buy', String(bins.length)],
    ['Pieces cut', String(totalPieces)],
    [haveWidths ? 'Utilization (area)' : 'Utilization', `${Math.round(utilization * 100)}%`],
    ['Leftover', `${fmt(totalLeftover)}″`]
  );
  $('stats').innerHTML = stats
    .map(([k, v]) => `<div class="stat"><span class="v">${v}</span><span class="k">${k}</span></div>`)
    .join('');

  const warn = $('warnBox');
  warn.hidden = !(pricedMode && unpriced);
  if (pricedMode && unpriced) {
    warn.textContent = `${unpriced} board${unpriced > 1 ? 's have' : ' has'} no price entered — the total treats ${unpriced > 1 ? 'them' : 'it'} as $0.`;
  }

  // shopping list: aggregate bins by stock type
  const byType = new Map();
  for (const b of bins) {
    const entry = byType.get(b.stock) || { type: b.stock, qty: 0 };
    entry.qty++;
    byType.set(b.stock, entry);
  }
  const rows = [...byType.values()]
    .sort((a, b) => b.type.length - a.type.length) // longest board first
    .map(({ type, qty }) => {
      if (!pricedMode) return `<tr><td>${describeDims(type)}</td><td>${qty}</td></tr>`;
      const price = type.price != null ? money(type.price) : '—';
      const line = type.price != null ? money(type.price * qty) : '—';
      return `<tr><td>${describeDims(type)}</td><td>${qty}</td><td>${price}</td><td>${line}</td></tr>`;
    })
    .join('');
  $('shoppingList').innerHTML = pricedMode
    ? `<table class="shop-table"><thead><tr><th>Board</th><th>Qty</th><th>Each</th><th>Total</th></tr></thead>` +
      `<tbody>${rows}</tbody><tfoot><tr><td>Total</td><td></td><td></td><td>${money(totalCost)}</td></tr></tfoot></table>`
    : `<table class="shop-table"><thead><tr><th>Board</th><th>Qty</th></tr></thead><tbody>${rows}</tbody></table>`;

  // cut plan: group identical board layouts (widths included — they change the drawing)
  const layouts = new Map();
  for (const b of bins) {
    const key =
      JSON.stringify([b.stock.length, b.stock.width, b.stock.thickness, b.stock.price]) +
      '|' +
      b.cuts.map((c) => `${c.length}x${c.width ?? '?'}`).sort().join(',');
    const entry = layouts.get(key) || { bin: b, count: 0 };
    entry.count++;
    layouts.set(key, entry);
  }

  $('cutPlan').innerHTML = [...layouts.values()]
    .sort((a, b) => b.bin.stock.length - a.bin.stock.length || b.bin.used - a.bin.used)
    .map(({ bin, count }) => {
      const stockW = bin.stock.width;
      const ripOf = (c) => (stockW != null && c.width != null ? stockW - c.width : 0);
      const segs = [];
      bin.cuts.forEach((c, ci) => {
        if (ci > 0 && kerf > 0) segs.push(`<div class="seg seg-kerf" title="kerf ${fmt(kerf)}″"></div>`);
        const rip = ripOf(c);
        const ripped = rip > EPS;
        const label = ripped ? `${fmt(c.length)}″ × ${fmt(c.width)}″` : `${fmt(c.length)}″`;
        const title = ripped
          ? `${fmt(c.length)}″ × ${fmt(c.width)}″ cut — rip ${fmt(rip)}″ off the width`
          : `${fmt(c.length)}″ cut`;
        segs.push(
          `<div class="seg seg-cut" style="flex-grow:${c.length}" title="${title}">` +
            `<div class="piece" style="flex-grow:${ripped ? c.width : 1}">${label}</div>` +
            (ripped ? `<div class="rip" style="flex-grow:${rip}" title="rip waste ${fmt(rip)}″"></div>` : '') +
            `</div>`
        );
      });
      const leftover = bin.stock.length - bin.used;
      if (leftover > EPS) {
        segs.push(
          `<div class="seg seg-left" style="flex-grow:${leftover}" title="leftover ${fmt(leftover)}″">${fmt(leftover)}″</div>`
        );
      }
      // draw the board to scale (length × width) so a sheet doesn't look like a 1×6.
      // the ratio is applied by sizeBars() rather than CSS aspect-ratio, which would
      // feed the clamped height back into the width and overflow the card.
      const barAttrs =
        stockW > 0
          ? ` class="bar bar-scaled" data-ratio="${bin.stock.length / stockW}"`
          : ` class="bar"`;
      const cutList = bin.cuts
        .map((c) => (ripOf(c) > EPS ? `${fmt(c.length)}″ × ${fmt(c.width)}″` : `${fmt(c.length)}″`))
        .join(' + ');
      const rips = bin.cuts.filter((c) => ripOf(c) > EPS).length;
      const ripNote = rips
        ? ` — ${rips === bin.cuts.length ? 'every piece' : `${rips} piece${rips > 1 ? 's' : ''}`} rips narrower than the board`
        : '';
      return (
        `<div class="board">` +
        `<div class="board-title">${describeDims(bin.stock)}${count > 1 ? ` <span class="mult">× ${count}</span>` : ''}</div>` +
        `<div${barAttrs}>${segs.join('')}</div>` +
        `<div class="board-caption">Cuts: ${cutList} — leftover ${fmt(Math.max(0, leftover))}″ of length${ripNote}</div>` +
        `</div>`
      );
    })
    .join('');

  sizeBars();
}

/* ---------------- wiring ---------------- */

function calculate() {
  document.querySelectorAll('input.invalid').forEach((el) => el.classList.remove('invalid'));
  $('noticeBox').hidden = true;
  const errorBox = $('errorBox');
  const { errors, stock, cuts, kerf } = collectInputs();
  if (errors.length) {
    errorBox.textContent = errors.join('\n');
    errorBox.hidden = false;
    $('results').hidden = true;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const allowLarger = $('allowLarger').checked;
  const res = solve(stock, cuts, kerf, allowLarger);
  if (res.errors) {
    errorBox.textContent = res.errors.join('\n');
    errorBox.hidden = false;
    $('results').hidden = true;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  errorBox.hidden = true;
  // with no prices anywhere, the solver's $0 tie-breakers already minimize
  // board count, then total material — just hide the money UI
  renderResults(res.bins, kerf, stock.some((s) => s.price != null));
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('calcBtn').addEventListener('click', calculate);
$('addStock').addEventListener('click', () => { addRow(stockRows, STOCK_COLS); saveState(); });
$('addCut').addEventListener('click', () => { addRow(cutRows, CUT_COLS, { qty: '1' }); saveState(); });
$('kerfInput').addEventListener('input', () => { $('kerfInput').classList.remove('invalid'); saveState(); });
$('kerfInput').addEventListener('keydown', handleEnterKey);
$('allowLarger').addEventListener('change', saveState);
addEventListener('resize', sizeBars);

$('exportCsv').addEventListener('click', exportCsv);
$('importCsv').addEventListener('click', () => $('csvFile').click());
$('csvFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // so re-picking the same file fires again
  if (!file) return;
  file
    .text()
    .then(importCsv)
    .catch(() => {
      $('errorBox').textContent = "Couldn't read that file.";
      $('errorBox').hidden = false;
    });
});

$('clearAll').addEventListener('click', () => {
  if (!confirm('Clear all stock, cuts and settings?')) return;
  stockRows.innerHTML = '';
  cutRows.innerHTML = '';
  addRow(stockRows, STOCK_COLS);
  addRow(cutRows, CUT_COLS, { qty: '1' });
  $('kerfInput').value = '1/8';
  $('allowLarger').checked = false;
  $('results').hidden = true;
  $('errorBox').hidden = true;
  $('noticeBox').hidden = true;
  saveState();
});

$('loadExample').addEventListener('click', () => {
  stockRows.innerHTML = '';
  cutRows.innerHTML = '';
  addRow(stockRows, STOCK_COLS, { length: '144', width: '6', thickness: '1.5', price: '12.99' });
  addRow(stockRows, STOCK_COLS, { length: '96', width: '6', thickness: '1.5', price: '8.49' });
  addRow(cutRows, CUT_COLS, { length: '48', width: '6', thickness: '1.5', qty: '5' });
  addRow(cutRows, CUT_COLS, { length: '60', width: '6', thickness: '1.5', qty: '3' });
  saveState();
});

loadState();
})();
