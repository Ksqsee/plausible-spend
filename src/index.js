import trackerSource from './tracker.client.js'
import dashboardHtml from './dashboard.html'
import loginHtml from './login.html'
import logoSvg from './logo.svg'
import gwSvg from './gw.svg'
import icons from './icons.js'
import interFont from './fonts/inter-400-700.woff2'
import interTightFont from './fonts/inter-tight-500-700.woff2'
import monoFont from './fonts/dm-mono-400.woff2'
import monoMediumFont from './fonts/dm-mono-500.woff2'

// fonts are served from here so viewers' browsers never contact Google
const FONTS = { 'inter.woff2': interFont, 'inter-tight.woff2': interTightFont, 'dm-mono-400.woff2': monoFont, 'dm-mono-500.woff2': monoMediumFont }
import { handleEvent } from './ingest.js'
import { BadRequest, Forbidden, MAX_RANGE_DAYS, ads, breakdown, overview, parseQuery, realtime, resolveSites, search, sitesSummary, timeseries } from './stats.js'
import { syncAll } from './sync.js'
import { adsDeep, content, forms, funnel, gbp, insights, leads, paths, setInsightState, when, xray } from './deep.js'
import { MIN_PASSWORD_LENGTH, checkPassword, currentUser, ensureAdmin, generatePassword, login, logout, setPassword } from './auth.js'

// Headers every dashboard response carries: no framing, no MIME sniffing, no referrer to third parties.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // same-origin, not no-referrer: with no-referrer Chrome sends "Origin: null" and the CSRF check below would refuse real logins
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
}

const json = (data, status = 200, extra) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...BASE_HEADERS, ...extra }
  })

// Pages get a per-request nonce so only our own inline script runs, never injected markup.
function page(htmlText, status = 200, extra) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https://onecdn.io https://icons.duckduckgo.com https://cdn.jsdelivr.net",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
  return new Response(htmlText.replace(/<script>/g, `<script nonce="${nonce}">`), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, ...BASE_HEADERS, ...extra }
  })
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function loginPage(error = '', username = '', status = 200) {
  return page(loginHtml.replace('<!--ERROR-->', escapeHtml(error)).replace('<!--USERNAME-->', escapeHtml(username)), status)
}

// State-changing requests must come from the dashboard itself, not from another site the user has open.
function sameOrigin(request, url) {
  const origin = request.headers.get('Origin')
  if (origin && origin !== 'null') return origin === url.origin
  return request.headers.get('Sec-Fetch-Site') === 'same-origin'
}

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) throw new BadRequest('JSON body required')
  const text = await request.text()
  if (text.length > 10000) throw new BadRequest('body too large')
  try {
    return JSON.parse(text)
  } catch {
    throw new BadRequest('JSON body required')
  }
}

function adminOnly(user) {
  if (user.role !== 'admin') throw new Forbidden('admin only')
}

async function api(request, env, url, user) {
  const db = env.DB
  const path = url.pathname.slice('/api/'.length)
  const own = user.role === 'admin' ? null : user.company

  if (path === 'me') return json({ username: user.username, role: user.role, company: user.company })

  if (path === 'sites') {
    const { results } = await db
      .prepare(
        `SELECT s.domain, s.name, s.company, s.favicon_url, s.logo_url, s.config, s.ads_account, s.gsc_property,
                c.name AS company_name, c.logo_domain, c.sort, c.favicon_url AS company_favicon, c.logo_url AS company_logo
         FROM sites s LEFT JOIN companies c ON c.id = s.company
         WHERE ? IS NULL OR s.company = ?
         ORDER BY c.sort, c.name, s.domain = c.logo_domain DESC, s.name`
      )
      .bind(own, own)
      .all()
    return json(results.map((r) => ({ ...r, config: r.config ? JSON.parse(r.config) : null })))
  }
  if (path === 'tracking') {
    // Last event per site and what the tracker has seen in the last 7 days, for the setup view.
    adminOnly(user)
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
    if ((new Date(to) - new Date(from)) / 86400000 > MAX_RANGE_DAYS) throw new BadRequest('range too long')
    const rows = await sitesSummary(db, from, to)
    if (!own) return json(rows)
    const mine = new Set((await db.prepare('SELECT domain FROM sites WHERE company = ?').bind(own).all()).results.map((r) => r.domain))
    return json(rows.filter((r) => mine.has(r.domain)))
  }
  if (path === 'sync' && request.method === 'POST') {
    adminOnly(user)
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 400)
    const detail = url.searchParams.has('detail') ? Math.min(Math.max(Number(url.searchParams.get('detail')) || 0, 0), 90) : Math.min(days, 30)
    return json(await syncAll(env, days, detail))
  }
  if (path === 'sync-log') {
    adminOnly(user)
    const { results } = await db.prepare('SELECT * FROM sync_log ORDER BY ts DESC LIMIT 40').all()
    return json(results)
  }
  if (path === 'insight-state' && request.method === 'POST') {
    const body = await readJson(request)
    return json(await setInsightState(db, body.key, body.state, own || 'admin'))
  }

  // --- accounts ---
  if (path === 'me/password' && request.method === 'POST') {
    const body = await readJson(request)
    if (!(await checkPassword(env, user.id, body.current))) throw new BadRequest('Das aktuelle Passwort stimmt nicht.')
    if (typeof body.next !== 'string' || body.next.length < MIN_PASSWORD_LENGTH || body.next.length > 200) {
      throw new BadRequest('Das neue Passwort braucht mindestens ' + MIN_PASSWORD_LENGTH + ' Zeichen.')
    }
    await setPassword(env, user.id, body.next)
    return json({ ok: true })
  }
  if (path === 'users') {
    adminOnly(user)
    if (request.method === 'GET') {
      const { results } = await db
        .prepare(
          `SELECT c.id AS company, c.name, u.username, u.last_login, u.disabled, u.created_at
           FROM companies c LEFT JOIN users u ON u.company = c.id AND u.role = 'company' ORDER BY c.sort, c.name`
        )
        .all()
      return json(results)
    }
    if (request.method === 'POST') {
      // create or reset a company login; returns the password once, it is not stored in readable form
      const body = await readJson(request)
      const company = await db.prepare('SELECT id FROM companies WHERE id = ?').bind(String(body.company || '')).first()
      if (!company) throw new BadRequest('unknown company')
      if (body.action === 'disable') {
        await db.batch([
          db.prepare("UPDATE users SET disabled = 1 WHERE company = ? AND role = 'company'").bind(company.id),
          db.prepare("DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE company = ? AND role = 'company')").bind(company.id)
        ])
        return json({ ok: true })
      }
      const password = body.password ? String(body.password) : generatePassword()
      if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) throw new BadRequest('Das Passwort braucht mindestens ' + MIN_PASSWORD_LENGTH + ' Zeichen.')
      let row = await db.prepare("SELECT id FROM users WHERE company = ? AND role = 'company'").bind(company.id).first()
      if (!row) {
        await db
          .prepare("INSERT INTO users (username, role, company, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, 'company', ?, 'x', '00', 1, ?)")
          .bind(company.id, company.id, Date.now())
          .run()
        row = await db.prepare("SELECT id FROM users WHERE company = ? AND role = 'company'").bind(company.id).first()
      }
      await setPassword(env, row.id, password)
      return json({ username: company.id, password })
    }
  }

  const sites = await resolveSites(db, url, user)
  if (path === 'realtime') return json(await realtime(db, sites))

  const q = parseQuery(url, sites)
  switch (path) {
    case 'overview':
      return json(await overview(db, q))
    case 'timeseries':
      return json(await timeseries(db, q))
    case 'breakdown': {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500)
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
    case 'xray':
      return json(await xray(db, q, url.searchParams.get('xpage')))
    case 'when':
      return json(await when(db, q))
    case 'paths':
      return json(await paths(db, q))
    case 'ads-deep':
      return json(await adsDeep(db, q))
    case 'gbp':
      return json(await gbp(db, q))
    case 'insights':
      return json(await insights(db, q, own || 'admin'))
    default:
      return json({ error: 'not found' }, 404)
  }
}

const RETENTION_DAYS = 760

async function purgeOld(db) {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000
  await db.batch([
    db.prepare('DELETE FROM events WHERE ts < ?').bind(cutoff),
    db.prepare('DELETE FROM sessions WHERE last_ts < ?').bind(cutoff),
    db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(Date.now()),
    db.prepare('DELETE FROM login_attempts WHERE first_at < ? AND locked_until < ?').bind(Date.now() - 86400000, Date.now())
  ])
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // --- public: tracker, event intake, logos ---
    if (url.pathname === '/s.js') {
      return new Response(trackerSource, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    }
    if (url.pathname === '/e') return handleEvent(request, env)
    if (url.pathname === '/logo.svg' || url.pathname === '/favicon.ico' || url.pathname === '/gw.svg') {
      return new Response(url.pathname === '/gw.svg' ? gwSvg : logoSvg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }
      })
    }
    const icon = url.pathname.match(/^\/i\/([a-z0-9-]+)\.svg$/)
    if (icon && Object.prototype.hasOwnProperty.call(icons, icon[1])) {
      return new Response(icons[icon[1]], {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' }
      })
    }
    const font = url.pathname.match(/^\/f\/([a-z0-9-]+\.woff2)$/)
    if (font && Object.prototype.hasOwnProperty.call(FONTS, font[1])) {
      return new Response(FONTS[font[1]], {
        headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }
      })
    }
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } })

    // --- login / logout ---
    if (url.pathname === '/login') {
      await ensureAdmin(env)
      if (request.method === 'GET') return (await currentUser(request, env)) ? Response.redirect(url.origin + '/', 303) : loginPage()
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
      if (!sameOrigin(request, url)) return loginPage('Anmeldung nur über diese Seite möglich.', '', 403)
      const form = await request.formData().catch(() => null)
      const username = form ? String(form.get('username') || '') : ''
      const result = await login(request, env, username, form ? form.get('password') : '')
      if (result.error) return loginPage(result.error, username.slice(0, 64), result.status)
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': result.cookie, 'Cache-Control': 'no-store' } })
    }
    if (url.pathname === '/logout') {
      if (request.method !== 'POST' || !sameOrigin(request, url)) return new Response('Method not allowed', { status: 405 })
      return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': await logout(request, env), 'Cache-Control': 'no-store' } })
    }

    // --- everything else needs a signed-in user ---
    const user = await currentUser(request, env)
    if (url.pathname.startsWith('/api/')) {
      if (!user) return json({ error: 'login required' }, 401)
      if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request, url)) return json({ error: 'forbidden' }, 403)
      try {
        return await api(request, env, url, user)
      } catch (e) {
        if (e instanceof BadRequest) return json({ error: e.message }, 400)
        if (e instanceof Forbidden) return json({ error: 'forbidden' }, 403)
        console.error(e)
        return json({ error: 'internal error' }, 500)
      }
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!user) return Response.redirect(url.origin + '/login', 303)
      return page(dashboardHtml)
    }
    return new Response('Not found', { status: 404, headers: BASE_HEADERS })
  },

  async scheduled(event, env, ctx) {
    // Keyword level tables are large: the full 30 days once a night, the last 3 days otherwise.
    const nightly = new Date(event.scheduledTime).getUTCHours() < 6
    ctx.waitUntil(syncAll(env, 30, nightly ? 30 : 3))
    // visit data is kept for 25 months, then deleted (data minimisation)
    if (nightly) ctx.waitUntil(purgeOld(env.DB))
  }
}
