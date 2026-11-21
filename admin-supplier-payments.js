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
  const modal = document.createElement('div');
  modal.id = 'supplier-transactions-modal';
  modal.className = 'payment-modal';
  modal.style.cssText = 'z-index:50;place-items:center;padding:20px';
  modal.innerHTML = `
    <div class="payment-card" style="width:min(760px,100%);max-height:calc(100vh - 40px)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <h2>Payment transactions</h2>
          <p class="muted" style="margin:0">${escapeSupplierHtml(supplier.name)}</p>
        </div>
        <button class="secondary" aria-label="Close" style="min-width:42px;padding:8px 12px;font-size:22px" onclick="this.closest('.payment-modal').remove()">×</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0">
        <div><small class="muted">Total purchases</small><strong style="display:block">₹${Number(supplier.purchased || 0).toFixed(2)}</strong></div>
        <div><small class="muted">Paid</small><strong style="display:block;color:var(--green)">₹${Number(supplier.paid || 0).toFixed(2)}</strong></div>
        <div><small class="muted">Total due</small><strong style="display:block;color:${supplier.outstanding ? 'var(--red)' : 'var(--green)'}">₹${Number(supplier.outstanding || 0).toFixed(2)}</strong></div>
      </div>
      ${payments.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>DATE & TIME</th><th>AMOUNT</th><th>METHOD</th><th>REFERENCE</th></tr></thead><tbody>${payments.map(payment => `<tr><td>${supplierDate(payment.createdAt)}</td><td><strong>₹${Number(payment.amount || 0).toFixed(2)}</strong></td><td>${escapeSupplierHtml(payment.method || 'Cash')}</td><td>${escapeSupplierHtml(payment.reference || '-')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No payments recorded for this supplier.</div>'}
      <button class="secondary" style="width:100%;margin-top:16px" onclick="this.closest('.payment-modal').remove()">Close</button>
    </div>`;
  document.body.appendChild(modal);
}

async function loadSuppliers() {
  const response = await fetch('/api/suppliers');
  const data = await response.json();
  window.supplierRows = Object.fromEntries((data.suppliers || []).map(supplier => [supplier.id, supplier]));
  document.querySelector('#admin-module-content').innerHTML = `
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>SUPPLIER</th><th>CONTACT</th><th>TOTAL PURCHASES</th><th>PAID</th><th>TOTAL DUE</th><th>ACTION</th></tr></thead>
      <tbody>${(data.suppliers || []).map(supplier => {
        const payments = supplier.payments || [];
        const encodedId = encodeURIComponent(supplier.id);
        const safeName = String(supplier.name || '').replaceAll("'", "\\'");
        return `<tr>
          <td><strong>${escapeSupplierHtml(supplier.name)}</strong></td>
          <td>${escapeSupplierHtml(supplier.phone || supplier.contact || '-')}</td>
          <td>₹${Number(supplier.purchased || 0).toFixed(2)}</td>
          <td>₹${Number(supplier.paid || 0).toFixed(2)}</td>
          <td style="color:${supplier.outstanding ? 'var(--red)' : 'var(--green)'}">₹${Number(supplier.outstanding || 0).toFixed(2)}</td>
          <td><div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="secondary" onclick="showSupplierTransactionsById('${encodedId}')">Transactions${payments.length ? ` (${payments.length})` : ''}</button>
            <button class="secondary" onclick="recordSupplierPayment('${supplier.id}','${safeName}')">Record payment</button>
          </div></td>
        </tr>`;
      }).join('') || '<tr><td colspan="6" class="empty">No suppliers recorded</td></tr>'}</tbody>
    </table></div>`;
}

async function recordSupplierPayment(id, name) {
  const amount = prompt(`Payment amount for ${name}`);
  if (!amount) return;
  const method = prompt('Payment method: Cash, UPI, Card, or Bank transfer', 'Cash');
  if (!method) return;
  const reference = prompt('Payment reference (optional)', '');
  const response = await fetch('/api/suppliers/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplierId: id, amount, method, reference })
  });
  const result = await response.json();
  if (!result.ok) return alert(result.error);
  loadSuppliers();
}
