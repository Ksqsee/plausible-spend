// Watches every site from outside: is it reachable, how fast does it answer, and is our snippet
// still in the page? Runs every 30 minutes; results and the last incidents are kept in KV.

const MON_KEY = (site) => `mon:${site}`
const MAX_INCIDENTS = 12

async function probe(site) {
  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(`https://${site}/?gw_ignore=1`, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'GW-Monitor/1.0' } })
    const html = r.ok ? await r.text() : ''
    const ms = Date.now() - started
    const snippet = /gw-analytics[^"']*\/s\.js/.test(html)
    return { status: r.status, ms, ok: r.ok, snippet }
  } catch (e) {
    return { status: 0, ms: Date.now() - started, ok: false, snippet: false, error: String((e && e.message) || e).slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}

export async function runMonitor(env) {
  const { results } = await env.DB.prepare('SELECT domain FROM sites').all()
  await Promise.all(
    results.map(async ({ domain }) => {
      const now = Date.now()
      const prev = (await env.SHOTS.get(MON_KEY(domain), { type: 'json' })) || { incidents: [] }
      let p = await probe(domain)
      // one failed request is not an outage: ask again before raising the alarm
      if (!p.ok) p = await probe(domain)
      const problem = !p.ok ? 'down' : !p.snippet ? 'snippet' : null
      const incidents = prev.incidents || []
      const open = incidents.length && !incidents[0].end ? incidents[0] : null
      if (problem && !open) incidents.unshift({ start: now, kind: problem, status: p.status })
      if (!problem && open) open.end = now
      if (problem && open && open.kind !== problem) {
        open.end = now
        incidents.unshift({ start: now, kind: problem, status: p.status })
      }
      const ms = (prev.ms || []).concat([p.ok ? p.ms : null]).slice(-48)
      await env.SHOTS.put(
        MON_KEY(domain),
        JSON.stringify({
          ts: now,
          ok: p.ok,
          status: p.status,
          snippet: p.snippet,
          problem,
          error: p.error || null,
          last_ok: p.ok ? now : prev.last_ok || null,
          ms,
          incidents: incidents.slice(0, MAX_INCIDENTS)
        })
      )
    })
  )
}

export async function monitorStatus(env, sites) {
  const out = {}
  await Promise.all(
    sites.map(async (s) => {
      const m = await env.SHOTS.get(MON_KEY(s), { type: 'json' })
      if (!m) return
      const times = (m.ms || []).filter((x) => x !== null)
      const up = (m.ms || []).length ? (m.ms || []).filter((x) => x !== null).length / m.ms.length : null
      out[s] = {
        ts: m.ts,
        ok: m.ok,
        problem: m.problem,
        status: m.status,
        snippet: m.snippet,
        last_ok: m.last_ok,
        response_ms: times.length ? Math.round(times.slice(-12).reduce((a, b) => a + b, 0) / Math.min(12, times.length)) : null,
        uptime_24h: up,
        incidents: (m.incidents || []).slice(0, 5)
      }
    })
  )
  return out
}
