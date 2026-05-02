import * as SQLite from 'expo-sqlite';
import { AttendanceRecord, EngineerUser } from "../types/attendance";

// Generate UUID v4
const generateUUID = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const getJakartaDateString = (date: Date): string => {
  const jakartaTime = new Date(date.getTime() + JAKARTA_OFFSET_MS);
  return `${jakartaTime.getUTCFullYear()}-${String(jakartaTime.getUTCMonth() + 1).padStart(2, '0')}-${String(jakartaTime.getUTCDate()).padStart(2, '0')}`;
};

// Platform detection
const isWeb = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

// ==================== Web Storage Fallback ====================
const loadFromStorage = (key: string) => {
  if (!isWeb) return null;
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

const saveToStorage = (key: string, data: any) => {
  if (!isWeb) return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('localStorage error:', e);
  }
};

export interface WebAttendance {
  id: number;
  employee_id: number;
  check_in: string | null;
  check_out: string | null;
  latitude: number;
  longitude: number;
  location_type: string;
  synced: number;
  client_ref: string;
}

export interface WebNews {
  id: number;
  remote_id: number | undefined;
  title: string;
  content: string;
  image_url: string | undefined;
  author_name: string | undefined;
  published_at: string | undefined;
  synced: number;
}

interface WebServerConfig {
  key: string;
  value: string;
}

// Clear old attendance data from localStorage on every load
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  try {
    localStorage.removeItem('attendance');
    console.log('✓ Cleared old attendance data from localStorage');
  } catch (e) {
    console.error('Error clearing localStorage:', e);
  }
}

export const webStorage: {
  employees: EngineerUser[];
  attendance: WebAttendance[];
  news: WebNews[];
  serverConfig: WebServerConfig[];
} = {
  employees: loadFromStorage('employees') || [],
  attendance: [],
  news: loadFromStorage('news') || [],
  serverConfig: loadFromStorage('serverConfig') || [],
};

export const saveAllToStorage = () => {
  saveToStorage('employees', webStorage.employees);
  saveToStorage('attendance', webStorage.attendance);
  saveToStorage('news', webStorage.news);
  saveToStorage('serverConfig', webStorage.serverConfig);
};

// ==================== SQLite Database (Native) ====================
let db: SQLite.SQLiteDatabase | null = null;

const getDatabase = (): SQLite.SQLiteDatabase => {
  if (!db) {
    db = SQLite.openDatabaseSync('apsensi.db');
  }
  return db;
};

// ==================== Initialize Database ====================
let initPromise: Promise<void> | null = null;

export const ensureDbInitialized = async (): Promise<void> => {
  if (isWeb) return;
  if (!initPromise) {
    initPromise = initializeLocalDb();
  }
  await initPromise;
};

export const initializeLocalDb = async (): Promise<void> => {
  if (isWeb) {
    console.log("Web mode: using localStorage");
    return;
  }

  try {
    const database = getDatabase();

    // Drop existing tables and recreate (for clean init)
    await database.execAsync(`
      DROP TABLE IF EXISTS sync_log;
      DROP TABLE IF EXISTS attendance;
      DROP TABLE IF EXISTS news;
      DROP TABLE IF EXISTS server_config;
      DROP TABLE IF EXISTS employees;

      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        site_id TEXT,
        password TEXT
      );

      CREATE TABLE attendance (
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

      CREATE TABLE news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER,
        title TEXT NOT NULL,
        content TEXT,
        image_url TEXT,
        author_name TEXT,
        published_at TEXT,
        synced INTEGER DEFAULT 1
      );

      CREATE TABLE server_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attendance_client_ref TEXT,
        status TEXT,
        message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("SQLite initialized successfully");
  } catch (error) {
    console.error("SQLite initialization error:", error);
  }
};

// ==================== User Operations ====================
export const cacheSignedInUser = async (user: EngineerUser | null): Promise<void> => {
  if (isWeb) {
    webStorage.employees = user ? [user] : [];
    saveAllToStorage();
    return;
  }

    try {
    await ensureDbInitialized();
    const database = getDatabase();
    if (!user) {
      await database.runAsync('DELETE FROM employees');
    } else {
      // Use INSERT ON CONFLICT instead of INSERT OR REPLACE for better compatibility
      await database.runAsync(
        `INSERT INTO employees (email, name, role, site_id, foto, flag, active, phone, jabatan, remark, datejoin, dateleft)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           name = excluded.name,
           role = excluded.role,
           site_id = excluded.site_id,
           foto = excluded.foto,
           flag = excluded.flag,
           active = excluded.active,
           phone = excluded.phone,
           jabatan = excluded.jabatan,
           remark = excluded.remark,
           datejoin = excluded.datejoin,
           dateleft = excluded.dateleft`,
        [user.email, user.name, user.role, user.site_id || null, user.foto || null, user.flag || 'active', user.active ?? 1, user.phone || null, user.jabatan || null, user.remark || null, user.datejoin || null, user.dateleft || null]
      );
    }
  } catch (error) {
    console.error("Cache user error:", error);
  }
};

export const getLocalUser = async (email: string): Promise<EngineerUser | null> => {
  if (isWeb) {
    return webStorage.employees.find((u) => u.email === email) || null;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const result = await database.getFirstAsync<EngineerUser>(
      'SELECT * FROM employees WHERE email = ?',
      [email]
    );
    return result || null;
  } catch (error) {
    console.error("Get local user error:", error);
    return null;
  }
};

export const getCachedUser = async (): Promise<EngineerUser | null> => {
  if (isWeb) {
    return webStorage.employees.length > 0 ? webStorage.employees[0] : null;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const result = await database.getFirstAsync<EngineerUser>(
      'SELECT * FROM employees ORDER BY id DESC LIMIT 1'
    );
    return result || null;
  } catch (error) {
    console.error("Get cached user error:", error);
    return null;
  }
};

// ==================== Attendance Operations ====================
export const saveCheckInLocal = async (
  employeeId: number,
  latitude: number,
  longitude: number,
  locationType: string
): Promise<boolean> => {
  const clientRef = generateUUID();
  const now = new Date().toISOString();
  const today = getJakartaDateString(new Date()); // YYYY-MM-DD in Jakarta Time

  if (isWeb) {
    // Check if already checked in today
    const alreadyCheckedInToday = webStorage.attendance.some(
      (a) => {
        if (!a.check_in) return false;
        return getJakartaDateString(new Date(a.check_in)) === today;
      }
    );
    if (alreadyCheckedInToday) {
      return false; // Already checked in today
    }
    webStorage.attendance.push({
      id: Date.now(),
      employee_id: employeeId,
      check_in: now,
      check_out: null,
      latitude,
      longitude,
      location_type: locationType,
      synced: 0,
      client_ref: clientRef,
    });
    saveAllToStorage();
    return true;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    // Fetch the latest check-in and compare dates using JS to avoid SQLite datetime support issues on some Androids
    const existing = await database.getFirstAsync<{ check_in: string }>(
      `SELECT check_in FROM attendance WHERE employee_id = ? ORDER BY check_in DESC LIMIT 1`,
      [employeeId]
    );
    if (existing && existing.check_in) {
      if (getJakartaDateString(new Date(existing.check_in)) === today) {
        return false; // Already checked in today
      }
    }
    await database.runAsync(
      `INSERT INTO attendance (employee_id, check_in, latitude, longitude, location_type, synced, client_ref)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [employeeId, now, latitude, longitude, locationType, clientRef]
    );
    return true;
  } catch (error) {
    console.error("Save check-in error:", error);
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
  const today = getJakartaDateString(new Date()); // YYYY-MM-DD in Jakarta Time

  if (isWeb) {
    // Check if already checked out today
    const alreadyCheckedOutToday = webStorage.attendance.some(
      (a) => {
        if (!a.check_out) return false;
        return getJakartaDateString(new Date(a.check_out)) === today;
      }
    );
    if (alreadyCheckedOutToday) {
      return false; // Already checked out today
    }
    const open = webStorage.attendance.find(
      (a) => a.employee_id === employeeId && !a.check_out
    );
    if (!open) return false;
    open.check_out = now;
    open.latitude = latitude;
    open.longitude = longitude;
    open.location_type = locationType;
    open.synced = 0;
    saveAllToStorage();
    return true;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    // Fetch the latest check-in/out to avoid SQLite datetime issues
    const lastRecord = await database.getFirstAsync<{ id: number, check_out: string | null }>(
      `SELECT id, check_out FROM attendance WHERE employee_id = ? ORDER BY check_in DESC LIMIT 1`,
      [employeeId]
    );
    
    if (!lastRecord || lastRecord.check_out) {
      return false; // No open check-in or already checked out
    }
    const result = await database.runAsync(
      `UPDATE attendance
       SET check_out = ?, latitude = ?, longitude = ?, location_type = ?, synced = 0
       WHERE id = ?`,
      [now, latitude, longitude, locationType, lastRecord.id]
    );
    return result.changes > 0;
  } catch (error) {
    console.error("Save check-out error:", error);
    return false;
  }
};

export const getUnsyncedAttendance = async (): Promise<AttendanceRecord[]> => {
  if (isWeb) {
    return webStorage.attendance
      .filter((a) => a.synced === 0)
      .map((row) => ({
        id: row.id,
        employee_id: row.employee_id,
        check_in: row.check_in,
        check_out: row.check_out,
        latitude: row.latitude,
        longitude: row.longitude,
        location_type: row.location_type,
        synced: false,
        client_ref: row.client_ref,
      }));
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const rows = await database.getAllAsync<WebAttendance>(
      'SELECT * FROM attendance WHERE synced = 0'
    );
    return rows.map((row) => ({
      id: row.id,
      employee_id: row.employee_id,
      check_in: row.check_in,
      check_out: row.check_out,
      latitude: row.latitude,
      longitude: row.longitude,
      location_type: row.location_type,
      synced: false,
      client_ref: row.client_ref,
    }));
  } catch (error) {
    console.error("Get unsynced error:", error);
    return [];
  }
};

export const markAttendanceSynced = async (clientRefs: string[]): Promise<void> => {
  if (clientRefs.length === 0) return;

  if (isWeb) {
    webStorage.attendance.forEach((a) => {
      if (clientRefs.includes(a.client_ref)) {
        a.synced = 1;
      }
    });
    saveAllToStorage();
    return;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const placeholders = clientRefs.map(() => '?').join(',');
    await database.runAsync(
      `UPDATE attendance SET synced = 1 WHERE client_ref IN (${placeholders})`,
      clientRefs
    );
  } catch (error) {
    console.error("Mark synced error:", error);
  }
};

export const getLocalAttendanceForUser = async (
  employeeId: number
): Promise<AttendanceRecord[]> => {
  if (isWeb) {
    const filtered = webStorage.attendance.filter((a) => a.employee_id === employeeId);

    // Deduplicate: keep only one record per day (earliest check-in with check-out)
    const byDate = new Map<string, typeof filtered>();
    filtered.forEach((record) => {
      if (!record.check_in) return;
      const date = record.check_in.split('T')[0];
      if (!byDate.has(date)) {
        byDate.set(date, []);
      }
      byDate.get(date)!.push(record);
    });

    const deduped: AttendanceRecord[] = [];
    byDate.forEach((records, date) => {
      // Keep the first record that has both check-in and check-out, or the earliest
      const withBoth = records.find(r => r.check_in && r.check_out);
      const toKeep = withBoth || records.sort((a, b) =>
        new Date(a.check_in || 0).getTime() - new Date(b.check_in || 0).getTime()
      )[0];

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
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const rows = await database.getAllAsync<WebAttendance>(
      'SELECT * FROM attendance WHERE employee_id = ? ORDER BY check_in DESC',
      [employeeId]
    );

    // Deduplicate by date (keep only one per day)
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
    console.error("Get local attendance error:", error);
    return [];
  }
};

// ==================== News Operations ====================
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
  if (isWeb) {
    webStorage.news.push({
      id: Date.now(),
      remote_id: news.remote_id,
      title: news.title,
      content: news.content,
      image_url: news.image_url,
      author_name: news.author_name,
      published_at: news.published_at,
      synced: 1,
    });
    saveAllToStorage();
    return;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    await database.runAsync(
      `INSERT OR REPLACE INTO news (remote_id, title, content, image_url, author_name, published_at, synced)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [news.remote_id || null, news.title, news.content, news.image_url || null, news.author_name || null, news.published_at || null]
    );
  } catch (error) {
    console.error("Save news error:", error);
  }
};

export const saveNewsLocalBatch = async (newsItems: NewsItem[]): Promise<void> => {
  if (isWeb) {
    webStorage.news = newsItems.map((item) => ({
      id: Date.now(),
      remote_id: item.remote_id,
      title: item.title,
      content: item.content,
      image_url: item.image_url,
      author_name: item.author_name,
      published_at: item.published_at,
      synced: 1,
    }));
    saveAllToStorage();
    return;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    for (const item of newsItems) {
      await database.runAsync(
        `INSERT OR REPLACE INTO news (remote_id, title, content, image_url, author_name, published_at, synced)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [item.remote_id || null, item.title, item.content, item.image_url || null, item.author_name || null, item.published_at || null]
      );
    }
  } catch (error) {
    console.error("Save news batch error:", error);
  }
};

export const getLocalNews = async (): Promise<NewsItem[]> => {
  if (isWeb) {
    return webStorage.news.map((row) => ({
      id: row.id,
      remote_id: row.remote_id ?? undefined,
      title: row.title,
      content: row.content,
      image_url: row.image_url ?? undefined,
      author_name: row.author_name ?? undefined,
      published_at: row.published_at ?? undefined,
      synced: row.synced === 1,
    }));
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const rows = await database.getAllAsync<WebNews>('SELECT * FROM news');
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
    console.error("Get local news error:", error);
    return [];
  }
};

// ==================== Server Config Operations ====================
export type ServerConfig = {
  key: string;
  value: string;
  updated_at?: string;
};

export const saveServerConfig = async (key: string, value: string): Promise<void> => {
  if (isWeb) {
    const existing = webStorage.serverConfig.find((c) => c.key === key);
    if (existing) {
      existing.value = value;
    } else {
      webStorage.serverConfig.push({ key, value });
    }
    saveAllToStorage();
    return;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    await database.runAsync(
      `INSERT OR REPLACE INTO server_config (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
      [key, value]
    );
  } catch (error) {
    console.error("Save server config error:", error);
  }
};

export const getServerConfig = async (key: string): Promise<string | null> => {
  if (isWeb) {
    const found = webStorage.serverConfig.find((c) => c.key === key);
    return found?.value ?? null;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    const result = await database.getFirstAsync<{ value: string }>(
      'SELECT value FROM server_config WHERE key = ?',
      [key]
    );
    return result?.value ?? null;
  } catch (error) {
    console.error("Get server config error:", error);
    return null;
  }
};

// ==================== Sync Log Operations ====================
export const insertSyncLog = async (
  attendanceClientRef: string,
  status: "success" | "failed",
  message: string
): Promise<void> => {
  if (isWeb) {
    console.log(`Sync log: ${attendanceClientRef} - ${status} - ${message}`);
    return;
  }

  try {
    await ensureDbInitialized();
    const database = getDatabase();
    await database.runAsync(
      `INSERT INTO sync_log (attendance_client_ref, status, message, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [attendanceClientRef, status, message]
    );
  } catch (error) {
    console.error("Insert sync log error:", error);
  }
};
