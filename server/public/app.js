// DOM Elements
const topMeta = document.getElementById("topMeta");
const pageTitle = document.getElementById("pageTitle");
const loginCard = document.getElementById("loginCard");
const dashboardCard = document.getElementById("dashboardCard");
const requestsList = document.getElementById("requestsList");
const approvalsList = document.getElementById("approvalsList");
const calendarContainer = document.getElementById("calendarContainer");
const selectedDayRecords = document.getElementById("selectedDayRecords");
const gpsStatus = document.getElementById("gpsStatus");
const userInfo = document.getElementById("userInfo");

// State
let selectedDate = new Date();
let attendanceRecords = [];
let sessionUser = null;

// Constants
const PROJECT_SITES = [
  { id: "jkt-hq", name: "Jakarta HQ", latitude: -6.2001, longitude: 106.8167, radiusMeters: 150 },
  { id: "bdg-plant", name: "Bandung Plant", latitude: -6.9147, longitude: 107.6098, radiusMeters: 200 },
  { id: "sby-field", name: "Surabaya Field Office", latitude: -7.2575, longitude: 112.7521, radiusMeters: 200 },
];

const HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-29', '2026-03-29', '2026-04-03',
  '2026-05-01', '2026-05-13', '2026-05-29', '2026-06-01',
  '2026-06-06', '2026-06-07', '2026-08-17', '2026-09-12',
  '2026-10-01', '2026-12-25',
];

// Helper Functions
const isHoliday = (date) => {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return HOLIDAYS_2026.includes(dateStr);
};

const toJakartaTime = (date) => {
  return new Date(date.getTime() + (7 * 60 * 60 * 1000));
};

const formatTimeJakarta = (iso) => {
  try {
    const d = new Date(iso);
    const jakarta = toJakartaTime(d);
    return jakarta.toLocaleString('id-ID', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch { return iso; }
};

const formatDateJakarta = (date) => {
  const jakarta = toJakartaTime(date);
  return jakarta.toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
};

const IS_ADMIN_ROLE = (role) => role === "hrd" || role === "admin";
const IS_MANAGER_ROLE = (role) => role === "manager_line" || IS_ADMIN_ROLE(role);

// API Helper
const apiCall = async (url, options = {}) => {
  try {
    const res = await fetch(url, options);
    const type = res.headers.get("content-type") || "";
    const body = type.includes("application/json") ? await res.json() : await res.text();
    if (!res.ok) {
      throw new Error(typeof body === "string" ? body : JSON.stringify(body));
    }
    return body;
  } catch (err) {
    console.error('API Error:', err);
    throw err;
  }
};

// Calendar Functions
const getDayStatus = (date) => {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (isHoliday(date)) return 'holiday';

  const dayRecords = attendanceRecords.filter(r => {
    if (!r.check_in) return false;
    const d = new Date(r.check_in);
    return d.getFullYear() === date.getFullYear() &&
           d.getMonth() === date.getMonth() &&
           d.getDate() === date.getDate();
  });

  if (dayRecords.length === 0) return 'no-checkin';
  const hasCheckin = dayRecords.some(r => r.check_in);
  const hasCheckout = dayRecords.some(r => r.check_out);
  const isLate = dayRecords.some(r => r.status === 'late');

  if (hasCheckin && !hasCheckout) return 'forget-checkout';
  if (isLate) return 'late';
  if (hasCheckin) return 'checked-in';
  return 'no-checkin';
};

const renderCalendar = () => {
  if (!calendarContainer) return;
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();

  let html = `
    <div class="calendar-header">
      <button class="calendar-nav" onclick="changeMonth(-1)">‹</button>
      <div class="calendar-title">${formatDateJakarta(selectedDate)}</div>
      <button class="calendar-nav" onclick="changeMonth(1)">›</button>
    </div>
    <div class="calendar-days">
      ${['Min','Sen','Sel','Rab','Kam','Jum','Sab'].map(d => `<div class="calendar-day-header">${d}</div>`).join('')}
  `;

  for (let i = 0; i < firstDay; i++) {
    html += '<div class="calendar-day"></div>';
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const status = getDayStatus(date);
    const isToday = date.toDateString() === new Date().toDateString();
    const isHolidayDate = isHoliday(date);

    let className = 'calendar-day';
    if (status === 'checked-in') className += ' checked-in';
    if (status === 'late') className += ' late';
    if (status === 'no-checkin') className += ' no-checkin';
    if (status === 'forget-checkout') className += ' forget-checkout';
    if (isToday) className += ' today';

    const textStyle = isHolidayDate ? 'color:#ff3b30;font-weight:600;' : '';
    html += `<div class="${className}" style="${textStyle}" onclick="selectDay(${year}, ${month}, ${day})">${day}</div>`;
  }

  html += '</div>';
  calendarContainer.innerHTML = html;
};

window.changeMonth = (delta) => {
  selectedDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + delta, 1);
  renderCalendar();
};

window.selectDay = (year, month, day) => {
  const date = new Date(year, month, day);
  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  if (!selectedDayRecords) return;

  const dayRecords = attendanceRecords.filter(r => {
    if (!r.check_in) return false;
    const d = new Date(r.check_in);
    return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
  });

  let html = `<div style="margin-top:12px;"><strong>${dateStr}</strong></div>`;
  if (isHoliday(date)) html += '<div class="status warn">Holiday</div>';

  if (dayRecords.length > 0) {
    dayRecords.forEach(r => {
      html += `
        <div class="item">
          <div class="item-title">${r.type || 'attendance'}</div>
          <div class="item-meta">Check-in: ${formatTimeJakarta(r.check_in)}</div>
          ${r.check_out ? `<div class="item-meta">Check-out: ${formatTimeJakarta(r.check_out)}</div>` : ''}
          <div class="item-meta">Location: ${r.location_type || '-'}</div>
          ${r.status ? `<div class="status ${r.status === 'late' ? 'warn' : 'ok'}">${r.status}</div>` : ''}
        </div>
      `;
    });
  } else if (!isHoliday(date)) {
    html += '<div class="muted">No attendance records</div>';
  }

  selectedDayRecords.innerHTML = html;
};

// Tab Navigation
const showTab = (tabName) => {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));

  const activeTab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  const activePanel = document.getElementById(`panel-${tabName}`);

  if (activeTab) activeTab.classList.add('active');
  if (activePanel) activePanel.classList.remove('hidden');

  if (tabName === 'calendar') renderCalendar();
  if (tabName === 'requests') loadRequests();
  if (tabName === 'approvals' && sessionUser && IS_MANAGER_ROLE(sessionUser.role)) loadApprovals();
};

// Login
const login = async () => {
  console.log('Login function called');
  const email = document.getElementById('email')?.value;
  const password = document.getElementById('password')?.value;

  if (!email || !password) {
    alert('Please enter email and password');
    return;
  }

  try {
    const user = await apiCall('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    sessionUser = user;
    localStorage.setItem('absensi_user', JSON.stringify(user));

    if (loginCard) loginCard.classList.add('hidden');
    if (dashboardCard && IS_ADMIN_ROLE(user.role)) dashboardCard.classList.remove('hidden');

    if (pageTitle) pageTitle.textContent = `Hello, ${user.name}`;
    if (topMeta) topMeta.textContent = `Role: ${user.role}`;
    if (userInfo) userInfo.textContent = `Logged in as: ${user.name} (${user.role})`;

    loadAttendance();
    if (IS_MANAGER_ROLE(user.role)) loadApprovals();
  } catch (err) {
    alert('Login failed: ' + err.message);
  }
};

// Logout
const logout = () => {
  sessionUser = null;
  localStorage.removeItem('absensi_user');
  if (loginCard) loginCard.classList.remove('hidden');
  if (dashboardCard) dashboardCard.classList.add('hidden');
  if (pageTitle) pageTitle.textContent = 'Absensi';
  if (topMeta) topMeta.textContent = 'Sign in untuk lihat absensi';
};

// Load Attendance
const loadAttendance = async () => {
  if (!sessionUser) return;
  try {
    attendanceRecords = await apiCall(`/attendance?user_id=${sessionUser.id}`);
    if (IS_ADMIN_ROLE(sessionUser.role)) {
      const stats = await apiCall('/dashboard');
      const kpiTotal = document.getElementById('kpiTotal');
      const kpiLate = document.getElementById('kpiLate');
      const kpiLeave = document.getElementById('kpiLeave');
      const kpiOvertime = document.getElementById('kpiOvertime');
      if (kpiTotal) kpiTotal.textContent = stats.total || 0;
      if (kpiLate) kpiLate.textContent = stats.late || 0;
      if (kpiLeave) kpiLeave.textContent = stats.leave || 0;
      if (kpiOvertime) kpiOvertime.textContent = stats.overtime || 0;
    }
  } catch (err) {
    console.error('Failed to load attendance:', err);
  }
};

// Load Requests
const loadRequests = async () => {
  if (!sessionUser || !requestsList) return;
  try {
    const requestItems = await apiCall(`/leave?user_id=${sessionUser.id}`);
    let html = '';
    requestItems.forEach(r => {
      html += `
        <div class="item">
          <div class="item-title">${r.type} - ${r.status}</div>
          <div class="item-meta">${formatTimeJakarta(r.created_at)}</div>
          <div class="item-meta">${r.remarks || ''}</div>
        </div>
      `;
    });
    requestsList.innerHTML = html || '<div class="muted">No requests</div>';
  } catch (err) {
    console.error('Failed to load requests:', err);
  }
};

// Load Approvals
const loadApprovals = async () => {
  if (!sessionUser || !approvalsList) return;
  try {
    const approvalItems = await apiCall('/leave/requests');
    let html = '';
    approvalItems.forEach(a => {
      html += `
        <div class="item">
          <div class="item-title">${a.user_name} - ${a.type}</div>
          <div class="item-meta">${formatTimeJakarta(a.created_at)}</div>
          <div class="item-meta">Status: ${a.approval_status}</div>
        </div>
      `;
    });
    approvalsList.innerHTML = html || '<div class="muted">No pending approvals</div>';
  } catch (err) {
    console.error('Failed to load approvals:', err);
  }
};

// Check-in/out
const checkIn = async () => {
  if (!sessionUser) { alert('Please login first'); return; }
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async (position) => {
      try {
        const { latitude, longitude } = position.coords;
        await apiCall('/attendance/check-in', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: sessionUser.id, latitude, longitude, locationType: 'gps-web' })
        });
        alert('Check-in successful');
        loadAttendance();
      } catch (err) {
        alert('Check-in failed: ' + err.message);
      }
    }, (err) => alert('GPS error: ' + err.message), { timeout: 30000 });
  } else {
    alert('Geolocation not supported');
  }
};

const checkOut = async () => {
  if (!sessionUser) { alert('Please login first'); return; }
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async (position) => {
      try {
        const { latitude, longitude } = position.coords;
        await apiCall('/attendance/check-out', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: sessionUser.id, latitude, longitude, locationType: 'gps-web' })
        });
        alert('Check-out successful');
        loadAttendance();
      } catch (err) {
        alert('Check-out failed: ' + err.message);
      }
    }, (err) => alert('GPS error: ' + err.message), { timeout: 30000 });
  } else {
    alert('Geolocation not supported');
  }
};

const syncNow = async () => {
  if (!sessionUser) { alert('Please login first'); return; }
  try {
    await apiCall('/sync/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: sessionUser.id })
    });
    alert('Sync completed');
  } catch (err) {
    alert('Sync failed: ' + err.message);
  }
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  const savedUser = localStorage.getItem('absensi_user');
  if (savedUser) {
    try {
      sessionUser = JSON.parse(savedUser);
      if (loginCard) loginCard.classList.add('hidden');
      if (dashboardCard && IS_ADMIN_ROLE(sessionUser.role)) dashboardCard.classList.remove('hidden');
      if (pageTitle) pageTitle.textContent = `Hello, ${sessionUser.name}`;
      if (topMeta) topMeta.textContent = `Role: ${sessionUser.role}`;
      if (userInfo) userInfo.textContent = `Logged in as: ${sessionUser.name} (${sessionUser.role})`;
      loadAttendance();
    } catch (e) {
      localStorage.removeItem('absensi_user');
    }
  }

  document.getElementById('btnLogin')?.addEventListener('click', login);
  document.getElementById('btnLogout')?.addEventListener('click', logout);
  document.getElementById('btnCheckIn')?.addEventListener('click', checkIn);
  document.getElementById('btnCheckOut')?.addEventListener('click', checkOut);
  document.getElementById('btnSync')?.addEventListener('click', syncNow);
  document.getElementById('btnRefresh')?.addEventListener('click', loadAttendance);

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });
});
window.handleLogin = login;
