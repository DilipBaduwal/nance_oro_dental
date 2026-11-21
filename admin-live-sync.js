let adminLastSyncedAt = '';
let currentAdminView = 'dashboard';

async function refreshCurrentAdminView() {
  if (document.querySelector('.payment-modal') || document.querySelector('#stock-modal')) return;
  if (currentAdminView === 'dashboard') return dashboard();
  if (currentAdminView === 'inventory') return inventory();
  if (currentAdminView === 'employees') return showEmployees();
  if (currentAdminView === 'sites') return showClinicSites();
  if (currentAdminView === 'bills') {
    const date = document.querySelector('#bills-date')?.value || '';
    return adminList('bills', date);
  }
  if (currentAdminView === 'reports') {
    const period = document.querySelector('[data-report-period].active')?.dataset.reportPeriod || 'day';
    return refreshReports(period);
  }
  if (['purchases', 'suppliers', 'reports'].includes(currentAdminView)) return adminList(currentAdminView);
}

async function pollAdminState() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) return;
    const state = await response.json();
    if (!adminLastSyncedAt) {
      adminLastSyncedAt = state.syncedAt;
      return;
    }
    if (state.syncedAt !== adminLastSyncedAt) {
      adminLastSyncedAt = state.syncedAt;
      await refreshCurrentAdminView();
    }
  } catch (error) {
    console.warn('Automatic admin sync unavailable', error);
  }
}

setInterval(pollAdminState, 1500);
pollAdminState();
