-- Website links in these profiles carry ?utm_source=gbp since 2026-10-27, so their clicks show up as
-- "Google Business Profile". Gruppenwerk Projektentwicklung links to another domain and is not verified yet.
ALTER TABLE gbp_locations ADD COLUMN website_tagged INTEGER NOT NULL DEFAULT 0;
UPDATE gbp_locations SET website_tagged = 1 WHERE location <> 'locations/10005708253433033136';
