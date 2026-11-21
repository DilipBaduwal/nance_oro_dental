async function showSignins() {
  document.querySelector('#app').innerHTML = `<div class="content">
    <div class="page-heading"><div><h1>Staff sign-ins</h1><p>Successful sign-ins with a fresh location inside an approved 100 m radius.</p></div><button class="secondary" type="button" onclick="showSignins()">↻ Refresh</button></div>
    <div class="panel"><div id="signins-table" class="table-wrap"><div class="empty">Loading verified sign-ins…</div></div></div>
    <p class="muted dental-data-note">Only successful sign-ins are listed. The app records distance and location accuracy, not the employee’s exact coordinates.</p>
  </div>`;
  try {
    const response = await fetch('/api/dental/signins', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load sign-ins.');
    const rows = data.signins.map(signin => `<tr>
      <td><strong>${escapeDentalHtml(signin.employee_name)}</strong><br><span class="muted">${escapeDentalHtml(signin.employee_code)}</span></td>
      <td>${escapeDentalHtml(signin.branch_name)}</td>
      <td>${new Date(signin.created_at).toLocaleString()}</td>
      <td>${Number(signin.distance_meters).toFixed(1)} m</td>
      <td>±${Number(signin.location_accuracy_meters).toFixed(1)} m</td>
    </tr>`).join('');
    document.querySelector('#signins-table').innerHTML = `<table class="data-table"><thead><tr><th>EMPLOYEE</th><th>LOCATION</th><th>TIME</th><th>DISTANCE</th><th>ACCURACY</th></tr></thead><tbody>${rows || '<tr><td class="empty" colspan="5">No sign-ins have been recorded.</td></tr>'}</tbody></table>`;
    labelAdminTables(document.querySelector('#signins-table'));
  } catch (error) {
    document.querySelector('#signins-table').innerHTML = `<div class="empty">${escapeDentalHtml(error.message)}</div>`;
    console.error('Sign-in history failed', error);
  }
}
