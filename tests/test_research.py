import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import research_agent as research
import research_delivery as delivery
from local_research_ai import validate_selection

NOW = dt.datetime(2026, 10, 1, 13, 0, tzinfo=dt.timezone.utc)


def history(count=210):
    return [{'date': str(dt.date(2026, 9, 30) - dt.timedelta(days=count-i-1)), 'close':100+i, 'volume':1000} for i in range(count)]


def row(symbol='TEST', industry='Software', kind='stock'):
    bars = history()
    return {'symbol':symbol, 'name':symbol, 'kind':kind, 'group':symbol, 'sector':'Technology',
            'industry':industry, 'currency':'USD', 'financialCurrency':'USD',
            'prices':research.price_metrics(bars, NOW), 'history':bars,
            'fundamentals':research.fundamental_metrics({'marketCap':1e9,'trailingPE':20,'revenueGrowth':.1,'profitMargins':.15,'freeCashflow':0}, {'debt':50,'equity':100,'date':'2026-06-30'}, kind),
            'retrievedAt':{'prices':NOW.isoformat(),'company':NOW.isoformat(),'balance':NOW.isoformat()},
            'sourceUrl':'https://finance.yahoo.com/quote/'+symbol+'/', 'warnings':[], 'priceWarning':'','fundamentalWarning':''}


def report():
    return research.assemble([row('SPY',kind='market_etfs'),row()], {'benchmark':'SPY','description':'Test universe'}, NOW)


class ResearchTests(unittest.TestCase):
    def test_ratio_uses_same_statement_and_preserves_zero_debt(self):
        self.assertEqual(research.debt_ratio({'debt':0,'equity':100})['debtEquity'],0)
        self.assertEqual(research.debt_ratio({'debt':50,'equity':100})['debtEquity'],.5)
        for equity in [None,0,-20]:
            self.assertIsNone(research.debt_ratio({'debt':50,'equity':equity})['debtEquity'])
        self.assertIsNone(research.debt_ratio({'debt':None,'equity':100})['debtEquity'])

    def test_incomplete_session_excluded_until_close_cushion(self):
        bars=history()+[{'date':'2026-10-01','close':999,'volume':1}]
        self.assertEqual(research.price_metrics(bars,NOW)['priceDate'],'2026-09-30')
        evening=NOW.replace(hour=21)
        self.assertEqual(research.price_metrics(bars,evening)['close'],999)

    def test_missing_and_short_history_dont_create_figures(self):
        self.assertTrue(research.price_metrics([],NOW)['stale'])
        metrics=research.price_metrics(history(10),NOW)
        for key in ['sma50','sma200','return1m','volatility20d','relativeVolume']:
            self.assertIsNone(metrics[key])
        self.assertIsNone(research.number(float('nan')))
        self.assertIsNone(research.number(True))
        self.assertIsNone(research.number('100'))

    def test_returns_and_volumes_use_correct_windows(self):
        bars=history()
        metrics=research.price_metrics(bars,NOW)
        self.assertAlmostEqual(metrics['return1m'],(309/288-1)*100)
        self.assertAlmostEqual(metrics['sma50'],sum(range(260,310))/50)
        self.assertEqual(metrics['relativeVolume'],1)
        bars[-1]['volume']=0
        self.assertEqual(research.price_metrics(bars,NOW)['relativeVolume'],0)

    def test_relative_returns_require_matched_latest_dates(self):
        bars=history()
        self.assertAlmostEqual(research.compare_to_benchmark(bars,bars,NOW),0)
        self.assertIsNone(research.compare_to_benchmark(bars[:-1],bars,NOW))
        self.assertIsNone(research.compare_to_benchmark(bars[:20],bars[:20],NOW))

    def test_stale_and_failed_quotes_not_selected(self):
        a=row(); a['prices']['stale']=True; research.assess(a)
        self.assertFalse(a['eligible'])
        a=row(); a['priceWarning']='Saved data'; research.assess(a)
        self.assertFalse(a['eligible'])
        a=row(); a['fundamentalWarning']='Unavailable'; research.assess(a)
        self.assertFalse(a['eligible'])

    def test_industry_pe_comparison_requires_three_other_peers(self):
        a,b,c,d,e=[row(s) for s in ['A','B','C','D','E']]
        for r,pe in zip([a,b,c,d,e],[20,10,30,50,100]):r['fundamentals']['pe']=pe
        e['industry']='Banks'
        research.assemble([a,b,c,d,e],{'benchmark':'A','description':'test'},NOW)
        self.assertEqual(a['peerPE'],30)
        self.assertIsNone(e['peerPE'])

    def test_etfs_dont_get_corporate_financial_scoring(self):
        f=research.fundamental_metrics({'trailingPE':20,'marketCap':1e9,'totalAssets':2e9},{'debt':1,'equity':1},'sector_etfs')
        self.assertEqual(f,{'assets':2e9})

    def test_html_escapes_provider_text_and_retains_data_gaps(self):
        r=report(); r['rows'][1]['name']='<script>bad()</script>'
        page=research.render(r)
        self.assertNotIn('<script>',page)
        self.assertIn('&lt;script&gt;',page)
        self.assertIn('Not available',page)
        self.assertIn('Quantitative screen only',page)

    def test_ai_cannot_invent_stocks_or_evidence(self):
        a=row(); research.assess(a)
        valid={'stocks':[{'symbol':'TEST','evidence':[0],'risks':[]}],'market':['SPY']}
        self.assertEqual(validate_selection(valid,[a],[row('SPY',kind='market_etfs')])['stocks'][0]['symbol'],'TEST')
        for update in [{'symbol':'FAKE','evidence':[0],'risks':[]},{'symbol':'TEST','evidence':[999],'risks':[]},{'symbol':'TEST','evidence':[True],'risks':[]}]:
            bad=copy.deepcopy(valid);bad['stocks']=[update]
            with self.assertRaises(ValueError):validate_selection(bad,[a],[row('SPY',kind='market_etfs')])

    def test_claims_block_duplicate_delivery_and_require_receipt(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(delivery,'DIRECTORY',Path(directory)):
            path=Path(directory)
            (path/'delivery-config.json').write_text(json.dumps({'recipient':'test@example.com','timezone':'America/Indiana/Indianapolis'}))
            r=report();r['reportId']=dt.datetime.now(research.LOCAL).strftime('%Y-%m-%d')
            r['scope']='full';r['localAI']={'status':'complete','model':'test','selection':{'stocks':[],'market':[]}}
            (path/'latest.json').write_text(json.dumps(r))
            self.assertEqual(delivery.delivery('status')['status'],'not_sent')
            self.assertEqual(delivery.delivery('claim')['status'],'claimed')
            self.assertEqual(delivery.delivery('claim')['status'],'blocked')
            with self.assertRaises(ValueError):delivery.delivery('sent')
            self.assertEqual(delivery.delivery('sent','confirmed-message-id')['status'],'sent')
            self.assertEqual(delivery.delivery('claim')['status'],'blocked')

    def test_old_reports_are_not_emailed_as_today(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(delivery,'DIRECTORY',Path(directory)):
            path=Path(directory)
            (path/'delivery-config.json').write_text(json.dumps({'recipient':'test@example.com','timezone':'America/Indiana/Indianapolis'}))
            r=report();r['reportId']='2000-01-01';(path/'latest.json').write_text(json.dumps(r))
            with self.assertRaises(ValueError):delivery.delivery('claim')

    def test_partial_or_unreviewed_reports_cannot_be_sent(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(delivery,'DIRECTORY',Path(directory)):
            path=Path(directory)
            (path/'delivery-config.json').write_text(json.dumps({'recipient':'test@example.com','timezone':'America/Indiana/Indianapolis'}))
            r=report();r['reportId']=dt.datetime.now(research.LOCAL).strftime('%Y-%m-%d')
            for scope, ai in [('subset','complete'), ('full','unavailable')]:
                r['scope']=scope;r['localAI']={'status':ai}
                (path/'latest.json').write_text(json.dumps(r))
                with self.assertRaises(ValueError):delivery.delivery('claim')
                self.assertFalse((path/'deliveries.json').exists())


if __name__=='__main__':unittest.main()
