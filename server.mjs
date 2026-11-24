import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createDentalApi } from './dental-api.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2'); }
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseEnabled = Boolean(supabaseUrl && supabaseServiceKey);
const dentalApi = createDentalApi({
  supabaseUrl,
  anonKey: process.env.SUPABASE_ANON_KEY,
  serviceKey: supabaseServiceKey,
  adminUsername: process.env.ADMIN_USERNAME,
  adminPassword: process.env.ADMIN_PASSWORD
});
let state = { syncedAt: new Date().toISOString(), salesToday: 0, transactions: [], inventory: [], employees: [], purchases: [], suppliers: [], medicineRequests: [], supplierPayments: [] };
if (!Array.isArray(state.purchases)) state.purchases = [];
if (!Array.isArray(state.suppliers)) state.suppliers = [];
state.inventory.forEach(item => { item.stripsPerBox = Number(item.stripsPerBox) || 10; item.piecesPerStrip = Number(item.piecesPerStrip) || 10; });
function saveState() {
  // Runtime business data is Supabase-only. The in-memory object is retained
  // only for compatibility with legacy handlers when Supabase is unavailable.
}
function expiryWindow() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setMonth(cutoff.getMonth() + 3);
  return { today, cutoff };
}
function applyExpiryRules() {
  const { today, cutoff } = expiryWindow();
  let changed = false;
  for (const item of state.inventory || []) {
    if (!item.expiryDate) continue;
    const expiry = new Date(`${item.expiryDate}T00:00:00`);
    if (Number.isNaN(expiry.getTime())) continue;
    if (expiry < today) {
      if (Number(item.stock) !== 0 || item.status !== 'EXPIRED') {
        item.stock = 0;
        item.status = 'EXPIRED';
        item.expiredAt = item.expiredAt || new Date().toISOString();
        changed = true;
      }
    } else if (expiry <= cutoff) {
      if (item.status !== 'EXPIRING_SOON') { item.status = 'EXPIRING_SOON'; changed = true; }
    } else if (item.status === 'EXPIRING_SOON') {
      item.status = Number(item.stock) > 0 ? 'AVAILABLE' : 'OUT_OF_STOCK';
      changed = true;
    }
  }
  if (changed) saveState();
}
function inventoryStatus(item) {
  if (item.status === 'EXPIRED') return 'EXPIRED';
  if (item.status === 'EXPIRING_SOON') return 'EXPIRING_SOON';
  const stock = Number(item.stock) || 0;
  if (stock === 0) return 'OUT_OF_STOCK';
  if (stock < 15) return 'LOW_STOCK';
  return 'AVAILABLE';
}
function inventoryWithExpiry() {
  const { today, cutoff } = expiryWindow();
  return (state.inventory || []).map(item => {
    const expiry = item.expiryDate ? new Date(`${item.expiryDate}T00:00:00`) : null;
    const valid = expiry && !Number.isNaN(expiry.getTime());
    const stock = Number(item.stock) || 0;
    return { ...item, stock, expiryStatus: inventoryStatus(item), nearExpiry: Boolean(valid && expiry >= today && expiry <= cutoff), value: stock * (Number(item.price) || 0) };
  });
}
applyExpiryRules();
function json(res, value, status = 200) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }
function readBody(req) { return new Promise(resolve => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } }); }); }
function verifyPassword(password, employee) { if (employee.password && employee.password === password) return true; if (!employee.passwordHash?.startsWith('scrypt$')) return false; const [, salt, expected] = employee.passwordHash.split('$'); const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), 64).toString('base64url'); return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); }
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function csvDownload(res, filename, headers, rows) {
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(`\uFEFF${csv}`);
}
async function supabaseRequest(resource, method='GET', query={}, body) { const u=new URL(`${supabaseUrl}/rest/v1/${resource}`); for(const [k,v] of Object.entries(query))u.searchParams.set(k,String(v)); const h={apikey:supabaseServiceKey,Authorization:`Bearer ${supabaseServiceKey}`,Accept:'application/json'}; if(body!==undefined){h['Content-Type']='application/json';h.Prefer='return=representation'} const r=await fetch(u,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});const t=await r.text();if(!r.ok)throw new Error(t);return t?JSON.parse(t):[]; }
async function supabaseAuth(path, method, body) { const r=await fetch(`${supabaseUrl}/auth/v1/admin/${path}`,{method,headers:{apikey:supabaseServiceKey,Authorization:`Bearer ${supabaseServiceKey}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const t=await r.text();if(!r.ok)throw new Error(t);return t?JSON.parse(t):{}; }
const employeeEmail = code => `${String(code).toLowerCase()}@nance.local`;

async function cloudAdminState() {
  const [sales, saleItems, medicines, batches, branches, suppliers, purchases, purchaseItems, legacyImports, profiles] = await Promise.all([
    supabaseRequest('sales', 'GET', { select: 'id,branch_id,invoice_number,customer_name,customer_mobile,total,payment_method,status,created_by,created_at', order: 'created_at.desc', limit: 5000 }),
    supabaseRequest('sale_items', 'GET', { select: 'sale_id,medicine_id,quantity,unit_price', limit: 20000 }),
    supabaseRequest('medicines', 'GET', { select: 'id,name,generic_name', limit: 5000 }),
    supabaseRequest('batches', 'GET', { select: 'id,medicine_id,branch_id,batch_number,expiry_date,purchase_price,selling_price,available_quantity,status', limit: 10000 }),
    supabaseRequest('branches', 'GET', { select: 'id,name', limit: 1000 }),
    supabaseRequest('suppliers', 'GET', { select: 'id,name,contact_name,phone,email,brands,categories,active,created_at', order: 'created_at.desc', limit: 5000 }),
    supabaseRequest('purchases', 'GET', { select: 'id,branch_id,supplier_id,invoice_number,subtotal,tax,total,created_at', order: 'created_at.desc', limit: 5000 }),
    supabaseRequest('purchase_items', 'GET', { select: 'purchase_id,medicine_id,quantity,boxes,strips,pieces,unit_cost,tax_rate,line_total', limit: 20000 }),
    supabaseRequest('legacy_imports', 'GET', { select: 'source_key,source_type,record', limit: 10000 }),
    supabaseRequest('profiles', 'GET', { select: 'id,full_name,employee_code', limit: 5000 })
  ]);
  const medicineMap = new Map(medicines.map(item => [item.id, item]));
  const profileMap = new Map(profiles.map(profile => [profile.id, profile.full_name || profile.employee_code || '']));
  const saleMetadata = new Map(legacyImports.filter(row => row.source_type === 'sale_metadata').map(row => [row.record?.saleId || row.source_key?.slice(5), row.record || {}]));
  const branchMap = new Map(branches.map(item => [item.id, item.name]));
  const itemsBySale = new Map();
  saleItems.forEach(item => {
    if (!itemsBySale.has(item.sale_id)) itemsBySale.set(item.sale_id, []);
    const medicine = medicineMap.get(item.medicine_id);
    itemsBySale.get(item.sale_id).push({
      name: medicine?.name || 'Medicine',
      quantity: Number(item.quantity) || 0,
      price: Number(item.unit_price) || 0,
      amount: (Number(item.quantity) || 0) * (Number(item.unit_price) || 0)
    });
  });
  const transactions = sales.map(sale => ({
    invoice: sale.invoice_number?.startsWith('#') ? sale.invoice_number : `#${sale.invoice_number || sale.id}`,
    createdAt: sale.created_at,
    branch: branchMap.get(sale.branch_id) || '',
    customer: sale.customer_name || 'Walk-in customer',
    phone: sale.customer_mobile || '',
    employee: profileMap.get(sale.created_by) || '',
    patientSource: saleMetadata.get(sale.id)?.patientSource || 'WALK_IN',
    doctor: saleMetadata.get(sale.id)?.doctor || '',
    items: itemsBySale.get(sale.id) || [],
    amount: Number(sale.total) || 0,
    payment: sale.payment_method || 'Cash',
    paymentMethod: sale.payment_method || 'Cash',
    status: sale.status || 'Completed'
  }));
  const importedInventory = legacyImports.filter(row => row.source_type === 'inventory_snapshot').map(row => row.record).filter(Boolean);
  const localInventoryByName = new Map(importedInventory.map(item => [item.name.toLowerCase(), item]));
  const primaryBranchId = branches.find(branch => branch.name === 'Assam')?.id;
  const inventoryMap = new Map();
  batches.filter(batch => !primaryBranchId || batch.branch_id === primaryBranchId).forEach(batch => {
    const medicine = medicineMap.get(batch.medicine_id);
    if (!medicine) return;
    const localItem = localInventoryByName.get(medicine.name.toLowerCase());
    const item = inventoryMap.get(batch.medicine_id) || { name: medicine.name, generic: medicine.generic_name || '', stock: 0, price: Number(batch.selling_price) || 0, expiryDate: batch.expiry_date || localItem?.expiryDate || '', buyingValue: 0, batches: [] };
    const available = Number(batch.available_quantity) || 0;
    item.stock += available;
    item.buyingValue += available * (Number(batch.purchase_price) || 0);
    item.batches.push({ batchNumber: batch.batch_number || '', expiryDate: batch.expiry_date || '', stock: Number(batch.available_quantity) || 0, price: Number(batch.selling_price) || 0, status: batch.status || '' });
    item.batches.sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)));
    item.price = item.batches[0]?.price || item.price;
    item.expiryDate = item.batches[0]?.expiryDate || item.expiryDate;
    inventoryMap.set(batch.medicine_id, item);
  });
  const inventory = [...inventoryMap.values()].map(item => {
    const expiry = item.expiryDate ? new Date(`${item.expiryDate}T00:00:00`) : null;
    const validExpiry = expiry && !Number.isNaN(expiry.getTime());
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today); cutoff.setMonth(cutoff.getMonth() + 3);
    const expiryStatus = item.stock === 0 ? 'OUT_OF_STOCK' : validExpiry && expiry < today ? 'EXPIRED' : validExpiry && expiry <= cutoff ? 'EXPIRING_SOON' : item.stock < 15 ? 'LOW_STOCK' : 'AVAILABLE';
    return { ...item, expiryStatus, nearExpiry: Boolean(validExpiry && expiry >= today && expiry <= cutoff), value: item.stock * item.price };
  });
  const inventoryOrder = new Map(importedInventory.map((item, index) => [item.name.toLowerCase(), index]));
  inventory.sort((a, b) => (inventoryOrder.get(a.name.toLowerCase()) ?? 9999) - (inventoryOrder.get(b.name.toLowerCase()) ?? 9999));
  const supplierMap = new Map(suppliers.map(supplier => [supplier.id, supplier]));
  const purchaseItemsByPurchase = new Map();
  purchaseItems.forEach(item => {
    if (!purchaseItemsByPurchase.has(item.purchase_id)) purchaseItemsByPurchase.set(item.purchase_id, []);
    const medicine = medicineMap.get(item.medicine_id);
    purchaseItemsByPurchase.get(item.purchase_id).push({
      name: medicine?.name || 'Medicine', quantity: Number(item.quantity) || 0,
      boxes: Number(item.boxes) || 0, strips: Number(item.strips) || 0, pieces: Number(item.pieces) || 0,
      unitCost: Number(item.unit_cost) || 0, taxRate: Number(item.tax_rate) || 0, lineTotal: Number(item.line_total) || 0
    });
  });
  const cloudPurchases = purchases.map(purchase => ({
    id: purchase.id, invoiceNumber: purchase.invoice_number, branch: branchMap.get(purchase.branch_id) || '',
    supplierId: purchase.supplier_id, supplier: supplierMap.get(purchase.supplier_id)?.name || '',
    subtotal: Number(purchase.subtotal) || 0, taxAmount: Number(purchase.tax) || 0,
    totalCost: Number(purchase.total) || 0, cost: Number(purchase.total) || 0,
    items: purchaseItemsByPurchase.get(purchase.id) || [], createdAt: purchase.created_at
  }));
  const localSupplierOrder = new Map(legacyImports
    .map(row => row.record)
    .filter(record => record?.name)
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true }))
    .map((record, index) => [record.name.toLowerCase(), index]));
  const cloudSuppliers = suppliers.map(supplier => {
    const ledger = legacyImports.find(row => row.source_key === `supplier:${supplier.id}`) || legacyImports.find(row =>
      ['supplier', 'supplier_snapshot'].includes(row.source_type) && row.record?.name?.toLowerCase() === supplier.name.toLowerCase()
    );
    const imported = ledger?.record || {};
    return {
    id: supplier.id, name: supplier.name, contact: supplier.contact_name || '', phone: supplier.phone || '',
    email: supplier.email || '', brands: supplier.brands || '', categories: supplier.categories || '', active: supplier.active,
    purchased: Number(imported.purchased) || 0, paid: Number(imported.paid) || 0, outstanding: Number(imported.outstanding) || 0,
    payments: Array.isArray(imported.payments) ? imported.payments : [],
    bills: Array.isArray(imported.bills) ? imported.bills : []
  }; });
  cloudSuppliers.sort((a, b) => (localSupplierOrder.get(a.name.toLowerCase()) ?? 9999) - (localSupplierOrder.get(b.name.toLowerCase()) ?? 9999));
  return { ...state, syncedAt: sales[0]?.created_at || purchases[0]?.created_at || state.syncedAt, transactions, inventory, purchases: cloudPurchases, suppliers: cloudSuppliers, salesToday: transactions.reduce((total, sale) => total + sale.amount, 0) };
}

async function adminState() {
  if (!supabaseEnabled) throw new Error('Supabase is not configured. Admin data is unavailable until the shared database is connected.');
  return cloudAdminState();
}

function adminStateResponse(res, transform) {
  return adminState().then(transform).catch(error => json(res, { ok: false, error: `Shared database unavailable: ${error.message}` }, 503));
}

async function syncApprovedMedicineRequest(request, buyingPrice) {
  const quantity = Math.max(1, Number(request.quantity) || 0);
  const purchaseTotal = Math.max(0, Number(request.purchaseTotal) || 0);
  const mrp = Math.max(0, Number(request.price) || 0);
  const discount = Math.max(0, Math.min(100, Number(request.discountPercent) || 0));
  const sellingPrice = mrp * (1 - discount / 100);
  const branch = (await supabaseRequest('branches', 'GET', { select: 'id,name', ...(request.branchId ? { id: `eq.${request.branchId}` } : { name: 'eq.Assam' }), status: 'eq.ACTIVE', limit: 1 }))[0];
  if (!branch) throw new Error('Assam branch was not found');
  let supplier = (await supabaseRequest('suppliers', 'GET', { select: 'id,name', ...(request.supplierId && request.deliveryDate ? { id: `eq.${request.supplierId}` } : { name: `eq.${request.supplier}` }), limit: 1 }))[0];
  if (!supplier && request.deliveryDate) throw new Error('The delivery supplier was not found');
  if (!supplier) supplier = (await supabaseRequest('suppliers', 'POST', {}, { id: crypto.randomUUID(), name: request.supplier, active: true }))[0];
  let medicine = (await supabaseRequest('medicines', 'GET', { select: 'id,name,generic_name', name: `eq.${request.name}`, limit: 1 }))[0];
  if (!medicine) medicine = (await supabaseRequest('medicines', 'POST', {}, { id: crypto.randomUUID(), name: request.name, generic_name: request.generic || '', status: 'ACTIVE', gst_rate: 0 }))[0];
  const purchaseId = crypto.randomUUID(), batchId = crypto.randomUUID(), invoice = `REQ-${String(request.id).replace(/[^A-Za-z0-9]/g, '').slice(-24)}`;
  await supabaseRequest('purchases', 'POST', {}, { id: purchaseId, branch_id: branch.id, supplier_id: supplier.id, invoice_number: invoice, subtotal: purchaseTotal, tax: 0, total: purchaseTotal, ...(request.deliveryDate ? { created_at: `${request.deliveryDate}T12:00:00+05:30` } : {}) });
  await supabaseRequest('batches', 'POST', {}, { id: batchId, medicine_id: medicine.id, branch_id: branch.id, batch_number: invoice, expiry_date: request.expiryDate || '2099-12-31', purchase_price: buyingPrice ?? purchaseTotal / quantity, mrp, selling_price: sellingPrice, received_quantity: quantity, available_quantity: quantity, status: 'AVAILABLE' });
  await supabaseRequest('purchase_items', 'POST', {}, { id: crypto.randomUUID(), purchase_id: purchaseId, medicine_id: medicine.id, batch_id: batchId, quantity, boxes: Number(request.boxes) || 0, strips: Number(request.strips) || 0, pieces: Number(request.pieces) || 0, strips_per_box: Number(request.stripsPerBox) || 10, pieces_per_strip: Number(request.piecesPerStrip) || 10, unit_cost: purchaseTotal / quantity, tax_rate: 0, line_total: purchaseTotal });
  await supabaseRequest('stock_movements', 'POST', {}, { id: crypto.randomUUID(), batch_id: batchId, branch_id: branch.id, type: 'PURCHASE', quantity, reference_id: purchaseId, note: `Approved staff medicine request ${request.id}` });
  if (purchaseTotal === 0) return { purchaseId, batchId, medicineId: medicine.id, supplierId: supplier.id };
  const imports = await supabaseRequest('legacy_imports', 'GET', { select: 'source_key,record', limit: 10000 });
  const row = imports.find(item => item.record?.name?.toLowerCase() === request.supplier.toLowerCase());
  const old = row?.record || { id: supplier.id, name: request.supplier, purchased: 0, paid: 0, outstanding: 0 };
  const balance = { ...old, id: supplier.id, name: request.supplier, purchased: (Number(old.purchased) || 0) + purchaseTotal, outstanding: (Number(old.outstanding) || 0) + purchaseTotal };
  if (row) await supabaseRequest('legacy_imports', 'PATCH', { source_key: `eq.${row.source_key}` }, { record: balance });
  else await supabaseRequest('legacy_imports', 'POST', {}, { source_key: `supplier:${supplier.id}`, source_type: 'supplier_snapshot', record: balance });
  return { purchaseId, batchId, medicineId: medicine.id, supplierId: supplier.id };
}

function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/dental/')) return dentalApi.handle(req, res);
  const adminProtectedRoutes = new Set([
    '/api/state', '/api/reports', '/api/purchases', '/api/suppliers/payment', '/api/suppliers/due', '/api/suppliers/bills',
    '/api/medicine-requests/approve', '/api/medicine-requests/buying-price', '/api/purchases/normalized',
    '/api/purchases/invoice', '/api/export/bills', '/api/export/purchases',
    '/api/export/inventory', '/api/stock/add'
  ]);
  const staffReadableRoutes = new Set(['/api/inventory', '/api/employees', '/api/suppliers', '/api/medicine-requests']);
  const session = dentalApi.getSession(req);
  const isAdmin = session?.role === 'ADMIN';
  const isStaff = session?.role === 'STAFF';
  const supplierCreate = url.pathname === '/api/suppliers' && req.method === 'POST';
  const staffMayRead = staffReadableRoutes.has(url.pathname) && req.method === 'GET';
  const adminSessionRequired = adminProtectedRoutes.has(url.pathname) || (url.pathname === '/api/employees' && req.method !== 'GET') || (url.pathname === '/api/suppliers' && req.method !== 'GET' && !supplierCreate);
  const deliveryCreate = url.pathname === '/api/medicine-requests' && req.method === 'POST';
  if (url.pathname === '/api/state' && !isAdmin && !isStaff) {
    if (!dentalApi.requireAdmin(req, res)) return;
  } else if (adminSessionRequired && !(url.pathname === '/api/state' && isStaff)) {
    if (!dentalApi.requireAdmin(req, res)) return;
  } else if ((staffMayRead || supplierCreate || deliveryCreate) && !isAdmin && !isStaff) {
    res.statusCode = 401;
    return json(res, { ok: false, error: 'Staff or admin sign-in is required.' }, 401);
  }
  if (req.method === 'POST' && url.pathname === '/api/login') return readBody(req).then(async input => { if(supabaseEnabled){try{const token=await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:employeeEmail(input.code),password:input.password})});if(!token.ok)return json(res,{ok:false,error:'Invalid employee ID or password'});const auth=await token.json(),profiles=await supabaseRequest('profiles','GET',{select:'employee_code,full_name,role,active,branch_id',id:`eq.${auth.user.id}`,limit:1}),branches=await supabaseRequest('branches','GET',{select:'id,name',id:`eq.${profiles[0]?.branch_id}`,limit:1}),profile=profiles[0];if(!profile?.active)return json(res,{ok:false,error:'Employee account is inactive'});const employee={code:profile.employee_code||input.code,name:profile.full_name||input.code,role:profile.role||'BILLING_STAFF',branch:branches[0]?.name||'Assam'};dentalApi.setStaffSession(req,res,{employeeId:auth.user.id,name:employee.name,code:employee.code,branchId:profile.branch_id,siteName:employee.branch});return json(res,{ok:true,employee})}catch{return json(res,{ok:false,error:'Invalid employee ID or password'})}} const employee=state.employees.find(e=>e.code===input.code&&verifyPassword(input.password||'',e));return json(res,employee?{ok:true,employee:{code:employee.code,name:employee.name,role:employee.role,branch:employee.branch}}:{ok:false,error:'Invalid employee ID or password'}); });
  if (req.method === 'GET' && url.pathname === '/api/employees') return (async()=>{if(supabaseEnabled){try{const rows=await supabaseRequest('profiles','GET',{select:'employee_code,full_name,role,active,branch_id',employee_code:'not.is.null',limit:1000}),branches=await supabaseRequest('branches','GET',{select:'id,name',limit:1000}),names=new Map(branches.map(b=>[b.id,b.name]));return json(res,{ok:true,employees:rows.map(p=>({code:p.employee_code,name:p.full_name,role:p.role==='PHARMACIST'?'DOCTOR':p.role,active:p.active,branch:names.get(p.branch_id)||'Unassigned'}))})}catch(e){return json(res,{ok:false,error:e.message},503)}}return json(res,{ok:true,employees:state.employees.map(({password,passwordHash,...employee})=>({...employee,role:employee.role==='PHARMACIST'?'DOCTOR':employee.role}))})})();
  if (req.method === 'GET' && url.pathname === '/api/medicine-requests') {
    if (!supabaseEnabled) return json(res, { ok: false, error: 'Supabase is required to load deliveries.' }, 503);
    return supabaseRequest('legacy_imports', 'GET', {
      select: 'record', source_type: 'eq.medicine_request', order: 'imported_at.asc', limit: 5000
    }).then(async rows => {
      const requests = rows.map(row => row.record).filter(Boolean);
      if (isAdmin) {
        if (url.searchParams.get('buyingPrices') !== '1') return json(res, { ok: true, requests });
        const ids = [...new Set(requests.filter(request => request.status === 'APPROVED' && request.batchId).map(request => request.batchId))];
        const batches = [];
        for (let offset = 0; offset < ids.length; offset += 100) {
          batches.push(await supabaseRequest('batches', 'GET', {
            select: 'id,purchase_price', id: `in.(${ids.slice(offset, offset + 100).join(',')})`
          }));
        }
        const prices = new Map(batches.flat().map(batch => [batch.id, Number(batch.purchase_price)]));
        return json(res, { ok: true, requests: requests.map(request => ({ ...request, buyingPrice: prices.get(request.batchId) })) });
      }
      return json(res, { ok: true, requests: requests.filter(request =>
        request.employeeId ? request.employeeId === session.employeeId : request.requestedBy === session.name
      ).map(({ name, supplier, deliveryDate, createdAt, status, quantity, reviewedAt }) => ({ name, supplier, deliveryDate, createdAt, status, quantity, reviewedAt })) });
    }).catch(() => json(res, { ok: false, error: 'Could not load deliveries from Supabase.' }, 503));
  }
  if (deliveryCreate) {
    if (!dentalApi.requireSameOrigin(req)) return json(res, { ok: false, error: 'Open the app directly to record deliveries.' }, 403);
    if (!supabaseEnabled) return json(res, { ok: false, error: 'Supabase is required to record deliveries.' }, 503);
    return readBody(req).then(async input => {
      const { boxes = 0, strips = 0, pieces = 0, stripsPerBox, piecesPerStrip } = Object.fromEntries(
        ['boxes', 'strips', 'pieces', 'stripsPerBox', 'piecesPerStrip']
          .filter(key => input?.[key] !== '' && input?.[key] != null)
          .map(key => [key, Number(input[key])])
      );
      if (boxes > 0 && stripsPerBox == null) {
        return json(res, { ok: false, error: 'Enter strips per box for boxed medicine.' }, 400);
      }
      if ((boxes > 0 || strips > 0) && piecesPerStrip == null) {
        return json(res, { ok: false, error: 'Enter pieces per strip for boxes or strips.' }, 400);
      }
      const perBox = stripsPerBox ?? 1;
      const perStrip = piecesPerStrip ?? 1;
      const quantity = boxes * perBox * perStrip + strips * perStrip + pieces;
      const name = typeof input?.name === 'string' ? input.name.trim() : '';
      const validDate = value => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const date = new Date(value);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
      };
      if (!name || !input.supplierId || ![boxes, strips, pieces, perBox, perStrip, quantity].every(Number.isSafeInteger)
          || Math.min(boxes, strips, pieces) < 0 || Math.min(perBox, perStrip, quantity) < 1 || quantity > 2147483647) {
        return json(res, { ok: false, error: 'Medicine, supplier, and a valid quantity are required.' }, 400);
      }
      if (!validDate(input.deliveryDate) || (input.expiryDate && !validDate(input.expiryDate))) {
        return json(res, { ok: false, error: 'Enter a valid delivery date and expiry date.' }, 400);
      }

      const [supplier] = await supabaseRequest('suppliers', 'GET', {
        select: 'id,name', id: `eq.${input.supplierId}`, active: 'eq.true', limit: 1
      });
      if (!supplier) return json(res, { ok: false, error: 'Select an active supplier.' }, 400);
      const price = Number(input.price || 0);
      const discountPercent = Number(input.discountPercent || 0);
      if (!Number.isFinite(price) || price < 0 || price > 9999999999.99 ||
          !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
        return json(res, { ok: false, error: 'Enter a valid selling price and discount.' }, 400);
      }
      const request = {
        id: `REQ-${crypto.randomUUID()}`, name, generic: String(input.generic || '').trim(),
        supplier: supplier.name, supplierId: supplier.id, boxes, strips, pieces, stripsPerBox: perBox, piecesPerStrip: perStrip, quantity,
        price, discountPercent, deliveryDate: input.deliveryDate, expiryDate: input.expiryDate || '',
        employeeId: session.employeeId, branchId: session.branchId, requestedBy: session.name,
        status: 'PENDING', createdAt: new Date().toISOString()
      };
      await supabaseRequest('legacy_imports', 'POST', {}, {
        source_key: `medicine-request:${request.id}`, source_type: 'medicine_request', record: request
      });
      return json(res, { ok: true }, 201);
    }).catch(() => json(res, { ok: false, error: 'Could not record the delivery in Supabase.' }, 503));
  }
  const editBuyingPrice = url.pathname === '/api/medicine-requests/buying-price';
  if (req.method === 'POST' && (editBuyingPrice || url.pathname === '/api/medicine-requests/approve')) {
    if (!dentalApi.requireSameOrigin(req)) return json(res, { ok: false, error: 'Open Admin directly to review deliveries.' }, 403);
    if (!supabaseEnabled) return json(res, { ok: false, error: 'Supabase is required to review deliveries.' }, 503);
    return readBody(req).then(async input => {
      const key = String(input.id || '').replace(/^medicine-request:/, '');
      const [row] = await supabaseRequest('legacy_imports', 'GET', {
        select: 'source_key,record', source_key: `eq.medicine-request:${key}`, source_type: 'eq.medicine_request', limit: 1
      });
      if (!row?.record) return json(res, { ok: false, error: 'Delivery not found.' }, 404);
      const existing = row.record;
      const hasPrice = input.buyingPrice != null && String(input.buyingPrice).trim() !== '';
      const buyingPrice = hasPrice ? Number(input.buyingPrice) : undefined;
      if ((editBuyingPrice && !hasPrice) || (hasPrice && (!Number.isFinite(buyingPrice) || buyingPrice < 0 || buyingPrice > 9999999999.99))) {
        return json(res, { ok: false, error: 'Enter a valid buying price per piece.' }, 400);
      }
      const unitCost = hasPrice ? Math.round(buyingPrice * 100) / 100 : undefined;
      if (editBuyingPrice) {
        if (existing.status !== 'APPROVED' || !existing.batchId) {
          return json(res, { ok: false, error: 'Approve this delivery before saving its buying price.' }, 409);
        }
        const [batch] = await supabaseRequest('batches', 'PATCH', { id: `eq.${existing.batchId}` }, { purchase_price: unitCost });
        if (!batch) return json(res, { ok: false, error: 'The stock batch for this delivery was not found.' }, 404);
        return json(res, { ok: true, buyingPrice: Number(batch.purchase_price) });
      }
      if (existing.status !== 'PENDING' && !(input.approved && existing.status === 'APPROVED' && !existing.purchaseId)) {
        return json(res, { ok: false, error: 'This delivery has already been reviewed.' }, 409);
      }
      const request = { ...existing, status: input.approved ? 'APPROVED' : 'REJECTED', reviewedAt: new Date().toISOString() };
      if (input.approved) {
        request.purchaseTotal = existing.status === 'APPROVED' ? Number(existing.purchaseTotal) || 0 : 0;
        Object.assign(request, await syncApprovedMedicineRequest(request, unitCost));
      }
      await supabaseRequest('legacy_imports', 'PATCH', { source_key: `eq.${row.source_key}` }, { record: request });
      return json(res, { ok: true, request });
    }).catch(() => json(res, { ok: false, error: 'Could not review the delivery in Supabase.' }, 503));
  }
  if (req.method === 'POST' && url.pathname === '/api/employees') return readBody(req).then(async input => { const code=String(input.code||'').trim().toUpperCase();if(!input.name||!code||!input.password)return json(res,{ok:false,error:'Full name, employee ID, and password are required'},400);if(supabaseEnabled){try{const branches=await supabaseRequest('branches','GET',{select:'id,name',name:`eq.${input.branch||'Assam'}`,limit:1});if(!branches[0])return json(res,{ok:false,error:'Branch not found'},400);const auth=await supabaseAuth('users','POST',{email:employeeEmail(code),password:input.password,email_confirm:true,user_metadata:{full_name:input.name}});const profile=(await supabaseRequest('profiles','POST',{}, {id:auth.id,employee_code:code,full_name:String(input.name).trim(),role:input.role==='DOCTOR'?'PHARMACIST':'BILLING_STAFF',branch_id:branches[0].id}))[0];return json(res,{ok:true,employee:{code,name:profile.full_name,role:input.role||'SUPPORT_STAFF',branch:branches[0].name}},201)}catch(e){return json(res,{ok:false,error:e.message},503)}}if(state.employees.some(e=>e.code===code))return json(res,{ok:false,error:'Employee ID already exists'},400);const employee={code,password:input.password,name:String(input.name).trim(),role:input.role||'SUPPORT_STAFF',branch:input.branch||'Assam'};state.employees.push(employee);saveState();json(res,{ok:true,employee:{...employee,password:undefined}})});
  if (req.method === 'GET' && url.pathname === '/api/purchases') return adminStateResponse(res, admin => json(res, { ok: true, purchases: admin.purchases }));
  if (req.method === 'POST' && url.pathname === '/api/purchases') return readBody(req).then(input => {
    const supplier = state.suppliers.find(item => item.id === input.supplierId);
    const boxes = Math.max(0, Number(input.boxes) || 0);
    const strips = Math.max(0, Number(input.strips) || 0);
    const pieces = Math.max(0, Number(input.pieces) || 0);
    const stripsPerBox = Math.max(1, Number(input.stripsPerBox) || 10);
    const piecesPerStrip = Math.max(1, Number(input.piecesPerStrip) || 10);
    const quantity = boxes * stripsPerBox * piecesPerStrip + strips * piecesPerStrip + pieces;
    const buyPrice = Math.max(0, Number(input.buyPrice) || 0);
    const taxPercent = Math.max(0, Number(input.taxPercent) || 0);
    const subtotal = quantity * buyPrice;
    const taxAmount = subtotal * taxPercent / 100;
    const totalCost = subtotal + taxAmount;
    if (!supplier || !input.name || quantity < 1) return json(res, { ok: false, error: 'Select a valid supplier, medicine, and at least one box, strip, or piece' }, 400);
    const product = state.inventory.find(item => item.name.toLowerCase() === String(input.name).toLowerCase());
    if (product) {
      product.stock += quantity;
      product.generic = input.generic || product.generic;
      product.price = Number(input.sellingPrice) || product.price;
      product.stripsPerBox = stripsPerBox;
      product.piecesPerStrip = piecesPerStrip;
    } else state.inventory.push({ name: input.name, generic: input.generic || '', stock: quantity, price: Number(input.sellingPrice) || 0, stripsPerBox, piecesPerStrip });
    const quantityLabel = [boxes ? `${boxes} box${boxes === 1 ? '' : 'es'}` : '', strips ? `${strips} strip${strips === 1 ? '' : 's'}` : '', pieces ? `${pieces} piece${pieces === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ');
    state.purchases.unshift({ supplierId: supplier.id, supplier: supplier.name, supplierName: supplier.name, name: input.name, quantity, quantityLabel, boxes, strips, pieces, stripsPerBox, piecesPerStrip, buyPrice, taxPercent, subtotal, taxAmount, totalCost, cost: totalCost, createdAt: new Date().toISOString() });
    state.syncedAt = new Date().toISOString();
    saveState();
    json(res, { ok: true, purchase: state.purchases[0], inventory: state.inventory });
  });
  if (req.method === 'POST' && url.pathname === '/api/purchases/normalized') return readBody(req).then(input => {
    const boxes=Math.max(0,Number(input.boxes)||0),strips=Math.max(0,Number(input.strips)||0),pieces=Math.max(0,Number(input.pieces)||0),spb=Math.max(1,Number(input.stripsPerBox)||10),pps=Math.max(1,Number(input.piecesPerStrip)||10),quantity=boxes*spb*pps+strips*pps+pieces,basis=input.priceBasis||'box',enteredPrice=Math.max(0,Number(input.enteredPrice)||0),enteredMrp=Math.max(0,Number(input.enteredMrp)||0),enteredSelling=Math.max(0,Number(input.enteredSelling)||0),basisUnits=basis==='box'?spb*pps:basis==='strip'?pps:1,buyPrice=enteredPrice/basisUnits,mrp=enteredMrp/basisUnits,sellingPrice=enteredSelling/basisUnits,taxPercent=Math.max(0,Number(input.taxPercent)||0),subtotal=quantity*buyPrice,taxAmount=subtotal*taxPercent/100,totalCost=subtotal+taxAmount;
    if(!input.supplierId||!input.name||quantity<1)return json(res,{ok:false,error:'Supplier, medicine, and quantity are required'},400);
    const product=state.inventory.find(item=>item.name.toLowerCase()===String(input.name).toLowerCase()); if(product){product.stock+=quantity;product.price=sellingPrice||product.price;product.stripsPerBox=spb;product.piecesPerStrip=pps}else state.inventory.push({name:input.name,generic:input.generic||'',stock:quantity,price:sellingPrice,stripsPerBox:spb,piecesPerStrip:pps});
    const supplier=state.suppliers.find(s=>s.id===input.supplierId);const requestedPaid=Math.max(0,Number(input.paidAmount)||0),paidAmount=Math.min(totalCost,requestedPaid),paymentStatus=paidAmount>=totalCost?'PAID':paidAmount>0?'PARTIAL':'CREDIT';state.purchases.unshift({supplierId:input.supplierId,supplier:supplier?.name||'',name:input.name,quantity,quantityLabel:`${boxes} box / ${strips} strips / ${pieces} pieces`,boxes,strips,pieces,stripsPerBox:spb,piecesPerStrip:pps,buyPrice,mrp,sellingPrice,taxPercent,subtotal,taxAmount,totalCost,cost:totalCost,paymentStatus,paymentMethod:paidAmount>0?(input.paymentMethod||'Cash'):'CREDIT',paymentReference:input.paymentReference||'',paidAmount,dueAmount:totalCost-paidAmount,createdAt:new Date().toISOString()});if(supplier){supplier.purchased=(supplier.purchased||0)+totalCost;supplier.paid=(supplier.paid||0)+paidAmount;supplier.outstanding=(supplier.outstanding||0)+(totalCost-paidAmount)}state.syncedAt=new Date().toISOString();saveState();return json(res,{ok:true,purchase:state.purchases[0],inventory:state.inventory});
  });
  if (req.method === 'POST' && url.pathname === '/api/purchases/invoice') return readBody(req).then(input => { const supplier=state.suppliers.find(s=>s.id===input.supplierId),items=Array.isArray(input.items)?input.items:[];if(!supplier||!items.length)return json(res,{ok:false,error:'Supplier and at least one medicine line are required'},400);const normalized=items.map(i=>{const boxes=Math.max(0,Number(i.boxes)||0),strips=Math.max(0,Number(i.strips)||0),pieces=Math.max(0,Number(i.pieces)||0),spb=Math.max(1,Number(i.stripsPerBox)||10),pps=Math.max(1,Number(i.piecesPerStrip)||10);return {name:String(i.name||'').trim(),boxes,strips,pieces,stripsPerBox:spb,piecesPerStrip:pps,quantity:boxes*spb*pps+strips*pps+pieces,lineTotal:Math.max(0,Number(i.lineTotal)||0),sellingPrice:Math.max(0,Number(i.sellingPrice)||0)}}).filter(i=>i.name&&i.quantity>0);if(!normalized.length)return json(res,{ok:false,error:'Enter boxes, strips, or pieces for at least one medicine'},400);const totalCost=normalized.reduce((n,i)=>n+i.lineTotal,0),paidAmount=Math.min(totalCost,Math.max(0,Number(input.paidAmount)||0)),dueAmount=totalCost-paidAmount,paymentStatus=paidAmount>=totalCost?'PAID':paidAmount>0?'PARTIAL':'CREDIT';normalized.forEach(line=>{const product=state.inventory.find(p=>p.name.toLowerCase()===line.name.toLowerCase());if(product){product.stock+=line.quantity;if(line.sellingPrice)product.price=line.sellingPrice;product.stripsPerBox=line.stripsPerBox;product.piecesPerStrip=line.piecesPerStrip}else state.inventory.push({name:line.name,generic:'',stock:line.quantity,price:line.sellingPrice||0,stripsPerBox:line.stripsPerBox,piecesPerStrip:line.piecesPerStrip})});const purchase={invoiceNumber:input.invoiceNumber||`PUR-${Date.now().toString().slice(-6)}`,supplierId:supplier.id,supplier:supplier.name,items:normalized,totalCost,paidAmount,dueAmount,paymentStatus,paymentMethod:paidAmount?(input.paymentMethod||'Cash'):'CREDIT',paymentReference:input.paymentReference||'',createdAt:new Date().toISOString()};state.purchases.unshift(purchase);supplier.purchased=(supplier.purchased||0)+totalCost;supplier.paid=(supplier.paid||0)+paidAmount;supplier.outstanding=(supplier.outstanding||0)+dueAmount;state.syncedAt=new Date().toISOString();saveState();return json(res,{ok:true,purchase,inventory:state.inventory});});
  const supplierPayment = url.pathname === '/api/suppliers/payment';
  const supplierBill = url.pathname === '/api/suppliers/bills';
  if (req.method === 'POST' && (supplierBill || supplierPayment || url.pathname === '/api/suppliers/due')) {
    if (!dentalApi.requireSameOrigin(req)) return json(res, { ok: false, error: 'Open Admin directly to update supplier balances.' }, 403);
    if (!supabaseEnabled) return json(res, { ok: false, error: 'Supabase is required to update supplier balances.' }, 503);
    return readBody(req).then(async input => {
      const rawAmount = supplierBill ? input?.total : input?.amount;
      const amount = Number(rawAmount);
      if (rawAmount == null || String(rawAmount).trim() === '' || !Number.isFinite(amount)
          || amount < (supplierPayment || supplierBill ? 0.01 : 0) || amount > 9999999999.99) {
        return json(res, { ok: false, error: 'Enter a valid amount.' }, 400);
      }
      const [supplier] = await supabaseRequest('suppliers', 'GET', { select: 'id,name', id: `eq.${input.supplierId}`, limit: 1 });
      if (!supplier) return json(res, { ok: false, error: 'Supplier not found.' }, 404);
      const imports = await supabaseRequest('legacy_imports', 'GET', {
        select: 'source_key,source_type,record', source_type: 'in.(supplier,supplier_snapshot)', limit: 10000
      });
      const row = imports.find(item => item.source_key === `supplier:${supplier.id}`) ||
        imports.find(item => ['supplier', 'supplier_snapshot'].includes(item.source_type) &&
          item.record?.name?.toLowerCase() === supplier.name.toLowerCase());
      const previous = row?.record || {};
      const paid = Number(previous.paid) || 0;
      const outstanding = Number(previous.outstanding) || 0;
      const value = Math.round(amount * 100) / 100;
      const record = { ...previous, id: supplier.id, name: supplier.name, ledgerRevision: crypto.randomUUID() };
      const bills = Array.isArray(previous.bills) ? previous.bills : [];
      if (supplierBill) {
        const paidAmount = Number(input.paidAmount ?? 0);
        const reference = String(input.reference || '').trim();
        const billId = String(input.billId || '');
        if (!/^[0-9a-f-]{36}$/i.test(billId) || !Number.isFinite(paidAmount) || paidAmount < 0 || paidAmount > amount) {
          return json(res, { ok: false, error: 'Enter an amount paid between zero and the bill total.' }, 400);
        }
        const paidNow = Math.round(paidAmount * 100) / 100;
        const pending = Math.round((value - paidNow) * 100) / 100;
        const existing = bills.find(bill => bill.id === billId);
        if (existing) return json(res, { ok: true, bill: existing });
        if (reference && bills.some(bill => bill.reference?.toLowerCase() === reference.toLowerCase())) {
          return json(res, { ok: false, error: 'That bill number is already recorded for this supplier.' }, 409);
        }
        const createdAt = new Date().toISOString();
        const bill = { id: billId, reference, total: value, paid: paidNow, pending, createdAt };
        record.bills = [...bills, bill];
        record.purchased = Math.round(((Number(previous.purchased) || 0) + value) * 100) / 100;
        record.paid = Math.round((paid + paidNow) * 100) / 100;
        record.outstanding = Math.round((outstanding + pending) * 100) / 100;
        if (paidNow > 0) record.payments = [
          ...(Array.isArray(previous.payments) ? previous.payments : []),
          { amount: paidNow, method: 'Paid at entry', reference, billId, createdAt }
        ];
      } else if (supplierPayment) {
        if (input.billId) {
          const bill = bills.find(item => item.id === input.billId);
          if (!bill) return json(res, { ok: false, error: 'Supplier bill not found.' }, 404);
          if (value > bill.pending) return json(res, { ok: false, error: 'Payment exceeds this bill?s pending amount.' }, 400);
          record.bills = bills.map(item => item.id === bill.id ? {
            ...item, paid: Math.round((item.paid + value) * 100) / 100,
            pending: Math.round((item.pending - value) * 100) / 100
          } : item);
        }
        const payment = { amount: value, method: String(input.method || 'Cash'), reference: String(input.reference || ''), billId: input.billId || undefined, createdAt: new Date().toISOString() };
        record.payments = [...(Array.isArray(previous.payments) ? previous.payments : []), payment];
        record.paid = Math.round((paid + value) * 100) / 100;
        record.outstanding = Math.max(0, Math.round((outstanding - value) * 100) / 100);
      } else {
        record.outstanding = value;
      }
      if (row) {
        const updated = await supabaseRequest('legacy_imports', 'PATCH', {
          source_key: `eq.${row.source_key}`, 'record->>ledgerRevision': previous.ledgerRevision ? `eq.${previous.ledgerRevision}` : 'is.null'
        }, { record });
        if (!updated.length) return json(res, { ok: false, error: 'This supplier balance changed. Try again.' }, 409);
      }
      else await supabaseRequest('legacy_imports', 'POST', {}, { source_key: `supplier:${supplier.id}`, source_type: 'supplier_snapshot', record });
      return json(res, { ok: true });
    }).catch(error => error.message.includes('"23505"')
      ? json(res, { ok: false, error: 'This supplier balance changed. Try again.' }, 409)
      : json(res, { ok: false, error: 'Could not update the supplier balance in Supabase.' }, 503));
  }
  if (req.method === 'POST' && url.pathname === '/api/purchases') return readBody(req).then(input => { const boxes = Math.max(0, Number(input.boxes) || 0), strips = Math.max(0, Number(input.strips) || 0), pieces = Math.max(0, Number(input.pieces) || 0), stripsPerBox = Math.max(1, Number(input.stripsPerBox) || 10), piecesPerStrip = Math.max(1, Number(input.piecesPerStrip) || 10), quantity = boxes * stripsPerBox * piecesPerStrip + strips * piecesPerStrip + pieces, buyPrice = Math.max(0, Number(input.buyPrice) || 0), taxPercent = Math.max(0, Number(input.taxPercent) || 0), subtotal = quantity * buyPrice, taxAmount = subtotal * taxPercent / 100, totalCost = subtotal + taxAmount; if (!input.supplier || !input.name || quantity < 1) return json(res, { ok: false, error: 'Supplier, medicine, and at least one box, strip, or piece are required' }, 400); const product = state.inventory.find(item => item.name.toLowerCase() === String(input.name).toLowerCase()); if (product) { product.stock += quantity; product.generic = input.generic || product.generic; product.price = Number(input.sellingPrice) || product.price; product.stripsPerBox = stripsPerBox; product.piecesPerStrip = piecesPerStrip; } else state.inventory.push({ name: input.name, generic: input.generic || '', stock: quantity, price: Number(input.sellingPrice) || 0, stripsPerBox, piecesPerStrip }); const quantityLabel = [boxes ? `${boxes} box${boxes === 1 ? '' : 'es'}` : '', strips ? `${strips} strip${strips === 1 ? '' : 's'}` : '', pieces ? `${pieces} piece${pieces === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + '); state.purchases.unshift({ supplier: input.supplier, name: input.name, quantity, quantityLabel, boxes, strips, pieces, stripsPerBox, piecesPerStrip, buyPrice, taxPercent, subtotal, taxAmount, totalCost, cost: totalCost, createdAt: new Date().toISOString() }); state.syncedAt = new Date().toISOString(); saveState(); json(res, { ok: true, purchase: state.purchases[0], inventory: state.inventory }); });
  if (supplierCreate) {
    if (!dentalApi.requireSameOrigin(req)) {
      return json(res, { ok: false, error: 'Open the app directly to save a supplier.' }, 403);
    }
    return readBody(req).then(async input => {
      const field = key => typeof input?.[key] === 'string' ? input[key].trim() : '';
      const name = field('name');
      if (!name) return json(res, { ok: false, error: 'Supplier name is required.' }, 400);
      if (!supabaseEnabled) return json(res, { ok: false, error: 'Supabase is required to save suppliers.' }, 503);

      try {
        const [supplier] = await supabaseRequest('suppliers', 'POST', {}, {
          name,
          contact_name: field('contact'),
          phone: field('phone'),
          email: field('email'),
          brands: field('brands'),
          categories: field('categories')
        });
        return json(res, { ok: true, supplier }, 201);
      } catch (error) {
        if (error.message.includes('"23505"')) {
          return json(res, { ok: false, error: 'A supplier with that name already exists. Select it from the supplier list.' }, 409);
        }
        return json(res, { ok: false, error: 'Could not save supplier to the shared database.' }, 503);
      }
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/suppliers' && isStaff) {
    if (!supabaseEnabled) return json(res, { ok: false, error: 'Supabase is required to load suppliers.' }, 503);
    return supabaseRequest('suppliers', 'GET', { select: 'id,name,phone,contact_name', active: 'eq.true', order: 'name.asc', limit: 5000 })
      .then(rows => json(res, { ok: true, suppliers: rows.map(({ id, name, phone, contact_name }) => ({ id, name, phone, contact: contact_name })) }))
      .catch(() => json(res, { ok: false, error: 'Could not load suppliers from Supabase.' }, 503));
  }
  if (req.method === 'GET' && url.pathname === '/api/suppliers') return adminStateResponse(res, admin => json(res, { ok: true, suppliers: admin.suppliers }));
  if (req.method === 'GET' && url.pathname === '/api/export/purchases') return csvDownload(res, 'pharmflow-purchases.csv', ['Date', 'Supplier', 'Supplier ID', 'Medicine', 'Quantity', 'Buying Subtotal', 'Tax %', 'Tax Amount', 'Total Cost'], state.purchases.map(p => [p.createdAt, p.supplierName || p.supplier, p.supplierId, p.name, p.quantityLabel || `${p.quantity} pieces`, p.subtotal || p.cost || 0, p.taxPercent || 0, p.taxAmount || 0, p.totalCost || p.cost || 0]));
  if (req.method === 'GET' && url.pathname === '/api/export/bills') return adminStateResponse(res, admin => {
    const date = url.searchParams.get('date');
    const normalize = value => String(value || '').trim().toLowerCase();
    const doctor = normalize(url.searchParams.get('doctor'));
    const medicine = normalize(url.searchParams.get('medicine'));
    const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
    const bills = admin.transactions.filter(bill =>
      (!date || dayFormatter.format(new Date(bill.createdAt)) === date) &&
      (!doctor || normalize(bill.doctor) === doctor) &&
      (!medicine || bill.items.some(item => normalize(item.name) === medicine))
    );
    return csvDownload(res, 'pharmflow-bills.csv',
      ['Invoice', 'Date', 'Branch', 'Customer', 'Phone', 'Doctor', 'Medicines', 'Employee', 'Amount', 'Payment', 'Status'],
      bills.map(bill => [bill.invoice, bill.createdAt, bill.branch, bill.customer, bill.phone, bill.doctor,
        bill.items.map(item => `${item.name} x ${item.quantity}`).join(', '), bill.employee, bill.amount, bill.payment, bill.status]));
  });
if (req.method === 'GET' && url.pathname === '/api/export/inventory') {
  applyExpiryRules();
  const inventory = inventoryWithExpiry();
  return csvDownload(res, 'pharmflow-inventory.csv', ['Medicine', 'Generic Name', 'Stock Pieces', 'Strips Per Box', 'Pieces Per Strip', 'Selling Price Per Piece', 'Stock Value', 'Expiry', 'Status'], inventory.map(item => [item.name, item.generic, item.stock, item.stripsPerBox, item.piecesPerStrip, item.price, item.value, item.expiryDate || '', item.expiryStatus]));
}
  if (req.method === 'POST' && url.pathname === '/api/suppliers') return readBody(req).then(input => { if (!input.name) return json(res, { ok: false, error: 'Supplier name is required' }, 400); const supplier = { id: `SUP${String(Date.now()).slice(-5)}`, name: input.name, contact: input.contact || '', phone: input.phone || '', email: input.email || '', brands: input.brands || '', categories: input.categories || '' }; state.suppliers.push(supplier); saveState(); json(res, { ok: true, supplier }); });
  if (req.method === 'GET' && url.pathname === '/api/reports') return adminStateResponse(res, admin => {
    const inventory = admin.inventory.map(({ buyingValue, ...item }) => ({ ...item, value: Math.round(buyingValue * 100) / 100 }));
    const salesTotal = admin.transactions.reduce((total, transaction) => total + (Number(transaction.amount) || 0), 0);
    const itemizedPurchaseCost = admin.purchases.reduce((total, purchase) => total + (Number(purchase.totalCost ?? purchase.cost) || 0), 0);
    const supplierBillCost = admin.suppliers.reduce((total, supplier) =>
      total + supplier.bills.reduce((subtotal, bill) => subtotal + (Number(bill.total) || 0), 0), 0);
    const purchaseCost = Math.round((itemizedPurchaseCost + supplierBillCost) * 100) / 100;
    const profit = salesTotal - purchaseCost;
    const profitPercent = purchaseCost > 0 ? profit / purchaseCost * 100 : null;
    return json(res, { ok: true, salesTotal, purchaseCost, profit, profitPercent, billCount: admin.transactions.length, stockUnits: inventory.reduce((total, item) => total + (Number(item.stock) || 0), 0), stockValue: inventory.reduce((total, item) => total + (Number(item.value) || 0), 0), inventoryValue: inventory.reduce((total, item) => total + (Number(item.value) || 0), 0), nearExpiryCount: inventory.filter(item => item.nearExpiry).length, expiredCount: inventory.filter(item => item.expiryStatus === 'EXPIRED').length, inventory });
  });
  if (req.method === 'POST' && url.pathname === '/api/stock/add') return readBody(req).then(input => { const boxes = Math.max(0, Number(input.boxes) || 0), strips = Math.max(0, Number(input.strips) || 0), pieces = Math.max(0, Number(input.pieces) || 0), stripsPerBox = Math.max(1, Number(input.stripsPerBox) || 10), piecesPerStrip = Math.max(1, Number(input.piecesPerStrip) || 10), quantity = boxes * stripsPerBox * piecesPerStrip + strips * piecesPerStrip + pieces; if (!input.name || quantity < 1) return json(res, { ok: false, error: 'Medicine and at least one box, strip, or piece are required' }, 400); const product = state.inventory.find(item => item.name.toLowerCase() === String(input.name).toLowerCase()); if (product) { product.stock += quantity; product.generic = input.generic || product.generic; product.price = Number(input.sellingPrice) || product.price; } else state.inventory.push({ name: input.name, generic: input.generic || '', stock: quantity, price: Number(input.sellingPrice) || 0, stripsPerBox, piecesPerStrip }); state.syncedAt = new Date().toISOString(); saveState(); json(res, { ok: true, inventory: state.inventory }); });
if (req.method === 'POST' && url.pathname === '/api/sale' && supabaseEnabled) return readBody(req).then(async sale => {
  const items = Array.isArray(sale.items) ? sale.items.map(item => ({ name: String(item.name || '').trim(), quantity: Math.max(0, Number(item.quantity) || 0), price: Math.max(0, Number(item.price) || 0), amount: Math.max(0, Number(item.amount) || (Number(item.price) || 0) * (Number(item.quantity) || 0)) })).filter(item => item.name && item.quantity > 0) : [];
  const paymentMethod = sale.method || sale.paymentMethod || 'Cash';
  if (!items.length || !['Cash', 'UPI', 'Card'].includes(paymentMethod)) return json(res, { ok: false, error: 'Add valid medicines and payment details before billing.' }, 400);
  try {
    const branches = await supabaseRequest('branches', 'GET', { select: 'id,name', name: `eq.${sale.branch || 'Assam'}`, limit: 1 });
    if (!branches[0]) return json(res, { ok: false, error: 'Staff clinic branch was not found.' }, 400);
    const staffSession = dentalApi.getSession(req);
    const result = await dentalApi.recordSaleDirect({ branchId: branches[0].id, items, paymentMethod, paymentReference: sale.paymentReference || '', customer: sale.customer || '', phone: sale.phone || '', discount: 0, createdBy: staffSession?.employeeId || null, patientSource: sale.patientSource, doctor: sale.doctor });
    const transaction = { invoice: result?.invoice_number || result?.invoice || '#SAVED', branch: branches[0].name, customer: sale.customer || 'Walk-in customer', phone: sale.phone || '', employee: sale.employee || '', patientSource: sale.patientSource || 'WALK_IN', doctor: sale.doctor || '', items: result?.items || items, amount: Number(result?.total) || items.reduce((total, item) => total + item.amount, 0), payment: paymentMethod, paymentMethod, status: 'Completed', createdAt: new Date().toISOString() };
    return json(res, { ok: true, transaction, source: 'supabase' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isValidationError = /only .* units available|not enough stock|valid medicines|payment details|referring doctor|required/i.test(message);
    return json(res, { ok: false, error: message }, isValidationError ? 400 : 503);
  }
});
if (req.method === 'POST' && url.pathname === '/api/sale') return readBody(req).then(sale => { const items = Array.isArray(sale.items) ? sale.items.map(item => ({ name: String(item.name || '').trim(), quantity: Math.max(0, Number(item.quantity) || 0), price: Math.max(0, Number(item.price) || 0), amount: Math.max(0, Number(item.amount) || (Number(item.price) || 0) * (Number(item.quantity) || 0)) })).filter(item => item.name && item.quantity > 0) : []; if (!items.length) return json(res, { ok: false, error: 'Add at least one medicine with a valid quantity before billing.' }, 400); for (const item of items) { const product = state.inventory.find(p => p.name === item.name); if (!product || item.quantity > product.stock) return json(res, { ok: false, error: `Only ${product?.stock || 0} units available for ${item.name}` }, 400); } items.forEach(item => { state.inventory.find(p => p.name === item.name).stock -= item.quantity; }); const paymentMethod = sale.method || sale.paymentMethod || 'Cash'; const patientSource = sale.patientSource === 'DOCTOR_REFERRAL' ? 'DOCTOR_REFERRAL' : 'WALK_IN'; const doctor = patientSource === 'DOCTOR_REFERRAL' ? String(sale.doctor || sale.consultant || '').trim() : ''; if (patientSource === 'DOCTOR_REFERRAL' && !doctor) return json(res, { ok: false, error: 'A referring doctor is required for doctor referrals.' }, 400); const transaction = { invoice: `#INV-${String(Date.now()).slice(-5)}`, branch: sale.branch || 'MG Road', customer: sale.customer || 'Walk-in customer', phone: sale.phone || '', employee: sale.employee || '', patientSource, doctor, ageGender: sale.ageGender || sale.age || '', opdNumber: sale.opdNumber || sale.opd || sale.uhid || '', remarks: sale.remarks || '', items, amount: Number(sale.amount) || items.reduce((total, item) => total + item.amount, 0), payment: paymentMethod, paymentMethod, status: 'Completed', createdAt: new Date().toISOString() }; state.salesToday += transaction.amount; state.transactions.unshift(transaction); state.transactions = state.transactions.slice(0, 100); state.syncedAt = transaction.createdAt; saveState(); json(res, { ok: true, transaction, state }); });
if (url.pathname === '/api/inventory') {
  if (supabaseEnabled) return adminStateResponse(res, admin => json(res, { ok: true, inventory: isStaff ? admin.inventory.map(({ buyingValue, ...item }) => item) : admin.inventory }));
  applyExpiryRules();
  return json(res, { ok: true, inventory: inventoryWithExpiry() });
}
  if (url.pathname === '/api/state') return adminStateResponse(res, admin => json(res, isStaff ? { transactions: admin.transactions.filter(sale => sale.employee === session.name) } : admin));
  if (url.pathname === '/api/health') return json(res, { ok: true, synchronizedPorts: [4173, 4174], syncedAt: state.syncedAt, supabase: supabaseEnabled, supabaseStatus: supabaseEnabled ? 'configured' : 'not configured' });
  const requested = url.pathname === '/' ? (req.socket.localPort === 4174 ? 'pos.html' : 'admin.html') : url.pathname.slice(1);
  const allowed = new Set(['admin.html', 'pos.html', 'index.html', 'styles.css', 'pwa.js', 'service-worker.js', 'admin.webmanifest', 'staff.webmanifest', 'print-features.js', 'admin-dashboard.js', 'admin-live-inventory.js', 'admin-controls.js', 'admin-employees.js', 'admin-employee-api.js', 'admin-navigation.js', 'admin-profit-reports.js', 'admin-purchase-units.js', 'admin-multi-purchase.js', 'admin-partial-payment.js', 'admin-supplier-payments.js', 'admin-requests.js', 'sales-app-v2.js', 'sales-login.js', 'sales-cancel.js', 'sales-doctor.js', 'sales-requests.js', 'assets/nance-polyclinic-logo.jpeg']);
  if (!allowed.has(requested)) return res.end('Not found');
  const file = path.join(root, requested);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', path.extname(file) === '.css' ? 'text/css' : path.extname(file) === '.html' ? 'text/html' : path.extname(file) === '.jpeg' ? 'image/jpeg' : path.extname(file) === '.webmanifest' ? 'application/manifest+json' : 'text/javascript');
  let output = fs.readFileSync(file);
  if (requested === 'admin.html') output = Buffer.from(output.toString().replace('</body>', '<script src="print-features.js"></script><script src="admin-purchase-units.js"></script><script src="admin-multi-purchase.js"></script><script src="admin-partial-payment.js"></script><script src="admin-profit-reports.js"></script><script src="admin-supplier-payments.js"></script><script src="admin-requests.js"></script></body>'));
  if (requested === 'pos.html') output = Buffer.from(output.toString().replace('</body>', `${output.toString().includes('sales-login.js') ? '' : '<script src="sales-login.js"></script>'}<script src="print-features.js"></script><script src="sales-doctor.js"></script><script src="sales-requests.js"></script></body>`));
  res.end(output);
}

const listenPort = Number(process.env.PORT) || 4173;
const listenHost = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
http.createServer(handler).listen(listenPort, listenHost, () => console.log(`Pharmflow ${listenPort}: http://${listenHost}:${listenPort}`));
