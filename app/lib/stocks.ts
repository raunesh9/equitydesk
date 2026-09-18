export type Financial = {
  period: string;
  currency: string;
  revenue: number | null;
  earnings: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  freeCashFlow: number | null;
  debt: number | null;
  cash: number | null;
};
export type Stock = {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  sector: string;
  description: string;
  price: number | null;
  priceDate: string | null;
  marketCap: number | null;
  pe: number | null;
  ps: number | null;
  financials: Financial[];
  history: { date: string; close: number }[];
  source: string;
  sourceUrl: string;
  fetchedAt: string;
  mode: 'sample' | 'live';
  warnings: string[];
  updated?: Record<string, string>;
  quote?: Quote;
  historyFeed?: string;
};
export type Quote = {
  priceSession?: 'regular' | 'pre' | 'post' | 'overnight';
  sessions?: Partial<
    Record<
      'regular' | 'pre' | 'post' | 'overnight',
      { price: number; priceAt: string; changePercent: number | null }
    >
  >;
  symbol: string;
  price: number | null;
  priceAt: string | null;
  checkedAt: string;
  currency: string;
  feed: string;
  source: string;
  sourceUrl: string;
  changePercent: number | null;
  warning: string;
  name?: string;
  marketState?: string;
  delayMinutes?: number | null;
};
export type ManagerSettings = {
  cash: number;
  targets: Record<string, number>;
  concentrationLimit: number;
  driftLimit: number;
};
export const sessionLabel = (session?: string) =>
  ({
    regular: 'Regular session',
    pre: 'Pre-market',
    post: 'After-hours',
    overnight: 'Overnight',
  })[session || 'regular'] || 'Latest available';
export const defaultManager: ManagerSettings = {
  cash: 0,
  targets: {},
  concentrationLimit: 25,
  driftLimit: 5,
};
export type Holding = {
  id: number;
  symbol: string;
  name: string;
  shares: number;
  cost: number;
  currency: string;
};
export type Watch = {
  symbol: string;
  name: string;
  notes: string;
  updatedAt: string;
};
export type AppState = {
  storage?: 'browser';
  mode: 'sample' | 'live';
  watchlist: Watch[];
  holdings: Holding[];
  configured: boolean;
  provider: string;
  paper?: PaperAccount;
  manager?: ManagerSettings;
  quotesConfigured?: boolean;
  quoteFeed?: string;
  refresh?: { enabled: boolean; interval: number };
  directory?: {
    count: number;
    fetchedAt: string;
    source: string;
    warning: string;
  };
};
export type PaperAccount = {
  cash: number;
  initialCash: number;
  realizedGain: number;
  holdings: {
    symbol: string;
    name: string;
    shares: number;
    costBasis: number;
  }[];
  trades: {
    id: number;
    symbol: string;
    name: string;
    side: 'buy' | 'sell';
    shares: number;
    price: number;
    amount: number;
    realizedGain: number;
    filledAt: string;
    quoteAt: string;
    source: string;
  }[];
};
export const money = (n: number | null | undefined, currency = 'USD') =>
  n == null || !currency || !/^[A-Z]{3}$/.test(currency)
    ? 'Not available'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: 2,
      }).format(n);
export const compact = (n: number | null | undefined, currency = 'USD') =>
  n == null || !currency || !/^[A-Z]{3}$/.test(currency)
    ? 'Not available'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        notation: 'compact',
        maximumFractionDigits: 2,
      }).format(n);
export const ratio = (n: number | null | undefined) =>
  n == null ? 'Not available' : n.toFixed(2) + '×';
export const percent = (n: number | null | undefined) =>
  n == null ? 'Not available' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
export function pointsFor(stock: Stock, range: string) {
  const pts = stock.history;
  if (!pts.length) return [];
  const end = new Date(pts[pts.length - 1].date + 'T12:00:00Z'),
    start = new Date(end);
  if (range === '1M') start.setMonth(start.getMonth() - 1);
  else if (range === '3M') start.setMonth(start.getMonth() - 3);
  else if (range === '1Y') start.setFullYear(start.getFullYear() - 1);
  else return pts;
  return pts.filter((p) => new Date(p.date + 'T12:00:00Z') >= start);
}
export function priceReturn(stock: Stock, range: string) {
  const p = pointsFor(stock, range);
  return p.length > 1 && p[0].close > 0
    ? (p[p.length - 1].close / p[0].close - 1) * 100
    : null;
}
const profiles = [
  [
    'RIVN',
    'Rivian Automotive, Inc.',
    'Consumer Discretionary',
    'Electric vehicles and related services. These sample figures are only for trying the app.',
    16.25,
    18,
    null,
    3.6,
    5,
    -1.8,
    -1.2,
    4,
  ],
  [
    'HDRN',
    'Hadron Energy, Inc.',
    'Energy',
    'Nuclear energy company. This demonstration has synthetic prices; financial reports are intentionally unavailable.',
    12.5,
    0.8,
    null,
    null,
    0,
    0,
    0,
    0,
  ],
  [
    'AAPL',
    'Apple Inc.',
    'Technology',
    'Consumer devices, software, and services. Explore how hardware sales and recurring services contribute to the business.',
    224.6,
    3460,
    31.8,
    8.5,
    402,
    102,
    113,
    99,
  ],
  [
    'MSFT',
    'Microsoft Corporation',
    'Technology',
    'Business software, cloud infrastructure, and productivity tools, with subscriptions and enterprise services.',
    438.2,
    3270,
    35.4,
    12.6,
    262,
    93,
    76,
    51,
  ],
  [
    'NVDA',
    'NVIDIA Corporation',
    'Technology',
    'Computing platforms for data centers, artificial intelligence, and graphics. Results depend on demand for computing infrastructure.',
    132.8,
    3230,
    43.2,
    23.6,
    137,
    75,
    61,
    9,
  ],
  [
    'GOOGL',
    'Alphabet Inc.',
    'Communication Services',
    'Search, digital advertising, cloud services, and other technology businesses serving consumers and enterprises.',
    181.4,
    2230,
    22.4,
    6.1,
    363,
    100,
    78,
    14,
  ],
  [
    'AMZN',
    'Amazon.com Inc.',
    'Consumer Discretionary',
    'Online retail, third-party seller services, advertising, and cloud computing, each with different margins and investment needs.',
    208.9,
    2190,
    36.3,
    3.5,
    628,
    60,
    40,
    61,
  ],
  [
    'IBM',
    'International Business Machines',
    'Technology',
    'Enterprise software, consulting, and computing infrastructure for large organizations.',
    242.7,
    226,
    24.5,
    3.6,
    63,
    9,
    12,
    56,
  ],
] as const;
export const sampleStocks: Stock[] = profiles.map((p, index) => {
  const [
    symbol,
    name,
    sector,
    description,
    price,
    marketCap,
    pe,
    ps,
    revenue,
    earnings,
    fcf,
    debt,
  ] = p;
  const history: { date: string; close: number }[] = [];
  const d = new Date('2025-09-08T12:00:00Z');
  let i = 0;
  while (d <= new Date('2026-09-08T12:00:00Z')) {
    if (d.getUTCDay() % 6 !== 0) {
      history.push({
        date: d.toISOString().slice(0, 10),
        close:
          price *
          (0.76 +
            i * 0.00085 +
            Math.sin(i * 0.06 + index) * 0.035 +
            Math.sin(i * 0.47 + index) * 0.009),
      });
      i++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const scale = price / history[history.length - 1].close;
  return {
    symbol,
    name,
    sector,
    description,
    exchange: symbol === 'IBM' ? 'NYSE' : 'NASDAQ',
    currency: 'USD',
    price,
    priceDate: '2026-09-08',
    marketCap: marketCap * 1e9,
    pe,
    ps,
    history: history.map((p) => ({
      ...p,
      close: Math.round(p.close * scale * 100) / 100,
    })),
    mode: 'sample',
    source: 'Illustrative sample dataset',
    sourceUrl: '',
    fetchedAt: '2026-09-09T12:00:00Z',
    warnings: [],
    financials:
      symbol === 'HDRN'
        ? []
        : [2025, 2024, 2023].map((year, n) => ({
            period: year + '-12-31',
            currency: 'USD',
            revenue: revenue * 1e9 * (1 - n * 0.095),
            earnings: earnings * 1e9 * (1 - n * 0.12),
            operatingCashFlow: (fcf + 18) * 1e9 * (1 - n * 0.1),
            capex: 18e9 * (1 - n * 0.1),
            freeCashFlow: fcf * 1e9 * (1 - n * 0.1),
            debt: debt * 1e9 * (1 + n * 0.04),
            cash: (20 + index * 6) * 1e9,
          })),
  };
});
export function portfolioTotals(
  holdings: Holding[],
  stocks: Record<string, Stock>,
) {
  const costTotal = holdings.reduce((sum, h) => sum + h.shares * h.cost, 0);
  const missing = holdings.filter(
    (h) =>
      stocks[h.symbol]?.price == null || stocks[h.symbol]?.currency !== 'USD',
  );
  const pricedTotal = holdings.reduce(
    (sum, h) =>
      sum +
      (stocks[h.symbol]?.currency === 'USD'
        ? (stocks[h.symbol]?.price ?? 0) * h.shares
        : 0),
    0,
  );
  const marketTotal = missing.length ? null : pricedTotal;
  return {
    costTotal,
    missing,
    pricedTotal,
    marketTotal,
    gain: marketTotal == null ? null : marketTotal - costTotal,
  };
}
