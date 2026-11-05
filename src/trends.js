// Click trends over the whole stored history: Google Ads and Google search per day,
// plus every keyword and search query week by week. The dashboard groups the days
// into weeks or months itself, so one response serves all three views.
import { LEAD_EVENTS } from './stats.js'

const inList = (col, list) => `${col} IN (${list.map(() => '?').join(',')})`
const DAY = 86400000

function shift(date, days) {
  return new Date(new Date(date + 'T00:00:00Z').getTime() + days * DAY).toISOString().slice(0, 10)
}

// Monday of the week a date falls in (SQLite: next Sunday, then back six days)
const WEEK = "date(date, 'weekday 0', '-6 days')"

export async function trends(db, q) {
  const to = q.to
  const from = shift(to, -400)
  const sites = q.sites
  const range = [...sites, from, to]
  const scope = `${inList('site', sites)} AND date >= ? AND date <= ?`
  const leadList = LEAD_EVENTS.map(() => '?').join(',')

  const [ads, organic, leads, visits, kwWeeks, kwTotals, qWeeks, qTotals, firsts] = await Promise.all([
    db
      .prepare(
        `SELECT date, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(spend) AS spend, SUM(conversions) AS conversions
         FROM ads_spend WHERE ${scope} GROUP BY date`
      )
      .bind(...range)
      .all(),
    db
      .prepare(`SELECT date, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM search_queries WHERE ${scope} GROUP BY date`)
      .bind(...range)
      .all(),
    // enquiries the website saw from people who came through an ad
    db
      .prepare(
        `SELECT date, COUNT(DISTINCT visitor_id) AS leads FROM events
         WHERE ${scope} AND source = 'Google Ads' AND name IN (${leadList}) GROUP BY date`
      )
      .bind(...range, ...LEAD_EVENTS)
      .all(),
    db
      .prepare(
        `SELECT date, COUNT(DISTINCT CASE WHEN source = 'Google Ads' THEN visitor_id END) AS ads,
                COUNT(DISTINCT CASE WHEN source = 'Google' THEN visitor_id END) AS organic
         FROM events WHERE ${scope} AND name = 'pageview' GROUP BY date`
      )
      .bind(...range)
      .all(),
    db
      .prepare(
        `SELECT site, keyword, match_type, ${WEEK} AS week, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                SUM(spend) AS spend, SUM(conversions) AS conversions
         FROM ads_keywords WHERE ${scope} GROUP BY site, keyword, match_type, week`
      )
      .bind(...range)
      .all(),
    db
      .prepare(
        `SELECT site, keyword, match_type, MAX(campaign) AS campaign, MAX(ad_group) AS ad_group, MAX(status) AS status,
                MIN(date) AS first, MAX(CASE WHEN clicks > 0 THEN date END) AS last_click
         FROM ads_keywords WHERE ${scope} GROUP BY site, keyword, match_type`
      )
      .bind(...range)
      .all(),
    // search queries: only those Google showed at least a few times, otherwise the list is noise
    db
      .prepare(
        `SELECT s.site, s.query, ${WEEK.replace('date(date', 'date(s.date')} AS week, SUM(s.clicks) AS clicks, SUM(s.impressions) AS impressions,
                SUM(s.position * s.impressions) / NULLIF(SUM(CASE WHEN s.position IS NOT NULL THEN s.impressions END), 0) AS position
         FROM search_queries s
         JOIN (SELECT site, query FROM search_queries WHERE ${scope} GROUP BY site, query
               ORDER BY SUM(clicks) DESC, SUM(impressions) DESC LIMIT 250) t ON t.site = s.site AND t.query = s.query
         WHERE ${inList('s.site', sites)} AND s.date >= ? AND s.date <= ? GROUP BY s.site, s.query, week`
      )
      .bind(...range, ...range)
      .all(),
    db
      .prepare(
        `SELECT site, query, MIN(date) AS first, MAX(CASE WHEN clicks > 0 THEN date END) AS last_click
         FROM search_queries WHERE ${scope} GROUP BY site, query`
      )
      .bind(...range)
      .all(),
    db
      .prepare(
        `SELECT (SELECT MIN(date) FROM ads_spend WHERE ${scope}) AS ads,
                (SELECT MAX(date) FROM ads_spend WHERE ${scope}) AS ads_last,
                (SELECT MIN(date) FROM ads_keywords WHERE ${scope}) AS keywords,
                (SELECT MAX(date) FROM ads_keywords WHERE ${scope}) AS keywords_last,
                (SELECT MIN(date) FROM search_queries WHERE ${scope}) AS organic,
                (SELECT MAX(date) FROM search_queries WHERE ${scope}) AS organic_last,
                (SELECT MIN(date) FROM events WHERE ${scope}) AS website`
      )
      .bind(...range, ...range, ...range, ...range, ...range, ...range, ...range)
      .first()
  ])

  const days = new Map()
  const day = (d) => {
    if (!days.has(d)) days.set(d, { date: d, ads_clicks: 0, ads_impressions: 0, ads_spend: 0, ads_conversions: 0, ads_leads: 0, organic_clicks: 0, organic_impressions: 0, ads_visitors: 0, organic_visitors: 0 })
    return days.get(d)
  }
  for (const r of ads.results) Object.assign(day(r.date), { ads_clicks: r.clicks || 0, ads_impressions: r.impressions || 0, ads_spend: Math.round((r.spend || 0) * 100) / 100, ads_conversions: r.conversions || 0 })
  for (const r of organic.results) Object.assign(day(r.date), { organic_clicks: r.clicks || 0, organic_impressions: r.impressions || 0 })
  for (const r of leads.results) day(r.date).ads_leads = r.leads || 0
  for (const r of visits.results) Object.assign(day(r.date), { ads_visitors: r.ads || 0, organic_visitors: r.organic || 0 })

  const keyOf = (...p) => p.join('\u0001')
  const keywords = new Map()
  for (const r of kwTotals.results) {
    keywords.set(keyOf(r.site, r.keyword, r.match_type), {
      kind: 'ads', site: r.site, keyword: r.keyword, match_type: r.match_type, campaign: r.campaign, ad_group: r.ad_group,
      status: r.status, first: r.first, last_click: r.last_click, weeks: {}
    })
  }
  for (const r of kwWeeks.results) {
    const k = keywords.get(keyOf(r.site, r.keyword, r.match_type))
    if (k) k.weeks[r.week] = [r.clicks || 0, r.impressions || 0, Math.round((r.spend || 0) * 100) / 100, r.conversions || 0]
  }
  const queries = new Map()
  const qMeta = new Map(qTotals.results.map((r) => [keyOf(r.site, r.query), r]))
  for (const r of qWeeks.results) {
    const key = keyOf(r.site, r.query)
    if (!queries.has(key)) {
      const m = qMeta.get(key) || {}
      queries.set(key, { kind: 'organic', site: r.site, keyword: r.query, first: m.first || null, last_click: m.last_click || null, weeks: {} })
    }
    queries.get(key).weeks[r.week] = [r.clicks || 0, r.impressions || 0, r.position === null ? null : Math.round(r.position * 10) / 10]
  }

  return {
    to,
    since: firsts || {},
    daily: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    keywords: [...keywords.values()],
    queries: [...queries.values()]
  }
}
