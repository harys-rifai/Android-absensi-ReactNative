const output = document.getElementById("output");
const topMeta = document.getElementById("topMeta");
const loginCard = document.getElementById("loginCard");
const dashboard = document.getElementById("dashboard");
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

const show = (data) => {
  output.textContent =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
};

const api = async (url, options = {}) => {
  const res = await fetch(url, options);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("application/json")
    ? await res.json()
    : await res.text();
  if (!res.ok) {
    throw new Error(typeof body === "string" ? body : JSON.stringify(body));
  }
  return body;
};

const toLocal = (value) => {
  if (!value) {
    return "-";
  }
  try {
    return new Date(value).toLocaleString("id-ID");
  } catch {
    return value;
  }
};

let sessionUser = null;
const IS_ADMIN_ROLE = (role) => role === "hrd";

const renderAttendance = (rows) => {
  if (!rows || rows.length === 0) {
    attendanceList.innerHTML = '<div class="muted">Belum ada data absensi.</div>';
    return;
  }
  attendanceList.innerHTML = rows
    .map((row) => {
      const synced = row.synced === true;
      return `
      <div class="item">
        <div class="title">${row.employee_name || "Employee"} ${
          row.location_type ? `- ${row.location_type}` : ""
        }</div>
        <div class="meta">Check-in: ${toLocal(row.check_in)} | Check-out: ${toLocal(
        row.check_out
      )}</div>
        <span class="status ${synced ? "ok" : "warn"}">${
        synced ? "Synced" : "Pending Sync"
      }</span>
      </div>`;
    })
    .join("");
};

const renderLate = (rows) => {
  if (!rows || rows.length === 0) {
    lateList.innerHTML = '<div class="muted">Belum ada data late.</div>';
    return;
  }
  lateList.innerHTML = rows
    .map(
      (row) => `
      <div class="item">
        <div class="title">${row.employee_name || "Employee"} - Masuk: ${toLocal(
        row.check_in
      )}</div>
        <div class="meta">Lokasi: ${row.location_type || "-"}</div>
        <span class="status bad">Late</span>
      </div>`
    )
    .join("");
};

const renderLeave = (rows) => {
  if (!rows || rows.length === 0) {
    leaveList.innerHTML = '<div class="muted">Belum ada data cuti.</div>';
    return;
  }
  leaveList.innerHTML = rows
    .map(
      (row) => `
      <div class="item">
        <div class="title">${row.employee_name || "Employee"} - ${row.leave_type}</div>
        <div class="meta">${toLocal(row.start_date)} sampai ${toLocal(
        row.end_date
      )}</div>
        <span class="status ok">${row.status || "approved"}</span>
      </div>`
    )
    .join("");
};

const renderOvertime = (rows) => {
  if (!rows || rows.length === 0) {
    overtimeList.innerHTML = '<div class="muted">Belum ada data lembur.</div>';
    return;
  }
  overtimeList.innerHTML = rows
    .map(
      (row) => `
      <div class="item">
        <div class="title">${row.employee_name || "Employee"} - ${
        row.hours
      } jam</div>
        <div class="meta">Tanggal: ${toLocal(row.overtime_date)} | Catatan: ${
        row.note || "-"
      }</div>
        <span class="status ${row.status === "approved" ? "ok" : "warn"}">${
        row.status
      }</span>
      </div>`
    )
    .join("");
};

const getPosition = async () => {
  if (!("geolocation" in navigator)) {
    throw new Error("Browser tidak mendukung GPS.");
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }),
      (err) => reject(new Error(err.message || "Gagal membaca GPS.")),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
};

const switchTab = (tabName) => {
  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  panels.forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `panel-${tabName}`);
  });
};

const loadDashboard = async () => {
  if (!sessionUser) {
    return;
  }
  try {
    const data = await api(
      `/dashboard?requesterId=${encodeURIComponent(
        sessionUser.id
      )}&role=${encodeURIComponent(sessionUser.role)}`
    );
    show(data);
    kpiTotal.textContent = String(data.summary?.totalAttendance ?? 0);
    kpiLate.textContent = String(data.summary?.lateCount ?? 0);
    kpiActive.textContent = String(data.summary?.activeShift ?? 0);
    kpiLeave.textContent = String(data.summary?.leaveCount ?? 0);
    kpiOvertime.textContent = String(data.summary?.overtimeCount ?? 0);
    renderAttendance(data.attendance || []);
    renderLeave(data.leave || []);
    renderLate(data.late || []);

    const overtime = await api(
      `/overtime?requesterId=${encodeURIComponent(
        sessionUser.id
      )}&role=${encodeURIComponent(sessionUser.role)}`
    );
    renderOvertime(overtime || []);
  } catch (error) {
    show(error.message || "Failed loading dashboard");
  }
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
    const scopeText = IS_ADMIN_ROLE(data.role)
      ? "Admin view all enabled"
      : "User scoped view";
    topMeta.textContent = `${data.name} (${data.role}) - ${scopeText}`;
    loginCard.classList.add("hidden");
    dashboard.classList.remove("hidden");
    bottomTabs.classList.remove("hidden");
    await loadDashboard();
  } catch (error) {
    show(error.message);
  }
});

document.getElementById("btnRefresh").addEventListener("click", async () => {
  await loadDashboard();
});

document.getElementById("btnCheckIn").addEventListener("click", async () => {
  if (!sessionUser) {
    return;
  }
  try {
    const pos = await getPosition();
    const result = await api("/attendance/check-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requesterId: sessionUser.id,
        latitude: pos.latitude,
        longitude: pos.longitude,
        locationType: "gps-mobile",
      }),
    });
    show(result);
    await loadDashboard();
  } catch (error) {
    show(error.message);
  }
});

document.getElementById("btnCheckOut").addEventListener("click", async () => {
  if (!sessionUser) {
    return;
  }
  try {
    const pos = await getPosition();
    const result = await api("/attendance/check-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requesterId: sessionUser.id,
        latitude: pos.latitude,
        longitude: pos.longitude,
        locationType: "gps-mobile",
      }),
    });
    show(result);
    await loadDashboard();
  } catch (error) {
    show(error.message);
  }
});

document.getElementById("btnSubmitLeave").addEventListener("click", async () => {
  if (!sessionUser) {
    return;
  }
  try {
    const startDate = document.getElementById("leaveStart").value;
    const endDate = document.getElementById("leaveEnd").value;
    const leaveType = document.getElementById("leaveType").value;
    const note = document.getElementById("leaveNote").value.trim();
    const result = await api("/leave/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requesterId: sessionUser.id,
        startDate,
        endDate,
        leaveType,
        note,
      }),
    });
    show(result);
    await loadDashboard();
  } catch (error) {
    show(error.message);
  }
});

document
  .getElementById("btnSubmitOvertime")
  .addEventListener("click", async () => {
    if (!sessionUser) {
      return;
    }
    try {
      const overtimeDate = document.getElementById("otDate").value;
      const hours = Number(document.getElementById("otHours").value || "0");
      const note = document.getElementById("otNote").value.trim();
      const result = await api("/overtime/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requesterId: sessionUser.id,
          overtimeDate,
          hours,
          note,
        }),
      });
      show(result);
      await loadDashboard();
    } catch (error) {
      show(error.message);
    }
  });

tabs.forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

window.addEventListener("load", () => {
  show({ message: "Ready", note: "Login to open mobile dashboard" });
  switchTab("attendance");
});

document.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && !sessionUser) {
    event.preventDefault();
    try {
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value.trim();
      const data = await api("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      sessionUser = data;
      const scopeText = IS_ADMIN_ROLE(data.role)
        ? "Admin view all enabled"
        : "User scoped view";
      topMeta.textContent = `${data.name} (${data.role}) - ${scopeText}`;
      loginCard.classList.add("hidden");
      dashboard.classList.remove("hidden");
      bottomTabs.classList.remove("hidden");
      await loadDashboard();
    } catch (error) {
      show(error.message);
    }
  }
});
