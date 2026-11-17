import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load the SuiteScript AMD module with stub NetSuite modules; only the pure helpers are exercised.
const source = readFileSync(new URL('../src/uk-stock-monitor-suitelet.js', import.meta.url), 'utf8');
let exported;
new Function('define', source)((deps, factory) => { exported = factory(...deps.map(() => ({}))); });
const { demandWindow, qtyToReplenish, evaluate, toCsv, clampInt } = exported._test;

test('six-month window ends today and is measured in weeks', () => {
  const w = demandWindow(new Date(2026, 10, 17), 6);
  assert.equal(w.start.getMonth(), 4);
  assert.equal(w.start.getDate(), 17);
  assert.equal(w.weeks, 185 / 7);
});

test('qty to replenish matches the saved search formula', () => {
  assert.equal(qtyToReplenish({ available: 661, onOrder: 0, reorderPoint: 720, preferred: 1440 }), 779);
  assert.equal(qtyToReplenish({ available: 300, onOrder: 420, reorderPoint: 720, preferred: 1440 }), 720);
  assert.equal(qtyToReplenish({ available: 276, onOrder: 400, reorderPoint: 200, preferred: 400 }), 0);
});

test('average weekly demand includes fulfilments and work order consumption; recommendation covers six weeks', () => {
  const window = { weeks: 26 };
  const row = evaluate({ available: 100, onOrder: 50, onHand: 120, preferred: 400, reorderPoint: 200 }, { fulfilled: 520, consumed: 260 }, window, 6);
  assert.equal(row.avgWeekly, 30);
  assert.equal(row.recommended, 180);
  assert.equal(row.shortfall, 30);
  assert.equal(row.weeksCover, 3.3);
  assert.equal(row.vsPreferred, -220);
  assert.equal(row.highlight, 'covered');
});

test('no history means no recommendation and no weeks cover', () => {
  const row = evaluate({ available: 10, onOrder: 0, onHand: 10, preferred: 20, reorderPoint: 5 }, undefined, { weeks: 26 }, 6);
  assert.equal(row.avgWeekly, 0);
  assert.equal(row.recommended, 0);
  assert.equal(row.weeksCover, null);
  assert.equal(row.highlight, '');
});

test('recommendation rounds up to whole units', () => {
  assert.equal(evaluate({}, { fulfilled: 10, consumed: 0 }, { weeks: 26 }, 6).recommended, 3);
});

test('special items highlight before replenishment state', () => {
  assert.equal(evaluate({ special: true, available: 0, reorderPoint: 10 }, null, { weeks: 26 }, 6).highlight, 'special');
  assert.equal(evaluate({ available: 0, onOrder: 0, reorderPoint: 10 }, null, { weeks: 26 }, 6).highlight, 'replenish');
});

test('csv escapes values and leaves weeks cover blank without demand', () => {
  const row = evaluate({ id: '1', name: '1013.1350 "Interim", Roll', available: 1 }, null, { weeks: 26 }, 6);
  const csv = toCsv([row]).split('\r\n');
  assert.ok(csv[1].startsWith('"1013.1350 ""Interim"", Roll"'));
  assert.ok(csv[0].includes('Weeks Cover'));
  assert.ok(!csv[1].includes('99999'));
});

test('form inputs are clamped to safe ranges', () => {
  assert.equal(clampInt('12', 1, 24, 6), 12);
  assert.equal(clampInt('0', 1, 24, 6), 6);
  assert.equal(clampInt('abc', 1, 24, 6), 6);
});

test('cover status is green at or above recommended cover, amber from half, red below half', () => {
  const { coverStatus } = exported._test;
  assert.equal(coverStatus(60, 10, 6), 'green');
  assert.equal(coverStatus(90, 10, 6), 'green');
  assert.equal(coverStatus(59, 10, 6), 'amber');
  assert.equal(coverStatus(30, 10, 6), 'amber');
  assert.equal(coverStatus(29, 10, 6), 'red');
  assert.equal(coverStatus(-5, 10, 6), 'red');
  assert.equal(coverStatus(100, 0, 6), '');
});

test('evaluate carries the cover status and csv labels it without a Type column', () => {
  const row = evaluate({ id: '1', name: 'A', available: 40, type: 'Assembly' }, { fulfilled: 260, consumed: 0 }, { weeks: 26 }, 6);
  assert.equal(row.coverStatus, 'amber');
  const [head, line] = toCsv([row]).split('\r\n');
  assert.ok(head.includes('Cover Status'));
  assert.ok(!head.split(',').includes('Type'));
  assert.ok(line.includes('Amber'));
});

test('hidden columns accept known keys only and never hide Name', () => {
  const { hiddenColumns } = exported._test;
  assert.deepEqual(hiddenColumns('description,name,bogus,weeks-cover,description'), ['description', 'weeks-cover']);
  assert.deepEqual(hiddenColumns(''), []);
  assert.deepEqual(hiddenColumns(undefined), []);
});

test('csv export leaves out hidden columns', () => {
  const row = evaluate({ id: '1', name: 'A', description: 'Desc', available: 5 }, null, { weeks: 26 }, 6);
  const head = toCsv([row], ['description', 'cover-status']).split('\r\n')[0].split(',');
  assert.ok(head.includes('Name') && head.includes('Weeks Cover') && head.includes('Location'));
  assert.ok(!head.includes('Description') && !head.includes('Cover Status'));
});

test('every column in the table carries its column key for the chooser', () => {
  const { renderTable, COLUMNS, colKey } = exported._test;
  const row = evaluate({ id: '1', name: 'A' }, null, { weeks: 26 }, 6);
  const html = renderTable([row], { window: { start: new Date(2026, 4, 17), end: new Date(2026, 10, 17), weeks: 26 }, weeks: 6 });
  for (const c of COLUMNS) {
    assert.equal(html.split(`class="c-${colKey(c)}`).length - 1, 2, colKey(c));
    if (colKey(c) !== 'name') assert.ok(html.includes(`data-key="${colKey(c)}"`), colKey(c));
  }
  assert.ok(!html.includes('data-key="name"'));
});
