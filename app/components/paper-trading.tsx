'use client';
import { useState } from 'react';
import { RefreshCw, GraduationCap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StockPicker } from '@/components/stock-picker';
import { useQuotes } from '@/lib/use-quotes';
import { money, type AppState } from '@/lib/stocks';
import { request } from '@/lib/api';

const fillPrice = (n: number | null | undefined, currency = 'USD') =>
  n == null || !/^[A-Z]{3}$/.test(currency)
    ? 'Not available'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(n);

type Preview = {
  id: string;
  symbol: string;
  name: string;
  side: 'buy' | 'sell';
  shares: string;
  price: string;
  amount: number;
  quoteAt: string;
  checkedAt: string;
  source: string;
  marketState: string;
  expiresAt: number;
};
export function PaperTrading({
  app,
  onUpdate,
  onResearch,
}: {
  app: AppState;
  onUpdate: (app: AppState) => void;
  onResearch: (symbol: string) => void;
}) {
  const [company, setCompany] = useState({
      symbol: 'RIVN',
      name: 'Rivian Automotive, Inc.',
    }),
    [side, setSide] = useState('buy'),
    [shares, setShares] = useState('1');
  const [preview, setPreview] = useState<Preview | null>(null),
    [requestId, setRequestId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [reset, setReset] = useState(false);
  const account = app.paper;
  const symbols = [
    ...new Set([
      company.symbol,
      ...(account?.holdings.map((h) => h.symbol) ?? []),
    ]),
  ]
    .sort()
    .join(',');
  const feed = useQuotes(
    symbols,
    Boolean(app.quotesConfigured),
    app.refresh?.enabled ?? true,
    30,
    0,
  );
  const quote = feed.quotes[company.symbol];
  const missing =
    account?.holdings.filter(
      (h) =>
        feed.quotes[h.symbol]?.price == null ||
        feed.quotes[h.symbol]?.currency !== 'USD',
    ) ?? [];
  const stockValue =
    account?.holdings.reduce(
      (sum, h) =>
        sum +
        (feed.quotes[h.symbol]?.currency === 'USD'
          ? (feed.quotes[h.symbol]?.price ?? 0) * h.shares
          : 0),
      0,
    ) ?? 0;
  const total = account && !missing.length ? account.cash + stockValue : null;
  const basis = account?.holdings.reduce((sum, h) => sum + h.costBasis, 0) ?? 0;
  const held = account?.holdings.find((h) => h.symbol === company.symbol);
  async function previewTrade(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const p = await request<Preview>('/api/paper/preview', {
        symbol: company.symbol,
        side,
        shares,
      });
      setPreview(p);
      setRequestId(crypto.randomUUID());
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not preview this practice trade.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await request<AppState>('/api/paper/trade', {
        previewId: preview.id,
        requestId,
      });
      onUpdate(result);
      setSuccess(
        `${preview.side === 'buy' ? 'Bought' : 'Sold'} ${preview.shares} ${preview.symbol} shares with virtual money.`,
      );
      setPreview(null);
      void feed.refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not complete the practice trade.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function resetAccount() {
    setBusy(true);
    setError('');
    try {
      onUpdate(
        await request<AppState>('/api/paper/reset', { confirmation: 'RESET' }),
      );
      setReset(false);
      setSuccess('Practice account reset to $100,000 virtual cash.');
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not reset the practice account.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (!account) return <p className="status">Opening your practice account…</p>;
  return (
    <section className="paper-workspace">
      <div className="section-heading">
        <div>
          <p className="eyebrow">VIRTUAL MONEY · REAL MARKET DATA</p>
          <h2>
            <GraduationCap size={24} /> Investment practice
          </h2>
          <p className="muted">
            Start with $100,000. Try buying and selling without using real
            money.
          </p>
        </div>
        <Button variant="outline" onClick={() => setReset(true)}>
          Reset practice account
        </Button>
      </div>
      <div className="paper-metrics">
        <div>
          <span>Practice account value</span>
          <strong>{money(total)}</strong>
          <small>
            {missing.length
              ? 'Some holdings need a USD price'
              : 'Virtual cash + priced holdings'}
          </small>
        </div>
        <div>
          <span>Virtual cash available</span>
          <strong>{money(account.cash)}</strong>
          <small>Starting cash {money(account.initialCash)}</small>
        </div>
        <div>
          <span>Total practice gain / loss</span>
          <strong
            className={
              total !== null && total < account.initialCash
                ? 'negative'
                : 'positive'
            }
          >
            {money(total === null ? null : total - account.initialCash)}
          </strong>
          <small>
            Realized {money(account.realizedGain)} · Unrealized{' '}
            {money(missing.length ? null : stockValue - basis)}
          </small>
        </div>
      </div>
      {success && (
        <p className="success-box" role="status">
          {success}
        </p>
      )}
      {error && !preview && !reset && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {feed.error && (
        <p className="warning-box" role="status">
          {feed.error}
        </p>
      )}
      <div className="paper-grid">
        <article className="panel">
          <div className="section-heading">
            <h2>Practice holdings</h2>
            <Button
              variant="ghost"
              size="sm"
              disabled={feed.busy}
              onClick={() => void feed.refresh()}
            >
              <RefreshCw />
              {feed.busy ? 'Checking…' : 'Refresh prices'}
            </Button>
          </div>
          {!account.holdings.length ? (
            <div className="paper-empty">
              <GraduationCap size={36} />
              <h3>Your first practice investment</h3>
              <p>
                Find any listed company by name in the trade panel. Preview a
                buy to see the price and virtual cash required.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead className="number">Shares</TableHead>
                  <TableHead className="number">Price / value</TableHead>
                  <TableHead className="number">Gain / loss</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {account.holdings.map((h) => {
                  const q = feed.quotes[h.symbol],
                    price = q?.currency === 'USD' ? q.price : null,
                    value = price == null ? null : price * h.shares;
                  return (
                    <TableRow key={h.symbol}>
                      <TableCell>
                        <button
                          className="text-link"
                          onClick={() => onResearch(h.symbol)}
                        >
                          {h.symbol}
                        </button>
                        <span className="table-subtitle">{h.name}</span>
                      </TableCell>
                      <TableCell className="number">
                        {h.shares.toLocaleString(undefined, {
                          maximumFractionDigits: 8,
                        })}
                      </TableCell>
                      <TableCell className="number">
                        {fillPrice(price)}
                        <span className="table-subtitle">
                          Value {money(value)}
                        </span>
                        <span className="table-subtitle">
                          {q?.priceAt
                            ? new Date(q.priceAt).toLocaleString()
                            : 'Waiting for price'}
                        </span>
                        {q?.warning && (
                          <span className="table-subtitle warning-text">
                            {q.warning}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="number">
                        {money(value === null ? null : value - h.costBasis)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setCompany({ symbol: h.symbol, name: h.name });
                            setSide('sell');
                            setShares(String(h.shares));
                            setError('');
                          }}
                        >
                          Sell
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <p className="footnote">
            Prices: Yahoo Finance; may be delayed. Checks run every 30 seconds
            while open, unless paused. Stock splits, dividends, fees, taxes, and
            order-book effects are not simulated.
          </p>
        </article>
        <aside className="panel paper-ticket">
          <h2>Place a practice trade</h2>
          <form onSubmit={previewTrade}>
            <label className="field-label" htmlFor="paper-company">
              Find a company
            </label>
            <StockPicker
              mode="live"
              inputId="paper-company"
              onPick={(s) => {
                setCompany(s);
                setError('');
              }}
            />
            <div className="paper-company">
              <strong>{quote?.name || company.name}</strong>
              <span>{company.symbol}</span>
            </div>
            <div className="paper-price">
              <strong>
                {fillPrice(quote?.price, quote?.currency || 'USD')}
              </strong>
              <span>Yahoo last regular-session price</span>
            </div>
            <p className="small muted">
              Price as of{' '}
              {quote?.priceAt
                ? new Date(quote.priceAt).toLocaleString()
                : 'unavailable'}
              . Last checked{' '}
              {quote?.checkedAt
                ? new Date(quote.checkedAt).toLocaleTimeString()
                : 'not yet'}
              .
            </p>
            <Tabs value={side} onValueChange={(v) => setSide(String(v))}>
              <TabsList className="paper-side">
                <TabsTrigger value="buy">Buy</TabsTrigger>
                <TabsTrigger value="sell">Sell</TabsTrigger>
              </TabsList>
            </Tabs>
            <label className="field-label" htmlFor="paper-shares">
              Number of shares
            </label>
            <Input
              id="paper-shares"
              type="number"
              step="0.00000001"
              min="0.00000001"
              max="1000000000"
              required
              value={shares}
              onChange={(e) => setShares(e.target.value)}
            />
            <p className="footnote">
              You own{' '}
              {held?.shares.toLocaleString(undefined, {
                maximumFractionDigits: 8,
              }) ?? '0'}{' '}
              practice shares. Fractional shares are supported.
            </p>
            <Button type="submit" disabled={busy || !app.quotesConfigured}>
              {busy ? 'Checking price…' : `Preview practice ${side}`}
            </Button>
            <p className="footnote">
              Simulation only. Fills use the displayed Yahoo price even outside
              market hours; they are not executable broker quotes.
            </p>
          </form>
        </aside>
      </div>
      <article className="panel paper-history">
        <h2>Practice trade history</h2>
        {!account.trades.length ? (
          <p className="empty-inline">
            Confirmed practice buys and sells will appear here.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Filled</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="number">Shares</TableHead>
                <TableHead className="number">Simulated fill price</TableHead>
                <TableHead className="number">Virtual amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {account.trades.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{new Date(t.filledAt).toLocaleString()}</TableCell>
                  <TableCell>{t.symbol}</TableCell>
                  <TableCell>{t.side === 'buy' ? 'Buy' : 'Sell'}</TableCell>
                  <TableCell className="number">
                    {t.shares.toLocaleString(undefined, {
                      maximumFractionDigits: 8,
                    })}
                  </TableCell>
                  <TableCell className="number">
                    {fillPrice(t.price)}
                    <span className="table-subtitle">
                      {t.source} · {new Date(t.quoteAt).toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell className="number">{money(t.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="footnote">
          Most recent 100 trades shown. Your complete practice history stays
          saved on this Mac.
        </p>
      </article>
      <Dialog
        open={!!preview}
        onOpenChange={(v) => {
          if (!v && !busy) {
            setPreview(null);
            setError('');
          }
        }}
      >
        <DialogContent className="holding-dialog">
          <DialogHeader>
            <DialogTitle>Confirm practice {preview?.side}</DialogTitle>
            <DialogDescription>
              Virtual money only. No real order will be submitted.
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <h2>{preview.name}</h2>
              <p>
                {preview.shares} shares of {preview.symbol} ×{' '}
                {fillPrice(Number(preview.price))}
              </p>
              <p className="paper-confirm-total">{money(preview.amount)}</p>
              <p className="small muted">
                Yahoo price from {new Date(preview.quoteAt).toLocaleString()}.{' '}
                {preview.marketState === 'REGULAR'
                  ? 'Regular session.'
                  : 'Outside regular trading hours or session status unavailable.'}{' '}
                May be delayed.
              </p>
              <p className="footnote">
                This price is held for 60 seconds, until{' '}
                {new Date(preview.expiresAt * 1000).toLocaleTimeString()}. No
                fees or slippage are applied.
              </p>
              {error && (
                <p className="error-box" role="alert">
                  {error}
                </p>
              )}
              <Button disabled={busy} onClick={() => void confirm()}>
                {busy ? 'Saving…' : `Confirm virtual ${preview.side}`}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={reset}
        onOpenChange={(v) => {
          if (!busy) setReset(v);
        }}
      >
        <DialogContent className="holding-dialog">
          <DialogHeader>
            <DialogTitle>Reset the practice account?</DialogTitle>
            <DialogDescription>
              This deletes practice holdings and trade history and restores
              $100,000 in virtual cash. Your real holdings and research notes
              are kept.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="error-box" role="alert">
              {error}
            </p>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setReset(false)}
          >
            Keep practicing
          </Button>
          <Button disabled={busy} onClick={() => void resetAccount()}>
            Reset virtual account
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
