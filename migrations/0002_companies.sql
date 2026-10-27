-- Companies group sites in the menu and in combined dashboards.
-- logo_domain is the site whose favicon stands for the company.
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo_domain TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE sites ADD COLUMN company TEXT REFERENCES companies (id);

INSERT INTO companies (id, name, logo_domain, sort) VALUES
  ('seehafer', 'Seehafer Elemente', 'seehafer-elemente.de', 1),
  ('hantke', 'Maler Hantke', 'maler-hantke.de', 2),
  ('brink', 'Tischlerei Brink', 'tischlerei-brink.de', 3),
  ('werner', 'J. Werner Gerüstbau', 'j-werner-geruestbau.de', 4);

INSERT OR IGNORE INTO sites (domain, name, hostnames) VALUES
  ('malerbautrocknungmadewithclaude.onepage.me', 'Hantke Bautrocknung', 'malerbautrocknungmadewithclaude.onepage.me'),
  ('hantkeleckortungmadewithclaude.onepage.me', 'Hantke Leckortung', 'hantkeleckortungmadewithclaude.onepage.me'),
  ('seehaferportamaticmadwithclaude.onepage.me', 'Seehafer Barrierefrei (PortaMatic)', 'seehaferportamaticmadwithclaude.onepage.me'),
  ('seehafer-wartung-modifiedwithclaude.onepage.me', 'Seehafer Wartung', 'seehafer-wartung-modifiedwithclaude.onepage.me'),
  ('seehaferkitamadewithclaude.onepage.me', 'Seehafer Klemmschutz', 'seehaferkitamadewithclaude.onepage.me'),
  ('brinkdichtungenclaud.onepage.me', 'Brink Dichtungen', 'brinkdichtungenclaud.onepage.me');

UPDATE sites SET company = 'seehafer' WHERE domain IN (
  'seehafer-elemente.de', 'seehaferportamaticmadwithclaude.onepage.me',
  'seehafer-wartung-modifiedwithclaude.onepage.me', 'seehaferkitamadewithclaude.onepage.me');
UPDATE sites SET company = 'hantke' WHERE domain IN (
  'maler-hantke.de', 'malerbautrocknungmadewithclaude.onepage.me', 'hantkeleckortungmadewithclaude.onepage.me');
UPDATE sites SET company = 'brink' WHERE domain IN ('tischlerei-brink.de', 'brinkdichtungenclaud.onepage.me');
UPDATE sites SET company = 'werner' WHERE domain = 'j-werner-geruestbau.de';
