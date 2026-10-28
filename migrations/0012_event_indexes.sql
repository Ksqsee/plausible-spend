-- Time-based lookups (live visitors, tracking status, overview) no longer scan the whole events table.
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_site_ts ON events(site, ts);
CREATE INDEX IF NOT EXISTS events_date_site ON events(date, site);
