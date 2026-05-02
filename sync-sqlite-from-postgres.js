// Script to reset SQLite and copy data from PostgreSQL
// Run with: node sync-sqlite-from-postgres.js

const { Pool } = require('pg');
const SQLite = require('better-sqlite3');
const path = require('path');

// PostgreSQL connection
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'apsensi_db',
  user: 'postgres',
  password: 'Password09'
});

// SQLite database path (for native app)
const sqlitePath = path.join(__dirname, "local_attendance.db");
const webSqlitePath = path.join(__dirname, "apsensi.db");

async function syncDatabase() {
  try {
    console.log('🔄 Starting sync from PostgreSQL to SQLite...\n');

    // Remove old SQLite databases
    const fs = require('fs');
    [sqlitePath, webSqlitePath].forEach(dbPath => {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        console.log(`✓ Removed old database: ${dbPath}`);
      }
    });

    // Create new SQLite database (for native)
    console.log('\n📱 Creating new SQLite database for native app...');
    const db = new SQLite(sqlitePath);

    // Create tables
    db.exec('PRAGMA journal_mode = DELETE;');
    db.exec('PRAGMA foreign_keys = ON;');

    db.exec("CREATE TABLE IF NOT EXISTS employee (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, role TEXT NOT NULL, password_hash TEXT, foto TEXT, flag TEXT DEFAULT 'active', active INTEGER DEFAULT 1, phone TEXT, jabatan TEXT, remark TEXT, datejoin TEXT, dateleft TEXT)");

    db.exec("CREATE TABLE IF NOT EXISTS attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, check_in TEXT, check_out TEXT, latitude REAL, longitude REAL, location_type TEXT, synced INTEGER DEFAULT 1, client_ref TEXT UNIQUE, FOREIGN KEY (employee_id) REFERENCES employee(id))");

    db.exec("CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, attendance_client_ref TEXT NOT NULL, status TEXT NOT NULL, message TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");

    db.exec("CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY AUTOINCREMENT, remote_id INTEGER UNIQUE, title TEXT NOT NULL, content TEXT NOT NULL, image_url TEXT, author_name TEXT, published_at TEXT, synced INTEGER DEFAULT 1)");

    db.exec("CREATE TABLE IF NOT EXISTS server_config (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");

    // Fetch data from PostgreSQL
    console.log('📥 Fetching data from PostgreSQL...');

    // Copy employees
    const employees = await pool.query('SELECT * FROM employee');
    console.log(`  Found ${employees.rows.length} employees`);

    const insertEmployee = db.prepare(`
      INSERT OR REPLACE INTO employee (id, name, email, role, password_hash, foto, flag, active, phone, jabatan, remark, datejoin, dateleft)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const emp of employees.rows) {
      insertEmployee.run(
        emp.id,
        emp.name,
        emp.email,
        emp.role,
        emp.password_hash || null,
        emp.foto || null,
        emp.flag || 'active',
        emp.active === true || emp.active === 't' ? 1 : 0,
        emp.phone || null,
        emp.jabatan || null,
        emp.remark || null,
        emp.datejoin ? String(emp.datejoin) : null,
        emp.dateleft ? String(emp.dateleft) : null
      );
    }
    console.log(`  ✓ Copied ${employees.rows.length} employees`);

    // Copy attendance (deduplicated - one per day per employee)
    const attendance = await pool.query(`
      WITH ranked AS (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY employee_id, DATE(check_in AT TIME ZONE 'Asia/Jakarta') ORDER BY check_in ASC) as rn
        FROM attendance
        WHERE check_in IS NOT NULL
      )
      SELECT * FROM ranked WHERE rn = 1
      ORDER BY check_in DESC
    `);
    console.log(`  Found ${attendance.rows.length} attendance records (deduplicated)`);

    const insertAttendance = db.prepare(`
      INSERT OR REPLACE INTO attendance (id, employee_id, check_in, check_out, latitude, longitude, location_type, synced, client_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);

    for (const att of attendance.rows) {
      const checkInJakarta = att.check_in ? new Date(att.check_in).toISOString() : null;
      const checkOutJakarta = att.check_out ? new Date(att.check_out).toISOString() : null;

      insertAttendance.run(
        att.id,
        att.employee_id,
        checkInJakarta,
        checkOutJakarta,
        att.latitude,
        att.longitude,
        att.location_type,
        att.client_ref || null
      );
    }
    console.log(`  ✓ Copied ${attendance.rows.length} attendance records`);

    // Copy news
    const news = await pool.query('SELECT * FROM news ORDER BY published_at DESC');
    console.log(`  Found ${news.rows.length} news articles`);

    const insertNews = db.prepare(`
      INSERT OR REPLACE INTO news (remote_id, title, content, image_url, author_name, published_at, synced)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);

    for (const n of news.rows) {
      insertNews.run(
        n.id,
        n.title,
        n.content,
        n.image_url,
        n.author_name || null,
        n.published_at ? new Date(n.published_at).toISOString() : null
      );
    }
    console.log(`  ✓ Copied ${news.rows.length} news articles`);

    // Copy server config
    const config = await pool.query('SELECT * FROM server_config');
    console.log(`  Found ${config.rows.length} config entries`);

    const insertConfig = db.prepare(`
      INSERT OR REPLACE INTO server_config (key, value, updated_at)
      VALUES (?, ?, ?)
    `);

    for (const c of config.rows) {
      insertConfig.run(c.key, c.value, c.updated_at ? new Date(c.updated_at).toISOString() : null);
    }
    console.log(`  ✓ Copied ${config.rows.length} config entries`);

    db.close();

    // Also create web SQLite database
    console.log('\n🌐 Creating SQLite database for web app...');
    const webDb = new SQLite(webSqlitePath);

    webDb.exec('PRAGMA journal_mode = WAL;');
    webDb.exec('PRAGMA foreign_keys = ON;');

    webDb.exec("CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, site_id INTEGER, foto TEXT, flag TEXT DEFAULT 'active', active INTEGER DEFAULT 1, phone TEXT, jabatan TEXT, remark TEXT, datejoin TEXT, dateleft TEXT, password TEXT)");

    webDb.exec("CREATE TABLE IF NOT EXISTS attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, check_in TEXT, check_out TEXT, latitude REAL, longitude REAL, location_type TEXT, synced INTEGER DEFAULT 1, client_ref TEXT UNIQUE)");

    webDb.exec("CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY AUTOINCREMENT, remote_id INTEGER, title TEXT NOT NULL, content TEXT NOT NULL, image_url TEXT, author_name TEXT, published_at TEXT, synced INTEGER DEFAULT 1)");

    webDb.exec("CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");

    webDb.exec("CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, attendance_client_ref TEXT, status TEXT, message TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");

    // Copy data to web database
    const webInsertEmployee = webDb.prepare(`
      INSERT OR REPLACE INTO employees (id, email, name, role, site_id, foto, flag, active, phone, jabatan, remark, datejoin, dateleft, password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);

    for (const emp of employees.rows) {
      webInsertEmployee.run(
        emp.id,
        emp.email,
        emp.name,
        emp.role,
        emp.site_id || null,
        emp.foto || null,
        emp.flag || 'active',
        emp.active === true || emp.active === 't' ? 1 : 0,
        emp.phone || null,
        emp.jabatan || null,
        emp.remark || null,
        emp.datejoin ? String(emp.datejoin) : null,
        emp.dateleft ? String(emp.dateleft) : null
      );
    }

    const webInsertAttendance = webDb.prepare(`
      INSERT OR REPLACE INTO attendance (id, employee_id, check_in, check_out, latitude, longitude, location_type, synced, client_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);

    for (const att of attendance.rows) {
      const checkInJakarta = att.check_in ? new Date(att.check_in).toISOString() : null;
      const checkOutJakarta = att.check_out ? new Date(att.check_out).toISOString() : null;

      webInsertAttendance.run(
        att.id,
        att.employee_id,
        checkInJakarta,
        checkOutJakarta,
        att.latitude,
        att.longitude,
        att.location_type,
        att.client_ref || null
      );
    }

    webDb.close();

    console.log('\n✅ Sync complete!');
    console.log(`  - Native SQLite: ${sqlitePath}`);
    console.log(`  - Web SQLite: ${webSqlitePath}`);
    console.log('\n📊 Summary:');
    console.log(`  - Employees: ${employees.rows.length}`);
    console.log(`  - Attendance (deduplicated): ${attendance.rows.length}`);
    console.log(`  - News: ${news.rows.length}`);
    console.log(`  - Config: ${config.rows.length}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await pool.end();
  }
}

syncDatabase();
