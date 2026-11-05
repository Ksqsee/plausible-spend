// Form enquiries from the Onepage CRM. They cover the time before our tracker ran on a site,
// so the enquiries tab can say what came in before measuring started. Only metadata is stored.

import { trackingSince } from './stats.js'

const KINDS = new Set(['ok', 'test', 'job', 'spam', 'empty', 'duplicate', 'rejected'])
const clip = (v, n) => (v == null ? null : String(v).slice(0, n))

export async function importOpLeads(db, rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000) return { error: 'rows: 1 to 2000 entries' }
  const known = new Set((await db.prepare('SELECT domain FROM sites').all()).results.map((r) => r.domain))
  const now = Date.now()
  const stmts = []
  for (const r of rows) {
    const ts = String(r.ts || '')
    if (!/^[\w-]{6,40}$/.test(String(r.id || '')) || !known.has(r.site) || !/^\d{4}-\d{2}-\d{2}T/.test(ts) || !KINDS.has(r.kind)) {
      return { error: 'invalid row ' + JSON.stringify(r).slice(0, 120) }
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO op_leads (id, site, ts, date, page, source, device, kind, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET site = excluded.site, ts = excluded.ts, date = excluded.date, page = excluded.page,
             source = excluded.source, device = excluded.device, kind = excluded.kind, imported_at = excluded.imported_at`
        )
        .bind(r.id, r.site, ts, ts.slice(0, 10), clip(r.page, 200), clip(r.source || '', 60), clip(r.device, 20), r.kind, now)
    )
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50))
  return { ok: true, rows: stmts.length }
}

// Enquiries that arrived before our tracker started on the chosen sites. Each site has its own
// start, so a site measured from day one adds nothing here.
export async function opLeadsBefore(db, sites) {
  if (!sites.length) return { total: 0 }
  const starts = await Promise.all(sites.map(async (s) => [s, await trackingSince(db, [s])]))
  const parts = starts.map(([s, d]) => ({ s, d: d || '9999-12-31' }))
  const where = parts.map(() => '(site = ? AND date < ?)').join(' OR ')
  const params = parts.flatMap((p) => [p.s, p.d])
  const { results } = await db.prepare(`SELECT site, date, page, source, device, kind FROM op_leads WHERE ${where} ORDER BY date`).bind(...params).all()
  const ok = results.filter((r) => r.kind === 'ok')
  const left = {}
  results.forEach((r) => { if (r.kind !== 'ok') left[r.kind] = (left[r.kind] || 0) + 1 })
  const count = (key) => {
    const m = new Map()
    ok.forEach((r) => m.set(r[key] || '', (m.get(r[key] || '') || 0) + 1))
    return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n)
  }
  const month = new Map()
  ok.forEach((r) => month.set(r.date.slice(0, 7), (month.get(r.date.slice(0, 7)) || 0) + 1))
  const measured = parts.filter((p) => p.d !== '9999-12-31').map((p) => p.d).sort()
  return {
    total: ok.length,
    first: ok.length ? ok[0].date : null,
    tracking_since: measured.length ? measured[measured.length - 1] : null,
    left_out: left,
    sources: count('source'),
    pages: count('page'),
    devices: count('device'),
    months: [...month].map(([m, n]) => ({ month: m, n })),
    sites: count('site')
  }
}
