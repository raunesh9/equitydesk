import datetime as dt
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch
import pandas as pd
import server
from yahoo_data import financial_rows, frame_rows, json_safe


class YahooPaperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = server.DATA, server.DB, server.market, server.yahoo, server.paper
        server.DATA = Path(self.temp.name)
        server.DB = server.DATA / 'test.sqlite3'
        server.initialize()
        self.y = server.yahoo
        self.paper = server.paper
        self.price = 10
        self.paper.quotes = lambda symbol, refresh: self.quote(symbol)

    def tearDown(self):
        server.DATA, server.DB, server.market, server.yahoo, server.paper = self.old
        self.temp.cleanup()

    def quote(self, symbol='RIVN'):
        return {'symbol':symbol, 'name':'Rivian', 'price':self.price, 'currency':'USD', 'priceAt':server.now(),
                'checkedAt':server.now(), 'warning':'', 'source':'Yahoo Finance', 'marketState':'REGULAR'}

    def preview(self, side='buy', shares='2.5'):
        return self.paper.preview({'symbol':'RIVN', 'side':side, 'shares':shares})

    def fill(self, p):
        body = {'previewId':p['id'], 'requestId':str(uuid.uuid4())}
        self.paper.fill(body)
        return body

    def test_default_is_full_yahoo_workspace_and_virtual_cash(self):
        state = server.state()
        self.assertEqual(state['mode'], 'live')
        self.assertEqual(state['provider'], 'Yahoo Finance')
        self.assertTrue(state['quotesConfigured'])
        self.assertEqual(state['paper']['cash'], 100000)
        self.assertEqual(state['holdings'], [])

    def test_migration_preserves_existing_workspaces(self):
        server.mutate('/api/mode', {'mode':'sample'})
        server.mutate('/api/watchlist', {'mode':'sample', 'symbol':'HDRN', 'notes':'Keep this note'})
        with server.database() as db:
            db.execute("DELETE FROM settings WHERE key='yahoo_migration'")
        server.initialize()
        self.assertEqual(server.mode(), 'live')
        server.mutate('/api/mode', {'mode':'sample'})
        self.assertEqual(server.state()['watchlist'][0]['notes'], 'Keep this note')
        server.initialize()
        self.assertEqual(server.mode(), 'sample')

    def test_yahoo_timestamp_metadata_is_json_safe(self):
        stamp = pd.Timestamp('2026-09-17T13:30:00Z')
        result = json_safe({'regular':{'start':stamp}, 'missing':float('nan')})
        self.assertEqual(result['regular']['start'], stamp.timestamp())
        self.assertIsNone(result['missing'])
        json.dumps(result, allow_nan=False)

    def test_real_adapter_serializes_sdk_metadata_and_never_invents_price_time(self):
        frame = pd.DataFrame({'Close':[10.0,11.0]}, index=pd.to_datetime(['2026-09-16','2026-09-17']))
        meta = {'symbol':'RIVN', 'currency':'USD', 'regularMarketPrice':11,
                'regularMarketTime':time.time(), 'currentTradingPeriod':{'regular':{'start':pd.Timestamp.now(tz='UTC')}}}
        with patch.object(self.y.yf, 'Ticker') as ticker:
            ticker.return_value.history.return_value = frame
            ticker.return_value.get_history_metadata.return_value = meta
            q = self.y.quote('RIVN')
            self.assertEqual(q['price'], 11)
            self.assertTrue(q['priceAt'])
            meta['regularMarketTime'] = None
            q = self.y.quote('HDRN')
            self.assertIsNone(q['price'])
            self.assertTrue(q['warning'])

    def test_financial_periods_missing_figures_and_provider_fcf(self):
        inc = {'2025-12-31':{'TotalRevenue':0, 'NetIncome':-5}}
        cf = {'2025-12-31':{'OperatingCashFlow':20, 'CapitalExpenditure':-6}, '2024-12-31':{'OperatingCashFlow':9}}
        result = financial_rows(inc, {}, cf, 'USD')
        self.assertEqual(result[0]['revenue'], 0)
        self.assertEqual(result[0]['freeCashFlow'], 14)
        self.assertIsNone(result[0]['debt'])
        self.assertIsNone(result[1]['freeCashFlow'])
        self.assertIsNone(result[1]['revenue'])
        cf['2025-12-31']['FreeCashFlow'] = 13
        self.assertEqual(financial_rows(inc,{},cf,'USD')[0]['freeCashFlow'],13)
        frame = pd.DataFrame({pd.Timestamp('2025-12-31'):[float('nan'),12]}, index=['Total Debt','Cash And Cash Equivalents'])
        self.assertIsNone(frame_rows(frame)['2025-12-31']['TotalDebt'])

    def test_failure_keeps_saved_timestamps_and_uses_backoff(self):
        value, stamp, _ = self.y.cached('test',25,lambda:{'price':10})
        with server.database() as db:
            db.execute('UPDATE cache SET fetched=?', (time.time()-100,))
        with patch.object(self.y, 'yf', object()):
            from unittest.mock import Mock
            fetch = Mock(side_effect=RuntimeError('offline'))
            stale, old_stamp, warning = self.y.cached('test',25,fetch)
            self.assertEqual(stale,value)
            self.assertEqual(old_stamp,stamp)
            self.assertIn('Saved data',warning)
            self.y.cached('test',25,fetch)
            self.assertEqual(fetch.call_count,1)

    def test_company_search_uses_directory_and_yahoo_fallback(self):
        with patch.object(server.market,'refresh_directory'), patch.object(self.y,'search',return_value=[{'symbol':'NEW','name':'New company','exchange':'NYSE'}]) as remote:
            for name,symbol in [('Rivian','RIVN'),('Hadron','HDRN'),('Rocket Lab','RKLB')]:
                self.assertEqual(server.search_stocks(name)[0]['symbol'],symbol)
            remote.assert_not_called()
            self.assertEqual(server.search_stocks('unknown company name')[0]['symbol'],'NEW')

    def test_snapshot_partial_failure_does_not_erase_success(self):
        def quotes(symbol):
            if symbol=='BAD': raise server.AppError('No coverage')
            return self.quote(symbol)
        with patch.object(self.y,'quote',side_effect=quotes):
            result = self.y.snapshot(['RIVN','BAD'])
        self.assertEqual(result['quotes']['RIVN']['warning'],'')
        self.assertEqual(result['errors'],{'BAD':'No coverage'})

    def test_buy_sell_fractional_cash_cost_basis_realized_and_persistence(self):
        self.fill(self.preview(shares='2.5'))
        self.assertEqual(self.paper.state()['cash'],99975)
        self.price = 12
        self.fill(self.preview('sell','1'))
        state = self.paper.state()
        self.assertEqual(state['cash'],99987)
        self.assertEqual(state['realizedGain'],2)
        self.assertEqual(state['holdings'][0]['shares'],1.5)
        self.assertEqual(state['holdings'][0]['costBasis'],15)
        self.paper.initialize()
        self.assertEqual(self.paper.state(),state)
        self.fill(self.preview('sell','1.5'))
        self.assertEqual(self.paper.state()['holdings'],[])
        self.assertEqual(self.paper.state()['cash'],100005)
        self.assertEqual(self.paper.state()['realizedGain'],5)

    def test_idempotent_confirmation_and_single_use_preview(self):
        p = self.preview()
        body = self.fill(p)
        self.paper.fill(body)
        self.assertEqual(len(self.paper.state()['trades']),1)
        with self.assertRaises(server.AppError): self.fill(p)
        self.assertEqual(self.paper.state()['cash'],99975)

    def test_expired_and_tampered_previews_cannot_fill(self):
        p = self.preview()
        with server.database() as db:
            db.execute('UPDATE paper_previews SET expires=?',(time.time()-1,))
        with self.assertRaises(server.AppError): self.fill(p)
        with self.assertRaises(server.AppError): self.fill({'id':str(uuid.uuid4()),'price':0})
        p = self.preview()
        self.paper.fill({'previewId':p['id'],'requestId':str(uuid.uuid4()),'price':0,'amountCents':0})
        self.assertEqual(self.paper.state()['cash'],99975)

    def test_invalid_quantity_overspend_and_oversell_rejected(self):
        for q in [0,-1,True,'NaN','Infinity','0.000000001',1000000001]:
            with self.subTest(q=q),self.assertRaises(server.AppError): self.preview(shares=q)
        with self.assertRaises(server.AppError): self.preview(shares='10001')
        with self.assertRaises(server.AppError): self.preview('sell','1')
        with self.assertRaises(server.AppError): self.preview(shares='0.00000001')
        self.assertEqual(self.paper.state()['cash'],100000)

    def test_concurrent_confirmations_cannot_overdraw_cash(self):
        previews = [self.preview(shares='6000') for _ in range(2)]
        failures=[]
        def buy(p):
            try:self.fill(p)
            except server.AppError as e:failures.append(str(e))
        threads=[threading.Thread(target=buy,args=(p,)) for p in previews]
        for thread in threads:thread.start()
        for thread in threads:thread.join()
        self.assertEqual(len(failures),1)
        self.assertEqual(self.paper.state()['cash'],40000)
        self.assertEqual(len(self.paper.state()['trades']),1)

    def test_unavailable_stale_non_usd_quotes_cannot_trade(self):
        for replacement in [{'price':None},{'warning':'saved data'},{'currency':'EUR'},{'checkedAt':'2000-01-01T00:00:00Z'},{'priceAt':'2000-01-01T00:00:00Z'},{'priceAt':None}]:
            self.paper.quotes=lambda symbol, refresh,replacement=replacement:{**self.quote(symbol),**replacement}
            with self.subTest(replacement=replacement),self.assertRaises(server.AppError): self.preview()

    def test_reset_preserves_real_holdings_and_notes(self):
        server.mutate('/api/holdings',{'mode':'live','symbol':'HDRN','shares':7,'cost':2})
        server.mutate('/api/watchlist',{'mode':'live','symbol':'HDRN','notes':'Do not erase'})
        self.fill(self.preview())
        with self.assertRaises(server.AppError): self.paper.reset({})
        self.paper.reset({'confirmation':'RESET'})
        state = server.state()
        self.assertEqual(state['paper']['cash'],100000)
        self.assertEqual(state['paper']['trades'],[])
        self.assertEqual(state['holdings'][0]['shares'],7)
        self.assertEqual(state['watchlist'][0]['notes'],'Do not erase')

if __name__=='__main__':unittest.main()
