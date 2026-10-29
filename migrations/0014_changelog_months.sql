-- Logbook: dated changes to websites and campaigns, so their effect can be read later.
CREATE TABLE IF NOT EXISTS changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT,               -- NULL: affects every site
  date TEXT NOT NULL,      -- YYYY-MM-DD the change went live
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS changelog_site_date ON changelog (site, date);

-- One row per site and month. Kept for good, also after the single visits are deleted (25 months).
CREATE TABLE IF NOT EXISTS monthly_stats (
  site TEXT NOT NULL,
  month TEXT NOT NULL,     -- YYYY-MM
  days INTEGER NOT NULL,   -- days with data in that month
  visitors INTEGER NOT NULL,
  visits INTEGER NOT NULL,
  pageviews INTEGER NOT NULL,
  contacts INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  whatsapp INTEGER NOT NULL,
  emails INTEGER NOT NULL,
  forms INTEGER NOT NULL,
  form_starts INTEGER NOT NULL,
  ad_spend REAL NOT NULL,
  ad_clicks INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (site, month)
);

INSERT INTO changelog (site, date, text, author, created_ts) VALUES
  (NULL, '2026-10-27', 'Neuer Tracker auf allen Websites: Kontakte, Formulare, Abschnitte und Lesetiefe werden gemessen', 'Claude', 1793280000000),
  (NULL, '2026-10-29', 'Tracker misst zusätzlich Formular-Abbrüche pro Feld, Ladezeit und Frust-Klicks', 'Claude', 1793280000000),
  ('groundpassion.de', '2026-10-29', 'Telefonnummer und E-Mail im Footer der Startseite anklickbar gemacht', 'Claude', 1793280000000);
