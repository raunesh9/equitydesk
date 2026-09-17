"""A virtual-money ledger. Never submits orders to a broker."""
import datetime as dt
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
import time
import uuid

START_CENTS = 10_000_000

class PaperTrading:
    def __init__(self, database, quotes, validate_symbol, error):
        self.database, self.quotes, self.validate_symbol, self.Error = database, quotes, validate_symbol, error

    def initialize(self):
        with self.database() as db:
            db.execute('CREATE TABLE IF NOT EXISTS paper_account (id INTEGER PRIMARY KEY CHECK(id=1), cash_cents INTEGER NOT NULL, initial_cents INTEGER NOT NULL, realized_cents INTEGER NOT NULL)')
            db.execute('INSERT OR IGNORE INTO paper_account VALUES (1,?,?,0)', (START_CENTS, START_CENTS))
            db.execute('CREATE TABLE IF NOT EXISTS paper_positions (symbol TEXT PRIMARY KEY, name TEXT NOT NULL, shares TEXT NOT NULL, cost_cents INTEGER NOT NULL)')
            db.execute('''CREATE TABLE IF NOT EXISTS paper_previews (id TEXT PRIMARY KEY, expires REAL NOT NULL, payload TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS paper_trades (id INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, preview_id TEXT NOT NULL UNIQUE,
                symbol TEXT NOT NULL, name TEXT NOT NULL, side TEXT NOT NULL, shares TEXT NOT NULL, price TEXT NOT NULL,
                amount_cents INTEGER NOT NULL, realized_cents INTEGER NOT NULL, filled_at TEXT NOT NULL, quote_at TEXT NOT NULL, source TEXT NOT NULL)''')

    def state(self):
        with self.database() as db:
            account = dict(db.execute('SELECT * FROM paper_account WHERE id=1').fetchone())
            holdings = [dict(row) for row in db.execute('SELECT * FROM paper_positions ORDER BY symbol')]
            trades = [dict(row) for row in db.execute('SELECT * FROM paper_trades ORDER BY id DESC LIMIT 100')]
        return {'cash': account['cash_cents']/100, 'initialCash': account['initial_cents']/100, 'realizedGain': account['realized_cents']/100,
            'holdings': [{'symbol':row['symbol'], 'name':row['name'], 'shares':float(row['shares']), 'costBasis':row['cost_cents']/100} for row in holdings],
            'trades': [{'id':r['id'], 'symbol':r['symbol'], 'name':r['name'], 'side':r['side'], 'shares':float(r['shares']),
                       'price':float(r['price']), 'amount':r['amount_cents']/100, 'realizedGain':r['realized_cents']/100,
                       'filledAt':r['filled_at'], 'quoteAt':r['quote_at'], 'source':r['source']} for r in trades]}

    def quantity(self, value):
        try:
            if isinstance(value, bool):
                raise InvalidOperation
            amount = Decimal(str(value))
            if not amount.is_finite() or amount < Decimal('0.00000001') or amount > Decimal('1000000000'):
                raise InvalidOperation
            if amount != amount.quantize(Decimal('0.00000001')):
                raise InvalidOperation
            return amount
        except (InvalidOperation, ValueError, TypeError):
            raise self.Error('Enter a positive share amount with up to eight decimal places.')

    def preview(self, body):
        symbol = self.validate_symbol(body.get('symbol'))
        side, quantity = body.get('side'), self.quantity(body.get('shares'))
        if side not in ('buy', 'sell'):
            raise self.Error('Choose Buy or Sell.')
        quote = self.quotes(symbol, True)
        if quote.get('price') is None or quote.get('currency') != 'USD' or quote.get('warning'):
            raise self.Error('A successfully checked Yahoo USD price is required to preview a practice trade.')
        try:
            quoted_at = dt.datetime.fromisoformat(quote['priceAt'].replace('Z','+00:00')).timestamp()
            checked_at = dt.datetime.fromisoformat(quote['checkedAt'].replace('Z','+00:00')).timestamp()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise self.Error('Yahoo did not provide valid price timestamps.')
        if not -120 <= time.time() - quoted_at <= 7*86400 or not -120 <= time.time() - checked_at <= 300:
            raise self.Error('This Yahoo price is too old for a practice trade. Refresh and try again.')
        price = Decimal(str(quote['price'])).quantize(Decimal('0.000001'), rounding=ROUND_HALF_UP)
        if not price.is_finite() or price <= 0:
            raise self.Error('A positive price is required.')
        cents = int((quantity*price*100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
        if cents < 1:
            raise self.Error('A practice trade must be worth at least one cent.')
        self.check_available(side, symbol, quantity, cents)
        preview = {'id':str(uuid.uuid4()), 'symbol':symbol, 'name':quote.get('name') or symbol, 'side':side,
                   'shares':str(quantity), 'price':str(price), 'amount':cents/100, 'amountCents':cents,
                   'quoteAt':quote['priceAt'], 'checkedAt':quote['checkedAt'], 'source':quote['source'],
                   'marketState':quote.get('marketState','UNKNOWN'), 'expiresAt':time.time()+60}
        with self.database() as db:
            db.execute('DELETE FROM paper_previews WHERE expires < ?', (time.time(),))
            db.execute('INSERT INTO paper_previews VALUES (?,?,?)', (preview['id'],preview['expiresAt'],json.dumps(preview)))
        return preview

    def check_available(self, side, symbol, quantity, cents, db=None):
        if db is None:
            with self.database() as connection:
                return self.check_available(side, symbol, quantity, cents, connection)
        account = db.execute('SELECT cash_cents FROM paper_account WHERE id=1').fetchone()
        position = db.execute('SELECT * FROM paper_positions WHERE symbol=?', (symbol,)).fetchone()
        if side == 'buy' and account[0] < cents:
            raise self.Error('Not enough virtual cash for this purchase.')
        if side == 'sell' and (not position or Decimal(position['shares']) < quantity):
            raise self.Error('You cannot sell more practice shares than you own.')
        return position

    def fill(self, body):
        request_id, preview_id = body.get('requestId'), body.get('previewId')
        try:
            uuid.UUID(str(request_id)); uuid.UUID(str(preview_id))
        except (ValueError, TypeError):
            raise self.Error('Preview this trade again before confirming.')
        with self.database() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT preview_id FROM paper_trades WHERE request_id=?', (request_id,)).fetchone()
            if previous:
                if previous['preview_id'] != preview_id:
                    raise self.Error('That confirmation was already used for another trade.')
                return
            if db.execute('SELECT id FROM paper_trades WHERE preview_id=?', (preview_id,)).fetchone():
                raise self.Error('This preview was already filled. No duplicate trade was made.')
            row = db.execute('SELECT * FROM paper_previews WHERE id=?', (preview_id,)).fetchone()
            if not row or row['expires'] < time.time():
                raise self.Error('The preview expired. Get a new price before confirming.')
            p = json.loads(row['payload'])
            quantity, cents = Decimal(p['shares']), p['amountCents']
            position = self.check_available(p['side'],p['symbol'],quantity,cents,db)
            old_shares = Decimal(position['shares']) if position else Decimal(0)
            old_cost = position['cost_cents'] if position else 0
            if p['side']=='buy':
                shares, basis, realized, cash_change = old_shares+quantity, old_cost+cents, 0, -cents
            else:
                basis_sold = old_cost if quantity == old_shares else int((Decimal(old_cost)*quantity/old_shares).quantize(Decimal('1'),rounding=ROUND_HALF_UP))
                shares, basis, realized, cash_change = old_shares-quantity, old_cost-basis_sold, cents-basis_sold, cents
            if shares:
                db.execute('INSERT OR REPLACE INTO paper_positions VALUES (?,?,?,?)',(p['symbol'],p['name'],str(shares),basis))
            else:
                db.execute('DELETE FROM paper_positions WHERE symbol=?',(p['symbol'],))
            db.execute('UPDATE paper_account SET cash_cents=cash_cents+?,realized_cents=realized_cents+? WHERE id=1',(cash_change,realized))
            db.execute('INSERT INTO paper_trades (request_id,preview_id,symbol,name,side,shares,price,amount_cents,realized_cents,filled_at,quote_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (request_id,preview_id,p['symbol'],p['name'],p['side'],p['shares'],p['price'],cents,realized,dt.datetime.now(dt.timezone.utc).isoformat(),p['quoteAt'],p['source']))

    def reset(self, body):
        if body.get('confirmation') != 'RESET':
            raise self.Error('Confirm resetting the practice account first.')
        with self.database() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM paper_positions')
            db.execute('DELETE FROM paper_previews')
            db.execute('DELETE FROM paper_trades')
            db.execute('UPDATE paper_account SET cash_cents=?, initial_cents=?, realized_cents=0 WHERE id=1',(START_CENTS,START_CENTS))
