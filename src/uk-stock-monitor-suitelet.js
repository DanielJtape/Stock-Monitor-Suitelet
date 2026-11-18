/**
 * UK Stock Monitor with demand-based stockholding. Read-only: it never creates or changes records.
 *
 * Stock levels come from the existing "UK Stock Monitor" saved search (customsearch1983 by default), so its
 * criteria (Warehouse location, reorder point set, active, not Raw Material) stay maintained in one place.
 * Demand is read with SuiteQL from posted item fulfilments, work order completions (backflushed component
 * lines) and work order issues at the same location over the look-back period (default 6 months).
 *
 * Item fields: custitem_isjtape ("JTAPE Product?" filter) and isspecialworkorderitem ("Special Work Order
 * Item", orange rows). Optional script parameters: custscript_usm_search overrides the saved search ID;
 * custscript_usm_exclude_customers (Free-Form Text: customer internal IDs separated by commas, e.g. 1234,5678)
 * is the customers excluded from demand when the page first opens. Viewers can change the exclusion on the form.
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
      // Highlighting: orange = special WO item; yellow = at or below replenish level with nothing on order.
      highlight: row.special ? 'special' : position - num(row.reorderPoint) <= 0 && num(row.onOrder) <= 0 ? 'replenish' : ''
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

  /**
   * Customers excluded from demand: the viewer's choice once they have submitted the form (custpage_exset=T),
   * even if they cleared it, otherwise the deployment's default from the script parameter.
   */
  function chosenExclusions(params, defaultValue) {
    return params.custpage_exset === 'T' ? excludedCustomers(params.custpage_exclude) : excludedCustomers(Array.isArray(defaultValue) ? defaultValue.join(',') : defaultValue);
  }

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

  const DAY = 86400000;
  const utcYmd = ms => new Date(ms).toISOString().slice(0, 10);
  const utcDay = text => { const [y, m, d] = String(text).split('-').map(Number); return Date.UTC(y, m - 1, d); };

  /**
   * Weekly demand for the chart, from counted drill-down lines. Weeks are 7-day periods from the window start
   * (the last one may be partial), so the average is the same total / window weeks as the main list. The median
   * uses full weeks only. Transactions are totalled per document so one large order shows as one entry.
   */
  function weeklyDemand(lines, window) {
    const start = utcDay(ymd(window.start));
    const end = utcDay(ymd(window.end));
    const count = Math.floor((end - start) / DAY / 7) + 1;
    const weeks = Array.from({ length: count }, (_, i) => {
      const from = start + i * 7 * DAY;
      const to = Math.min(from + 6 * DAY, end);
      return { start: utcYmd(from), end: utcYmd(to), days: Math.round((to - from) / DAY) + 1, fulfilled: 0, consumed: 0, txns: {} };
    });
    const docs = {};
    lines.forEach(l => {
      if (num(l.counted) !== 1) return;
      const qty = -num(l.quantity);
      const index = Math.floor((utcDay(l.trandate) - start) / DAY / 7);
      const week = weeks[index];
      if (!week) return;
      if (l.type === 'ItemShip') week.fulfilled += qty; else week.consumed += qty;
      const key = String(l.tranid_internal || l.tranid);
      const doc = docs[key] || (docs[key] = { id: key, number: l.tranid, date: l.trandate, type: TYPE_LABEL[l.type] || l.type,
        customer: (l.type === 'ItemShip' ? l.customer : l.wocustomer) || '', qty: 0, week: index });
      doc.qty += qty;
      week.txns[key] = doc;
    });
    const round = v => Math.round(v * 100) / 100;
    const total = weeks.reduce((sum, w) => sum + w.fulfilled + w.consumed, 0);
    const windowWeeks = window.weeks || ((end - start) / DAY + 1) / 7;
    const full = weeks.filter(w => w.days === 7).map(w => w.fulfilled + w.consumed).sort((a, b) => a - b);
    const median = full.length ? (full.length % 2 ? full[(full.length - 1) / 2] : (full[full.length / 2 - 1] + full[full.length / 2]) / 2) : 0;
    const ranked = Object.values(docs).sort((a, b) => b.qty - a.qty);
    const largest = ranked.length ? ranked[0].qty : 0;
    return {
      total: round(total),
      windowWeeks: round(windowWeeks),
      average: round(windowWeeks > 0 ? total / windowWeeks : 0),
      median: round(median),
      averageWithoutLargest: round(windowWeeks > 0 ? (total - largest) / windowWeeks : 0),
      largestShare: total > 0 ? Math.round((largest / total) * 1000) / 10 : 0,
      weeks: weeks.map(w => ({ start: w.start, end: w.end, partial: w.days < 7, fulfilled: round(w.fulfilled), consumed: round(w.consumed),
        txns: Object.values(w.txns).sort((a, b) => b.qty - a.qty).slice(0, 3).map(d => ({ number: d.number, customer: d.customer, qty: round(d.qty) })) })),
      top: ranked.slice(0, 8).map(d => ({ id: d.id, number: d.number, date: d.date, type: d.type, customer: d.customer, qty: round(d.qty),
        share: total > 0 ? Math.round((d.qty / total) * 1000) / 10 : 0 }))
    };
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

  const chartButton = r => (r.traceUrl && num(r.avgWeekly) > 0
    ? `<button type="button" class="usm-chart-btn" title="Weekly demand chart" aria-label="Weekly demand chart for ${esc(r.name)}" data-url="${esc(`${r.traceUrl}&custpage_weekly=T`)}" data-name="${esc(`${r.name} ${r.description || ''}`.trim())}" data-trace="${esc(`${r.traceUrl}&custpage_ttype=`)}"><svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><rect x="1" y="6" width="3" height="6" rx="1"/><rect x="5.5" y="2" width="3" height="10" rx="1"/><rect x="10" y="4" width="3" height="8" rx="1"/></svg></button>`
    : '');
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

  /**
   * Browser code for the weekly demand pop-up (embedded with toString, never run on the server). It fetches the
   * weekly JSON for the row and draws stacked weekly bars (Fulfilled, WO Consumed) with average and median
   * lines, a hover tooltip per week, and the largest transactions. Text is set with textContent only.
   */
  function chartClient() {
    var modal = document.getElementById('usm-modal');
    if (!modal) return;
    var body = document.getElementById('usm-modal-body'), title = document.getElementById('usm-modal-title');
    var NS = 'http://www.w3.org/2000/svg', C = { f: '#2a78d6', c: '#eb6834', ink: '#0b0b0b', muted: '#52514e', grid: '#e4e3df', surface: '#fcfcfb' };
    function el(tag, attrs, text, svg) {
      var n = svg ? document.createElementNS(NS, tag) : document.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      if (text != null) n.textContent = text;
      return n;
    }
    function fmt(v, dp) { return Number(v || 0).toLocaleString('en-GB', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp == null ? 2 : dp }); }
    function dm(text) { var p = String(text).split('-'); return p[2] + '/' + p[1]; }
    function close() { modal.hidden = true; body.textContent = ''; }
    modal.addEventListener('click', function (e) { if (e.target === modal || e.target.className === 'usm-close') close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) close(); });
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.usm-chart-btn');
      if (!btn) return;
      e.preventDefault();
      title.textContent = btn.getAttribute('data-name') + ': weekly demand';
      body.textContent = 'Loading\u2026';
      modal.hidden = false;
      fetch(btn.getAttribute('data-url'), { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { draw(d, btn.getAttribute('data-trace')); })
        .catch(function () { body.textContent = 'The weekly demand could not be loaded. Please try again.'; });
    });
    function stat(label, value) { var s = el('div', { class: 'usm-stat' }); s.appendChild(el('b', null, value)); s.appendChild(el('span', null, label)); return s; }
    function draw(d, traceBase) {
      body.textContent = '';
      var stats = el('div', { class: 'usm-stats' });
      stats.appendChild(stat('Average per week', fmt(d.average, 1)));
      stats.appendChild(stat('Median full week', fmt(d.median, 1)));
      stats.appendChild(stat('Average without the largest transaction', fmt(d.averageWithoutLargest, 1)));
      stats.appendChild(stat('Largest transaction share of total', fmt(d.largestShare, 1) + '%'));
      stats.appendChild(stat('Total over ' + fmt(d.windowWeeks, 1) + ' weeks', fmt(d.total, 0)));
      body.appendChild(stats);
      var legend = el('div', { class: 'usm-legend' });
      [['Fulfilled', C.f], ['WO Consumed', C.c]].forEach(function (k) { var s = el('span'); s.appendChild(el('span', { class: 'usm-key', style: 'background:' + k[1] })); s.appendChild(document.createTextNode(k[0])); legend.appendChild(s); });
      [['Average', '6 4'], ['Median full week', '1 4']].forEach(function (k) {
        var s = el('span'), sw = el('svg', { width: 22, height: 10, style: 'vertical-align:middle;margin-right:5px' }, null, true);
        sw.appendChild(el('line', { x1: 1, x2: 21, y1: 5, y2: 5, stroke: C.ink, 'stroke-width': 1.5, 'stroke-dasharray': k[1], 'stroke-linecap': 'round' }, null, true));
        s.appendChild(sw); s.appendChild(document.createTextNode(k[0])); legend.appendChild(s);
      });
      body.appendChild(legend);
      var W = 860, H = 280, L = 52, R = 70, T = 12, B = 30, n = d.weeks.length;
      var max = Math.max.apply(null, d.weeks.map(function (w) { return w.fulfilled + w.consumed; }).concat([d.average, d.median, 1]));
      var step = Math.pow(10, Math.floor(Math.log10(max / 4))), nice = [1, 2, 2.5, 5, 10].map(function (m) { return m * step; }).filter(function (v) { return v * 4 >= max; })[0] || step * 10;
      var top = nice * 4, y = function (v) { return T + (H - T - B) * (1 - v / top); }, slot = (W - L - R) / n, bw = Math.max(3, slot - 4);
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Weekly demand bar chart' }, null, true);
      for (var g = 0; g <= 4; g++) {
        var gy = y(nice * g);
        svg.appendChild(el('line', { x1: L, x2: W - R, y1: gy, y2: gy, stroke: g ? C.grid : '#b9b8b2', 'stroke-width': 1 }, null, true));
        svg.appendChild(el('text', { x: L - 6, y: gy + 4, 'text-anchor': 'end', 'font-size': 11, fill: C.muted }, fmt(nice * g, 0), true));
      }
      var tip = el('div', { class: 'usm-tip' });
      var plot = el('div', { class: 'usm-plot' });
      d.weeks.forEach(function (w, i) {
        var x = L + i * slot + (slot - bw) / 2, f = w.fulfilled, c = w.consumed, op = w.partial ? 0.45 : 1;
        if (f > 0) {
          var top1 = y(f);
          svg.appendChild(el('path', { d: barPath(x, top1, bw, y(0) - top1, c > 0 ? 0 : 3), fill: C.f, opacity: op }, null, true));
        }
        if (c > 0) {
          var base = y(f) - (f > 0 ? 2 : 0);
          svg.appendChild(el('path', { d: barPath(x, y(f + c), bw, Math.max(1, base - y(f + c)), 3), fill: C.c, opacity: op }, null, true));
        }
        if (i % Math.ceil(n / 13) === 0) svg.appendChild(el('text', { x: x + bw / 2, y: H - B + 16, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, dm(w.start), true));
        var hit = el('rect', { x: L + i * slot, y: T, width: slot, height: H - T - B, fill: 'transparent' }, null, true);
        hit.addEventListener('mouseenter', function () { showTip(w, x + bw / 2, y(f + c)); });
        hit.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
        svg.appendChild(hit);
      });
      [[d.average, 'Avg ' + fmt(d.average, 1), '6 4'], [d.median, 'Median ' + fmt(d.median, 1), '1 4']].forEach(function (ref, k) {
        var ry = y(ref[0]);
        svg.appendChild(el('line', { x1: L, x2: W - R, y1: ry, y2: ry, stroke: C.ink, 'stroke-width': 1.5, 'stroke-dasharray': ref[2], 'stroke-linecap': 'round', 'pointer-events': 'none' }, null, true));
        var ly = ry + 4 + (k === 1 && Math.abs(y(d.average) - ry) < 14 ? (ry >= y(d.average) ? 12 : -12) : 0);
        svg.appendChild(el('text', { x: W - R + 6, y: ly, 'font-size': 11, fill: C.ink }, ref[1], true));
      });
      function showTip(w, cx, cy) {
        tip.textContent = '';
        tip.appendChild(el('div', null, dm(w.start) + ' \u2013 ' + dm(w.end) + (w.partial ? ' (part week)' : '')));
        var total = w.fulfilled + w.consumed;
        tip.appendChild(el('div', { style: 'font-weight:600' }, 'Total ' + fmt(total)));
        tip.appendChild(el('div', { class: 'usm-muted' }, 'Fulfilled ' + fmt(w.fulfilled) + ' \u00b7 WO Consumed ' + fmt(w.consumed)));
        w.txns.forEach(function (t) { tip.appendChild(el('div', { class: 'usm-muted' }, t.number + (t.customer ? ' \u00b7 ' + t.customer : '') + ': ' + fmt(t.qty))); });
        tip.style.display = 'block';
        var box = plot.getBoundingClientRect(), sx = box.width / W;
        var left = Math.min(Math.max(cx * sx - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth);
        tip.style.left = left + 'px';
        tip.style.top = Math.max(cy * sx - tip.offsetHeight - 8, 0) + 'px';
      }
      plot.appendChild(svg); plot.appendChild(tip); body.appendChild(plot);
      body.appendChild(el('div', { style: 'margin:12px 0 2px;font-weight:600' }, 'Largest transactions'));
      if (!d.top.length) { body.appendChild(el('div', null, 'No demand in the window.')); return; }
      var t = el('table', { class: 'usm-top' }), hr = el('tr');
      ['Date', 'Number', 'Type', 'Customer', 'Quantity', '% of total'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
      var thead = el('thead'); thead.appendChild(hr); t.appendChild(thead);
      var tb = el('tbody');
      d.top.forEach(function (x) {
        var tr = el('tr'), a = el('a', { href: '/app/accounting/transactions/transaction.nl?id=' + encodeURIComponent(x.id), target: '_blank' }, x.number);
        tr.appendChild(el('td', null, x.date)); var td = el('td'); td.appendChild(a); tr.appendChild(td);
        tr.appendChild(el('td', null, x.type)); tr.appendChild(el('td', null, x.customer));
        tr.appendChild(el('td', { class: 'usm-num' }, fmt(x.qty))); tr.appendChild(el('td', { class: 'usm-num' }, fmt(x.share, 1) + '%'));
        tb.appendChild(tr);
      });
      t.appendChild(tb); body.appendChild(t);
      var more = el('div', { style: 'margin-top:8px' }), link = el('a', { href: traceBase, target: '_blank' }, 'Open all transaction lines');
      more.appendChild(link); body.appendChild(more);
    }
    function barPath(x, yTop, w, h, r) {
      r = Math.min(r, w / 2, h);
      return 'M' + x + ',' + (yTop + h) + 'V' + (yTop + r) + 'Q' + x + ',' + yTop + ' ' + (x + r) + ',' + yTop + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + yTop + ' ' + (x + w) + ',' + (yTop + r) + 'V' + (yTop + h) + 'Z';
    }
  }

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
  table.usm tbody tr:hover td{box-shadow:inset 0 0 0 9999px rgba(42,120,214,.10)}
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
    ['Avg Weekly Demand', r => chartButton(r) + blank(r.avgWeekly, 1), r => r.avgWeekly],
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

  function columnChooser(settings = {}) {
    const boxes = COLUMNS.filter(c => colKey(c) !== ALWAYS_SHOWN).map(c =>
      `<label><input type="checkbox" data-key="${esc(colKey(c))}" checked> ${esc(c[0])}</label>`).join('');
    return `<div class="usm-cols"><button type="button" id="usm-cols-btn">Choose columns &#9662;</button>
<div id="usm-cols-box" style="display:none">${boxes}<div class="usm-cols-actions"><a href="#" id="usm-cols-all">Show all</a> &middot; <a href="#" id="usm-cols-order" title="Default columns, column order and excluded customers"${settings.resetUrl ? ` data-reset-url="${esc(settings.resetUrl)}"` : ''}>Restore default layout</a></div></div></div>`;
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
  table.usm tbody tr:hover td{box-shadow:inset 0 0 0 9999px rgba(42,120,214,.10)}
  tr.usm-special td,tr.usm-special a{background:#ff9900;color:#c00}
  tr.usm-replenish td,tr.usm-replenish a{background:#ffff66;color:#c00}
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
  .usm-chart-btn{border:1px solid #bbb;background:#fff;border-radius:3px;padding:1px 3px;margin-right:6px;cursor:pointer;vertical-align:middle;line-height:0}
  .usm-chart-btn svg{fill:#2a78d6}
  .usm-chart-btn:hover{border-color:#2a78d6}
  .usm-modal{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:1000;display:flex;align-items:center;justify-content:center}
  .usm-modal[hidden]{display:none}
  .usm-dialog{background:#fcfcfb;color:#0b0b0b;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.3);width:min(900px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:16px 20px;position:relative;font-size:12px;box-sizing:border-box}
  .usm-dialog h2{font-size:15px;margin:0 28px 8px 0}
  .usm-close{position:absolute;top:8px;right:10px;border:0;background:none;font-size:22px;cursor:pointer;color:#52514e}
  .usm-stats{display:flex;flex-wrap:wrap;gap:8px 24px;margin:4px 0 10px}
  .usm-stat b{display:block;font-size:16px;font-weight:600}
  .usm-stat span{color:#52514e}
  .usm-legend{display:flex;gap:16px;align-items:center;color:#52514e;margin:0 0 4px}
  .usm-key{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  .usm-plot{position:relative}
  .usm-plot svg{display:block;width:100%;height:auto}
  .usm-tip{position:absolute;pointer-events:none;background:#fff;border:1px solid #ccc;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.15);padding:6px 8px;font-size:12px;white-space:nowrap;display:none;z-index:2}
  .usm-tip .usm-muted{color:#52514e}
  table.usm-top{border-collapse:collapse;margin-top:6px}
  table.usm-top th{background:#e5e5e5;text-transform:uppercase;font-weight:normal;font-size:11px;padding:4px 8px;text-align:left}
  table.usm-top td{padding:3px 8px;border-bottom:1px solid #eee;white-space:nowrap}
  table.usm-top td.usm-num{text-align:right}
  .usm-cols-actions{padding-top:6px;break-inside:avoid}
  .usm-progress{overflow:hidden;height:16px;width:64px;background:#c23b22;border-radius:4px;box-shadow:inset 0 1px 2px rgba(0,0,0,.1)}
  .usm-bar{float:left;height:100%;font-size:10px;line-height:16px;color:#fff;text-align:center;background:#22c23b;box-shadow:inset 0 -1px 0 rgba(0,0,0,.15)}
</style>
<div class="usm-note">${esc(rows.length)} items. Demand ${esc(ymd(settings.window.start))} to ${esc(ymd(settings.window.end))}
 (${esc(fmt(settings.window.weeks, 1))} weeks): posted item fulfilments plus components consumed by work order completions and issues, in base units.${settings.excluded && settings.excluded.length ? ` <b>Excluding ${esc(settings.excluded.length)} customer${settings.excluded.length === 1 ? '' : 's'}</b> (their fulfilments and work orders).` : ''}
 Recommended stock = average weekly demand &times; ${esc(settings.weeks)} weeks. Cover Status: green = weeks cover at or above ${esc(settings.weeks)} weeks, amber = 50% to 100% of it, red = below 50%. Click a Fulfilled or WO Consumed figure to see the transaction lines behind it. Click a column heading to sort.</div>
${columnChooser(settings)}
<style id="usm-hide"></style>
<div class="usm-wrap"><table class="usm" id="usm"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
<div id="usm-modal" class="usm-modal" hidden><div class="usm-dialog" role="dialog" aria-modal="true" aria-labelledby="usm-modal-title">
<button type="button" class="usm-close" aria-label="Close">&times;</button><h2 id="usm-modal-title"></h2><div id="usm-modal-body"></div></div></div>
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
(${chartClient.toString()})();
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
document.getElementById('usm-cols-order').addEventListener('click',function(e){e.preventDefault();hidden=DEFAULT.slice();apply();if(window.usmResetColumnOrder)window.usmResetColumnOrder();
var reset=this.getAttribute('data-reset-url');if(reset)window.location.href=reset;});
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
      excluded: chosenExclusions(p, script.getParameter({ name: 'custscript_usm_exclude_customers' })),
      defaultExcluded: chosenExclusions({}, script.getParameter({ name: 'custscript_usm_exclude_customers' })),
      traceType: ['fulfilled', 'consumed', 'completion', 'issue'].includes(p.custpage_ttype) ? p.custpage_ttype : '',
      weekly: p.custpage_weekly === 'T',
      traceItem: RECORD_ID.test(String(p.custpage_trace || '')) ? String(p.custpage_trace) : '',
      traceLocation: RECORD_ID.test(String(p.custpage_loc || '')) ? String(p.custpage_loc) : '',
      csv: p.custpage_csv === 'T',
      hidden: hiddenColumns(p.custpage_hide),
      order: String(p.custpage_order || '').slice(0, 2000),
      window: demandWindow(new Date(), months)
    };
  }

  /** Every candidate line for the traced item, with created-from details (display only). */
  function loadTraceLines(settings) {
    const dates = [ymd(settings.window.start), ymd(settings.window.end)];
    const lines = [];
    const paged = query.runSuiteQLPaged({ query: traceSql(settings.traceItem, settings.traceLocation, settings.excluded), params: dates, pageSize: 1000 });
    paged.pageRanges.forEach(range => paged.fetch({ index: range.index }).data.asMappedResults().forEach(l => lines.push(l)));
    // A failure here leaves those details blank but never changes the figures.
    const sources = {};
    let sourcesFailed = false;
    const ids = [...new Set(lines.map(l => String(l.tranid_internal)))];
    for (let i = 0; i < ids.length; i += 900) {
      try {
        const sql = sourcesSql(ids.slice(i, i + 900));
        if (sql) query.runSuiteQL({ query: sql }).asMappedResults().forEach(x => { sources[String(x.id)] = x; });
      } catch (e) { sourcesFailed = true; }
    }
    lines.forEach(l => Object.assign(l, sourceFields(sources[String(l.tranid_internal)])));
    return { lines, sourcesFailed };
  }

  /** Page address that reapplies the default excluded customers, or '' when they are already in use. */
  function resetUrl(settings, script) {
    const same = settings.excluded.length === settings.defaultExcluded.length && settings.excluded.every(id => settings.defaultExcluded.includes(id));
    if (same) return '';
    return `/app/site/hosting/scriptlet.nl?script=${encodeURIComponent(script.id)}&deploy=${encodeURIComponent(script.deploymentId)}`
      + `&custpage_months=${settings.months}&custpage_weeks=${settings.weeks}&custpage_jtape=${encodeURIComponent(settings.jtape)}`;
  }

  function onRequest(context) {
    const { request, response } = context;
    if (request.method === 'POST') {
      const p = request.parameters;
      const script = runtime.getCurrentScript();
      redirect.toSuitelet({
        scriptId: script.id,
        deploymentId: script.deploymentId,
        parameters: { custpage_months: p.custpage_months, custpage_weeks: p.custpage_weeks, custpage_jtape: p.custpage_jtape || '', custpage_exclude: excludedCustomers(p.custpage_exclude).join(','), custpage_exset: 'T' }
      });
      return;
    }

    const settings = settingsFrom(request);
    const script = runtime.getCurrentScript();
    const base = `/app/site/hosting/scriptlet.nl?script=${encodeURIComponent(script.id)}&deploy=${encodeURIComponent(script.deploymentId)}`
      + `&custpage_months=${settings.months}&custpage_exclude=${encodeURIComponent(settings.excluded.join(','))}&custpage_exset=T`;

    if (settings.traceItem && settings.traceLocation) {
      const { lines, sourcesFailed } = loadTraceLines(settings);
      if (settings.weekly) {
        response.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
        response.write(JSON.stringify(weeklyDemand(lines, settings.window)));
        return;
      }
      // The main list's figures for this item, from the same aggregate query, to prove the two agree.
      const main = demandByItem([settings.traceLocation], settings.window, settings.excluded, settings.traceItem)[`${settings.traceItem}|${settings.traceLocation}`];
      const traceForm = serverWidget.createForm({ title: 'UK Stock Monitor: demand lines' });
      const out = traceForm.addField({ id: 'custpage_trace_html', type: serverWidget.FieldType.INLINEHTML, label: 'Lines' });
      out.defaultValue = renderTrace(lines, settings, settings.traceItem, main || { fulfilled: 0, consumed: 0 }, sourcesFailed);
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
    const csvParams = { custpage_months: settings.months, custpage_weeks: settings.weeks, custpage_jtape: settings.jtape, custpage_exclude: settings.excluded.join(','), custpage_exset: 'T', custpage_csv: 'T' };
    const qs = Object.keys(csvParams).map(k => `${k}=${encodeURIComponent(csvParams[k])}`).join('&');
    form.addButton({ id: 'custpage_export', label: 'Export CSV', functionName: `(function(){window.location.href=window.location.pathname+'?script=${encodeURIComponent(script.id)}&deploy=${encodeURIComponent(script.deploymentId)}&${qs}'+(window.usmHiddenColumns?'&custpage_hide='+encodeURIComponent(window.usmHiddenColumns()):'')+(window.usmColumnOrder?'&custpage_order='+encodeURIComponent(window.usmColumnOrder()):'');})` });
    const html = form.addField({ id: 'custpage_results', type: serverWidget.FieldType.INLINEHTML, label: 'Results' });
    // Restore default layout also returns to the deployment's default excluded customers when they differ,
    // keeping the other filters (a page load without custpage_exset applies the default).
    settings.resetUrl = resetUrl(settings, script);
    html.defaultValue = renderTable(rows, settings);
    response.writePage(form);
  }

  return { onRequest, _test: { resetUrl, weeklyDemand, chartButton, chosenExclusions, DEFAULT_HIDDEN, orderedColumns, sourcesSql, sourceFields, traceSql, lineReason, renderTrace, countedSql, excludedCustomers, demandSql, hiddenColumns, colKey, COLUMNS, renderTable, coverStatus, demandWindow, qtyToReplenish, evaluate, percent, toCsv, clampInt } };
});
