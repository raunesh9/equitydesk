#!/usr/bin/env python3
"""EquityDesk: local-only API, SQLite persistence, and static web server."""
import argparse
import datetime as dt
import functools
import hashlib
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from market import MarketData, DIRECTORY_URL, ALPACA_URL
from yahoo_data import YahooData
from paper import PaperTrading

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("EQUITYDESK_DATA_DIR", ROOT / "data"))
DB = DATA / "equitydesk.sqlite3"
API_URL = "https://www.alphavantage.co/query"
DOC_URL = "https://www.alphavantage.co/documentation/"
PROVIDER_LOCK = threading.Lock()
LAST_REQUEST = 0.0
STOCK_LOCK = threading.Lock()
SYMBOL = re.compile(r"^[A-Z][A-Z0-9.\-]{0,14}$")
market = None
yahoo = None
paper = None


class AppError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def database():
    conn = sqlite3.connect(DB, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def initialize():
    global market, yahoo, paper
    DATA.mkdir(parents=True, exist_ok=True)
    os.chmod(DATA, 0o700)
    with database() as db:
        db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("INSERT OR IGNORE INTO settings VALUES ('mode','sample')")
        # One-time move out of the limited demo; old sample holdings remain untouched.
        if not db.execute("SELECT 1 FROM settings WHERE key='yahoo_migration'").fetchone():
            db.execute("UPDATE settings SET value='live' WHERE key='mode'")
            db.execute("INSERT INTO settings VALUES ('yahoo_migration','1')")
            db.execute("INSERT OR REPLACE INTO settings VALUES ('refresh',?)", (json.dumps({'enabled':True,'interval':30}),))
        db.execute("""CREATE TABLE IF NOT EXISTS watchlist (
            mode TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL,
            PRIMARY KEY (mode, symbol))""")
        db.execute("""CREATE TABLE IF NOT EXISTS holdings (
            id INTEGER PRIMARY KEY, mode TEXT NOT NULL, symbol TEXT NOT NULL,
            name TEXT NOT NULL, shares REAL NOT NULL CHECK(shares>0),
            cost REAL NOT NULL CHECK(cost>=0), currency TEXT NOT NULL DEFAULT 'USD')""")
        db.execute("CREATE INDEX IF NOT EXISTS idx_holdings_mode ON holdings(mode)")
        db.execute("""CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched REAL NOT NULL,
            fetchedAt TEXT NOT NULL)""")
        db.execute("PRAGMA optimize")
    os.chmod(DB, 0o600)
    market = MarketData(DATA, database, AppError)
    yahoo = YahooData(DATA, database, AppError)
    paper = PaperTrading(database, yahoo.quote, valid_symbol, AppError)
    paper.initialize()


def mode():
    with database() as db:
        return db.execute("SELECT value FROM settings WHERE key='mode'").fetchone()[0]


def api_key():
    if os.environ.get("ALPHA_VANTAGE_API_KEY"):
        return os.environ["ALPHA_VANTAGE_API_KEY"]
    path = DATA / "provider-key.txt"
    return path.read_text().strip() if path.exists() else "demo"


def state():
    selected = mode()
    with database() as db:
        watches = [dict(r) for r in db.execute("SELECT symbol,name,notes,updatedAt FROM watchlist WHERE mode=? ORDER BY symbol", (selected,))]
        holdings = [dict(r) for r in db.execute("SELECT id,symbol,name,shares,cost,currency FROM holdings WHERE mode=? ORDER BY symbol,id", (selected,))]
        manager_row = db.execute("SELECT value FROM settings WHERE key=?", ('manager:' + selected,)).fetchone()
    manager = json.loads(manager_row[0]) if manager_row else {"cash": 0, "targets": {}, "concentrationLimit": 25, "driftLimit": 5}
    quotes_config = market.config()
    return {"mode": selected, "watchlist": watches, "holdings": holdings,
            "configured": api_key() != "demo", "provider": "Yahoo Finance", "manager": manager,
            "quotesConfigured": bool(yahoo.yf), "quoteFeed": 'yahoo', "paper": paper.state(),
            "refresh": market.settings(), "directory": market.directory_info()}


def number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None


def text_value(value, fallback="Not available"):
    return value.strip() if isinstance(value, str) and value.strip() not in ("", "None", "null", "-") else fallback


def valid_symbol(value):
    if not isinstance(value, str) or not SYMBOL.fullmatch(value.upper().strip()):
        raise AppError("Enter a valid stock ticker, such as AAPL.")
    return value.upper().strip()


def valid_mode(value):
    if value not in ("sample", "live"):
        raise AppError("Choose sample or provider data.")
    return value


def require_text(value, limit, label):
    if not isinstance(value, str) or len(value) > limit:
        raise AppError(label + " is too long or invalid.")
    return value


def valid_amount(value, positive=False):
    n = number(value)
    if n is None or n < 0 or (positive and n <= 0) or n > 1e12:
        raise AppError("Enter valid shares greater than zero and a nonnegative cost.")
    return n


def provider(function, symbol=None, keywords=None, refresh=False, key_override=None):
    """Cache successful raw responses, throttle calls, and label stale fallbacks."""
    global LAST_REQUEST
    key = key_override or api_key()
    identity = hashlib.sha256(key.encode()).hexdigest()[:16]
    cache_key = "|".join((identity, function, symbol or "", keywords or ""))
    with database() as db:
        cached = db.execute("SELECT * FROM cache WHERE key=?", (cache_key,)).fetchone()
    if cached and not refresh and time.time() - cached["fetched"] < 21600:
        return json.loads(cached["payload"]), cached["fetchedAt"], None
    params = {"function": function}
    if symbol:
        params["symbol"] = symbol
    if keywords:
        params["keywords"] = keywords
    # Demo access accepts the documented URL shape; compact is the daily default.
    params["apikey"] = key
    failure = None
    try:
        with PROVIDER_LOCK:
            wait = 0.7 - (time.monotonic() - LAST_REQUEST)
            if wait > 0:
                time.sleep(wait)
            LAST_REQUEST = time.monotonic()
            req = urllib.request.Request(API_URL + "?" + urllib.parse.urlencode(params),
                                         headers={"User-Agent": "EquityDesk/1.0"})
            with urllib.request.urlopen(req, timeout=18) as response:
                raw = response.read(12_000_000)
                result = json.loads(raw)
        if not isinstance(result, dict) or not result:
            raise AppError("The provider returned no data for this request.", 502)
        if result.get("Note") or result.get("Information"):
            raise AppError("The provider limited this request. Check your key or plan, or try again later.", 429)
        if result.get("Error Message"):
            raise AppError("The provider could not find data for that symbol.", 404)
        stamp = now()
        with database() as db:
            db.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?,?)",
                       (cache_key, json.dumps(result, allow_nan=False), time.time(), stamp))
        return result, stamp, None
    except AppError as exc:
        failure = exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        failure = AppError("Could not reach Alpha Vantage. Check your connection and try again.", 502)
    if cached:
        return json.loads(cached["payload"]), cached["fetchedAt"], "Showing saved provider data because refresh failed. " + str(failure)
    raise failure


def normalize_stock(symbol, payloads, stamps, warnings):
    overview = payloads.get("OVERVIEW", {})
    daily = payloads.get("TIME_SERIES_DAILY", {})
    price_rows = daily.get("Time Series (Daily)", {})
    history = []
    for date, values in price_rows.items():
        close = number(values.get("4. close"))
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) and close is not None and close > 0:
            history.append({"date": date, "close": close})
    history.sort(key=lambda row: row["date"])
    income = {r.get("fiscalDateEnding"): r for r in payloads.get("INCOME_STATEMENT", {}).get("annualReports", [])}
    cashflow = {r.get("fiscalDateEnding"): r for r in payloads.get("CASH_FLOW", {}).get("annualReports", [])}
    balance = {r.get("fiscalDateEnding"): r for r in payloads.get("BALANCE_SHEET", {}).get("annualReports", [])}
    periods = sorted(set(income) | set(cashflow) | set(balance), reverse=True)
    financials = []
    for period in periods[:5]:
        if not period:
            continue
        inc, cf, bal = income.get(period, {}), cashflow.get(period, {}), balance.get(period, {})
        currency = text_value(inc.get("reportedCurrency") or cf.get("reportedCurrency") or bal.get("reportedCurrency"), "")
        # Values in different reporting currencies are not combined.
        currency_ok = lambda report: report.get("reportedCurrency") == currency
        revenue = number(inc.get("totalRevenue")) if currency_ok(inc) else None
        earnings = number(inc.get("netIncome")) if currency_ok(inc) else None
        ocf = number(cf.get("operatingCashflow")) if currency_ok(cf) else None
        capex = number(cf.get("capitalExpenditures")) if currency_ok(cf) else None
        debt = number(bal.get("shortLongTermDebtTotal")) if currency_ok(bal) else None
        # Do not infer total debt from potentially overlapping long/short-term fields.
        financials.append({"period": period, "currency": currency,
            "revenue": revenue, "earnings": earnings, "operatingCashFlow": ocf,
            "capex": capex, "freeCashFlow": ocf - abs(capex) if ocf is not None and capex is not None else None,
            "debt": debt, "cash": number(bal.get("cashAndCashEquivalentsAtCarryingValue")) if currency_ok(bal) else None})
    currency = text_value(overview.get("Currency"), "")
    return {"symbol": symbol, "name": text_value(overview.get("Name"), symbol),
        "exchange": text_value(overview.get("Exchange")), "currency": currency,
        "sector": text_value(overview.get("Sector")), "description": text_value(overview.get("Description"), "Company description is not available."),
        "price": history[-1]["close"] if history else None,
        "priceDate": history[-1]["date"] if history else None,
        "marketCap": number(overview.get("MarketCapitalization")),
        "pe": number(overview.get("PERatio")), "ps": number(overview.get("PriceToSalesRatioTTM")),
        "financials": financials, "history": history, "mode": "live",
        "source": "Alpha Vantage", "sourceUrl": DOC_URL,
        "fetchedAt": min(stamps.values()) if stamps else "", "updated": stamps, "warnings": warnings}


def legacy_stock_data(symbol, refresh=False):
    symbol = valid_symbol(symbol)
    payloads, stamps, warnings = {}, {}, []
    if api_key() != 'demo' or symbol == 'IBM':
        with STOCK_LOCK:
            for function in ("OVERVIEW", "TIME_SERIES_DAILY", "INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"):
                if function == 'TIME_SERIES_DAILY' and market.config():
                    continue
                try:
                    payloads[function], stamps[function], warning = provider(function, symbol=symbol, refresh=refresh)
                    if warning:
                        warnings.append(function.replace("_", " ").title() + ": " + warning)
                except AppError as exc:
                    warnings.append(function.replace("_", " ").title() + ": " + str(exc))
    else:
        warnings.append('Connect Alpha Vantage for company financial reports. Missing figures remain unavailable.')
    result = normalize_stock(symbol, payloads, stamps, warnings)
    meta = market.metadata(symbol)
    if not payloads.get('OVERVIEW'):
        result.update({k: meta[k] for k in ('name', 'currency', 'exchange')})
    if market.config():
        history, fetched, warning = market.bars(symbol, refresh)
        result['history'] = history
        result['price'] = history[-1]['close'] if history else None
        result['priceDate'] = history[-1]['date'] if history else None
        result['currency'] = 'USD'
        result['updated']['ALPACA_DAILY_BARS'] = fetched
        result['source'] = 'Alpaca' + (' + Alpha Vantage' if payloads else '')
        result['sourceUrl'] = ALPACA_URL
        result['historyFeed'] = market.config()['feed']
        if warning:
            warnings.append(warning)
    elif not result['history']:
        warnings.append('Connect Alpaca for price charts and automatic quote updates across U.S. listings.')
    if not payloads and not market.config():
        result['source'], result['sourceUrl'], result['fetchedAt'] = 'Nasdaq Trader listing directory', DIRECTORY_URL, market.directory_info()['fetchedAt']
    return result


def stock_data(symbol, refresh=False):
    symbol = valid_symbol(symbol)
    return yahoo.stock(symbol, market.metadata(symbol), refresh)


def fundamentals_data(symbol):
    symbol = valid_symbol(symbol)
    details, financials, stamps, warnings = yahoo.fundamentals(symbol)
    return {'sector': details.get('sector') or 'Not available', 'description': details.get('longBusinessSummary') or 'Company description is not available.',
            'marketCap': number(details.get('marketCap')), 'pe': number(details.get('trailingPE')),
            'ps': number(details.get('priceToSalesTrailing12Months')), 'financials': financials, 'updated': stamps, 'warnings':warnings}


def search_stocks(query):
    query = require_text(query, 80, "Search").strip()
    if len(query) < 1:
        return []
    results = market.search(query)
    if results and any(r.get('exchange') != 'Unverified' for r in results):
        return results
    try:
        remote = yahoo.search(query)
        return remote or results
    except AppError:
        return results


def mutate(path, body):
    if not isinstance(body, dict):
        raise AppError("Expected a form object.")
    current = mode()
    # Guard against a stale tab writing into the other data workspace.
    if path in ("/api/watchlist", "/api/holdings", "/api/remove", "/api/manager", "/api/sample-portfolio") and body.get("mode") != current:
        raise AppError("The data workspace changed. Reload the page before saving.", 409)
    if path == "/api/mode":
        selected = valid_mode(body.get("mode"))
        with database() as db:
            db.execute("UPDATE settings SET value=? WHERE key='mode'", (selected,))
    elif path == '/api/paper/trade':
        paper.fill(body)
    elif path == '/api/paper/reset':
        paper.reset(body)
    elif path == "/api/key":
        key = require_text(body.get("key"), 200, "API key").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,200}", key):
            raise AppError("Enter the API key from your Alpha Vantage account.")
        raw, _, warning = provider("OVERVIEW", symbol="IBM", key_override=key, refresh=True)
        if warning or not raw.get("Symbol"):
            raise AppError("Could not verify that key. Please check it and try again.")
        target = DATA / "provider-key.txt"
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(key)
        os.chmod(target, 0o600)
    elif path == '/api/sample-portfolio':
        if current != 'sample':
            raise AppError('Practice holdings can only be added in the sample workspace.')
        with database() as db:
            if db.execute("SELECT count(*) FROM holdings WHERE mode='sample'").fetchone()[0]:
                raise AppError('The sample portfolio already contains holdings. Your entries were kept.')
            db.executemany("INSERT INTO holdings (mode,symbol,name,shares,cost,currency) VALUES ('sample',?,?,?,?,'USD')", [
                ('AAPL', 'Apple Inc.', 3, 180), ('RIVN', 'Rivian Automotive, Inc.', 30, 14), ('HDRN', 'Hadron Energy, Inc.', 40, 10)])
            db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', ('manager:sample', json.dumps({'cash': 500, 'targets': {'AAPL': 35, 'RIVN': 35, 'HDRN': 20}, 'concentrationLimit': 25, 'driftLimit': 5})))
    elif path == '/api/alpaca':
        market.connect(body)
    elif path == '/api/refresh-settings':
        if not isinstance(body.get('enabled'), bool) or body.get('interval') not in (30, 60, 120):
            raise AppError('Choose an update interval of 30, 60, or 120 seconds.')
        with database() as db:
            db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', ('refresh', json.dumps({'enabled': body['enabled'], 'interval': body['interval']})))
    elif path == '/api/manager':
        cash = valid_amount(body.get('cash'))
        concentration, drift = number(body.get('concentrationLimit')), number(body.get('driftLimit'))
        if concentration is None or not 1 <= concentration <= 100 or drift is None or not 0.1 <= drift <= 100:
            raise AppError('Use a concentration limit of 1–100% and a drift threshold of 0.1–100 percentage points.')
        raw = body.get('targets')
        if not isinstance(raw, dict) or len(raw) > 200:
            raise AppError('Enter valid target percentages.')
        targets = {}
        for key, value in raw.items():
            n = number(value)
            if n is None or not 0 <= n <= 100:
                raise AppError('Targets must be numbers from 0 to 100%.')
            targets[valid_symbol(key)] = n
        if sum(targets.values()) > 100.0000001:
            raise AppError('Stock targets cannot add up to more than 100%. The remainder is your cash target.')
        config = {'cash': cash, 'targets': targets, 'concentrationLimit': concentration, 'driftLimit': drift}
        with database() as db:
            db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', ('manager:' + current, json.dumps(config)))
    elif path == "/api/watchlist":
        symbol = valid_symbol(body.get("symbol"))
        name = require_text(body.get("name", symbol), 200, "Company name").strip() or symbol
        notes = require_text(body.get("notes", ""), 10000, "Notes")
        with database() as db:
            if body.get("notesOnly"):
                result = db.execute("UPDATE watchlist SET notes=?,updatedAt=? WHERE mode=? AND symbol=?",
                                    (notes, now(), current, symbol))
                if not result.rowcount:
                    raise AppError("That company is no longer on your watchlist.", 404)
            else:
                db.execute("INSERT OR IGNORE INTO watchlist VALUES (?,?,?,?,?)", (current, symbol, name, notes, now()))
    elif path == "/api/holdings":
        symbol = valid_symbol(body.get("symbol"))
        name = require_text(body.get("name", symbol), 200, "Company name").strip() or symbol
        if name == symbol:
            name = market.metadata(symbol)['name'][:200]
        shares, cost = valid_amount(body.get("shares"), True), valid_amount(body.get("cost"))
        if body.get("currency", "USD") != "USD":
            raise AppError("This first version tracks holdings in USD.")
        with database() as db:
            if body.get("id") is not None:
                if not isinstance(body["id"], int) or isinstance(body["id"], bool):
                    raise AppError("Invalid holding.")
                res = db.execute("UPDATE holdings SET symbol=?,name=?,shares=?,cost=? WHERE id=? AND mode=?",
                                 (symbol, name, shares, cost, body["id"], current))
                if not res.rowcount:
                    raise AppError("That holding could not be found.", 404)
            else:
                db.execute("INSERT INTO holdings (mode,symbol,name,shares,cost,currency) VALUES (?,?,?,?,?,'USD')",
                           (current, symbol, name, shares, cost))
    elif path == "/api/remove":
        with database() as db:
            if body.get("kind") == "watch":
                db.execute("DELETE FROM watchlist WHERE mode=? AND symbol=?", (current, valid_symbol(body.get("symbol"))))
            elif body.get("kind") == "holding":
                if not isinstance(body.get("id"), int) or isinstance(body.get("id"), bool):
                    raise AppError("Invalid holding.")
                db.execute("DELETE FROM holdings WHERE mode=? AND id=?", (current, body["id"]))
            else:
                raise AppError("Unknown item type.")
    else:
        raise AppError("Page not found.", 404)
    return state()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "app" / "dist" / "client"), **kwargs)

    def log_message(self, format, *args):
        # Do not print URLs or provider keys.
        pass

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def json_response(self, payload, status=200):
        data = json.dumps(payload, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        host = self.headers.get("Host", "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            raise AppError("This app only accepts local requests.", 403)
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise AppError("Cross-site requests are not allowed.", 403)

    def do_GET(self):
        try:
            self.allowed()
            url = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(url.query)
            if url.path == "/api/health":
                self.json_response({"app": "equitydesk", "version": 3})
            elif url.path == "/api/state":
                self.json_response(state())
            elif url.path == "/api/stock":
                self.json_response(stock_data(query.get("symbol", [""])[0], query.get("refresh") == ["1"]))
            elif url.path == '/api/fundamentals':
                self.json_response(fundamentals_data(query.get('symbol',[''])[0]))
            elif url.path == "/api/search":
                self.json_response({"results": search_stocks(query.get("q", [""])[0])})
            elif url.path == '/api/quotes':
                symbols = [valid_symbol(s) for s in query.get('symbols', [''])[0].split(',') if s]
                self.json_response(yahoo.snapshot(symbols))
            elif url.path == '/api/directory':
                self.json_response(market.directory_info())
            elif url.path.startswith("/api/"):
                raise AppError("Page not found.", 404)
            else:
                # SimpleHTTPRequestHandler's root is ONLY the generated public site.
                # Deny symlinks escaping that directory.
                target = Path(self.translate_path(self.path)).resolve()
                public = (ROOT / "app" / "dist" / "client").resolve()
                if public != target and public not in target.parents:
                    raise AppError("Page not found.", 404)
                super().do_GET()
        except AppError as exc:
            self.json_response({"error": str(exc)}, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.json_response({"error": "The local app encountered an error. Please retry."}, 500)

    def do_POST(self):
        try:
            self.allowed()
            if self.headers.get("X-EquityDesk") != "1":
                raise AppError("Missing application request header.", 403)
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise AppError("Expected JSON form data.", 415)
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise AppError("Invalid request size.")
            if not 0 < length <= 50000:
                raise AppError("This form is too large or empty.", 413)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise AppError('Expected a form object.')
            if urllib.parse.urlsplit(self.path).path == '/api/paper/preview':
                self.json_response(paper.preview(body))
                return
            if urllib.parse.urlsplit(self.path).path == "/api/shutdown":
                self.json_response({"stopped": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            result = mutate(urllib.parse.urlsplit(self.path).path, body)
            self.json_response(result)
        except AppError as exc:
            self.json_response({"error": str(exc)}, exc.status)
        except (ValueError, TypeError):
            self.json_response({"error": "The submitted form was invalid."}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.json_response({"error": "Could not save. Please retry; your previous data is unchanged."}, 500)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    initialize()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("EquityDesk is ready at http://127.0.0.1:" + str(args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
