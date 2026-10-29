// Deeper read-side views: leads, funnels, forms, content, keyword level Ads, Business Profile,
// and the opportunities that come from putting those sources side by side.

import { BadRequest, LEAD_EVENTS, latestWindow, where } from './stats.js'

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
  const names = [...LEAD_EVENTS, 'Application', 'Application contact']
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
       WHERE ${w.sql} AND name IN ('pageview', 'Engagement', 'Form start', 'Form step', 'FAQ open', 'Application', 'Application contact', ${LEAD_EVENTS.map(() => '?').join(',')})`
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
    if (r.name === 'Engagement') for (const id of Array.isArray(props.sec) ? props.sec : []) s.sections.add(id)
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
    case 'events':
      return step.value.some((v) => s.events.has(v))
    case 'page_or_section':
      return step.value.some((v) => (v.startsWith('/') ? s.pages.has(v) : s.sections.has(v)))
    case 'lead':
      return s.lead
    default:
      return false
  }
}

// Each step counts every visit that reached it, whatever came before: someone who calls straight
// from the start page is a contact even though they never opened the form.
export async function funnel(db, q) {
  const sites = await siteRows(db, q.sites)
  const steps = (sites.length === 1 && sites[0].config.funnel) || DEFAULT_FUNNEL
  const sessions = await sessionFacts(db, q)
  const counts = steps.map(() => 0)
  let skipped = 0
  const last = steps.length - 1
  for (const s of sessions.values()) {
    const hit = steps.map((st) => matches(st, s))
    hit.forEach((h, i) => { if (h) counts[i]++ })
    // reached the last step without passing every step before it
    if (hit[last] && hit.slice(0, last).some((h) => !h)) skipped++
  }
  return {
    steps: steps.map((st, i) => ({
      label: st.label,
      sessions: counts[i],
      rate: counts[0] ? round((counts[i] / counts[0]) * 100, 1) : 0,
      drop: i && counts[i - 1] && counts[i] <= counts[i - 1] ? round(100 - (counts[i] / counts[i - 1]) * 100, 1) : null
    })),
    shortcut: skipped
  }
}

// ---------------------------------------------------------------------------------------------
// Forms: starts, steps reached and leads per form.

async function sectionNames(db, sites) {
  const { results } = await db.prepare(`SELECT id, name FROM section_names WHERE ${inList('site', sites)}`).bind(...sites).all()
  const out = {}
  for (const r of results) if (!out[r.id]) out[r.id] = r.name
  return out
}

const median = (list) => {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// Forms: starts, leads, and per field how far visitors got and where they gave up.
export async function forms(db, q) {
  const w = where(q)
  const [{ results }, names] = await Promise.all([
    db
      .prepare(
        `SELECT session_id, name, label, props FROM events
         WHERE ${w.sql} AND name IN ('Form start', 'Form step', 'Form submit', 'Form abandon', 'Application start', 'Application')
         ORDER BY ts`
      )
      .bind(...w.params)
      .all(),
    sectionNames(db, q.sites)
  ])
  const byForm = new Map()
  const get = (key) => {
    if (!byForm.has(key))
      byForm.set(key, { form: key, name: null, starts: new Set(), appStarts: new Set(), leads: new Set(), apps: new Set(), steps: {}, paths: new Map() })
    return byForm.get(key)
  }
  const path = (f, sid) => {
    if (!f.paths.has(sid)) f.paths.set(sid, { fs: null, last: null, err: [], t: null, submitted: false, abandoned: false })
    return f.paths.get(sid)
  }
  for (const r of results) {
    const props = parse(r.props) || {}
    const key = (r.name === 'Form step' ? props.form : r.label) || 'form'
    const f = get(key)
    if (r.name === 'Form start' || r.name === 'Application start') {
      ;(r.name === 'Form start' ? f.starts : f.appStarts).add(r.session_id)
      if (props.fn) f.name = props.fn
    } else if (r.name === 'Form step') {
      if (!f.steps[r.label]) f.steps[r.label] = new Set()
      f.steps[r.label].add(r.session_id)
    } else if (r.name === 'Form submit' || r.name === 'Application') {
      ;(r.name === 'Form submit' ? f.leads : f.apps).add(r.session_id)
      const p = path(f, r.session_id)
      p.submitted = true
      if (Array.isArray(props.fs) && props.fs.length) p.fs = props.fs
      if (Array.isArray(props.err)) p.err = props.err
      if (typeof props.t === 'number') p.t = props.t
    } else if (r.name === 'Form abandon') {
      const p = path(f, r.session_id)
      if (p.submitted) continue
      // the latest abandon of a visit is the furthest it got
      p.abandoned = true
      p.fs = Array.isArray(props.fs) ? props.fs : p.fs
      p.last = props.last || (p.fs && p.fs[p.fs.length - 1]) || null
      p.err = Array.isArray(props.err) ? props.err : p.err
      if (typeof props.t === 'number') p.t = props.t
    }
  }

  const out = []
  for (const f of byForm.values()) {
    // field order: where a field usually comes in the visitors' paths
    const pos = new Map()
    for (const p of f.paths.values()) {
      ;(p.fs || []).forEach((name, i) => {
        const x = pos.get(name) || { sum: 0, n: 0 }
        x.sum += i
        x.n++
        pos.set(name, x)
      })
    }
    const order = [...pos.entries()].sort((a, b) => a[1].sum / a[1].n - b[1].sum / b[1].n || b[1].n - a[1].n).map(([name]) => name).slice(0, 14)
    const rank = new Map(order.map((n, i) => [n, i]))
    const fields = order.map((label) => ({ label, reached: 0, gave_up: 0, errors: 0 }))
    let measured = 0
    const tSubmit = []
    const tAbandon = []
    for (const p of f.paths.values()) {
      if (p.submitted && typeof p.t === 'number') tSubmit.push(p.t)
      if (p.abandoned && typeof p.t === 'number') tAbandon.push(p.t)
      if (!p.fs && !p.submitted) continue
      measured++
      const furthest = p.submitted ? fields.length - 1 : Math.max(-1, ...(p.fs || []).map((n) => (rank.has(n) ? rank.get(n) : -1)))
      for (let i = 0; i <= furthest; i++) fields[i].reached++
      if (p.abandoned && p.last && rank.has(p.last)) fields[rank.get(p.last)].gave_up++
      for (const e of p.err || []) if (rank.has(e)) fields[rank.get(e)].errors++
    }
    const abandons = [...f.paths.values()].filter((p) => p.abandoned).length
    const worst = fields.reduce((a, x) => (x.gave_up && (!a || x.gave_up > a.gave_up) ? x : a), null)
    const starts = f.starts.size
    out.push({
      form: f.form,
      name: f.name || names[f.form] || null,
      starts,
      application_starts: f.appStarts.size,
      leads: f.leads.size,
      applications: f.apps.size,
      abandons,
      measured,
      fields,
      worst: worst ? { label: worst.label, gave_up: worst.gave_up, of: abandons } : null,
      time_submit: median(tSubmit),
      time_abandon: median(tAbandon),
      steps: Object.entries(f.steps)
        .map(([label, set]) => ({ label, sessions: set.size }))
        .sort((a, b) => a.label.localeCompare(b.label, 'de', { numeric: true })),
      completion: starts ? round((f.leads.size / starts) * 100, 1) : null
    })
  }
  return { results: out.filter((f) => f.starts || f.application_starts).sort((a, b) => b.starts + b.application_starts - (a.starts + a.application_starts)) }
}

// ---------------------------------------------------------------------------------------------
// Content: how far people read, which sections they reach, which questions they open.

export async function content(db, q) {
  const w = where(q)
  const [eng, faq, clicks, names, rage] = await Promise.all([
    db.prepare(`SELECT page, session_id, device, props FROM events WHERE ${w.sql} AND name = 'Engagement'`).bind(...w.params).all(),
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
      .all(),
    sectionNames(db, q.sites),
    db
      .prepare(
        `SELECT page, label, json_extract(props, '$.section') AS section, COUNT(DISTINCT session_id) AS visitors, COUNT(*) AS events FROM events
         WHERE ${w.sql} AND name = 'Rage click' GROUP BY page, label, section ORDER BY visitors DESC LIMIT 15`
      )
      .bind(...w.params)
      .all()
  ])
  const speed = new Map()
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
    if (typeof p.lcp === 'number' && p.lcp > 0) {
      const sp = speed.get(r.page) || { mobile: [], desktop: [] }
      ;(r.device === 'Mobile' ? sp.mobile : sp.desktop).push(p.lcp)
      speed.set(r.page, sp)
    }
    for (const id of Array.isArray(p.sec) ? p.sec : []) {
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
      .map(([id, set]) => ({ section: id, name: names[id] || null, sessions: set.size, reach: sessions.size ? round((set.size / sessions.size) * 100, 1) : 0, actions: actions.get(id) || {} }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 25),
    faq: faq.results,
    speed: [...speed.entries()]
      .map(([page, sp]) => ({ page, mobile: median(sp.mobile), desktop: median(sp.desktop), n: sp.mobile.length + sp.desktop.length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 12),
    rage: rage.results.map((r) => ({ ...r, section_name: r.section ? names[r.section] || null : null })),
    sessions: sessions.size
  }
}

// ---------------------------------------------------------------------------------------------
// Page x-ray: one page from top to bottom, how many reach each section and where people get in touch.

export async function xray(db, q, page) {
  const w = where(q)
  const { results: top } = await db
    .prepare(`SELECT page, COUNT(DISTINCT session_id) AS visits FROM events WHERE ${w.sql} AND name = 'Engagement' GROUP BY page ORDER BY visits DESC LIMIT 8`)
    .bind(...w.params)
    .all()
  const target = page && top.some((t) => t.page === page) ? page : top.length ? top[0].page : null
  if (!target) return { pages: [], page: null, sections: [], visits: 0 }
  const leadList = LEAD_EVENTS.map(() => '?').join(',')
  const [eng, clicks, names] = await Promise.all([
    db.prepare(`SELECT session_id, props FROM events WHERE ${w.sql} AND name = 'Engagement' AND page = ?`).bind(...w.params, target).all(),
    db
      .prepare(
        `SELECT name, label, json_extract(props, '$.section') AS section, COUNT(DISTINCT session_id) AS n FROM events
         WHERE ${w.sql} AND page = ? AND name IN (${leadList}) GROUP BY name, label, section`
      )
      .bind(...w.params, target, ...LEAD_EVENTS)
      .all(),
    sectionNames(db, q.sites)
  ])
  const visits = new Set()
  const reach = new Map()
  const pos = new Map()
  for (const r of eng.results) {
    visits.add(r.session_id)
    const sec = (parse(r.props) || {}).sec
    if (!Array.isArray(sec)) continue
    sec.forEach((id, i) => {
      if (!reach.has(id)) reach.set(id, new Set())
      reach.get(id).add(r.session_id)
      const x = pos.get(id) || { sum: 0, n: 0 }
      x.sum += i
      x.n++
      pos.set(id, x)
    })
  }
  const contacts = new Map()
  let unplaced = 0
  for (const r of clicks.results) {
    // a sent form belongs to the section it sits in, which is its key
    const id = r.section || (r.name === 'Form submit' && reach.has(r.label) ? r.label : null)
    if (!id || !reach.has(id)) { unplaced += r.n; continue }
    if (!contacts.has(id)) contacts.set(id, {})
    const c = contacts.get(id)
    c[r.name] = (c[r.name] || 0) + r.n
  }
  // sections are seen top to bottom, so their usual position in the list is their place on the page
  const ids = new Set([...reach.keys(), ...contacts.keys()])
  const sections = [...ids]
    .map((id) => {
      const p = pos.get(id)
      return {
        id,
        name: names[id] || null,
        order: p ? p.sum / p.n : 99,
        reach: visits.size ? round(((reach.get(id) || new Set()).size / visits.size) * 100, 1) : 0,
        contacts: contacts.get(id) || {}
      }
    })
    .sort((a, b) => a.order - b.order)
  return { pages: top, page: target, visits: visits.size, sections, unplaced }
}

// ---------------------------------------------------------------------------------------------
// When people get in touch: weekday x hour.

export async function when(db, q) {
  const w = where(q)
  const { results } = await db
    .prepare(
      `SELECT CAST(strftime('%w', date) AS INTEGER) AS dow, hour, name, COUNT(DISTINCT session_id) AS n FROM events
       WHERE ${w.sql} AND name IN (${LEAD_EVENTS.map(() => '?').join(',')}) GROUP BY dow, hour, name`
    )
    .bind(...w.params, ...LEAD_EVENTS)
    .all()
  // Monday first
  return { cells: results.map((r) => ({ day: (r.dow + 6) % 7, hour: r.hour, type: r.name, n: r.n })) }
}

// ---------------------------------------------------------------------------------------------
// Path to contact: where the visit came from, where it landed, how it got in touch.

export async function paths(db, q) {
  const w = where(q)
  const { results } = await db
    .prepare(
      `SELECT s.source, s.entry_page, e.name, COUNT(DISTINCT e.session_id) AS n
       FROM (SELECT session_id, MIN(ts) AS ts FROM events WHERE ${w.sql} AND name IN (${LEAD_EVENTS.map(() => '?').join(',')}) GROUP BY session_id) f
       JOIN events e ON e.session_id = f.session_id AND e.ts = f.ts
       JOIN sessions s ON s.id = f.session_id
       GROUP BY s.source, s.entry_page, e.name ORDER BY n DESC`
    )
    .bind(...w.params, ...LEAD_EVENTS)
    .all()
  return { paths: results.map((r) => ({ source: r.source || 'Direct / None', entry: r.entry_page || '/', type: r.name, n: r.n })) }
}

// ---------------------------------------------------------------------------------------------
// Logbook: each change with the two weeks before and after it, side by side.

const WINDOW_DAYS = 14
const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function windowStats(db, sites, from, to) {
  const leadList = LEAD_EVENTS.map(() => '?').join(',')
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT date) AS days, COUNT(DISTINCT session_id) AS visits,
              COUNT(DISTINCT CASE WHEN name IN (${leadList}) THEN session_id END) AS contacts
       FROM events WHERE ${inList('site', sites)} AND date >= ? AND date <= ?`
    )
    .bind(...LEAD_EVENTS, ...sites, from, to)
    .first()
  return { days: row.days || 0, visits: row.visits || 0, contacts: row.contacts || 0 }
}

export async function changelog(db, q, today) {
  const { results } = await db
    .prepare(`SELECT * FROM changelog WHERE site IS NULL OR ${inList('site', q.sites)} ORDER BY date DESC, id DESC LIMIT 60`)
    .bind(...q.sites)
    .all()
  const since = (await db.prepare(`SELECT MIN(date) AS d FROM events WHERE ${inList('site', q.sites)}`).bind(...q.sites).first() || {}).d
  const entries = []
  for (const r of results) {
    const sites = r.site ? [r.site] : q.sites
    const before = await windowStats(db, sites, addDays(r.date, -WINDOW_DAYS), addDays(r.date, -1))
    const afterTo = addDays(r.date, WINDOW_DAYS - 1) < today ? addDays(r.date, WINDOW_DAYS - 1) : today
    const after = r.date <= today ? await windowStats(db, sites, r.date, afterTo) : { days: 0, visits: 0, contacts: 0 }
    entries.push({
      id: r.id,
      site: r.site,
      date: r.date,
      text: r.text,
      author: r.author,
      // a comparison needs the tracker to have run before the change
      comparable: !!since && addDays(r.date, -WINDOW_DAYS) >= since,
      window: WINDOW_DAYS,
      before,
      after
    })
  }
  return { entries }
}

export async function addChange(db, { site, date, text }, author) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new BadRequest('date and text are required')
  await db.prepare('INSERT INTO changelog (site, date, text, author, created_ts) VALUES (?, ?, ?, ?, ?)').bind(site || null, date, t, author, Date.now()).run()
}

// ---------------------------------------------------------------------------------------------
// Monthly memory: one row per site and month, never deleted.

export async function rollupMonths(db, months) {
  const leadList = LEAD_EVENTS.map(() => '?').join(',')
  for (const month of months) {
    const from = month + '-01'
    const to = month + '-31'
    const { results } = await db
      .prepare(
        `SELECT site, COUNT(DISTINCT date) AS days, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS visits,
                SUM(name = 'pageview') AS pageviews,
                COUNT(DISTINCT CASE WHEN name IN (${leadList}) THEN session_id END) AS contacts,
                COUNT(DISTINCT CASE WHEN name = 'Phone click' THEN session_id END) AS calls,
                COUNT(DISTINCT CASE WHEN name = 'WhatsApp click' THEN session_id END) AS whatsapp,
                COUNT(DISTINCT CASE WHEN name = 'Email click' THEN session_id END) AS emails,
                COUNT(DISTINCT CASE WHEN name = 'Form submit' THEN session_id END) AS forms,
                COUNT(DISTINCT CASE WHEN name = 'Form start' THEN session_id END) AS form_starts
         FROM events WHERE date >= ? AND date <= ? GROUP BY site`
      )
      .bind(...LEAD_EVENTS, from, to)
      .all()
    const { results: ads } = await db
      .prepare('SELECT site, SUM(spend) AS spend, SUM(clicks) AS clicks FROM ads_spend WHERE date >= ? AND date <= ? GROUP BY site')
      .bind(from, to)
      .all()
    const adBy = new Map(ads.map((a) => [a.site, a]))
    const sites = new Set([...results.map((r) => r.site), ...ads.map((a) => a.site)])
    const statements = []
    for (const site of sites) {
      const r = results.find((x) => x.site === site) || {}
      const a = adBy.get(site) || {}
      statements.push(
        db
          .prepare(
            'INSERT OR REPLACE INTO monthly_stats (site, month, days, visitors, visits, pageviews, contacts, calls, whatsapp, emails, forms, form_starts, ad_spend, ad_clicks, updated_ts) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(site, month, r.days || 0, r.visitors || 0, r.visits || 0, r.pageviews || 0, r.contacts || 0, r.calls || 0, r.whatsapp || 0, r.emails || 0, r.forms || 0, r.form_starts || 0, round(a.spend || 0), a.clicks || 0, Date.now())
      )
    }
    for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50))
  }
}

export async function months(db, q) {
  const { results } = await db
    .prepare(
      `SELECT month, SUM(days) AS days, SUM(visitors) AS visitors, SUM(visits) AS visits, SUM(contacts) AS contacts, SUM(calls) AS calls,
              SUM(whatsapp) AS whatsapp, SUM(emails) AS emails, SUM(forms) AS forms, SUM(form_starts) AS form_starts,
              SUM(ad_spend) AS ad_spend, SUM(ad_clicks) AS ad_clicks
       FROM monthly_stats WHERE ${inList('site', q.sites)} GROUP BY month ORDER BY month DESC LIMIT 36`
    )
    .bind(...q.sites)
    .all()
  return { months: results.map((r) => ({ ...r, ad_spend: round(r.ad_spend || 0) })) }
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
  const result = await gbpRange(db, q)
  if (!result.totals || Object.values(result.totals).some((v) => v > 0)) return result
  // Today's rows exist but stay at zero until Google reports the day.
  const window = await latestWindow(db, 'gbp_daily', 'location', result.locations.map((l) => l.location), q.to,
    'impressions_maps + impressions_search + calls + website_clicks + directions > 0')
  if (!window) return result
  return { ...(await gbpRange(db, { ...q, ...window })), fallback: window }
}

async function gbpRange(db, q) {
  const { results: locations } = await db
    .prepare(
      `SELECT l.location, l.name, l.site, l.company, l.website_tagged, r.count AS reviews, r.rating
       FROM gbp_locations l LEFT JOIN gbp_reviews r ON r.location = l.location WHERE ${inList('l.site', q.sites)}`
    )
    .bind(...q.sites)
    .all()
  if (!locations.length) return { locations: [], daily: [], keywords: [], totals: null }
  const ids = locations.map((l) => l.location)
  const [totals, daily, keywords, profileVisits, ever] = await Promise.all([
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
      .all(),
    // a profile that never reported anything is usually not verified yet
    db
      .prepare(
        `SELECT DISTINCT location FROM gbp_daily WHERE ${inList('location', ids)}
         AND impressions_maps + impressions_search + calls + website_clicks + directions > 0`
      )
      .bind(...ids)
      .all()
  ])
  const t = new Map(totals.results.map((r) => [r.location, r]))
  const reporting = new Set(ever.results.map((r) => r.location))
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
      tracked_visits: visits.get(l.site) || 0,
      reporting: reporting.has(l.location),
      website_tagged: !!l.website_tagged
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

// Who acts on a finding and roughly how long it takes. minutes: null means ongoing or just for context.
const KIND = {
  zero_conversions: { owner: 'Google Ads', minutes: 15 },
  tracker_missing: { owner: 'Website', minutes: 5 },
  no_keyword: { owner: 'Google Ads', minutes: 5 },
  keyword_waste: { owner: 'Google Ads', minutes: 15 },
  junk_terms: { owner: 'Google Ads', minutes: 5 },
  tail_terms: { owner: 'Google Ads', minutes: 15 },
  winner_terms: { owner: 'Google Ads', minutes: 10 },
  budget_lost: { owner: 'Google Ads', minutes: 5 },
  rank_lost: { owner: 'Google Ads', minutes: 60 },
  route_landing: { owner: 'Google Ads', minutes: 30 },
  off_hours: { owner: 'Google Ads', minutes: 5 },
  device: { owner: 'Google Ads', minutes: 5 },
  landing_waste: { owner: 'Website', minutes: 60 },
  seo_gap: { owner: 'Website', minutes: 240 },
  organic_overlap: { owner: 'Google Ads', minutes: 5 },
  gbp_silent: { owner: 'Google-Profil', minutes: 15 },
  gbp_reviews: { owner: 'Team', minutes: null },
  gbp_calls: { owner: 'Google-Profil', minutes: null },
  gbp_untagged: { owner: 'Google-Profil', minutes: 5 },
  gbp_keywords: { owner: 'Google Ads', minutes: 30 },
  form_drop: { owner: 'Website', minutes: 30 },
  faq_top: { owner: 'Website', minutes: 15 },
  choices: { owner: 'Google Ads', minutes: 15 },
  sister: { owner: 'Website', minutes: 30 },
  slow_page: { owner: 'Website', minutes: 60 },
  rage: { owner: 'Website', minutes: 30 },
  xray_section: { owner: 'Website', minutes: 30 },
  contact_drop: { owner: 'Team', minutes: 15 },
  silent_traffic: { owner: 'Website', minutes: 30 },
  evening: { owner: 'Team', minutes: null }
}
const SEVERITY_WEIGHT = { high: 3, medium: 2, info: 1 }

// The site a landing page URL belongs to.
function siteOfUrl(url, domains) {
  const host = String(url || '').replace(/^https?:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '').toLowerCase()
  return domains.find((d) => d.replace(/^www\./, '') === host) || null
}

export async function insights(db, q, owner = 'admin') {
  const sites = await siteRows(db, q.sites)
  const names = new Map(sites.map((s) => [s.domain, s.name]))
  const scope = `${inList('site', q.sites)} AND date >= ? AND date <= ?`
  const range = [...q.sites, q.from, q.to]
  const out = []
  const add = (o) => out.push({ ...(KIND[o.kind] || { owner: o.area, minutes: null }), ...o })
  const eur = (n) => `${Math.round(n).toLocaleString('de-DE')} €`
  const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0)

  const [spendRows, trackerRows, adsSessions, ads, gbpData, gscRows, formData, leadData, faqRows, outbound, trackedRows] = await Promise.all([
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
      .all(),
    db.prepare(`SELECT DISTINCT site FROM events WHERE ${inList('site', q.sites)}`).bind(...q.sites).all()
  ])
  const everTracked = new Set(trackedRows.results.map((r) => r.site))

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
        kind: 'zero_conversions',
        area: 'Tracking',
        site: s.site,
        title: `${name}: Google Ads meldet 0 Conversions bei ${eur(s.spend)} Ausgaben`,
        detail:
          (a && a.lead_sessions
            ? `Unser Tracker zählt ${a.lead_sessions} Besuche aus Google Ads mit Anfrage oder Anruf-Klick. `
            : '') +
          'Google zählt Conversions nur bei Besuchern, die Cookies zustimmen; ohne Zustimmung gehen sie bei kleinem Volumen verloren. Für Berichte gelten die Anfragen aus diesem Dashboard.',
        action: 'In Google Ads die Anruf-Conversion als primär markieren und im Google-Tag url_passthrough aktivieren. Vor einem Wechsel auf Conversion-Gebote erst prüfen, ob Google genug Conversions sieht.',
        // a counting problem, not lost money: the spend may well bring enquiries Google cannot see
        value: null
      })
    }
    if ((!t || !t.visitors) && !everTracked.has(s.site)) {
      // never a single event: either just installed or the snippet is missing
      add({
        severity: 'info',
        kind: 'tracker_missing',
        area: 'Tracking',
        site: s.site,
        title: `${name}: noch kein Besuch im eigenen Tracker`,
        detail: `${eur(s.spend)} Werbeausgaben im Zeitraum, aber das Snippet hat noch keinen Besuch gemeldet. Direkt nach dem Einbau ist das normal.`,
        action: 'Wenn nach zwei Tagen weiterhin nichts ankommt: Snippet im Onepage-Kopfbereich prüfen (Seite „Snippets“).',
        value: null
      })
    }
  }
  const noTerm = adsSessions.results.filter((a) => a.sessions >= 5 && a.without_term / a.sessions > 0.5)
  if (noTerm.length) {
    add({
      severity: 'medium',
      kind: 'no_keyword',
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

  // --- Ads: keywords without results, one finding with a table ---
  const keywordWaste = ads.keywords.filter((k) => k.spend >= 15 && !k.conversions && !k.site_leads).slice(0, 10)
  if (keywordWaste.length) {
    const total = keywordWaste.reduce((a, k) => a + k.spend, 0)
    const lowQs = keywordWaste.filter((k) => k.quality_score && k.quality_score <= 4).length
    add({
      kind: 'keyword_waste',
      severity: keywordWaste.some((k) => k.spend >= 40) ? 'high' : 'medium',
      area: 'Google Ads',
      site: new Set(keywordWaste.map((k) => k.site)).size === 1 ? keywordWaste[0].site : null,
      title: keywordWaste.length === 1
        ? `Keyword „${keywordWaste[0].keyword}“ kostet ${eur(total)} ohne Anfrage`
        : `${keywordWaste.length} Keywords kosten ${eur(total)} ohne Anfrage`,
      detail: 'Klicks ohne eine einzige Anfrage, weder laut Google noch laut Website.' + (lowQs ? ` ${lowQs} davon mit schwachem Qualitätsfaktor (≤ 4): Anzeige oder Zielseite passt nicht zur Suche.` : ''),
      action: 'Gebote senken oder pausieren. Vorher unter „Suchbegriffe“ prüfen, welche Suchen dahinter stecken.',
      value: scaleToMonth(total, q),
      table: {
        cols: ['Keyword', 'Klicks', 'Qualität', 'Kosten'],
        rows: keywordWaste.map((k) => ({ site: k.site, cells: [k.keyword, k.clicks, k.quality_score ?? '–', eur(k.spend)] }))
      }
    })
  }

  // --- Ads: search terms to exclude ---
  const junk = ads.search_terms.filter((t) => JUNK_TERMS.test(t.term) && t.spend > 0 && !t.conversions)
  if (junk.length) {
    const total = junk.reduce((a, t) => a + t.spend, 0)
    add({
      kind: 'junk_terms',
      severity: 'high',
      area: 'Google Ads',
      site: junk[0].site,
      title: `${junk.length} Suchbegriffe ohne Kaufabsicht kosten ${eur(total)}`,
      detail: 'Suchen nach Jobs, Anleitungen oder Kostenlosem. Daraus wird kein Auftrag.',
      table: { cols: ['Suchbegriff', 'Kosten'], rows: junk.slice(0, 12).map((t) => ({ site: t.site, cells: [t.term, eur(t.spend)] })) },
      action: 'Als ausschließende Keywords hinzufügen (Phrase): ' + [...new Set(junk.map((t) => (t.term.match(JUNK_TERMS) || [])[0]).filter(Boolean))].join(', '),
      value: scaleToMonth(total, q),
      terms: junk.slice(0, 20).map((t) => ({ site: t.site, campaign: t.campaign, term: t.term, spend: t.spend }))
    })
  }
  const tail = ads.search_terms.filter((t) => !t.is_keyword && !t.conversions && t.spend >= 3 && !JUNK_TERMS.test(t.term))
  if (tail.length >= 3) {
    const total = tail.reduce((a, t) => a + t.spend, 0)
    add({
      kind: 'tail_terms',
      severity: 'medium',
      area: 'Google Ads',
      site: new Set(tail.map((t) => t.site)).size === 1 ? tail[0].site : null,
      title: `${tail.length} Suchbegriffe kosten ${eur(total)} ohne Conversion`,
      detail: 'Suchen, für die keine eigene Anzeige gedacht war und die je mindestens 3 € gekostet haben.',
      table: { cols: ['Suchbegriff', 'Kosten'], rows: tail.slice(0, 12).map((t) => ({ site: t.site, cells: [t.term, eur(t.spend)] })) },
      action: 'Einzeln prüfen: passende als exakte Keywords mit eigener Anzeige, unpassende ausschließen.',
      value: scaleToMonth(total, q),
      terms: tail.slice(0, 30).map((t) => ({ site: t.site, campaign: t.campaign, term: t.term, spend: t.spend }))
    })
  }
  const winners = ads.search_terms.filter((t) => t.conversions > 0 && !t.is_keyword)
  if (winners.length) {
    add({
      kind: 'winner_terms',
      severity: 'medium',
      area: 'Google Ads',
      site: new Set(winners.map((t) => t.site)).size === 1 ? winners[0].site : null,
      title: `${winners.length} Suchbegriffe bringen Anfragen, sind aber keine Keywords`,
      detail: 'Diese Suchen funktionieren. Als eigenes Keyword bekommen sie ein passendes Gebot und eine passende Anzeige.',
      table: { cols: ['Suchbegriff', 'Conversions', 'Kosten'], rows: winners.slice(0, 12).map((t) => ({ site: t.site, cells: [t.term, round(t.conversions, 1), eur(t.spend)] })) },
      action: 'Als exakte Keywords übernehmen, damit Gebot und Anzeige gezielt darauf laufen.',
      value: null,
      terms: winners.slice(0, 20).map((t) => ({ site: t.site, campaign: t.campaign, term: t.term, spend: t.spend, conversions: t.conversions }))
    })
  }

  // --- Ads: impression share ---
  const budgetLost = []
  for (const c of ads.share) {
    const conv = ads.keywords.filter((k) => k.campaign === c.campaign).reduce((a, k) => a + (k.conversions || 0), 0)
    if (c.lost_budget >= 0.2 && conv > 0) budgetLost.push({ ...c, conv })
    else if (c.lost_rank >= 0.5 && c.impressions >= 200) {
      add({
        kind: 'rank_lost',
        severity: 'medium',
        area: 'Google Ads',
        site: c.site,
        title: `${c.campaign}: ${Math.round(c.lost_rank * 100)} % der Einblendungen wegen Anzeigenrang verloren`,
        detail: 'Qualitätsfaktor oder Gebot reichen nicht. Ein schlechter Rang verteuert jeden Klick.',
        action: 'Keywords mit Qualitätsfaktor ≤ 4 auf eine passende Landingpage leiten und Anzeigentexte enger an die Suchbegriffe anlehnen.',
        value: null
      })
    }
  }
  if (budgetLost.length) {
    add({
      kind: 'budget_lost',
      severity: 'high',
      area: 'Google Ads',
      site: budgetLost.length === 1 ? budgetLost[0].site : null,
      title: budgetLost.length === 1
        ? `${budgetLost[0].campaign} geht vorzeitig das Budget aus`
        : `${budgetLost.length} Kampagnen mit Anfragen geht vorzeitig das Budget aus`,
      detail: 'Diese Kampagnen bringen Anfragen, werden aber täglich abgeschaltet, bevor alle passenden Suchen eine Anzeige sehen.',
      action: 'Tagesbudget erhöhen oder Budget von Keywords ohne Anfrage hierher verschieben.',
      value: null,
      table: {
        cols: ['Kampagne', 'Gezeigt', 'Verloren (Budget)', 'Conversions'],
        rows: budgetLost.map((c) => ({ site: c.site, cells: [c.campaign, Math.round((c.impression_share || 0) * 100) + ' %', Math.round(c.lost_budget * 100) + ' %', round(c.conv, 1)] }))
      }
    })
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
  if (routed.size) {
    const list = [...routed.values()].sort((a, b) => b.spend - a.spend)
    const total = list.reduce((a, r) => a + r.spend, 0)
    add({
      kind: 'route_landing',
      severity: 'medium',
      area: 'Synergie',
      site: list.length === 1 ? list[0].lp.domain : null,
      title: list.length === 1
        ? `${eur(total)} für „${list[0].lp.config.service}“-Suchen landen nicht auf der passenden Landingpage`
        : `${eur(total)} für Suchen, zu denen es schon eine eigene Landingpage gibt`,
      detail: 'Für diese Suchen gibt es schon eine Seite, die genau dafür gebaut ist. Die Anzeigen führen aber noch auf die allgemeine Website.',
      action: 'Nach dem Livegang der Landingpage: eigene Anzeigengruppe mit diesen Keywords und der Landingpage als Ziel.',
      value: null,
      table: {
        cols: ['Landingpage', 'Keywords', 'Kosten'],
        rows: list.map((r) => ({ site: r.lp.domain, cells: [r.lp.name, [...new Set(r.keywords)].slice(0, 4).join(', '), eur(r.spend)] }))
      }
    })
  }

  // --- Ads: hours and devices ---
  const off = ads.segments.hour.filter((h) => OFF_HOURS.has(Number(h.key)))
  const offSpend = off.reduce((a, h) => a + h.spend, 0)
  const offConv = off.reduce((a, h) => a + h.conversions, 0)
  if (offSpend >= 10 && !offConv) {
    add({
      kind: 'off_hours',
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
        kind: 'device',
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
  const wasteUrls = ads.segments.url.filter((u) => u.spend >= 20 && !u.conversions).slice(0, 8)
  if (wasteUrls.length) {
    const total = wasteUrls.reduce((a, u) => a + u.spend, 0)
    const sitesOf = wasteUrls.map((u) => siteOfUrl(u.key, q.sites))
    add({
      kind: 'landing_waste',
      severity: 'medium',
      area: 'Google Ads',
      site: new Set(sitesOf).size === 1 ? sitesOf[0] : null,
      title: wasteUrls.length === 1
        ? `Zielseite ${wasteUrls[0].key.replace(/^https?:\/\/(www\.)?/, '')}: ${eur(total)} ohne Anfrage`
        : `${wasteUrls.length} Zielseiten bekommen ${eur(total)} Anzeigenklicks ohne Anfrage`,
      detail: 'Die Besucher kommen aus der Anzeige an, finden dort aber nicht schnell genug den Weg zum Kontakt.',
      action: 'Telefonnummer und WhatsApp in den ersten Bildschirm, Formular kurz halten, oder die Anzeige auf eine passendere Seite leiten.',
      value: scaleToMonth(total, q),
      table: {
        cols: ['Seite', 'Klicks', 'Kosten'],
        rows: wasteUrls.map((u, i) => ({ site: sitesOf[i], cells: [u.key.replace(/^https?:\/\/(www\.)?[^/]+/, '') || '/', u.clicks, eur(u.spend)] }))
      }
    })
  }

  // --- Search Console: demand that ads and pages do not catch yet ---
  const covered = new Set([...ads.keywords.map((k) => norm(k.keyword)), ...ads.search_terms.map((t) => norm(t.term))])
  const brand = /seehafer|brink|hantke|werner|gruppenwerk/i
  const gaps = gscRows.results.filter((r) => r.position > 7 && r.impressions >= 15 && !brand.test(r.query) && !covered.has(norm(r.query)))
  if (gaps.length) {
    add({
      kind: 'seo_gap',
      severity: 'medium',
      area: 'SEO',
      site: new Set(gaps.map((g) => g.site)).size === 1 ? gaps[0].site : null,
      title: `${gaps.length} gefragte Suchen finden uns erst auf Seite 2`,
      detail: 'Diese Suchen kommen regelmäßig vor, aber die Website steht dafür hinter Platz 7 und es läuft keine Anzeige.',
      table: { cols: ['Suche', 'Einblendungen', 'Position'], rows: gaps.slice(0, 12).map((r) => ({ site: r.site, cells: [r.query, r.impressions, round(r.position, 1)] })) },
      action: 'Für die stärksten Begriffe: eigene Abschnitte/Seiten mit dem Begriff in Titel und H1, oder als Keyword testen.',
      value: null,
      terms: gaps.slice(0, 20).map((r) => ({ site: r.site, term: r.query, impressions: r.impressions, position: round(r.position, 1) }))
    })
  }
  const overlap = ads.keywords.filter((k) => k.organic_position && k.organic_position <= 3 && k.organic_impressions >= 20 && k.spend >= 10)
  for (const k of overlap.slice(0, 3)) {
    add({
      kind: 'organic_overlap',
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
  const silentProfiles = gbpData.locations.filter((l) => !l.reporting)
  if (silentProfiles.length) {
    add({
      kind: 'gbp_silent',
      severity: 'medium',
      area: 'Google Business',
      site: silentProfiles.length === 1 ? silentProfiles[0].site : null,
      title: silentProfiles.length === 1
        ? `${silentProfiles[0].name}: Profil liefert keine Zahlen`
        : `${silentProfiles.length} Profile liefern keine Zahlen`,
      detail: 'Google meldet weder Einblendungen noch Anrufe. Fast immer ist das Profil noch nicht bestätigt (Postkarte, Video oder Telefon).',
      action: 'In business.google.com die Bestätigung abschließen; danach füllt sich das Dashboard von selbst.',
      items: silentProfiles.map((l) => ({ site: l.site, label: l.name, value: 'nicht bestätigt?' })),
      value: null
    })
  }
  const fewReviews = gbpData.locations.filter((l) => l.reporting && (l.reviews ?? 0) < 10).sort((a, b) => (a.reviews ?? 0) - (b.reviews ?? 0))
  if (fewReviews.length) {
    const seen = fewReviews.reduce((a, l) => a + l.maps + l.search, 0)
    add({
      kind: 'gbp_reviews',
      severity: fewReviews.some((l) => (l.reviews ?? 0) < 5 && l.maps + l.search >= 50) ? 'high' : 'medium',
      area: 'Google Business',
      site: fewReviews.length === 1 ? fewReviews[0].site : null,
      title: fewReviews.length === 1
        ? `${fewReviews[0].name}: nur ${fewReviews[0].reviews ?? 0} Google-Bewertungen`
        : `${fewReviews.length} Profile haben weniger als 10 Google-Bewertungen`,
      detail: `Zusammen ${seen.toLocaleString('de-DE')} Einblendungen in Maps und Suche im Zeitraum. Bewertungen sind der stärkste Hebel im Kartenranking.`,
      action: 'Nach jedem Auftrag den Bewertungslink per WhatsApp oder SMS schicken; jede Bewertung kurz beantworten.',
      items: fewReviews.map((l) => ({
        site: l.site,
        label: l.name,
        value: `${l.reviews ?? 0} ${(l.reviews ?? 0) === 1 ? 'Bewertung' : 'Bewertungen'}`,
        note: `${(l.maps + l.search).toLocaleString('de-DE')} Einblendungen · ${l.calls} Anrufe`
      })),
      value: null
    })
  }
  for (const l of gbpData.locations) {
    if (l.calls >= 5) {
      add({
        kind: 'gbp_calls',
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
  const untagged = gbpData.locations.filter((l) => l.website >= 3 && !l.website_tagged && !l.tracked_visits)
  if (untagged.length) {
    add({
      kind: 'gbp_untagged',
      severity: 'medium',
      area: 'Tracking',
      site: untagged.length === 1 ? untagged[0].site : null,
      title: `${untagged.reduce((a, l) => a + l.website, 0)} Website-Klicks aus Google-Profilen sind nicht als solche erkennbar`,
      detail: 'Ohne Markierung im Website-Link erscheinen diese Besucher als „Google“ oder „Direkt“ statt als „Google-Profil“.',
      action: 'Den Website-Link im Profil markieren lassen (Claude erledigt das über Windsor in einer Minute).',
      items: untagged.map((l) => ({ site: l.site, label: l.name, value: `${l.website} Klicks` })),
      value: null
    })
  }
  const gbpKeywordsNoAds = gbpData.keywords.filter(
    (k) => !brand.test(k.keyword) && /\s/.test(k.keyword) && !/\b(gmbh|kg|ag|ug)\b/.test(k.keyword) && ![...covered].some((c) => c.includes(k.keyword) || k.keyword.includes(c))
  )
  if (gbpKeywordsNoAds.length) {
    add({
      kind: 'gbp_keywords',
      severity: 'info',
      area: 'Synergie',
      site: null,
      title: `${gbpKeywordsNoAds.length} Suchbegriffe finden das Google-Profil, aber keine Anzeige`,
      detail: 'So suchen Leute, die das Profil in Maps finden. Gute Ideen für Keywords und Überschriften.',
      table: { cols: ['Suchbegriff', 'Profil'], rows: gbpKeywordsNoAds.slice(0, 12).map((k) => ({ site: k.site || null, cells: [k.keyword, k.location_name] })) },
      action: 'Als Keyword-Ideen für Anzeigen und Abschnitte auf den Landingpages nutzen.',
      value: null
    })
  }

  // --- Website: forms, questions, what leads ask for ---
  for (const f of formData.results) {
    if (f.starts >= 5 && f.completion !== null && f.completion < 35) {
      const title = `„${String(f.name || f.form).replace(/[.:\s]+$/, '')}“`
      let detail = 'Viele beginnen, wenige senden ab.'
      if (f.worst && f.worst.of) detail = `Die meisten geben beim Feld „${f.worst.label}“ auf (${f.worst.gave_up} von ${f.worst.of}).`
      add({
        kind: 'form_drop',
        severity: 'high',
        area: 'Website',
        site: q.sites.length === 1 ? q.sites[0] : null,
        title: `Formular ${title}: ${f.starts} begonnen, ${f.leads} gesendet (${f.completion} %)`,
        detail,
        action: f.worst ? `Das Feld „${f.worst.label}“ vereinfachen, optional machen oder später im Rückruf klären.` : 'Den Schritt mit dem größten Abbruch kürzen; Telefon oder E-Mail genügt, Rest beim Rückruf klären.',
        value: null
      })
    }
  }
  if (faqRows.results.length) {
    const f = faqRows.results[0]
    add({
      kind: 'faq_top',
      severity: 'info',
      area: 'Website',
      site: f.site,
      title: `Meistgeöffnete Frage: „${String(f.label || '').replace(/^Q\.\s*/, '')}“`,
      detail: `${f.n} Besuche haben sie aufgeklappt. Was oft gefragt wird, gehört in die Anzeige und weiter nach oben.`,
      action: 'Antwort als Anzeigentext-Zeile oder Hero-Unterzeile testen.',
      value: null
    })
  }
  if (leadData.choices.length) {
    const top = leadData.choices.slice(0, 4)
    add({
      kind: 'choices',
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
      kind: 'sister',
      severity: 'info',
      area: 'Synergie',
      site: null,
      title: `${n} Besuche wechseln zwischen Gruppen-Websites`,
      detail: sister.slice(0, 6).map((o) => `${names.get(o.site) || o.site} → ${String(o.target).replace(/^https?:\/\//, '')} (${o.n})`).join(' · '),
      action: 'Querverweise stärken, wo Leistungen zusammengehören (Leckortung → Trocknung → Malerarbeiten).',
      value: null
    })
  }

  // --- Website: what the new measurements show ---
  const [contentData, timing] = await Promise.all([content(db, q), when(db, q)])
  const slow = contentData.speed.filter((r) => r.n >= 3 && Math.max(r.mobile || 0, r.desktop || 0) > 4000)
  if (slow.length) {
    add({
      kind: 'slow_page',
      severity: 'medium',
      area: 'Website',
      site: q.sites.length === 1 ? q.sites[0] : null,
      title: slow.length === 1 ? `${slow[0].page === '/' ? 'Die Startseite' : slow[0].page} lädt zu langsam` : `${slow.length} Seiten laden zu langsam`,
      detail: 'Über 4 Sekunden, bis der erste Bildschirm steht. Gerade Besucher aus Anzeigen springen dann ab, bevor sie die Telefonnummer sehen.',
      action: 'Große Bilder im ersten Bildschirm verkleinern (WebP, max. 1600 px breit) und Videos erst nach dem Laden starten.',
      value: null,
      table: { cols: ['Seite', 'Handy', 'Computer'], rows: slow.map((r) => ({ site: null, cells: [r.page, r.mobile ? (r.mobile / 1000).toFixed(1).replace('.', ',') + ' s' : '–', r.desktop ? (r.desktop / 1000).toFixed(1).replace('.', ',') + ' s' : '–'] })) }
    })
  }
  const rage = contentData.rage.filter((r) => r.visitors >= 2)
  if (rage.length) {
    add({
      kind: 'rage',
      severity: 'medium',
      area: 'Website',
      site: q.sites.length === 1 ? q.sites[0] : null,
      title: `Besucher klicken wiederholt auf „${rage[0].label}“, und nichts passiert`,
      detail: 'Mehrere schnelle Klicks auf etwas, das kein Link ist. Die Seite verspricht dort etwas, das sie nicht hält.',
      action: 'Das Element anklickbar machen (Großansicht, Link, Telefonnummer als Link) oder so gestalten, dass es nicht nach Knopf aussieht.',
      value: null,
      table: { cols: ['Element', 'Ort', 'Besucher'], rows: rage.slice(0, 8).map((r) => ({ site: null, cells: [r.label, r.section_name || r.section || r.page, r.visitors] })) }
    })
  }
  if (q.sites.length === 1) {
    const x = await xray(db, q, null)
    const total = (c) => Object.values(c).reduce((a, n) => a + n, 0)
    const best = x.sections.reduce((a, s2) => (total(s2.contacts) > (a ? total(a.contacts) : 0) ? s2 : a), null)
    if (best && total(best.contacts) >= 3 && best.reach > 0 && best.reach < 50 && x.sections.indexOf(best) > 0) {
      add({
        kind: 'xray_section',
        severity: 'medium',
        area: 'Website',
        site: q.sites[0],
        title: `„${best.name || best.id}“ bringt die meisten Kontakte, wird aber nur von ${Math.round(best.reach)} % gesehen`,
        detail: `Auf ${x.page === '/' ? 'der Startseite' : x.page} entstehen hier ${total(best.contacts)} Kontakte, obwohl die meisten Besucher vorher aufhören zu scrollen.`,
        action: 'Den Abschnitt oder seinen Kontakt-Knopf weiter nach oben holen und den Effekt im Logbuch festhalten.',
        value: null
      })
    }
  }
  const lateContacts = timing.cells.filter((c) => c.hour >= 18 || c.hour < 7).reduce((a, c) => a + c.n, 0)
  const allContacts = timing.cells.reduce((a, c) => a + c.n, 0)
  if (allContacts >= 5 && lateContacts / allContacts >= 0.3) {
    add({
      kind: 'evening',
      severity: 'info',
      area: 'Website',
      site: q.sites.length === 1 ? q.sites[0] : null,
      title: `${lateContacts} von ${allContacts} Kontakten kommen abends oder früh morgens`,
      detail: 'Dann ist meist niemand am Telefon. Wer abends anruft und niemanden erreicht, ruft oft den nächsten Betrieb an.',
      action: 'Abends WhatsApp und Rückruf-Formular hervorheben und den Rückruf am nächsten Morgen fest zusagen.',
      value: null
    })
  }
  // visitors without a single contact, and contacts falling off week on week
  const since = (await db.prepare(`SELECT site, MIN(date) AS d FROM events WHERE ${inList('site', q.sites)} GROUP BY site`).bind(...q.sites).all()).results
  const sinceOf = new Map(since.map((r) => [r.site, r.d]))
  for (const t of trackerRows.results) {
    if (t.visitors >= 40 && !t.leads) {
      add({
        kind: 'silent_traffic',
        severity: 'medium',
        area: 'Website',
        site: t.site,
        title: `${names.get(t.site) || t.site}: ${t.visitors} Besucher, kein einziger Kontakt`,
        detail: 'Niemand hat angerufen, geschrieben oder das Formular geschickt.',
        action: 'Auf dem Handy prüfen: Ist die Telefonnummer im ersten Bildschirm anklickbar, gibt es einen WhatsApp-Knopf, ist das Formular kurz?',
        value: null
      })
    }
  }
  const weekAgo = addDays(q.to, -6)
  const twoWeeksAgo = addDays(q.to, -13)
  for (const site of q.sites) {
    if (!sinceOf.get(site) || sinceOf.get(site) > twoWeeksAgo) continue
    const row = await db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN date >= ? THEN session_id END) AS now, COUNT(DISTINCT CASE WHEN date < ? THEN session_id END) AS before
         FROM events WHERE site = ? AND date >= ? AND date <= ? AND name IN (${LEAD_EVENTS.map(() => '?').join(',')})`
      )
      .bind(weekAgo, weekAgo, site, twoWeeksAgo, q.to, ...LEAD_EVENTS)
      .first()
    if (row.before >= 4 && row.now <= row.before / 2) {
      add({
        kind: 'contact_drop',
        severity: 'high',
        area: 'Website',
        site,
        title: `${names.get(site) || site}: Kontakte halbiert (${row.before} → ${row.now} pro Woche)`,
        detail: 'Die letzten 7 Tage im Vergleich zu den 7 Tagen davor. Häufige Ursachen: Anzeigen pausiert, Budget leer, Formular oder Telefonlink defekt.',
        action: 'Website auf dem Handy testen (Anruf-Knopf, Formular), Google-Ads-Status und Budget prüfen.',
        value: null
      })
    }
  }

  for (const r of out) r.score = SEVERITY_WEIGHT[r.severity] * 1000 + (r.value || 0)
  out.sort((a, b) => b.score - a.score)
  await attachStates(db, out, owner)
  return { results: out, sites: Object.fromEntries(names) }
}

// A ticked-off item comes back after this long if the rule still fires.
const DONE_FOR_MS = 30 * 86400000

export function insightKey(r) {
  return [r.area, r.site || '', r.title.replace(/[\d.,€%]+/g, '#')].join('|').slice(0, 300)
}

// Each account keeps its own checklist: the stored key is prefixed with the owner.
async function attachStates(db, items, owner) {
  for (const r of items) r.key = insightKey(r)
  if (!items.length) return
  // D1 allows at most 100 bound values per statement
  const stored = (k) => owner + ':' + k
  const keys = [...new Set(items.map((r) => stored(r.key)))]
  const states = new Map()
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90)
    const { results } = await db.prepare(`SELECT key, state, at FROM insight_state WHERE ${inList('key', chunk)}`).bind(...chunk).all()
    for (const x of results) states.set(x.key, x)
  }
  for (const r of items) {
    const st = states.get(stored(r.key))
    r.state = 'open'
    if (!st) continue
    if (st.state === 'done' && Date.now() - st.at > DONE_FOR_MS) r.reopened = true
    else {
      r.state = st.state
      r.state_at = st.at
    }
  }
}

export async function setInsightState(db, rawKey, state, owner) {
  if (typeof rawKey !== 'string' || !rawKey || rawKey.length > 300) throw new BadRequest('key required')
  const key = owner + ':' + rawKey
  if (state === 'open') await db.prepare('DELETE FROM insight_state WHERE key = ?').bind(key).run()
  else if (state === 'done' || state === 'hidden') {
    await db
      .prepare('INSERT INTO insight_state (key, state, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET state = excluded.state, at = excluded.at')
      .bind(key, state, Date.now())
      .run()
  } else throw new BadRequest('state must be open, done or hidden')
  return { key, state }
}
