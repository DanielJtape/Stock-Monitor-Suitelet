/**
 * UK Stock Monitor with demand-based stockholding. Read-only: it never creates or changes records.
 *
 * Stock levels come from the existing "UK Stock Monitor" saved search (customsearch1983 by default), so its
 * criteria (Warehouse location, reorder point set, active, not Raw Material) stay maintained in one place.
 * Demand is read with SuiteQL from posted item fulfilments, work order completions (backflushed component
 * lines) and work order issues at the same location over the look-back period (default 6 months).
 *
 * Item fields: custitem_isjtape ("JTAPE Product?" filter) and isspecialworkorderitem ("Special Work Order
 * Item", orange rows). Optional script parameter custscript_usm_search overrides the saved search ID.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/ui/serverWidget', 'N/search', 'N/query', 'N/runtime', 'N/redirect', 'N/file'], (serverWidget, search, query, runtime, redirect, file) => {
  const DEFAULTS = { months: 6, weeks: 6 };
  const JTAPE_FIELD = 'custitem_isjtape';
  const SPECIAL_FIELD = 'isspecialworkorderitem';

  // ---------- Pure calculations (covered by test/uk-stock-monitor.test.mjs) ----------

  const num = value => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
  const clampInt = (value, min, max, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };

  /** Look-back window ending today: start date and length in weeks. */
  function demandWindow(today, months) {
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const start = new Date(end);
    start.setMonth(start.getMonth() - months);
    const days = Math.round((end - start) / 86400000) + 1; // inclusive of today
    return { start, end, weeks: days / 7 };
  }

  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /** Same rule as the saved search's Formula (Numeric) "Qty to Replenish". */
  function qtyToReplenish(row) {
    const position = num(row.available) + num(row.onOrder);
    return position - num(row.reorderPoint) <= 0 ? Math.abs(position - num(row.preferred)) : 0;
  }

  function percent(part, whole) {
    const w = num(whole) || 1;
    return Math.round((num(part) / w) * 1000) / 10;
  }

  /**
   * Traffic light for weeks cover against the recommended cover weeks: green at 100% or more, amber from 50%
   * up to 100%, red below 50%. No demand in the window gives no light (cover cannot be measured).
   */
  function coverStatus(available, avgWeekly, coverWeeks) {
    if (!(avgWeekly > 0) || !(coverWeeks > 0)) return '';
    const ratio = num(available) / avgWeekly / coverWeeks;
    return ratio >= 1 ? 'green' : ratio >= 0.5 ? 'amber' : 'red';
  }

  /** Adds demand, recommended stockholding and the derived columns to one stock row. */
  function evaluate(row, demand, window, coverWeeks) {
    const fulfilled = num(demand && demand.fulfilled);
    const consumed = num(demand && demand.consumed);
    const avgWeekly = window.weeks > 0 ? (fulfilled + consumed) / window.weeks : 0;
    const recommended = Math.max(0, Math.ceil(avgWeekly * coverWeeks - 1e-9));
    const position = num(row.available) + num(row.onOrder);
    const replenish = qtyToReplenish(row);
    return {
      ...row,
      fulfilled,
      consumed,
      avgWeekly: Math.round(avgWeekly * 10) / 10,
      recommended,
      weeksCover: avgWeekly > 0 ? Math.round((num(row.available) / avgWeekly) * 10) / 10 : null,
      coverStatus: coverStatus(row.available, avgWeekly, coverWeeks),
      shortfall: Math.max(0, recommended - position),
      vsPreferred: recommended - num(row.preferred),
      pctStocked: percent(row.onHand, row.preferred),
      pctAvailable: percent(row.available, row.preferred),
      replenish,
      // Highlighting: orange = special WO item; yellow = below replenish level with nothing on order;
      // green = below replenish level but work orders are already open.
      highlight: row.special ? 'special' : position - num(row.reorderPoint) <= 0 ? (num(row.onOrder) > 0 ? 'covered' : 'replenish') : ''
    };
  }

  // ---------- NetSuite reads ----------

  function stockRows(params, jtape) {
    const s = search.load({ id: params.searchId });
    const cols = {
      name: search.createColumn({ name: 'itemid', sort: search.Sort.ASC }),
      description: search.createColumn({ name: 'salesdescription' }),
      type: search.createColumn({ name: 'type' }),
      location: search.createColumn({ name: 'inventorylocation' }),
      preferred: search.createColumn({ name: 'locationpreferredstocklevel' }),
      reorderPoint: search.createColumn({ name: 'locationreorderpoint' }),
      onHand: search.createColumn({ name: 'locationquantityonhand' }),
      committed: search.createColumn({ name: 'locationquantitycommitted' }),
      available: search.createColumn({ name: 'locationquantityavailable' }),
      onOrder: search.createColumn({ name: 'locationquantityonorder' }),
      special: search.createColumn({ name: SPECIAL_FIELD })
    };
    s.columns = Object.values(cols);
    if (jtape === 'T' || jtape === 'F') {
      s.filters = s.filters.concat(search.createFilter({ name: JTAPE_FIELD, operator: search.Operator.IS, values: jtape }));
    }
    const rows = [];
    const paged = s.runPaged({ pageSize: 1000 });
    paged.pageRanges.forEach(range => {
      paged.fetch({ index: range.index }).data.forEach(r => {
        rows.push({
          id: r.id,
          name: r.getValue(cols.name),
          description: r.getValue(cols.description),
          typeId: r.getValue(cols.type),
          type: r.getText(cols.type),
          locationId: r.getValue(cols.location),
          location: r.getText(cols.location),
          preferred: num(r.getValue(cols.preferred)),
          reorderPoint: num(r.getValue(cols.reorderPoint)),
          onHand: num(r.getValue(cols.onHand)),
          committed: num(r.getValue(cols.committed)),
          available: num(r.getValue(cols.available)),
          onOrder: num(r.getValue(cols.onOrder)),
          special: r.getValue(cols.special) === true || r.getValue(cols.special) === 'T'
        });
      });
    });
    return rows;
  }

  const RECORD_ID = /^[1-9]\d{0,9}$/;
  const MAX_EXCLUDED = 500;

  /** Customer internal IDs to leave out of demand, from a comma or multiselect (\u0005) separated list. */
  function excludedCustomers(value) {
    return [...new Set(String(value || '').split(/[\u0005,\s]+/).filter(id => RECORD_ID.test(id)))].slice(0, MAX_EXCLUDED);
  }

  const DEMAND_TYPES = `t.type IN ('ItemShip', 'WOCompl', 'WOIssue')`;
  const BASE_FILTERS = `${DEMAND_TYPES}
        AND t.trandate >= TO_DATE(?, 'YYYY-MM-DD') AND t.trandate <= TO_DATE(?, 'YYYY-MM-DD')
        AND t.posting = 'T' AND t.voided = 'F'`;
  /**
   * True for a completion line of the assembly being built: the completion's main line item. A completion
   * carries the built assembly on its main line and again on an offsetting negative line; neither is demand.
   */
  const BUILT_ASSEMBLY = `t.type = 'WOCompl' AND EXISTS (
          SELECT 1 FROM transactionline m WHERE m.transaction = t.id AND m.mainline = 'T' AND m.item = tl.item)`;

  /**
   * Which lines count as demand. Only stock leaving the location counts (negative quantity): the item line
   * on a fulfilment and component lines on completions and issues, never the assembly a completion adds.
   * Cost of goods sold lines repeat the item on fulfilments and are never counted. Excluded customers are
   * matched on the fulfilment's customer, and on the work order's customer for completions and issues.
   * No joins: the work order customer is checked with a subquery, so a join can never drop lines.
   * An item fulfilment has no separate header line: its main line is its first item line, so main lines count
   * for fulfilments. For completions and issues the main line is the transaction header and never counts.
   */
  function countedSql(customers) {
    const list = customers.join(',');
    return `tl.quantity < 0 AND NVL(tl.iscogs, 'F') = 'F' AND (tl.mainline = 'F' OR t.type = 'ItemShip')
        AND NOT (${BUILT_ASSEMBLY})${customers.length ? `
        AND NOT (t.type = 'ItemShip' AND NVL(t.entity, 0) IN (${list}))
        AND NOT (t.type IN ('WOCompl', 'WOIssue') AND t.id IN (
          SELECT h.transaction FROM transactionline h, transaction w
          WHERE h.mainline = 'T' AND w.id = h.createdfrom AND w.type = 'WorkOrd' AND w.entity IN (${list})))` : ''}`;
  }

  /** SuiteQL for demand totals per item, location and transaction type. IDs are validated integers. */
  function demandSql(locationIds, excluded = [], itemId = '') {
    const locs = [...new Set(locationIds.map(String))].filter(id => RECORD_ID.test(id));
    const customers = excludedCustomers(excluded.join(','));
    const item = RECORD_ID.test(String(itemId)) ? `
        AND tl.item = ${itemId}` : '';
    return { locs, sql: `
      SELECT tl.item AS item, tl.location AS location, t.type AS type, SUM(-tl.quantity) AS qty
      FROM transactionline tl
      JOIN transaction t ON t.id = tl.transaction
      WHERE ${BASE_FILTERS}
        AND tl.itemtype IN ('InvtPart', 'Assembly')
        AND tl.location IN (${locs.join(',')})${item}
        AND ${countedSql(customers)}
      GROUP BY tl.item, tl.location, t.type` };
  }

  /**
   * SuiteQL listing every candidate line for one item and location, flagged with whether it counts.
   * Same FROM and filters as demandSql (without the count rule), so it lists every line the total uses.
   */
  function traceSql(itemId, locationId, excluded = []) {
    if (!RECORD_ID.test(String(itemId)) || !RECORD_ID.test(String(locationId))) throw Error('Invalid item or location');
    const customers = excludedCustomers(excluded.join(','));
    return `
      SELECT t.id AS tranid_internal, t.tranid AS tranid, t.type AS type, TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate,
             BUILTIN.DF(tl.item) AS itemname, BUILTIN.DF(t.entity) AS customer, NVL(t.entity, 0) AS customerid,
             tl.id AS lineid, tl.quantity AS quantity, NVL(tl.iscogs, 'F') AS iscogs, tl.mainline AS mainline,
             CASE WHEN ${BUILT_ASSEMBLY} THEN 'T' ELSE 'F' END AS isbuilt,
             CASE WHEN ${countedSql(customers)} THEN 1 ELSE 0 END AS counted
      FROM transactionline tl
      JOIN transaction t ON t.id = tl.transaction
      WHERE ${BASE_FILTERS}
        AND tl.itemtype IN ('InvtPart', 'Assembly')
        AND tl.item = ${itemId} AND tl.location = ${locationId}
      ORDER BY t.trandate, t.id, tl.id`;
  }

  /** Created-from record and work order customer for listed transactions (display only, looked up separately). */
  function sourcesSql(transactionIds) {
    const ids = [...new Set(transactionIds.map(String))].filter(id => RECORD_ID.test(id));
    if (!ids.length) return '';
    return `
      SELECT h.transaction AS id, BUILTIN.DF(h.createdfrom) AS createdfrom, w.type AS sourcetype,
             BUILTIN.DF(w.entity) AS sourcecustomer, NVL(w.entity, 0) AS sourcecustomerid
      FROM transactionline h
      LEFT JOIN transaction w ON w.id = h.createdfrom
      WHERE h.mainline = 'T' AND h.transaction IN (${ids.join(',')})`;
  }

  /** Created-from details for a traced line; the work order customer only when the source is a work order. */
  function sourceFields(src) {
    if (!src) return { createdfrom: '', wocustomer: '', wocustomerid: 0 };
    const isWo = src.sourcetype === 'WorkOrd';
    return { createdfrom: src.createdfrom || '', wocustomer: isWo ? src.sourcecustomer || '' : '', wocustomerid: isWo ? num(src.sourcecustomerid) : 0 };
  }

  /** Why a traced line is or is not counted (explanation only; the query decides). */
  function lineReason(line, excluded = []) {
    if (num(line.counted) === 1) return 'Counted';
    if (line.iscogs === 'T') return 'Cost of goods line (duplicate of the item line)';
    if (line.isbuilt === 'T') return 'Assembly being built, not consumption';
    if (line.mainline === 'T' && line.type !== 'ItemShip') return 'Main line of the work order transaction';
    if (num(line.quantity) >= 0) return line.type === 'ItemShip' ? 'Not stock out (positive quantity)' : 'Output or stock in, not consumption';
    const customer = String(line.type === 'ItemShip' ? line.customerid : line.wocustomerid);
    if (excluded.includes(customer)) return 'Excluded customer';
    return 'Not counted';
  }

  /**
   * Demand per item|location in base units (see countedSql for which lines count).
   * Only posting, non-voided transactions count (picked/packed fulfilments are excluded).
   */
  function demandByItem(locationIds, window, excluded, itemId) {
    const result = {};
    const { locs, sql } = demandSql(locationIds, excluded, itemId);
    if (!locs.length) return result;
    const paged = query.runSuiteQLPaged({ query: sql, params: [ymd(window.start), ymd(window.end)], pageSize: 1000 });
    paged.pageRanges.forEach(range => {
      paged.fetch({ index: range.index }).data.asMappedResults().forEach(r => {
        const key = `${r.item}|${r.location}`;
        const entry = result[key] || (result[key] = { fulfilled: 0, consumed: 0 });
        if (r.type === 'ItemShip') entry.fulfilled += num(r.qty); else entry.consumed += num(r.qty);
      });
    });
    return result;
  }

  // ---------- Rendering ----------

  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (value, dp = 0) => value == null || value === '' ? '' : Number(value).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const blank = (value, dp) => (num(value) === 0 ? '' : fmt(value, dp));

  const bar = pct => `<div class="usm-progress"><div class="usm-bar" style="width:${Math.max(0, Math.min(100, pct))}%">${esc(pct)}%</div></div>`;

  function woLink(row) {
    if (row.typeId === 'InvtPart') return 'Inventory';
    if (row.replenish <= 0) return 'No WO Required';
    return `<a target="_blank" href="/app/accounting/transactions/workord.nl?assemblyitem=${encodeURIComponent(row.id)}&quantity=${encodeURIComponent(row.replenish)}&whence=">Create WO</a>`;
  }

  const traceLink = (r, text, type) => (text && r.traceUrl ? `<a target="_blank" title="Show the transaction lines behind this figure" href="${esc(`${r.traceUrl}&custpage_ttype=${type}`)}">${text}</a>` : text);

  const TYPE_LABEL = { ItemShip: 'Item Fulfilment', WOCompl: 'WO Completion', WOIssue: 'WO Issue' };

  /**
   * Sizes the table box to end at the bottom of the window, so the filters, buttons and notes above it stay on
   * screen and only the table scrolls (both ways) under its sticky column headings. Never below 300px.
   */
  const FIT_SCRIPT = `(function(){var w=document.querySelector('.usm-wrap');if(!w)return;
function fit(){var top=w.getBoundingClientRect().top+(window.pageYOffset||document.documentElement.scrollTop||0);
w.style.maxHeight=Math.max(300,Math.floor(window.innerHeight-top-24))+'px';}
fit();window.addEventListener('resize',fit);window.addEventListener('load',fit);})();`;

  const TRACE_FILTERS = [
    { key: '', value: '', label: 'All' },
    { key: 'fulfilled', value: 'ItemShip', label: 'Item Fulfilment' },
    { key: 'consumed', value: 'WOCompl,WOIssue', label: 'WO Completion + WO Issue' },
    { key: 'completion', value: 'WOCompl', label: 'WO Completion' },
    { key: 'issue', value: 'WOIssue', label: 'WO Issue' }
  ];

  /** Drill-down page body: every candidate line for one item, with what was counted and why. */
  function renderTrace(lines, settings, itemId, main, sourcesFailed) {
    const name = lines.length ? lines[0].itemname : `Item ${itemId}`;
    let fulfilled = 0, consumed = 0, skipped = 0;
    const body = lines.map(l => {
      const counted = num(l.counted) === 1 ? -num(l.quantity) : 0;
      if (!counted) skipped++; else if (l.type === 'ItemShip') fulfilled += counted; else consumed += counted;
      const customer = l.type === 'ItemShip' ? l.customer : l.wocustomer;
      return `<tr class="${counted ? '' : 'usm-skip'}" data-type="${esc(l.type)}" data-counted="${counted ? 1 : 0}" data-qty="${counted}"><td>${esc(l.trandate)}</td><td>${esc(TYPE_LABEL[l.type] || l.type)}</td>
<td><a target="_blank" href="/app/accounting/transactions/transaction.nl?id=${encodeURIComponent(l.tranid_internal)}">${esc(l.tranid)}</a></td>
<td>${esc(l.createdfrom)}</td><td>${esc(customer)}</td><td class="usm-num">${esc(fmt(l.quantity, 2))}</td><td>${l.mainline === 'T' ? 'Yes' : ''}</td><td>${l.iscogs === 'T' ? 'Yes' : ''}</td>
<td class="usm-num">${counted ? esc(fmt(counted, 2)) : ''}</td><td>${esc(lineReason(l, settings.excluded))}</td></tr>`;
    }).join('');
    return `
<style>
  .usm-wrap{overflow:auto;max-height:75vh;font-size:12px;border-bottom:1px solid #ddd}
  table.usm{border-collapse:collapse}
  table.usm th{background:#e5e5e5;text-transform:uppercase;font-weight:normal;font-size:11px;padding:6px;text-align:left;white-space:nowrap;position:sticky;top:0;z-index:2;box-shadow:0 1px 0 #ccc}
  table.usm td{padding:4px 8px;border-bottom:1px solid #eee;white-space:nowrap}
  table.usm td.usm-num{text-align:right}
  tr.usm-skip td{color:#999}
  .usm-note{margin:6px 0 10px;font-size:13px}
  .usm-filter{margin:6px 0 10px;font-size:13px}
  .usm-filter select{font-size:13px;margin-right:12px}
  #usm-shown{margin-left:12px;color:#555}
  .usm-warn{margin:6px 0 10px;padding:6px 10px;background:#fff3cd;border:1px solid #e0b000;font-size:13px}
</style>
<div class="usm-note"><b>${esc(name)}</b>: transaction lines at this location from ${esc(ymd(settings.window.start))} to ${esc(ymd(settings.window.end))}.
 Counted: Fulfilled <b>${esc(fmt(fulfilled, 2))}</b>, WO Consumed <b>${esc(fmt(consumed, 2))}</b>. ${esc(skipped)} line${skipped === 1 ? '' : 's'} shown in grey ${skipped === 1 ? 'is' : 'are'} not counted.
 Line quantity is NetSuite's transaction line quantity (negative = stock out).</div>
${main && (Math.abs(num(main.fulfilled) - fulfilled) > 0.0001 || Math.abs(num(main.consumed) - consumed) > 0.0001)
    ? `<div class="usm-warn">These lines do not add up to the main list (Fulfilled ${esc(fmt(main.fulfilled, 2))}, WO Consumed ${esc(fmt(main.consumed, 2))}). Please report this.</div>`
    : `<div class="usm-note">Matches the main list.</div>`}
${sourcesFailed ? '<div class="usm-warn">Created From and work order customers could not be read; the figures are unaffected.</div>' : ''}
<div class="usm-filter">Type <select id="usm-type">${TRACE_FILTERS.map(f => `<option value="${f.value}"${f.key === settings.traceType ? ' selected' : ''}>${f.label}</option>`).join('')}</select>
 <label><input type="checkbox" id="usm-counted"> Counted lines only</label> <span id="usm-shown"></span></div>
<div class="usm-wrap"><table class="usm" id="usm-trace"><thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Created From</th><th>Customer</th><th>Line Quantity</th><th>Main Line</th><th>COGS Line</th><th>Counted</th><th>Reason</th></tr></thead>
<tbody>${body}</tbody></table></div>
<script>
(function(){var t=document.getElementById('usm-trace'),sel=document.getElementById('usm-type'),only=document.getElementById('usm-counted'),info=document.getElementById('usm-shown');
if(!t||!sel||!only)return;
function apply(){var types=sel.value?sel.value.split(','):null,shown=0,total=0;
[].slice.call(t.tBodies[0].rows).forEach(function(row){var ok=(!types||types.indexOf(row.getAttribute('data-type'))>=0)&&(!only.checked||row.getAttribute('data-counted')==='1');
row.style.display=ok?'':'none';if(ok){shown++;total+=parseFloat(row.getAttribute('data-qty'))||0;}});
info.textContent='Showing '+shown+' of '+t.tBodies[0].rows.length+' lines; counted quantity shown: '+total.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});}
sel.addEventListener('change',apply);only.addEventListener('change',apply);apply();})();
${FIT_SCRIPT}
</script>`;
  }

  const LIGHT_ORDER = { red: 0, amber: 1, green: 2, '': 3 };
  const LIGHT_LABEL = { red: 'Red', amber: 'Amber', green: 'Green', '': '' };
  const LIGHT_TITLE = { red: 'Below 50% of recommended cover', amber: '50% to 100% of recommended cover', green: 'At or above recommended cover' };
  const light = status => (status ? `<span class="usm-light usm-light-${status}" title="${esc(LIGHT_TITLE[status])}"></span>` : '');
  const NUMERIC = new Set(['Preferred Stock', 'Replenish Level', 'Current Stock', 'Committed', 'Available', "WO's", 'Qty to Replenish', 'Fulfilled',
    'WO Consumed', 'Avg Weekly Demand', 'Recommended Stock', 'Recommended vs Preferred', 'Weeks Cover', 'Shortfall to Recommended']);

  // Default layout: this order, with DEFAULT_HIDDEN columns hidden. Viewers can change both on the page.
  const COLUMNS = [
    ['Name', r => `<a target="_blank" href="/app/common/item/item.nl?id=${encodeURIComponent(r.id)}">${esc(r.name)}</a>`, r => r.name],
    ['Description', r => esc(r.description), r => r.description],
    ['% Stocked', r => bar(r.pctStocked), r => r.pctStocked],
    ['% Available', r => bar(r.pctAvailable), r => r.pctAvailable],
    ['Recommended Stock', r => blank(r.recommended), r => r.recommended],
    ['Preferred Stock', r => fmt(r.preferred), r => r.preferred],
    ['Replenish Level', r => fmt(r.reorderPoint), r => r.reorderPoint],
    ['Current Stock', r => blank(r.onHand), r => r.onHand],
    ['Committed', r => blank(r.committed), r => r.committed],
    ['Available', r => blank(r.available), r => r.available],
    ['Avg Weekly Demand', r => blank(r.avgWeekly, 1), r => r.avgWeekly],
    ['Weeks Cover', r => (r.weeksCover == null ? '' : fmt(r.weeksCover, 1)), r => (r.weeksCover == null ? 99999 : r.weeksCover), r => (r.weeksCover == null ? '' : r.weeksCover)],
    ['Cover Status', r => light(r.coverStatus), r => LIGHT_ORDER[r.coverStatus], r => LIGHT_LABEL[r.coverStatus]],
    ['Qty to Replenish', r => fmt(r.replenish), r => r.replenish],
    ['Create WO', woLink, () => ''],
    ["WO's", r => blank(r.onOrder), r => r.onOrder],
    ['Fulfilled', r => traceLink(r, blank(r.fulfilled), 'fulfilled'), r => r.fulfilled],
    ['WO Consumed', r => traceLink(r, blank(r.consumed), 'consumed'), r => r.consumed],
    ['Recommended vs Preferred', r => (r.vsPreferred > 0 ? '+' : '') + fmt(r.vsPreferred), r => r.vsPreferred],
    ['Shortfall to Recommended', r => blank(r.shortfall), r => r.shortfall]
  ];

  /** Stable key per column, used for the column chooser, its saved choice and the CSV export. */
  const colKey = c => c[0].toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ALWAYS_SHOWN = 'name';
  const DEFAULT_HIDDEN = ['fulfilled', 'wo-consumed', 'recommended-vs-preferred', 'shortfall-to-recommended'];

  /** Column keys to hide, from a comma list; unknown keys and Name are ignored. */
  function hiddenColumns(value) {
    const known = new Set(COLUMNS.map(colKey));
    return [...new Set(String(value || '').split(',').map(k => k.trim()).filter(k => known.has(k) && k !== ALWAYS_SHOWN))];
  }

  function columnChooser() {
    const boxes = COLUMNS.filter(c => colKey(c) !== ALWAYS_SHOWN).map(c =>
      `<label><input type="checkbox" data-key="${esc(colKey(c))}" checked> ${esc(c[0])}</label>`).join('');
    return `<div class="usm-cols"><button type="button" id="usm-cols-btn">Choose columns &#9662;</button>
<div id="usm-cols-box" style="display:none">${boxes}<div class="usm-cols-actions"><a href="#" id="usm-cols-all">Show all</a> &middot; <a href="#" id="usm-cols-order">Restore default layout</a></div></div></div>`;
  }

  function renderTable(rows, settings) {
    const head = COLUMNS.map((c, i) => `<th data-col="${i}" data-key="${colKey(c)}" draggable="true" title="Click to sort, drag to move" class="c-${colKey(c)}">${esc(c[0])}</th>`).join('');
    const body = rows.map(r => `<tr class="${r.highlight ? 'usm-' + r.highlight : ''}">${COLUMNS.map((c, i) => {
      const sortValue = c[2](r);
      const align = NUMERIC.has(c[0]) ? ' usm-num' : c[0] === 'Cover Status' ? ' usm-center' : '';
      return `<td data-sort="${esc(sortValue)}" class="c-${colKey(c)}${align}">${c[1](r)}</td>`;
    }).join('')}</tr>`).join('');
    return `
<style>
  .usm-wrap{overflow:auto;max-height:75vh;font-size:12px;border-bottom:1px solid #ddd}
  .usm-note{margin:6px 0 10px;color:#555}
  table.usm{border-collapse:collapse;width:100%}
  table.usm th{background:#e5e5e5;text-transform:uppercase;font-weight:normal;font-size:11px;padding:6px;text-align:left;cursor:pointer;white-space:nowrap;position:sticky;top:0;z-index:2;box-shadow:0 1px 0 #ccc}
  table.usm td{padding:4px 6px;border-bottom:1px solid #eee;white-space:nowrap}
  table.usm td.usm-num{text-align:right}
  tr.usm-special td,tr.usm-special a{background:#ff9900;color:#c00}
  tr.usm-replenish td,tr.usm-replenish a{background:#ffff66;color:#c00}
  tr.usm-covered td,tr.usm-covered a{background:#ccee99;color:#c00}
  table.usm td.usm-center{text-align:center}
  .usm-light{display:inline-block;width:14px;height:14px;border-radius:50%;border:1px solid rgba(0,0,0,.35);vertical-align:middle}
  .usm-light-green{background:#22c23b}
  .usm-light-amber{background:#ffb000}
  .usm-light-red{background:#c23b22}
  .usm-cols{position:relative;margin:0 0 8px}
  .usm-cols button{font-size:12px;padding:3px 10px;cursor:pointer}
  #usm-cols-box{position:absolute;z-index:10;background:#fff;border:1px solid #ccc;box-shadow:0 2px 8px rgba(0,0,0,.2);padding:8px 12px;margin-top:4px;columns:2;column-gap:24px;font-size:12px}
  #usm-cols-box label{display:block;white-space:nowrap;padding:2px 0;break-inside:avoid}
  table.usm th.usm-dragging{opacity:.4}
  table.usm th.usm-drop{box-shadow:inset 3px 0 0 #1f6fd1}
  .usm-cols-actions{padding-top:6px;break-inside:avoid}
  .usm-progress{overflow:hidden;height:16px;width:64px;background:#c23b22;border-radius:4px;box-shadow:inset 0 1px 2px rgba(0,0,0,.1)}
  .usm-bar{float:left;height:100%;font-size:10px;line-height:16px;color:#fff;text-align:center;background:#22c23b;box-shadow:inset 0 -1px 0 rgba(0,0,0,.15)}
</style>
<div class="usm-note">${esc(rows.length)} items. Demand ${esc(ymd(settings.window.start))} to ${esc(ymd(settings.window.end))}
 (${esc(fmt(settings.window.weeks, 1))} weeks): posted item fulfilments plus components consumed by work order completions and issues, in base units.${settings.excluded && settings.excluded.length ? ` <b>Excluding ${esc(settings.excluded.length)} customer${settings.excluded.length === 1 ? '' : 's'}</b> (their fulfilments and work orders).` : ''}
 Recommended stock = average weekly demand &times; ${esc(settings.weeks)} weeks. Cover Status: green = weeks cover at or above ${esc(settings.weeks)} weeks, amber = 50% to 100% of it, red = below 50%. Click a Fulfilled or WO Consumed figure to see the transaction lines behind it. Click a column heading to sort.</div>
${columnChooser()}
<style id="usm-hide"></style>
<div class="usm-wrap"><table class="usm" id="usm"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
<script>
(function(){var t=document.getElementById('usm');if(!t)return;var dir={};
function cell(row,k){return row.querySelector('.c-'+k);}
t.querySelectorAll('th').forEach(function(th){th.addEventListener('click',function(){var k=th.getAttribute('data-key');dir[k]=!dir[k];
var rows=[].slice.call(t.tBodies[0].rows);rows.sort(function(a,b){var x=cell(a,k).getAttribute('data-sort'),y=cell(b,k).getAttribute('data-sort');
var nx=parseFloat(x),ny=parseFloat(y);var c=(!isNaN(nx)&&!isNaN(ny))?nx-ny:String(x).localeCompare(String(y));return dir[k]?c:-c;});
rows.forEach(function(r){t.tBodies[0].appendChild(r);});});});})();
(function(){var KEY='usm-column-order',t=document.getElementById('usm');if(!t)return;
var head=t.tHead.rows[0],initial=[].map.call(head.cells,function(c){return c.getAttribute('data-key');}),dragged=null;
function current(){return [].map.call(head.cells,function(c){return c.getAttribute('data-key');});}
function arrange(order){var keys=order.filter(function(k){return initial.indexOf(k)>=0;});
initial.forEach(function(k){if(keys.indexOf(k)<0)keys.push(k);});
[].slice.call(t.rows).forEach(function(row){keys.forEach(function(k){var c=row.querySelector('.c-'+k);if(c)row.appendChild(c);});});
try{window.localStorage.setItem(KEY,keys.join(','));}catch(e){}}
window.usmColumnOrder=function(){return current().join(',');};
window.usmResetColumnOrder=function(){arrange(initial);};
[].forEach.call(head.cells,function(th){
th.addEventListener('dragstart',function(e){dragged=th.getAttribute('data-key');th.classList.add('usm-dragging');try{e.dataTransfer.setData('text/plain',dragged);}catch(x){}e.dataTransfer.effectAllowed='move';});
th.addEventListener('dragend',function(){th.classList.remove('usm-dragging');[].forEach.call(head.cells,function(c){c.classList.remove('usm-drop');});dragged=null;});
th.addEventListener('dragover',function(e){if(!dragged)return;e.preventDefault();e.dataTransfer.dropEffect='move';th.classList.add('usm-drop');});
th.addEventListener('dragleave',function(){th.classList.remove('usm-drop');});
th.addEventListener('drop',function(e){e.preventDefault();th.classList.remove('usm-drop');var target=th.getAttribute('data-key');if(!dragged||dragged===target)return;
var order=current(),from=order.indexOf(dragged);order.splice(from,1);var to=order.indexOf(target);
var rect=th.getBoundingClientRect();if(e.clientX>rect.left+rect.width/2)to++;order.splice(to,0,dragged);arrange(order);});});
var saved='';try{saved=window.localStorage.getItem(KEY)||'';}catch(e){}
if(saved)arrange(saved.split(','));})();
${FIT_SCRIPT}
(function(){var KEY='usm-hidden-columns',box=document.getElementById('usm-cols-box'),btn=document.getElementById('usm-cols-btn'),style=document.getElementById('usm-hide');
if(!box||!btn||!style)return;var inputs=[].slice.call(box.querySelectorAll('input[data-key]'));var hidden=[];
var DEFAULT=${JSON.stringify(DEFAULT_HIDDEN)},saved=null;try{saved=window.localStorage.getItem(KEY);}catch(e){}
hidden=saved===null?DEFAULT.slice():saved.split(',').filter(Boolean);
function apply(){style.textContent=hidden.map(function(k){return 'table.usm .c-'+k+'{display:none}';}).join('');
inputs.forEach(function(i){i.checked=hidden.indexOf(i.getAttribute('data-key'))<0;});
try{window.localStorage.setItem(KEY,hidden.join(','));}catch(e){}}
window.usmHiddenColumns=function(){return hidden.join(',');};
inputs.forEach(function(i){i.addEventListener('change',function(){hidden=inputs.filter(function(x){return !x.checked;}).map(function(x){return x.getAttribute('data-key');});apply();});});
btn.addEventListener('click',function(e){e.preventDefault();box.style.display=box.style.display==='none'?'':'none';});
document.getElementById('usm-cols-all').addEventListener('click',function(e){e.preventDefault();hidden=[];apply();});
document.getElementById('usm-cols-order').addEventListener('click',function(e){e.preventDefault();hidden=DEFAULT.slice();apply();if(window.usmResetColumnOrder)window.usmResetColumnOrder();});
document.addEventListener('click',function(e){if(!box.contains(e.target)&&e.target!==btn)box.style.display='none';});
apply();})();
</script>`;
  }

  /** Columns in the order a viewer arranged them; unknown keys are ignored and missing columns keep their place at the end. */
  function orderedColumns(order) {
    const keys = String(order || '').split(',').map(k => k.trim());
    const picked = keys.map(k => COLUMNS.find(c => colKey(c) === k)).filter(Boolean);
    return [...new Set(picked.concat(COLUMNS))];
  }

  function toCsv(rows, hidden = [], order = '') {
    const cell = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = orderedColumns(order).filter(c => colKey(c) !== 'create-wo' && !hidden.includes(colKey(c)));
    const headers = cols.map(c => c[0]).concat('Location');
    const lines = rows.map(r => cols.map(c => (c[3] || c[2])(r)).concat(r.location).map(cell).join(','));
    return [headers.map(cell).join(',')].concat(lines).join('\r\n');
  }

  // ---------- Entry point ----------

  function settingsFrom(request) {
    const script = runtime.getCurrentScript();
    const p = request.parameters || {};
    const months = clampInt(p.custpage_months, 1, 24, DEFAULTS.months);
    return {
      searchId: String(script.getParameter({ name: 'custscript_usm_search' }) || 'customsearch1983'),
      months,
      weeks: clampInt(p.custpage_weeks, 1, 52, DEFAULTS.weeks),
      jtape: ['T', 'F'].includes(p.custpage_jtape) ? p.custpage_jtape : '',
      excluded: excludedCustomers(p.custpage_exclude),
      traceType: ['fulfilled', 'consumed', 'completion', 'issue'].includes(p.custpage_ttype) ? p.custpage_ttype : '',
      traceItem: RECORD_ID.test(String(p.custpage_trace || '')) ? String(p.custpage_trace) : '',
      traceLocation: RECORD_ID.test(String(p.custpage_loc || '')) ? String(p.custpage_loc) : '',
      csv: p.custpage_csv === 'T',
      hidden: hiddenColumns(p.custpage_hide),
      order: String(p.custpage_order || '').slice(0, 2000),
      window: demandWindow(new Date(), months)
    };
  }

  function onRequest(context) {
    const { request, response } = context;
    if (request.method === 'POST') {
      const p = request.parameters;
      const script = runtime.getCurrentScript();
      redirect.toSuitelet({
        scriptId: script.id,
        deploymentId: script.deploymentId,
        parameters: { custpage_months: p.custpage_months, custpage_weeks: p.custpage_weeks, custpage_jtape: p.custpage_jtape || '', custpage_exclude: excludedCustomers(p.custpage_exclude).join(',') }
      });
      return;
    }

    const settings = settingsFrom(request);
    const script = runtime.getCurrentScript();
    const base = `/app/site/hosting/scriptlet.nl?script=${encodeURIComponent(script.id)}&deploy=${encodeURIComponent(script.deploymentId)}`
      + `&custpage_months=${settings.months}&custpage_exclude=${encodeURIComponent(settings.excluded.join(','))}`;

    if (settings.traceItem && settings.traceLocation) {
      const dates = [ymd(settings.window.start), ymd(settings.window.end)];
      const lines = [];
      const paged = query.runSuiteQLPaged({ query: traceSql(settings.traceItem, settings.traceLocation, settings.excluded), params: dates, pageSize: 1000 });
      paged.pageRanges.forEach(range => paged.fetch({ index: range.index }).data.asMappedResults().forEach(l => lines.push(l)));
      // Display-only details; a failure here leaves those cells blank but never changes the figures.
      const sources = {};
      const ids = [...new Set(lines.map(l => String(l.tranid_internal)))];
      for (let i = 0; i < ids.length; i += 900) {
        try {
          const sql = sourcesSql(ids.slice(i, i + 900));
          if (sql) query.runSuiteQL({ query: sql }).asMappedResults().forEach(x => { sources[String(x.id)] = x; });
        } catch (e) { sources.failed = true; }
      }
      lines.forEach(l => Object.assign(l, sourceFields(sources[String(l.tranid_internal)])));
      // The main list's figures for this item, from the same aggregate query, to prove the two agree.
      const main = demandByItem([settings.traceLocation], settings.window, settings.excluded, settings.traceItem)[`${settings.traceItem}|${settings.traceLocation}`];
      const traceForm = serverWidget.createForm({ title: 'UK Stock Monitor: demand lines' });
      const out = traceForm.addField({ id: 'custpage_trace_html', type: serverWidget.FieldType.INLINEHTML, label: 'Lines' });
      out.defaultValue = renderTrace(lines, settings, settings.traceItem, main || { fulfilled: 0, consumed: 0 }, Boolean(sources.failed));
      response.writePage(traceForm);
      return;
    }

    const stock = stockRows(settings, settings.jtape);
    const demand = demandByItem(stock.map(r => r.locationId), settings.window, settings.excluded);
    const rows = stock.map(r => ({ ...evaluate(r, demand[`${r.id}|${r.locationId}`], settings.window, settings.weeks),
      traceUrl: `${base}&custpage_trace=${encodeURIComponent(r.id)}&custpage_loc=${encodeURIComponent(r.locationId)}` }));

    if (settings.csv) {
      response.writeFile({ file: file.create({ name: `uk-stock-monitor-${ymd(settings.window.end)}.csv`, fileType: file.Type.CSV, contents: toCsv(rows, settings.hidden, settings.order) }), isInline: false });
      return;
    }

    const form = serverWidget.createForm({ title: 'UK Stock Monitor' });
    form.addFieldGroup({ id: 'custpage_filters', label: 'Filters' });
    const months = form.addField({ id: 'custpage_months', type: serverWidget.FieldType.INTEGER, label: 'Demand history (months)', container: 'custpage_filters' });
    months.defaultValue = settings.months;
    const weeks = form.addField({ id: 'custpage_weeks', type: serverWidget.FieldType.INTEGER, label: 'Recommended cover (weeks)', container: 'custpage_filters' });
    weeks.defaultValue = settings.weeks;
    const jtape = form.addField({ id: 'custpage_jtape', type: serverWidget.FieldType.SELECT, label: 'JTAPE Product?', container: 'custpage_filters' });
    jtape.addSelectOption({ value: '', text: '- All -' });
    jtape.addSelectOption({ value: 'T', text: 'Yes' });
    jtape.addSelectOption({ value: 'F', text: 'No' });
    jtape.defaultValue = settings.jtape;
    const exclude = form.addField({ id: 'custpage_exclude', type: serverWidget.FieldType.MULTISELECT, label: 'Exclude customers from demand', source: 'customer', container: 'custpage_filters' });
    exclude.setHelpText({ help: 'Fulfilments to these customers, and work orders for these customers, are left out of average weekly demand and the recommended stock.' });
    if (settings.excluded.length) exclude.defaultValue = settings.excluded;
    form.addSubmitButton({ label: 'Refresh' });
    const csvParams = { custpage_months: settings.months, custpage_weeks: settings.weeks, custpage_jtape: settings.jtape, custpage_exclude: settings.excluded.join(','), custpage_csv: 'T' };
    const qs = Object.keys(csvParams).map(k => `${k}=${encodeURIComponent(csvParams[k])}`).join('&');
    form.addButton({ id: 'custpage_export', label: 'Export CSV', functionName: `(function(){window.location.href=window.location.pathname+'?script=${encodeURIComponent(script.id)}&deploy=${encodeURIComponent(script.deploymentId)}&${qs}'+(window.usmHiddenColumns?'&custpage_hide='+encodeURIComponent(window.usmHiddenColumns()):'')+(window.usmColumnOrder?'&custpage_order='+encodeURIComponent(window.usmColumnOrder()):'');})` });
    const html = form.addField({ id: 'custpage_results', type: serverWidget.FieldType.INLINEHTML, label: 'Results' });
    html.defaultValue = renderTable(rows, settings);
    response.writePage(form);
  }

  return { onRequest, _test: { DEFAULT_HIDDEN, orderedColumns, sourcesSql, sourceFields, traceSql, lineReason, renderTrace, countedSql, excludedCustomers, demandSql, hiddenColumns, colKey, COLUMNS, renderTable, coverStatus, demandWindow, qtyToReplenish, evaluate, percent, toCsv, clampInt } };
});
