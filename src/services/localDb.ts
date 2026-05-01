import * as SQLite from "expo-sqlite";
import { AttendanceRecord, EngineerUser } from "../types/attendance";

const dbPromise = SQLite.openDatabaseAsync("local_attendance.db");

const toBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  return Number(value) === 1;
};

export const initializeLocalDb = async (): Promise<void> => {
  const db = await dbPromise;
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS employee (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      password_hash TEXT
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
      client_ref TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendance_client_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_id INTEGER UNIQUE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      image_url TEXT,
      author_name TEXT,
      published_at TEXT,
      synced INTEGER DEFAULT 0
    );
  `);
};

export const cacheSignedInUser = async (user: EngineerUser): Promise<void> => {
  const db = await dbPromise;
  await db.runAsync(
    `INSERT INTO employee (id, name, email, role, password_hash)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       email = excluded.email,
       role = excluded.role`,
    [user.id, user.name, user.email, user.role]
  );
};

export const saveCheckInLocal = async (
  employeeId: number,
  latitude: number,
  longitude: number,
  locationType: string
): Promise<void> => {
  const db = await dbPromise;
  await db.runAsync(
    `INSERT INTO attendance (
       employee_id, check_in, check_out, latitude, longitude, location_type, synced, client_ref
     ) VALUES (
       ?, datetime('now'), NULL, ?, ?, ?, 0, ?
     )`,
    [employeeId, latitude, longitude, locationType, `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`]
  );
};

export const saveCheckOutLocal = async (
  employeeId: number,
  latitude: number,
  longitude: number,
  locationType: string
): Promise<boolean> => {
  const db = await dbPromise;
  const open = await db.getFirstAsync<{ id: number }>(
    `SELECT id FROM attendance
     WHERE employee_id = ? AND check_in IS NOT NULL AND check_out IS NULL
     ORDER BY id DESC LIMIT 1`,
    [employeeId]
  );

  if (!open) {
    return false;
  }

  await db.runAsync(
    `UPDATE attendance
     SET check_out = datetime('now'),
         latitude = ?,
         longitude = ?,
         location_type = ?,
         synced = 0
     WHERE id = ?`,
    [latitude, longitude, locationType, open.id]
  );
  return true;
};

export const getUnsyncedAttendance = async (): Promise<AttendanceRecord[]> => {
  const db = await dbPromise;
  const rows = await db.getAllAsync<{
    id: number;
    employee_id: number;
    check_in: string | null;
    check_out: string | null;
    latitude: number | null;
    longitude: number | null;
    location_type: string | null;
    synced: number;
    client_ref: string;
  }>(`SELECT * FROM attendance WHERE synced = 0 ORDER BY id ASC`);

  return rows.map((row) => ({
    id: row.id,
    employee_id: row.employee_id,
    check_in: row.check_in,
    check_out: row.check_out,
    latitude: row.latitude,
    longitude: row.longitude,
    location_type: row.location_type,
    synced: toBoolean(row.synced),
    client_ref: row.client_ref,
  }));
};

export const markAttendanceSynced = async (
  clientRefs: string[]
): Promise<void> => {
  if (clientRefs.length === 0) {
    return;
  }
  const db = await dbPromise;
  const placeholders = clientRefs.map(() => "?").join(",");
  await db.runAsync(
    `UPDATE attendance SET synced = 1 WHERE client_ref IN (${placeholders})`,
    clientRefs
  );
};

export const insertSyncLog = async (
  attendanceClientRef: string,
  status: "success" | "failed",
  message: string
): Promise<void> => {
  const db = await dbPromise;
  await db.runAsync(
    `INSERT INTO sync_log (attendance_client_ref, status, message)
     VALUES (?, ?, ?)`,
    [attendanceClientRef, status, message]
  );
};

export const getLocalAttendanceForUser = async (
  employeeId: number
): Promise<AttendanceRecord[]> => {
  const db = await dbPromise;
  const rows = await db.getAllAsync<{
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
    `SELECT *
     FROM attendance
     WHERE employee_id = ?
     ORDER BY COALESCE(check_in, check_out) DESC`,
    [employeeId]
  );

  return rows.map((row) => ({
    id: row.id,
    employee_id: row.employee_id,
    check_in: row.check_in,
    check_out: row.check_out,
    latitude: row.latitude,
    longitude: row.longitude,
    location_type: row.location_type,
    synced: toBoolean(row.synced),
    client_ref: row.client_ref,
  }));
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
  const db = await dbPromise;
  await db.runAsync(
    `INSERT OR REPLACE INTO news (remote_id, title, content, image_url, author_name, published_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [news.remote_id || null, news.title, news.content, news.image_url || null, news.author_name || null, news.published_at || null]
  );
};

export const saveNewsLocalBatch = async (newsItems: NewsItem[]): Promise<void> => {
  const db = await dbPromise;
  for (const news of newsItems) {
    await db.runAsync(
      `INSERT OR REPLACE INTO news (remote_id, title, content, image_url, author_name, published_at, synced)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [news.remote_id || null, news.title, news.content, news.image_url || null, news.author_name || null, news.published_at || null]
    );
  }
};

export const getLocalNews = async (): Promise<NewsItem[]> => {
  const db = await dbPromise;
  const rows = await db.getAllAsync<{
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
    synced: toBoolean(row.synced),
  }));
};
