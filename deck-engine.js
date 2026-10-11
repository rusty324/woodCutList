/* Deck layout engine — pure geometry + packing, no DOM.
 *
 * All lengths are inches. A footprint is a simple polygon; boards are laid in
 * rows at an angle relative to one of its edges. Rows are clipped to the
 * polygon, each resulting run is split into pieces whose butt joints land on
 * joist centerlines (when joists exist), and all pieces are then packed into
 * purchasable stock lengths so offcuts get reused.
 */
(function (root) {
'use strict';

const EPS = 1e-6;
const MARGIN = 2;        // seams stay at least this far from a run's end
const FREE_STEP = 1;     // spacing of candidate seams when no joist is available

/* ---------------- polygon basics ---------------- */

const polyArea2 = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
};
const polyArea = (pts) => Math.abs(polyArea2(pts)) / 2;

const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSeg = (a, b, c) =>
  Math.min(a[0], b[0]) - EPS <= c[0] && c[0] <= Math.max(a[0], b[0]) + EPS &&
  Math.min(a[1], b[1]) - EPS <= c[1] && c[1] <= Math.max(a[1], b[1]) + EPS;

function segsCross(p1, p2, p3, p4) {
  const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
      ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
  return (Math.abs(o1) <= EPS && onSeg(p1, p2, p3)) || (Math.abs(o2) <= EPS && onSeg(p1, p2, p4)) ||
         (Math.abs(o3) <= EPS && onSeg(p3, p4, p1)) || (Math.abs(o4) <= EPS && onSeg(p3, p4, p2));
}

function isSimple(pts) {
  const n = pts.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

function pointInPoly(pt, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
        pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// drop repeated points and corners that are really straight lines
function simplifyPoly(pts, tol = 0.01) {
  let p = pts.map((q) => [q[0], q[1]]);
  let changed = true;
  while (changed && p.length > 2) {
    changed = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
      const ac = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const dup = Math.hypot(b[0] - a[0], b[1] - a[1]) < tol;
      const straight = ac > tol && Math.abs(orient(a, c, b)) / ac < tol;
      if (dup || straight) { p.splice(i, 1); changed = true; break; }
    }
  }
  return p;
}

/* Offset a polygon inward, edge i by d[i], joining neighbours with miters. */
function offsetPolygon(pts, d) {
  const n = pts.length;
  const sgn = polyArea2(pts) > 0 ? 1 : -1;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    let dx = q[0] - p[0], dy = q[1] - p[1];
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    const nx = -dy * sgn, ny = dx * sgn;
    return { p: [p[0] + nx * d[i], p[1] + ny * d[i]], d: [dx, dy] };
  });
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = lines[(j + n - 1) % n], b = lines[j];
    const cr = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    if (Math.abs(cr) < 1e-9) { out.push([b.p[0], b.p[1]]); continue; }
    const wx = b.p[0] - a.p[0], wy = b.p[1] - a.p[1];
    const t = (wx * b.d[1] - wy * b.d[0]) / cr;
    out.push([a.p[0] + a.d[0] * t, a.p[1] + a.d[1] * t]);
  }
  return out;
}

// an offset is only usable if no edge collapsed or flipped and it stays simple
function offsetIsValid(orig, off) {
  const n = orig.length;
  const a0 = polyArea2(orig), a1 = polyArea2(off);
  if (a0 * a1 <= 0 || Math.abs(a1) < 1) return false;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const o = [orig[j][0] - orig[i][0], orig[j][1] - orig[i][1]];
    const f = [off[j][0] - off[i][0], off[j][1] - off[i][1]];
    if (o[0] * f[0] + o[1] * f[1] <= 0) return false;
  }
  return isSimple(off);
}

/* Board frame: u runs along the boards, v across them (row 0 at the lowest v). */
function makeFrame(theta, flip) {
  const c = Math.cos(theta), s = Math.sin(theta), sg = flip ? -1 : 1;
  return {
    theta,
    u: (p) => p[0] * c + p[1] * s,
    v: (p) => sg * (-p[0] * s + p[1] * c),
    toXY: (u, v) => { const vv = sg * v; return [u * c - vv * s, u * s + vv * c]; },
  };
}

/* ---------------- band decomposition ---------------- */

// Intersect a polygon (already in u,v) with the band v0..v1. Returns connected
// components, each a union of trapezoids stacked between polygon vertices.
function bandComponents(uv, v0, v1) {
  const n = uv.length;
  const cuts = [v0, v1];
  for (const p of uv) if (p[1] > v0 + EPS && p[1] < v1 - EPS) cuts.push(p[1]);
  cuts.sort((a, b) => a - b);
  const vs = [];
  for (const c of cuts) if (!vs.length || c - vs[vs.length - 1] > EPS) vs.push(c);

  const traps = [];
  const levels = [];
  for (let k = 0; k + 1 < vs.length; k++) {
    const va = vs[k], vb = vs[k + 1], vm = (va + vb) / 2;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = uv[i], b = uv[(i + 1) % n];
      const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
      if (hi - lo < EPS || lo > va + EPS || hi < vb - EPS) continue;
      const at = (v) => a[0] + ((b[0] - a[0]) * (v - a[1])) / (b[1] - a[1]);
      xs.push([at(vm), at(va), at(vb)]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    const start = traps.length;
    for (let j = 0; j + 1 < xs.length; j += 2) {
      const t = { va, vb, uLa: xs[j][1], uRa: xs[j + 1][1], uLb: xs[j][2], uRb: xs[j + 1][2] };
      if (((t.uRa - t.uLa) + (t.uRb - t.uLb)) * (vb - va) < 1e-9) continue;
      traps.push(t);
    }
    levels.push([start, traps.length]);
  }

  const parent = traps.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let k = 0; k + 1 < levels.length; k++) {
    for (let a = levels[k][0]; a < levels[k][1]; a++) {
      for (let b = levels[k + 1][0]; b < levels[k + 1][1]; b++) {
        const ov = Math.min(traps[a].uRb, traps[b].uRa) - Math.max(traps[a].uLb, traps[b].uLa);
        if (ov > 1e-6) parent[find(a)] = find(b);
      }
    }
  }
  const groups = new Map();
  traps.forEach((t, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  });
  const comps = [];
  for (const ts of groups.values()) {
    let umin = Infinity, umax = -Infinity, area = 0;
    for (const t of ts) {
      t.tmin = Math.min(t.uLa, t.uLb);
      t.tmax = Math.max(t.uRa, t.uRb);
      umin = Math.min(umin, t.tmin);
      umax = Math.max(umax, t.tmax);
      area += ((t.uRa - t.uLa) + (t.uRb - t.uLb)) / 2 * (t.vb - t.va);
    }
    if (area > 0.01) comps.push({ traps: ts, umin, umax, area, union: chainUnion(ts), poly: uv, v0, v1 });
  }
  comps.sort((a, b) => a.umin - b.umin);
  return comps;
}

// Stacked trapezoids that form a single chain merge into one outline, so a board
// that crosses a corner is drawn as one board rather than several slices.
function chainUnion(traps) {
  const ts = [...traps].sort((a, b) => a.va - b.va);
  for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i].va - ts[i - 1].vb) > 1e-6) return null;
  const pts = [];
  for (const t of ts) pts.push([t.uLa, t.va], [t.uLb, t.vb]);
  for (let i = ts.length - 1; i >= 0; i--) pts.push([ts[i].uRb, ts[i].vb], [ts[i].uRa, ts[i].va]);
  const u = simplifyPoly(pts, 1e-7);
  return u.length >= 3 ? u : null;
}

// length of the board needed to cover the part of `comp` between u=ua and u=ub
function extentOf(comp, ua, ub) {
  let lo = Infinity, hi = -Infinity;
  for (const t of comp.traps) {
    const a = Math.max(ua, t.tmin), b = Math.min(ub, t.tmax);
    if (b > a + 1e-9) { if (a < lo) lo = a; if (b > hi) hi = b; }
  }
  return hi > lo ? hi - lo : 0;
}

// the actual outline(s) of that piece, back in plan coordinates
// Sutherland–Hodgman against one half-plane (axis 0 = u, 1 = v)
function clipHalf(poly, axis, lim, keepGreater) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const pin = keepGreater ? p[axis] >= lim - 1e-9 : p[axis] <= lim + 1e-9;
    const qin = keepGreater ? q[axis] >= lim - 1e-9 : q[axis] <= lim + 1e-9;
    if (pin) out.push(p);
    if (pin !== qin) {
      const f = (lim - p[axis]) / (q[axis] - p[axis]);
      out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
    }
  }
  return out;
}

function clipParts(comp, ua, ub, frame) {
  const slab = (poly) => {
    for (const [lim, keepGreater] of [[ua, true], [ub, false]]) {
      poly = clipHalf(poly, 0, lim, keepGreater);
      if (poly.length < 3) return null;
    }
    return polyArea(poly) > 1e-4 ? poly : null;
  };
  let shapes;
  if (comp.union) {
    shapes = [comp.union];
  } else {
    const slices = comp.traps.map((t) => [[t.uLa, t.va], [t.uRa, t.va], [t.uRb, t.vb], [t.uLb, t.vb]]);
    shapes = slices;
    // a branching board (e.g. notched between two legs): trace its true outline,
    // trusting it only if the area agrees with the sum of the slices
    if (comp.poly && slices.length > 1) {
      let whole = comp.poly;
      for (const [axis, lim, g] of [[1, comp.v0, true], [1, comp.v1, false], [0, ua, true], [0, ub, false]]) {
        whole = clipHalf(whole, axis, lim, g);
        if (whole.length < 3) break;
      }
      const expect = slices.reduce((a, q) => a + (slab(q) ? polyArea(slab(q)) : 0), 0);
      if (whole.length >= 3 && Math.abs(polyArea(whole) - expect) <= 1e-6 * Math.max(1, expect)) {
        return polyArea(whole) > 1e-4 ? [whole.map(([u, v]) => frame.toXY(u, v))] : [];
      }
    }
  }
  const parts = [];
  for (const sh of shapes) {
    const poly = slab(sh);
    if (poly) parts.push(poly.map(([u, v]) => frame.toXY(u, v)));
  }
  return parts;
}

/* ---------------- seam planning ---------------- */

// where joists cross the centre line of a run, in board coordinates
function joistCandidates(joists, frame, vc) {
  const out = [];
  for (const j of joists) {
    const ua = frame.u(j.a), va = frame.v(j.a), ub = frame.u(j.b), vb = frame.v(j.b);
    const len = Math.hypot(ub - ua, vb - va), dv = vb - va;
    if (len < 1 || Math.abs(dv) / len < 0.1) continue;   // (nearly) parallel to the boards
    const t = (vc - va) / dv, tol = 3 / len;
    if (t < -tol || t > 1 + tol) continue;
    out.push(ua + t * (ub - ua));
  }
  out.sort((a, b) => a - b);
  return out.filter((p, i) => i === 0 || p - out[i - 1] > 0.25);
}

const STRATEGIES = ['greedy', 'balanced', 'stock'];

/* Split one run into pieces. A DP over candidate seam positions: boards may be
   at most `Lmax` long, and each strategy scores the split differently.
     greedy   – fewest boards, uneven (long boards + a short remainder)
     balanced – fewest boards, as even as possible
     stock    – minimise waste against the purchasable lengths
   Seams that sit on the same joist as a seam in the previous row are penalised
   so end joints stagger. */
function partitionRun(comp, cands, ctx) {
  const { Lmax, gap, strategy, prevSeams, hasJoists, stockLens } = ctx;
  const s = comp.umin, e = comp.umax, hg = gap / 2;

  if (extentOf(comp, s, e) <= Lmax + EPS) {
    return { segs: [{ ua: s, ub: e, len: extentOf(comp, s, e) }], seams: [], unsupported: 0 };
  }

  const wasteFor = (len) => {
    for (const L of stockLens) if (L >= len - EPS) return L - len;
    return 1e5;
  };
  const stock = strategy === 'stock';
  const pieceCost = (len) =>
    strategy === 'greedy' ? 1e6 - 1e-3 * len * len
      : strategy === 'balanced' ? 1e6 + 1e-3 * len * len
        : 40 + wasteFor(len);
  const unsupportedPen = stock ? 1e4 : 1e7;
  const conflictPen = stock ? 25 : 1e4;
  const tol = hasJoists ? 3 : 16;

  const attempt = (nodes) => {
    const m = nodes.length;
    const best = new Array(m).fill(Infinity), prev = new Array(m).fill(-1);
    best[0] = 0;
    const nodePen = nodes.map((nd, j) => {
      if (j === m - 1 || nd.kind === 'end') return 0;
      let pen = nd.kind === 'free' ? unsupportedPen : 0;
      if (prevSeams.some((p) => Math.abs(p - nd.pos) < tol)) pen += conflictPen;
      return pen;
    });
    for (let i = 0; i < m - 1; i++) {
      if (best[i] === Infinity) continue;
      const ua = nodes[i].pos + (i > 0 ? hg : 0);
      for (let j = i + 1; j < m; j++) {
        const ub = nodes[j].pos - (j < m - 1 ? hg : 0);
        if (ub <= ua) continue;
        const len = extentOf(comp, ua, ub);
        if (len > Lmax + EPS) break;
        if (len <= 0) continue;
        const c = best[i] + pieceCost(len) + nodePen[j];
        if (c < best[j]) { best[j] = c; prev[j] = i; }
      }
    }
    if (best[m - 1] === Infinity) return null;
    const segs = [], seams = [];
    let unsupported = 0;
    for (let j = m - 1; j > 0; j = prev[j]) {
      const i = prev[j];
      const ua = nodes[i].pos + (i > 0 ? hg : 0);
      const ub = nodes[j].pos - (j < m - 1 ? hg : 0);
      segs.unshift({ ua, ub, len: extentOf(comp, ua, ub) });
      if (j < m - 1) { seams.push(nodes[j].pos); if (nodes[j].kind === 'free' && hasJoists) unsupported++; }
    }
    return { segs, seams, unsupported };
  };

  const ends = (mid) => [{ pos: s, kind: 'end' }, ...mid, { pos: e, kind: 'end' }];
  const joistNodes = cands
    .filter((p) => p > s + MARGIN && p < e - MARGIN)
    .map((p) => ({ pos: p, kind: 'joist' }));
  if (hasJoists && joistNodes.length) {
    const r = attempt(ends(joistNodes));
    if (r) return r;
  }
  const free = [];
  for (let p = s + MARGIN; p < e - MARGIN; p += FREE_STEP) free.push({ pos: p, kind: 'free' });
  const all = [...joistNodes, ...free].sort((a, b) => a.pos - b.pos);
  return attempt(ends(all));
}

/* ---------------- packing ---------------- */

function pack(pieces, stock, kerf, priced) {
  const opts = [...stock].sort((a, b) => a.length - b.length);
  const metric = (st) => (priced ? st.price : st.length);
  let remaining = pieces.map((p, i) => ({ i, len: p.length })).sort((a, b) => b.len - a.len);
  const bins = [];
  while (remaining.length) {
    let best = null;
    for (const st of opts) {
      let used = 0;
      const taken = [];
      for (const it of remaining) {
        const need = taken.length ? kerf + it.len : it.len;
        if (used + need <= st.length + EPS) { taken.push(it); used += need; }
      }
      if (!taken.length) continue;
      const score = metric(st) / used;
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && used > best.used)) {
        best = { st, taken, used, score };
      }
    }
    if (!best) return null;
    bins.push({ stock: best.st, items: best.taken.map((t) => t.i), used: best.used });
    const gone = new Set(best.taken.map((t) => t.i));
    remaining = remaining.filter((it) => !gone.has(it.i));
  }
  // shrink each board to the cheapest stock that still holds its cuts
  for (const b of bins) {
    const fit = opts.filter((st) => st.length >= b.used - EPS);
    fit.sort((a, c) => metric(a) - metric(c) || a.length - c.length);
    b.stock = fit[0];
  }
  return bins;
}

/* ---------------- solve ---------------- */

const ang = (deg) => (deg * Math.PI) / 180;

function prepareFootprint(fp, idx, S, errors) {
  const name = fp.name || `Area ${idx + 1}`;
  const pts = fp.pts;
  const n = pts.length;
  if (n < 3) { errors.push(`${name}: needs at least three corners.`); return null; }
  if (!isSimple(pts)) { errors.push(`${name}: its edges cross each other — redraw the outline.`); return null; }
  if (Math.abs(polyArea2(pts)) < 1) { errors.push(`${name}: its corners don't enclose any area.`); return null; }

  const ew = fp.edgeWidth > 0 ? fp.edgeWidth : 0;
  const on = pts.map((_, i) => (fp.edgeOn ? fp.edgeOn[i] !== false : true) && ew > 0);
  const Q = offsetPolygon(pts, on.map((b) => (b ? ew : 0)));
  const F = offsetPolygon(pts, on.map((b) => (b ? ew + S.gap : 0)));
  if (!offsetIsValid(pts, Q) || !offsetIsValid(pts, F)) {
    errors.push(`${name}: the edge boards are too wide for this shape — reduce the edge board width or switch some edges off.`);
    return null;
  }
  if (ew > S.boardWidth + EPS) {
    errors.push(`${name}: edge boards (${ew}″) are wider than the deck boards (${S.boardWidth}″), so they can't be cut from them.`);
    return null;
  }

  const ref = ((fp.refEdge || 0) % n + n) % n;
  const a = pts[ref], b = pts[(ref + 1) % n];
  const theta = Math.atan2(b[1] - a[1], b[0] - a[0]) + ang(fp.angle || 0);
  const frame = makeFrame(theta, !!fp.flip);
  const joists = (fp.joists || []).filter((j) => Math.hypot(j.b[0] - j.a[0], j.b[1] - j.a[1]) > 1);

  // deck-board rows
  const uvF = F.map((p) => [frame.u(p), frame.v(p)]);
  let vmin = Infinity, vmax = -Infinity;
  for (const p of uvF) { vmin = Math.min(vmin, p[1]); vmax = Math.max(vmax, p[1]); }
  const pitch = S.boardWidth + S.gap;
  const rows = [];
  for (let k = 0; ; k++) {
    const v0 = vmin + k * pitch;
    if (v0 > vmax - 0.05) break;
    const v1 = Math.min(v0 + S.boardWidth, vmax);
    const comps = bandComponents(uvF, v0, v1);
    rows.push({ k, v0, v1, vc: (v0 + v1) / 2, width: v1 - v0, comps });
  }

  // edge-board strips (mitred where two edge boards meet)
  const strips = [];
  pts.forEach((p, i) => {
    if (!on[i]) return;
    const j = (i + 1) % n;
    const quad = [pts[i], pts[j], Q[j], Q[i]];
    const sf = makeFrame(Math.atan2(pts[j][1] - pts[i][1], pts[j][0] - pts[i][0]), false);
    const uv = quad.map((q) => [sf.u(q), sf.v(q)]);
    let lo = Infinity, hi = -Infinity;
    for (const q of uv) { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); }
    const comps = bandComponents(uv, lo, hi);
    strips.push({ edge: i, frame: sf, vc: (lo + hi) / 2, width: ew, comps, quad });
  });

  return { idx, name, pts, Q, F, frame, joists, rows, strips, ew, on, theta };
}

function buildPieces(prep, strategy, S, stockLens, Lmax) {
  const pieces = [];
  const unsupported = new Map();
  const note = (fi, n) => unsupported.set(fi, (unsupported.get(fi) || 0) + n);

  for (const fp of prep.fps) {
    const hasJoists = fp.joists.length > 0;
    let prevSeams = [];
    for (const row of fp.rows) {
      const seams = [];
      const cands = joistCandidates(fp.joists, fp.frame, row.vc);
      for (const comp of row.comps) {
        const r = partitionRun(comp, cands, { Lmax, gap: S.gap, strategy, prevSeams, hasJoists, stockLens });
        note(fp.idx, r.unsupported);
        seams.push(...r.seams);
        for (const sg of r.segs) {
          const parts = clipParts(comp, sg.ua, sg.ub, fp.frame);
          if (!parts.length) continue;
          pieces.push({ fp: fp.idx, kind: 'deck', row: row.k, length: sg.len, width: row.width, ua: sg.ua, ub: sg.ub, theta: fp.frame.theta, parts });
        }
      }
      prevSeams = seams;
    }
    for (const st of fp.strips) {
      const cands = joistCandidates(fp.joists, st.frame, st.vc);
      for (const comp of st.comps) {
        const r = partitionRun(comp, cands, { Lmax, gap: S.gap, strategy, prevSeams: [], hasJoists, stockLens });
        note(fp.idx, r.unsupported);
        for (const sg of r.segs) {
          const parts = clipParts(comp, sg.ua, sg.ub, st.frame);
          if (!parts.length) continue;
          pieces.push({ fp: fp.idx, kind: 'edge', row: st.edge, length: sg.len, width: st.width, ua: sg.ua, ub: sg.ub, theta: st.frame.theta, parts });
        }
      }
    }
  }
  return { pieces, unsupported };
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] < b[i];
  }
  return false;
}

const letter = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');

/* model: { boardWidth, gap, kerf, stock:[{length, price|null}], footprints:[...] } */
function solve(model) {
  const errors = [], warnings = [];
  const S = { boardWidth: model.boardWidth, gap: model.gap || 0, kerf: model.kerf || 0 };
  if (!(S.boardWidth > 0)) errors.push('Enter the deck board width.');
  const stock = (model.stock || []).filter((s) => s.length > 0);
  if (!stock.length) errors.push('Add at least one board length to buy.');
  if (!model.footprints.length) errors.push('Draw at least one deck area.');
  if (errors.length) return { errors, warnings };

  const prep = { fps: [] };
  model.footprints.forEach((fp, i) => {
    const p = prepareFootprint(fp, i, S, errors);
    if (p) prep.fps.push(p);
  });
  if (errors.length) return { errors, warnings };

  const stockLens = [...new Set(stock.map((s) => s.length))].sort((a, b) => a - b);
  const Lmax = stockLens[stockLens.length - 1];
  const priced = stock.every((s) => s.price != null && !Number.isNaN(s.price));

  let chosen = null;
  for (const strategy of STRATEGIES) {
    const built = buildPieces(prep, strategy, S, stockLens, Lmax);
    const bins = pack(built.pieces, stock, S.kerf, priced);
    if (!bins) continue;
    const totalLen = bins.reduce((a, b) => a + b.stock.length, 0);
    const cost = priced ? bins.reduce((a, b) => a + b.stock.price, 0) : 0;
    const key = [priced ? cost : totalLen, totalLen, bins.length];
    if (!chosen || lexLess(key, chosen.key)) chosen = { strategy, built, bins, key, totalLen, cost };
  }
  if (!chosen) return { errors: ['Could not fit the pieces into the boards listed.'], warnings };

  // labels + back-references
  const { pieces } = chosen.built;
  const counters = new Map();
  const labelOf = (p) => {
    const k = p.fp + p.kind;
    const c = (counters.get(k) || 0) + 1;
    counters.set(k, c);
    return `${letter(p.fp)}${p.kind === 'edge' ? 'e' : ''}${c}`;
  };
  pieces.forEach((p) => { p.label = labelOf(p); });
  chosen.bins.forEach((b, bi) => {
    b.cuts = b.items.map((i, slot) => { pieces[i].bin = bi; pieces[i].slot = slot; return i; });
    b.waste = b.stock.length - b.used;
  });

  // warnings
  for (const fp of prep.fps) {
    if (!fp.joists.length) {
      warnings.push(`${fp.name}: no joists drawn, so board ends were placed without checking joist support.`);
    } else {
      const n = chosen.built.unsupported.get(fp.idx) || 0;
      if (n) warnings.push(`${fp.name}: ${n} board joint${n > 1 ? 's' : ''} couldn't be placed over a joist. Check joist spacing and board direction.`);
      const parallel = fp.rows.length && !joistCandidates(fp.joists, fp.frame, fp.rows[0].vc).length;
      if (parallel) warnings.push(`${fp.name}: the boards run parallel to the joists, so joints can't land on them. Rotate the boards 90°.`);
      const thin = fp.joists.find((j) => (j.width - S.gap) / 2 < 0.25);
      if (thin) warnings.push(`${fp.name}: a ${thin.width}″ joist is too narrow to support two board ends with a ${S.gap}″ gap.`);
    }
  }
  if (!priced && stock.some((s) => s.price != null)) {
    warnings.push('Only some board lengths have prices, so the layout was optimised for total length instead of cost.');
  }

  let deckArea = 0, pieceArea = 0;
  for (const fp of prep.fps) deckArea += polyArea(fp.pts);
  for (const p of pieces) p.area = p.parts.reduce((a, q) => a + polyArea(q), 0), pieceArea += p.area;
  const boughtLen = chosen.totalLen;

  return {
    errors, warnings, priced, strategy: chosen.strategy,
    footprints: prep.fps.map((fp) => ({
      idx: fp.idx, name: fp.name, pts: fp.pts, inner: fp.Q, field: fp.F, theta: fp.theta,
      rows: fp.rows.length, joists: fp.joists,
    })),
    pieces, bins: chosen.bins,
    stats: {
      boards: chosen.bins.length,
      deckPieces: pieces.filter((p) => p.kind === 'deck').length,
      edgePieces: pieces.filter((p) => p.kind === 'edge').length,
      cost: chosen.cost, deckArea, pieceArea,
      boughtLen, boughtArea: boughtLen * S.boardWidth,
      cutLen: pieces.reduce((a, p) => a + p.length, 0),
    },
  };
}

/* Evenly spaced joists across a footprint, perpendicular to the boards. */
function generateJoists(fp, spacing, width) {
  const n = fp.pts.length;
  const ref = ((fp.refEdge || 0) % n + n) % n;
  const a = fp.pts[ref], b = fp.pts[(ref + 1) % n];
  const frame = makeFrame(Math.atan2(b[1] - a[1], b[0] - a[0]) + ang(fp.angle || 0), !!fp.flip);
  const uv = fp.pts.map((p) => [frame.u(p), frame.v(p)]);
  let umin = Infinity, umax = -Infinity;
  for (const p of uv) { umin = Math.min(umin, p[0]); umax = Math.max(umax, p[0]); }
  const pos = [];
  for (let u = umin + width / 2; u < umax - width / 2 - 1; u += spacing) pos.push(u);
  pos.push(umax - width / 2);

  const out = [];
  for (const u0raw of pos) {
    const u0 = u0raw + 1e-4;                  // dodge exact vertex hits
    const vs = [];
    for (let i = 0; i < n; i++) {
      const p = uv[i], q = uv[(i + 1) % n];
      if ((p[0] - u0) * (q[0] - u0) < 0) vs.push(p[1] + ((q[1] - p[1]) * (u0 - p[0])) / (q[0] - p[0]));
    }
    vs.sort((x, y) => x - y);
    for (let j = 0; j + 1 < vs.length; j += 2) {
      if (vs[j + 1] - vs[j] < 2) continue;
      out.push({ a: frame.toXY(u0, vs[j]), b: frame.toXY(u0, vs[j + 1]), width });
    }
  }
  return out;
}

const api = {
  solve, generateJoists, offsetPolygon, offsetIsValid, polyArea, polyArea2, isSimple, simplifyPoly,
  pointInPoly, makeFrame, bandComponents, pack, partitionRun, extentOf,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.DeckEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
