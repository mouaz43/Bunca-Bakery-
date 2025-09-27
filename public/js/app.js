/* =========================================================
   Bunca Bakery – Frontend App (no emojis)
   One-flow: Rohwaren → Rezepte → Produktionsplan
   - Clean API wrapper
   - Router + Views registry
   - Toasts/Modals (no emojis)
   - Import helpers
   - Live calculations: product → recipe → plan
   ========================================================= */

class BuncaBakeryApp {
  constructor() {
    // --- Auth / session ---
    this.user = null;

    // --- UI helpers ---
    this.notifications = [];
    this.cache = new Map();
    this.autoRefresh = true;
    this.refreshInterval = null;

    // --- In-memory state (synced with API) ---
    this.state = {
      products: [],   // Rohwaren
      recipes: [],    // Rezepte (each has ingredients referencing products)
      plan: [],       // Produktionsplan (date, recipeId, quantity)
    };

    // --- Router ---
    this.views = new Map(); // {name -> {mount, refresh}}
    this.currentView = null;

    // Bootstrap
    this.init();
  }

  /* ======================= Init ======================= */

  async init() {
    try {
      await this.checkSession();
      this.registerViews();
      this.setupEventListeners();
      this.setupKeyboardShortcuts();
      await this.bootstrapData();
      this.routeTo(this.getInitialRoute());
      this.startAutoRefresh();
      console.log('Bunca Bakery App initialized');
    } catch (err) {
      console.error('Initialization failed:', err);
      this.showToast('Initialization failed. Check console for details.', 'error');
    }
  }

  async checkSession() {
    try {
      const r = await this.api('/api/session');
      this.user = r.user || null;
      if (!this.user && !location.pathname.includes('login')) {
        location.href = '/login.html';
      }
    } catch (err) {
      console.warn('Session check failed', err);
    }
  }

  async bootstrapData() {
    try {
      const [products, recipes, plan] = await Promise.all([
        this.api('/api/products').catch(() => []),
        this.api('/api/recipes').catch(() => []),
        this.api('/api/plan').catch(() => []),
      ]);
      this.state.products = products;
      this.state.recipes = recipes;
      this.state.plan = plan;

      // Precompute costs once
      this.recalculateAll();
    } catch (err) {
      console.warn('Bootstrap data failed:', err);
    }
  }

  /* ======================= Router ======================= */

  getInitialRoute() {
    const hash = location.hash.replace('#', '');
    return hash || 'dashboard';
  }

  registerViews() {
    // You can render into a single shell container: #app
    this.views.set('dashboard', {
      mount: () => this.renderDashboard(),
      refresh: () => this.renderDashboard()
    });

    this.views.set('rohwaren', {
      mount: () => this.renderRohwaren(),
      refresh: () => this.renderRohwaren()
    });

    this.views.set('rezepte', {
      mount: () => this.renderRezepte(),
      refresh: () => this.renderRezepte()
    });

    this.views.set('produktion', {
      mount: () => this.renderProduktion(),
      refresh: () => this.renderProduktion()
    });

    window.addEventListener('hashchange', () => {
      const route = location.hash.replace('#', '') || 'dashboard';
      this.routeTo(route);
    });
  }

  routeTo(name) {
    const view = this.views.get(name);
    const container = document.getElementById('app');
    if (!container) return console.error('#app container not found');
    container.innerHTML = '';
    if (!view) {
      container.innerHTML = `<div class="card"><h3>Not found</h3><p>Unknown route: ${name}</p></div>`;
      return;
    }
    this.currentView = name;
    view.mount();
    // Update active nav state (if you have a nav)
    document.querySelectorAll('[data-route]').forEach(a => {
      a.classList.toggle('active', a.getAttribute('data-route') === name);
    });
  }

  async refreshCurrentPage() {
    try {
      this.cache.clear();
      // pull fresh data and re-compute
      await this.bootstrapData();
      const view = this.views.get(this.currentView);
      if (view && typeof view.refresh === 'function') view.refresh();
      this.showRefreshIndicator();
    } catch (err) {
      console.error('Auto-refresh failed:', err);
    }
  }

  startAutoRefresh() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    if (!this.autoRefresh) return;
    this.refreshInterval = setInterval(() => this.refreshCurrentPage(), 30000);
  }

  stopAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /* ======================= API ======================= */

  async api(endpoint, options = {}) {
    const defaultOptions = {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    };
    const config = { ...defaultOptions, ...options };
    if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
      config.body = JSON.stringify(config.body);
    }

    const key = `${config.method}:${endpoint}`;
    try {
      const res = await fetch(endpoint, config);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json().catch(() => ({}));
      if (config.method === 'GET') this.cache.set(key, { data, ts: Date.now() });
      return data;
    } catch (err) {
      console.error(`API Error ${endpoint}:`, err);
      this.showToast(`API Error: ${err.message}`, 'error');
      throw err;
    }
  }

  /* ======================= Calculations ======================= */

  // Price lookup helper
  productPrice(productId) {
    const p = this.state.products.find(x => x.id === productId);
    return p ? Number(p.unitPrice || 0) : 0;
  }

  // Convert recipe.ingredients -> cost
  // ingredient: { productId, amount, unit } — assumes unit matches product’s pricing unit
  recipeCost(recipe) {
    if (!recipe || !Array.isArray(recipe.ingredients)) return 0;
    return recipe.ingredients.reduce((sum, ing) => {
      const unitPrice = this.productPrice(ing.productId);
      const amount = Number(ing.amount || 0);
      return sum + unitPrice * amount;
    }, 0);
  }

  // Cost map for recipes
  recalculateAll() {
    this.state.recipes = this.state.recipes.map(r => ({
      ...r,
      unitCost: this.round(this.recipeCost(r) / (Number(r.yield || 1) || 1), 4) // cost per piece
    }));

    // Also compute production plan totals
    this.state.planTotals = this.computePlanTotals();
  }

  computePlanTotals() {
    // Aggregates totals for each plan line and grand total
    const totals = this.state.plan.map(row => {
      const recipe = this.state.recipes.find(r => r.id === row.recipeId);
      const qty = Number(row.quantity || 0);
      const unitCost = recipe ? Number(recipe.unitCost || 0) : 0;
      return {
        ...row,
        recipeName: recipe ? recipe.name : 'Unbekannt',
        unitCost,
        lineCost: this.round(unitCost * qty, 2)
      };
    });
    const grand = this.round(totals.reduce((s, x) => s + x.lineCost, 0), 2);
    return { lines: totals, grand };
  }

  /* ======================= CRUD (sync with API) ======================= */

  // Products
  async saveProduct(product) {
    const isNew = !product.id;
    const url = isNew ? '/api/products' : `/api/products/${product.id}`;
    const method = isNew ? 'POST' : 'PUT';
    const saved = await this.api(url, { method, body: product });
    await this.bootstrapData();
    this.showToast('Product saved', 'success');
    return saved;
  }

  async deleteProduct(id) {
    await this.api(`/api/products/${id}`, { method: 'DELETE' });
    await this.bootstrapData();
    this.showToast('Product deleted', 'success');
  }

  // Recipes
  async saveRecipe(recipe) {
    const isNew = !recipe.id;
    const url = isNew ? '/api/recipes' : `/api/recipes/${recipe.id}`;
    const method = isNew ? 'POST' : 'PUT';
    const saved = await this.api(url, { method, body: recipe });
    await this.bootstrapData();
    this.showToast('Recipe saved', 'success');
    return saved;
  }

  async deleteRecipe(id) {
    await this.api(`/api/recipes/${id}`, { method: 'DELETE' });
    await this.bootstrapData();
    this.showToast('Recipe deleted', 'success');
  }

  // Production plan
  async savePlanRow(row) {
    const isNew = !row.id;
    const url = isNew ? '/api/plan' : `/api/plan/${row.id}`;
    const method = isNew ? 'POST' : 'PUT';
    const saved = await this.api(url, { method, body: row });
    await this.bootstrapData();
    this.showToast('Plan updated', 'success');
    return saved;
  }

  async deletePlanRow(id) {
    await this.api(`/api/plan/${id}`, { method: 'DELETE' });
    await this.bootstrapData();
    this.showToast('Plan row deleted', 'success');
  }

  /* ======================= UI: Toasts / Modals ======================= */

  showToast(message, type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <div class="toast-content">
        <span class="toast-badge ${type}"></span>
        <span class="toast-message">${message}</span>
        <button class="toast-close" aria-label="Close">×</button>
      </div>
    `;

    if (!document.querySelector('#toast-styles')) {
      const styles = document.createElement('style');
      styles.id = 'toast-styles';
      styles.textContent = `
        .toast{position:fixed;top:20px;right:20px;min-width:300px;background:var(--surface,#111);color:var(--text,#f5f5f5);border:1px solid var(--border,#2a2a2a);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:1080;animation:toast-in .2s ease}
        .toast-content{display:flex;align-items:center;gap:12px;padding:14px 16px}
        .toast-badge{width:10px;height:10px;border-radius:50%;display:inline-block}
        .toast-badge.info{background:#3b82f6}.toast-badge.success{background:#10b981}.toast-badge.warning{background:#f59e0b}.toast-badge.error{background:#ef4444}
        .toast-message{flex:1}
        .toast-close{background:none;border:0;color:inherit;cursor:pointer;font-size:18px;line-height:1}
        @keyframes toast-in{from{transform:translateX(12px);opacity:0}to{transform:translateX(0);opacity:1}}
      `;
      document.head.appendChild(styles);
    }

    toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  showModal(title, content, actions = []) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
          <button class="btn btn-ghost btn-icon" aria-label="Close">×</button>
        </div>
        <div class="modal-body">${content}</div>
        ${actions.length ? `
          <div class="modal-footer">
            ${actions.map(a => `<button class="btn ${a.class || 'btn-primary'}" data-action="${a.onclick || ''}">${a.text}</button>`).join('')}
          </div>` : ''
        }
      </div>
    `;
    if (!document.querySelector('#modal-styles')) {
      const styles = document.createElement('style');
      styles.id = 'modal-styles';
      styles.textContent = `
        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:1060}
        .modal{width:min(720px,92vw);background:#0f1115;border:1px solid #23262d;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.55);overflow:hidden}
        .modal-header{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid #23262d}
        .modal-title{margin:0;font-size:18px}
        .modal-body{padding:18px}
        .modal-footer{display:flex;justify-content:flex-end;gap:10px;padding:14px 18px;border-top:1px solid #23262d}
        .btn{padding:8px 12px;border-radius:10px;border:1px solid #2b2f36;background:#171a20;color:#f5f5f5;cursor:pointer}
        .btn-primary{background:#2563eb;border-color:#2563eb}
        .btn-ghost{background:transparent;border:none}
      `;
      document.head.appendChild(styles);
    }
    modal.querySelector('.btn-icon').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.remove();
      const act = e.target.closest('[data-action]');
      if (act && act.dataset.action) {
        const fn = act.dataset.action;
        if (typeof window[fn] === 'function') window[fn]();
      }
    });
    document.body.appendChild(modal);
    return modal;
  }

  closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.remove());
  }

  showLoadingOverlay(message = 'Loading...') {
    const el = document.createElement('div');
    el.id = 'loading-overlay';
    el.innerHTML = `
      <div class="loading-content">
        <div class="loading-spinner"></div>
        <div class="loading-message">${message}</div>
      </div>
    `;
    if (!document.querySelector('#loading-styles')) {
      const styles = document.createElement('style');
      styles.id = 'loading-styles';
      styles.textContent = `
        #loading-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:1050}
        .loading-content{text-align:center;color:#fff}
        .loading-spinner{width:40px;height:40px;border:4px solid rgba(255,255,255,.25);border-top-color:#2563eb;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 12px}
        .loading-message{font-weight:600}
        @keyframes spin{to{transform:rotate(360deg)}}
      `;
      document.head.appendChild(styles);
    }
    document.body.appendChild(el);
  }

  hideLoadingOverlay() { document.getElementById('loading-overlay')?.remove(); }

  showRefreshIndicator() {
    const indicator = document.createElement('div');
    indicator.className = 'refresh-indicator';
    indicator.textContent = 'Data updated';
    if (!document.querySelector('#refresh-indicator-styles')) {
      const s = document.createElement('style');
      s.id = 'refresh-indicator-styles';
      s.textContent = `.refresh-indicator{position:fixed;top:80px;right:20px;background:#10b981;color:#0b2b1f;padding:8px 14px;border-radius:18px;font-weight:600;z-index:1080;animation:fade .2s ease}@keyframes fade{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:translateX(0)}}`;
      document.head.appendChild(s);
    }
    document.body.appendChild(indicator);
    setTimeout(() => indicator.remove(), 1600);
  }

  /* ======================= Events ======================= */

  setupEventListeners() {
    document.addEventListener('click', (e) => this.handleGlobalClick(e));
    document.addEventListener('submit', (e) => this.handleFormSubmit(e));
    document.addEventListener('change', (e) => this.handleFileChange(e));
    window.addEventListener('beforeunload', (e) => this.handleBeforeUnload(e));
    window.addEventListener('online', () => this.showToast('Connection restored', 'success'));
    window.addEventListener('offline', () => this.showToast('Connection lost', 'warning'));
    document.addEventListener('DOMContentLoaded', () => {
      document.body.classList.add('animate-fadeIn');
      document.querySelectorAll('form').forEach(f => {
        f.addEventListener('input', () => f.setAttribute('data-dirty', 'true'));
      });
    });
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.openSearch?.(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); this.openNewItemModal?.(); }
      if (e.key === 'Escape') this.closeAllModals();
    });
  }

  handleGlobalClick(e) {
    const t = e.target;
    if (t.matches('[data-route]')) {
      e.preventDefault();
      const r = t.getAttribute('data-route');
      location.hash = r;
    }
    if (t.matches('[data-delete]')) {
      e.preventDefault();
      const id = t.getAttribute('data-delete');
      const type = t.getAttribute('data-type');
      this.confirmDelete(id, type);
    }
    if (t.matches('[data-edit]')) {
      e.preventDefault();
      const id = t.getAttribute('data-edit');
      const type = t.getAttribute('data-type');
      this.openEditModal(id, type);
    }
  }

  handleFormSubmit(e) {
    const form = e.target;
    if (form.matches('[data-ajax]')) {
      e.preventDefault();
      this.submitForm(form);
    }
  }

  handleFileChange(e) {
    const input = e.target;
    if (input.matches('[data-import]')) {
      const file = input.files?.[0];
      if (file) this.handleFileImport(file, input.getAttribute('data-import'));
    }
  }

  handleBeforeUnload(e) {
    const unsaved = document.querySelectorAll('form[data-dirty="true"]');
    if (unsaved.length) {
      e.preventDefault();
      e.returnValue = 'You have unsaved changes. Leave this page?';
    }
  }

  /* ======================= Import ======================= */

  async handleFileImport(file, type) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);

    try {
      this.showLoadingOverlay('Importing file...');
      const res = await fetch('/api/import/file', { method: 'POST', body: formData });
      if (!res.ok) throw new Error(`Import failed: ${res.statusText}`);
      const result = await res.json();
      this.hideLoadingOverlay();
      this.showToast(`Imported ${result.imported || 0} items`, 'success');
      await this.bootstrapData();
      this.refreshCurrentPage();
      return result;
    } catch (err) {
      this.hideLoadingOverlay();
      this.showToast(`Import failed: ${err.message}`, 'error');
      throw err;
    }
  }

  /* ======================= Forms / Modals ======================= */

  async submitForm(form) {
    const endpoint = form.getAttribute('action') || form.dataset.endpoint;
    const method = (form.getAttribute('method') || 'POST').toUpperCase();
    const formData = new FormData(form);
    const payload = {};
    formData.forEach((v, k) => payload[k] = v);

    try {
      await this.api(endpoint, { method, body: payload });
      form.removeAttribute('data-dirty');
      this.showToast('Saved', 'success');
      await this.bootstrapData();
      this.refreshCurrentPage();
    } catch (err) {
      // toast already shown
    }
  }

  confirmDelete(id, type) {
    const modal = this.showModal('Delete', `<p>Are you sure you want to delete this ${type}?</p>`, [
      { text: 'Cancel', class: 'btn', onclick: 'closeModal' },
      { text: 'Delete', class: 'btn btn-primary', onclick: 'confirmModalDelete' },
    ]);
    window.closeModal = () => modal.remove();
    window.confirmModalDelete = async () => {
      try {
        if (type === 'product') await this.deleteProduct(id);
        if (type === 'recipe') await this.deleteRecipe(id);
        if (type === 'plan') await this.deletePlanRow(id);
      } finally { modal.remove(); }
    };
  }

  openEditModal(id, type) {
    if (type === 'product') return this.openProductModal(id);
    if (type === 'recipe') return this.openRecipeModal(id);
    if (type === 'plan') return this.openPlanModal(id);
  }

  /* ======================= View Renderers ======================= */

  renderDashboard() {
    const el = document.getElementById('app');
    const totals = this.state.planTotals || { lines: [], grand: 0 };
    el.innerHTML = `
      <div class="grid gap-16">
        <section class="card">
          <h2>Overview</h2>
          <div class="stats">
            <div class="stat"><div class="stat-title">Rohwaren</div><div class="stat-value">${this.state.products.length}</div></div>
            <div class="stat"><div class="stat-title">Rezepte</div><div class="stat-value">${this.state.recipes.length}</div></div>
            <div class="stat"><div class="stat-title">Plan Positionen</div><div class="stat-value">${this.state.plan.length}</div></div>
            <div class="stat"><div class="stat-title">Geplante Gesamtkosten</div><div class="stat-value">${this.formatCurrency(totals.grand)}</div></div>
          </div>
        </section>

        <section class="card">
          <h3>Today’s Production (preview)</h3>
          <div class="table-scroll">
            <table class="table">
              <thead><tr><th>Datum</th><th>Rezept</th><th>Menge</th><th>Kosten/St.</th><th>Gesamt</th></tr></thead>
              <tbody>
                ${totals.lines.slice(0,10).map(r => `
                  <tr>
                    <td>${this.formatDate(r.date || new Date())}</td>
                    <td>${r.recipeName}</td>
                    <td>${this.formatNumber(r.quantity || 0, 0)}</td>
                    <td>${this.formatCurrency(r.unitCost)}</td>
                    <td>${this.formatCurrency(r.lineCost)}</td>
                  </tr>
                `).join('') || `<tr><td colspan="5" style="text-align:center;color:#6b7280">No data</td></tr>`}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `;
    this.injectBaseStyles();
  }

  renderRohwaren() {
    const el = document.getElementById('app');
    el.innerHTML = `
      <section class="card">
        <div class="card-header">
          <h2>Rohwaren</h2>
          <div class="actions">
            <button class="btn btn-primary" data-edit="new" data-type="product">Neu</button>
            <label class="btn">
              Import CSV
              <input type="file" data-import="products" accept=".csv" style="display:none">
            </label>
          </div>
        </div>

        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr><th>Name</th><th>Warengruppe</th><th>Einheit</th><th>Preis/Einheit</th><th style="text-align:right">Aktionen</th></tr>
            </thead>
            <tbody>
              ${this.state.products.map(p => `
                <tr>
                  <td>${p.name}</td>
                  <td>${p.group || '-'}</td>
                  <td>${p.unit || '-'}</td>
                  <td>${this.formatCurrency(p.unitPrice || 0)}</td>
                  <td style="text-align:right">
                    <button class="btn" data-edit="${p.id}" data-type="product">Bearbeiten</button>
                    <button class="btn" data-delete="${p.id}" data-type="product">Löschen</button>
                  </td>
                </tr>
              `).join('') || `<tr><td colspan="5" style="text-align:center;color:#6b7280">Keine Einträge</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    `;
    this.injectBaseStyles();
  }

  renderRezepte() {
    const el = document.getElementById('app');
    el.innerHTML = `
      <section class="card">
        <div class="card-header">
          <h2>Rezepte</h2>
          <div class="actions">
            <button class="btn btn-primary" data-edit="new" data-type="recipe">Neu</button>
            <label class="btn">
              Import CSV
              <input type="file" data-import="recipes" accept=".csv" style="display:none">
            </label>
          </div>
        </div>

        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr><th>Name</th><th>Ausbeute (St.)</th><th>Kosten/St.</th><th style="text-align:right">Aktionen</th></tr>
            </thead>
            <tbody>
              ${this.state.recipes.map(r => `
                <tr>
                  <td>${r.name}</td>
                  <td>${this.formatNumber(r.yield || 0, 0)}</td>
                  <td>${this.formatCurrency(r.unitCost || 0)}</td>
                  <td style="text-align:right">
                    <button class="btn" data-edit="${r.id}" data-type="recipe">Bearbeiten</button>
                    <button class="btn" data-delete="${r.id}" data-type="recipe">Löschen</button>
                  </td>
                </tr>
              `).join('') || `<tr><td colspan="4" style="text-align:center;color:#6b7280">Keine Einträge</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    `;
    this.injectBaseStyles();
  }

  renderProduktion() {
    const el = document.getElementById('app');
    const totals = this.state.planTotals || { lines: [], grand: 0 };
    el.innerHTML = `
      <section class="card">
        <div class="card-header">
          <h2>Produktionsplan</h2>
          <div class="actions">
            <button class="btn btn-primary" data-edit="new" data-type="plan">Neu</button>
            <label class="btn">
              Import CSV
              <input type="file" data-import="plan" accept=".csv" style="display:none">
            </label>
          </div>
        </div>

        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr><th>Datum</th><th>Rezept</th><th>Menge</th><th>Kosten/St.</th><th>Gesamt</th><th style="text-align:right">Aktionen</th></tr>
            </thead>
            <tbody>
              ${totals.lines.map(r => `
                <tr>
                  <td>${this.formatDate(r.date || new Date())}</td>
                  <td>${r.recipeName}</td>
                  <td>${this.formatNumber(r.quantity || 0, 0)}</td>
                  <td>${this.formatCurrency(r.unitCost)}</td>
                  <td>${this.formatCurrency(r.lineCost)}</td>
                  <td style="text-align:right">
                    <button class="btn" data-edit="${r.id}" data-type="plan">Bearbeiten</button>
                    <button class="btn" data-delete="${r.id}" data-type="plan">Löschen</button>
                  </td>
                </tr>
              `).join('') || `<tr><td colspan="6" style="text-align:center;color:#6b7280">Keine Einträge</td></tr>`}
            </tbody>
            <tfoot>
              <tr><th colspan="4" style="text-align:right">Gesamtkosten:</th><th>${this.formatCurrency(totals.grand)}</th><th></th></tr>
            </tfoot>
          </table>
        </div>
      </section>
    `;
    this.injectBaseStyles();
  }

  /* ======================= Modals (forms) ======================= */

  openProductModal(idOrNew) {
    const isNew = idOrNew === 'new';
    const p = isNew ? { name: '', group: '', unit: 'kg', unitPrice: 0 } :
      this.state.products.find(x => x.id === idOrNew);
    const modal = this.showModal(isNew ? 'Neue Rohware' : 'Rohware bearbeiten', `
      <form id="product-form" data-ajax action="${isNew ? '/api/products' : `/api/products/${p.id}`}" method="${isNew ? 'POST' : 'PUT'}">
        <div class="grid-2">
          <label>Name<input name="name" required value="${p.name || ''}"></label>
          <label>Warengruppe<input name="group" value="${p.group || ''}"></label>
          <label>Einheit<input name="unit" value="${p.unit || ''}"></label>
          <label>Preis/Einheit<input name="unitPrice" type="number" step="0.0001" value="${p.unitPrice || 0}"></label>
        </div>
        <div class="mt-12"><button class="btn btn-primary" type="submit">Speichern</button></div>
      </form>
    `);
    return modal;
  }

  openRecipeModal(idOrNew) {
    const isNew = idOrNew === 'new';
    const r = isNew ? { name: '', yield: 1, ingredients: [] } :
      structuredClone(this.state.recipes.find(x => x.id === idOrNew));
    if (!r.ingredients) r.ingredients = [];

    const rows = r.ingredients.map((ing, i) => this.recipeIngRow(i, ing)).join('');
    const productOptions = this.state.products.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

    const modal = this.showModal(isNew ? 'Neues Rezept' : 'Rezept bearbeiten', `
      <form id="recipe-form" data-ajax action="${isNew ? '/api/recipes' : `/api/recipes/${r.id}`}" method="${isNew ? 'POST' : 'PUT'}">
        <label>Name<input name="name" required value="${r.name || ''}"></label>
        <label>Ausbeute (St.)<input name="yield" type="number" step="1" min="1" value="${r.yield || 1}"></label>

        <div class="mt-12">
          <h4>Zutaten</h4>
          <table class="table table-compact">
            <thead><tr><th>Produkt</th><th>Menge</th><th>Einheit</th><th style="text-align:right">Aktionen</th></tr></thead>
            <tbody id="ing-rows">
              ${rows || `<tr><td colspan="4" style="text-align:center;color:#6b7280">Noch keine Zutaten</td></tr>`}
            </tbody>
          </table>
          <div class="mt-8">
            <button class="btn" id="add-ing">Zutat hinzufügen</button>
          </div>
        </div>

        <input type="hidden" name="ingredientsJson">
        <div class="mt-12"><button class="btn btn-primary" type="submit">Speichern</button></div>
      </form>
    `);

    const form = modal.querySelector('#recipe-form');
    const ingBody = form.querySelector('#ing-rows');
    const addBtn = form.querySelector('#add-ing');

    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const idx = ingBody.querySelectorAll('tr').length;
      ingBody.insertAdjacentHTML('beforeend', this.recipeIngRow(idx, { productId: '', amount: 0, unit: '' }, productOptions));
    });

    form.addEventListener('submit', () => {
      const rows = Array.from(ingBody.querySelectorAll('tr')).map(tr => ({
        productId: tr.querySelector('[name="productId"]')?.value || '',
        amount: Number(tr.querySelector('[name="amount"]')?.value || 0),
        unit: tr.querySelector('[name="unit"]')?.value || ''
      })).filter(x => x.productId);
      form.elements['ingredientsJson'].value = JSON.stringify(rows);
    });

    // Fill selects with product options
    ingBody.querySelectorAll('select[name="productId"]').forEach(sel => {
      sel.innerHTML = productOptions;
      const v = sel.getAttribute('data-value');
      if (v) sel.value = v;
    });

    return modal;
  }

  recipeIngRow(i, ing = {}, productOptions = '') {
    const options = productOptions || this.state.products.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    return `
      <tr>
        <td><select name="productId" data-value="${ing.productId || ''}" required>${options}</select></td>
        <td><input name="amount" type="number" step="0.0001" value="${ing.amount || 0}"></td>
        <td><input name="unit" value="${(ing.unit || '').toString()}"></td>
        <td style="text-align:right"><button class="btn btn-ghost" onclick="this.closest('tr').remove()">Entfernen</button></td>
      </tr>
    `;
  }

  openPlanModal(idOrNew) {
    const isNew = idOrNew === 'new';
    const row = isNew ? { date: new Date().toISOString().slice(0,10), recipeId: '', quantity: 0 } :
      this.state.plan.find(x => x.id === idOrNew) || {};
    const recipeOptions = this.state.recipes.map(r => `<option value="${r.id}">${r.name}</option>`).join('');

    const modal = this.showModal(isNew ? 'Neue Plan-Position' : 'Plan-Position bearbeiten', `
      <form id="plan-form" data-ajax action="${isNew ? '/api/plan' : `/api/plan/${row.id}`}" method="${isNew ? 'POST' : 'PUT'}">
        <div class="grid-2">
          <label>Datum<input name="date" type="date" required value="${(row.date || new Date().toISOString().slice(0,10)).slice(0,10)}"></label>
          <label>Rezept
            <select name="recipeId" required>${recipeOptions}</select>
          </label>
          <label>Menge<input name="quantity" type="number" step="1" min="0" value="${row.quantity || 0}"></label>
        </div>
        <div class="mt-12"><button class="btn btn-primary" type="submit">Speichern</button></div>
      </form>
    `);
    const form = modal.querySelector('#plan-form');
    form.querySelector('select[name="recipeId"]').value = row.recipeId || '';
    return modal;
  }

  /* ======================= Auth Helpers ======================= */

  async login(email, password) {
    try {
      const r = await this.api('/api/login', { method: 'POST', body: { email, password } });
      this.user = r.user;
      this.showToast('Login successful', 'success');
      setTimeout(() => location.href = '/dashboard.html', 600);
      return r;
    } catch (err) {
      this.showToast('Login failed: invalid credentials', 'error');
      throw err;
    }
  }

  async logout() {
    try {
      await this.api('/api/logout', { method: 'POST' });
    } catch (_) {}
    this.user = null;
    this.showToast('Logged out', 'info');
    setTimeout(() => location.href = '/login.html', 400);
  }

  /* ======================= Utils ======================= */

  formatCurrency(amount, currency = 'EUR') {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(Number(amount || 0));
  }
  formatDate(date, opts = { year:'numeric', month:'short', day:'numeric' }) {
    return new Intl.DateTimeFormat('de-DE', opts).format(new Date(date));
  }
  formatNumber(n, d = 2) {
    return new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(n || 0));
  }
  round(n, d = 2) { const m = Math.pow(10, d); return Math.round((Number(n) + Number.EPSILON) * m) / m; }

  /* ======================= Base Styles (lightweight) ======================= */

  injectBaseStyles() {
    if (document.getElementById('bunca-base-styles')) return;
    const s = document.createElement('style');
    s.id = 'bunca-base-styles';
    s.textContent = `
      :root{--bg:#0b0e12;--card:#0f1115;--line:#23262d;--text:#e6e6e6;--muted:#9aa3af;--primary:#2563eb}
      body{background:var(--bg);color:var(--text)}
      .grid{display:grid}.gap-16{gap:16px}
      .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
      .card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
      .actions{display:flex;gap:8px}
      .table{width:100%;border-collapse:separate;border-spacing:0 8px}
      .table th,.table td{padding:10px 12px;border-bottom:1px solid var(--line)}
      .table-scroll{overflow:auto}
      .stat{background:rgba(255,255,255,.03);border:1px solid var(--line);padding:12px;border-radius:12px}
      .stat-title{color:var(--muted);font-size:12px}
      .stat-value{font-size:18px;font-weight:700}
      .btn{padding:8px 12px;border-radius:10px;border:1px solid #2b2f36;background:#171a20;color:#f5f5f5;cursor:pointer}
      .btn-primary{background:var(--primary);border-color:var(--primary)}
      .table-compact th,.table-compact td{padding:8px}
      .grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .mt-8{margin-top:8px}.mt-12{margin-top:12px}
      input,select{width:100%;background:#0c0f14;border:1px solid #262a33;border-radius:10px;padding:8px;color:var(--text)}
      h2{margin:0 0 8px 0}
      a.active,[data-route].active{outline:2px solid var(--primary);outline-offset:2px;border-radius:8px}
    `;
    document.head.appendChild(s);
  }
}

/* ======================= Global helpers (back-compat) ======================= */

const app = new BuncaBakeryApp();

window.$$  = (sel, root = document) => root.querySelector(sel);
window.$$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(endpoint, options = {}) { return app.api(endpoint, options); }
async function sessionInfo() { try { const r = await app.api('/api/session'); return r.user; } catch { return null; } }
function toast(message, type = 'info') { app.showToast(message, type); }
function logout() { app.logout(); }
function showModal(title, content, actions = []) { return app.showModal(title, content, actions); }
function closeModal() { app.closeAllModals(); }

/* ======================= Page boot ======================= */

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('animate-fadeIn');
});

console.log('Bunca Bakery Frontend loaded');
