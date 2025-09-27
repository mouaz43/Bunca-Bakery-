// UI core + brand/menu for BUNCA Bakeflow

window.$$  = (sel, root = document) => root.querySelector(sel);
window.$$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- Toast ---------- */
window.toast = (msg) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(()=>{ t.style.opacity='1'; t.style.transform='translateY(0)'; });
  setTimeout(()=>{ t.style.opacity='0'; t.style.transform='translateY(6px)'; }, 2200);
  setTimeout(()=> t.remove(), 2600);
};

/* ---------- API ---------- */
window.api = async function(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok || json.ok === false) { const err = new Error(json.error || `request_failed_${res.status}`); err.status=res.status; throw err; }
  return json;
};
window.sessionInfo = async ()=> { try { return (await api('/api/session')).user; } catch { return null; } };

/* ---------- Theme/Accent/Density ---------- */
(function initTheme(){
  const theme = localStorage.getItem('theme') || 'dark';
  const accent = localStorage.getItem('accent') || '#6aa6ff';
  const dens = localStorage.getItem('density') || 'comfy';
  if (theme === 'light') document.documentElement.classList.add('light');
  if (dens  === 'compact') document.documentElement.classList.add('compact');
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-2', accent);
  window.toggleTheme   = ()=>{ const v=document.documentElement.classList.toggle('light'); localStorage.setItem('theme', v?'light':'dark'); };
  window.toggleDensity = ()=>{ const v=document.documentElement.classList.toggle('compact'); localStorage.setItem('density', v?'compact':'comfy'); };
  window.changeAccent  = (hex)=>{ document.documentElement.style.setProperty('--accent', hex); document.documentElement.style.setProperty('--accent-2', hex); localStorage.setItem('accent', hex); };
})();

/* ---------- Elegant single menu ---------- */
(function mountMenu(){
  const nav = $$('.nav'); if (!nav) return;
  // Brand left
  const brand = $$('.brand', nav);
  if (brand) brand.innerHTML = '🍞 <b>BUNCA</b> Bakeflow';

  // Replace .menu-wrap with a single dropdown
  let wrap = $$('.menu-wrap', nav);
  if (!wrap) { wrap = document.createElement('div'); wrap.className='menu-wrap'; nav.appendChild(wrap); }
  wrap.innerHTML = `
    <div class="menu-root">
      <button class="btn" id="menuBtn">Menu ▾</button>
      <div class="menu-pop">
        <a href="/dashboard.html">Übersicht</a>
        <a href="/materials.html">Rohwaren</a>
        <a href="/items.html">Rezepte</a>
        <a href="/plan.html">Produktion</a>
        <a href="/tools.html">Data Studio</a>
        <a href="/settings.html">Einstellungen</a>
        <a href="/print.html">Druckansicht</a>
        <hr/>
        <a href="#" id="menuLogout">Logout</a>
      </div>
    </div>`;
  const btn = $$('#menuBtn', wrap);
  const pop = $$('.menu-pop', wrap);

  btn.addEventListener('click', (e)=>{ e.stopPropagation(); pop.classList.toggle('open'); });
  document.addEventListener('click', ()=> pop.classList.remove('open'));
  $$('#menuLogout', wrap).onclick = async (e)=>{ e.preventDefault(); try{ await api('/api/logout',{method:'POST'});}catch{} location.href='/login.html'; };

  // minimal styles (works with your styles.css)
  const style = document.createElement('style');
  style.textContent = `
    .menu-root{ position:relative }
    .menu-pop{
      position:absolute; right:0; top:100%;
      display:none; min-width:200px; padding:8px;
      border:1px solid var(--border); border-radius:12px;
      background:var(--card); box-shadow:var(--shadow); z-index:40
    }
    .menu-pop.open{ display:block }
    .menu-pop a{ display:block; padding:8px 10px; border-radius:8px; text-decoration:none; color:var(--text) }
    .menu-pop a:hover{ background:rgba(255,255,255,.06) }
    .menu-pop hr{ border:none; border-top:1px solid var(--border); margin:6px 0 }
  `;
  document.head.appendChild(style);
})();

/* ---------- Drawer ---------- */
(function(){
  let lastScroll = 0;
  function lock(){ lastScroll = window.scrollY||0; document.body.style.top=`-${lastScroll}px`; document.body.classList.add('no-scroll'); }
  function unlock(){ document.body.classList.remove('no-scroll'); document.body.style.top=''; window.scrollTo(0,lastScroll); }
  function open(sel){ const el=$$(sel); if(!el) return; $$$('.drawer').forEach(d=>d.classList.remove('open')); el.classList.add('open'); lock(); }
  function close(){ $$$('.drawer').forEach(d=>d.classList.remove('open')); unlock(); }
  window.Drawer = { open, close };
  document.addEventListener('click', (e)=>{ const d=e.target.closest('.drawer'); if(d && e.target===d) close(); });
})();

/* ---------- Utilities ---------- */
window.makeTableSortable = function(table){ if(!table||!table.tHead) return;
  const ths=Array.from(table.tHead.querySelectorAll('th'));
  ths.forEach((th,idx)=>{
    th.classList.add('th-sort');
    th.addEventListener('click', ()=>{
      const tb=table.tBodies[0]; const rows=Array.from(tb.querySelectorAll('tr'));
      const cur = th.classList.contains('asc') ? 'asc' : th.classList.contains('desc') ? 'desc' : null;
      ths.forEach(x=>x.classList.remove('asc','desc'));
      const dir = cur==='asc'?'desc':'asc'; th.classList.add(dir);
      rows.sort((a,b)=>{
        const read = (r)=>{ const c=r.children[idx]; if(!c) return ''; const inp=c.querySelector('input,select'); return (inp?inp.value:c.textContent).trim(); };
        const A=read(a), B=read(b); const nA=Number(A.replace(',','.')), nB=Number(B.replace(',','.'));
        if(!Number.isNaN(nA)&&!Number.isNaN(nB)) return dir==='asc'? nA-nB : nB-nA;
        return dir==='asc'? A.localeCompare(B) : B.localeCompare(A);
      });
      rows.forEach(r=>tb.appendChild(r));
    });
  });
};
window.attachClientFilter = (input, table)=>{ if(!input||!table) return;
  input.addEventListener('input', ()=>{ const q=input.value.toLowerCase().trim();
    $$$('tbody tr', table).forEach(tr=> tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none');
  });
};
