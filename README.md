# Hybrid Attendance (Postgres + SQLite)

Starter app absensi engineer dengan arsitektur hybrid: Postgres sebagai sumber utama dan SQLite sebagai cache offline.

## Fitur

- Login via Postgres (`employee`)
- Data user login disimpan manual ke SQLite
- Check-in/check-out disimpan dulu ke SQLite (`synced=0`)
- Auto-sync setiap 15 menit ke Postgres
- Jika sync sukses: SQLite diupdate `synced=1` lalu stop
- Sync log tersimpan di SQLite (`sync_log`)
- Role support: `user`, `manager_line`, `hrd`

## Dependencies utama

- `expo-location` untuk akses GPS
- `expo-sqlite` untuk cache lokal offline
- `express`, `pg`, `cors`, `dotenv` untuk API + PostgreSQL

## Konfigurasi database

Kredensial PostgreSQL default pada `server/.env`:

- DB: `apsensi_db`
- User: `postgres`
- Password: `Password09`
- Port: `5432`

Inisialisasi tabel:

```bash
npm run db:init
```

Jalankan API:

```bash
npm run api
```

## Menjalankan project

```bash
npm install
npm run db:init
npm run api
# terminal lain:
npm run ios
# atau
npm run android
# atau
npm run web
```

## Struktur file

- `App.tsx` - flow login, check-in/out, auto-sync 15 menit
- `src/constants/sites.ts` - daftar site project dan radius
- `src/utils/geofence.ts` - util hitung jarak haversine
- `src/services/attendanceApi.ts` - koneksi API absensi
- `src/services/localDb.ts` - SQLite schema, cache login, sync log
- `src/types/attendance.ts` - type model absensi
- `server/server.js` - REST API absensi
- `server/init.sql` - schema tabel PostgreSQL
- `server/db.js` - koneksi database

## Endpoint API

- `POST /auth/login`
- `GET /attendance?requesterId=<id>&role=<role>`
- `POST /sync/attendance`
- `GET /attendance/export?role=hrd`

## Demo account (seed otomatis)

- `user@apsensi.local` / `Password09`
- `manager@apsensi.local` / `Password09`
- `hrd@apsensi.local` / `Password09`

## Catatan produksi

- Ganti autentikasi md5 demo ini ke hash kuat (bcrypt/argon2 + JWT)
- Tambahkan anti-spoofing (mock location detection)
- Pertimbangkan upload selfie untuk bukti kehadiran
- Untuk device fisik, set `EXPO_PUBLIC_API_BASE_URL` ke IP laptop, contoh: `http://192.168.1.10:4000`
