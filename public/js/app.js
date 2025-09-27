// Bunca Bakeryflow — Frontend helpers (bright, no emojis)
// Exposes: app.api, app.login, app.logout, sessionInfo(), api(), toast(), showModal(), logout()

class BakeryflowApp {
  constructor() {
    // simple listeners for network status
    window.addEventListener('online',  () => this.showToast('Verbindung wiederhergestellt', 'success'));
    window.addEventListener('offline', () => this.showToast('Keine Internetverbindung', 'warning'));
  }

  /* ---------------- API ---------------- */
  async api(endpoint, options = {}) {
    const cfg = {
      method: options.method || 'GET',
      headers: { ...(options.headers || {}) },
      body: options.body
    };

    // If body is a plain object, send JSON
    if (cfg.body && typeof cfg.body === 'object' && !(cfg.body instanceof FormData)) {
      cfg.headers['Content-Type'] = 'application/json';
      cfg.body = JSON.stringify(cfg.body);
    }

    const res = await fetch(endpoint, cfg);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  /* ---------------- Auth ---------------- */
  async login(email, password) {
    const r = await this.api('/api/login', { method: 'POST', body: { email, password } });
    this.user = r.user;
    this.showToast('Login erfolgreich', 'success');
    // important: we removed dashboard, go to materials
    setTimeout(() => { window.location.href = '/materials.html'; }, 500);
    return r;
  }

  async logout() {
    try { await this.api('/api/logout', { method: 'POST' }); } catch {}
    this.user = null;
    this.showToast('Abgemeldet', 'info');
    setTimeout(() => { window.location.href = '/login.html'; }, 400);
  }

  /* ---------------- UI: Toast ---------------- */
  showToast(message, type = 'info', duration = 4000) {
    if (!document.getElementById('bf-toast-styles')) {
      const s = document.createElement('style');
      s.id = 'bf-toast-styles';
      s.textContent = `
        .bf-toast{position:fixed;top:20px;right:20px;min-width:280px;max-width:420px;background:#ffffff;border:1px solid #e6e8ef;border-radius:12px;box-shadow:0 10px 30px rgba(16,24,40,.15);z-index:9999;overflow:hidden}
        .bf-toast .row{display:flex;gap:10px;align-items:center;padding:12px 14px}
        .bf-toast .dot{width:10px;height:10px;border-radius:50%}
        .bf-toast.info .dot{background:#2563eb}
        .bf-toast.success .dot{background:#16a34a}
        .bf-toast.warning .dot{background:#f59e0b}
        .bf-toast.error .dot{background:#dc2626}
        .bf-toast .msg{font-size:14px;color:#0b1220}
        .bf-toast .close{margin-left:auto;border:0;background:transparent;cursor:pointer;color:#5b6474}
        @keyframes slideIn{from{transform:translateY(-8px);opacity:0}to{transform:translateY(0);opacity:1}}
        .bf-toast{animation:slideIn .18s ease}
      `;
      document.head.appendChild(s);
    }
    const el = document.createElement('div');
    el.className = `bf-toast ${type}`;
    el.innerHTML = `<div class="row"><span class="dot"></span><div class="msg">${this.escape(message)}</div><button class="close" aria-label="Schließen">×</button></div>`;
    el.querySelector('.close').onclick = () => el.remove();
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  /* ---------------- UI: Modal ---------------- */
  showModal(title, contentHTML, actions = []) {
    if (!document.getElementById('bf-modal-styles')) {
      const s = document.createElement('style');
      s.id = 'bf-modal-styles';
      s.textContent = `
        .bf-modal-wrap{position:fixed;inset:0;background:rgba(0,0,0,.24);display:flex;align-items:center;justify-content:center;z-index:9998}
        .bf-modal{width:min(680px,92vw);background:#fff;border:1px solid #e6e8ef;border-radius:16px;box-shadow:0 16px 48px rgba(16,24,40,.18);overflow:hidden}
        .bf-modal .head{padding:14px 16px;border-bottom:1px solid #e6e8ef;font-weight:800}
        .bf-modal .body{padding:14px 16px}
        .bf-modal .foot{padding:12px 16px;border-top:1px solid #e6e8ef;display:flex;justify-content:flex-end;gap:8px}
        .bf-btn{padding:9px 12px;border-radius:10px;border:1px solid #e6e8ef;background:#fff;cursor:pointer}
        .bf-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
      `;
      document.head.appendChild(s);
    }
    const wrap = document.createElement('div');
    wrap.className = 'bf-modal-wrap';
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });

    const modal = document.createElement('div');
    modal.className = 'bf-modal';
    modal.innerHTML = `
      <div class="head">${this.escape(title)}</div>
      <div class="body">${contentHTML}</div>
      <div class="foot"></div>
    `;
    const foot = modal.querySelector('.foot');
    actions.forEach(a => {
      const b = document.createElement('button');
      b.className = 'bf-btn' + (a.class ? ' ' + a.class : '');
      b.textContent = a.text;
      b.onclick = () => a.onClick?.(wrap);
      foot.appendChild(b);
    });
    wrap.appendChild(modal);
    document.body.appendChild(wrap);
    return wrap;
  }

  /* ---------------- Utils ---------------- */
  escape(s) { return String(s ?? '').replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }
}

/* ====== Initialize & expose helpers ====== */
const app = new BakeryflowApp();
window.api = (endpoint, options = {}) => app.api(endpoint, options);
window.sessionInfo = async () => { try { const r = await app.api('/api/session'); return r.user; } catch { return null; } };
window.toast = (msg, type='info') => app.showToast(msg, type);
window.showModal = (...a) => app.showModal(...a);
window.logout = () => app.logout();
