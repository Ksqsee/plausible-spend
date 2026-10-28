// Pulls Google Ads, Search Console and Google Business Profile data from Windsor.ai.
// See https://windsor.ai/api-documentation/

import { localParts } from './ingest.js'

const DEFAULT_WINDSOR_URL = 'https://connectors.windsor.ai'

async function windsor(env, connector, fields, account, dateFrom, dateTo) {
  const params = new URLSearchParams({
    api_key: env.WINDSOR_API_KEY,
    fields: fields.join(','),
    date_from: dateFrom,
    date_to: dateTo,
    select_accounts: account
  })
  const base = env.WINDSOR_URL || DEFAULT_WINDSOR_URL
  const res = await fetch(`${base}/${connector}?${params}`, { headers: { Accept: 'application/json' } })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`Windsor ${connector}: HTTP ${res.status}, non-JSON response`)
  }
  if (!res.ok || !Array.isArray(body.data)) {
    throw new Error(`Windsor ${connector}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  }
  return body.data
}

function toDate(value) {
  const s = String(value || '')
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null
}

const num = (v) => (typeof v === 'number' ? v : Number(v) || 0)

async function replaceWindow(db, table, site, dateFrom, statements) {
  const batch = [db.prepare(`DELETE FROM ${table} WHERE site = ? AND date >= ?`).bind(site, dateFrom), ...statements]
  for (let i = 0; i < batch.length; i += 90) await db.batch(batch.slice(i, i + 90))
}

async function syncAds(env, site, dateFrom, dateTo) {
  const rows = await windsor(
    env,
    'google_ads',
    ['date', 'campaign', 'campaign_id', 'spend', 'clicks', 'impressions', 'conversions'],
    site.ads_account,
    dateFrom,
    dateTo
  )
  const merged = new Map()
  for (const r of rows) {
    const date = toDate(r.date)
    if (!date || !r.campaign) continue
    const key = `${date}|${r.campaign_id || ''}|${r.campaign}`
    const prev = merged.get(key) || { date, campaign_id: String(r.campaign_id || ''), campaign: r.campaign, spend: 0, clicks: 0, impressions: 0, conversions: 0 }
    prev.spend += num(r.spend)
    prev.clicks += num(r.clicks)
    prev.impressions += num(r.impressions)
    prev.conversions += num(r.conversions)
    merged.set(key, prev)
  }
  const statements = [...merged.values()].map((r) =>
    env.DB.prepare(
      'INSERT INTO ads_spend (site, date, campaign_id, campaign, spend, clicks, impressions, conversions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(site.domain, r.date, r.campaign_id, r.campaign, Math.round(r.spend * 100) / 100, r.clicks, r.impressions, r.conversions)
  )
  await replaceWindow(env.DB, 'ads_spend', site.domain, dateFrom, statements)
  return statements.length
}

async function syncSearch(env, site, dateFrom, dateTo) {
  const rows = await windsor(
    env,
    'searchconsole',
    ['date', 'query', 'clicks', 'impressions', 'position'],
    site.gsc_property,
    dateFrom,
    dateTo
  )
  const statements = []
  const seen = new Set()
  for (const r of rows) {
    const date = toDate(r.date)
    if (!date || !r.query) continue
    const key = `${date}|${r.query}`
    if (seen.has(key)) continue
    seen.add(key)
    statements.push(
      env.DB.prepare(
        'INSERT INTO search_queries (site, date, query, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(site.domain, date, String(r.query).slice(0, 300), num(r.clicks), num(r.impressions), num(r.position))
    )
  }
  await replaceWindow(env.DB, 'search_queries', site.domain, dateFrom, statements)
  return statements.length
}

// Keyword level Ads data. The quality score is a snapshot, so it is fetched per day and the latest wins.
async function syncKeywords(env, site, dateFrom, dateTo) {
  const rows = await windsor(
    env,
    'google_ads',
    ['date', 'campaign', 'ad_group_name', 'keyword_text', 'keyword_match_type', 'keyword_status', 'quality_score', 'clicks', 'impressions', 'spend', 'conversions'],
    site.ads_account,
    dateFrom,
    dateTo
  )
  const merged = new Map()
  for (const r of rows) {
    const date = toDate(r.date)
    if (!date || !r.keyword_text) continue
    const key = [date, r.campaign, r.ad_group_name, r.keyword_text, r.keyword_match_type].join('|')
    const prev = merged.get(key) || {
      date, campaign: String(r.campaign || ''), ad_group: String(r.ad_group_name || ''), keyword: String(r.keyword_text).slice(0, 200),
      match_type: String(r.keyword_match_type || ''), status: r.keyword_status || null, quality_score: null, clicks: 0, impressions: 0, spend: 0, conversions: 0
    }
    const qs = num(r.quality_score)
    if (qs > 0 && qs <= 10) prev.quality_score = qs
    prev.clicks += num(r.clicks)
    prev.impressions += num(r.impressions)
    prev.spend += num(r.spend)
    prev.conversions += num(r.conversions)
    merged.set(key, prev)
  }
  const statements = [...merged.values()].map((r) =>
    env.DB.prepare(
      'INSERT INTO ads_keywords (site, date, campaign, ad_group, keyword, match_type, status, quality_score, clicks, impressions, spend, conversions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(site.domain, r.date, r.campaign, r.ad_group, r.keyword, r.match_type, r.status, r.quality_score, r.clicks, r.impressions, Math.round(r.spend * 100) / 100, r.conversions)
  )
  await replaceWindow(env.DB, 'ads_keywords', site.domain, dateFrom, statements)
  return statements.length
}

async function syncSearchTerms(env, site, dateFrom, dateTo) {
  const rows = await windsor(
    env,
    'google_ads',
    ['date', 'campaign', 'search_term', 'search_term_view_status', 'clicks', 'impressions', 'spend', 'conversions'],
    site.ads_account,
    dateFrom,
    dateTo
  )
  const merged = new Map()
  for (const r of rows) {
    const date = toDate(r.date)
    if (!date || !r.search_term) continue
    // Terms that never got a click are noise for the decisions made here and cost D1 writes.
    if (!num(r.clicks) && !num(r.spend)) continue
    const key = [date, r.campaign, r.search_term].join('|')
    const prev = merged.get(key) || { date, campaign: String(r.campaign || ''), term: String(r.search_term).slice(0, 200), status: r.search_term_view_status || null, clicks: 0, impressions: 0, spend: 0, conversions: 0 }
    prev.clicks += num(r.clicks)
    prev.impressions += num(r.impressions)
    prev.spend += num(r.spend)
    prev.conversions += num(r.conversions)
    merged.set(key, prev)
  }
  const statements = [...merged.values()].map((r) =>
    env.DB.prepare(
      'INSERT INTO ads_search_terms (site, date, campaign, term, status, clicks, impressions, spend, conversions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(site.domain, r.date, r.campaign, r.term, r.status, r.clicks, r.impressions, Math.round(r.spend * 100) / 100, r.conversions)
  )
  await replaceWindow(env.DB, 'ads_search_terms', site.domain, dateFrom, statements)
  return statements.length
}

const SEGMENTS = [
  ['hour', 'hour_of_day'],
  ['device', 'device'],
  ['url', 'final_url']
]

async function syncSegments(env, site, dateFrom, dateTo) {
  const statements = []
  for (const [kind, field] of SEGMENTS) {
    const rows = await windsor(env, 'google_ads', ['date', field, 'clicks', 'spend', 'conversions'], site.ads_account, dateFrom, dateTo)
    const merged = new Map()
    for (const r of rows) {
      const date = toDate(r.date)
      const raw = r[field]
      if (!date || raw === null || raw === undefined || raw === '') continue
      const key = kind === 'hour' ? String(Math.round(num(raw))) : String(raw).slice(0, 300)
      if (!num(r.clicks) && !num(r.spend)) continue
      const id = date + '|' + key
      const prev = merged.get(id) || { date, key, clicks: 0, spend: 0, conversions: 0 }
      prev.clicks += num(r.clicks)
      prev.spend += num(r.spend)
      prev.conversions += num(r.conversions)
      merged.set(id, prev)
    }
    for (const r of merged.values()) {
      statements.push(
        env.DB.prepare('INSERT INTO ads_segments (site, date, kind, key, clicks, spend, conversions) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
          site.domain, r.date, kind, r.key, r.clicks, Math.round(r.spend * 100) / 100, r.conversions
        )
      )
    }
  }
  await replaceWindow(env.DB, 'ads_segments', site.domain, dateFrom, statements)
  return statements.length
}

async function syncShare(env, site, dateFrom, dateTo) {
  const rows = await windsor(
    env,
    'google_ads',
    ['date', 'campaign', 'impressions', 'search_impression_share', 'search_top_impression_share', 'search_budget_lost_impression_share', 'search_rank_lost_impression_share'],
    site.ads_account,
    dateFrom,
    dateTo
  )
  const seen = new Set()
  const share = (v) => (v === null || v === undefined || v === '' ? null : Math.min(1, Math.max(0, num(v))))
  const statements = []
  for (const r of rows) {
    const date = toDate(r.date)
    if (!date || !r.campaign || !num(r.impressions)) continue
    const key = date + '|' + r.campaign
    if (seen.has(key)) continue
    seen.add(key)
    statements.push(
      env.DB.prepare(
        'INSERT INTO ads_share (site, date, campaign, impression_share, top_share, lost_budget, lost_rank, impressions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(site.domain, date, String(r.campaign), share(r.search_impression_share), share(r.search_top_impression_share),
        share(r.search_budget_lost_impression_share), share(r.search_rank_lost_impression_share), num(r.impressions))
    )
  }
  await replaceWindow(env.DB, 'ads_share', site.domain, dateFrom, statements)
  return statements.length
}

async function syncSearchPages(env, site, dateFrom, dateTo) {
  const rows = await windsor(env, 'searchconsole', ['date', 'query', 'page', 'clicks', 'impressions', 'position'], site.gsc_property, dateFrom, dateTo)
  const statements = []
  const seen = new Set()
  for (const r of rows) {
    const date = toDate(r.date)
    if (!date || !r.query || !r.page) continue
    const key = `${date}|${r.query}|${r.page}`
    if (seen.has(key)) continue
    seen.add(key)
    statements.push(
      env.DB.prepare('INSERT INTO search_pages (site, date, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        site.domain, date, String(r.query).slice(0, 300), String(r.page).slice(0, 300), num(r.clicks), num(r.impressions), num(r.position)
      )
    )
  }
  await replaceWindow(env.DB, 'search_pages', site.domain, dateFrom, statements)
  return statements.length
}

async function syncGbp(env, location, dateFrom, dateTo) {
  const db = env.DB
  const daily = await windsor(
    env,
    'google_my_business',
    ['date', 'impressions_mobile_maps', 'impressions_desktop_maps', 'impressions_mobile_search', 'impressions_desktop_search', 'call_clicks', 'website_clicks', 'direction_requests'],
    location.location,
    dateFrom,
    dateTo
  )
  const byDate = new Map()
  for (const r of daily) {
    const date = toDate(r.date)
    if (!date) continue
    const prev = byDate.get(date) || { maps: 0, search: 0, calls: 0, web: 0, dir: 0 }
    prev.maps += num(r.impressions_mobile_maps) + num(r.impressions_desktop_maps)
    prev.search += num(r.impressions_mobile_search) + num(r.impressions_desktop_search)
    prev.calls += num(r.call_clicks)
    prev.web += num(r.website_clicks)
    prev.dir += num(r.direction_requests)
    byDate.set(date, prev)
  }
  const statements = [db.prepare('DELETE FROM gbp_daily WHERE location = ? AND date >= ?').bind(location.location, dateFrom)]
  for (const [date, r] of byDate) {
    statements.push(
      db.prepare(
        'INSERT INTO gbp_daily (location, date, impressions_maps, impressions_search, calls, website_clicks, directions) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(location.location, date, r.maps, r.search, r.calls, r.web, r.dir)
    )
  }

  // Keywords are monthly, reviews are a running total: both are replaced as a whole.
  const keywords = await windsor(env, 'google_my_business', ['search_keyword', 'search_keyword_value', 'search_keyword_threshold'], location.location, dateFrom, dateTo)
  statements.push(db.prepare('DELETE FROM gbp_keywords WHERE location = ?').bind(location.location))
  const seen = new Set()
  for (const r of keywords) {
    const kw = String(r.search_keyword || '').trim().toLowerCase().slice(0, 200)
    if (!kw || seen.has(kw)) continue
    seen.add(kw)
    statements.push(
      db.prepare('INSERT INTO gbp_keywords (location, keyword, value, threshold) VALUES (?, ?, ?, ?)').bind(
        location.location, kw, r.search_keyword_value === null || r.search_keyword_value === undefined ? null : num(r.search_keyword_value),
        r.search_keyword_threshold === null || r.search_keyword_threshold === undefined ? null : num(r.search_keyword_threshold)
      )
    )
  }
  const reviews = await windsor(env, 'google_my_business', ['review_total_count', 'review_average_rating_total'], location.location, dateFrom, dateTo)
  const rev = reviews.find((r) => r.review_total_count !== null && r.review_total_count !== undefined)
  if (rev) {
    statements.push(
      db.prepare('INSERT OR REPLACE INTO gbp_reviews (location, count, rating, updated_ts) VALUES (?, ?, ?, ?)').bind(
        location.location, num(rev.review_total_count), rev.review_average_rating_total === null ? null : num(rev.review_average_rating_total), Date.now()
      )
    )
  }
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90))
  return byDate.size + seen.size
}

function startDate(today, days) {
  const from = new Date(today + 'T00:00:00Z')
  from.setUTCDate(from.getUTCDate() - (days - 1))
  return from.toISOString().slice(0, 10)
}

async function logSync(env, entry) {
  await env.DB.prepare('INSERT INTO sync_log (ts, source, site, rows, error) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), entry.source, entry.site, entry.rows ?? null, entry.error ?? null)
    .run()
}

async function run(env, log, source, site, fn) {
  let entry
  try {
    entry = { source, site, rows: await fn() }
  } catch (e) {
    // never keep a key that an upstream error might echo back
    entry = { source, site, error: String(e.message || e).replace(/(api_key=|key["':= ]+)[A-Za-z0-9_-]+/gi, '$1…').slice(0, 500) }
  }
  log.push(entry)
  await logSync(env, entry)
}

// days: window for spend, queries and GBP. detailDays: window for keyword level tables,
// which are larger; the scheduled run keeps it short to stay well inside D1 write limits.
export async function syncAll(env, days = 30, detailDays = days) {
  if (!env.WINDSOR_API_KEY) {
    const error = 'WINDSOR_API_KEY ist nicht gesetzt'
    await logSync(env, { source: 'windsor', site: '*', error })
    return [{ error }]
  }
  const today = localParts(Date.now()).date
  const dateFrom = startDate(today, days)
  const detailFrom = startDate(today, detailDays)

  const { results: sites } = await env.DB.prepare('SELECT * FROM sites').all()
  const log = []
  for (const site of sites) {
    if (site.ads_account) {
      await run(env, log, 'google_ads', site.domain, () => syncAds(env, site, dateFrom, today))
      if (detailDays > 0) {
        await run(env, log, 'ads_keywords', site.domain, () => syncKeywords(env, site, detailFrom, today))
        await run(env, log, 'ads_search_terms', site.domain, () => syncSearchTerms(env, site, detailFrom, today))
        await run(env, log, 'ads_segments', site.domain, () => syncSegments(env, site, detailFrom, today))
        await run(env, log, 'ads_share', site.domain, () => syncShare(env, site, detailFrom, today))
      }
    }
    if (site.gsc_property) {
      await run(env, log, 'searchconsole', site.domain, () => syncSearch(env, site, dateFrom, today))
      if (detailDays > 0) await run(env, log, 'search_pages', site.domain, () => syncSearchPages(env, site, detailFrom, today))
    }
  }
  const { results: locations } = await env.DB.prepare('SELECT * FROM gbp_locations').all()
  for (const location of locations) {
    await run(env, log, 'gbp', location.name, () => syncGbp(env, location, dateFrom, today))
  }
  await env.DB.prepare('DELETE FROM sync_log WHERE ts < ?').bind(Date.now() - 30 * 86400000).run()
  return log
}
