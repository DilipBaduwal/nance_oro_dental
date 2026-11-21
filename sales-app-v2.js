let staffLocationVerified = false;
let verifiedStaffLocation = null;
let staffSitesPromise;
let staffBillingItems = [];
let staffBillingCart = [];

function renderStaffLogin(message = '') {
  staffLocationVerified = false;
  verifiedStaffLocation = null;
  document.querySelector('#app').innerHTML = `<div class="content dental-login-wrap">
    <form class="panel dental-login staff-login" id="staff-login-form">
      <span class="brand-mark dental-login-mark">N</span>
      <h1>Staff sign-in</h1>
      <p class="muted">Sign-in is available only within 100 metres of an approved clinic. Verify this device before entering credentials.</p>
      <div class="staff-site-card">
        <button class="secondary" id="verify-clinic-location" type="button">Check this device's clinic location</button>
        <p id="geofence-status" class="muted" aria-live="polite">Location verification is required to unlock sign-in.</p>
      </div>
      <label>Employee ID<input id="staff-code" class="search" autocomplete="username" autocapitalize="characters" required disabled></label>
      <label>Password<input id="staff-password" class="search" type="password" autocomplete="current-password" required disabled></label>
      <label>Clinic location<select id="login-site" class="search" required disabled><option value="">Loading approved locations…</option></select></label>
      <button class="primary" type="submit" disabled>Sign in</button>
      <p class="dental-login-error" id="login-error" aria-live="polite">${escapeStaffHtml(message)}</p>
      <p class="muted dental-login-note" id="sync-mode-note">Checking sign-in storage…</p>
      <p class="muted dental-login-note" id="secure-context-note"></p>
    </form>
  </div>`;
  document.querySelector('#staff-login-form').addEventListener('submit', doStaffLogin);
  staffSitesPromise = loadLoginSites();
  document.querySelector('#verify-clinic-location').addEventListener('click', verifyClinicLocation);
  if (!window.isSecureContext || !navigator.geolocation) {
    const note = document.querySelector('#secure-context-note');
    note.textContent = 'Browser location requires HTTPS on a shared device. Use localhost only for same-computer testing; deploy this app to a trusted HTTPS address before sharing it.';
    document.querySelector('#verify-clinic-location').disabled = true;
  }
}

async function loadLoginSites() {
  const select = document.querySelector('#login-site');
  try {
    const response = await fetch('/api/dental/sites', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load approved clinic locations.');
    select.replaceChildren(new Option(data.sites.length ? 'Select clinic location' : 'No locations configured', ''));
    data.sites.forEach(site => select.add(new Option(site.name, site.id)));
    select.disabled = true;
    document.querySelector('#sync-mode-note').textContent = data.source === 'local-device'
      ? 'Local-only testing: sign-in records stay on this computer and do not sync to Supabase.'
      : 'Internet is required to verify the account and record sign-in securely.';
    return data;
  } catch (error) {
    select.replaceChildren(new Option('Locations unavailable — retry the page', ''));
    select.disabled = true;
    document.querySelector('#login-error').textContent = error.message;
    return null;
  }
}

async function verifyClinicLocation() {
  const button = document.querySelector('#verify-clinic-location');
  const status = document.querySelector('#geofence-status');
  button.disabled = true;
  status.textContent = 'Checking GPS location…';
  try {
    const location = await getStaffLocation();
    if (location.accuracy > 100) throw new Error(`GPS accuracy is ±${Math.round(location.accuracy)} m; 100 m or better is required.`);
    const response = await fetch('/api/dental/geofence/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'This device is outside an approved clinic location.');
    if (!await staffSitesPromise) throw new Error('Could not load clinic locations. Refresh the page and try again.');
    const site = document.querySelector('#login-site');
    if (!Array.from(site.options).some(option => option.value === result.site.id)) {
      throw new Error('The verified clinic is unavailable. Refresh the page and try again.');
    }
    site.value = result.site.id;
    site.disabled = false;
    document.querySelector('#staff-code').disabled = false;
    document.querySelector('#staff-password').disabled = false;
    document.querySelector('#staff-login-form button[type="submit"]').disabled = false;
    staffLocationVerified = true;
    verifiedStaffLocation = location;
    status.textContent = `Location verified at ${result.site.name} · ${Math.round(result.distanceMeters)} m away (±${Math.round(location.accuracy)} m GPS accuracy).`;
    document.querySelector('#staff-code').focus();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

function getStaffLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device does not provide location services.'));
    navigator.geolocation.getCurrentPosition(position => resolve({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      capturedAt: new Date().toISOString()
    }), error => reject(new Error(error.code === 1
      ? 'Allow location permission in device settings and try again.'
      : error.code === 3
        ? 'Location timed out. Allow location for this site and your browser in system settings, enable Wi-Fi, then retry.'
        : 'The device could not determine its location. Check this site and browser’s location permissions, enable Wi-Fi, then retry.')), {
      enableHighAccuracy: false,
      maximumAge: 10000,
      timeout: 30000
    });
  });
}

async function doStaffLogin(event) {
  event.preventDefault();
  if (!staffLocationVerified) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const error = document.querySelector('#login-error');
  button.disabled = true;
  error.textContent = 'Checking sign-in…';
  try {
    const location = verifiedStaffLocation;
    if (!location || Date.now() - Date.parse(location.capturedAt) > 60000) {
      staffLocationVerified = false;
      verifiedStaffLocation = null;
      throw new Error('Location verification expired. Check your clinic location again.');
    }
    const response = await fetch('/api/dental/staff/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: document.querySelector('#staff-code').value.trim(),
        password: document.querySelector('#staff-password').value,
        siteId: document.querySelector('#login-site').value,
        location
      })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Sign-in failed.');
    renderStaffBilling({
      employee: data.employee,
      site: data.site,
      source: data.source
    });
  } catch (loginError) {
    error.textContent = loginError.message;
    button.disabled = false;
  }
}

async function renderStaffBilling(session) {
  staffBillingCart = [];
  const breadcrumb = document.querySelector('.breadcrumbs strong');
  if (breadcrumb) breadcrumb.textContent = 'POS billing';
  const accessLabel = document.querySelector('.top-actions .muted');
  if (accessLabel) accessLabel.textContent = `Staff · ${session.employee.name}`;
  document.querySelector('#app').innerHTML = `<div class="content staff-billing-screen">
    <div class="page-heading">
      <div><h1>POS billing</h1><p>${escapeStaffHtml(session.site.name)} · Staff counter · <span style="color:var(--green)">● Signed in as ${escapeStaffHtml(session.employee.name)}</span></p></div>
      <div class="top-actions">
        <button class="secondary" id="staff-billing-scan" type="button">⌘ K&nbsp; Scan barcode</button>
        <button class="secondary" type="button" onclick="staffLogout()">Sign out</button>
      </div>
    </div>
    ${session.notice ? `<p class="staff-billing-notice" role="status">${escapeStaffHtml(session.notice)}</p>` : ''}
    <div class="pos-layout">
      <section>
        <input id="staff-billing-search" class="search" style="width:100%;margin-bottom:14px" placeholder="⌕  Search medicine or scan barcode...">
        <div id="staff-billing-products" class="pos-products"></div>
      </section>
      <section class="cart">
        <h3>Current sale <span class="muted" style="float:right;font:12px 'DM Sans'">#DRAFT-001</span></h3>
        <div id="staff-billing-cart"></div>
        <div class="cart-total"><span>Total</span><span id="staff-billing-total">₹0.00</span></div>
        <button id="staff-billing-checkout" class="primary" style="width:100%" disabled>Proceed to payment →</button>
        <p id="staff-billing-error" class="dental-login-error" aria-live="polite"></p>
      </section>
    </div>
  </div>`;
  try {
    const response = await fetch('/api/dental/staff/billing', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load billing inventory.');
    staffBillingItems = data.inventory;
    document.querySelector('#staff-billing-search').addEventListener('input', event => renderStaffBillingProducts(event.target.value));
    document.querySelector('#staff-billing-scan').addEventListener('click', () => document.querySelector('#staff-billing-search').focus());
    document.querySelector('#staff-billing-products').addEventListener('click', event => {
      const button = event.target.closest('[data-billing-index]');
      if (button) addStaffBillingItem(Number(button.dataset.billingIndex));
    });
    document.querySelector('#staff-billing-cart').addEventListener('click', event => {
      const button = event.target.closest('[data-billing-action]');
      if (button) updateStaffBillingItem(Number(button.dataset.billingIndex), button.dataset.billingAction);
    });
    document.querySelector('#staff-billing-checkout').addEventListener('click', openStaffBillingCheckout);
    const note = document.createElement('p');
    note.className = 'staff-sync-status';
    note.textContent = data.syncStatus === 'cloud-read-only'
      ? 'Local save only · Cloud billing sync is not enabled on the server.'
      : data.syncStatus === 'shared-local'
        ? 'Shared with the admin app on this server.'
        : 'Synced with the clinic database and admin.';
    document.querySelector('.pos-layout').before(note);
    renderStaffBillingProducts();
    renderStaffBillingCart();
  } catch (error) {
    document.querySelector('#staff-billing-products').innerHTML = `<div class="empty">${escapeStaffHtml(error.message)}</div>`;
  }
}

function renderStaffBillingProducts(query = '') {
  const products = staffBillingItems
    .map((item, index) => ({ ...item, index }))
    .filter(item => item.stock > 0 && `${item.name} ${item.generic || ''}`.toLowerCase().includes(query.toLowerCase()));
  document.querySelector('#staff-billing-products').innerHTML = products.length
    ? products.map(item => `<button class="product staff-billing-product" type="button" data-billing-index="${item.index}">
        <strong>${escapeStaffHtml(item.name)}</strong>
        <small>${escapeStaffHtml(item.generic || '')}</small>
        <small style="margin-top:10px;color:var(--green)">${item.stock} in stock · ₹${Number(item.price).toFixed(2)}${item.discountPercent ? ` <s style="color:#889">₹${(Number(item.price)/(1-item.discountPercent/100)).toFixed(2)}</s>` : ''}</small>
      </button>`).join('')
    : '<div class="empty">No available items match your search.</div>';
}

function addStaffBillingItem(index) {
  const product = staffBillingItems[index];
  if (!product) return;
  const item = staffBillingCart.find(entry => entry.name === product.name);
  if (item) {
    if (item.quantity >= product.stock) return;
    item.quantity += 1;
  } else {
    staffBillingCart.push({ name: product.name, price: Number(product.price) || 0, quantity: 1 });
  }
  renderStaffBillingCart();
}

function updateStaffBillingItem(index, action) {
  const item = staffBillingCart[index];
  if (!item) return;
  if (action === 'remove' || (action === 'decrease' && item.quantity === 1)) staffBillingCart.splice(index, 1);
  else if (action === 'decrease') item.quantity -= 1;
  else if (action === 'increase') {
    const product = staffBillingItems.find(entry => entry.name === item.name);
    if (product && item.quantity < product.stock) item.quantity += 1;
  }
  renderStaffBillingCart();
}

function renderStaffBillingCart() {
  const cart = document.querySelector('#staff-billing-cart');
  if (!cart) return;
  cart.innerHTML = staffBillingCart.length
    ? staffBillingCart.map((item, index) => `<div class="cart-row staff-billing-row">
        <span>${escapeStaffHtml(item.name)}<br><small class="muted">${item.quantity} × ₹${item.price.toFixed(2)}</small></span>
        <span><strong>₹${(item.quantity * item.price).toFixed(2)}</strong><br>
          <button class="secondary" type="button" data-billing-index="${index}" data-billing-action="decrease">−</button>
          <button class="secondary" type="button" data-billing-index="${index}" data-billing-action="increase">+</button>
          <button class="secondary" type="button" data-billing-index="${index}" data-billing-action="remove">Remove</button>
        </span>
      </div>`).join('')
    : '<div class="empty">Add items to start a bill.</div>';
  const total = staffBillingCart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  document.querySelector('#staff-billing-total').textContent = `₹${total.toFixed(2)}`;
  document.querySelector('#staff-billing-checkout').disabled = staffBillingCart.length === 0;
}

function openStaffBillingCheckout() {
  const modal = document.createElement('div');
  modal.className = 'payment-modal';
  modal.innerHTML = `<form class="payment-card" id="staff-billing-payment">
    <h2>Customer details & payment</h2>
    <p class="muted payment-summary">Amount due: <strong>₹${staffBillingCart.reduce((sum, item) => sum + item.price * item.quantity, 0).toFixed(2)}</strong></p>
    <fieldset class="staff-customer-fields"><legend>Customer information</legend>
      <label>Customer name (optional)<input class="search" name="customer" maxlength="160" placeholder="Walk-in customer" autocomplete="name"></label>
      <label>Mobile number (optional)<input class="search" name="phone" maxlength="40" inputmode="tel" autocomplete="tel" placeholder="Customer phone"></label>
    </fieldset>
    <fieldset class="staff-customer-fields"><legend>Payment</legend>
      <label>Payment method<select class="search" name="method" required><option>Cash</option><option>UPI</option><option>Card</option></select></label>
      <label>Payment reference (optional)<input class="search" name="paymentReference" maxlength="120" placeholder="UPI or card reference"></label>
      <label>Discount (₹)<input class="search" name="discount" type="number" min="0" step="0.01" value="0" inputmode="decimal"></label>
    </fieldset>
    <p id="staff-billing-payment-error" class="dental-login-error" aria-live="polite"></p>
    <button class="primary" style="width:100%" type="submit">Save bill</button>
    <button class="secondary" style="width:100%;margin-top:8px" type="button" onclick="this.closest('.payment-modal').remove()">Cancel</button>
  </form>`;
  document.body.append(modal);
  modal.querySelector('form').addEventListener('submit', submitStaffBilling);
  modal.querySelector('[name="discount"]').addEventListener('input', event => {
    const discount = Math.max(0, Number(event.currentTarget.value) || 0);
    const subtotal = staffBillingCart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    modal.querySelector('.payment-summary strong').textContent = `₹${Math.max(0, subtotal - discount).toFixed(2)}`;
  });
}

async function submitStaffBilling(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const error = form.querySelector('#staff-billing-payment-error');
  button.disabled = true;
  error.textContent = 'Saving bill…';
  try {
    const fields = new FormData(form);
    const response = await fetch('/api/dental/staff/billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: staffBillingCart.map(item => ({ name: item.name, quantity: item.quantity })),
        customer: fields.get('customer'),
        phone: fields.get('phone'),
        method: fields.get('method'),
        paymentReference: fields.get('paymentReference'),
        discount: Number(fields.get('discount')) || 0
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Could not save this bill.');
    document.querySelector('.payment-modal')?.remove();
    staffBillingCart = [];
    renderStaffBilling({
      employee: result.employee,
      site: result.site,
      source: result.source,
      notice: `Bill ${result.invoice} saved · ₹${Number(result.total).toFixed(2)}`
    });
  } catch (saveError) {
    error.textContent = saveError.message;
    button.disabled = false;
  }
}

function escapeStaffHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function formatStaffTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'on this device' : date.toLocaleString();
}

async function staffLogout() {
  try {
    const response = await fetch('/api/dental/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Could not sign out. Check your connection and retry.');
    renderStaffLogin();
  } catch (error) {
    const message = document.createElement('p');
    message.className = 'dental-login-error';
    message.textContent = error.message;
    document.querySelector('#app .staff-success')?.append(message);
  }
}

async function initializeStaffApp() {
  try {
    const response = await fetch('/api/dental/session', { cache: 'no-store' });
    if (!response.ok) throw new Error('The staff server is not responding correctly. Refresh or contact the administrator.');
    const data = await response.json();
    if (data.authenticated && data.user?.role === 'STAFF') {
      renderStaffBilling({
        employee: { name: data.user.name },
        site: { name: data.user.siteName },
        source: data.source
      });
      return;
    }
  } catch (error) {
    renderStaffLogin('Cannot connect to the app server. Check your connection and retry.');
    console.error('Staff session check failed', error);
    return;
  }
  renderStaffLogin();
}

initializeStaffApp();
