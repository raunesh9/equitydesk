"""Public listing directory and read-only Alpaca market data. No trading API."""
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import unicodedata

DIRECTORY_URL = 'https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs'
ALPACA_URL = 'https://docs.alpaca.markets/us/docs/about-market-data-api'
SYMBOL = re.compile(r'^[A-Z][A-Z0-9.\-]{0,14}$')
ALIASES = json.loads((Path(__file__).parent / 'app/lib/company-aliases.json').read_text())

def normalize_company_query(value):
    value = ''.join(c for c in unicodedata.normalize('NFKD', value) if not unicodedata.combining(c)).lower()
    return ' '.join(re.sub(r'\band\b', ' ', re.sub(r'[^a-z0-9]+', ' ', value)).split())

def company_search(rows, query):
    q = normalize_company_query(query)
    if not q:
        return []
    tokens, ranked = q.split(), []
    for row in rows:
        terms = [normalize_company_query(name) for name in [row['name']] + ALIASES.get(row['symbol'], [])]
        ticker = row['symbol'].lower()
        raw_query = query.strip().lower()
        score = (0 if ticker == raw_query else
                 1 if any(name.startswith(q) for name in terms) else
                 2 if any(all(token in name for token in tokens) for name in terms) else
                 3 if ticker.startswith(raw_query) else 99)
        if score < 99:
            derivative = any(word in terms[0] for word in ('warrant', 'preferred', ' units'))
            ranked.append((score, derivative, row['name'], row['symbol'], row))
    ranked.sort(key=lambda match: match[:4])
    return [match[-1] for match in ranked[:30]]

def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def positive(value):
    if isinstance(value, bool):
        return None
    try:
        n = float(value)
        return n if math.isfinite(n) and n > 0 else None
    except (ValueError, TypeError):
        return None

def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        normalized = re.sub(r'(\.\d{6})\d+(?=[+-])', r'\1', value.replace('Z', '+00:00'))
        parsed = dt.datetime.fromisoformat(normalized)
        return value if parsed.tzinfo else None
    except ValueError:
        return None

def parse_directory(nasdaq, other):
    rows = {}
    exchanges = {'A': 'NYSE American', 'N': 'NYSE', 'P': 'NYSE Arca', 'Z': 'Cboe', 'V': 'IEX'}
    for text, nasdaq_file in ((nasdaq, True), (other, False)):
        for row in csv.DictReader(io.StringIO(text), delimiter='|'):
            symbol = row.get('Symbol' if nasdaq_file else 'ACT Symbol', '')
            if not SYMBOL.fullmatch(symbol) or row.get('Test Issue') != 'N':
                continue
            rows[symbol] = {'symbol': symbol, 'name': row['Security Name'],
                'exchange': 'NASDAQ' if nasdaq_file else exchanges.get(row.get('Exchange'), 'Other U.S. exchange'),
                'currency': 'USD', 'kind': 'ETF' if row.get('ETF') == 'Y' else 'Listed security'}
    return sorted(rows.values(), key=lambda r: r['symbol'])

class MarketData:
    def __init__(self, data, database, error):
        self.data, self.database, self.Error = data, database, error
        self.lock = threading.Lock()
        self.directory_lock = threading.Lock()
        self.quotes = {}
        self.failed_until = 0
        self.last_error = ''
        self.directory = {'results': [], 'fetchedAt': '', 'source': DIRECTORY_URL}
        for path in (Path(__file__).parent / 'resources/listings.json', data / 'listings.json'):
            if path.exists():
                try:
                    self.directory = json.loads(path.read_text())
                except (OSError, ValueError):
                    pass
        self.directory_attempt = 0

    def config(self):
        path = self.data / 'alpaca.json'
        return json.loads(path.read_text()) if path.exists() else None

    def settings(self):
        with self.database() as db:
            row = db.execute("SELECT value FROM settings WHERE key='refresh'").fetchone()
        return json.loads(row[0]) if row else {'enabled': True, 'interval': 30}

    def directory_info(self):
        return {'count': len(self.directory['results']), 'fetchedAt': self.directory['fetchedAt'],
                'source': DIRECTORY_URL, 'warning': self.directory.get('warning', '')}

    def refresh_directory(self):
        if not self.directory_lock.acquire(blocking=False):
            return
        try:
            self.directory_attempt = time.time()
            texts = []
            for filename in ('nasdaqlisted.txt', 'otherlisted.txt'):
                req = urllib.request.Request('https://www.nasdaqtrader.com/dynamic/SymDir/' + filename,
                                             headers={'User-Agent': 'EquityDesk/2.0'})
                with urllib.request.urlopen(req, timeout=15) as response:
                    texts.append(response.read(5_000_000).decode())
            rows = parse_directory(*texts)
            if len(rows) < 1000:
                raise ValueError('Incomplete directory')
            result = {'results': rows, 'fetchedAt': stamp(), 'source': DIRECTORY_URL}
            temp = self.data / 'listings.tmp'
            temp.write_text(json.dumps(result))
            temp.replace(self.data / 'listings.json')
            self.directory = result
        except (OSError, ValueError):
            self.directory = {**self.directory, 'warning': 'Directory refresh failed; using the saved listing directory.'}
        finally:
            self.directory_lock.release()

    def search(self, query):
        # Searches use the local directory; refresh it at most once daily, in the background.
        date = timestamp(self.directory.get('fetchedAt'))
        age = time.time() - dt.datetime.fromisoformat(date.replace('Z', '+00:00')).timestamp() if date else float('inf')
        if age > 86400 and time.time() - self.directory_attempt > 3600:
            self.directory_attempt = time.time()
            threading.Thread(target=self.refresh_directory, daemon=True).start()
        result = company_search(self.directory['results'], query)
        if not result and query.isupper() and SYMBOL.fullmatch(query):
            result.append({'symbol': query.upper(), 'name': 'Look up ticker · listing not verified', 'currency': 'USD', 'exchange': 'Unverified'})
        return result

    def metadata(self, symbol):
        return next((r for r in self.directory['results'] if r['symbol'] == symbol),
                    {'symbol': symbol, 'name': symbol, 'currency': 'USD', 'exchange': 'Not verified'})

    def fetch(self, path, params, config=None):
        config = config or self.config()
        if not config:
            raise self.Error('Connect Alpaca in Data connection to receive frequent prices.', 400)
        req = urllib.request.Request('https://data.alpaca.markets/v2/stocks/' + path + '?' + urllib.parse.urlencode(params),
            headers={'APCA-API-KEY-ID': config['key'], 'APCA-API-SECRET-KEY': config['secret'], 'User-Agent': 'EquityDesk/2.0'})
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                result = json.loads(response.read(12_000_000))
            if not isinstance(result, dict):
                raise ValueError('Invalid response')
            return result
        except urllib.error.HTTPError as exc:
            messages = {401: 'Alpaca did not accept these credentials.', 403: 'This Alpaca account does not have access to the selected feed.',
                        429: 'Alpaca rate limit reached. Updates will retry after a short pause.', 400: 'Alpaca could not process these tickers or feed settings.'}
            raise self.Error(messages.get(exc.code, 'Alpaca could not supply market data. Try again later.'), 502) from None
        except (OSError, ValueError):
            raise self.Error('Could not reach Alpaca. Last available prices retain their original timestamps.', 502) from None

    def connect(self, body):
        config = {k: body.get(k) for k in ('key', 'secret', 'feed')}
        if config['feed'] not in ('iex', 'sip') or any(not isinstance(config[k], str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,200}', config[k]) for k in ('key', 'secret')):
            raise self.Error('Enter your Alpaca API key, secret, and an available feed.')
        self.fetch('snapshots', {'symbols': 'IBM', 'feed': config['feed']}, config)
        with self.lock:
            target = self.data / 'alpaca.json'
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump(config, stream)
            os.chmod(target, 0o600)
            self.quotes = {}
            self.failed_until = 0
        return True

    def snapshot(self, symbols):
        config = self.config()
        if not config:
            raise self.Error('Connect Alpaca in Data connection to receive frequent prices.')
        symbols = sorted(set(symbols))
        if len(symbols) > 200 or any(not SYMBOL.fullmatch(s) for s in symbols):
            raise self.Error('Request up to 200 valid tickers at a time.')
        with self.lock:
            # Share the same 25-second cache across all local windows and tickers.
            due = [s for s in symbols if s not in self.quotes or time.time() - self.quotes[s]['checked'] >= 25]
            failure = self.last_error if time.time() < self.failed_until else ''
            if due and not failure:
                try:
                    raw = self.fetch('snapshots', {'symbols': ','.join(due), 'feed': config['feed']}, config)
                    checked = stamp()
                    for symbol in due:
                        item = raw.get(symbol) or {}
                        trade = item.get('latestTrade') or {}
                        price, traded_at = positive(trade.get('p')), timestamp(trade.get('t'))
                        if not price or not traded_at:
                            price, traded_at = None, None
                        previous = positive((item.get('prevDailyBar') or {}).get('c'))
                        self.quotes[symbol] = {'symbol': symbol, 'price': price, 'priceAt': traded_at, 'currency': 'USD',
                            'checkedAt': checked, 'checked': time.time(), 'feed': config['feed'], 'source': 'Alpaca', 'sourceUrl': ALPACA_URL,
                            'changePercent': (price / previous - 1) * 100 if price and previous else None,
                            'warning': '' if price else 'No latest trade available on this feed. Coverage can be limited for smaller stocks.'}
                    self.last_error = ''
                except self.Error as exc:
                    failure = self.last_error = str(exc)
                    self.failed_until = time.time() + 60
            quotes = {}
            for s in symbols:
                value = self.quotes.get(s)
                if value:
                    quotes[s] = {k: v for k, v in value.items() if k != 'checked'}
                    if failure:
                        quotes[s]['warning'] = failure
            return {'quotes': quotes, 'error': failure, 'feed': config['feed'], 'interval': self.settings()['interval']}

    def bars(self, symbol, refresh=False):
        config = self.config()
        if not config:
            return None
        identity = hashlib.sha256((config['key'] + config['secret'] + config['feed']).encode()).hexdigest()[:16]
        cache_key = 'alpaca-bars|' + identity + '|' + symbol
        with self.database() as db:
            cached = db.execute('SELECT * FROM cache WHERE key=?', (cache_key,)).fetchone()
        if cached and not refresh and time.time() - cached['fetched'] < 3600:
            return json.loads(cached['payload']), cached['fetchedAt'], ''
        try:
            start = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=370)).date().isoformat()
            raw = self.fetch('bars', {'symbols': symbol, 'timeframe': '1Day', 'start': start,
                'limit': 1000, 'adjustment': 'raw', 'feed': config['feed'], 'sort': 'asc'})
            rows = raw.get('bars', {}).get(symbol) or []
            history = [{'date': r['t'][:10], 'close': positive(r.get('c'))} for r in rows if timestamp(r.get('t')) and positive(r.get('c'))]
            history.sort(key=lambda r: r['date'])
            fetched = stamp()
            with self.database() as db:
                db.execute('INSERT OR REPLACE INTO cache VALUES (?,?,?,?)', (cache_key, json.dumps(history), time.time(), fetched))
            return history, fetched, '' if history else 'No historical bars available on this feed.'
        except self.Error as exc:
            if cached:
                return json.loads(cached['payload']), cached['fetchedAt'], str(exc)
            return [], '', str(exc)
