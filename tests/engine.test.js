// The deck layout engine is pure, so it is tested in Node with no browser:
//   node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../deck-engine.js');

const rect = (w, d) => [[0, 0], [w, 0], [w, d], [0, d]];
const model = (over = {}) => ({
  boardWidth: 5.5, gap: 0.125, kerf: 0.125,
  stock: [{ length: 96, price: null }, { length: 144, price: null }, { length: 192, price: null }],
  footprints: [{ name: 'Deck', pts: rect(192, 144), edgeWidth: 0, edgeOn: [true, true, true, true], refEdge: 0, angle: 0, flip: false, joists: [] }],
  ...over,
});
const withJoists = (m, spacing = 16) => {
  for (const fp of m.footprints) fp.joists = E.generateJoists(fp, spacing, 1.5);
  return m;
};

test('a plain rectangle is covered row by row', () => {
  const res = E.solve(model());
  assert.deepEqual(res.errors, []);
  // 144″ deep at 5.625″ pitch: 26 rows, each one 16′ board
  assert.equal(res.footprints[0].rows, 26);
  assert.equal(res.stats.deckPieces, 26);
  assert.equal(res.stats.boards, 26);
  assert.ok(res.bins.every((b) => b.stock.length === 192));
});

test('pieces cover the deck: their area is the deck minus the gaps', () => {
  const res = E.solve(model());
  const { deckArea, pieceArea } = res.stats;
  assert.equal(deckArea, 192 * 144);
  assert.ok(pieceArea < deckArea && pieceArea > deckArea * 0.95, `${pieceArea} of ${deckArea}`);
});

test('no piece is longer than the longest board, and none overflows its board', () => {
  const m = model({ footprints: [{ name: 'Long', pts: rect(400, 60), edgeWidth: 0, refEdge: 0, angle: 0, joists: [] }] });
  const res = E.solve(withJoists(m));
  assert.deepEqual(res.errors, []);
  assert.ok(res.pieces.every((p) => p.length <= 192 + 1e-6));
  for (const b of res.bins) {
    const used = b.cuts.reduce((s, i, k) => s + res.pieces[i].length + (k ? 0.125 : 0), 0);
    assert.ok(used <= b.stock.length + 1e-6, `${used} in a ${b.stock.length} board`);
  }
});

test('butt joints land on joists when there are joists', () => {
  const m = model({ footprints: [{ name: 'Long', pts: rect(400, 60), edgeWidth: 0, refEdge: 0, angle: 0, joists: [] }] });
  const res = E.solve(withJoists(m));
  assert.ok(!res.warnings.some((w) => /couldn't be placed over a joist/.test(w)), res.warnings.join('\n'));
  const joistX = m.footprints[0].joists.map((j) => j.a[0]);
  const seams = res.pieces.filter((p) => p.ua > 1).map((p) => p.ua - 0.0625);
  assert.ok(seams.length > 0);
  for (const s of seams) assert.ok(joistX.some((x) => Math.abs(x - s) < 0.01), `seam at ${s}`);
});

test('with every length priced, the cheaper mix wins', () => {
  // A 16′ run needs a joint either way (the longest board is 10′). Splitting
  // it 10′ + 6′ buys a $40 board per row; 8′ + 8′ buys two $5 ones.
  const res = E.solve(model({ stock: [{ length: 96, price: 5 }, { length: 120, price: 40 }], footprints: [{ name: 'D', pts: rect(192, 22), edgeWidth: 0, refEdge: 0, angle: 0, joists: [] }] }));
  assert.equal(res.priced, true);
  // (Joints are staggered row to row, so every other row is 9′4″ + 6′8″ and
  // does need a 10′ board; the rows between must not.)
  const tens = res.bins.filter((b) => b.stock.length === 120).length;
  assert.ok(tens <= res.footprints[0].rows / 2, res.bins.map((b) => b.stock.length).join());
  assert.equal(res.stats.cost, res.bins.reduce((s, b) => s + b.stock.price, 0));
});

test('edge boards frame the area and are mitred', () => {
  const m = model();
  m.footprints[0].edgeWidth = 5.5;
  const res = E.solve(m);
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.edgePieces, 4);
  assert.ok(res.stats.deckPieces < 26, 'the field inside the frame needs fewer rows');
});

test('bad input is reported, not thrown', () => {
  assert.match(E.solve(model({ boardWidth: 0 })).errors[0], /board width/);
  assert.match(E.solve(model({ stock: [] })).errors[0], /board length/);
  const bow = model({ footprints: [{ name: 'Bow', pts: [[0, 0], [100, 100], [100, 0], [0, 100]], edgeWidth: 0, refEdge: 0, angle: 0, joists: [] }] });
  assert.match(E.solve(bow).errors[0], /edges cross/);
});

test('a sliver last row is called out', () => {
  // 5 rows of 5.625″ pitch = 28.125″; 28.5″ deep leaves a 0.375″ sixth row
  const m = model({ footprints: [{ name: 'Tight', pts: rect(96, 28.5), edgeWidth: 0, refEdge: 0, angle: 0, joists: [] }] });
  const res = E.solve(m);
  assert.ok(res.warnings.some((w) => /last row of boards is only/.test(w)), res.warnings.join('\n'));
  assert.ok(!E.solve(model()).warnings.some((w) => /last row/.test(w)));
});

test('packing reuses offcuts and never loses a piece', () => {
  const pieces = [60, 60, 30, 30, 30, 90].map((length) => ({ length }));
  const bins = E.pack(pieces, [{ length: 96, price: null }], 0, false);
  assert.equal(bins.flatMap((b) => b.items).sort().join(), '0,1,2,3,4,5');
  assert.equal(bins.length, 4); // 300″ of cuts: 90 | 60+30 | 60+30 | 30
});

test('polygon helpers', () => {
  assert.equal(E.polyArea(rect(10, 4)), 40);
  assert.equal(E.isSimple(rect(10, 4)), true);
  assert.deepEqual(E.simplifyPoly([[0, 0], [5, 0], [10, 0], [10, 4], [0, 4]]), rect(10, 4));
  const inner = E.offsetPolygon(rect(10, 4), [1, 1, 1, 1]);
  assert.equal(Math.round(E.polyArea(inner)), 16);
  assert.equal(E.offsetIsValid(rect(10, 4), E.offsetPolygon(rect(10, 4), [3, 3, 3, 3])), false);
});
