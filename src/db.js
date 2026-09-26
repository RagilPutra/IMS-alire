const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Add a Postgres database to this Railway project.');
  process.exit(1);
}

// Railway's internal Postgres connection does not require SSL, but a lot of
// managed Postgres providers do and refuse a plain connection -- accept
// either by disabling certificate verification rather than requiring it.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, ensureSchema };
