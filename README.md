# UK Stock Monitor Suitelet

`src/uk-stock-monitor-suitelet.js` is a read-only Suitelet that reproduces the **UK Stock Monitor** saved search (customsearch1983) and adds demand-based stockholding. It never creates or changes records; the Create WO link opens a new work order form for a person to complete, as the saved search does.

## What it shows
Everything the saved search shows except Type (% stocked, % available, preferred stock, replenish level, current, committed, available, WO's, qty to replenish, Create WO), plus:

| Column | Meaning |
| --- | --- |
| Fulfilled | Quantity on posted item fulfilments from the location in the history window |
| WO Consumed | Component quantity consumed by posted work order completions (backflush) and work order issues at the location |
| Avg Weekly Demand | (Fulfilled + WO Consumed) / weeks in the window |
| Recommended Stock | Avg weekly demand x cover weeks (default 6), rounded up |
| Recommended vs Preferred | Recommended minus the current preferred stock level, to show where preferred levels look too high or low |
| Weeks Cover | Available / avg weekly demand |
| Cover Status | Traffic light comparing weeks cover with the recommended cover weeks: green at 100% or more, amber 50% to under 100%, red under 50%. Blank when there was no demand in the window |
| Shortfall to Recommended | Recommended minus (available + on order), never below 0 |

Filters: demand history in months (default 6, 1-24), cover weeks (default 6, 1-52), and JTAPE Product? (All / Yes / No). Export CSV downloads the same rows and leaves out any hidden columns.

Exclude customers from demand (multi-select) leaves chosen customers out of Fulfilled, WO Consumed, average weekly demand and everything calculated from them. Stock columns are not affected. The page notes how many customers are excluded, and the choice is kept in the page address, so a bookmarked link keeps it.
- Item fulfilments are excluded when the fulfilment's customer is selected.
- Work order completions and issues are excluded when the work order they were created from has a selected customer. Work orders with no customer (stock builds) always count, even if the finished goods are later sold to an excluded customer.
- Only the exact customers chosen are excluded, not their sub-customers.

Click any Fulfilled or WO Consumed figure to open a drill-down listing every transaction line for that item at the location in the window: date, type, number (linked), created from, customer, NetSuite's line quantity, whether it is a cost of goods line, the quantity counted and the reason any line is not counted. Use it to reconcile a figure against your own numbers. The drill-down uses the same query filters as the main list and says whether its lines add up to the main figure.

Choose columns (above the table) shows or hides any column except Name straight away, without re-running the search. The choice is saved in the browser, so each person keeps their own layout on that computer; Show all restores every column. Column headings sort the table.

Row colours: orange = Special Work Order Item; yellow = available + on order at or below the replenish level with nothing on order; light green = at or below the replenish level but work orders are open. Adjust in `evaluate()` if the saved search's yellow/green rules differ.

## Rules
- Stock rows come from the saved search itself (`search.load`), so its criteria remain the single definition of which items appear. The Suitelet replaces only the columns.
- Demand is per item and per the row's inventory location. Only posting, non-voided transactions count, so picked or packed fulfilments that are not shipped are excluded.
- Only lines taking stock out (negative quantity) count, on fulfilments, completions and issues alike, so an assembly's own output is never counted as its demand. Cost of goods sold lines, which repeat the item on a fulfilment, are never counted. Finished goods get demand from fulfilments; sub-assemblies such as interim rolls get demand from the work orders that consume them. An item that is both sold and consumed gets both.
- Transfer order fulfilments out of the location count as demand (they are item fulfilments).
- Quantities are SuiteQL `transactionline.quantity`, expected in base units like the location quantity columns.

## Deployment (sandbox first)
1. Upload the file to the File Cabinet (SuiteScripts) and create a Suitelet script record from it.
2. Optional script parameter `custscript_usm_search` (free-form text) overrides the saved search ID; default `customsearch1983`. The item fields are fixed in the script: `custitem_isjtape` (JTAPE Product? filter) and `isspecialworkorderitem` (Special Work Order Item, orange rows).
3. Deploy with the roles that use the saved search today; it needs Items, Find Transaction, SuiteQL access and the saved search to be public or shared with those roles.
4. Add it to a centre tab or a shortcut.

## Validate in the sandbox before production
- Compare stock columns row by row with the saved search for the same moment.
- For one finished good, compare Fulfilled with a transaction search of shipped item fulfilment lines in the window.
- For one sub-assembly (e.g. 1013.1350 4.8m Interim Roll), compare WO Consumed with completion/issue component lines in the window.
- For an item with a non-base stock unit (e.g. Z9403, stocked in LM, base Sqm), confirm the demand total is in base units like Current Stock. If SuiteQL returns transaction units, convert in `demandByItem`.
- With a customer excluded, check that a work order completion for that customer's work order no longer counts (the link from completion to work order uses the completion's Created From).
- Confirm the run stays within Suitelet governance with the full item list (one paged search plus one paged SuiteQL query).

## Tests
Run `npm test` (Node 18+, no dependencies). The tests cover the pure calculations; NetSuite reads are validated in the sandbox as above.
