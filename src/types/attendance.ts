export type UserRole = "user" | "manager_line" | "hrd" | "admin";

export type EngineerUser = {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  site_id?: string;
  line_manager_id?: number;
  foto?: string;
  flag?: string;
  active?: boolean;
  phone?: string;
  jabatan?: string;
  remark?: string;
  datejoin?: string;
  dateleft?: string;
};

export type Site = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

export type AttendanceRecord = {
  id?: number;
  employee_id: number;
  employee_name?: string;
  employee_role?: UserRole;
  check_in: string | null;
  check_out: string | null;
  latitude: number | null;
  longitude: number | null;
  location_type: string | null;
  synced: boolean;
  client_ref: string;
};

export type SyncLog = {
  id?: number;
  attendance_client_ref: string;
  status: "success" | "failed";
  message: string;
  created_at?: string;
};
