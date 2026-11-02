// Real numbers for the funnel simulator. Everything the simulator starts from is measured; where a
// number is an assumption (close rate, order value without recorded outcomes) it says so.
//
// Stages per visit: came -> looked around (scrolled 10 % or stayed 15 s) -> reached the contact
// area (saw a contact section or page, started a form, or got in touch) -> got in touch.
// Visits from Google Ads and all other visits are counted apart, because only the first group
// grows with the ad budget, and because the two often convert very differently.

import { LEAD_EVENTS, trackingSince, where } from './stats.js'
import { outcomeStats } from './deep.js'

const CONTACT_SECTION = /anfrage|kontakt|contact|formular|termin|angebot|rueckruf|rückruf/i
const CONTACT_PAGE = /^\/(anfrage|kontakt|contact|angebot|termin|rueckruf|rückruf)/i
const ADS_SOURCE = 'Google Ads'

// 90 % Wilson interval for a share k of n
export function wilson(k, n, z = 1.645) {
  if (!n) return [0, 1]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)]
}

function stages(list) {
  const visits = list.length
  const looked = list.filter((x) => x.looked || x.area || x.lead).length
  const area = list.filter((x) => x.area || x.lead).length
  const leads = list.filter((x) => x.lead).length
  return {
    counts: { visits, looked, area, leads },
    rates: { looked: visits ? looked / visits : 0, area: looked ? area / looked : 0, contact: area ? leads / area : 0, overall: visits ? leads / visits : 0 },
    ranges: { looked: wilson(looked, visits), area: wilson(area, looked), contact: wilson(leads, area), overall: wilson(leads, visits) }
  }
}

export async function simFunnel(db, q) {
  const w = where(q)
  const since = await trackingSince(db, q.sites)
  const from = since && since > q.from ? since : q.from
  const days = Math.max(1, Math.round((new Date(q.to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1)
  const leadIn = LEAD_EVENTS.map(() => '?').join(',')
  const siteIn = q.sites.map(() => '?').join(',')
  const [rows, spend, share, outcomes] = await Promise.all([
    db
      .prepare(
        `SELECT session_id, name, page, props, source FROM events
         WHERE ${w.sql} AND name IN ('pageview', 'Engagement', 'Form start', ${leadIn})`
      )
      .bind(...w.params, ...LEAD_EVENTS)
      .all(),
    db
      .prepare(`SELECT SUM(spend) AS spend, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM ads_spend WHERE site IN (${siteIn}) AND date >= ? AND date <= ?`)
      .bind(...q.sites, from, q.to)
      .first(),
    db
      .prepare(
        `SELECT SUM(impressions) AS imp, SUM(impressions / NULLIF(impression_share, 0)) AS eligible,
           SUM(impressions / NULLIF(impression_share, 0) * lost_budget) AS lost_budget, SUM(impressions / NULLIF(impression_share, 0) * lost_rank) AS lost_rank
         FROM ads_share WHERE site IN (${siteIn}) AND date >= ? AND date <= ? AND impression_share > 0`
      )
      .bind(...q.sites, from, q.to)
      .first(),
    outcomeStats(db, q.sites)
  ])
  const s = new Map()
  let contactSignals = 0
  for (const r of rows.results) {
    let x = s.get(r.session_id)
    if (!x) {
      x = { looked: false, area: false, lead: false, ads: false }
      s.set(r.session_id, x)
    }
    if (r.source === ADS_SOURCE) x.ads = true
    let p = null
    try {
      p = r.props ? JSON.parse(r.props) : null
    } catch {}
    if (r.name === 'pageview' && CONTACT_PAGE.test(r.page)) {
      x.area = true
      contactSignals++
    }
    if (r.name === 'Engagement' && p) {
      if ((p.d || 0) >= 10 || (p.t || 0) >= 15) x.looked = true
      if ((p.sec || []).some((id) => CONTACT_SECTION.test(id))) {
        x.area = true
        contactSignals++
      }
    }
    if (r.name === 'Form start') {
      x.area = true
      contactSignals++
    }
    if (LEAD_EVENTS.includes(r.name)) {
      x.lead = true
      x.area = true
      x.looked = true
    }
  }
  const all = [...s.values()]
  const month = 30 / days
  const total = stages(all)
  const ads = stages(all.filter((x) => x.ads))
  const other = stages(all.filter((x) => !x.ads))

  // Google Ads: what a click costs, and how many more clicks money alone could buy. Impressions
  // lost to the budget can be won with more budget; those lost to ad rank need better ads or bids.
  let adsInfo = null
  if (spend && spend.clicks) {
    const ctr = spend.impressions ? spend.clicks / spend.impressions : null
    const lostBudgetImp = share && share.lost_budget ? share.lost_budget : 0
    const extraClicks = ctr ? lostBudgetImp * ctr : 0
    adsInfo = {
      spend_month: Math.round(spend.spend * month),
      clicks_month: Math.round(spend.clicks * month),
      cpc: Math.round((spend.spend / spend.clicks) * 100) / 100,
      impression_share: share && share.eligible ? share.imp / share.eligible : null,
      lost_budget: share && share.eligible ? share.lost_budget / share.eligible : null,
      lost_rank: share && share.eligible ? share.lost_rank / share.eligible : null,
      // at today's click price; extra clicks usually cost a little more
      max_extra_clicks_month: Math.round(extraClicks * month),
      max_budget_month: Math.round((spend.spend + extraClicks * (spend.spend / spend.clicks)) * month)
    }
  }

  const decided = (outcomes.won || 0) + (outcomes.lost || 0)
  return {
    days,
    since: from,
    visits_month: Math.round(total.counts.visits * month),
    month_factor: month,
    total,
    ads: ads.counts.visits ? { ...ads, visits_month: Math.round(ads.counts.visits * month) } : null,
    other: { ...other, visits_month: Math.round(other.counts.visits * month) },
    // without any contact section, page or form start the "contact area" step cannot be measured
    area_measured: contactSignals > 0,
    ads_spend: adsInfo,
    outcomes: {
      decided,
      won: outcomes.won || 0,
      lost: outcomes.lost || 0,
      none: outcomes.none || 0,
      close_rate: decided >= 3 ? outcomes.won / decided : null,
      close_range: decided >= 3 ? wilson(outcomes.won, decided) : null,
      avg_value: outcomes.won >= 2 && outcomes.avg_value ? Math.round(outcomes.avg_value) : null
    }
  }
}
