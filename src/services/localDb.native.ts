import * as SQLite from "expo-sqlite";
import { AttendanceRecord, EngineerUser } from "../types/attendance";

// Use synchronous API to avoid prepareAsync issues
let db: SQLite.SQLiteDatabase | null = null;

const getDatabase = (): SQLite.SQLiteDatabase => {
  if (!db) {
    db = SQLite.openDatabaseSync("apsensi.db");
  }
  return db;
};

let initPromise: Promise<void> | null = null;

export const ensureDbInitialized = async (): Promise<void> => {
  if (!initPromise) {
    initPromise = initializeLocalDb();
  }
  await initPromise;
};

export const initializeLocalDb = async (): Promise<void> => {
  try {
    const database = getDatabase();

    database.execSync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        site_id INTEGER,
        password TEXT
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        check_in TEXT,
        check_out TEXT,
        latitude REAL,
        longitude REAL,
        location_type TEXT,
        synced INTEGER DEFAULT 0,
        client_ref TEXT UNIQUE,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      );

      CREATE TABLE IF NOT EXISTS news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER,
        title TEXT NOT NULL,
        content TEXT,
        image_url TEXT,
        author_name TEXT,
        published_at TEXT,
        synced INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS server_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attendance_client_ref TEXT,
        status TEXT,
        message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("SQLite initialized successfully (native)");
  } catch (error) {
    console.error("SQLite initialization error (native):", error);
  }
};

export const cacheSignedInUser = async (user: EngineerUser | null): Promise<void> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    if (!user) {
      database.runSync('DELETE FROM employees');
    } else {
      database.runSync(
        `INSERT OR REPLACE INTO employees (id, email, name, role, site_id, password)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [user.id || null, user.email, user.name, user.role, user.site_id || null, null]
      );
    }
  } catch (error) {
    console.error("Cache user error (native):", error);
  }
};

export const getLocalUser = async (email: string): Promise<EngineerUser | null> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const result = database.getFirstSync<EngineerUser>(
      'SELECT * FROM employees WHERE email = ?',
      [email]
    );
    return result || null;
  } catch (error) {
    console.error("Get local user error (native):", error);
    return null;
  }
};

export const getCachedUser = async (): Promise<EngineerUser | null> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const result = database.getFirstSync<EngineerUser>(
      'SELECT * FROM employees ORDER BY id DESC LIMIT 1'
    );
    return result || null;
  } catch (error) {
    console.error("Get cached user error (native):", error);
    return null;
  }
};

export const saveCheckInLocal = async (
  employeeId: number,
  latitude: number,
  longitude: number,
  locationType: string
): Promise<boolean> => {
  const clientRef = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  try {
    await ensureDbInitialized();
    const database = getDatabase();

    // Check if already checked in today using JS
    const existing = database.getFirstSync<{ check_in: string }>(
      `SELECT check_in FROM attendance WHERE employee_id = ? ORDER BY check_in DESC LIMIT 1`,
      [employeeId]
    );
    if (existing && existing.check_in) {
      const existingDate = existing.check_in.split('T')[0];
      if (existingDate === today) {
        return false;
      }
    }

    database.runSync(
      `INSERT INTO attendance (employee_id, check_in, latitude, longitude, location_type, synced, client_ref)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [employeeId, now, latitude, longitude, locationType, clientRef]
    );
    return true;
  } catch (error) {
    console.error("Save check-in error (native):", error);
    return false;
  }
};

export const saveCheckOutLocal = async (
  employeeId: number,
  latitude: number,
  longitude: number,
  locationType: string
): Promise<boolean> => {
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  try {
    await ensureDbInitialized();
    const database = getDatabase();

    // Get latest record to check
    const open = database.getFirstSync<{ id: number, check_out: string | null }>(
      `SELECT id, check_out FROM attendance WHERE employee_id = ? ORDER BY check_in DESC LIMIT 1`,
      [employeeId]
    );

    if (!open || open.check_out) {
      return false;
    }

    // Check if already checked out today
    if (open.check_out && open.check_out.split('T')[0] === today) {
      return false;
    }

    database.runSync(
      `UPDATE attendance
       SET check_out = ?, latitude = ?, longitude = ?, location_type = ?, synced = 0
       WHERE id = ?`,
      [now, latitude, longitude, locationType, open.id]
    );
    return true;
  } catch (error) {
    console.error("Save check-out error (native):", error);
    return false;
  }
};

export const getUnsyncedAttendance = async (): Promise<AttendanceRecord[]> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const rows = database.getAllSync<{
      id: number;
      employee_id: number;
      check_in: string | null;
      check_out: string | null;
      latitude: number | null;
      longitude: number | null;
      location_type: string | null;
      synced: number;
      client_ref: string;
    }>(`SELECT * FROM attendance WHERE synced = 0`);

    return rows.map((row) => ({
      id: row.id,
      employee_id: row.employee_id,
      check_in: row.check_in,
      check_out: row.check_out,
      latitude: row.latitude,
      longitude: row.longitude,
      location_type: row.location_type,
      synced: row.synced === 1,
      client_ref: row.client_ref,
    }));
  } catch (error) {
    console.error("Get unsynced error (native):", error);
    return [];
  }
};

export const markAttendanceSynced = async (clientRefs: string[]): Promise<void> => {
  if (clientRefs.length === 0) return;
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const placeholders = clientRefs.map(() => '?').join(',');
    database.runSync(
      `UPDATE attendance SET synced = 1 WHERE client_ref IN (${placeholders})`,
      clientRefs
    );
  } catch (error) {
    console.error("Mark synced error (native):", error);
  }
};

export const getLocalAttendanceForUser = async (
  employeeId: number
): Promise<AttendanceRecord[]> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const rows = database.getAllSync<{
      id: number;
      employee_id: number;
      check_in: string | null;
      check_out: string | null;
      latitude: number | null;
      longitude: number | null;
      location_type: string | null;
      synced: number;
      client_ref: string;
    }>(
      `SELECT * FROM attendance WHERE employee_id = ? ORDER BY check_in DESC`,
      [employeeId]
    );

    // Deduplicate by date
    const byDate = new Map<string, typeof rows>();
    rows.forEach((row) => {
      if (!row.check_in) return;
      const date = row.check_in.split('T')[0];
      if (!byDate.has(date)) {
        byDate.set(date, []);
      }
      byDate.get(date)!.push(row);
    });

    const deduped: AttendanceRecord[] = [];
    byDate.forEach((records) => {
      const withBoth = records.find(r => r.check_in && r.check_out);
      const toKeep = withBoth || records[0];
      deduped.push({
        id: toKeep.id,
        employee_id: toKeep.employee_id,
        check_in: toKeep.check_in,
        check_out: toKeep.check_out,
        latitude: toKeep.latitude,
        longitude: toKeep.longitude,
        location_type: toKeep.location_type,
        synced: toKeep.synced === 1,
        client_ref: toKeep.client_ref,
      });
    });

    return deduped.sort((a, b) =>
      new Date(b.check_in || b.check_out || 0).getTime() -
      new Date(a.check_in || a.check_out || 0).getTime()
    );
  } catch (error) {
    console.error("Get local attendance error (native):", error);
    return [];
  }
};

export type NewsItem = {
  id?: number;
  remote_id?: number;
  title: string;
  content: string;
  image_url?: string;
  author_name?: string;
  published_at?: string;
  synced?: boolean;
};

export const saveNewsLocal = async (news: NewsItem): Promise<void> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    database.runSync(
      `INSERT OR REPLACE INTO news (remote_id, title, content, image_url, author_name, published_at, synced)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [news.remote_id || null, news.title, news.content, news.image_url || null, news.author_name || null, news.published_at || null]
    );
  } catch (error) {
    console.error("Save news error (native):", error);
  }
};

export const saveNewsLocalBatch = async (newsItems: NewsItem[]): Promise<void> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    for (const item of newsItems) {
      database.runSync(
        `INSERT OR REPLACE INTO news (remote_id, title, content, image_url, author_name, published_at, synced)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [item.remote_id || null, item.title, item.content, item.image_url || null, item.author_name || null, item.published_at || null]
      );
    }
  } catch (error) {
    console.error("Save news batch error (native):", error);
  }
};

export const getLocalNews = async (): Promise<NewsItem[]> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const rows = database.getAllSync<{
      id: number;
      remote_id: number | null;
      title: string;
      content: string;
      image_url: string | null;
      author_name: string | null;
      published_at: string | null;
      synced: number;
    }>(`SELECT * FROM news ORDER BY published_at DESC`);

    return rows.map((row) => ({
      id: row.id,
      remote_id: row.remote_id ?? undefined,
      title: row.title,
      content: row.content,
      image_url: row.image_url ?? undefined,
      author_name: row.author_name ?? undefined,
      published_at: row.published_at ?? undefined,
      synced: row.synced === 1,
    }));
  } catch (error) {
    console.error("Get local news error (native):", error);
    return [];
  }
};

export type ServerConfig = {
  key: string;
  value: string;
  updated_at?: string;
};

export const saveServerConfig = async (key: string, value: string): Promise<void> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    database.runSync(
      `INSERT OR REPLACE INTO server_config (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
      [key, value]
    );
  } catch (error) {
    console.error("Save server config error (native):", error);
  }
};

export const getServerConfig = async (key: string): Promise<string | null> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const result = database.getFirstSync<{ value: string }>(
      'SELECT value FROM server_config WHERE key = ?',
      [key]
    );
    return result?.value ?? null;
  } catch (error) {
    console.error("Get server config error (native):", error);
    return null;
  }
};

export const insertSyncLog = async (
  attendanceClientRef: string,
  status: "success" | "failed",
  message: string
): Promise<void> => {
  try {
    await ensureDbInitialized();
    const database = getDatabase();
    database.runSync(
      `INSERT INTO sync_log (attendance_client_ref, status, message, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [attendanceClientRef, status, message]
    );
  } catch (error) {
    console.error("Insert sync log error (native):", error);
  }
};

export const webStorage = {
  employees: [],
  attendance: [],
  news: [],
  serverConfig: [],
};

export const saveAllToStorage = () => {
  // No-op for native
};
