-- Visible headings of page sections, so the dashboard shows "Leistungen" instead of "#leistungen".
CREATE TABLE IF NOT EXISTS section_names (
  site TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (site, id)
);
