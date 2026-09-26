// One-time data migration: loads the real production data exported from
// the old Claude-artifact database (seed-data.json, sitting next to this
// script) into the new Postgres `documents` table.
//
// Safe to re-run: every write is an upsert keyed by (collection, id), so
// running this twice just re-syncs the same rows rather than duplicating
// them.
//
// Usage (from the project root, with DATABASE_URL set):
//   node migrate/seed.js

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Run this with the same env Railway gives your app,');
    console.error('e.g.: railway run node migrate/seed.js');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  });

  // Make sure the schema exists even if this is run before the server's
  // first boot.
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(schemaSql);

  const seedPath = path.join(__dirname, 'seed-data.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  let total = 0;
  for (const [collection, docs] of Object.entries(seed)) {
    if (!Array.isArray(docs) || docs.length === 0) {
      console.log(`  ${collection}: 0 documents (skipped)`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const doc of docs) {
        await client.query(
          `INSERT INTO documents (collection, id, data, version, updated_at)
           VALUES ($1, $2, $3::jsonb, 1, now())
           ON CONFLICT (collection, id) DO UPDATE
             SET data = EXCLUDED.data, updated_at = now()`,
          [collection, doc.id, JSON.stringify(doc.data)]
        );
      }
      await client.query('COMMIT');
      console.log(`  ${collection}: ${docs.length} documents migrated`);
      total += docs.length;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  console.log(`\nDone. ${total} documents migrated in total.`);
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
