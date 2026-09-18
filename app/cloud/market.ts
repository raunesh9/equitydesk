import YahooFinance from 'yahoo-finance2';
import { ExtendedCookieJar } from 'yahoo-finance2/lib/cookieJar';
import type { Quote, Stock } from '../lib/stocks.ts';
import {
  finite,
  financialRows,
  normalizeQuote,
  row,
  string,
  timestamp,
} from './normalize.ts';

const quiet = () => {};
let retryAfter = 0;
const yahooFetch: typeof fetch = async (input, options) => {
  if (Date.now() < retryAfter)
    throw Error('Yahoo is limiting requests. Please retry in two minutes.');
  const headers = new Headers(options?.headers);
  if (!headers.has('User-Agent'))
    headers.set('User-Agent', 'EquityDesk/1.0 (personal investment research)');
  const response = await fetch(input, {
    ...options,
    headers,
    signal: options?.signal ?? AbortSignal.timeout(12000),
  });
  if (response.status === 429) retryAfter = Date.now() + 120000;
  return response;
};
// Workers cannot share pending I/O or queue timers between request contexts.
const client = () =>
  new YahooFinance({
    suppressNotices: ['yahooSurvey'],
    versionCheck: false,
    fetch: yahooFetch,
    cookieJar: new ExtendedCookieJar(),
    logger: {
      info: quiet,
      warn: quiet,
      error: quiet,
      debug: quiet,
      dir: quiet,
    },
    queue: { concurrency: 3 },
  });
const yahooSymbol = (symbol: string) => symbol.replace('.', '-');
export const dataError =
  'Yahoo data is temporarily unavailable. Please retry shortly. Previously shown prices retain their original timestamps.';

export async function fetchQuote(symbol: string): Promise<Quote> {
  const result = await fetchQuotes([symbol]);
  if (!result.quotes[symbol]) throw Error(result.errors[symbol] || dataError);
  return result.quotes[symbol];
}
export async function fetchQuotes(symbols: string[]) {
  const quotes: Record<string, Quote> = {},
    errors: Record<string, string> = {};
  if (!symbols.length) return { quotes, errors };
  // A batch uses one Yahoo session, keeping large portfolios within Worker limits.
  const results = await client().quote(symbols.map(yahooSymbol));
  const checkedAt = new Date().toISOString();
  for (const symbol of symbols) {
    const value = results.find((q) => q.symbol === yahooSymbol(symbol));
    const quote = normalizeQuote(symbol, value, checkedAt);
    if (!value || quote.warning) errors[symbol] = quote.warning || dataError;
    else quotes[symbol] = quote;
  }
  return { quotes, errors };
}
export async function fetchStock(symbol: string): Promise<Stock> {
  const chart = await client().chart(yahooSymbol(symbol), {
    period1: new Date(Date.now() - 5 * 366 * 86400000),
    interval: '1d',
  });
  const checkedAt = new Date().toISOString(),
    meta = chart.meta,
    quote = normalizeQuote(symbol, meta, checkedAt);
  return {
    symbol,
    name: quote.name || symbol,
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    currency: meta.currency || '',
    sector: '',
    description: '',
    price: quote.price,
    priceDate: quote.priceAt,
    marketCap: null,
    pe: null,
    ps: null,
    financials: [],
    history: chart.quotes.flatMap((p) => {
      const date = timestamp(p.date),
        n = finite(p.close);
      return date && n != null && n > 0
        ? [{ date: date.slice(0, 10), close: n }]
        : [];
    }),
    source: 'Yahoo Finance',
    sourceUrl: quote.sourceUrl,
    fetchedAt: checkedAt,
    mode: 'live',
    quote,
    historyFeed: 'Yahoo Finance · daily closing prices',
    updated: { history: checkedAt },
    warnings: quote.warning ? [quote.warning] : [],
  };
}
export async function fetchFundamentals(symbol: string) {
  const ys = yahooSymbol(symbol),
    url = new URL(
      'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/' +
        encodeURIComponent(ys),
    );
  url.search = new URLSearchParams({
    type: [
      'TotalRevenue',
      'NetIncome',
      'OperatingCashFlow',
      'CapitalExpenditure',
      'FreeCashFlow',
      'TotalDebt',
      'CashAndCashEquivalents',
    ]
      .map((k) => 'annual' + k)
      .join(','),
    period1: String(Math.floor(Date.now() / 1000) - 6 * 366 * 86400),
    period2: String(Math.floor(Date.now() / 1000)),
  }).toString();
  const [details, statements] = await Promise.allSettled([
    client().quoteSummary(ys, {
      modules: [
        'assetProfile',
        'price',
        'summaryDetail',
        'defaultKeyStatistics',
        'financialData',
      ],
    }),
    yahooFetch(url).then(async (r) => {
      if (!r.ok) throw Error('Yahoo statements returned HTTP ' + r.status);
      const d: unknown = await r.json();
      if (row(row(d).timeseries).error) throw Error(dataError);
      return financialRows(d);
    }),
  ]);
  if (details.status === 'rejected' && statements.status === 'rejected')
    throw Error(dataError);
  if (statements.status === 'rejected')
    console.warn(
      'Yahoo annual statements unavailable:',
      statements.reason instanceof Error
        ? statements.reason.message
        : 'Invalid response',
    );
  const d = details.status === 'fulfilled' ? details.value : {},
    stamp = new Date().toISOString();
  const financials = statements.status === 'fulfilled' ? statements.value : [];
  return {
    sector: d.assetProfile?.sector || '',
    description: d.assetProfile?.longBusinessSummary || '',
    marketCap: finite(d.price?.marketCap),
    pe: finite(d.summaryDetail?.trailingPE),
    ps: finite(d.summaryDetail?.priceToSalesTrailing12Months),
    financials,
    updated: {
      ...(details.status === 'fulfilled' ? { profile: stamp } : {}),
      ...(statements.status === 'fulfilled' ? { financials: stamp } : {}),
    },
    warnings: [
      ...(details.status === 'rejected'
        ? ['Yahoo company details are temporarily unavailable.']
        : []),
      ...(statements.status === 'rejected'
        ? ['Yahoo financial statements are temporarily unavailable.']
        : financials.length
          ? []
          : [
              'Yahoo has no annual financial statements available for this company.',
            ]),
    ],
    complete:
      details.status === 'fulfilled' && statements.status === 'fulfilled',
  };
}
export async function fetchSearch(query: string) {
  const result = await client().search(query, {
    quotesCount: 20,
    newsCount: 0,
  });
  return result.quotes.flatMap((value) => {
    const q = row(value),
      symbol = string(q.symbol),
      kind = string(q.quoteType);
    return /^[A-Z][A-Z0-9.\-]{0,14}$/.test(symbol) &&
      ['EQUITY', 'ETF'].includes(kind)
      ? [
          {
            symbol,
            name: string(q.longname) || string(q.shortname) || symbol,
            exchange: string(q.exchDisp),
            currency: '',
            kind,
          },
        ]
      : [];
  });
}
