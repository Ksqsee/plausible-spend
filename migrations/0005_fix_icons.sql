-- Two favicon URLs pointed at a resize path the CDN refuses; Gruppenwerk uses the dashboard's brand mark.
UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/media/ed8a9122-76d9-4b85-994d-39b98ec95795/full' WHERE domain = 'groundpassion.de';
UPDATE sites SET favicon_url = 'https://onecdn.io/cdn-cgi/image/width=144,height=144,fit=contain/media/892527db-2d04-456c-a44a-fecddd632d3a/full' WHERE domain = 'wernerbau2026.onepage.me';
UPDATE sites SET favicon_url = '/logo.svg?v=2' WHERE domain = 'gruppenwerk.de';
UPDATE companies SET favicon_url = (SELECT favicon_url FROM sites WHERE domain = companies.logo_domain) WHERE id IN ('groundpassion', 'wernerbau', 'gruppenwerk');
