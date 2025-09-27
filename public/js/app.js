// Bunca Bakeryflow — Frontend helpers

class BakeryApp {
  async api(endpoint, options = {}) {
    const cfg = {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (options.body) cfg.body = JSON.stringify(options.body);
    const res = await fetch(endpoint, cfg);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async login(email, password) {
    const r = await this.api('/api/login', { method: 'POST', body: { email, password } });
    this.user = r.user;
    window.location.href = '/materials.html';
  }

  async logout() {
    await this.api('/api/logout', { method: 'POST' });
    this.user = null;
    window.location.href = '/login.html';
  }
}

const app = new BakeryApp();
window.api = (...a) => app.api(...a);
window.logout = () => app.logout();
