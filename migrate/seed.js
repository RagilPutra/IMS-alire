// Data migration: loads the deduplicated master data + Stock Opname
// Agustus 2026 export (seed-data.json, sitting next to this script) into
// the Postgres `documents` table.
//
// This is a REPLACE for the "operational" collections (items, stock,
// transactions, opnameSessions, opnameDetails, opnameDrafts): each one is
// fully cleared and reloaded from seed-data.json, because seed-data.json
// is itself a deduplicated rebuild of the master data -- some old item
// ids no longer exist post-dedup, and a plain upsert would leave those
// orphaned rows behind alongside the new ones, recreating the exact
// duplicate problem this migration fixes. If a collection's array in
// seed-data.json is empty (transactions, opnameDrafts), the collection is
// still cleared, just left empty afterwards.
//
// suppliers and users are NEVER cleared -- only upserted -- so your
// supplier list and any custom logins you created stay untouched.
//
// Safe to re-run: it always ends at the same state (the content of
// seed-data.json), whether run once or many times.
//
// Usage (from the project root, with DATABASE_URL set):
//   node migrate/seed.js

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Collections that are fully replaced on every run (cleared, then
// reloaded from seed-data.json). Keep this in sync with the artifact-side
// migration's deletion scope.
const REPLACE_COLLECTIONS = new Set([
  'items', 'stock', 'transactions', 'opnameSessions', 'opnameDetails', 'opnameDrafts',
]);

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
    const list = Array.isArray(docs) ? docs : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (REPLACE_COLLECTIONS.has(collection)) {
        const del = await client.query('DELETE FROM documents WHERE collection = $1', [collection]);
        if (del.rowCount) console.log(`  ${collection}: cleared ${del.rowCount} old documents`);
      }

      for (const doc of list) {
        await client.query(
          `INSERT INTO documents (collection, id, data, version, updated_at)
           VALUES ($1, $2, $3::jsonb, 1, now())
           ON CONFLICT (collection, id) DO UPDATE
             SET data = EXCLUDED.data, updated_at = now()`,
          [collection, doc.id, JSON.stringify(doc.data)]
        );
      }
      await client.query('COMMIT');
      console.log(`  ${collection}: ${list.length} documents loaded`);
      total += list.length;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  console.log(`\nDone. ${total} documents loaded in total.`);
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
