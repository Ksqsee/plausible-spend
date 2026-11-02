// Heatmap data for one page: click clusters, how far people scroll, and the sections with their
// reach and contacts, all in the geometry of the device the screenshot shows.

import { LEAD_EVENTS, where } from './stats.js'

const DEVICE_CLASSES = { desktop: ['Laptop', 'Desktop'], mobile: ['Mobile'] }
const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

export async function heat(db, q, page, device) {
  const classes = DEVICE_CLASSES[device] || DEVICE_CLASSES.desktop
  const w = where(q)
  const devIn = classes.map(() => '?').join(',')
  const [pages, clicks, eng, geo, names, contacts] = await Promise.all([
    db
      .prepare(
        `SELECT page, COUNT(DISTINCT session_id) AS visits FROM events WHERE ${w.sql} AND name = 'pageview' AND device IN (${devIn})
         GROUP BY page ORDER BY visits DESC LIMIT 12`
      )
      .bind(...w.params, ...classes)
      .all(),
    db
      .prepare(
        `SELECT x, y, ph, target, section FROM heat_clicks
         WHERE site IN (${q.sites.map(() => '?').join(',')}) AND page = ? AND device = ? AND date >= ? AND date <= ? LIMIT 5000`
      )
      .bind(...q.sites, page, device, q.from, q.to)
      .all(),
    db
      .prepare(`SELECT props FROM events WHERE ${w.sql} AND name = 'Engagement' AND page = ? AND device IN (${devIn})`)
      .bind(...w.params, page, ...classes)
      .all(),
    db.prepare(`SELECT ph, vh, vw, sections FROM page_geo WHERE site IN (${q.sites.map(() => '?').join(',')}) AND page = ? AND device = ? ORDER BY updated_ts DESC LIMIT 1`)
      .bind(...q.sites, page, device)
      .first(),
    db.prepare(`SELECT id, name FROM section_names WHERE site IN (${q.sites.map(() => '?').join(',')})`).bind(...q.sites).all(),
    db
      .prepare(
        `SELECT json_extract(props, '$.section') AS section, name, COUNT(DISTINCT session_id) AS n FROM events
         WHERE ${w.sql} AND page = ? AND device IN (${devIn}) AND name IN (${LEAD_EVENTS.map(() => '?').join(',')}) GROUP BY section, name`
      )
      .bind(...w.params, page, ...classes, ...LEAD_EVENTS)
      .all()
  ])

  // scroll reach: share of page views that got at least this far, in 2 % steps
  const depths = []
  const seen = new Map()
  for (const r of eng.results) {
    const p = parse(r.props) || {}
    if (typeof p.d === 'number') depths.push(Math.max(0, Math.min(100, p.d)))
    for (const id of Array.isArray(p.sec) ? p.sec : []) seen.set(id, (seen.get(id) || 0) + 1)
  }
  const views = depths.length
  const reach = []
  for (let pct = 0; pct <= 100; pct += 2) reach.push(views ? Math.round((depths.filter((d) => d >= pct).length / views) * 1000) / 10 : 0)

  // clicks as relative positions, so they fit any screenshot of the page
  const points = clicks.results.filter((c) => c.ph > 0).map((c) => ({ x: c.x / 1000, y: Math.min(1, c.y / c.ph), target: c.target, section: c.section }))
  const targets = new Map()
  for (const c of points) if (c.target) targets.set(c.target, (targets.get(c.target) || 0) + 1)

  const nameOf = Object.fromEntries(names.results.map((r) => [r.id, r.name]))
  const byContact = new Map()
  for (const r of contacts.results) {
    if (!r.section) continue
    const c = byContact.get(r.section) || {}
    c[r.name] = (c[r.name] || 0) + r.n
    byContact.set(r.section, c)
  }
  const g = geo ? { ph: geo.ph, vh: geo.vh, vw: geo.vw, sections: parse(geo.sections) || [] } : null
  return {
    pages: pages.results,
    page,
    device,
    views,
    reach,
    fold: g && g.ph ? Math.min(1, g.vh / g.ph) : null,
    clicks: points,
    targets: [...targets.entries()].map(([target, n]) => ({ target, n })).sort((a, b) => b.n - a.n).slice(0, 12),
    sections: g
      ? g.sections.map(([id, top, height]) => ({
          id,
          name: nameOf[id] || null,
          top: top / g.ph,
          height: height / g.ph,
          reach: views ? Math.round(((seen.get(id) || 0) / views) * 1000) / 10 : 0,
          contacts: byContact.get(id) || {}
        }))
      : []
  }
}
