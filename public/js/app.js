// Tiny SPA controller for BUNCA Planner
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

async function j(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function setActive(view) {
  $$('.tab').forEach(b => {
    b.classList.toggle('bg-slate-900', b.dataset.view === view);
    b.classList.toggle('text-white', b.dataset.view === view);
    b.classList.toggle('bg-slate-100', b.dataset.view !== view);
  });
}

function html(strings, ...vals) {
  return strings.reduce((s, str, i) => s + str + (vals[i] ?? ''), '');
}

async function ensureSession() {
  const { ok, user } = await j('/api/session');
  if (!ok || !user) { location.href = '/'; return null; }
  $('#userEmail').textContent = user.email || '';
  return user;
}

/* ---------- VIEWS ---------- */

async function renderHome() {
  $('#view').innerHTML = html`
    <section class="space-y-4">
      <h1 class="text-2xl font-bold">Übersicht</h1>
      <p class="text-slate-600">Willkommen! Wähle oben einen Bereich aus.</p>
      <div id="stats" class="grid grid-cols-1 sm:grid-cols-3 gap-4"></div>
    </section>
  `;
  try {
    const mats = await j('/api/materials');
    const items = await j('/api/items');
    $('#stats').innerHTML = html`
      <div class="p-4 rounded-lg bg-white border">
        <div class="text-sm text-slate-500">Rohwaren</div>
        <div class="text-3xl font-semibold mt-1">${mats.data.length}</div>
      </div>
      <div class="p-4 rounded-lg bg-white border">
        <div class="text-sm text-slate-500">Artikel/Rezepte</div>
        <div class="text-3xl font-semibold mt-1">${items.data.length}</div>
      </div>
      <div class="p-4 rounded-lg bg-white border">
        <div class="text-sm text-slate-500">Letzter Seed</div>
        <div class="mt-1">Nutze „Seed (Wizard)“ um Daten einzuspielen.</div>
      </div>
    `;
  } catch (e) {
    $('#stats').innerHTML = `<div class="text-red-600">Fehler beim Laden: ${e.message}</div>`;
  }
}

async function renderSeed() {
  $('#view').innerHTML = html`
    <section class="space-y-4">
      <h1 class="text-2xl font-bold">Seed (Wizard)</h1>
      <p class="text-slate-600">Liest JSON aus <code>/seed/</code> (suppliers/materials/items/bom/plan) und führt idempotente UPSERTs aus.</p>
      <button id="applySeed" class="px-4 py-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700">Seed anwenden</button>
      <div id="seedOut" class="text-sm text-slate-600"></div>
    </section>
  `;
  $('#applySeed').onclick = async () => {
    $('#seedOut').textContent = 'Wird angewendet…';
    try {
      const { ok, counts, error } = await j('/api/admin/seed/apply', { method: 'POST', body: '{}' });
      if (!ok) throw new Error(error || 'Seed fehlgeschlagen');
      $('#seedOut').textContent = `OK: ${JSON.stringify(counts)}`;
    } catch (e) {
      $('#seedOut').innerHTML = `<span class="text-red-600">Fehler: ${e.message}</span>`;
    }
  };
}

async function renderMaterials() {
  $('#view').innerHTML = html`
    <section class="space-y-4">
      <div class="flex items-end justify-between">
        <h1 class="text-2xl font-bold">Rohwaren</h1>
        <details>
          <summary class="cursor-pointer text-sm text-slate-600">Bulk-Preise einfügen</summary>
          <div class="mt-2 p-3 rounded border bg-white max-w-xl">
            <p class="text-sm text-slate-600 mb-2">Format: <code>CODE | 0.00123</code> pro Zeile</p>
            <textarea id="bulkTxt" class="w-full h-32 border rounded p-2 font-mono text-sm"></textarea>
            <div class="mt-2 flex gap-2">
              <button id="bulkApply" class="px-3 py-1.5 rounded bg-slate-900 text-white">Anwenden</button>
              <div id="bulkOut" class="text-sm text-slate-600"></div>
            </div>
          </div>
        </details>
      </div>
      <div id="matWrap" class="overflow-x-auto rounded border bg-white"></div>
    </section>
  `;

  $('#bulkApply').onclick = async () => {
    const text = $('#bulkTxt').value;
    $('#bulkOut').textContent = 'Sende…';
    try {
      const r = await j('/api/materials/bulk-prices', { method: 'POST', body: JSON.stringify({ text }) });
      $('#bulkOut').textContent = `Aktualisiert: ${r.updated}`;
      await renderMaterials(); // refresh
    } catch (e) {
      $('#bulkOut').textContent = `Fehler: ${e.message}`;
    }
  };

  try {
    const { data } = await j('/api/materials');
    const rows = data.map(m => html`
      <tr class="border-t">
        <td class="px-3 py-2 font-mono">${m.code}</td>
        <td class="px-3 py-2">${m.name}</td>
        <td class="px-3 py-2">${m.base_unit}</td>
        <td class="px-3 py-2 text-right">${Number(m.price_per_unit || 0).toFixed(6)}</td>
        <td class="px-3 py-2">${m.supplier_name || ''}</td>
      </tr>
    `).join('');
    $('#matWrap').innerHTML = html`
      <table class="min-w-full text-sm">
        <thead class="bg-slate-50">
          <tr>
            <th class="text-left px-3 py-2">Code</th>
            <th class="text-left px-3 py-2">Name</th>
            <th class="text-left px-3 py-2">Einheit</th>
            <th class="text-right px-3 py-2">Preis/Einheit</th>
            <th class="text-left px-3 py-2">Lieferant</th>
          </tr>
        </thead>
        <tbody>${rows || ''}</tbody>
      </table>
    `;
  } catch (e) {
    $('#matWrap').innerHTML = `<div class="p-3 text-red-600">Fehler: ${e.message}</div>`;
  }
}

async function renderItems() {
  $('#view').innerHTML = html`
    <section class="space-y-4">
      <h1 class="text-2xl font-bold">Artikel & Rezepte</h1>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="rounded border bg-white">
          <div class="px-3 py-2 border-b font-semibold">Artikel</div>
          <div id="itemsList" class="divide-y"></div>
        </div>
        <div class="rounded border bg-white">
          <div class="px-3 py-2 border-b font-semibold">Rezept (BOM)</div>
          <div id="bomPane" class="p-3 text-sm text-slate-600">Artikel wählen…</div>
        </div>
      </div>
    </section>
  `;
  try {
    const { data } = await j('/api/items');
    $('#itemsList').innerHTML = data.map(it => html`
      <button class="w-full text-left px-3 py-2 hover:bg-slate-50" data-code="${it.code}">
        <div class="font-medium">${it.name}</div>
        <div class="text-xs text-slate-500">${it.code} • Yield: ${it.yield_qty} ${it.yield_unit}</div>
      </button>
    `).join('');
    $('#itemsList').onclick = async (e) => {
      const b = e.target.closest('button[data-code]');
      if (!b) return;
      const code = b.dataset.code;
      const bom = await j(`/api/items/${encodeURIComponent(code)}/bom`);
      const lines = bom.data.map(r => html`
        <tr class="border-t">
          <td class="px-2 py-1 font-mono">${r.material_code}</td>
          <td class="px-2 py-1">${r.material_name}</td>
          <td class="px-2 py-1 text-right">${r.qty}</td>
          <td class="px-2 py-1">${r.unit}</td>
        </tr>
      `).join('');
      $('#bomPane').innerHTML = html`
        <div class="mb-2 font-medium">${code}</div>
        <table class="min-w-full text-sm">
          <thead class="bg-slate-50">
            <tr>
              <th class="text-left px-2 py-1">Code</th>
              <th class="text-left px-2 py-1">Rohware</th>
              <th class="text-right px-2 py-1">Menge</th>
              <th class="text-left px-2 py-1">Einheit</th>
            </tr>
          </thead>
          <tbody>${lines || ''}</tbody>
        </table>
      `;
    };
  } catch (e) {
    $('#view').innerHTML += `<div class="text-red-600">Fehler: ${e.message}</div>`;
  }
}

async function renderPlan() {
  $('#view').innerHTML = html`
    <section class="space-y-4">
      <div class="flex items-end gap-3">
        <h1 class="text-2xl font-bold">Produktionsplan</h1>
        <input type="date" id="planDate" class="border rounded px-2 py-1" />
        <button id="loadPlan" class="px-3 py-1.5 rounded bg-slate-900 text-white">Laden</button>
        <button id="calcPlan" class="px-3 py-1.5 rounded bg-emerald-600 text-white">Material-Bedarf</button>
      </div>
      <div id="planWrap" class="rounded border bg-white"></div>
      <div id="calcWrap"></div>
    </section>
  `;
  $('#loadPlan').onclick = async () => {
    const date = $('#planDate').value;
    if (!date) return;
    const { data } = await j(`/api/plan?date=${encodeURIComponent(date)}`);
    const rows = data.map(p => html`
      <tr class="border-t">
        <td class="px-2 py-1">${p.start_time || ''}</td>
        <td class="px-2 py-1">${p.end_time || ''}</td>
        <td class="px-2 py-1 font-mono">${p.product_code}</td>
        <td class="px-2 py-1">${p.product_name || ''}</td>
        <td class="px-2 py-1 text-right">${p.qty}</td>
      </tr>
    `).join('');
    $('#planWrap').innerHTML = html`
      <table class="min-w-full text-sm">
        <thead class="bg-slate-50">
          <tr>
            <th class="text-left px-2 py-1">Start</th>
            <th class="text-left px-2 py-1">Ende</th>
            <th class="text-left px-2 py-1">Code</th>
            <th class="text-left px-2 py-1">Artikel</th>
            <th class="text-right px-2 py-1">Menge</th>
          </tr>
        </thead>
        <tbody>${rows || ''}</tbody>
      </table>
    `;
  };
  $('#calcPlan').onclick = async () => {
    const date = $('#planDate').value;
    if (!date) return;
    $('#calcWrap').innerHTML = 'Berechne…';
    const { data } = await j('/api/plan/calc', {
      method: 'POST',
      body: JSON.stringify({ date })
    });
    const lines = data.lines.map(l => html`
      <tr class="border-t">
        <td class="px-2 py-1 font-mono">${l.material_code}</td>
        <td class="px-2 py-1">${l.material_name}</td>
        <td class="px-2 py-1 text-right">${l.qty}</td>
        <td class="px-2 py-1">${l.unit}</td>
        <td class="px-2 py-1 text-right">${l.price_per_unit.toFixed(6)}</td>
        <td class="px-2 py-1 text-right">${l.cost.toFixed(2)} €</td>
      </tr>
    `).join('');
    $('#calcWrap').innerHTML = html`
      <div class="mt-4 rounded border bg-white overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-slate-50">
            <tr>
              <th class="px-2 py-1 text-left">Code</th>
              <th class="px-2 py-1 text-left">Rohware</th>
              <th class="px-2 py-1 text-right">Menge</th>
              <th class="px-2 py-1 text-left">Einheit</th>
              <th class="px-2 py-1 text-right">€/Einheit</th>
              <th class="px-2 py-1 text-right">Kosten</th>
            </tr>
          </thead>
          <tbody>${lines || ''}</tbody>
          <tfoot class="bg-slate-50">
            <tr>
              <td colspan="5" class="px-2 py-2 text-right font-semibold">Gesamt</td>
              <td class="px-2 py-2 text-right font-semibold">${data.total_cost.toFixed(2)} €</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  };
}

async function renderTools() {
  $('#view').innerHTML = html`
    <section class="space-y-4">
      <h1 class="text-2xl font-bold">Tools</h1>
      <ul class="list-disc pl-5 text-slate-600">
        <li>Bulk-Preise unter „Rohwaren“</li>
        <li>Seed unter „Seed (Wizard)“</li>
      </ul>
    </section>
  `;
}

/* ---------- Init ---------- */
async function boot() {
  await ensureSession();
  // nav
  $$('.tab').forEach(b => {
    b.addEventListener('click', async () => {
      setActive(b.dataset.view);
      if (b.dataset.view === 'home') return renderHome();
      if (b.dataset.view === 'seed') return renderSeed();
      if (b.dataset.view === 'materials') return renderMaterials();
      if (b.dataset.view === 'items') return renderItems();
      if (b.dataset.view === 'plan') return renderPlan();
      if (b.dataset.view === 'tools') return renderTools();
    });
  });

  $('#logoutBtn').onclick = async () => {
    await j('/api/logout', { method: 'POST', body: '{}' });
    location.href = '/';
  };

  setActive('home');
  renderHome();
}

boot().catch(e => {
  $('#view').innerHTML = `<div class="text-red-600">Fehler beim Starten: ${e.message}</div>`;
});
