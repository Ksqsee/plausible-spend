-- Gruppenwerk, Ground Passion, Mehlig, Werner Bau and three more Seehafer pages.

INSERT OR IGNORE INTO companies (id, name, logo_domain, sort) VALUES
  ('gruppenwerk', 'Gruppenwerk', 'gruppenwerk.de', 0),
  ('groundpassion', 'Ground Passion', 'groundpassion.de', 5),
  ('mehlig', 'Mehlig', 'mehlig-gmbh.de', 6),
  ('wernerbau', 'Werner Bau', 'wernerbau2026.onepage.me', 7);

INSERT OR IGNORE INTO sites (domain, name, hostnames, gsc_property, company, favicon_url, logo_url, config) VALUES
  ('gruppenwerk.de', 'Gruppenwerk', 'gruppenwerk.de,www.gruppenwerk.de', 'https://www.gruppenwerk.de/', 'gruppenwerk',
   'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/media/bec5ff6e-af9d-4b1d-bb7c-cc42737f75cf/sm',
   'https://onecdn.io/media/24bb588c-e0ce-4404-97e0-42f911d486a0/md2x',
   '{"kind":"main","funnel":[{"label":"Besuch","type":"visit"},{"label":"Jobs angesehen","type":"page","value":"/jobs"},{"label":"Bewerbung oder Kontakt","type":"events","value":["Application contact","Application","Email click","Phone click"]}]}'),
  ('groundpassion.de', 'Ground Passion', 'groundpassion.de,www.groundpassion.de', NULL, 'groundpassion',
   'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/https://onecdn.io/media/ed8a9122-76d9-4b85-994d-39b98ec95795/full/sm',
   'https://onecdn.io/cdn-cgi/image/width=480,format=auto,quality=80/media/cd29f24c-e700-4801-88d2-b9d8988799e8/full',
   '{"kind":"main","funnel":[{"label":"Besuch","type":"visit"},{"label":"Leistungsseite angesehen","type":"service_page"},{"label":"Anfrage-Seite oder Formular","type":"page_or_section","value":["/kontakt","formular"]},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Kontakt (Formular, Telefon, Mail)","type":"lead"}]}'),
  ('mehlig-gmbh.de', 'Mehlig', 'mehlig-gmbh.de,www.mehlig-gmbh.de', NULL, 'mehlig',
   'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/media/925e3dba-5366-44e9-94bd-edafa741f777/sm', NULL,
   '{"kind":"main","funnel":[{"label":"Besuch","type":"visit"},{"label":"Projekte angesehen","type":"page_or_section","value":["/projekte","/projekt","projekte"]},{"label":"Kontakt-Bereich","type":"section","value":"kontakt"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Kontakt (Formular, Telefon, Mail)","type":"lead"}]}'),
  ('wernerbau2026.onepage.me', 'Werner Bau', 'wernerbau2026.onepage.me', NULL, 'wernerbau',
   'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/https://onecdn.io/media/892527db-2d04-456c-a44a-fecddd632d3a/full/sm',
   'https://onecdn.io/media/5be520fb-bb94-43af-8488-176401ad777e/preview',
   '{"kind":"main","funnel":[{"label":"Besuch","type":"visit"},{"label":"Leistungsseite angesehen","type":"service_page"},{"label":"Kontaktseite","type":"page","value":"/kontakt"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Kontakt (Formular, Telefon, Mail)","type":"lead"}]}'),
  ('seehaferobjettuerenmadewithclaude.onepage.me', 'Seehafer Objekttüren', 'seehaferobjettuerenmadewithclaude.onepage.me', NULL, 'seehafer',
   'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/media/617368fa-eb07-4514-87b8-d9a1ecffc8d1/sm', NULL,
   '{"kind":"landing","service":"Objekttüren","terms":["objekttür","schallschutztür","strahlenschutz","stahltür","holztür objekt","rohrrahmentür"],"funnel":[{"label":"Besuch","type":"visit"},{"label":"Türarten gesehen","type":"section","value":"tuerarten"},{"label":"Leistungsumfang gesehen","type":"section","value":"leistungsumfang"},{"label":"Anfrage-Bereich","type":"section","value":"anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Anfrage gesendet","type":"event","value":"Form submit"}]}'),
  ('seehafer-elemente-workedwithclaude.onepage.me', 'Seehafer Türreparatur', 'seehafer-elemente-workedwithclaude.onepage.me', NULL, 'seehafer',
   'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/https://onecdn.io/media/f22507f7-c950-4594-a97f-c409c83fee0b/sm',
   'https://onecdn.io/media/4a7c2d7a-503e-4749-b1a5-53c38766b350/full',
   '{"kind":"landing","service":"Türreparatur","terms":["reparatur","türschließer","schloss","beschlag","klemmt","notdienst"],"funnel":[{"label":"Besuch","type":"visit"},{"label":"Schäden gesehen","type":"section","value":"schaeden"},{"label":"Kosten gesehen","type":"section","value":"kosten"},{"label":"Anfrage-Bereich","type":"section","value":"anfrage"},{"label":"Formular begonnen","type":"event","value":"Form start"},{"label":"Anfrage gesendet","type":"event","value":"Form submit"}]}');

UPDATE companies SET favicon_url = (SELECT favicon_url FROM sites WHERE domain = companies.logo_domain),
  logo_url = (SELECT logo_url FROM sites WHERE domain = companies.logo_domain)
  WHERE id IN ('gruppenwerk', 'groundpassion', 'mehlig', 'wernerbau');

-- The Gruppenwerk group itself uses the brand mark served by the dashboard.
UPDATE companies SET favicon_url = '/logo.svg?v=2' WHERE id = 'gruppenwerk';

INSERT OR IGNORE INTO gbp_locations (location, name, company, site) VALUES
  ('locations/9341725612634059939', 'Ground Passion', 'groundpassion', 'groundpassion.de');
