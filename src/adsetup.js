// How each company's Google Ads account is set up: campaigns with budget, bidding,
// targeting and schedule, ad groups with keywords and ads, and the linked assets.
// Paused entities are included, so the setup is visible before anything runs.
import GEO from './geo-de.json'

const DEFAULT_WINDSOR_URL = 'https://connectors.windsor.ai'
const DAYS = 30

async function windsor(env, fields, account, from, to) {
  const params = new URLSearchParams({
    api_key: env.WINDSOR_API_KEY,
    fields: fields.join(','),
    date_from: from,
    date_to: to,
    select_accounts: account,
    include_inactive: 'true'
  })
  const res = await fetch(`${env.WINDSOR_URL || DEFAULT_WINDSOR_URL}/google_ads?${params}`, { headers: { Accept: 'application/json' } })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`Windsor google_ads: HTTP ${res.status}, non-JSON response`)
  }
  if (!res.ok || !Array.isArray(body.data)) throw new Error(`Windsor google_ads: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  return body.data
}

const n = (v) => (typeof v === 'number' ? v : Number(v) || 0)
const split = (s) => (s ? String(s).split(' | ').map((x) => x.trim()).filter(Boolean) : [])
const firstUrl = (v) => {
  if (!v) return null
  try {
    const a = typeof v === 'string' && v.startsWith('[') ? JSON.parse(v) : v
    return Array.isArray(a) ? a[0] || null : String(a)
  } catch {
    return String(v)
  }
}
const geoName = (c) => {
  const id = String(c || '').split('/').pop()
  return { id, name: GEO[id] || 'Ort ' + id }
}
const LANG = { 1001: 'Deutsch', 1000: 'Englisch', 1003: 'Spanisch', 1002: 'Französisch' }

function day(d) {
  return d.toISOString().slice(0, 10)
}

export const ADS_FIELDS = ['campaign', 'campaign_status', 'ad_group_name', 'ad_group_ad_status', 'ad_group_ad_ad_strength', 'ad_group_ad_policy_summary_approval_status',
  'ad_responsive_search_ad_headlines_combined_text', 'ad_responsive_search_ad_descriptions_combined_text', 'ad_group_ad_ad_final_urls',
  'ad_group_ad_ad_responsive_search_ad_path1', 'ad_group_ad_ad_responsive_search_ad_path2']
export const ASSET_FIELDS = ['campaign', 'campaign_status', 'asset_type', 'asset_sitelink_asset_link_text', 'asset_sitelink_asset_description1', 'asset_sitelink_asset_description2',
  'asset_final_urls', 'asset_callout_asset_callout_text', 'asset_structured_snippet_asset_header', 'asset_structured_snippet_asset_values',
  'asset_call_asset_phone_number', 'asset_policy_summary_approval_status']

// ads and assets of paused campaigns are not in Windsor's report API; they can be handed in (imported)
export async function fetchAdSetup(env, account, imported = null) {
  const to = day(new Date())
  const from = day(new Date(Date.now() - (DAYS - 1) * 86400000))
  const [camps, crit, kws, adsLive, assetsLive] = await Promise.all([
    windsor(env, ['campaign_id', 'campaign', 'campaign_status', 'budget_amount', 'bidding_strategy_type', 'campaign_target_spend_cpc_bid_ceiling_micros',
      'campaign_network_settings_target_partner_search_network', 'campaign_network_settings_target_content_network',
      'campaign_geo_target_type_setting_positive_geo_target_type', 'clicks', 'impressions', 'spend', 'conversions'], account, from, to),
    windsor(env, ['campaign', 'campaign_status', 'campaign_criterion_negative', 'campaign_criterion_keyword_text', 'campaign_criterion_keyword_match_type',
      'campaign_criterion_language_language_constant', 'campaign_criterion_proximity_radius', 'campaign_criterion_proximity_radius_units',
      'campaign_criterion_proximity_geo_point_latitude_in_micro_degrees', 'campaign_criterion_proximity_geo_point_longitude_in_micro_degrees',
      'campaign_criterion_location_geo_target_constant', 'campaign_criterion_ad_schedule_day_of_week', 'campaign_criterion_ad_schedule_start_hour',
      'campaign_criterion_ad_schedule_end_hour'], account, from, to),
    windsor(env, ['campaign', 'campaign_status', 'ad_group_name', 'ad_group_status', 'keyword_text', 'ad_group_criterion_keyword_match_type',
      'ad_group_criterion_primary_status'], account, from, to),
    imported && imported.ads ? Promise.resolve([]) : windsor(env, ADS_FIELDS, account, from, to),
    imported && imported.assets ? Promise.resolve([]) : windsor(env, ASSET_FIELDS, account, from, to)
  ])
  const ads = imported && imported.ads ? imported.ads : adsLive
  const assets = imported && imported.assets ? imported.assets : assetsLive

  const live = (r) => r.campaign_status !== 'REMOVED'
  const byName = new Map()
  for (const r of camps.filter(live)) {
    let c = byName.get(r.campaign)
    if (!c) {
      c = {
        id: String(r.campaign_id), name: r.campaign, status: r.campaign_status, budget: n(r.budget_amount), bidding: r.bidding_strategy_type,
        ceiling: r.campaign_target_spend_cpc_bid_ceiling_micros ? n(r.campaign_target_spend_cpc_bid_ceiling_micros) / 1e6 : null,
        partners: !!r.campaign_network_settings_target_partner_search_network, display: !!r.campaign_network_settings_target_content_network,
        presence: r.campaign_geo_target_type_setting_positive_geo_target_type,
        stats: { clicks: 0, impressions: 0, spend: 0, conversions: 0 },
        languages: [], radius: [], places: [], excluded: [], schedule: [], negatives: [],
        sitelinks: [], callouts: [], snippets: [], calls: [], groups: []
      }
      byName.set(r.campaign, c)
    }
    c.stats.clicks += n(r.clicks); c.stats.impressions += n(r.impressions); c.stats.spend += n(r.spend); c.stats.conversions += n(r.conversions)
  }
  const camp = (name) => byName.get(name)
  const seen = new Set()
  const once = (key) => (seen.has(key) ? false : (seen.add(key), true))

  for (const r of crit.filter(live)) {
    const c = camp(r.campaign)
    if (!c) continue
    if (r.campaign_criterion_language_language_constant) {
      const id = String(r.campaign_criterion_language_language_constant).split('/').pop()
      if (once('l' + c.name + id)) c.languages.push(LANG[id] || 'Sprache ' + id)
    }
    if (r.campaign_criterion_proximity_radius) {
      const lat = n(r.campaign_criterion_proximity_geo_point_latitude_in_micro_degrees) / 1e6
      const lng = n(r.campaign_criterion_proximity_geo_point_longitude_in_micro_degrees) / 1e6
      const km = n(r.campaign_criterion_proximity_radius) * (r.campaign_criterion_proximity_radius_units === 'MILES' ? 1.609 : 1)
      if (once('p' + c.name + lat + lng + km)) c.radius.push({ lat, lng, km: Math.round(km * 10) / 10 })
    }
    if (r.campaign_criterion_location_geo_target_constant) {
      const g = geoName(r.campaign_criterion_location_geo_target_constant)
      if (once('g' + c.name + g.id + !!r.campaign_criterion_negative)) (r.campaign_criterion_negative ? c.excluded : c.places).push(g)
    }
    if (r.campaign_criterion_ad_schedule_day_of_week) {
      const s = { day: r.campaign_criterion_ad_schedule_day_of_week, from: n(r.campaign_criterion_ad_schedule_start_hour), to: n(r.campaign_criterion_ad_schedule_end_hour) }
      if (once('s' + c.name + s.day + s.from + s.to)) c.schedule.push(s)
    }
    if (r.campaign_criterion_keyword_text && r.campaign_criterion_negative) {
      if (once('n' + c.name + r.campaign_criterion_keyword_text + r.campaign_criterion_keyword_match_type)) c.negatives.push([r.campaign_criterion_keyword_text, r.campaign_criterion_keyword_match_type])
    }
  }

  const group = (c, name, status) => {
    let g = c.groups.find((x) => x.name === name)
    if (!g) { g = { name, status: status || null, keywords: [], ads: [] }; c.groups.push(g) }
    if (status && !g.status) g.status = status
    return g
  }
  for (const r of kws.filter(live)) {
    const c = camp(r.campaign)
    if (!c || !r.keyword_text) continue
    const g = group(c, r.ad_group_name, r.ad_group_status)
    const k = g.keywords.find((x) => x.text === r.keyword_text && x.match === r.ad_group_criterion_keyword_match_type)
    if (k) { k.clicks += n(r.clicks); k.impressions += n(r.impressions); k.spend += n(r.spend); k.conversions += n(r.conversions); continue }
    g.keywords.push({ text: r.keyword_text, match: r.ad_group_criterion_keyword_match_type, status: r.ad_group_criterion_primary_status || null, clicks: n(r.clicks), impressions: n(r.impressions), spend: n(r.spend), conversions: n(r.conversions) })
  }
  for (const r of ads.filter(live)) {
    const c = camp(r.campaign)
    if (!c) continue
    const g = group(c, r.ad_group_name)
    const ad = {
      status: r.ad_group_ad_status, strength: r.ad_group_ad_ad_strength, approval: r.ad_group_ad_policy_summary_approval_status,
      headlines: split(r.ad_responsive_search_ad_headlines_combined_text), descriptions: split(r.ad_responsive_search_ad_descriptions_combined_text),
      url: firstUrl(r.ad_group_ad_ad_final_urls), path1: r.ad_group_ad_ad_responsive_search_ad_path1 || null, path2: r.ad_group_ad_ad_responsive_search_ad_path2 || null,
      clicks: n(r.clicks), impressions: n(r.impressions)
    }
    const same = g.ads.find((x) => x.url === ad.url && x.headlines.join() === ad.headlines.join())
    if (same) { same.clicks += ad.clicks; same.impressions += ad.impressions } else g.ads.push(ad)
  }
  for (const r of assets.filter(live)) {
    const c = camp(r.campaign)
    if (!c) continue
    const t = r.asset_type
    if (t === 'SITELINK' && r.asset_sitelink_asset_link_text && once('a' + c.name + 'sl' + r.asset_sitelink_asset_link_text))
      c.sitelinks.push({ text: r.asset_sitelink_asset_link_text, d1: r.asset_sitelink_asset_description1 || null, d2: r.asset_sitelink_asset_description2 || null, url: firstUrl(r.asset_final_urls), approval: r.asset_policy_summary_approval_status })
    else if (t === 'CALLOUT' && r.asset_callout_asset_callout_text && once('a' + c.name + 'co' + r.asset_callout_asset_callout_text)) c.callouts.push(r.asset_callout_asset_callout_text)
    else if (t === 'STRUCTURED_SNIPPET' && r.asset_structured_snippet_asset_header) {
      let values = r.asset_structured_snippet_asset_values
      if (typeof values === 'string') {
        try { values = JSON.parse(values) } catch { values = values.split(',') }
      }
      values = Array.isArray(values) ? values.map((v) => String(v).trim()).filter(Boolean) : []
      if (once('a' + c.name + 'sn' + r.asset_structured_snippet_asset_header + values.join())) c.snippets.push({ header: r.asset_structured_snippet_asset_header, values })
    } else if (t === 'CALL' && r.asset_call_asset_phone_number && once('a' + c.name + 'ca' + r.asset_call_asset_phone_number)) c.calls.push(r.asset_call_asset_phone_number)
  }
  const order = { ENABLED: 0, PAUSED: 1 }
  const campaigns = [...byName.values()].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || b.budget - a.budget || a.name.localeCompare(b.name))
  for (const c of campaigns) c.groups.sort((a, b) => a.name.localeCompare(b.name))
  return { from, to, campaigns, ads_source: imported && imported.ads ? 'import' : 'api' }
}

// what the report API cannot see (ads, assets of paused campaigns) is kept from the last snapshot
function carryOver(next, prev) {
  if (!prev) return next
  const old = new Map(prev.campaigns.map((c) => [c.name, c]))
  for (const c of next.campaigns) {
    const o = old.get(c.name)
    if (!o) continue
    for (const g of c.groups) {
      if (g.ads.length) continue
      const og = o.groups.find((x) => x.name === g.name)
      if (og && og.ads.length) { g.ads = og.ads; g.ads_kept = true }
    }
    for (const k of ['sitelinks', 'callouts', 'snippets', 'calls']) if (!c[k].length && o[k] && o[k].length) { c[k] = o[k]; c.assets_kept = true }
  }
  return next
}

export async function syncAdSetup(env, only, imported = null) {
  if (!env.WINDSOR_API_KEY) return [{ error: 'WINDSOR_API_KEY ist nicht gesetzt' }]
  const { results } = await env.DB.prepare('SELECT id, ads_account FROM companies WHERE ads_account IS NOT NULL').all()
  const out = []
  for (const co of results) {
    if (only && co.id !== only) continue
    try {
      const prevRow = await env.DB.prepare('SELECT data FROM ad_setup WHERE company = ?').bind(co.id).first()
      const data = carryOver(await fetchAdSetup(env, co.ads_account, imported), prevRow && prevRow.data ? JSON.parse(prevRow.data) : null)
      await env.DB.prepare('INSERT OR REPLACE INTO ad_setup (company, account, fetched_ts, data, error) VALUES (?, ?, ?, ?, NULL)')
        .bind(co.id, co.ads_account, Date.now(), JSON.stringify(data)).run()
      out.push({ company: co.id, campaigns: data.campaigns.length })
    } catch (e) {
      const error = String(e.message || e).replace(/(api_key=)[A-Za-z0-9_-]+/gi, '$1…').slice(0, 400)
      // keep the last good snapshot, only note the error
      await env.DB.prepare(`INSERT INTO ad_setup (company, account, fetched_ts, data, error) VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT (company) DO UPDATE SET error = excluded.error`).bind(co.id, co.ads_account, Date.now(), error).run()
      out.push({ company: co.id, error })
    }
  }
  return out
}

export async function adSetup(db, own) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.logo_domain, c.ads_account, a.fetched_ts, a.data, a.error
       FROM companies c LEFT JOIN ad_setup a ON a.company = c.id
       WHERE c.ads_account IS NOT NULL ${own ? 'AND c.id = ?' : ''} ORDER BY c.sort, c.name`
    )
    .bind(...(own ? [own] : []))
    .all()
  const since = day(new Date(Date.now() - 89 * 86400000))
  const companies = []
  for (const r of results) {
    const { results: siteRows } = await db.prepare('SELECT domain FROM sites WHERE company = ?').bind(r.id).all()
    const sites = siteRows.map((x) => x.domain)
    companies.push({
      id: r.id, name: r.name, logo: r.logo_domain, account: r.ads_account, fetched_ts: r.fetched_ts || null, error: r.error || null,
      setup: r.data ? JSON.parse(r.data) : null,
      history: sites.length ? await history(db, sites, since) : null
    })
  }
  return { since, companies }
}

// what the old accounts and Google search already tell about these keywords (last 90 days)
async function history(db, sites, since) {
  const inl = `site IN (${sites.map(() => '?').join(',')}) AND date >= ?`
  const b = [...sites, since]
  const [tot, kw, terms, organic] = await Promise.all([
    db.prepare(`SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(spend) AS spend, SUM(conversions) AS conversions, MIN(date) AS first FROM ads_spend WHERE ${inl}`).bind(...b).first(),
    db.prepare(`SELECT LOWER(keyword) AS k, match_type AS m, SUM(clicks) AS c, SUM(impressions) AS i, ROUND(SUM(spend), 2) AS s, SUM(conversions) AS v
                FROM ads_keywords WHERE ${inl} GROUP BY LOWER(keyword), match_type`).bind(...b).all(),
    db.prepare(`SELECT LOWER(term) AS t, SUM(clicks) AS c, SUM(impressions) AS i, ROUND(SUM(spend), 2) AS s, SUM(conversions) AS v
                FROM ads_search_terms WHERE ${inl} GROUP BY LOWER(term) HAVING SUM(clicks) > 0 ORDER BY SUM(spend) DESC LIMIT 400`).bind(...b).all(),
    db.prepare(`SELECT LOWER(query) AS q, SUM(clicks) AS c, SUM(impressions) AS i,
                       ROUND(SUM(position * impressions) / NULLIF(SUM(CASE WHEN position IS NOT NULL THEN impressions END), 0), 1) AS p
                FROM search_queries WHERE ${inl} GROUP BY LOWER(query) HAVING SUM(impressions) >= 10 ORDER BY SUM(impressions) DESC LIMIT 300`).bind(...b).all()
  ])
  return {
    totals: tot && tot.clicks !== null ? tot : null,
    keywords: kw.results.map((x) => [x.k, x.m, x.c || 0, x.i || 0, x.s || 0, x.v || 0]),
    terms: terms.results.map((x) => [x.t, x.c || 0, x.i || 0, x.s || 0, x.v || 0]),
    organic: organic.results.map((x) => [x.q, x.c || 0, x.i || 0, x.p])
  }
}
