-- npx wrangler d1 execute skraning --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS submissions (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  kennitala       TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  status          TEXT NOT NULL,          -- received | claimed | ready | sent | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  form_json       TEXT NOT NULL,          -- what the customer entered, normalized
  company_json    TEXT NOT NULL,          -- fyrirtækjaskrá at submit time
  claim_json      TEXT,                   -- serials from /api/v1/leases/claim
  payload_json    TEXT,                   -- exactly what was POSTed to Zapier
  sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_submissions_dedupe ON submissions(dedupe_key, created_at);

CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
