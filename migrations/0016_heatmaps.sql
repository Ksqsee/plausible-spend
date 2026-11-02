-- Click positions for heatmaps: x in per mille of the page width, y in px from the top.
CREATE TABLE IF NOT EXISTS heat_clicks (
  site TEXT NOT NULL,
  page TEXT NOT NULL,
  device TEXT NOT NULL,
  date TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  ph INTEGER NOT NULL,
  target TEXT,
  section TEXT
);
CREATE INDEX IF NOT EXISTS heat_clicks_page ON heat_clicks (site, page, device, date);

-- Page geometry as the visitors saw it: height, fold and where each section sits.
CREATE TABLE IF NOT EXISTS page_geo (
  site TEXT NOT NULL,
  page TEXT NOT NULL,
  device TEXT NOT NULL,
  ph INTEGER NOT NULL,
  vh INTEGER NOT NULL,
  vw INTEGER NOT NULL,
  sections TEXT,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (site, page, device)
);
