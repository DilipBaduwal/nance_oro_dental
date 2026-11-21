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
const stateFile = path.join(root, 'pharmflow-state.json');
const defaultEmployees = [{ code: 'EMP001', password: 'demo123', name: 'Billing Staff', role: 'BILLING_STAFF', branch: 'MG Road' }];
const initialInventory = [
  { name: 'Augmentin 625mg', generic: 'Amoxicillin + Clavulanate', stock: 24, price: 18.5 },
  { name: 'Pantop 40mg', generic: 'Pantoprazole', stock: 86, price: 4.2 },
  { name: 'Dolo 650mg', generic: 'Paracetamol', stock: 142, price: 2.1 },
  { name: 'Telma 40mg', generic: 'Telmisartan', stock: 12, price: 7.8 },
  { name: 'Azithral 500mg', generic: 'Azithromycin', stock: 7, price: 11.2 },
  { name: 'Shelcal 500mg', generic: 'Calcium + Vitamin D3', stock: 53, price: 5.4 }
];
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { syncedAt: new Date().toISOString(), salesToday: 84260, transactions: [], inventory: initialInventory, employees: defaultEmployees, purchases: [], suppliers: [] };
if (!Array.isArray(state.employees)) state.employees = defaultEmployees;
if (!Array.isArray(state.purchases)) state.purchases = [];
if (!Array.isArray(state.suppliers)) state.suppliers = [];
if (!Array.isArray(state.medicineRequests)) state.medicineRequests = [];
state.inventory.forEach(item => { item.stripsPerBox = Number(item.stripsPerBox) || 10; item.piecesPerStrip = Number(item.piecesPerStrip) || 10; });
function saveState() { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
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
  const [sales, saleItems, medicines, batches, branches, suppliers, purchases, purchaseItems, legacyImports] = await Promise.all([
    supabaseRequest('sales', 'GET', { select: 'id,branch_id,invoice_number,customer_name,customer_mobile,total,payment_method,status,created_at', order: 'created_at.desc', limit: 5000 }),
    supabaseRequest('sale_items', 'GET', { select: 'sale_id,medicine_id,quantity,unit_price', limit: 20000 }),
    supabaseRequest('medicines', 'GET', { select: 'id,name,generic_name', limit: 5000 }),
    supabaseRequest('batches', 'GET', { select: 'id,medicine_id,branch_id,batch_number,expiry_date,selling_price,available_quantity,status', limit: 10000 }),
    supabaseRequest('branches', 'GET', { select: 'id,name', limit: 1000 }),
    supabaseRequest('suppliers', 'GET', { select: 'id,name,contact_name,phone,email,brands,categories,active,created_at', order: 'created_at.desc', limit: 5000 }),
    supabaseRequest('purchases', 'GET', { select: 'id,branch_id,supplier_id,invoice_number,subtotal,tax,total,created_at', order: 'created_at.desc', limit: 5000 }),
    supabaseRequest('purchase_items', 'GET', { select: 'purchase_id,medicine_id,quantity,boxes,strips,pieces,unit_cost,tax_rate,line_total', limit: 20000 }),
    supabaseRequest('legacy_imports', 'GET', { select: 'source_type,record', source_type: 'eq.supplier', limit: 5000 })
  ]);
  const medicineMap = new Map(medicines.map(item => [item.id, item]));
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
    employee: '',
    patientSource: 'WALK_IN',
    doctor: '',
    items: itemsBySale.get(sale.id) || [],
    amount: Number(sale.total) || 0,
    payment: sale.payment_method || 'Cash',
    paymentMethod: sale.payment_method || 'Cash',
    status: sale.status || 'Completed'
  }));
  const localInventoryByName = new Map((state.inventory || []).map(item => [item.name.toLowerCase(), item]));
  const primaryBranchId = branches.find(branch => branch.name === 'MG Road')?.id;
  const inventoryMap = new Map();
  batches.filter(batch => !primaryBranchId || batch.branch_id === primaryBranchId).forEach(batch => {
    const medicine = medicineMap.get(batch.medicine_id);
    if (!medicine) return;
    const localItem = localInventoryByName.get(medicine.name.toLowerCase());
    const item = inventoryMap.get(batch.medicine_id) || { name: medicine.name, generic: medicine.generic_name || '', stock: 0, price: Number(batch.selling_price) || 0, expiryDate: localItem?.expiryDate || '', batches: [] };
    item.stock += Number(batch.available_quantity) || 0;
    item.price = Number(batch.selling_price) || item.price;
    item.batches.push({ batchNumber: batch.batch_number || '', expiryDate: batch.expiry_date || '', stock: Number(batch.available_quantity) || 0, status: batch.status || '' });
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
  const inventoryOrder = new Map((state.inventory || []).map((item, index) => [item.name.toLowerCase(), index]));
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
  const localSupplierOrder = new Map((state.suppliers || []).map((supplier, index) => [supplier.name.toLowerCase(), index]));
  const cloudSuppliers = suppliers.map(supplier => {
    const imported = legacyImports.find(row => row.record?.name?.toLowerCase() === supplier.name.toLowerCase())?.record || {};
    return {
    id: supplier.id, name: supplier.name, contact: supplier.contact_name || '', phone: supplier.phone || '',
    email: supplier.email || '', brands: supplier.brands || '', categories: supplier.categories || '', active: supplier.active,
    purchased: Number(imported.purchased) || 0, paid: Number(imported.paid) || 0, outstanding: Number(imported.outstanding) || 0,
    payments: []
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

function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/dental/')) return dentalApi.handle(req, res);
  const adminProtectedRoutes = new Set([
    '/api/state', '/api/reports', '/api/purchases', '/api/suppliers/payment',
    '/api/medicine-requests/approve', '/api/purchases/normalized',
    '/api/purchases/invoice', '/api/export/bills', '/api/export/purchases',
    '/api/export/inventory', '/api/stock/add'
  ]);
  const staffReadableRoutes = new Set(['/api/inventory', '/api/employees', '/api/suppliers', '/api/medicine-requests']);
  const session = dentalApi.getSession(req);
  const isAdmin = session?.role === 'ADMIN';
  const isStaff = session?.role === 'STAFF';
  const staffMayRead = staffReadableRoutes.has(url.pathname) && req.method === 'GET';
  const adminSessionRequired = adminProtectedRoutes.has(url.pathname) || (url.pathname === '/api/employees' && req.method !== 'GET') || (url.pathname === '/api/suppliers' && req.method !== 'GET');
  if (url.pathname === '/api/state' && !isAdmin && !isStaff) {
    if (!dentalApi.requireAdmin(req, res)) return;
  } else if (adminSessionRequired && !(url.pathname === '/api/state' && isStaff)) {
    if (!dentalApi.requireAdmin(req, res)) return;
  } else if (staffMayRead && !isAdmin && !isStaff) {
    res.statusCode = 401;
    return json(res, { ok: false, error: 'Staff or admin sign-in is required.' }, 401);
  }
  if (req.method === 'POST' && url.pathname === '/api/login') return readBody(req).then(async input => { if(supabaseEnabled){try{const token=await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:employeeEmail(input.code),password:input.password})});if(!token.ok)return json(res,{ok:false,error:'Invalid employee ID or password'});const auth=await token.json(),profiles=await supabaseRequest('profiles','GET',{select:'employee_code,full_name,role,branch_id',id:`eq.${auth.user.id}`,limit:1}),branches=await supabaseRequest('branches','GET',{select:'id,name',id:`eq.${profiles[0]?.branch_id}`,limit:1});return json(res,{ok:true,employee:{code:profiles[0]?.employee_code||input.code,name:profiles[0]?.full_name||input.code,role:profiles[0]?.role||'BILLING_STAFF',branch:branches[0]?.name||'MG Road'}})}catch{return json(res,{ok:false,error:'Invalid employee ID or password'})}} const employee=state.employees.find(e=>e.code===input.code&&verifyPassword(input.password||'',e));return json(res,employee?{ok:true,employee:{code:employee.code,name:employee.name,role:employee.role,branch:employee.branch}}:{ok:false,error:'Invalid employee ID or password'}); });
  if (req.method === 'GET' && url.pathname === '/api/employees') return (async()=>{if(supabaseEnabled){try{const rows=await supabaseRequest('profiles','GET',{select:'employee_code,full_name,role,active,branch_id',employee_code:'not.is.null',limit:1000}),branches=await supabaseRequest('branches','GET',{select:'id,name',limit:1000}),names=new Map(branches.map(b=>[b.id,b.name]));return json(res,{ok:true,employees:rows.map(p=>({code:p.employee_code,name:p.full_name,role:p.role==='PHARMACIST'?'DOCTOR':p.role,active:p.active,branch:names.get(p.branch_id)||'Unassigned'}))})}catch(e){return json(res,{ok:false,error:e.message},503)}}return json(res,{ok:true,employees:state.employees.map(({password,passwordHash,...employee})=>({...employee,role:employee.role==='PHARMACIST'?'DOCTOR':employee.role}))})})();
  if (req.method === 'GET' && url.pathname === '/api/medicine-requests') return json(res, { ok: true, requests: state.medicineRequests });
  if (req.method === 'POST' && url.pathname === '/api/medicine-requests') return readBody(req).then(input => { if (!input.name || !input.supplier || Number(input.quantity)<1) return json(res, { ok:false, error:'Medicine, supplier, and quantity are required' }, 400); const request = { id:`REQ-${Date.now()}`, name:String(input.name).trim(), generic:input.generic||'', supplier:String(input.supplier).trim(), supplierId:input.supplierId||'', quantity:Number(input.quantity)||0, boxes:Number(input.boxes)||0, strips:Number(input.strips)||0, pieces:Number(input.pieces)||0, stripsPerBox:Number(input.stripsPerBox)||10, piecesPerStrip:Number(input.piecesPerStrip)||10, purchaseTotal:Number(input.purchaseTotal)||0, price:Number(input.price)||0, discountPercent:Math.max(0,Math.min(100,Number(input.discountPercent)||0)), expiryDate:input.expiryDate||'', requestedBy:input.requestedBy||'Staff', status:'PENDING', createdAt:new Date().toISOString() }; state.medicineRequests.unshift(request); saveState(); json(res,{ok:true,request}); });
  if (req.method === 'POST' && url.pathname === '/api/medicine-requests/approve') return readBody(req).then(input => { const request=state.medicineRequests.find(r=>r.id===input.id); if(!request) return json(res,{ok:false,error:'Request not found'},404); if(request.status!=='PENDING') return json(res,{ok:false,error:`Request already ${request.status.toLowerCase()}`},409); if(input.approved){let supplier=state.suppliers.find(s=>s.id===request.supplierId||s.name.toLowerCase()===request.supplier.toLowerCase()); if(!supplier){supplier={id:`SUP${String(Date.now()).slice(-5)}`,name:request.supplier,contact:'',phone:'',email:'',brands:'',categories:'',purchased:0,paid:0,outstanding:0};state.suppliers.push(supplier)} const product=state.inventory.find(p=>p.name.toLowerCase()===request.name.toLowerCase()), effectivePrice=Math.max(0,Number(request.price)||0)*(1-Math.max(0,Math.min(100,Number(request.discountPercent)||0))/100); if(product){product.stock+=Math.max(0,request.quantity);product.price=effectivePrice||product.price;product.discountPercent=Number(request.discountPercent)||0;product.expiryDate=request.expiryDate||product.expiryDate}else state.inventory.push({name:request.name,generic:request.generic,stock:Math.max(0,request.quantity),price:effectivePrice,discountPercent:Number(request.discountPercent)||0,expiryDate:request.expiryDate||'',stripsPerBox:request.stripsPerBox,piecesPerStrip:request.piecesPerStrip}); const total=Number(request.purchaseTotal)||0; state.purchases.unshift({invoiceNumber:`REQ-${request.id}`,supplierId:supplier.id,supplier:supplier.name,name:request.name,quantity:request.quantity,quantityLabel:`${request.boxes} boxes + ${request.strips} strips + ${request.pieces} pieces`,boxes:request.boxes,strips:request.strips,pieces:request.pieces,stripsPerBox:request.stripsPerBox,piecesPerStrip:request.piecesPerStrip,totalCost:total,cost:total,buyPrice:total/Math.max(1,request.quantity),sellingPrice:effectivePrice,discountPercent:Number(request.discountPercent)||0,expiryDate:request.expiryDate,paymentStatus:'PENDING_APPROVAL',createdAt:new Date().toISOString()});supplier.purchased=(supplier.purchased||0)+total;supplier.outstanding=(supplier.outstanding||0)+total; request.status='APPROVED';}else request.status='REJECTED'; request.reviewedAt=new Date().toISOString(); saveState(); json(res,{ok:true,request,inventory:state.inventory}); });
  if (req.method === 'POST' && url.pathname === '/api/employees') return readBody(req).then(async input => { const code=String(input.code||'').trim().toUpperCase();if(!input.name||!code||!input.password)return json(res,{ok:false,error:'Full name, employee ID, and password are required'},400);if(supabaseEnabled){try{const branches=await supabaseRequest('branches','GET',{select:'id,name',name:`eq.${input.branch||'MG Road'}`,limit:1});if(!branches[0])return json(res,{ok:false,error:'Branch not found'},400);const auth=await supabaseAuth('users','POST',{email:employeeEmail(code),password:input.password,email_confirm:true,user_metadata:{full_name:input.name}});const profile=(await supabaseRequest('profiles','POST',{}, {id:auth.id,employee_code:code,full_name:String(input.name).trim(),role:input.role==='DOCTOR'?'PHARMACIST':'BILLING_STAFF',branch_id:branches[0].id}))[0];return json(res,{ok:true,employee:{code,name:profile.full_name,role:input.role||'SUPPORT_STAFF',branch:branches[0].name}},201)}catch(e){return json(res,{ok:false,error:e.message},503)}}if(state.employees.some(e=>e.code===code))return json(res,{ok:false,error:'Employee ID already exists'},400);const employee={code,password:input.password,name:String(input.name).trim(),role:input.role||'SUPPORT_STAFF',branch:input.branch||'MG Road'};state.employees.push(employee);saveState();json(res,{ok:true,employee:{...employee,password:undefined}})});
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
  if (req.method === 'POST' && url.pathname === '/api/suppliers/payment') return readBody(req).then(input => { const supplier=state.suppliers.find(s=>s.id===input.supplierId);const amount=Math.max(0,Number(input.amount)||0);if(!supplier||amount<1)return json(res,{ok:false,error:'Select a supplier and enter a payment amount'},400);supplier.paid=(supplier.paid||0)+amount;supplier.outstanding=Math.max(0,(supplier.outstanding||0)-amount);state.supplierPayments=state.supplierPayments||[];state.supplierPayments.unshift({supplierId:supplier.id,supplier:supplier.name,amount,method:input.method||'Cash',reference:input.reference||'',createdAt:new Date().toISOString()});saveState();return json(res,{ok:true,supplier});});
  if (req.method === 'POST' && url.pathname === '/api/purchases') return readBody(req).then(input => { const boxes = Math.max(0, Number(input.boxes) || 0), strips = Math.max(0, Number(input.strips) || 0), pieces = Math.max(0, Number(input.pieces) || 0), stripsPerBox = Math.max(1, Number(input.stripsPerBox) || 10), piecesPerStrip = Math.max(1, Number(input.piecesPerStrip) || 10), quantity = boxes * stripsPerBox * piecesPerStrip + strips * piecesPerStrip + pieces, buyPrice = Math.max(0, Number(input.buyPrice) || 0), taxPercent = Math.max(0, Number(input.taxPercent) || 0), subtotal = quantity * buyPrice, taxAmount = subtotal * taxPercent / 100, totalCost = subtotal + taxAmount; if (!input.supplier || !input.name || quantity < 1) return json(res, { ok: false, error: 'Supplier, medicine, and at least one box, strip, or piece are required' }, 400); const product = state.inventory.find(item => item.name.toLowerCase() === String(input.name).toLowerCase()); if (product) { product.stock += quantity; product.generic = input.generic || product.generic; product.price = Number(input.sellingPrice) || product.price; product.stripsPerBox = stripsPerBox; product.piecesPerStrip = piecesPerStrip; } else state.inventory.push({ name: input.name, generic: input.generic || '', stock: quantity, price: Number(input.sellingPrice) || 0, stripsPerBox, piecesPerStrip }); const quantityLabel = [boxes ? `${boxes} box${boxes === 1 ? '' : 'es'}` : '', strips ? `${strips} strip${strips === 1 ? '' : 's'}` : '', pieces ? `${pieces} piece${pieces === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + '); state.purchases.unshift({ supplier: input.supplier, name: input.name, quantity, quantityLabel, boxes, strips, pieces, stripsPerBox, piecesPerStrip, buyPrice, taxPercent, subtotal, taxAmount, totalCost, cost: totalCost, createdAt: new Date().toISOString() }); state.syncedAt = new Date().toISOString(); saveState(); json(res, { ok: true, purchase: state.purchases[0], inventory: state.inventory }); });
  if (req.method === 'GET' && url.pathname === '/api/suppliers') return adminStateResponse(res, admin => json(res, { ok: true, suppliers: admin.suppliers }));
  if (req.method === 'GET' && url.pathname === '/api/export/purchases') return csvDownload(res, 'pharmflow-purchases.csv', ['Date', 'Supplier', 'Supplier ID', 'Medicine', 'Quantity', 'Buying Subtotal', 'Tax %', 'Tax Amount', 'Total Cost'], state.purchases.map(p => [p.createdAt, p.supplierName || p.supplier, p.supplierId, p.name, p.quantityLabel || `${p.quantity} pieces`, p.subtotal || p.cost || 0, p.taxPercent || 0, p.taxAmount || 0, p.totalCost || p.cost || 0]));
  if (req.method === 'GET' && url.pathname === '/api/export/bills') return csvDownload(res, 'pharmflow-bills.csv', ['Invoice', 'Date', 'Branch', 'Customer', 'Phone', 'Employee', 'Amount', 'Payment', 'Status'], state.transactions.map(t => [t.invoice, t.createdAt, t.branch, t.customer, t.phone, t.employee, t.amount, t.payment, t.status]));
if (req.method === 'GET' && url.pathname === '/api/export/inventory') {
  applyExpiryRules();
  const inventory = inventoryWithExpiry();
  return csvDownload(res, 'pharmflow-inventory.csv', ['Medicine', 'Generic Name', 'Stock Pieces', 'Strips Per Box', 'Pieces Per Strip', 'Selling Price Per Piece', 'Stock Value', 'Expiry', 'Status'], inventory.map(item => [item.name, item.generic, item.stock, item.stripsPerBox, item.piecesPerStrip, item.price, item.value, item.expiryDate || '', item.expiryStatus]));
}
  if (req.method === 'POST' && url.pathname === '/api/suppliers') return readBody(req).then(input => { if (!input.name) return json(res, { ok: false, error: 'Supplier name is required' }, 400); const supplier = { id: `SUP${String(Date.now()).slice(-5)}`, name: input.name, contact: input.contact || '', phone: input.phone || '', email: input.email || '', brands: input.brands || '', categories: input.categories || '' }; state.suppliers.push(supplier); saveState(); json(res, { ok: true, supplier }); });
  if (req.method === 'GET' && url.pathname === '/api/reports') return adminStateResponse(res, admin => {
    const inventory = supabaseEnabled ? admin.inventory : inventoryWithExpiry();
    const salesTotal = admin.transactions.reduce((total, transaction) => total + (Number(transaction.amount) || 0), 0);
    const purchaseCost = admin.purchases.reduce((total, purchase) => total + (Number(purchase.totalCost || purchase.cost) || 0), 0);
    return json(res, { ok: true, salesTotal, purchaseCost, profit: salesTotal - purchaseCost, billCount: admin.transactions.length, stockUnits: inventory.reduce((total, item) => total + (Number(item.stock) || 0), 0), stockValue: inventory.reduce((total, item) => total + (Number(item.value) || 0), 0), inventoryValue: inventory.reduce((total, item) => total + (Number(item.value) || 0), 0), nearExpiryCount: inventory.filter(item => item.nearExpiry).length, expiredCount: inventory.filter(item => item.expiryStatus === 'EXPIRED').length, inventory });
  });
  if (req.method === 'POST' && url.pathname === '/api/stock/add') return readBody(req).then(input => { const boxes = Math.max(0, Number(input.boxes) || 0), strips = Math.max(0, Number(input.strips) || 0), pieces = Math.max(0, Number(input.pieces) || 0), stripsPerBox = Math.max(1, Number(input.stripsPerBox) || 10), piecesPerStrip = Math.max(1, Number(input.piecesPerStrip) || 10), quantity = boxes * stripsPerBox * piecesPerStrip + strips * piecesPerStrip + pieces; if (!input.name || quantity < 1) return json(res, { ok: false, error: 'Medicine and at least one box, strip, or piece are required' }, 400); const product = state.inventory.find(item => item.name.toLowerCase() === String(input.name).toLowerCase()); if (product) { product.stock += quantity; product.generic = input.generic || product.generic; product.price = Number(input.sellingPrice) || product.price; } else state.inventory.push({ name: input.name, generic: input.generic || '', stock: quantity, price: Number(input.sellingPrice) || 0, stripsPerBox, piecesPerStrip }); state.syncedAt = new Date().toISOString(); saveState(); json(res, { ok: true, inventory: state.inventory }); });
  if (req.method === 'POST' && url.pathname === '/api/sale') return readBody(req).then(sale => { const items = Array.isArray(sale.items) ? sale.items.map(item => ({ name: String(item.name || '').trim(), quantity: Math.max(0, Number(item.quantity) || 0), price: Math.max(0, Number(item.price) || 0), amount: Math.max(0, Number(item.amount) || (Number(item.price) || 0) * (Number(item.quantity) || 0)) })).filter(item => item.name && item.quantity > 0) : []; if (!items.length) return json(res, { ok: false, error: 'Add at least one medicine with a valid quantity before billing.' }, 400); for (const item of items) { const product = state.inventory.find(p => p.name === item.name); if (!product || item.quantity > product.stock) return json(res, { ok: false, error: `Only ${product?.stock || 0} units available for ${item.name}` }, 400); } items.forEach(item => { state.inventory.find(p => p.name === item.name).stock -= item.quantity; }); const paymentMethod = sale.method || sale.paymentMethod || 'Cash'; const patientSource = sale.patientSource === 'DOCTOR_REFERRAL' ? 'DOCTOR_REFERRAL' : 'WALK_IN'; const doctor = patientSource === 'DOCTOR_REFERRAL' ? String(sale.doctor || sale.consultant || '').trim() : ''; if (patientSource === 'DOCTOR_REFERRAL' && !doctor) return json(res, { ok: false, error: 'A referring doctor is required for doctor referrals.' }, 400); const transaction = { invoice: `#INV-${String(Date.now()).slice(-5)}`, branch: sale.branch || 'MG Road', customer: sale.customer || 'Walk-in customer', phone: sale.phone || '', employee: sale.employee || '', patientSource, doctor, ageGender: sale.ageGender || sale.age || '', opdNumber: sale.opdNumber || sale.opd || sale.uhid || '', remarks: sale.remarks || '', items, amount: Number(sale.amount) || items.reduce((total, item) => total + item.amount, 0), payment: paymentMethod, paymentMethod, status: 'Completed', createdAt: new Date().toISOString() }; state.salesToday += transaction.amount; state.transactions.unshift(transaction); state.transactions = state.transactions.slice(0, 100); state.syncedAt = transaction.createdAt; saveState(); json(res, { ok: true, transaction, state }); });
if (url.pathname === '/api/inventory') {
  if (supabaseEnabled) return adminStateResponse(res, admin => json(res, { ok: true, inventory: admin.inventory }));
  applyExpiryRules();
  return json(res, { ok: true, inventory: inventoryWithExpiry() });
}
  if (url.pathname === '/api/state') return adminStateResponse(res, admin => json(res, admin));
  if (url.pathname === '/api/health') return json(res, { ok: true, synchronizedPorts: [4173, 4174], syncedAt: state.syncedAt, supabase: supabaseEnabled, supabaseStatus: supabaseEnabled ? 'configured' : 'not configured' });
  const requested = url.pathname === '/' ? (req.socket.localPort === 4174 ? 'pos.html' : 'admin.html') : url.pathname.slice(1);
  const allowed = new Set(['admin.html', 'pos.html', 'index.html', 'styles.css', 'pwa.js', 'service-worker.js', 'admin.webmanifest', 'staff.webmanifest', 'print-features.js', 'admin-dashboard.js', 'admin-live-inventory.js', 'admin-controls.js', 'admin-employees.js', 'admin-employee-api.js', 'admin-navigation.js', 'admin-profit-reports.js', 'admin-purchase-units.js', 'admin-multi-purchase.js', 'admin-partial-payment.js', 'admin-supplier-payments.js', 'admin-requests.js', 'sales-app-v2.js', 'sales-login.js', 'sales-cancel.js', 'sales-doctor.js', 'sales-requests.js', 'assets/nance-polyclinic-logo.jpeg']);
  if (!allowed.has(requested)) return res.end('Not found');
  const file = path.join(root, requested);
  res.setHeader('Content-Type', path.extname(file) === '.css' ? 'text/css' : path.extname(file) === '.html' ? 'text/html' : path.extname(file) === '.jpeg' ? 'image/jpeg' : path.extname(file) === '.webmanifest' ? 'application/manifest+json' : 'text/javascript');
  let output = fs.readFileSync(file);
  if (requested === 'admin.html') output = Buffer.from(output.toString().replace('</body>', '<script src="print-features.js"></script><script src="admin-purchase-units.js"></script><script src="admin-multi-purchase.js"></script><script src="admin-partial-payment.js"></script><script src="admin-profit-reports.js"></script><script src="admin-supplier-payments.js"></script><script src="admin-requests.js"></script></body>'));
  if (requested === 'pos.html') output = Buffer.from(output.toString().replace('</body>', `${output.toString().includes('sales-login.js') ? '' : '<script src="sales-login.js"></script>'}<script src="print-features.js"></script><script src="sales-doctor.js"></script><script src="sales-requests.js"></script></body>`));
  res.end(output);
}

const listenPort = Number(process.env.PORT) || 4173;
const listenHost = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
http.createServer(handler).listen(listenPort, listenHost, () => console.log(`Pharmflow ${listenPort}: http://${listenHost}:${listenPort}`));
