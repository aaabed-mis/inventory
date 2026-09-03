# Inventory Dashboard

Offline, double-click-to-open HTML dashboard for inventory position, value concentration, demand, incoming supply and stock risk. SAP ECC EHP7 (PRD) → dlt → DuckDB → inline JSON payload.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Layout, KPI cards, filters, chart/table containers |
| `styles.css` | Dark/light theme (same design language as Material Aging Dashboard) |
| `app.js` | All logic: data load, filters, risk model, charts, tables, insights, CSV export |
| `data/export_inventory.py` | Regenerates the payload from the three DuckDB files |
| `data/inventory.json` | Payload (fetched if served over http) |
| `data/data.js` | Inline `window.__INVENTORY__` payload (used for `file://` double-click) |
| `assets/chart.umd.min.js` | Local Chart.js copy (no CDN, works offline) |

## Data sources (DuckDB, schema `sap_prd`)

- `fact_inventory` — inventory position (grain: matnr × werks; value = Σ CLABS × MA_PRICE)
- `fact_ztsd_detail` — sales/demand (net qty / NET_VALUE; windows 30/60/90/365d anchored to MAX(inv_date))
- `fact_incoming` — open purchase orders (line-level)
- `dim_vendors` / `dim_material_master` — vendor names + material dims

## Refresh

```bash
cd "C:\Users\c.crizaldo\OneDrive - Ahmad A. Abed Trading Co. Ltd\Documents\Dashboards\Inventory\data"
C:/Users/c.crizaldo/AppData/Local/Python/pythoncore-3.14-64/python.exe export_inventory.py
```

Then bump the `?v=` cache-buster on the three asset tags in `index.html` (exact `str.replace`, never regex).

Full methodology in Obsidian: `Dashboards\Inventory Dashboard.md`.
