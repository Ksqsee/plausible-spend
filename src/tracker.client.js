// Cookieless page view, click and form tracker. Served at /s.js.
// Usage: <script defer data-domain="example.de" src="https://<worker>/s.js"></script>
// Add ?gw_ignore=1 to any page URL to stop counting your own visits in that browser
// (?gw_ignore=0 turns counting back on).
//
// Events:
//   pageview, Engagement (scroll depth, seconds visible, named sections seen)
//   Phone / Email / WhatsApp / Maps click, Review click, Outbound link, File download, Button click
//   FAQ open, Copy contact, Video play
//   Form start, Form step, Form submit (a lead the CRM accepted), Form abandon (left with the form
//   half filled: which field came last, never what was typed), Application start, Application,
//   Application contact (call or mail about a job), Cancellation (withdrawal form, not a lead)
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

  function clip(s, n) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 80)
  }

  // ---- engagement: scroll depth, visible time and named sections, sent once per page ----

  var NAMED_SECTION = /^[a-z][a-z0-9-]{1,40}$/
  var SKIP_SECTION = /^(main-content|top|faq-a-\d+|root|app|cookie.*)$/
  var seen = []
  var depth = 0
  var visibleMs = 0
  var visibleSince = 0
  var engagementSent = true
  var observer

  function sectionName(el) {
    var s = el && el.closest && el.closest('section[id]')
    return s && NAMED_SECTION.test(s.id) && !SKIP_SECTION.test(s.id) ? s.id : null
  }

  // The visible heading of a section, so the dashboard can say "Leistungen" instead of "#leistungen".
  function headingOf(root) {
    var h = root && root.querySelector && root.querySelector('h1, h2, h3, [class*="title"], [class*="Title"]')
    return h ? tidy(clip(h.innerText || h.textContent, 60)) : ''
  }
  function tidy(t) {
    t = String(t || '').replace(/\s*\*\s*$/, '').replace(/[:\s]+$/, '')
    // labels set in capitals by CSS read better in sentence case
    if (t.length > 3 && t === t.toUpperCase() && /[A-ZÄÖÜ]/.test(t)) t = t.charAt(0) + t.slice(1).toLowerCase()
    return t.replace(/\be-mail\b/i, 'E-Mail')
  }
  function sectionHeadings(ids) {
    var out = {}
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i])
      var h = headingOf(el)
      if (h) out[ids[i]] = h
    }
    return out
  }

  function resetEngagement() {
    seen = []
    depth = 0
    visibleMs = 0
    visibleSince = document.visibilityState === 'visible' ? Date.now() : 0
    engagementSent = false
    if (observer) observer.disconnect()
    if (!window.IntersectionObserver) return
    // A section counts as seen once it crosses the middle band of the screen.
    observer = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var id = entries[i].target.id
          if (entries[i].isIntersecting && seen.indexOf(id) < 0 && seen.length < 40) seen.push(id)
        }
      },
      { rootMargin: '-35% 0px -35% 0px' }
    )
    var current = observer
    setTimeout(function () {
      if (current !== observer) return
      var list = document.querySelectorAll('section[id]')
      for (var i = 0; i < list.length; i++) {
        if (NAMED_SECTION.test(list[i].id) && !SKIP_SECTION.test(list[i].id)) observer.observe(list[i])
      }
    }, 300)
  }

  window.addEventListener(
    'scroll',
    function () {
      var doc = document.documentElement
      var max = Math.max(doc.scrollHeight - window.innerHeight, 1)
      var pct = Math.min(100, Math.round(((window.scrollY || doc.scrollTop) / max) * 100))
      if (pct > depth) depth = pct
    },
    { passive: true }
  )

  function flushEngagement() {
    if (engagementSent) return
    if (visibleSince) visibleMs += Date.now() - visibleSince
    visibleSince = 0
    var t = Math.round(visibleMs / 1000)
    if (t < 1 && !seen.length) return
    engagementSent = true
    var bucket = depth >= 90 ? '100%' : depth >= 75 ? '75%' : depth >= 50 ? '50%' : depth >= 25 ? '25%' : '0%'
    send('Engagement', { label: bucket, d: depth, t: Math.min(t, 3600), sec: seen.slice(0, 40), sn: sectionHeadings(seen.slice(0, 40)) })
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { flushEngagement(); flushForms() }
    else {
      if (!engagementSent) visibleSince = Date.now()
      // back from another app: a later abandon may replace the one just sent
      for (var k in forms) forms[k].sent = false
    }
  })
  window.addEventListener('pagehide', function () { flushEngagement(); flushForms() })

  // ---- page views ----

  var formsStarted = {}
  var lastPath
  function pageview() {
    if (lastPath === location.pathname) return
    flushEngagement()
    flushForms()
    lastPath = location.pathname
    formsStarted = {}
    forms = {}
    resetEngagement()
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

  // ---- clicks ----

  var FILE_RE = /\.(pdf|xlsx?|docx?|pptx?|txt|rtf|csv|zip|rar|7z|gz|dmg|exe|mp3|mp4|mov|avi|wav)$/i
  var BUTTON_RE = /(^|[\s_-])(btn|button|cta)|Cta|Button|Btn/
  var APPLICATION_RE = /bewerb|bewirb|karriere|\/jobs?\b|stellen|lebenslauf|apply|application|aplikuj|başvur|заявк/i
  var CANCEL_RE = /widerruf|kündig|kuendig|storn/i
  var REVIEW_RE = /g\.page\/r\/|writereview|\/maps\?cid=/i

  function text(el) {
    return clip(el.getAttribute('data-track') || el.innerText || el.value || el.getAttribute('aria-label') || el.title || '')
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
      var where = sectionName(el)
      var props = function (extra) {
        var p = { label: label }
        if (where) p.section = where
        for (var k in extra) p[k] = extra[k]
        return p
      }

      if (el.tagName === 'A') {
        var href = el.getAttribute('href') || ''
        // Calls and mails about a job are applications, not customer leads.
        var job = APPLICATION_RE.test(label + ' ' + (where || '') + ' ' + location.pathname)
        if (/^tel:/i.test(href)) return send(job ? 'Application contact' : 'Phone click', props({ target: href.slice(4).replace(/[^\d+]/g, ''), via: 'Telefon' }))
        if (/^mailto:/i.test(href)) return send(job ? 'Application contact' : 'Email click', props({ target: href.slice(7).split('?')[0], via: 'E-Mail' }))
        if (/^https?:\/\/(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)/i.test(href)) return send(job ? 'Application contact' : 'WhatsApp click', props({ via: 'WhatsApp' }))
        var url
        try {
          url = new URL(el.href, location.href)
        } catch (err) {}
        if (url && FILE_RE.test(url.pathname)) return send('File download', props({ target: url.origin + url.pathname }))
        if (url && /^https?:$/.test(url.protocol) && url.host !== location.host) {
          if (REVIEW_RE.test(url.href) || /bewertung|rezension|review/i.test(label)) return send('Review click', props({ target: url.host }))
          if (/google\.[a-z.]+\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl|openstreetmap\.org/i.test(url.href))
            return send('Maps click', props({ target: url.host }))
          return send('Outbound link', props({ target: url.origin + url.pathname }))
        }
        if (custom || BUTTON_RE.test(el.className || '')) return send('Button click', props({ target: href.split(/[?#]/)[0] }))
        return
      }

      var expanded = el.getAttribute('aria-expanded')
      if (expanded !== null) {
        // Accordions: count opening a question, ignore menus and closing.
        if (expanded === 'false' && (/\?\s*$/.test(label) || where === 'faq' || el.closest('[id^="faq"], [class*="faq"], [class*="Faq"]')))
          send('FAQ open', props({}))
        return
      }
      if (el.closest('form')) return // covered by Form start / Form step / Form submit
      if (custom || BUTTON_RE.test(el.className || '')) return send('Button click', props({}))
    },
    true
  )

  // ---- forms ----
  // Multi-step forms submit once per step, so a submit event is a step, not a lead.
  // A lead is counted when the site's CRM accepts it (Onepage: crm-service leadV2.create).

  var lastForm = null
  var lastStep = {}
  // per form on this page: fields touched in order, fields that showed an error, start time
  var forms = {}
  var FIELD_WRAP = '[class*="field"], [class*="Field"], [class*="question"], [class*="Question"], fieldset'
  var FIELD_EL = 'input, textarea, select, button, [role="radio"], [role="checkbox"], [role="combobox"], [role="option"]'

  function cssEscape(v) {
    return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&')
  }

  // The field's label as the visitor reads it. Never its value.
  function fieldName(el, form) {
    var t = ''
    try {
      var lab = el.id && document.querySelector('label[for="' + cssEscape(el.id) + '"]')
      if (lab) t = lab.innerText
    } catch (e) {}
    if (!t) {
      var own = el.closest('label')
      if (own && form.contains(own)) t = own.innerText
    }
    if (!t) {
      var wrap = el.closest(FIELD_WRAP)
      if (wrap && wrap !== form && form.contains(wrap)) {
        var head = wrap.querySelector('legend, label, [class*="label"], [class*="Label"]')
        t = (head || wrap).innerText
      }
    }
    t = String(t || '').split('\n')[0]
    if (!t.trim()) t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || ''
    return tidy(clip(t, 50))
  }

  function formState(form, key) {
    if (!forms[key]) forms[key] = { t0: Date.now(), seq: [], err: [], done: false, sent: false }
    return forms[key]
  }

  function noteField(el, form, key) {
    if (!el || el === form || !el.matches || !el.matches(FIELD_EL)) return
    if (el.type === 'submit' || el.type === 'hidden') return
    var f = formState(form, key)
    var name = fieldName(el, form)
    if (name && f.seq.indexOf(name) < 0 && f.seq.length < 20) f.seq.push(name)
  }

  // Leaving the page with a started, unsent form: say how far the visitor got.
  function flushForms() {
    for (var key in forms) {
      var f = forms[key]
      if (f.done || f.sent || !f.seq.length) continue
      f.sent = true
      send('Form abandon', { label: key, last: f.seq[f.seq.length - 1], fs: f.seq.slice(0, 20), err: f.err.slice(0, 20), t: Math.min(Math.round((Date.now() - f.t0) / 1000), 3600) })
    }
  }

  function formKey(form) {
    return sectionName(form) || form.getAttribute('data-track') || form.id || form.getAttribute('name') || 'form'
  }

  function isApplication(text) {
    return APPLICATION_RE.test(text + ' ' + location.pathname)
  }

  function onFormTouch(e) {
    var form = e.target && e.target.closest && e.target.closest('form')
    if (!form || inConsentBanner(form)) return
    var key = formKey(form)
    lastForm = key
    if (CANCEL_RE.test(key + ' ' + location.pathname)) return
    var field = e.target.closest(FIELD_EL)
    if (field && form.contains(field)) noteField(field, form, key)
    if (formsStarted[key]) return
    formsStarted[key] = true
    send(isApplication(key) ? 'Application start' : 'Form start', { label: key, fn: headingOf(form.closest('section') || form) })
  }

  // the browser's own "please fill in this field" and the site's error styling both count
  document.addEventListener(
    'invalid',
    function (e) {
      var form = e.target && e.target.closest && e.target.closest('form')
      if (!form || inConsentBanner(form)) return
      var key = formKey(form)
      var f = formState(form, key)
      var name = fieldName(e.target, form)
      if (name && f.err.indexOf(name) < 0) f.err.push(name)
    },
    true
  )
  function noteErrors(form, key) {
    var bad = form.querySelectorAll('[aria-invalid="true"]')
    var f = formState(form, key)
    for (var i = 0; i < bad.length && f.err.length < 20; i++) {
      var name = fieldName(bad[i], form)
      if (name && f.err.indexOf(name) < 0) f.err.push(name)
    }
  }
  document.addEventListener('pointerdown', onFormTouch, true)
  document.addEventListener('focusin', onFormTouch, true)

  // Only progress markers inside the form count; a numbered "how it works" list next to it is not a step.
  function stepInfo(form) {
    var num = form.querySelector('[class*="stepNum"], [class*="step-num"], [aria-current="step"]')
    if (!num) return null
    var n = parseInt(String(num.textContent).replace(/[^\d]/g, ''), 10)
    var name = form.querySelector('[class*="stepName"], [class*="step-name"]')
    var text = name ? clip(name.textContent, 40) : ''
    if (!text) {
      // name the step after its first visible field
      var fields = form.querySelectorAll(FIELD_EL)
      for (var i = 0; i < fields.length; i++) {
        if (fields[i].offsetParent !== null && fields[i].type !== 'submit') { text = fieldName(fields[i], form); break }
      }
    }
    return (isNaN(n) ? clip(num.textContent, 12) : 'Schritt ' + n) + (text ? ' · ' + tidy(text) : '')
  }

  // Read the progress label after the site has rendered the next step. Some steps advance on a
  // tap without submitting, so taps inside a form are checked as well.
  function checkStep(form) {
    var key = formKey(form)
    lastForm = key
    var check = function () {
      noteErrors(form, key)
      var step = stepInfo(form)
      if (step && step !== lastStep[key]) {
        var first = lastStep[key] === undefined && /^Schritt 1\b/.test(step)
        lastStep[key] = step
        if (!first) send('Form step', { label: step, form: key })
      }
    }
    setTimeout(check, 450)
    setTimeout(check, 1100)
  }

  document.addEventListener(
    'submit',
    function (e) {
      var form = e.target
      if (form && form.tagName === 'FORM' && !inConsentBanner(form)) checkStep(form)
    },
    true
  )
  document.addEventListener(
    'click',
    function (e) {
      var form = e.target && e.target.closest && e.target.closest('form')
      if (form && !inConsentBanner(form)) checkStep(form)
    },
    true
  )

  var PII_TYPE = /email|phone|tel|textarea|consent|file|upload|signature|password/i
  // only fields where the visitor picks from given options; free text can hold anything personal
  var CHOICE_TYPE = /select|radio|checkbox|choice|option|dropdown|toggle|rating|slider|range|number|date/i
  var PII_LABEL = /ansprech|beschreib|anliegen|helfen|frage|name|adresse|anschrift|stra(ß|ss)e|plz|postleitzahl|\bort\b|wohnort|firma|unternehmen|telefon|handy|mobil|mail|nachricht|notiz|kommentar|anmerkung|geburt|iban|datenschutz|einwillig/i

  // Keeps only the choices a visitor picked (problem, material, size, timing), never contact details.
  function choices(fields) {
    var out = {}
    var n = 0
    for (var i = 0; i < fields.length && n < 8; i++) {
      var f = fields[i] || {}
      var label = clip(f.label, 40)
      var value = typeof f.value === 'string' || typeof f.value === 'number' ? clip(f.value, 80) : ''
      if (!label || !value || !CHOICE_TYPE.test(f.atomType || '') || PII_TYPE.test(f.atomType || '') || PII_LABEL.test(label)) continue
      if (/@|\d{5,}|https?:/.test(value)) continue
      out[label] = value
      n++
    }
    return out
  }

  function leadSent(bodyText) {
    var fields = []
    try {
      var body = JSON.parse(bodyText)
      fields = (body && body.params && body.params.fields) || []
    } catch (e) {}
    var labels = fields.map(function (f) { return (f && f.label) || '' }).join(' ')
    var key = lastForm || 'form'
    leadAt = Date.now()
    var where = key + ' ' + labels + ' ' + location.pathname
    var name = CANCEL_RE.test(where) ? 'Cancellation' : isApplication(where) ? 'Application' : 'Form submit'
    var f = forms[key]
    var props = { label: key, c: name === 'Form submit' ? choices(fields) : {} }
    if (f) {
      f.done = true
      props.fs = f.seq.slice(0, 20)
      props.err = f.err.slice(0, 20)
      props.t = Math.min(Math.round((Date.now() - f.t0) / 1000), 3600)
    }
    send(name, props)
  }

  // Fallback for forms that keep their own reference to fetch and so bypass the wrapper below:
  // the browser still reports the request in its resource timing.
  var leadAt = 0
  if (window.PerformanceObserver) {
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (!LEAD_URL.test(entry.name)) return
          if (entry.responseStatus && (entry.responseStatus < 200 || entry.responseStatus >= 300)) return
          // Only count it if the fetch wrapper has not already seen this request.
          var startedAt = (performance.timeOrigin || Date.now() - performance.now()) + entry.startTime
          setTimeout(function () { if (leadAt < startedAt) leadSent('') }, 1500)
        })
      }).observe({ type: 'resource', buffered: false })
    } catch (e) {}
  }

  var LEAD_URL = /leadV2\.create/

  if (window.fetch) {
    var origFetch = window.fetch
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url
      var result = origFetch.apply(this, arguments)
      if (url && LEAD_URL.test(url)) {
        var body = init && typeof init.body === 'string' ? init.body : ''
        result.then(
          function (res) {
            if (!res.ok) return
            res.clone().json().then(
              function (j) { if (!j || !j.error) leadSent(body) },
              function () { leadSent(body) }
            )
          },
          function () {}
        )
      }
      return result
    }
  }
  var XHR = window.XMLHttpRequest && XMLHttpRequest.prototype
  if (XHR) {
    var xhrOpen = XHR.open
    var xhrSend = XHR.send
    XHR.open = function (method, url) {
      this._gwLead = LEAD_URL.test(String(url))
      return xhrOpen.apply(this, arguments)
    }
    XHR.send = function (body) {
      if (this._gwLead) {
        var xhr = this
        var text = typeof body === 'string' ? body : ''
        xhr.addEventListener('load', function () {
          var body = ''
          // responseText throws when the site asked for json or blob responses
          try { body = !xhr.responseType || xhr.responseType === 'text' ? xhr.responseText : JSON.stringify(xhr.response) } catch (e) {}
          if (xhr.status >= 200 && xhr.status < 300 && !/"error"\s*:\s*\{/.test(body || '')) leadSent(text)
        })
      }
      return xhrSend.apply(this, arguments)
    }
  }

  // ---- other signals ----

  document.addEventListener('copy', function () {
    var s = String((window.getSelection && window.getSelection()) || '').trim()
    if (/^[+\d][\d\s/().-]{5,}$/.test(s)) send('Copy contact', { label: 'Telefon' })
    else if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s)) send('Copy contact', { label: 'E-Mail' })
  })

  document.addEventListener(
    'play',
    function (e) {
      var v = e.target
      if (v && v.tagName === 'VIDEO' && !v._gwPlayed && !v.muted) {
        v._gwPlayed = true
        send('Video play', { label: sectionName(v) || location.pathname })
      }
    },
    true
  )

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

  window.gwTrack = function (name, props) {
    send(String(name).slice(0, 80), props)
  }
})()
