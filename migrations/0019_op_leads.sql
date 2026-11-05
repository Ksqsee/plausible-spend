-- Form enquiries copied from the Onepage CRM, so the dashboard can show what came in before
-- our own measuring started. Only non-personal metadata: no names, phones, e-mails, addresses,
-- messages or files.
CREATE TABLE IF NOT EXISTS op_leads (
  id TEXT PRIMARY KEY,          -- Onepage lead id
  site TEXT NOT NULL,           -- our site domain
  ts TEXT NOT NULL,             -- ISO time the form was sent
  date TEXT NOT NULL,           -- YYYY-MM-DD
  page TEXT,                    -- page path the form was sent from
  source TEXT,                  -- same names as sessions.source ('' = not recorded)
  device TEXT,
  kind TEXT NOT NULL,           -- ok | test | job | spam | empty | duplicate | rejected
  imported_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS op_leads_site_date ON op_leads (site, date);
