const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./db");

const app = express();
const PORT = Number(process.env.API_PORT || 4000);

// Haversine distance calculation (in meters)
const haversineDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000; // Earth's radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Project sites configuration
const PROJECT_SITES = [
  { id: "jkt-hq", name: "Jakarta HQ", latitude: -6.2001, longitude: 106.8167, radiusMeters: 150 },
  { id: "bdg-plant", name: "Bandung Plant", latitude: -6.9147, longitude: 107.6098, radiusMeters: 200 },
  { id: "sby-field", name: "Surabaya Field Office", latitude: -7.2575, longitude: 112.7521, radiusMeters: 200 },
];

// Server-side GPS validation
const validateGpsLocation = (latitude, longitude) => {
  if (!latitude || !longitude) return { valid: false, locationType: "unknown", distance: null };

  let minDistance = Infinity;
  let nearestSite = null;

  for (const site of PROJECT_SITES) {
    const distance = haversineDistanceMeters(latitude, longitude, site.latitude, site.longitude);
    if (distance < minDistance) {
      minDistance = distance;
      nearestSite = site;
    }
  }

  const locationType = minDistance <= nearestSite.radiusMeters ? "onsite" : "offsite";
  return { valid: true, locationType, distance: Math.round(minDistance), site: nearestSite };
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const roleScope = (role, employeeColumn, requesterId) => {
  if (role === "user") {
    return {
      clause: ` WHERE ${employeeColumn} = $1`,
      params: [requesterId],
    };
  }
  return { clause: "", params: [] };
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api", (_req, res) => {
  res.json({
    service: "Hybrid Attendance API",
    status: "running",
    endpoints: [
      "/health",
      "/auth/login",
      "/attendance",
      "/attendance/late",
      "/attendance/check-in",
      "/attendance/check-out",
      "/leave",
      "/leave/request",
      "/overtime",
      "/overtime/request",
      "/dashboard",
      "/sync/attendance",
      "/news",
      "/news/create"
    ],
  });
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required." });
      return;
    }

    const result = await pool.query(
      `SELECT id, name, email, role, site_id, line_manager_id
       FROM employee
       WHERE email = $1 AND password_hash = md5($2)
       LIMIT 1`,
      [email, password]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: "Invalid credentials." });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Login error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to authenticate user";
    res.status(500).json({ error: message });
  }
});

app.get("/attendance", async (req, res) => {
  try {
    const requesterId = Number(req.query.requesterId || 0);
    const role = String(req.query.role || "user");

    if (role === "user" && !requesterId) {
      res.status(400).json({ error: "requesterId and role are required." });
      return;
    }

    let query = `
      SELECT a.*, e.name AS employee_name, e.role AS employee_role
      FROM attendance a
      INNER JOIN employee e ON e.id = a.employee_id
    `;
    const params = [];

    if (role === "user") {
      query += " WHERE a.employee_id = $1";
      params.push(requesterId);
    }

    query += " ORDER BY COALESCE(a.check_in, a.check_out) DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch attendance";
    res.status(500).json({ error: message });
  }
});

app.get("/attendance/late", async (req, res) => {
  try {
    const requesterId = Number(req.query.requesterId || 0);
    const role = String(req.query.role || "user");
    if (role === "user" && !requesterId) {
      res.status(400).json({ error: "requesterId and role are required." });
      return;
    }

    const scoped = roleScope(role, "a.employee_id", requesterId);
    const result = await pool.query(
      `
      SELECT a.*, e.name AS employee_name, e.role AS employee_role
      FROM attendance a
      INNER JOIN employee e ON e.id = a.employee_id
      ${scoped.clause}
      ${scoped.clause ? " AND " : " WHERE "}
      a.check_in IS NOT NULL
      AND ((a.check_in AT TIME ZONE 'Asia/Jakarta')::time > TIME '09:00:00')
      ORDER BY a.check_in DESC
      `,
      scoped.params
    );
    res.json(result.rows);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch late attendance";
    res.status(500).json({ error: message });
  }
});

app.post("/attendance/check-in", async (req, res) => {
  try {
    const { requesterId, latitude, longitude, locationType: clientLocationType } = req.body;
    const id = Number(requesterId || 0);
    if (!id) {
      res.status(400).json({ error: "requesterId is required." });
      return;
    }

    // Check for existing open check-in
    // Check for existing check-in today
    const existingToday = await pool.query(
      `SELECT id FROM attendance
       WHERE employee_id = $1
         AND DATE(check_in AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE AT TIME ZONE 'Asia/Jakarta'
       LIMIT 1`,
      [id]
    );
    if (existingToday.rows.length > 0) {
      res.status(400).json({ error: "You already have a check-in today. Only one check-in per day is allowed." });
      return;
    }

    // Check for active check-in (not checked out)
    const existing = await pool.query(
      `SELECT id FROM attendance WHERE employee_id = $1 AND check_out IS NULL LIMIT 1`,
      [id]
    );
    if (existing.rows.length > 0) {
      res.status(400).json({ error: "You already have an active check-in. Please check-out first." });
      return;
    }

    // Server-side GPS validation
    const gpsValidation = validateGpsLocation(latitude, longitude);
    const locationType = gpsValidation.valid ? gpsValidation.locationType : (clientLocationType || "gps-web");

    const clientRef = req.body.clientRef || `web-${id}-${Date.now()}`;
    const result = await pool.query(
      `INSERT INTO attendance (
        employee_id, check_in, latitude, longitude, location_type, synced, client_ref
      ) VALUES ($1, NOW(), $2, $3, $4, TRUE, $5)
      RETURNING *`,
      [id, latitude ?? null, longitude ?? null, locationType, clientRef]
    );

    // Add server validation info to response
    const response = result.rows[0];
    if (gpsValidation.valid) {
      response.server_location_type = gpsValidation.locationType;
      response.distance_to_site = gpsValidation.distance;
      response.nearest_site = gpsValidation.site?.name;
    }

    res.status(201).json(response);
  } catch (error) {
    console.error("Check-in error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to check in attendance";
    res.status(500).json({ error: message });
  }
});

app.post("/attendance/check-out", async (req, res) => {
  try {
    const { requesterId, latitude, longitude, locationType: clientLocationType } = req.body;
    const id = Number(requesterId || 0);
    if (!id) {
      res.status(400).json({ error: "requesterId is required." });
      return;
    }

    // Check if already checked out today
    const alreadyCheckedOut = await pool.query(
      `SELECT id FROM attendance
       WHERE employee_id = $1
         AND DATE(check_out AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE AT TIME ZONE 'Asia/Jakarta'
       LIMIT 1`,
      [id]
    );
    if (alreadyCheckedOut.rows.length > 0) {
      res.status(400).json({ error: "You already have a check-out today. Only one check-out per day is allowed." });
      return;
    }

    // Server-side GPS validation
    const gpsValidation = validateGpsLocation(latitude, longitude);
    const locationType = gpsValidation.valid ? gpsValidation.locationType : (clientLocationType || "gps-web");

    const open = await pool.query(
      `SELECT id
       FROM attendance
       WHERE employee_id = $1 AND check_out IS NULL
       ORDER BY check_in DESC
       LIMIT 1`,
      [id]
    );
    if (open.rows.length === 0) {
      res.status(400).json({ error: "No open check-in record found. Please check-in first." });
      return;
    }

    const updated = await pool.query(
      `UPDATE attendance
       SET check_out = NOW(),
           latitude = COALESCE($1, latitude),
           longitude = COALESCE($2, longitude),
           location_type = $3
       WHERE id = $4
       RETURNING *`,
      [latitude ?? null, longitude ?? null, locationType, open.rows[0].id]
    );

    // Add server validation info to response
    const response = updated.rows[0];
    if (gpsValidation.valid) {
      response.server_location_type = gpsValidation.locationType;
      response.distance_to_site = gpsValidation.distance;
      response.nearest_site = gpsValidation.site?.name;
    }

    res.json(response);
  } catch (error) {
    console.error("Check-out error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to check out attendance";
    res.status(500).json({ error: message });
  }
});

app.get("/leave", async (req, res) => {
  try {
    const requesterId = Number(req.query.requesterId || 0);
    const role = String(req.query.role || "user");

    if (role === "user" && !requesterId) {
      res.status(400).json({ error: "requesterId and role are required." });
      return;
    }

    let query = `
      SELECT l.*, e.name AS employee_name, e.role AS employee_role
      FROM leave_request l
      INNER JOIN employee e ON e.id = l.employee_id
    `;
    const params = [];

    if (role === "user") {
      query += " WHERE l.employee_id = $1";
      params.push(requesterId);
    }

    query += " ORDER BY l.start_date DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch leave history";
    res.status(500).json({ error: message });
  }
});

app.post("/leave/request", async (req, res) => {
  try {
    const { requesterId, startDate, endDate, leaveType, note } = req.body;
    const id = Number(requesterId || 0);
    if (!id || !startDate || !endDate) {
      res
        .status(400)
        .json({ error: "requesterId, startDate, and endDate are required." });
      return;
    }

    const result = await pool.query(
      `INSERT INTO leave_request (
        employee_id, start_date, end_date, leave_type, status, note
      ) VALUES (
        $1, $2, $3, $4, 'pending_manager', $5
      )
      RETURNING *`,
      [id, startDate, endDate, leaveType || "annual", note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Leave request error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to request leave";
    res.status(500).json({ error: message });
  }
});

// Approve leave by manager
app.post("/leave/approve-manager/:id", async (req, res) => {
  try {
    const leaveId = Number(req.params.id || 0);
    const { approverId } = req.body;

    if (!leaveId || !approverId) {
      res.status(400).json({ error: "leaveId and approverId are required." });
      return;
    }

    const result = await pool.query(
      `UPDATE leave_request
       SET status = 'pending_hrd', manager_approved_by = $1, manager_approved_at = NOW()
       WHERE id = $2 AND status = 'pending_manager'
       RETURNING *`,
      [approverId, leaveId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Leave request not found or already processed." });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Manager approval error:", error);
    const message = error instanceof Error ? error.message : "Failed to approve leave";
    res.status(500).json({ error: message });
  }
});

// Approve leave by HRD
app.post("/leave/approve-hrd/:id", async (req, res) => {
  try {
    const leaveId = Number(req.params.id || 0);
    const { approverId } = req.body;

    if (!leaveId || !approverId) {
      res.status(400).json({ error: "leaveId and approverId are required." });
      return;
    }

    const result = await pool.query(
      `UPDATE leave_request
       SET status = 'approved', hrd_approved_by = $1, hrd_approved_at = NOW()
       WHERE id = $2 AND (status = 'pending_hrd' OR status = 'pending_manager')
       RETURNING *`,
      [approverId, leaveId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Leave request not found or already processed." });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("HRD approval error:", error);
    const message = error instanceof Error ? error.message : "Failed to approve leave";
    res.status(500).json({ error: message });
  }
});

app.get("/overtime", async (req, res) => {
  try {
    const requesterId = Number(req.query.requesterId || 0);
    const role = String(req.query.role || "user");
    if (role === "user" && !requesterId) {
      res.status(400).json({ error: "requesterId and role are required." });
      return;
    }

    const scoped = roleScope(role, "o.employee_id", requesterId);
    const result = await pool.query(
      `SELECT o.*, e.name AS employee_name, e.role AS employee_role
       FROM overtime_request o
       INNER JOIN employee e ON e.id = o.employee_id
       ${scoped.clause}
       ORDER BY o.overtime_date DESC, o.created_at DESC`,
      scoped.params
    );
    res.json(result.rows);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch overtime history";
    res.status(500).json({ error: message });
  }
});

app.post("/overtime/request", async (req, res) => {
  try {
    const { requesterId, overtimeDate, hours, note } = req.body;
    const id = Number(requesterId || 0);
    const parsedHours = Number(hours || 0);
    if (!id || !overtimeDate || parsedHours <= 0) {
      res.status(400).json({ error: "requesterId, overtimeDate, and hours (>0) are required." });
      return;
    }

    const result = await pool.query(
      `INSERT INTO overtime_request (
        employee_id, overtime_date, hours, status, note
      ) VALUES (
        $1, $2, $3, 'pending_manager', $4
      )
      RETURNING *`,
      [id, overtimeDate, parsedHours, note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Overtime request error:", error);
    const message = error instanceof Error ? error.message : "Failed to request overtime";
    res.status(500).json({ error: message });
  }
});

// Approve overtime by manager
app.post("/overtime/approve-manager/:id", async (req, res) => {
  try {
    const otId = Number(req.params.id || 0);
    const { approverId } = req.body;

    if (!otId || !approverId) {
      res.status(400).json({ error: "overtimeId and approverId are required." });
      return;
    }

    const result = await pool.query(
      `UPDATE overtime_request
       SET status = 'pending_hrd', manager_approved_by = $1, manager_approved_at = NOW()
       WHERE id = $2 AND status = 'pending_manager'
       RETURNING *`,
      [approverId, otId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Overtime request not found or already processed." });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Manager approval error:", error);
    const message = error instanceof Error ? error.message : "Failed to approve overtime";
    res.status(500).json({ error: message });
  }
});

// Approve overtime by HRD
app.post("/overtime/approve-hrd/:id", async (req, res) => {
  try {
    const otId = Number(req.params.id || 0);
    const { approverId } = req.body;

    if (!otId || !approverId) {
      res.status(400).json({ error: "overtimeId and approverId are required." });
      return;
    }

    const result = await pool.query(
      `UPDATE overtime_request
       SET status = 'approved', hrd_approved_by = $1, hrd_approved_at = NOW()
       WHERE id = $2 AND status = 'pending_hrd'
       RETURNING *`,
      [approverId, otId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Overtime request not found or already processed." });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("HRD approval error:", error);
    const message = error instanceof Error ? error.message : "Failed to approve overtime";
    res.status(500).json({ error: message });
  }
});

app.get("/dashboard", async (req, res) => {
  try {
    const requesterId = Number(req.query.requesterId || 0);
    const role = String(req.query.role || "user");

    if (role === "user" && !requesterId) {
      res.status(400).json({ error: "requesterId and role are required." });
      return;
    }

    const params = [];
    const whereClause = role === "user" ? "WHERE a.employee_id = $1" : "";
    if (role === "user") {
      params.push(requesterId);
    }

    const attendanceQuery = `
      SELECT a.*, e.name AS employee_name, e.role AS employee_role
      FROM attendance a
      INNER JOIN employee e ON e.id = a.employee_id
      ${whereClause}
      ORDER BY COALESCE(a.check_in, a.check_out) DESC
      LIMIT 25
    `;
    const attendance = await pool.query(attendanceQuery, params);

    const leaveWhere = role === "user" ? "WHERE l.employee_id = $1" : "";
    const leaveParams = role === "user" ? [requesterId] : [];
    const leaveRows = await pool.query(
      `
      SELECT l.*, e.name AS employee_name
      FROM leave_request l
      INNER JOIN employee e ON e.id = l.employee_id
      ${leaveWhere}
      ORDER BY l.start_date DESC
      LIMIT 10
      `,
      leaveParams
    );

    const statWhere = role === "user" ? "WHERE employee_id = $1" : "";
    const statParams = role === "user" ? [requesterId] : [];
    const stats = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_attendance,
        COUNT(*) FILTER (WHERE check_out IS NULL)::int AS active_shift,
        COUNT(*) FILTER (
          WHERE check_in IS NOT NULL
          AND ((check_in AT TIME ZONE 'Asia/Jakarta')::time > TIME '09:00:00')
        )::int AS late_count
      FROM attendance
      ${statWhere}
      `,
      statParams
    );

    // Get leave count
    const leaveCountWhere = role === "user" ? "WHERE employee_id = $1" : "";
    const leaveCountParams = role === "user" ? [requesterId] : [];
    const leaveCount = await pool.query(
      `SELECT COUNT(*)::int AS leave_count FROM leave_request ${leaveCountWhere}`,
      leaveCountParams
    );

    const overtimeScope = roleScope(role, "employee_id", requesterId);
    const overtime = await pool.query(
      `SELECT COUNT(*)::int AS overtime_count
       FROM overtime_request
       ${overtimeScope.clause}`,
      overtimeScope.params
    );

    const lateRows = await pool.query(
      `
      SELECT a.*, e.name AS employee_name
      FROM attendance a
      INNER JOIN employee e ON e.id = a.employee_id
      ${role === "user" ? "WHERE a.employee_id = $1 AND " : "WHERE "}
      a.check_in IS NOT NULL
      AND ((a.check_in AT TIME ZONE 'Asia/Jakarta')::time > TIME '09:00:00')
      ORDER BY a.check_in DESC
      LIMIT 10
      `,
      role === "user" ? [requesterId] : []
    );

    res.json({
      summary: {
        totalAttendance: stats.rows[0]?.total_attendance ?? 0,
        activeShift: stats.rows[0]?.active_shift ?? 0,
        lateCount: stats.rows[0]?.late_count ?? 0,
        leaveCount: leaveCount.rows[0]?.leave_count ?? 0,
        overtimeCount: overtime.rows[0]?.overtime_count ?? 0,
      },
      attendance: attendance.rows,
      leave: leaveRows.rows,
      late: lateRows.rows,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load dashboard";
    res.status(500).json({ error: message });
  }
});

app.post("/sync/attendance", async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];

  if (records.length === 0) {
    res.status(400).json({ error: "records is required and must be an array." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const syncedClientRefs = [];

    for (const record of records) {
      const {
        employee_id,
        check_in,
        check_out,
        latitude,
        longitude,
        location_type,
        client_ref,
      } = record;

      const inserted = await client.query(
        `INSERT INTO attendance (
          employee_id,
          check_in,
          check_out,
          latitude,
          longitude,
          location_type,
          synced,
          client_ref
        ) VALUES (
          $1,$2,$3,$4,$5,$6,TRUE,$7
        )
        ON CONFLICT (client_ref) DO UPDATE
        SET
          check_out = COALESCE(EXCLUDED.check_out, attendance.check_out),
          latitude = COALESCE(EXCLUDED.latitude, attendance.latitude),
          longitude = COALESCE(EXCLUDED.longitude, attendance.longitude),
          location_type = COALESCE(EXCLUDED.location_type, attendance.location_type),
          synced = TRUE
        RETURNING id, client_ref`,
        [
          employee_id,
          check_in ?? null,
          check_out ?? null,
          latitude ?? null,
          longitude ?? null,
          location_type ?? null,
          client_ref,
        ]
      );
      syncedClientRefs.push(inserted.rows[0].client_ref);
    }

    await client.query("COMMIT");
    res.json({ syncedClientRefs, count: syncedClientRefs.length });
  } catch (error) {
    await client.query("ROLLBACK");
    const message =
      error instanceof Error ? error.message : "Failed to sync attendance";
    res.status(500).json({ error: message });
  } finally {
    client.release();
  }
});

app.get("/attendance/export", async (req, res) => {
  try {
    const role = String(req.query.role || "user");
    if (role !== "hrd") {
      res.status(403).json({ error: "Only hrd role can export attendance." });
      return;
    }

    const result = await pool.query(
      `SELECT
         a.id,
         e.name,
         e.email,
         e.role,
         a.check_in,
         a.check_out,
         a.latitude,
         a.longitude,
         a.location_type
       FROM attendance a
       INNER JOIN employee e ON e.id = a.employee_id
       ORDER BY COALESCE(a.check_in, a.check_out) DESC`
    );

    const header =
      "id,name,email,role,check_in,check_out,latitude,longitude,location_type";
    const rows = result.rows.map((row) =>
      [
        row.id,
        row.name,
        row.email,
        row.role,
        row.check_in ? new Date(row.check_in).toISOString() : "",
        row.check_out ? new Date(row.check_out).toISOString() : "",
        row.latitude ?? "",
        row.longitude ?? "",
        row.location_type ?? "",
      ].join(",")
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=attendance.csv");
    res.send([header, ...rows].join("\n"));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to export attendance";
    res.status(500).json({ error: message });
  }
});

app.get("/news", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.*, e.name AS author_name
       FROM news n
       LEFT JOIN employee e ON e.id = n.author_id
       WHERE n.is_active = TRUE
       ORDER BY n.published_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch news";
    res.status(500).json({ error: message });
  }
});

app.post("/news/create", async (req, res) => {
  try {
    const { title, content, image_url, author_id } = req.body;
    if (!title || !content || !author_id) {
      res.status(400).json({ error: "title, content, and author_id are required." });
      return;
    }

    const result = await pool.query(
      `INSERT INTO news (title, content, image_url, author_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [title, content, image_url || null, author_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create news";
    res.status(500).json({ error: message });
  }
});

app.get("/config/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const result = await pool.query(
      "SELECT value FROM server_config WHERE key = $1 LIMIT 1",
      [key]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Config key not found." });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch config";
    res.status(500).json({ error: message });
  }
});

app.post("/config", async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || !value) {
      res.status(400).json({ error: "key and value are required." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO server_config (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING *`,
      [key, value]
    );
    res.json(result.rows[0]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save config";
    res.status(500).json({ error: message });
  }
});

app.post("/api/update-profile", async (req, res) => {
  try {
    const { email, name, phone, foto } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (phone !== undefined) {
      updates.push(`phone = $${paramCount++}`);
      values.push(phone);
    }
    if (foto !== undefined) {
      updates.push(`foto = $${paramCount++}`);
      values.push(foto);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    updates.push(`updated_at = NOW()`);
    values.push(email);

    const query = `
      UPDATE employee
      SET ${updates.join(", ")}
      WHERE email = $${paramCount}
      RETURNING id, email, name, jabatan, phone, foto, role
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ message: "Profile updated successfully", user: result.rows[0] });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update profile";
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Attendance API running on http://0.0.0.0:${PORT}`);
  console.log(`For Android USB debugging, run: adb reverse tcp:${PORT} tcp:${PORT}`);
  console.log(`Then the app can access the API via http://localhost:${PORT}`);
});
