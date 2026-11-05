-- Shadow copies of the Search Console tables, filled straight from Google while the Windsor copy
-- is still the live one. Once the numbers agree, GSC_SOURCE=google writes the live tables instead.
CREATE TABLE IF NOT EXISTS search_queries_g (site TEXT NOT NULL, date TEXT NOT NULL, query TEXT NOT NULL, clicks INTEGER, impressions INTEGER, position REAL);
CREATE INDEX IF NOT EXISTS search_queries_g_site_date ON search_queries_g (site, date);
CREATE TABLE IF NOT EXISTS search_pages_g (site TEXT NOT NULL, date TEXT NOT NULL, query TEXT NOT NULL, page TEXT NOT NULL, clicks INTEGER, impressions INTEGER, position REAL);
CREATE INDEX IF NOT EXISTS search_pages_g_site_date ON search_pages_g (site, date);
