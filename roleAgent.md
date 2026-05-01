Offline & Online Sync Flow
1. App Start / Init
* Buat database lokal SQLite di perangkat.
* Simpan semua config (user, role, absensi, setting).
* Gunakan kredensial default:
    * User: [NEON_USER]
    * Password: Password09

2. Default Mode (Offline-first)
* Semua query dibaca dari SQLite.
* Jika tidak ada koneksi:
    * Data user, config, absensi, dan temp data tetap disimpan di SQLite.
    * Postgres tidak diakses langsung.
* SQLite berfungsi sebagai cache + storage sementara.

3. Sync Job (Online Mode)
* Saat koneksi tersedia:
    * Jalankan sync service → kirim data baru dari SQLite ke Postgres.
    * Postgres tetap menjadi master database.
    * Koneksi utama:
        * Host: localhost
        * Port: 5432
        * DB: apsensi_db
        * User: postgres
        * Password: Password09

4. Postgres → Neon Backup
* Postgres akan melakukan replication/backup ke Neon:
    * Host: [NEON_HOST]
    * DB: apsensi_db
    * User: [NEON_USER]
    * Password: [NEON_PASSWORD]
    * Port: 5432

5. Sync Flow Detail
1. Ambil data dari SQLite dengan flag synced=0.
2. Push ke Postgres via API.
3. Jika sukses → update flag synced=1 di SQLite.
4. Buat log absensi hanya untuk user yang sign in.
5. Sinkronisasi dilakukan periodik (misalnya setiap 1 menit dengan cron job / background worker).

🔹 Catatan Teknis
* SQLite hanya cache → jangan dipakai untuk audit final.
* Postgres master → semua validasi & compliance tetap di sini.
* Neon backup → redundancy & disaster recovery.
* API layer → wajib ada untuk komunikasi aman (jangan direct DB connect dari mobile).
