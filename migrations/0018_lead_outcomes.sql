-- What became of an enquiry: one row per visit (a visitor's day), set by the company or the admin.
-- status: open, quote (offer sent), won (order, with value), lost, none (no real contact / spam)
CREATE TABLE IF NOT EXISTS lead_outcomes (
  session_id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  status TEXT NOT NULL,
  value REAL,
  note TEXT,
  updated_ts INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS lead_outcomes_site ON lead_outcomes (site, status);
