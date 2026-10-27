-- Logos, Google Business Profile, keyword level Ads data and per-site tracking config.

ALTER TABLE sites ADD COLUMN favicon_url TEXT;
ALTER TABLE sites ADD COLUMN logo_url TEXT;
-- JSON: { "kind": "main" | "landing", "service": "...", "funnel": [ { "label", "type", "value" } ], "goals": [...] }
ALTER TABLE sites ADD COLUMN config TEXT;
ALTER TABLE companies ADD COLUMN favicon_url TEXT;
ALTER TABLE companies ADD COLUMN logo_url TEXT;

UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/media/b2d9feb0-067a-4adf-97ea-4493ba0d01ba/sm',
  logo_url = 'https://onecdn.io/media/4a7c2d7a-503e-4749-b1a5-53c38766b350/full' WHERE domain = 'seehafer-elemente.de';
UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/media/e817b30c-6829-4a9a-952c-aaa415a6f524/sm'
  WHERE domain = 'maler-hantke.de';
UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/media/ee20c3d5-969c-4016-b4fc-efb3ecc02442/sm',
  logo_url = 'https://onecdn.io/media/ecb2ec29-e2f4-481f-8b21-c0430d16d77b/full' WHERE domain = 'tischlerei-brink.de';
UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/media/856c258f-651d-4972-b13f-3c15d84a8703/sm',
  logo_url = 'https://onecdn.io/cdn-cgi/image/width=600,format=auto,quality=80/media/db9185ad-e257-4a45-920d-626267b5aaf1/full' WHERE domain = 'j-werner-geruestbau.de';
UPDATE sites SET logo_url = 'https://onecdn.io/media/10b6b5ea-8dbf-4bf3-a114-d77d5016af55/full'
  WHERE domain = 'malerbautrocknungmadewithclaude.onepage.me';
UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/https://onecdn.io/media/741003a0-3afa-4e3d-bbeb-929e35f2ddd4/sm'
  WHERE domain = 'seehaferportamaticmadwithclaude.onepage.me';
UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/https://onecdn.io/media/8e9f5c73-74f5-4c8e-8271-247881af1445/sm'
  WHERE domain = 'seehafer-wartung-modifiedwithclaude.onepage.me';
UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/https://onecdn.io/media/f04f0428-9605-4e99-b9c0-029cc72bba35/sm'
  WHERE domain = 'seehaferkitamadewithclaude.onepage.me';
UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/https://onecdn.io/media/c47d2dc1-56af-453d-90dc-770fc10e8acd/sm',
  logo_url = 'https://onecdn.io/media/6c5b1f23-4d0f-4674-a9d6-cddfc44beb54/full' WHERE domain = 'brinkdichtungenclaud.onepage.me';

UPDATE companies SET favicon_url = (SELECT favicon_url FROM sites WHERE domain = companies.logo_domain),
  logo_url = (SELECT logo_url FROM sites WHERE domain = companies.logo_domain);

-- Landing pages: the request form funnel they are built around.
UPDATE sites SET config = '{"kind":"landing","service":"Bautrocknung","terms":["bautrocknung","trocknung","trockn","estrich","feucht","wasserschaden"],"funnel":[{"label":"Besuch","type":"visit"},{"label":"Leistungen gesehen","type":"section","value":"leistungen"},{"label":"Kosten gesehen","type":"section","value":"kosten"},{"label":"Anfrage-Bereich","type":"section","value":"anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Anfrage gesendet","type":"lead"}]}'
  WHERE domain = 'malerbautrocknungmadewithclaude.onepage.me';
UPDATE sites SET config = '{"kind":"landing","service":"Leckortung","terms":["leckortung","leck","ortung","rohrbruch","wasserrohr"],"funnel":[{"label":"Besuch","type":"visit"},{"label":"Anzeichen gesehen","type":"section","value":"anzeichen"},{"label":"Ablauf gesehen","type":"section","value":"ablauf"},{"label":"Anfrage-Bereich","type":"section","value":"anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Anfrage gesendet","type":"lead"}]}'
  WHERE domain = 'hantkeleckortungmadewithclaude.onepage.me';
UPDATE sites SET config = '{"kind":"landing","service":"Automatische Türen","terms":["automatisch","türantrieb","antrieb","türöffner","portamatic","barrierefrei","drehtür"],"funnel":[{"label":"Besuch","type":"visit"},{"label":"Antriebe gesehen","type":"section","value":"antriebe"},{"label":"Referenzen gesehen","type":"section","value":"referenzen"},{"label":"Anfrage-Bereich","type":"section","value":"anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Anfrage gesendet","type":"lead"}]}'
  WHERE domain = 'seehaferportamaticmadwithclaude.onepage.me';
UPDATE sites SET config = '{"kind":"landing","service":"Türwartung","terms":["wartung","prüfung","feststell","brandschutztür","rauchschutz","wartungsvertrag"],"funnel":[{"label":"Besuch","type":"visit"},{"label":"Prüfpflichten gesehen","type":"section","value":"pruefpflichten"},{"label":"Vertrag gesehen","type":"section","value":"vertrag"},{"label":"Anfrage-Bereich","type":"section","value":"anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Anfrage gesendet","type":"lead"}]}'
  WHERE domain = 'seehafer-wartung-modifiedwithclaude.onepage.me';
UPDATE sites SET config = '{"kind":"landing","service":"Kita-Klemmschutz","terms":["kita","klemmschutz","fingerschutz","fingerklemm","schule"],"funnel":[{"label":"Besuch","type":"visit"},{"label":"Nachrüstung gesehen","type":"section","value":"nachruestung"},{"label":"Begehung gesehen","type":"section","value":"begehung"},{"label":"Anfrage-Bereich","type":"section","value":"anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Anfrage gesendet","type":"lead"}]}'
  WHERE domain = 'seehaferkitamadewithclaude.onepage.me';
UPDATE sites SET config = '{"kind":"landing","service":"Fensterdichtungen","terms":["dichtung","zugluft","zieht","dichtungswechsel"],"funnel":[{"label":"Besuch","type":"visit"},{"label":"Anzeichen gesehen","type":"section","value":"anzeichen"},{"label":"Preis gesehen","type":"section","value":"preis"},{"label":"Anfrage-Bereich","type":"section","value":"anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Anfrage gesendet","type":"lead"}]}'
  WHERE domain = 'brinkdichtungenclaud.onepage.me';
UPDATE sites SET config = '{"kind":"main","funnel":[{"label":"Besuch","type":"visit"},{"label":"Leistungsseite angesehen","type":"service_page"},{"label":"Anfrage-Bereich","type":"section","value":"anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Kontakt (Formular, Telefon, Mail)","type":"lead"}]}'
  WHERE config IS NULL;
UPDATE sites SET config = '{"kind":"main","funnel":[{"label":"Besuch","type":"visit"},{"label":"Anfrage-Seite","type":"page","value":"/anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Kontakt (Formular, Telefon, Mail)","type":"lead"}]}'
  WHERE domain = 'j-werner-geruestbau.de';

-- Google Business Profile locations and the site their profile links to.
CREATE TABLE gbp_locations (
  location TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT REFERENCES companies (id),
  site TEXT
);
INSERT INTO gbp_locations (location, name, company, site) VALUES
  ('locations/17651062171078403131', 'Seehafer Elemente', 'seehafer', 'seehafer-elemente.de'),
  ('locations/17823599309722235351', 'Tomas Hantke Malermeister', 'hantke', 'maler-hantke.de'),
  ('locations/2827383516507925607', 'Hantke Bautrocknung', 'hantke', 'malerbautrocknungmadewithclaude.onepage.me'),
  ('locations/5499471254339518555', 'Karl Brink Tischlerei', 'brink', 'tischlerei-brink.de'),
  ('locations/15441646822212190286', 'J. Werner Gerüstbau', 'werner', 'j-werner-geruestbau.de');

CREATE TABLE gbp_daily (
  location TEXT NOT NULL,
  date TEXT NOT NULL,
  impressions_maps INTEGER NOT NULL DEFAULT 0,
  impressions_search INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  website_clicks INTEGER NOT NULL DEFAULT 0,
  directions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location, date)
);

-- Monthly search keywords people used to find the profile (Google hides values below a threshold).
CREATE TABLE gbp_keywords (
  location TEXT NOT NULL,
  keyword TEXT NOT NULL,
  value INTEGER,
  threshold INTEGER,
  PRIMARY KEY (location, keyword)
);

CREATE TABLE gbp_reviews (
  location TEXT PRIMARY KEY,
  count INTEGER,
  rating REAL,
  updated_ts INTEGER
);

CREATE TABLE ads_keywords (
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  campaign TEXT NOT NULL,
  ad_group TEXT NOT NULL,
  keyword TEXT NOT NULL,
  match_type TEXT NOT NULL,
  status TEXT,
  quality_score INTEGER,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  spend REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (site, date, campaign, ad_group, keyword, match_type)
);

CREATE TABLE ads_search_terms (
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  campaign TEXT NOT NULL,
  term TEXT NOT NULL,
  status TEXT,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  spend REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (site, date, campaign, term)
);

-- Spend split by hour of day, device and final URL (kind = 'hour' | 'device' | 'url').
CREATE TABLE ads_segments (
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  spend REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (site, date, kind, key)
);

CREATE TABLE ads_share (
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  campaign TEXT NOT NULL,
  impression_share REAL,
  top_share REAL,
  lost_budget REAL,
  lost_rank REAL,
  impressions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site, date, campaign)
);

-- Search Console queries with the page that ranked for them.
CREATE TABLE search_pages (
  site TEXT NOT NULL,
  date TEXT NOT NULL,
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position REAL,
  PRIMARY KEY (site, date, query, page)
);
