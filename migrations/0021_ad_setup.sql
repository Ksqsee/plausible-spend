-- The Google Ads account of each company and a snapshot of how it is set up
-- (campaigns, targeting, keywords, ads, assets), refreshed from Windsor.
ALTER TABLE companies ADD COLUMN ads_account TEXT;

UPDATE companies SET ads_account = '129-654-6325' WHERE id = 'seehafer';
UPDATE companies SET ads_account = '493-713-5791' WHERE id = 'hantke';
UPDATE companies SET ads_account = '418-312-7833' WHERE id = 'brink';
UPDATE companies SET ads_account = '223-074-5219' WHERE id = 'werner';
UPDATE companies SET ads_account = '652-388-9784' WHERE id = 'gruppenwerk';
UPDATE companies SET ads_account = '537-881-1021' WHERE id = 'groundpassion';
UPDATE companies SET ads_account = '226-969-0107' WHERE id = 'mehlig';
UPDATE companies SET ads_account = '868-493-5535' WHERE id = 'wernerbau';

CREATE TABLE IF NOT EXISTS ad_setup (
  company TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  fetched_ts INTEGER NOT NULL,
  data TEXT,
  error TEXT
);
