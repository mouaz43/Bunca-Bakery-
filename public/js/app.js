// Bakeflow Creative UI Core — helpers, API, drawer, toast, palette, cmd bar
const $$  = (sel, root=document) => root.querySelector(sel);
const $$$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

/* ---------- Toast ---------- */
function toast(msg){
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity=.0; t.style.transform='translate(-50%, 6px)'; }, 2000);
  setTimeout(()=> t.remove(), 2500);
}

/* ---------- API ---------- */
async function api(path, opts={}){
  const res = await fetch(path, { headers:{'Content-Type':'application/json'}, credentials:'same-origin', ...opts });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok || json.ok === false) throw new Error(json.error || `request_failed_${res.status}`);
  return json;
}
async function sessionInfo(){ try { return (await api('/api/session')).user; } catch { return null; } }

/* ---------- Sortable ---------- */
function makeTableSortable(table){
  if (!table || !table.tHead) return;
  const ths = Array.from(table.tHead.querySelectorAll('th'));
  ths.forEach((th, idx)=>{
    th.classList.add('th-sort');
    th.addEventListener('click', ()=>{
      const tbody = table.tBodies[0];
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const dir = th.classList.contains('asc') ? 'desc' : 'asc';
      ths.forEach(x=>x.classList.remove('asc','desc')); th.classList.add(dir);
      rows.sort((a,b)=>{
        const A = (a.children[idx]?.textContent || '').trim();
        const B = (b.children[idx]?.textContent || '').trim();
        const nA = Number(A.replace(',','.')); const nB = Number(B.replace(',','.'));
        if (!isNaN(nA) && !isNaN(nB)) return dir==='asc' ? nA-nB : nB-nA;
        return dir==='asc' ? A.localeCompare(B) : B.localeCompare(A);
      });
      rows.forEach(r=>tbody.appendChild(r));
    });
  });
}

/* ---------- Filter ---------- */
function attachClientFilter(inputEl, table){
  if (!inputEl || !table) return;
  inputEl.addEventListener('input', ()=>{
    const q = inputEl.value.trim().toLowerCase();
    $$$('tbody tr', table).forEach(tr=>{
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

/* ---------- Drawer ---------- */
const Drawer = {
  el: null,
  open(id){ this.el = $$(id); if (this.el) this.el.classList.add('open'); },
  close(){ if (this.el) this.el.classList.remove('open'); },
}

/* ---------- Command Palette (shell) ---------- */
(function initCmd(){
  window.addEventListener('keydown', (e)=>{
    const mac = navigator.platform.toUpperCase().includes('MAC');
    if ((mac && e.metaKey && e.key.toLowerCase()==='k') || (!mac && e.ctrlKey && e.key.toLowerCase()==='k')){
      e.preventDefault();
      const dd = document.createElement('div');
      dd.className='dropdown'; dd.style.left='50%'; dd.style.top='70px'; dd.style.transform='translateX(-50%)';
      dd.innerHTML = `
        <div class="dropdown-item" data-href="/materials.html">Rohwaren öffnen (G)</div>
        <div class="dropdown-item" data-href="/items.html">Rezepte öffnen (R)</div>
        <div class="dropdown-item" data-href="/plan.html">Plan öffnen (P)</div>
        <div class="dropdown-item" data-logout>Logout</div>
      `;
      document.body.appendChild(dd);
      const kill = ()=> dd.remove();
      $$$('.dropdown-item', dd).forEach(el=>{
        el.addEventListener('click', ()=>{
          if (el.dataset.logout){ api('/api/logout',{method:'POST'}).then(()=>location.href='/login.html'); }
          else location.href = el.dataset.href;
          kill();
        });
      });
      setTimeout(()=>{ window.addEventListener('click', kill, { once:true }); }, 0);
    }
  });
})();

/* ---------- Theme / Accent (simple) ---------- */
(function initTheme(){
  const saved = localStorage.getItem('accent'); if (saved){ document.documentElement.style.setProperty('--accent', saved); }
  window.setAccent = (hex)=>{ document.documentElement.style.setProperty('--accent', hex); localStorage.setItem('accent', hex); }
})();

/* ---------- Exports for pages ---------- */
window.$$ = $$; window.$$$ = $$$;
window.toast = toast; window.api = api; window.sessionInfo = sessionInfo;
window.makeTableSortable = makeTableSortable; window.attachClientFilter = attachClientFilter;
window.Drawer = Drawer;
