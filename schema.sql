-- Alire Inventory — Postgres schema
-- Generic JSONB document store, mirroring the Firestore-like model the
-- frontend was originally built against. One row per document, addressed
-- by (collection, id). This keeps every collection (items, stock,
-- transactions, suppliers, opnameDetails, opnameSessions, users,
-- monthlyNetSales, ...) schema-free so the app's ~6000 lines of business
-- logic never had to change.

CREATE TABLE IF NOT EXISTS documents (
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents (collection);
CREATE INDEX IF NOT EXISTS idx_documents_data_gin ON documents USING GIN (data);

-- Distributed lock table backing the app's ref.acquire({holder, ttlMs})
-- calls (used only for concurrency-safe stock quantity updates).
CREATE TABLE IF NOT EXISTS locks (
  path        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Uploaded PDF attachments (goods-receipt proof documents). Stored as
-- BYTEA directly in Postgres for simplicity -- no external object storage
-- needed. Served back at GET /_blob/:id, exactly the URL the frontend's
-- existing rendering code already hardcodes.
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  content_type  TEXT,
  filename      TEXT,
  data          BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
