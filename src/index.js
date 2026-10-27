import trackerSource from './tracker.client.js'
import dashboardHtml from './dashboard.html'
import logoSvg from './logo.svg'
import { handleEvent } from './ingest.js'
import { BadRequest, ads, breakdown, overview, parseQuery, realtime, resolveSites, search, sitesSummary, timeseries } from './stats.js'
import { syncAll } from './sync.js'
import { adsDeep, content, forms, funnel, gbp, insights, leads } from './deep.js'

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  })

function authorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return false
  const header = request.headers.get('Authorization') || ''
  if (!header.startsWith('Basic ')) return false
  let decoded
  try {
    decoded = atob(header.slice(6))
  } catch {
    return false
  }
  const password = decoded.slice(decoded.indexOf(':') + 1)
  const a = new TextEncoder().encode(password)
  const b = new TextEncoder().encode(env.DASHBOARD_PASSWORD)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

const unauthorized = () =>
  new Response('Login required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Gruppenwerk Analytics", charset="UTF-8"' } })

async function api(request, env, url) {
  const db = env.DB
  const path = url.pathname.slice('/api/'.length)

  if (path === 'sites') {
    const { results } = await db
      .prepare(
        `SELECT s.domain, s.name, s.company, s.favicon_url, s.logo_url, s.config, s.ads_account, s.gsc_property,
                c.name AS company_name, c.logo_domain, c.sort, c.favicon_url AS company_favicon, c.logo_url AS company_logo
         FROM sites s LEFT JOIN companies c ON c.id = s.company
         ORDER BY c.sort, c.name, s.domain = c.logo_domain DESC, s.name`
      )
      .all()
    return json(results.map((r) => ({ ...r, config: r.config ? JSON.parse(r.config) : null })))
  }
  if (path === 'tracking') {
    // Last event per site and what the tracker has seen in the last 7 days, for the setup view.
    const since = Date.now() - 7 * 86400000
    const { results } = await db
      .prepare(
        `SELECT site, MAX(ts) AS last_ts, COUNT(*) AS events, COUNT(DISTINCT name) AS kinds,
                GROUP_CONCAT(DISTINCT name) AS names
         FROM events WHERE ts > ? GROUP BY site`
      )
      .bind(since)
      .all()
    const { results: last } = await db.prepare('SELECT site, MAX(ts) AS last_ts FROM events GROUP BY site').all()
    const lastBySite = new Map(last.map((r) => [r.site, r.last_ts]))
    return json(results.map((r) => ({ ...r, names: r.names ? r.names.split(',') : [] })).concat(
      last.filter((r) => !results.some((x) => x.site === r.site)).map((r) => ({ site: r.site, last_ts: lastBySite.get(r.site), events: 0, names: [] }))
    ))
  }
  if (path === 'sites-summary') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) {
      throw new BadRequest('from and to (YYYY-MM-DD) are required')
    }
    return json(await sitesSummary(db, from, to))
  }
  if (path === 'sync' && request.method === 'POST') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 400)
    const detail = url.searchParams.has('detail') ? Math.min(Math.max(Number(url.searchParams.get('detail')) || 0, 0), 90) : Math.min(days, 30)
    return json(await syncAll(env, days, detail))
  }
  if (path === 'sync-log') {
    const { results } = await db.prepare('SELECT * FROM sync_log ORDER BY ts DESC LIMIT 40').all()
    return json(results)
  }
  const sites = await resolveSites(db, url)
  if (path === 'realtime') return json(await realtime(db, sites))

  const q = parseQuery(url, sites)
  switch (path) {
    case 'overview':
      return json(await overview(db, q))
    case 'timeseries':
      return json(await timeseries(db, q))
    case 'breakdown': {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500)
      return json(await breakdown(db, q, url.searchParams.get('dim'), limit))
    }
    case 'ads':
      return json(await ads(db, q))
    case 'search':
      return json(await search(db, q))
    case 'leads':
      return json(await leads(db, q))
    case 'funnel':
      return json(await funnel(db, q))
    case 'forms':
      return json(await forms(db, q))
    case 'content':
      return json(await content(db, q))
    case 'ads-deep':
      return json(await adsDeep(db, q))
    case 'gbp':
      return json(await gbp(db, q))
    case 'insights':
      return json(await insights(db, q))
    default:
      return json({ error: 'not found' }, 404)
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/s.js') {
      return new Response(trackerSource, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }
    if (url.pathname === '/e') return handleEvent(request, env)
    if (url.pathname === '/logo.svg' || url.pathname === '/favicon.ico') {
      return new Response(logoSvg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }
      })
    }

    if (!authorized(request, env)) return unauthorized()

    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url)
      } catch (e) {
        if (e instanceof BadRequest) return json({ error: e.message }, 400)
        console.error(e)
        return json({ error: 'internal error' }, 500)
      }
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(dashboardHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      })
    }
    return new Response('Not found', { status: 404 })
  },

  async scheduled(event, env, ctx) {
    // Keyword level tables are large: the full 30 days once a night, the last 3 days otherwise.
    const nightly = new Date(event.scheduledTime).getUTCHours() < 6
    ctx.waitUntil(syncAll(env, 30, nightly ? 30 : 3))
  }
}
