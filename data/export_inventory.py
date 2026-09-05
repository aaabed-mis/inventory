"""Export Inventory Dashboard payload from DuckDB (fact_inventory + fact_ztsd_detail + fact_incoming).

Run with the 3.14 Python (default 'python' is a 3.11 Hermes venv missing duckdb):
  C:/Users/c.crizaldo/AppData/Local/Python/pythoncore-3.14-64/python.exe export_inventory.py

Writes BOTH data/data.js (inline window.__INVENTORY__ = {...}) and
data/inventory.json so the dashboard works on file:// and http:// alike.

Model / grain decisions (documented in the dashboard methodology card):
- Inventory: aggregate batch rows (matnr+werks+lgort+charg) to matnr+werks grain.
  value = clabs x ma_price per batch, summed.
- Sales: pre-aggregated demand windows per material (30/60/90/365d), per sales office,
  per material x office, plus a monthly global trend. Net quantity & NET_VALUE used
  (returns/credit memos are negative rows -> net is the true demand).
- Incoming: line-level open POs (890 rows) shipped; JS aggregates.
- Material dims: union of inventory + sales + incoming materials so out-of-stock
  SKUs with demand still appear.
"""
import duckdb, json, datetime, os

HOME = "C:/Users/c.crizaldo/OneDrive - Ahmad A. Abed Trading Co. Ltd/Documents"
DUCK = os.path.join(HOME, "duckdb")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(OUT_DIR, "inventory.json")
OUT_JS = os.path.join(OUT_DIR, "data.js")

INV = os.path.join(DUCK, "fact_inventory.duckdb")
SALES = os.path.join(DUCK, "fact_ztsd_detail.duckdb")
INCOMING = os.path.join(DUCK, "fact_incoming.duckdb")
VENDORS = os.path.join(DUCK, "dim_vendors.duckdb")
FORECAST = os.path.join(DUCK, "fact_forecast.duckdb")

WINDOWS = [30, 60, 90, 365]


def q(con, sql, params=None):
    cur = con.execute(sql, params or [])
    return cur.fetchall(), [d[0] for d in cur.description]


def strip_matnr(v):
    return str(v).lstrip("0") or "0"


print("Reading fact_inventory ...")
con = duckdb.connect(INV, read_only=True)
# 1) inventory at matnr+werks grain (qty = SUM(clabs), huom = SUM(huom))
rows, names = q(con, """
SELECT matnr, werks, vkorg,
       SUM(clabs) AS qty,
       ROUND(SUM(clabs * COALESCE(ma_price,0)), 2) AS value,
       COUNT(*) AS batches,
       ROUND(SUM(COALESCE(huom,0)), 4) AS huom
FROM sap_prd.fact_inventory
GROUP BY 1,2,3
""")
inv_idx = {}   # (matnr,werks) -> [qty,value,batches,huom]
plants = {}    # werks -> name1
for matnr, werks, vkorg, qty, value, batches, huom in rows:
    m = strip_matnr(matnr)
    inv_idx[(m, werks)] = [round(float(qty), 4), round(float(value), 2), int(batches), round(float(huom), 4)]

# 1b) aging per batch: mirror MaterialAgingDashboard EXACTLY.
#     Source of truth = material_aging.duckdb (same table the aging dashboard's export_aging.py reads),
#     so Expired / Near-Expiry values match the Material Aging Dashboard KPI cards.
#     VKORG 1000/blank -> aging date = CHARG (YYYY.MM.DD); VKORG 6000 -> VFDAT (YYYYMMDD).
#     Bucket = days from TODAY; <0 Expired, <=30 0-30, <=60 31-60, <=90 61-90, <=120 91-120, else >120 Days.
import datetime as _dt
AGING_TODAY = _dt.date.today()

def _parse_aging_date(s):
    if not s: return None
    s = str(s).strip()
    if len(s) == 10 and s[4] == '.' and s[7] == '.':
        try: return _dt.datetime.strptime(s, "%Y.%m.%d").date()
        except Exception: pass
    if len(s) == 8 and s.isdigit():
        try: return _dt.datetime.strptime(s, "%Y%m%d").date()
        except Exception: pass
    return None

def aging_bucket(vkorg, charg, vfdat):
    v = (vkorg or '').strip()
    d = _parse_aging_date(charg) if v in ('1000', '', ' ') else _parse_aging_date(vfdat)
    if d is None:
        return '>120 Days'
    delta = (d - AGING_TODAY).days
    if delta < 0:       return 'Expired'
    elif delta <= 30:   return '0-30'
    elif delta <= 60:   return '31-60'
    elif delta <= 90:   return '61-90'
    elif delta <= 120:  return '91-120'
    return '>120 Days'

# per (matnr,werks): value/qty/batches by aging bucket (batch-level, value = clabs*ma_price per batch)
print("Reading material_aging (aging source of truth) ...")
aging = {}   # matnr|werks -> {bucket: [value, qty, batches]}
try:
    acon = duckdb.connect(os.path.join(DUCK, "material_aging.duckdb"), read_only=True)
    aging_rows = acon.execute("""
        SELECT matnr, werks, vkorg, charg, vfdat, clabs, ma_price
        FROM sap_prd.material_aging
    """).fetchall()
    acon.close()
    for matnr, werks, vkorg, charg, vfdat, clabs, ma_price in aging_rows:
        m = strip_matnr(matnr)
        cl = float(clabs or 0); mp = float(ma_price or 0)
        if cl == 0:  # count all CLABS>0 batches (price-0 rows add 0 value but count, matching aging dashboard)
            continue
        b = aging_bucket(vkorg, charg, vfdat)
        key = m + "|" + werks
        d = aging.get(key)
        if d is None:
            d = {'Expired':[0.0,0.0,0],'0-30':[0.0,0.0,0],'31-60':[0.0,0.0,0],'61-90':[0.0,0.0,0],'91-120':[0.0,0.0,0],'>120 Days':[0.0,0.0,0]}
            aging[key] = d
        d[b][0] += round(cl * mp, 2)
        d[b][1] += cl
        d[b][2] += 1
except Exception as e:
    print("  WARN material_aging read failed (aging KPIs will be 0):", e)
print("  aging rows (matnr x werks with batch aging):", len(aging))
# 2) plants dim (werks -> name1, regio, vkorg)
prows, _ = q(con, """
SELECT werks, MIN(name1) name1, MIN(regio) regio, MIN(vkorg) vkorg
FROM sap_prd.fact_inventory GROUP BY 1
""")
for werks, name1, regio, vkorg in prows:
    plants[werks] = {"name1": name1 or "", "regio": regio or "", "vkorg": vkorg or ""}
# 3) material dims from inventory (matnr -> desc, matkl, extwg, mfrnr)
drows, _ = q(con, """
SELECT matnr, MIN(maktx) maktx, MIN(matkl) matkl, MIN(wgbez) wgbez,
       MIN(extwg) extwg, MIN(ewbez) ewbez, MIN(mfrnr) mfrnr, MIN(name11) name11
FROM sap_prd.fact_inventory GROUP BY 1
""")
mats = {}
for matnr, maktx, matkl, wgbez, extwg, ewbez, mfrnr, name11 in drows:
    mats[strip_matnr(matnr)] = {
        "maktx": maktx or "", "matkl": matkl or "", "wgbez": wgbez or "",
        "extwg": extwg or "", "ewbez": ewbez or "", "mfrnr": mfrnr or "", "name11": name11 or "",
    }
con.close()
print("  inventory combos:", len(inv_idx), "| materials:", len(mats), "| plants:", len(plants))

print("Reading fact_ztsd_detail ...")
con = duckdb.connect(SALES, read_only=True)
ref = con.execute("SELECT MAX(inv_date) FROM sap_prd.fact_ztsd_detail").fetchone()[0]
print("  ref_date (max sales):", ref)

# material dims fallback for sold-only materials
srows, _ = q(con, """
SELECT material, MIN(material_des), MIN(mat_ext_grp), MIN(mat_ext_grp_des),
       MIN(material_grp), MIN(material_grp_des), MIN(vendor_no), MIN(vendor_name)
FROM sap_prd.fact_ztsd_detail GROUP BY 1
""")
for matnr, maktx, extwg, ewbez, matkl, wgbez, mfrnr, name11 in srows:
    m = strip_matnr(matnr)
    if m not in mats:
        mats[m] = {"maktx": maktx or "", "matkl": matkl or "", "wgbez": wgbez or "",
                   "extwg": extwg or "", "ewbez": ewbez or "", "mfrnr": mfrnr or "", "name11": name11 or ""}

# material dims fallback 2: dim_material_master (catches incoming-only materials)
try:
    mm = duckdb.connect(os.path.join(DUCK, "dim_material_master.duckdb"), read_only=True)
    for matnr, maktx, matkl, wgbez, extwg, ewbez, mfrnr in mm.execute(
        "SELECT matnr, maktx, matkl, wgbez, extwg, ewbez, mfrnr FROM sap_prd.dim_material_master"
    ).fetchall():
        m = strip_matnr(matnr)
        if m not in mats:
            mats[m] = {"maktx": maktx or "", "matkl": matkl or "", "wgbez": wgbez or "",
                       "extwg": extwg or "", "ewbez": ewbez or "", "mfrnr": mfrnr or "", "name11": ""}
    mm.close()
    print("  dim_material_master fallback loaded")
except Exception as e:
    print("  WARN dim_material_master:", e)

def win_expr(col, days, ref):
    # SKU Analysis: qty windows use QTY_IN_SKU (SKU/base units)
    return f"SUM(CASE WHEN {col} > DATE '{ref}' - INTERVAL {days} DAY AND {col} <= DATE '{ref}' THEN qty_in_sku ELSE 0 END)"

def win_val_expr(col, days, ref):
    return f"SUM(CASE WHEN {col} > DATE '{ref}' - INTERVAL {days} DAY AND {col} <= DATE '{ref}' THEN net_value ELSE 0 END)"

# per-material windows
sel = ["material"]
for d in WINDOWS:
    sel.append(f"ROUND({win_expr('inv_date', d, ref)},4) AS q{d}")
    sel.append(f"ROUND({win_val_expr('inv_date', d, ref)},2) AS v{d}")
sel.append("MAX(inv_date) AS last_sale")
sel.append(f"COUNT(DISTINCT CASE WHEN inv_date > DATE '{ref}' - INTERVAL 365 DAY THEN zmonth END) AS active_months")
sql = "SELECT " + ", ".join(sel) + " FROM sap_prd.fact_ztsd_detail GROUP BY 1"
sales_mat = {}
for r in con.execute(sql).fetchall():
    m = strip_matnr(r[0])
    sales_mat[m] = {
        "q30": float(r[1] or 0), "v30": float(r[2] or 0),
        "q60": float(r[3] or 0), "v60": float(r[4] or 0),
        "q90": float(r[5] or 0), "v90": float(r[6] or 0),
        "q365": float(r[7] or 0), "v365": float(r[8] or 0),
        "last_sale": r[9].isoformat() if r[9] else None,
        "active_months": int(r[10] or 0),
    }
print("  materials with sales:", len(sales_mat))

# per sales-office windows (warehouse demand)
sel = ["sales_office", "MIN(region_desc) region_desc"]
for d in WINDOWS:
    sel.append(f"ROUND({win_expr('inv_date', d, ref)},4) AS q{d}")
    sel.append(f"ROUND({win_val_expr('inv_date', d, ref)},2) AS v{d}")
sql = "SELECT " + ", ".join(sel) + " FROM sap_prd.fact_ztsd_detail GROUP BY 1"
sales_office = {}
for r in con.execute(sql).fetchall():
    o = r[0]
    sales_office[o] = {
        "name": (r[1] or o or "").strip() or o,
        "q30": float(r[2] or 0), "v30": float(r[3] or 0),
        "q60": float(r[4] or 0), "v60": float(r[5] or 0),
        "q90": float(r[6] or 0), "v90": float(r[7] or 0),
        "q365": float(r[8] or 0), "v365": float(r[9] or 0),
    }
print("  sales offices:", len(sales_office))

# per material x office (for plant-filtered SKU view): q30/v30, q90/v90, q365/v365
sql = ("SELECT material, sales_office, "
       f"ROUND({win_expr('inv_date',30,ref)},4), ROUND({win_val_expr('inv_date',30,ref)},2), "
       f"ROUND({win_expr('inv_date',90,ref)},4), ROUND({win_val_expr('inv_date',90,ref)},2), "
       f"ROUND({win_expr('inv_date',365,ref)},4), ROUND({win_val_expr('inv_date',365,ref)},2), "
       "MAX(inv_date) FROM sap_prd.fact_ztsd_detail GROUP BY 1,2")
sales_mat_office = []
for r in con.execute(sql).fetchall():
    sales_mat_office.append([
        strip_matnr(r[0]), r[1],
        float(r[2] or 0), float(r[3] or 0),
        float(r[4] or 0), float(r[5] or 0),
        float(r[6] or 0), float(r[7] or 0),
        r[8].isoformat() if r[8] else None,
    ])
print("  material x office combos:", len(sales_mat_office))

# monthly global trend (last 36 months)
sql = ("SELECT zmonth, ROUND(SUM(quantity),2), ROUND(SUM(net_value),2) "
       "FROM sap_prd.fact_ztsd_detail WHERE zmonth >= '202401' GROUP BY 1 ORDER BY 1")
trend_month = [[r[0], float(r[1]), float(r[2])] for r in con.execute(sql).fetchall()]
print("  trend months:", len(trend_month))
con.close()

print("Reading fact_incoming ...")
con = duckdb.connect(INCOMING, read_only=True)
irows, _ = q(con, """
SELECT po_number, po_item, plant, storage_location, material_number,
       quantity, order_uom, net_value, ton, vendor_number,
       po_creation_date, delivery_date, stat_rel_del_date
FROM sap_prd.fact_incoming
""")
incoming = []
for (po, item, plant, sloc, matnr, qty, uom, value, ton, vendor,
     poc, deld, statd) in irows:
    incoming.append({
        "po": po or "", "item": item or "", "plant": plant or "", "sloc": sloc or "",
        "matnr": strip_matnr(matnr), "qty": round(float(qty or 0), 4), "uom": uom or "",
        "value": round(float(value or 0), 2), "ton": round(float(ton or 0), 4),
        "vendor": vendor or "",
        "po_date": poc.isoformat() if poc else None,
        "del_date": deld.isoformat() if deld else None,
        "stat_date": statd.isoformat() if statd else None,
    })
con.close()
print("  incoming lines:", len(incoming))

# vendor names for incoming POs
vendors = {}
try:
    con = duckdb.connect(VENDORS, read_only=True)
    for lifnr, name1 in con.execute("SELECT lifnr, name1 FROM sap_prd.dim_vendors").fetchall():
        vendors[str(lifnr)] = name1 or ""
    con.close()
except Exception as e:
    print("WARN vendors:", e)
for row in incoming:
    row["vendor_name"] = vendors.get(row["vendor"], "") or row["vendor"]

print("Reading fact_forecast ...")
# forecast per material x plant (current month only; fact_forecast holds one ZMONTH)
forecast_mat = []
fc_months = set()
try:
    con = duckdb.connect(FORECAST, read_only=True)
    for matnr, werks, zmonth, fqty, fval in con.execute(
        "SELECT material, werks, zmonth, ROUND(SUM(zbqty),4), ROUND(SUM(zbvalue),2) "
        "FROM sap_prd.fact_forecast GROUP BY 1,2,3"
    ).fetchall():
        m = strip_matnr(matnr)
        forecast_mat.append([m, werks, float(fqty or 0), float(fval or 0)])
        fc_months.add(zmonth)
    con.close()
    print("  forecast mat x plant combos:", len(forecast_mat), "| months:", sorted(fc_months))
except Exception as e:
    print("  WARN fact_forecast:", e)

# plant dims union: add incoming plants + sales offices not in inventory plants
for row in incoming:
    p = row["plant"]
    if p and p not in plants:
        plants[p] = {"name1": "", "regio": "", "vkorg": ""}
for o, info in sales_office.items():
    if o and o not in plants:
        plants[o] = {"name1": info["name"], "regio": "", "vkorg": ""}

# build compact inventory array: [matnr, werks, vkorg, qty, value, batches, huom]
inventory = []
for (m, w), (qty, value, batches, huom) in inv_idx.items():
    inventory.append([m, w, plants.get(w, {}).get("vkorg", ""), qty, value, batches, huom])
inventory.sort(key=lambda r: -r[4])

meta = {
    "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "source": "fact_inventory + fact_ztsd_detail + fact_incoming + fact_forecast (duckdb)",
    "ref_date": ref.isoformat(),
    "windows": WINDOWS,
    "grain": "matnr x werks (inventory); demand windows pre-aggregated",
    "inv_combos": len(inventory), "materials": len(mats), "plants": len(plants),
    "sales_materials": len(sales_mat), "incoming_lines": len(incoming),
    "forecast_combos": len(forecast_mat), "forecast_months": sorted(fc_months),
    "notes": [
        "Inventory value = SUM(clabs x ma_price) per matnr+werks (421 rows have zero ma_price; included at 0 value).",
        "Inventory qty = SUM(clabs); HUOM = SUM(huom) (handling units) from fact_inventory.",
        "Sales qty = SUM(qty_in_sku) (SKU/base units); value windows use NET_VALUE (returns & credit memos negative).",
        "Demand windows anchored to ref_date (max sales date).",
        "Incoming = open PO lines (all delivery dates; overdue flagged client-side).",
        "Forecast = fact_forecast per material x plant (current month, zbqty/zbvalue).",
        "Aging buckets mirror MaterialAgingDashboard: VKORG 1000/blank -> CHARG date; VKORG 6000 -> VFDAT; days from export run date.",
        "Aging source of truth = material_aging.duckdb (same table as Material Aging Dashboard) so Expired/Near-Expiry KPIs match it exactly.",
    ],
}

payload = {
    "meta": meta,
    "plants": plants,
    "mats": mats,
    "inventory": inventory,
    "aging": aging,
    "sales_mat": sales_mat,
    "sales_office": sales_office,
    "sales_mat_office": sales_mat_office,
    "trend_month": trend_month,
    "incoming": incoming,
    "forecast_mat": forecast_mat,
}

for path, as_js in [(OUT_JSON, False), (OUT_JS, True)]:
    with open(path, "w", encoding="utf-8") as f:
        if as_js:
            f.write("window.__INVENTORY__ = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        if as_js:
            f.write(";")

print("Rows written -> inventory:", len(inventory), "| mats:", len(mats), "| incoming:", len(incoming))
print("File size bytes:", os.path.getsize(OUT_JSON))
