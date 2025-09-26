// BUNCA UI core — theme, accent, density, toast, API, nav, sorting, palette

const $$ = (sel, root = document) => root.querySelector(sel);
const $$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- Toast ---------- */
const toast = (msg) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, 2200);
  setTimeout(() => t.remove(), 2600);
};

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok || json.ok === false) throw new Error(json.error || `request_failed_${res.status}`);
  return json;
}
async function sessionInfo() { try { return (await api('/api/session')).user; } catch { return null; } }
function navActive(id) { const el = document.querySelector(`[data-tab="${id}"]`); if (el) el.classList.add('active'); }

/* ---------- Theme / Accent / Density ---------- */
(function initTheme(){
  const savedTheme = localStorage.getItem('theme') || 'dark';
  const savedAccent = localStorage.getItem('accent') || '#6aa6ff';
  const savedDensity = localStorage.getItem('density') || 'comfy';
  if (savedTheme === 'light') document.documentElement.classList.add('light');
  if (savedDensity === 'compact') document.documentElement.classList.add('compact');
  document.documentElement.style.setProperty('--accent', savedAccent);
  document.documentElement.style.setProperty('--accent-2', savedAccent);

  window.toggleTheme = () => {
    const isLight = document.documentElement.classList.toggle('light');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
  };
  window.toggleDensity = () => {
    const isCompact = document.documentElement.classList.toggle('compact');
    localStorage.setItem('density', isCompact ? 'compact' : 'comfy');
  };
  window.changeAccent = (hex) => {
    document.documentElement.style.setProperty('--accent', hex);
    document.documentElement.style.setProperty('--accent-2', hex);
    localStorage.setItem('accent', hex);
  };
})();

/* ---------- Sortable tables ---------- */
function makeTableSortable(table) {
  if (!table) return;
  const ths = table.tHead ? Array.from(table.tHead.querySelectorAll('th')) : [];
  ths.forEach((th, idx) => {
    th.classList.add('th-sort');
    th.addEventListener('click', () => {
      const tbody = table.tBodies[0];
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const current = th.classList.contains('asc') ? 'asc' : th.classList.contains('desc') ? 'desc' : null;
      ths.forEach(x => x.classList.remove('asc','desc'));
      const dir = current === 'asc' ? 'desc' : 'asc';
      th.classList.add(dir);
      rows.sort((a,b)=>{
        const A = (a.children[idx]?.textContent || a.children[idx]?.querySelector('input')?.value || '').trim();
        const B = (b.children[idx]?.textContent || b.children[idx]?.querySelector('input')?.value || '').trim();
        const nA = Number(A.replace(',','.')); const nB = Number(B.replace(',','.'));
        if (!Number.isNaN(nA) && !Number.isNaN(nB)) return dir==='asc' ? nA - nB : nB - nA;
        return dir==='asc' ? A.localeCompare(B) : B.localeCompare(A);
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
}

/* ---------- Client search (simple contains filter) ---------- */
function attachClientFilter(inputEl, table) {
  if (!inputEl || !table) return;
  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim().toLowerCase();
    $$$('tbody tr', table).forEach(tr => {
      const hit = tr.textContent.toLowerCase().includes(q);
      tr.style.display = hit ? '' : 'none';
    });
  });
}

/* ---------- Command palette (Ctrl/Cmd+K) ---------- */
(function initKbar(){
  const wrapper = document.createElement('div');
  wrapper.className = 'kbar';
  wrapper.innerHTML = `
    <div class="panel">
      <input id="kbarInput" class="input" placeholder="Suchen oder Aktion… (z.B. plan, import, logout)" />
      <div class="list" id="kbarList"></div>
    </div>`;
  document.body.appendChild(wrapper);

  const items = [
    { label: 'Dashboard', action: () => location.href='/dashboard.html' },
    { label: 'Rohwaren', action: () => location.href='/materials.html' },
    { label: 'Rezepte', action: () => location.href='/items.html' },
    { label: 'Produktionsplan', action: () => location.href='/plan.html' },
    { label: 'Tools', action: () => location.href='/tools.html' },
    { label: 'Logout', action: async () => { await api('/api/logout', { method:'POST' }); location.href='/login.html'; } },
  ];

  const list = $$('#kbarList', wrapper);
  const input = $$('#kbarInput', wrapper);
  function render(q='') {
    const s = q.toLowerCase();
    const filtered = items.filter(i => i.label.toLowerCase().includes(s));
    list.innerHTML = filtered.map((i,idx)=>`<div class="item ${idx===0?'active':''}" data-idx="${idx}">${i.label}</div>`).join('');
    $$$('.item', list).forEach((el, i) => el.onclick = () => { filtered[i].action(); close(); });
  }
  function open() { wrapper.style.display='flex'; input.value=''; render(); setTimeout(()=>input.focus(),0); }
  function close() { wrapper.style.display='none'; }

  input.addEventListener('input', (e)=>render(e.target.value));
  input.addEventListener('keydown', (e)=>{
    const itemsEls = $$$('.item', list);
    let idx = itemsEls.findIndex(x=>x.classList.contains('active'));
    if (e.key === 'ArrowDown') { e.preventDefault(); itemsEls[idx]?.classList.remove('active'); idx = Math.min(itemsEls.length-1, idx+1); itemsEls[idx]?.classList.add('active'); }
    if (e.key === 'ArrowUp') { e.preventDefault(); itemsEls[idx]?.classList.remove('active'); idx = Math.max(0, idx-1); itemsEls[idx]?.classList.add('active'); }
    if (e.key === 'Enter') { e.preventDefault(); const active = itemsEls[idx]; if (active) items[Array.from(list.children).indexOf(active)].action(); close(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  window.addEventListener('keydown', (e)=>{
    const mac = navigator.platform.toUpperCase().includes('MAC');
    if ((mac && e.metaKey && e.key.toLowerCase() === 'k') || (!mac && e.ctrlKey && e.key.toLowerCase() === 'k')) {
      e.preventDefault(); open();
    }
  });
})();
