import crypto from 'node:crypto';

const STAFF_RADIUS_METERS = 100;
const STAFF_MAX_GPS_ACCURACY_METERS = 100;
const SITE_CAPTURE_MAX_GPS_ACCURACY_METERS = 20;

const SESSION_COOKIE = 'nance_session';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const adminAttempts = new Map();

export function createDentalApi({ supabaseUrl, anonKey, serviceKey, adminUsername, adminPassword }) {
  const configured = Boolean(supabaseUrl && anonKey && serviceKey);
  const adminSalt = crypto.randomBytes(16);
  const validAdminConfig = Boolean(adminUsername && adminUsername.length <= 64 && adminUsername.trim() === adminUsername && adminPassword?.length >= 10);
  const adminHash = validAdminConfig
    ? crypto.scryptSync(adminPassword, adminSalt, 64)
    : null;

  function json(res, value, status = 200) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(value));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 16_384) {
          reject(new Error('Request body is too large.'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Request body must be valid JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  function requireSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function getSession(req) {
    const cookies = String(req.headers.cookie || '').split(';');
    const token = cookies.map(cookie => cookie.trim()).find(cookie => cookie.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    if (!token) return null;
    const key = crypto.createHash('sha256').update(decodeURIComponent(token)).digest('hex');
    const session = sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    return session;
  }

  function setSession(res, req, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const key = crypto.createHash('sha256').update(token).digest('hex');
    sessions.set(key, { ...user, expiresAt: Date.now() + SESSION_DURATION_MS });
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_MS / 1000}${secure ? '; Secure' : ''}`);
  }

  function clearSession(req, res) {
    const session = getSession(req);
    if (session) {
      const cookies = String(req.headers.cookie || '').split(';');
      const token = cookies.map(cookie => cookie.trim()).find(cookie => cookie.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
      if (token) sessions.delete(crypto.createHash('sha256').update(decodeURIComponent(token)).digest('hex'));
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  function requireAdmin(req, res) {
    const session = getSession(req);
    if (session?.role === 'ADMIN') return session;
    json(res, { ok: false, error: 'Admin sign-in is required.' }, 401);
    return null;
  }

  async function supabaseRequest(table, method = 'GET', query = {}, body, prefer = 'return=representation') {
    if (!configured) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY on the server to enable secure staff and location sync.');
    const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/json'
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.Prefer = prefer;
    }
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    const text = await response.text();
    if (!response.ok) {
      console.error(`Dental Supabase ${method} ${table} failed (HTTP ${response.status}): ${text.slice(0, 400)}`);
      if (response.status === 404) throw new Error('The staff-location migration is not installed. Run supabase/staff-location-migration.sql in the Supabase SQL Editor.');
      if (response.status === 409) throw new Error('That employee ID or record already exists.');
      throw new Error('Supabase could not save or load staff data.');
    }
    if (!text) return [];
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Supabase returned an invalid response.');
    }
  }

  function employeeEmail(code) {
    return `staff-${code.toLowerCase()}@login.invalid`;
  }

  async function createAuthUser(email, password, name) {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
        app_metadata: { app_access: 'dental_staff' }
      }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok || !result.id) {
      console.error(`Supabase Auth user creation failed (HTTP ${response.status}): ${JSON.stringify(result).slice(0, 300)}`);
      if (response.status === 422 || response.status === 400) throw new Error('Could not create the employee login. Check that the employee ID is not already in use.');
      throw new Error('Supabase Auth could not create the employee login.');
    }
    return result;
  }

  async function deleteAuthUser(id) {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error(`Supabase Auth rollback failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      throw new Error('Could not roll back the incomplete employee login. Remove it from Supabase Auth before retrying.');
    }
  }

  async function authenticateEmployee(email, password) {
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok) return true;
    if ([400, 401, 422].includes(response.status)) return false;
    const detail = await response.text();
    console.error(`Supabase Auth sign-in failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
    throw new Error('Supabase Auth is temporarily unavailable.');
  }

  async function getActiveBranches() {
    const rows = await supabaseRequest('branches', 'GET', {
      select: 'id,name,code,latitude,longitude,radius_meters,status',
      status: 'eq.ACTIVE',
      latitude: 'not.is.null',
      longitude: 'not.is.null',
      order: 'name.asc',
      limit: 500
    });
    return rows.filter(branch => Number(branch.radius_meters) === STAFF_RADIUS_METERS);
  }

  async function recordSaleDirect({ branchId, items, paymentMethod, paymentReference, customer, phone, discount = 0, createdBy = null, patientSource = 'WALK_IN', doctor = '' }) {
    const [medicines, batches, branches] = await Promise.all([
      supabaseRequest('medicines', 'GET', { select: 'id,name,status', status: 'eq.ACTIVE', limit: 5000 }),
      supabaseRequest('batches', 'GET', { select: 'id,medicine_id,selling_price,available_quantity,status,expiry_date', branch_id: `eq.${branchId}`, status: 'eq.AVAILABLE', order: 'expiry_date.asc', limit: 10000 }),
      supabaseRequest('branches', 'GET', { select: 'id,name', id: `eq.${branchId}`, limit: 1 })
    ]);
    if (!branches[0]) throw new Error('Staff clinic branch was not found.');
    const medicineByName = new Map(medicines.map(m => [String(m.name).toLowerCase(), m]));
    const batchesByMedicine = new Map();
    for (const batch of batches) {
      if (!batchesByMedicine.has(batch.medicine_id)) batchesByMedicine.set(batch.medicine_id, []);
      batchesByMedicine.get(batch.medicine_id).push(batch);
    }
    const allocations = [];
    let subtotal = 0;
    for (const item of items) {
      const medicine = medicineByName.get(item.name.trim().toLowerCase());
      if (!medicine) throw new Error(`Medicine not found: ${item.name}`);
      let remaining = Number(item.quantity);
      const available = (batchesByMedicine.get(medicine.id) || []).reduce((sum, batch) => sum + Math.max(0, Number(batch.available_quantity) || 0), 0);
      if (available < remaining) throw new Error(`Only ${available} units available for ${medicine.name}`);
      for (const batch of batchesByMedicine.get(medicine.id) || []) {
        if (!remaining) break;
        const quantity = Math.min(remaining, Math.max(0, Number(batch.available_quantity) || 0));
        if (!quantity) continue;
        const unitPrice = Number(batch.selling_price) || 0;
        allocations.push({ medicine, batch, quantity, unitPrice });
        subtotal += quantity * unitPrice;
        remaining -= quantity;
      }
    }
    const safeDiscount = Math.min(Number(discount) || 0, subtotal);
    const saleId = crypto.randomUUID();
    const invoice = `INV-${Date.now().toString().slice(-8)}`;
    const saleBody = { id: saleId, branch_id: branchId, invoice_number: invoice, customer_name: customer || null, customer_mobile: phone || null, subtotal, discount: safeDiscount, tax: 0, total: subtotal - safeDiscount, payment_method: paymentMethod, payment_reference: paymentReference || null, status: 'COMPLETED' };
    if (createdBy) saleBody.created_by = createdBy;
    await supabaseRequest('sales', 'POST', {}, saleBody);
    await supabaseRequest('sale_items', 'POST', {}, allocations.map(({ medicine, batch, quantity, unitPrice }) => ({ sale_id: saleId, medicine_id: medicine.id, batch_id: batch.id, quantity, unit_price: unitPrice, gst_rate: 0 })));
    await supabaseRequest('legacy_imports', 'POST', {}, {
      source_key: `sale:${saleId}`,
      source_type: 'sale_metadata',
      record: { saleId, employeeId: createdBy, patientSource: patientSource === 'DOCTOR_REFERRAL' ? 'DOCTOR_REFERRAL' : 'WALK_IN', doctor: patientSource === 'DOCTOR_REFERRAL' ? String(doctor || '').trim() : '' }
    });
    for (const allocation of allocations) {
      const remaining = Math.max(0, Number(allocation.batch.available_quantity) - allocation.quantity);
      await supabaseRequest('batches', 'PATCH', { id: `eq.${allocation.batch.id}` }, { available_quantity: remaining, status: remaining > 0 ? 'AVAILABLE' : 'OUT_OF_STOCK' }, 'return=minimal');
    }
    return { id: saleId, invoice_number: invoice, total: subtotal - safeDiscount, branch_name: branches[0].name, items: allocations.map(({ medicine, quantity, unitPrice }) => ({ name: medicine.name, quantity, price: unitPrice, amount: quantity * unitPrice })) };
  }

  async function health() {
    if (!configured) {
      return {
        ok: false,
        supabaseStatus: 'Set the server-only SUPABASE_SERVICE_ROLE_KEY and run the staff-location migration to enable employee/location writes.',
        dataSource: 'unavailable',
        writeSync: false,
        schemaReady: false
      };
    }
    try {
      await Promise.all([
        supabaseRequest('branches', 'GET', { select: 'id,latitude,longitude,radius_meters', limit: 0 }),
        supabaseRequest('profiles', 'GET', { select: 'id,employee_code,active', limit: 0 }),
        supabaseRequest('staff_signins', 'GET', { select: 'id', limit: 0 }),
        supabaseRequest('suppliers', 'GET', { select: 'id', limit: 0 }),
        supabaseRequest('purchases', 'GET', { select: 'id', limit: 0 }),
        supabaseRequest('purchase_items', 'GET', { select: 'id', limit: 0 })
      ]);
      return {
        ok: true,
        supabaseStatus: 'connected to staff, supplier, purchase, and pharmacy tables',
        dataSource: 'supabase',
        writeSync: true,
        schemaReady: true
      };
    } catch (error) {
      return {
        ok: false,
        supabaseStatus: error.message,
        dataSource: 'unavailable',
        writeSync: false,
        schemaReady: false
      };
    }
  }

  function validLocation(location, maxAccuracy = STAFF_MAX_GPS_ACCURACY_METERS) {
    const capturedAt = Date.parse(location?.capturedAt);
    return Number.isFinite(location?.latitude) && location.latitude >= -90 && location.latitude <= 90
      && Number.isFinite(location?.longitude) && location.longitude >= -180 && location.longitude <= 180
      && Number.isFinite(location?.accuracy) && location.accuracy > 0 && location.accuracy <= maxAccuracy
      && Number.isFinite(capturedAt) && capturedAt <= Date.now() + 15000 && Date.now() - capturedAt <= 60000;
  }

  function distanceMeters(from, to) {
    const radians = degrees => degrees * Math.PI / 180;
    const dLat = radians(to.latitude - from.latitude);
    const dLon = radians(to.longitude - from.longitude);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function attemptKey(req, code) {
    return `${req.socket.remoteAddress || 'unknown'}:${code.toUpperCase()}`;
  }

  function allowedAttempt(req, code) {
    const key = attemptKey(req, code);
    const entry = loginAttempts.get(key);
    if (!entry || entry.until <= Date.now()) {
      loginAttempts.set(key, { count: 0, until: Date.now() + 15 * 60 * 1000 });
      return true;
    }
    return entry.count < 8;
  }

  function recordFailedAttempt(req, code) {
    const key = attemptKey(req, code);
    const entry = loginAttempts.get(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
    entry.count += 1;
    loginAttempts.set(key, entry);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method || 'GET';
    const route = url.pathname;
    if (!route.startsWith('/api/dental/')) return false;

    if (['POST', 'PATCH', 'DELETE'].includes(method) && !requireSameOrigin(req)) {
      json(res, { ok: false, error: 'Request origin is not allowed.' }, 403);
      return true;
    }

    if (method === 'GET' && route === '/api/dental/health') {
      return json(res, await health());
    }

    if (method === 'GET' && route === '/api/dental/session') {
      const session = getSession(req);
      return json(res, {
        ok: true,
        authenticated: Boolean(session),
        user: session ? {
          role: session.role,
          name: session.name,
          code: session.code,
          siteName: session.siteName,
          signedInAt: session.signedInAt
        } : null
      });
    }

    if (method === 'POST' && route === '/api/dental/admin/login') {
      const input = await readBody(req);
      if (!adminHash || !adminUsername) return json(res, { ok: false, error: 'Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 10 characters on the server.' }, 503);
      const ip = req.socket.remoteAddress || 'unknown';
      const attempt = adminAttempts.get(ip);
      if (attempt && attempt.until > Date.now() && attempt.count >= 8) {
        return json(res, { ok: false, error: 'Too many sign-in attempts. Try again in 15 minutes.' }, 429);
      }
      const supplied = String(input.password || '');
      const actualHash = crypto.scryptSync(supplied, adminSalt, adminHash.length);
      const valid = String(input.id || '') === adminUsername && crypto.timingSafeEqual(actualHash, adminHash);
      if (!valid) {
        const current = adminAttempts.get(ip);
        adminAttempts.set(ip, current && current.until > Date.now()
          ? { count: current.count + 1, until: current.until }
          : { count: 1, until: Date.now() + 15 * 60 * 1000 });
        return json(res, { ok: false, error: 'Invalid admin username or password.' }, 401);
      }
      adminAttempts.delete(ip);
      setSession(res, req, { role: 'ADMIN', name: adminUsername, code: adminUsername });
      return json(res, { ok: true, user: { role: 'ADMIN', name: adminUsername } });
    }

    if (method === 'POST' && route === '/api/dental/logout') {
      clearSession(req, res);
      return json(res, { ok: true });
    }

    if (method === 'GET' && route === '/api/dental/sites') {
      try {
        const rows = await getActiveBranches();
        const admin = getSession(req)?.role === 'ADMIN';
        const sites = rows.map(site => admin
          ? site
          : ({ id: site.id, name: site.name, radiusMeters: site.radius_meters }));
        return json(res, { ok: true, sites, source: 'supabase' });
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (method === 'POST' && route === '/api/dental/geofence/check') {
      const input = await readBody(req);
      if (!validLocation(input.location)) {
        return json(res, { ok: false, error: `A fresh device location with GPS accuracy of ${STAFF_MAX_GPS_ACCURACY_METERS} m or better is required.` }, 403);
      }
      try {
        const branches = await getActiveBranches();
        const matches = branches.map(site => ({ site, distance: distanceMeters(site, input.location) }))
          .filter(match => match.distance <= match.site.radius_meters)
          .sort((left, right) => left.distance - right.distance);
        const match = matches[0];
        if (!match) return json(res, { ok: false, error: `This device is outside the approved ${STAFF_RADIUS_METERS} metre clinic locations.` }, 403);
        return json(res, {
          ok: true,
          site: { id: match.site.id, name: match.site.name },
          radiusMeters: match.site.radius_meters,
          distanceMeters: Math.round(match.distance * 100) / 100
        });
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (method === 'POST' && route === '/api/dental/staff/login') {
      const input = await readBody(req);
      const code = String(input.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{2,32}$/.test(code) || !String(input.password || '') || !input.siteId) {
        return json(res, { ok: false, error: 'Enter your employee ID, password, and clinic site.' }, 400);
      }
      if (!allowedAttempt(req, code)) return json(res, { ok: false, error: 'Too many sign-in attempts. Try again in 15 minutes.' }, 429);
      if (!configured) return json(res, { ok: false, error: 'Staff sync needs the server-only Supabase service-role key and the staff-location migration.' }, 503);
      if (!validLocation(input.location)) return json(res, { ok: false, error: `A fresh device location with GPS accuracy of ${STAFF_MAX_GPS_ACCURACY_METERS} m or better is required.` }, 403);
      try {
        const [employees, branches] = await Promise.all([
          supabaseRequest('profiles', 'GET', {
            select: 'id,full_name,employee_code,active,branch_id',
            employee_code: `eq.${code}`,
            limit: 1
          }),
          supabaseRequest('branches', 'GET', {
            select: 'id,name,latitude,longitude,radius_meters,status',
            id: `eq.${input.siteId}`,
            status: 'eq.ACTIVE',
            latitude: 'not.is.null',
            longitude: 'not.is.null',
            limit: 1
          })
        ]);
        const employee = employees[0];
        const site = branches[0];
        if (!employee || !employee.active) {
          recordFailedAttempt(req, code);
          return json(res, { ok: false, error: 'Invalid employee ID or password.' }, 401);
        }
        if (!site) return json(res, { ok: false, error: 'Select an active clinic location.' }, 403);
        if (employee.branch_id !== site.id) {
          recordFailedAttempt(req, code);
          return json(res, { ok: false, error: 'This employee is not assigned to the selected clinic location.' }, 403);
        }
        if (!await authenticateEmployee(employeeEmail(code), String(input.password || ''))) {
          recordFailedAttempt(req, code);
          return json(res, { ok: false, error: 'Invalid employee ID or password.' }, 401);
        }
        const distance = distanceMeters(site, input.location);
        if (distance > site.radius_meters) {
          recordFailedAttempt(req, code);
          return json(res, { ok: false, error: `Outside the verified ${site.radius_meters} m boundary or location is too imprecise.` }, 403);
        }
        const signIn = {
          profile_id: employee.id,
          employee_code: employee.employee_code,
          employee_name: employee.full_name,
          branch_id: site.id,
          branch_name: site.name,
          distance_meters: Math.round(distance * 100) / 100,
          location_accuracy_meters: Math.round(input.location.accuracy * 100) / 100
        };
        const created = await supabaseRequest('staff_signins', 'POST', {}, signIn);
        const signedInAt = created[0]?.created_at || new Date().toISOString();
        setSession(res, req, { role: 'STAFF', employeeId: employee.id, code: employee.employee_code, name: employee.full_name, branchId: site.id, siteName: site.name, signedInAt });
        loginAttempts.delete(attemptKey(req, code));
        return json(res, { ok: true, employee: { code: employee.employee_code, name: employee.full_name }, site: { id: site.id, name: site.name }, signedInAt });
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (route === '/api/dental/staff/billing') {
      const session = getSession(req);
      if (session?.role !== 'STAFF') return json(res, { ok: false, error: 'Sign in as staff to access billing.' }, 401);
      if (!session.branchId) return json(res, { ok: false, error: 'Your staff account has no assigned clinic. Ask an administrator to update it.' }, 403);
      if (method === 'GET') {
        try {
          const [medicines, batches] = await Promise.all([
            supabaseRequest('medicines', 'GET', {
              select: 'id,name,generic_name,status',
              status: 'eq.ACTIVE',
              limit: 5000
            }),
            supabaseRequest('batches', 'GET', {
              select: 'medicine_id,selling_price,available_quantity,status,expiry_date',
              branch_id: `eq.${session.branchId}`,
              status: 'eq.AVAILABLE',
              order: 'expiry_date.asc',
              limit: 10000
            })
          ]);
          const products = new Map(medicines.map(medicine => [medicine.id, {
            name: medicine.name,
            generic: medicine.generic_name || '',
            stock: 0,
            price: 0
          }]));
          for (const batch of batches) {
            const product = products.get(batch.medicine_id);
            if (!product) continue;
            product.stock += Math.max(0, Number(batch.available_quantity) || 0);
            if (!product.price && Number(batch.selling_price) > 0) product.price = Number(batch.selling_price);
          }
          return json(res, {
            ok: true,
            source: 'supabase',
            inventory: [...products.values()].filter(product => product.stock > 0)
          });
        } catch (error) {
          console.error('Staff billing inventory load failed:', error.message);
          return json(res, { ok: false, error: 'Could not load clinic billing inventory.' }, 503);
        }
      }
      if (method !== 'POST') return json(res, { ok: false, error: 'Billing endpoint not found.' }, 404);
      const input = await readBody(req);
      const items = Array.isArray(input.items) ? input.items : [];
      const paymentMethod = String(input.method || '');
      const customer = String(input.customer || '').trim();
      const phone = String(input.phone || '').trim();
      const paymentReference = String(input.paymentReference || '').trim();
      const discount = Number(input.discount || 0);
      if (!items.length || items.length > 100
        || !items.every(item => item && typeof item.name === 'string' && item.name.trim().length > 0
          && item.name.trim().length <= 160 && Number.isInteger(Number(item.quantity))
          && Number(item.quantity) > 0 && Number(item.quantity) <= 10000)
        || !['Cash', 'UPI', 'Card'].includes(paymentMethod)
        || customer.length > 160 || phone.length > 40 || paymentReference.length > 120
        || !Number.isFinite(discount) || discount < 0) {
        return json(res, { ok: false, error: 'Enter valid bill items and payment details.' }, 400);
      }
      try {
        const sale = await recordSaleDirect({ branchId: session.branchId, items, paymentMethod, paymentReference, customer, phone, discount, createdBy: session.employeeId, patientSource: input.patientSource, doctor: input.doctor });
        invalidateSupabaseSnapshot();
        return json(res, {
          ok: true,
          invoice: sale?.invoice_number || sale?.invoice || 'saved',
          total: Number(sale?.total) || 0,
          employee: { name: session.name },
          site: { name: session.siteName },
          source: 'supabase'
        }, 201);
      } catch (error) {
        console.error('Staff bill save failed:', error.message);
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (method === 'GET' && route === '/api/dental/employees') {
      if (!requireAdmin(req, res)) return true;
      try {
        const profiles = await supabaseRequest('profiles', 'GET', {
          select: 'id,employee_code,full_name,active,created_at,branch_id',
          employee_code: 'not.is.null',
          order: 'created_at.desc',
          limit: 1000
        });
        const branches = await supabaseRequest('branches', 'GET', { select: 'id,name', limit: 1000 });
        const branchNames = new Map(branches.map(branch => [branch.id, branch.name]));
        const employees = profiles.map(profile => ({
          id: profile.id,
          code: profile.employee_code,
          name: profile.full_name,
          active: profile.active,
          created_at: profile.created_at,
          branch_id: profile.branch_id,
          branch_name: branchNames.get(profile.branch_id) || 'Unassigned'
        }));
        return json(res, { ok: true, employees, locations: await getActiveBranches(), source: 'supabase' });
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (method === 'POST' && route === '/api/dental/employees') {
      const admin = requireAdmin(req, res);
      if (!admin) return true;
      const input = await readBody(req);
      const code = String(input.code || `EMP${crypto.randomInt(100000, 1000000)}`).trim().toUpperCase();
      const name = String(input.name || '').trim();
      const password = String(input.password || '');
      const branchId = String(input.branchId || '');
      if (!/^[A-Z0-9_-]{2,32}$/.test(code)) return json(res, { ok: false, error: 'Employee ID must be 2–32 letters, numbers, dashes, or underscores.' }, 400);
      if (!name || name.length > 120) return json(res, { ok: false, error: 'Enter an employee name (up to 120 characters).' }, 400);
      if (password.length < 12 || password.length > 256) return json(res, { ok: false, error: 'Use an initial password of 12–256 characters.' }, 400);
      if (!/^[0-9a-f-]{36}$/i.test(branchId)) return json(res, { ok: false, error: 'Select the employee’s clinic location.' }, 400);
      try {
        const branches = await getActiveBranches();
        if (!branches.some(branch => branch.id === branchId)) return json(res, { ok: false, error: 'Select an active clinic location.' }, 400);
        const authUser = await createAuthUser(employeeEmail(code), password, name);
        try {
          const rows = await supabaseRequest('profiles', 'POST', { select: 'id,employee_code,full_name,active,created_at,branch_id' }, {
            id: authUser.id,
            employee_code: code,
            full_name: name,
            role: 'DENTAL_STAFF',
            branch_id: branchId,
            active: true
          });
          return json(res, { ok: true, employee: rows[0] && {
            id: rows[0].id,
            code: rows[0].employee_code,
            name: rows[0].full_name,
            active: rows[0].active,
            created_at: rows[0].created_at,
            branch_id: rows[0].branch_id,
            branch_name: branches.find(branch => branch.id === branchId)?.name
          } }, 201);
        } catch (error) {
          await deleteAuthUser(authUser.id);
          throw error;
        }
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (method === 'PATCH' && route.startsWith('/api/dental/employees/')) {
      if (!requireAdmin(req, res)) return true;
      const id = route.slice('/api/dental/employees/'.length);
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, { ok: false, error: 'Invalid employee ID.' }, 400);
      const input = await readBody(req);
      const active = input.active === false ? false : input.active === true ? true : null;
      const branchId = input.branchId === undefined ? undefined : String(input.branchId);
      if (active === null && branchId === undefined) return json(res, { ok: false, error: 'Set an active status or clinic location.' }, 400);
      try {
        const updates = {};
        if (active !== null) updates.active = active;
        if (branchId !== undefined) {
          if (!/^[0-9a-f-]{36}$/i.test(branchId)) return json(res, { ok: false, error: 'Select a valid clinic location.' }, 400);
          if (!(await getActiveBranches()).some(branch => branch.id === branchId)) return json(res, { ok: false, error: 'Select an active clinic location.' }, 400);
          updates.branch_id = branchId;
        }
        const rows = await supabaseRequest('profiles', 'PATCH', { id: `eq.${id}`, employee_code: 'not.is.null', select: 'id,employee_code,full_name,active,created_at,branch_id' }, updates);
        if (!rows.length) return json(res, { ok: false, error: 'Employee not found.' }, 404);
        const branches = await supabaseRequest('branches', 'GET', { select: 'id,name', id: `eq.${rows[0].branch_id}`, limit: 1 });
        return json(res, { ok: true, employee: {
          id: rows[0].id, code: rows[0].employee_code, name: rows[0].full_name,
          active: rows[0].active, created_at: rows[0].created_at,
          branch_id: rows[0].branch_id, branch_name: branches[0]?.name || 'Unassigned'
        } });
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (method === 'POST' && route === '/api/dental/sites') {
      const admin = requireAdmin(req, res);
      if (!admin) return true;
      const input = await readBody(req);
      const name = String(input.name || '').trim();
      if (!name || name.length > 80 || !validLocation(input.location, SITE_CAPTURE_MAX_GPS_ACCURACY_METERS)) {
        return json(res, { ok: false, error: 'Enter a site name and capture a fresh location with accuracy of 20 m or better.' }, 400);
      }
      try {
        const code = `STAFF_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const rows = await supabaseRequest('branches', 'POST', {}, {
          name,
          code,
          latitude: input.location.latitude,
          longitude: input.location.longitude,
          radius_meters: STAFF_RADIUS_METERS,
          status: 'ACTIVE'
        });
        return json(res, { ok: true, site: rows[0] }, 201);
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (method === 'DELETE' && route.startsWith('/api/dental/sites/')) {
      if (!requireAdmin(req, res)) return true;
      const id = route.slice('/api/dental/sites/'.length);
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, { ok: false, error: 'Invalid clinic site ID.' }, 400);
      try {
        const assignedProfiles = await supabaseRequest('profiles', 'GET', {
          select: 'id',
          branch_id: `eq.${id}`,
          employee_code: 'not.is.null',
          active: 'eq.true',
          limit: 1
        });
        if (assignedProfiles.length) return json(res, { ok: false, error: 'Reassign or disable this location’s active employees before removing the location.' }, 409);
        const rows = await supabaseRequest('branches', 'PATCH', {
          id: `eq.${id}`,
          latitude: 'not.is.null',
          longitude: 'not.is.null'
        }, { latitude: null, longitude: null });
        if (!rows.length) return json(res, { ok: false, error: 'Clinic site not found.' }, 404);
        return json(res, { ok: true });
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (method === 'GET' && route === '/api/dental/signins') {
      if (!requireAdmin(req, res)) return true;
      try {
        const signins = await supabaseRequest('staff_signins', 'GET', {
          select: 'id,employee_code,employee_name,branch_name,distance_meters,location_accuracy_meters,created_at',
          order: 'created_at.desc',
          limit: 500
        });
        return json(res, { ok: true, signins, source: 'supabase' });
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    if (method === 'GET' && route === '/api/dental/dashboard') {
      if (!requireAdmin(req, res)) return true;
      try {
        const now = new Date();
        const dateParts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Kolkata',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).formatToParts(now);
        const indiaDay = Object.fromEntries(dateParts.map(part => [part.type, part.value]));
        const startOfDay = new Date(`${indiaDay.year}-${indiaDay.month}-${indiaDay.day}T00:00:00+05:30`);
        const startOfTomorrow = new Date(startOfDay);
        startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
        const [employees, sites, signins, todaySignins] = await Promise.all([
          supabaseRequest('profiles', 'GET', { select: 'id,active', employee_code: 'not.is.null', limit: 1000 }),
          getActiveBranches(),
          supabaseRequest('staff_signins', 'GET', { select: 'id,employee_code,employee_name,branch_name,distance_meters,location_accuracy_meters,created_at', order: 'created_at.desc', limit: 10 }),
          supabaseRequest('staff_signins', 'GET', { select: 'created_at', created_at: `gte.${startOfDay.toISOString()}`, limit: 5000 })
        ]);
        return json(res, {
          ok: true,
          source: 'supabase',
          counts: {
            employees: employees.filter(employee => employee.active).length,
            sites: sites.length,
            signinsToday: todaySignins.filter(signin => new Date(signin.created_at) < startOfTomorrow).length
          },
          recentSignins: signins
        });
      } catch (error) {
        return json(res, { ok: false, error: error.message }, 503);
      }
    }

    json(res, { ok: false, error: 'Not found.' }, 404);
    return true;
  }

  return { handle, configured, health, requireAdmin, getSession, recordSaleDirect, setStaffSession: (req, res, user) => setSession(res, req, { role: 'STAFF', ...user }) };
}
