import { Platform } from "react-native";
import { AttendanceRecord, EngineerUser, UserRole } from "../types/attendance";

// Default server IP - otomatis menggunakan IP ini
const SERVER_IP = "192.168.1.21";
const SERVER_PORT = "4000";

// Default URL berdasarkan platform
const getDefaultUrl = (): string => {
  if (Platform.OS === "android") {
    // Coba gunakan IP server langsung untuk USB debugging
    return `http://${SERVER_IP}:${SERVER_PORT}`;
  }
  return "http://localhost:4000";
};

let API_BASE_URL = getDefaultUrl();

export const setApiBaseUrl = (url: string): void => {
  API_BASE_URL = url;
};

export const getApiBaseUrl = (): string => {
  return API_BASE_URL;
};

const defaultBaseUrl =
  Platform.OS === "android" ? "http://10.0.2.2:4000" : "http://localhost:4000";

type LoginPayload = {
  email: string;
  password: string;
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

export const loginUser = async (
  payload: LoginPayload
): Promise<EngineerUser> => {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error("Login gagal. Periksa email/password.");
  }

  return (await response.json()) as EngineerUser;
};

export const fetchAttendanceRecords = async (
  requesterId: number,
  role: UserRole
): Promise<AttendanceRecord[]> => {
  const response = await fetch(
    `${API_BASE_URL}/attendance?requesterId=${requesterId}&role=${role}`
  );
  if (!response.ok) {
    throw new Error("Gagal mengambil data absensi dari server.");
  }
  return (await response.json()) as AttendanceRecord[];
};

export const syncAttendanceRecords = async (
  records: AttendanceRecord[]
): Promise<string[]> => {
  const response = await fetch(`${API_BASE_URL}/sync/attendance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records }),
  });

  if (!response.ok) {
    throw new Error("Gagal sync absensi ke server.");
  }

  const result = (await response.json()) as { syncedClientRefs: string[] };
  return result.syncedClientRefs;
};

export const fetchNews = async (): Promise<NewsItem[]> => {
  const response = await fetch(`${API_BASE_URL}/news`);
  if (!response.ok) {
    throw new Error("Gagal mengambil berita dari server.");
  }
  return (await response.json()) as NewsItem[];
};

export const fetchServerConfig = async (key: string): Promise<string | null> => {
  try {
    const response = await fetch(`${API_BASE_URL}/config/${key}`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.value || null;
  } catch {
    return null;
  }
};

export const saveServerConfigRemote = async (key: string, value: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!response.ok) {
    throw new Error("Gagal menyimpan konfigurasi server.");
  }
};
