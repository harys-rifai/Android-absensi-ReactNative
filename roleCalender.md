Role calendar


pembuatan calender di react native dengan utc+7 dan hari libur nasional dengan urutan hari di atas dan di ikuiti tanggal di bawah sesuai kalender nasional Legend:
Check-in = color
check-out = color 
Late = color
No Check-in = color
No Check-out = color
Red Text = Holiday

# 📅 Role Calendar (React Native)

## 🕒 Timezone
- Semua tanggal dan waktu menggunakan **UTC+7 (WIB)**.
- Sinkronisasi otomatis dengan perangkat pengguna.

## 📌 Format Tampilan
- **Hari** ditampilkan di baris atas (Senin, Selasa, dst).
- **Tanggal** ditampilkan di baris bawah sesuai kalender nasional Indonesia.
- **Hari Libur Nasional** ditampilkan dengan **teks merah**.

Contoh:

Senin   Selasa   Rabu   Kamis   Jumat   Sabtu   Minggu
1               2              3            4             5             6             7



## 🎨 Legend Status Absensi
- **Check-in** → 🟢 Hijau
- **Check-out** → 🔵 Biru
- **Late** → 🟡 Kuning
- **No Check-in** → 🟠 Oranye
- **No Check-out** → 🟣 Ungu
- **Holiday (Libur Nasional)** → 🔴 Teks Merah

## 📂 Struktur Data
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
  "color": "#FFD700" // Kuning untuk Late
}



🔄 Integrasi
* Backend API mengembalikan data absensi per tanggal.
* Frontend React Native menampilkan kalender dengan warna sesuai legend.
* Hari libur nasional diambil dari API Kemenaker atau file JSON lokal.
