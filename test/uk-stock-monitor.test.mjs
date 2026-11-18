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
    if (colKey(c) !== 'name') assert.ok(html.includes(`<input type="checkbox" data-key="${colKey(c)}"`), colKey(c));
    assert.ok(html.includes(`data-key="${colKey(c)}" draggable="true"`), colKey(c));
  }
  assert.ok(!html.includes('<input type="checkbox" data-key="name"'));
});

test('excluded customers accept internal IDs only, from comma or multiselect lists', () => {
  const { excludedCustomers } = exported._test;
  assert.deepEqual(excludedCustomers('12,34\u000556, 12'), ['12', '34', '56']);
  assert.deepEqual(excludedCustomers("1) OR 1=1 --,0,abc,07"), []);
  assert.deepEqual(excludedCustomers(undefined), []);
});

test('demand query is unchanged without exclusions', () => {
  const { demandSql } = exported._test;
  const { sql } = demandSql(['1'], []);
  assert.ok(!sql.includes('wo.entity') && !sql.includes('t.entity'));
  assert.ok(sql.includes('tl.location IN (1)'));
});

test('demand query excludes customers on fulfilments and on the work order behind completions and issues', () => {
  const { demandSql } = exported._test;
  const { sql } = demandSql(['1', '1', '5'], ['101', 'x', '202']);
  assert.ok(sql.includes("NOT (t.type = 'ItemShip' AND NVL(t.entity, 0) IN (101,202))"));
  assert.ok(sql.includes("NOT (t.type IN ('WOCompl', 'WOIssue') AND t.id IN ("));
  assert.ok(sql.includes("w.id = h.createdfrom AND w.type = 'WorkOrd' AND w.entity IN (101,202)"));
  assert.ok(!/JOIN transactionline/.test(sql), 'no join that could drop lines');
  assert.ok(sql.includes('tl.location IN (1,5)'));
});

test('demand counts only stock-out lines and never cost of goods lines', () => {
  const { demandSql } = exported._test;
  const { sql } = demandSql(['1'], []);
  assert.ok(sql.includes("tl.quantity < 0 AND NVL(tl.iscogs, 'F') = 'F'"));
  assert.ok(sql.includes('SUM(-tl.quantity)'));
  assert.ok(!sql.includes('ABS('));
});

test('trace query uses the same counting rule and rejects bad ids', () => {
  const { traceSql, countedSql } = exported._test;
  const sql = traceSql('42', '1', ['7']);
  assert.ok(sql.includes(`CASE WHEN ${countedSql(['7'])} THEN 1 ELSE 0 END`));
  assert.ok(sql.includes('tl.item = 42 AND tl.location = 1'));
  assert.throws(() => traceSql('42 OR 1=1', '1'));
  assert.throws(() => traceSql('42', ''));
});

test('trace explains why lines are not counted and totals the counted ones', () => {
  const { lineReason, renderTrace } = exported._test;
  assert.equal(lineReason({ counted: 0, iscogs: 'T', quantity: -5, type: 'ItemShip' }), 'Cost of goods line (duplicate of the item line)');
  assert.equal(lineReason({ counted: 0, iscogs: 'F', quantity: 10, type: 'WOCompl' }), 'Output or stock in, not consumption');
  assert.equal(lineReason({ counted: 0, iscogs: 'F', quantity: -3, type: 'ItemShip', customerid: 9 }, ['9']), 'Excluded customer');
  const lines = [
    { type: 'ItemShip', quantity: -10, iscogs: 'F', counted: 1, tranid: 'IF1', itemname: '1011.2050 JTAPE' },
    { type: 'ItemShip', quantity: -10, iscogs: 'T', counted: 0, tranid: 'IF1' },
    { type: 'WOCompl', quantity: -4, iscogs: 'F', counted: 1, tranid: 'WOC1' },
    { type: 'WOCompl', quantity: 6, iscogs: 'F', counted: 0, tranid: 'WOC1' }
  ];
  const html = renderTrace(lines, { window: { start: new Date(2026, 4, 18), end: new Date(2026, 10, 18) }, excluded: [] }, '42');
  assert.ok(html.includes('Fulfilled <b>10.00</b>'));
  assert.ok(html.includes('WO Consumed <b>4.00</b>'));
  assert.ok(html.includes('2 lines shown in grey are not counted'));
});

test('drill-down lists lines with the same source and filters as the main figure', () => {
  const { demandSql, traceSql } = exported._test;
  for (const excluded of [[], ['101']]) {
    const main = demandSql(['1'], excluded, '42').sql;
    const trace = traceSql('42', '1', excluded);
    const from = q => { const i = q.indexOf('FROM transactionline tl'); return q.slice(i, q.indexOf('WHERE', i)); };
    assert.equal(from(trace), from(main));
    for (const part of ["t.posting = 'T'", "(tl.mainline = 'F' OR t.type = 'ItemShip')", "tl.itemtype IN ('InvtPart', 'Assembly')", 'tl.item = 42']) {
      assert.ok(main.includes(part) && trace.includes(part), part);
    }
  }
});

test('created-from details only give a work order customer for work orders', () => {
  const { sourceFields, sourcesSql } = exported._test;
  assert.deepEqual(sourceFields({ createdfrom: 'Work Order #WO1', sourcetype: 'WorkOrd', sourcecustomer: 'ACME', sourcecustomerid: '9' }), { createdfrom: 'Work Order #WO1', wocustomer: 'ACME', wocustomerid: 9 });
  assert.deepEqual(sourceFields({ createdfrom: 'Sales Order #SO1', sourcetype: 'SalesOrd', sourcecustomer: 'ACME', sourcecustomerid: '9' }), { createdfrom: 'Sales Order #SO1', wocustomer: '', wocustomerid: 0 });
  assert.equal(sourcesSql(['x']), '');
  assert.ok(sourcesSql(['5', '6', '5']).includes('h.transaction IN (5,6)'));
});

test('drill-down warns when its lines do not add up to the main list', () => {
  const { renderTrace } = exported._test;
  const settings = { window: { start: new Date(2026, 4, 18), end: new Date(2026, 10, 18) }, excluded: [] };
  const lines = [{ type: 'ItemShip', quantity: -10, iscogs: 'F', counted: 1, tranid: 'IF1' }];
  assert.ok(renderTrace(lines, settings, '42', { fulfilled: 10, consumed: 0 }).includes('Matches the main list'));
  assert.ok(renderTrace(lines, settings, '42', { fulfilled: 657, consumed: 0 }).includes('do not add up to the main list'));
});

test('a fulfilment main line is its first item line and counts; work order main lines never count', () => {
  const { countedSql, lineReason } = exported._test;
  assert.ok(countedSql([]).includes("(tl.mainline = 'F' OR t.type = 'ItemShip')"));
  assert.equal(lineReason({ counted: 0, iscogs: 'F', mainline: 'T', quantity: -2, type: 'WOIssue' }), 'Main line of the work order transaction');
  assert.equal(lineReason({ counted: 1, iscogs: 'F', mainline: 'T', quantity: -80, type: 'ItemShip' }), 'Counted');
});

test('drill-down rows carry type and counted flags for the filter, preset from the clicked figure', () => {
  const { renderTrace, COLUMNS } = exported._test;
  const settings = { window: { start: new Date(2026, 4, 18), end: new Date(2026, 10, 18) }, excluded: [], traceType: 'consumed' };
  const html = renderTrace([
    { type: 'ItemShip', quantity: -80, iscogs: 'F', counted: 1, tranid: 'IF1' },
    { type: 'WOIssue', quantity: -3, iscogs: 'F', counted: 1, tranid: 'WOI1' }
  ], settings, '42', { fulfilled: 80, consumed: 3 });
  assert.ok(html.includes('data-type="ItemShip" data-counted="1" data-qty="80"'));
  assert.ok(html.includes('<option value="WOCompl,WOIssue" selected>'));
  const row = { fulfilled: 5, consumed: 2, traceUrl: '/x?a=1' };
  const cell = name => COLUMNS.find(c => c[0] === name)[1](row);
  assert.ok(cell('Fulfilled').includes('custpage_ttype=fulfilled'));
  assert.ok(cell('WO Consumed').includes('custpage_ttype=consumed'));
});

test('a completion never counts the assembly it builds, only its components', () => {
  const { countedSql, traceSql, lineReason } = exported._test;
  const rule = countedSql([]);
  assert.ok(rule.includes("AND NOT (t.type = 'WOCompl' AND EXISTS ("));
  assert.ok(rule.includes("m.transaction = t.id AND m.mainline = 'T' AND m.item = tl.item"));
  assert.ok(traceSql('42', '1').includes("THEN 'T' ELSE 'F' END AS isbuilt"));
  // COM1043 building 1011.2050: main line +200 and offset line -200 are both the built assembly.
  assert.equal(lineReason({ counted: 0, iscogs: 'F', isbuilt: 'T', mainline: 'F', quantity: -200, type: 'WOCompl' }), 'Assembly being built, not consumption');
  // COM1734 consuming 1011.2050 as a component still counts.
  assert.equal(lineReason({ counted: 1, iscogs: 'F', isbuilt: 'F', mainline: 'F', quantity: -1, type: 'WOCompl' }), 'Counted');
});

test('csv follows the viewer column order, ignores unknown keys and keeps every column', () => {
  const { orderedColumns, COLUMNS, colKey } = exported._test;
  const keys = orderedColumns('weeks-cover,bogus,name,weeks-cover').map(colKey);
  assert.deepEqual(keys.slice(0, 2), ['weeks-cover', 'name']);
  assert.equal(keys.length, COLUMNS.length);
  const row = evaluate({ id: '1', name: 'A', available: 5 }, null, { weeks: 26 }, 6);
  const head = toCsv([row], ['description'], 'cover-status,name').split('\r\n')[0].split(',');
  assert.deepEqual(head.slice(0, 2), ['Cover Status', 'Name']);
  assert.equal(head[head.length - 1], 'Location');
  assert.ok(!head.includes('Description') && !head.includes('Create WO'));
});

test('default layout matches the agreed column order and hidden columns', () => {
  const { COLUMNS, DEFAULT_HIDDEN, renderTable } = exported._test;
  assert.deepEqual(COLUMNS.map(c => c[0]), ['Name', 'Description', '% Stocked', '% Available', 'Recommended Stock', 'Preferred Stock',
    'Replenish Level', 'Current Stock', 'Committed', 'Available', 'Avg Weekly Demand', 'Weeks Cover', 'Cover Status', 'Qty to Replenish',
    'Create WO', "WO's", 'Fulfilled', 'WO Consumed', 'Recommended vs Preferred', 'Shortfall to Recommended']);
  assert.deepEqual(DEFAULT_HIDDEN, ['fulfilled', 'wo-consumed', 'recommended-vs-preferred', 'shortfall-to-recommended']);
  const html = renderTable([], { window: { start: new Date(2026, 4, 18), end: new Date(2026, 10, 18), weeks: 26 }, weeks: 6 });
  assert.ok(html.includes(`var DEFAULT=${JSON.stringify(DEFAULT_HIDDEN)}`));
  assert.ok(html.includes('Restore default layout'));
});

test('default excluded customers apply until the viewer submits their own choice, even an empty one', () => {
  const { chosenExclusions } = exported._test;
  assert.deepEqual(chosenExclusions({}, '101,202'), ['101', '202']);
  assert.deepEqual(chosenExclusions({}, ['101', '202']), ['101', '202']);
  assert.deepEqual(chosenExclusions({}, '101\u0005202'), ['101', '202']);
  assert.deepEqual(chosenExclusions({}, null), []);
  assert.deepEqual(chosenExclusions({ custpage_exset: 'T', custpage_exclude: '303' }, '101'), ['303']);
  assert.deepEqual(chosenExclusions({ custpage_exset: 'T', custpage_exclude: '' }, '101'), []);
});

test('weekly demand buckets counted lines into weeks from the window start and flags outliers', () => {
  const { weeklyDemand } = exported._test;
  const window = demandWindow(new Date(2026, 10, 18), 6);
  const lines = [
    { counted: 1, type: 'ItemShip', quantity: -10, trandate: '2026-05-18', tranid: 'IF1', tranid_internal: 1, customer: 'A' },
    { counted: 1, type: 'ItemShip', quantity: -10, trandate: '2026-05-25', tranid: 'IF2', tranid_internal: 2, customer: 'B' },
    { counted: 1, type: 'ItemShip', quantity: -500, trandate: '2026-06-01', tranid: 'IF3', tranid_internal: 3, customer: 'GPI' },
    { counted: 1, type: 'ItemShip', quantity: -30, trandate: '2026-06-01', tranid: 'IF3', tranid_internal: 3, customer: 'GPI' },
    { counted: 1, type: 'WOCompl', quantity: -6, trandate: '2026-06-03', tranid: 'COM1', tranid_internal: 4, wocustomer: 'C' },
    { counted: 0, type: 'ItemShip', quantity: 80, trandate: '2026-06-03', tranid: 'IF9', tranid_internal: 9 },
    { counted: 1, type: 'ItemShip', quantity: -4, trandate: '2026-11-18', tranid: 'IF4', tranid_internal: 5 }
  ];
  const d = weeklyDemand(lines, window);
  assert.equal(d.weeks.length, 27);
  assert.equal(d.weeks[0].start, '2026-05-18');
  assert.equal(d.weeks[0].end, '2026-05-24');
  assert.equal(d.weeks[2].fulfilled, 530);
  assert.equal(d.weeks[2].consumed, 6);
  assert.equal(d.weeks[26].partial, true);
  assert.equal(d.weeks[26].fulfilled, 4);
  assert.equal(d.total, 560);
  assert.equal(d.average, Math.round((560 / window.weeks) * 100) / 100);
  assert.equal(d.median, 0);
  assert.deepEqual(d.top[0], { id: '3', number: 'IF3', date: '2026-06-01', type: 'Item Fulfilment', customer: 'GPI', qty: 530, share: 94.6 });
  assert.equal(d.largestShare, 94.6);
  assert.equal(d.averageWithoutLargest, Math.round((30 / window.weeks) * 100) / 100);
  assert.equal(d.weeks[2].txns[0].number, 'IF3');
});

test('chart button appears only for rows with demand and escapes the item name', () => {
  const { chartButton } = exported._test;
  assert.equal(chartButton({ traceUrl: '/x', avgWeekly: 0 }), '');
  const html = chartButton({ traceUrl: '/x?a=1', avgWeekly: 5, name: '<b>A</b>', description: 'Tape' });
  assert.ok(html.includes('data-url="/x?a=1&amp;custpage_weekly=T"'));
  assert.ok(html.includes('&lt;b&gt;A&lt;/b&gt;') && !html.includes('<b>A</b>'));
});
