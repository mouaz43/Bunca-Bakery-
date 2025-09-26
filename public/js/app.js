// BUNCA/Bakeflow UI core — one place for shared UX pieces
// - $$ helpers
// - toast()
// - api() wrapper with JSON + error handling
// - sessionInfo()
// - theme / accent / density
// - Drawer (open/close/lock scroll)
// - Sortable tables
// - Command palette (Cmd/Ctrl+K)
// - Small utilities (navActive, attachClientFilter)

/* ---------- DOM helpers ---------- */
window.$$  = (sel, root = document) => root.querySelector(sel);
window.$$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- Toast ---------- */
window.toast = (msg) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(()=>{
    t.style.opacity = '1';
    t.style.transform = 'translateY(0)';
  });
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, 2200);
  setTimeout(() => t.remove(), 2600);
};

/* ---------- API ---------- */
window.api = async function(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `request_failed_${res.status}`);
    err.status = res.status; throw err;
  }
  return json;
};
window.sessionInfo = async () => {
  try { const r = await api('/api/session'); return r.user; } catch { return null; }
};
window.navActive = (id) => { const el = document.querySelector(`[data-tab="${id}"]`); if (el) el.classList.add('active'); };

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
  // Also expose an alias some pages used:
  window.setAccent = window.changeAccent;
})();

/* ---------- Drawer (off-canvas) ---------- */
(function initDrawer(){
  let lastScroll = 0;
  function lockScroll() {
    lastScroll = window.scrollY || 0;
    document.body.style.top = `-${lastScroll}px`;
    document.body.classList.add('no-scroll');
  }
  function unlockScroll() {
    document.body.classList.remove('no-scroll');
    document.body.style.top = '';
    window.scrollTo(0, lastScroll);
  }
  function open(sel) {
    const el = $$(sel);
    if (!el) return;
    $$$('.drawer').forEach(d => d.classList.remove('open'));
    el.classList.add('open'); lockScroll();
  }
  function close() {
    $$$('.drawer').forEach(d => d.classList.remove('open'));
    unlockScroll();
  }
  window.Drawer = { open, close };
  // Close on clicking outside content if backdrop is clicked
  document.addEventListener('click', (e)=>{
    const d = e.target.closest('.drawer');
    if (d && e.target === d) Drawer.close();
  });
})();

/* ---------- Sortable tables ---------- */
window.makeTableSortable = function(table) {
  if (!table || !table.tHead) return;
  const ths = Array.from(table.tHead.querySelectorAll('th'));
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
        const get = (row) => {
          const cell = row.children[idx];
          if (!cell) return '';
          const inp = cell.querySelector('input, select');
          return (inp ? inp.value : cell.textContent).trim();
        };
        const A = get(a), B = get(b);
        const nA = Number(A.replace(',','.')); const nB = Number(B.replace(',','.'));
        if (!Number.isNaN(nA) && !Number.isNaN(nB)) return dir==='asc' ? nA - nB : nB - nA;
        return dir==='asc' ? A.localeCompare(B) : B.localeCompare(A);
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
};

/* ---------- Client filter ---------- */
window.attachClientFilter = function(inputEl, table) {
  if (!inputEl || !table) return;
  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim().toLowerCase();
    $$$('tbody tr', table).forEach(tr => {
      const hit = tr.textContent.toLowerCase().includes(q);
      tr.style.display = hit ? '' : 'none';
    });
  });
};

/* ---------- Command palette (Ctrl/Cmd+K) ---------- */
(function initKbar(){
  // Only inject once
  if (document.body.dataset.kbarInit) return;
  document.body.dataset.kbarInit = '1';

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
    { label: 'Produktion', action: () => location.href='/plan.html' },
    { label: 'Data Studio', action: () => location.href='/tools.html' },
    { label: 'Einstellungen', action: () => location.href='/settings.html' },
    { label: 'Drucken', action: () => location.href='/print.html' },
    { label: 'Diagnose', action: () => location.href='/health.html' },
    { label: 'Login', action: () => location.href='/login.html' },
    { label: 'Logout', action: async () => { try{ await api('/api/logout', { method:'POST' }); }catch{} location.href='/login.html'; } },
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
    if (e.key === 'Enter') { e.preventDefault(); const active = itemsEls[idx]; if (active) { const i = Array.from(list.children).indexOf(active); const filtered = Array.from(list.children).map(el=>el.textContent); const label = filtered[i]; const item = items.find(it=>it.label===label); item?.action(); close(); } }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  window.addEventListener('keydown', (e)=>{
    const mac = navigator.platform.toUpperCase().includes('MAC');
    if ((mac && e.metaKey && e.key.toLowerCase() === 'k') || (!mac && e.ctrlKey && e.key.toLowerCase() === 'k')) {
      e.preventDefault(); open();
    }
  });
})();
