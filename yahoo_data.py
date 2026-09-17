"""Yahoo Finance via yfinance, with bounded refresh, honest timestamps, and saved fallback."""
import datetime as dt
import json
import math
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

def numeric(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None

def iso(epoch):
    number = numeric(epoch)
    if number is None or number <= 0:
        return None
    try:
        return dt.datetime.fromtimestamp(number, dt.timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        return None

def json_safe(value):
    """yfinance converts trading-session epochs into pandas Timestamps."""
    if isinstance(value, dt.datetime):
        return value.timestamp()
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if value is None or isinstance(value, (str, bool, int)):
        return value
    return numeric(value)

def frame_rows(frame):
    if frame is None or frame.empty:
        return {}
    return {column.strftime('%Y-%m-%d'): {str(key).replace(' ', ''): numeric(value)
            for key, value in frame[column].items()} for column in frame.columns if hasattr(column, 'strftime')}

def financial_rows(income, balance, cashflow, currency):
    periods = sorted(set(income) | set(balance) | set(cashflow), reverse=True)
    output = []
    for period in periods[:5]:
        inc, bal, cf = income.get(period, {}), balance.get(period, {}), cashflow.get(period, {})
        ocf, capex, fcf = cf.get('OperatingCashFlow'), cf.get('CapitalExpenditure'), cf.get('FreeCashFlow')
        if fcf is None and ocf is not None and capex is not None:
            fcf = ocf - abs(capex)
        output.append({'period': period, 'currency': currency, 'revenue': inc.get('TotalRevenue'),
            'earnings': inc.get('NetIncome'), 'operatingCashFlow': ocf, 'capex': capex, 'freeCashFlow': fcf,
            'debt': bal.get('TotalDebt'), 'cash': bal.get('CashAndCashEquivalents')})
    return output

class YahooData:
    def __init__(self, data, database, error):
        self.database, self.Error = database, error
        self.locks, self.lock = {}, threading.Lock()
        self.cooldown_until = 0
        self.failures = {}
        self.yf = None
        try:
            import yfinance as yf
            yf.set_tz_cache_location(str(data / 'yahoo-cache'))
            self.yf = yf
        except ImportError:
            pass

    @staticmethod
    def provider_symbol(symbol):
        # Yahoo uses hyphens for class shares such as BRK-B.
        return symbol.replace('.', '-')

    def cached(self, key, ttl, fetch, refresh=False):
        with self.lock:
            lock = self.locks.setdefault(key, threading.Lock())
        with lock:
            with self.database() as db:
                saved = db.execute('SELECT * FROM cache WHERE key=?', ('yahoo|' + key,)).fetchone()
            age = time.time() - saved['fetched'] if saved else float('inf')
            # Even a manual refresh respects a short floor to prevent repeated-click flooding.
            if saved and age < (10 if refresh else ttl):
                return json.loads(saved['payload']), saved['fetchedAt'], ''
            failure = self.failures.get(key)
            try:
                if not self.yf:
                    raise self.Error('Yahoo Finance support is not installed. Reopen EquityDesk with its launcher.', 503)
                if time.time() < self.cooldown_until:
                    raise self.Error('Yahoo Finance is limiting requests. Automatic updates will retry after a short pause.', 429)
                if failure and time.time() < failure[0]:
                    raise self.Error(failure[1], 503)
                value = fetch()
                stamp = dt.datetime.now(dt.timezone.utc).isoformat()
                payload = json.dumps(value, allow_nan=False)
                with self.database() as db:
                    db.execute('INSERT OR REPLACE INTO cache VALUES (?,?,?,?)', ('yahoo|' + key, payload, time.time(), stamp))
                self.failures.pop(key, None)
                return value, stamp, ''
            except Exception as exc:
                logging.getLogger(__name__).warning('Yahoo request failed (%s): %s', key, type(exc).__name__)
                if isinstance(exc, self.Error):
                    message = str(exc)
                elif 'RateLimit' in type(exc).__name__ or '429' in str(exc):
                    self.cooldown_until = time.time() + 120
                    message = 'Yahoo Finance is limiting requests. Updates will retry after two minutes.'
                else:
                    message = 'Yahoo Finance could not supply this data. The company may have limited coverage, or the connection may be unavailable.'
                self.failures[key] = (time.time() + 60, message)
                if saved:
                    return json.loads(saved['payload']), saved['fetchedAt'], 'Saved data: ' + message
                raise self.Error(message, 503) from None

    def chart(self, symbol, full=False, refresh=False):
        def fetch():
            ticker = self.yf.Ticker(self.provider_symbol(symbol))
            frame = ticker.history(period='1y' if full else '5d', interval='1d', auto_adjust=False,
                                   actions=False, raise_errors=True, timeout=12)
            meta = ticker.get_history_metadata() or {}
            history = []
            for index, row in frame.iterrows():
                close = numeric(row.get('Close'))
                if close is not None and close > 0:
                    history.append({'date': index.strftime('%Y-%m-%d'), 'close': close})
            if not meta.get('symbol') or not history:
                raise self.Error('Yahoo Finance has no price history for ' + symbol + ' right now.', 404)
            # Keep only public, JSON-safe metadata used by the app.
            return {'history': history, 'meta': {k: json_safe(meta.get(k)) for k in ('symbol', 'longName', 'shortName',
                'currency', 'exchangeName', 'fullExchangeName', 'instrumentType', 'regularMarketPrice', 'regularMarketTime',
                'chartPreviousClose', 'previousClose', 'marketState', 'exchangeDataDelayedBy', 'currentTradingPeriod')}}
        return self.cached(('history|' if full else 'quote|') + symbol, 900 if full else 25, fetch, refresh)

    def quote(self, symbol, refresh=False):
        value, fetched, warning = self.chart(symbol, refresh=refresh)
        meta = value['meta']
        price, price_at = numeric(meta.get('regularMarketPrice')), iso(meta.get('regularMarketTime'))
        if price is None or price <= 0 or not price_at:
            price, price_at = None, None
        regular = (meta.get('currentTradingPeriod') or {}).get('regular') or {}
        start, end = numeric(regular.get('start')), numeric(regular.get('end'))
        session = meta.get('marketState') or ('REGULAR' if start and end and start <= time.time() <= end else 'CLOSED')
        return {'symbol': symbol, 'name': meta.get('longName') or meta.get('shortName') or symbol,
            'price': price, 'priceAt': price_at, 'checkedAt': fetched, 'currency': meta.get('currency') or '',
            'feed': 'yahoo', 'source': 'Yahoo Finance', 'sourceUrl': 'https://finance.yahoo.com/quote/' + self.provider_symbol(symbol) + '/',
            'changePercent': None, 'warning': warning or ('' if price else 'No timestamped Yahoo price is available.'),
            'marketState': session, 'delayMinutes': numeric(meta.get('exchangeDataDelayedBy'))}

    def snapshot(self, symbols):
        symbols = sorted(set(symbols))
        if len(symbols) > 200:
            raise self.Error('Request up to 200 companies at a time.')
        def one(symbol):
            try:
                return symbol, self.quote(symbol), ''
            except self.Error as exc:
                return symbol, None, str(exc)
        with ThreadPoolExecutor(max_workers=4) as pool:
            rows = list(pool.map(one, symbols))
        errors = {symbol: error for symbol, _, error in rows if error}
        return {'quotes': {symbol: quote for symbol, quote, _ in rows if quote}, 'errors': errors,
                'error': '' if not errors else '; '.join(dict.fromkeys(errors.values())), 'feed': 'yahoo', 'interval': 30}

    def search(self, query):
        import re
        def fetch():
            rows = self.yf.Search(query, max_results=20, news_count=0).quotes
            return [{'symbol':r['symbol'], 'name':r.get('longname') or r.get('shortname') or r['symbol'],
                     'exchange':r.get('exchDisp') or r.get('exchange') or 'Yahoo Finance'}
                    for r in rows if r.get('quoteType') in ('EQUITY','ETF') and re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}',r.get('symbol',''))]
        result, _, _ = self.cached('search|' + query.lower(), 86400, fetch)
        return result

    def fundamentals(self, symbol, refresh=False):
        def info():
            result = self.yf.Ticker(self.provider_symbol(symbol)).get_info() or {}
            keys = ('longName', 'shortName', 'sector', 'longBusinessSummary', 'marketCap', 'trailingPE',
                    'priceToSalesTrailing12Months', 'currency', 'financialCurrency')
            return {key: result.get(key) for key in keys}
        details, fetched, warning = self.cached('info|' + symbol, 21600, info, refresh)
        reports, stamps, warnings = {}, {'YAHOO_COMPANY_DETAILS': fetched}, [warning] if warning else []
        for kind, attribute in (('income', 'income_stmt'), ('balance', 'balance_sheet'), ('cashflow', 'cashflow')):
            try:
                reports[kind], stamps['YAHOO_' + kind.upper()], warn = self.cached('annual-' + kind + '|' + symbol, 21600,
                    lambda attribute=attribute: frame_rows(getattr(self.yf.Ticker(self.provider_symbol(symbol)), attribute)), refresh)
                if warn:
                    warnings.append(warn)
            except self.Error as exc:
                reports[kind] = {}
                warnings.append(str(exc))
        return details, financial_rows(reports['income'], reports['balance'], reports['cashflow'], details.get('financialCurrency') or ''), stamps, warnings

    def stock(self, symbol, metadata, refresh=False):
        value, fetched, warning = self.chart(symbol, full=True, refresh=refresh)
        meta = value['meta']
        return {'symbol': symbol, 'name': meta.get('longName') or meta.get('shortName') or metadata['name'],
            'exchange': meta.get('fullExchangeName') or meta.get('exchangeName') or metadata['exchange'],
            'currency': meta.get('currency') or '', 'sector': 'Not available', 'description': 'Company details are loading from Yahoo Finance.',
            'price': numeric(meta.get('regularMarketPrice')), 'priceDate': iso(meta.get('regularMarketTime')),
            'marketCap': None, 'pe': None, 'ps': None, 'financials': [], 'history': value['history'],
            'mode': 'live', 'source': 'Yahoo Finance', 'sourceUrl': 'https://finance.yahoo.com/quote/' + self.provider_symbol(symbol) + '/',
            'fetchedAt': fetched, 'updated': {'YAHOO_DAILY_PRICES': fetched}, 'historyFeed': 'Yahoo Finance',
            'warnings': [warning] if warning else []}
