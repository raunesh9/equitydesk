import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import server
from market import parse_directory, positive, timestamp, company_search

class MarketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = server.DATA, server.DB, server.market
        server.DATA = Path(self.temp.name); server.DB = server.DATA / 'equitydesk.sqlite3'
        server.initialize()
        server.mutate('/api/mode', {'mode':'sample'})
        self.market = server.market
        self.config = {'key':'TEST_KEY_123', 'secret':'TEST_SECRET_123', 'feed':'iex'}

    def tearDown(self):
        server.DATA, server.DB, server.market = self.old
        self.temp.cleanup()

    def test_directory_parses_both_exchanges_excludes_test_and_bad_symbols(self):
        a = 'Symbol|Security Name|Test Issue|ETF\nHDRN|Hadron Energy|N|N\nRIVN|Rivian|N|N\nTEST|Test|Y|N\n'
        b = 'ACT Symbol|Security Name|Exchange|Test Issue|ETF\nIBM|IBM|N|N|N\nSPY|SPDR|P|N|Y\nBAD/NAME|Bad|N|N|N\n'
        result = parse_directory(a, b)
        self.assertEqual([r['symbol'] for r in result], ['HDRN','IBM','RIVN','SPY'])
        self.assertEqual(result[1]['exchange'], 'NYSE')
        self.assertEqual(result[-1]['kind'], 'ETF')

    def test_large_local_directory_search_has_small_companies_and_one_letter_ticker(self):
        self.assertGreater(self.market.directory_info()['count'], 5000)
        with patch.object(self.market, 'refresh_directory'):
            self.assertEqual(self.market.search('hadron')[0]['symbol'], 'HDRN')
            self.assertEqual(self.market.search('rivian')[0]['symbol'], 'RIVN')
            self.assertEqual(self.market.search('F')[0]['symbol'], 'F')
            self.assertIn('not verified', self.market.search('ZZUNSEEN')[0]['name'])

    def test_names_match_partial_words_punctuation_and_different_word_order(self):
        rows = [{'symbol':'HDRNW','name':'Hadron Energy, Inc. - Warrants'}, {'symbol':'HDRN','name':'Hadron Energy, Inc. - Common Stock'}, {'symbol':'RIVN','name':'Rivian Automotive, Inc.'}]
        for query in ('HaDrOn', ' energy   hadron ', 'Hadron Energy Inc', 'hadr ener'):
            self.assertEqual(company_search(rows, query)[0]['symbol'], 'HDRN')
        self.assertEqual(company_search(rows, 'Rivian automotive')[0]['symbol'], 'RIVN')

    def test_familiar_names_map_to_verified_directory_rows_only(self):
        rows = [{'symbol':'GOOGL','name':'Alphabet Inc.'}, {'symbol':'META','name':'Meta Platforms, Inc.'}]
        self.assertEqual(company_search(rows,'Google')[0]['symbol'],'GOOGL')
        self.assertEqual(company_search(rows,'Facebook')[0]['symbol'],'META')
        self.assertEqual(company_search([], 'Google'), [])

    def test_name_search_does_not_offer_company_name_as_a_fake_ticker(self):
        with patch.object(self.market, 'refresh_directory'):
            result = self.market.search('RIVIAN')
            self.assertEqual(result[0]['symbol'], 'RIVN')
            self.assertNotIn('RIVIAN', [row['symbol'] for row in result])
            self.assertEqual(self.market.search('Not a listed company at all'), [])

    def test_batch_quotes_cache_share_across_different_searches(self):
        at = '2026-09-09T15:00:00Z'
        raw = {'RIVN': {'latestTrade': {'p': 15, 't': at}, 'prevDailyBar': {'c': 12}}, 'HDRN': {}}
        with patch.object(self.market,'config',return_value=self.config), patch.object(self.market,'fetch',return_value=raw) as fetch:
            first = self.market.snapshot(['RIVN','HDRN'])
            again = self.market.snapshot(['RIVN'])
            self.assertEqual(fetch.call_count,1)
            self.assertEqual(first['quotes']['RIVN']['priceAt'],at)
            self.assertEqual(first['quotes']['RIVN']['changePercent'],25)
            self.assertEqual(first['quotes']['RIVN']['checkedAt'],again['quotes']['RIVN']['checkedAt'])
            self.assertIsNone(first['quotes']['HDRN']['price'])
            self.assertTrue(first['quotes']['HDRN']['warning'])

    def test_failed_refresh_retains_timestamp_and_uses_backoff(self):
        with patch.object(self.market,'config',return_value=self.config), patch.object(self.market,'fetch',return_value={'RIVN':{'latestTrade':{'p':15,'t':'2026-09-09T15:00:00Z'}}}):
            first = self.market.snapshot(['RIVN'])
        self.market.quotes['RIVN']['checked'] -= 30
        with patch.object(self.market,'config',return_value=self.config), patch.object(self.market,'fetch',side_effect=server.AppError('Rate limit')) as fetch:
            failed = self.market.snapshot(['RIVN'])
            self.market.snapshot(['RIVN'])
            self.assertEqual(fetch.call_count,1)
            self.assertEqual(failed['quotes']['RIVN']['checkedAt'],first['quotes']['RIVN']['checkedAt'])
            self.assertEqual(failed['quotes']['RIVN']['priceAt'],first['quotes']['RIVN']['priceAt'])
            self.assertIn('Rate limit',failed['quotes']['RIVN']['warning'])

    def test_invalid_trade_data_is_never_a_price(self):
        for value in (0, -1, 'NaN', 'Infinity', True, None): self.assertIsNone(positive(value))
        self.assertIsNone(timestamp('2026-09-09'))
        self.assertEqual(timestamp('2026-09-09T15:00:00.123456789Z'), '2026-09-09T15:00:00.123456789Z')
        with patch.object(self.market,'config',return_value=self.config), patch.object(self.market,'fetch',return_value={'HDRN':{'latestTrade':{'p':10,'t':'bad date'}}}):
            self.assertIsNone(self.market.snapshot(['HDRN'])['quotes']['HDRN']['price'])

    def test_connection_is_data_only_private_and_not_exposed_by_state(self):
        with patch.object(self.market,'fetch',return_value={}) as fetch:
            self.market.connect(self.config)
            self.assertEqual(fetch.call_args.args[0], 'snapshots')
        self.assertEqual((server.DATA/'alpaca.json').stat().st_mode & 0o777, 0o600)
        state = server.state()
        self.assertTrue(state['quotesConfigured'])
        self.assertNotIn('TEST_SECRET',json.dumps(state))
        self.assertNotIn('TEST_KEY',json.dumps(state))

    def test_failed_connection_preserves_old_credentials(self):
        with patch.object(self.market,'fetch',return_value={}): self.market.connect(self.config)
        with patch.object(self.market,'fetch',side_effect=server.AppError('Not allowed')):
            with self.assertRaises(server.AppError): self.market.connect({**self.config, 'key':'DIFFERENT_KEY'})
        self.assertEqual(self.market.config(),self.config)

    def test_manager_validation_persistence_and_mode_separation(self):
        config = {'mode':'sample','cash':250.5,'targets':{'RIVN':40,'HDRN':30},'concentrationLimit':30,'driftLimit':5}
        saved = server.mutate('/api/manager',config)
        self.assertEqual(saved['manager']['cash'],250.5)
        server.initialize()
        self.assertEqual(server.state()['manager']['targets']['HDRN'],30)
        for bad in ({'targets':{'RIVN':60,'HDRN':50}},{'cash':-1},{'targets':{'RIVN':None}},{'driftLimit':0},{'concentrationLimit':True}):
            with self.assertRaises(server.AppError): server.mutate('/api/manager',{**config,**bad})
        self.assertEqual(server.state()['manager']['cash'],250.5)
        server.mutate('/api/mode',{'mode':'live'})
        self.assertEqual(server.state()['manager']['cash'],0)
        with self.assertRaises(server.AppError): server.mutate('/api/manager',config)

    def test_sample_portfolio_is_explicit_and_cannot_overwrite_holdings(self):
        state = server.mutate('/api/sample-portfolio',{'mode':'sample'})
        self.assertEqual({h['symbol'] for h in state['holdings']},{'AAPL','RIVN','HDRN'})
        with self.assertRaises(server.AppError): server.mutate('/api/sample-portfolio',{'mode':'sample'})
        server.mutate('/api/mode',{'mode':'live'})
        with self.assertRaises(server.AppError): server.mutate('/api/sample-portfolio',{'mode':'live'})
        self.assertEqual(server.state()['holdings'],[])

    def test_alpaca_only_stock_has_history_without_invented_financials(self):
        with patch.object(server,'api_key',return_value='demo'), patch.object(self.market,'config',return_value=self.config), patch.object(self.market,'bars',return_value=([{'date':'2026-09-08','close':10}], '2026-09-09T12:00:00Z','')):
            stock = server.legacy_stock_data('HDRN')
        self.assertEqual(stock['name'],'Hadron Energy, Inc. - Common Stock')
        self.assertEqual(stock['price'],10)
        self.assertEqual(stock['financials'],[])
        self.assertIsNone(stock['marketCap'])
        self.assertIsNone(stock['pe'])

    def test_historical_prices_keep_cache_on_provider_error(self):
        raw = {'bars':{'RIVN':[{'t':'2026-09-08T04:00:00Z','c':15}]}}
        with patch.object(self.market,'config',return_value=self.config), patch.object(self.market,'fetch',return_value=raw) as fetch:
            first = self.market.bars('RIVN')
            self.market.bars('RIVN')
            self.assertEqual(fetch.call_count,1)
        with patch.object(self.market,'config',return_value=self.config), patch.object(self.market,'fetch',side_effect=server.AppError('Unavailable')):
            last = self.market.bars('RIVN',True)
        self.assertEqual(last[:2],first[:2])
        self.assertEqual(last[2],'Unavailable')
