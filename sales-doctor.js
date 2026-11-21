const originalCustomerDetails = customerDetails;
customerDetails = function () { const modal = document.createElement('div'); modal.className = 'payment-modal'; modal.innerHTML = `<div class="payment-card"><h2>Customer details</h2><input id="customer-name" class="search" style="width:100%;margin:8px 0" placeholder="Customer name" required><div style="display:flex;align-items:center;border:1px solid #dce4e1;border-radius:12px;margin:8px 0 14px;background:#fff"><span style="padding-left:14px;font-weight:600;color:#53645d">+91</span><input id="customer-phone" class="search" style="border:0;margin:0;width:100%" type="tel" inputmode="numeric" maxlength="10" pattern="[0-9]{10}" placeholder="10-digit mobile number" required oninput="this.value=this.value.replace(/\\D/g,\\\"\\\").slice(0,10)"></div><label>Patient source<select id="patient-source" class="search" style="width:100%;margin:8px 0"><option value="WALK_IN">Walk-in patient</option><option value="DOCTOR_REFERRAL">Sent by a doctor</option></select></label><label id="referring-doctor-wrap" style="display:none">Referring doctor<input id="sale-doctor" class="search" style="width:100%;margin:8px 0 14px" placeholder="Enter referring doctor name"></label><button class="primary" style="width:100%" onclick="paymentDetails()">Continue to payment</button></div>`; document.body.appendChild(modal); document.querySelector('#patient-source').onchange=e=>{document.querySelector('#referring-doctor-wrap').style.display=e.target.value==='DOCTOR_REFERRAL'?'block':'none';}; };
const originalComplete = completeSalesBill;
completeSalesBill = async function (customer, phone) { if (window.saleSubmitting) return; window.saleSubmitting = true; const button = document.querySelector('.payment-card button.primary'); if (button) { button.disabled = true; button.textContent = 'Saving bill…'; } const patientSource = window.pendingPatientSource || 'WALK_IN'; const doctor = patientSource === 'DOCTOR_REFERRAL' ? (window.pendingReferringDoctor || '') : ''; if (patientSource === 'DOCTOR_REFERRAL' && !doctor) { window.saleSubmitting = false; return alert('Select the referring doctor'); } try { const r = await fetch('/api/sale', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({items:salesCart, amount:cartTotal(), method:document.querySelector('#payment-method').value, customer, phone, patientSource, doctor, employee:salesUser.name, branch:salesUser.branch}) }); const d = await r.json(); if (!d.ok) { window.saleSubmitting = false; return alert(d.error); } window.lastBillForPrint=d.transaction || d.state?.transactions?.[0]||{items:salesCart,customer,phone,patientSource,doctor,amount:cartTotal(),payment:document.querySelector('#payment-method').value,createdAt:new Date().toISOString()}; salesCart=[]; window.pendingPatientSource=''; window.pendingReferringDoctor=''; document.querySelector('.payment-card').innerHTML='<h2>Payment successful ✓</h2><p>Bill saved with medicines, quantities, and patient source.</p><p style="margin:18px 0 8px;font-weight:600">Print bill required?</p><div style="display:flex;gap:10px"><button class="primary" onclick="printReceipt(\'Sales bill\',window.lastBillForPrint);this.closest(\'.payment-modal\').remove();renderSalesApp()">Yes, print bill</button><button class="secondary" onclick="this.closest(\'.payment-modal\').remove();renderSalesApp()">No</button></div>'; await loadSalesInventory(); } catch (error) { window.saleSubmitting = false; if (button) { button.disabled = false; button.textContent = 'Confirm payment'; } return alert('Could not save bill. Please try again.'); } };
paymentDetails = function(){const name=document.querySelector('#customer-name').value.trim(),digits=document.querySelector('#customer-phone').value.replace(/\D/g,'');const source=document.querySelector('#patient-source')?.value||'WALK_IN',doctor=document.querySelector('#sale-doctor')?.value.trim()||'';if(!name)return alert('Customer name is required');if(!/^\d{10}$/.test(digits))return alert('Enter exactly 10 digits after +91');if(source==='DOCTOR_REFERRAL'&&!doctor)return alert('Enter the referring doctor name');window.pendingPatientSource=source;window.pendingReferringDoctor=doctor;document.querySelector('.payment-card').innerHTML=`<h2>Collect payment</h2><p>${name} · +91 ${digits}</p><p><strong>${source==='DOCTOR_REFERRAL'?'Doctor referral: '+doctor:'Walk-in patient'}</strong></p><h2>₹${cartTotal().toFixed(2)}</h2><select id="payment-method" class="search" style="width:100%;margin:10px 0"><option>Cash</option><option>UPI</option><option>Card</option></select><input id="payment-reference" class="search" style="width:100%;margin-bottom:14px" placeholder="Payment reference"><button class="primary" style="width:100%" onclick="completeSalesBill('${name.replaceAll("'","\\'")}','+91${digits}')">Confirm payment</button>`};
// Add a consistent close control to every sales modal, including dynamically rendered payment states.
(() => {
  const addModalClose = (root = document) => root.querySelectorAll('.payment-modal .payment-card').forEach(card => {
    if (card.querySelector('.modal-close')) return;
    card.style.position = 'relative';
    const close = document.createElement('button');
    close.className = 'modal-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    Object.assign(close.style, {position:'absolute', top:'12px', right:'16px', border:'0', background:'transparent', fontSize:'28px', lineHeight:'1', cursor:'pointer', color:'#64748b'});
    close.onclick = () => card.closest('.payment-modal')?.remove();
    card.prepend(close);
  });
  new MutationObserver(() => addModalClose()).observe(document.body, {childList:true, subtree:true});
})();

// The referring clinician must come from the Admin employee directory.
(() => {
  const convertDoctorField = () => {
    const field = document.querySelector('#sale-doctor');
    if (!field || field.tagName === 'SELECT') return;
    const select = document.createElement('select');
    select.id = field.id;
    select.className = field.className;
    select.style.cssText = field.style.cssText;
    select.innerHTML = '<option value="">Select doctor</option>' + (typeof salesDoctors !== 'undefined' ? salesDoctors : [])
      .filter(employee => employee.role === 'DOCTOR' || employee.role === 'PHARMACIST')
      .map(employee => `<option value="${String(employee.name).replaceAll('"', '&quot;')}">${String(employee.name).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]))}</option>`)
      .join('');
    field.replaceWith(select);
  };
  new MutationObserver(convertDoctorField).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('load', convertDoctorField);
})();
