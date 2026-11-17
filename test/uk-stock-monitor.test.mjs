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
