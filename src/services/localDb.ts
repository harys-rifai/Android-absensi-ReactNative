import { AttendanceRecord, EngineerUser } from "../types/attendance";

// Generate UUID v4
const generateUUID = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Web storage using localStorage for persistence
const loadFromStorage = (key: string) => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

const saveToStorage = (key: string, data: any) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('localStorage error:', e);
  }
};

// Web fallback storage
interface WebAttendance {
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

interface WebNews {
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

const webStorage: {
  employees: EngineerUser[];
  attendance: WebAttendance[];
  news: WebNews[];
  serverConfig: WebServerConfig[];
} = {
  employees: loadFromStorage('employees') || [],
  attendance: loadFromStorage('attendance') || [],
  news: loadFromStorage('news') || [],
  serverConfig: loadFromStorage('serverConfig') || [],
};

// Save to localStorage whenever webStorage changes
const saveAllToStorage = () => {
  saveToStorage('employees', webStorage.employees);
  saveToStorage('attendance', webStorage.attendance);
  saveToStorage('news', webStorage.news);
  saveToStorage('serverConfig', webStorage.serverConfig);
};

export const initializeLocalDb = async (): Promise<void> => {
  console.log("Web mode: using in-memory storage");
};

export const cacheSignedInUser = async (user: EngineerUser): Promise<void> => {
  webStorage.employees = [user];
  saveAllToStorage();
};

export const getLocalUser = async (email: string): Promise<EngineerUser | null> => {
  const user = webStorage.employees.find((u) => u.email === email);
  return user || null;
};

export const saveCheckInLocal = async (
  employeeId: number,
  latitude: number,
  longitude: number,
  locationType: string
): Promise<void> => {
  const clientRef = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  webStorage.attendance.push({
    id: Date.now(),
    employee_id: employeeId,
    check_in: new Date().toISOString(),
    check_out: null,
    latitude,
    longitude,
    location_type: locationType,
    synced: 0,
    client_ref: clientRef,
  });
  saveAllToStorage();
};

export const saveCheckOutLocal = async (
  employeeId: number,
  latitude: number,
  longitude: number,
  locationType: string
): Promise<boolean> => {
  const open = webStorage.attendance.find(
    (a) => a.employee_id === employeeId && !a.check_out
  );
  if (!open) return false;
  open.check_out = new Date().toISOString();
  open.latitude = latitude;
  open.longitude = longitude;
  open.location_type = locationType;
  open.synced = 0;
  saveAllToStorage();
  return true;
};

export const getUnsyncedAttendance = async (): Promise<AttendanceRecord[]> => {
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
};

export const markAttendanceSynced = async (clientRefs: string[]): Promise<void> => {
  if (clientRefs.length === 0) return;
  webStorage.attendance.forEach((a) => {
    if (clientRefs.includes(a.client_ref)) {
      a.synced = 1;
    }
  });
  saveAllToStorage();
};

export const insertSyncLog = async (
  attendanceClientRef: string,
  status: "success" | "failed",
  message: string
): Promise<void> => {
  console.log(`Sync log: ${attendanceClientRef} - ${status} - ${message}`);
};

export const getLocalAttendanceForUser = async (
  employeeId: number
): Promise<AttendanceRecord[]> => {
  return webStorage.attendance
    .filter((a) => a.employee_id === employeeId)
    .map((row) => ({
      id: row.id,
      employee_id: row.employee_id,
      check_in: row.check_in,
      check_out: row.check_out,
      latitude: row.latitude,
      longitude: row.longitude,
      location_type: row.location_type,
      synced: row.synced === 1,
      client_ref: row.client_ref,
    }))
    .sort(
      (a, b) =>
        new Date(b.check_in || b.check_out || 0).getTime() -
        new Date(a.check_in || a.check_out || 0).getTime()
    );
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
};

export const saveNewsLocalBatch = async (newsItems: NewsItem[]): Promise<void> => {
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
};

export const getLocalNews = async (): Promise<NewsItem[]> => {
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
};

export type ServerConfig = {
  key: string;
  value: string;
  updated_at?: string;
};

export const saveServerConfig = async (key: string, value: string): Promise<void> => {
  const existing = webStorage.serverConfig.find((c) => c.key === key);
  if (existing) {
    existing.value = value;
  } else {
    webStorage.serverConfig.push({ key, value });
  }
  saveAllToStorage();
};

export const getServerConfig = async (key: string): Promise<string | null> => {
  const found = webStorage.serverConfig.find((c) => c.key === key);
  return found?.value ?? null;
};
