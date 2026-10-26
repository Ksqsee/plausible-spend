import React, { useEffect, useState } from 'react'
import * as api from '../api'
import { useQueryContext } from '../query-context'
import { useSiteContext } from '../site-context'
import { numberLongFormatter } from '../util/number-formatter'

type AdSpendRow = {
  platform: string
  campaign: string
  campaign_id: string
  spend: number
  clicks: number
  impressions: number
  visitors: number | null
  cost_per_visitor: number | null
}

type AdSpendResponse =
  | { configured: false }
  | {
      configured: true
      currency: string
      goal_filter: boolean
      results: AdSpendRow[]
      totals: Omit<AdSpendRow, 'platform' | 'campaign' | 'campaign_id'>
    }

const PLATFORM_NAMES: Record<string, string> = {
  google_ads: 'Google Ads',
  facebook: 'Meta Ads',
  linkedin: 'LinkedIn Ads',
  tiktok: 'TikTok Ads',
  bing: 'Microsoft Ads'
}

function platformName(platform: string) {
  return PLATFORM_NAMES[platform] ?? platform
}

function useMoneyFormatter(currency: string | undefined) {
  return React.useMemo(() => {
    const format = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'EUR'
    })
    return (value: number | null) =>
      value === null ? '–' : format.format(value)
  }, [currency])
}

export default function AdSpend() {
  const site = useSiteContext()
  const { query } = useQueryContext()
  const [data, setData] = useState<AdSpendResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    setLoading(true)
    api
      .get(`/api/stats/${encodeURIComponent(site.domain)}/ad-spend`, query)
      .then((res: AdSpendResponse) => {
        setData(res)
        setError(false)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [query, site.domain])

  const formatMoney = useMoneyFormatter(
    data && data.configured ? data.currency : undefined
  )

  if (data && !data.configured) {
    return null
  }

  const goalFilter = data?.configured ? data.goal_filter : false
  const visitorsLabel = goalFilter ? 'Conversions' : 'Visitors'
  const costLabel = goalFilter ? 'Cost / conversion' : 'Cost / visitor'

  return (
    <div className="relative w-full mt-5 p-4 bg-white dark:bg-gray-900 shadow-sm rounded-md">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-bold dark:text-gray-100">Ad Spend</h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Matched to visits by utm_campaign (campaign name or ID). Filters other
          than goals and dates don&apos;t change spend.
        </span>
      </div>

      {loading && !data && (
        <div className="flex justify-center items-center h-32">
          <div className="loading">
            <div />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-6 text-sm text-gray-500 dark:text-gray-400">
          Could not load ad spend.
        </div>
      )}

      {data?.configured && (
        <div className={loading ? 'opacity-50' : undefined}>
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Spend" value={formatMoney(data.totals.spend)} />
            <Stat
              label="Clicks"
              value={numberLongFormatter(data.totals.clicks)}
            />
            <Stat
              label={`${visitorsLabel} from ads`}
              value={
                data.totals.visitors === null
                  ? '–'
                  : numberLongFormatter(data.totals.visitors)
              }
            />
            <Stat
              label={costLabel}
              value={formatMoney(data.totals.cost_per_visitor)}
            />
          </div>

          {data.results.length === 0 ? (
            <div className="mt-6 text-sm text-gray-500 dark:text-gray-400">
              No ad spend in this period.
            </div>
          ) : (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs font-bold tracking-wide text-gray-500 dark:text-gray-400">
                    <th className="text-left pb-2 pr-4">Campaign</th>
                    <th className="text-right pb-2 px-2">Spend</th>
                    <th className="text-right pb-2 px-2">Clicks</th>
                    <th className="text-right pb-2 px-2">{visitorsLabel}</th>
                    <th className="text-right pb-2 pl-2">{costLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((row) => (
                    <tr
                      key={`${row.platform}-${row.campaign_id}-${row.campaign}`}
                      className="border-t border-gray-100 dark:border-gray-800 dark:text-gray-200"
                    >
                      <td className="py-2 pr-4">
                        <div className="break-all">{row.campaign}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {platformName(row.platform)}
                          {row.visitors === null &&
                            ' · no matching utm_campaign'}
                        </div>
                      </td>
                      <td className="py-2 px-2 text-right font-medium">
                        {formatMoney(row.spend)}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {numberLongFormatter(row.clicks)}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {row.visitors === null
                          ? '–'
                          : numberLongFormatter(row.visitors)}
                      </td>
                      <td className="py-2 pl-2 text-right">
                        {formatMoney(row.cost_per_visitor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-bold tracking-wide text-gray-500 dark:text-gray-400 uppercase">
        {label}
      </div>
      <div className="mt-1 text-lg font-bold dark:text-gray-100">{value}</div>
    </div>
  )
}
