// Search Console straight from Google with a service account (secret GSC_SERVICE_ACCOUNT, the
// JSON key). Free, up to 25,000 rows per request. While GSC_SOURCE is not 'google' the rows go to
// shadow tables only, so they can be compared with the Windsor copy before switching over.

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
const API = 'https://searchconsole.googleapis.com/webmasters/v3'
let cached = null

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlStr = (s) => b64url(new TextEncoder().encode(s))

function account(env) {
  if (!env.GSC_SERVICE_ACCOUNT) return null
  try {
    const a = JSON.parse(env.GSC_SERVICE_ACCOUNT)
    return a.client_email && a.private_key ? a : null
  } catch {
    return null
  }
}
export const gscConfigured = (env) => !!account(env)

async function token(env) {
  if (cached && cached.exp > Date.now() + 60000) return cached.token
  const a = account(env)
  if (!a) throw new Error('GSC_SERVICE_ACCOUNT fehlt oder ist kein gültiger JSON-Schlüssel')
  const pem = a.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const now = Math.floor(Date.now() / 1000)
  const head = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64urlStr(JSON.stringify({ iss: a.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))
  const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body)))
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + body + '.' + sig
  })
  const d = await r.json()
  if (!r.ok || !d.access_token) throw new Error('Google-Anmeldung fehlgeschlagen: ' + (d.error_description || d.error || r.status))
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 }
  return cached.token
}

async function call(env, path, body) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + (await token(env)), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error('Search Console ' + r.status + ': ' + ((d.error && d.error.message) || '').slice(0, 200))
  return d
}

// properties the service account can read
export async function gscProperties(env) {
  const d = await call(env, '/sites')
  return (d.siteEntry || []).map((s) => ({ property: s.siteUrl, permission: s.permissionLevel }))
}

async function rows(env, property, dims, from, to) {
  const out = []
  for (let start = 0; start < 100000; start += 25000) {
    const d = await call(env, '/sites/' + encodeURIComponent(property) + '/searchAnalytics/query', {
      startDate: from, endDate: to, dimensions: dims, rowLimit: 25000, startRow: start, dataState: 'all'
    })
    const r = d.rows || []
    out.push(...r)
    if (r.length < 25000) break
  }
  return out
}

async function replace(db, table, site, from, stmts) {
  const batch = [db.prepare(`DELETE FROM ${table} WHERE site = ? AND date >= ?`).bind(site, from), ...stmts]
  for (let i = 0; i < batch.length; i += 90) await db.batch(batch.slice(i, i + 90))
}

export async function syncSearchDirect(env, site, from, to, live) {
  const t = live ? 'search_queries' : 'search_queries_g'
  const list = await rows(env, site.gsc_property, ['date', 'query'], from, to)
  const stmts = list.map((r) =>
    env.DB.prepare(`INSERT INTO ${t} (site, date, query, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?)`).bind(
      site.domain, r.keys[0], String(r.keys[1]).slice(0, 300), r.clicks || 0, r.impressions || 0, Math.round((r.position || 0) * 10) / 10
    )
  )
  await replace(env.DB, t, site.domain, from, stmts)
  return stmts.length
}

export async function syncSearchPagesDirect(env, site, from, to, live) {
  const t = live ? 'search_pages' : 'search_pages_g'
  const list = await rows(env, site.gsc_property, ['date', 'query', 'page'], from, to)
  const stmts = list.map((r) =>
    env.DB.prepare(`INSERT INTO ${t} (site, date, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      site.domain, r.keys[0], String(r.keys[1]).slice(0, 300), String(r.keys[2]).slice(0, 300), r.clicks || 0, r.impressions || 0, Math.round((r.position || 0) * 10) / 10
    )
  )
  await replace(env.DB, t, site.domain, from, stmts)
  return stmts.length
}

// side-by-side totals of the Windsor copy and the direct copy, per site and day range
export async function gscCompare(env, from, to) {
  const out = { configured: gscConfigured(env), source: env.GSC_SOURCE === 'google' ? 'google' : 'windsor' }
  if (!out.configured) return out
  try {
    out.properties = await gscProperties(env)
  } catch (e) {
    out.error = String(e.message || e)
    return out
  }
  const { results: sites } = await env.DB.prepare('SELECT domain, gsc_property FROM sites WHERE gsc_property IS NOT NULL').all()
  const sum = (t, s) => env.DB.prepare(`SELECT COUNT(*) AS rows, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM ${t} WHERE site = ? AND date >= ? AND date <= ?`).bind(s, from, to).first()
  out.sites = await Promise.all(
    sites.map(async (s) => ({
      site: s.domain,
      property: s.gsc_property,
      readable: out.properties.some((p) => p.property === s.gsc_property),
      windsor: await sum('search_queries', s.domain),
      direct: await sum('search_queries_g', s.domain)
    }))
  )
  return out
}
