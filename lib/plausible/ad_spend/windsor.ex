defmodule Plausible.AdSpend.Windsor do
  @moduledoc """
  Fetches daily campaign spend from the Windsor.ai connectors API.

  See https://windsor.ai/api-documentation/
  """
  require Logger
  alias Plausible.HTTPClient

  @fields ~w(date account_id campaign campaign_id spend clicks impressions)

  @type row() :: %{
          date: Date.t(),
          account_id: String.t(),
          campaign: String.t(),
          campaign_id: String.t(),
          spend: Decimal.t(),
          clicks: non_neg_integer(),
          impressions: non_neg_integer()
        }

  @spec fetch(String.t(), String.t(), String.t(), Date.t(), Date.t()) ::
          {:ok, [row()]} | {:error, term()}
  def fetch(api_key, connector, account_id, date_from, date_to) do
    params = %{
      "api_key" => api_key,
      "fields" => Enum.join(@fields, ","),
      "date_from" => Date.to_iso8601(date_from),
      "date_to" => Date.to_iso8601(date_to),
      "select_accounts" => account_id
    }

    url = "#{base_url()}/#{URI.encode(connector)}?#{URI.encode_query(params)}"

    case HTTPClient.impl().get(url, [{"Accept", "application/json"}]) do
      {:ok, %{body: %{"data" => data}}} when is_list(data) ->
        {:ok, Enum.flat_map(data, &parse_row(&1, account_id))}

      {:ok, %{body: body}} ->
        {:error, {:unexpected_response, body}}

      {:error, reason} ->
        Logger.error(
          "Windsor: failed to fetch #{connector} spend for #{account_id}: #{inspect(reason)}"
        )

        {:error, reason}
    end
  end

  @doc false
  def parse_row(%{"date" => date, "campaign" => campaign} = row, account_id)
      when is_binary(date) and is_binary(campaign) do
    case Date.from_iso8601(date) do
      {:ok, date} ->
        [
          %{
            date: date,
            account_id: to_string(row["account_id"] || account_id),
            campaign: campaign,
            campaign_id: to_string(row["campaign_id"] || ""),
            spend: to_decimal(row["spend"]),
            clicks: to_integer(row["clicks"]),
            impressions: to_integer(row["impressions"])
          }
        ]

      _ ->
        []
    end
  end

  def parse_row(_row, _account_id), do: []

  defp to_decimal(nil), do: Decimal.new(0)
  defp to_decimal(n) when is_integer(n), do: Decimal.new(n)
  defp to_decimal(n) when is_float(n), do: Decimal.from_float(n) |> Decimal.round(2)

  defp to_decimal(n) when is_binary(n) do
    case Decimal.parse(n) do
      {d, ""} -> Decimal.round(d, 2)
      _ -> Decimal.new(0)
    end
  end

  defp to_integer(n) when is_integer(n), do: n
  defp to_integer(n) when is_float(n), do: round(n)

  defp to_integer(n) when is_binary(n) do
    case Integer.parse(n) do
      {i, _} -> i
      :error -> 0
    end
  end

  defp to_integer(_), do: 0

  defp base_url do
    Keyword.get(Application.get_env(:plausible, Plausible.AdSpend, []), :windsor_url) ||
      "https://connectors.windsor.ai"
  end
end
