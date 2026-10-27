// Read-side queries for the dashboard.

export const LEAD_EVENTS = ['Phone click', 'Email click', 'WhatsApp click', 'Form submit']

// Dimensions that can be filtered on and broken down, mapped to event columns.
const DIMENSIONS = {
  page: 'page',
  source: 'source',
  referrer: 'referrer',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_content: 'utm_content',
  utm_term: 'utm_term',
  country: 'country',
  region: 'region',
  city: 'city',
  device: 'device',
  browser: 'browser',
  os: 'os',
  event: 'name',
  label: 'label',
  hostname: 'hostname',
  site: 'site'
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export class BadRequest extends Error {}

// Resolves ?scope=all, ?scope=company:<id> or ?site=<domain> to a list of site domains.
export async function resolveSites(db, url) {
  const p = url.searchParams
  const scope = p.get('scope')
  const site = p.get('site')
  let rows
  if (scope === 'all') {
    rows = (await db.prepare('SELECT domain FROM sites').all()).results
  } else if (scope && scope.startsWith('company:')) {
    rows = (await db.prepare('SELECT domain FROM sites WHERE company = ?').bind(scope.slice(8)).all()).results
  } else if (site) {
    rows = (await db.prepare('SELECT domain FROM sites WHERE domain = ?').bind(site).all()).results
  } else {
    throw new BadRequest('scope or site is required')
  }
  if (!rows.length) throw new BadRequest('unknown site or company')
  return rows.map((r) => r.domain)
}

export function parseQuery(url, sites) {
  const p = url.searchParams
  const from = p.get('from')
  const to = p.get('to')
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
    throw new BadRequest('from and to (YYYY-MM-DD) are required')
  }
  let filters = []
  if (p.get('filters')) {
    try {
      filters = JSON.parse(p.get('filters'))
    } catch {
      throw new BadRequest('filters must be JSON')
    }
  }
  if (!Array.isArray(filters)) throw new BadRequest('filters must be a list')
  filters = filters.map((f) => {
    if (!Array.isArray(f) || !DIMENSIONS[f[0]] || typeof f[1] !== 'string') throw new BadRequest('invalid filter')
    return [f[0], f[1]]
  })
  return { sites, from, to, filters }
}

const inList = (sites) => `site IN (${sites.map(() => '?').join(',')})`

export function where(q, { pageviewsOnly = false, range = [q.from, q.to] } = {}) {
  const clauses = [inList(q.sites), 'date >= ?', 'date <= ?']
  const params = [...q.sites, range[0], range[1]]
  for (const [dim, value] of q.filters) {
    if (value === '(none)') {
      clauses.push(`${DIMENSIONS[dim]} IS NULL`)
    } else {
      clauses.push(`${DIMENSIONS[dim]} = ?`)
      params.push(value)
    }
  }
  if (pageviewsOnly) clauses.push("name = 'pageview'")
  return { sql: clauses.join(' AND '), params }
}

function previousRange(q) {
  const from = new Date(q.from + 'T00:00:00Z')
  const to = new Date(q.to + 'T00:00:00Z')
  const days = Math.round((to - from) / 86400000) + 1
  const prevTo = new Date(from.getTime() - 86400000)
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000)
  return [prevFrom.toISOString().slice(0, 10), prevTo.toISOString().slice(0, 10)]
}

async function totals(db, q, range) {
  const w = where(q, { range })
  const leadList = LEAD_EVENTS.map(() => '?').join(',')
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT session_id) AS visits,
              SUM(name = 'pageview') AS pageviews,
              COUNT(DISTINCT CASE WHEN name IN (${leadList}) THEN visitor_id END) AS leads
       FROM events WHERE ${w.sql}`
    )
    .bind(...LEAD_EVENTS, ...w.params)
    .first()
  const s = await db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              SUM(pageviews <= 1) AS bounces,
              AVG((last_ts - start_ts) / 1000.0) AS duration
       FROM sessions WHERE id IN (SELECT DISTINCT session_id FROM events WHERE ${w.sql})`
    )
    .bind(...w.params)
    .first()
  const visits = row.visits || 0
  return {
    visitors: row.visitors || 0,
    visits,
    pageviews: row.pageviews || 0,
    views_per_visit: visits ? Math.round(((row.pageviews || 0) / visits) * 100) / 100 : 0,
    bounce_rate: s.sessions ? Math.round((s.bounces / s.sessions) * 100) : 0,
    visit_duration: Math.round(s.duration || 0),
    leads: row.leads || 0
  }
}

export async function overview(db, q) {
  const [current, previous] = await Promise.all([totals(db, q, [q.from, q.to]), totals(db, q, previousRange(q))])
  return { current, previous }
}

export async function timeseries(db, q) {
  const w = where(q)
  const byHour = q.from === q.to
  const bucket = byHour ? 'hour' : 'date'
  const { results } = await db
    .prepare(
      `SELECT ${bucket} AS bucket, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS visits,
              SUM(name = 'pageview') AS pageviews
       FROM events WHERE ${w.sql} GROUP BY ${bucket} ORDER BY ${bucket}`
    )
    .bind(...w.params)
    .all()
  return { interval: byHour ? 'hour' : 'day', results }
}

export async function breakdown(db, q, dim, limit = 50) {
  if (dim === 'entry_page' || dim === 'exit_page') {
    const w = where(q)
    const { results } = await db
      .prepare(
        `SELECT ${dim} AS name, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS visits
         FROM sessions WHERE id IN (SELECT DISTINCT session_id FROM events WHERE ${w.sql})
         GROUP BY ${dim} ORDER BY visitors DESC LIMIT ?`
      )
      .bind(...w.params, limit)
      .all()
    return results
  }

  const column = DIMENSIONS[dim]
  if (!column) throw new BadRequest('unknown dimension')

  if (dim === 'event' || dim === 'label') {
    const w = where(q)
    const { results } = await db
      .prepare(
        `SELECT ${column} AS name, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS events
         FROM events WHERE ${w.sql} AND name NOT IN ('pageview', 'Engagement', 'Form step')
         GROUP BY ${column} ORDER BY visitors DESC, events DESC LIMIT ?`
      )
      .bind(...w.params, limit)
      .all()
    return results
  }

  const w = where(q, { pageviewsOnly: dim === 'page' })
  // cities and regions carry their country so the dashboard can show a flag
  const country = dim === 'city' || dim === 'region' ? ', MAX(country) AS country' : ''
  const { results } = await db
    .prepare(
      `SELECT ${column} AS name, COUNT(DISTINCT visitor_id) AS visitors, SUM(name = 'pageview') AS pageviews${country}
       FROM events WHERE ${w.sql}
       GROUP BY ${column} ORDER BY visitors DESC, pageviews DESC LIMIT ?`
    )
    .bind(...w.params, limit)
    .all()
  return results
}

// Visitors per site for the overview page, with a daily series for sparklines.
export async function sitesSummary(db, from, to) {
  const q = { from, to }
  const prev = previousRange(q)
  const leadList = LEAD_EVENTS.map(() => '?').join(',')
  const totalsSql = `SELECT site, COUNT(DISTINCT visitor_id) AS visitors, SUM(name = 'pageview') AS pageviews,
          COUNT(DISTINCT CASE WHEN name IN (${leadList}) THEN visitor_id END) AS leads
     FROM events WHERE date >= ? AND date <= ? GROUP BY site`
  const [sites, current, previous, daily, spend, live] = await Promise.all([
    db.prepare('SELECT domain, name FROM sites ORDER BY name').all(),
    db.prepare(totalsSql).bind(...LEAD_EVENTS, from, to).all(),
    db.prepare(totalsSql).bind(...LEAD_EVENTS, prev[0], prev[1]).all(),
    db
      .prepare(
        `SELECT site, date, COUNT(DISTINCT visitor_id) AS visitors FROM events
         WHERE date >= ? AND date <= ? GROUP BY site, date`
      )
      .bind(from, to)
      .all(),
    db
      .prepare('SELECT site, SUM(spend) AS spend FROM ads_spend WHERE date >= ? AND date <= ? GROUP BY site')
      .bind(from, to)
      .all(),
    db
      .prepare('SELECT site, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE ts > ? GROUP BY site')
      .bind(Date.now() - 5 * 60 * 1000)
      .all()
  ])
  const bySite = (rows) => new Map(rows.results.map((r) => [r.site, r]))
  const cur = bySite(current)
  const prv = bySite(previous)
  const spendBySite = bySite(spend)
  const liveBySite = bySite(live)
  const series = new Map()
  for (const r of daily.results) {
    if (!series.has(r.site)) series.set(r.site, {})
    series.get(r.site)[r.date] = r.visitors
  }
  return sites.results.map((s) => {
    const c = cur.get(s.domain) || {}
    const p = prv.get(s.domain) || {}
    return {
      domain: s.domain,
      name: s.name,
      visitors: c.visitors || 0,
      previous_visitors: p.visitors || 0,
      pageviews: c.pageviews || 0,
      leads: c.leads || 0,
      spend: Math.round(((spendBySite.get(s.domain) || {}).spend || 0) * 100) / 100,
      live: (liveBySite.get(s.domain) || {}).visitors || 0,
      daily: series.get(s.domain) || {}
    }
  })
}

export async function realtime(db, sites) {
  const row = await db
    .prepare(`SELECT COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE ${inList(sites)} AND ts > ?`)
    .bind(...sites, Date.now() - 5 * 60 * 1000)
    .first()
  return { visitors: row.visitors || 0 }
}

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

export async function ads(db, q) {
  const { results: campaigns } = await db
    .prepare(
      `SELECT campaign_id, campaign, SUM(spend) AS spend, SUM(clicks) AS clicks,
              SUM(impressions) AS impressions, SUM(conversions) AS conversions
       FROM ads_spend WHERE ${inList(q.sites)} AND date >= ? AND date <= ?
       GROUP BY campaign_id, campaign ORDER BY spend DESC`
    )
    .bind(...q.sites, q.from, q.to)
    .all()

  const w = where(q)
  const leadList = LEAD_EVENTS.map(() => '?').join(',')
  const { results: byCampaign } = await db
    .prepare(
      `SELECT utm_campaign, COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT CASE WHEN name IN (${leadList}) THEN visitor_id END) AS leads
       FROM events WHERE ${w.sql} AND source = 'Google Ads' GROUP BY utm_campaign`
    )
    .bind(...LEAD_EVENTS, ...w.params)
    .all()

  const visitorsByKey = new Map()
  let adVisitors = 0
  let adLeads = 0
  for (const r of byCampaign) {
    adVisitors += r.visitors
    adLeads += r.leads
    if (r.utm_campaign) {
      const key = normalize(r.utm_campaign)
      const prev = visitorsByKey.get(key) || { visitors: 0, leads: 0 }
      visitorsByKey.set(key, { visitors: prev.visitors + r.visitors, leads: prev.leads + r.leads })
    }
  }

  const rows = campaigns.map((c) => {
    const match = visitorsByKey.get(normalize(c.campaign)) || visitorsByKey.get(normalize(c.campaign_id))
    const spend = Math.round(c.spend * 100) / 100
    return {
      campaign: c.campaign,
      campaign_id: c.campaign_id,
      spend,
      clicks: c.clicks,
      impressions: c.impressions,
      conversions: Math.round(c.conversions * 10) / 10,
      visitors: match ? match.visitors : null,
      leads: match ? match.leads : null,
      cost_per_lead: match && match.leads ? Math.round((spend / match.leads) * 100) / 100 : null
    }
  })

  const spend = Math.round(rows.reduce((a, r) => a + r.spend, 0) * 100) / 100
  const conversions = rows.reduce((a, r) => a + r.conversions, 0)
  return {
    results: rows,
    totals: {
      spend,
      clicks: rows.reduce((a, r) => a + r.clicks, 0),
      impressions: rows.reduce((a, r) => a + r.impressions, 0),
      conversions: Math.round(conversions * 10) / 10,
      cost_per_conversion: conversions ? Math.round((spend / conversions) * 100) / 100 : null,
      visitors: adVisitors,
      leads: adLeads,
      cost_per_lead: adLeads ? Math.round((spend / adLeads) * 100) / 100 : null
    }
  }
}

function shiftDays(date, days) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Google delivers Search Console and Business Profile data with a few days' delay. When the
// chosen period has none yet, the latest 30 days that do have data are shown instead.
export async function latestWindow(db, table, column, ids, before, hasData = '1') {
  const row = await db
    .prepare(`SELECT MAX(date) AS latest FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(',')}) AND date <= ? AND ${hasData}`)
    .bind(...ids, before)
    .first()
  return row && row.latest ? { from: shiftDays(row.latest, -29), to: row.latest } : null
}

export async function search(db, q, limit = 100) {
  const result = await searchRange(db, q, limit)
  if (result.results.length) return result
  const window = await latestWindow(db, 'search_queries', 'site', q.sites, q.to)
  if (!window) return result
  return { ...(await searchRange(db, { ...q, ...window }, limit)), fallback: window }
}

async function searchRange(db, q, limit) {
  const { results } = await db
    .prepare(
      `SELECT query AS name, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
              SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS position
       FROM search_queries WHERE ${inList(q.sites)} AND date >= ? AND date <= ?
       GROUP BY query ORDER BY impressions DESC, clicks DESC LIMIT ?`
    )
    .bind(...q.sites, q.from, q.to, limit)
    .all()
  const totals = await db
    .prepare(
      `SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions,
              SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS position,
              MAX(date) AS latest
       FROM search_queries WHERE ${inList(q.sites)} AND date >= ? AND date <= ?`
    )
    .bind(...q.sites, q.from, q.to)
    .first()
  const round = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10)
  return {
    results: results.map((r) => ({ ...r, position: round(r.position) })),
    totals: {
      clicks: totals.clicks || 0,
      impressions: totals.impressions || 0,
      position: round(totals.position),
      latest: totals.latest
    }
  }
}
