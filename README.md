# Gruppenwerk Analytics

Cookieless website analytics for the Gruppenwerk client sites, running on a Cloudflare Worker with a D1 database. Google Ads (campaigns, keywords, search terms, hours, devices, landing pages, impression share), Search Console and Google Business Profile data come in from Windsor.ai every 6 hours.

Live: https://gw-analytics.ksqsebastian.workers.dev (login: any user name, password in the `DASHBOARD_PASSWORD` secret)

## Tracking snippet

Add to each site's `<head>`, with that site's domain:

```html
<script defer data-domain="seehafer-elemente.de" src="https://gw-analytics.ksqsebastian.workers.dev/s.js"></script>
```

Tracked automatically:

- page views, including single-page navigation
- `Engagement` once per page: scroll depth, seconds visible, and which named sections (`<section id="…">`) reached the middle of the screen
- clicks on `tel:`, `mailto:` and WhatsApp links, Google review links, map links, outbound links and file downloads, each with the section it sits in
- FAQ questions opened, phone numbers or e-mail addresses copied, videos played
- forms: `Form start` on first touch, `Form step` for every step of a multi-step form, and `Form submit` only when the site's CRM accepted the request (Onepage `leadV2.create`). The submit keeps the choices made (problem, material, size …) but never names, phone numbers, e-mails, addresses or free text. Job forms count as `Application start` / `Application`
- clicks on anything whose class contains `btn`, `button` or `cta`, or that has `data-track="Name"`
- custom events via `window.gwTrack('Name', { label: '…' })`

Per-site settings (funnel steps, the service a landing page is built for and the search terms that belong to it) live in `sites.config`, so the snippet never changes.

Recommended Google Ads tracking template (account level), so leads can be tied to keywords:

```
{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}&utm_content={creative}
```

Google Business Profile website links: add `?utm_source=gbp&utm_medium=organic&utm_campaign=gbp`.

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
- `src/stats.js`: traffic queries
- `src/deep.js`: leads, funnels, forms, content, keyword level Ads, Business Profile, and the opportunity rules (`/api/insights`)
- `src/sync.js`: Windsor.ai sync. The scheduled run fetches keyword level tables for 30 days once a night and 3 days otherwise; `POST /api/sync?days=30&detail=30` does a full run
- `src/dashboard.html`: the dashboard
