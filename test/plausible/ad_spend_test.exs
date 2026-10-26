defmodule Plausible.AdSpendTest do
  use Plausible.DataCase, async: false

  import Mox

  alias Plausible.AdSpend
  alias Plausible.AdSpend.Windsor

  setup :verify_on_exit!

  describe "parse_accounts/1" do
    test "parses domain:connector:account entries" do
      assert AdSpend.parse_accounts(
               "example.com:google_ads:123-456-7890, example.com:facebook:act_9 ,other.com:google_ads:1"
             ) == [
               %{domain: "example.com", connector: "google_ads", account_id: "123-456-7890"},
               %{domain: "example.com", connector: "facebook", account_id: "act_9"},
               %{domain: "other.com", connector: "google_ads", account_id: "1"}
             ]
    end

    test "skips malformed entries" do
      assert AdSpend.parse_accounts("example.com:google_ads,:google_ads:1,,") == []
      assert AdSpend.parse_accounts(nil) == []
    end
  end

  describe "Windsor.parse_row/2" do
    test "normalizes a Windsor row" do
      assert Windsor.parse_row(
               %{
                 "date" => "2026-10-23",
                 "account_id" => "570-032-2907",
                 "campaign" => "BRINK / conversion",
                 "campaign_id" => 42,
                 "spend" => 5.85,
                 "clicks" => 11,
                 "impressions" => 172
               },
               "fallback"
             ) == [
               %{
                 date: ~D[2026-10-23],
                 account_id: "570-032-2907",
                 campaign: "BRINK / conversion",
                 campaign_id: "42",
                 spend: Decimal.new("5.85"),
                 clicks: 11,
                 impressions: 172
               }
             ]
    end

    test "drops rows without a date or campaign" do
      assert Windsor.parse_row(%{"date" => "2026-10-23"}, "a") == []
      assert Windsor.parse_row(%{"date" => "nope", "campaign" => "x"}, "a") == []
    end
  end

  describe "build_report/2" do
    test "matches visitors by campaign name or ID, ignoring case" do
      campaigns = [
        %{
          platform: "google_ads",
          campaign: "Brand Search",
          campaign_id: "111",
          spend: Decimal.new("100.00"),
          clicks: Decimal.new(50),
          impressions: Decimal.new(1000)
        },
        %{
          platform: "google_ads",
          campaign: "Repairs",
          campaign_id: "222",
          spend: Decimal.new("30.00"),
          clicks: Decimal.new(10),
          impressions: Decimal.new(300)
        },
        %{
          platform: "facebook",
          campaign: "Unmatched",
          campaign_id: "333",
          spend: Decimal.new("20.00"),
          clicks: Decimal.new(5),
          impressions: Decimal.new(200)
        }
      ]

      visitors = [
        %{utm_campaign: "brand search", visitors: 40},
        %{utm_campaign: "222", visitors: 15},
        %{utm_campaign: "something else", visitors: 99}
      ]

      report = AdSpend.build_report(campaigns, visitors)

      assert [brand, repairs, unmatched] = report.results
      assert brand.visitors == 40
      assert brand.cost_per_visitor == 2.5
      assert repairs.visitors == 15
      assert repairs.cost_per_visitor == 2.0
      assert unmatched.visitors == nil
      assert unmatched.cost_per_visitor == nil

      assert report.totals == %{
               spend: 150.0,
               clicks: 65,
               impressions: 1500,
               visitors: 55,
               cost_per_visitor: 2.36
             }
    end

    test "has no visitor totals when nothing matches" do
      report =
        AdSpend.build_report(
          [
            %{
              platform: "google_ads",
              campaign: "A",
              campaign_id: "1",
              spend: Decimal.new("10"),
              clicks: 1,
              impressions: 2
            }
          ],
          []
        )

      assert report.totals.visitors == nil
      assert report.totals.cost_per_visitor == nil
    end
  end

  describe "sync/1" do
    setup do
      previous = Application.get_env(:plausible, AdSpend)
      on_exit(fn -> Application.put_env(:plausible, AdSpend, previous || []) end)
      :ok
    end

    test "stores spend and replaces the recent window on every run" do
      site = new_site(domain: "brink.example")

      Application.put_env(:plausible, AdSpend,
        api_key: "test-key",
        accounts: "brink.example:google_ads:570-032-2907"
      )

      expect(Plausible.HTTPClient.Mock, :get, fn url, _headers ->
        uri = URI.parse(url)
        params = URI.decode_query(uri.query)

        assert uri.path == "/google_ads"
        assert params["api_key"] == "test-key"
        assert params["select_accounts"] == "570-032-2907"
        assert params["date_from"] == "2026-10-13"
        assert params["date_to"] == "2026-10-26"

        {:ok,
         %Finch.Response{
           status: 200,
           body: %{
             "data" => [
               %{
                 "date" => "2026-10-23",
                 "account_id" => "570-032-2907",
                 "campaign" => "BRINK / conversion",
                 "campaign_id" => "1",
                 "spend" => 5.85,
                 "clicks" => 11,
                 "impressions" => 172
               },
               %{
                 "date" => "2026-10-24",
                 "account_id" => "570-032-2907",
                 "campaign" => "BRINK / conversion",
                 "campaign_id" => "1",
                 "spend" => 4.25,
                 "clicks" => 7,
                 "impressions" => 109
               }
             ]
           }
         }}
      end)

      assert {:ok, [{:ok, 2}]} = AdSpend.sync(~D[2026-10-26])

      assert [row] =
               AdSpend.campaign_totals(site, Date.range(~D[2026-10-01], ~D[2026-10-31]))

      assert row.campaign == "BRINK / conversion"
      assert Decimal.equal?(row.spend, Decimal.new("10.10"))
      assert Decimal.to_integer(row.clicks) == 18

      expect(Plausible.HTTPClient.Mock, :get, fn _url, _headers ->
        {:ok, %Finch.Response{status: 200, body: %{"data" => []}}}
      end)

      assert {:ok, [{:ok, 0}]} = AdSpend.sync(~D[2026-10-26])
      assert AdSpend.campaign_totals(site, Date.range(~D[2026-10-01], ~D[2026-10-31])) == []
    end

    test "does nothing without an API key" do
      Application.put_env(:plausible, AdSpend, accounts: "brink.example:google_ads:1")
      assert AdSpend.sync() == {:error, :no_api_key}
    end
  end
end
