#!/usr/bin/env python3
"""Local market research: fetched evidence, deterministic metrics, reviewable reports.

AI interpretation runs in local Ollama; delivery is orchestrated by the scheduled Codex task.
This module never submits trades, reads holdings, or sends mail itself.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime as dt
import fcntl
import html
import json
import math
import os
from pathlib import Path
import statistics
import sys
import time
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DIRECTORY = ROOT / 'data' / 'research'
EASTERN = ZoneInfo('America/New_York')
LOCAL = ZoneInfo('America/Indiana/Indianapolis')


def number(value):
    if value is None or isinstance(value, (bool, str)):
        return None
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(payload, indent=2, allow_nan=False))
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def complete_through(now):
    eastern = now.astimezone(EASTERN)
    # A 15-minute cushion avoids treating a still-forming regular-session bar as final.
    return eastern.date() - dt.timedelta(days=int(eastern.time() < dt.time(16, 15)))


def price_metrics(rows, now):
    cutoff = complete_through(now)
    clean = {}
    for row in rows:
        try:
            day = dt.date.fromisoformat(row['date'])
        except (KeyError, TypeError, ValueError):
            continue
        close = number(row.get('close'))
        if day <= cutoff and close is not None and close > 0:
            clean[day] = {'date': str(day), 'close': close, 'volume': number(row.get('volume'))}
    prices = [clean[d] for d in sorted(clean)]
    if not prices:
        return {'priceDate': None, 'close': None, 'stale': True, 'observations': 0}
    closes = [r['close'] for r in prices]
    last = closes[-1]
    result = {'priceDate': prices[-1]['date'], 'close': last, 'observations': len(closes),
              'stale': (cutoff - dt.date.fromisoformat(prices[-1]['date'])).days > 5}
    for label, sessions in [('return1d', 1), ('return1m', 21), ('return3m', 63), ('return6m', 126)]:
        result[label] = (last / closes[-sessions-1] - 1) * 100 if len(closes) > sessions else None
    for size in [50, 200]:
        average = statistics.mean(closes[-size:]) if len(closes) >= size else None
        result[f'sma{size}'] = average
        result[f'above{size}'] = last > average if average is not None else None
    changes = [b / a - 1 for a, b in zip(closes[:-1], closes[1:])]
    result['volatility20d'] = statistics.stdev(changes[-20:]) * math.sqrt(252) * 100 if len(changes) >= 20 else None
    window = closes[-252:]
    result['drawdownFromHigh'] = (last / max(window) - 1) * 100
    result['highWindowSessions'] = len(window)
    previous_volumes = [r['volume'] for r in prices[-21:-1]]
    average_volume = statistics.mean(previous_volumes) if len(previous_volumes) == 20 and all(v is not None and v >= 0 for v in previous_volumes) else None
    latest_volume = prices[-1]['volume']
    result['relativeVolume'] = latest_volume / average_volume if latest_volume is not None and average_volume and average_volume > 0 else None
    return result


def debt_ratio(balance):
    """Total debt / shareholder equity from the same reported quarterly statement."""
    debt, equity = number(balance.get('debt')), number(balance.get('equity'))
    ratio = debt / equity if debt is not None and debt >= 0 and equity is not None and equity > 0 else None
    return {'debtEquity': ratio, 'debt': debt, 'equity': equity, 'balanceDate': balance.get('date'),
            'negativeEquity': equity is not None and equity <= 0}


def fundamental_metrics(info, balance, kind):
    if kind != 'stock':
        return {'assets': number(info.get('totalAssets'))}
    mapping = {'marketCap': 'marketCap', 'pe': 'trailingPE', 'forwardPE': 'forwardPE',
               'priceSales': 'priceToSalesTrailing12Months', 'evEbitda': 'enterpriseToEbitda',
               'revenueGrowth': 'revenueGrowth', 'earningsGrowth': 'earningsGrowth',
               'margin': 'profitMargins', 'roe': 'returnOnEquity', 'freeCashFlow': 'freeCashflow',
               'cash': 'totalCash'}
    result = {key: number(info.get(field)) for key, field in mapping.items()}
    for key in ['pe', 'forwardPE', 'priceSales', 'evEbitda']:
        if result[key] is not None and result[key] <= 0:
            result[key] = None
    result.update(debt_ratio(balance))
    return result


def compare_to_benchmark(history, benchmark, now):
    cutoff = str(complete_through(now))
    def valid(rows):
        return {r['date']: r['close'] for r in rows if r.get('date', 'z') <= cutoff
                and number(r.get('close')) is not None and r['close'] > 0}
    a, b = valid(history), valid(benchmark)
    common = sorted(set(a) & set(b))
    # Do not compare prices on different dates or silently call an old quote current.
    if len(common) < 64 or not a or not b or common[-1] != max(a) or common[-1] != max(b):
        return None
    end, start = common[-1], common[-64]
    return ((a[end] / a[start] - 1) - (b[end] / b[start] - 1)) * 100


def assess(row):
    """A disclosed research-priority heuristic, not a return forecast or probability."""
    p, f = row['prices'], row['fundamentals']
    reasons, risks, score = [], [], 0
    for key, weight, label in [('above50', 2, 'above its 50-session average'), ('above200', 2, 'above its 200-session average')]:
        if p.get(key) is True:
            score += weight; reasons.append(label)
        elif p.get(key) is False:
            risks.append(label.replace('above', 'below'))
    if p.get('return3m') is not None and p['return3m'] > 0:
        score += 1; reasons.append('positive three-month momentum')
    if row.get('relative3m') is not None and row['relative3m'] > 0:
        score += 1; reasons.append('outperformed SPY over matched three-month dates')
    if row['kind'] == 'stock':
        for key, label in [('revenueGrowth', 'positive reported revenue growth'), ('freeCashFlow', 'positive reported free cash flow'), ('margin', 'positive reported profit margin')]:
            if f.get(key) is not None and f[key] > 0:
                score += 1; reasons.append(label)
            elif f.get(key) is not None and f[key] < 0:
                risks.append(label.replace('positive', 'negative'))
        if row.get('peerPE') is not None and f.get('pe') is not None:
            if f['pe'] < row['peerPE']:
                score += 1; reasons.append('P/E below the median of covered profitable industry peers')
            else:
                risks.append('P/E at or above covered profitable industry peers')
        if row.get('sector') not in ('Financial Services', 'Real Estate'):
            if f.get('debtEquity') is not None and f['debtEquity'] > 2:
                score -= 1; risks.append('total debt exceeds twice reported shareholder equity')
        else:
            risks.append('leverage and valuation need sector-specific interpretation')
        if f.get('negativeEquity'):
            risks.append('non-positive shareholder equity; debt/equity is not meaningful')
        if f.get('pe') is None:
            risks.append('a meaningful positive trailing P/E is unavailable')
        if f.get('debtEquity') is None:
            risks.append('debt/equity is unavailable; do not assume low debt')
    if p.get('volatility20d') is not None and p['volatility20d'] > 50:
        risks.append('high recent annualized volatility')
    if p.get('stale'):
        risks.append('price history is stale or unavailable')
    if row.get('warnings'):
        risks.extend(row['warnings'])
    enough = p.get('observations', 0) >= 64 and not p.get('stale') and not row.get('priceWarning')
    if row['kind'] == 'stock':
        enough = enough and f.get('marketCap') is not None and not row.get('fundamentalWarning')
    row.update(score=max(0, score), reasons=reasons, risks=list(dict.fromkeys(risks)), eligible=bool(enough))


class Collector:
    def __init__(self, directory, now):
        import yfinance as yf
        self.yf, self.directory, self.now = yf, directory, now
        yf.set_tz_cache_location(str(ROOT / 'data' / 'yahoo-cache'))
        yf.config.debug.hide_exceptions = False

    def cached(self, key, fetch, ttl):
        path = self.directory / 'cache' / (key + '.json')
        try:
            saved = json.loads(path.read_text())
        except (FileNotFoundError, ValueError):
            saved = None
        if saved and time.time() - saved['epoch'] < ttl:
            return saved['value'], saved['fetchedAt'], ''
        try:
            value = fetch()
            result = {'value': value, 'fetchedAt': stamp(), 'epoch': time.time()}
            write_json(path, result)
            return value, result['fetchedAt'], ''
        except Exception as error:
            warning = 'Yahoo retrieval failed (' + type(error).__name__ + ').'
            if saved:
                return saved['value'], saved['fetchedAt'], 'Saved data: ' + warning
            return None, None, warning

    def one(self, symbol, kind, label):
        ticker = self.yf.Ticker(symbol)
        def history():
            frame = ticker.history(period='1y', interval='1d', auto_adjust=True, actions=False, timeout=15)
            result = [{'date': index.strftime('%Y-%m-%d'), 'close': number(item.get('Close')), 'volume': number(item.get('Volume'))} for index, item in frame.iterrows()]
            if not result:
                raise ValueError('No history')
            return result
        bars, checked, price_warning = self.cached(symbol + '-history', history, 900)
        def info():
            result = ticker.get_info()
            fields = ['longName', 'shortName', 'sector', 'industry', 'currency', 'financialCurrency', 'quoteType', 'marketCap',
                      'trailingPE', 'forwardPE', 'priceToSalesTrailing12Months', 'enterpriseToEbitda',
                      'revenueGrowth', 'earningsGrowth', 'profitMargins', 'returnOnEquity', 'freeCashflow', 'totalCash', 'totalAssets']
            if not result or not result.get('quoteType'):
                raise ValueError('No company details')
            return {k: result.get(k) if isinstance(result.get(k), str) else number(result.get(k)) for k in fields}
        details, detail_time, info_warning = self.cached(symbol + '-info', info, 21600)
        balance, balance_time, balance_warning = {}, None, ''
        if kind == 'stock':
            def statement():
                frame = ticker.quarterly_balance_sheet
                if frame is None or frame.empty:
                    raise ValueError('No balance sheet')
                date = max(frame.columns)
                column = frame[date]
                return {'date': date.strftime('%Y-%m-%d'), 'debt': number(column.get('Total Debt')), 'equity': number(column.get('Stockholders Equity'))}
            balance, balance_time, balance_warning = self.cached(symbol + '-balance', statement, 86400)
        details = details or {}
        row = {'symbol': symbol, 'kind': kind, 'group': label, 'name': details.get('longName') or details.get('shortName') or label or symbol,
               'sector': details.get('sector'), 'industry': details.get('industry'), 'currency': details.get('currency'),
               'financialCurrency': details.get('financialCurrency'), 'prices': price_metrics(bars or [], self.now),
               'fundamentals': fundamental_metrics(details, balance or {}, kind), 'history': bars or [],
               'retrievedAt': {'prices': checked, 'company': detail_time, 'balance': balance_time},
               'source': 'Yahoo Finance via yfinance', 'sourceUrl': 'https://finance.yahoo.com/quote/' + symbol + '/',
               'priceWarning': price_warning, 'fundamentalWarning': info_warning,
               'warnings': [w for w in [price_warning, info_warning, balance_warning] if w]}
        return row


def assemble(rows, universe, now):
    benchmark = next((row for row in rows if row['symbol'] == universe['benchmark']), None)
    for row in rows:
        row['relative3m'] = compare_to_benchmark(row['history'], benchmark['history'], now) if benchmark and not benchmark.get('priceWarning') else None
        peers = [other['fundamentals']['pe'] for other in rows if other['kind'] == 'stock' and other['symbol'] != row['symbol']
                 and row.get('industry') and other.get('industry') == row['industry']
                 and other['fundamentals'].get('pe') is not None and not other.get('fundamentalWarning')]
        row['peerPE'] = statistics.median(peers) if len(peers) >= 3 else None
        row['peerCount'] = len(peers)
        assess(row)
    ranked = sorted([r for r in rows if r['kind'] == 'stock' and r['eligible'] and r['score'] >= 5], key=lambda r: (-r['score'], -(r['prices'].get('return3m') or 0), r['symbol']))
    # A research list should not become an accidental single-industry list.
    picks, sectors = [], {}
    for row in ranked:
        sector = row.get('sector') or 'Unknown'
        if sectors.get(sector, 0) >= 2:
            continue
        picks.append(row['symbol']); sectors[sector] = sectors.get(sector, 0) + 1
        if len(picks) == 5:
            break
    for row in rows:
        row.pop('history', None)
    return {'version': 1, 'reportId': now.astimezone(LOCAL).strftime('%Y-%m-%d'), 'generatedAt': now.isoformat(),
            'timezone': str(LOCAL), 'universeDescription': universe['description'], 'benchmark': universe['benchmark'],
            'coverage': {'requested': len(rows), 'usablePrices': sum(not r['prices'].get('stale') for r in rows),
                         'warnings': sum(bool(r['warnings']) for r in rows)},
            'watchlist': picks, 'rows': rows,
            'methodology': [
                'Daily adjusted closing prices only. In-progress sessions are excluded. No streaming or overnight-price claim.',
                '1M/3M/6M mean 21/63/126 trading-session returns. Relative performance uses matched dates against SPY.',
                'Momentum: +2 above each of the 50- and 200-session averages, +1 positive 3M return, +1 positive 3M performance versus SPY.',
                'Stocks: +1 each for positive reported revenue growth, profit margin and free cash flow; +1 below the covered industry peer P/E median when at least 3 other profitable peers exist.',
                'Debt/equity = total debt / positive shareholder equity from the same latest quarterly statement; it is not total liabilities/equity. Non-financial/non-real-estate stocks lose 1 point above 2x.',
                'Up to 5 eligible stocks scoring at least 5, capped at 2 per sector. This heuristic is unbacktested and is not a forecast, probability, price target, or instruction to buy.',
                'The local model reviews up to 16 higher-scoring eligible stocks and the available ETF trends, then selects priorities and existing supporting evidence.',
                'ETF prices are group proxies, not exhaustive industry analysis. Corporate debt/equity and company P/E scoring are not applied to ETFs.',
                'Company metrics are provider-reported snapshots retrieved at the displayed time, not necessarily newly reported financial periods. Missing figures stay unavailable.',
                'On weekends and holidays the report uses the latest available completed session. Prices older than 5 calendar days are excluded from watch candidates.',
            ]}


def fmt(value, unit='', digits=2):
    if value is None:
        return 'Not available'
    if unit == 'money':
        for divisor, suffix in [(1e12, 'T'), (1e9, 'B'), (1e6, 'M')]:
            if abs(value) >= divisor:
                return f'{value/divisor:,.2f}{suffix}'
        return f'{value:,.2f}'
    return f'{value:,.{digits}f}{unit}'


def display_time(value):
    if not value:
        return 'Not available'
    try:
        moment = dt.datetime.fromisoformat(value)
        if moment.tzinfo is not None:
            return moment.astimezone(LOCAL).strftime('%b %d, %Y · %I:%M %p %Z')
    except (TypeError, ValueError):
        pass
    return value


def render(report):
    esc = lambda v: html.escape(str(v if v is not None else 'Not available'))
    rows = {r['symbol']: r for r in report['rows']}
    parts = [f'<h1>EquityDesk daily research</h1><p>{esc(report["reportId"])} · Indianapolis time</p>',
             f'<p>Generated {esc(display_time(report["generatedAt"]))}. Usable price histories: {report["coverage"]["usablePrices"]}/{report["coverage"]["requested"]}. Research ideas for your review; no trades are placed.</p>']
    local_ai = report.get('localAI', {})
    if local_ai.get('status') == 'complete':
        cloud = local_ai.get('runtime') == 'github-actions'
        parts.append('<h2>' + ('Cloud' if cloud else 'Local') + ' AI review</h2><p>' + esc(local_ai['model']) + ' reviewed the metrics ' + ('on a GitHub cloud runner' if cloud else 'on your Mac') + '. The watchlist below reflects its selected research priorities.</p>')
        for item in local_ai['selection']['stocks']:
            row = rows[item['symbol']]
            selected = '; '.join(row['reasons'][i] for i in item['evidence'])
            concerns = '; '.join(row['risks'][i] for i in item['risks'])
            parts.append('<p><b>' + esc(row['symbol']) + ':</b> ' + esc(selected) + ('. <b>Check:</b> ' + esc(concerns) if concerns else '') + '.</p>')
        for symbol in local_ai['selection']['market']:
            row = rows[symbol]
            parts.append('<p><b>Market focus: ' + esc(symbol) + ' · ' + esc(row['group']) + '</b> — 1M ' + fmt(row['prices'].get('return1m'), '%') + '; 3M ' + fmt(row['prices'].get('return3m'), '%') + '.</p>')
    else:
        parts.append('<p><b>Quantitative screen only:</b> ' + esc(local_ai.get('error', 'Local AI review has not run.')) + '</p>')
    parts.append('<h2>Stocks to investigate</h2>')
    if not report['watchlist']:
        parts.append('<p>No stocks met the data-quality and screening requirements today. No replacement figures or forced picks.</p>')
    for symbol in report['watchlist']:
        r, f, p = rows[symbol], rows[symbol]['fundamentals'], rows[symbol]['prices']
        parts.append(f'<h3><a href="{esc(r["sourceUrl"])}">{esc(symbol)} · {esc(r["name"])}</a></h3>'
                     f'<p>{esc(r["sector"])} / {esc(r["industry"])} · Research priority {r["score"]} points (not a rating or forecast).</p>'
                     '<p><b>Why it surfaced:</b> ' + esc('; '.join(r['reasons'])) + '.</p>'
                     '<p><b>Risks / gaps:</b> ' + esc('; '.join(r['risks']) or 'No heuristic flag; risks still require independent research.') + '</p>'
                     '<p><b>Review next:</b> Check the latest company earnings release, guidance and filing; compare valuation with more industry peers; monitor whether the price trend persists.</p>')
        metrics = [('Adjusted close', fmt(p.get('close')) + ' ' + (r.get('currency') or 'currency unavailable')),
                   ('Market cap', fmt(f.get('marketCap'), 'money') + ' ' + (r.get('currency') or 'currency unavailable')),
                   ('Trailing / forward P/E', fmt(f.get('pe'), 'x') + ' / ' + fmt(f.get('forwardPE'), 'x')),
                   ('Debt / equity', fmt(f.get('debtEquity'), 'x')), ('Balance sheet date', f.get('balanceDate')),
                   ('P/S / EV/EBITDA', fmt(f.get('priceSales'), 'x') + ' / ' + fmt(f.get('evEbitda'), 'x')),
                   ('Revenue growth / net margin', fmt(f['revenueGrowth'] * 100 if f.get('revenueGrowth') is not None else None, '%') + ' / ' + fmt(f['margin'] * 100 if f.get('margin') is not None else None, '%')),
                   ('Reported free cash flow', fmt(f.get('freeCashFlow'), 'money') + ' ' + (r.get('financialCurrency') or 'currency unavailable')),
                   ('1M / 3M return', fmt(p.get('return1m'), '%') + ' / ' + fmt(p.get('return3m'), '%')),
                   ('3M versus SPY', fmt(r.get('relative3m'), ' pp')), ('20-session annualized volatility', fmt(p.get('volatility20d'), '%')),
                   ('Price session / retrieved', (p.get('priceDate') or 'unavailable') + ' / ' + display_time(r['retrievedAt'].get('prices'))),
                   ('Fundamentals retrieved', display_time(r['retrievedAt'].get('company')))]
        parts.append('<table>' + ''.join(f'<tr><td>{esc(k)}</td><td>{esc(v)}</td></tr>' for k,v in metrics) + '</table>')
    for kind, title in [('market_etfs','Major ETFs'), ('sector_etfs','Sector trends'), ('industry_etfs','Industry trends')]:
        group = sorted([r for r in report['rows'] if r['kind'] == kind], key=lambda r: (r['prices'].get('return1m') is None, -(r['prices'].get('return1m') or 0)))
        parts.append(f'<h2>{title}</h2><table><tr><th>ETF / proxy</th><th>1M</th><th>3M</th><th>Versus SPY, 3M</th><th>Session / status</th></tr>')
        for r in group:
            p = r['prices']
            status = ' · Stale' if p.get('stale') else (' · Retrieval warning' if r['warnings'] else '')
            parts.append(f'<tr><td><a href="{esc(r["sourceUrl"])}">{esc(r["symbol"])} · {esc(r["group"])}</a></td><td>{fmt(p.get("return1m"), "%")}</td><td>{fmt(p.get("return3m"), "%")}</td><td>{fmt(r.get("relative3m"), " pp")}</td><td>{esc(p.get("priceDate"))}{status}</td></tr>')
        parts.append('</table>')
    parts.append('<h2>All covered companies</h2><table><tr><th>Company</th><th>Market cap</th><th>P/E</th><th>Debt/equity</th><th>3M</th><th>Status</th></tr>')
    for r in report['rows']:
        if r['kind'] != 'stock': continue
        f = r['fundamentals']
        parts.append(f'<tr><td><a href="{esc(r["sourceUrl"])}">{esc(r["symbol"])} · {esc(r["name"])}</a></td><td>{fmt(f.get("marketCap"), "money")} {esc(r.get("currency"))}</td><td>{fmt(f.get("pe"), "x")}</td><td>{fmt(f.get("debtEquity"), "x")}</td><td>{fmt(r["prices"].get("return3m"), "%")}</td><td>{esc("; ".join(r["warnings"]) or ("Screened" if r["eligible"] else "Insufficient data"))}</td></tr>')
    parts.append('</table><h2>Data update times</h2><p>Times are shown in Indianapolis time. A retrieval time is when Yahoo was checked; it is not the date a company published its financial statements.</p><table><tr><th>Symbol</th><th>Price session / retrieved</th><th>Company data retrieved</th><th>Balance sheet period / retrieved</th></tr>')
    for r in report['rows']:
        fetched = r['retrievedAt']
        parts.append('<tr><td>' + esc(r['symbol']) + '</td><td>' + esc(r['prices'].get('priceDate')) + '<br>' + esc(display_time(fetched.get('prices'))) + '</td><td>' + esc(display_time(fetched.get('company'))) + '</td><td>' + (esc(r['fundamentals'].get('balanceDate')) + '<br>' + esc(display_time(fetched.get('balance'))) if r['kind'] == 'stock' else 'Not applicable') + '</td></tr>')
    parts.append('</table><h2>How this report works</h2><p>' + esc(report['universeDescription']) + '</p><ul>' + ''.join('<li>' + esc(m) + '</li>' for m in report['methodology']) + '</ul>')
    parts.append('<p>Sources: linked Yahoo Finance pages and their reported financial statements. <a href="https://www.finra.org/investors/investing/investment-products/stocks/evaluating-stocks">FINRA: evaluating stocks and peer comparisons</a>.</p>')
    body = '\n'.join(parts)
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EquityDesk Daily Research</title><style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#1e2924;background:#f8faf9;margin:0;padding:24px}main{max-width:1050px;margin:auto;background:white;padding:32px;border:1px solid #dce5de;border-radius:16px}h1{font-size:32px}h2{margin-top:40px;color:#285f43}h3{margin-top:30px}a{color:#286044}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:9px;border-bottom:1px solid #e3e8e4;text-align:left}th{background:#f0f5f1}p,li{overflow-wrap:anywhere}@media(max-width:650px){body{padding:8px}main{padding:14px}table{font-size:11px}td,th{padding:5px}}</style></head><body><main>' + body + '</main></body></html>'


def save_report(report):
    write_json(DIRECTORY / 'latest.json', report)
    write_json(DIRECTORY / 'reports' / (report['reportId'] + '.json'), report)
    page = DIRECTORY / 'latest.html'
    temporary = page.with_suffix('.html.tmp')
    temporary.write_text(render(report)); os.chmod(temporary, 0o600); temporary.replace(page)


def run(symbols=None, local_ai=False):
    import logging
    logging.getLogger('yfinance').setLevel(logging.CRITICAL)
    now = dt.datetime.now(dt.timezone.utc)
    universe = json.loads((ROOT / 'resources/research-universe.json').read_text())
    items = [(symbol, kind, label) for kind in ['market_etfs', 'sector_etfs', 'industry_etfs'] for symbol,label in universe[kind].items()]
    items += [(symbol, 'stock', symbol) for symbol in universe['stocks']]
    if symbols:
        items = [item for item in items if item[0] in set(symbols) | {universe['benchmark']}]
    collector = Collector(DIRECTORY, now)
    collected = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {pool.submit(collector.one, *item): item[0] for item in items}
        for job in as_completed(jobs):
            row = job.result(); collected.append(row)
            print(f'Checked {row["symbol"]} ({len(collected)}/{len(items)})', flush=True)
    ordered = {row['symbol']:row for row in collected}
    report = assemble([ordered[item[0]] for item in items], universe, now)
    report['scope'] = 'subset' if symbols else 'full'
    if local_ai:
        try:
            from local_research_ai import review
            review(report)
        except Exception as error:
            report['localAI'] = {'status':'unavailable','error':str(error)}
    save_report(report)
    print(json.dumps({'reportId': report['reportId'], 'coverage': report['coverage'], 'watchlist': report['watchlist'], 'localAI': report.get('localAI', {}).get('status', 'not_requested'), 'html': str(DIRECTORY / 'latest.html')}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--local-ai', action='store_true')
    parser.add_argument('--symbols', help='Optional comma-separated subset for a smoke test')
    args = parser.parse_args()
    DIRECTORY.mkdir(parents=True, exist_ok=True); os.chmod(DIRECTORY, 0o700)
    with (DIRECTORY / '.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('A research run is already active.', file=sys.stderr); return 2
        if args.run:
            run(args.symbols.split(',') if args.symbols else None, args.local_ai)
    return 0


if __name__ == '__main__':
    sys.exit(main())
