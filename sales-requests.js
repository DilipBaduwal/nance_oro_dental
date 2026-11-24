const oldRenderSalesApp = renderSalesApp;
renderSalesApp = function(){ oldRenderSalesApp(); const head=document.querySelector('.staff-billing-screen .page-heading'); if(head&&!document.querySelector('#staff-actions')){const box=document.createElement('div');box.id='staff-actions';box.innerHTML='<button class="secondary" onclick="staffMedicineRequest()">＋ Request medicine</button> <button class="secondary" onclick="staffRecentBills()">Recent bills</button> <button class="secondary" onclick="printLatestStaffBill()">Print latest bill</button>';head.appendChild(box);} };
async function staffRecentBills(){const d=await (await fetch('/api/state')).json(),cut=Date.now()-7*86400000,rows=(d.transactions||[]).filter(t=>new Date(t.createdAt).getTime()>=cut&&t.employee===salesUser.name);const modal=document.createElement('div');modal.className='payment-modal';modal.innerHTML=`<div class="payment-card"><h2>Recent bills · Last 7 days</h2>${rows.map((t,i)=>`<div class="cart-row"><span>${t.invoice}<br><small>${t.customer} · ₹${Number(t.amount).toFixed(2)}</small></span><button class="secondary" onclick='printReceipt("Sales bill",${JSON.stringify(t).replaceAll("'","\\'")})'>Print</button></div>`).join('')||'<p class="muted">No bills in the last 7 days.</p>'}<button class="secondary" onclick="this.closest(\'.payment-modal\').remove()">Close</button></div>`;document.body.appendChild(modal)}
function printCurrentBill(){window.print()}
async function printLatestStaffBill(){const d=await (await fetch('/api/state')).json(),cut=Date.now()-7*86400000,t=(d.transactions||[]).find(x=>new Date(x.createdAt).getTime()>=cut&&x.employee===salesUser.name);if(!t)return alert('No bill in the last 7 days.');printReceipt('Sales bill',t)}

staffRecentBills=async function(){const d=await (await fetch('/api/state')).json(),cut=Date.now()-7*86400000,all=(d.transactions||[]).filter(t=>new Date(t.createdAt).getTime()>=cut&&t.employee===salesUser.name);document.querySelector('#app').innerHTML=`<div class="content"><div class="page-heading"><div><h1>Recent bills</h1><p>Only the last 7 days are available.</p></div><button class="secondary" onclick="renderSalesApp()">← Back to billing</button></div><div class="filters"><label>From <input id="bill-from" type="date"></label><label>To <input id="bill-to" type="date"></label><input id="bill-search" class="search" placeholder="Search customer, mobile, or invoice"></div><div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>INVOICE</th><th>DATE</th><th>CUSTOMER</th><th>MOBILE</th><th>AMOUNT</th><th>PRINT</th></tr></thead><tbody id="recent-bill-rows"></tbody></table></div></div></div>`;const draw=()=>{const q=document.querySelector('#bill-search').value.toLowerCase(),from=document.querySelector('#bill-from').value,to=document.querySelector('#bill-to').value;const rows=all.filter(t=>(!from||t.createdAt.slice(0,10)>=from)&&(!to||t.createdAt.slice(0,10)<=to)&&(`${t.invoice} ${t.customer} ${t.phone}`.toLowerCase().includes(q)));document.querySelector('#recent-bill-rows').innerHTML=rows.map(t=>`<tr><td>${t.invoice}</td><td>${new Date(t.createdAt).toLocaleString('en-IN')}</td><td>${t.customer}</td><td>${t.phone||'-'}</td><td>₹${Number(t.amount).toFixed(2)}</td><td><button class="secondary" onclick='printReceipt("Sales bill",${JSON.stringify(t).replaceAll("'","\\'")})'>Print</button></td></tr>`).join('')||'<tr><td colspan="6">No bills found</td></tr>'};['bill-from','bill-to','bill-search'].forEach(id=>document.querySelector('#'+id).oninput=draw);draw()};

function escapeDeliveryHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

async function staffDeliveryApi(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Could not complete the request.');
  return data;
}

function staffDeliveryPost(path, body) {
  return staffDeliveryApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function staffMedicineRequest() {
  const app = document.querySelector('#app');
  app.innerHTML = `<div class="content" style="max-width:1250px;margin:auto;overflow:hidden">
    <div class="page-heading">
      <div><h1>Request inventory</h1><p>Submit new medicines for Admin approval.</p></div>
      <div class="top-actions"><span class="muted" role="status" id="staff-refresh-status"></span><button class="secondary" type="button" id="refresh-staff-requests">Refresh</button><button class="secondary" onclick="renderSalesApp()">&#8592; Back to billing</button></div>
    </div>
    <div class="grid">
      <div class="panel" style="overflow:hidden"><h3>Current inventory</h3>
        <div style="overflow-x:auto"><table class="data-table"><tbody id="request-inventory"></tbody></table></div>
      </div>
      <div class="panel" style="overflow:hidden"><h3>Suppliers</h3>
        <div style="overflow-x:auto"><table class="data-table"><tbody id="request-suppliers"></tbody></table></div>
      </div>
    </div>
    <div class="panel" style="overflow:hidden"><h3>New medicine request</h3>
      <form id="staff-delivery-form">
        <div class="form-grid">
          <input name="name" id="req-name" class="search" placeholder="Medicine name" aria-label="Medicine name" required>
          <input name="generic" class="search" placeholder="Generic name" aria-label="Generic name">
          <select name="supplierId" id="req-supplier" class="search" aria-label="Supplier" required disabled>
            <option value="">Select supplier</option><option value="__NEW__">+ Add new supplier</option>
          </select>
          <input name="boxes" type="number" min="0" class="search" placeholder="Boxes" aria-label="Boxes">
          <input name="strips" type="number" min="0" class="search" placeholder="Strips" aria-label="Strips">
          <input name="pieces" type="number" min="0" class="search" placeholder="Pieces" aria-label="Pieces">
          <input name="stripsPerBox" type="number" min="1" class="search" placeholder="Strips per box" aria-label="Strips per box">
          <input name="piecesPerStrip" type="number" min="1" class="search" placeholder="Pieces per strip" aria-label="Pieces per strip">
          <label>Delivery date<input name="deliveryDate" type="date" class="search" required></label>
          <input name="price" type="number" min="0" step="0.01" class="search" placeholder="MRP / selling price per piece" aria-label="MRP or selling price per piece">
          <input name="discountPercent" type="number" min="0" max="100" step="0.01" class="search" placeholder="Discount %" aria-label="Discount percentage">
          <label>Expiry date<input name="expiryDate" type="date" class="search"></label>
        </div>
        <p id="req-price-preview" class="muted"></p>
        <button class="primary" type="submit">Send for approval</button>
        <p id="delivery-status" class="muted" role="status">Loading suppliers...</p>
      </form>
    </div>
    <div class="panel" style="overflow:hidden"><h3>My requests</h3>
      <div style="overflow-x:auto"><table class="data-table">
        <thead><tr><th>MEDICINE</th><th>QTY</th><th>SUPPLIER</th><th>DELIVERED</th><th>STATUS</th></tr></thead>
        <tbody id="staff-delivery-history"></tbody>
      </table></div>
    </div>
  </div>`;
  const status = app.querySelector('#delivery-status');
  const form = app.querySelector('#staff-delivery-form');
  const select = form.elements.supplierId;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  const history = app.querySelector('#staff-delivery-history');
  const today = new Date();
  const date = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  form.elements.deliveryDate.defaultValue = date;
  const inventoryRows = app.querySelector('#request-inventory');
  const supplierRows = app.querySelector('#request-suppliers');
  const preview = app.querySelector('#req-price-preview');
  const refreshPreview = () => {
    const number = name => Number(form.elements[name].value) || 0;
    const discount = Math.max(0, Math.min(100, number('discountPercent')));
    const boxes = number('boxes');
    const strips = number('strips');
    const perBox = number('stripsPerBox');
    const perStrip = number('piecesPerStrip');
    form.elements.stripsPerBox.required = boxes > 0;
    form.elements.piecesPerStrip.required = boxes > 0 || strips > 0;
    const needsPerBox = boxes > 0 && perBox < 1;
    const needsPerStrip = (boxes > 0 || strips > 0) && perStrip < 1;
    if (needsPerBox || needsPerStrip) {
      const missing = [needsPerBox && 'strips per box', needsPerStrip && 'pieces per strip'].filter(Boolean);
      preview.textContent = 'Enter ' + missing.join(' and ') + ' to calculate total pieces.';
      return;
    }
    const quantity = boxes * perBox * perStrip + strips * perStrip + number('pieces');
    const price = number('price') * (1 - discount / 100);
    preview.textContent = `Discount: ${discount}% \u00b7 Final selling price per piece: \u20b9${price.toFixed(2)} \u00b7 Total selling price: \u20b9${(quantity * price).toFixed(2)} (${quantity} pieces \u00d7 \u20b9${price.toFixed(2)})`;
  };
  form.addEventListener('input', refreshPreview);
  refreshPreview();

  const refreshInventory = async () => {
    try {
      const { inventory } = await staffDeliveryApi('/api/inventory');
      inventoryRows.innerHTML = inventory.map(item => {
        const price = Number(item.price) || 0;
        const discount = Number(item.discountPercent);
        const mrp = discount > 0 && discount < 100 ? ` <small>(MRP &#8377;${(price / (1 - discount / 100)).toFixed(2)})</small>` : '';
        return `<tr><td>${escapeDeliveryHtml(item.name)}</td><td>${Number(item.stock) || 0} pieces</td><td>&#8377;${price.toFixed(2)}${mrp}<br><small>Expiry: ${escapeDeliveryHtml(item.expiryDate || 'Not set')}</small></td></tr>`;
      }).join('');
    } catch (error) {
      inventoryRows.innerHTML = `<tr><td>${escapeDeliveryHtml(error.message)}</td></tr>`;
      throw error;
    }
  };
  const refreshHistory = async () => {
    try {
      const { requests } = await staffDeliveryApi('/api/medicine-requests');
      const label = request => request.status === 'PENDING' ? 'Waiting for approval' :
        `${request.status === 'APPROVED' ? 'Approved' : 'Rejected'} on ${new Date(request.reviewedAt || request.createdAt).toLocaleString('en-IN')}`;
      history.innerHTML = requests.map(request => `<tr><td>${escapeDeliveryHtml(request.name)}</td>
        <td>${Number(request.quantity) || 0}</td><td>${escapeDeliveryHtml(request.supplier || '-')}</td>
        <td>${escapeDeliveryHtml(request.deliveryDate || request.createdAt?.slice(0, 10) || '-')}</td>
        <td>${escapeDeliveryHtml(label(request))}</td></tr>`).join('') || '<tr><td colspan="5">No requests yet.</td></tr>';
    } catch (error) {
      history.innerHTML = `<tr><td colspan="5">${escapeDeliveryHtml(error.message)}</td></tr>`;
      throw error;
    }
  };
  const addSupplier = supplier => {
    select.add(new Option(supplier.name, supplier.id));
    supplierRows.querySelector('[data-empty]')?.remove();
    const [name, contact] = [supplier.name, supplier.phone || supplier.contact || supplier.contact_name || '-'];
    const row = supplierRows.insertRow();
    row.insertCell().textContent = name;
    row.insertCell().textContent = contact;
  };
  const refreshSuppliers = async () => {
    const { suppliers } = await staffDeliveryApi('/api/suppliers');
    for (const supplier of suppliers) {
      if (!Array.from(select.options).some(option => option.value === supplier.id)) addSupplier(supplier);
    }
    if (select.disabled) {
      select.disabled = false;
      submit.disabled = false;
      status.textContent = '';
    }
    if (!supplierRows.rows.length) supplierRows.innerHTML = '<tr data-empty><td>No suppliers</td></tr>';
  };
  const refresh = app.querySelector('#refresh-staff-requests');
  const refreshStatus = app.querySelector('#staff-refresh-status');
  const refreshRequestTables = async (manual = false) => {
    refresh.disabled = true;
    refreshStatus.textContent = manual ? 'Refreshing...' : '';
    try {
      const results = await Promise.allSettled([refreshSuppliers(), refreshInventory(), refreshHistory()]);
      const supplierResult = results[0];
      if (supplierResult.status === 'rejected' && select.disabled) {
        status.textContent = supplierResult.reason.message;
        supplierRows.innerHTML = '<tr data-empty><td>Could not load suppliers</td></tr>';
      }
      if (manual) refreshStatus.textContent = results.some(result => result.status === 'rejected')
        ? 'Some data could not be refreshed. Try again.' : 'Updated.';
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.onclick = () => refreshRequestTables(true);
  void refreshRequestTables();
  select.onchange = () => {
    if (select.value === '__NEW__') {
      select.value = '';
      openStaffSupplierForm(supplier => {
        if (!Array.from(select.options).some(option => option.value === supplier.id)) addSupplier(supplier);
        select.value = supplier.id;
      });
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      await staffDeliveryPost('/api/medicine-requests', body);
      form.reset();
      refreshPreview();
      status.textContent = 'Delivery sent for approval.';
    } catch (error) {
      status.textContent = error.message;
      return;
    } finally {
      button.disabled = false;
    }
    await refreshHistory().catch(() => {});
  };
}

function openStaffSupplierForm(onSaved) {
  const modal = document.createElement('div');
  modal.className = 'payment-modal';
  modal.innerHTML = `<form class="payment-card">
    <button type="button" class="secondary" aria-label="Close" style="float:right" data-close>&times;</button>
    <h2>Add supplier</h2>
    <input name="name" class="search" placeholder="Supplier name" aria-label="Supplier name" required>
    <input name="contact" class="search" placeholder="Contact person (optional)" aria-label="Contact person">
    <input name="phone" class="search" placeholder="Phone number (optional)" aria-label="Phone number">
    <input name="email" type="email" class="search" placeholder="Email (optional)" aria-label="Email">
    <input name="brands" class="search" placeholder="Brands supplied (optional)" aria-label="Brands supplied">
    <input name="categories" class="search" placeholder="Medicine categories (optional)" aria-label="Medicine categories">
    <p role="status"></p>
    <button class="primary" type="submit">Save supplier</button>
    <button class="secondary" type="button">Cancel</button>
  </form>`;
  document.body.appendChild(modal);
  const form = modal.querySelector('form');
  form.elements.name.focus();
  form.querySelectorAll('[type=button]').forEach(button => { button.onclick = () => modal.remove(); });
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const { supplier } = await staffDeliveryPost('/api/suppliers', Object.fromEntries(new FormData(form)));
      onSaved(supplier);
      modal.remove();
    } catch (error) {
      form.querySelector('[role=status]').textContent = error.message;
      button.disabled = false;
    }
  };
}
