# Role Plan - Hybrid Attendance App

## 📋 Overview
Aplikasi absensi hybrid menggunakan React Native dengan Expo, SQLite local database, dan PostgreSQL remote database dengan fitur auto-sync. Dilengkapi dengan UI iPhone-style dan validasi GPS yang lebih baik.

---

## 🏗️ Architecture Plan

### System Design
```
┌─────────────────┐
│  React Native  │
│   (Expo App)   │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐ ┌─▼─────┐
│ SQLite │ │ API    │
│ (Local)│ │ Server │
└────────┘ └──┬────┘
                 │
            ┌────▼────┐
            │PostgreSQL│
            │ (Remote) │
            └─────────┘
```

### Database Strategy
- **SQLite (Local)**: Cache + offline storage, temp data
- **PostgreSQL (Master)**: All validation & compliance, master database
- **Neon (Backup)**: Redundancy & disaster recovery

---

## 👥 User Roles & Access

### Role Hierarchy
1. **User** - Employee with basic attendance features
2. **Manager (manager_line)** - Can approve leave requests (pending_manager)
3. **HRD** - Full access: statistics, approvals (pending_hrd → approved)
4. **Admin** - System administration

### Demo Accounts
| Email | Password | Role |
|-------|----------|------|
| user@apsensi.local | Password09 | user |
| manager@apsensi.local | Password09 | manager_line |
| hrd@apsensi.local | Password09 | hrd |
| harys@google.com | xcxcxc | hrd |

---

## 🔄 Sync Flow Plan

### Offline & Online Sync Flow

#### 1. App Start / Init
- Buat database lokal SQLite di perangkat
- Simpan semua config (user, role, absensi, setting)
- Default credentials:
  - User: [NEON_USER]
  - Password: Password09

#### 2. Default Mode (Offline-first)
- Semua query dibaca dari SQLite
- Jika tidak ada koneksi:
  - Data user, config, absensi, dan temp data tetap disimpan di SQLite
  - Postgres tidak diakses langsung
- SQLite berfungsi sebagai cache + storage sementara

#### 3. Sync Job (Online Mode)
- Saat koneksi tersedia:
  - Jalankan sync service → kirim data baru dari SQLite ke Postgres
  - Postgres tetap menjadi master database
  - Koneksi utama:
    - Host: localhost
    - Port: 5432
    - DB: apsensi_db
    - User: postgres
    - Password: Password09

#### 4. Postgres → Neon Backup
- Postgres replication/backup ke Neon:
  - Host: [NEON_HOST]
  - DB: apsensi_db
  - User: [NEON_USER]
  - Password: [NEON_PASSWORD]
  - Port: 5432

#### 5. Sync Flow Detail
1. Ambil data dari SQLite dengan flag synced=0
2. Push ke Postgres via API
3. Jika sukses → update flag synced=1 di SQLite
4. Buat log absensi hanya untuk user yang sign in
5. Sinkronisasi periodik (setiap 1 menit dengan background worker)

**Catatan Teknis:**
- SQLite hanya cache → jangan dipakai untuk audit final
- Postgres master → semua validasi & compliance tetap di sini
- Neon backup → redundancy & disaster recovery
- API layer → wajib ada untuk komunikasi aman

---

## 📅 Calendar Feature Plan

### Timezone & Display
- **UTC+7 (WIB)** untuk semua tanggal dan waktu
- Sinkronisasi otomatis dengan perangkat pengguna
- **Hari** ditampilkan di baris atas (Senin, Selasa, dst)
- **Tanggal** di baris bawah sesuai kalender nasional Indonesia
- **Hari Libur Nasional** dengan teks merah

### Attendance Status Legend
- **Check-in** → 🟢 Hijau
- **Check-out** → 🔵 Biru
- **Late** → 🟡 Kuning
- **No Check-in** → 🟠 Oranye
- **No Check-out** → 🟣 Ungu
- **Holiday (Libur Nasional)** → 🔴 Teks Merah

### Data Structure
```json
{
  "date": "2026-05-02",
  "day": "Sabtu",
  "holiday": true,
  "attendance": {
    "check_in": "08:15",
    "check_out": "17:00",
    "status": "Late"
  },
  "color": "#FFD700"
}
```

### Integration
- Backend API mengembalikan data absensi per tanggal
- Frontend React Native menampilkan kalender dengan warna sesuai legend
- Hari libur nasional dari API Kemenaker atau file JSON lokal

---

## 🗄️ Database Structure

### PostgreSQL (Remote - Master)
```sql
- employee (id, name, email, role, password_hash)
- attendance (id, employee_id, check_in, check_out, latitude, longitude, location_type, synced, client_ref)
- leave_request (id, employee_id, start_date, end_date, leave_type, status, note, manager_approved_by, manager_approved_at, hrd_approved_by, hrd_approved_at)
- overtime_request (id, employee_id, overtime_date, hours, status, note, created_at)
- news (id, title, content, image_url, author_id, published_at, is_active)
- server_config (id, key, value, updated_at)
```

### SQLite (Local - Cache)
```sql
- employee (id, name, email, role, password_hash)
- attendance (id, employee_id, check_in, check_out, latitude, longitude, location_type, synced, client_ref)
- sync_log (id, attendance_client_ref, status, message, created_at)
- news (id, remote_id, title, content, image_url, author_name, published_at, synced)
- server_config (id, key, value, updated_at)
```

---

## 🌐 API Endpoints Plan

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | API info |
| `/health` | GET | Health check |
| `/auth/login` | POST | User login |
| `/attendance` | GET | Get attendance records |
| `/attendance/check-in` | POST | Check-in (GPS validation) |
| `/attendance/check-out` | POST | Check-out (GPS validation) |
| `/attendance/late` | GET | Get late attendance |
| `/leave` | GET | Get leave requests |
| `/leave/request` | POST | Submit leave request |
| `/leave/approve-manager/:id` | POST | Manager approval |
| `/leave/approve-hrd/:id` | POST | HRD approval |
| `/overtime` | GET | Get overtime requests |
| `/overtime/request` | POST | Submit overtime request |
| `/dashboard` | GET | Dashboard summary (HRD) |
| `/sync/attendance` | POST | Sync local to remote |
| `/news` | GET | Get news list |
| `/news/create` | POST | Create new news |
| `/attendance/export` | GET | Export to CSV (HRD) |

---

## 🎨 UI/UX Plan

### iPhone-Style Design
- **SF Pro Font** - Native iOS font family
- **iOS Colors** - #007AFF primary, #8e8e93 secondary, #f2f2f7 background
- **Card Shadows** - Proper elevation and blur effects
- **Calendar View** - Monthly calendar with attendance status dots
- **Tab Navigation** - Bottom tab bar with icons

### Screens
1. **Login Screen** - iPhone-style login with validation
2. **Attendance Screen** - Check-in/out with GPS validation & site selection
3. **Calendar History** - Monthly view with attendance status dots
4. **Dashboard HRD** - Statistics cards (Total, Late, Leave, Overtime)
5. **Settings** - Server connection configuration

---

## 🔧 Key Features Implementation

### GPS & Attendance
- **GPS Timeout & Accuracy Validation** - 30s timeout, rejects accuracy >100m
- **Server-side GPS Validation** - Haversine formula validates location server-side
- **Duplicate Check-in Prevention** - Backend blocks multiple active check-ins
- **UUID Generation** - Proper unique IDs instead of Math.random()

### Offline-First
- Aplikasi tetap berjalan tanpa koneksi internet
- Auto-Sync setiap 15 menit
- Data disimpan di SQLite untuk mode offline

### Geofencing
- Validasi lokasi absensi berdasarkan radius site (server & client)
- Project Sites: Jakarta HQ, Bandung Plant, Surabaya Field Office

### News Feature
- News ditampilkan di beranda aplikasi
- Auto-sync setiap 15 menit
- HRD dapat menambah news via API

### Leave & Overtime Workflow
- **Leave Approval**: pending_manager → pending_hrd → approved
- **Role-based Access** untuk approval workflow
- Overtime request submission & approval

---

## 📱 Deployment Plan

### Android
- USB Debugging support via ADB
- ADB Reverse untuk localhost access: `adb reverse tcp:4000 tcp:4000`
- IP Address configuration untuk network access
- Build APK: `eas build --platform android`

### Server Connection Settings
- Default: `http://10.0.2.2:4000` (Android Emulator) atau `http://localhost:4000` (Web)
- Custom URL via Settings screen
- Disimpan di SQLite, auto-load saat aplikasi dibuka

---

## 🐛 Troubleshooting Plan

### Common Issues
1. **Android Network Request Failed** - Gunakan ADB Reverse atau IP Address
2. **GPS Timeout/Low Accuracy** - Pastikan GPS aktif, coba di area terbuka
3. **Server tidak bisa diakses** - Cek `curl http://localhost:4000/health`

### Debug Commands
```bash
# Check server status
curl http://localhost:4000/health

# Check port usage
lsof -i :4000

# Kill process if needed
kill -9 $(lsof -ti :4000)

# ADB Reverse for Android
adb reverse tcp:4000 tcp:4000
```

---

## 📦 Development Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start Expo development server |
| `npm run android` | Run on Android device/emulator |
| `npm run ios` | Run on iOS simulator |
| `npm run web` | Run on web browser |
| `npm run api` | Start API server |
| `npm run db:init` | Initialize PostgreSQL database |
| `./run-app.sh` | Interactive launcher (API + Expo) |

---

## 🚀 Future Enhancements

1. **Biometric Authentication** - Fingerprint/Face ID for check-in
2. **Push Notifications** - Reminder for check-in/out
3. **Advanced Reports** - PDF export, detailed analytics
4. **Multi-language Support** - Indonesian & English
5. **Dark Mode** - iOS-style dark mode support
6. **Real-time Sync** - WebSocket for instant updates
7. **Geofencing Alerts** - Notification when entering/leaving site

---

## 📝 License
MIT License

## 📞 Contact
Harys Rifai - harysrifai@gmail.com

Project Link: https://github.com/harysrifai/Android-absensi-ReactNative
