defmodule Plausible.Repo.Migrations.CreateAdSpend do
  use Ecto.Migration

  def change do
    create table(:ad_spend) do
      add :site_id, references(:sites, on_delete: :delete_all), null: false
      add :date, :date, null: false
      add :platform, :string, null: false
      add :account_id, :string, null: false
      add :campaign_id, :string, null: false, default: ""
      add :campaign, :string, null: false
      add :spend, :decimal, null: false, default: 0
      add :clicks, :bigint, null: false, default: 0
      add :impressions, :bigint, null: false, default: 0

      timestamps()
    end

    create unique_index(:ad_spend, [
             :site_id,
             :date,
             :platform,
             :account_id,
             :campaign_id,
             :campaign
           ])
  end
end
