/* Inventory Dashboard — client-side analytics over data.js payload
   Sources: fact_inventory (position), fact_ztsd_detail (demand), fact_incoming (supply)
   Grain: inventory aggregated to SKU x plant; demand pre-aggregated windows. */
'use strict';

/* ---------- config / thresholds ---------- */
const LOW_COV = 30;      // coverage days below which stock is Critical (high demand)
const OK_COV = 60;       // coverage days for Low Stock boundary
const EXCESS_COV = 180;  // coverage days above which stock is Excess
const SLOW_VALUE = 50000;// SAR value above which a no-sales SKU is flagged Watch
const FONT = "'Segoe UI', Roboto, Arial, sans-serif";
const STATUS_ORDER = ['Critical','Low Stock','Healthy','Excess','No Recent Sales','Out of Stock','No Stock'];
const STATUS_CLASS = {'Critical':'t-Critical','Low Stock':'t-Low','Healthy':'t-Healthy','Excess':'t-Excess',
  'No Recent Sales':'t-Slow','Out of Stock':'t-Out','No Stock':'t-None'};
const STATUS_COLOR = {'Critical':'#ff5d6c','Low Stock':'#f5a623','Healthy':'#33c08a','Excess':'#a78bfa',
  'No Recent Sales':'#4f8cff','Out of Stock':'#ff5d6c','No Stock':'#6f8298'};
const RISK_ORDER = ['Critical','High','Watch','Healthy'];
const RISK_CLASS = {'Critical':'t-Critical','High':'t-High','Watch':'t-Watch','Healthy':'t-Healthy'};
const RISK_COLOR = {'Critical':'#ff5d6c','High':'#f5a623','Watch':'#4f8cff','Healthy':'#33c08a'};
const RISK_RANK = {'Critical':4,'High':3,'Watch':2,'Healthy':1};
const PALETTE = ['#4f8cff','#22c1a4','#f5a623','#ff5d6c','#a78bfa','#33c08a','#ffb347','#7b5cff'];

let DATA = null;   // window.__INVENTORY__
const state = {
  vkorg:'', werks:new Set(), extwg:'', matkl:'', maabc:'', window:90, status:'', risk:'', replen:'', search:'',
  sortKey:'value', sortDir:-1, page:1, pageSize:50,
  colWidths:{},   // per-column px widths (Material Analysis resize)
  hiddenCols:new Set(['vendor','wgbez','ewbez','maabc','umrez','plantCount','lastSale']),   // hidden-by-default columns
  poSortKey:'del_date', poSortDir:1, poPage:1, poPageSize:50, topN:50,
  itSortKey:'po', itSortDir:1, itPage:1, itPageSize:50
};
const charts = {};
let AS_OF = null; // date string YYYY-MM-DD (data generation date)

/* ---------- helpers ---------- */
const fmtInt = n => (n==null?0:n).toLocaleString('en-US',{maximumFractionDigits:0});
const fmtNum = (n,d=2) => (n==null?0:n).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:d});
const fmtMoney = n => 'SAR '+fmtNum(n,0);
const fmtMoneyM = n => fmtNum(n/1e6,2)+'M';
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const strip0 = s => String(s==null?'':s).replace(/^0+/,'')||'0';
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

/* ---------- theme ---------- */
let CURRENT_THEME='dark';
function applyTheme(t){
  CURRENT_THEME=t;
  document.documentElement.setAttribute('data-theme',t);
  try{localStorage.setItem('inv-theme',t);}catch(e){}
  const btn=document.getElementById('theme-toggle');
  if(btn) btn.textContent = t==='light'?'☀':'☾';
  Chart.defaults.color = cssVar('--muted') || '#8a99af';
  Chart.defaults.borderColor = t==='light' ? 'rgba(20,30,50,.12)' : 'rgba(42,54,71,.6)';
}
function initTheme(){
  let t='dark';
  try{ t = localStorage.getItem('inv-theme') || 'dark'; }catch(e){}
  applyTheme(t==='light'?'light':'dark');
}
Chart.defaults.font.family=FONT;

/* ---------- data access ---------- */
function eligiblePlants(){
  let set = new Set(Object.keys(DATA.plants||{}).filter(w=>!state.vkorg || (DATA.plants[w]||{}).vkorg===state.vkorg));
  if(state.werks.size) set = new Set([...set].filter(w=>state.werks.has(w)));
  return set;
}

/* Build the SKU list: union of inventory / sales / incoming materials.
   Each SKU: qty, value, plantCount, demand metrics for the selected window,
   incoming (future) metrics, stock status, risk level, replenishment status. */
function computeSkus(){
  const plantsOk = eligiblePlants();
  const q = state.search.trim().toLowerCase();
  // 1) aggregate inventory rows -> per matnr
  const inv = new Map(); // matnr -> {qty,value,huom,plants:Set}
  for(const r of DATA.inventory){
    const m=r[0], w=r[1];
    if(!plantsOk.has(w)) continue;
    const mat=DATA.mats[m]||{};
    if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
    if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
    if(state.maabc && (mat.maabc||'')!==state.maabc) continue;
    if(q && !(m+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    let o=inv.get(m);
    if(!o){ o={qty:0,value:0,huom:0,plants:new Set()}; inv.set(m,o); }
    o.qty+=r[3]; o.value+=r[4]; o.huom+=(r[6]||0); o.plants.add(w);
  }
  // 2) demand: office-scoped when plant/vkorg filter active, else company-wide
  const demand = new Map(); // matnr -> {qW,vW,q365,v365,lastSale}
  const scope = (state.werks.size||state.vkorg) ? plantsOk : null;
  if(scope){
    // aggregate sales_mat_office for eligible offices
    const byOffice = new Map();
    for(const r of DATA.sales_mat_office){
      if(!scope.has(r[1])) continue;
      const mat=DATA.mats[r[0]]||{};
      if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
      if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
      if(state.maabc && (mat.maabc||'')!==state.maabc) continue;
      if(q && !(r[0]+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
      let o=byOffice.get(r[0]);
      if(!o){ o={q30:0,v30:0,q90:0,v90:0,q365:0,v365:0,lastSale:r[8]}; byOffice.set(r[0],o); }
      o.q30+=r[2]; o.v30+=r[3]; o.q90+=r[4]; o.v90+=r[5]; o.q365+=r[6]; o.v365+=r[7];
      if(r[8] && (!o.lastSale || r[8]>o.lastSale)) o.lastSale=r[8];
    }
    for(const [m,o] of byOffice){
      demand.set(m,{qW:state.window===30?o.q30:state.window===60?o.q90:state.window===90?o.q90:o.q365,
                    vW:state.window===30?o.v30:state.window===60?o.v90:state.window===90?o.v90:o.v365,
                    q365:o.q365, v365:o.v365, lastSale:o.lastSale});
    }
  } else {
    for(const [m,s] of Object.entries(DATA.sales_mat)){
      const mat=DATA.mats[m]||{};
      if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
      if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
      if(state.maabc && (mat.maabc||'')!==state.maabc) continue;
      if(q && !(m+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
      demand.set(m,{qW:state.window===30?s.q30:state.window===60?s.q60:state.window===90?s.q90:s.q365,
                    vW:state.window===30?s.v30:state.window===60?s.v60:state.window===90?s.v90:s.v365,
                    q365:s.q365, v365:s.v365, lastSale:s.last_sale});
    }
  }
  // 3) incoming: ALL open PO lines per matnr (regardless of status — incl. overdue), per user 2026-09-06
  const inc = new Map(); // matnr -> {qty,value,pos,overdueQty,overdueValue}
  for(const i of DATA.incoming){
    if(!plantsOk.has(i.plant)) continue;
    const mat=DATA.mats[i.matnr]||{};
    if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
    if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
    if(state.maabc && (mat.maabc||'')!==state.maabc) continue;
    if(q && !(i.matnr+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    const future = i.del_date && i.del_date >= AS_OF;
    let o=inc.get(i.matnr);
    if(!o){ o={qty:0,value:0,pos:0,overdueQty:0,overdueValue:0}; inc.set(i.matnr,o); }
    o.qty+=i.qty; o.value+=i.value; o.pos++;   // sum ALL lines regardless of status
    if(!future){ o.overdueQty+=i.qty; o.overdueValue+=i.value; }
  }
  // 3b) forecast: per matnr x plant (fact_forecast, current month)
  const fc = new Map(); // matnr -> {qty,value}
  for(const r of DATA.forecast_mat||[]){
    if(!plantsOk.has(r[1])) continue;
    let o=fc.get(r[0]);
    if(!o){ o={qty:0,value:0}; fc.set(r[0],o); }
    o.qty+=r[2]; o.value+=r[3];
  }
  // 4) assemble SKU rows (union of inv + demand + incoming + forecast matnrs)
  const keys = new Set([...inv.keys(), ...demand.keys(), ...inc.keys(), ...fc.keys()]);
  // aging per matnr (plant-filtered, from the authoritative aging payload) so
  // Expired / Near-Expiry KPIs match the Material Aging Dashboard exactly
  const agingByMat = new Map(); // matnr -> {expiredVal, expiredBatches, nearVal, nearQty, nearBatches}
  for(const [k, ag] of Object.entries(DATA.aging||{})){
    const bar = k.indexOf('|');
    const m = k.slice(0, bar), w = k.slice(bar+1);
    if(!plantsOk.has(w)) continue;
    let o = agingByMat.get(m);
    if(!o){ o={expiredVal:0, expiredBatches:0, nearVal:0, nearQty:0, nearBatches:0}; agingByMat.set(m,o); }
    const ex = ag['Expired']||[0,0,0];
    o.expiredVal += ex[0]; o.expiredBatches += ex[2];
    for(const b of ['0-30','31-60','61-90','91-120']){
      const v = ag[b]||[0,0,0];
      o.nearVal += v[0]; o.nearQty += v[1]; o.nearBatches += v[2];
    }
  }
  const skus=[];
  const dailyW = state.window; // days in window
  for(const m of keys){
    const iv=inv.get(m), dm=demand.get(m), ic=inc.get(m), fm=fc.get(m);
    const mat=DATA.mats[m]||{};
    if(q && !(m+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    const agm = agingByMat.get(m)||{expiredVal:0, expiredBatches:0, nearVal:0, nearQty:0, nearBatches:0};
    const qty=iv?iv.qty:0, value=iv?iv.value:0, huom=iv?iv.huom:0;
    const umrez=(mat.umrez||1)||1;
    const fcQty=fm?(fm.qty*umrez):0;    // Forecast zbqty in cartons -> pieces (× umrez)
    const qW = dm?dm.qW:0;                          // Sales Qty in PIECES (payload in base units)
    const dailyDemand = qW/dailyW;                  // daily demand in PIECES (matches qty in pieces)
    const vW=dm?dm.vW:0, q365=dm?dm.q365:0, v365=dm?dm.v365:0;
    const incQty=ic?(ic.qty*umrez):0, incValue=ic?ic.value:0, overdueQty=ic?ic.overdueQty:0;   // Incoming Qty in cartons -> pieces (× umrez)
    // ---- lead time / safety stock aware (from dim_material_master) ----
    const leadTime=mat.lead_time||0, safetyStockPcs=mat.safety_stock||0;
    const safetyStock = safetyStockPcs;          // Safety Stock in pieces
    const coverage=dailyDemand>0?qty/dailyDemand:null;   // days (internal: status/risk use days)
    const coverageMo = coverage!=null ? coverage/30.44 : null;   // months for display
    const target = safetyStockPcs + dailyDemand*leadTime;   // target stays in base units (pieces)
    const excessQty = target>0 ? Math.max(0, qty-target) : 0;
    const unitPrice = qty>0 ? value/qty : 0;                 // weighted avg price for excess-value calc
    const excessValue = excessQty>0 ? excessQty*unitPrice : 0;
    const rop = target;                                      // reorder point = same target
    const hasReorderData = (safetyStock>0) || (leadTime>0);
    let reorder='';
    if(hasReorderData && rop>0 && qty<=rop) reorder='Reorder';   // at/below reorder point
    else if(hasReorderData) reorder='OK';
    // overstock flag: qty > 2x lead-time target -> excess working capital (status axis only)
    const overstock = hasReorderData && target>0 && qty>2*target;
    // stock status (uses coverage)
    let status;
    if(qty<=0){ status = qW>0 ? 'Out of Stock' : 'No Stock'; }
    else if(qW<=0){ status = 'No Recent Sales'; }
    else if(coverage<LOW_COV){ status='Critical'; }
    else if(coverage<OK_COV){ status='Low Stock'; }
    else if(coverage>EXCESS_COV){ status='Excess'; }
    else status='Healthy';
    // risk level
    const incCov = dailyDemand>0 ? incQty/dailyDemand : null;
    let risk='Healthy';
    if(qW>0){
      if(qty<=0) risk = (incCov!=null && incCov>=30) ? 'High' : 'Critical';
      else if(coverage==null) risk='Critical';
      else if(coverage<LOW_COV) risk = (incCov!=null && incCov>=30) ? 'High' : 'Critical';
      else if(coverage<OK_COV) risk = (incCov!=null && incCov>=30) ? 'Healthy' : 'High';
      else if(coverage>EXCESS_COV) risk = (incCov!=null && incCov>=30) ? 'Watch' : 'Healthy';
    } else {
      if(qty>0 && (coverage==null || coverage>EXCESS_COV) && value>SLOW_VALUE) risk='Watch';
    }
    const replen = incQty>0 ? 'Incoming' : 'None';
    // risk escalation — NEVER downgrades: stock must survive the lead time, and must not sit below reorder point.
    // Incoming that already covers the lead time (incCov >= leadTime) neutralises the escalation.
    let escalated=risk;
    if(qW>0 && leadTime>0 && coverage!=null && coverage<leadTime){
      escalated = (incCov!=null && incCov>=leadTime) ? 'Watch' : 'High';
    }
    if(reorder==='Reorder'){
      const e2 = (incCov!=null && incCov>=leadTime) ? 'Watch' : 'High';
      if(RISK_RANK[e2]>RISK_RANK[escalated]) escalated=e2;
    }
    if(RISK_RANK[escalated]>RISK_RANK[risk]) risk=escalated;
    // stock status: overstock reclassification (status axis) — only upgrades Healthy to Excess
    if(overstock && status==='Healthy') status='Excess';
    if(state.status && status!==state.status) continue;
    if(state.risk && risk!==state.risk) continue;
    if(state.replen && replen!==state.replen) continue;
    skus.push({matnr:m, maktx:mat.maktx||'', extwg:mat.extwg||'', ewbez:mat.ewbez||'',
      matkl:mat.matkl||'', wgbez:mat.wgbez||'', mfrnr:mat.mfrnr||'', name11:mat.name11||'',
      qty, value, huom, maabc:mat.maabc||'', vendor:mat.name11||mat.name1||'', matkl:mat.matkl||'', ewbez:mat.ewbez||'', plantCount:iv?iv.plants.size:0, plantsArr:iv?[...iv.plants]:[],
      qW, vW, q365, v365, dailyDemand, coverage, coverageMo, fcQty,
      leadTime, safetyStock, target, excessQty, excessValue, reorder, umrez,
      expiredVal:agm.expiredVal, expiredBatches:agm.expiredBatches,
      nearVal:agm.nearVal, nearQty:agm.nearQty, nearBatches:agm.nearBatches,
      incQty, incValue, pos:ic?ic.pos:0, overdueQty, overdueValue:ic?ic.overdueValue:0,
      lastSale:dm?dm.lastSale:null, status, risk, replen});
  }
  return skus;
}

/* ---------- aggregation ---------- */
function aggregate(skus){
  const a={
    invQty:0, invValue:0, skuCount:skus.length, skusInStock:0, outOfStock:0, outWithDemand:0,
    criticalCount:0, highCount:0, excessValue:0, excessCount:0, slowValue:0, slowCount:0,
    reorderCount:0, reorderValue:0, excessQtyTotal:0,
    salesQty:0, salesValue:0, incQty:0, incValue:0, posCount:0, overdueQty:0, overdueValue:0,
    coverageDays:null, totalDaily:0,
    intransitValue:0, intransitQty:0, intransitLines:0,
    expiredValue:0, expiredBatches:0, nearExpiryValue:0, nearExpiryQty:0, nearExpiryBatches:0,
    byStatus:{}, byRisk:{}, byExtwg:{}, byMatnr:{}
  };
  STATUS_ORDER.forEach(s=>a.byStatus[s]={value:0,count:0});
  RISK_ORDER.forEach(s=>a.byRisk[s]={count:0});
  for(const s of skus){
    a.invQty+=s.qty; a.invValue+=s.value;
    if(s.qty>0) a.skusInStock++;
    if(s.status==='Out of Stock'){ a.outOfStock++; if(s.qW>0) a.outWithDemand++; }
    if(s.risk==='Critical') a.criticalCount++;
    if(s.risk==='High') a.highCount++;
    if(s.status==='Excess'){ a.excessValue+=s.value; a.excessCount++; }
    if(s.status==='No Recent Sales'){ a.slowValue+=s.value; a.slowCount++; }
    a.salesQty+=s.qW; a.salesValue+=s.vW;
    a.incQty+=s.incQty; a.incValue+=s.incValue; a.posCount+=s.pos;
    a.overdueQty+=s.overdueQty; a.overdueValue+=s.overdueValue;
    if(s.reorder==='Reorder'){ a.reorderCount++; a.reorderValue+=s.value; }
    a.excessQtyTotal+=s.excessQty||0;
    a.totalDaily+=s.dailyDemand;
    // aging: per-SKU totals pre-aggregated in computeSkus from DATA.aging (authoritative aging payload)
    a.expiredValue += s.expiredVal||0; a.expiredBatches += s.expiredBatches||0;
    a.nearExpiryValue += s.nearVal||0; a.nearExpiryQty += s.nearQty||0; a.nearExpiryBatches += s.nearBatches||0;
    const st=a.byStatus[s.status]||(a.byStatus[s.status]={value:0,count:0});
    st.value+=s.value; st.count++;
    a.byRisk[s.risk].count++;
    const eg=s.ewbez||s.extwg||'(none)';
    const g=a.byExtwg[eg]||(a.byExtwg[eg]={value:0,qty:0,count:0});
    g.value+=s.value; g.qty+=s.qty; g.count++;
    const mk=s.maktx?s.matnr+' – '+s.maktx:s.matnr;
    a.byMatnr[mk]=(a.byMatnr[mk]||0)+s.value;
  }
  a.coverageDays = a.totalDaily>0 ? a.invQty/a.totalDaily : null;
  a.intransitValue = sumIntransitValue(); a.intransitQty = sumIntransitQty(); a.intransitLines = DATA.intransit?DATA.intransit.length:0;
  return a;
}

/* per-plant inventory (from raw rows, respects filters incl. search-free plant scoping) */
function byPlantInventory(){
  const plantsOk=eligiblePlants();
  const q=state.search.trim().toLowerCase();
  const by={};
  for(const r of DATA.inventory){
    if(!plantsOk.has(r[1])) continue;
    const mat=DATA.mats[r[0]]||{};
    if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
    if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
    if(state.maabc && (mat.maabc||'')!==state.maabc) continue;
    if(q && !(r[0]+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    const key=r[1]+(DATA.plants[r[1]]?.name1?' – '+DATA.plants[r[1]].name1:'');
    const o=by[key]||(by[key]={value:0,qty:0});
    o.value+=r[4]; o.qty+=r[3];
  }
  return by;
}

function incomingByMonth(){
  const plantsOk=eligiblePlants();
  const by={};
  for(const i of DATA.incoming){
    if(!plantsOk.has(i.plant)) continue;
    if(!i.del_date || i.del_date<AS_OF) continue;
    const ym=i.del_date.slice(0,7);
    const o=by[ym]||(by[ym]={qty:0,value:0,pos:0});
    o.qty+=i.qty; o.value+=i.value; o.pos++;
  }
  return by;
}

/* ---------- KPIs ---------- */
function renderKPIs(a){
  const cards=[
    {cls:'k-value',label:'Total Inventory Value',value:fmtMoney(a.invValue+a.intransitValue),sub:fmtInt(a.invQty)+' units · '+fmtInt(a.skuCount)+' SKUs · incl. intransit'},
    {cls:'k-risk',label:'Expired Value',value:fmtMoney(a.expiredValue),sub:fmtNum(a.invValue?(a.expiredValue/a.invValue*100):0,1)+'% of stock · '+fmtInt(a.expiredBatches)+' batches'},
    {cls:'k-warn',label:'Near Expiry Value (0-120 days)',value:fmtMoney(a.nearExpiryValue),sub:fmtInt(a.nearExpiryQty)+' units · '+fmtInt(a.nearExpiryBatches)+' batches'},
    {cls:'k-value',label:'Incoming PO Value',value:fmtMoney(a.incValue),sub:fmtInt(a.incQty)+' units · '+fmtInt(a.posCount)+' PO lines'},
    {cls:'k-risk',label:'Out-of-Stock SKUs',value:fmtInt(a.outOfStock),sub:fmtInt(a.outWithDemand)+' with recent demand'},
    {cls:'k-warn',label:'Critical / High Risk',value:fmtInt(a.criticalCount)+' / '+fmtInt(a.highCount),sub:'SKUs needing attention'},
    {cls:'k-warn',label:'Potential Excess Value',value:fmtMoney(a.excessValue),sub:fmtInt(a.excessCount)+' SKUs > '+EXCESS_COV+'d coverage'},
    {cls:'k-good',label:'Intransit STO',value:fmtMoney(a.intransitValue),sub:fmtInt(a.intransitQty)+' units · '+fmtInt(a.intransitLines)+' lines'}, 
  ];
  document.getElementById('kpis').innerHTML=cards.map(c=>`
    <div class="kpi ${c.cls}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('');
}

/* ---------- charts ---------- */
function renderStatus(a){
  const labels=STATUS_ORDER.filter(s=>a.byStatus[s]&&a.byStatus[s].count>0);
  const ctx=document.getElementById('chart-status');
  if(charts.status)charts.status.destroy();
  charts.status=new Chart(ctx,{type:'doughnut',data:{labels,
    datasets:[{data:labels.map(s=>Math.max(a.byStatus[s].value,0.01)),backgroundColor:labels.map(s=>STATUS_COLOR[s]),borderWidth:2,borderColor:cssVar('--panel')||'#1b2433'}]},
    options:{maintainAspectRatio:false,cutout:'62%',
      plugins:{legend:{position:'right',labels:{usePointStyle:true,boxWidth:8,font:{size:11}}},
        tooltip:{callbacks:{label:c=>' '+labels[c.dataIndex]+': '+fmtMoney(a.byStatus[labels[c.dataIndex]].value)+' · '+fmtInt(a.byStatus[labels[c.dataIndex]].count)+' SKUs'}}}}});
}
function renderExtwg(a){
  const entries=Object.entries(a.byExtwg).sort((x,y)=>y[1].value-x[1].value).slice(0,14);
  const ctx=document.getElementById('chart-extwg');
  if(charts.extwg)charts.extwg.destroy();
  charts.extwg=new Chart(ctx,{type:'bar',data:{labels:entries.map(e=>e[0]),
    datasets:[{label:'Inventory value',data:entries.map(e=>e[1].value),
      backgroundColor:entries.map((_,i)=>`hsl(${210-i*13} 70% 58%)`),borderRadius:6}]},
    options:{indexAxis:'y',maintainAspectRatio:false,
      plugins:{legend:{display:false},
        tooltip:{callbacks:{title:items=>items[0].label,label:c=>fmtMoneyM(c.raw)}}},
      scales:{x:{ticks:{callback:v=>fmtMoneyM(v)}}}}});}
function renderRisk(a){
  const labels=RISK_ORDER.filter(s=>a.byRisk[s].count>0);
  const ctx=document.getElementById('chart-risk');
  if(charts.risk)charts.risk.destroy();
  charts.risk=new Chart(ctx,{type:'bar',data:{labels,
    datasets:[{label:'SKUs',data:labels.map(s=>a.byRisk[s].count),backgroundColor:labels.map(s=>RISK_COLOR[s]),borderRadius:8}]},
    options:{maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmtInt(c.raw)+' SKUs'}}},
      scales:{y:{beginAtZero:true,ticks:{callback:v=>fmtInt(v)}}}}});
}
function renderIncoming(by){
  const entries=Object.entries(by).sort(); // by ym
  const labels=entries.map(e=>{const y=e[0]; return y.slice(5,7)+'/'+y.slice(2,4);});
  const ctx=document.getElementById('chart-incoming');
  if(charts.incoming)charts.incoming.destroy();
  charts.incoming=new Chart(ctx,{type:'bar',data:{labels,datasets:[
    {label:'Qty',data:entries.map(e=>e[1].qty),backgroundColor:'#22c1a4',borderRadius:6,yAxisID:'y',order:2},
    {label:'Value (M)',data:entries.map(e=>+(e[1].value/1e6).toFixed(3)),type:'line',borderColor:cssVar('--text')||'#e7edf5',
     backgroundColor:cssVar('--text')||'#e7edf5',borderWidth:2.5,tension:.3,pointRadius:3,yAxisID:'y1',order:1}
  ]},options:{maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
    plugins:{legend:{labels:{usePointStyle:true}}},
    scales:{y:{position:'left',title:{display:true,text:'Qty'},ticks:{callback:v=>fmtInt(v)}},
      y1:{position:'right',title:{display:true,text:'Value (M SAR)'},grid:{drawOnChartArea:false},ticks:{callback:v=>v}}}}});}

/* ---------- SKU table ---------- */
const SKU_COLS=[
  {k:'matnr',t:'SKU',cls:''},
  {k:'maktx',t:'Description',cls:''},
  {k:'vendor',t:'Vendor',cls:''},
  {k:'wgbez',t:'Mat Group',cls:''},
  {k:'ewbez',t:'Ext Mat Group',cls:''},
  {k:'maabc',t:'ABC',cls:''},
  {k:'umrez',t:'Factor',cls:'num'},
  {k:'plantCount',t:'Plant',cls:'num'},
  {k:'qty',t:'Qty',cls:'num'},
  {k:'value',t:'Value',cls:'num'},
  {k:'qW',t:'Sales Qty',cls:'num'},
  {k:'dailyDemand',t:'Daily Sales',cls:'num'},
  {k:'coverageMo',t:'Coverage (mo)',cls:'num'},
  {k:'leadTime',t:'Lead Time',cls:'num'},
  {k:'safetyStock',t:'Safety Stock',cls:'num'},
  {k:'target',t:'Ideal Stock',cls:'num'},
  {k:'fcQty',t:'Sales Forecast',cls:'num'},
  {k:'excessQty',t:'Excess Qty',cls:'num'},
  {k:'excessValue',t:'Excess Value',cls:'num'},
  {k:'incQty',t:'Incoming Qty',cls:'num'},
  {k:'status',t:'Stock Status',cls:''},
  {k:'risk',t:'Risk',cls:''},
  {k:'reorder',t:'Reorder',cls:''},
  {k:'lastSale',t:'Last Sale',cls:''},
];
const SKU_HEAD=['SKU','Description','Vendor','Mat Group','Ext Mat Group','ABC','Factor','Plant','Qty','Value','Sales Qty','Daily Sales','Coverage (mo)','Lead Time','Safety Stock','Ideal Stock','Sales Forecast','Excess Qty','Excess Value','Incoming Qty','Stock Status','Risk','Reorder','Last Sale'];
const SKU_CSV_KEYS=['matnr','maktx','vendor','wgbez','ewbez','maabc','umrez','plantCount','qty','value','qW','dailyDemand','coverageMo','leadTime','safetyStock','target','fcQty','excessQty','excessValue','incQty','status','risk','reorder','lastSale'];
function drawSkuTable(skus){
  const cols=SkuVisibleCols();
  SKU_VISIBLE=cols;
  document.querySelector('#sku-table thead').innerHTML=
    '<tr>'+cols.map(c=>`<th data-k="${c.k}" class="${c.cls}">${c.t}${state.sortKey===c.k?(state.sortDir<0?' ▼':' ▲'):''}</th>`).join('')+'</tr>';
  const sorted=[...skus].sort((x,y)=>{
    let a=x[state.sortKey],b=y[state.sortKey];
    if(typeof a==='number'&&typeof b==='number')return (a-b)*state.sortDir;
    a=(a==null?'':String(a));b=(b==null?'':String(b));
    return a<b?-1*state.sortDir:a>b?1*state.sortDir:0;
  });
  const limited = state.topN>0 ? sorted.slice(0,state.topN) : sorted;
  const total=limited.length, pages=Math.max(1,Math.ceil(total/state.pageSize));
  if(state.page>pages)state.page=pages;
  const start=(state.page-1)*state.pageSize, pageRows=limited.slice(start,start+state.pageSize);
  document.querySelector('#sku-table tbody').innerHTML=pageRows.map(r=>'<tr>'+
    cols.map(c=>{
      let v=r[c.k];
      if(c.k==='matnr') return `<td>${esc(strip0(v))}</td>`;
      if(c.k==='maktx'||c.k==='vendor'||c.k==='wgbez'||c.k==='ewbez') return `<td>${esc(v||'')}</td>`;
      if(c.k==='status') return `<td><span class="tag ${STATUS_CLASS[v]||'t-None'}">${esc(v)}</span></td>`;
      if(c.k==='risk') return `<td><span class="tag ${RISK_CLASS[v]||'t-None'}">${esc(v)}</span></td>`;
      if(c.k==='reorder') return `<td><span class="tag ${v==='Reorder'?'t-Overdue':v==='OK'?'t-Incoming':'t-None'}">${v||'—'}</span></td>`;
      if(c.k==='lastSale') return `<td>${v?esc(v.slice(0,10)):'—'}</td>`;
      if(c.k==='coverageMo') return `<td class="num">${v==null?'—':fmtNum(v,1)}</td>`;
      if(c.k==='leadTime') return `<td class="num">${fmtNum(v,1)}</td>`;
      if(c.k==='safetyStock') return `<td class="num">${fmtNum(v,0)}</td>`;
      if(c.k==='target') return `<td class="num">${v>0?fmtNum(v,0):'—'}</td>`;
      if(c.k==='excessQty') return `<td class="num" style="color:${v>0?'var(--warn)':'inherit'}">${v>0?fmtNum(v,0):'—'}</td>`;
      if(c.k==='excessValue') return `<td class="num" style="color:${v>0?'var(--warn)':'inherit'}">${v>0?fmtMoney(v):'—'}</td>`;
      if(c.k==='umrez') return `<td class="num">${fmtNum(v,1)}</td>`;
      if(c.k==='qty'||c.k==='huom'||c.k==='fcQty'||c.k==='qW'||c.k==='incQty') return `<td class="num">${fmtInt(v)}</td>`;
      if(c.k==='dailyDemand') return `<td class="num">${fmtNum(r.dailyDemand,1)}</td>`;
      if(c.k==='value'||c.k==='vW'||c.k==='incValue') return `<td class="num">${fmtMoney(v)}</td>`;
      return `<td class="num">${fmtInt(v)}</td>`;
    }).join('')+'</tr>').join('');
  document.getElementById('page-info').textContent='Page '+state.page+' of '+pages+' · '+fmtInt(total)+' SKUs';
  document.getElementById('prev').disabled=state.page<=1;
  document.getElementById('next').disabled=state.page>=pages;
  setupSkuResize();
}
const SKU_DEF_WIDTHS={matnr:95,maktx:280,vendor:200,wgbez:110,ewbez:150,maabc:48,umrez:55,plantCount:58,qty:90,value:120,qW:95,dailyDemand:95,coverageMo:100,leadTime:68,safetyStock:90,target:95,fcQty:100,excessQty:88,excessValue:120,incQty:95,status:120,risk:95,reorder:88,lastSale:95};
let SKU_VISIBLE=SKU_COLS;   // columns currently shown (updated each draw)
function SkuVisibleCols(){ return SKU_COLS.filter(c=>!state.hiddenCols.has(c.k)); }
function initColMan(){
  const menu=document.getElementById('colman-menu'); if(!menu) return;
  menu.innerHTML=SKU_COLS.map(c=>{
    const on=!state.hiddenCols.has(c.k);
    return `<label class="colman-item"><input type="checkbox" data-k="${c.k}" ${on?'checked':''}><span>${esc(c.t)}</span></label>`;
  }).join('');
  menu.querySelectorAll('input').forEach(inp=>{
    inp.onchange=()=>{
      if(inp.checked) state.hiddenCols.delete(inp.dataset.k);
      else state.hiddenCols.add(inp.dataset.k);
      refresh();
    };
  });
  document.getElementById('colman-toggle').onclick=e=>{
    e.stopPropagation();
    menu.classList.toggle('open');
  };
  // close on outside click
  document.addEventListener('click', e=>{ if(!e.target.closest('.colman')) menu.classList.remove('open'); });
}
function setupSkuResize(){
  const tbl=document.getElementById('sku-table'); if(!tbl) return;
  const cols=SKU_VISIBLE.length?SKU_VISIBLE:SKU_COLS;
  // (re)build colgroup with default + persisted widths — honored under table-layout:fixed
  let cg=tbl.querySelector('colgroup');
  if(!cg){ cg=document.createElement('colgroup'); tbl.insertBefore(cg, tbl.querySelector('thead')); }
  cg.innerHTML=cols.map(c=>`<col style="width:${state.colWidths[c.k]||SKU_DEF_WIDTHS[c.k]||120}px">`).join('');
  // add a drag handle to each header cell, binding mousedown directly (not delegation)
  tbl.querySelectorAll('thead th').forEach((th,i)=>{
    const k=cols[i]&&cols[i].k; if(!k) return;
    if(th.querySelector('.th-resizer')) return;
    const r=document.createElement('div');
    r.className='th-resizer'; r.dataset.k=k;
    r.addEventListener('click', e=>e.stopPropagation()); // dragging a handle must not sort
    r.addEventListener('mousedown', e=>{
      e.preventDefault(); e.stopPropagation();
      const w=th.getBoundingClientRect().width;
      skuResize={k, startX:e.clientX, startW:w};
      r.classList.add('active');
      skuResize.handle=r;
    });
    th.appendChild(r);
  });
}
function applySkuColWidth(k, w){
  const tbl=document.getElementById('sku-table'); if(!tbl) return;
  const cols=SKU_VISIBLE.length?SKU_VISIBLE:SKU_COLS;
  const idx=cols.findIndex(c=>c.k===k); if(idx<0) return;
  const col=tbl.querySelector(`colgroup > col:nth-child(${idx+1})`);
  if(col) col.style.width=w+'px';
}
let skuResize=null;
document.addEventListener('mousemove', e=>{
  if(!skuResize) return;
  const w=Math.max(60, Math.round(skuResize.startW + (e.clientX-skuResize.startX)));
  state.colWidths[skuResize.k]=w;
  applySkuColWidth(skuResize.k, w);
});
document.addEventListener('mouseup', ()=>{
  if(skuResize){ if(skuResize.handle) skuResize.handle.classList.remove('active'); skuResize=null; }
});
function exportSkuCsv(skus){
  const sorted=[...skus].sort((x,y)=>{
    let a=x[state.sortKey],b=y[state.sortKey];
    if(typeof a==='number'&&typeof b==='number')return (a-b)*state.sortDir;
    a=(a==null?'':String(a));b=(b==null?'':String(b));
    return a<b?-1*state.sortDir:a>b?1*state.sortDir:0;
  });
  const limited = state.topN>0 ? sorted.slice(0,state.topN) : sorted;
  const cols=SKU_VISIBLE.length?SKU_VISIBLE:SKU_COLS;
  const head=cols.map(c=>c.t);
  const keys=cols.map(c=>c.k);
  const rows=[head.join(',')];
  for(const r of limited){
    rows.push(keys.map(k=>{
      const v=r[k];
      if(v==null) return '';
      if(typeof v==='number') return v;
      return '"'+String(v).replace(/"/g,'""')+'"';
    }).join(','));
  }
  downloadCsv('inventory_sku_analysis.csv',rows.join('\n'));
}

/* ---------- PO table ---------- */
const PO_COLS=[
  {k:'po',t:'PO',cls:''},{k:'item',t:'Item',cls:''},{k:'matnr',t:'Material',cls:''},
  {k:'maktx',t:'Description',cls:''},
  {k:'vendor_name',t:'Vendor',cls:''},{k:'qty',t:'Qty',cls:'num'},{k:'uom',t:'UoM',cls:''},
  {k:'value',t:'Value',cls:'num'},{k:'po_date',t:'PO Date',cls:''},{k:'del_date',t:'Delivery',cls:''},
  {k:'status',t:'Status',cls:''},{k:'ship_status',t:'Shipment Status',cls:''},
];
const PO_HEAD=['PO','Item','Material','Description','Vendor','Qty','UoM','Value','PO Date','Delivery','Status','Shipment Status'];
function filteredPoRows(){
  const plantsOk=eligiblePlants();
  const q=state.search.trim().toLowerCase();
  const rows=[];
  for(const i of DATA.incoming){
    if(!plantsOk.has(i.plant)) continue;
    const mat=DATA.mats[i.matnr]||{};
    if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
    if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
    if(state.maabc && (mat.maabc||'')!==state.maabc) continue;
    if(q && !(i.matnr+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    const future = i.del_date && i.del_date>=AS_OF;
    rows.push({...i, maktx:mat.maktx||'', status: future?'Incoming':'Overdue',
      vendor_name:i.vendor_name||i.vendor});
  }
  return rows;
}
function drawPoTable(rows){
  const cols=PO_COLS;
  document.querySelector('#po-table thead').innerHTML=
    '<tr>'+cols.map(c=>`<th data-k="${c.k}" class="${c.cls}">${c.t}${state.poSortKey===c.k?(state.poSortDir<0?' ▼':' ▲'):''}</th>`).join('')+'</tr>';
  const sorted=[...rows].sort((x,y)=>{
    let a=x[state.poSortKey],b=y[state.poSortKey];
    if(typeof a==='number'&&typeof b==='number')return (a-b)*state.poSortDir;
    a=(a==null?'':String(a));b=(b==null?'':String(b));
    return a<b?-1*state.poSortDir:a>b?1*state.poSortDir:0;
  });
  const total=sorted.length, pages=Math.max(1,Math.ceil(total/state.poPageSize));
  if(state.poPage>pages)state.poPage=pages;
  const start=(state.poPage-1)*state.poPageSize, pageRows=sorted.slice(start,start+state.poPageSize);
  document.querySelector('#po-table tbody').innerHTML=pageRows.map(r=>'<tr>'+
    cols.map(c=>{
      let v=r[c.k];
      if(c.k==='matnr') return `<td>${esc(strip0(v))}</td>`;
      if(c.k==='status') return `<td><span class="tag ${v==='Incoming'?'t-Incoming':'t-Overdue'}">${esc(v)}</span></td>`;
      if(c.k==='qty') return `<td class="num">${fmtInt(v)}</td>`;
      if(c.k==='value') return `<td class="num">${fmtMoney(v)}</td>`;
      if(c.k==='del_date'||c.k==='po_date') return `<td>${v?esc(v.slice(0,10)):'—'}</td>`;
      return `<td>${esc(v==null?'':v)}</td>`;
    }).join('')+'</tr>').join('');
  const inc=rows.filter(r=>r.status==='Incoming').length;
  const totVal=rows.reduce((s,r)=>s+r.value,0);
  document.getElementById('po-count').textContent=fmtInt(rows.length)+' lines · '+fmtInt(inc)+' incoming · '+fmtMoney(totVal);
  document.getElementById('po-page-info').textContent='Page '+state.poPage+' of '+pages+' · '+fmtInt(total)+' lines';
  document.getElementById('po-prev').disabled=state.poPage<=1;
  document.getElementById('po-next').disabled=state.poPage>=pages;
}
function exportPoCsv(rows){
  const sorted=[...rows].sort((x,y)=>{
    let a=x[state.poSortKey],b=y[state.poSortKey];
    if(typeof a==='number'&&typeof b==='number')return (a-b)*state.poSortDir;
    a=(a==null?'':String(a));b=(b==null?'':String(b));
    return a<b?-1*state.poSortDir:a>b?1*state.poSortDir:0;
  });
  const data=[PO_HEAD.join(',')];
  for(const r of sorted){
    data.push(['po','item','matnr','maktx','vendor_name','qty','uom','value','po_date','del_date','status','ship_status']
          .map(k=>{const v=r[k]; if(v==null)return ''; if(typeof v==='number')return v; return '"'+String(v).replace(/"/g,'""')+'"';}).join(','));
  }
  downloadCsv('inventory_incoming_pos.csv',data.join('\n'));
}
function downloadCsv(name,text){
  const blob=new Blob([text],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),500);
}

/* ---------- intransit ---------- */
const IT_COLS=[
  {k:'po',t:'PO',cls:''},{k:'item',t:'Item',cls:''},{k:'matnr',t:'Material',cls:''},
  {k:'maktx',t:'Description',cls:''},{k:'fromName',t:'From Plant',cls:''},
  {k:'toName',t:'To Plant',cls:''},{k:'qty',t:'Qty',cls:'num'},{k:'uom',t:'UoM',cls:''},
  {k:'value',t:'Value',cls:'num'},{k:'po_date',t:'PO Date',cls:''},
];
const IT_HEAD=['PO','Item','Material','Description','From Plant','To Plant','Qty','UoM','Value','PO Date'];
const IT_CSV_KEYS=['po','item','matnr','maktx','fromName','toName','qty','uom','value','po_date'];
function plantName(p){ const pl=DATA.plants||{}; return (pl[p]&&pl[p].name1)||''; }
function plantLabel(p){ const n=plantName(p); return p ? (n ? p+' – '+n : p) : '—'; }
function itValue(r){ const mp=(DATA.mats[r.matnr]&&DATA.mats[r.matnr].ma_price)||0; const u=r.umrez||1; return r.qty*u*mp; }
function intransitRows(){
  const q=state.search.trim().toLowerCase();
  const rows=[];
  for(const r of DATA.intransit||[]){
    const mat=DATA.mats[r.matnr]||{};
    if(q && !(r.matnr+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    rows.push({...r, maktx:mat.maktx||'', fromName:plantLabel(r.from), toName:plantLabel(r.to), value:itValue(r)});
  }
  return rows;
}
function sumIntransitValue(){ return (DATA.intransit||[]).reduce((s,r)=>s+itValue(r),0); }
function sumIntransitQty(){ return (DATA.intransit||[]).reduce((s,r)=>s+(r.qty||0),0); }
function drawItTable(rows){
  const cols=IT_COLS;
  document.querySelector('#it-table thead').innerHTML=
    '<tr>'+cols.map(c=>`<th data-k="${c.k}" class="${c.cls}">${c.t}${state.itSortKey===c.k?(state.itSortDir<0?' ▼':' ▲'):''}</th>`).join('')+'</tr>';
  const sorted=[...rows].sort((x,y)=>{
    let a=x[state.itSortKey],b=y[state.itSortKey];
    if(typeof a==='number'&&typeof b==='number')return (a-b)*state.itSortDir;
    a=(a==null?'':String(a));b=(b==null?'':String(b));
    return a<b?-1*state.itSortDir:a>b?1*state.itSortDir:0;
  });
  const total=sorted.length, pages=Math.max(1,Math.ceil(total/state.itPageSize));
  if(state.itPage>pages)state.itPage=pages;
  const start=(state.itPage-1)*state.itPageSize, pageRows=sorted.slice(start,start+state.itPageSize);
  document.querySelector('#it-table tbody').innerHTML=pageRows.map(r=>'<tr>'+
    cols.map(c=>{
      let v=r[c.k];
      if(c.k==='matnr') return `<td>${esc(strip0(v))}</td>`;
      if(c.k==='qty') return `<td class="num">${fmtInt(v)}</td>`;
      if(c.k==='value') return `<td class="num">${fmtInt(v)}</td>`;
      if(c.k==='po_date') return `<td>${v?esc(v.slice(0,10)):'—'}</td>`;
      return `<td>${esc(v==null?'':v)}</td>`;
    }).join('')+'</tr>').join('');
  const totVal=rows.reduce((s,r)=>s+r.value,0);
  document.getElementById('it-count').textContent=fmtInt(rows.length)+' lines · '+fmtMoney(totVal);
  document.getElementById('it-page-info').textContent='Page '+state.itPage+' of '+pages+' · '+fmtInt(total)+' lines';
  document.getElementById('it-prev').disabled=state.itPage<=1;
  document.getElementById('it-next').disabled=state.itPage>=pages;
}
function exportItCsv(rows){
  const data=[IT_HEAD.join(',')];
  for(const r of rows){
    data.push(IT_CSV_KEYS.map(k=>{const v=r[k]; if(v==null)return ''; if(typeof v==='number')return v; return '"'+String(v).replace(/"/g,'""')+'"';}).join(','));
  }
  downloadCsv('inventory_intransit.csv',data.join('\n'));
}

/* ---------- refresh / boot ---------- */
function refresh(){
  const skus=computeSkus();
  const a=aggregate(skus);
  renderKPIs(a);
  renderStatus(a);
  renderExtwg(a);
  renderRisk(a);
  renderIncoming(incomingByMonth());
  drawSkuTable(skus);
  const poRows=filteredPoRows();
  drawPoTable(poRows);
  drawItTable(intransitRows());
}

function fillSelect(id, opts, placeholder){
  const el=document.getElementById(id);
  el.innerHTML='<option value="">'+placeholder+'</option>'+opts.map(o=>`<option value="${esc(o[0])}">${esc(o[1])}</option>`).join('');
}
function initUI(){
  document.getElementById('meta-time').textContent='Data refreshed: '+(DATA.meta?.generated_at||'…');
  // vkorg
  const vk=new Set(); Object.values(DATA.plants||{}).forEach(p=>{ if(p.vkorg) vk.add(p.vkorg); });
  fillSelect('f-vkorg',[...vk].sort().map(v=>[v,v]),'All');
  // extwg / matkl from mats
  const eg=new Map(), mk=new Map();
  for(const m of Object.values(DATA.mats)){
    if(m.extwg){ if(!eg.has(m.extwg)) eg.set(m.extwg,m.ewbez||m.extwg); }
    if(m.matkl){ if(!mk.has(m.matkl)) mk.set(m.matkl,m.wgbez||m.matkl); }
  }
  fillSelect('f-extwg',[...eg.entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(e=>[e[0],e[0]+' – '+e[1]]),'All');
  fillSelect('f-matkl',[...mk.entries()].sort((a,b)=>a[1].localeCompare(b[1])).map(e=>[e[0],e[0]+' – '+e[1]]),'All');
  fillSelect('f-maabc',['A','B','C'].map(v=>[v,v]),'All');
  fillSelect('f-status',STATUS_ORDER.map(s=>[s,s]),'All');
  fillSelect('f-risk',RISK_ORDER.map(s=>[s,s]),'All');
  // plant multi-select
  const root=document.querySelector('.ms[data-key="werks"]');
  injectMSToggle(root,'Plant');
  const plants=[...Object.entries(DATA.plants)].sort((a,b)=>(a[1].name1||a[0]).localeCompare(b[1].name1||b[0]));
  buildMultiSelect(root,'werks',plants.map(([w,p])=>({v:w,label:(p.name1?w+' – '+p.name1:w)})));
  // events
  document.getElementById('f-vkorg').onchange=e=>{state.vkorg=e.target.value; resetPages(); refresh();};
  document.getElementById('f-extwg').onchange=e=>{state.extwg=e.target.value; resetPages(); refresh();};
  document.getElementById('f-matkl').onchange=e=>{state.matkl=e.target.value; resetPages(); refresh();};
  document.getElementById('f-maabc').onchange=e=>{state.maabc=e.target.value; resetPages(); refresh();};
  document.getElementById('f-window').onchange=e=>{state.window=parseInt(e.target.value,10); resetPages(); refresh();};
  document.getElementById('f-status').onchange=e=>{state.status=e.target.value; resetPages(); refresh();};
  document.getElementById('f-risk').onchange=e=>{state.risk=e.target.value; resetPages(); refresh();};
  document.getElementById('f-replen').onchange=e=>{state.replen=e.target.value; resetPages(); refresh();};
  document.getElementById('f-search').oninput=e=>{state.search=e.target.value; resetPages(); refresh();};
  document.getElementById('reset').onclick=()=>{
    state.vkorg=''; state.werks.clear(); state.extwg=''; state.matkl=''; state.window=90;
    state.status=''; state.risk=''; state.replen=''; state.search='';
    document.getElementById('f-vkorg').value=''; document.getElementById('f-extwg').value='';
    document.getElementById('f-matkl').value=''; document.getElementById('f-maabc').value=''; document.getElementById('f-window').value='90';
    document.getElementById('f-status').value=''; document.getElementById('f-risk').value='';
    document.getElementById('f-replen').value=''; document.getElementById('f-search').value='';
    document.querySelectorAll('.ms[data-key="werks"] input[type="checkbox"]').forEach(c=>c.checked=false);
    state.werks.clear(); syncMSCount(root);
    resetPages(); refresh();
  };
  document.getElementById('theme-toggle').onclick=()=>{ applyTheme(CURRENT_THEME==='light'?'dark':'light'); refresh(); };
  document.getElementById('f-topn').onchange=e=>{ state.topN=parseInt(e.target.value,10); state.page=1; refresh(); };
  document.getElementById('page-size').onchange=e=>{ state.pageSize=parseInt(e.target.value,10); state.page=1; refresh(); };
  document.getElementById('prev').onclick=()=>{ if(state.page>1){state.page--; refresh();} };
  document.getElementById('next').onclick=()=>{ state.page++; refresh(); };
  document.getElementById('po-page-size').onchange=e=>{ state.poPageSize=parseInt(e.target.value,10); state.poPage=1; refresh(); };
  document.getElementById('po-prev').onclick=()=>{ if(state.poPage>1){state.poPage--; refresh();} };
  document.getElementById('po-next').onclick=()=>{ state.poPage++; refresh(); };
  document.getElementById('it-page-size').onchange=e=>{ state.itPageSize=parseInt(e.target.value,10); state.itPage=1; refresh(); };
  document.getElementById('it-prev').onclick=()=>{ if(state.itPage>1){state.itPage--; refresh();} };
  document.getElementById('it-next').onclick=()=>{ state.itPage++; refresh(); };
  document.getElementById('export-sku-csv').onclick=()=>exportSkuCsv(computeSkus());
  document.getElementById('export-po-csv').onclick=()=>exportPoCsv(filteredPoRows());
  document.getElementById('export-it-csv').onclick=()=>exportItCsv(intransitRows());
  document.querySelector('#sku-table thead').onclick=e=>{
    const th=e.target.closest('th'); if(!th) return; const k=th.dataset.k;
    if(state.sortKey===k) state.sortDir*=-1; else {state.sortKey=k; state.sortDir=-1;}
    state.page=1; refresh();
  };
  document.querySelector('#po-table thead').onclick=e=>{
    const th=e.target.closest('th'); if(!th) return; const k=th.dataset.k;
    if(state.poSortKey===k) state.poSortDir*=-1; else {state.poSortKey=k; state.poSortDir=-1;}
    state.poPage=1; refresh();
  };
  document.querySelector('#it-table thead').onclick=e=>{
    const th=e.target.closest('th'); if(!th) return; const k=th.dataset.k;
    if(state.itSortKey===k) state.itSortDir*=-1; else {state.itSortKey=k; state.itSortDir=-1;}
    state.itPage=1; refresh();
  };
}
function resetPages(){ state.page=1; state.poPage=1; state.itPage=1; }

/* multi-select (plant) — mirrors MaterialAgingDashboard pattern */
function injectMSToggle(root,label){
  root.innerHTML=`<button class="ms-toggle" type="button"><span class="ms-label">${label}</span><span class="cnt">All</span><span class="chev">▾</span></button>
  <div class="ms-menu"><input class="ms-search" type="text" placeholder="search ${label.toLowerCase()}…" />
  <div class="ms-opts"></div><div class="ms-actions"><button class="ms-all">All</button><button class="ms-clear">Clear</button></div></div>`;
  const toggle=root.querySelector('.ms-toggle'), menu=root.querySelector('.ms-menu');
  toggle.onclick=e=>{ e.stopPropagation(); root.classList.toggle('open'); if(root.classList.contains('open')) root.querySelector('.ms-search').focus(); };
  root.querySelector('.ms-search').oninput=e=>{
    const t=e.target.value.toLowerCase();
    root.querySelectorAll('.ms-opt').forEach(o=>{ o.style.display=o.dataset.label.toLowerCase().includes(t)?'':'none'; });
  };
  root.querySelector('.ms-all').onclick=e=>{
    e.stopPropagation();
    state.werks = new Set([...root.querySelectorAll('.ms-opt input')].map(c=>c.value));
    root.querySelectorAll('.ms-opt input').forEach(c=>c.checked=true);
    syncMSCount(root); resetPages(); refresh();
  };
  root.querySelector('.ms-clear').onclick=e=>{ e.stopPropagation(); state.werks.clear(); root.querySelectorAll('.ms-opt input').forEach(c=>c.checked=false); syncMSCount(root); refresh(); };
}
function buildMultiSelect(root,key,opts){
  const box=root.querySelector('.ms-opts');
  box.innerHTML=opts.map(o=>`<label class="ms-opt" data-label="${esc(o.label.toLowerCase())}"><input type="checkbox" value="${esc(o.v)}" /><span>${esc(o.label)}</span></label>`).join('');
  box.querySelectorAll('.ms-opt input').forEach(c=>{
    c.onchange=()=>{
      if(c.checked) state[key].add(c.value); else state[key].delete(c.value);
      syncMSCount(root); resetPages(); refresh();
    };
  });
}
function syncMSCount(root){
  const cnt=root.querySelector('.cnt');
  cnt.textContent = state.werks.size ? state.werks.size+' selected' : 'All';
}

function boot(){
  if(window.__INVENTORY__ && window.__INVENTORY__.inventory){
    DATA=window.__INVENTORY__;
  } else {
    document.getElementById('loading').innerHTML='Failed to load data.';
    return;
  }
  AS_OF = (DATA.meta?.generated_at||'').slice(0,10) || '2026-09-03';
  initTheme();
  initUI();
  initColMan();
  refresh();
  const ld=document.getElementById('loading'); if(ld) ld.style.display='none';
}
boot();
