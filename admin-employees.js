async function showEmployees() {
  document.querySelector('#app').innerHTML = '<div class="content"><div class="page-heading"><div><h1>Employees</h1><p>Create staff accounts and assign their branch, role, and access.</p></div><button class="primary" onclick="employeeForm()">＋ Add employee</button></div><div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>EMPLOYEE</th><th>BRANCH</th><th>ROLE</th><th>ACCESS</th></tr></thead><tbody id="employee-rows"><tr><td colspan="4" class="empty">Loading employees...</td></tr></tbody></table></div></div></div>';
  try {
    const response = await fetch('/api/employees');
    if (!response.ok) throw new Error('Employee list request failed');
    const data = await response.json();
    const rows = document.querySelector('#employee-rows');
    rows.innerHTML = (data.employees || []).map(employee =>
      `<tr><td>${employee.code} · ${employee.name}</td><td>${employee.branch}</td><td>${employee.role === 'PHARMACIST' ? 'Doctor' : employee.role === 'BILLING_STAFF' ? 'Medical Billing' : employee.role}</td><td>${employee.role === 'BILLING_STAFF' ? 'Sales, checkout' : employee.role === 'PHARMACIST' ? 'Doctor selection in billing' : 'Admin workspace'}</td></tr>`
    ).join('') || '<tr><td colspan="4" class="empty">No employees found</td></tr>';
  } catch (error) {
    const rows = document.querySelector('#employee-rows');
    if (rows) rows.innerHTML = '<tr><td colspan="4" class="empty">Could not load employees</td></tr>';
    console.error('Employee list failed', error);
  }
}
