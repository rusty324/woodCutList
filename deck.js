(() => {
'use strict';

const U = window.CutUtil;
const E = window.DeckEngine;
const $ = (id) => document.getElementById(id);

/* ---------------- tabs ---------------- */

const TAB_KEY = 'wood-tools-tab';
const TABS = { cuts: [$('tabCuts'), $('cutsPanel')], deck: [$('tabDeck'), $('deckPanel')] };
let deckShownOnce = false;

function showTab(name, persist) {
  for (const [k, [btn, panel]] of Object.entries(TABS)) {
    btn.setAttribute('aria-selected', String(k === name));
    panel.hidden = k !== name;
  }
  if (persist) { try { localStorage.setItem(TAB_KEY, name); } catch { /* private mode */ } }
  if (name === 'deck') requestAnimationFrame(onDeckShown);
}
for (const [k, [btn]] of Object.entries(TABS)) btn.addEventListener('click', () => showTab(k, true));

let startTab = 'cuts';
try { if (localStorage.getItem(TAB_KEY) === 'deck') startTab = 'deck'; } catch { /* ignore */ }
if (location.hash === '#deck') startTab = 'deck';
if (location.hash === '#cuts') startTab = 'cuts';

/* ---------------- state ---------------- */

const KEY = 'deck-planner-v1';
const DEFAULT_STOCK = ["8'", "10'", "12'", "16'", "20'"];

const fresh = () => ({
  settings: { boardW: '5.5', gap: '1/8', kerf: '1/8', waste: '10', joistSpacing: '16', joistWidth: '1.5' },
  stock: DEFAULT_STOCK.map((length) => ({ length, price: '' })),
  footprints: [],
  active: null,
  nextId: 1,
  snap: 6,
});

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.footprints) && Array.isArray(d.stock)) {
      const base = fresh();
      const st = { ...base, ...d, settings: { ...base.settings, ...(d.settings || {}) } };
      st.footprints = st.footprints.filter((f) => Array.isArray(f.pts) && f.pts.length >= 3);
      for (const f of st.footprints) {
        f.edgeOn = f.pts.map((_, i) => (Array.isArray(f.edgeOn) ? f.edgeOn[i] !== false : true));
        f.joists = Array.isArray(f.joists) ? f.joists : [];
      }
      return st;
    }
  } catch { /* ignore */ }
  return fresh();
}
let state = load();
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ } }

// transient UI state (not saved)
let tool = 'select';
let drawing = [];            // corners placed so far in "Draw area"
let joistStart = null;       // first end of a joist being drawn
let hover = null;            // pointer position in plan coordinates
let sel = null;              // {type:'vertex'|'joist', fp, i}
let results = null;          // engine output for the current inputs
let selBin = null;           // highlighted board in the layout

const fpById = (id) => state.footprints.find((f) => f.id === id);
const activeFp = () => fpById(state.active) || null;
const fpIndex = (fp) => state.footprints.indexOf(fp);

/* ---------------- parsing & formatting ---------------- */

const mm = (s) => U.parseMeasure(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r2 = (x) => Math.round(x * 100) / 100;
const money = (n) => '$' + n.toFixed(2);

function parseAngle(s) {
  const t = String(s ?? '').trim().replace(/°$/, '');
  if (!t) return 0;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
}

// 62.5 -> 5′ 2 1/2″ (nearest 1/16)
function fmtFtIn(n) {
  if (!(n >= 0)) return '—';
  const sx = Math.round(n * 16);
  const ft = Math.floor(sx / 192);
  const rem = sx - ft * 192;
  const inch = Math.floor(rem / 16);
  let a = rem % 16, b = 16;
  while (a && a % 2 === 0) { a /= 2; b /= 2; }
  const frac = a ? `${a}/${b}` : '';
  const inchPart = inch ? (frac ? `${inch} ${frac}` : `${inch}`) : (frac || '0');
  if (!ft) return `${inchPart}″`;
  return inch || frac ? `${ft}′ ${inchPart}″` : `${ft}′`;
}
const fmtIn = (n) => String(Math.round(n * 100) / 100);

/* ---------------- settings + stock table ---------------- */

const SETTING_INPUTS = { boardW: 'dBoardW', gap: 'dGap', kerf: 'dKerf', waste: 'dWaste' };
for (const [k, id] of Object.entries(SETTING_INPUTS)) {
  $(id).value = state.settings[k];
  $(id).addEventListener('input', () => { state.settings[k] = $(id).value; $(id).classList.remove('invalid'); touch(); });
}

function renderStock() {
  const box = $('dStockRows');
  box.innerHTML = '';
  state.stock.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'row';
    el.innerHTML =
      `<label class="cell"><span>Length *</span><input type="text" inputmode="decimal" autocomplete="off" data-k="length" value="${esc(row.length)}"></label>` +
      `<label class="cell"><span>Price ($)</span><input type="text" inputmode="decimal" autocomplete="off" data-k="price" value="${esc(row.price)}"></label>` +
      `<button type="button" class="del" aria-label="Remove length">×</button>`;
    el.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      row[inp.dataset.k] = inp.value;
      inp.classList.remove('invalid');
      touch();
    }));
    el.querySelector('.del').addEventListener('click', () => {
      state.stock.splice(i, 1);
      if (!state.stock.length) state.stock.push({ length: '', price: '' });
      renderStock();
      touch();
    });
    box.appendChild(el);
  });
}
$('dAddStock').addEventListener('click', () => { state.stock.push({ length: '', price: '' }); renderStock(); touch(); });

/* ---------------- model for the engine ---------------- */

function buildModel() {
  const errors = [];
  const bad = (id) => $(id).classList.add('invalid');
  document.querySelectorAll('#deckMain input.invalid').forEach((el) => el.classList.remove('invalid'));

  const boardWidth = mm(state.settings.boardW);
  if (!(boardWidth > 0)) { errors.push('Enter a valid deck board width.'); bad('dBoardW'); }
  const opt = (v, id, label) => {
    const x = mm(v);
    if (x == null) return 0;
    if (Number.isNaN(x) || x < 0) { errors.push(`Enter a valid ${label} (0 for none).`); bad(id); return 0; }
    return x;
  };
  const gap = opt(state.settings.gap, 'dGap', 'gap between boards');
  const kerf = opt(state.settings.kerf, 'dKerf', 'saw kerf');
  const wasteRaw = String(state.settings.waste ?? '').trim();
  const waste = wasteRaw === '' ? 0 : Number(wasteRaw);
  if (!Number.isFinite(waste) || waste < 0) { errors.push('Enter a valid extra-to-buy percentage.'); bad('dWaste'); }

  const stock = [];
  const rows = $('dStockRows').querySelectorAll('.row');
  state.stock.forEach((r, i) => {
    if (!String(r.length).trim() && !String(r.price).trim()) return;
    const length = mm(r.length), price = U.parsePrice(r.price);
    const inputs = rows[i] ? rows[i].querySelectorAll('input') : [];
    if (!(length > 0)) { errors.push(`Board length ${i + 1}: enter a valid length.`); inputs[0]?.classList.add('invalid'); return; }
    if (Number.isNaN(price)) { errors.push(`Board length ${i + 1}: invalid price.`); inputs[1]?.classList.add('invalid'); return; }
    stock.push({ length, price });
  });

  const footprints = state.footprints.map((fp, i) => {
    const name = fp.name || `Deck area ${i + 1}`;
    const ew = mm(fp.edgeWidth);
    if (Number.isNaN(ew) || ew < 0) errors.push(`${name}: invalid edge board width.`);
    const angle = parseAngle(fp.angle);
    if (Number.isNaN(angle)) errors.push(`${name}: invalid board angle.`);
    const joists = fp.joists.map((j, k) => {
      const w = mm(j.width);
      if (!(w > 0)) { errors.push(`${name}: joist ${k + 1} needs a valid width.`); return null; }
      return { a: j.a, b: j.b, width: w };
    }).filter(Boolean);
    return {
      name, pts: fp.pts, edgeWidth: ew > 0 ? ew : 0, edgeOn: fp.edgeOn, refEdge: fp.refEdge || 0,
      angle: Number.isNaN(angle) ? 0 : angle, flip: !!fp.flip, joists,
    };
  });
  return { errors, waste: Number.isFinite(waste) ? waste : 0, model: { boardWidth, gap, kerf, stock, footprints } };
}

/* ---------------- view (pan / zoom) ---------------- */

const svg = $('dSvg');
const layers = $('dLayers');
const size = { w: 0, h: 0 };
const view = { cx: 180, cy: 120, s: 2 };
const MIN_S = 0.05, MAX_S = 40;

function measure() {
  const r = svg.getBoundingClientRect();
  size.w = r.width; size.h = r.height;
}
function toWorld(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return [view.cx + (clientX - r.left - r.width / 2) / view.s, view.cy + (clientY - r.top - r.height / 2) / view.s];
}
function bounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const fp of state.footprints) for (const p of fp.pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 360, 240];
}
function fit() {
  measure();
  if (!size.w) return;
  const [x0, y0, x1, y1] = bounds();
  const w = Math.max(x1 - x0, 24) * 1.2, h = Math.max(y1 - y0, 24) * 1.2;
  view.s = Math.min(MAX_S, Math.max(MIN_S, Math.min(size.w / w, size.h / h)));
  view.cx = (x0 + x1) / 2;
  view.cy = (y0 + y1) / 2;
  draw();
}
function zoomAt(factor, cx, cy) {
  const before = toWorld(cx, cy);
  view.s = Math.min(MAX_S, Math.max(MIN_S, view.s * factor));
  const after = toWorld(cx, cy);
  view.cx += before[0] - after[0];
  view.cy += before[1] - after[1];
  scheduleDraw();
}
function zoomCenter(factor) {
  const r = svg.getBoundingClientRect();
  zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
}
$('dZoomIn').addEventListener('click', () => zoomCenter(1.4));
$('dZoomOut').addEventListener('click', () => zoomCenter(1 / 1.4));
$('dFit').addEventListener('click', fit);

let rafPending = false;
function scheduleDraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; draw(); });
}

/* ---------------- drawing ---------------- */

const GRID = [[1, 12], [3, 12], [6, 12], [12, 60], [36, 180], [60, 360], [120, 600], [360, 1800]];
const pts2s = (pts) => pts.map((p) => `${r2(p[0])},${r2(p[1])}`).join(' ');
const pathOf = (pts) => 'M' + pts.map((p) => `${r2(p[0])} ${r2(p[1])}`).join('L') + 'Z';

function gridSvg(x0, y0, w, h, s) {
  const [minor, major] = GRID.find(([m]) => m * s >= 8) || GRID[GRID.length - 1];
  const per = major / minor;
  let dMin = '', dMaj = '';
  const i0 = Math.floor(x0 / minor), i1 = Math.ceil((x0 + w) / minor);
  for (let i = i0; i <= i1; i++) {
    const seg = `M${i * minor} ${y0}V${y0 + h}`;
    if (i % per === 0) dMaj += seg; else dMin += seg;
  }
  const j0 = Math.floor(y0 / minor), j1 = Math.ceil((y0 + h) / minor);
  for (let j = j0; j <= j1; j++) {
    const seg = `M${x0} ${j * minor}H${x0 + w}`;
    if (j % per === 0) dMaj += seg; else dMin += seg;
  }
  return `<path class="svg-grid-minor" d="${dMin}"/><path class="svg-grid-major" d="${dMaj}"/>`;
}

const centroid = (pts) => [
  pts.reduce((a, p) => a + p[0], 0) / pts.length,
  pts.reduce((a, p) => a + p[1], 0) / pts.length,
];

function joistRect(j, width) {
  const dx = j.b[0] - j.a[0], dy = j.b[1] - j.a[1], L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * (width / 2), ny = (dx / L) * (width / 2);
  return [[j.a[0] + nx, j.a[1] + ny], [j.b[0] + nx, j.b[1] + ny], [j.b[0] - nx, j.b[1] - ny], [j.a[0] - nx, j.a[1] - ny]];
}

// the frame of edge boards for the editing view
function framePath(fp) {
  const ew = mm(fp.edgeWidth);
  if (!(ew > 0) || !E.isSimple(fp.pts)) return null;
  const inner = E.offsetPolygon(fp.pts, fp.pts.map((_, i) => (fp.edgeOn[i] !== false ? ew : 0)));
  if (!E.offsetIsValid(fp.pts, inner)) return null;
  return { d: pathOf(fp.pts) + pathOf(inner), inner };
}

function edgeLabels(fp, s) {
  const n = fp.pts.length;
  const sgn = E.polyArea2(fp.pts) > 0 ? 1 : -1;
  const fs = 11 / s;
  let out = '';
  for (let i = 0; i < n; i++) {
    const a = fp.pts[i], b = fp.pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const ox = (dy / L) * sgn, oy = (-dx / L) * sgn;   // outward normal
    const mx = (a[0] + b[0]) / 2 + ox * 16 / s, my = (a[1] + b[1]) / 2 + oy * 11 / s;
    const on = fp.edgeOn[i] !== false;
    out += `<text class="svg-lbl muted" x="${r2(mx)}" y="${r2(my)}" font-size="${r2(fs)}" stroke-width="${r2(3 / s)}">${i + 1}: ${fmtFtIn(L)}${on ? '' : ' · open'}</text>`;
  }
  return out;
}

function drawResults(s) {
  let h = '';
  const res = results;
  res.pieces.forEach((p, pi) => {
    const c = p.bin % 6;
    const dim = selBin != null && p.bin !== selBin ? ' dim' : '';
    h += `<g data-p="${pi}">`;
    for (const part of p.parts) h += `<polygon class="svg-pc c${c}${p.kind === 'edge' ? ' edge' : ''}${dim}" points="${pts2s(part)}"/>`;
    h += '</g>';
  });
  // joist centre lines over the boards
  state.footprints.forEach((fp) => {
    for (const j of fp.joists) {
      h += `<line x1="${r2(j.a[0])}" y1="${r2(j.a[1])}" x2="${r2(j.b[0])}" y2="${r2(j.b[1])}" stroke="var(--joist)" stroke-width="1" stroke-dasharray="5 4" opacity="0.7" vector-effect="non-scaling-stroke"/>`;
    }
  });
  // labels
  for (const p of res.pieces) {
    const width = p.width;
    const fs = Math.min(width * 0.55, 6);
    if (fs * s < 7) continue;
    if (p.length < p.label.length * fs * 0.7 * 1.25) continue;
    let best = p.parts[0];
    for (const part of p.parts) if (E.polyArea(part) > E.polyArea(best)) best = part;
    const [cx, cy] = centroid(best);
    let deg = (p.theta * 180) / Math.PI;
    deg = ((deg % 180) + 180) % 180;
    if (deg > 90) deg -= 180;
    const dim = selBin != null && p.bin !== selBin ? ' opacity="0.25"' : '';
    h += `<text class="svg-pc-lbl" x="${r2(cx)}" y="${r2(cy)}" font-size="${r2(fs)}" transform="rotate(${r2(deg)} ${r2(cx)} ${r2(cy)})"${dim}>${p.label}</text>`;
  }
  return h;
}

function draw() {
  measure();
  if (!size.w) return;
  const s = view.s;
  const w = size.w / s, hgt = size.h / s, x0 = view.cx - w / 2, y0 = view.cy - hgt / 2;
  svg.setAttribute('viewBox', `${r2(x0)} ${r2(y0)} ${r2(w)} ${r2(hgt)}`);
  svg.setAttribute('class', `deck-svg tool-${tool}`);

  let h = gridSvg(x0, y0, w, hgt, s);
  const showRes = !!results;
  const act = activeFp();

  state.footprints.forEach((fp) => {
    const isAct = fp === act;
    h += `<polygon class="svg-fp${isAct ? ' active' : ''}" points="${pts2s(fp.pts)}"/>`;
    if (!showRes) {
      const fr = framePath(fp);
      if (fr) h += `<path class="svg-frame" d="${fr.d}"/><polygon class="svg-inner" points="${pts2s(fr.inner)}"/>`;
    }
  });

  if (showRes) {
    h += drawResults(s);
  } else {
    state.footprints.forEach((fp) => {
      fp.joists.forEach((j, k) => {
        const w2 = mm(j.width) > 0 ? mm(j.width) : 1.5;
        const isSel = sel && sel.type === 'joist' && sel.fp === fp.id && sel.i === k;
        h += `<polygon class="svg-joist${isSel ? ' sel' : ''}" points="${pts2s(joistRect(j, w2))}"/>`;
      });
    });
    state.footprints.forEach((fp) => {
      const [cx, cy] = centroid(fp.pts);
      h += `<text class="svg-lbl" x="${r2(cx)}" y="${r2(cy)}" font-size="${r2(14 / s)}" stroke-width="${r2(3 / s)}">${esc(fp.name)}</text>`;
    });
    if (act) h += edgeLabels(act, s);

    // handles
    if (act && (tool === 'select' || tool === 'corner')) {
      act.pts.forEach((p, i) => {
        const isSel = sel && sel.type === 'vertex' && sel.fp === act.id && sel.i === i;
        h += `<circle class="svg-handle${isSel ? ' sel' : ''}" cx="${r2(p[0])}" cy="${r2(p[1])}" r="${r2(7 / s)}"/>`;
      });
      act.joists.forEach((j) => {
        for (const p of [j.a, j.b]) h += `<circle class="svg-handle" cx="${r2(p[0])}" cy="${r2(p[1])}" r="${r2(5 / s)}"/>`;
      });
    }
    // in-progress drawing
    if (tool === 'area' && drawing.length) {
      const line = hover ? [...drawing, hover] : drawing;
      h += `<polyline class="svg-draw" points="${pts2s(line)}"/>`;
      drawing.forEach((p, i) => { h += `<circle class="svg-handle${i === 0 ? ' sel' : ''}" cx="${r2(p[0])}" cy="${r2(p[1])}" r="${r2(6 / s)}"/>`; });
      if (hover && drawing.length) {
        const a = drawing[drawing.length - 1];
        const L = Math.hypot(hover[0] - a[0], hover[1] - a[1]);
        h += `<text class="svg-lbl" x="${r2((a[0] + hover[0]) / 2)}" y="${r2((a[1] + hover[1]) / 2 - 10 / s)}" font-size="${r2(12 / s)}" stroke-width="${r2(3 / s)}">${fmtFtIn(L)}</text>`;
      }
    }
    if (tool === 'joist' && joistStart) {
      if (hover) h += `<line class="svg-draw" x1="${r2(joistStart[0])}" y1="${r2(joistStart[1])}" x2="${r2(hover[0])}" y2="${r2(hover[1])}"/>`;
      h += `<circle class="svg-handle sel" cx="${r2(joistStart[0])}" cy="${r2(joistStart[1])}" r="${r2(6 / s)}"/>`;
    }
  }
  layers.innerHTML = h;
}

/* ---------------- geometry helpers for interaction ---------------- */

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function projectOnSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return [a[0] + dx * t, a[1] + dy * t];
}
const segDist = (p, a, b) => dist(p, projectOnSeg(p, a, b));

function snapPoint(w, o = {}) {
  const tol = 12 / view.s;
  let best = null, bd = tol;
  for (const fp of state.footprints) {
    fp.pts.forEach((p, i) => {
      if (o.skip && o.skip(fp, i)) return;
      const d = dist(p, w);
      if (d < bd) { bd = d; best = p; }
    });
  }
  if (best) return [best[0], best[1]];
  if (o.edgesOf) {
    let eb = null, ed = tol * 0.85;
    const n = o.edgesOf.pts.length;
    for (let i = 0; i < n; i++) {
      const a = o.edgesOf.pts[i], b = o.edgesOf.pts[(i + 1) % n];
      const pr = projectOnSeg(w, a, b), d = dist(pr, w);
      if (d < ed) { ed = d; eb = pr; }
    }
    if (eb) return eb;
  }
  const g = state.snap;
  return g > 0 ? [Math.round(w[0] / g) * g, Math.round(w[1] / g) * g] : [w[0], w[1]];
}

function hitTest(w) {
  const tolH = 14 / view.s;
  const act = activeFp();
  if (act) {
    for (let i = 0; i < act.pts.length; i++) if (dist(act.pts[i], w) < tolH) return { type: 'vertex', fp: act, i };
    for (let k = 0; k < act.joists.length; k++) {
      const j = act.joists[k];
      if (dist(j.a, w) < tolH) return { type: 'jend', fp: act, i: k, end: 'a' };
      if (dist(j.b, w) < tolH) return { type: 'jend', fp: act, i: k, end: 'b' };
    }
    for (let k = 0; k < act.joists.length; k++) {
      const j = act.joists[k], hw = Math.max((mm(j.width) || 1.5) / 2, 9 / view.s);
      if (segDist(w, j.a, j.b) < hw) return { type: 'joist', fp: act, i: k };
    }
  }
  for (let i = state.footprints.length - 1; i >= 0; i--) {
    const fp = state.footprints[i];
    if (E.pointInPoly(w, fp.pts)) return { type: 'body', fp };
  }
  return null;
}

/* ---------------- editing operations ---------------- */

function touch() {
  results = null;
  selBin = null;
  $('dResults').hidden = true;
  $('dError').hidden = true;
  $('dLegend').hidden = true;
  $('dPieceInfo').hidden = true;
  save();
  scheduleDraw();
}

let flashTimer = null;
function flash(msg) {
  const box = $('dError');
  box.textContent = msg;
  box.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { box.hidden = true; }, 6000);
}

function setActive(id, rerender = true) {
  state.active = id;
  if (rerender) { renderChips(); renderAreaCard(); }
  save();
}

function addFootprint(pts, name) {
  const fp = {
    id: state.nextId++,
    name: name || `Deck area ${state.footprints.length + 1}`,
    pts,
    edgeWidth: state.settings.boardW,
    edgeOn: pts.map(() => true),
    refEdge: 0,
    angle: '0',
    flip: false,
    joists: [],
  };
  state.footprints.push(fp);
  setActive(fp.id);
  touch();
  return fp;
}

function finishArea() {
  const pts = E.simplifyPoly(drawing);
  if (pts.length < 3) { flash('An area needs at least three corners.'); return; }
  if (!E.isSimple(pts)) { flash('The edges cross each other — undo a point or cancel and redraw.'); return; }
  if (E.polyArea(pts) < 1) { flash("Those corners don't enclose any area."); return; }
  drawing = [];
  addFootprint(pts);
  setTool('select');
}

function deleteVertex(fp, i) {
  if (fp.pts.length <= 3) { flash('An area needs at least three corners — delete the area instead.'); return; }
  fp.pts.splice(i, 1);
  fp.edgeOn.splice(i, 1);
  if (fp.refEdge > i) fp.refEdge--;
  fp.refEdge = Math.min(fp.refEdge, fp.pts.length - 1);
  sel = null;
}

function insertCorner(fp, w) {
  const tol = 14 / view.s, n = fp.pts.length;
  let bi = -1, bd = tol, bp = null;
  for (let i = 0; i < n; i++) {
    const pr = projectOnSeg(w, fp.pts[i], fp.pts[(i + 1) % n]), d = dist(pr, w);
    if (d < bd) { bd = d; bi = i; bp = pr; }
  }
  if (bi < 0) return false;
  const g = state.snap;
  let p = bp;
  if (g > 0) {
    const a = fp.pts[bi], b = fp.pts[(bi + 1) % n];
    const sp = [Math.round(bp[0] / g) * g, Math.round(bp[1] / g) * g];
    if (segDist(sp, a, b) < 0.01) p = sp;
  }
  fp.pts.splice(bi + 1, 0, p);
  fp.edgeOn.splice(bi + 1, 0, fp.edgeOn[bi]);
  if (fp.refEdge > bi) fp.refEdge++;
  sel = { type: 'vertex', fp: fp.id, i: bi + 1 };
  return true;
}

function deleteArea(fp) {
  state.footprints.splice(fpIndex(fp), 1);
  if (state.active === fp.id) state.active = state.footprints.length ? state.footprints[state.footprints.length - 1].id : null;
  sel = null;
  renderChips(); renderAreaCard(); renderActions();
  touch();
}

/* ---------------- pointer interaction ---------------- */

const pointers = new Map();
let gesture = null;
const TAP_PX = 6;

function setTool(t) {
  tool = t;
  drawing = []; joistStart = null; hover = null;
  document.querySelectorAll('#deckMain .tool[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  $('dHint').textContent = {
    select: 'Drag corners or joist ends to reshape, or drag an area to move it. Tap an area to edit its settings. Drag the background to pan; pinch or scroll to zoom.',
    area: 'Tap to place each corner (snaps to the grid and to existing corners). Tap the first corner, or press Finish, to close the shape.',
    joist: "Tap where the joist starts, then where it ends. Joists snap to the selected area's edges. For even spacing, use “Generate joists” below.",
    corner: 'Tap an edge of the selected area to add a corner there.',
  }[t];
  renderActions();
  scheduleDraw();
}
document.querySelectorAll('#deckMain .tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('dSnap').addEventListener('change', () => { state.snap = Number($('dSnap').value); save(); });

svg.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  svg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s0: view.s };
    return;
  }
  if (pointers.size > 2) return;
  const w = toWorld(e.clientX, e.clientY);
  const base = { sx: e.clientX, sy: e.clientY, cx0: view.cx, cy0: view.cy, moved: false, w0: w };

  if (results) {                      // viewing a layout: drag pans, tap picks a board
    gesture = { ...base, type: 'pan', tap: 'piece' };
    return;
  }
  if (tool === 'select') {
    const hit = hitTest(w);
    if (hit && hit.type === 'vertex') {
      sel = { type: 'vertex', fp: hit.fp.id, i: hit.i };
      gesture = { ...base, type: 'vertex', fp: hit.fp, i: hit.i };
      renderActions(); scheduleDraw(); return;
    }
    if (hit && hit.type === 'jend') {
      sel = { type: 'joist', fp: hit.fp.id, i: hit.i };
      gesture = { ...base, type: 'jend', fp: hit.fp, i: hit.i, end: hit.end };
      renderActions(); scheduleDraw(); return;
    }
    if (hit && hit.type === 'joist') {
      sel = { type: 'joist', fp: hit.fp.id, i: hit.i };
      const j = hit.fp.joists[hit.i];
      gesture = { ...base, type: 'joist', fp: hit.fp, i: hit.i, a: [...j.a], b: [...j.b] };
      renderActions(); scheduleDraw(); return;
    }
    if (hit && hit.type === 'body') {
      if (state.active !== hit.fp.id) { sel = null; setActive(hit.fp.id); renderActions(); }
      gesture = {
        ...base, type: 'body', fp: hit.fp,
        pts: hit.fp.pts.map((p) => [...p]),
        joists: hit.fp.joists.map((j) => ({ a: [...j.a], b: [...j.b], width: j.width })),
      };
      scheduleDraw(); return;
    }
    gesture = { ...base, type: 'pan', tap: 'clear' };
    return;
  }
  gesture = { ...base, type: 'pan', tap: tool };
});

svg.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  const w = toWorld(e.clientX, e.clientY);

  if (gesture && gesture.type === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const before = toWorld(mid[0], mid[1]);
    view.s = Math.min(MAX_S, Math.max(MIN_S, gesture.s0 * (d / gesture.d0)));
    const after = toWorld(mid[0], mid[1]);
    view.cx += before[0] - after[0];
    view.cy += before[1] - after[1];
    scheduleDraw();
    return;
  }
  if (!gesture) {
    if (tool === 'area' || tool === 'joist') {
      const act = activeFp();
      hover = snapPoint(w, tool === 'joist' && act ? { edgesOf: act } : {});
      if (drawing.length || joistStart) scheduleDraw();
    }
    return;
  }
  const dx = e.clientX - gesture.sx, dy = e.clientY - gesture.sy;
  if (!gesture.moved && Math.hypot(dx, dy) > TAP_PX) gesture.moved = true;
  if (!gesture.moved) return;

  switch (gesture.type) {
    case 'pan':
      view.cx = gesture.cx0 - dx / view.s;
      view.cy = gesture.cy0 - dy / view.s;
      break;
    case 'vertex': {
      const p = snapPoint(w, { skip: (f, i) => f === gesture.fp && i === gesture.i });
      gesture.fp.pts[gesture.i] = p;
      break;
    }
    case 'jend': {
      const p = snapPoint(w, { edgesOf: gesture.fp, skip: () => false });
      gesture.fp.joists[gesture.i][gesture.end] = p;
      break;
    }
    case 'joist': {
      const g = state.snap;
      let mx = w[0] - gesture.w0[0], my = w[1] - gesture.w0[1];
      if (g > 0) { mx = Math.round(mx / g) * g; my = Math.round(my / g) * g; }
      const j = gesture.fp.joists[gesture.i];
      j.a = [gesture.a[0] + mx, gesture.a[1] + my];
      j.b = [gesture.b[0] + mx, gesture.b[1] + my];
      break;
    }
    case 'body': {
      let mx = w[0] - gesture.w0[0], my = w[1] - gesture.w0[1];
      const g = state.snap;
      if (g > 0) { mx = Math.round(mx / g) * g; my = Math.round(my / g) * g; }
      // glue a corner onto a neighbouring area's corner when close
      const tol = 12 / view.s;
      let glued = false;
      for (const p of gesture.pts) {
        for (const other of state.footprints) {
          if (other === gesture.fp) continue;
          for (const q of other.pts) {
            if (!glued && Math.hypot(p[0] + mx - q[0], p[1] + my - q[1]) < tol) { mx = q[0] - p[0]; my = q[1] - p[1]; glued = true; }
          }
        }
      }
      gesture.fp.pts = gesture.pts.map((p) => [p[0] + mx, p[1] + my]);
      gesture.fp.joists = gesture.joists.map((j) => ({ a: [j.a[0] + mx, j.a[1] + my], b: [j.b[0] + mx, j.b[1] + my], width: j.width }));
      break;
    }
    default:
  }
  scheduleDraw();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (gesture && gesture.type === 'pinch') { if (pointers.size < 2) gesture = null; return; }
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (g.moved) {
    if (g.type !== 'pan') { results = null; touch(); renderAreaCard(); }
    return;
  }
  if (g.type !== 'pan') {           // a tap on a handle/body: selection already applied
    renderActions(); renderAreaCard(); scheduleDraw();
    return;
  }
  const w = toWorld(e.clientX, e.clientY);
  if (g.tap === 'clear') { sel = null; renderActions(); scheduleDraw(); }
  else if (g.tap === 'piece') pickPiece(w);
  else if (g.tap === 'area') tapArea(w);
  else if (g.tap === 'joist') tapJoist(w);
  else if (g.tap === 'corner') tapCorner(w);
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);
svg.addEventListener('pointerleave', () => { if (!gesture) { hover = null; if (drawing.length || joistStart) scheduleDraw(); } });
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });

function tapArea(w) {
  const p = snapPoint(w);
  if (drawing.length >= 3 && dist(p, drawing[0]) < 14 / view.s) { finishArea(); return; }
  if (drawing.length && dist(p, drawing[drawing.length - 1]) < 0.01) return;
  drawing.push(p);
  hover = p;
  renderActions();
  scheduleDraw();
}

function tapJoist(w) {
  const act = activeFp();
  if (!act) { flash('Select a deck area first (tap it), then draw its joists.'); return; }
  const p = snapPoint(w, { edgesOf: act });
  if (!joistStart) { joistStart = p; renderActions(); scheduleDraw(); return; }
  if (dist(p, joistStart) < 2) { flash('That joist is too short.'); return; }
  act.joists.push({ a: joistStart, b: p, width: state.settings.joistWidth });
  joistStart = null;
  renderActions(); renderAreaCard();
  touch();
}

function tapCorner(w) {
  const act = activeFp();
  if (!act) { flash('Select a deck area first (tap it).'); return; }
  if (insertCorner(act, w)) { renderAreaCard(); renderActions(); touch(); }
  else flash('Tap closer to an edge of the selected area.');
}

function pickPiece(w) {
  for (let i = results.pieces.length - 1; i >= 0; i--) {
    const p = results.pieces[i];
    if (p.parts.some((part) => E.pointInPoly(w, part))) { showPiece(i); return; }
  }
  selBin = null;
  $('dPieceInfo').hidden = true;
  scheduleDraw();
}

document.addEventListener('keydown', (e) => {
  if ($('deckPanel').hidden) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.key === 'Escape') { drawing = []; joistStart = null; renderActions(); scheduleDraw(); }
  else if (e.key === 'Enter' && tool === 'area' && drawing.length >= 3) finishArea();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { deleteSelected(); e.preventDefault(); }
});

function deleteSelected() {
  if (!sel) return;
  const fp = fpById(sel.fp);
  if (!fp) { sel = null; return; }
  if (sel.type === 'vertex') deleteVertex(fp, sel.i);
  else { fp.joists.splice(sel.i, 1); sel = null; }
  renderActions(); renderAreaCard();
  touch();
}

/* ---------------- toolbar actions, chips, quick rectangle ---------------- */

function renderActions() {
  const box = $('dActions');
  const btns = [];
  if (tool === 'area' && drawing.length) {
    btns.push(['finish', 'Finish area', drawing.length < 3]);
    btns.push(['undo', 'Undo point']);
    btns.push(['cancel', 'Cancel']);
  } else if (tool === 'joist' && joistStart) {
    btns.push(['cancel', 'Cancel joist']);
  }
  if (sel && !results) {
    btns.push(['delsel', sel.type === 'vertex' ? 'Delete selected corner' : 'Delete selected joist', false, 'danger']);
  }
  box.innerHTML = btns.map(([k, label, dis, cls]) => `<button type="button" data-a="${k}" class="${cls || ''}"${dis ? ' disabled' : ''}>${label}</button>`).join('');
}
$('dActions').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const a = b.dataset.a;
  if (a === 'finish') finishArea();
  else if (a === 'undo') { drawing.pop(); renderActions(); scheduleDraw(); }
  else if (a === 'cancel') { drawing = []; joistStart = null; renderActions(); scheduleDraw(); }
  else if (a === 'delsel') deleteSelected();
});

function renderChips() {
  const box = $('dChips');
  if (!state.footprints.length) { box.innerHTML = '<span class="hint" style="margin:0">No deck areas yet — add a rectangle below or use “Draw area”.</span>'; return; }
  box.innerHTML = state.footprints
    .map((f) => `<button type="button" class="chip" data-id="${f.id}" aria-pressed="${f.id === state.active}">${esc(f.name)}</button>`)
    .join('');
}
$('dChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  sel = null;
  setActive(Number(b.dataset.id));
  renderActions();
  scheduleDraw();
});

$('dRectAdd').addEventListener('click', () => {
  const w = mm($('dRectW').value), d = mm($('dRectD').value);
  if (!(w > 0) || !(d > 0)) { flash("Enter the rectangle's width and depth in inches, or in feet with a ′ — e.g. 192 and 144, or 16' and 12'."); return; }
  const [x0, y0, x1] = bounds();
  const ox = state.footprints.length ? x1 + 24 : 0;
  const oy = state.footprints.length ? y0 : 0;
  addFootprint([[ox, oy], [ox + w, oy], [ox + w, oy + d], [ox, oy + d]]);
  $('dRectW').value = ''; $('dRectD').value = '';
  fit();
});

/* ---------------- area settings card ---------------- */

function renderAreaCard() {
  const card = $('dAreaCard');
  const fp = activeFp();
  if (!fp) { card.hidden = true; card.innerHTML = ''; return; }
  card.hidden = false;
  const n = fp.pts.length;
  const edges = fp.pts.map((p, i) => {
    const q = fp.pts[(i + 1) % n];
    const len = dist(p, q);
    return `<div class="edge-row"><span>Edge ${i + 1}</span>` +
      `<input type="text" inputmode="decimal" autocomplete="off" data-edge-len="${i}" value="${esc(fmtFtIn(len))}" aria-label="Edge ${i + 1} length">` +
      `<label class="tog"><input type="checkbox" data-edge-on="${i}"${fp.edgeOn[i] !== false ? ' checked' : ''}> edge board</label></div>`;
  }).join('');
  const refOpts = fp.pts.map((_, i) => `<option value="${i}"${i === fp.refEdge ? ' selected' : ''}>Edge ${i + 1}</option>`).join('');
  const joists = fp.joists.map((j, k) =>
    `<div class="joist-row"><span>Joist ${k + 1} · ${fmtFtIn(dist(j.a, j.b))}</span>` +
    `<input type="text" inputmode="decimal" autocomplete="off" data-joist-w="${k}" value="${esc(j.width)}" aria-label="Joist ${k + 1} width (in)">` +
    `<button type="button" class="del" data-del-joist="${k}" aria-label="Remove joist">×</button></div>`).join('');

  card.innerHTML =
    `<div class="card-head"><h2>${esc(fp.name)} — settings</h2><button type="button" class="btn-link" data-act="del-area">Delete area</button></div>` +
    `<div class="area-grid">` +
    `<label class="cell"><span>Name</span><input type="text" autocomplete="off" data-f="name" value="${esc(fp.name)}"></label>` +
    `<label class="cell"><span>Edge board width (in)</span><input type="text" inputmode="decimal" autocomplete="off" data-f="edgeWidth" value="${esc(fp.edgeWidth)}"></label>` +
    `</div>` +
    `<p class="hint">Edge boards frame the area with mitred corners. Switch an edge off below where it meets the house or another area.</p>` +
    `<h3>Board direction</h3>` +
    `<div class="area-grid">` +
    `<label class="cell"><span>Measured from</span><select class="field" data-f="refEdge">${refOpts}</select></label>` +
    `<label class="cell"><span>Angle (°)</span><input type="text" inputmode="decimal" autocomplete="off" data-f="angle" value="${esc(fp.angle)}"></label>` +
    `</div>` +
    `<div class="presets">` +
    `<button type="button" data-preset="0">Parallel to edge</button><button type="button" data-preset="90">Perpendicular</button>` +
    `<button type="button" data-preset="45">45°</button><button type="button" data-preset="-45">−45°</button></div>` +
    `<label class="toggle"><input type="checkbox" data-f="flip"${fp.flip ? ' checked' : ''}><span>Start rows from the opposite side</span></label>` +
    `<h3>Edges</h3><div class="edge-list">${edges}</div>` +
    `<h3>Joists</h3>` +
    `<p class="hint">Board ends are cut to land on joist centrelines, so the joists matter. Generated joists run perpendicular to the boards.</p>` +
    `<div class="area-grid">` +
    `<label class="cell"><span>Spacing, centre to centre (in)</span><input type="text" inputmode="decimal" autocomplete="off" data-js="joistSpacing" value="${esc(state.settings.joistSpacing)}"></label>` +
    `<label class="cell"><span>Joist width (in)</span><input type="text" inputmode="decimal" autocomplete="off" data-js="joistWidth" value="${esc(state.settings.joistWidth)}"></label>` +
    `</div>` +
    `<div class="actions"><button type="button" data-act="gen-joists">Generate joists</button>` +
    (fp.joists.length ? `<button type="button" data-act="clear-joists" class="danger">Remove all joists</button>` : '') + `</div>` +
    `<div class="joist-list">${joists}</div>`;
}

const areaCard = $('dAreaCard');
areaCard.addEventListener('input', (e) => {
  const fp = activeFp();
  if (!fp) return;
  const t = e.target;
  if (t.dataset.f && t.type !== 'checkbox' && t.tagName !== 'SELECT') {
    fp[t.dataset.f] = t.value;
    if (t.dataset.f === 'name') renderChips();
    touch();
  } else if (t.dataset.joistW != null) {
    fp.joists[Number(t.dataset.joistW)].width = t.value;
    touch();
  } else if (t.dataset.js) {
    state.settings[t.dataset.js] = t.value;
    save();
  }
});
areaCard.addEventListener('change', (e) => {
  const fp = activeFp();
  if (!fp) return;
  const t = e.target;
  if (t.dataset.f === 'refEdge') { fp.refEdge = Number(t.value); touch(); }
  else if (t.dataset.f === 'flip') { fp.flip = t.checked; touch(); }
  else if (t.dataset.edgeOn != null) { fp.edgeOn[Number(t.dataset.edgeOn)] = t.checked; touch(); }
  else if (t.dataset.edgeLen != null) {
    const i = Number(t.dataset.edgeLen), len = mm(t.value);
    if (!(len > 0)) { flash('Enter a valid edge length.'); renderAreaCard(); return; }
    const a = fp.pts[i], j = (i + 1) % fp.pts.length, b = fp.pts[j];
    const cur = dist(a, b);
    const ux = cur > 1e-9 ? (b[0] - a[0]) / cur : 1, uy = cur > 1e-9 ? (b[1] - a[1]) / cur : 0;
    fp.pts[j] = [a[0] + ux * len, a[1] + uy * len];
    renderAreaCard();
    touch();
  }
});
areaCard.addEventListener('click', (e) => {
  const fp = activeFp();
  const b = e.target.closest('button');
  if (!fp || !b) return;
  if (b.dataset.preset != null) { fp.angle = b.dataset.preset; renderAreaCard(); touch(); }
  else if (b.dataset.delJoist != null) { fp.joists.splice(Number(b.dataset.delJoist), 1); sel = null; renderAreaCard(); renderActions(); touch(); }
  else if (b.dataset.act === 'del-area') { if (confirm(`Delete “${fp.name}” and its joists?`)) deleteArea(fp); }
  else if (b.dataset.act === 'clear-joists') { fp.joists = []; sel = null; renderAreaCard(); renderActions(); touch(); }
  else if (b.dataset.act === 'gen-joists') {
    const spacing = mm(state.settings.joistSpacing), width = mm(state.settings.joistWidth);
    if (!(spacing > 0) || !(width > 0)) { flash('Enter a joist spacing and width first.'); return; }
    if (!E.isSimple(fp.pts)) { flash('Fix the area outline first — its edges cross.'); return; }
    if (fp.joists.length && !confirm('Replace this area’s existing joists?')) return;
    const model = buildModel().model.footprints[fpIndex(fp)];
    const gen = E.generateJoists({ ...model, joists: [] }, spacing, width);
    fp.joists = gen.map((j) => ({ a: j.a, b: j.b, width: state.settings.joistWidth }));
    sel = null;
    renderAreaCard(); renderActions();
    touch();
  }
});

/* ---------------- calculate + results ---------------- */

function showErrors(list) {
  const box = $('dError');
  clearTimeout(flashTimer);
  box.textContent = list.join('\n');
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function calculate() {
  $('dError').hidden = true;
  const { errors, model, waste } = buildModel();
  if (errors.length) { results = null; $('dResults').hidden = true; showErrors(errors); return; }
  const res = E.solve(model);
  if (res.errors.length) { results = null; $('dResults').hidden = true; showErrors(res.errors); return; }
  results = res;
  res.waste = waste;
  selBin = null;
  sel = null;
  renderActions();
  renderResults(res, model);
  draw();
  $('dLayoutCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('dCalc').addEventListener('click', calculate);

const letter = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');

function renderResults(res, model) {
  const st = res.stats;
  const extra = 1 + (res.waste || 0) / 100;
  $('dResults').hidden = false;

  const byLen = new Map();
  for (const b of res.bins) {
    const e = byLen.get(b.stock.length) || { stock: b.stock, qty: 0 };
    e.qty++;
    byLen.set(b.stock.length, e);
  }
  const lines = [...byLen.values()].sort((a, b) => b.stock.length - a.stock.length);
  const buyQty = (q) => (res.waste > 0 ? Math.ceil(q * extra - 1e-9) : q);
  const costBuy = res.priced ? lines.reduce((a, l) => a + buyQty(l.qty) * l.stock.price, 0) : 0;

  const tiles = [];
  if (res.priced) tiles.push([money(st.cost), 'Cost (exact)']);
  tiles.push(
    [String(st.boards), 'Boards (exact)'],
    [String(lines.reduce((a, l) => a + buyQty(l.qty), 0)), `Boards to buy (+${res.waste || 0}%)`],
    [`${r2(st.deckArea / 144)} sq ft`, 'Deck surface'],
    [`${Math.round((st.cutLen / st.boughtLen) * 100)}%`, 'Of purchased length used'],
  );
  if (res.priced && res.waste > 0) tiles.splice(1, 0, [money(costBuy), `Cost with +${res.waste}%`]);
  $('dStats').innerHTML = tiles.map(([v, k]) => `<div class="stat"><span class="v">${v}</span><span class="k">${k}</span></div>`).join('');

  const warn = $('dWarn');
  warn.hidden = !res.warnings.length;
  warn.textContent = res.warnings.join('\n');

  const head = res.priced
    ? '<th>Length</th><th>Exact</th><th>Buy</th><th>Each</th><th>Total</th>'
    : '<th>Length</th><th>Exact</th><th>Buy</th>';
  const body = lines.map((l) => {
    const q = buyQty(l.qty);
    return res.priced
      ? `<tr><td>${fmtFtIn(l.stock.length)}</td><td>${l.qty}</td><td>${q}</td><td>${money(l.stock.price)}</td><td>${money(q * l.stock.price)}</td></tr>`
      : `<tr><td>${fmtFtIn(l.stock.length)}</td><td>${l.qty}</td><td>${q}</td></tr>`;
  }).join('');
  const foot = res.priced
    ? `<tfoot><tr><td>Total</td><td>${st.boards}</td><td>${lines.reduce((a, l) => a + buyQty(l.qty), 0)}</td><td></td><td>${money(costBuy)}</td></tr></tfoot>`
    : '';
  $('dShopping').innerHTML = `<table class="shop-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;

  // one bar per purchased board
  $('dCutPlan').innerHTML = res.bins.map((b, bi) => {
    const c = bi % 6;
    const segs = [];
    b.cuts.forEach((pi, k) => {
      const p = res.pieces[pi];
      if (k > 0 && model.kerf > 0) segs.push('<div class="seg seg-kerf"></div>');
      segs.push(`<div class="seg seg-cut c${c}" style="flex-grow:${p.length}" title="${p.label}: ${fmtFtIn(p.length)}"><div class="piece">${p.label} · ${fmtFtIn(p.length)}</div></div>`);
    });
    if (b.waste > 0.01) segs.push(`<div class="seg seg-left" style="flex-grow:${b.waste}" title="offcut ${fmtFtIn(b.waste)}">${fmtFtIn(b.waste)}</div>`);
    return `<div class="board" data-bin="${bi}"><div class="board-title"><strong>#${bi + 1}</strong> · ${fmtFtIn(b.stock.length)} board</div>` +
      `<div class="bar">${segs.join('')}</div></div>`;
  }).join('');

  const bw = model.boardWidth;
  const rows = res.pieces.map((p, pi) => {
    const notes = [];
    if (p.kind === 'edge') notes.push('edge board');
    if (p.kind === 'deck' && p.width < bw - 0.01) notes.push(`rip to ${fmtFtIn(p.width)}`);
    if (p.area < p.length * p.width * 0.995) notes.push('angled / notched end');
    return `<tr data-piece="${pi}"><td>${p.label}</td><td>${esc(model.footprints[p.fp].name)}</td><td>${fmtFtIn(p.length)}</td><td>#${p.bin + 1}</td><td>${notes.join(', ')}</td></tr>`;
  }).join('');
  $('dPieces').innerHTML = `<table><thead><tr><th>Piece</th><th>Area</th><th>Length</th><th>From board</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;

  const legend = $('dLegend');
  legend.hidden = false;
  legend.innerHTML = model.footprints.map((f, i) => `<span><strong>${letter(i)}</strong> = ${esc(f.name)}</span>`).join('') +
    '<span>“e” = edge board</span><span>Tap a board in the drawing to see its cuts</span>';
}

function showPiece(pi) {
  const p = results.pieces[pi];
  const b = results.bins[p.bin];
  selBin = p.bin;
  const cuts = b.cuts.map((i) => `${results.pieces[i].label} ${fmtFtIn(results.pieces[i].length)}`).join(' + ');
  const info = $('dPieceInfo');
  info.hidden = false;
  info.innerHTML = `<strong>${p.label}</strong> — ${fmtFtIn(p.length)} long × ${fmtFtIn(p.width)} wide, from board <strong>#${p.bin + 1}</strong> (${fmtFtIn(b.stock.length)}).<br>` +
    `That board is cut into: ${cuts}${b.waste > 0.01 ? `, leaving ${fmtFtIn(b.waste)}` : ''}.`;
  scheduleDraw();
}
$('dCutPlan').addEventListener('click', (e) => {
  const el = e.target.closest('.board');
  if (!el || !results) return;
  selBin = Number(el.dataset.bin);
  $('dPieceInfo').hidden = true;
  scheduleDraw();
  $('dLayoutCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('dPieces').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-piece]');
  if (!tr || !results) return;
  showPiece(Number(tr.dataset.piece));
  $('dLayoutCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('dClear').addEventListener('click', () => {
  if (!confirm('Remove all deck areas and joists? Your board settings are kept.')) return;
  state.footprints = [];
  state.active = null;
  sel = null; drawing = []; joistStart = null;
  renderChips(); renderAreaCard(); renderActions();
  touch();
  fit();
});

/* ---------------- boot ---------------- */

function onDeckShown() {
  measure();
  if (!deckShownOnce) { deckShownOnce = true; fit(); } else draw();
}

if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (!$('deckPanel').hidden) scheduleDraw(); }).observe(svg);
addEventListener('resize', () => { if (!$('deckPanel').hidden) scheduleDraw(); });

$('dSnap').value = String(state.snap);
if (!fpById(state.active)) state.active = state.footprints.length ? state.footprints[0].id : null;
renderStock();
renderChips();
renderAreaCard();
setTool('select');
showTab(startTab, false);

// for tests / debugging
window.DeckPlanner = { state: () => state, results: () => results, calculate };
})();
