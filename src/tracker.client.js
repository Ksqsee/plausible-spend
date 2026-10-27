// Cookieless page view and click tracker. Served at /s.js.
// Usage: <script defer data-domain="example.de" src="https://<worker>/s.js"></script>
// Add ?gw_ignore=1 to any page URL to stop counting your own visits in that browser
// (?gw_ignore=0 turns counting back on).
(function () {
  'use strict'
  var script = document.currentScript
  if (!script) return
  var domain = script.getAttribute('data-domain') || location.hostname.replace(/^www\./, '')
  var endpoint = new URL(script.src).origin + '/e'

  var ignored = false
  try {
    if (/[?&]gw_ignore=(1|true)\b/.test(location.search)) localStorage.setItem('gw_ignore', '1')
    if (/[?&]gw_ignore=0\b/.test(location.search)) localStorage.removeItem('gw_ignore')
    ignored = localStorage.getItem('gw_ignore') === '1'
  } catch (e) {}

  function send(name, props) {
    if (ignored || navigator.webdriver || window._phantom || window.__nightmare) return
    if (location.protocol === 'file:' || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname)) return
    var body = JSON.stringify({
      n: name,
      u: location.href,
      d: domain,
      r: document.referrer || null,
      w: window.innerWidth,
      p: props
    })
    if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return
    try {
      fetch(endpoint, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } })
    } catch (e) {}
  }

  var lastPath
  function pageview() {
    if (lastPath === location.pathname) return
    lastPath = location.pathname
    send('pageview')
  }

  var pushState = history.pushState
  if (pushState) {
    history.pushState = function () {
      pushState.apply(this, arguments)
      pageview()
    }
    window.addEventListener('popstate', pageview)
  }

  if (document.visibilityState === 'prerender') {
    document.addEventListener('visibilitychange', function onVisible() {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', onVisible)
        pageview()
      }
    })
  } else {
    pageview()
  }

  var FILE_RE = /\.(pdf|xlsx?|docx?|pptx?|txt|rtf|csv|zip|rar|7z|gz|dmg|exe|mp3|mp4|mov|avi|wav)$/i
  var BUTTON_RE = /(^|[\s_-])(btn|button|cta)|Cta|Button|Btn/

  function text(el) {
    var t = el.getAttribute('data-track') || el.innerText || el.value || el.getAttribute('aria-label') || el.title || ''
    return t.replace(/\s+/g, ' ').trim().slice(0, 80)
  }

  function inConsentBanner(el) {
    return !!el.closest('[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], [class^="sc-"], [class*=" sc-"]')
  }

  document.addEventListener(
    'click',
    function (e) {
      if (e.button > 1 || !e.target || !e.target.closest) return
      var el = e.target.closest('a, button, input[type="submit"], [role="button"], [data-track]')
      if (!el || inConsentBanner(el)) return

      var label = text(el)
      var custom = el.getAttribute('data-track')

      if (el.tagName === 'A') {
        var href = el.getAttribute('href') || ''
        if (/^tel:/i.test(href)) return send('Phone click', { label: label, target: href.slice(4) })
        if (/^mailto:/i.test(href)) return send('Email click', { label: label, target: href.slice(7).split('?')[0] })
        if (/^https?:\/\/(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)/i.test(href))
          return send('WhatsApp click', { label: label })
        var url
        try {
          url = new URL(el.href, location.href)
        } catch (err) {}
        if (url && FILE_RE.test(url.pathname)) return send('File download', { label: label, target: url.href })
        if (url && /^https?:$/.test(url.protocol) && url.host !== location.host) {
          if (/google\.[a-z.]+\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(url.href))
            return send('Maps click', { label: label, target: url.href })
          return send('Outbound link', { label: label, target: url.href })
        }
        if (custom || BUTTON_RE.test(el.className || '')) return send('Button click', { label: label, target: href })
        return
      }

      if (el.getAttribute('aria-expanded') !== null) return
      // Submitting a form is counted by the submit listener below.
      if (el.type === 'submit' && el.form && !custom) return
      if (custom || BUTTON_RE.test(el.className || '') || el.type === 'submit')
        return send('Button click', { label: label })
    },
    true
  )

  document.addEventListener(
    'submit',
    function (e) {
      var form = e.target
      if (!form || form.tagName !== 'FORM' || inConsentBanner(form)) return
      var name = form.getAttribute('data-track') || form.getAttribute('name') || form.id || ''
      send('Form submit', { label: name.slice(0, 80) })
    },
    true
  )

  window.gwTrack = function (name, props) {
    send(String(name).slice(0, 80), props)
  }
})()
