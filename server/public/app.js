const output = document.getElementById("output");
const topMeta = document.getElementById("topMeta");
const pageTitle = document.getElementById("pageTitle");
const loginCard = document.getElementById("loginCard");
const dashboardCard = document.getElementById("dashboardCard");
const attendanceList = document.getElementById("attendanceList");
const lateList = document.getElementById("lateList");
const leaveList = document.getElementById("leaveList");
const overtimeList = document.getElementById("overtimeList");
const kpiTotal = document.getElementById("kpiTotal");
const kpiLate = document.getElementById("kpiLate");
const kpiActive = document.getElementById("kpiActive");
const kpiLeave = document.getElementById("kpiLeave");
const kpiOvertime = document.getElementById("kpiOvertime");
const tabs = Array.from(document.querySelectorAll(".tab"));
const panels = Array.from(document.querySelectorAll(".tab-panel"));
const bottomTabs = document.getElementById("bottomTabs");
const loadingOverlay = document.getElementById("loadingOverlay");
const siteList = document.getElementById("siteList");
const calendarContainer = document.getElementById("calendarContainer");
const selectedDayRecords = document.getElementById("selectedDayRecords");
const gpsStatus = document.getElementById("gpsStatus");
const userInfo = document.getElementById("userInfo");

const PROJECT_SITES = [
  { id: "jkt-hq", name: "Jakarta HQ", latitude: -6.2001, longitude: 106.8167, radiusMeters: 150 },
  { id: "bdg-plant", name: "Bandung Plant", latitude: -6.9147, longitude: 107.6098, radiusMeters: 200 },
  { id: "sby-field", name: "Surabaya Field Office", latitude: -7.2575, longitude: 112.7521, radiusMeters: 200 },
];

let selectedSiteId = PROJECT_SITES[0].id;
let selectedDate = new Date();
let attendanceRecords = [];

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
  } catch {
    return value;
  }
};

let sessionUser = null;
const IS_ADMIN_ROLE = (role) => role === "hrd" || role === "admin";

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
  const titles = { attendance: "Absensi", history: "History", late: "Late", leave: "Cuti", settings: "Settings" };
  if (pageTitle) pageTitle.textContent = titles[tabName] || "Absensi";
};

const renderSites = () => {
  if (!siteList) return;
  siteList.innerHTML = PROJECT_SITES.map((site) => {
    const active = site.id === selectedSiteId;
    return `<div class="site-button ${active ? 'active' : ''}" data-site="${site.id}" onclick="window.selectSite('${site.id}')">
      <div class="site-name">${site.name}</div>
      <div class="site-meta">Radius ${site.radiusMeters}m</div>
    </div>`;
  }).join("");
};

window.selectSite = (siteId) => {
  selectedSiteId = siteId;
  renderSites();
};

const renderCalendar = () => {
  if (!calendarContainer) return;
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();

  const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const dayNames = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

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
    const hasRecord = attendanceRecords.some(r => r.check_in && r.check_in.startsWith(dateStr));
    const isToday = today.getDate() === day && today.getMonth() === month && today.getFullYear() === year;
    const isSelected = selectedDate.getDate() === day && selectedDate.getMonth() === month && selectedDate.getFullYear() === year;

    let classes = "calendar-day";
    if (isSelected) classes += " active";
    else if (isToday) classes += " today";
    else if (hasRecord) classes += " has-record";

    html += `<div class="${classes}" onclick="window.selectDate(${day})">${day}</div>`;
  }

  html += `</div>`;
  calendarContainer.innerHTML = html;
  renderSelectedDayRecords();
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
      <div class="item-meta">Check-in: ${toLocal(row.check_in)}</div>
      ${row.check_out ? `<div class="item-meta">Check-out: ${toLocal(row.check_out)}</div>` : '<div class="item-meta">Belum check-out</div>'}
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
    renderSites();
    await loadDashboard();
  } catch (error) {
    alert("Login gagal: " + error.message);
  }
});

document.getElementById("btnRefresh").addEventListener("click", async () => {
  await loadDashboard();
});

document.getElementById("btnCheckIn").addEventListener("click", async () => {
  if (!sessionUser) return;
  try {
    if (gpsStatus) gpsStatus.textContent = "Mendapatkan lokasi GPS...";
    const pos = await getPosition();
    if (gpsStatus) gpsStatus.textContent = `GPS: ${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)} (±${Math.round(pos.accuracy || 0)}m)`;

    const selectedSite = PROJECT_SITES.find(s => s.id === selectedSiteId) || PROJECT_SITES[0];
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

    const selectedSite = PROJECT_SITES.find(s => s.id === selectedSiteId) || PROJECT_SITES[0];
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
    await loadDashboard();
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
    await loadDashboard();
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
