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

// ---------- our own data for the page: real loading times and Google search ----------

const median = (a) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

export async function liveData(db, site, page, from, to) {
  const [eng, gsc, views, leads, gbp] = await Promise.all([
    db
      .prepare(`SELECT device, props FROM events WHERE site = ? AND page = ? AND name = 'Engagement' AND date >= ? AND date <= ? LIMIT 3000`)
      .bind(site, page, from, to)
      .all(),
    db
      .prepare(
        `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) / MAX(SUM(impressions), 1) AS position
         FROM search_pages WHERE site = ? AND date >= ? AND date <= ? AND (page = ? OR page = ? OR page = ? OR page = ?)
         GROUP BY query ORDER BY impressions DESC LIMIT 40`
      )
      .bind(site, from, to, `https://${site}${page}`, `https://www.${site}${page}`, `https://${site}${page === '/' ? '' : page}/`, `https://www.${site}${page === '/' ? '' : page}/`)
      .all(),
    db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE site = ? AND page = ? AND name = 'pageview' AND date >= ? AND date <= ?`)
      .bind(site, page, from, to)
      .first(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE site = ? AND date >= ? AND date <= ?
         AND name IN ('Phone click', 'Email click', 'WhatsApp click', 'Form submit')
         AND session_id IN (SELECT session_id FROM events WHERE site = ? AND page = ? AND name = 'pageview' AND date >= ? AND date <= ?)`
      )
      .bind(site, from, to, site, page, from, to)
      .first(),
    page === '/'
      ? db
          .prepare(
            `SELECT l.name, r.count, r.rating,
               (SELECT SUM(calls) FROM gbp_daily d WHERE d.location = l.location AND d.date >= ? AND d.date <= ?) AS calls,
               (SELECT SUM(website_clicks) FROM gbp_daily d WHERE d.location = l.location AND d.date >= ? AND d.date <= ?) AS clicks,
               (SELECT SUM(directions) FROM gbp_daily d WHERE d.location = l.location AND d.date >= ? AND d.date <= ?) AS directions,
               (SELECT SUM(impressions_maps + impressions_search) FROM gbp_daily d WHERE d.location = l.location AND d.date >= ? AND d.date <= ?) AS views
             FROM gbp_locations l LEFT JOIN gbp_reviews r ON r.location = l.location WHERE l.site = ? ORDER BY views DESC LIMIT 1`
          )
          .bind(from, to, from, to, from, to, from, to, site)
          .first()
      : null
  ])
  const lcp = { mobile: [], desktop: [] }
  for (const r of eng.results) {
    try {
      const p = JSON.parse(r.props)
      if (typeof p.lcp === 'number' && p.lcp > 0) (r.device === 'Mobile' ? lcp.mobile : lcp.desktop).push(p.lcp)
    } catch (e) {}
  }
  const q = gsc.results.map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 }))
  const imp = q.reduce((s, r) => s + r.impressions, 0)
  const clk = q.reduce((s, r) => s + r.clicks, 0)
  return {
    speed: { mobile: median(lcp.mobile), mobile_n: lcp.mobile.length, desktop: median(lcp.desktop), desktop_n: lcp.desktop.length },
    search: {
      impressions: imp,
      clicks: clk,
      ctr: imp ? clk / imp : null,
      position: imp ? Math.round((q.reduce((s, r) => s + r.position * r.impressions, 0) / imp) * 10) / 10 : null,
      queries: q.slice(0, 12),
      // ranked between 4 and 20: a small push brings these onto the first screen of Google
      near: q.filter((r) => r.position > 3.5 && r.position <= 20 && r.impressions >= 10).slice(0, 8)
    },
    gbp: gbp || null,
    visits: views ? views.n : 0,
    leads: leads ? leads.n : 0
  }
}

// ---------- grading: plain words, one fix per point ----------

export const CATS = {
  seo: 'Bei Google gefunden werden',
  speed: 'Tempo & Technik',
  conv: 'Kontakt & Vertrauen',
  legal: 'Rechtliches',
  local: 'Google-Profil'
}

const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.round(b / 1024) + ' KB')
const sec = (ms) => (ms / 1000).toFixed(1).replace('.', ',') + ' s'

export function grade(a, live) {
  const f = a.facts
  const n = a.net || {}
  const C = []
  const add = (cat, id, status, title, found, fix, weight = 2, items) => C.push({ cat, id, status, title, found, fix: status === 'good' ? '' : fix, weight, items: status === 'good' ? undefined : items })

  // --- SEO
  const tl = f.title.length
  add('seo', 'title', !tl ? 'bad' : tl < 25 || tl > 65 ? 'warn' : 'good', 'Seitentitel',
    tl ? `„${f.title}" (${tl} Zeichen)` : 'Kein Titel vorhanden',
    !tl ? 'Einen Titel mit Leistung und Ort setzen, z. B. „Fenster & Türen in Hamburg | Firma".' : tl < 25 ? 'Titel ist kurz. Leistung und Ort ergänzen, 40 bis 60 Zeichen.' : 'Titel ist zu lang und wird bei Google abgeschnitten. Auf 60 Zeichen kürzen, das Wichtigste nach vorn.', 3)
  const dl = f.description.length
  add('seo', 'description', !dl ? 'bad' : dl < 70 || dl > 165 ? 'warn' : 'good', 'Beschreibung für Google',
    dl ? `${dl} Zeichen: „${f.description.slice(0, 120)}${dl > 120 ? '…' : ''}"` : 'Keine Beschreibung. Google nimmt dann irgendeinen Text von der Seite.',
    !dl ? 'Eine Beschreibung mit 120 bis 155 Zeichen schreiben: was, wo, warum ihr, und eine Aufforderung.' : dl < 70 ? 'Beschreibung ist kurz. Auf 120 bis 155 Zeichen erweitern, mit Ort und Nutzen.' : 'Beschreibung ist zu lang. Auf 155 Zeichen kürzen.', 2)
  add('seo', 'h1', f.h1.length === 1 ? 'good' : f.h1.length === 0 ? 'bad' : 'warn', 'Hauptüberschrift (H1)',
    f.h1.length ? f.h1.map((h) => `„${h.slice(0, 70)}"`).join(', ') : 'Keine H1 auf der Seite',
    f.h1.length === 0 ? 'Genau eine H1 setzen, die sagt, was hier angeboten wird und wo.' : `Es gibt ${f.h1.length} H1. Nur eine behalten, die anderen zu H2 machen.`, 2)
  add('seo', 'structure', f.h2 >= 2 && !f.skipped ? 'good' : 'warn', 'Gliederung mit Zwischenüberschriften',
    `${f.h2} Zwischenüberschriften (H2)${f.skipped ? `, ${f.skipped}× wird eine Ebene übersprungen` : ''}`,
    f.h2 < 2 ? 'Abschnitte mit H2-Überschriften gliedern, die Suchbegriffe enthalten.' : 'Überschriften der Reihe nach verwenden (H2, dann H3), ohne Ebenen zu überspringen.', 1)
  add('seo', 'words', f.words >= 300 ? 'good' : f.words >= 150 ? 'warn' : 'bad', 'Textmenge',
    `${f.words} Wörter`, 'Mehr eigener Text hilft Google zu verstehen, worum es geht. Leistungen, Ablauf, Einsatzgebiet und häufige Fragen ergänzen.', 1)
  const noindex = /noindex/i.test(f.robots)
  add('seo', 'index', noindex || a.robots.blocksAll ? 'bad' : 'good', 'Darf Google die Seite zeigen?',
    noindex ? 'Die Seite sagt Google „nicht anzeigen" (noindex).' : a.robots.blocksAll ? 'robots.txt sperrt die ganze Website.' : 'Ja',
    'Die Sperre entfernen, sonst taucht die Seite nie bei Google auf.', 4)
  add('seo', 'canonical', f.canonical ? 'good' : 'warn', 'Eindeutige Adresse (Canonical)',
    f.canonical ? f.canonical : 'Nicht gesetzt', 'Canonical-Link auf die eigene Adresse setzen, damit Google keine Doppelungen zählt.', 1)
  add('seo', 'sitemap', a.sitemap.status === 200 ? (a.sitemap.inSitemap === false ? 'warn' : 'good') : 'warn', 'Sitemap',
    a.sitemap.status === 200 ? `${a.sitemap.urls} Seiten gelistet${a.sitemap.inSitemap === false ? ', diese Seite fehlt darin' : ''}` : 'Keine Sitemap gefunden',
    a.sitemap.status === 200 ? 'Diese Seite in die Sitemap aufnehmen.' : 'Eine sitemap.xml anlegen und in der Search Console einreichen.', 1)
  const local = f.ld.some((t) => /LocalBusiness|Organization|HomeAndConstructionBusiness|GeneralContractor|RealEstateAgent|Plumber|Electrician|RoofingContractor|HousePainter|Locksmith/i.test(t))
  add('seo', 'schema', local ? 'good' : f.ld.length ? 'warn' : 'warn', 'Firmendaten für Google (Schema)',
    f.ld.length ? f.ld.slice(0, 5).join(', ') : 'Keine strukturierten Daten',
    'LocalBusiness-Daten einbauen (Name, Adresse, Telefon, Öffnungszeiten, Einsatzgebiet). Das hilft bei lokalen Suchen und in Google Maps.', 1)
  const alts = f.images.total ? (f.images.total - f.images.noAlt) / f.images.total : 1
  add('seo', 'alt', alts >= 0.9 ? 'good' : alts >= 0.6 ? 'warn' : 'bad', 'Bildbeschreibungen (Alt-Text)',
    f.images.total ? `${f.images.total - f.images.noAlt} von ${f.images.total} Bildern beschrieben` : 'Keine Bilder',
    'Jedem Bild einen kurzen Alt-Text geben, der zeigt, was zu sehen ist („Holzfenster nach Einbau in Hamburg-Eimsbüttel").', 1)
  add('seo', 'share', f.og.image && f.og.title ? 'good' : 'warn', 'Vorschau beim Teilen (WhatsApp, Facebook)',
    f.og.image ? 'Vorschaubild gesetzt' : 'Kein Vorschaubild', 'Ein Vorschaubild (og:image, 1200×630) und einen Vorschautitel setzen. Geteilte Links sehen sonst leer aus.', 1)
  if (a.broken) {
    add('seo', 'links', a.broken.length ? 'bad' : 'good', 'Kaputte Links',
      a.broken.length ? a.broken.map((b) => `${b.url.replace(/^https?:\/\/(www\.)?/, '')} (${b.status})`).slice(0, 5).join(', ') : `${a.checkedLinks} interne Links geprüft, alle erreichbar`,
      'Diese Links zeigen auf Seiten, die es nicht gibt. Korrigieren oder entfernen.', 2, a.broken.map((b) => ({ label: b.url.replace(/^https?:\/\/(www\.)?/, '') + ' · ' + b.status })))
  }
  if (live && live.search.impressions >= 80 && live.search.ctr !== null) {
    const ctr = live.search.ctr
    const expect = live.search.position <= 3 ? 0.08 : live.search.position <= 10 ? 0.025 : 0.005
    add('seo', 'ctr', ctr >= expect ? 'good' : 'warn', 'Wird der Eintrag bei Google angeklickt?',
      `${live.search.impressions} Mal gezeigt, ${live.search.clicks} Klicks (${(ctr * 100).toFixed(1).replace('.', ',')} %), Ø Platz ${String(live.search.position).replace('.', ',')}`,
      'Für diesen Platz klicken zu wenige. Titel und Beschreibung konkreter machen: Ort, Leistung, ein klarer Vorteil.', 2)
  }

  // --- Tempo & Technik
  const realM = live && live.speed.mobile_n >= 5 ? live.speed.mobile : null
  const lcp = realM || f.lcp
  if (lcp) {
    add('speed', 'lcp', lcp <= 2500 ? 'good' : lcp <= 4000 ? 'warn' : 'bad', 'Ladezeit auf dem Handy',
      `${sec(lcp)} bis der Hauptinhalt steht${realM ? ` (echte Besucher, ${live.speed.mobile_n} Messungen)` : ' (Test ohne langsames Netz)'}`,
      'Das größte Bild oben verkleinern und als WebP liefern, Schriften und Skripte reduzieren. Ziel: unter 2,5 Sekunden.', 3)
  }
  if (!n.unavailable) {
    add('speed', 'weight', n.bytes <= 2.5e6 ? 'good' : n.bytes <= 5e6 ? 'warn' : 'bad', 'Datenmenge der Seite',
      `${kb(n.bytes)} in ${n.requests} Dateien${n.byType && n.byType.Image ? `, davon Bilder ${kb(n.byType.Image)}` : ''}`,
      'Bilder komprimieren (WebP, höchstens 200 KB pro Bild) und nicht mehr laden als angezeigt wird.', 2)
  }
  const heavy = (n.big || []).filter((b) => b.type === 'Image')
  add('speed', 'images', !heavy.length && !f.images.oversized.length ? 'good' : heavy.length > 2 ? 'bad' : 'warn', 'Bildgrößen',
    heavy.length ? `${heavy.length} ${heavy.length === 1 ? 'Bild' : 'Bilder'} über 250 KB, das größte ${kb(heavy[0].bytes)}` : f.images.oversized.length ? `${f.images.oversized.length} ${f.images.oversized.length === 1 ? 'Bild' : 'Bilder'} viel größer als angezeigt` : 'Keine übergroßen Bilder',
    'Diese Bilder auf die angezeigte Größe verkleinern und komprimieren.', 2,
    heavy.length ? heavy.map((b) => ({ img: b.url, label: kb(b.bytes) })) : f.images.oversized.map((i) => ({ img: i.src, label: `${i.natural} px statt ${i.shown} px` })))
  add('speed', 'cls', f.cls <= 0.1 ? 'good' : f.cls <= 0.25 ? 'warn' : 'bad', 'Springt die Seite beim Laden?',
    f.cls <= 0.1 ? 'Nein, die Seite steht ruhig' : `Ja, Verschiebung ${String(f.cls).replace('.', ',')}`,
    'Bildern und Einbettungen feste Höhen geben, damit nichts nachrutscht, während man liest oder tippt.', 1)
  add('speed', 'mobile', f.viewport && !f.overflow ? 'good' : 'bad', 'Passt auf den Handybildschirm',
    !f.viewport ? 'Keine Handy-Einstellung (viewport)' : f.overflow ? 'Seite ist breiter als der Bildschirm, man kann seitlich wischen' : 'Ja',
    'Elemente finden, die breiter als der Bildschirm sind, und begrenzen.', 3)
  const tinyShare = f.textEls ? f.tinyText / f.textEls : 0
  add('speed', 'text', tinyShare <= 0.05 ? 'good' : tinyShare <= 0.2 ? 'warn' : 'bad', 'Lesbare Schrift auf dem Handy',
    tinyShare <= 0.05 ? 'Text ist groß genug' : `${Math.round(tinyShare * 100)} % der Texte kleiner als 12 px`, 'Fließtext mindestens 16 px, Kleingedrucktes mindestens 12 px.', 1)
  add('speed', 'tap', f.smallTargets <= 2 ? 'good' : f.smallTargets <= 8 ? 'warn' : 'bad', 'Knöpfe groß genug zum Tippen',
    f.smallTargets <= 2 ? 'Ja' : `${f.smallTargets} Knöpfe oder Links kleiner als eine Fingerkuppe`, 'Knöpfe und Links mindestens 44 px hoch machen, mit Abstand zueinander.', 1, (f.smallLabels || []).map((l) => ({ label: l })))
  const secure = a.https.upgraded || (/^https:/.test(a.https.location || '') && a.https.hops > 0)
  add('speed', 'https', secure || a.https.status === 0 ? 'good' : 'warn', 'Sichere Verbindung (HTTPS)',
    secure ? 'http leitet auf https um' : `http antwortet mit ${a.https.status} und bleibt unverschlüsselt`, 'Alle http-Aufrufe dauerhaft (301) auf https umleiten.', 1)
  add('speed', 'errors', !(a.errors || []).length && !n.failed ? 'good' : 'warn', 'Fehler beim Laden',
    (a.errors || []).length || n.failed ? `${(a.errors || []).length} Skriptfehler, ${n.failed || 0} Dateien nicht gefunden` : 'Keine',
    'Die Fehler in der Browser-Konsole prüfen lassen, sie können Formulare oder Knöpfe lahmlegen.', 1, (a.errors || []).map((e) => ({ label: e })))

  // --- Kontakt & Vertrauen
  add('conv', 'cta', f.cta.fold ? 'good' : 'bad', 'Kontakt-Knopf im ersten Bildschirm',
    f.cta.fold ? f.cta.labels.map((l) => `„${l.slice(0, 40)}"`).join(', ') : 'Auf dem Handy ist ohne Scrollen kein Kontakt-Knopf zu sehen',
    'Oben einen klaren Knopf platzieren: „Kostenlos anfragen" oder „Jetzt anrufen".', 4)
  add('conv', 'tel', f.tel.count ? (f.tel.fold || f.fixedContact ? 'good' : 'warn') : 'bad', 'Telefonnummer antippbar',
    f.tel.count ? `${f.tel.count} Anruf-Links${f.tel.fold ? ', einer davon sofort sichtbar' : ', aber erst weiter unten'}` : 'Keine antippbare Telefonnummer',
    f.tel.count ? 'Die Telefonnummer auch oben oder in einer festen Leiste zeigen. Im Handwerk ist ein Anruf der häufigste Kontakt.' : 'Die Telefonnummer als tel:-Link einbauen, damit ein Tipp genügt.', 3)
  add('conv', 'whatsapp', f.whatsapp.count ? 'good' : 'warn', 'WhatsApp-Kontakt',
    f.whatsapp.count ? `${f.whatsapp.count} WhatsApp-Links` : 'Nicht vorhanden',
    'Einen WhatsApp-Knopf anbieten. Viele schicken lieber ein Foto vom Problem, als anzurufen.', 1)
  add('conv', 'sticky', f.fixedContact ? 'good' : 'warn', 'Kontakt immer erreichbar',
    f.fixedContact ? 'Feste Kontaktleiste oder fester Knopf vorhanden' : 'Beim Scrollen verschwindet jeder Kontaktweg',
    'Auf dem Handy eine feste Leiste unten mit „Anrufen" und „Anfragen" einbauen.', 2)
  const hasForm = f.form.forms || f.form.fields || f.form.wizard
  add('conv', 'form', hasForm ? (f.form.fields > 7 ? 'warn' : 'good') : 'info', 'Anfrageformular',
    hasForm ? `${f.form.wizard ? 'Mehrstufiges Formular' : f.form.forms + ' Formular'}${f.form.fields ? `, ${f.form.fields} Felder sichtbar` : ''}${f.form.required ? `, ${f.form.required} Pflichtfelder` : ''}` : 'Auf dieser Seite kein Formular',
    hasForm ? 'Weniger Felder bedeuten mehr Anfragen. Alles weglassen, was man auch im Gespräch klären kann.' : 'Kein Fehler, solange der Weg zum Formular kurz ist.', 2)
  add('conv', 'trust', f.trust ? 'good' : 'warn', 'Bewertungen und Referenzen',
    f.trust ? 'Bewertungen oder Referenzen erwähnt' : 'Keine Bewertungen oder Kundenstimmen gefunden',
    'Google-Sterne und zwei, drei echte Kundenstimmen zeigen. Das ist für Fremde der stärkste Grund, sich zu melden.', 2)
  add('conv', 'nap', f.address ? 'good' : 'warn', 'Adresse sichtbar',
    f.address ? 'Ja' : 'Keine Postanschrift gefunden', 'Adresse mit PLZ zeigen. Das schafft Vertrauen und hilft bei lokalen Google-Suchen.', 1)
  if (live && live.visits >= 30) {
    const rate = live.leads / live.visits
    add('conv', 'rate', rate >= 0.03 ? 'good' : rate >= 0.01 ? 'warn' : 'bad', 'Melden sich Besucher dieser Seite?',
      `${live.leads} von ${live.visits} Besuchern haben danach angerufen, geschrieben oder angefragt (${(rate * 100).toFixed(1).replace('.', ',')} %, letzte 4 Wochen)`,
      'Auf dieser Seite meldet sich kaum jemand. Heatmap ansehen: Kommen die Leute bis zum Kontakt? Ist das Angebot klar?', 3)
  }

  // --- Rechtliches
  add('legal', 'impressum', f.impressum ? 'good' : 'bad', 'Impressum verlinkt', f.impressum ? 'Ja' : 'Kein Impressum-Link gefunden', 'Pflicht für Firmen-Websites: Impressum von jeder Seite aus verlinken.', 3)
  add('legal', 'privacy', f.datenschutz ? 'good' : 'bad', 'Datenschutzerklärung verlinkt', f.datenschutz ? 'Ja' : 'Kein Datenschutz-Link gefunden', 'Pflicht: Datenschutzerklärung von jeder Seite aus verlinken.', 3)
  const trackers = f.thirdParty.filter((h) => /google|facebook|fbcdn|doubleclick|hotjar|tiktok|linkedin|clarity/i.test(h))
  add('legal', 'consent', !trackers.length ? 'good' : f.cookieBanner ? 'good' : 'warn', 'Fremddienste und Einwilligung',
    trackers.length ? `Lädt ${trackers.slice(0, 4).join(', ')}${f.cookieBanner ? ', Cookie-Hinweis vorhanden' : ', kein Cookie-Hinweis gefunden'}` : 'Keine Werbe- oder Analysedienste von Dritten',
    'Dienste wie Google oder Meta erst nach Einwilligung laden. Mit dem Datenschutz-Verantwortlichen prüfen.', 1)
  add('legal', 'lang', /^de/i.test(f.lang) ? 'good' : 'warn', 'Sprache angegeben', f.lang ? `lang="${f.lang}"` : 'Nicht angegeben', 'lang="de" im HTML setzen, für Vorleseprogramme und Google.', 1)

  // --- Google-Profil: for local trades often the first thing people see
  const g = live && live.gbp
  // a profile without any synced numbers is not connected yet; grading it would only add noise
  if (g && (g.count !== null || g.views)) {
    const cnt = g.count || 0
    add('local', 'reviews', cnt >= 20 ? 'good' : cnt >= 5 ? 'warn' : 'bad', 'Anzahl Google-Bewertungen',
      cnt ? `${cnt} Bewertungen für „${g.name}"` : `„${g.name}" hat noch keine Bewertung`,
      'Nach jedem Auftrag um eine Bewertung bitten, am besten mit Link oder QR-Code auf Rechnung und Visitenkarte. Ab etwa 20 Bewertungen wirkt ein Profil verlässlich.', 3)
    if (cnt) add('local', 'rating', g.rating >= 4.5 ? 'good' : g.rating >= 4 ? 'warn' : 'bad', 'Sterne-Durchschnitt',
      `${String(g.rating).replace('.', ',')} von 5 Sternen`, 'Auf jede Bewertung antworten, auch auf kritische, ruhig und sachlich.', 2)
    add('local', 'gbpuse', (g.calls || 0) + (g.clicks || 0) + (g.directions || 0) > 0 ? 'good' : 'warn', 'Wird das Profil genutzt?',
      `${g.views || 0}× gesehen, ${g.calls || 0} Anrufe, ${g.clicks || 0} Klicks zur Website, ${g.directions || 0} Routen (4 Wochen)`,
      'Das Profil wird gesehen, aber niemand handelt. Fotos von echten Arbeiten, Leistungen und Öffnungszeiten ergänzen und regelmäßig Beiträge posten.', 2)
  }

  const val = { good: 1, warn: 0.5, bad: 0 }
  const scores = {}
  for (const cat of Object.keys(CATS)) {
    const cs = C.filter((c) => c.cat === cat && c.status !== 'info')
    const w = cs.reduce((s, c) => s + c.weight, 0)
    scores[cat] = w ? Math.round((cs.reduce((s, c) => s + c.weight * val[c.status], 0) / w) * 100) : null
  }
  const all = C.filter((c) => c.status !== 'info')
  const tw = all.reduce((s, c) => s + c.weight, 0)
  const score = tw ? Math.round((all.reduce((s, c) => s + c.weight * val[c.status], 0) / tw) * 100) : null
  // the order to fix things in: heavy and broken first
  const urgency = (c) => c.weight * (c.status === 'bad' ? 2 : 1)
  const todo = C.filter((c) => c.status === 'bad' || c.status === 'warn').sort((x, y) => urgency(y) - urgency(x))
  return { score, scores, checks: C, todo: todo.map((c) => c.id) }
}
