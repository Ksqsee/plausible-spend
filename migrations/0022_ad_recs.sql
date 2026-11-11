-- What people decided about a keyword recommendation on the Anzeigen page.
-- accepted = add as keyword (applied in Google Ads by the admin), ignored = hide it.
CREATE TABLE IF NOT EXISTS ad_rec (
  company TEXT NOT NULL,
  kind TEXT NOT NULL,
  term TEXT NOT NULL,
  state TEXT NOT NULL,
  by_user TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (company, kind, term)
);
