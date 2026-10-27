# Gruppenwerk Analytics

Cookieless website analytics for the Gruppenwerk client sites, running on a Cloudflare Worker with a D1 database. Google Ads spend and Search Console queries come in from Windsor.ai every 6 hours.

Live: https://gw-analytics.ksqsebastian.workers.dev (login: any user name, password in the `DASHBOARD_PASSWORD` secret)

## Tracking snippet

Add to each site's `<head>`, with that site's domain:

```html
<script defer data-domain="seehafer-elemente.de" src="https://gw-analytics.ksqsebastian.workers.dev/s.js"></script>
```

Tracked automatically:

- page views, including single-page navigation
- clicks on `tel:`, `mailto:` and WhatsApp links, Google Maps links, outbound links and file downloads
- clicks on anything whose class contains `btn`, `button` or `cta`, or that has `data-track="Name"`
- form submissions
- custom events via `window.gwTrack('Name', { label: '…' })`

Cookie-banner and menu buttons are ignored. Add `?gw_ignore=1` to any page URL to exclude your own browser (`?gw_ignore=0` to undo).

Visitors are counted like Plausible: a SHA-256 hash of a daily random salt, the site, IP address and user agent. The salt is deleted the next day, nothing is stored in the browser.

Only hostnames listed in the `sites` table are accepted, so builder previews (e.g. the Onepage editor) are not counted.

## Setup

```sh
npm install
npx wrangler d1 migrations apply gw-analytics --remote
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put WINDSOR_API_KEY
npx wrangler deploy
```

Sites, their Google Ads account and Search Console property live in the `sites` table (see `migrations/0001_init.sql`).

## Layout

- `src/tracker.client.js`: the browser script, served at `/s.js`
- `src/ingest.js`: `/e` endpoint, visitor hashing, sessions, source detection
- `src/stats.js`: dashboard queries
- `src/sync.js`: Windsor.ai sync (Google Ads, Search Console)
- `src/dashboard.html`: the dashboard
