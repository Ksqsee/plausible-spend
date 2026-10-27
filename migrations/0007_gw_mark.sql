-- The Gruppenwerk company keeps its own mark; /logo.svg is now the Analytics logo.
UPDATE companies SET favicon_url = '/gw.svg' WHERE id = 'gruppenwerk';
UPDATE sites SET favicon_url = '/gw.svg' WHERE domain = 'gruppenwerk.de';
