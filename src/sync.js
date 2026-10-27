// Pulls Google Ads spend and Search Console queries from Windsor.ai.
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

export async function syncAll(env, days = 30) {
  if (!env.WINDSOR_API_KEY) {
    const error = 'WINDSOR_API_KEY ist nicht gesetzt'
    await env.DB.prepare('INSERT INTO sync_log (ts, source, site, rows, error) VALUES (?, ?, ?, ?, ?)')
      .bind(Date.now(), 'windsor', '*', null, error)
      .run()
    return [{ error }]
  }
  const today = localParts(Date.now()).date
  const from = new Date(today + 'T00:00:00Z')
  from.setUTCDate(from.getUTCDate() - (days - 1))
  const dateFrom = from.toISOString().slice(0, 10)

  const { results: sites } = await env.DB.prepare('SELECT * FROM sites').all()
  const log = []
  for (const site of sites) {
    for (const [source, enabled, fn] of [
      ['google_ads', site.ads_account, syncAds],
      ['searchconsole', site.gsc_property, syncSearch]
    ]) {
      if (!enabled) continue
      let entry
      try {
        entry = { source, site: site.domain, rows: await fn(env, site, dateFrom, today) }
      } catch (e) {
        entry = { source, site: site.domain, error: String(e.message || e).slice(0, 500) }
      }
      log.push(entry)
      await env.DB.prepare('INSERT INTO sync_log (ts, source, site, rows, error) VALUES (?, ?, ?, ?, ?)')
        .bind(Date.now(), source, site.domain, entry.rows ?? null, entry.error ?? null)
        .run()
    }
  }
  await env.DB.prepare('DELETE FROM sync_log WHERE ts < ?').bind(Date.now() - 30 * 86400000).run()
  return log
}
