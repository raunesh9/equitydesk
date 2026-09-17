import copy
import json
import math
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import server

class EquityDeskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_data, self.original_db = server.DATA, server.DB
        server.DATA = Path(self.temp.name)
        server.DB = server.DATA / "equitydesk.sqlite3"
        server.initialize()
        server.mutate('/api/mode', {'mode':'sample'})

    def tearDown(self):
        server.DATA, server.DB = self.original_data, self.original_db
        self.temp.cleanup()

    def test_default_state_and_separate_workspaces(self):
        self.assertEqual(server.state()["mode"], "sample")
        server.mutate("/api/watchlist", {"mode":"sample","symbol":"aapl","name":"Apple"})
        server.mutate("/api/watchlist", {"mode":"sample","symbol":"AAPL","notesOnly":True,"notes":"A durable research note"})
        server.mutate("/api/holdings", {"mode":"sample","symbol":"AAPL","shares":2.5,"cost":150.25})
        server.initialize()
        self.assertEqual(server.state()["watchlist"][0]["notes"], "A durable research note")
        self.assertEqual(server.state()["holdings"][0]["shares"], 2.5)
        server.mutate("/api/mode", {"mode":"live"})
        self.assertEqual(server.state()["watchlist"], [])
        self.assertEqual(server.state()["holdings"], [])
        with self.assertRaises(server.AppError):
            server.mutate("/api/watchlist", {"mode":"sample","symbol":"MSFT"})
        server.mutate("/api/mode", {"mode":"sample"})
        self.assertEqual(len(server.state()["watchlist"]), 1)
        self.assertEqual(len(server.state()["holdings"]), 1)

    def test_duplicate_watch_does_not_erase_notes(self):
        server.mutate("/api/watchlist", {"mode":"sample","symbol":"IBM","notes":"Keep this"})
        server.mutate("/api/watchlist", {"mode":"sample","symbol":"IBM"})
        self.assertEqual(server.state()["watchlist"][0]["notes"], "Keep this")

    def test_holdings_edit_remove_and_fractional_shares(self):
        s=server.mutate("/api/holdings",{"mode":"sample","symbol":"MSFT","shares":0.25,"cost":0})
        holding=s["holdings"][0]
        self.assertEqual(holding["cost"],0)
        edited=server.mutate("/api/holdings",{"mode":"sample","id":holding["id"],"symbol":"MSFT","shares":1.25,"cost":400.1})
        self.assertEqual(edited["holdings"][0]["shares"],1.25)
        removed=server.mutate("/api/remove",{"mode":"sample","kind":"holding","id":holding["id"]})
        self.assertEqual(removed["holdings"],[])

    def test_invalid_inputs_do_not_save(self):
        for shares,cost in [(0,10),(-2,10),(float("nan"),10),(float("inf"),10),(True,10),(1,-1),(1,"abc")]:
            with self.subTest(shares=shares,cost=cost),self.assertRaises(server.AppError):
                server.mutate("/api/holdings",{"mode":"sample","symbol":"IBM","shares":shares,"cost":cost})
        for symbol in ["", "AAPL;DROP TABLE holdings", "../../data", None]:
            with self.subTest(symbol=symbol),self.assertRaises(server.AppError):
                server.valid_symbol(symbol)
        self.assertEqual(server.state()["holdings"], [])

    def test_missing_figures_and_matching_periods(self):
        payload={
          "OVERVIEW":{"Symbol":"IBM","Name":"IBM","Currency":"USD","MarketCapitalization":"None","PERatio":"-"},
          "TIME_SERIES_DAILY":{"Time Series (Daily)":{"2025-03-04":{"4. close":"100.5"},"2025-03-03":{"4. close":"90"},"2025-03-05":{"4. close":"NaN"}}},
          "INCOME_STATEMENT":{"annualReports":[{"fiscalDateEnding":"2024-12-31","reportedCurrency":"USD","totalRevenue":"0","netIncome":"-5"}]},
          "CASH_FLOW":{"annualReports":[{"fiscalDateEnding":"2024-12-31","reportedCurrency":"USD","operatingCashflow":"100","capitalExpenditures":"-20"},{"fiscalDateEnding":"2023-12-31","reportedCurrency":"USD","operatingCashflow":"50"}]},
          "BALANCE_SHEET":{"annualReports":[{"fiscalDateEnding":"2024-12-31","reportedCurrency":"USD","shortLongTermDebtTotal":"30"}]}
        }
        s=server.normalize_stock("IBM",payload,{"OVERVIEW":"2025-03-04T12:00:00+00:00"},[])
        self.assertIsNone(s["marketCap"])
        self.assertIsNone(s["pe"])
        self.assertEqual(s["price"],100.5)
        self.assertEqual(s["priceDate"],"2025-03-04")
        self.assertEqual(len(s["history"]),2)
        self.assertEqual(s["financials"][0]["revenue"],0)
        self.assertEqual(s["financials"][0]["earnings"],-5)
        self.assertEqual(s["financials"][0]["freeCashFlow"],80)
        self.assertEqual(s["financials"][0]["debt"],30)
        self.assertIsNone(s["financials"][1]["revenue"])
        self.assertIsNone(s["financials"][1]["freeCashFlow"])

    def test_currency_mismatch_is_not_combined(self):
        payload={"INCOME_STATEMENT":{"annualReports":[{"fiscalDateEnding":"2024-12-31","reportedCurrency":"USD","totalRevenue":"100"}]},
                 "CASH_FLOW":{"annualReports":[{"fiscalDateEnding":"2024-12-31","reportedCurrency":"EUR","operatingCashflow":"50","capitalExpenditures":"10"}]}}
        s=server.normalize_stock("IBM",payload,{},[])
        self.assertIsNone(s["financials"][0]["freeCashFlow"])
        self.assertEqual(s["financials"][0]["revenue"],100)

    def test_provider_cache_keeps_original_timestamp_on_failure(self):
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return b'{"Symbol":"IBM","Name":"IBM"}'
        with patch.object(server.urllib.request,"urlopen",return_value=Response()) as network,patch.object(server.time,"sleep"):
            first,stamp,warning=server.provider("OVERVIEW",symbol="IBM")
            again,same_stamp,_=server.provider("OVERVIEW",symbol="IBM")
            self.assertEqual(network.call_count,1)
            self.assertEqual(stamp,same_stamp)
            self.assertIsNone(warning)
        with patch.object(server.urllib.request,"urlopen",side_effect=urllib.error.URLError("offline")),patch.object(server.time,"sleep"):
            stale,old_stamp,warning=server.provider("OVERVIEW",symbol="IBM",refresh=True)
            self.assertEqual(first,stale)
            self.assertEqual(stamp,old_stamp)
            self.assertIn("saved provider data",warning)

    def test_demo_url_matches_documented_endpoint(self):
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return b'{"Meta Data":{},"Time Series (Daily)":{}}'
        with patch.object(server.urllib.request,"urlopen",return_value=Response()) as network,patch.object(server.time,"sleep"):
            server.provider("TIME_SERIES_DAILY",symbol="IBM")
            self.assertEqual(network.call_args.args[0].full_url,"https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=IBM&apikey=demo")

    def test_demo_never_substitutes_sample_for_unknown_stock(self):
        with patch.object(server,"api_key",return_value="demo"):
            stock = server.legacy_stock_data("AAPL")
        self.assertEqual(stock['mode'], 'live')
        self.assertIsNone(stock['price'])
        self.assertEqual(stock['financials'], [])
        self.assertTrue(stock['warnings'])

    def test_http_persistence_and_local_request_guards(self):
        http=server.ThreadingHTTPServer(("127.0.0.1",0),server.Handler)
        thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
        url="http://127.0.0.1:"+str(http.server_port)
        def call(path,body=None,headers=None):
            h={"Content-Type":"application/json","X-EquityDesk":"1"} if body is not None else {}
            if headers:h.update(headers)
            req=urllib.request.Request(url+path,data=json.dumps(body).encode() if body is not None else None,headers=h)
            with urllib.request.urlopen(req) as r:return json.load(r)
        try:
            self.assertEqual(call("/api/health")["app"],"equitydesk")
            saved=call("/api/watchlist",{"mode":"sample","symbol":"IBM","notes":"HTTP note"})
            self.assertEqual(saved["watchlist"][0]["notes"],"HTTP note")
            self.assertEqual(call("/api/state")["watchlist"][0]["notes"],"HTTP note")
            self.assertNotIn("key",call("/api/state"))
            with self.assertRaises(urllib.error.HTTPError) as e:call("/api/mode",{"mode":"live"},{"X-EquityDesk":"wrong"})
            self.assertEqual(e.exception.code,403)
            with self.assertRaises(urllib.error.HTTPError) as e:call("/api/state",headers={"Host":"evil.example"})
            self.assertEqual(e.exception.code,403)
            with self.assertRaises(urllib.error.HTTPError) as e:call("/api/state",headers={"Sec-Fetch-Site":"cross-site"})
            self.assertEqual(e.exception.code,403)
            with self.assertRaises(urllib.error.HTTPError):call("/data/provider-key.txt")
        finally:
            http.shutdown();http.server_close();thread.join()

if __name__=="__main__":
    unittest.main()
