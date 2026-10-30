// Everything the simple company view needs in one call: per-day series for the metric cards,
// the period before for comparison, and the facts the highlight sentences are built from.

import { LEAD_EVENTS, trackingSince, where } from './stats.js'

const list = (n) => Array(n).fill('?').join(',')
const shift = (date, days) => {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const span = (from, to) => Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1
const TYPES = { 'Phone click': 'call', 'WhatsApp click': 'whatsapp', 'Email click': 'email', 'Form submit': 'form' }

async function siteSide(db, q, range) {
  const w = where(q, { range })
  const leadIn = list(LEAD_EVENTS.length)
  const byHour = range[0] === range[1]
  const bucket = byHour ? 'hour' : 'date'
  const [visitors, leads, types, sources, weekdays, total] = await Promise.all([
    db.prepare(`SELECT ${bucket} AS b, COUNT(DISTINCT visitor_id) AS n FROM events WHERE ${w.sql} GROUP BY b`).bind(...w.params).all(),
    db.prepare(`SELECT ${bucket} AS b, COUNT(DISTINCT session_id) AS n FROM events WHERE ${w.sql} AND name IN (${leadIn}) GROUP BY b`).bind(...w.params, ...LEAD_EVENTS).all(),
    db.prepare(`SELECT ${bucket} AS b, name, COUNT(DISTINCT session_id) AS n FROM events WHERE ${w.sql} AND name IN (${leadIn}) GROUP BY b, name`).bind(...w.params, ...LEAD_EVENTS).all(),
    db
      .prepare(
        `SELECT s.source AS source, COUNT(DISTINCT e.session_id) AS n FROM events e JOIN sessions s ON s.id = e.session_id
         WHERE ${w.sql.replace(/\b(site|date|name|page|source|device|country|city|browser|os|utm_\w+)\b/g, 'e.$1')} AND e.name IN (${leadIn})
         GROUP BY s.source ORDER BY n DESC`
      )
      .bind(...w.params, ...LEAD_EVENTS)
      .all(),
    db
      .prepare(`SELECT CAST(strftime('%w', date) AS INTEGER) AS d, COUNT(DISTINCT session_id) AS n FROM events WHERE ${w.sql} AND name IN (${leadIn}) GROUP BY d`)
      .bind(...w.params, ...LEAD_EVENTS)
      .all(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT CASE WHEN name IN (${leadIn}) THEN session_id END) AS leads FROM events WHERE ${w.sql}`
      )
      .bind(...LEAD_EVENTS, ...w.params)
      .first()
  ])
  const typeTotals = { call: 0, whatsapp: 0, email: 0, form: 0 }
  const typeSeries = {}
  for (const r of types.results) {
    const k = TYPES[r.name]
    typeTotals[k] += r.n
    if (!typeSeries[r.b]) typeSeries[r.b] = { call: 0, whatsapp: 0, email: 0, form: 0 }
    typeSeries[r.b][k] += r.n
  }
  const week = [0, 0, 0, 0, 0, 0, 0]
  for (const r of weekdays.results) week[(r.d + 6) % 7] += r.n
  return {
    visitors: total.visitors || 0,
    leads: total.leads || 0,
    visitorSeries: Object.fromEntries(visitors.results.map((r) => [r.b, r.n])),
    leadSeries: Object.fromEntries(leads.results.map((r) => [r.b, r.n])),
    typeTotals,
    typeSeries,
    sources: sources.results.map((r) => ({ source: r.source || 'Direct / None', n: r.n })),
    weekdays: week
  }
}

async function dailySum(db, sql, params) {
  const { results } = await db.prepare(sql).bind(...params).all()
  return results
}

export async function summary(db, q) {
  const days = span(q.from, q.to)
  const prev = [shift(q.from, -days), shift(q.from, -1)]
  const sites = q.sites
  const siteIn = list(sites.length)
  const since = await trackingSince(db, sites)
  const measuredBefore = !!since && prev[0] >= since

  const [now, before, ads, adsPrev, gbp, gbpPrev, search, searchPrev, hasGbp, hasAds, hasSearch] = await Promise.all([
    siteSide(db, q, [q.from, q.to]),
    measuredBefore ? siteSide(db, q, prev) : null,
    dailySum(
      db,
      `SELECT date, SUM(spend) AS spend, SUM(clicks) AS clicks,
              SUM(CASE WHEN date >= (SELECT MIN(e.date) FROM events e WHERE e.site = ads_spend.site) THEN spend ELSE 0 END) AS tracked
       FROM ads_spend WHERE site IN (${siteIn}) AND date >= ? AND date <= ? GROUP BY date`,
      [...sites, q.from, q.to]
    ),
    db.prepare(`SELECT SUM(spend) AS spend FROM ads_spend WHERE site IN (${siteIn}) AND date >= ? AND date <= ?`).bind(...sites, ...prev).first(),
    dailySum(
      db,
      `SELECT d.date AS date, SUM(d.calls) AS calls, SUM(d.impressions_maps + d.impressions_search) AS views, SUM(d.website_clicks) AS web, SUM(d.directions) AS directions
       FROM gbp_daily d JOIN gbp_locations l ON l.location = d.location WHERE l.site IN (${siteIn}) AND d.date >= ? AND d.date <= ? GROUP BY d.date`,
      [...sites, q.from, q.to]
    ),
    db
      .prepare(
        `SELECT SUM(d.calls) AS calls, SUM(d.impressions_maps + d.impressions_search) AS views FROM gbp_daily d JOIN gbp_locations l ON l.location = d.location
         WHERE l.site IN (${siteIn}) AND d.date >= ? AND d.date <= ?`
      )
      .bind(...sites, ...prev)
      .first(),
    dailySum(
      db,
      `SELECT date, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM search_queries WHERE site IN (${siteIn}) AND date >= ? AND date <= ? GROUP BY date`,
      [...sites, q.from, q.to]
    ),
    db.prepare(`SELECT SUM(clicks) AS clicks FROM search_queries WHERE site IN (${siteIn}) AND date >= ? AND date <= ?`).bind(...sites, ...prev).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM gbp_locations WHERE site IN (${siteIn})`).bind(...sites).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM sites WHERE domain IN (${siteIn}) AND ads_account IS NOT NULL`).bind(...sites).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM sites WHERE domain IN (${siteIn}) AND gsc_property IS NOT NULL`).bind(...sites).first()
  ])

  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0)
  const by = (rows, k) => Object.fromEntries(rows.map((r) => [r.date, r[k] || 0]))
  const spend = sum(ads, 'spend')
  const tracked = sum(ads, 'tracked')
  return {
    from: q.from,
    to: q.to,
    interval: q.from === q.to ? 'hour' : 'day',
    tracking_since: since,
    leads: { total: now.leads, prev: before ? before.leads : null, series: now.leadSeries, types: now.typeTotals, type_series: now.typeSeries },
    visitors: { total: now.visitors, prev: before ? before.visitors : null, series: now.visitorSeries },
    ads: hasAds.n
      ? {
          spend: Math.round(spend * 100) / 100,
          prev: adsPrev && adsPrev.spend !== null ? Math.round(adsPrev.spend * 100) / 100 : null,
          clicks: sum(ads, 'clicks'),
          series: by(ads, 'spend'),
          // cost per lead only over the days the website counted leads
          per_lead: now.leads && tracked ? Math.round((tracked / now.leads) * 100) / 100 : null,
          spend_tracked: Math.round(tracked * 100) / 100,
          per_lead_prev: before && before.leads && adsPrev && adsPrev.spend ? Math.round((adsPrev.spend / before.leads) * 100) / 100 : null
        }
      : null,
    gbp: hasGbp.n
      ? { calls: sum(gbp, 'calls'), views: sum(gbp, 'views'), web: sum(gbp, 'web'), directions: sum(gbp, 'directions'), prev: gbpPrev ? gbpPrev.calls : null, views_prev: gbpPrev ? gbpPrev.views : null, series: by(gbp, 'calls'), view_series: by(gbp, 'views') }
      : null,
    search: hasSearch.n ? { clicks: sum(search, 'clicks'), impressions: sum(search, 'impressions'), prev: searchPrev ? searchPrev.clicks : null, series: by(search, 'clicks') } : null,
    sources: now.sources,
    weekdays: now.weekdays
  }
}
