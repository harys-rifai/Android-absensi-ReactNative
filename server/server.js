const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./db");

const app = express();
const PORT = Number(process.env.API_PORT || 4000);

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
      `SELECT id, name, email, role
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
    const { requesterId, latitude, longitude } = req.body;
    const id = Number(requesterId || 0);
    if (!id) {
      res.status(400).json({ error: "requesterId is required." });
      return;
    }

    const locationType = req.body.locationType || "gps-mobile";
    const clientRef = req.body.clientRef || `web-${id}-${Date.now()}`;
    const result = await pool.query(
      `INSERT INTO attendance (
        employee_id, check_in, latitude, longitude, location_type, synced, client_ref
      ) VALUES ($1, NOW(), $2, $3, $4, TRUE, $5)
      RETURNING *`,
      [id, latitude ?? null, longitude ?? null, locationType, clientRef]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to check in attendance";
    res.status(500).json({ error: message });
  }
});

app.post("/attendance/check-out", async (req, res) => {
  try {
    const { requesterId, latitude, longitude } = req.body;
    const id = Number(requesterId || 0);
    if (!id) {
      res.status(400).json({ error: "requesterId is required." });
      return;
    }

    const locationType = req.body.locationType || "gps-mobile";
    const open = await pool.query(
      `SELECT id
       FROM attendance
       WHERE employee_id = $1 AND check_out IS NULL
       ORDER BY check_in DESC
       LIMIT 1`,
      [id]
    );
    if (open.rows.length === 0) {
      res.status(400).json({ error: "No open check-in record found." });
      return;
    }

    const updated = await pool.query(
      `UPDATE attendance
       SET check_out = NOW(),
           latitude = COALESCE($1, latitude),
           longitude = COALESCE($2, longitude),
           location_type = COALESCE($3, location_type)
       WHERE id = $4
       RETURNING *`,
      [latitude ?? null, longitude ?? null, locationType, open.rows[0].id]
    );
    res.json(updated.rows[0]);
  } catch (error) {
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
        $1, $2, $3, $4, 'pending', $5
      )
      RETURNING *`,
      [id, startDate, endDate, leaveType || "annual", note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to request leave";
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
      res.status(400).json({
        error: "requesterId, overtimeDate, and hours (>0) are required.",
      });
      return;
    }

    const result = await pool.query(
      `INSERT INTO overtime_request (
        employee_id, overtime_date, hours, status, note
      ) VALUES (
        $1, $2, $3, 'pending', $4
      )
      RETURNING *`,
      [id, overtimeDate, parsedHours, note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to request overtime";
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
        leaveCount: leaveRows.rows.length,
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

app.listen(PORT, () => {
  console.log(`Attendance API running on http://localhost:${PORT}`);
});
