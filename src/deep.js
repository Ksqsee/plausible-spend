// Deeper read-side views: leads, funnels, forms, content, keyword level Ads, Business Profile,
// and the opportunities that come from putting those sources side by side.

import { LEAD_EVENTS, where } from './stats.js'

const inList = (col, list) => `${col} IN (${list.map(() => '?').join(',')})`
const round = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d)
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

// Pages that are never a service page in a funnel.
const GENERIC_PAGE = /^\/(|impressum|datenschutz|agb|karriere.*|kontakt|ueber-uns|referenzen|anfrage)$/

async function siteRows(db, sites) {
  const { results } = await db
    .prepare(
      `SELECT s.domain, s.name, s.company, s.ads_account, s.gsc_property, s.config, c.name AS company_name
       FROM sites s LEFT JOIN companies c ON c.id = s.company WHERE ${inList('s.domain', sites)}`
    )
    .bind(...sites)
    .all()
  return results.map((r) => ({ ...r, config: parse(r.config) || {} }))
}

// ---------------------------------------------------------------------------------------------
// Leads: every form lead and contact click, with the visit that produced it.

export async function leads(db, q, limit = 60) {
  const w = where(q)
  const names = [...LEAD_EVENTS, 'Application']
  const { results } = await db
    .prepare(
      `SELECT e.ts, e.site, e.name, e.label, e.props, e.page, e.source, e.utm_campaign, e.utm_term, e.device, e.city,
              s.entry_page, s.pageviews, (s.last_ts - s.start_ts) / 1000 AS duration
       FROM (SELECT * FROM events WHERE ${w.sql} AND name IN (${names.map(() => '?').join(',')}) ORDER BY ts DESC LIMIT ?) e
       LEFT JOIN sessions s ON s.id = e.session_id
       ORDER BY e.ts DESC`
    )
    .bind(...w.params, ...names, limit)
    .all()

  const [{ results: submits }, { results: types }] = await Promise.all([
    db.prepare(`SELECT props FROM events WHERE ${w.sql} AND name = 'Form submit' ORDER BY ts DESC LIMIT 1000`).bind(...w.params).all(),
    db.prepare(`SELECT name, COUNT(*) AS n FROM events WHERE ${w.sql} AND name IN (${names.map(() => '?').join(',')}) GROUP BY name`).bind(...w.params, ...names).all()
  ])
  const choiceCounts = {}
  const byType = Object.fromEntries(types.map((t) => [t.name, t.n]))
  for (const sub of submits) {
    const props = parse(sub.props) || {}
    for (const [k, v] of Object.entries(props.c || {})) {
      for (const part of String(v).split(/,\s*/)) {
        if (!part) continue
        const key = k + '\u0000' + part
        choiceCounts[key] = (choiceCounts[key] || 0) + 1
      }
    }
  }
  const rows = results.map((r) => {
    const props = parse(r.props) || {}
    return {
      ts: r.ts,
      site: r.site,
      type: r.name,
      label: r.label,
      choices: props.c || null,
      section: props.section || null,
      page: r.page,
      entry_page: r.entry_page,
      source: r.source,
      campaign: r.utm_campaign,
      keyword: r.utm_term,
      device: r.device,
      city: r.city,
      pageviews: r.pageviews,
      duration: r.duration
    }
  })
  const choices = Object.entries(choiceCounts)
    .map(([k, n]) => {
      const [question, answer] = k.split('\u0000')
      return { question, answer, leads: n }
    })
    .sort((a, b) => b.leads - a.leads)
    .slice(0, 30)
  return { results: rows, by_type: byType, choices }
}

// ---------------------------------------------------------------------------------------------
// Funnel: the steps come from the site's config; several sites use a shared default.

const DEFAULT_FUNNEL = [
  { label: 'Besuch', type: 'visit' },
  { label: 'Anfrage-Bereich gesehen', type: 'section', value: 'anfrage' },
  { label: 'Formular begonnen', type: 'event', value: 'Form start' },
  { label: 'Anfrage gesendet', type: 'event', value: 'Form submit' }
]

async function sessionFacts(db, q) {
  const w = where(q)
  const { results } = await db
    .prepare(
      `SELECT session_id, name, page, label, props FROM events
       WHERE ${w.sql} AND name IN ('pageview', 'Engagement', 'Form start', 'Form step', 'FAQ open', ${LEAD_EVENTS.map(() => '?').join(',')})`
    )
    .bind(...w.params, ...LEAD_EVENTS)
    .all()
  const sessions = new Map()
  for (const r of results) {
    let s = sessions.get(r.session_id)
    if (!s) {
      s = { pages: new Set(), sections: new Set(), events: new Set(), steps: new Set(), lead: false }
      sessions.set(r.session_id, s)
    }
    const props = parse(r.props) || {}
    if (r.name === 'pageview') s.pages.add(r.page)
    if (r.name === 'Engagement') for (const id of props.sec || []) s.sections.add(id)
    if (props.section) s.sections.add(props.section)
    if (r.name === 'Form start' && r.label) s.sections.add(r.label)
    if (r.name === 'Form step') s.steps.add(r.label)
    if (LEAD_EVENTS.includes(r.name)) s.lead = true
    s.events.add(r.name)
  }
  return sessions
}

function matches(step, s) {
  switch (step.type) {
    case 'visit':
      return true
    case 'page':
      return s.pages.has(step.value)
    case 'service_page':
      return [...s.pages].some((p) => !GENERIC_PAGE.test(p))
    case 'section':
      return s.sections.has(step.value)
    case 'event':
      return s.events.has(step.value)
    case 'lead':
      return s.lead
    default:
      return false
  }
}

export async function funnel(db, q) {
  const sites = await siteRows(db, q.sites)
  const steps = (sites.length === 1 && sites[0].config.funnel) || DEFAULT_FUNNEL
  const sessions = await sessionFacts(db, q)
  const counts = steps.map(() => 0)
  for (const s of sessions.values()) {
    for (let i = 0; i < steps.length; i++) {
      if (!matches(steps[i], s)) break
      counts[i]++
    }
  }
  return {
    steps: steps.map((st, i) => ({
      label: st.label,
      sessions: counts[i],
      rate: counts[0] ? round((counts[i] / counts[0]) * 100, 1) : 0,
      drop: i && counts[i - 1] ? round(100 - (counts[i] / counts[i - 1]) * 100, 1) : null
    }))
  }
}

// ---------------------------------------------------------------------------------------------
// Forms: starts, steps reached and leads per form.

export async function forms(db, q) {
  const w = where(q)
  const { results } = await db
    .prepare(
      `SELECT name, label, props, COUNT(DISTINCT session_id) AS sessions FROM events
       WHERE ${w.sql} AND name IN ('Form start', 'Form step', 'Form submit', 'Application start', 'Application')
       GROUP BY name, label, props`
    )
    .bind(...w.params)
    .all()
  const byForm = new Map()
  const get = (key) => {
    if (!byForm.has(key)) byForm.set(key, { form: key, starts: 0, steps: {}, leads: 0, applications: 0, application_starts: 0 })
    return byForm.get(key)
  }
  for (const r of results) {
    const props = parse(r.props) || {}
    if (r.name === 'Form start') get(r.label || 'form').starts += r.sessions
    else if (r.name === 'Application start') get(r.label || 'form').application_starts += r.sessions
    else if (r.name === 'Form submit') get(r.label || 'form').leads += r.sessions
    else if (r.name === 'Application') get(r.label || 'form').applications += r.sessions
    else if (r.name === 'Form step') {
      const f = get(props.form || 'form')
      f.steps[r.label] = (f.steps[r.label] || 0) + r.sessions
    }
  }
  return {
    results: [...byForm.values()]
      .map((f) => ({
        ...f,
        steps: Object.entries(f.steps)
          .map(([label, sessions]) => ({ label, sessions }))
          .sort((a, b) => a.label.localeCompare(b.label, 'de', { numeric: true })),
        completion: f.starts ? round((f.leads / f.starts) * 100, 1) : null
      }))
      .sort((a, b) => b.starts + b.application_starts - (a.starts + a.application_starts))
  }
}

// ---------------------------------------------------------------------------------------------
// Content: how far people read, which sections they reach, which questions they open.

export async function content(db, q) {
  const w = where(q)
  const [eng, faq, clicks] = await Promise.all([
    db.prepare(`SELECT page, session_id, props FROM events WHERE ${w.sql} AND name = 'Engagement'`).bind(...w.params).all(),
    db
      .prepare(
        `SELECT label AS name, COUNT(DISTINCT session_id) AS visitors, COUNT(*) AS events FROM events
         WHERE ${w.sql} AND name = 'FAQ open' GROUP BY label ORDER BY visitors DESC LIMIT 15`
      )
      .bind(...w.params)
      .all(),
    db
      .prepare(
        `SELECT json_extract(props, '$.section') AS section, name, COUNT(DISTINCT session_id) AS visitors FROM events
         WHERE ${w.sql} AND name NOT IN ('pageview', 'Engagement', 'Form step') AND json_extract(props, '$.section') IS NOT NULL
         GROUP BY section, name`
      )
      .bind(...w.params)
      .all()
  ])
  const pages = new Map()
  const sectionSessions = new Map()
  const sessions = new Set()
  for (const r of eng.results) {
    const p = parse(r.props) || {}
    sessions.add(r.session_id)
    const pg = pages.get(r.page) || { page: r.page, views: 0, depth: 0, time: 0 }
    pg.views++
    pg.depth += Number(p.d) || 0
    pg.time += Number(p.t) || 0
    pages.set(r.page, pg)
    for (const id of p.sec || []) {
      if (!sectionSessions.has(id)) sectionSessions.set(id, new Set())
      sectionSessions.get(id).add(r.session_id)
    }
  }
  const actions = new Map()
  for (const r of clicks.results) {
    const a = actions.get(r.section) || {}
    a[r.name] = (a[r.name] || 0) + r.visitors
    actions.set(r.section, a)
  }
  return {
    pages: [...pages.values()]
      .map((p) => ({ page: p.page, views: p.views, depth: Math.round(p.depth / p.views), time: Math.round(p.time / p.views) }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 20),
    sections: [...sectionSessions.entries()]
      .map(([id, set]) => ({ section: id, sessions: set.size, reach: sessions.size ? round((set.size / sessions.size) * 100, 1) : 0, actions: actions.get(id) || {} }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 25),
    faq: faq.results,
    sessions: sessions.size
  }
}

// ---------------------------------------------------------------------------------------------
// Google Ads, keyword level, cross-referenced with on-site leads and organic rankings.

async function organicPositions(db, sites, from, to) {
  const { results } = await db
    .prepare(
      `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
              SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS position
       FROM search_queries WHERE ${inList('site', sites)} AND date >= ? AND date <= ? GROUP BY query`
    )
    .bind(...sites, from, to)
    .all()
  return new Map(results.map((r) => [norm(r.query), r]))
}

async function termLeads(db, q) {
  const w = where(q)
  const { results } = await db
    .prepare(
      `SELECT LOWER(utm_term) AS term, COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT CASE WHEN name IN (${LEAD_EVENTS.map(() => '?').join(',')}) THEN visitor_id END) AS leads
       FROM events WHERE ${w.sql} AND source = 'Google Ads' AND utm_term IS NOT NULL GROUP BY LOWER(utm_term)`
    )
    .bind(...LEAD_EVENTS, ...w.params)
    .all()
  return new Map(results.map((r) => [norm(r.term).replace(/^[+"[]|["\]]$/g, ''), r]))
}

export async function adsDeep(db, q) {
  const range = [...q.sites, q.from, q.to]
  const scope = `${inList('site', q.sites)} AND date >= ? AND date <= ?`
  const [kw, qsLatest, terms, segs, share, organic, onsite] = await Promise.all([
    db
      .prepare(
        `SELECT site, campaign, ad_group, keyword, match_type, MAX(status) AS status, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                SUM(spend) AS spend, SUM(conversions) AS conversions
         FROM ads_keywords WHERE ${scope} GROUP BY site, campaign, ad_group, keyword, match_type ORDER BY spend DESC`
      )
      .bind(...range)
      .all(),
    db
      .prepare(
        `SELECT k.site, k.campaign, k.ad_group, k.keyword, k.match_type, k.quality_score FROM ads_keywords k
         JOIN (SELECT site, campaign, ad_group, keyword, match_type, MAX(date) AS d FROM ads_keywords
               WHERE ${scope} AND quality_score IS NOT NULL GROUP BY site, campaign, ad_group, keyword, match_type) m
           ON m.site = k.site AND m.campaign = k.campaign AND m.ad_group = k.ad_group AND m.keyword = k.keyword
              AND m.match_type = k.match_type AND m.d = k.date`
      )
      .bind(...range)
      .all(),
    db
      .prepare(
        `SELECT site, campaign, term, MAX(status) AS status, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                SUM(spend) AS spend, SUM(conversions) AS conversions
         FROM ads_search_terms WHERE ${scope} GROUP BY site, campaign, term ORDER BY spend DESC LIMIT 400`
      )
      .bind(...range)
      .all(),
    db
      .prepare(
        `SELECT kind, key, SUM(clicks) AS clicks, SUM(spend) AS spend, SUM(conversions) AS conversions
         FROM ads_segments WHERE ${scope} GROUP BY kind, key`
      )
      .bind(...range)
      .all(),
    db
      .prepare(
        `SELECT site, campaign, SUM(impressions) AS impressions,
                SUM(impression_share * impressions) / NULLIF(SUM(CASE WHEN impression_share IS NOT NULL THEN impressions END), 0) AS impression_share,
                SUM(top_share * impressions) / NULLIF(SUM(CASE WHEN top_share IS NOT NULL THEN impressions END), 0) AS top_share,
                SUM(lost_budget * impressions) / NULLIF(SUM(CASE WHEN lost_budget IS NOT NULL THEN impressions END), 0) AS lost_budget,
                SUM(lost_rank * impressions) / NULLIF(SUM(CASE WHEN lost_rank IS NOT NULL THEN impressions END), 0) AS lost_rank
         FROM ads_share WHERE ${scope} GROUP BY site, campaign ORDER BY impressions DESC`
      )
      .bind(...range)
      .all(),
    organicPositions(db, q.sites, q.from, q.to),
    termLeads(db, q)
  ])
  const qsKey = (r) => [r.site, r.campaign, r.ad_group, r.keyword, r.match_type].join('|')
  const qs = new Map(qsLatest.results.map((r) => [qsKey(r), r.quality_score]))
  const keywordSet = new Set(kw.results.map((r) => norm(r.keyword)))

  const keywords = kw.results.map((r) => {
    const o = organic.get(norm(r.keyword))
    const s = onsite.get(norm(r.keyword))
    return {
      site: r.site,
      campaign: r.campaign,
      ad_group: r.ad_group,
      keyword: r.keyword,
      match_type: r.match_type,
      status: r.status,
      quality_score: qs.get(qsKey(r)) ?? null,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.impressions ? round((r.clicks / r.impressions) * 100, 1) : null,
      spend: round(r.spend),
      cpc: r.clicks ? round(r.spend / r.clicks) : null,
      conversions: round(r.conversions, 1),
      site_leads: s ? s.leads : null,
      organic_position: o && o.impressions ? round(o.position, 1) : null,
      organic_impressions: o ? o.impressions : null,
      organic_clicks: o ? o.clicks : null
    }
  })

  const searchTerms = terms.results.map((r) => {
    const o = organic.get(norm(r.term))
    return {
      site: r.site,
      campaign: r.campaign,
      term: r.term,
      status: r.status,
      is_keyword: keywordSet.has(norm(r.term)),
      clicks: r.clicks,
      impressions: r.impressions,
      spend: round(r.spend),
      conversions: round(r.conversions, 1),
      organic_position: o && o.impressions ? round(o.position, 1) : null
    }
  })

  const segments = { hour: [], device: [], url: [] }
  for (const r of segs.results) {
    if (!segments[r.kind]) continue
    segments[r.kind].push({ key: r.key, clicks: r.clicks, spend: round(r.spend), conversions: round(r.conversions, 1) })
  }
  segments.hour.sort((a, b) => Number(a.key) - Number(b.key))
  segments.device.sort((a, b) => b.spend - a.spend)
  segments.url.sort((a, b) => b.spend - a.spend)

  return {
    keywords,
    search_terms: searchTerms,
    segments,
    share: share.results.map((r) => ({
      site: r.site,
      campaign: r.campaign,
      impressions: r.impressions,
      impression_share: round(r.impression_share, 3),
      top_share: round(r.top_share, 3),
      lost_budget: round(r.lost_budget, 3),
      lost_rank: round(r.lost_rank, 3)
    })),
    has_term_tracking: onsite.size > 0
  }
}

// ---------------------------------------------------------------------------------------------
// Google Business Profile: the locations whose website is one of the sites in scope.

export async function gbp(db, q) {
  const { results: locations } = await db
    .prepare(
      `SELECT l.location, l.name, l.site, l.company, r.count AS reviews, r.rating
       FROM gbp_locations l LEFT JOIN gbp_reviews r ON r.location = l.location WHERE ${inList('l.site', q.sites)}`
    )
    .bind(...q.sites)
    .all()
  if (!locations.length) return { locations: [], daily: [], keywords: [], totals: null }
  const ids = locations.map((l) => l.location)
  const [totals, daily, keywords, profileVisits] = await Promise.all([
    db
      .prepare(
        `SELECT location, SUM(impressions_maps) AS maps, SUM(impressions_search) AS search, SUM(calls) AS calls,
                SUM(website_clicks) AS website, SUM(directions) AS directions
         FROM gbp_daily WHERE ${inList('location', ids)} AND date >= ? AND date <= ? GROUP BY location`
      )
      .bind(...ids, q.from, q.to)
      .all(),
    db
      .prepare(
        `SELECT date, SUM(impressions_maps + impressions_search) AS impressions, SUM(calls) AS calls,
                SUM(website_clicks) AS website, SUM(directions) AS directions
         FROM gbp_daily WHERE ${inList('location', ids)} AND date >= ? AND date <= ? GROUP BY date ORDER BY date`
      )
      .bind(...ids, q.from, q.to)
      .all(),
    db
      .prepare(`SELECT location, keyword, value, threshold FROM gbp_keywords WHERE ${inList('location', ids)} ORDER BY COALESCE(value, 0) DESC, keyword`)
      .bind(...ids)
      .all(),
    db
      .prepare(
        `SELECT site, COUNT(DISTINCT visitor_id) AS visitors FROM events
         WHERE ${inList('site', q.sites)} AND date >= ? AND date <= ? AND source = 'Google Business Profile' GROUP BY site`
      )
      .bind(...q.sites, q.from, q.to)
      .all()
  ])
  const t = new Map(totals.results.map((r) => [r.location, r]))
  const visits = new Map(profileVisits.results.map((r) => [r.site, r.visitors]))
  const sum = { maps: 0, search: 0, calls: 0, website: 0, directions: 0 }
  const rows = locations.map((l) => {
    const r = t.get(l.location) || {}
    for (const k of Object.keys(sum)) sum[k] += r[k] || 0
    return {
      location: l.location,
      name: l.name,
      site: l.site,
      reviews: l.reviews,
      rating: l.rating,
      maps: r.maps || 0,
      search: r.search || 0,
      calls: r.calls || 0,
      website: r.website || 0,
      directions: r.directions || 0,
      tracked_visits: visits.get(l.site) || 0
    }
  })
  const names = new Map(locations.map((l) => [l.location, l.name]))
  return {
    locations: rows,
    daily: daily.results,
    keywords: keywords.results.map((k) => ({ ...k, location_name: names.get(k.location) })),
    totals: sum
  }
}

// ---------------------------------------------------------------------------------------------
// Opportunities: rules over all sources. Each has a severity, an estimated monthly euro value
// where one can be put on it, and a concrete next step.

const JUNK_TERMS = /\b(job|jobs|ausbildung|gehalt|stellen|stellenangebot|lehrling|praktikum|selber|selbst machen|diy|anleitung|gebraucht|ebay|kleinanzeigen|bauhaus|obi|hornbach|toom|kostenlos|gratis|reddit|youtube|wikipedia|definition|was ist|englisch)\b/i
const OFF_HOURS = new Set([0, 1, 2, 3, 4, 5, 6, 21, 22, 23])

function scaleToMonth(value, q) {
  const days = Math.round((new Date(q.to) - new Date(q.from)) / 86400000) + 1
  return round((value / days) * 30, 0)
}

export async function insights(db, q) {
  const sites = await siteRows(db, q.sites)
  const names = new Map(sites.map((s) => [s.domain, s.name]))
  const scope = `${inList('site', q.sites)} AND date >= ? AND date <= ?`
  const range = [...q.sites, q.from, q.to]
  const out = []
  const add = (o) => out.push(o)
  const eur = (n) => `${Math.round(n).toLocaleString('de-DE')} €`

  const [spendRows, trackerRows, adsSessions, ads, gbpData, gscRows, formData, leadData, faqRows, outbound] = await Promise.all([
    db.prepare(`SELECT site, SUM(spend) AS spend, SUM(clicks) AS clicks, SUM(conversions) AS conversions FROM ads_spend WHERE ${scope} GROUP BY site`).bind(...range).all(),
    db
      .prepare(
        `SELECT site, COUNT(DISTINCT visitor_id) AS visitors,
                COUNT(DISTINCT CASE WHEN name IN (${LEAD_EVENTS.map(() => '?').join(',')}) THEN visitor_id END) AS leads
         FROM events WHERE ${scope} GROUP BY site`
      )
      .bind(...LEAD_EVENTS, ...range)
      .all(),
    db
      .prepare(
        `SELECT site, COUNT(*) AS sessions, SUM(utm_term IS NULL) AS without_term,
                COUNT(DISTINCT CASE WHEN id IN (SELECT session_id FROM events WHERE ${scope} AND name IN (${LEAD_EVENTS.map(() => '?').join(',')})) THEN id END) AS lead_sessions
         FROM sessions WHERE ${scope} AND source = 'Google Ads' GROUP BY site`
      )
      .bind(...range, ...LEAD_EVENTS, ...range)
      .all(),
    adsDeep(db, q),
    gbp(db, q),
    db
      .prepare(
        `SELECT site, query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS position
         FROM search_queries WHERE ${scope} GROUP BY site, query HAVING SUM(impressions) >= 10 ORDER BY impressions DESC LIMIT 300`
      )
      .bind(...range)
      .all(),
    forms(db, q),
    leads(db, q, 200),
    db.prepare(`SELECT site, label, COUNT(DISTINCT session_id) AS n FROM events WHERE ${scope} AND name = 'FAQ open' GROUP BY site, label ORDER BY n DESC LIMIT 5`).bind(...range).all(),
    db
      .prepare(`SELECT site, json_extract(props, '$.target') AS target, COUNT(DISTINCT session_id) AS n FROM events WHERE ${scope} AND name = 'Outbound link' GROUP BY site, target`)
      .bind(...range)
      .all()
  ])

  const tracker = new Map(trackerRows.results.map((r) => [r.site, r]))
  const adSess = new Map(adsSessions.results.map((r) => [r.site, r]))

  // --- Tracking ---
  for (const s of spendRows.results) {
    const name = names.get(s.site)
    const t = tracker.get(s.site)
    if (s.spend >= 30 && !s.conversions) {
      const a = adSess.get(s.site)
      add({
        severity: 'high',
        area: 'Tracking',
        site: s.site,
        title: `${name}: Google Ads meldet 0 Conversions bei ${eur(s.spend)} Ausgaben`,
        detail:
          a && a.lead_sessions
            ? `Unser Tracker sieht ${a.lead_sessions} Besuche aus Google Ads mit Anfrage oder Anruf-Klick. Google lernt davon nichts, Smart Bidding optimiert blind.`
            : 'Ohne gemeldete Conversions kann Google nicht auf Anfragen optimieren, und niemand sieht, welche Keywords Kunden bringen.',
        action: 'Conversion-Aktion für Formular-Anfrage und Anruf-Klick im Google-Tag prüfen (Einwilligungsmodus, Auslöser auf Erfolgsmeldung statt Absende-Klick).',
        value: scaleToMonth(s.spend, q)
      })
    }
    if (!t || !t.visitors) {
      add({
        severity: 'medium',
        area: 'Tracking',
        site: s.site,
        title: `${name}: Anzeigenklicks ohne Website-Tracking`,
        detail: `${eur(s.spend)} Ausgaben, aber keine Besuche im eigenen Tracker. Klick → Anfrage → Keyword lässt sich so nicht verbinden.`,
        action: 'Tracking-Snippet im Onepage-Kopfbereich der Website einfügen (Bereich „Tracking“).',
        value: null
      })
    }
  }
  const noTerm = adsSessions.results.filter((a) => a.sessions >= 5 && a.without_term / a.sessions > 0.5)
  if (noTerm.length) {
    add({
      severity: 'medium',
      area: 'Tracking',
      site: noTerm.length === 1 ? noTerm[0].site : null,
      title: `Anzeigenbesuche ohne Keyword auf ${noTerm.length} Website${noTerm.length > 1 ? 's' : ''}`,
      detail:
        noTerm.map((a) => `${names.get(a.site)} ${Math.round((a.without_term / a.sessions) * 100)} %`).join(' · ') +
        '. Ohne utm_term ist nicht zu sehen, welches Keyword eine Anfrage gebracht hat.',
      action: 'Tracking-Vorlage auf Kontoebene in allen vier Konten: {lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}&utm_content={creative}',
      value: null
    })
  }

  // --- Ads: keywords without results ---
  const keywordWaste = ads.keywords.filter((k) => k.spend >= 15 && !k.conversions && !k.site_leads).slice(0, 6)
  for (const k of keywordWaste) {
    add({
      severity: k.spend >= 40 ? 'high' : 'medium',
      area: 'Google Ads',
      site: k.site,
      title: `Keyword „${k.keyword}“: ${eur(k.spend)} ohne Anfrage`,
      detail: `${k.clicks} Klicks, CTR ${k.ctr ?? '–'} %, Qualitätsfaktor ${k.quality_score ?? '–'}${k.organic_impressions >= 10 ? `, organisch Position ${k.organic_position}` : ''} (${k.campaign}).`,
      action: k.quality_score && k.quality_score <= 4 ? 'Gebot senken oder pausieren; Anzeige und Zielseite enger auf den Begriff zuschneiden.' : 'Gebot senken oder pausieren und Suchbegriffe dahinter prüfen.',
      value: scaleToMonth(k.spend, q)
    })
  }

  // --- Ads: search terms to exclude ---
  const junk = ads.search_terms.filter((t) => JUNK_TERMS.test(t.term) && t.spend > 0 && !t.conversions)
  if (junk.length) {
    const total = junk.reduce((a, t) => a + t.spend, 0)
    add({
      severity: 'high',
      area: 'Google Ads',
      site: junk[0].site,
      title: `${junk.length} Suchbegriffe ohne Kaufabsicht kosten ${eur(total)}`,
      detail: junk.slice(0, 8).map((t) => `„${t.term}“ ${eur(t.spend)}`).join(', '),
      action: 'Als ausschließende Keywords hinzufügen (Phrase): ' + [...new Set(junk.map((t) => (t.term.match(JUNK_TERMS) || [])[0]).filter(Boolean))].join(', '),
      value: scaleToMonth(total, q),
      terms: junk.slice(0, 20).map((t) => ({ site: t.site, campaign: t.campaign, term: t.term, spend: t.spend }))
    })
  }
  const tail = ads.search_terms.filter((t) => !t.is_keyword && !t.conversions && t.spend >= 3 && !JUNK_TERMS.test(t.term))
  if (tail.length >= 3) {
    const total = tail.reduce((a, t) => a + t.spend, 0)
    add({
      severity: 'medium',
      area: 'Google Ads',
      site: null,
      title: `${tail.length} Suchbegriffe mit je ≥ 3 € und ohne Conversion: ${eur(total)}`,
      detail: tail.slice(0, 10).map((t) => `„${t.term}“ ${eur(t.spend)}`).join(', '),
      action: 'Einzeln prüfen: passende als exakte Keywords mit eigener Anzeige, unpassende ausschließen.',
      value: scaleToMonth(total, q),
      terms: tail.slice(0, 30).map((t) => ({ site: t.site, campaign: t.campaign, term: t.term, spend: t.spend }))
    })
  }
  const winners = ads.search_terms.filter((t) => t.conversions > 0 && !t.is_keyword)
  if (winners.length) {
    add({
      severity: 'medium',
      area: 'Google Ads',
      site: winners[0].site,
      title: `${winners.length} Suchbegriffe bringen Conversions, sind aber keine Keywords`,
      detail: winners.slice(0, 10).map((t) => `„${t.term}“ (${t.conversions} Conv. für ${eur(t.spend)})`).join(', '),
      action: 'Als exakte Keywords übernehmen, damit Gebot und Anzeige gezielt darauf laufen.',
      value: null,
      terms: winners.slice(0, 20).map((t) => ({ site: t.site, campaign: t.campaign, term: t.term, spend: t.spend, conversions: t.conversions }))
    })
  }

  // --- Ads: impression share ---
  for (const c of ads.share) {
    const conv = ads.keywords.filter((k) => k.campaign === c.campaign).reduce((a, k) => a + (k.conversions || 0), 0)
    if (c.lost_budget >= 0.2 && conv > 0) {
      add({
        severity: 'high',
        area: 'Google Ads',
        site: c.site,
        title: `${c.campaign}: ${Math.round(c.lost_budget * 100)} % der Einblendungen wegen Budget verloren`,
        detail: `Die Kampagne bringt Conversions (${round(conv, 1)}), wird aber vorzeitig abgeschaltet. Impression-Share ${Math.round((c.impression_share || 0) * 100)} %.`,
        action: 'Tagesbudget erhöhen oder Budget aus Keywords ohne Anfrage hierher verschieben.',
        value: null
      })
    } else if (c.lost_rank >= 0.5 && c.impressions >= 200) {
      add({
        severity: 'medium',
        area: 'Google Ads',
        site: c.site,
        title: `${c.campaign}: ${Math.round(c.lost_rank * 100)} % der Einblendungen wegen Anzeigenrang verloren`,
        detail: 'Qualitätsfaktor oder Gebot reichen nicht. Schlechter Rang verteuert jeden Klick.',
        action: 'Keywords mit Qualitätsfaktor ≤ 4 auf eine passende Landingpage leiten und Anzeigentexte enger an die Suchbegriffe anlehnen.',
        value: null
      })
    }
  }

  // --- Ads ↔ landing pages: route keywords to the landing page that matches them ---
  const landings = (
    await db.prepare(`SELECT s.domain, s.name, s.company, s.config FROM sites s WHERE s.config LIKE '%"kind":"landing"%'`).all()
  ).results.map((r) => ({ ...r, config: parse(r.config) || {} }))
  const companyOf = new Map(
    (await db.prepare('SELECT domain, company FROM sites').all()).results.map((r) => [r.domain, r.company])
  )
  const routed = new Map()
  for (const k of ads.keywords) {
    if (k.spend < 3) continue
    const lp = landings.find(
      (l) => l.company === companyOf.get(k.site) && (l.config.terms || []).some((t) => norm(k.keyword).includes(t))
    )
    if (!lp) continue
    const r = routed.get(lp.domain) || { lp, spend: 0, keywords: [], lowQs: 0 }
    r.spend += k.spend
    r.keywords.push(k.keyword)
    if (k.quality_score && k.quality_score <= 5) r.lowQs++
    routed.set(lp.domain, r)
  }
  for (const r of routed.values()) {
    add({
      severity: 'medium',
      area: 'Synergie',
      site: r.lp.domain,
      title: `${eur(r.spend)} für „${r.lp.config.service}“-Keywords landen nicht auf der passenden Landingpage`,
      detail: `${[...new Set(r.keywords)].slice(0, 8).join(', ')}${r.lowQs ? ` – davon ${r.lowQs} mit Qualitätsfaktor ≤ 5` : ''}. Die Seite ${r.lp.name} ist genau für diese Suche gebaut (mehrstufiges Formular, Preisangaben, FAQ).`,
      action: `Nach dem Livegang: eigene Anzeigengruppe mit diesen Keywords und finaler URL ${r.lp.domain}.`,
      value: null
    })
  }

  // --- Ads: hours and devices ---
  const off = ads.segments.hour.filter((h) => OFF_HOURS.has(Number(h.key)))
  const offSpend = off.reduce((a, h) => a + h.spend, 0)
  const offConv = off.reduce((a, h) => a + h.conversions, 0)
  if (offSpend >= 10 && !offConv) {
    add({
      severity: 'medium',
      area: 'Google Ads',
      site: null,
      title: `${eur(offSpend)} Ausgaben zwischen 21 und 7 Uhr ohne Conversion`,
      detail: 'Abends und nachts kommen kaum Anfragen, die Klicks kosten trotzdem.',
      action: 'Werbezeitplan auf 7–21 Uhr begrenzen oder Gebote nachts um 50 % senken.',
      value: scaleToMonth(offSpend, q)
    })
  }
  const dev = ads.segments.device.filter((d) => d.spend > 0)
  if (dev.length >= 2) {
    const cpa = dev.map((d) => ({ ...d, cpa: d.conversions ? d.spend / d.conversions : null }))
    const worst = cpa.filter((d) => d.spend >= 30 && !d.conversions)
    for (const d of worst) {
      add({
        severity: 'medium',
        area: 'Google Ads',
        site: null,
        title: `${d.key}: ${eur(d.spend)} ohne Conversion`,
        detail: cpa.map((x) => `${x.key} ${eur(x.spend)} / ${x.conversions} Conv.`).join(' · '),
        action: `Gebotsanpassung für ${d.key} senken (z. B. −30 %).`,
        value: null
      })
    }
  }
  for (const u of ads.segments.url.filter((u) => u.spend >= 20 && !u.conversions).slice(0, 4)) {
    add({
      severity: 'medium',
      area: 'Google Ads',
      site: null,
      title: `Zielseite ${u.key.replace(/^https?:\/\//, '')}: ${eur(u.spend)} ohne Conversion`,
      detail: `${u.clicks} Anzeigenklicks landen hier und keiner wird zur Anfrage.`,
      action: 'Seite auf Anfrage optimieren (Formular über dem Falz, Telefonnummer, Preise) oder Klicks auf eine Landingpage leiten.',
      value: scaleToMonth(u.spend, q)
    })
  }

  // --- Search Console: demand that ads and pages do not catch yet ---
  const covered = new Set([...ads.keywords.map((k) => norm(k.keyword)), ...ads.search_terms.map((t) => norm(t.term))])
  const brand = /seehafer|brink|hantke|werner|gruppenwerk/i
  const gaps = gscRows.results.filter((r) => r.position > 7 && r.impressions >= 15 && !brand.test(r.query) && !covered.has(norm(r.query)))
  if (gaps.length) {
    add({
      severity: 'medium',
      area: 'SEO',
      site: gaps[0].site,
      title: `${gaps.length} Suchanfragen mit Nachfrage, aber Seite 2+ und ohne Anzeige`,
      detail: gaps.slice(0, 8).map((r) => `„${r.query}“ ${r.impressions}× · Pos. ${round(r.position, 1)}`).join(', '),
      action: 'Für die stärksten Begriffe: eigene Abschnitte/Seiten mit dem Begriff in Titel und H1, oder als Keyword testen.',
      value: null,
      terms: gaps.slice(0, 20).map((r) => ({ site: r.site, term: r.query, impressions: r.impressions, position: round(r.position, 1) }))
    })
  }
  const overlap = ads.keywords.filter((k) => k.organic_position && k.organic_position <= 3 && k.organic_impressions >= 20 && k.spend >= 10)
  for (const k of overlap.slice(0, 3)) {
    add({
      severity: 'info',
      area: 'SEO',
      site: k.site,
      title: `„${k.keyword}“ steht organisch auf Platz ${k.organic_position} und kostet zusätzlich ${eur(k.spend)}`,
      detail: `${k.clicks} Anzeigenklicks, ${k.conversions || 0} Conversions${k.quality_score ? `, Qualitätsfaktor ${k.quality_score}` : ''}. Die Seite wird für diese Suche ohnehin oben gezeigt.`,
      action: brand.test(k.keyword)
        ? 'Marken-Keyword testweise pausieren und beobachten, ob die Anfragen gleich bleiben.'
        : 'Gebot senken; die Anzeige lohnt sich nur, wenn sie zusätzliche Anfragen bringt.',
      value: scaleToMonth(k.spend, q)
    })
  }

  // --- Business Profile ---
  for (const l of gbpData.locations) {
    if ((l.reviews ?? 0) < 10) {
      add({
        severity: (l.reviews ?? 0) < 5 ? 'high' : 'medium',
        area: 'Google Business',
        site: l.site,
        title: `${l.name}: nur ${l.reviews ?? 0} Google-Bewertungen`,
        detail: `${l.maps + l.search} Einblendungen, ${l.calls} Anrufe und ${l.directions} Routen im Zeitraum. Bewertungen sind der stärkste Hebel im Kartenranking.`,
        action: 'Nach jedem Auftrag den Bewertungslink per WhatsApp/SMS schicken; Bewertungen über Windsor beantworten.',
        value: null
      })
    }
    if (l.calls >= 5) {
      add({
        severity: 'info',
        area: 'Google Business',
        site: l.site,
        title: `${l.name}: ${l.calls} Anrufe direkt aus dem Profil`,
        detail: 'Diese Anfragen tauchen in keiner Website-Statistik auf, sind aber Leads.',
        action: 'Profil aktuell halten (Öffnungszeiten, Fotos, wöchentlicher Beitrag); zählt in der Lead-Summe mit.',
        value: null
      })
    }
  }
  const untagged = gbpData.locations.filter((l) => l.website >= 3 && !l.tracked_visits)
  if (untagged.length) {
    add({
      severity: 'medium',
      area: 'Tracking',
      site: untagged.length === 1 ? untagged[0].site : null,
      title: `${untagged.reduce((a, l) => a + l.website, 0)} Website-Klicks aus Google-Profilen sind nicht als solche erkennbar`,
      detail: untagged.map((l) => `${l.name} ${l.website}`).join(' · ') + '. Sie erscheinen sonst als „Google“ oder „Direkt“.',
      action: 'Website-Link in jedem Profil mit ?utm_source=gbp&utm_medium=organic&utm_campaign=gbp versehen (geht auch über Windsor).',
      value: null
    })
  }
  const gbpKeywordsNoAds = gbpData.keywords.filter(
    (k) => !brand.test(k.keyword) && /\s/.test(k.keyword) && !/\b(gmbh|kg|ag|ug)\b/.test(k.keyword) && ![...covered].some((c) => c.includes(k.keyword) || k.keyword.includes(c))
  )
  if (gbpKeywordsNoAds.length) {
    add({
      severity: 'info',
      area: 'Synergie',
      site: null,
      title: `${gbpKeywordsNoAds.length} Begriffe finden das Profil, aber keine Anzeige`,
      detail: gbpKeywordsNoAds.slice(0, 10).map((k) => `„${k.keyword}“ (${k.location_name})`).join(', '),
      action: 'Als Keyword-Ideen für Anzeigen und Abschnitte auf den Landingpages nutzen.',
      value: null
    })
  }

  // --- Website: forms, questions, what leads ask for ---
  for (const f of formData.results) {
    if (f.starts >= 5 && f.completion !== null && f.completion < 35) {
      const steps = f.steps
      let worst = null
      for (let i = 1; i < steps.length; i++) {
        const drop = steps[i - 1].sessions ? 1 - steps[i].sessions / steps[i - 1].sessions : 0
        if (!worst || drop > worst.drop) worst = { from: steps[i - 1].label, to: steps[i].label, drop }
      }
      add({
        severity: 'high',
        area: 'Website',
        site: q.sites.length === 1 ? q.sites[0] : null,
        title: `Formular „${f.form}“: ${f.starts} begonnen, ${f.leads} gesendet (${f.completion} %)`,
        detail: worst ? `Größter Abbruch zwischen „${worst.from}“ und „${worst.to}“ (${Math.round(worst.drop * 100)} %).` : 'Viele beginnen, wenige senden ab.',
        action: 'Den Schritt mit dem größten Abbruch kürzen; Telefon oder E-Mail genügt, Rest beim Rückruf klären.',
        value: null
      })
    }
  }
  if (faqRows.results.length) {
    const f = faqRows.results[0]
    add({
      severity: 'info',
      area: 'Website',
      site: f.site,
      title: `Meistgeöffnete Frage: „${f.label}“`,
      detail: `${f.n} Besuche haben sie aufgeklappt. Was oft gefragt wird, gehört in die Anzeige und weiter nach oben.`,
      action: 'Antwort als Anzeigentext-Zeile oder Hero-Unterzeile testen.',
      value: null
    })
  }
  if (leadData.choices.length) {
    const top = leadData.choices.slice(0, 4)
    add({
      severity: 'info',
      area: 'Synergie',
      site: null,
      title: `Was Anfragende am häufigsten wählen: „${top[0].answer}“`,
      detail: top.map((c) => `${c.question}: ${c.answer} (${c.leads})`).join(' · '),
      action: 'Diese Formulierungen in Anzeigentitel und Keywords übernehmen; sie sind die Sprache der Kunden.',
      value: null
    })
  }
  const sister = outbound.results.filter((o) => /onepage\.me|seehafer|brink|hantke|werner/i.test(o.target || ''))
  if (sister.length) {
    const n = sister.reduce((a, o) => a + o.n, 0)
    add({
      severity: 'info',
      area: 'Synergie',
      site: null,
      title: `${n} Besuche wechseln zwischen Gruppen-Websites`,
      detail: sister.slice(0, 6).map((o) => `${names.get(o.site) || o.site} → ${String(o.target).replace(/^https?:\/\//, '')} (${o.n})`).join(' · '),
      action: 'Querverweise stärken, wo Leistungen zusammengehören (Leckortung → Trocknung → Malerarbeiten).',
      value: null
    })
  }

  const order = { high: 0, medium: 1, info: 2 }
  out.sort((a, b) => order[a.severity] - order[b.severity] || (b.value || 0) - (a.value || 0))
  return { results: out, sites: Object.fromEntries(names) }
}
