import type { Financial, Quote } from '../lib/stocks.ts';

export type Row = Record<string, unknown>;
export const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
export const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
export const string = (value: unknown) =>
  typeof value === 'string' ? value : '';
export function timestamp(value: unknown): string | null {
  if (
    !(value instanceof Date) &&
    typeof value !== 'number' &&
    typeof value !== 'string'
  )
    return null;
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function normalizeQuote(
  symbol: string,
  value: unknown,
  checkedAt: string,
): Quote {
  const q = row(value),
    sessions: NonNullable<Quote['sessions']> = {};
  for (const [session, prefix] of [
    ['regular', 'regularMarket'],
    ['pre', 'preMarket'],
    ['post', 'postMarket'],
  ] as const) {
    const priceAt = timestamp(q[prefix + 'Time']),
      price = finite(q[prefix + 'Price']);
    if (
      !priceAt ||
      price == null ||
      price <= 0 ||
      Date.parse(priceAt) > Date.parse(checkedAt) + 120000
    )
      continue;
    let key: NonNullable<Quote['priceSession']> = session;
    // A market-state string alone must never relabel yesterday's after-hours quote.
    const zone = string(q.exchangeTimezoneName) || string(q.timeZoneFullName);
    if (session === 'post' && zone === 'America/New_York') {
      const hour = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(priceAt)),
      );
      if (
        (hour >= 20 || hour < 4) &&
        (['PREPRE', 'POSTPOST'].includes(string(q.marketState)) ||
          /BOATS|Blue Ocean/i.test(string(q.postMarketSource)))
      )
        key = 'overnight';
    }
    sessions[key] = {
      price,
      priceAt,
      changePercent: finite(q[prefix + 'ChangePercent']),
    };
  }
  const newest = (
    Object.entries(sessions) as [
      NonNullable<Quote['priceSession']>,
      NonNullable<Quote['sessions']>['regular'],
    ][]
  ).sort((a, b) => Date.parse(b[1]!.priceAt) - Date.parse(a[1]!.priceAt))[0];
  const priceSession = newest?.[0] || 'regular',
    point = newest?.[1],
    price = point?.price ?? null,
    priceAt = point?.priceAt ?? null;
  return {
    symbol,
    name: string(q.longName) || string(q.shortName) || symbol,
    price,
    priceAt,
    checkedAt,
    priceSession,
    sessions,
    currency: string(q.currency),
    feed: 'Yahoo Finance',
    source: 'Yahoo Finance',
    sourceUrl:
      'https://finance.yahoo.com/quote/' +
      encodeURIComponent(symbol.replace('.', '-')) +
      '/',
    changePercent: point?.changePercent ?? null,
    marketState: string(q.marketState) || 'UNKNOWN',
    delayMinutes: finite(q.exchangeDataDelayedBy),
    warning:
      price == null
        ? 'Yahoo did not provide a valid price and market timestamp.'
        : '',
  };
}

// Read raw time series to retain reported zeros and the currency on each figure.
// Never combine different currencies or synthesize a missing statement figure.
export function financialRows(value: unknown): Financial[] {
  const result = row(row(value).timeseries).result;
  if (!Array.isArray(result)) return [];
  const mapping: Record<string, keyof Financial> = {
    annualTotalRevenue: 'revenue',
    annualNetIncome: 'earnings',
    annualOperatingCashFlow: 'operatingCashFlow',
    annualCapitalExpenditure: 'capex',
    annualFreeCashFlow: 'freeCashFlow',
    annualTotalDebt: 'debt',
    annualCashAndCashEquivalents: 'cash',
  };
  const periods = new Map<string, Financial>();
  for (const item of result)
    for (const [field, dest] of Object.entries(mapping)) {
      const values = row(item)[field];
      if (!Array.isArray(values)) continue;
      for (const v of values) {
        const r = row(v),
          date = string(r.asOfDate),
          currency = string(r.currencyCode),
          number = finite(row(r.reportedValue).raw);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !/^[A-Z]{3}$/.test(currency) ||
          number == null ||
          r.periodType !== '12M'
        )
          continue;
        const key = date + ':' + currency;
        const f = periods.get(key) ?? {
          period: date,
          currency,
          revenue: null,
          earnings: null,
          operatingCashFlow: null,
          capex: null,
          freeCashFlow: null,
          debt: null,
          cash: null,
        };
        Object.assign(f, { [dest]: number });
        periods.set(key, f);
      }
    }
  return [...periods.values()]
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, 5);
}
