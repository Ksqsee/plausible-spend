defmodule PlausibleWeb.Api.StatsController.AdSpendTest do
  use PlausibleWeb.ConnCase, async: false

  alias Plausible.AdSpend

  setup do
    previous = Application.get_env(:plausible, AdSpend)
    on_exit(fn -> Application.put_env(:plausible, AdSpend, previous || []) end)
    :ok
  end

  describe "GET /api/stats/:domain/ad-spend" do
    setup [:create_user, :log_in, :create_site]

    test "reports that the site has no ad accounts", %{conn: conn, site: site} do
      Application.put_env(:plausible, AdSpend, accounts: "other.example:google_ads:1")

      conn = get(conn, "/api/stats/#{site.domain}/ad-spend?period=day&date=2021-01-01")

      assert json_response(conn, 200) == %{"configured" => false}
    end

    test "combines spend with visitors per utm_campaign", %{conn: conn, site: site} do
      Application.put_env(:plausible, AdSpend,
        accounts: "#{site.domain}:google_ads:123",
        currency: "EUR"
      )

      insert_spend(site, ~D[2021-01-01], "Brand Search", "111", "40.00", 20)
      insert_spend(site, ~D[2021-01-01], "Repairs", "222", "10.00", 5)
      # outside the requested period
      insert_spend(site, ~D[2020-12-31], "Brand Search", "111", "99.00", 99)

      populate_stats(site, [
        build(:pageview, utm_campaign: "brand search", timestamp: ~N[2021-01-01 00:00:00]),
        build(:pageview, utm_campaign: "Brand Search", timestamp: ~N[2021-01-01 00:01:00]),
        build(:pageview, utm_campaign: "other", timestamp: ~N[2021-01-01 00:02:00])
      ])

      conn = get(conn, "/api/stats/#{site.domain}/ad-spend?period=day&date=2021-01-01")

      assert %{
               "configured" => true,
               "currency" => "EUR",
               "goal_filter" => false,
               "results" => [brand, repairs],
               "totals" => totals
             } = json_response(conn, 200)

      assert brand["campaign"] == "Brand Search"
      assert brand["spend"] == 40.0
      assert brand["visitors"] == 2
      assert brand["cost_per_visitor"] == 20.0

      assert repairs["visitors"] == nil

      assert totals["spend"] == 50.0
      assert totals["clicks"] == 25
      assert totals["visitors"] == 2
      assert totals["cost_per_visitor"] == 20.0
    end

    test "counts conversions when filtered by goal", %{conn: conn, site: site} do
      Application.put_env(:plausible, AdSpend, accounts: "#{site.domain}:google_ads:123")

      insert(:goal, site: site, event_name: "Signup")
      insert_spend(site, ~D[2021-01-01], "Brand Search", "111", "30.00", 10)

      populate_stats(site, [
        build(:pageview,
          utm_campaign: "Brand Search",
          user_id: 1,
          timestamp: ~N[2021-01-01 00:00:00]
        ),
        build(:event,
          name: "Signup",
          utm_campaign: "Brand Search",
          user_id: 1,
          timestamp: ~N[2021-01-01 00:01:00]
        ),
        build(:pageview, utm_campaign: "Brand Search", timestamp: ~N[2021-01-01 00:02:00])
      ])

      filters = Jason.encode!([[:is, "event:goal", ["Signup"]]])

      conn =
        get(
          conn,
          "/api/stats/#{site.domain}/ad-spend?period=day&date=2021-01-01&filters=#{filters}"
        )

      assert %{"goal_filter" => true, "results" => [row]} = json_response(conn, 200)
      assert row["visitors"] == 1
      assert row["cost_per_visitor"] == 30.0
    end
  end

  defp insert_spend(site, date, campaign, campaign_id, spend, clicks) do
    now = NaiveDateTime.utc_now(:second)

    Plausible.Repo.insert!(%Plausible.AdSpend.Entry{
      site_id: site.id,
      date: date,
      platform: "google_ads",
      account_id: "123",
      campaign: campaign,
      campaign_id: campaign_id,
      spend: Decimal.new(spend),
      clicks: clicks,
      impressions: clicks * 10,
      inserted_at: now,
      updated_at: now
    })
  end
end
