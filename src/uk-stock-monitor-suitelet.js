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

  /**
   * SuiteQL for demand. Excluded customers are matched on the fulfilment's customer for item fulfilments and on
   * the work order's customer for completions and issues (found through the transaction's Created From). IDs
   * are validated integers before they are written into the query.
   */
  function demandSql(locationIds, excluded = []) {
    const locs = [...new Set(locationIds.map(String))].filter(id => RECORD_ID.test(id));
    const customers = excludedCustomers(excluded.join(','));
    const exclusion = customers.length ? `
        AND NOT (t.type = 'ItemShip' AND NVL(t.entity, 0) IN (${customers.join(',')}))
        AND NOT (t.type IN ('WOCompl', 'WOIssue') AND NVL(wo.entity, 0) IN (${customers.join(',')}))` : '';
    const joins = customers.length ? `
      LEFT JOIN transactionline hdr ON hdr.transaction = t.id AND hdr.mainline = 'T'
      LEFT JOIN transaction wo ON wo.id = hdr.createdfrom AND wo.type = 'WorkOrd'` : '';
    return { locs, sql: `
      SELECT tl.item AS item, tl.location AS location, t.type AS type,
             SUM(CASE WHEN t.type = 'ItemShip' THEN ABS(tl.quantity) ELSE -tl.quantity END) AS qty
      FROM transactionline tl
      JOIN transaction t ON t.id = tl.transaction${joins}
      WHERE t.type IN ('ItemShip', 'WOCompl', 'WOIssue')
        AND t.trandate >= TO_DATE(?, 'YYYY-MM-DD') AND t.trandate <= TO_DATE(?, 'YYYY-MM-DD')
        AND t.posting = 'T' AND t.voided = 'F'
        AND tl.mainline = 'F'
        AND tl.itemtype IN ('InvtPart', 'Assembly')
        AND tl.location IN (${locs.join(',')})
        AND (t.type = 'ItemShip' OR tl.quantity < 0)${exclusion}
      GROUP BY tl.item, tl.location, t.type` };
  }

  /**
   * Demand per item|location in base units. Fulfilment lines count in full; for completions and issues
   * only negative (consumed) component lines count, so the assembly being built is never demand for itself.
   * Only posting, non-voided transactions count (picked/packed fulfilments are excluded).
   */
  function demandByItem(locationIds, window, excluded) {
    const result = {};
    const { locs, sql } = demandSql(locationIds, excluded);
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

  const LIGHT_ORDER = { red: 0, amber: 1, green: 2, '': 3 };
  const LIGHT_LABEL = { red: 'Red', amber: 'Amber', green: 'Green', '': '' };
  const LIGHT_TITLE = { red: 'Below 50% of recommended cover', amber: '50% to 100% of recommended cover', green: 'At or above recommended cover' };
  const light = status => (status ? `<span class="usm-light usm-light-${status}" title="${esc(LIGHT_TITLE[status])}"></span>` : '');
  const NUMERIC = new Set(['Preferred Stock', 'Replenish Level', 'Current Stock', 'Committed', 'Available', "WO's", 'Qty to Replenish', 'Fulfilled',
    'WO Consumed', 'Avg Weekly Demand', 'Recommended Stock', 'Recommended vs Preferred', 'Weeks Cover', 'Shortfall to Recommended']);

  const COLUMNS = [
    ['Name', r => `<a target="_blank" href="/app/common/item/item.nl?id=${encodeURIComponent(r.id)}">${esc(r.name)}</a>`, r => r.name],
    ['Description', r => esc(r.description), r => r.description],
    ['% Stocked', r => bar(r.pctStocked), r => r.pctStocked],
    ['% Available', r => bar(r.pctAvailable), r => r.pctAvailable],
    ['Preferred Stock', r => fmt(r.preferred), r => r.preferred],
    ['Replenish Level', r => fmt(r.reorderPoint), r => r.reorderPoint],
    ['Current Stock', r => blank(r.onHand), r => r.onHand],
    ['Committed', r => blank(r.committed), r => r.committed],
    ['Available', r => blank(r.available), r => r.available],
    ["WO's", r => blank(r.onOrder), r => r.onOrder],
    ['Qty to Replenish', r => fmt(r.replenish), r => r.replenish],
    ['Fulfilled', r => blank(r.fulfilled), r => r.fulfilled],
    ['WO Consumed', r => blank(r.consumed), r => r.consumed],
    ['Avg Weekly Demand', r => blank(r.avgWeekly, 1), r => r.avgWeekly],
    ['Recommended Stock', r => blank(r.recommended), r => r.recommended],
    ['Recommended vs Preferred', r => (r.vsPreferred > 0 ? '+' : '') + fmt(r.vsPreferred), r => r.vsPreferred],
    ['Weeks Cover', r => (r.weeksCover == null ? '' : fmt(r.weeksCover, 1)), r => (r.weeksCover == null ? 99999 : r.weeksCover), r => (r.weeksCover == null ? '' : r.weeksCover)],
    ['Cover Status', r => light(r.coverStatus), r => LIGHT_ORDER[r.coverStatus], r => LIGHT_LABEL[r.coverStatus]],
    ['Shortfall to Recommended', r => blank(r.shortfall), r => r.shortfall],
    ['Create WO', woLink, () => '']
  ];

  /** Stable key per column, used for the column chooser, its saved choice and the CSV export. */
  const colKey = c => c[0].toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ALWAYS_SHOWN = 'name';

  /** Column keys to hide, from a comma list; unknown keys and Name are ignored. */
  function hiddenColumns(value) {
    const known = new Set(COLUMNS.map(colKey));
    return [...new Set(String(value || '').split(',').map(k => k.trim()).filter(k => known.has(k) && k !== ALWAYS_SHOWN))];
  }

  function columnChooser() {
    const boxes = COLUMNS.filter(c => colKey(c) !== ALWAYS_SHOWN).map(c =>
      `<label><input type="checkbox" data-key="${esc(colKey(c))}" checked> ${esc(c[0])}</label>`).join('');
    return `<div class="usm-cols"><button type="button" id="usm-cols-btn">Choose columns &#9662;</button>
<div id="usm-cols-box" style="display:none">${boxes}<div class="usm-cols-actions"><a href="#" id="usm-cols-all">Show all</a></div></div></div>`;
  }

  function renderTable(rows, settings) {
    const head = COLUMNS.map((c, i) => `<th data-col="${i}" class="c-${colKey(c)}">${esc(c[0])}</th>`).join('');
    const body = rows.map(r => `<tr class="${r.highlight ? 'usm-' + r.highlight : ''}">${COLUMNS.map((c, i) => {
      const sortValue = c[2](r);
      const align = NUMERIC.has(c[0]) ? ' usm-num' : c[0] === 'Cover Status' ? ' usm-center' : '';
      return `<td data-sort="${esc(sortValue)}" class="c-${colKey(c)}${align}">${c[1](r)}</td>`;
    }).join('')}</tr>`).join('');
    return `
<style>
  .usm-wrap{overflow-x:auto;font-size:12px}
  .usm-note{margin:6px 0 10px;color:#555}
  table.usm{border-collapse:collapse;width:100%}
  table.usm th{background:#e5e5e5;text-transform:uppercase;font-weight:normal;font-size:11px;padding:6px;text-align:left;cursor:pointer;white-space:nowrap;position:sticky;top:0}
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
  .usm-cols-actions{padding-top:6px;break-inside:avoid}
  .usm-progress{overflow:hidden;height:16px;width:64px;background:#c23b22;border-radius:4px;box-shadow:inset 0 1px 2px rgba(0,0,0,.1)}
  .usm-bar{float:left;height:100%;font-size:10px;line-height:16px;color:#fff;text-align:center;background:#22c23b;box-shadow:inset 0 -1px 0 rgba(0,0,0,.15)}
</style>
<div class="usm-note">${esc(rows.length)} items. Demand ${esc(ymd(settings.window.start))} to ${esc(ymd(settings.window.end))}
 (${esc(fmt(settings.window.weeks, 1))} weeks): posted item fulfilments plus components consumed by work order completions and issues, in base units.${settings.excluded && settings.excluded.length ? ` <b>Excluding ${esc(settings.excluded.length)} customer${settings.excluded.length === 1 ? '' : 's'}</b> (their fulfilments and work orders).` : ''}
 Recommended stock = average weekly demand &times; ${esc(settings.weeks)} weeks. Cover Status: green = weeks cover at or above ${esc(settings.weeks)} weeks, amber = 50% to 100% of it, red = below 50%. Click a column heading to sort.</div>
${columnChooser()}
<style id="usm-hide"></style>
<div class="usm-wrap"><table class="usm" id="usm"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
<script>
(function(){var t=document.getElementById('usm');if(!t)return;var dir={};
t.querySelectorAll('th').forEach(function(th){th.addEventListener('click',function(){var i=+th.getAttribute('data-col');dir[i]=!dir[i];
var rows=[].slice.call(t.tBodies[0].rows);rows.sort(function(a,b){var x=a.cells[i].getAttribute('data-sort'),y=b.cells[i].getAttribute('data-sort');
var nx=parseFloat(x),ny=parseFloat(y);var c=(!isNaN(nx)&&!isNaN(ny))?nx-ny:String(x).localeCompare(String(y));return dir[i]?c:-c;});
rows.forEach(function(r){t.tBodies[0].appendChild(r);});});});})();
(function(){var KEY='usm-hidden-columns',box=document.getElementById('usm-cols-box'),btn=document.getElementById('usm-cols-btn'),style=document.getElementById('usm-hide');
if(!box||!btn||!style)return;var inputs=[].slice.call(box.querySelectorAll('input[data-key]'));var hidden=[];
try{hidden=(window.localStorage.getItem(KEY)||'').split(',').filter(Boolean);}catch(e){}
function apply(){style.textContent=hidden.map(function(k){return 'table.usm .c-'+k+'{display:none}';}).join('');
inputs.forEach(function(i){i.checked=hidden.indexOf(i.getAttribute('data-key'))<0;});
try{window.localStorage.setItem(KEY,hidden.join(','));}catch(e){}}
window.usmHiddenColumns=function(){return hidden.join(',');};
inputs.forEach(function(i){i.addEventListener('change',function(){hidden=inputs.filter(function(x){return !x.checked;}).map(function(x){return x.getAttribute('data-key');});apply();});});
btn.addEventListener('click',function(e){e.preventDefault();box.style.display=box.style.display==='none'?'':'none';});
document.getElementById('usm-cols-all').addEventListener('click',function(e){e.preventDefault();hidden=[];apply();});
document.addEventListener('click',function(e){if(!box.contains(e.target)&&e.target!==btn)box.style.display='none';});
apply();})();
</script>`;
  }

  function toCsv(rows, hidden = []) {
    const cell = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = COLUMNS.slice(0, -1).filter(c => !hidden.includes(colKey(c)));
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
      csv: p.custpage_csv === 'T',
      hidden: hiddenColumns(p.custpage_hide),
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
    const stock = stockRows(settings, settings.jtape);
    const demand = demandByItem(stock.map(r => r.locationId), settings.window, settings.excluded);
    const rows = stock.map(r => evaluate(r, demand[`${r.id}|${r.locationId}`], settings.window, settings.weeks));

    if (settings.csv) {
      response.writeFile({ file: file.create({ name: `uk-stock-monitor-${ymd(settings.window.end)}.csv`, fileType: file.Type.CSV, contents: toCsv(rows, settings.hidden) }), isInline: false });
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
    const script = runtime.getCurrentScript();
    const csvParams = { custpage_months: settings.months, custpage_weeks: settings.weeks, custpage_jtape: settings.jtape, custpage_exclude: settings.excluded.join(','), custpage_csv: 'T' };
    const qs = Object.keys(csvParams).map(k => `${k}=${encodeURIComponent(csvParams[k])}`).join('&');
    form.addButton({ id: 'custpage_export', label: 'Export CSV', functionName: `(function(){window.location.href=window.location.pathname+'?script=${encodeURIComponent(script.id)}&deploy=${encodeURIComponent(script.deploymentId)}&${qs}'+(window.usmHiddenColumns?'&custpage_hide='+encodeURIComponent(window.usmHiddenColumns()):'');})` });
    const html = form.addField({ id: 'custpage_results', type: serverWidget.FieldType.INLINEHTML, label: 'Results' });
    html.defaultValue = renderTable(rows, settings);
    response.writePage(form);
  }

  return { onRequest, _test: { excludedCustomers, demandSql, hiddenColumns, colKey, COLUMNS, renderTable, coverStatus, demandWindow, qtyToReplenish, evaluate, percent, toCsv, clampInt } };
});
