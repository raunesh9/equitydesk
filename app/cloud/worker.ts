import listings from '../../resources/listings.json';
import { searchCompanies } from '../lib/company-search';
import { defaultManager } from '../lib/stocks';
import {
  fetchQuotes,
  fetchStock,
  fetchFundamentals,
  fetchSearch,
  dataError,
} from './market';

type Environment = { ASSETS: { fetch(request: Request): Promise<Response> } };
type Context = { waitUntil(promise: Promise<unknown>): void };
type Envelope<T> = { at: number; value: T };
const memory = new Map<string, Envelope<unknown>>();
const stamp = () => new Date().toISOString();
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
function symbol(value: string | null) {
  const s = (value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,14}$/.test(s))
    throw Error('Choose a valid company symbol.');
  return s;
}

// This cache contains public market data only. Personal data never reaches this Worker.
async function cached<T>(
  key: string,
  ttl: number,
  load: () => Promise<T>,
  ctx: Context,
  stale?: (value: T) => T,
): Promise<T> {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const url = 'https://equitydesk.cache.invalid/v2/' + encodeURIComponent(key);
  let saved = memory.get(key) as Envelope<T> | undefined;
  if (!saved) {
    const response = await cache.match(url);
    if (response) saved = (await response.json()) as Envelope<T>;
  }
  if (saved && Date.now() - saved.at < ttl * 1000) return saved.value;
  try {
    const value = await load(),
      entry = { at: Date.now(), value };
    if (memory.size > 500) memory.delete(memory.keys().next().value!);
    memory.set(key, entry);
    ctx.waitUntil(
      cache.put(
        url,
        new Response(JSON.stringify(entry), {
          headers: {
            'Cache-Control': 'public, max-age=604800',
            'Content-Type': 'application/json',
          },
        }),
      ),
    );
    return value;
  } catch (error) {
    if (saved && stale && Date.now() - saved.at < 7 * 86400000)
      return stale(saved.value);
    throw error;
  }
}
const directory = () => ({
  count: listings.results.length,
  fetchedAt: listings.fetchedAt,
  source: listings.source,
  warning:
    'Bundled listing directory; Yahoo search checks names beyond this snapshot.',
});

export default {
  async fetch(
    request: Request,
    env: Environment,
    ctx: Context,
  ): Promise<Response> {
    const url = new URL(request.url),
      p = url.pathname,
      q = url.searchParams;
    if (!p.startsWith('/api/')) {
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set(
        'Referrer-Policy',
        'strict-origin-when-cross-origin',
      );
      return response;
    }
    if (request.method !== 'GET')
      return json(
        { error: 'Personal changes are saved in your browser.' },
        405,
      );
    try {
      if (p === '/api/health')
        return json({ app: 'equitydesk', version: 4, storage: 'browser' });
      if (p === '/api/state')
        return json({
          storage: 'browser',
          mode: 'live',
          holdings: [],
          watchlist: [],
          manager: defaultManager,
          configured: true,
          provider: 'Yahoo Finance',
          quotesConfigured: true,
          quoteFeed: 'Yahoo Finance',
          refresh: { enabled: true, interval: 30 },
          directory: directory(),
        });
      if (p === '/api/directory') return json(directory());
      if (p === '/api/search') {
        const query = (q.get('q') || '').trim();
        if (query.length > 100)
          return json({ error: 'Use a shorter company name.' }, 400);
        if (!query) return json({ results: [] });
        const local = searchCompanies(listings.results, query).slice(0, 30);
        if (local.length) return json({ results: local });
        const results = await cached(
          'search:' + query.toLowerCase(),
          3600,
          () => fetchSearch(query),
          ctx,
        );
        return json({ results });
      }
      if (p === '/api/quotes') {
        const symbols = [
          ...new Set(
            (q.get('symbols') || '').split(',').filter(Boolean).map(symbol),
          ),
        ].sort();
        if (symbols.length > 20)
          return json({ error: 'Request up to 20 companies at a time.' }, 400);
        const result = await cached(
          'quotes:' + symbols.join(','),
          25,
          () => fetchQuotes(symbols),
          ctx,
          (old) => ({
            quotes: Object.fromEntries(
              Object.entries(old.quotes).map(([s, quote]) => [
                s,
                { ...quote, warning: dataError },
              ]),
            ),
            errors: Object.fromEntries(symbols.map((s) => [s, dataError])),
          }),
        );
        return json({
          ...result,
          checkedAt: stamp(),
          error: Object.keys(result.errors).length ? dataError : '',
        });
      }
      if (p === '/api/stock') {
        const s = symbol(q.get('symbol'));
        return json(
          await cached(
            'chart:' + s,
            900,
            () => fetchStock(s),
            ctx,
            (old) => ({ ...old, warnings: [...old.warnings, dataError] }),
          ),
        );
      }
      if (p === '/api/fundamentals') {
        const s = symbol(q.get('symbol'));
        const value = await cached(
          'fundamentals:' + s,
          21600,
          async () => {
            const result = await fetchFundamentals(s);
            // Partial responses stay useful without pinning a temporary outage for six hours.
            if (!result.complete)
              throw Object.assign(Error(dataError), { partial: result });
            return result;
          },
          ctx,
          (old) => ({ ...old, warnings: [...old.warnings, dataError] }),
        ).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'partial' in error)
            return error.partial;
          throw error;
        });
        return json(value);
      }
      return json({ error: 'Page not found.' }, 404);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Choose a valid company symbol.'
      )
        return json({ error: error.message }, 400);
      return json({ error: dataError }, 503);
    }
  },
};
