import { Platform } from "react-native";
import { AttendanceRecord, EngineerUser, UserRole } from "../types/attendance";

const defaultBaseUrl =
  Platform.OS === "android" ? "http://10.0.2.2:4000" : "http://localhost:4000";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || defaultBaseUrl;

type LoginPayload = {
  email: string;
  password: string;
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
