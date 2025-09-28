/* Bunca Bakeflow — Frontend (no separate login page)
   - Opens directly in read-only
   - Admin Key can be entered any time via lock icon in topbar
   - Routes: #/products, #/recipes, #/plan, #/admin
*/

const qs = (s,el=document)=>el.querySelector(s);
const qsa = (s,el=document)=>Array.from(el.querySelectorAll(s));

/* ----------- State ----------- */
const state = {
  adminKey: sessionStorage.getItem('adminKey') || null,
  settings: null,
  products: [],
  recipes: [],
  plan: [],
};

const api = {
  base: '',
  async req(path, opts={}) {
    const hdr = opts.headers || {};
    if (opts.method && opts.method !== 'GET' && state.adminKey) hdr['x-admin-key'] = state.adminKey;
    hdr['Content-Type'] = 'application/json';
    const url = this.base + path;
    progress(true);
    try{
      const res = await fetch(url, {...opts, headers:hdr});
      const json = await res.json().catch(()=>({ok:false,error:'Bad JSON'}));
      if(!res.ok || !json.ok) throw new Error(json.error || res.statusText);
      return json.data;
    } finally {
      progress(false);
    }
  },
  get(p){ return this.req(p); },
  post(p,body){ return this.req(p,{method:'POST', body: JSON.stringify(body||{})}); },
  put(p,body){ return this.req(p,{method:'PUT', body: JSON.stringify(body||{})}); },
  del(p){ return this.req(p,{method:'DELETE'}); }
};

/* ----------- UI primitives ----------- */
function toast(msg, type='success'){
  const host = qs('#toasts'); const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = msg; host.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; setTimeout(()=>el.remove(), 300); }, 3500);
}
function progress(on){ qs('#progress').style.transform = on ? 'scaleX(1)' : 'scaleX(0)'; }
function openDrawer(open=true){ qs('#drawer').classList.toggle('open', open); qs('#backdrop').classList.toggle('show', open); }
function setTitle(t){ qs('#page-title').textContent = t; }
function setRoleBadge(){ qs('#role-badge').textContent = state.adminKey ? 'Admin' : 'Lesen'; }

function modal(title, contentNode, actions=[{label:'Schließen'}]){
  const host = qs('#modal-host');
  const wrap = document.createElement('div');
  wrap.className='modal-wrap show';
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="hd"><div>${title}</div>
        <button class="icon-btn" aria-label="Schließen">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="bd"></div>
      <div class="ft"></div>
    </div>`;
  qs('.bd', wrap).appendChild(contentNode);
  const ft = qs('.ft', wrap);
  actions.forEach(a=>{
    const b = document.createElement('button');
    b.className = `btn ${a.class||''}`.trim();
    b.textContent = a.label;
    b.onclick = async()=>{
      try{ if(a.onClick) await a.onClick(); close(); }
      catch(e){ toast(e.message||'Fehler','error'); }
    };
    ft.appendChild(b);
  });
  function close(){ wrap.remove(); qs('#backdrop').classList.remove('show'); }
  qs('.icon-btn', wrap).onclick = close;
  qs('#backdrop').classList.add('show');
  host.appendChild(wrap);
  return {close};
}

function confirmBox(text, onYes){
  const node = document.createElement('div');
  node.innerHTML = `<div class="vstack"><div>${text}</div></div>`;
  modal('Bestätigen', node, [
    {label:'Abbrechen', class:'outline'},
    {label:'Ja', class:'primary', onClick:onYes}
  ]);
}

function truncSpan(text, max=42){
  const s = document.createElement('span');
  s.className='trunc'; s.textContent = text || '';
  if((text||'').length>max) s.title = text;
  return s;
}

/* ----------- Connectivity ----------- */
function setOnline(online){
  const dot = qs('#net-dot');
  dot.classList.toggle('online', online);
  dot.classList.toggle('offline', !online);
}
window.addEventListener('online', ()=>setOnline(true));
window.addEventListener('offline', ()=>setOnline(false));
setOnline(navigator.onLine);

/* ----------- Router ----------- */
const routes = {};
function route(path, fn){ routes[path]=fn; }
function go(hash){ location.hash = hash; }
async function render(){
  const hash = location.hash || '#/products';
  const key = hash.split('?')[0];
  qs('#app').innerHTML = '';
  (routes[key] || routes['#/products'])();
}
window.addEventListener('hashchange', render);

/* ----------- Data loaders ----------- */
async function hydrateSettings(){ state.settings = await api.get('/settings'); }
async function loadProducts(){ state.products = await api.get('/products'); }
async function loadRecipes(){ state.recipes  = await api.get('/recipes'); }
async function loadPlan(q=''){ state.plan = await api.get('/plan'+q); }

/* ----------- Key prompt ----------- */
function openKeyPrompt(){
  const node = document.createElement('div');
  node.className='vstack';
  node.innerHTML = `
    <div class="vstack">
      <label class="label">Admin Key</label>
      <input id="key" class="input" type="password" placeholder="••••••••" value="">
    </div>
    <div class="small">Schlüssel wird nur lokal im Tab gespeichert.</div>
  `;
  modal('Admin Key eingeben', node, [
    {label:'Abbrechen', class:'outline'},
    {label:'Speichern', class:'primary', onClick: ()=>{
      const val = qs('#key', node).value.trim();
      state.adminKey = val || null;
      if(state.adminKey) sessionStorage.setItem('adminKey', state.adminKey);
      else sessionStorage.removeItem('adminKey');
      setRoleBadge(); toast(state.adminKey ? 'Admin aktiv' : 'Nur-Lesen aktiv');
    }}
  ]);
}

/* ----------- Pages ----------- */

// PRODUCTS
route('#/products', async()=>{
  setTitle('Rohwaren');
  const app = qs('#app');
  await Promise.all([hydrateSettings(), loadProducts()]);
  const wrap = document.createElement('div'); wrap.className='section';

  const tb = document.createElement('div'); tb.className='toolbar';
  tb.innerHTML = `
    <input class="input grow" id="q" placeholder="Suche Name / SKU / EAN">
    <select class="select" id="f-group"><option value="">Warengruppe</option></select>
    ${state.adminKey ? `<button class="btn" id="btn-new">
      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      Neu
    </button>`:''}
  `;
  wrap.appendChild(tb);

  const uniqueGroups = Array.from(new Set(state.products.map(p=>p.group).filter(Boolean))).sort();
  const sel = qs('#f-group', tb); uniqueGroups.forEach(g=>{ const o=document.createElement('option'); o.value=g; o.textContent=g; sel.appendChild(o); });

  const tableCard = document.createElement('div'); tableCard.className='card';
  tableCard.innerHTML = `
    <table class="table">
      <thead><tr>
        <th style="width:30%">Name</th><th>Gruppe</th><th>Einheit</th><th>Pack/Verp.</th><th>Preis/Einheit</th><th>Allergene</th><th style="width:120px">Aktionen</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>`;
  wrap.appendChild(tableCard);
  app.appendChild(wrap);

  const rows = qs('#rows', tableCard);

  function renderRows(){
    const q = qs('#q', tb).value.trim().toLowerCase();
    const g = qs('#f-group', tb).value;
    rows.innerHTML='';
    let data = state.products.slice();
    if(q) data = data.filter(p => [p.name,p.sku,p.ean].join(' ').toLowerCase().includes(q));
    if(g) data = data.filter(p=>p.group===g);
    if(!data.length){ const tr = document.createElement('tr'); tr.innerHTML=`<td colspan="7"><span class="small">Keine Einträge</span></td>`; rows.appendChild(tr); return; }

    data.forEach(p=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${truncSpan(p.name).outerHTML}</td>
        <td>${p.group||'-'}</td>
        <td>${p.unit||'-'}</td>
        <td>${[p.packSize||'', p.package||''].filter(Boolean).join(' ')||'-'}</td>
        <td>${p.pricePerUnit!=null ? (Number(p.pricePerUnit).toFixed(2)+' €'):'-'}</td>
        <td><div class="badges">${(p.allergens||[]).slice(0,4).map(a=>`<span class="tag">${a}</span>`).join('')}${(p.allergens||[]).length>4?`<span class="tag">+${p.allergens.length-4}</span>`:''}</div></td>
        <td class="td-actions">
          ${state.adminKey?`<button class="btn" data-act="edit">Bearbeiten</button><button class="btn danger" data-act="del">Löschen</button>`:''}
        </td>`;
      rows.appendChild(tr);
      if(state.adminKey){
        qs('[data-act="edit"]', tr).onclick=()=> openProductModal(p);
        qs('[data-act="del"]', tr).onclick=()=> confirmBox('Produkt löschen?', async()=>{ await api.del(`/products/${p.id}`); await loadProducts(); renderRows(); toast('Gelöscht'); });
      }
    });
  }
  renderRows();
  tb.oninput = ()=>renderRows();
  sel.onchange = renderRows;
  if(state.adminKey) qs('#btn-new', tb).onclick = ()=> openProductModal();

  function openProductModal(p){
    const node = document.createElement('div'); node.className='vstack';
    node.innerHTML = `
      <div class="grid-2 vstack" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="vstack"><label class="label">Name</label><input id="name" class="input" value="${p?.name||''}"></div>
        <div class="vstack"><label class="label">Warengruppe</label><input id="group" class="input" value="${p?.group||''}"></div>
        <div class="vstack"><label class="label">Einheit</label>
          <select id="unit" class="select">${['kg','g','l','ml','pcs','box'].map(u=>`<option ${p?.unit===u?'selected':''}>${u}</option>`).join('')}</select>
        </div>
        <div class="vstack"><label class="label">Packungsmenge</label><input id="packSize" class="number" type="number" step="0.01" value="${p?.packSize??''}"></div>
        <div class="vstack"><label class="label">Verpackung</label><input id="package" class="input" value="${p?.package||''}"></div>
        <div class="vstack"><label class="label">Preis/Einheit (€)</label><input id="price" class="number" type="number" step="0.0001" value="${p?.pricePerUnit??''}"></div>
        <div class="vstack"><label class="label">SKU</label><input id="sku" class="input" value="${p?.sku||''}"></div>
        <div class="vstack"><label class="label">EAN</label><input id="ean" class="input" value="${p?.ean||''}"></div>
        <div class="vstack" style="grid-column:1 / -1"><label class="label">Allergene (Komma-getrennt)</label><input id="allergens" class="input" placeholder="gluten, nuts, milk" value="${(p?.allergens||[]).join(', ')}"></div>
      </div>`;
    modal(p?'Produkt bearbeiten':'Neues Produkt', node, [
      {label:'Abbrechen', class:'outline'},
      {label:'Speichern', class:'primary', onClick: async ()=>{
        const body = {
          name: val('#name'), group: val('#group'), unit: val('#unit'),
          packSize: num(val('#packSize')), package: val('#package'),
          pricePerUnit: num(val('#price')), sku: val('#sku'), ean: val('#ean'),
          allergens: (val('#allergens')||'').split(',').map(s=>s.trim()).filter(Boolean)
        };
        if(!body.name) throw new Error('Name ist erforderlich');
        if(p) await api.put(`/products/${p.id}`, body); else await api.post('/products', body);
        await loadProducts(); renderRows(); toast('Gespeichert');
        function val(sel){ return qs(sel,node).value.trim(); }
      } }
    ]);
  }
});

// RECIPES
route('#/recipes', async()=>{
  setTitle('Rezepte');
  const app = qs('#app');
  await Promise.all([hydrateSettings(), loadProducts(), loadRecipes()]);
  const wrap = document.createElement('div'); wrap.className='section';

  const tb = document.createElement('div'); tb.className='toolbar';
  tb.innerHTML = `
    <input class="input grow" id="q" placeholder="Suche Rezept">
    ${state.adminKey?`<button class="btn" id="btn-new"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Neues Rezept</button>`:''}
  `;
  wrap.appendChild(tb);

  const grid = document.createElement('div'); grid.className='grid'; wrap.appendChild(grid);
  app.appendChild(wrap);

  function renderCards(){
    const q = qs('#q', tb).value.trim().toLowerCase();
    let data = state.recipes.slice();
    if(q) data = data.filter(r => (r.name||'').toLowerCase().includes(q));
    grid.innerHTML='';
    if(!data.length){ const c=document.createElement('div'); c.className='card small'; c.textContent='Keine Rezepte'; grid.appendChild(c); return; }

    data.forEach(r=>{
      const c = document.createElement('div'); c.className='card recipe-card';
      const allergens = (r.allergens||[]).slice(0,4).map(a=>`<span class="tag">${a}</span>`).join('');
      c.innerHTML=`
        <div class="hdr"><span>${truncSpan(r.name,30).outerHTML}</span><div class="meta"><span>${r.yieldQty||1} ${r.yieldUnit||'pcs'}</span></div></div>
        <div class="badges" style="margin:6px 0">${allergens}${(r.allergens||[]).length>4?`<span class="tag">+${r.allergens.length-4}</span>`:''}</div>
        <div class="hstack" style="justify-content:flex-end;gap:6px">
          <button class="btn" data-act="view">Details</button>
          ${state.adminKey?`<button class="btn" data-act="edit">Bearbeiten</button><button class="btn danger" data-act="del">Löschen</button>`:''}
        </div>`;
      grid.appendChild(c);

      qs('[data-act="view"]', c).onclick=()=> viewRecipe(r);
      if(state.adminKey){
        qs('[data-act="edit"]', c).onclick=()=> openRecipeModal(r);
        qs('[data-act="del"]', c).onclick=()=> confirmBox('Rezept löschen?', async()=>{ await api.del(`/recipes/${r.id}`); await loadRecipes(); renderCards(); toast('Gelöscht'); });
      }
    });
  }
  renderCards();
  tb.oninput = ()=>renderCards();
  if(state.adminKey) qs('#btn-new', tb).onclick=()=> openRecipeModal();

  function viewRecipe(r){
    const node = document.createElement('div'); node.className='vstack';
    const ingRows = (r.ingredients||[]).map(i=>{
      const p = state.products.find(x=>x.id===i.productId);
      return `<tr><td>${p?truncSpan(p.name,32).outerHTML:'? fehlend'}</td><td>${i.qty}</td><td>${p?.unit||''}</td><td class="small">${i.note||''}</td></tr>`;
    }).join('');
    node.innerHTML=`
      <div class="vstack">
        <div class="hstack" style="justify-content:space-between">
          <div><strong>${r.name}</strong></div>
          <div class="small">${r.yieldQty||1} ${r.yieldUnit||'pcs'} pro Batch</div>
        </div>
        <div class="badges">${(r.allergens||[]).map(a=>`<span class="tag">${a}</span>`).join('')}</div>
        <div class="card" style="padding:0">
          <table class="table"><thead><tr><th>Zutat</th><th>Menge</th><th>Einheit</th><th>Notiz</th></tr></thead>
          <tbody>${ingRows||`<tr><td colspan="4" class="small">Keine Zutaten</td></tr>`}</tbody></table>
        </div>
      </div>`;
    modal('Rezept', node, [{label:'Schließen', class:'outline'}]);
  }

  function openRecipeModal(r){
    const node = document.createElement('div'); node.className='vstack';
    node.innerHTML = `
      <div class="grid-2 vstack" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="vstack"><label class="label">Name</label><input id="name" class="input" value="${r?.name||''}"></div>
        <div class="hstack" style="gap:10px">
          <div class="vstack" style="flex:1"><label class="label">Yield Menge</label><input id="yieldQty" class="number" type="number" step="1" value="${r?.yieldQty??60}"></div>
          <div class="vstack" style="width:120px"><label class="label">Einheit</label>
            <select id="yieldUnit" class="select">${['pcs','kg','g','l','ml'].map(u=>`<option ${r?.yieldUnit===u?'selected':''}>${u}</option>`).join('')}</select>
          </div>
        </div>
      </div>
      <div class="vstack">
        <div class="hstack" style="justify-content:space-between">
          <div class="label">Zutaten</div>
          <button class="btn" id="add-row"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Zutat</button>
        </div>
        <div id="rows" class="vstack"></div>
        <div class="hstack" style="justify-content:flex-end"><span class="small" id="cost">Batchkosten: –</span></div>
      </div>
    `;
    const rowsEl = qs('#rows', node);
    function addRow(it={}){
      const row = document.createElement('div'); row.className='hstack card'; row.style.padding='8px 10px';
      row.innerHTML = `
        <select class="select" style="flex:1" data-k="productId">
          <option value="">Produkt wählen…</option>
          ${state.products.map(p=>`<option value="${p.id}" ${it.productId===p.id?'selected':''}>${p.name}</option>`).join('')}
        </select>
        <input class="number" style="width:120px" data-k="qty" type="number" step="0.001" value="${it.qty??''}" placeholder="Menge">
        <input class="input" style="flex:1" data-k="note" placeholder="Notiz" value="${it.note||''}">
        <button class="icon-btn" data-act="del" title="Entfernen">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 7h12M9 7v10m6-10v10M10 7l1-2h2l1 2" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>
        </button>`;
      rowsEl.appendChild(row);
      qs('[data-act="del"]', row).onclick = ()=>{ row.remove(); computeCost(); };
      rowsEl.oninput = ()=> computeCost();
    }
    (r?.ingredients||[]).forEach(addRow);
    qs('#add-row', node).onclick = ()=> addRow();

    function computeCost(){
      let total = 0;
      qsa('[data-k="productId"]', rowsEl).forEach((sel,i)=>{
        const id = sel.value, qty = Number(qsa('[data-k="qty"]', rowsEl)[i].value||0);
        const p = state.products.find(x=>x.id===id);
        if(p?.pricePerUnit!=null) total += qty * Number(p.pricePerUnit);
      });
      qs('#cost', node).textContent = 'Batchkosten: ' + (total ? (total.toFixed(2)+' €') : '–');
    }
    computeCost();

    modal(r?'Rezept bearbeiten':'Neues Rezept', node, [
      {label:'Abbrechen', class:'outline'},
      {label:'Speichern', class:'primary', onClick: async ()=>{
        const body = {
          name: g('#name'), yieldQty: Number(g('#yieldQty')), yieldUnit: g('#yieldUnit'),
          ingredients: qsa('#rows > *', node).map(row=>({
            productId: qs('[data-k="productId"]',row).value,
            qty: Number(qs('[data-k="qty"]',row).value||0),
            note: qs('[data-k="note"]',row).value.trim()
          })).filter(x=>x.productId)
        };
        if(!body.name) throw new Error('Name ist erforderlich');
        if(r) await api.put(`/recipes/${r.id}`, body); else await api.post('/recipes', body);
        await loadRecipes(); render(); toast('Gespeichert');
        function g(sel){ return qs(sel,node).value; }
      }}
    ]);
  }
});

// PLAN
route('#/plan', async()=>{
  setTitle('Produktionsplan');
  const app = qs('#app');
  await Promise.all([hydrateSettings(), loadRecipes(), loadProducts()]);
  const wrap = document.createElement('div'); wrap.className='section';

  const today = new Date().toISOString().slice(0,10);
  const shops = state.settings?.shops || ['City','Berger','GBW'];

  const tb = document.createElement('div'); tb.className='toolbar';
  tb.innerHTML = `
    <input id="date" class="picker" type="date" value="${today}" style="width:160px">
    <select id="shop" class="select" style="width:180px">${shops.map(s=>`<option>${s}</option>`).join('')}</select>
    ${state.adminKey?`<button class="btn" id="add"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Zeile</button>`:''}
    <button class="btn" id="ready">Ready Sheet</button>
    <button class="btn" id="valid">Validieren</button>
    <button class="btn" id="sum">Zusammenfassung</button>
    <button class="btn" id="costs">Kosten</button>
  `;
  wrap.appendChild(tb);

  const tableCard = document.createElement('div'); tableCard.className='card';
  tableCard.innerHTML = `
    <table class="table">
      <thead><tr>
        <th>Rezept</th><th>Batches</th><th>Yield/Batch</th><th>Stück gesamt</th><th>Kosten (≈)</th><th>Aktionen</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>`;
  wrap.appendChild(tableCard);
  app.appendChild(wrap);

  async function refresh(){
    const d = qs('#date', tb).value; const s = qs('#shop', tb).value;
    state.plan = await api.get(`/plan?dateFrom=${d}&dateTo=${d}&shop=${encodeURIComponent(s)}`);
    renderRows();
  }
  await refresh();

  function estimateRecipeCost(rec){
    return (rec.ingredients||[]).reduce((s,i)=>{
      const p = state.products.find(x=>x.id===i.productId);
      return s + (p?.pricePerUnit ? Number(p.pricePerUnit)*Number(i.qty||0):0);
    },0);
  }

  function renderRows(){
    const tbody = qs('#rows', tableCard); tbody.innerHTML='';
    if(!state.plan.length){ const tr=document.createElement('tr'); tr.innerHTML=`<td colspan="6" class="small">Keine Einträge</td>`; tbody.appendChild(tr); return; }
    state.plan.forEach(r=>{
      const rec = state.recipes.find(x=>x.id===r.recipeId);
      const batchCost = rec ? estimateRecipeCost(rec) : 0;
      const pieces = rec?.yieldQty ? rec.yieldQty * (r.quantity||0) : '-';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${truncSpan(rec?.name || '(Rezept fehlt)', 38).outerHTML}</td>
        <td>${state.adminKey?`<input class="number" data-k="qty" style="width:100px" type="number" step="0.01" value="${r.quantity||1}">`:(r.quantity||1)}</td>
        <td>${rec?.yieldQty||'-'} ${rec?.yieldUnit||''}</td>
        <td>${pieces}</td>
        <td>${batchCost ? ( (batchCost*(r.quantity||1)).toFixed(2)+' €'):'-'}</td>
        <td class="td-actions">
          ${state.adminKey?`<button class="btn" data-act="edit">Rezept</button><button class="btn danger" data-act="del">Löschen</button>`:''}
        </td>`;
      tbody.appendChild(tr);

      if(state.adminKey){
        qs('[data-k="qty"]', tr).onchange = async(e)=>{ await api.put(`/plan/${r.id}`, { quantity: Number(e.target.value||1) }); toast('Aktualisiert'); await refresh(); };
        qs('[data-act="edit"]', tr).onclick = ()=> openRowEdit(r);
        qs('[data-act="del"]', tr).onclick = ()=> confirmBox('Zeile löschen?', async()=>{ await api.del(`/plan/${r.id}`); await refresh(); toast('Gelöscht'); });
      }
    });
  }

  function openRowEdit(row){
    const node = document.createElement('div'); node.className='vstack';
    node.innerHTML = `
      <div class="grid-2 vstack" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="vstack"><label class="label">Datum</label><input id="date" class="picker" type="date" value="${row.date}"></div>
        <div class="vstack"><label class="label">Shop</label><select id="shop" class="select">${(state.settings?.shops||[]).map(s=>`<option ${row.shop===s?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="vstack" style="grid-column:1 / -1"><label class="label">Rezept</label>
          <select id="recipe" class="select">${state.recipes.map(r=>`<option value="${r.id}" ${row.recipeId===r.id?'selected':''}>${r.name}</option>`).join('')}</select>
        </div>
        <div class="vstack"><label class="label">Batches</label><input id="qty" class="number" type="number" step="0.01" value="${row.quantity||1}"></div>
      </div>`;
    modal('Plan-Zeile', node, [
      {label:'Abbrechen', class:'outline'},
      {label:'Speichern', class:'primary', onClick: async()=>{
        await api.put(`/plan/${row.id}`, {
          date: qs('#date',node).value,
          shop: qs('#shop',node).value,
          recipeId: qs('#recipe',node).value,
          quantity: Number(qs('#qty',node).value||1)
        });
        await refresh(); toast('Gespeichert');
      }}
    ]);
  }

  if(state.adminKey) qs('#add', tb).onclick = ()=>{
    const d = qs('#date', tb).value; const s = qs('#shop', tb).value;
    const node = document.createElement('div'); node.className='vstack';
    node.innerHTML=`
      <div class="grid-2 vstack" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="vstack"><label class="label">Datum</label><input id="date" class="picker" type="date" value="${d}"></div>
        <div class="vstack"><label class="label">Shop</label><select id="shop" class="select">${(state.settings?.shops||[]).map(x=>`<option ${x===s?'selected':''}>${x}</option>`).join('')}</select></div>
        <div class="vstack" style="grid-column:1 / -1"><label class="label">Rezept</label><select id="recipe" class="select">${state.recipes.map(r=>`<option value="${r.id}">${r.name}</option>`).join('')}</select></div>
        <div class="vstack"><label class="label">Batches</label><input id="qty" class="number" type="number" step="0.01" value="1"></div>
      </div>`;
    modal('Zeile hinzufügen', node, [
      {label:'Abbrechen', class:'outline'},
      {label:'Hinzufügen', class:'primary', onClick: async()=>{
        await api.post('/plan', {
          date: qs('#date',node).value,
          shop: qs('#shop',node).value,
          recipeId: qs('#recipe',node).value,
          quantity: Number(qs('#qty',node).value||1)
        });
        await refresh(); toast('Hinzugefügt');
      }}
    ]);
  };

  // Smart buttons
  qs('#valid', tb).onclick = async ()=>{
    const d = qs('#date', tb).value; const s = qs('#shop', tb).value;
    const data = await api.get(`/plan/validate?date=${d}&shop=${encodeURIComponent(s)}`);
    const node = document.createElement('div'); node.className='vstack';
    node.innerHTML = data.count ? data.issues.map(i=>`<div class="card small">${i.type} – ${i.recipeId||''} ${i.productId||''}</div>`).join('') : `<div class="small">Keine Probleme gefunden</div>`;
    modal('Validierung', node, [{label:'OK', class:'primary'}]);
  };
  qs('#ready', tb).onclick = async ()=>{
    const d = qs('#date', tb).value; const s = qs('#shop', tb).value;
    const data = await api.get(`/ready-sheet?date=${d}&shop=${encodeURIComponent(s)}`);
    const node = document.createElement('div'); node.className='vstack';
    node.innerHTML = data.items.map(it=>{
      const ing = it.ingredients.map(x=>`<tr><td>${x.name||'?'}</td><td>${x.qty}</td><td>${x.unit||''}</td></tr>`).join('');
      return `<div class="card"><div class="hstack" style="justify-content:space-between"><strong>${it.recipeName}</strong><span class="small">${it.batches} Batches • ${it.totalPieces||'-'} Stück</span></div>
        <table class="table"><thead><tr><th>Zutat</th><th>Menge</th><th>Einheit</th></tr></thead><tbody>${ing}</tbody></table></div>`;
    }).join('') || `<div class="small">Keine Einträge</div>`;
    modal(`Ready Sheet – ${s} – ${d}`, node, [{label:'Schließen', class:'outline'},{label:'Drucken', class:'primary', onClick:()=>window.print()}]);
  };
  qs('#sum', tb).onclick = async ()=>{
    const d = qs('#date', tb).value; const s = qs('#shop', tb).value;
    const sum = await api.get(`/plan/summary?dateFrom=${d}&dateTo=${d}&shop=${encodeURIComponent(s)}`);
    const node = document.createElement('div'); node.className='vstack';
    node.innerHTML = `
      <div class="card" style="padding:0">
        <table class="table"><thead><tr><th>Produkt</th><th>Gruppe</th><th>Menge</th><th>Einheit</th><th>Kosten (≈)</th></tr></thead>
        <tbody>${sum.totals.map(t=>`<tr><td>${t.productName}</td><td>${t.group||''}</td><td>${Number(t.qty).toFixed(3)}</td><td>${t.unit||''}</td><td>${t.estCost? t.estCost.toFixed(2)+' €':'-'}</td></tr>`).join('')||`<tr><td colspan="5" class="small">Keine Daten</td></tr>`}</tbody></table>
      </div>
      <div class="hstack" style="justify-content:flex-end"><strong>Gesamtkosten: ${sum.costTotal? sum.costTotal.toFixed(2)+' €':'-'}</strong></div>`;
    modal(`Zusammenfassung – ${s} – ${d}`, node, [{label:'Schließen', class:'outline'},{label:'Drucken', class:'primary', onClick:()=>window.print()}]);
  };
  qs('#costs', tb).onclick = async ()=>{
    const d = qs('#date', tb).value; const s = qs('#shop', tb).value;
    const data = await api.get(`/plan/costs?dateFrom=${d}&dateTo=${d}&shop=${encodeURIComponent(s)}`);
    const node = document.createElement('div'); node.className='vstack';
    node.innerHTML = data.items.map(i=>`
      <div class="card hstack" style="justify-content:space-between">
        <div>${i.recipeName||'(?)'}</div>
        <div class="small">${i.batches} × ${(i.batchCost||0).toFixed(2)} € = <strong>${(i.totalCost||0).toFixed(2)} €</strong></div>
      </div>`).join('') || `<div class="small">Keine Daten</div>`;
    modal('Kosten', node, [{label:'Schließen', class:'primary'}]);
  };

  tb.onchange = async(e)=>{ if(e.target.id==='date' || e.target.id==='shop') await refresh(); };
});

// ADMIN
route('#/admin', async()=>{
  setTitle('Admin');
  const app = qs('#app');
  await hydrateSettings();

  const wrap = document.createElement('div'); wrap.className='section vstack';

  const status = document.createElement('div');
  status.className='card hstack';
  status.style.justifyContent='space-between';
  status.innerHTML = `<div><strong>Status</strong> — ${state.adminKey ? 'Admin aktiv' : 'Nur-Lesen'}</div>
                      <div class="small">Key wird im Browser-Tab gehalten.</div>`;
  wrap.appendChild(status);

  const card = document.createElement('div'); card.className='card vstack';
  card.innerHTML = `
    <div class="hstack" style="justify-content:space-between"><strong>Einstellungen</strong><span class="small">Serverseitig gespeichert</span></div>
    <div class="vstack"><label class="label">Shops (Komma)</label><input id="shops" class="input" value="${(state.settings?.shops||[]).join(', ')}"></div>
    <div class="vstack"><label class="label">Units (Komma)</label><input id="units" class="input" value="${(state.settings?.units||[]).join(', ')}"></div>
    <div class="vstack"><label class="label">Ofenkapazität (optional)</label><input id="cap" class="number" type="number" step="1" value="${state.settings?.capacity?.ovenBatchMax??''}"></div>
    ${state.adminKey?`<div><button class="btn primary" id="save-settings">Speichern</button></div>`:`<div class="small">Gib oben den Admin Key ein, um zu speichern.</div>`}
  `;
  wrap.appendChild(card);

  const dataCard = document.createElement('div'); dataCard.className='card vstack';
  dataCard.innerHTML = `
    <strong>Daten</strong>
    <div class="hstack" style="flex-wrap:wrap;gap:8px">
      <button class="btn" id="export">Export JSON</button>
      ${state.adminKey?`<label class="btn outline" for="import-file">Import JSON<input id="import-file" type="file" accept="application/json" style="display:none"></label>`:''}
      <button class="btn" id="backups">Backups</button>
    </div>`;
  wrap.appendChild(dataCard);

  app.appendChild(wrap);

  if(state.adminKey){
    qs('#save-settings', card).onclick = async()=>{
      const shops = qs('#shops', card).value.split(',').map(s=>s.trim()).filter(Boolean);
      const units = qs('#units', card).value.split(',').map(s=>s.trim()).filter(Boolean);
      const cap = Number(qs('#cap', card).value||0) || null;
      await api.put('/settings', { shops, units, capacity:{ ovenBatchMax: cap } });
      state.settings = await api.get('/settings'); toast('Gespeichert');
    };
    qs('#import-file', dataCard).onchange = async(e)=>{
      const file = e.target.files[0]; if(!file) return;
      try{ await api.post('/import', JSON.parse(await file.text())); toast('Importiert'); }
      catch{ toast('Import fehlgeschlagen','error'); }
    };
  }

  qs('#export', dataCard).onclick = async()=>{
    const data = await api.get('/export');
    const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `bunca-bakeflow-${new Date().toISOString().slice(0,10)}.json`; document.body.appendChild(a); a.click(); a.remove();
  };
  qs('#backups', dataCard).onclick = async()=>{
    const list = await api.get('/backups');
    const node = document.createElement('div'); node.className='vstack';
    node.innerHTML = list.length ? list.map(n=>`<div class="card hstack" style="justify-content:space-between"><div>${n}</div><button class="btn" data-n="${n}">Anzeigen</button></div>`).join('') : `<div class="small">Keine Backups</div>`;
    const m = modal('Backups', node, [{label:'Schließen', class:'outline'}]);
    qsa('[data-n]', node).forEach(btn=>{
      btn.onclick = async()=>{
        const name = btn.getAttribute('data-n');
        const data = await api.get('/backups/'+encodeURIComponent(name));
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(data, null, 2);
        modal(name, pre, [{label:'Schließen', class:'primary'}]);
      };
    });
  };
});

/* ----------- Drawer & Key events ----------- */
qs('#btn-menu').onclick = ()=> openDrawer(true);
qs('#btn-close-drawer').onclick = ()=> openDrawer(false);
qs('#backdrop').onclick = ()=> openDrawer(false);
qs('#btn-key').onclick = ()=> openKeyPrompt();
qs('#btn-logout').onclick = ()=>{ state.adminKey=null; sessionStorage.removeItem('adminKey'); setRoleBadge(); toast('Admin-Key entfernt'); };

/* ----------- Utils ----------- */
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

/* ----------- Bootstrap ----------- */
setRoleBadge();
render();
