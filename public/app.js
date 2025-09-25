// Tiny client helpers shared by all pages
async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body
  });
  const isJson = r.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await r.json() : null;
  return { ok: r.ok, status: r.status, data };
}
function $(s, root=document){ return root.querySelector(s); }
function el(tag, attrs={}){ const e=document.createElement(tag); Object.assign(e, attrs); return e; }
function toast(msg, type='success'){ const t=el('div',{className:`toast ${type}`,textContent:msg}); document.body.appendChild(t); setTimeout(()=>t.remove(),2200); }
async function requireSession() {
  const { data } = await api('/api/session');
  if (!data?.user) location.href = '/login';
  return data.user;
}

// Pages
window.pages = {
  async login() {
    $('#login-form').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const email = $('#email').value.trim();
      const password = $('#password').value.trim();
      const r = await api('/api/login', { method:'POST', body:{ email, password }});
      if (!r.ok) return toast('Login fehlgeschlagen', 'error');
      location.href = '/dashboard';
    });
  },

  async dashboard() {
    await requireSession();
    $('#logout').addEventListener('click', async ()=>{ await api('/api/logout',{method:'POST'}); location.href='/login'; });
    $('#seed').addEventListener('click', async ()=>{
      const wipe = $('#wipe').checked;
      const r = await api('/api/seed/full?wipe='+wipe, { method:'POST' });
      if (r.ok) toast(`Seed OK (Products: ${r.data.stats.products})`); else toast('Seed failed','error');
    });
  },

  async products() {
    await requireSession();
    $('#logout').addEventListener('click', async ()=>{ await api('/api/logout',{method:'POST'}); location.href='/login'; });

    const { data } = await api('/api/products');
    const tbody = $('#products-body'); tbody.innerHTML='';
    for (const p of data.products) {
      const tr = el('tr');
      tr.innerHTML = `
        <td><code>${p.code}</code></td>
        <td>${p.name}</td>
        <td><span class="badge">${p.base_unit}</span></td>
        <td>${Number(p.unit_cost||0).toFixed(6)}</td>
        <td>${p.supplier_code||''}</td>`;
      tbody.appendChild(tr);
    }

    $('#bulk-form').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const text = $('#bulk-text').value.trim();
      if (!text) return toast('Bitte Text einfügen','error');
      const r = await api('/api/products/bulk-prices',{method:'POST', body:{text}});
      if (r.ok) { toast(`Preise übernommen (${r.data.applied})`); location.reload(); }
      else toast('Import Fehler','error');
    });
  },

  async recipes() {
    await requireSession();
    $('#logout').addEventListener('click', async ()=>{ await api('/api/logout',{method:'POST'}); location.href='/login'; });

    // Items
    const items = (await api('/api/items')).data.items;
    const sel = $('#item');
    for (const it of items) {
      const o = el('option'); o.value = it.code; o.textContent = `${it.name} (${it.yield_qty} ${it.yield_unit})`; sel.appendChild(o);
    }

    async function calc() {
      const item = sel.value; const output = Number($('#output').value||0);
      if (!item || !output) return;
      const r = await api(`/api/calc/bom?item=${encodeURIComponent(item)}&output=${output}`);
      if (!r.ok) return toast('Fehler bei Berechnung','error');

      $('#result-title').textContent = `${r.data.item.name} – Zutaten für ${output} ${r.data.item.yield_unit}`;
      const tb = $('#calc-body'); tb.innerHTML='';
      for (const ln of r.data.lines) {
        const tr = el('tr');
        tr.innerHTML = `
          <td>${ln.product_name}</td>
          <td>${ln.qty.toFixed(2)} ${ln.unit}</td>
          <td class="small muted">${ln.base_qty.toFixed(2)} ${ln.base_unit}</td>
          <td>${ln.unit_cost.toFixed(6)}</td>
          <td>${ln.cost_total.toFixed(2)} €</td>`;
        tb.appendChild(tr);
      }
      $('#calc-total').textContent = r.data.totalCost.toFixed(2) + ' €';
    }

    sel.addEventListener('change', calc);
    $('#output').addEventListener('input', calc);
  },

  async production() {
    await requireSession();
    $('#logout').addEventListener('click', async ()=>{ await api('/api/logout',{method:'POST'}); location.href='/login'; });

    const items = (await api('/api/items')).data.items;
    const shops = (await api('/api/shops')).data.shops;

    const thead = $('#plan-head');
    const headRow = el('tr');
    headRow.innerHTML = `<th>Artikel</th><th>Total</th>`;
    for (const s of shops) headRow.innerHTML += `<th>${s.name}</th>`;
    thead.appendChild(headRow);

    const tbody = $('#plan-body');
    for (const it of items) {
      const tr = el('tr');
      tr.innerHTML = `<td>${it.name} <span class="badge">${it.yield_qty} ${it.yield_unit}</span></td>
        <td><input class="input" style="width:110px" type="number" min="0" step="1" data-total="${it.code}"></td>`;
      for (const s of shops) tr.innerHTML += `<td><input class="input" style="width:110px" type="number" min="0" step="1" data-shop="${it.code}:${s.code}"></td>`;
      tbody.appendChild(tr);
    }

    $('#save-plan').addEventListener('click', async ()=>{
      const lines = [];
      for (const it of items) {
        const total = Number(document.querySelector(`[data-total="${it.code}"]`)?.value || 0);
        const shopsObj = {};
        for (const s of shops) {
          shopsObj[s.code] = Number(document.querySelector(`[data-shop="${it.code}:${s.code}"]`)?.value || 0);
        }
        lines.push({ item_code: it.code, total_qty: total, shops: shopsObj });
      }
      const r = await api('/api/production/save',{ method:'POST', body:{ lines }});
      if (!r.ok) return toast('Plan speichern fehlgeschlagen','error');
      toast('Plan gespeichert');
    });

    $('#show-usage').addEventListener('click', async ()=>{
      const r = await api('/api/production/usage');
      if (!r.ok) return toast('Berechnung fehlgeschlagen','error');
      const tb = $('#usage-body'); tb.innerHTML='';
      for (const u of r.data.usage) {
        const tr = el('tr');
        tr.innerHTML = `<td>${u.product_name}</td><td>${u.base_qty.toFixed(2)} ${u.base_unit}</td><td>${u.unit_cost.toFixed(6)}</td><td>${u.cost_total.toFixed(2)} €</td>`;
        tb.appendChild(tr);
      }
      $('#usage-total').textContent = r.data.total_cost.toFixed(2) + ' €';
    });
  }
};

window.addEventListener('DOMContentLoaded', ()=>{
  const page = document.body.getAttribute('data-page');
  if (window.pages[page]) window.pages[page]();
});
