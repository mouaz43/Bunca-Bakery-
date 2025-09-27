// 🍞 Bunca Bakery - Advanced Automated Frontend Framework
// Beautiful UI/UX with complete automation and import capabilities

/* ========== Core Application Framework ========== */

class BuncaBakeryApp {
  constructor() {
    this.user = null;
    this.notifications = [];
    this.autoRefresh = true;
    this.refreshInterval = null;
    this.cache = new Map();
    this.init();
  }

  async init() {
    try {
      await this.checkSession();
      this.setupEventListeners();
      this.startAutoRefresh();
      this.initializeNotifications();
      this.setupKeyboardShortcuts();
      console.log('🚀 Bunca Bakery App initialized successfully');
    } catch (error) {
      console.error('❌ App initialization failed:', error);
    }
  }

  async checkSession() {
    try {
      const response = await this.api('/api/session');
      this.user = response.user;
      
      if (!this.user && !window.location.pathname.includes('login')) {
        window.location.href = '/login.html';
      }
    } catch (error) {
      console.error('Session check failed:', error);
    }
  }

  setupEventListeners() {
    // Global click handler for dynamic elements
    document.addEventListener('click', this.handleGlobalClick.bind(this));
    
    // Form submission handler
    document.addEventListener('submit', this.handleFormSubmit.bind(this));
    
    // File input handler
    document.addEventListener('change', this.handleFileChange.bind(this));
    
    // Window events
    window.addEventListener('beforeunload', this.handleBeforeUnload.bind(this));
    window.addEventListener('online', () => this.showToast('✅ Connection restored', 'success'));
    window.addEventListener('offline', () => this.showToast('⚠️ Connection lost', 'warning'));
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + K for search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.openSearch();
      }
      
      // Ctrl/Cmd + N for new item
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        this.openNewItemModal();
      }
      
      // Escape to close modals
      if (e.key === 'Escape') {
        this.closeAllModals();
      }
    });
  }

  /* ========== API Communication ========== */

  async api(endpoint, options = {}) {
    const defaultOptions = {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const config = { ...defaultOptions, ...options };
    
    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }

    try {
      const response = await fetch(endpoint, config);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Cache successful GET requests
      if (config.method === 'GET') {
        this.cache.set(endpoint, { data, timestamp: Date.now() });
      }
      
      return data;
    } catch (error) {
      console.error(`API Error (${endpoint}):`, error);
      this.showToast(`API Error: ${error.message}`, 'error');
      throw error;
    }
  }

  /* ========== File Import System ========== */

  async handleFileImport(file, type) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);

    try {
      this.showLoadingOverlay('Importing file...');
      
      const response = await fetch('/api/import/file', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Import failed: ${response.statusText}`);
      }

      const result = await response.json();
      this.hideLoadingOverlay();
      
      this.showToast(`✅ Successfully imported ${result.imported} items`, 'success');
      this.refreshCurrentPage();
      
      return result;
    } catch (error) {
      this.hideLoadingOverlay();
      this.showToast(`❌ Import failed: ${error.message}`, 'error');
      throw error;
    }
  }

  /* ========== UI Components ========== */

  showToast(message, type = 'info', duration = 5000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <div class="toast-content">
        <span class="toast-icon">${this.getToastIcon(type)}</span>
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.parentElement.remove()">×</button>
      </div>
    `;

    // Add toast styles if not already present
    if (!document.querySelector('#toast-styles')) {
      const styles = document.createElement('style');
      styles.id = 'toast-styles';
      styles.textContent = `
        .toast {
          position: fixed;
          top: 20px;
          right: 20px;
          min-width: 300px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-xl);
          z-index: 1080;
          animation: slideInRight 0.3s ease;
        }
        .toast-content {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px;
        }
        .toast-icon {
          font-size: 18px;
        }
        .toast-message {
          flex: 1;
          color: var(--text);
        }
        .toast-close {
          background: none;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          font-size: 18px;
          padding: 0;
          width: 20px;
          height: 20px;
        }
        .toast-success { border-left: 4px solid var(--success); }
        .toast-warning { border-left: 4px solid var(--warning); }
        .toast-error { border-left: 4px solid var(--error); }
        .toast-info { border-left: 4px solid var(--info); }
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `;
      document.head.appendChild(styles);
    }

    document.body.appendChild(toast);

    // Auto remove after duration
    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.animation = 'slideInRight 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
      }
    }, duration);
  }

  getToastIcon(type) {
    const icons = {
      success: '✅',
      warning: '⚠️',
      error: '❌',
      info: 'ℹ️'
    };
    return icons[type] || icons.info;
  }

  showLoadingOverlay(message = 'Loading...') {
    const overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `
      <div class="loading-content">
        <div class="loading-spinner"></div>
        <div class="loading-message">${message}</div>
      </div>
    `;

    // Add loading styles if not already present
    if (!document.querySelector('#loading-styles')) {
      const styles = document.createElement('style');
      styles.id = 'loading-styles';
      styles.textContent = `
        #loading-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1050;
        }
        .loading-content {
          text-align: center;
          color: white;
        }
        .loading-spinner {
          width: 40px;
          height: 40px;
          border: 4px solid rgba(255, 255, 255, 0.3);
          border-top: 4px solid var(--primary);
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin: 0 auto 16px;
        }
        .loading-message {
          font-size: 18px;
          font-weight: 600;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(styles);
    }

    document.body.appendChild(overlay);
  }

  hideLoadingOverlay() {
    const overlay = document.querySelector('#loading-overlay');
    if (overlay) {
      overlay.remove();
    }
  }

  showModal(title, content, actions = []) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
          <button class="btn btn-ghost btn-icon" onclick="this.closest('.modal-overlay').remove()">×</button>
        </div>
        <div class="modal-body">
          ${content}
        </div>
        ${actions.length > 0 ? `
          <div class="modal-footer">
            ${actions.map(action => `
              <button class="btn ${action.class || 'btn-primary'}" onclick="${action.onclick}">
                ${action.text}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;

    document.body.appendChild(modal);
    
    // Trigger open animation
    setTimeout(() => modal.classList.add('open'), 10);
    
    return modal;
  }

  closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(modal => {
      modal.remove();
    });
  }

  /* ========== Event Handlers ========== */

  handleGlobalClick(event) {
    const target = event.target;
    
    // Handle dropdown toggles
    if (target.matches('[data-dropdown-toggle]')) {
      event.preventDefault();
      this.toggleDropdown(target.getAttribute('data-dropdown-toggle'));
    }
    
    // Handle modal triggers
    if (target.matches('[data-modal]')) {
      event.preventDefault();
      this.openModal(target.getAttribute('data-modal'));
    }
    
    // Handle delete actions
    if (target.matches('[data-delete]')) {
      event.preventDefault();
      this.confirmDelete(target.getAttribute('data-delete'), target.getAttribute('data-type'));
    }
    
    // Handle edit actions
    if (target.matches('[data-edit]')) {
      event.preventDefault();
      this.openEditModal(target.getAttribute('data-edit'), target.getAttribute('data-type'));
    }
  }

  handleFormSubmit(event) {
    const form = event.target;
    
    if (form.matches('[data-ajax]')) {
      event.preventDefault();
      this.submitForm(form);
    }
  }

  handleFileChange(event) {
    const input = event.target;
    
    if (input.matches('[data-import]')) {
      const file = input.files[0];
      if (file) {
        this.handleFileImport(file, input.getAttribute('data-import'));
      }
    }
  }

  handleBeforeUnload(event) {
    // Check for unsaved changes
    const unsavedForms = document.querySelectorAll('form[data-dirty="true"]');
    if (unsavedForms.length > 0) {
      event.preventDefault();
      event.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
    }
  }

  /* ========== Auto Refresh System ========== */

  startAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    
    if (this.autoRefresh) {
      this.refreshInterval = setInterval(() => {
        this.refreshCurrentPage();
      }, 30000); // Refresh every 30 seconds
    }
  }

  stopAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  async refreshCurrentPage() {
    try {
      // Clear cache for current page
      this.cache.clear();
      
      // Trigger page-specific refresh
      if (typeof window.refreshData === 'function') {
        await window.refreshData();
      }
      
      // Show refresh indicator
      this.showRefreshIndicator();
    } catch (error) {
      console.error('Auto-refresh failed:', error);
    }
  }

  showRefreshIndicator() {
    const indicator = document.createElement('div');
    indicator.className = 'refresh-indicator';
    indicator.textContent = '🔄 Data updated';
    
    // Add styles if not present
    if (!document.querySelector('#refresh-indicator-styles')) {
      const styles = document.createElement('style');
      styles.id = 'refresh-indicator-styles';
      styles.textContent = `
        .refresh-indicator {
          position: fixed;
          top: 80px;
          right: 20px;
          background: var(--success);
          color: white;
          padding: 8px 16px;
          border-radius: 20px;
          font-size: 14px;
          font-weight: 600;
          z-index: 1080;
          animation: slideInRight 0.3s ease;
        }
      `;
      document.head.appendChild(styles);
    }
    
    document.body.appendChild(indicator);
    
    setTimeout(() => {
      if (indicator.parentElement) {
        indicator.style.animation = 'slideInRight 0.3s ease reverse';
        setTimeout(() => indicator.remove(), 300);
      }
    }, 2000);
  }

  /* ========== Authentication ========== */

  async login(email, password) {
    try {
      const response = await this.api('/api/login', {
        method: 'POST',
        body: { email, password }
      });
      
      this.user = response.user;
      this.showToast('✅ Login successful', 'success');
      
      setTimeout(() => {
        window.location.href = '/dashboard.html';
      }, 1000);
      
      return response;
    } catch (error) {
      this.showToast('❌ Login failed: Invalid credentials', 'error');
      throw error;
    }
  }

  async logout() {
    try {
      await this.api('/api/logout', { method: 'POST' });
      this.user = null;
      this.showToast('👋 Logged out successfully', 'info');
      
      setTimeout(() => {
        window.location.href = '/login.html';
      }, 1000);
    } catch (error) {
      console.error('Logout failed:', error);
      // Force logout even if API fails
      window.location.href = '/login.html';
    }
  }

  /* ========== Utility Functions ========== */

  formatCurrency(amount, currency = 'EUR') {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: currency
    }).format(amount);
  }

  formatDate(date, options = {}) {
    const defaultOptions = {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    };
    
    return new Intl.DateTimeFormat('de-DE', { ...defaultOptions, ...options }).format(new Date(date));
  }

  formatNumber(number, decimals = 2) {
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(number);
  }

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  generateId() {
    return Math.random().toString(36).substr(2, 9);
  }
}

/* ========== Global Functions ========== */

// Initialize app
const app = new BuncaBakeryApp();

// Global utility functions for backward compatibility
window.$$  = (sel, root = document) => root.querySelector(sel);
window.$$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(endpoint, options = {}) {
  return app.api(endpoint, options);
}

async function sessionInfo() {
  try {
    const response = await app.api('/api/session');
    return response.user;
  } catch (error) {
    return null;
  }
}

function toast(message, type = 'info') {
  app.showToast(message, type);
}

function logout() {
  app.logout();
}

function showModal(title, content, actions = []) {
  return app.showModal(title, content, actions);
}

function closeModal() {
  app.closeAllModals();
}

/* ========== Page-Specific Initialization ========== */

document.addEventListener('DOMContentLoaded', () => {
  // Add loading animation to page
  document.body.classList.add('animate-fadeIn');
  
  // Initialize tooltips
  document.querySelectorAll('[data-tooltip]').forEach(element => {
    element.classList.add('tooltip');
  });
  
  // Initialize form validation
  document.querySelectorAll('form').forEach(form => {
    form.addEventListener('input', () => {
      form.setAttribute('data-dirty', 'true');
    });
  });
});

console.log('🍞 Bunca Bakery Advanced Framework Loaded Successfully!');
