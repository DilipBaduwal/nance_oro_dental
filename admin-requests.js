async function loadMedicineRequests(){
  const d=await (await fetch('/api/medicine-requests')).json();
  const requests=d.requests||[];
  const status=r=>r.status==='PENDING'?'Waiting for approval':`${r.status==='APPROVED'?'Approved':'Rejected'} on ${new Date(r.reviewedAt||r.createdAt).toLocaleString('en-IN')}`;
  return `<div class="panel request-approval-panel" style="margin-top:16px;overflow:hidden"><h3>Staff medicine requests</h3><div style="overflow-x:auto"><table class="data-table"><thead><tr><th>MEDICINE</th><th>SUPPLIER</th><th>QTY</th><th>PURCHASE</th><th>MRP/PIECE</th><th>DISCOUNT</th><th>FINAL SELLING/PIECE</th><th>TOTAL SELLING</th><th>EXPIRY</th><th>REQUESTED BY</th><th>STATUS / ACTION</th></tr></thead><tbody>${requests.map(r=>{const quantity=Number(r.quantity||0);const mrp=Number(r.price||0);const discount=Math.max(0,Math.min(100,Number(r.discountPercent)||0));const finalPrice=mrp*(1-discount/100);const totalSelling=quantity*finalPrice;return `<tr><td>${r.name}</td><td>${r.supplier||'-'}</td><td>${quantity}</td><td>₹${Number(r.purchaseTotal||0).toFixed(2)}</td><td>₹${mrp.toFixed(2)}</td><td>${discount.toFixed(2).replace(/\.00$/,'')}%</td><td>₹${finalPrice.toFixed(2)}</td><td>₹${totalSelling.toFixed(2)}</td><td>${r.expiryDate||'-'}</td><td>${r.requestedBy||'-'}</td><td>${r.status==='PENDING'?`<button class="primary" onclick="reviewMedicineRequest('${r.id}',true)">Approve</button> <button class="secondary" onclick="reviewMedicineRequest('${r.id}',false)">Reject</button>`:`<span class="muted">${status(r)}</span>`}</td></tr>`}).join('')||'<tr><td colspan="11">No requests yet.</td></tr>'}</tbody></table></div></div>`;
}
async function reviewMedicineRequest(id,approved){
  const r=await fetch('/api/medicine-requests/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,approved})});
  const d=await r.json(); if(!d.ok)return alert(d.error);
  alert(approved?'Approved and added to Purchases/inventory':'Request rejected'); await loadPurchases();
}
const originalLoadPurchases=loadPurchases;
loadPurchases=async function(){
  await originalLoadPurchases(); const app=document.querySelector('#admin-module-content')||document.querySelector('#app'); if(!app)return;
  const panel=document.createElement('div'); panel.innerHTML=await loadMedicineRequests(); app.appendChild(panel.firstElementChild);
};
