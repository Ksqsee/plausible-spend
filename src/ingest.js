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

const MAX_BODY = 8192
const MAX_EVENTS_PER_VISITOR_MINUTE = 120
const MAX_EVENTS_PER_SITE_MINUTE = 1000

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

  // events are tiny; anything big is not from our tracker
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return new Response('Too large', { status: 413, headers: corsHeaders })
  let payload
  try {
    const text = await request.text()
    if (text.length > MAX_BODY) return new Response('Too large', { status: 413, headers: corsHeaders })
    payload = JSON.parse(text)
  } catch {
    return new Response('Bad request', { status: 400, headers: corsHeaders })
  }
  if (!payload || typeof payload !== 'object') return new Response('Bad request', { status: 400, headers: corsHeaders })

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
  // a browser always names the page that sent the beacon; it has to be one of the site's own hosts
  const origin = request.headers.get('Origin')
  if (origin && origin !== 'null') {
    let originHost = ''
    try {
      originHost = new URL(origin).hostname.toLowerCase()
    } catch {}
    if (!allowedHosts.includes(originHost)) return accepted()
  }
  const ipForLimit = request.headers.get('CF-Connecting-IP') || ''
  // a real visitor sends a handful of events a minute; floods are dropped quietly
  if (env.EVENTS_RATE) {
    const { success } = await env.EVENTS_RATE.limit({ key: site + '|' + ipForLimit })
    if (!success) return accepted()
  }
  if (env.EVENTS_SITE_RATE) {
    const { success } = await env.EVENTS_SITE_RATE.limit({ key: site })
    if (!success) return accepted()
  }

  const name = clean(payload.n, 80) || 'pageview'
  const now = Date.now()
  const { date, hour } = localParts(now)
  const ip = request.headers.get('CF-Connecting-IP') || ''
  const salt = await dailySalt(env.DB, date)
  const visitorId = (await sha256Hex(`${salt}|${site}|${ip}|${ua}`)).slice(0, 20)
  // the rate limiter above is only approximate (it counts per server), so the database has the final word
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS site_n, SUM(visitor_id = ?) AS visitor_n FROM events WHERE site = ? AND ts > ?'
  )
    .bind(visitorId, site, now - 60000)
    .first()
  if (recent && (recent.visitor_n >= MAX_EVENTS_PER_VISITOR_MINUTE || recent.site_n >= MAX_EVENTS_PER_SITE_MINUTE)) return accepted()

  const page = (url.pathname || '/').slice(0, 300)
  const params = url.searchParams
  // only where someone came from, never the full address (query strings can carry tokens or personal data)
  const referrer = shortReferrer(payload.r)
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
  // Google adds the campaign ID on its own; it matches ads_spend.campaign_id.
  if (!utm.campaign && params.get('gad_campaignid')) utm.campaign = clean(params.get('gad_campaignid'), 30)
  const isAdClick = utm.medium && /^(cpc|ppc|paid|paidsearch|paid_search|display|paid_social)$/i.test(utm.medium)
  const isProfile = /^(gbp|gmb|google_business|googlebusiness|google-business)$/i.test(utm.source || '') || /^(gbp|gmb)$/i.test(utm.campaign || '')
  const source =
    (isProfile && 'Google Business Profile') ||
    (utm.source && (isAdClick && /google/i.test(utm.source) ? 'Google Ads' : capitalizeSource(utm.source))) ||
    refSource ||
    'Direct / None'

  const cf = request.cf || {}
  const { browser, os } = parseUserAgent(ua)
  const device = deviceFromWidth(payload.w)
  const isPageview = name === 'pageview'

  const props = sanitizeProps(payload.p)
  const label = props ? clean(props.label, 100) : null
  const propsJson = props ? JSON.stringify(props) : null

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

  for (const [id, heading] of sectionHeadings(payload.p)) {
    statements.push(
      db
        .prepare(
          'INSERT INTO section_names (site, id, name, updated_ts) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(site, id) DO UPDATE SET name = excluded.name, updated_ts = excluded.updated_ts WHERE name != excluded.name'
        )
        .bind(site, id, heading, now)
    )
  }

  await db.batch(statements)
  return accepted()
}

function shortReferrer(raw) {
  const r = clean(raw, 500)
  if (!r) return null
  try {
    const u = new URL(r)
    return (u.origin + u.pathname).slice(0, 300)
  } catch {
    return null
  }
}

function capitalizeSource(source) {
  const s = source.toLowerCase()
  const known = { google: 'Google', facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', bing: 'Bing', newsletter: 'Newsletter' }
  return known[s] || source
}

// Event properties are kept small and flat: strings, numbers, a list of strings (sections seen)
// and one level of string choices (form answers).
const LIST_PROPS = { sec: 40, fs: 20, err: 20 }

// Section id -> visible heading, as sent with engagement events.
export function sectionHeadings(raw) {
  const sn = raw && typeof raw === 'object' ? raw.sn : null
  if (!sn || typeof sn !== 'object' || Array.isArray(sn)) return []
  return Object.entries(sn)
    .slice(0, 40)
    .filter(([id, name]) => /^[a-z][a-z0-9-]{1,40}$/.test(id) && typeof name === 'string' && name.trim())
    .map(([id, name]) => [id, name.replace(/\s+/g, ' ').trim().slice(0, 60)])
}

export function sanitizeProps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  let keys = 0
  for (const [k, v] of Object.entries(raw)) {
    if (keys >= 12) break
    const key = String(k).slice(0, 40)
    // lists: sections seen, form fields touched in order, form fields that showed an error
    if (key === 'sn') continue // section headings go to their own table
    if (LIST_PROPS[key]) {
      if (!Array.isArray(v)) continue
      out[key] = v.filter((x) => typeof x === 'string').slice(0, LIST_PROPS[key]).map((x) => x.slice(0, 60))
    } else if (typeof v === 'string') out[key] = v.slice(0, 200)
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (Array.isArray(v)) continue
    else if (v && typeof v === 'object') {
      const flat = {}
      for (const [ck, cv] of Object.entries(v).slice(0, 8)) {
        if (typeof cv === 'string' || typeof cv === 'number') flat[String(ck).slice(0, 40)] = String(cv).slice(0, 80)
      }
      out[key] = flat
    } else continue
    keys++
  }
  return keys ? out : null
}
