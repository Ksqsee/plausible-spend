// Full-page screenshots of a site's pages, as the backdrop for heatmaps and scroll maps.
// Taken with Cloudflare Browser Rendering and kept in KV; the sites forbid framing, so a picture is
// the only way to show the page inside the dashboard.

import puppeteer from '@cloudflare/puppeteer'

export const DEVICES = {
  desktop: { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
}
const MAX_HEIGHT = 16000
// a week is fresh enough for a backdrop; pages rarely change more often
export const SHOT_MAX_AGE = 7 * 86400000

const shotKey = (site, page, device) => `shot:${site}:${device}:${page}`
const geoKey = (site, page, device) => `geo:${site}:${device}:${page}`

// Show everything as a returning visitor would see it after scrolling: no cookie banner, no
// elements waiting for an animation, no fixed bars repeated over the whole picture.
const PREPARE_CSS = `
  *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }
  [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i] { display: none !important; }
`

export async function capture(env, site, page, device) {
  const spec = DEVICES[device]
  if (!spec) throw new Error('unknown device')
  const browser = await puppeteer.launch(env.BROWSER, { keep_alive: 120000 })
  const log = (m) => console.log('shot', site, page, device, m)
  try {
    const tab = await browser.newPage()
    await tab.setViewport(spec)
    await tab.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    // never counted as a visit
    log('open')
    await tab.goto(`https://${site}${page}${page.includes('?') ? '&' : '?'}gw_ignore=1`, { waitUntil: 'load', timeout: 25000 })
    log('loaded')
    await tab.addStyleTag({ content: PREPARE_CSS })
    // scroll through once so lazy images and reveal-on-scroll sections render
    await tab.evaluate(async () => {
      const step = window.innerHeight * 0.6
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y)
        await new Promise((r) => setTimeout(r, 140))
      }
      window.scrollTo(0, 0)
      document.querySelectorAll('.rv, [class*="reveal"], [data-aos]').forEach((el) => el.classList.add('in', 'is-visible', 'aos-animate'))
      // content still waiting for a reveal animation: show it as it looks once revealed
      document.querySelectorAll('section *').forEach((el) => {
        const cs = getComputedStyle(el)
        if (cs.position === 'fixed' || el.closest('[aria-hidden="true"], dialog, [role="dialog"], nav')) return
        const r = el.getBoundingClientRect()
        if (!r.height) return
        if (cs.opacity === '0') el.style.setProperty('opacity', '1', 'important')
        if (cs.visibility === 'hidden') el.style.setProperty('visibility', 'visible', 'important')
        if (cs.transform && cs.transform !== 'none' && /matrix\(1, 0, 0, 1, 0, [1-9]/.test(cs.transform)) el.style.setProperty('transform', 'none', 'important')
      })
    })
    await new Promise((r) => setTimeout(r, 600))
    log('scrolled')
    const height = await tab.evaluate(() => document.documentElement.scrollHeight)
    // where each named section sits in this picture, so sections can be drawn before visitors report them
    const sections = await tab.evaluate(() =>
      // every top-level section, named by its id when it has one, otherwise by its heading
      [...document.querySelectorAll('section')]
        .filter((s) => !s.parentElement.closest('section'))
        .map((s, i) => {
          const r = s.getBoundingClientRect()
          const h = s.querySelector('h1, h2, h3')
          const name = h ? h.innerText.trim().replace(/\s+/g, ' ').replace(/\s*\(\d+\)$/, '').slice(0, 60) : ''
          const id = s.id && /^[a-z][a-z0-9-]{1,40}$/.test(s.id) ? s.id : 'abschnitt-' + (i + 1)
          return [id, Math.round(r.top + window.scrollY), Math.round(r.height), name]
        })
        .filter((x) => x[2] > 120 && x[3])
    )
    // where every top-level section and every clickable element sits in this picture; clicks and
    // scroll positions from visitors are tied to these (same rules as the tracker)
    const layout = await tab.evaluate(() => {
      window.scrollTo(0, 0)
      const sy = window.scrollY
      const tops = [...document.querySelectorAll('section')].filter((s) => !s.parentElement || !s.parentElement.closest('section'))
      const anchors = tops.map((s) => {
        const r = s.getBoundingClientRect()
        return [Math.round(r.top + sy), Math.round(r.height)]
      })
      const STABLE_ID = /^[A-Za-z][\w-]{0,40}$/
      const pathOf = (el) => {
        const parts = []
        let n = el
        while (n && n.nodeType === 1 && parts.length < 30) {
          if (n === document.body) { parts.unshift('body'); break }
          if (n.id && STABLE_ID.test(n.id) && !/\d{4,}/.test(n.id)) { parts.unshift('#' + n.id); break }
          let i = 1
          let x = n
          while ((x = x.previousElementSibling)) if (x.tagName === n.tagName) i++
          parts.unshift(n.tagName.toLowerCase() + ':' + i)
          n = n.parentElement
        }
        const out = parts.join('>')
        return out.length <= 220 ? out : ''
      }
      const els = {}
      let count = 0
      for (const el of document.querySelectorAll('a, button, [role="button"], input, textarea, select, label, img, video, summary, h1, h2, h3, p, li')) {
        if (count >= 1500) break
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        const p = pathOf(el)
        if (!p || els[p]) continue
        els[p] = [Math.round(r.left), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)]
        count++
      }
      return { anchors, els, vh: window.innerHeight }
    })
    const clipHeight = Math.min(height, MAX_HEIGHT)
    const image = await tab.screenshot({ type: 'jpeg', quality: 62, clip: { x: 0, y: 0, width: spec.width, height: clipHeight }, captureBeyondViewport: true })
    const meta = { ts: Date.now(), width: spec.width, height: clipHeight, page_height: height }
    log('shot ' + image.byteLength)
    await env.SHOTS.put(shotKey(site, page, device), image, { metadata: meta })
    await env.SHOTS.put(geoKey(site, page, device), JSON.stringify({ ...meta, sections, ...layout, v: 2 }))
    return { ...meta, sections, ...layout, v: 2 }
  } finally {
    await browser.close()
  }
}

export async function getShot(env, site, page, device) {
  const { value, metadata } = await env.SHOTS.getWithMetadata(shotKey(site, page, device), { type: 'arrayBuffer' })
  return value ? { image: value, meta: metadata } : null
}

export async function shotMeta(env, site, page, device) {
  return (await env.SHOTS.get(geoKey(site, page, device), { type: 'json' })) || null
}
