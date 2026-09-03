/* Inventory Dashboard — client-side analytics over data.js payload
   Sources: fact_inventory (position), fact_ztsd_detail (demand), fact_incoming (supply)
   Grain: inventory aggregated to SKU x plant; demand pre-aggregated windows. */
'use strict';

/* ---------- config / thresholds (documented in methodology card) ---------- */
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
const PALETTE = ['#4f8cff','#22c1a4','#f5a623','#ff5d6c','#a78bfa','#33c08a','#ffb347','#7b5cff'];

let DATA = null;   // window.__INVENTORY__
const state = {
  vkorg:'', werks:new Set(), extwg:'', matkl:'', window:90, status:'', risk:'', replen:'', search:'',
  sortKey:'value', sortDir:-1, page:1, pageSize:50,
  poSortKey:'del_date', poSortDir:1, poPage:1, poPageSize:50, topN:50
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
  const inv = new Map(); // matnr -> {qty,value,plants:Set}
  for(const r of DATA.inventory){
    const m=r[0], w=r[1];
    if(!plantsOk.has(w)) continue;
    const mat=DATA.mats[m]||{};
    if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
    if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
    if(q && !(m+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    let o=inv.get(m);
    if(!o){ o={qty:0,value:0,plants:new Set()}; inv.set(m,o); }
    o.qty+=r[3]; o.value+=r[4]; o.plants.add(w);
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
      if(q && !(m+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
      demand.set(m,{qW:state.window===30?s.q30:state.window===60?s.q60:state.window===90?s.q90:s.q365,
                    vW:state.window===30?s.v30:state.window===60?s.v60:state.window===90?s.v90:s.v365,
                    q365:s.q365, v365:s.v365, lastSale:s.last_sale});
    }
  }
  // 3) incoming: future-dated lines per matnr
  const inc = new Map(); // matnr -> {qty,value,pos,overdueQty,overdueValue}
  for(const i of DATA.incoming){
    if(!plantsOk.has(i.plant)) continue;
    const mat=DATA.mats[i.matnr]||{};
    if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
    if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
    if(q && !(i.matnr+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    const future = i.del_date && i.del_date >= AS_OF;
    let o=inc.get(i.matnr);
    if(!o){ o={qty:0,value:0,pos:0,overdueQty:0,overdueValue:0}; inc.set(i.matnr,o); }
    if(future){ o.qty+=i.qty; o.value+=i.value; o.pos++; }
    else { o.overdueQty+=i.qty; o.overdueValue+=i.value; }
  }
  // 4) assemble SKU rows (union of inv + demand + incoming matnrs)
  const keys = new Set([...inv.keys(), ...demand.keys(), ...inc.keys()]);
  const skus=[];
  const dailyW = state.window; // days in window
  for(const m of keys){
    const iv=inv.get(m), dm=demand.get(m), ic=inc.get(m);
    const mat=DATA.mats[m]||{};
    if(q && !(m+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    const qty=iv?iv.qty:0, value=iv?iv.value:0;
    const qW=dm?dm.qW:0, vW=dm?dm.vW:0, q365=dm?dm.q365:0, v365=dm?dm.v365:0;
    const dailyDemand=qW/dailyW;
    const coverage=dailyDemand>0?qty/dailyDemand:null;
    const incQty=ic?ic.qty:0, incValue=ic?ic.value:0, overdueQty=ic?ic.overdueQty:0;
    // stock status
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
    if(state.status && status!==state.status) continue;
    if(state.risk && risk!==state.risk) continue;
    if(state.replen && replen!==state.replen) continue;
    skus.push({matnr:m, maktx:mat.maktx||'', extwg:mat.extwg||'', ewbez:mat.ewbez||'',
      matkl:mat.matkl||'', wgbez:mat.wgbez||'', mfrnr:mat.mfrnr||'', name11:mat.name11||'',
      qty, value, plantCount:iv?iv.plants.size:0,
      qW, vW, q365, v365, dailyDemand, coverage,
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
    salesQty:0, salesValue:0, incQty:0, incValue:0, posCount:0, overdueQty:0, overdueValue:0,
    coverageDays:null, totalDaily:0,
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
    a.totalDaily+=s.dailyDemand;
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
    if(q && !(r[0]+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
    const key=r[1]+(DATA.plants[r[1]]?.name1?' – '+DATA.plants[r[1]].name1:'');
    const o=by[key]||(by[key]={value:0,qty:0});
    o.value+=r[4]; o.qty+=r[3];
  }
  return by;
}
function byOfficeSales(){
  const plantsOk=eligiblePlants();
  const q=state.search.trim().toLowerCase();
  const catFilter = state.extwg || state.matkl || q;
  const by={};
  if(catFilter){
    // category/search-scoped: aggregate office sales from material x office rows
    const agg=new Map();
    for(const r of DATA.sales_mat_office){
      if(state.werks.size||state.vkorg){ if(!plantsOk.has(r[1])) continue; }
      const mat=DATA.mats[r[0]]||{};
      if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
      if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
      if(q && !(r[0]+' '+(mat.maktx||'')).toLowerCase().includes(q)) continue;
      const W=state.window;
      const qty=W===30?r[2]:W===60?r[4]:W===90?r[4]:r[6];
      const val=W===30?r[3]:W===60?r[5]:W===90?r[5]:r[7];
      let o=agg.get(r[1]);
      if(!o){ o={qty:0,value:0,name:r[1]}; agg.set(r[1],o); }
      o.qty+=qty; o.value+=val;
    }
    for(const [o,v] of agg){
      const nm=(DATA.sales_office[o]&&DATA.sales_office[o].name)||o;
      by[nm]=v;
    }
  } else {
    for(const [o,info] of Object.entries(DATA.sales_office)){
      if(state.werks.size||state.vkorg){ if(!plantsOk.has(o)) continue; }
      const W=state.window;
      const q2=W===30?info.q30:W===60?info.q60:W===90?info.q90:info.q365;
      const v=W===30?info.v30:W===60?info.v60:W===90?info.v90:info.v365;
      by[info.name||o]={qty:q2,value:v};
    }
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
    {cls:'k-value',label:'Total Inventory Value',value:fmtMoney(a.invValue),sub:fmtInt(a.invQty)+' units · '+fmtInt(a.skuCount)+' SKUs'},
    {cls:'k-value',label:'Total Inventory Qty',value:fmtInt(a.invQty)+' u',sub:'across '+fmtInt(a.skusInStock)+' SKUs in stock'},
    {cls:'k-good',label:'Sales Value ('+state.window+'d)',value:fmtMoney(a.salesValue),sub:fmtInt(a.salesQty)+' units sold'},
    {cls:'k-value',label:'Incoming PO Value',value:fmtMoney(a.incValue),sub:fmtInt(a.incQty)+' units · '+fmtInt(a.posCount)+' PO lines'},
    {cls:'k-risk',label:'Out-of-Stock SKUs',value:fmtInt(a.outOfStock),sub:fmtInt(a.outWithDemand)+' with recent demand'},
    {cls:'k-warn',label:'Critical / High Risk',value:fmtInt(a.criticalCount)+' / '+fmtInt(a.highCount),sub:'SKUs needing attention'},
    {cls:'k-warn',label:'Potential Excess Value',value:fmtMoney(a.excessValue),sub:fmtInt(a.excessCount)+' SKUs > '+EXCESS_COV+'d coverage'},
    {cls:'k-good',label:'Portfolio Coverage',value:a.coverageDays==null?'—':fmtNum(a.coverageDays,0)+' d',sub:'stock ÷ daily demand'},
  ];
  document.getElementById('kpis').innerHTML=cards.map(c=>`
    <div class="kpi ${c.cls}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('');
}

/* ---------- charts ---------- */
function renderPareto(skus){
  const top=[...skus].sort((x,y)=>y.value-x.value).slice(0,20);
  const labels=top.map(s=>strip0(s.matnr));
  const vals=top.map(s=>s.value);
  const total=vals.reduce((x,y)=>x+y,0);
  let cum=0; const pct=vals.map(v=>{cum+=v; return total>0?cum/total*100:0;});
  const ctx=document.getElementById('chart-pareto');
  if(charts.pareto)charts.pareto.destroy();
  charts.pareto=new Chart(ctx,{type:'bar',data:{labels,datasets:[
    {label:'Inventory value',data:vals,backgroundColor:'#4f8cff',borderRadius:6,yAxisID:'y',order:2},
    {label:'Cumulative %',data:pct,type:'line',borderColor:cssVar('--text')||'#e7edf5',backgroundColor:cssVar('--text')||'#e7edf5',
     borderWidth:2.5,tension:.3,pointRadius:3,pointBorderColor:cssVar('--text')||'#e7edf5',pointBackgroundColor:cssVar('--text')||'#e7edf5',yAxisID:'y1',order:1}
  ]},options:{maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
    plugins:{legend:{labels:{usePointStyle:true}},
      tooltip:{callbacks:{label:ctx2=>ctx2.dataset.yAxisID==='y1'?ctx2.raw.toFixed(1)+'% cum.':fmtMoney(ctx2.raw)}}},
    scales:{y:{position:'left',title:{display:true,text:'Value'},ticks:{callback:v=>fmtMoneyM(v)}},
      y1:{position:'right',title:{display:true,text:'Cumulative %'},min:0,max:100,grid:{drawOnChartArea:false},ticks:{callback:v=>v+'%'}}}}});
}
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
        tooltip:{callbacks:{title:items=>items[0].label,label:c=>['Value: '+fmtMoney(c.raw),'Qty: '+fmtInt(entries[c.dataIndex][1].qty)+' · '+fmtInt(entries[c.dataIndex][1].count)+' SKUs']}}},
      scales:{x:{ticks:{callback:v=>fmtMoneyM(v)}}}}});
}
function renderPlant(by){
  const top=Object.entries(by).sort((x,y)=>y[1].value-x[1].value).slice(0,15);
  const ctx=document.getElementById('chart-plant');
  if(charts.plant)charts.plant.destroy();
  charts.plant=new Chart(ctx,{type:'bar',data:{labels:top.map(e=>e[0]),
    datasets:[{label:'Inventory value',data:top.map(e=>e[1].value),backgroundColor:'#22c1a4',borderRadius:6}]},
    options:{maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>['Value: '+fmtMoney(c.raw),'Qty: '+fmtInt(top[c.dataIndex][1].qty)]}}},
      scales:{y:{ticks:{callback:v=>fmtMoneyM(v)}}}}});
}
function renderTrend(){
  const rows=DATA.trend_month.slice(-18);
  const labels=rows.map(r=>{const y=String(r[0]); return y.slice(4,6)+'/'+y.slice(2,4);});
  const ctx=document.getElementById('chart-trend');
  if(charts.trend)charts.trend.destroy();
  charts.trend=new Chart(ctx,{type:'bar',data:{labels,datasets:[
    {label:'Qty',data:rows.map(r=>r[1]),backgroundColor:'#4f8cff',borderRadius:6,yAxisID:'y',order:2},
    {label:'Value (M)',data:rows.map(r=>+(r[2]/1e6).toFixed(3)),type:'line',borderColor:cssVar('--text')||'#e7edf5',
     backgroundColor:cssVar('--text')||'#e7edf5',borderWidth:2.5,tension:.3,pointRadius:3,yAxisID:'y1',order:1}
  ]},options:{maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
    plugins:{legend:{labels:{usePointStyle:true}}},
    scales:{y:{position:'left',title:{display:true,text:'Qty'},ticks:{callback:v=>fmtInt(v)}},
      y1:{position:'right',title:{display:true,text:'Value (M SAR)'},grid:{drawOnChartArea:false},ticks:{callback:v=>v}}}}});
}
function renderSalesPlant(by){
  const top=Object.entries(by).sort((x,y)=>y[1].value-x[1].value).slice(0,15);
  const ctx=document.getElementById('chart-salesplant');
  if(charts.salesplant)charts.salesplant.destroy();
  charts.salesplant=new Chart(ctx,{type:'bar',data:{labels:top.map(e=>e[0]),
    datasets:[{label:'Sales value',data:top.map(e=>e[1].value),backgroundColor:'#f5a623',borderRadius:6}]},
    options:{maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>['Value: '+fmtMoney(c.raw),'Qty: '+fmtInt(top[c.dataIndex][1].qty)]}}},
      scales:{y:{ticks:{callback:v=>fmtMoneyM(v)}}}}});
}
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
      y1:{position:'right',title:{display:true,text:'Value (M SAR)'},grid:{drawOnChartArea:false},ticks:{callback:v=>v}}}}});
}
function renderScatter(skus){
  // top SKUs by value (keep readable), x = inventory value, y = window sales value, r = incoming qty
  const pts=[...skus].sort((x,y)=>y.value-x.value).slice(0,400)
    .filter(s=>s.value>0||s.vW>0)
    .map(s=>({x:s.value, y:s.vW, r:Math.min(22, 4+Math.sqrt(s.incQty)*0.35), sku:s}));
  const ctx=document.getElementById('chart-scatter');
  if(charts.scatter)charts.scatter.destroy();
  charts.scatter=new Chart(ctx,{type:'scatter',data:{datasets:[
    {label:'SKUs',data:pts,backgroundColor:pts.map(p=>RISK_COLOR[p.sku.risk]+'99'),borderColor:pts.map(p=>RISK_COLOR[p.sku.risk]),
     borderWidth:1,pointRadius:pts.map(p=>p.r),pointHoverRadius:pts.map(p=>p.r+3)}
  ]},options:{maintainAspectRatio:false,
    plugins:{legend:{display:false},
      tooltip:{callbacks:{title:items=>{const p=items[0].raw.sku; return strip0(p.matnr)+' – '+p.maktx;},
        label:c=>{const p=c.raw.sku; return ['Inv value: '+fmtMoney(p.value),'Sales ('+state.window+'d): '+fmtMoney(p.vW)+' · '+fmtInt(p.qW)+' u',
          'Incoming: '+fmtInt(p.incQty)+' u','Coverage: '+(p.coverage==null?'—':fmtNum(p.coverage,0)+' d'),'Risk: '+p.risk];}}}},
    scales:{x:{type:'linear',title:{display:true,text:'Inventory value (SAR)'},ticks:{callback:v=>fmtMoneyM(v)}},
      y:{type:'linear',title:{display:true,text:'Sales value ('+state.window+'d, SAR)'},ticks:{callback:v=>fmtMoneyM(v)}}}}});
}

/* ---------- SKU table ---------- */
const SKU_COLS=[
  {k:'matnr',t:'SKU',cls:''},
  {k:'maktx',t:'Description',cls:''},
  {k:'ewbez',t:'Ext Group',cls:''},
  {k:'wgbez',t:'Mat.Grp',cls:''},
  {k:'plantCount',t:'Plants',cls:'num'},
  {k:'qty',t:'Qty',cls:'num'},
  {k:'value',t:'Value',cls:'num'},
  {k:'qW',t:'Sales Qty',cls:'num'},
  {k:'vW',t:'Sales Value',cls:'num'},
  {k:'dailyDemand',t:'Daily Sales',cls:'num'},
  {k:'coverage',t:'Coverage d',cls:'num'},
  {k:'incQty',t:'Incoming Qty',cls:'num'},
  {k:'incValue',t:'Incoming Value',cls:'num'},
  {k:'status',t:'Stock Status',cls:''},
  {k:'risk',t:'Risk',cls:''},
  {k:'lastSale',t:'Last Sale',cls:''},
];
const SKU_HEAD=['SKU','Description','Ext Group','Mat.Grp','Plants','Qty','Value','Sales Qty','Sales Value','Daily Sales','Coverage d','Incoming Qty','Incoming Value','Stock Status','Risk','Last Sale'];
const SKU_CSV_KEYS=['matnr','maktx','ewbez','wgbez','plantCount','qty','value','qW','vW','dailyDemand','coverage','incQty','incValue','status','risk','lastSale'];
function drawSkuTable(skus){
  const cols=SKU_COLS;
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
      if(c.k==='maktx') return `<td>${esc(v)}</td>`;
      if(c.k==='status') return `<td><span class="tag ${STATUS_CLASS[v]||'t-None'}">${esc(v)}</span></td>`;
      if(c.k==='risk') return `<td><span class="tag ${RISK_CLASS[v]||'t-None'}">${esc(v)}</span></td>`;
      if(c.k==='lastSale') return `<td>${v?esc(v.slice(0,10)):'—'}</td>`;
      if(c.k==='coverage') return `<td class="num">${v==null?'—':fmtNum(v,0)}</td>`;
      if(c.k==='qty'||c.k==='qW'||c.k==='incQty') return `<td class="num">${fmtInt(v)}</td>`;
      if(c.k==='dailyDemand') return `<td class="num">${fmtNum(v,1)}</td>`;
      if(c.k==='value'||c.k==='vW'||c.k==='incValue') return `<td class="num">${fmtMoney(v)}</td>`;
      return `<td class="num">${fmtInt(v)}</td>`;
    }).join('')+'</tr>').join('');
  document.getElementById('page-info').textContent='Page '+state.page+' of '+pages+' · '+fmtInt(total)+' SKUs';
  document.getElementById('prev').disabled=state.page<=1;
  document.getElementById('next').disabled=state.page>=pages;
}
function exportSkuCsv(skus){
  const sorted=[...skus].sort((x,y)=>{
    let a=x[state.sortKey],b=y[state.sortKey];
    if(typeof a==='number'&&typeof b==='number')return (a-b)*state.sortDir;
    a=(a==null?'':String(a));b=(b==null?'':String(b));
    return a<b?-1*state.sortDir:a>b?1*state.sortDir:0;
  });
  const limited = state.topN>0 ? sorted.slice(0,state.topN) : sorted;
  const rows=[SKU_HEAD.join(',')];
  for(const r of limited){
    rows.push(SKU_CSV_KEYS.map(k=>{
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
  {k:'maktx',t:'Description',cls:''},{k:'plant',t:'Plant',cls:''},{k:'sloc',t:'SLoc',cls:''},
  {k:'vendor_name',t:'Vendor',cls:''},{k:'qty',t:'Qty',cls:'num'},{k:'uom',t:'UoM',cls:''},
  {k:'value',t:'Value',cls:'num'},{k:'po_date',t:'PO Date',cls:''},{k:'del_date',t:'Delivery',cls:''},
  {k:'status',t:'Status',cls:''},
];
const PO_HEAD=['PO','Item','Material','Description','Plant','SLoc','Vendor','Qty','UoM','Value','PO Date','Delivery','Status'];
function filteredPoRows(){
  const plantsOk=eligiblePlants();
  const q=state.search.trim().toLowerCase();
  const rows=[];
  for(const i of DATA.incoming){
    if(!plantsOk.has(i.plant)) continue;
    const mat=DATA.mats[i.matnr]||{};
    if(state.extwg && (mat.extwg||'')!==state.extwg) continue;
    if(state.matkl && (mat.matkl||'')!==state.matkl) continue;
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
    data.push(['po','item','matnr','maktx','plant','sloc','vendor_name','qty','uom','value','po_date','del_date','status']
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

/* ---------- insights ---------- */
function buildInsights(skus,a){
  const ins=[];
  const total=a.invValue;
  // concentration
  const top20=[...skus].sort((x,y)=>y.value-x.value).slice(0,20);
  const top20v=top20.reduce((s,x)=>s+x.value,0);
  if(total>0) ins.push({rank:90,cls:'ic-blue',icon:'📊',html:`<b>${fmtNum(top20v/total*100,1)}%</b> of total inventory value (${fmtMoney(top20v)}) is concentrated in the top 20 SKUs.`,meta:'Pareto concentration'});
  // warehouse with highest value
  const byP=byPlantInventory();
  const topP=Object.entries(byP).sort((x,y)=>y[1].value-x[1].value)[0];
  if(topP) ins.push({rank:80,cls:'ic-blue',icon:'🏬',html:`<b>${esc(topP[0])}</b> holds the highest inventory value: ${fmtMoney(topP[1].value)} (${fmtNum(topP[1].value/total*100,1)}% of total).`,meta:'Warehouse concentration'});
  // out of stock with demand
  const oos=skus.filter(s=>s.status==='Out of Stock'&&s.qW>0);
  if(oos.length) ins.push({rank:95,cls:'ic-red',icon:'⛔',html:`<b>${fmtInt(oos.length)} SKUs</b> are out of stock but have recent sales activity (${fmtMoney(oos.reduce((s,x)=>s+x.vW,0))} of ${state.window}d sales).`,meta:'Stock-out risk'});
  // critical / high risk
  const cr=skus.filter(s=>s.risk==='Critical'), hi=skus.filter(s=>s.risk==='High');
  if(cr.length||hi.length) ins.push({rank:93,cls:'ic-red',icon:'⚠️',html:`<b>${fmtInt(cr.length)} SKUs critical</b> (${fmtInt(hi.length)} high) on stock risk. Critical = stock-out / coverage < ${LOW_COV}d with demand and insufficient incoming supply.`,meta:'Risk exposure'});
  // excess
  if(a.excessValue>0) ins.push({rank:70,cls:'ic-amber',icon:'💤',html:`<b>${fmtMoney(a.excessValue)}</b> of inventory (${fmtInt(a.excessCount)} SKUs) exceeds ${EXCESS_COV} days of coverage — potential excess working capital.`,meta:'Excess inventory'});
  // slow moving
  if(a.slowValue>0) ins.push({rank:60,cls:'ic-amber',icon:'🐌',html:`<b>${fmtMoney(a.slowValue)}</b> of inventory (${fmtInt(a.slowCount)} SKUs) has <b>no sales in the last ${state.window} days</b>.`,meta:'Slow moving'});
  // incoming
  if(a.incQty>0) ins.push({rank:50,cls:'ic-green',icon:'🚚',html:`<b>${fmtInt(a.incQty)} units / ${fmtMoney(a.incValue)}</b> are on incoming POs (${fmtInt(a.posCount)} lines) for delivery from ${AS_OF}.`,meta:'Incoming supply'});
  // high demand insufficient incoming
  const hd=skus.filter(s=>s.qW>0 && s.dailyDemand>0 && (s.coverage==null||s.coverage<LOW_COV) && s.incQty < s.dailyDemand*LOW_COV);
  if(hd.length) ins.push({rank:92,cls:'ic-red',icon:'🔥',html:`<b>${fmtInt(hd.length)} high-demand SKUs</b> have less than ${LOW_COV} days of stock and insufficient incoming supply (< ${LOW_COV} days of demand on order).`,meta:'Replenishment gap'});
  // zero stock recent sales
  const zs=skus.filter(s=>s.qty<=0 && s.qW>0);
  if(zs.length) ins.push({rank:88,cls:'ic-red',icon:'🕳️',html:`<b>${fmtInt(zs.length)} SKUs</b> have zero inventory but recent sales in the last ${state.window} days — review replenishment urgently.`,meta:'Zero stock with demand'});
  // high inventory low sales
  const hl=skus.filter(s=>s.status==='Excess'||s.status==='No Recent Sales').sort((x,y)=>y.value-x.value).slice(0,5);
  if(hl.length) ins.push({rank:55,cls:'ic-amber',icon:'📦',html:`High inventory / low demand: <b>${esc(hl.map(s=>strip0(s.matnr)).join(', '))}</b> (${fmtMoney(hl.reduce((s,x)=>s+x.value,0))} combined).`,meta:'Excess candidates'});
  // overdue
  if(a.overdueValue>0) ins.push({rank:75,cls:'ic-amber',icon:'⏰',html:`<b>${fmtMoney(a.overdueValue)}</b> of PO lines have a delivery date before ${AS_OF} (${fmtInt(a.overdueQty)} units) — verify receipt or expedite.`,meta:'Overdue deliveries'});
  // coverage portfolio
  if(a.coverageDays!=null) ins.push({rank:40,cls:'ic-green',icon:'🛡️',html:`Portfolio coverage is <b>${fmtNum(a.coverageDays,0)} days</b> (total stock ÷ daily demand).`,meta:'Portfolio'});
  // category exposure
  const egTop=Object.entries(a.byExtwg).sort((x,y)=>y[1].value-x[1].value).slice(0,3);
  if(egTop.length) ins.push({rank:35,cls:'ic-blue',icon:'🏷️',html:`Top value categories: <b>${esc(egTop.map(e=>e[0]+' ('+fmtNum(e[1].value/total*100,1)+'%)').join(' · '))}</b>.`,meta:'Category exposure'});
  ins.sort((x,y)=>y.rank-x.rank);
  return ins.slice(0,12);
}
function renderInsights(skus,a){
  const ins=buildInsights(skus,a);
  document.getElementById('insights').innerHTML = ins.length
    ? ins.map(i=>`<div class="insight ${i.cls}"><div class="ic">${i.icon}</div><div><div>${i.html}</div><div class="i-meta">${esc(i.meta)}</div></div></div>`).join('')
    : '<div class="insight ic-blue"><div class="ic">ℹ️</div><div>No insights for the current filter selection.</div></div>';
}

/* ---------- methodology ---------- */
function renderMethodology(){
  const m=DATA.meta;
  const html=`
  <p><b>Sources:</b> fact_inventory (inventory position) · fact_ztsd_detail (sales/demand) · fact_incoming (open purchase orders), extracted ${esc(m.generated_at)}. Sales data through ${esc(m.ref_date)}. ${fmtInt(m.inv_combos)} SKU×plant inventory combos, ${fmtInt(m.materials)} materials, ${fmtInt(m.incoming_lines)} open PO lines.</p>
  <p><b>Stock value</b> = Σ(qty × ma_price) per SKU×plant. <b>Demand</b> uses net quantity and net value in the selected window (returns/credit memos are negative rows and are netted). <b>Coverage days</b> = stock qty ÷ daily demand (window qty ÷ window days). <b>Incoming</b> = PO lines with delivery date ≥ ${esc(AS_OF)}; earlier lines are flagged Overdue.</p>
  <p><b>Thresholds:</b> Critical &lt; ${LOW_COV}d coverage · Low Stock ${LOW_COV}–${OK_COV}d · Healthy ${OK_COV}–${EXCESS_COV}d · Excess &gt; ${EXCESS_COV}d · Watch (no sales) when value &gt; ${fmtMoney(SLOW_VALUE)}. Risk: Critical = stock-out/&lt;${LOW_COV}d with demand &amp; insufficient incoming · High = low stock w/ demand or incoming pending · Watch = excess/overstock or slow-moving value. Demand window is user-selectable (30/60/90/365d).</p>
  <p><b>Data notes:</b> 421 inventory rows have zero ma_price (included at SAR 0). 1,624 materials sold in the period have no current stock row (they appear as Out of Stock / No Stock). Plant filter scopes inventory and incoming; sales are company-wide unless a plant/org filter restricts the office set.</p>`;
  document.getElementById('methodology').innerHTML=html;
}

/* ---------- refresh / boot ---------- */
function refresh(){
  const skus=computeSkus();
  const a=aggregate(skus);
  renderKPIs(a);
  renderPareto(skus);
  renderStatus(a);
  renderExtwg(a);
  renderPlant(byPlantInventory());
  renderTrend();
  renderSalesPlant(byOfficeSales());
  renderRisk(a);
  renderIncoming(incomingByMonth());
  renderScatter(skus);
  drawSkuTable(skus);
  const poRows=filteredPoRows();
  drawPoTable(poRows);
  renderInsights(skus,a);
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
  document.getElementById('f-window').onchange=e=>{state.window=parseInt(e.target.value,10); resetPages(); refresh();};
  document.getElementById('f-status').onchange=e=>{state.status=e.target.value; resetPages(); refresh();};
  document.getElementById('f-risk').onchange=e=>{state.risk=e.target.value; resetPages(); refresh();};
  document.getElementById('f-replen').onchange=e=>{state.replen=e.target.value; resetPages(); refresh();};
  document.getElementById('f-search').oninput=e=>{state.search=e.target.value; resetPages(); refresh();};
  document.getElementById('reset').onclick=()=>{
    state.vkorg=''; state.werks.clear(); state.extwg=''; state.matkl=''; state.window=90;
    state.status=''; state.risk=''; state.replen=''; state.search='';
    document.getElementById('f-vkorg').value=''; document.getElementById('f-extwg').value='';
    document.getElementById('f-matkl').value=''; document.getElementById('f-window').value='90';
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
  document.getElementById('export-sku-csv').onclick=()=>exportSkuCsv(computeSkus());
  document.getElementById('export-po-csv').onclick=()=>exportPoCsv(filteredPoRows());
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
}
function resetPages(){ state.page=1; state.poPage=1; }

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
  refresh();
  const ld=document.getElementById('loading'); if(ld) ld.style.display='none';
}
boot();
