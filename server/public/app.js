const output = document.getElementById("output");
const topMeta = document.getElementById("topMeta");
const pageTitle = document.getElementById("pageTitle");
const loginCard = document.getElementById("loginCard");
const dashboardCard = document.getElementById("dashboardCard");
const attendanceList = document.getElementById("attendanceList");
const lateList = document.getElementById("lateList");
const leaveList = document.getElementById("leaveList");
const overtimeList = document.getElementById("overtimeList");
const requestsList = document.getElementById("requestsList");
const approvalsList = document.getElementById("approvalsList");
const kpiTotal = document.getElementById("kpiTotal");
const kpiLate = document.getElementById("kpiLate");
const kpiActive = document.getElementById("kpiActive");
const kpiLeave = document.getElementById("kpiLeave");
const kpiOvertime = document.getElementById("kpiOvertime");
const tabs = Array.from(document.querySelectorAll(".tab"));
const panels = Array.from(document.querySelectorAll(".tab-panel"));
const bottomTabs = document.getElementById("bottomTabs");
const loadingOverlay = document.getElementById("loadingOverlay");
const calendarContainer = document.getElementById("calendarContainer");
const selectedDayRecords = document.getElementById("selectedDayRecords");
const gpsStatus = document.getElementById("gpsStatus");
const userInfo = document.getElementById("userInfo");

const PROJECT_SITES = [
  { id: "jkt-hq", name: "Jakarta HQ", latitude: -6.2001, longitude: 106.8167, radiusMeters: 150 },
  { id: "bdg-plant", name: "Bandung Plant", latitude: -6.9147, longitude: 107.6098, radiusMeters: 200 },
  { id: "sby-field", name: "Surabaya Field Office", latitude: -7.2575, longitude: 112.7521, radiusMeters: 200 },
];

let selectedDate = new Date();
let attendanceRecords = [];
let requestItems = [];
let approvalItems = [];

const HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-29', '2026-03-29', '2026-04-03',
  '2026-05-01', '2026-05-13', '2026-05-29', '2026-06-01',
  '2026-06-06', '2026-06-07', '2026-08-17', '2026-09-12',
  '2026-10-01', '2026-12-25',
];

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

const show = (data) => {
  if (output) {
    output.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  }
};

const api = async (url, options = {}) => {
  const res = await fetch(url, options);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    throw new Error(typeof body === "string" ? body : JSON.stringify(body));
  }
  return body;
};

const toLocal = (value) => {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
  } catch { return value; }
};

let sessionUser = null;
const IS_ADMIN_ROLE = (role) => role === "hrd" || role === "admin";
const IS_MANAGER_ROLE = (role) => role === "manager_line" || IS_ADMIN_ROLE(role);

const haversineDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const getPosition = async () => {
  if (!("geolocation" in navigator)) {
    throw new Error("Browser tidak mendukung GPS.");
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => {
        const errorMessages = { 1: "Akses lokasi ditolak.", 2: "Lokasi tidak tersedia.", 3: "GPS timeout." };
        reject(new Error(errorMessages[err.code] || err.message || "Gagal membaca GPS."));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 }
    );
  });
};

const switchTab = (tabName) => {
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
  panels.forEach((panel) => panel.classList.toggle("hidden", panel.id !== `panel-${tabName}`));
  const titles = { attendance: "Absensi", requests: "Requests", news: "News", approvals: "Approvals", settings: "Settings" };
  if (pageTitle) pageTitle.textContent = titles[tabName] || "Absensi";
};

const renderCalendar = () => {
  if (!calendarContainer) return;
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();

  const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  let html = `<div class="calendar-header">
    <button class="calendar-nav" onclick="window.changeMonth(-1)">‹</button>
    <div class="calendar-title">${monthNames[month]} ${year}</div>
    <button class="calendar-nav" onclick="window.changeMonth(1)">›</button>
  </div>
  <div class="calendar-days">`;

  dayNames.forEach(d => { html += `<div class="calendar-day-header">${d}</div>`; });

  for (let i = 0; i < firstDay; i++) { html += `<div></div>`; }

  const today = new Date();

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayRecords = attendanceRecords.filter(r => r.check_in && r.check_in.startsWith(dateStr));
    const isToday = today.getDate() === day && today.getMonth() === month && today.getFullYear() === year;
    const isSelected = selectedDate.getDate() === day;

    let classes = "calendar-day";
    let textColor = "";

    // Check holiday first
    const dayDate = new Date(year, month, day);
    if (isHoliday(dayDate)) {
      textColor = ' style="color:#ff3b30;font-weight:600;"';
    }

    if (dayRecords.length > 0) {
      const hasLate = dayRecords.some(r => r.check_in && isLate(r.check_in));
      const hasForgetCheckout = dayRecords.some(r => !r.check_out);

      if (hasLate) { classes += " late"; }
      else if (hasForgetCheckout) { classes += " forget-checkout"; }
      else { classes += " checked-in"; }
    } else if (dayDate < today && !isToday) {
      classes += " no-checkin";
    }

    if (isToday) classes += " today";
    if (isSelected) classes += " active";

    html += `<div class="${classes}" onclick="window.selectDate(${day})"${textColor}>${day}</div>`;
  }

  html += '</div>';
  calendarContainer.innerHTML = html;
  renderSelectedDayRecords();
};

const isLate = (checkInStr) => {
  try {
    const d = new Date(checkInStr);
    const jakarta = toJakartaTime(d);
    const hours = jakarta.getUTCHours();
    const minutes = jakarta.getUTCMinutes();
    return (hours > 9) || (hours === 9 && minutes > 0);
  } catch { return false; }
};

window.changeMonth = (delta) => {
  selectedDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + delta, 1);
  renderCalendar();
};

window.selectDate = (day) => {
  selectedDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day);
  renderCalendar();
};

const renderSelectedDayRecords = () => {
  if (!selectedDayRecords) return;
  const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`;
  const dayRecords = attendanceRecords.filter(r => r.check_in && r.check_in.startsWith(dateStr));

  if (dayRecords.length === 0) {
    selectedDayRecords.innerHTML = '<p class="muted">Tidak ada absensi di hari ini.</p>';
    return;
  }

  selectedDayRecords.innerHTML = dayRecords.map(row => `
    <div class="item">
      <div class="item-title">${row.employee_name || "Employee"} ${row.check_out ? "(Selesai)" : "(Aktif)"}</div>
      <div class="item-meta">Check-in: ${formatTimeJakarta(row.check_in)}</div>
      ${row.check_out ? `<div class="item-meta">Check-out: ${formatTimeJakarta(row.check_out)}</div>` : '<div class="item-meta">Belum check-out</div>'}
      <span class="status ${row.synced ? 'ok' : 'warn'}">${row.synced ? '✓ Synced' : '⏳ Pending'}</span>
    </div>
  `).join("");
};

const loadDashboard = async () => {
  if (!sessionUser) return;
  try {
    const data = await api(`/dashboard?requesterId=${encodeURIComponent(sessionUser.id)}&role=${encodeURIComponent(sessionUser.role)}`);
    if (kpiTotal) kpiTotal.textContent = String(data.summary?.totalAttendance ?? 0);
    if (kpiLate) kpiLate.textContent = String(data.summary?.lateCount ?? 0);
    if (kpiActive) kpiActive.textContent = String(data.summary?.activeShift ?? 0);
    if (kpiLeave) kpiLeave.textContent = String(data.summary?.leaveCount ?? 0);
    if (kpiOvertime) kpiOvertime.textContent = String(data.summary?.overtimeCount ?? 0);

    attendanceRecords = data.attendance || [];
    if (lateList) renderLate(data.late || []);
    if (leaveList) renderLeave(data.leave || []);
    if (overtimeList) renderOvertime(data.overtime || []);

    renderCalendar();
  } catch (error) {
    console.error("Dashboard error:", error);
  }
};

const loadRequests = async () => {
  if (!sessionUser) return;
  try {
    const [leaveRes, overtimeRes] = await Promise.all([
      api(`/leave?requesterId=${sessionUser.id}&role=${sessionUser.role}`),
      api(`/overtime?requesterId=${sessionUser.id}&role=${sessionUser.role}`)
    ]);

    requestItems = [
      ...(leaveRes || []).map(r => ({ ...r, type: 'leave' })),
      ...(overtimeRes || []).map(r => ({ ...r, type: 'overtime' })),
    ];

    renderRequests();
  } catch (error) {
    console.error("Requests error:", error);
  }
};

const renderRequests = () => {
  if (!requestsList) return;

  if (requestItems.length === 0) {
    requestsList.innerHTML = '<p class="muted">Tidak ada requests.</p>';
    return;
  }

  requestsList.innerHTML = requestItems.map(row => {
    const statusColor = row.status.includes('approved') ? '#34c759' :
      row.status.includes('rejected') ? '#ff3b30' : '#ffcc00';
    const statusText = row.type === 'leave' ?
      row.status === 'approved' ? '✓ Approved' :
      row.status === 'pending_hrd' ? '⏳ Waiting HRD' :
      row.status === 'pending_manager' ? '⏳ Waiting Manager' : '✗ Rejected' : row.status;

    return `
      <div class="item">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div class="item-title">${row.employee_name || 'Employee'} - ${row.type.charAt(0).toUpperCase() + row.type.slice(1)}</div>
          <div style="background:${statusColor};padding:4px 8px;border-radius:6px;color:white;font-size:10px;font-weight:600;">${statusText}</div>
        </div>
        ${row.type === 'leave' ? `<div class="item-meta">Period: ${row.start_date} s/d ${row.end_date}</div>` : ''}
        ${row.type === 'overtime' ? `<div class="item-meta">${row.overtime_date} - ${row.hours} hours</div>` : ''}
        ${row.note ? `<div class="item-meta">Note: ${row.note}</div>` : ''}
      </div>
    `;
  }).join("");
};

const loadApprovals = async () => {
  if (!sessionUser) return;
  try {
    const [leaveRes, overtimeRes] = await Promise.all([
      api(`/leave?requesterId=${sessionUser.id}&role=${sessionUser.role}`),
      api(`/overtime?requesterId=${sessionUser.id}&role=${sessionUser.role}`)
    ]);

    approvalItems = [
      ...(leaveRes || []).filter(r =>
        sessionUser.role === 'manager_line' ? r.status === 'pending_manager' :
        sessionUser.role === 'hrd' ? r.status === 'pending_hrd' : false
      ).map(r => ({ ...r, type: 'leave' })),
      ...(overtimeRes || []).filter(r =>
        sessionUser.role === 'manager_line' ? r.status === 'pending_manager' :
        sessionUser.role === 'hrd' ? r.status === 'pending_hrd' : false
      ).map(r => ({ ...r, type: 'overtime' })),
    ];

    renderApprovals();
  } catch (error) {
    console.error("Approvals error:", error);
  }
};

const renderApprovals = () => {
  if (!approvalsList) return;

  if (approvalItems.length === 0) {
    approvalsList.innerHTML = '<p class="muted">Tidak ada pending approvals.</p>';
    return;
  }

  approvalsList.innerHTML = approvalItems.map(row => `
    <div class="item">
      <div class="item-title">${row.employee_name || 'Employee'} - ${row.type === 'leave' ? 'Leave' : 'Overtime'}</div>
      <div class="item-meta">${row.type === 'leave' ? `Period: ${row.start_date} s/d ${row.end_date}` : `${row.overtime_date} - ${row.hours} hours`}</div>
      ${row.note ? `<div class="item-meta">Note: ${row.note}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button class="approve-btn" onclick="window.approveRequest('${row.type}', ${row.id}, 'approve')">Approve</button>
        <button class="reject-btn" onclick="window.approveRequest('${row.type}', ${row.id}, 'reject')">Reject</button>
      </div>
    </div>
  `).join("");
};

window.approveRequest = async (type, id, action) => {
  if (!sessionUser) return;
  try {
    const endpoint = type === 'leave' ?
      (sessionUser.role === 'manager_line' ? '/leave/approve-manager' : '/leave/approve-hrd') :
      (sessionUser.role === 'manager_line' ? '/overtime/approve-manager' : '/overtime/approve-hrd');

    const url = `${endpoint}/${id}`;
    const body = action === 'approve' ?
      { approverId: sessionUser.id } :
      { approverId: sessionUser.id, remark: 'Rejected' };

    const result = await api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    alert(`Request ${action}d successfully`);
    await loadApprovals();
  } catch (error) {
    alert(`Failed to ${action} request: ` + error.message);
  }
};

const renderLeave = (rows) => {
  if (!rows || rows.length === 0) {
    leaveList.innerHTML = '<p class="muted">Belum ada data cuti.</p>';
    return;
  }
  leaveList.innerHTML = rows.map(row => `
    <div class="item">
      <div class="item-title">${row.employee_name || "Employee"} - ${row.leave_type}</div>
      <div class="item-meta">${toLocal(row.start_date)} s/d ${toLocal(row.end_date)}</div>
      <span class="status ${row.status === 'approved' ? 'ok' : row.status === 'pending' ? 'warn' : 'bad'}">${row.status || "pending"}</span>
    </div>
  `).join("");
};

const renderLate = (rows) => {
  if (!rows || rows.length === 0) {
    lateList.innerHTML = '<p class="muted">Belum ada data late.</p>';
    return;
  }
  lateList.innerHTML = rows.map(row => `
    <div class="item">
      <div class="item-title">${row.employee_name || "Employee"}</div>
      <div class="item-meta">Masuk: ${toLocal(row.check_in)} | Lokasi: ${row.location_type || "-"}</div>
      <span class="status bad">Late</span>
    </div>
  `).join("");
};

const renderOvertime = (rows) => {
  if (!rows || rows.length === 0) {
    overtimeList.innerHTML = '<p class="muted">Belum ada data lembur.</p>';
    return;
  }
  overtimeList.innerHTML = rows.map(row => `
    <div class="item">
      <div class="item-title">${row.employee_name || "Employee"} - ${row.hours} jam</div>
      <div class="item-meta">Tanggal: ${toLocal(row.overtime_date)} | ${row.note || "-"}</div>
      <span class="status ${row.status === 'approved' ? 'ok' : 'warn'}">${row.status || "pending"}</span>
    </div>
  `).join("");
};

document.getElementById("btnLogin").addEventListener("click", async () => {
  try {
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value.trim();
    const data = await api("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    sessionUser = data;
    if (topMeta) topMeta.textContent = `${data.name} (${data.role})`;
    if (userInfo) userInfo.textContent = `User: ${data.name} (${data.role})`;
    if (loginCard) loginCard.classList.add("hidden");
    if (dashboardCard && IS_ADMIN_ROLE(data.role)) dashboardCard.classList.remove("hidden");
    bottomTabs.classList.remove("hidden");
    await loadDashboard();
    await loadRequests();
    await loadApprovals();
  } catch (error) {
    alert("Login gagal: " + error.message);
  }
});

document.getElementById("btnRefresh").addEventListener("click", async () => {
  await loadDashboard();
  await loadRequests();
  await loadApprovals();
});

document.getElementById("btnCheckIn").addEventListener("click", async () => {
  if (!sessionUser) return;
  try {
    if (gpsStatus) gpsStatus.textContent = "Mendapatkan lokasi GPS...";
    const pos = await getPosition();
    if (gpsStatus) gpsStatus.textContent = `GPS: ${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)} (±${Math.round(pos.accuracy || 0)}m)`;

    const selectedSite = PROJECT_SITES.find(s => s.id === sessionUser.site_id) || PROJECT_SITES[0];
    const distance = haversineDistanceMeters(pos.latitude, pos.longitude, selectedSite.latitude, selectedSite.longitude);
    const locationType = distance <= selectedSite.radiusMeters ? "onsite" : "offsite";

    const result = await api("/attendance/check-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterId: sessionUser.id, latitude: pos.latitude, longitude: pos.longitude, locationType: "gps-web" }),
    });
    alert(`Check-in berhasil! (${locationType}, jarak ${Math.round(distance)}m)`);
    await loadDashboard();
  } catch (error) {
    if (gpsStatus) gpsStatus.textContent = "GPS Error: " + error.message;
  }
});

document.getElementById("btnCheckOut").addEventListener("click", async () => {
  if (!sessionUser) return;
  try {
    if (gpsStatus) gpsStatus.textContent = "Mendapatkan lokasi GPS...";
    const pos = await getPosition();
    if (gpsStatus) gpsStatus.textContent = `GPS: ${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)} (±${Math.round(pos.accuracy || 0)}m)`;

    const selectedSite = PROJECT_SITES.find(s => s.id === sessionUser.site_id) || PROJECT_SITES[0];
    const distance = haversineDistanceMeters(pos.latitude, pos.longitude, selectedSite.latitude, selectedSite.longitude);
    const locationType = distance <= selectedSite.radiusMeters ? "onsite" : "offsite";

    const result = await api("/attendance/check-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterId: sessionUser.id, latitude: pos.latitude, longitude: pos.longitude, locationType: "gps-web" }),
    });
    alert(`Check-out berhasil! (${locationType}, jarak ${Math.round(distance)}m)`);
    await loadDashboard();
  } catch (error) {
    if (gpsStatus) gpsStatus.textContent = "GPS Error: " + error.message;
  }
});

document.getElementById("btnSubmitLeave").addEventListener("click", async () => {
  if (!sessionUser) return;
  try {
    const startDate = document.getElementById("leaveStart").value;
    const endDate = document.getElementById("leaveEnd").value;
    const leaveType = document.getElementById("leaveType").value;
    const note = document.getElementById("leaveNote").value.trim();
    await api("/leave/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterId: sessionUser.id, startDate, endDate, leaveType, note }),
    });
    alert("Cuti berhasil diajukan. Menunggu persetujuan manager & HRD.");
    await loadRequests();
  } catch (error) {
    alert("Gagal: " + error.message);
  }
});

document.getElementById("btnSubmitOvertime").addEventListener("click", async () => {
  if (!sessionUser) return;
  try {
    const overtimeDate = document.getElementById("otDate").value;
    const hours = Number(document.getElementById("otHours").value || "0");
    const note = document.getElementById("otNote").value.trim();
    await api("/overtime/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requesterId: sessionUser.id, overtimeDate, hours, note }),
    });
    alert("Lembur berhasil diajukan");
    await loadRequests();
  } catch (error) {
    alert("Gagal: " + error.message);
  }
});

document.getElementById("btnLogout").addEventListener("click", () => {
  sessionUser = null;
  if (loginCard) loginCard.classList.remove("hidden");
  if (dashboardCard) dashboardCard.classList.add("hidden");
  bottomTabs.classList.add("hidden");
  if (topMeta) topMeta.textContent = "Sign in untuk lihat absensi";
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

window.addEventListener("load", () => {
  if (loadingOverlay) loadingOverlay.style.display = "none";
  switchTab("attendance");
});

document.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && !sessionUser) {
    event.preventDefault();
    document.getElementById("btnLogin").click();
  }
});
