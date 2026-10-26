defmodule Plausible.AdSpend do
  @moduledoc """
  Ad spend pulled from Windsor.ai and matched against UTM campaigns.

  Configured with environment variables:

    * `WINDSOR_API_KEY` - Windsor.ai API key
    * `AD_SPEND_ACCOUNTS` - comma-separated `domain:connector:account_id`
      entries, e.g. `example.com:google_ads:123-456-7890,example.com:facebook:987`
    * `AD_SPEND_CURRENCY` - currency shown on the dashboard, defaults to `EUR`

  Spend is matched to visitors by comparing each ad campaign's name and ID
  (case-insensitive) with the `utm_campaign` of the visits.
  """

  import Ecto.Query
  require Logger

  alias Plausible.AdSpend.{Entry, Windsor}
  alias Plausible.Repo

  @sync_days 14

  def config, do: Application.get_env(:plausible, __MODULE__, [])

  def currency, do: Keyword.get(config(), :currency) || "EUR"

  @spec accounts() :: [%{domain: String.t(), connector: String.t(), account_id: String.t()}]
  def accounts, do: config() |> Keyword.get(:accounts) |> parse_accounts()

  def accounts_for(%Plausible.Site{domain: domain}) do
    Enum.filter(accounts(), &(&1.domain == domain))
  end

  def configured_for?(site), do: accounts_for(site) != []

  @doc """
  Parses the `AD_SPEND_ACCOUNTS` value. Malformed entries are skipped.
  """
  def parse_accounts(nil), do: []

  def parse_accounts(value) when is_binary(value) do
    value
    |> String.split(",", trim: true)
    |> Enum.flat_map(fn entry ->
      case entry |> String.trim() |> String.split(":", parts: 3) do
        [domain, connector, account_id]
        when domain != "" and connector != "" and account_id != "" ->
          [
            %{
              domain: String.trim(domain),
              connector: String.trim(connector),
              account_id: String.trim(account_id)
            }
          ]

        _ ->
          []
      end
    end)
  end

  @doc """
  Pulls the last #{@sync_days} days of spend for every configured account.

  Platforms keep revising recent spend, so each run replaces the whole window
  for an account instead of only adding new days.
  """
  def sync(today \\ Date.utc_today()) do
    api_key = Keyword.get(config(), :api_key)
    date_from = Date.add(today, -(@sync_days - 1))

    if api_key in [nil, ""] do
      {:error, :no_api_key}
    else
      results =
        for account <- accounts(),
            site <- List.wrap(Repo.get_by(Plausible.Site, domain: account.domain)) do
          with {:ok, rows} <-
                 Windsor.fetch(api_key, account.connector, account.account_id, date_from, today) do
            replace_window(site, account, date_from, today, rows)
          end
        end

      {:ok, results}
    end
  end

  @doc false
  def replace_window(site, account, date_from, date_to, rows) do
    now = NaiveDateTime.utc_now(:second)

    entries =
      rows
      |> Enum.group_by(&{&1.date, &1.account_id, &1.campaign_id, &1.campaign})
      |> Enum.map(fn {{date, account_id, campaign_id, campaign}, group} ->
        %{
          site_id: site.id,
          date: date,
          platform: account.connector,
          account_id: account_id,
          campaign_id: campaign_id,
          campaign: campaign,
          spend: group |> Enum.map(& &1.spend) |> Enum.reduce(Decimal.new(0), &Decimal.add/2),
          clicks: group |> Enum.map(& &1.clicks) |> Enum.sum(),
          impressions: group |> Enum.map(& &1.impressions) |> Enum.sum(),
          inserted_at: now,
          updated_at: now
        }
      end)

    Repo.transaction(fn ->
      from(e in Entry,
        where:
          e.site_id == ^site.id and e.platform == ^account.connector and
            e.account_id == ^account.account_id and e.date >= ^date_from and
            e.date <= ^date_to
      )
      |> Repo.delete_all()

      entries
      |> Enum.chunk_every(1000)
      |> Enum.each(&Repo.insert_all(Entry, &1))

      length(entries)
    end)
  end

  @doc """
  Spend per campaign for a site within a date range, highest spend first.
  """
  def campaign_totals(site, %Date.Range{first: first, last: last}) do
    from(e in Entry,
      where: e.site_id == ^site.id and e.date >= ^first and e.date <= ^last,
      group_by: [e.platform, e.campaign_id, e.campaign],
      select: %{
        platform: e.platform,
        campaign_id: e.campaign_id,
        campaign: e.campaign,
        spend: sum(e.spend),
        clicks: sum(e.clicks),
        impressions: sum(e.impressions)
      },
      order_by: [desc: sum(e.spend)]
    )
    |> Repo.all()
  end

  @doc """
  Combines campaign spend with visitor counts per `utm_campaign`.

  `visitors_by_utm` is a list of `%{utm_campaign: name, visitors: count}`.
  A UTM value matches a campaign when it equals the campaign's name or ID,
  ignoring case and surrounding whitespace.
  """
  def build_report(campaigns, visitors_by_utm) do
    visitors =
      Enum.reduce(visitors_by_utm, %{}, fn %{utm_campaign: utm, visitors: count}, acc ->
        Map.update(acc, normalize(utm), count, &(&1 + count))
      end)

    rows =
      Enum.map(campaigns, fn c ->
        matched =
          [c.campaign, c.campaign_id]
          |> Enum.reject(&(&1 in [nil, ""]))
          |> Enum.map(&normalize/1)
          |> Enum.uniq()
          |> Enum.map(&Map.get(visitors, &1))
          |> Enum.reject(&is_nil/1)

        visitor_count = if matched == [], do: nil, else: Enum.sum(matched)
        spend = to_float(c.spend)

        %{
          platform: c.platform,
          campaign: c.campaign,
          campaign_id: c.campaign_id,
          spend: spend,
          clicks: to_int(c.clicks),
          impressions: to_int(c.impressions),
          visitors: visitor_count,
          cost_per_visitor: cost_per(spend, visitor_count)
        }
      end)

    total_spend = rows |> Enum.map(& &1.spend) |> Enum.sum() |> Float.round(2)
    matched_rows = Enum.reject(rows, &is_nil(&1.visitors))
    matched_visitors = matched_rows |> Enum.map(& &1.visitors) |> Enum.sum()
    matched_spend = matched_rows |> Enum.map(& &1.spend) |> Enum.sum()

    %{
      results: rows,
      totals: %{
        spend: total_spend,
        clicks: rows |> Enum.map(& &1.clicks) |> Enum.sum(),
        impressions: rows |> Enum.map(& &1.impressions) |> Enum.sum(),
        visitors: if(matched_rows == [], do: nil, else: matched_visitors),
        cost_per_visitor:
          if(matched_rows == [], do: nil, else: cost_per(matched_spend, matched_visitors))
      }
    }
  end

  defp normalize(value), do: value |> to_string() |> String.trim() |> String.downcase()

  defp cost_per(_spend, nil), do: nil
  defp cost_per(_spend, 0), do: nil
  defp cost_per(spend, count), do: Float.round(spend / count, 2)

  defp to_float(nil), do: 0.0
  defp to_float(%Decimal{} = d), do: d |> Decimal.to_float() |> Float.round(2)
  defp to_float(n) when is_number(n), do: Float.round(n / 1, 2)

  defp to_int(nil), do: 0
  defp to_int(%Decimal{} = d), do: Decimal.to_integer(d)
  defp to_int(n) when is_integer(n), do: n
end
