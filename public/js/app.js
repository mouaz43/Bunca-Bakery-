// public/js/app.js
// Shared helpers + theme toggle

const $$ = (sel, root = document) => root.querySelector(sel);

const toast = (msg, ok = true) => {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, 2200);
  setTimeout(() => t.remove(), 2600);
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `request_failed_${res.status}`);
  }
  return json;
}

async function sessionInfo() {
  try { return (await api('/api/session')).user; }
  catch { return null; }
}

function navActive(id) {
  const el = document.querySelector(`[data-tab="${id}"]`);
  if (el) el.classList.add('active');
}

/* ---------- Theme ---------- */
(function themeInit(){
  const saved = localStorage.getItem('theme') || 'dark';
  if (saved === 'light') document.documentElement.classList.add('light');
  window.toggleTheme = () => {
    const isLight = document.documentElement.classList.toggle('light');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
  };
})();
