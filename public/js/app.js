// public/js/app.js
// Minimal helpers for all pages

const $$ = (sel, root = document) => root.querySelector(sel);

const toast = (msg, ok = true) => {
  const t = document.createElement('div');
  t.className = 'toast show';
  t.style.borderColor = ok ? '#285a3a' : '#6b1f22';
  t.style.background = ok ? '#102018' : '#1e1112';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
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
