function renderAdminList(view) {
  const titles = {
    purchases: ['Purchases', 'Receive supplier stock and keep a purchase history.'],
    suppliers: ['Suppliers', 'Maintain supplier contacts for purchasing.'],
    reports: ['Reports', 'Review sales, stock valuation, and inventory alerts.']
  };
  const [title, description] = titles[view];
  document.querySelector('#app').innerHTML = `<div class="content"><div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="top-actions"><button class="secondary" onclick="downloadExcel('${view === 'purchases' ? 'purchases' : 'inventory'}')">⇩ Excel</button><button class="primary" onclick="${view === 'purchases' ? 'purchaseForm()' : view === 'suppliers' ? 'supplierForm()' : 'refreshReports()'}">${view === 'reports' ? '↻ Refresh' : '＋ Add record'}</button></div></div><div id="admin-module-content" class="panel"><div class="empty">Loading...</div></div></div>`;
  if (view === 'purchases') loadPurchases();
  if (view === 'suppliers') loadSuppliers();
  if (view === 'reports') refreshReports();
}

function downloadExcel(type) {
  window.location.href = `/api/export/${type}`;
}

async function loadPurchases() {
  try {
    const response = await fetch('/api/purchases', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Purchases could not be loaded.');
    document.querySelector('#admin-module-content').innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>DATE</th><th>SUPPLIER</th><th>MEDICINE</th><th>QUANTITY</th><th>BUYING COST</th><th>TAX</th><th>TOTAL</th><th>PRINT</th></tr></thead><tbody>${data.purchases.map(p => `<tr><td>${new Date(p.createdAt).toLocaleString()}</td><td>${p.supplierName || p.supplier || '-'}</td><td>${p.name || (p.items||[]).map(i=>i.name).join(', ')}</td><td>${p.quantityLabel || (p.items||[]).map(i=>i.quantity).join(', ') || `${p.quantity} pieces`}</td><td>₹${Number(p.subtotal || p.totalCost || p.cost || 0).toFixed(2)}</td><td>${Number(p.taxPercent || 0)}% · ₹${Number(p.taxAmount || 0).toFixed(2)}</td><td>₹${Number(p.totalCost || p.cost || 0).toFixed(2)}</td><td><button class="secondary" onclick='printReceipt("Supplier purchase",${JSON.stringify(p)})'>Print</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No purchases recorded</td></tr>'}</tbody></table></div>`;
  } catch (error) {
    document.querySelector('#admin-module-content').innerHTML = `<div class="empty">${escapeDentalHtml(error.message)}</div>`;
  }
}

async function loadSuppliers() {
  const response = await fetch('/api/suppliers');
  const data = await response.json();
  document.querySelector('#admin-module-content').innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>SUPPLIER</th><th>CONTACT</th><th>PHONE</th><th>EMAIL</th><th>BRANDS</th><th>MEDICINE CATEGORIES</th></tr></thead><tbody>${data.suppliers.map(s => `<tr><td><strong>${s.name}</strong></td><td>${s.contact || '-'}</td><td>${s.phone || '-'}</td><td>${s.email || '-'}</td><td>${s.brands || '-'}</td><td>${s.categories || '-'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No suppliers recorded</td></tr>'}</tbody></table></div>`;
}

async function refreshReports() {
  const response = await fetch('/api/reports');
  const report = await response.json();
  document.querySelector('#admin-module-content').innerHTML = `<div class="stats"><div class="stat-card"><div class="stat-top"><span>Total sales</span></div><div class="stat-value">₹${Number(report.salesTotal).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div></div><div class="stat-card"><div class="stat-top"><span>Bills</span></div><div class="stat-value">${report.billCount}</div></div><div class="stat-card"><div class="stat-top"><span>Stock units</span></div><div class="stat-value">${report.stockUnits}</div></div><div class="stat-card"><div class="stat-top"><span>Stock value</span></div><div class="stat-value">₹${Number(report.stockValue).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div></div></div><div class="table-wrap" style="margin-top:20px"><table class="data-table"><thead><tr><th>MEDICINE</th><th>UNITS</th><th>VALUE</th><th>STATUS</th></tr></thead><tbody>${report.inventory.map(item => `<tr><td>${item.name}</td><td>${item.stock}</td><td>₹${item.value.toFixed(2)}</td><td>${item.stock === 0 ? 'Out of stock' : item.stock < 15 ? 'Low stock' : 'Available'}</td></tr>`).join('')}</tbody></table></div>`;
}

function openAdminModal(title, fields, submitLabel, onSubmit) {
  document.querySelector('#admin-form-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'admin-form-modal';
  modal.className = 'payment-modal';
  modal.innerHTML = `<div class="payment-card"><h2>${title}</h2>${fields.map(field => `<input id="admin-${field.id}" type="${field.type || 'text'}" class="search" style="width:100%;margin:8px 0" placeholder="${field.placeholder}">`).join('')}<button class="primary" id="admin-form-submit" style="width:100%;margin-top:8px">${submitLabel}</button><button class="secondary" style="width:100%;margin-top:8px" onclick="this.closest('.payment-modal').remove()">Cancel</button><p id="admin-form-result" class="muted"></p></div>`;
  document.body.appendChild(modal);
  document.querySelector('#admin-form-submit').onclick = () => onSubmit(modal);
  document.querySelector(`#admin-${fields[0].id}`).focus();
}

async function purchaseForm() {
  const inventory = (await (await fetch('/api/inventory')).json()).inventory || [];
  const suppliers = (await (await fetch('/api/suppliers')).json()).suppliers || [];
  document.querySelector('#admin-form-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'admin-form-modal';
  modal.className = 'payment-modal';
  modal.innerHTML = `<div class="payment-card"><h2>Receive purchase</h2><p class="muted">Every purchase is linked to a supplier. Choose an existing supplier or add a new one.</p><label>Supplier<select id="admin-supplier" class="search" style="width:100%;margin:4px 0 8px"><option value="">Select supplier...</option>${suppliers.map(supplier => `<option value="${supplier.id}">${supplier.name}</option>`).join('')}<option value="__new__">＋ New supplier</option></select></label><div id="admin-new-supplier-fields" style="display:none"><input id="admin-supplier-name" class="search" style="width:100%;margin:4px 0 8px" placeholder="New supplier name"><input id="admin-supplier-contact" class="search" style="width:100%;margin:4px 0 8px" placeholder="Contact person (optional)"><input id="admin-supplier-phone" class="search" style="width:100%;margin:4px 0 8px" placeholder="Phone (optional)"><input id="admin-supplier-email" class="search" style="width:100%;margin:4px 0 8px" placeholder="Email (optional)"><input id="admin-supplier-brands" class="search" style="width:100%;margin:4px 0 8px" placeholder="Brands sold (optional)"><input id="admin-supplier-categories" class="search" style="width:100%;margin:4px 0 8px" placeholder="Medicine categories (optional)"></div><label>Medicine<select id="admin-existing-name" class="search" style="width:100%;margin:4px 0 8px"><option value="">Select existing medicine...</option>${inventory.map(item => `<option value="${item.name}">${item.name}</option>`).join('')}<option value="__new__">＋ New medicine</option></select></label><input id="admin-name" class="search" style="width:100%;margin:4px 0 8px;display:none" placeholder="Type new medicine name"><label>Generic name (optional)<input id="admin-generic" class="search" style="width:100%;margin:4px 0 8px" placeholder="Can be left blank"></label><fieldset><legend>Quantity received</legend><div class="form-grid"><label>Boxes<input id="admin-boxes" type="number" min="0" value="0" class="search" placeholder="0"></label><label>Loose strips<input id="admin-strips" type="number" min="0" value="0" class="search" placeholder="0"></label><label>Loose pieces<input id="admin-pieces" type="number" min="0" value="0" class="search" placeholder="0"></label></div><p class="muted">Enter any combination. Leave unused quantities as 0.</p></fieldset><fieldset><legend>Pack size conversion</legend><div class="form-grid"><label>Strips in 1 box<input id="admin-strips-per-box" type="number" min="1" value="10" class="search"></label><label>Pieces in 1 strip<input id="admin-pieces-per-strip" type="number" min="1" value="10" class="search"></label></div><p class="muted">Example: 10 strips per box and 10 pieces per strip means 1 box = 100 pieces.</p></fieldset><label>Buying price per piece<input id="admin-buy-price" type="number" min="0" step="0.01" class="search" style="width:100%;margin:4px 0 8px" placeholder="₹0.00"></label><label>Tax on buying price (%)<input id="admin-tax-percent" type="number" min="0" step="0.01" value="0" class="search" style="width:100%;margin:4px 0 8px"></label><p class="muted">Tax 0% means no tax is added. Example: ₹100 subtotal + 5% tax = ₹105 total.</p><label>Selling price per piece<input id="admin-selling-price" type="number" min="0" step="0.01" class="search" style="width:100%;margin:4px 0 8px" placeholder="₹0.00"></label><button class="primary" id="admin-form-submit" style="width:100%;margin-top:8px">Receive stock</button><button class="secondary" style="width:100%;margin-top:8px" onclick="this.closest('.payment-modal').remove()">Cancel</button><p id="admin-form-result" class="muted"></p></div>`;
  document.body.appendChild(modal);
  const existing = document.querySelector('#admin-existing-name');
  const newName = document.querySelector('#admin-name');
  existing.onchange = () => { newName.style.display = existing.value === '__new__' ? 'block' : 'none'; };
  const supplierSelect = document.querySelector('#admin-supplier');
  const newSupplierFields = document.querySelector('#admin-new-supplier-fields');
  supplierSelect.onchange = () => { newSupplierFields.style.display = supplierSelect.value === '__new__' ? 'block' : 'none'; };
  document.querySelector('#admin-form-submit').onclick = async () => {
    const isNewSupplier = supplierSelect.value === '__new__';
    const input = { supplierId: isNewSupplier ? '' : supplierSelect.value, supplier: isNewSupplier ? '' : supplierSelect.options[supplierSelect.selectedIndex].textContent, name: existing.value === '__new__' ? newName.value.trim() : existing.value, generic: document.querySelector('#admin-generic').value.trim(), boxes: document.querySelector('#admin-boxes').value, strips: document.querySelector('#admin-strips').value, pieces: document.querySelector('#admin-pieces').value, stripsPerBox: document.querySelector('#admin-strips-per-box').value, piecesPerStrip: document.querySelector('#admin-pieces-per-strip').value, buyPrice: document.querySelector('#admin-buy-price').value, taxPercent: document.querySelector('#admin-tax-percent').value, sellingPrice: document.querySelector('#admin-selling-price').value };
    const result = modal.querySelector('#admin-form-result');
    if (!supplierSelect.value || !input.name) { result.textContent = 'Supplier and medicine are required'; return; }
    if (isNewSupplier) {
      input.supplier = document.querySelector('#admin-supplier-name').value.trim();
      if (!input.supplier) { result.textContent = 'New supplier name is required'; return; }
      const supplierResponse = await fetch('/api/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: input.supplier, contact: document.querySelector('#admin-supplier-contact').value.trim(), phone: document.querySelector('#admin-supplier-phone').value.trim(), email: document.querySelector('#admin-supplier-email').value.trim(), brands: document.querySelector('#admin-supplier-brands').value.trim(), categories: document.querySelector('#admin-supplier-categories').value.trim() }) });
      const supplierData = await supplierResponse.json();
      if (!supplierResponse.ok || !supplierData.ok) { result.textContent = supplierData.error || 'Could not save supplier'; return; }
      input.supplierId = supplierData.supplier.id;
    }
    const response = await fetch('/api/purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const data = await response.json();
    if (!response.ok || !data.ok) { result.textContent = data.error || 'Could not receive purchase'; return; }
    modal.remove();
    loadPurchases();
  };
}

function supplierForm() {
  openAdminModal('Add supplier', [{ id: 'name', placeholder: 'Supplier name' }, { id: 'contact', placeholder: 'Contact person' }, { id: 'phone', placeholder: 'Phone' }, { id: 'email', placeholder: 'Email' }, { id: 'brands', placeholder: 'Brands they sell (for example: Cipla, Abbott)' }, { id: 'categories', placeholder: 'Medicine categories (for example: antibiotics, diabetes)' }], 'Save supplier', async modal => {
    const input = Object.fromEntries(['name', 'contact', 'phone', 'email', 'brands', 'categories'].map(id => [id, document.querySelector(`#admin-${id}`).value.trim()]));
    const result = modal.querySelector('#admin-form-result');
    if (!input.name) { result.textContent = 'Supplier name is required'; return; }
    const response = await fetch('/api/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const data = await response.json();
    if (!response.ok || !data.ok) { result.textContent = data.error || 'Could not save supplier'; return; }
    modal.remove();
    loadSuppliers();
  });
}

function adminList(view, selectedDate = '') {
  if (view === 'bills') {
    fetch('/api/state', { cache: 'no-store' }).then(response => response.json()).then(state => {
      const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const today = new Date();
      const todayKey = dayKey(today);
      const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
      const activeDate = selectedDate || todayKey;
      const bills = Array.isArray(state.transactions) ? state.transactions.filter(t => dayKey(new Date(t.createdAt)) === activeDate) : [];
      const totals = { Cash: 0, UPI: 0, Card: 0 };
      bills.forEach(bill => { const method = String(bill.payment || 'Cash'); if (totals[method] !== undefined) totals[method] += Number(bill.amount) || 0; });
      const total = bills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);
      const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
      document.querySelector('#app').innerHTML = `<div class="content"><div class="page-heading"><div><h1>Bills</h1><p>Sales for the selected date.</p></div><div class="top-actions"><button class="secondary" onclick="downloadExcel('bills')">⇩ Excel</button><a class="secondary" href="#" data-admin-view="dashboard">← Back to dashboard</a></div></div><div class="filters"><label class="date-filter">Date <input id="bills-date" type="date" value="${activeDate}"></label><button class="filter ${activeDate === todayKey ? 'active' : ''}" data-bills-date="${todayKey}">Today</button><button class="filter ${activeDate === dayKey(yesterday) ? 'active' : ''}" data-bills-date="${dayKey(yesterday)}">Yesterday</button></div><div class="stats payment-summary"><div class="stat-card"><div class="stat-top"><span>Total sales</span></div><div class="stat-value">₹${total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div><div class="trend">${bills.length} bill${bills.length === 1 ? '' : 's'}</div></div><div class="stat-card"><div class="stat-top"><span>Cash</span></div><div class="stat-value">₹${totals.Cash.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div></div><div class="stat-card"><div class="stat-top"><span>UPI</span></div><div class="stat-value">₹${totals.UPI.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div></div><div class="stat-card"><div class="stat-top"><span>Card</span></div><div class="stat-value">₹${totals.Card.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div></div></div><div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>INVOICE</th><th>DATE</th><th>BRANCH</th><th>CUSTOMER</th><th>PATIENT SOURCE</th><th>MEDICINES</th><th>EMPLOYEE</th><th>AMOUNT</th><th>PAYMENT</th></tr></thead><tbody>${bills.map(t => `<tr><td>${safe(t.invoice)}</td><td>${safe(new Date(t.createdAt).toLocaleString('en-IN'))}</td><td>${safe(t.branch)}</td><td>${safe(t.customer)}<br><span class="muted">${safe(t.phone || '')}</span></td><td>${t.patientSource === 'DOCTOR_REFERRAL' ? `Doctor referral${t.doctor ? `: ${safe(t.doctor)}` : ''}` : 'Walk-in'}</td><td>${(t.items || []).map(item => `${safe(item.name)} × ${Number(item.quantity) || 0}`).join('<br>') || '-'}</td><td>${safe(t.employee || '-')}</td><td>₹${Number(t.amount || 0).toFixed(2)}</td><td>${safe(t.payment || 'Cash')}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No bills for this date</td></tr>'}</tbody></table></div></div></div>`;
      document.querySelector('#bills-date').onchange = event => adminList('bills', event.target.value);
      document.querySelectorAll('[data-bills-date]').forEach(button => { button.onclick = () => adminList('bills', button.dataset.billsDate); });
    });
  } else renderAdminList(view);
}
