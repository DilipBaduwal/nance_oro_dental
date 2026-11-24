async function loadMedicineRequests() {
  const response = await fetch('/api/medicine-requests?buyingPrices=1');
  const data = await response.json();
  if (!response.ok) return `<p role="status">${escapeDentalHtml(data.error || 'Could not load deliveries.')}</p>`;
  return `<div class="panel request-approval-panel" style="margin-top:16px">
    <h3>Staff medicine requests</h3>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>MEDICINE</th><th>SUPPLIER</th><th>DELIVERED</th><th>QTY</th><th>BUYING PRICE/PIECE</th><th>MRP/PIECE</th><th>DISCOUNT</th><th>FINAL SELLING/PIECE</th><th>TOTAL SELLING</th><th>EXPIRY</th><th>RECORDED BY</th><th>STATUS / ACTION</th></tr></thead>
      <tbody>${data.requests.map(request => {
        const quantity = Number(request.quantity) || 0;
        const mrp = Number(request.price) || 0;
        const discount = Number(request.discountPercent) || 0;
        const finalPrice = mrp * (1 - discount / 100);
        return `<tr>
        <td>${escapeDentalHtml(request.name)}</td><td>${escapeDentalHtml(request.supplier || '-')}</td>
        <td>${escapeDentalHtml(request.deliveryDate || request.createdAt?.slice(0, 10) || '-')}</td>
        <td>${quantity}</td>
        <td>${request.status === 'PENDING' || (request.status === 'APPROVED' && request.batchId) ? `
          <input class="search" data-buying-price type="number" min="0" max="9999999999.99" step="0.01"
            style="min-width:0;width:110px" aria-label="Buying price per piece" placeholder="Optional"
            value="${request.buyingPrice == null ? '' : Number(request.buyingPrice).toFixed(2)}">
          ${request.status === 'APPROVED' ? `<button class="secondary" data-delivery-id="${escapeDentalHtml(request.id)}"
            onclick="submitMedicineRequestAction(this)">Save price</button>` : ''}
        ` : '-'}</td>
        <td>&#8377;${mrp.toFixed(2)}</td><td>${discount}%</td>
        <td>&#8377;${finalPrice.toFixed(2)}</td><td>&#8377;${(quantity * finalPrice).toFixed(2)}</td>
        <td>${escapeDentalHtml(request.expiryDate || '-')}</td>
        <td>${escapeDentalHtml(request.requestedBy || '-')}</td>
        <td>${request.status === 'PENDING' ? `
          <button class="primary" data-delivery-id="${escapeDentalHtml(request.id)}" onclick="submitMedicineRequestAction(this, true)">Approve</button>
          <button class="secondary" data-delivery-id="${escapeDentalHtml(request.id)}" onclick="submitMedicineRequestAction(this, false)">Reject</button>` : escapeDentalHtml(request.status)}</td>
      </tr>`; }).join('') || '<tr><td colspan="12">No requests yet.</td></tr>'}</tbody>
    </table></div></div>`;
}

async function submitMedicineRequestAction(button, approved) {
  const priceOnly = approved === undefined;
  const row = button.closest('tr');
  const price = row.querySelector('[data-buying-price]');
  const body = { id: button.dataset.deliveryId, approved };
  if (priceOnly || approved) {
    if (priceOnly && !price.value.trim()) {
      price.focus();
      return;
    }
    if (!price.reportValidity()) return;
    if (price.value !== '') body.buyingPrice = price.value;
  }
  const buttons = row.querySelectorAll('button');
  buttons.forEach(item => { item.disabled = true; });
  try {
    const response = await fetch(priceOnly ? '/api/medicine-requests/buying-price' : '/api/medicine-requests/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not review delivery.');
    if (priceOnly) {
      price.value = Number(data.buyingPrice).toFixed(2);
    } else {
      await loadPurchases();
    }
  } catch (error) {
    alert(error.message);
  } finally {
    buttons.forEach(item => { item.disabled = false; });
  }
}

const originalLoadPurchases=loadPurchases;
loadPurchases=async function(){
  await originalLoadPurchases(); const app=document.querySelector('#admin-module-content')||document.querySelector('#app'); if(!app)return;
  const panel=document.createElement('div'); panel.innerHTML=await loadMedicineRequests(); app.appendChild(panel.firstElementChild);
};
