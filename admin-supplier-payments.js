function escapeSupplierHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function supplierDate(value) {
  return value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-';
}

function showSupplierTransactionsById(encodedId) {
  const supplier = window.supplierRows?.[decodeURIComponent(encodedId)];
  if (supplier) showSupplierTransactions(supplier);
}

function showSupplierTransactions(supplier) {
  document.querySelector('#supplier-transactions-modal')?.remove();
  const payments = supplier.payments || [];
  const deliveries = supplier.deliveryHistory || [];
  const bills = supplier.bills || [];
  const encodedId = encodeURIComponent(supplier.id);
  const modal = document.createElement('div');
  modal.id = 'supplier-transactions-modal';
  modal.className = 'payment-modal';
  modal.style.cssText = 'z-index:50;place-items:center;padding:20px';
  modal.innerHTML = `
    <div class="payment-card" style="width:min(760px,100%);max-height:calc(100vh - 40px)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <h2>Supplier deliveries and payments</h2>
          <p class="muted" style="margin:0">${escapeSupplierHtml(supplier.name)}</p>
        </div>
        <button class="secondary" aria-label="Close" style="min-width:42px;padding:8px 12px;font-size:22px" onclick="this.closest('.payment-modal').remove()">×</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0">
        <div><small class="muted">Total purchases</small><strong style="display:block">₹${Number(supplier.purchased || 0).toFixed(2)}</strong></div>
        <div><small class="muted">Paid</small><strong style="display:block;color:var(--green)">₹${Number(supplier.paid || 0).toFixed(2)}</strong></div>
        <div><small class="muted">Total due</small><strong style="display:block;color:${supplier.outstanding ? 'var(--red)' : 'var(--green)'}">₹${Number(supplier.outstanding || 0).toFixed(2)}</strong></div>
      </div>
      <h3>Deliveries</h3>
      ${deliveries.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>DELIVERED</th><th>MEDICINE</th><th>QUANTITY</th><th>STATUS</th></tr></thead><tbody>${deliveries.map(delivery => `<tr><td>${escapeSupplierHtml(delivery.deliveryDate || delivery.createdAt?.slice(0, 10) || '-')}</td><td>${escapeSupplierHtml(delivery.name)}</td><td>${Number(delivery.quantity) || 0}</td><td>${escapeSupplierHtml(delivery.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No staff deliveries recorded.</p>'}
      <h3>Supplier bills</h3>
      ${bills.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>BILL NUMBER</th><th>RECORDED</th><th>TOTAL</th><th>PAID</th><th>PENDING</th><th>ACTION</th></tr></thead>
        <tbody>${bills.map(bill => `<tr>
          <td>${escapeSupplierHtml(bill.reference || '-')}</td><td>${supplierDate(bill.createdAt)}</td>
          <td>&#8377;${Number(bill.total).toFixed(2)}</td><td>&#8377;${Number(bill.paid).toFixed(2)}</td>
          <td>&#8377;${Number(bill.pending).toFixed(2)}</td><td>${bill.pending > 0 ? `<button class="secondary"
            data-supplier="${encodedId}" data-bill="${escapeSupplierHtml(bill.id)}"
            onclick="recordSupplierPayment(this.dataset.supplier, this.dataset.bill)">Record payment</button>` : 'Paid'}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No supplier bills recorded.</p>'}
      <h3>Payments</h3>
      ${payments.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>DATE & TIME</th><th>AMOUNT</th><th>METHOD</th><th>REFERENCE</th></tr></thead><tbody>${payments.map(payment => `<tr><td>${supplierDate(payment.createdAt)}</td><td><strong>₹${Number(payment.amount || 0).toFixed(2)}</strong></td><td>${escapeSupplierHtml(payment.method || 'Cash')}</td><td>${escapeSupplierHtml(payment.reference || '-')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No payments recorded for this supplier.</div>'}
      <button class="secondary" style="width:100%;margin-top:16px" onclick="this.closest('.payment-modal').remove()">Close</button>
    </div>`;
  document.body.appendChild(modal);
}

async function loadSuppliers() {
  const [response, deliveriesResponse] = await Promise.all([
    fetch('/api/suppliers'), fetch('/api/medicine-requests')
  ]);
  const [data, deliveries] = await Promise.all([response.json(), deliveriesResponse.json()]);
  if (!response.ok || !deliveriesResponse.ok) {
    document.querySelector('#admin-module-content').textContent = data.error || deliveries.error || 'Could not load suppliers.';
    return;
  }
  for (const supplier of data.suppliers) {
    supplier.deliveryHistory = deliveries.requests.filter(delivery =>
      delivery.supplierId === supplier.id || (!delivery.deliveryDate && delivery.supplier === supplier.name)
    );
  }
  window.supplierRows = Object.fromEntries((data.suppliers || []).map(supplier => [supplier.id, supplier]));
  document.querySelector('#admin-module-content').innerHTML = `
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>SUPPLIER</th><th>CONTACT</th><th>TOTAL PURCHASES</th><th>PAID</th><th>TOTAL DUE</th><th>ACTION</th></tr></thead>
      <tbody>${(data.suppliers || []).map(supplier => {
        const encodedId = encodeURIComponent(supplier.id);
        return `<tr>
          <td><strong>${escapeSupplierHtml(supplier.name)}</strong></td>
          <td>${escapeSupplierHtml(supplier.phone || supplier.contact || '-')}</td>
          <td>₹${Number(supplier.purchased || 0).toFixed(2)}</td>
          <td>₹${Number(supplier.paid || 0).toFixed(2)}</td>
          <td style="color:${supplier.outstanding ? 'var(--red)' : 'var(--green)'}">₹${Number(supplier.outstanding || 0).toFixed(2)}</td>
          <td><div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="secondary" onclick="showSupplierTransactionsById('${encodedId}')">Deliveries and payments</button>
            <button class="primary" onclick="openSupplierBill('${encodedId}')">Record bill</button>
            <button class="secondary" onclick="setSupplierDue('${encodedId}')">Set amount due</button>
            <button class="secondary" onclick="recordSupplierPayment('${encodedId}')">Record payment</button>
          </div></td>
        </tr>`;
      }).join('') || '<tr><td colspan="6" class="empty">No suppliers recorded</td></tr>'}</tbody>
    </table></div>`;
}

function openSupplierBill(encodedId) {
  const supplier = window.supplierRows?.[decodeURIComponent(encodedId)];
  if (!supplier) return;
  const billId = crypto.randomUUID();
  const modal = document.createElement('div');
  modal.className = 'payment-modal';
  modal.innerHTML = `<form class="payment-card" aria-label="Record supplier bill">
    <h2>Record supplier bill</h2>
    <p class="muted">${escapeSupplierHtml(supplier.name)}</p>
    <label>Supplier bill number (optional)<input class="search" name="reference" maxlength="120"></label>
    <label>Bill total (&#8377;)<input class="search" name="total" type="number" min="0.01" max="9999999999.99" step="0.01" required></label>
    <label>Amount paid (&#8377;)<input class="search" name="paidAmount" type="number" min="0" step="0.01" value="0" required></label>
    <p>Pending balance <strong data-pending aria-live="polite"></strong></p>
    <p class="muted" role="status"></p>
    <button class="primary" type="submit">Save bill</button>
    <button class="secondary" type="button">Cancel</button>
  </form>`;
  document.body.appendChild(modal);
  const form = modal.querySelector('form');
  const { total, paidAmount } = form.elements;
  const preview = () => {
    const valid = total.value !== '' && Number(paidAmount.value) <= Number(total.value);
    paidAmount.setCustomValidity(total.value && !valid ? 'Amount paid cannot exceed the bill total.' : '');
    form.querySelector('[data-pending]').textContent = valid
      ? '?' + (Number(total.value) - Number(paidAmount.value)).toFixed(2) : '-';
  };
  preview();
  form.addEventListener('input', preview);
  total.focus();
  form.querySelector('[type=button]').onclick = () => modal.remove();
  form.onsubmit = async event => {
    event.preventDefault();
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const response = await fetch('/api/suppliers/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), supplierId: supplier.id, billId })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not save bill.');
      modal.remove();
    } catch (error) {
      form.querySelector('[role=status]').textContent = error.message;
      submit.disabled = false;
      return;
    }
    await loadSuppliers();
  };
}

async function setSupplierDue(encodedId) {
  const supplier = window.supplierRows?.[decodeURIComponent(encodedId)];
  if (!supplier) return;
  const amount = prompt(`Current amount due to ${supplier.name}`, String(supplier.outstanding || 0));
  if (amount === null || amount.trim() === '') return;
  const response = await fetch('/api/suppliers/due', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplierId: supplier.id, amount })
  });
  const result = await response.json();
  if (!result.ok) return alert(result.error);
  await loadSuppliers();
}

async function recordSupplierPayment(encodedId, billId) {
  const supplier = window.supplierRows?.[decodeURIComponent(encodedId)];
  if (!supplier) return;
  const { id, name } = supplier;
  const bill = supplier.bills?.find(item => item.id === billId);
  const amount = prompt(`Payment amount for ${name}`, bill ? String(bill.pending) : '');
  if (!amount) return;
  const method = prompt('Payment method: Cash, UPI, Card, or Bank transfer', 'Cash');
  if (!method) return;
  const reference = prompt('Payment reference (optional)', '');
  const response = await fetch('/api/suppliers/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplierId: id, amount, method, reference, billId })
  });
  const result = await response.json();
  if (!result.ok) return alert(result.error);
  const historyOpen = document.querySelector('#supplier-transactions-modal');
  await loadSuppliers();
  if (historyOpen?.isConnected) showSupplierTransactionsById(encodedId);
}
