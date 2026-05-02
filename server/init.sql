CREATE TABLE IF NOT EXISTS project_sites (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  radius_meters INT DEFAULT 150
);

INSERT INTO project_sites (id, name, latitude, longitude, radius_meters) VALUES
  ('jkt-hq', 'Jakarta HQ', -6.2001, 106.8167, 150),
  ('bdg-plant', 'Bandung Plant', -6.9147, 107.6098, 200),
  ('sby-field', 'Surabaya Field Office', -7.2575, 112.7521, 200)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS employee (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user','manager_line','hrd','admin')),
  password_hash TEXT NOT NULL,
  site_id VARCHAR(50) REFERENCES project_sites(id),
  foto TEXT,
  flag VARCHAR(20) DEFAULT 'active',
  active BOOLEAN DEFAULT TRUE,
  phone VARCHAR(20),
  jabatan VARCHAR(100),
  remark TEXT,
  datejoin DATE,
  dateleft DATE
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employee(id),
  check_in TIMESTAMPTZ,
  check_out TIMESTAMPTZ,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  location_type VARCHAR(20),
  synced BOOLEAN DEFAULT FALSE,
  client_ref TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS leave_request (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employee(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  leave_type VARCHAR(20) NOT NULL DEFAULT 'annual',
  status VARCHAR(20) NOT NULL DEFAULT 'pending_manager',
  note TEXT,
  manager_approved_by INT REFERENCES employee(id),
  manager_approved_at TIMESTAMPTZ,
  hrd_approved_by INT REFERENCES employee(id),
  hrd_approved_at TIMESTAMPTZ,
  manager_remark TEXT,
  hrd_remark TEXT
);

CREATE TABLE IF NOT EXISTS overtime_request (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employee(id),
  overtime_date DATE NOT NULL,
  hours NUMERIC(5,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO employee (name, email, role, password_hash)
VALUES
  ('Field Engineer', 'user@apsensi.local', 'user', md5('Password09')),
  ('Line Manager', 'manager@apsensi.local', 'manager_line', md5('Password09')),
  ('HR Admin', 'hrd@apsensi.local', 'hrd', md5('Password09')),
  ('Harys Admin', 'harys@google.com', 'hrd', md5('xcxcxc'))
ON CONFLICT (email) DO NOTHING;

INSERT INTO leave_request (employee_id, start_date, end_date, leave_type, status, note)
SELECT e.id, CURRENT_DATE - INTERVAL '7 day', CURRENT_DATE - INTERVAL '6 day', 'annual', 'approved', 'Family event'
FROM employee e
WHERE e.email = 'user@apsensi.local'
  AND NOT EXISTS (
    SELECT 1
    FROM leave_request l
    WHERE l.employee_id = e.id
      AND l.start_date = CURRENT_DATE - INTERVAL '7 day'
      AND l.end_date = CURRENT_DATE - INTERVAL '6 day'
  );

CREATE TABLE IF NOT EXISTS news (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  image_url TEXT,
  author_id INT REFERENCES employee(id),
  published_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

INSERT INTO news (title, content, author_id)
SELECT 'Selamat Datang di Aplikasi Absensi', 'Aplikasi ini memungkinkan Anda untuk melakukan absensi dengan sistem hybrid SQLite dan PostgreSQL.', e.id
FROM employee e
WHERE e.email = 'hrd@apsensi.local'
  AND NOT EXISTS (SELECT 1 FROM news WHERE title = 'Selamat Datang di Aplikasi Absensi')
LIMIT 1;

INSERT INTO news (title, content, author_id)
SELECT 'Cara Menggunakan Fitur Absensi', '1. Buka aplikasi\n2. Pilih site project\n3. Tekan tombol Check-in\n4. Pastikan GPS aktif\n5. Tunggu notifikasi sukses', e.id
FROM employee e
WHERE e.email = 'hrd@apsensi.local'
  AND NOT EXISTS (SELECT 1 FROM news WHERE title = 'Cara Menggunakan Fitur Absensi')
LIMIT 1;

CREATE TABLE IF NOT EXISTS server_config (
  id SERIAL PRIMARY KEY,
  key VARCHAR(50) UNIQUE NOT NULL,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO server_config (key, value)
SELECT 'api_base_url', 'http://192.168.1.21:4000'
WHERE NOT EXISTS (SELECT 1 FROM server_config WHERE key = 'api_base_url');
