// Real numbers for the funnel simulator: how many visits there are per month and how many of them
// pass each stage, plus what a visit from Google Ads costs.

import { LEAD_EVENTS, trackingSince, where } from './stats.js'

const CONTACT_SECTION = /anfrage|kontakt|contact|formular|termin|angebot/i

export async function simFunnel(db, q) {
  const w = where(q)
  const since = await trackingSince(db, q.sites)
  const from = since && since > q.from ? since : q.from
  const days = Math.max(1, Math.round((new Date(q.to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1)
  const leadIn = LEAD_EVENTS.map(() => '?').join(',')
  const [rows, ads] = await Promise.all([
    db
      .prepare(
        `SELECT session_id, name, props, label FROM events
         WHERE ${w.sql} AND name IN ('pageview', 'Engagement', 'Form start', ${leadIn}) `
      )
      .bind(...w.params, ...LEAD_EVENTS)
      .all(),
    db
      .prepare(`SELECT SUM(spend) AS spend, SUM(clicks) AS clicks FROM ads_spend WHERE site IN (${q.sites.map(() => '?').join(',')}) AND date >= ? AND date <= ?`)
      .bind(...q.sites, from, q.to)
      .first()
  ])
  const s = new Map()
  for (const r of rows.results) {
    let x = s.get(r.session_id)
    if (!x) { x = { looked: false, area: false, started: false, lead: false }; s.set(r.session_id, x) }
    let p = null
    try { p = r.props ? JSON.parse(r.props) : null } catch {}
    if (r.name === 'Engagement' && p) {
      if ((p.d || 0) >= 10 || (p.t || 0) >= 15) x.looked = true
      if ((p.sec || []).some((id) => CONTACT_SECTION.test(id))) x.area = true
    }
    if (r.name === 'Form start') { x.area = true; x.started = true }
    if (LEAD_EVENTS.includes(r.name)) { x.lead = true; x.area = true; x.started = true; x.looked = true }
  }
  const all = [...s.values()]
  const count = (f) => all.filter(f).length
  const visits = all.length
  // each stage includes everyone who got further, so the funnel never widens
  const looked = count((x) => x.looked || x.area || x.lead)
  const area = count((x) => x.area || x.lead)
  const leads = count((x) => x.lead)
  const month = 30 / days
  return {
    days,
    since: from,
    visits_month: Math.round(visits * month),
    rates: {
      looked: visits ? looked / visits : 0,
      area: looked ? area / looked : 0,
      contact: area ? leads / area : 0
    },
    counts: { visits, looked, area, leads },
    ads: ads && ads.clicks ? { spend_month: Math.round(ads.spend * month), clicks_month: Math.round(ads.clicks * month), cpc: Math.round((ads.spend / ads.clicks) * 100) / 100 } : null
  }
}
