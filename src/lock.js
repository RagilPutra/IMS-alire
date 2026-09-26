const { pool } = require('./db');

// Emulates the artifact db's ref.acquire({holder, ttlMs}) — an atomic
// "take this lock unless someone else already holds a still-valid one"
// operation. Implemented as a single upsert: the row is written only when
// it doesn't exist yet, has already expired, or is already held by the
// same holder (so retries by the same tab don't self-deadlock).
async function acquireLock(path, holder, ttlMs) {
  const result = await pool.query(
    `INSERT INTO locks (path, holder, expires_at)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (path) DO UPDATE
       SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE locks.expires_at < now() OR locks.holder = EXCLUDED.holder
     RETURNING path`,
    [path, holder, String(ttlMs || 4000)]
  );
  return result.rowCount > 0;
}

module.exports = { acquireLock };
