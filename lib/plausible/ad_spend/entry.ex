defmodule Plausible.AdSpend.Entry do
  @moduledoc """
  Daily ad spend for one campaign of one ad account, as reported by Windsor.ai.
  """
  use Ecto.Schema

  @type t() :: %__MODULE__{}

  schema "ad_spend" do
    belongs_to :site, Plausible.Site
    field :date, :date
    field :platform, :string
    field :account_id, :string
    field :campaign_id, :string, default: ""
    field :campaign, :string
    field :spend, :decimal, default: Decimal.new(0)
    field :clicks, :integer, default: 0
    field :impressions, :integer, default: 0

    timestamps()
  end
end
