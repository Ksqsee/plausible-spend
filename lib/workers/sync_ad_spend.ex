defmodule Plausible.Workers.SyncAdSpend do
  @moduledoc """
  Pulls recent ad spend from Windsor.ai for all configured accounts.
  """

  use Oban.Worker, queue: :ad_spend_sync, max_attempts: 3

  @impl Oban.Worker
  def perform(_job) do
    case Plausible.AdSpend.sync() do
      {:ok, _} -> :ok
      {:error, :no_api_key} -> :ok
    end
  end
end
