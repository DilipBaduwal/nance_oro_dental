async function dashboard() {
  document.querySelector('#app').innerHTML = `
    <div class="content">
      <div class="page-heading"><div><h1>Owner dashboard</h1><p>Live overview across all pharmacy branches.</p></div><span id="db-status" class="pill orange">Checking connection...</span></div>
      <div class="stats">
        <div class="stat-card"><div class="stat-top"><span>Today's sales</span><span class="stat-icon">₹</span></div><div class="stat-value" id="dash-sales">₹0</div><div class="trend">Live from sales</div></div>
        <div class="stat-card"><div class="stat-top"><span>Total inventory</span><span class="stat-icon">▦</span></div><div class="stat-value" id="dash-items">0</div><div class="trend">Units available</div></div>
        <div class="stat-card"><div class="stat-top"><span>Low stock</span><span class="stat-icon">!</span></div><div class="stat-value" id="dash-low">0</div><div class="trend" style="color:var(--orange)">Needs attention</div></div>
        <div class="stat-card"><div class="stat-top"><span>Out of stock</span><span class="stat-icon">×</span></div><div class="stat-value" id="dash-out">0</div><div class="trend" style="color:var(--red)">Unavailable now</div></div>
      </div>
      <div class="grid">
        <div class="panel revenue-panel"><div class="panel-title"><div><h3>Revenue overview</h3><small id="revenue-range" class="muted">Last 7 days</small></div><a href="#" data-admin-view="bills">View bills →</a></div><div class="revenue-summary"><div><span>Today</span><strong id="revenue-today">₹0</strong></div><div><span>Yesterday</span><strong id="revenue-yesterday">₹0</strong></div><div><span>7-day total</span><strong id="revenue-week">₹0</strong></div></div><div class="chart" id="dash-chart"></div><div class="chart-labels" id="dash-chart-labels"></div></div>
        <div class="panel"><div class="panel-title"><h3>Inventory alerts</h3><a href="#" data-admin-view="inventory">View inventory →</a></div><div id="dash-alerts" class="alert-list"></div></div>
      </div>
    </div>`;
  refreshDashboard();
}

async function refreshDashboard() {
  try {
    const [stateResponse, healthResponse] = await Promise.all([fetch('/api/state'), fetch('/api/health')]);
    if (!stateResponse.ok || !healthResponse.ok) throw new Error('Unable to load dashboard data');
    const state = await stateResponse.json();
    const health = await healthResponse.json();
    const inventoryItems = Array.isArray(state.inventory) ? state.inventory : [];
    const transactions = Array.isArray(state.transactions) ? state.transactions : [];
    const today = new Date();
    const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const todayKey = dayKey(today);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayKey = dayKey(yesterday);
    const dailyRevenue = new Map();
    transactions.forEach(transaction => {
      const date = new Date(transaction.createdAt);
      if (Number.isNaN(date.getTime())) return;
      const key = dayKey(date);
      dailyRevenue.set(key, (dailyRevenue.get(key) || 0) + (Number(transaction.amount) || 0));
    });
    const todayRevenue = dailyRevenue.get(todayKey) || 0;
    const yesterdayRevenue = dailyRevenue.get(yesterdayKey) || 0;
    const chartDays = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      return { key: dayKey(date), date, amount: dailyRevenue.get(dayKey(date)) || 0 };
    });
    const weekRevenue = chartDays.reduce((total, day) => total + day.amount, 0);
    document.querySelector('#dash-sales').textContent = `₹${Math.round(todayRevenue).toLocaleString('en-IN')}`;
    document.querySelector('#revenue-today').textContent = `₹${todayRevenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.querySelector('#revenue-yesterday').textContent = `₹${yesterdayRevenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.querySelector('#revenue-week').textContent = `₹${weekRevenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.querySelector('#dash-items').textContent = inventoryItems.reduce((total, item) => total + Number(item.stock || 0), 0);
    document.querySelector('#dash-low').textContent = inventoryItems.filter(item => item.stock > 0 && item.stock < 15).length;
    document.querySelector('#dash-out').textContent = inventoryItems.filter(item => item.stock === 0).length;
    const status = document.querySelector('#db-status');
    status.textContent = health.supabase ? '● Supabase connected' : '● Shared server active';
    status.className = `pill${health.supabase ? '' : ' orange'}`;
    document.querySelector('#dash-alerts').innerHTML = inventoryItems.filter(item => item.stock < 15).map(item =>
      `<div class="alert"><i class="alert-dot ${item.stock ? 'orange' : ''}"></i><div class="alert-info"><strong>${item.name}</strong><small>${item.stock ? `${item.stock} units remaining` : 'Out of stock'}</small></div><span class="pill ${item.stock ? 'orange' : 'red'}">${item.stock ? 'Low stock' : 'Out'}</span></div>`
    ).join('') || '<div class="empty">No stock alerts</div>';
    const maximum = Math.max(...chartDays.map(day => day.amount), 1);
    document.querySelector('#dash-chart').innerHTML = chartDays.map(day => `<button class="bar ${day.key === todayKey ? 'active' : ''}" data-revenue-date="${day.key}" title="${day.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}: ₹${day.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}" aria-label="View bills for ${day.date.toLocaleDateString('en-IN')}: ₹${day.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}" style="height:${day.amount ? Math.max(8, day.amount / maximum * 100) : 4}%"></button>`).join('');
    document.querySelector('#dash-chart-labels').innerHTML = chartDays.map(day => `<span>${day.date.toLocaleDateString('en-IN', { weekday: 'short' })}<br>${day.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>`).join('');
    document.querySelector('#dash-chart').querySelectorAll('[data-revenue-date]').forEach(bar => {
      bar.addEventListener('click', () => adminList('bills', bar.dataset.revenueDate));
    });
  } catch (error) {
    const status = document.querySelector('#db-status');
    if (status) { status.textContent = '● Connection unavailable'; status.className = 'pill red'; }
    console.error('Dashboard refresh failed', error);
  }
}

setInterval(() => { if (document.querySelector('#dash-sales')) refreshDashboard(); }, 2000);
