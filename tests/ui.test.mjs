// The page itself, in Chromium: the bugs fixed in the November 2026 review.
//   node tests/ui.test.mjs      (needs the `playwright` package; set
//                                CHROMIUM_PATH to use a specific browser)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'text/html' }).end(await fs.readFile(path.join(ROOT, p === '/' ? 'index.html' : p)));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

let failed = 0;
let passed = 0;
const check = (ok, name, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !extra ? '' : ` — ${extra}`}`); if (ok) passed++; else failed++; };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const dialogs = [];
let accept = true;
page.on('dialog', (d) => { dialogs.push(d.message()); if (accept) d.accept(); else d.dismiss(); });
await page.goto(BASE);

console.log('Cut list');
check((await page.locator('main').count()) === 2, 'one <main> per tool');
await page.fill('#stockRows input', '77');
accept = false;
await page.click('#loadExample');
check(dialogs.length === 1 && (await page.inputValue('#stockRows input')) === '77', 'Load example asks first, and No keeps your rows');
accept = true;
await page.click('#loadExample');
check((await page.inputValue('#stockRows input')) === '144', 'Yes loads the example');
await page.click('#calcBtn');
check(/Boards to buy/.test(await page.textContent('#stats')), 'the example calculates');
await page.locator('#cutRows input[data-key=qty]').first().fill('500000');
await page.click('#calcBtn');
check(/limit is 5,000/.test(await page.textContent('#errorBox')), 'an absurd quantity is refused instead of freezing the page');

console.log('Deck planner');
await page.click('#tabDeck');
await page.fill('#dRectW', "16'");
await page.fill('#dRectD', "12'");
await page.click('#dRectAdd');
const pts = () => page.evaluate(() => JSON.stringify(DeckPlanner.state().footprints[0].pts));
const edge = async (i, v) => { await page.fill(`[data-edge-len="${i}"]`, v); await page.dispatchEvent(`[data-edge-len="${i}"]`, 'change'); };
await edge(0, "18'");
check((await pts()) === '[[0,0],[216,0],[216,144],[0,144]]', 'lengthening an edge of a rectangle keeps it a rectangle', await pts());
await edge(1, "10'");
check((await pts()) === '[[0,0],[216,0],[216,120],[0,120]]', '…on the other axis too', await pts());
await edge(3, "12'");
check((await pts()) === '[[0,-24],[216,-24],[216,120],[0,120]]', '…and for the closing edge', await pts());

await page.fill('[data-js=joistSpacing]', '0.01');
await page.click('[data-act="gen-joists"]');
check((await page.evaluate(() => DeckPlanner.state().footprints[0].joists.length)) === 0 && /at least 1/.test(await page.textContent('#dError')), 'a joist spacing under 1″ is refused');
await page.fill('[data-js=joistSpacing]', '16');
await page.click('[data-act="gen-joists"]');
const joists = await page.evaluate(() => DeckPlanner.state().footprints[0].joists.length);
check(joists > 10 && (await page.locator('.joist-details:not([open])').count()) === 1, `${joists} joists sit behind one summary line`);

await page.click('#dCalc');
await page.waitForFunction(() => !!DeckPlanner.results());
const boards = await page.evaluate(() => DeckPlanner.results().bins.length);
const bars = await page.locator('#dCutPlan .board').count();
check(bars < boards, `identical boards share a bar (${bars} bars for ${boards} boards)`);
check(/Edit layout/.test(await page.textContent('#dActions')) && /Showing the board layout/.test(await page.textContent('#dHint')), 'the results view says so and offers “Edit layout”');

const corner = () => page.evaluate(() => {
  const s = document.getElementById('dSvg');
  const pt = s.createSVGPoint();
  [pt.x, pt.y] = DeckPlanner.state().footprints[0].pts[0];
  const r = pt.matrixTransform(s.getScreenCTM());
  return [r.x, r.y];
});
const drag = async () => {
  await page.evaluate(() => document.getElementById('dSvg').scrollIntoView({ block: 'center' }));
  const [x, y] = await corner();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 40, { steps: 6 });
  await page.mouse.up();
};
const before = await pts();
await page.click('[data-tool="select"]');
check(await page.evaluate(() => !DeckPlanner.results()), 'picking a tool leaves the results view');
await drag();
check((await pts()) !== before, 'and corners can be dragged again');
await page.click('#dCalc');
await page.waitForFunction(() => !!DeckPlanner.results());
await page.click('#dActions button[data-a=edit]');
check(await page.evaluate(() => !DeckPlanner.results()) && /Drag corners/.test(await page.textContent('#dHint')), '“Edit layout” does the same');

// wheel: the page scrolls unless Ctrl is held
const zoom = () => page.evaluate(() => document.getElementById('dSvg').getAttribute('viewBox'));
await page.evaluate(() => document.getElementById('dSvg').scrollIntoView({ block: 'center' }));
const box = await page.locator('#dSvg').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
const vb = await zoom();
const y0 = await page.evaluate(() => scrollY);
await page.mouse.wheel(0, 200);
await page.waitForTimeout(200);
check((await zoom()) === vb && (await page.evaluate(() => scrollY)) > y0, 'scrolling over the drawing scrolls the page');
await page.keyboard.down('Control');
await page.mouse.wheel(0, -200);
await page.keyboard.up('Control');
await page.waitForTimeout(200);
check((await zoom()) !== vb, 'Ctrl + scroll zooms');

// save to a file, clear, open it again
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dExport')]);
const saved = await fs.readFile(await download.path(), 'utf8');
check(/^deck-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()) && JSON.parse(saved).footprints.length === 1, 'a deck saves to a file');
const shape = await pts();
await page.click('#dClear');
check((await page.evaluate(() => DeckPlanner.state().footprints.length)) === 0, 'cleared');
await page.setInputFiles('#dFile', { name: 'deck.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
await page.waitForFunction(() => DeckPlanner.state().footprints.length === 1);
check((await pts()) === shape && (await page.evaluate(() => DeckPlanner.state().footprints[0].joists.length)) === joists, 'and opens again with its shape and joists');
await page.setInputFiles('#dFile', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
await page.waitForTimeout(200);
check(/isn't a deck file/.test(await page.textContent('#dError')) && (await pts()) === shape, 'some other file is refused and changes nothing');

console.log('Offline');
await page.reload();
await page.evaluate(() => new Promise((resolve) => {
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'precached') resolve(); });
  navigator.serviceWorker.ready.then((reg) => reg.active.postMessage({ type: 'precache', urls: [location.href.split('#')[0], ...performance.getEntriesByType('resource').map((r) => r.name)] }));
}));
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('#calcBtn', { timeout: 15000 }).catch(() => {});
check(await page.evaluate(() => !!window.DeckPlanner && !!window.CutUtil), 'the page opens with no connection');
await ctx.setOffline(false);

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
server.close();
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nAll ${passed} checks passed`);
process.exit(failed ? 1 : 0);
