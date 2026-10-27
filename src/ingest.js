// Receives events from the tracker, counts visitors without cookies.

const SESSION_TIMEOUT_MS = 30 * 60 * 1000
const TIME_ZONE = 'Europe/Berlin'

const BOT_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|headless|lighthouse|pagespeed|preview|monitor|curl|wget|python-requests|axios|go-http|java\/|httpclient|scrapy|phantom|selenium|puppeteer|playwright/i

const SOURCES = [
  [/(^|\.)google\./, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)ecosia\.org$/, 'Ecosia'],
  [/(^|\.)yahoo\./, 'Yahoo'],
  [/(^|\.)qwant\.com$/, 'Qwant'],
  [/(^|\.)(facebook\.com|fb\.com|l\.facebook\.com|m\.facebook\.com)$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'LinkedIn'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'X'],
  [/(^|\.)youtube\.com$/, 'YouTube'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)pinterest\./, 'Pinterest'],
  [/(^|\.)(chatgpt\.com|chat\.openai\.com)$/, 'ChatGPT'],
  [/(^|\.)perplexity\.ai$/, 'Perplexity'],
  [/(^|\.)claude\.ai$/, 'Claude'],
  [/(^|\.)gemini\.google\.com$/, 'Gemini'],
  [/(^|\.)copilot\.microsoft\.com$/, 'Copilot'],
  [/(^|\.)(myhammer\.de|my-hammer\.de)$/, 'MyHammer'],
  [/(^|\.)gelbeseiten\.de$/, 'Gelbe Seiten'],
  [/(^|\.)11880\.com$/, '11880'],
  [/(^|\.)(wa\.me|whatsapp\.com)$/, 'WhatsApp']
]

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

export function localParts(ts) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value])
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
}

export function sourceFromReferrer(referrer, pageHost) {
  if (!referrer) return null
  let host
  try {
    host = new URL(referrer).hostname.toLowerCase()
  } catch {
    return null
  }
  if (!host || host === pageHost || host.replace(/^www\./, '') === pageHost.replace(/^www\./, '')) return null
  for (const [re, name] of SOURCES) if (re.test(host)) return name
  return host.replace(/^www\./, '')
}

export function deviceFromWidth(width) {
  const w = Number(width) || 0
  if (!w) return '(unknown)'
  if (w < 576) return 'Mobile'
  if (w < 992) return 'Tablet'
  if (w < 1440) return 'Laptop'
  return 'Desktop'
}

export function parseUserAgent(ua) {
  const browser =
    (/Edg(e|A|iOS)?\//.test(ua) && 'Edge') ||
    (/OPR\/|Opera/.test(ua) && 'Opera') ||
    (/SamsungBrowser/.test(ua) && 'Samsung Internet') ||
    (/Firefox|FxiOS/.test(ua) && 'Firefox') ||
    (/CriOS|Chrome\//.test(ua) && 'Chrome') ||
    (/Safari\//.test(ua) && 'Safari') ||
    '(other)'
  const os =
    (/Windows/.test(ua) && 'Windows') ||
    (/iPhone|iPad|iPod/.test(ua) && 'iOS') ||
    (/Android/.test(ua) && 'Android') ||
    (/Mac OS X|Macintosh/.test(ua) && 'macOS') ||
    (/CrOS/.test(ua) && 'ChromeOS') ||
    (/Linux/.test(ua) && 'Linux') ||
    '(other)'
  return { browser, os }
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function dailySalt(db, day) {
  let row = await db.prepare('SELECT salt FROM salts WHERE day = ?').bind(day).first()
  if (!row) {
    const salt = crypto.randomUUID() + crypto.randomUUID()
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)').bind(day, salt),
      db.prepare('DELETE FROM salts WHERE day < ?').bind(day)
    ])
    row = await db.prepare('SELECT salt FROM salts WHERE day = ?').bind(day).first()
  }
  return row.salt
}

function clean(value, max = 200) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s ? s.slice(0, max) : null
}

let sitesCache = { at: 0, sites: new Map() }

async function loadSites(db) {
  if (Date.now() - sitesCache.at < 60_000) return sitesCache.sites
  const { results } = await db.prepare('SELECT domain, hostnames FROM sites').all()
  const sites = new Map(results.map((s) => [s.domain, s.hostnames.split(',').map((h) => h.trim().toLowerCase())]))
  sitesCache = { at: Date.now(), sites }
  return sites
}

export async function handleEvent(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })

  const accepted = () => new Response('ok', { status: 202, headers: corsHeaders })

  const ua = request.headers.get('User-Agent') || ''
  if (!ua || BOT_RE.test(ua)) return accepted()

  let payload
  try {
    payload = JSON.parse(await request.text())
  } catch {
    return new Response('Bad request', { status: 400, headers: corsHeaders })
  }

  let url
  try {
    url = new URL(payload.u)
  } catch {
    return new Response('Bad request', { status: 400, headers: corsHeaders })
  }

  const site = clean(payload.d, 100)
  const sites = await loadSites(env.DB)
  const allowedHosts = sites.get(site)
  const hostname = url.hostname.toLowerCase()
  // Unknown sites and foreign hostnames (e.g. a site builder's editor preview) are dropped.
  if (!allowedHosts || !allowedHosts.includes(hostname)) return accepted()

  const name = clean(payload.n, 80) || 'pageview'
  const now = Date.now()
  const { date, hour } = localParts(now)
  const ip = request.headers.get('CF-Connecting-IP') || ''
  const salt = await dailySalt(env.DB, date)
  const visitorId = (await sha256Hex(`${salt}|${site}|${ip}|${ua}`)).slice(0, 20)

  const page = (url.pathname || '/').slice(0, 300)
  const params = url.searchParams
  const referrer = clean(payload.r, 500)
  const refSource = sourceFromReferrer(referrer, hostname)
  const utm = {
    source: clean(params.get('utm_source'), 100),
    medium: clean(params.get('utm_medium'), 100),
    campaign: clean(params.get('utm_campaign'), 150),
    content: clean(params.get('utm_content'), 150),
    term: clean(params.get('utm_term'), 150)
  }
  if (!utm.source && (params.has('gclid') || params.has('gbraid') || params.has('wbraid'))) {
    utm.source = 'google'
    utm.medium = utm.medium || 'cpc'
  }
  if (!utm.source && params.has('fbclid')) utm.source = 'facebook'
  const isAdClick = utm.medium && /^(cpc|ppc|paid|paidsearch|paid_search|display|paid_social)$/i.test(utm.medium)
  const source =
    (utm.source && (isAdClick && /google/i.test(utm.source) ? 'Google Ads' : capitalizeSource(utm.source))) ||
    refSource ||
    'Direct / None'

  const cf = request.cf || {}
  const { browser, os } = parseUserAgent(ua)
  const device = deviceFromWidth(payload.w)
  const isPageview = name === 'pageview'

  const props = payload.p && typeof payload.p === 'object' ? payload.p : null
  const label = props ? clean(props.label, 100) : null
  const propsJson = props ? JSON.stringify(props).slice(0, 1000) : null

  const db = env.DB
  const last = await db
    .prepare(
      'SELECT id, source, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term FROM sessions ' +
        'WHERE site = ? AND visitor_id = ? AND last_ts > ? ORDER BY last_ts DESC LIMIT 1'
    )
    .bind(site, visitorId, now - SESSION_TIMEOUT_MS)
    .first()

  let sessionId
  let attrs
  const statements = []

  if (last) {
    // Later events keep the attribution of the visit they belong to.
    sessionId = last.id
    attrs = last
    statements.push(
      db
        .prepare(
          'UPDATE sessions SET last_ts = ?, events = events + 1, pageviews = pageviews + ?, ' +
            'exit_page = CASE WHEN ? THEN ? ELSE exit_page END WHERE id = ?'
        )
        .bind(now, isPageview ? 1 : 0, isPageview ? 1 : 0, page, sessionId)
    )
  } else {
    sessionId = crypto.randomUUID()
    attrs = {
      source,
      referrer: refSource ? referrer : null,
      utm_source: utm.source,
      utm_medium: utm.medium,
      utm_campaign: utm.campaign,
      utm_content: utm.content,
      utm_term: utm.term
    }
    statements.push(
      db
        .prepare(
          'INSERT INTO sessions (id, site, visitor_id, start_ts, last_ts, date, entry_page, exit_page, pageviews, events, ' +
            'source, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          sessionId,
          site,
          visitorId,
          now,
          now,
          date,
          page,
          page,
          isPageview ? 1 : 0,
          attrs.source,
          attrs.referrer,
          attrs.utm_source,
          attrs.utm_medium,
          attrs.utm_campaign,
          attrs.utm_content,
          attrs.utm_term
        )
    )
  }

  statements.push(
    db
      .prepare(
        'INSERT INTO events (site, ts, date, hour, name, page, hostname, visitor_id, session_id, source, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, country, region, city, device, browser, os, label, props) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        site,
        now,
        date,
        hour,
        name,
        page,
        hostname,
        visitorId,
        sessionId,
        attrs.source,
        attrs.referrer,
        attrs.utm_source,
        attrs.utm_medium,
        attrs.utm_campaign,
        attrs.utm_content,
        attrs.utm_term,
        clean(cf.country, 2),
        clean(cf.region, 100),
        clean(cf.city, 100),
        device,
        browser,
        os,
        label,
        propsJson
      )
  )

  await db.batch(statements)
  return accepted()
}

function capitalizeSource(source) {
  const s = source.toLowerCase()
  const known = { google: 'Google', facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', bing: 'Bing', newsletter: 'Newsletter' }
  return known[s] || source
}
