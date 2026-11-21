async function employeeForm() {
  document.querySelector('#employee-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="payment-modal" id="employee-modal" role="dialog" aria-modal="true" aria-labelledby="employee-modal-title">
    <div class="payment-card"><h2 id="employee-modal-title">Add employee</h2>
      <label>Full name<input id="employee-name" class="search" maxlength="120" autocomplete="name" placeholder="Employee name"></label>
      <label>Employee ID<input id="employee-code" class="search" maxlength="32" autocomplete="off" placeholder="Leave blank to generate one"></label>
      <label>Role<select id="employee-role" class="search"><option value="DOCTOR">Doctor</option><option value="SUPPORT_STAFF">Support Staff</option></select></label>
      <label>Initial password<input id="employee-password" type="password" class="search" minlength="6" maxlength="256" autocomplete="new-password" placeholder="At least 6 characters"></label>
      <label>Location<select id="employee-branch" class="search" required><option value="MG Road">MG Road</option></select></label>
      <p class="muted">Doctors appear in sales checkout. Support staff can sign in to the sales counter.</p>
      <button class="primary" id="employee-submit" type="button" style="width:100%">Create employee</button>
      <button class="secondary" type="button" style="width:100%;margin-top:8px" onclick="document.querySelector('#employee-modal').remove()">Cancel</button>
      <p id="employee-result" class="muted" aria-live="polite"></p>
    </div>
  </div>`);
  const result = document.querySelector('#employee-result');
  document.querySelector('#employee-name').focus();
  document.querySelector('#employee-submit').addEventListener('click', saveEmployee);
}

async function saveEmployee() {
  const result = document.querySelector('#employee-result');
  const submit = document.querySelector('#employee-submit');
  const input = {
    name: document.querySelector('#employee-name').value.trim(),
    code: document.querySelector('#employee-code').value.trim(),
    password: document.querySelector('#employee-password').value,
    role: document.querySelector('#employee-role').value,
    branch: document.querySelector('#employee-branch').value
  };
  if (!input.name || !input.code || input.password.length < 6 || !input.branch) {
    result.textContent = 'Enter full name, employee ID, location, and a password of at least 6 characters.';
    return;
  }
  submit.disabled = true;
  result.textContent = 'Creating account…';
  try {
    const response = await fetch('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not create employee.');
    result.textContent = `Created ${data.employee.code}.`;
    document.querySelector('#employee-password').value = '';
    setTimeout(() => {
      document.querySelector('#employee-modal')?.remove();
      showEmployees();
    }, 700);
  } catch (error) {
    result.textContent = error.message;
    submit.disabled = false;
  }
}
