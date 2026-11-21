let currentAdminView = 'dashboard';

// Browsers can restore admin.html from the back/forward cache without
// re-running the normal page initialization. Never leave a restored admin
// screen visible without requiring the password again.
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  document.body.classList.remove('auth-required');
  document.querySelector('#admin-logout')?.setAttribute('hidden', '');
  renderAdminLogin();
});

function escapeDentalHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function labelAdminTables(root = document) {
  root.querySelectorAll('.data-table').forEach(table => {
    const labels = Array.from(table.querySelectorAll('thead th'), cell => cell.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(row => {
      Array.from(row.cells).forEach((cell, index) => {
        if (cell.colSpan === 1 && labels[index]) cell.dataset.label = labels[index];
      });
    });
  });
}

function renderAdminLogin(message = '') {
  document.querySelector('#app').innerHTML = `<div class="content dental-login-wrap">
    <form class="panel dental-login" id="admin-login-form">
      <span class="brand-mark dental-login-mark">N</span>
      <h1>Admin sign-in</h1>
      <p class="muted">Sign in to manage Nance Oro Dental staff and clinic locations.</p>
    <label>Admin username<input id="admin-id" class="search" autocomplete="username" placeholder="Enter admin username" required></label>
    <label>Password<input id="admin-password" class="search" type="password" autocomplete="current-password" placeholder="Enter admin password" required></label>
      <button class="primary" type="submit">Sign in</button>
      <p class="dental-login-error" id="admin-login-error" aria-live="polite">${escapeDentalHtml(message)}</p>
    </form>
  </div>`;
  document.querySelector('#admin-login-form').addEventListener('submit', signInAdmin);
}

async function signInAdmin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const error = document.querySelector('#admin-login-error');
  button.disabled = true;
  error.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/dental/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: document.querySelector('#admin-id').value.trim(),
        password: document.querySelector('#admin-password').value
      })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Admin sign-in failed.');
    document.querySelector('#admin-password').value = '';
    await loadDentalAdmin();
  } catch (error) {
    document.querySelector('#admin-login-error').textContent = error.message;
    button.disabled = false;
  }
}

async function initializeDentalAdmin() {
  document.body.classList.remove('auth-required');
  document.querySelector('#admin-logout')?.setAttribute('hidden', '');
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-view], [data-admin-view]');
    if (!button) return;
    const view = button.dataset.view || button.dataset.adminView;
    if (!view) return;
    event.preventDefault();
    currentAdminView = view;
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    showAdminView(view);
  });
  // Always require a fresh admin sign-in when the admin app is opened.
  // The server still validates every protected API request as a second lock.
  renderAdminLogin();
}

async function loadDentalAdmin() {
  document.body.classList.remove('auth-required');
  document.querySelector('#admin-logout').hidden = false;
  currentAdminView = 'dashboard';
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'dashboard'));
  await dashboard();
}

function showAdminView(view) {
  if (view === 'dashboard') return dashboard();
  if (view === 'inventory') return inventory();
  if (view === 'bills') return adminList('bills');
  if (view === 'employees') return showEmployees();
  if (view === 'sites') return showClinicSites();
  if (view === 'purchases' || view === 'suppliers' || view === 'reports') return adminList(view);
}

async function signOutAdmin() {
  try {
    const response = await fetch('/api/dental/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Could not sign out. Check your connection and retry.');
    document.querySelector('#admin-logout').hidden = true;
    document.body.classList.add('auth-required');
    renderAdminLogin();
  } catch (error) {
    alert(error.message);
  }
}
