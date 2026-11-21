function showClinicSites() {
  const breadcrumb = document.querySelector('#crumb');
  if (breadcrumb) breadcrumb.textContent = 'Clinic locations';
  document.querySelector('#app').innerHTML = `<div class="content">
    <div class="page-heading"><div><h1>Clinic locations</h1><p>Staff sign-in requires a fresh location fix inside 100 metres of one of these sites.</p></div></div>
    <div class="panel">
      <div class="panel-title"><h3>Add a clinic location</h3></div>
      <p class="muted" style="margin-bottom:12px">This adds a branch to the existing pharmacy database. Stand at the site to capture its location; staff must sign in within 100 metres.</p>
      <input id="site-name" class="search" style="width:min(420px,100%);margin:0 10px 10px 0" maxlength="80" placeholder="Site name">
      <button id="capture-site-location" class="secondary" type="button">Capture this device location</button>
      <button id="save-clinic-site" class="primary" type="button" disabled>Save site</button>
      <p id="site-capture-result" class="muted" aria-live="polite" style="margin-top:10px"></p>
    </div>
    <div class="panel" style="margin-top:16px">
      <div class="panel-title"><h3>Approved login locations</h3><button class="secondary" onclick="loadClinicSites()">Refresh</button></div>
      <div id="clinic-site-list" class="table-wrap">Loading sites…</div>
    </div>
  </div>`;
  document.querySelector('#capture-site-location').addEventListener('click', captureClinicSiteLocation);
  document.querySelector('#save-clinic-site').addEventListener('click', saveClinicSite);
  loadClinicSites();
}

let capturedClinicLocation = null;
function captureClinicSiteLocation() {
  const result = document.querySelector('#site-capture-result');
  const save = document.querySelector('#save-clinic-site');
  save.disabled = true;
  result.textContent = 'Requesting location…';
  if (!navigator.geolocation) {
    result.textContent = 'This device does not provide location services.';
    return;
  }
  navigator.geolocation.getCurrentPosition(position => {
    capturedClinicLocation = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      capturedAt: new Date().toISOString()
    };
    if (capturedClinicLocation.accuracy > 20) {
      capturedClinicLocation = null;
      result.textContent = `Location accuracy is ±${Math.round(position.coords.accuracy)} m; 20 m or better is required.`;
      return;
    }
    result.textContent = `Location captured: ${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)} (±${Math.round(position.coords.accuracy)} m).`;
    save.disabled = false;
  }, error => {
    result.textContent = error.code === 1 ? 'Allow location permission in device settings and try again.' : 'Could not get a location fix. Enable device location and try again.';
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

async function saveClinicSite() {
  const name = document.querySelector('#site-name').value.trim();
  const result = document.querySelector('#site-capture-result');
  if (!name || !capturedClinicLocation) {
    result.textContent = 'Enter a site name and capture its location first.';
    return;
  }
  try {
    const response = await fetch('/api/dental/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, location: capturedClinicLocation })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not save clinic site.');
    document.querySelector('#site-name').value = '';
    document.querySelector('#save-clinic-site').disabled = true;
    capturedClinicLocation = null;
    result.textContent = `Saved ${data.site.name}.`;
    await loadClinicSites();
  } catch (error) {
    result.textContent = error.message;
  }
}

async function loadClinicSites() {
  const container = document.querySelector('#clinic-site-list');
  if (!container) return;
  try {
    const response = await fetch('/api/dental/sites', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load sites.');
    if (!data.sites.length) {
      container.textContent = 'No clinic sites yet. Add the test and actual clinic locations above.';
      return;
    }
    const table = document.createElement('table');
    table.className = 'data-table';
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['SITE', 'COORDINATES · RADIUS', 'ACTION'].forEach(label => {
      const header = document.createElement('th');
      header.textContent = label;
      headerRow.append(header);
    });
    head.append(headerRow);
    table.append(head);
    const body = document.createElement('tbody');
    data.sites.forEach(site => {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = site.name;
      const coordinates = document.createElement('td');
      coordinates.textContent = `${Number(site.latitude).toFixed(6)}, ${Number(site.longitude).toFixed(6)} · ${site.radius_meters} m`;
      const action = document.createElement('td');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => removeClinicSite(site.id));
      action.append(remove);
      row.append(name, coordinates, action);
      body.append(row);
    });
    table.append(body);
    container.replaceChildren(table);
    labelAdminTables(container);
  } catch (error) {
    container.textContent = error.message;
  }
}

async function removeClinicSite(id) {
  if (!confirm('Remove this clinic location from staff sign-in?')) return;
  try {
    const response = await fetch(`/api/dental/sites/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not remove clinic site.');
    await loadClinicSites();
  } catch (error) {
    const result = document.querySelector('#site-capture-result');
    if (result) result.textContent = error.message;
  }
}
