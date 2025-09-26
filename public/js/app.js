// public/js/app.js — core UI + single-button header with menu
// ─ helpers ─
window.$$  = (sel, root=document) => root.querySelector(sel);
window.$$$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

window.toast = (msg) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, 2200);
  setTimeout(() => t.remove(), 2600);
};

window.api = async (path, opts = {}) => {
  const res = await fetch(path, { headers:{'Content-Type':'application/json'}, ...opts });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok || json.ok === false) throw new Error(json.error || `request_failed_${res.status}`);
  return json;
};
window.sessionInfo = async () => { try { return (await api('/api/session')).user; } catch { return null; } };

// ─ theme / accent / density ─
(function() {
  const savedTheme   = localStorage.getItem('theme')   || 'dark';
  const savedAccent  = localStorage.getItem('accent')  || '#6aa6ff';
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

// ─ sortable tables & filter (unchanged) ─
window.makeTableSortable = (table) => {
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
};
window.attachClientFilter = (inputEl, table) => {
  if (!inputEl || !table) return;
  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim().toLowerCase();
    $$$('tbody tr', table).forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  });
};

// ─ brand & header renderer ─
const BRAND = 'Bakeflow'; // <— change this name anytime

window.renderHeader = async function renderHeader() {
  const wrap = document.getElementById('appHeader');
  if (!wrap) return;
  const user = await sessionInfo();
  const active = document.body.dataset.active || '';

  wrap.innerHTML = `
    <header class="header">
      <nav class="nav">
        <div class="brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 12c0-4.418 3.582-8 8-8a8 8 0 1 1-8 8Z" stroke="currentColor" opacity=".8"/>
            <path d="M12 4v16M4 12h16" stroke="currentColor" opacity=".6"/>
          </svg>
          <span>${BRAND}</span>
        </div>

        <button id="menuBtn" class="btn ghost menu-trigger">
          ☰ Menu
        </button>

        <div id="menuPanel" class="menu-panel" hidden>
          <div class="menu-sec">
            <a class="menu-item ${active==='dash'?'active':''}" href="/dashboard.html">Übersicht</a>
            <a class="menu-item ${active==='materials'?'active':''}" href="/materials.html">Rohwaren</a>
            <a class="menu-item ${active==='items'?'active':''}" href="/items.html">Rezepte</a>
            <a class="menu-item ${active==='plan'?'active':''}" href="/plan.html">Produktionsplan</a>
            <a class="menu-item ${active==='tools'?'active':''}" href="/tools.html">Tools</a>
          </div>
          <div class="menu-sec row" style="align-items:center">
            <span style="font-size:12px;color:var(--muted);margin-right:8px">Theme</span>
            <button class="btn" onclick="toggleTheme()">🌓</button>
            <button class="btn" onclick="toggleDensity()">↕︎ Dichte</button>
            <label class="accent" style="margin-left:auto">
              <div class="dot"></div>
              <input id="accentPicker" type="color" style="background:transparent;border:none;width:20px;height:20px;padding:0"/>
            </label>
          </div>
          <div class="menu-sec row" style="justify-content:space-between">
            <div class="muted" style="font-size:12px">${user ? user.email : 'Nicht angemeldet'}</div>
            ${user ? `<button id="logoutBtn" class="btn">Logout</button>` : `<a class="btn" href="/login.html">Login</a>`}
          </div>
        </div>
      </nav>
    </header>
  `;

  // menu interactions
  const panel = $$('#menuPanel', wrap);
  const btn   = $$('#menuBtn', wrap);
  const color = $$('#accentPicker', wrap);
  btn.addEventListener('click', () => {
    const open = panel.hasAttribute('hidden');
    $$$('.menu-panel').forEach(p => p.setAttribute('hidden','')); // close others
    if (open) panel.removeAttribute('hidden'); else panel.setAttribute('hidden','');
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) panel.setAttribute('hidden','');
  });
  color?.addEventListener('input', (e) => changeAccent(e.target.value));

  // logout
  $$('#logoutBtn', wrap)?.addEventListener('click', async () => {
    await api('/api/logout', { method:'POST' });
    location.href = '/login.html';
  });
};

// ─ command palette (kept; opens with ⌘K / Ctrl+K) ─
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
    { label: 'Übersicht',       action: () => location.href='/dashboard.html' },
    { label: 'Rohwaren',        action: () => location.href='/materials.html' },
    { label: 'Rezepte',         action: () => location.href='/items.html' },
    { label: 'Produktionsplan', action: () => location.href='/plan.html' },
    { label: 'Tools',           action: () => location.href='/tools.html' },
    { label: 'Logout',          action: async () => { await api('/api/logout', { method:'POST' }); location.href='/login.html'; } },
  ];

  const list  = $$('#kbarList', wrapper);
  const input = $$('#kbarInput', wrapper);
  function render(q='') {
    const s = q.toLowerCase();
    const filtered = items.filter(i => i.label.toLowerCase().includes(s));
    list.innerHTML = filtered.map((i,idx)=>`<div class="item ${idx===0?'active':''}" data-idx="${idx}">${i.label}</div>`).join('');
    $$$('.item', list).forEach((el, i) => el.onclick = () => { filtered[i].action(); close(); });
  }
  function open() { wrapper.style.display='flex'; input.value=''; render(); setTimeout(()=>input.focus(),0); }
  function close(){ wrapper.style.display='none'; }

  input.addEventListener('input', (e)=>render(e.target.value));
  input.addEventListener('keydown', (e)=>{
    const itemsEls = $$$('.item', list);
    let idx = itemsEls.findIndex(x=>x.classList.contains('active'));
    if (e.key === 'ArrowDown') { e.preventDefault(); itemsEls[idx]?.classList.remove('active'); idx = Math.min(itemsEls.length-1, idx+1); itemsEls[idx]?.classList.add('active'); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); itemsEls[idx]?.classList.remove('active'); idx = Math.max(0, idx-1);  itemsEls[idx]?.classList.add('active'); }
    if (e.key === 'Enter')     { e.preventDefault(); itemsEls[idx]?.click(); }
    if (e.key === 'Escape')    { e.preventDefault(); close(); }
  });

  window.addEventListener('keydown', (e)=>{
    const mac = navigator.platform.toUpperCase().includes('MAC');
    if ((mac && e.metaKey && e.key.toLowerCase()==='k') || (!mac && e.ctrlKey && e.key.toLowerCase()==='k')) {
      e.preventDefault(); open();
    }
  });
})();

// auto-render header if placeholder exists
window.addEventListener('DOMContentLoaded', () => { window.renderHeader?.(); });
