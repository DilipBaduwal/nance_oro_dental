function printReceipt(title, inputRecord) {
  let record = inputRecord;
  if (typeof inputRecord === 'string') {
    try { record = JSON.parse(inputRecord); } catch { record = {}; }
  }
  record = record || {};
  const sale = record.sale || record.currentSale || record.transaction || {};
  record = { ...sale, ...record };
  const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const logoUrl = `${window.location.origin}/assets/nance-polyclinic-logo.jpeg`;
  const money = value => `₹${(Number(value) || 0).toFixed(2)}`;
  const first = (...values) => values.find(value => value !== undefined && value !== null && String(value).trim() !== '');
  const isPurchase = Boolean(record.supplier || record.supplierName || record.totalCost !== undefined || record.invoiceNumber);
  const party = first(isPurchase ? record.supplier : record.customer, record.supplierName, record.customerName, isPurchase ? '-' : 'Walk-in customer');
  const date = record.createdAt ? new Date(record.createdAt).toLocaleString('en-IN') : new Date().toLocaleString('en-IN');
  const invoice = first(record.invoice, record.invoiceNumber, 'Receipt');
  const payment = first(record.paymentMethod, record.payment, record.method, 'Cash');
  const total = Number(record.totalCost ?? record.amount ?? record.total ?? 0) || 0;
  const savedDoctor = first(record.doctor, record.consultant, '');
  const isReferral = record.patientSource === 'DOCTOR_REFERRAL' || (savedDoctor && !/^walk[- ]?in$/i.test(savedDoctor));
  const doctor = isReferral ? first(savedDoctor, '-') : 'Walk-in';
  const ageGender = first(record.ageGender, record.age, '');
  const opd = first(record.opdNumber, record.opd, record.uhid, '');
  const items = (Array.isArray(record.items) && record.items.length ? record.items
    : Array.isArray(record.saleItems) && record.saleItems.length ? record.saleItems
    : Array.isArray(record.lineItems) && record.lineItems.length ? record.lineItems
    : Array.isArray(record.products) && record.products.length ? record.products
    : [{ name: first(record.medicineName, record.productName, record.name, record.medicine, '-'), quantity: record.quantity || 1, batchNumber: record.batchNumber || '', sellingPrice: record.sellingPrice ?? record.price ?? record.amount ?? total, amount: record.amount ?? total }]).slice(0, 15);
  const rows = items.map((item, index) => {
    const quantity = Number(item.quantity ?? item.qty ?? item.pieces ?? 0) || 0;
    const unit = Number(item.sellingPrice ?? item.price ?? item.mrp ?? item.unitPrice ?? 0) || 0;
    const amount = Number(item.amount ?? item.lineTotal ?? unit * quantity) || 0;
    return `<tr><td>${index + 1}</td><td>${safe(first(item.name, item.medicineName, item.productName, item.medicine, '-'))}</td><td>${safe(first(item.batchNumber, item.batch, '—'))}</td><td>${quantity}</td><td>${money(unit)} / ${money(amount)}</td></tr>`;
  }).join('');
  const paymentMarkup = ['Cash', 'UPI', 'Card', 'Other'].map(method => `<span class="pay-option"><span class="box">${String(payment).toLowerCase() === method.toLowerCase() ? '✓' : ''}</span>${method}${method === 'Other' ? ' : __________' : ''}</span>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${safe(invoice)} · Medicine Invoice</title><style>
  @page{size:A4;margin:10mm}*{box-sizing:border-box}body{margin:0;background:#fff;color:#112b4f;font-family:Georgia,'Times New Roman',serif}.sheet{width:190mm;min-height:277mm;margin:0 auto;padding:7mm 0 0;display:flex;flex-direction:column}.top{display:grid;grid-template-columns:58mm 1fr;gap:7mm;align-items:center}.brand{display:flex;gap:4mm;align-items:center}.brand-mark{width:20mm;height:20mm;border:2px solid #b98724;border-radius:50%;display:grid;place-items:center;font-size:21px;color:#0d3763}.tagline{font:italic 8px Arial,sans-serif;color:#17487e;margin-bottom:2mm}.brand-name{font-weight:700;font-size:16px;letter-spacing:.5px;color:#c39124}.brand-sub{font:700 8px Arial,sans-serif;letter-spacing:1.3px;color:#112b4f;margin-top:1mm}.title{background:#f4ead5;border-radius:16mm;padding:7mm 8mm;text-align:center;font:700 23px 'Courier New',monospace;letter-spacing:1px}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:5mm;margin-top:9mm}.info-card{background:#f0f3f8;border-radius:5mm;padding:5mm 6mm;font:700 12px 'Courier New',monospace;line-height:2}.label{display:inline-block;min-width:32mm}.line{display:inline-block;border-bottom:1px solid #112b4f;min-width:58mm;height:4mm;vertical-align:middle}.table-wrap{border:1px solid #112b4f;border-radius:5mm;overflow:hidden;margin-top:8mm;min-height:142mm}.items{width:100%;border-collapse:collapse;font:12px 'Courier New',monospace}.items th{background:#112b4f;color:#fff;padding:4mm 3mm;border-right:1px solid #dbe2ed}.items td{height:12mm;padding:3mm;border-right:1px solid #112b4f;border-bottom:1px solid #dbe2ed;color:#112b4f}.items th:nth-child(1){width:16mm}.items th:nth-child(2){width:76mm}.items th:nth-child(3){width:32mm}.items th:nth-child(4){width:22mm}.items th:last-child{width:44mm}.items td:last-child,.items th:last-child{border-right:0}.bottom{display:grid;grid-template-columns:1fr 74mm;gap:8mm;margin-top:8mm;align-items:start}.remarks{font:700 12px 'Courier New',monospace;line-height:2}.remarks-line{border-bottom:1px solid #112b4f;height:8mm;width:92mm}.payment{margin-top:5mm}.pay-option{display:inline-flex;align-items:center;gap:2mm;margin:2mm 5mm 0 0;font-family:Arial,sans-serif;font-weight:600}.box{display:inline-grid;place-items:center;width:5mm;height:5mm;border:1px solid #112b4f;font-size:12px}.total{background:#f4ead5;border:1px solid #112b4f;border-radius:4mm;display:grid;grid-template-columns:1fr 1fr;font:700 16px 'Courier New',monospace}.total span{padding:5mm;border-right:1px solid #112b4f}.total span:last-child{border-right:0}.notice{background:#f0f3f8;border-radius:9mm;text-align:center;padding:5mm;margin-top:auto;font:700 11px 'Courier New',monospace;line-height:1.6}.footer{margin-top:7mm;border-top:1px solid #112b4f;padding-top:5mm;text-align:center;font:12px Arial,sans-serif;color:#112b4f}@media print{.sheet{margin:0}.no-print{display:none}}
  </style></head><body><main class="sheet"><header class="top"><div class="brand"><img class="invoice-logo" src="${logoUrl}" alt="Nance Polyclinic"><div><div class="tagline">Bringing life to a healthier you</div><div class="brand-name">NANCE POLYCLINIC</div><div class="brand-sub">SPECIALIST CARE UNDER ONE ROOF</div></div></div><div class="title">MEDICINE INVOICE</div></header><section class="info-grid"><div class="info-card"><div><span class="label">Patient Name :</span><span class="line">${safe(party)}</span></div><div><span class="label">Age / Gender :</span><span class="line">${safe(ageGender)}</span></div><div><span class="label">Consultant :</span><span class="line">${safe(doctor)}</span></div></div><div class="info-card"><div><span class="label">Invoice No. :</span><span class="line">${safe(invoice)}</span></div><div><span class="label">Date :</span><span class="line">${safe(date)}</span></div><div><span class="label">OPD / UHID No. :</span><span class="line">${safe(opd)}</span></div></div></section><section class="table-wrap"><table class="items"><thead><tr><th>Sl. No.</th><th>Medicine / Item</th><th>Batch No.</th><th>Qty</th><th>MRP (₹) / Amount (₹)</th></tr></thead><tbody>${rows}</tbody></table></section><section class="bottom"><div class="remarks"><div>Remarks :</div><div class="remarks-line"></div><div class="remarks-line"></div><div class="payment">Mode of Payment :<br>${paymentMarkup}</div></div><div class="total"><span>Total Amount</span><span>${money(total)}</span></div></section><div class="notice">Please check the medicines, quantity and expiry before leaving.<br>For any queries, contact the pharmacy directly at the clinic.</div><footer class="footer">📍 Kajalgaon–Bengtol Road, Near Kajalgaon Weekly Market, Chirang – 783386, Assam &nbsp; | &nbsp; ☎ 9101068433</footer></main></body></html>`;
  const printOverrides = '@page{size:A4 portrait;margin:0}.invoice-logo{width:15mm;height:15mm;object-fit:contain;border-radius:50%}.sheet{width:210mm;height:297mm;min-height:297mm;margin:0 auto;padding:8mm 10mm 6mm;overflow:hidden;display:flex;flex-direction:column}.top{gap:3mm}.brand-mark{width:15mm;height:15mm}.title{padding:4mm 5mm;font-size:18px}.info-grid{margin-top:4mm;gap:3mm;flex-shrink:0}.info-card{padding:3mm 4mm;font-size:9px;line-height:1.5}.table-wrap{flex:1 1 auto;min-height:70mm;height:auto;margin-top:5mm;display:block}.items{font-size:9px}.items th{padding:2mm 1.5mm}.items td{height:7mm;padding:1.5mm}.bottom{margin-top:4mm;flex-shrink:0}.remarks{font-size:9px}.remarks-line{height:5mm}.payment{margin-top:2mm}.notice{padding:2mm;font-size:8px;margin-top:4mm;flex-shrink:0}.footer{margin-top:3mm;padding-top:2mm;font-size:8px;flex-shrink:0}@media print{.sheet{page-break-after:avoid}}';
  const printableHtml = html
    .replace('</div></section><section class="table-wrap">', '</div></div></section><section class="table-wrap">')
    .replace('</style></head>', `${printOverrides}</style></head>`);
  const popup = window.open('', '_blank', 'width=900,height=1100');
  if (!popup) { window.alert('Please allow pop-ups to print the invoice.'); return; }
  popup.document.open(); popup.document.write(printableHtml); popup.document.close();
  setTimeout(() => { popup.focus(); popup.print(); }, 250);
}

