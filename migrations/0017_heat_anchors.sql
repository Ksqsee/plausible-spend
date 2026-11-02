-- Clicks tied to the clicked element (path + position inside it) and to the page's top-level
-- section, so they land on the same spot in a screenshot taken at a different screen width.
ALTER TABLE heat_clicks ADD COLUMN anchor TEXT;
ALTER TABLE heat_clicks ADD COLUMN ax INTEGER;
ALTER TABLE heat_clicks ADD COLUMN ay INTEGER;
ALTER TABLE heat_clicks ADD COLUMN sa TEXT;
