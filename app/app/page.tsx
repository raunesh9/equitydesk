'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Bookmark,
  ChartNoAxesCombined,
  Check,
  GitCompareArrows,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Wallet,
  X,
  PenLine,
  LoaderCircle,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StockPicker } from '@/components/stock-picker';
import { PriceChart } from '@/components/price-chart';
import { PortfolioManager } from '@/components/portfolio-manager';
import { PaperTrading } from '@/components/paper-trading';
import { useQuotes } from '@/lib/use-quotes';
import { Switch } from '@/components/ui/switch';
import { Sources } from '@/components/sources';
import { SessionPrices } from '@/components/session-prices';
import { sessionLabel } from '@/lib/stocks';
import { request } from '@/lib/api';
import {
  sampleStocks,
  money,
  compact,
  ratio,
  percent,
  priceReturn,
  pointsFor,
  portfolioTotals,
  type Stock,
  type AppState,
  type Holding,
  type Financial,
} from '@/lib/stocks';

const sampleMap = Object.fromEntries(sampleStocks.map((s) => [s.symbol, s]));
const noState: AppState = {
  mode: 'live',
  watchlist: [],
  holdings: [],
  configured: false,
  provider: 'Yahoo Finance',
};
const periods = ['1M', '3M', '1Y', 'All'];
const financialRows: [string, keyof Financial][] = [
  ['Revenue', 'revenue'],
  ['Net income', 'earnings'],
  ['Operating cash flow', 'operatingCashFlow'],
  ['Capital expenditures', 'capex'],
  ['Free cash flow', 'freeCashFlow'],
  ['Total debt', 'debt'],
  ['Cash & equivalents', 'cash'],
];

function RangePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(String(v))}>
      <TabsList className="range-tabs">
        {periods.map((p) => (
          <TabsTrigger key={p} value={p}>
            {p}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
function Metric({
  label,
  value,
  caption,
  positive,
}: {
  label: string;
  value: string;
  caption: string;
  positive?: boolean;
}) {
  return (
    <div className="panel metric">
      <span>{label}</span>
      <strong
        className={
          positive === undefined ? '' : positive ? 'positive' : 'negative'
        }
      >
        {value}
      </strong>
      <small>{caption}</small>
    </div>
  );
}
function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="panel empty-state">
      <Bookmark />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export default function Home() {
  const [app, setApp] = useState<AppState>(noState),
    [ready, setReady] = useState(false),
    [tab, setTab] = useState('practice');
  const [selected, setSelected] = useState('RIVN'),
    [compare, setCompare] = useState<string[]>(['RIVN', 'HDRN']);
  const [range, setRange] = useState('1Y'),
    [compareRange, setCompareRange] = useState('1Y');
  const [live, setLive] = useState<Record<string, Stock>>({}),
    [loading, setLoading] = useState<Record<string, boolean>>({}),
    [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [settings, setSettings] = useState(false),
    [holding, setHolding] = useState<Partial<Holding> | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const liveRef = useRef<Record<string, Stock>>({}),
    inflight = useRef(new Map<string, number>()),
    appRef = useRef(app);
  const generation = useRef(0);
  appRef.current = app;
  useEffect(() => {
    request<AppState>('/api/state')
      .then((s) => {
        setApp(s);
        setReady(true);
      })
      .catch((e) => setError(e.message));
  }, []);
  const loadStock = useCallback(
    async (symbol: string, refresh = false, revalidate = false) => {
      if (
        inflight.current.get(symbol) === generation.current ||
        (!refresh && !revalidate && liveRef.current[symbol])
      )
        return;
      const gen = generation.current;
      inflight.current.set(symbol, gen);
      setLoading((p) => ({ ...p, [symbol]: true }));
      setErrors((p) => ({ ...p, [symbol]: '' }));
      try {
        const s = await request<Stock>(
          '/api/stock?symbol=' +
            encodeURIComponent(symbol) +
            (refresh ? '&refresh=1' : ''),
        );
        if (gen === generation.current) {
          liveRef.current = { ...liveRef.current, [symbol]: s };
          setLive(liveRef.current);
          setLoading((p) => ({ ...p, [symbol]: false }));
        }
        // A slow statement request must not hold up the price chart.
        try {
          const details = await request<
            Pick<
              Stock,
              | 'sector'
              | 'description'
              | 'marketCap'
              | 'pe'
              | 'ps'
              | 'financials'
              | 'updated'
              | 'warnings'
            >
          >('/api/fundamentals?symbol=' + encodeURIComponent(symbol));
          if (gen === generation.current) {
            liveRef.current = {
              ...liveRef.current,
              [symbol]: {
                ...s,
                ...details,
                updated: { ...s.updated, ...details.updated },
                warnings: [...s.warnings, ...details.warnings],
              },
            };
            setLive(liveRef.current);
          }
        } catch (e) {
          if (gen === generation.current) {
            liveRef.current = {
              ...liveRef.current,
              [symbol]: {
                ...s,
                description: 'Company details could not be loaded.',
                warnings: [
                  ...s.warnings,
                  e instanceof Error
                    ? e.message
                    : 'Financial reports are unavailable.',
                ],
              },
            };
            setLive(liveRef.current);
          }
        }
      } catch (e) {
        if (gen === generation.current)
          setErrors((p) => ({
            ...p,
            [symbol]: e instanceof Error ? e.message : 'Could not load data.',
          }));
      } finally {
        if (inflight.current.get(symbol) === gen)
          inflight.current.delete(symbol);
        if (gen === generation.current)
          setLoading((p) => ({ ...p, [symbol]: false }));
      }
    },
    [],
  );
  const holdingSymbols = app.holdings.map((h) => h.symbol).join(',');
  useEffect(() => {
    if (!ready || app.mode !== 'live') return;
    const needed =
      tab === 'research'
        ? [selected]
        : tab === 'compare'
          ? compare
          : !app.quotesConfigured && tab === 'portfolio'
            ? [...new Set(holdingSymbols.split(',').filter(Boolean))]
            : [];
    for (const s of needed) void loadStock(s);
    const timer = setInterval(
      () => {
        if (app.refresh?.enabled !== false)
          for (const s of needed) void loadStock(s, false, true);
      },
      15 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [
    ready,
    app.mode,
    app.quotesConfigured,
    app.refresh?.enabled,
    tab,
    selected,
    compare,
    holdingSymbols,
    loadStock,
  ]);
  const quoteSymbols = [
    ...new Set([
      selected,
      ...(tab === 'compare' ? compare : []),
      ...app.holdings.map((h) => h.symbol),
      ...app.watchlist.map((w) => w.symbol),
      ...Object.keys(app.manager?.targets ?? {}),
    ]),
  ]
    .sort()
    .join(',');
  const quoteData = useQuotes(
    quoteSymbols,
    ready && app.mode === 'live' && Boolean(app.quotesConfigured),
    app.refresh?.enabled ?? true,
    app.refresh?.interval ?? 30,
    0,
  );
  const stocks: Record<string, Stock> =
    app.mode === 'sample' ? sampleMap : { ...live };
  if (app.mode === 'live')
    for (const [symbol, quote] of Object.entries(quoteData.quotes)) {
      const old = stocks[symbol];
      stocks[symbol] = {
        ...(old ?? {
          symbol,
          name:
            app.holdings.find((h) => h.symbol === symbol)?.name ??
            app.watchlist.find((w) => w.symbol === symbol)?.name ??
            quote.name ??
            symbol,
          exchange: 'U.S. listing',
          sector: 'Not available',
          description: 'Open Research to load company details.',
          financials: [],
          history: [],
          marketCap: null,
          pe: null,
          ps: null,
          fetchedAt: '',
          source: 'Yahoo Finance',
          sourceUrl: quote.sourceUrl,
          warnings: [],
          mode: 'live' as const,
        }),
        price: quote.price,
        currency: quote.currency,
        priceDate: quote.priceAt,
        quote,
      };
    }

  const active = stocks[selected];
  const act = useCallback(
    async (path: string, body: Record<string, unknown>, success: string) => {
      setPending(true);
      setError('');
      setMessage('');
      try {
        const s = await request<AppState>(path, {
          ...body,
          mode: body.mode ?? appRef.current.mode,
        });
        setApp(s);
        setMessage(success);
        return s;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save.');
        return null;
      } finally {
        setPending(false);
      }
    },
    [],
  );
  async function changeMode(newMode: 'sample' | 'live') {
    const result = await act(
      '/api/mode',
      { mode: newMode },
      newMode === 'sample'
        ? 'Sample workspace opened.'
        : 'Provider workspace opened.',
    );
    if (result) {
      setDrafts({});
      setSelected(newMode === 'sample' ? 'AAPL' : 'RIVN');
      setCompare(
        newMode === 'sample' ? ['AAPL', 'MSFT', 'NVDA'] : ['RIVN', 'HDRN'],
      );
      setTab('research');
      setSettings(false);
    }
  }
  function pick(symbol: string) {
    setSelected(symbol);
    setTab('research');
    setError('');
  }
  function addCompare(symbol: string) {
    if (compare.includes(symbol)) {
      setMessage(symbol + ' is already in the comparison.');
      return;
    }
    if (compare.length >= 3) {
      setError(
        'Remove a company before adding another. You can compare up to three.',
      );
      return;
    }
    setCompare([...compare, symbol]);
    setError('');
  }
  async function watch(s: Stock) {
    await act(
      '/api/watchlist',
      { symbol: s.symbol, name: s.name },
      s.symbol + ' added to your watchlist.',
    );
  }
  async function saveHolding(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      symbol = String(f.get('symbol')).trim().toUpperCase();
    const s = stocks[symbol];
    const result = await act(
      '/api/holdings',
      {
        id: holding?.id,
        symbol,
        name: holding?.name || s?.name || symbol,
        shares: Number(f.get('shares')),
        cost: Number(f.get('cost')),
        currency: 'USD',
      },
      'Holding saved.',
    );
    if (result) setHolding(null);
  }
  const watched = app.watchlist.some((w) => w.symbol === selected);
  const financial = active?.financials[0];
  const returnValue = active ? priceReturn(active, range) : null;
  const selectedPoints = active ? pointsFor(active, range) : [];
  const compareStocks = compare.map((s) => stocks[s]).filter(Boolean);
  const { costTotal, missing, pricedTotal, marketTotal, gain } =
    portfolioTotals(app.holdings, stocks);

  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options: unknown,
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: unknown) => {
      try {
        Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch(() => {});
      } catch {}
    };
    register({
      name: 'read_research_workspace',
      description:
        'Read the active sample or provider workspace, saved watchlist and manually entered holdings.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => request<AppState>('/api/state'),
    });
    register({
      name: 'save_watchlist_note',
      description:
        'Save research notes for an existing watched stock in the current workspace and update the visible note.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          notes: { type: 'string', maxLength: 10000 },
        },
        required: ['symbol', 'notes'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input: unknown) => {
        const d = input as { symbol?: unknown; notes?: unknown };
        if (
          typeof d?.symbol !== 'string' ||
          typeof d.notes !== 'string' ||
          d.notes.length > 10000
        )
          throw Error(
            'Provide a symbol and a note of at most 10,000 characters.',
          );
        const w = appRef.current.watchlist.find(
          (w) => w.symbol === String(d.symbol).toUpperCase(),
        );
        if (!w) throw Error('Add this stock to the watchlist first.');
        const result = await request<AppState>('/api/watchlist', {
          mode: appRef.current.mode,
          symbol: w.symbol,
          notes: d.notes,
          notesOnly: true,
        });
        setApp(result);
        setDrafts((prev) => ({ ...prev, [w.symbol]: String(d.notes) }));
        return { symbol: w.symbol, saved: true, mode: result.mode };
      },
    });
    return () => lifecycle.abort();
  }, []);

  return (
    <main>
      <header className="masthead">
        <div className="brand">
          <ChartNoAxesCombined />
          <span>
            Equity<span className="brand-light">Desk</span>
          </span>
        </div>
        <span className="local-status">
          <i />
          {app.storage === 'browser'
            ? 'Saved in this browser'
            : 'Local on your Mac'}
        </span>
      </header>
      <div className="workspace">
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR MONEY, IN FOCUS</p>
            <h1>Invest with a clearer view.</h1>
          </div>
          <Button
            variant="outline"
            onClick={() => setSettings(true)}
            disabled={!ready}
          >
            <SlidersHorizontal />
            Data connection
          </Button>
        </div>
        {app.mode === 'sample' && tab !== 'practice' ? (
          <div className="sample-banner">
            <span className="sample-tag">SAMPLE DATA</span>
            <span>
              Archived demo with illustrative prices. Your saved demo notes and
              holdings are kept here.
            </span>
            <button onClick={() => setSettings(true)} disabled={!ready}>
              Use Yahoo data <ArrowUpRight size={14} />
            </button>
          </div>
        ) : (
          <div className="live-banner">
            <span className="provider-tag">YAHOO FINANCE</span>
            <span>
              {app.quotesConfigured
                ? `No API key needed · Prices may be delayed. ${app.refresh?.enabled === false ? 'Automatic checks paused.' : 'Checks every 30 seconds while open.'}`
                : 'Reopen EquityDesk with its launcher to enable Yahoo Finance.'}
            </span>
          </div>
        )}
        {(app.mode === 'live' || tab === 'practice') &&
          app.quotesConfigured && (
            <div className="refresh-bar">
              <label>
                <Switch
                  checked={app.refresh?.enabled ?? true}
                  onCheckedChange={(enabled) =>
                    void act(
                      '/api/refresh-settings',
                      { enabled, interval: app.refresh?.interval ?? 30 },
                      enabled
                        ? 'Automatic price updates enabled.'
                        : 'Automatic updates paused.',
                    )
                  }
                />
                Automatic prices · Yahoo
              </label>
              <span>
                {tab !== 'practice' && quoteData.busy
                  ? 'Checking prices…'
                  : app.refresh?.enabled === false
                    ? 'Paused'
                    : `Checks every ${app.refresh?.interval ?? 30} seconds`}
              </span>
              {tab !== 'practice' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void quoteData.refresh()}
                  disabled={quoteData.busy}
                >
                  <RefreshCw />
                  Refresh now
                </Button>
              )}
            </div>
          )}
        {quoteData.error && app.mode === 'live' && (
          <p className="warning-box" role="status">
            {quoteData.error}
          </p>
        )}
        {!ready && !error && (
          <p className="status">
            <LoaderCircle className="spin" size={16} />
            Opening your saved workspace…
          </p>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {message && (
          <div className="success-box" role="status">
            <Check size={16} />
            {message}
            <button aria-label="Dismiss message" onClick={() => setMessage('')}>
              <X size={16} />
            </button>
          </div>
        )}
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
          <TabsList className="main-tabs">
            <TabsTrigger value="practice">Practice investing</TabsTrigger>
            <TabsTrigger value="research">Research</TabsTrigger>
            <TabsTrigger value="compare">Compare</TabsTrigger>
            <TabsTrigger value="watchlist">
              Watchlist{' '}
              {app.watchlist.length > 0 && (
                <span className="count">{app.watchlist.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="portfolio">My holdings</TabsTrigger>
          </TabsList>

          <TabsContent value="practice">
            {ready && (
              <PaperTrading
                app={app}
                onUpdate={setApp}
                onResearch={(symbol) => {
                  if (app.mode === 'sample')
                    void changeMode('live').then(() => pick(symbol));
                  else pick(symbol);
                }}
              />
            )}
          </TabsContent>

          <TabsContent value="research">
            <div className="research-toolbar">
              <StockPicker
                mode={app.mode}
                onPick={(s) => pick(s.symbol)}
                disabled={!ready}
              />
              {app.mode === 'sample' && (
                <Button
                  variant="outline"
                  disabled={!ready || pending}
                  onClick={() => void changeMode('live')}
                >
                  Search all U.S. listings
                </Button>
              )}
              <span className="muted small">
                {app.mode === 'sample'
                  ? '8 sample companies · including RIVN & HDRN'
                  : `${app.directory?.count.toLocaleString() ?? ''} U.S. listings + Yahoo search`}
              </span>
            </div>
            <div className="ticker-strip">
              {(app.mode === 'sample'
                ? sampleStocks.map((s) => s.symbol)
                : [...new Set(['HDRN', 'RIVN', 'IBM', ...Object.keys(live)])]
              ).map((symbol) => (
                <button
                  className={
                    'ticker-chip ' + (selected === symbol ? 'active' : '')
                  }
                  key={symbol}
                  onClick={() => pick(symbol)}
                >
                  <strong>{symbol}</strong>
                  <span>
                    {stocks[symbol]
                      ? money(stocks[symbol].price, stocks[symbol].currency)
                      : 'View'}
                  </span>
                </button>
              ))}
            </div>
            {loading[selected] && (
              <p className="status">
                <LoaderCircle className="spin" size={16} />
                Loading {selected} from connected providers…
              </p>
            )}
            {errors[selected] && (
              <div className="error-box">
                {errors[selected]}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => loadStock(selected, true)}
                >
                  Retry
                </Button>
              </div>
            )}
            {active ? (
              <>
                <div className="research-grid">
                  <article className="panel">
                    <div className="stock-heading">
                      <div className="company-mark">{active.symbol[0]}</div>
                      <div>
                        <h2>{active.name}</h2>
                        <p>
                          {active.symbol} · {active.exchange} ·{' '}
                          {active.currency || 'Currency unavailable'}
                        </p>
                      </div>
                      <Button
                        className="watch-button"
                        variant="outline"
                        disabled={watched || pending || !ready}
                        onClick={() => watch(active)}
                      >
                        {watched ? <Check /> : <Bookmark />}
                        {watched ? 'Watching' : 'Watch'}
                      </Button>
                    </div>
                    <div className="price-line">
                      <strong>{money(active.price, active.currency)}</strong>
                      <span
                        className={
                          returnValue != null && returnValue < 0
                            ? 'negative'
                            : 'positive'
                        }
                      >
                        {percent(returnValue)}{' '}
                        <span className="muted">
                          {range === 'All' ? 'history' : range + ' history'}
                        </span>
                      </span>
                    </div>
                    <div className="chart-toolbar">
                      <span className="muted small">
                        {active.quote
                          ? sessionLabel(active.quote.priceSession) +
                            ' price · ' +
                            (active.quote.priceAt
                              ? new Date(active.quote.priceAt).toLocaleString()
                              : 'Not available')
                          : 'Daily price · ' +
                            (active.priceDate || 'Date unavailable')}
                      </span>
                      <RangePicker value={range} onChange={setRange} />
                    </div>
                    {active.quote && (
                      <p className="chart-caption">
                        {active.quote.warning
                          ? 'Latest check failed. '
                          : 'Last successful check: ' +
                            new Date(
                              active.quote.checkedAt,
                            ).toLocaleTimeString() +
                            '. '}
                        {sessionLabel(active.quote.priceSession)} quote. Yahoo
                        prices may be delayed.
                      </p>
                    )}
                    <PriceChart stocks={[active]} range={range} />
                    <p className="chart-caption">
                      {selectedPoints.length > 0
                        ? 'Showing ' +
                          selectedPoints[0].date +
                          ' – ' +
                          selectedPoints[selectedPoints.length - 1].date
                        : 'No history available.'}
                      {active.mode === 'live'
                        ? ' · Unadjusted prices; splits and dividends are not included.'
                        : ' · Illustrative price history.'}
                    </p>
                    {active.quote?.warning && (
                      <p className="warning-box">{active.quote.warning}</p>
                    )}
                    <Sources stock={active} />
                    <SessionPrices quote={active.quote} />
                  </article>
                  <aside className="panel">
                    <p className="eyebrow">COMPANY SNAPSHOT</p>
                    <h2>Understand the business</h2>
                    <p className="description">{active.description}</p>
                    {[
                      ['Sector', active.sector],
                      [
                        'Market cap',
                        compact(active.marketCap, active.currency),
                      ],
                      ['P/E · trailing', ratio(active.pe)],
                      ['P/S · trailing', ratio(active.ps)],
                    ].map(([k, v]) => (
                      <div className="snapshot-row" key={k}>
                        <span>{k}</span>
                        <strong>{v}</strong>
                      </div>
                    ))}
                    <div className="snapshot-actions">
                      <Button
                        variant="outline"
                        onClick={() => {
                          addCompare(active.symbol);
                          setTab('compare');
                        }}
                      >
                        <GitCompareArrows />
                        Compare
                      </Button>
                      {app.mode === 'live' && (
                        <Button
                          variant="ghost"
                          disabled={loading[selected]}
                          onClick={() => loadStock(selected, true)}
                        >
                          <RefreshCw size={15} />
                          Refresh
                        </Button>
                      )}
                    </div>
                  </aside>
                </div>
                {active.warnings.length > 0 && (
                  <details className="warning-box" open>
                    <summary>Some provider data could not be updated</summary>
                    {active.warnings.map((w, i) => (
                      <p key={i}>{w}</p>
                    ))}
                  </details>
                )}
                <div className="metric-grid">
                  {[
                    ['Revenue', financial?.revenue],
                    ['Net income', financial?.earnings],
                    ['Free cash flow', financial?.freeCashFlow],
                    ['Total debt', financial?.debt],
                  ].map(([k, v]) => (
                    <Metric
                      key={String(k)}
                      label={String(k)}
                      value={compact(
                        v as number | undefined,
                        financial?.currency || '',
                      )}
                      caption={
                        (app.mode === 'sample' ? 'Sample · ' : '') +
                        (financial
                          ? 'Year ended ' + financial.period
                          : 'No annual report available')
                      }
                    />
                  ))}
                </div>
                <section className="panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">THE FUNDAMENTALS</p>
                      <h2>Financial history</h2>
                    </div>
                    <span className="muted small">
                      Annual statements ·{' '}
                      {financial?.currency || 'Currency unavailable'}
                    </span>
                  </div>
                  {active.financials.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Metric</TableHead>
                          {active.financials.map((f) => (
                            <TableHead key={f.period} className="number">
                              Year ended {f.period}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {financialRows.map(([label, field]) => (
                          <TableRow key={field}>
                            <TableCell>{label}</TableCell>
                            {active.financials.map((f) => (
                              <TableCell key={f.period} className="number">
                                {compact(f[field] as number | null, f.currency)}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <p className="empty-inline">
                      Annual financial statements are not available. Try
                      refreshing or check the provider connection.
                    </p>
                  )}
                  <p className="footnote">
                    Free cash flow is provider-reported, or calculated as
                    operating cash flow minus the absolute capital expenditure
                    when both are available. Missing figures are shown as “Not
                    available.” Debt is shown only when the provider supplies a
                    total-debt figure.
                  </p>
                </section>
              </>
            ) : !loading[selected] && !errors[selected] ? (
              <Empty title="Choose a company">
                Search for a stock to begin your research.
              </Empty>
            ) : null}
          </TabsContent>

          <TabsContent value="compare">
            <div className="section-heading">
              <div>
                <h2>Compare companies</h2>
                <p className="muted">
                  See the numbers side by side. Add up to three stocks.
                </p>
              </div>
            </div>
            <StockPicker
              mode={app.mode}
              onPick={(s) => addCompare(s.symbol)}
              disabled={compare.length >= 3 || !ready}
              label="Add company to comparison"
            />
            <div className="compare-chips">
              {compare.map((s) => (
                <span key={s}>
                  {s}
                  <button
                    aria-label={'Remove ' + s + ' from comparison'}
                    onClick={() => setCompare(compare.filter((x) => x !== s))}
                  >
                    <X size={15} />
                  </button>
                </span>
              ))}
            </div>
            {compare.some((s) => loading[s]) && (
              <p className="status">
                <LoaderCircle className="spin" size={16} />
                Loading company data…
              </p>
            )}
            {compare.map(
              (s) =>
                errors[s] && (
                  <div className="error-box" key={s}>
                    {s}: {errors[s]}
                    <Button size="sm" onClick={() => loadStock(s, true)}>
                      Retry
                    </Button>
                  </div>
                ),
            )}
            {compareStocks.length ? (
              <>
                <section className="panel">
                  <div className="section-heading">
                    <div>
                      <h2>Price performance</h2>
                      <p className="muted small">
                        Change from the first shared trading date in the
                        selected period
                      </p>
                    </div>
                    <RangePicker
                      value={compareRange}
                      onChange={setCompareRange}
                    />
                  </div>
                  <PriceChart
                    stocks={compareStocks}
                    range={compareRange}
                    normalized
                  />
                  <p className="footnote">
                    Price changes exclude dividends.{' '}
                    {app.mode === 'live'
                      ? 'Prices are not adjusted for splits. '
                      : ''}
                    Only dates shared by all loaded companies are compared.
                  </p>
                </section>
                <section className="panel comparison-table">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Metric</TableHead>
                        {compareStocks.map((s) => (
                          <TableHead key={s.symbol} className="number">
                            <strong>{s.symbol}</strong>
                            <span className="table-subtitle">{s.name}</span>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[
                        [
                          'Latest daily price',
                          (s: Stock) => money(s.price, s.currency),
                        ],
                        [
                          'Price date',
                          (s: Stock) => s.priceDate || 'Not available',
                        ],
                        [
                          'Market cap',
                          (s: Stock) => compact(s.marketCap, s.currency),
                        ],
                        ['P/E · trailing', (s: Stock) => ratio(s.pe)],
                        ['P/S · trailing', (s: Stock) => ratio(s.ps)],
                        [
                          'Annual report period',
                          (s: Stock) =>
                            s.financials[0]?.period || 'Not available',
                        ],
                        [
                          'Revenue',
                          (s: Stock) =>
                            compact(
                              s.financials[0]?.revenue,
                              s.financials[0]?.currency || '',
                            ),
                        ],
                        [
                          'Net income',
                          (s: Stock) =>
                            compact(
                              s.financials[0]?.earnings,
                              s.financials[0]?.currency || '',
                            ),
                        ],
                        [
                          'Free cash flow',
                          (s: Stock) =>
                            compact(
                              s.financials[0]?.freeCashFlow,
                              s.financials[0]?.currency || '',
                            ),
                        ],
                        [
                          'Total debt',
                          (s: Stock) =>
                            compact(
                              s.financials[0]?.debt,
                              s.financials[0]?.currency || '',
                            ),
                        ],
                      ].map(([label, fn]) => (
                        <TableRow key={String(label)}>
                          <TableCell>{String(label)}</TableCell>
                          {compareStocks.map((s) => (
                            <TableCell className="number" key={s.symbol}>
                              {(fn as (s: Stock) => string)(s)}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="footnote">
                    Companies can have different fiscal year ends. Check the
                    reporting periods before comparing annual figures.
                  </p>
                  {compareStocks.map((s) => (
                    <div key={s.symbol} className="compare-source">
                      <strong>{s.symbol}</strong>
                      <Sources stock={s} />
                      {s.warnings.length > 0 && (
                        <p className="warning-text">
                          Some data is unavailable or saved from an earlier
                          request. Open Research for details.
                        </p>
                      )}
                    </div>
                  ))}
                </section>
              </>
            ) : (
              <Empty title="Choose companies to compare">
                Add a company with the search box above.
              </Empty>
            )}
          </TabsContent>

          <TabsContent value="watchlist">
            <div className="section-heading">
              <div>
                <h2>Your watchlist</h2>
                <p className="muted">
                  Keep the business case, questions, and next steps together.
                </p>
              </div>
              <Button variant="outline" onClick={() => setTab('research')}>
                <Plus />
                Find a stock
              </Button>
            </div>
            {!app.watchlist.length ? (
              <Empty title="Make room for your next idea">
                Open a company in Research and select Watch. Your notes will
                stay saved{' '}
                {app.storage === 'browser' ? 'in this browser' : 'on this Mac'}.
              </Empty>
            ) : (
              <div className="watch-grid">
                {app.watchlist.map((w) => {
                  const draft = drafts[w.symbol] ?? w.notes;
                  return (
                    <article className="panel watch-card" key={w.symbol}>
                      <div className="section-heading">
                        <div>
                          <button
                            className="text-link"
                            onClick={() => pick(w.symbol)}
                          >
                            {w.symbol}
                            <ArrowUpRight size={16} />
                          </button>
                          <p className="muted small">{w.name}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={pending}
                          aria-label={'Remove ' + w.symbol + ' from watchlist'}
                          onClick={() =>
                            act(
                              '/api/remove',
                              { kind: 'watch', symbol: w.symbol },
                              w.symbol + ' removed from watchlist.',
                            )
                          }
                        >
                          <Trash2 size={16} />
                        </Button>
                      </div>
                      {stocks[w.symbol] && (
                        <p className="watch-price">
                          {money(stocks[w.symbol].price)}
                          <small>
                            {stocks[w.symbol].quote?.priceAt
                              ? new Date(
                                  stocks[w.symbol].quote!.priceAt!,
                                ).toLocaleString()
                              : stocks[w.symbol].priceDate}
                          </small>
                        </p>
                      )}
                      <label
                        className="field-label"
                        htmlFor={'note-' + w.symbol}
                      >
                        Research notes
                      </label>
                      <Textarea
                        id={'note-' + w.symbol}
                        placeholder="Why am I watching this company? What would change my view?"
                        maxLength={10000}
                        value={draft}
                        onChange={(e) =>
                          setDrafts({ ...drafts, [w.symbol]: e.target.value })
                        }
                        rows={5}
                      />
                      <div className="note-footer">
                        <span>
                          {draft !== w.notes
                            ? 'Unsaved changes'
                            : 'Saved ' +
                              new Date(w.updatedAt).toLocaleDateString()}
                        </span>
                        <Button
                          size="sm"
                          disabled={pending || draft === w.notes}
                          onClick={() =>
                            act(
                              '/api/watchlist',
                              {
                                symbol: w.symbol,
                                notes: draft,
                                notesOnly: true,
                              },
                              w.symbol + ' notes saved.',
                            )
                          }
                        >
                          Save notes
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="portfolio">
            <div className="section-heading">
              <div>
                <h2>Your portfolio</h2>
                <p className="muted">Manually entered holdings · USD</p>
              </div>
              <Button
                disabled={!ready}
                onClick={() =>
                  setHolding({ symbol: '', shares: undefined, cost: undefined })
                }
              >
                <Plus />
                Add holding
              </Button>
            </div>
            <div className="metric-grid portfolio-metrics">
              <Metric
                label={
                  app.mode === 'sample' ? 'Illustrative value' : 'Market value'
                }
                value={money(marketTotal)}
                caption={
                  missing.length
                    ? missing.length + ' holding(s) need a USD price'
                    : 'Stock holdings at the latest available prices'
                }
              />
              <Metric
                label="Cost basis"
                value={money(costTotal)}
                caption="Shares × average cost per share"
              />
              <Metric
                label="Unrealized gain / loss"
                value={money(gain)}
                positive={gain == null ? undefined : gain >= 0}
                caption={
                  gain != null && costTotal > 0
                    ? percent((gain / costTotal) * 100) + ' on cost basis'
                    : 'Excludes dividends, fees, and realized returns'
                }
              />
            </div>
            {missing.length > 0 && (
              <div className="warning-box">
                The full portfolio value is unavailable until every holding has
                a USD price. The priced portion is {money(pricedTotal)}.
              </div>
            )}
            {!app.holdings.length ? (
              <Empty title="Start with your first holding">
                Find the company by name, enter the number of shares you own,
                and your average purchase cost per share.
                {app.mode === 'sample' && (
                  <Button
                    className="try-sample"
                    disabled={pending}
                    onClick={() =>
                      void act(
                        '/api/sample-portfolio',
                        {},
                        'Practice portfolio added: AAPL, RIVN, and HDRN. All prices are sample data.',
                      )
                    }
                  >
                    Try a sample portfolio
                  </Button>
                )}
              </Empty>
            ) : (
              <section className="panel">
                <div className="section-heading">
                  <h2>Holdings</h2>
                  {app.mode === 'live' && (
                    <Button
                      variant="outline"
                      disabled={Object.values(loading).some(Boolean)}
                      onClick={() => {
                        if (app.quotesConfigured) void quoteData.refresh();
                        else
                          for (const s of new Set(
                            app.holdings.map((h) => h.symbol),
                          ))
                            void loadStock(s, true);
                      }}
                    >
                      <RefreshCw />
                      Update prices
                    </Button>
                  )}
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      {[
                        'Company',
                        'Shares',
                        'Avg. cost',
                        'Latest price',
                        'Value',
                        'Gain / loss',
                        '',
                      ].map((s, i) => (
                        <TableHead key={i} className={i ? 'number' : ''}>
                          {s || <span className="sr-only">Actions</span>}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {app.holdings.map((h) => {
                      const s = stocks[h.symbol],
                        price = s?.currency === 'USD' ? s.price : null,
                        value = price == null ? null : price * h.shares,
                        pnl = value == null ? null : value - h.shares * h.cost;
                      return (
                        <TableRow key={h.id}>
                          <TableCell>
                            <button
                              className="text-link"
                              onClick={() => pick(h.symbol)}
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
                            {money(h.cost)}
                          </TableCell>
                          <TableCell className="number">
                            {loading[h.symbol] ? 'Loading…' : money(price)}
                            <span className="table-subtitle">
                              {s?.quote?.priceAt
                                ? new Date(s.quote.priceAt).toLocaleString() +
                                  ' · ' +
                                  s.quote.feed.toUpperCase()
                                : s?.priceDate ||
                                  errors[h.symbol] ||
                                  'No quote loaded'}
                            </span>
                          </TableCell>
                          <TableCell className="number">
                            {money(value)}
                          </TableCell>
                          <TableCell
                            className={
                              'number ' +
                              (pnl == null
                                ? ''
                                : pnl >= 0
                                  ? 'positive'
                                  : 'negative')
                            }
                          >
                            {money(pnl)}
                          </TableCell>
                          <TableCell className="number">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={'Edit ' + h.symbol + ' holding'}
                              onClick={() => setHolding(h)}
                            >
                              <PenLine size={15} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={pending}
                              aria-label={'Remove ' + h.symbol + ' holding'}
                              onClick={() =>
                                act(
                                  '/api/remove',
                                  { kind: 'holding', id: h.id },
                                  'Holding removed.',
                                )
                              }
                            >
                              <Trash2 size={15} />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <p className="footnote">
                  Holdings and cost basis are entered by you. Values use{' '}
                  {app.mode === 'sample'
                    ? 'illustrative sample prices'
                    : 'provider prices with the timestamps shown'}
                  ; price dates may differ. Record changes to shares, cost
                  basis, and cash manually. Dividends, fees, sales, and tax lots
                  are not tracked.
                </p>
                {marketTotal != null && marketTotal > 0 && (
                  <div className="allocation">
                    <h3>Stock allocation · excludes cash</h3>
                    {[...new Set(app.holdings.map((h) => h.symbol))].map(
                      (symbol) => {
                        const v = app.holdings
                            .filter((h) => h.symbol === symbol)
                            .reduce(
                              (sum, h) =>
                                sum + (stocks[symbol]?.price ?? 0) * h.shares,
                              0,
                            ),
                          pct = (v / marketTotal) * 100;
                        return (
                          <div className="allocation-row" key={symbol}>
                            <span>{symbol}</span>
                            <div>
                              <i style={{ width: pct + '%' }} />
                            </div>
                            <strong>{pct.toFixed(1)}%</strong>
                          </div>
                        );
                      },
                    )}
                  </div>
                )}
              </section>
            )}
            <PortfolioManager
              app={app}
              stocks={stocks}
              onSave={(body) =>
                act('/api/manager', body, 'Portfolio plan saved.')
              }
            />
          </TabsContent>
        </Tabs>
        <footer className="app-footer">
          <span>
            EquityDesk ·{' '}
            {app.storage === 'browser'
              ? 'Saved in this browser'
              : 'Saved on this Mac'}
          </span>
          <span>
            {app.mode === 'sample' ? 'Sample workspace' : 'Provider workspace'}{' '}
            · Research at your own pace
          </span>
        </footer>
        {app.storage === 'browser' && (
          <p className="footnote">
            Your holdings, notes, and practice account stay in this browser.
            They do not sync with the Mac app or other devices. Clearing this
            site’s browser data removes them.
          </p>
        )}
      </div>

      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>Choose your data</DialogTitle>
            <DialogDescription>
              Yahoo Finance is ready to use. No API key or brokerage account is
              needed.
            </DialogDescription>
          </DialogHeader>
          <div className="connection-option">
            <div>
              <strong>Archived offline demo</strong>
              <p>
                Eight companies with illustrative prices, plus your previous
                demo notes and holdings.
              </p>
            </div>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => changeMode('sample')}
            >
              Open demo archive
            </Button>
          </div>
          <div className="connection-option">
            <div>
              <strong>Real data workspace</strong>
              <p>
                Search companies by name across Nasdaq, NYSE, and other U.S.
                listings. Prices, history, and available financial reports come
                from Yahoo Finance.
              </p>
            </div>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => changeMode('live')}
            >
              Open real workspace
            </Button>
          </div>
          {app.directory && (
            <p className="footnote">
              <a href={app.directory.source} target="_blank" rel="noreferrer">
                Nasdaq Trader directory ↗
              </a>{' '}
              · {app.directory.count.toLocaleString()} searchable listings ·
              Retrieved {new Date(app.directory.fetchedAt).toLocaleString()}.
              Refreshed daily when searching. Includes ETFs and other
              securities, excludes test issues and unsupported ticker formats.{' '}
              {app.directory.warning}
            </p>
          )}
          <p className="footnote">
            Prices are checked every 30 seconds while open. Daily charts refresh
            every 15 minutes; financial reports are cached for six hours. Yahoo
            may delay or limit requests. Saved prices retain their original
            timestamps when a check fails. Missing figures stay unavailable.
            Practice trading uses a separate virtual account; no real trades are
            placed.
          </p>
          {error && (
            <p className="negative" role="alert">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={holding !== null}
        onOpenChange={(open) => {
          if (!open) setHolding(null);
        }}
      >
        <DialogContent className="holding-dialog">
          <DialogHeader>
            <DialogTitle>
              {holding?.id ? 'Edit holding' : 'Add a holding'}
            </DialogTitle>
            <DialogDescription>
              {app.mode === 'sample'
                ? 'This holding will use sample prices in your practice workspace.'
                : 'Enter the shares you currently own and your average purchase price.'}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={saveHolding}
            key={holding?.id ?? 'new'}
            className="holding-form"
          >
            <label className="field-label" htmlFor="holding-company">
              Company
            </label>
            <StockPicker
              mode={app.mode}
              inputId="holding-company"
              label="Find a company for this holding"
              disabled={pending}
              onPick={(company) =>
                setHolding((previous) => ({
                  ...previous,
                  symbol: company.symbol,
                  name: company.name,
                }))
              }
            />
            <input type="hidden" name="symbol" value={holding?.symbol ?? ''} />
            {holding?.symbol ? (
              <div className="holding-company-selection" role="status">
                <strong>
                  {holding.name ||
                    stocks[holding.symbol]?.name ||
                    holding.symbol}
                </strong>
                <span>{holding.symbol} · Selected company</span>
              </div>
            ) : (
              <p className="footnote">
                Type a company name and select a result. Its ticker is filled in
                automatically.
              </p>
            )}
            <label className="field-label" htmlFor="holding-shares">
              Number of shares
            </label>
            <Input
              name="shares"
              id="holding-shares"
              type="number"
              required
              min="0.00000001"
              max="1000000000000"
              step="any"
              placeholder="e.g. 10"
              defaultValue={holding?.shares}
            />
            <label className="field-label" htmlFor="holding-cost">
              Average cost per share (USD)
            </label>
            <Input
              name="cost"
              id="holding-cost"
              type="number"
              required
              min="0"
              max="1000000000000"
              step="any"
              placeholder="e.g. 180.50"
              defaultValue={holding?.cost}
            />
            <Button type="submit" disabled={pending || !holding?.symbol}>
              {pending ? 'Saving…' : 'Save holding'}
            </Button>
            {error && (
              <p className="negative" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
