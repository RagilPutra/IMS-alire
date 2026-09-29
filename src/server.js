const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { pool, ensureSchema } = require('./db');
const { acquireLock } = require('./lock');

const PORT = process.env.PORT || 3000;
const APP_KEY = process.env.APP_KEY || '';
const INDEX_PATH = path.join(__dirname, '..', 'index.html');

if (!APP_KEY) {
  console.warn('WARNING: APP_KEY is not set. The API will run with no access control at all.');
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---- Static icon/manifest files (favicon, Add-to-Home-Screen / PWA icons).
// Served as real files (not embedded data: URIs) because Chrome/Android in
// particular are unreliable about picking up data-URI favicons and manifest
// icons -- real fetchable URLs are the standard, broadly-compatible way to
// do this and what "Add to Home Screen" install flows expect. Registered
// before the app.get('*', serveIndex) catch-all below so these exact paths
// are served as files, not swallowed by the SPA fallback.
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, '..', 'public', 'manifest.webmanifest'));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB, matches the frontend's own client-side check
});

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

// Shared-secret guard for the REST API. The original app (running inside a
// private Claude artifact) had no server-side auth at all -- everything
// was wide open within that private page. Per the "keep it simple" choice,
// we're not building real per-user accounts; this shared key is just a
// basic barrier against random internet scanning of the now-public API.
// It is injected into the page itself at request time (see serveIndex
// below), so the browser sends it back on every API call automatically.
function requireAppKey(req, res, next) {
  if (!APP_KEY) return next();
  if (req.get('x-app-key') === APP_KEY) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// ---- index.html, with the shared key injected in place of the
// __APP_KEY__ placeholder the frontend shim reads at startup. ----
function serveIndex(req, res) {
  fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
    if (err) return res.status(500).send('index.html not found');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html.replace('__APP_KEY__', APP_KEY));
  });
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

// ---- Documents API (generic collection/doc store) ----

app.get('/api/collections/:col', requireAppKey, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, data, version FROM documents WHERE collection = $1',
      [req.params.col]
    );
    res.json(rows.map(r => ({ id: r.id, data: r.data, version: r.version })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/api/collections/:col', requireAppKey, async (req, res) => {
  try {
    const id = newId();
    const data = req.body || {};
    await pool.query(
      `INSERT INTO documents (collection, id, data, version, updated_at)
       VALUES ($1, $2, $3::jsonb, 1, now())`,
      [req.params.col, id, JSON.stringify(data)]
    );
    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/collections/:col/:id', requireAppKey, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, data, version FROM documents WHERE collection = $1 AND id = $2',
      [req.params.col, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ exists: false });
    res.json({ exists: true, id: rows[0].id, data: rows[0].data, version: rows[0].version });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Replace (Firestore .set()) -- upserts.
app.put('/api/collections/:col/:id', requireAppKey, async (req, res) => {
  try {
    const data = req.body || {};
    await pool.query(
      `INSERT INTO documents (collection, id, data, version, updated_at)
       VALUES ($1, $2, $3::jsonb, 1, now())
       ON CONFLICT (collection, id) DO UPDATE
         SET data = EXCLUDED.data, version = documents.version + 1, updated_at = now()`,
      [req.params.col, req.params.id, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Merge (Firestore .update()) -- shallow merge into existing data, upserts
// if the document doesn't exist yet (more forgiving than real Firestore,
// which errors -- the app never relies on that error path).
app.patch('/api/collections/:col/:id', requireAppKey, async (req, res) => {
  try {
    const patch = req.body || {};
    await pool.query(
      `INSERT INTO documents (collection, id, data, version, updated_at)
       VALUES ($1, $2, $3::jsonb, 1, now())
       ON CONFLICT (collection, id) DO UPDATE
         SET data = documents.data || $3::jsonb, version = documents.version + 1, updated_at = now()`,
      [req.params.col, req.params.id, JSON.stringify(patch)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.delete('/api/collections/:col/:id', requireAppKey, async (req, res) => {
  try {
    await pool.query('DELETE FROM documents WHERE collection = $1 AND id = $2', [
      req.params.col,
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---- Distributed lock (backs the app's ref.acquire() calls) ----
app.post('/api/lock/acquire', requireAppKey, async (req, res) => {
  try {
    const { path: lockPath, holder, ttlMs } = req.body || {};
    if (!lockPath || !holder) return res.status(400).json({ error: 'path and holder required' });
    const acquired = await acquireLock(lockPath, holder, ttlMs);
    res.json({ acquired });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---- Attachments (PDF uploads + retrieval) ----
app.post('/api/upload', requireAppKey, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const id = newId();
    const contentType = req.body.type || req.file.mimetype || 'application/octet-stream';
    await pool.query(
      'INSERT INTO attachments (id, content_type, filename, data) VALUES ($1, $2, $3, $4)',
      [id, contentType, req.file.originalname || null, req.file.buffer]
    );
    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Deliberately NOT behind requireAppKey: the frontend's existing rendering
// code already hardcodes plain `<a href="/_blob/${attachmentId}">` links
// (no way to attach a header to a browser navigation), so this endpoint is
// protected only by its id being an unguessable random token.
app.get('/_blob/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT content_type, filename, data FROM attachments WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).send('Not found');
    const row = rows[0];
    res.set('Content-Type', row.content_type || 'application/octet-stream');
    if (row.filename) res.set('Content-Disposition', `inline; filename="${row.filename}"`);
    res.send(row.data);
  } catch (e) {
    console.error(e);
    res.status(500).send('internal_error');
  }
});

// Anything else falls back to the app shell.
app.get('*', serveIndex);

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Alire Inventory server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
