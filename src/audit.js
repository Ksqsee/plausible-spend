// Website check: opens a page the way a phone does, reads what Google, a visitor and the law look
// for, and grades each point in plain words. The browser part is cached in KV; the parts that
// come from our own data (real loading times, Google search results) are added fresh on every read.

import puppeteer from '@cloudflare/puppeteer'
import { DEVICES } from './shots.js'

export const AUDIT_MAX_AGE = 7 * 86400000
const auditKey = (site, page) => `audit:${site}:${page}`
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

// Runs inside the page. Everything the grading needs, in one pass.
function collectFacts() {
  const vh = window.innerHeight
  const vw = window.innerWidth
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
  }
  const meta = (sel) => (document.querySelector(sel) || {}).content || ''
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const aboveFold = (el) => {
    const r = el.getBoundingClientRect()
    return r.top + window.scrollY < vh && r.bottom > 0
  }

  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible)
  const h1 = headings.filter((h) => h.tagName === 'H1').map(txt).filter(Boolean)
  let skipped = 0
  let last = 0
  for (const h of headings) {
    const lvl = Number(h.tagName[1])
    if (last && lvl > last + 1) skipped++
    last = lvl
  }

  const ld = []
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return
        if (Array.isArray(o)) return o.forEach(walk)
        if (o['@type']) ld.push([].concat(o['@type']).join(','))
        if (o['@graph']) walk(o['@graph'])
      }
      walk(JSON.parse(s.textContent))
    } catch (e) {
      ld.push('ungültig')
    }
  }

  const imgs = [...document.images]
  const shown = imgs.filter(visible)
  const noAlt = shown.filter((i) => !i.hasAttribute('alt')).length
  const emptyAlt = shown.filter((i) => i.hasAttribute('alt') && !i.alt.trim()).length
  const oversized = shown
    .filter((i) => i.naturalWidth > 1200 && i.naturalWidth > i.getBoundingClientRect().width * window.devicePixelRatio * 2.2)
    .map((i) => ({ src: i.currentSrc || i.src, natural: i.naturalWidth, shown: Math.round(i.getBoundingClientRect().width) }))
    .slice(0, 8)

  const host = location.hostname.replace(/^www\./, '')
  const links = [...document.querySelectorAll('a[href]')]
  const internal = new Set()
  let external = 0
  for (const a of links) {
    try {
      const u = new URL(a.href, location.href)
      if (!/^https?:$/.test(u.protocol)) continue
      if (u.hostname.replace(/^www\./, '') === host) internal.add(u.origin + u.pathname)
      else external++
    } catch (e) {}
  }
  const tel = links.filter((a) => /^tel:/i.test(a.getAttribute('href')))
  const wa = links.filter((a) => /wa\.me|whatsapp/i.test(a.getAttribute('href')))
  const mail = links.filter((a) => /^mailto:/i.test(a.getAttribute('href')))
  const CTA = /anfrag|anfrage|kontakt|termin|angebot|anrufen|beratung|rückruf|jetzt|bewert|whatsapp|schreib/i
  const clickables = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')].filter(visible)
  const ctaFold = clickables.filter((el) => aboveFold(el) && (CTA.test(txt(el) || el.value || '') || /^tel:|wa\.me|whatsapp/i.test(el.getAttribute('href') || '')))
  const fixedContact = clickables.some((el) => {
    let n = el
    while (n && n !== document.body) {
      const p = getComputedStyle(n).position
      if (p === 'fixed' || p === 'sticky') return /^tel:|wa\.me|whatsapp/i.test(el.getAttribute('href') || '') || CTA.test(txt(el))
      n = n.parentElement
    }
    return false
  })
  // tap targets: stand-alone links and buttons, not links inside running text
  const small = clickables.filter((el) => {
    if (el.closest('p, li') && el.tagName === 'A' && el.closest('p')) return false
    const r = el.getBoundingClientRect()
    return r.height < 32 && r.width < 200
  })

  const fields = [...document.querySelectorAll('input, select, textarea')].filter(
    (f) => !['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(f.type) && visible(f)
  )
  const forms = document.querySelectorAll('form').length
  const choiceSteps = /Schritt\s+\d+\s*(von|\/)\s*\d+/i.test(document.body.innerText)

  let tinyText = 0
  let textEls = 0
  for (const el of document.querySelectorAll('p, li, span, a, td, small, label')) {
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 3)) continue
    if (!visible(el)) continue
    textEls++
    if (parseFloat(getComputedStyle(el).fontSize) < 12) tinyText++
  }

  const body = document.body.innerText || ''
  const legalLink = (re) => links.some((a) => re.test(txt(a)) || re.test(a.getAttribute('href') || ''))
  const scripts = [...document.scripts].map((s) => s.src).filter(Boolean)
  const hosts = [...new Set(scripts.map((s) => { try { return new URL(s).hostname } catch (e) { return '' } }).filter((h) => h && h.replace(/^www\./, '') !== host))]

  return {
    url: location.href,
    title: document.title.trim(),
    description: meta('meta[name="description"]').trim(),
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || '',
    robots: meta('meta[name="robots"]'),
    lang: document.documentElement.lang || '',
    viewport: meta('meta[name="viewport"]'),
    og: { title: meta('meta[property="og:title"]'), image: meta('meta[property="og:image"]'), description: meta('meta[property="og:description"]') },
    favicon: !!document.querySelector('link[rel~="icon"], link[rel="apple-touch-icon"]'),
    h1,
    h2: headings.filter((h) => h.tagName === 'H2').length,
    skipped,
    ld,
    words: body.split(/\s+/).filter((w) => w.length > 1).length,
    images: { total: shown.length, noAlt, emptyAlt, oversized, lazy: imgs.filter((i) => i.loading === 'lazy').length },
    internal: [...internal].slice(0, 60),
    external,
    tel: { count: tel.length, fold: tel.some(aboveFold), numbers: [...new Set(tel.map((a) => a.getAttribute('href').replace(/[^\d+]/g, '')))].slice(0, 4) },
    whatsapp: { count: wa.length, fold: wa.some(aboveFold) },
    mail: mail.length,
    cta: { fold: ctaFold.length, labels: [...new Set(ctaFold.map((el) => txt(el) || el.value).filter(Boolean))].slice(0, 5) },
    fixedContact,
    smallTargets: small.length,
    smallLabels: [...new Set(small.map((el) => (txt(el) || el.getAttribute('aria-label') || el.getAttribute('href') || '').slice(0, 40)).filter(Boolean))].slice(0, 12),
    clickables: clickables.length,
    form: { forms, fields: fields.length, required: fields.filter((f) => f.required || f.getAttribute('aria-required') === 'true').length, wizard: choiceSteps },
    tinyText,
    textEls,
    overflow: document.documentElement.scrollWidth > vw + 2,
    pageHeight: document.documentElement.scrollHeight,
    impressum: legalLink(/impressum/i),
    datenschutz: legalLink(/datenschutz|privacy/i),
    trust: /bewertung|sterne|★|kundenstimme|referenz|rezension|zufriedene kunden|google.{0,10}(4|5)[,.]\d/i.test(body),
    address: /\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+/.test(body),
    hours: /öffnungszeit|mo\s*[-–]\s*fr|montag\s*[-–]\s*freitag|erreichbar/i.test(body),
    cookieBanner: !!document.querySelector('[class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i]'),
    thirdParty: hosts.slice(0, 20),
    lcp: window.__gwLcp || null,
    cls: Math.round((window.__gwCls || 0) * 1000) / 1000
  }
}

const OBSERVE = `
  window.__gwCls = 0;
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__gwLcp = Math.round(e.startTime) }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__gwCls += e.value }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
`

async function inBrowser(env, site, page) {
  const browser = await puppeteer.launch(env.BROWSER, { keep_alive: 60000 })
  try {
    const tab = await browser.newPage()
    await tab.setUserAgent(MOBILE_UA)
    await tab.setViewport(DEVICES.mobile)
    await tab.evaluateOnNewDocument(OBSERVE)
    const net = { bytes: 0, requests: 0, byType: {}, big: [], http: 0, failed: 0 }
    const types = new Map()
    const errors = []
    try {
      const cdp = await tab.target().createCDPSession()
      await cdp.send('Network.enable')
      cdp.on('Network.responseReceived', (e) => {
        types.set(e.requestId, { type: e.type, url: e.response.url, status: e.response.status })
        if (/^http:\/\//.test(e.response.url)) net.http++
      })
      cdp.on('Network.loadingFinished', (e) => {
        const t = types.get(e.requestId) || { type: 'Other', url: '' }
        net.requests++
        net.bytes += e.encodedDataLength
        net.byType[t.type] = (net.byType[t.type] || 0) + e.encodedDataLength
        if (e.encodedDataLength > 250000) net.big.push({ url: t.url.slice(0, 200), type: t.type, bytes: e.encodedDataLength })
        if (t.status >= 400) net.failed++
      })
    } catch (e) {
      net.unavailable = true
    }
    tab.on('pageerror', (e) => errors.length < 5 && errors.push(String(e.message || e).slice(0, 160)))
    const t0 = Date.now()
    const res = await tab.goto(`https://${site}${page}${page.includes('?') ? '&' : '?'}gw_ignore=1`, { waitUntil: 'load', timeout: 25000 })
    const loadMs = Date.now() - t0
    const status = res ? res.status() : 0
    // give late images and the largest paint a moment, then scroll once like a reader would
    await new Promise((r) => setTimeout(r, 1500))
    const lcpBeforeScroll = await tab.evaluate(() => window.__gwLcp || null)
    const fold = await tab.evaluate(collectFacts)
    await tab.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight * 0.7) {
        window.scrollTo(0, y)
        await new Promise((r) => setTimeout(r, 120))
      }
    })
    await new Promise((r) => setTimeout(r, 800))
    const facts = await tab.evaluate(collectFacts)
    // what is visible in the first screen is only true before scrolling
    facts.tel.fold = fold.tel.fold
    facts.whatsapp.fold = fold.whatsapp.fold
    facts.cta = fold.cta
    facts.lcp = lcpBeforeScroll
    net.big.sort((a, b) => b.bytes - a.bytes)
    net.big = net.big.slice(0, 8)
    return { facts, net, errors, status, loadMs }
  } finally {
    await browser.close()
  }
}

async function head(url) {
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'GW-Website-Check' } })
    if (r.status === 405 || r.status === 403) r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'GW-Website-Check' } })
    return r.status
  } catch (e) {
    return 0
  }
}

// follow the redirect chain from plain http by hand, to see where it really ends
async function followHttp(start) {
  let url = start
  let hops = 0
  let first = 0
  let upgraded = false
  try {
    while (hops < 5) {
      const r = await fetch(url, { redirect: 'manual' })
      if (!first) first = r.status
      const loc = r.headers.get('location')
      if (r.status >= 300 && r.status < 400 && !loc) {
        // some edges hide the Location header from manual redirects; let fetch follow and look where it lands
        const f = await fetch(start, { redirect: 'follow' })
        return { status: first, location: f.url, hops: hops + 1, final: f.status, upgraded: f.url.startsWith('https:') }
      }
      if (r.status < 300 || r.status >= 400 || !loc) return { status: first, location: url, hops, final: r.status, upgraded }
      url = new URL(loc, url).href
      if (url.startsWith('https:')) upgraded = true
      hops++
    }
  } catch (e) {
    return { status: first, location: url, hops, final: 0, upgraded, error: String(e && e.message || e).slice(0, 160) }
  }
  return { status: first, location: url, hops, final: 0, upgraded }
}

async function outside(site, page, internal) {
  const origin = `https://${site}`
  const [robotsRes, httpRes] = await Promise.all([
    fetch(origin + '/robots.txt').then(async (r) => ({ status: r.status, text: r.ok ? (await r.text()).slice(0, 20000) : '' })).catch(() => ({ status: 0, text: '' })),
    followHttp(`http://${site}${page}`)
  ])
  const sitemapUrl = (robotsRes.text.match(/^\s*sitemap:\s*(\S+)/im) || [])[1] || origin + '/sitemap.xml'
  const sitemap = await fetch(sitemapUrl).then(async (r) => ({ status: r.status, text: r.ok ? (await r.text()).slice(0, 200000) : '' })).catch(() => ({ status: 0, text: '' }))
  const blocksAll = /user-agent:\s*\*[^]*?disallow:\s*\/\s*$/im.test(robotsRes.text)
  const inSitemap = sitemap.text ? sitemap.text.replace(/https?:\/\/(www\.)?/g, '').includes(site + (page === '/' ? '' : page)) : null
  const toCheck = internal.filter((u) => !/\.(pdf|jpe?g|png|webp|zip)$/i.test(u)).slice(0, 30)
  const statuses = await Promise.all(toCheck.map(async (u) => [u, await head(u)]))
  return {
    robots: { status: robotsRes.status, blocksAll },
    sitemap: { status: sitemap.status, url: sitemapUrl, urls: (sitemap.text.match(/<loc>/g) || []).length, inSitemap },
    https: httpRes,
    broken: statuses.filter(([, s]) => s >= 400).map(([u, s]) => ({ url: u, status: s })),
    checkedLinks: toCheck.length
  }
}

export async function runAudit(env, site, page) {
  const browser = await inBrowser(env, site, page)
  const out = await outside(site, page, browser.facts.internal)
  const audit = { ts: Date.now(), site, page, ...browser, ...out }
  await env.SHOTS.put(auditKey(site, page), JSON.stringify(audit))
  return audit
}

// one home page per call, the one checked longest ago; pages never checked come first
export async function refreshOneAudit(env) {
  const { results } = await env.DB.prepare('SELECT domain FROM sites').all()
  let pick = null
  let oldest = Infinity
  for (const r of results) {
    const a = await getAudit(env, r.domain, '/')
    const ts = a ? a.ts : 0
    if (ts < oldest) {
      oldest = ts
      pick = r.domain
    }
  }
  if (pick && Date.now() - oldest > AUDIT_MAX_AGE - 86400000) await runAudit(env, pick, '/')
}

export async function getAudit(env, site, page) {
  return (await env.SHOTS.get(auditKey(site, page), { type: 'json' })) || null
}

export async function listAudits(env, site) {
  const { keys } = await env.SHOTS.list({ prefix: `audit:${site}:` })
  const out = []
  for (const k of keys.slice(0, 30)) {
    const a = await env.SHOTS.get(k.name, { type: 'json' })
    if (a) out.push(a)
  }
  return out
}

// ---------- our own data for the page: visits, contacts, loading times, Google search ----------

const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}
const CONTACT_SECTION = /anfrage|kontakt|contact|formular|termin|angebot|rueckruf|rückruf/i
const LEADS = ['Phone click', 'Email click', 'WhatsApp click', 'Form submit']

export async function liveData(db, site, page, from, to) {
  const pageUrls = [`https://${site}${page}`, `https://www.${site}${page}`, `https://${site}${page === '/' ? '' : page}/`, `https://www.${site}${page === '/' ? '' : page}/`]
  const [eng, gsc, gscDays, views, leads, since] = await Promise.all([
    db
      .prepare(`SELECT session_id, device, props FROM events WHERE site = ? AND page = ? AND name = 'Engagement' AND date >= ? AND date <= ? LIMIT 5000`)
      .bind(site, page, from, to)
      .all(),
    db
      .prepare(
        `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) / MAX(SUM(impressions), 1) AS position
         FROM search_pages WHERE site = ? AND date >= ? AND date <= ? AND page IN (?, ?, ?, ?)
         GROUP BY query ORDER BY impressions DESC LIMIT 60`
      )
      .bind(site, from, to, ...pageUrls)
      .all(),
    db.prepare(`SELECT COUNT(DISTINCT date) AS n FROM search_pages WHERE site = ? AND date >= ? AND date <= ?`).bind(site, from, to).first(),
    db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE site = ? AND page = ? AND name = 'pageview' AND date >= ? AND date <= ?`)
      .bind(site, page, from, to)
      .first(),
    db
      .prepare(
        `SELECT DISTINCT session_id FROM events WHERE site = ? AND date >= ? AND date <= ?
         AND name IN (${LEADS.map(() => '?').join(',')})
         AND session_id IN (SELECT session_id FROM events WHERE site = ? AND page = ? AND name = 'pageview' AND date >= ? AND date <= ?)`
      )
      .bind(site, from, to, ...LEADS, site, page, from, to)
      .all(),
    db.prepare('SELECT MIN(date) AS d FROM events WHERE site = ?').bind(site).first()
  ])
  const lcp = { mobile: [], desktop: [] }
  const leadSet = new Set(leads.results.map((r) => r.session_id))
  const sawArea = new Set()
  const engaged = new Set()
  for (const r of eng.results) {
    engaged.add(r.session_id)
    try {
      const p = JSON.parse(r.props)
      if (typeof p.lcp === 'number' && p.lcp > 0) (r.device === 'Mobile' ? lcp.mobile : lcp.desktop).push(p.lcp)
      if ((p.sec || []).some((id) => CONTACT_SECTION.test(id))) sawArea.add(r.session_id)
    } catch (e) {}
  }
  const q = gsc.results.map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 }))
  const imp = q.reduce((s, r) => s + r.impressions, 0)
  const clk = q.reduce((s, r) => s + r.clicks, 0)
  const firstDay = since && since.d && since.d > from ? since.d : from
  const trackedDays = Math.max(1, Math.round((new Date(to + 'T00:00:00Z') - new Date(firstDay + 'T00:00:00Z')) / 86400000) + 1)
  return {
    tracked_days: trackedDays,
    speed: { mobile: median(lcp.mobile), mobile_n: lcp.mobile.length, desktop: median(lcp.desktop), desktop_n: lcp.desktop.length },
    search: {
      days: gscDays ? gscDays.n : 0,
      impressions: imp,
      clicks: clk,
      ctr: imp ? clk / imp : null,
      position: imp ? Math.round((q.reduce((s, r) => s + r.position * r.impressions, 0) / imp) * 10) / 10 : null,
      queries: q
    },
    visits: views ? views.n : 0,
    leads: leadSet.size,
    // of the visits that left an engagement record on this page: how many saw a contact section
    engaged: engaged.size,
    saw_contact: sawArea.size,
    // contacts among visits that saw the contact section, and among those that did not
    leads_saw: [...sawArea].filter((x) => leadSet.has(x)).length,
    leads_not: [...engaged].filter((x) => !sawArea.has(x) && leadSet.has(x)).length,
    contact_section: eng.results.some((r) => /"sec":\[[^\]]*"(anfrage|kontakt|contact|formular|termin|angebot)/i.test(r.props || ''))
  }
}

// ---------- assessment: measured numbers, a target for each, and what the gap is worth ----------

// average share of searchers who click a result at a given Google position (rounded figures from
// public click-through studies of organic results; position 11+ is page two)
const CTR_CURVE = [0.28, 0.16, 0.11, 0.085, 0.065, 0.05, 0.04, 0.033, 0.028, 0.025]
export function expectedCtr(pos) {
  if (!pos || pos < 1) return CTR_CURVE[0]
  if (pos <= 10) {
    const lo = Math.floor(pos)
    const hi = Math.min(10, lo + 1)
    const f = pos - lo
    return CTR_CURVE[lo - 1] + (CTR_CURVE[hi - 1] - CTR_CURVE[lo - 1]) * f
  }
  if (pos <= 20) return 0.01
  return 0.003
}

const MOBILE_MBIT = 10 // a typical real-world mobile connection, in Mbit/s
const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.round(b / 1024) + ' KB')
const de = (x, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toString().replace('.', ',')
const pct = (x) => de(x * 100, x < 0.1 ? 1 : 0) + ' %'

export function assess(a, live) {
  const f = a.facts
  const n = a.net || {}
  const month = live ? 30 / Math.min(28, live.tracked_days) : 1
  const searchMonth = live && live.search.days ? 30 / live.search.days : 1
  const visitsMonth = live ? live.visits * month : 0
  const leadsMonth = live ? live.leads * month : 0
  // contacts per visit on this page; with very few visits the site's typical 3 % is safer
  const rate = live && live.visits >= 30 ? Math.max(live.leads / live.visits, 0.005) : 0.03
  const rateNote = live && live.visits >= 30 ? 'gemessene Kontaktquote dieser Seite' : 'angenommene Kontaktquote von 3 %, bis genug Besuche gemessen sind'

  const M = []
  const add = (m) => M.push(m)

  // 1. loading time on a phone
  const realLcp = live && live.speed.mobile_n >= 5 ? live.speed.mobile : null
  const lcp = realLcp || f.lcp
  if (lcp) {
    const secs = lcp / 1000
    const over = Math.max(0, secs - 2.5)
    // studies on mobile sites: each second of waiting costs roughly 7 % of conversions
    const lost = Math.min(0.35, over * 0.07)
    add({
      id: 'lcp',
      group: 'Tempo',
      title: 'Ladezeit auf dem Handy',
      value: secs,
      display: de(secs) + ' s',
      target: '≤ 2,5 s',
      status: secs <= 2.5 ? 'good' : secs <= 4 ? 'warn' : 'bad',
      basis: realLcp ? `Median aus ${live.speed.mobile_n} echten Handy-Besuchen` : 'Messung im Test, ohne langsames Netz (echte Werte folgen)',
      leads: over ? leadsMonth * lost : 0,
      why: over ? `Jede Sekunde Wartezeit kostet erfahrungsgemäß etwa 7 % der Anfragen. Bei ${de(over)} s über dem Ziel sind das rund ${pct(lost)}.` : 'Die Seite steht schnell.',
      fix: 'Das große Bild oben verkleinern und als WebP liefern, unnötige Skripte entfernen.'
    })
  }
  // 2. data volume, as seconds on a normal phone connection
  if (n.bytes) {
    const secs = (n.bytes * 8) / (MOBILE_MBIT * 1e6)
    const heavy = (n.big || []).filter((b) => b.type === 'Image')
    add({
      id: 'weight',
      group: 'Tempo',
      title: 'Datenmenge pro Aufruf',
      value: n.bytes,
      display: kb(n.bytes),
      target: '≤ 2,5 MB',
      status: n.bytes <= 2.5e6 ? 'good' : n.bytes <= 5e6 ? 'warn' : 'bad',
      basis: `${n.requests} Dateien, davon Bilder ${kb((n.byType && n.byType.Image) || 0)}`,
      leads: 0,
      why: `Bei normalem Handy-Empfang (${MOBILE_MBIT} Mbit/s) dauert es etwa ${de(secs, 0)} Sekunden, bis alles geladen ist.` + (heavy.length ? ` ${heavy.length} Bilder sind einzeln größer als 250 KB.` : ''),
      fix: heavy.length ? 'Diese Bilder auf höchstens 200 KB bringen (WebP, passende Breite).' : 'Bilder und Skripte reduzieren.',
      items: heavy.map((b) => ({ img: b.url, label: kb(b.bytes) }))
    })
  }
  // 3. how many visitors reach the contact section
  if (live && live.engaged >= 15 && live.contact_section) {
    const share = live.saw_contact / live.engaged
    const target = 0.5
    const notSaw = live.engaged - live.saw_contact
    const rateSaw = live.saw_contact ? live.leads_saw / live.saw_contact : 0
    const rateNot = notSaw ? live.leads_not / notSaw : 0
    const contactGivenArea = rateSaw
    // only the extra contacts that seeing the section brings, and never more than half of today's
    const uplift = Math.max(0, rateSaw - rateNot)
    const gain = share < target && live.leads_saw >= 2 ? Math.min((target - share) * visitsMonth * uplift, leadsMonth * 0.5) : 0
    add({
      id: 'reach',
      group: 'Kontakt',
      title: 'Besucher, die den Kontaktbereich sehen',
      value: share,
      display: pct(share),
      target: '≥ 50 %',
      // when the section itself brings no extra contacts, its reach is a fact, not a problem
      status: share >= target ? 'good' : uplift <= 0 || live.leads_saw < 2 ? 'info' : share >= 0.3 ? 'warn' : 'bad',
      basis: `${live.saw_contact} von ${live.engaged} Besuchen dieser Seite`,
      leads: gain,
      why: share < target && (uplift <= 0 || live.leads_saw < 2)
        ? `Wer sich meldet, tut das hier meist schon vorher, etwa über die Telefonnummer oben. Der Kontaktbereich selbst brachte bisher ${live.leads_saw} ${live.leads_saw === 1 ? 'Anfrage' : 'Anfragen'}.`
        : share < target
        ? `Wer den Kontaktbereich sieht, meldet sich zu ${pct(contactGivenArea)}, die anderen zu ${pct(rateNot)}. Sähen ihn 50 % statt ${pct(share)}, kämen rechnerisch mehr Anfragen.`
        : 'Die Hälfte der Besucher und mehr kommt bis zum Kontakt.',
      fix: 'Den Kontaktbereich weiter nach oben holen oder einen Knopf „Anfrage stellen“ früher auf der Seite zeigen.'
    })
  }
  // 4. Google: clicks the page should get at its position, and searches close to page one
  if (live && live.search.impressions >= 30) {
    let expected = 0
    let near = 0
    const nearList = []
    for (const r of live.search.queries) {
      expected += r.impressions * expectedCtr(r.position)
      if (r.position > 3.5 && r.position <= 20 && r.impressions >= 5) {
        const extra = r.impressions * (expectedCtr(3) - expectedCtr(r.position))
        if (extra > 0) {
          near += extra
          nearList.push({ label: `${r.query} · Platz ${de(r.position)} · ${r.impressions}× gesehen` })
        }
      }
    }
    const gap = Math.max(0, expected - live.search.clicks)
    const ctr = live.search.clicks / live.search.impressions
    const expCtr = expected / live.search.impressions
    add({
      id: 'ctr',
      group: 'Google',
      title: 'Klicks aus der Google-Suche',
      value: ctr,
      display: pct(ctr),
      target: '≈ ' + pct(expCtr) + ' auf diesem Platz',
      status: ctr >= expCtr * 0.8 ? 'good' : ctr >= expCtr * 0.5 ? 'warn' : 'bad',
      basis: `${live.search.impressions}× gezeigt, ${live.search.clicks} Klicks, Ø Platz ${de(live.search.position)} (${live.search.days} Tage)`,
      visits: gap * searchMonth,
      leads: gap * searchMonth * rate,
      why: gap >= 1 ? `Auf diesem Platz klicken im Schnitt ${pct(expCtr)}. Das wären rund ${de(gap * searchMonth, 0)} Besucher mehr im Monat.` : 'Der Eintrag wird so oft angeklickt, wie es auf diesem Platz üblich ist.',
      fix: 'Titel und Beschreibung für Google konkreter machen: Leistung, Ort und ein klarer Vorteil.'
    })
    if (nearList.length) {
      add({
        id: 'near',
        group: 'Google',
        title: 'Suchen knapp hinter den Top 3',
        value: nearList.length,
        display: String(nearList.length),
        target: 'Platz 1 bis 3',
        status: near * searchMonth >= 10 ? 'warn' : 'good',
        basis: 'Suchbegriffe auf Platz 4 bis 20 mit echten Einblendungen',
        visits: near * searchMonth,
        leads: near * searchMonth * rate,
        why: `Kämen diese Suchen auf Platz 3, brächte das rund ${de(near * searchMonth, 0)} Besucher mehr im Monat.`,
        fix: 'Zu diesen Begriffen mehr eigenen Text auf die Seite bringen (Leistung, Ort, Fragen) und intern darauf verlinken.',
        items: nearList.slice(0, 8)
      })
    }
  }
  // 5. contacts per visit (measured, no target: it is the result of everything above)
  if (live && live.visits >= 10) {
    add({
      id: 'rate',
      group: 'Kontakt',
      title: 'Besucher, die sich melden',
      value: live.leads / live.visits,
      display: pct(live.leads / live.visits),
      target: null,
      status: 'info',
      basis: `${live.leads} von ${live.visits} Besuchen dieser Seite in ${Math.min(28, live.tracked_days)} Tagen`,
      leads: 0,
      why: 'Anruf, WhatsApp, E-Mail oder Formular, irgendwo auf der Website nach dem Besuch dieser Seite.'
    })
  }
  // 6. errors that stop people
  if (a.broken && a.broken.length) {
    add({
      id: 'broken',
      group: 'Technik',
      title: 'Kaputte Links',
      value: a.broken.length,
      display: String(a.broken.length),
      target: '0',
      status: 'bad',
      basis: `${a.checkedLinks} interne Links geprüft`,
      leads: 0,
      why: 'Wer darauf tippt, landet auf einer Fehlerseite.',
      fix: 'Links korrigieren oder entfernen.',
      items: a.broken.map((b) => ({ label: b.url.replace(/^https?:\/\/(www\.)?/, '') + ' · Fehler ' + b.status }))
    })
  }
  if ((a.errors || []).length) {
    add({
      id: 'errors',
      group: 'Technik',
      title: 'Skriptfehler beim Laden',
      value: a.errors.length,
      display: String(a.errors.length),
      target: '0',
      status: 'warn',
      basis: 'im Test auf dem Handy',
      leads: 0,
      why: 'Fehler in Skripten können Knöpfe oder Formulare lahmlegen.',
      fix: 'Von der Webagentur in der Browser-Konsole prüfen lassen.',
      items: a.errors.map((e) => ({ label: e }))
    })
  }

  // basics: yes or no, things a page simply should have
  const tl = f.title.length
  const dl = f.description.length
  const alts = f.images.total ? (f.images.total - f.images.noAlt) / f.images.total : 1
  const B = [
    ['Kontakt-Knopf ohne Scrollen sichtbar', f.cta.fold > 0, f.cta.fold ? f.cta.labels.map((l) => `„${l.slice(0, 30)}"`).join(', ') : 'Auf dem Handy oben kein Kontakt-Knopf', 'Oben einen Knopf „Kostenlos anfragen" oder „Jetzt anrufen" zeigen.', 3],
    ['Telefonnummer antippbar', f.tel.count > 0, f.tel.count ? f.tel.count + ' Anruf-Links' : 'Keine tel:-Links', 'Die Nummer als tel:-Link einbauen.', 3],
    ['Kontakt beim Scrollen erreichbar', f.fixedContact, f.fixedContact ? 'Feste Leiste oder fester Knopf' : 'Kein fester Kontaktweg', 'Auf dem Handy eine feste Leiste mit „Anrufen" und „Anfragen" einbauen.', 2],
    ['Passt auf den Handybildschirm', !!f.viewport && !f.overflow, f.overflow ? 'Seite ist breiter als der Bildschirm' : 'Ja', 'Zu breite Elemente begrenzen.', 3],
    ['Seitentitel 25–65 Zeichen', tl >= 25 && tl <= 65, tl ? `„${f.title}" (${tl})` : 'Kein Titel', 'Titel mit Leistung und Ort, 40–60 Zeichen.', 2],
    ['Beschreibung für Google 70–165 Zeichen', dl >= 70 && dl <= 165, dl ? `${dl} Zeichen` : 'Keine Beschreibung', '120–155 Zeichen: was, wo, warum ihr.', 2],
    ['Genau eine Hauptüberschrift', f.h1.length === 1, f.h1.length ? f.h1.length + '× H1' : 'Keine H1', 'Genau eine H1 mit Leistung und Ort.', 1],
    ['Google darf die Seite zeigen', !/noindex/i.test(f.robots) && !a.robots.blocksAll, /noindex/i.test(f.robots) ? 'noindex gesetzt' : a.robots.blocksAll ? 'robots.txt sperrt alles' : 'Ja', 'Die Sperre entfernen.', 3],
    ['Bilder beschrieben (Alt-Text)', alts >= 0.9, `${f.images.total - f.images.noAlt} von ${f.images.total}`, 'Jedem Bild einen kurzen Alt-Text geben.', 1],
    ['Firmendaten für Google (LocalBusiness)', f.ld.some((t) => /LocalBusiness|Organization|Contractor|Painter|Plumber|Electrician|RealEstate|Locksmith|HomeAndConstruction/i.test(t)), f.ld.length ? f.ld.slice(0, 3).join(', ') : 'Keine', 'Name, Adresse, Telefon und Öffnungszeiten als strukturierte Daten einbauen.', 1],
    ['Vorschaubild beim Teilen', !!f.og.image, f.og.image ? 'Gesetzt' : 'Fehlt', 'og:image (1200×630) setzen.', 1],
    ['In der Sitemap', a.sitemap.status === 200 && a.sitemap.inSitemap !== false, a.sitemap.status === 200 ? (a.sitemap.inSitemap === false ? 'Seite fehlt in der Sitemap' : 'Ja') : 'Keine Sitemap', 'Seite in die sitemap.xml aufnehmen.', 1],
    ['Impressum verlinkt', f.impressum, f.impressum ? 'Ja' : 'Fehlt', 'Pflicht: Impressum von jeder Seite verlinken.', 3],
    ['Datenschutz verlinkt', f.datenschutz, f.datenschutz ? 'Ja' : 'Fehlt', 'Pflicht: Datenschutzerklärung von jeder Seite verlinken.', 3],
    ['Sichere Verbindung (HTTPS)', a.https.upgraded || a.https.status === 0 || (/^https:/.test(a.https.location || '') && a.https.hops > 0), 'http → https', 'Alle http-Aufrufe auf https umleiten.', 2]
  ].map(([title, ok, found, fix, weight]) => ({ title, ok: !!ok, found, fix: ok ? '' : fix, weight }))

  const potential = M.reduce((s, m) => s + (m.leads || 0), 0)
  const potentialVisits = M.reduce((s, m) => s + (m.visits || 0), 0)
  return {
    potential: { leads: Math.round(potential * 10) / 10, visits: Math.round(potentialVisits), rate, rate_note: rateNote, leads_month: Math.round(leadsMonth * 10) / 10, visits_month: Math.round(visitsMonth) },
    metrics: M,
    basics: B.sort((x, y) => (x.ok === y.ok ? y.weight - x.weight : x.ok ? 1 : -1)),
    basics_ok: B.filter((b) => b.ok).length,
    basics_total: B.length
  }
}
