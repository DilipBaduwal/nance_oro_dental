import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const statePath = process.env.STATE_FILE || path.join(root, 'pharmflow-state.json');
if (!supabaseUrl || !serviceKey) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the server-only .env file.');
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  Accept: 'application/json'
};

async function request(resource, method = 'GET', query = {}, body, prefer = 'return=representation') {
  const url = new URL(`${supabaseUrl}/rest/v1/${resource}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const requestHeaders = { ...headers };
  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    requestHeaders.Prefer = prefer;
  }
  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${resource} failed (HTTP ${response.status}): ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

function sourceKey(type, value) {
  const digest = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
  return `${type}:${digest}`;
}

async function alreadyImported(key) {
  const rows = await request('legacy_imports', 'GET', { select: 'source_key', source_key: `eq.${key}`, limit: 1 });
  return rows.length > 0;
}

async function recordImport(key, type, targetId, record) {
  await request('legacy_imports', 'POST', {}, {
    source_key: key,
    source_type: type,
    target_id: targetId || null,
    record
  });
}

async function findBranch(name) {
  const rows = await request('branches', 'GET', {
    select: 'id,name,code',
    name: `eq.${name}`,
    limit: 1
  });
  return rows[0] || null;
}

async function importSites() {
  const siteIds = new Map();
  for (const site of state.sites || []) {
    const key = sourceKey('site', site.id || site.name);
    const imported = await request('legacy_imports', 'GET', {
      select: 'target_id',
      source_key: `eq.${key}`,
      limit: 1
    });
    if (imported[0]?.target_id) {
      siteIds.set(site.id, imported[0].target_id);
      continue;
    }
    let branch = await findBranch(site.name);
    if (branch) {
      const updated = await request('branches', 'PATCH', { id: `eq.${branch.id}`, select: 'id' }, { status: 'ACTIVE' });
      branch = updated[0] || branch;
    } else {
      const code = `CLINIC_${crypto.createHash('sha1').update(site.name).digest('hex').slice(0, 10).toUpperCase()}`;
      const created = await request('branches', 'POST', {}, {
        name: site.name,
        code,
        status: 'ACTIVE'
      });
      branch = created[0];
    }
    await recordImport(key, 'site', branch.id, { id: site.id, name: site.name });
    siteIds.set(site.id, branch.id);
  }
  return siteIds;
}

async function findOrCreateSupplier(supplier) {
  const key = sourceKey('supplier', supplier.id || supplier.name.toLowerCase());
  const mapped = await request('legacy_imports', 'GET', {
    select: 'target_id',
    source_key: `eq.${key}`,
    limit: 1
  });
  if (mapped[0]?.target_id) return mapped[0].target_id;

  const existing = await request('suppliers', 'GET', {
    select: 'id',
    name: `eq.${supplier.name}`,
    limit: 1
  });
  const row = existing[0] || (await request('suppliers', 'POST', {}, {
    name: String(supplier.name).slice(0, 160),
    contact_name: String(supplier.contact || '').slice(0, 120) || null,
    phone: String(supplier.phone || '').slice(0, 40) || null,
    email: String(supplier.email || '').slice(0, 254) || null,
    brands: String(supplier.brands || '').slice(0, 1000) || null,
    categories: String(supplier.categories || '').slice(0, 1000) || null
  }))[0];
  await recordImport(key, 'supplier', row.id, supplier);
  return row.id;
}

async function findOrCreateMedicine(item) {
  const existing = await request('medicines', 'GET', {
    select: 'id',
    name: `eq.${item.name}`,
    order: 'created_at.asc',
    limit: 1
  });
  if (existing[0]) return existing[0].id;
  const rows = await request('medicines', 'POST', {}, {
    name: String(item.name).slice(0, 160),
    generic_name: String(item.generic || '').slice(0, 160) || null,
    status: 'ACTIVE'
  });
  return rows[0].id;
}

async function importPurchases(supplierIds, branchId) {
  for (let index = 0; index < (state.purchases || []).length; index += 1) {
    const purchase = state.purchases[index];
    const key = sourceKey('purchase', `${purchase.createdAt}:${purchase.supplierId}:${purchase.name}:${purchase.quantity}`);
    if (await alreadyImported(key)) continue;
    const supplier = (state.suppliers || []).find(item => item.id === purchase.supplierId)
      || { name: purchase.supplierName || purchase.supplier || 'Imported supplier' };
    const supplierId = supplierIds.get(supplier.id) || await findOrCreateSupplier(supplier);
    const medicineId = await findOrCreateMedicine({ name: purchase.name });
    const subtotal = Number(purchase.subtotal ?? purchase.cost) || 0;
    const tax = Number(purchase.taxAmount) || 0;
    const total = Number(purchase.totalCost ?? purchase.cost) || subtotal + tax;
    const invoice = `LEGACY-PO-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12).toUpperCase()}`;
    const existing = await request('purchases', 'GET', {
      select: 'id',
      invoice_number: `eq.${invoice}`,
      limit: 1
    });
    const purchaseId = existing[0]?.id || crypto.randomUUID();
    if (!existing.length) {
      await request('purchases', 'POST', {}, {
        id: purchaseId,
        branch_id: branchId,
        supplier_id: supplierId,
        invoice_number: invoice,
        subtotal,
        tax,
        total,
        created_at: purchase.createdAt
      });
    }
    const existingItems = await request('purchase_items', 'GET', {
      select: 'id',
      purchase_id: `eq.${purchaseId}`,
      limit: 1
    });
    if (!existingItems.length) {
      await request('purchase_items', 'POST', {}, {
        purchase_id: purchaseId,
        medicine_id: medicineId,
        batch_id: null,
        quantity: Math.max(1, Number(purchase.quantity) || 1),
        boxes: Math.max(0, Number(purchase.boxes) || 0),
        strips: Math.max(0, Number(purchase.strips) || 0),
        pieces: Math.max(0, Number(purchase.pieces) || 0),
        strips_per_box: Math.max(1, Number(purchase.stripsPerBox) || 10),
        pieces_per_strip: Math.max(1, Number(purchase.piecesPerStrip) || 10),
        unit_cost: Number(purchase.buyPrice) || 0,
        tax_rate: Number(purchase.taxPercent) || 0,
        line_total: total
      });
    }
    await recordImport(key, 'purchase', purchaseId, purchase);
  }
}

async function importSales(branches, defaultBranchId) {
  for (const transaction of state.transactions || []) {
    const invoice = String(transaction.invoice || '').slice(0, 100);
    if (!invoice) continue;
    const key = sourceKey('sale', invoice);
    const amount = Math.max(0, Number(transaction.amount) || 0);
    const importRows = await request('legacy_imports', 'GET', {
      select: 'target_id,source_type',
      source_key: `eq.${key}`,
      limit: 1
    });
    const existing = await request('sales', 'GET', {
      select: 'id,total,created_at,customer_name',
      invoice_number: `eq.${invoice}`,
      limit: 1
    });
    if (existing[0] && !importRows.length) {
      const sameRecord = Math.abs(Number(existing[0].total) - amount) < 0.01
        && new Date(existing[0].created_at).getTime() === new Date(transaction.createdAt).getTime()
        && (existing[0].customer_name || '') === (transaction.customer || '');
      if (!sameRecord) {
        await recordImport(key, 'sale_existing_record', existing[0].id, { invoice });
        continue;
      }
    }
    if (importRows[0]?.source_type === 'sale_existing_record') continue;
    let sale = existing[0];
    if (!sale) {
      const branchId = branches.get(transaction.branch) || defaultBranchId;
      const rows = await request('sales', 'POST', {}, {
        branch_id: branchId,
        invoice_number: invoice,
        customer_name: String(transaction.customer || '').slice(0, 160) || null,
        customer_mobile: String(transaction.phone || '').slice(0, 40) || null,
        subtotal: amount,
        discount: 0,
        tax: 0,
        total: amount,
        payment_method: ['Cash', 'UPI', 'Card'].includes(transaction.payment) ? transaction.payment : 'Cash',
        status: 'COMPLETED',
        created_at: transaction.createdAt
      });
      sale = rows[0];
    }
    if (!importRows.length) await recordImport(key, 'sale', sale.id, { invoice });
    for (let index = 0; index < (transaction.items || []).length; index += 1) {
      const item = transaction.items[index];
      const itemKey = sourceKey('sale-item', `${invoice}:${index}`);
      if (await alreadyImported(itemKey) || !String(item.name || '').trim()) continue;
      const medicineId = await findOrCreateMedicine(item);
      const quantity = Math.floor(Number(item.quantity) || 0);
      if (quantity < 1) continue;
      const saleItems = await request('sale_items', 'POST', {}, {
        sale_id: sale.id,
        medicine_id: medicineId,
        batch_id: null,
        quantity,
        unit_price: Math.max(0, Number(item.unitPrice) || 0),
        gst_rate: 0
      });
      await recordImport(itemKey, 'sale_item', saleItems[0]?.id, { invoice, index });
    }
  }
}

async function main() {
  const siteIds = await importSites();
  const branches = await request('branches', 'GET', { select: 'id,name,status', status: 'eq.ACTIVE', order: 'name.asc', limit: 1000 });
  if (!branches.length) throw new Error('No active branch exists. Add a branch before importing the saved records.');
  const branchIdsByName = new Map(branches.map(branch => [branch.name, branch.id]));
  for (const site of state.sites || []) {
    const id = siteIds.get(site.id);
    const branch = branches.find(item => item.id === id);
    if (branch) branchIdsByName.set(site.name, branch.id);
  }
  const defaultBranchId = branchIdsByName.get('MG Road') || branches[0].id;
  const supplierIds = new Map();
  for (const supplier of state.suppliers || []) {
    supplierIds.set(supplier.id, await findOrCreateSupplier(supplier));
  }
  await importPurchases(supplierIds, defaultBranchId);
  await importSales(branchIdsByName, defaultBranchId);

  for (const item of state.inventory || []) {
    const key = sourceKey('inventory-snapshot', item.name.toLowerCase());
    if (!(await alreadyImported(key))) await recordImport(key, 'inventory_snapshot', null, item);
  }
  for (const employee of state.employees || []) {
    const key = sourceKey('employee-account', employee.code);
    if (!(await alreadyImported(key))) {
      await recordImport(key, 'employee_account_requires_password_reset', null, {
        code: employee.code,
        name: employee.name,
        branch: employee.branch || 'MG Road',
        active: employee.active !== false
      });
    }
  }
  console.log(`Imported local suppliers, purchases, bills, locations, and inventory snapshots. Employee IDs ${state.employees.map(employee => employee.code).join(', ')} need fresh Supabase Auth passwords.`);
  console.log('Inventory snapshots were archived for reference; they were not added to live stock, to prevent double-counting existing Supabase batches.');
}

main().catch(error => {
  console.error('Local state import failed:', error.message);
  process.exitCode = 1;
});
