-- Sites that may send events. hostnames is a comma-separated allowlist.
CREATE TABLE sites (
  domain TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostnames TEXT NOT NULL,
  ads_account TEXT,
  gsc_property TEXT
);

-- Daily random salt for cookieless visitor IDs. Old salts are deleted,
-- so yesterday's visitor IDs can no longer be recomputed.
CREATE TABLE salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  date TEXT NOT NULL,
  entry_page TEXT,
  exit_page TEXT,
  pageviews INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT
);
CREATE INDEX sessions_visitor ON sessions (site, visitor_id, last_ts);
CREATE INDEX sessions_date ON sessions (site, date);

-- One row per pageview or event. Session attributes (source, UTMs) are
-- copied onto every row so any filter works on this table alone.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  ts INTEGER NOT NULL,
  date TEXT NOT NULL,
  hour INTEGER NOT NULL,
  name TEXT NOT NULL,
  page TEXT NOT NULL,
  hostname TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  device TEXT,
  browser TEXT,
  os TEXT,
  label TEXT,
  props TEXT
);
CREATE INDEX events_site_date ON events (site, date);
CREATE INDEX events_site_name ON events (site, name, date);

-- Daily Google Ads spend per campaign, from Windsor.ai.
CREATE TABLE ads_spend (
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign TEXT NOT NULL,
  spend REAL NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (site, date, campaign_id, campaign)
);

-- Daily Search Console performance per query, from Windsor.ai.
CREATE TABLE search_queries (
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  query TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position REAL,
  PRIMARY KEY (site, date, query)
);

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  site TEXT NOT NULL,
  rows INTEGER,
  error TEXT
);

INSERT INTO sites (domain, name, hostnames, ads_account, gsc_property) VALUES
  ('seehafer-elemente.de', 'Seehafer Elemente', 'seehafer-elemente.de,www.seehafer-elemente.de', '344-127-4121', 'https://seehafer-elemente.de/'),
  ('tischlerei-brink.de', 'Tischlerei Brink', 'tischlerei-brink.de,www.tischlerei-brink.de', '570-032-2907', 'https://tischlerei-brink.de/'),
  ('maler-hantke.de', 'Maler Hantke', 'maler-hantke.de,www.maler-hantke.de', '913-818-3446', 'https://www.maler-hantke.de/'),
  ('j-werner-geruestbau.de', 'J. Werner Gerüstbau', 'j-werner-geruestbau.de,www.j-werner-geruestbau.de', '660-719-2807', 'https://j-werner-geruestbau.de/');
