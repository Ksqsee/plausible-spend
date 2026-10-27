import trackerSource from './tracker.client.js'
import dashboardHtml from './dashboard.html'
import logoSvg from './logo.svg'
import { handleEvent } from './ingest.js'
import { BadRequest, ads, breakdown, overview, parseQuery, realtime, resolveSites, search, sitesSummary, timeseries } from './stats.js'
import { syncAll } from './sync.js'

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
        `SELECT s.domain, s.name, s.company, c.name AS company_name, c.logo_domain, c.sort
         FROM sites s LEFT JOIN companies c ON c.id = s.company
         ORDER BY c.sort, c.name, s.domain = c.logo_domain DESC, s.name`
      )
      .all()
    return json(results)
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
    return json(await syncAll(env, days))
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

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(syncAll(env, 30))
  }
}
