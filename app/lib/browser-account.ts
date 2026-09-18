import {
  defaultManager,
  sessionLabel,
  type AppState,
  type Quote,
  type Holding,
  type Watch,
  type ManagerSettings,
} from './stocks.ts';

type Workspace = {
  holdings: Holding[];
  watchlist: Watch[];
  manager: ManagerSettings;
  nextId: number;
};
type Preview = {
  id: string;
  symbol: string;
  name: string;
  side: 'buy' | 'sell';
  shares: string;
  price: string;
  amount: number;
  amountCents: number;
  quoteAt: string;
  checkedAt: string;
  source: string;
  marketState: string;
  priceSession?: Quote['priceSession'];
  expiresAt: number;
};
type Trade = Preview & {
  requestId: string;
  tradeId: number;
  realizedCents: number;
  filledAt: string;
};
export type BrowserAccount = {
  version: 1;
  mode: 'live' | 'sample';
  workspaces: Record<'live' | 'sample', Workspace>;
  refresh: { enabled: boolean; interval: number };
  paper: {
    cashCents: number;
    realizedCents: number;
    positions: Record<
      string,
      { name: string; units: string; costCents: number }
    >;
    previews: Record<string, Preview>;
    trades: Trade[];
  };
};
const SCALE = BigInt(100000000);
const emptyWorkspace = (): Workspace => ({
  holdings: [],
  watchlist: [],
  manager: structuredClone(defaultManager),
  nextId: 1,
});
export const newBrowserAccount = (): BrowserAccount => ({
  version: 1,
  mode: 'live',
  workspaces: { live: emptyWorkspace(), sample: emptyWorkspace() },
  refresh: { enabled: true, interval: 30 },
  paper: {
    cashCents: 10000000,
    realizedCents: 0,
    positions: {},
    previews: {},
    trades: [],
  },
});
function symbol(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[A-Z][A-Z0-9.\-]{0,14}$/.test(value.trim().toUpperCase())
  )
    throw Error('Choose a valid company.');
  return value.trim().toUpperCase();
}
function text(value: unknown, max: number) {
  if (typeof value !== 'string' || value.length > max)
    throw Error('This text is missing or too long.');
  return value;
}
function amount(value: unknown, positive = false, limit = 1e12) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (positive && value <= 0) ||
    value > limit
  )
    throw Error('Enter a valid positive amount.');
  return value;
}
export function shareUnits(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw Error('Enter a valid share amount.');
  const n = Number(value);
  if (
    !Number.isFinite(n) ||
    n < 0.00000001 ||
    n > 1e9 ||
    Number(n.toFixed(8)) !== n
  )
    throw Error(
      'Enter a positive share amount with up to eight decimal places.',
    );
  return BigInt(n.toFixed(8).replace('.', ''));
}
function rounded(n: bigint, divisor: bigint) {
  return (n + divisor / BigInt(2)) / divisor;
}
function safeCents(value: bigint) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw Error(
      'The practice trade must be worth at least one cent and within the supported range.',
    );
  return n;
}
export function accountState(
  account: BrowserAccount,
  base: AppState,
): AppState {
  const w = account.workspaces[account.mode],
    p = account.paper;
  return {
    ...base,
    mode: account.mode,
    holdings: w.holdings,
    watchlist: w.watchlist,
    manager: w.manager,
    refresh: account.refresh,
    paper: {
      cash: p.cashCents / 100,
      initialCash: 100000,
      realizedGain: p.realizedCents / 100,
      holdings: Object.entries(p.positions).map(([symbol, h]) => ({
        symbol,
        name: h.name,
        shares: Number(h.units) / 1e8,
        costBasis: h.costCents / 100,
      })),
      trades: p.trades
        .slice(-100)
        .reverse()
        .map((t) => ({
          id: t.tradeId,
          symbol: t.symbol,
          name: t.name,
          side: t.side,
          shares: Number(t.shares),
          price: Number(t.price),
          amount: t.amount,
          realizedGain: t.realizedCents / 100,
          filledAt: t.filledAt,
          quoteAt: t.quoteAt,
          source: t.source,
        })),
    },
  };
}
function available(
  account: BrowserAccount,
  symbol: string,
  side: string,
  units: bigint,
  cents: number,
) {
  if (side === 'buy' && account.paper.cashCents < cents)
    throw Error('Not enough virtual cash for this purchase.');
  if (
    side === 'sell' &&
    BigInt(account.paper.positions[symbol]?.units || '0') < units
  )
    throw Error('You cannot sell more practice shares than you own.');
}
export function makePreview(
  account: BrowserAccount,
  body: Record<string, unknown>,
  quote: Quote,
  now = Date.now(),
): Preview {
  const s = symbol(body.symbol),
    units = shareUnits(body.shares),
    side = body.side;
  if (side !== 'buy' && side !== 'sell') throw Error('Choose Buy or Sell.');
  if (
    quote.symbol !== s ||
    quote.currency !== 'USD' ||
    quote.warning ||
    quote.price == null ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0 ||
    quote.price > 1e9
  )
    throw Error(
      'A successfully checked Yahoo USD price is required to preview a practice trade.',
    );
  const priceAt = Date.parse(quote.priceAt || ''),
    checkedAt = Date.parse(quote.checkedAt);
  if (
    !Number.isFinite(priceAt) ||
    !Number.isFinite(checkedAt) ||
    now - priceAt < -120000 ||
    now - priceAt > 7 * 86400000 ||
    now - checkedAt < -120000 ||
    now - checkedAt > 300000
  )
    throw Error(
      'This Yahoo price is too old for a practice trade. Refresh and try again.',
    );
  const price = quote.price.toFixed(6),
    microPrice = BigInt(price.replace('.', ''));
  const cents = safeCents(rounded(units * microPrice, SCALE * BigInt(10000)));
  available(account, s, side, units, cents);
  const preview: Preview = {
    id: crypto.randomUUID(),
    symbol: s,
    name: quote.name || s,
    side,
    shares: Number(body.shares).toFixed(8),
    price,
    amount: cents / 100,
    amountCents: cents,
    quoteAt: quote.priceAt!,
    checkedAt: quote.checkedAt,
    source: quote.source + ' · ' + sessionLabel(quote.priceSession),
    priceSession: quote.priceSession,
    marketState: quote.marketState || 'UNKNOWN',
    expiresAt: (now + 60000) / 1000,
  };
  account.paper.previews = Object.fromEntries(
    Object.entries(account.paper.previews).filter(
      ([, p]) => p.expiresAt * 1000 >= now,
    ),
  );
  account.paper.previews[preview.id] = preview;
  return preview;
}
export function changeAccount(
  account: BrowserAccount,
  path: string,
  body: Record<string, unknown>,
  now = Date.now(),
) {
  const workspace = account.workspaces[account.mode],
    stamp = new Date(now).toISOString();
  if (
    [
      '/api/watchlist',
      '/api/holdings',
      '/api/remove',
      '/api/manager',
      '/api/sample-portfolio',
    ].includes(path) &&
    body.mode !== account.mode
  )
    throw Error('The workspace changed in another tab. Reload before saving.');
  if (path === '/api/mode') {
    if (body.mode !== 'live' && body.mode !== 'sample')
      throw Error('Choose sample or provider data.');
    account.mode = body.mode;
  } else if (path === '/api/refresh-settings') {
    if (
      typeof body.enabled !== 'boolean' ||
      ![30, 60, 120].includes(Number(body.interval))
    )
      throw Error('Choose a valid update interval.');
    account.refresh = {
      enabled: body.enabled,
      interval: Number(body.interval),
    };
  } else if (path === '/api/watchlist') {
    const s = symbol(body.symbol),
      existing = workspace.watchlist.find((w) => w.symbol === s),
      notes = text(body.notes ?? '', 10000);
    if (body.notesOnly) {
      if (!existing) throw Error('Add this company to your watchlist first.');
      existing.notes = notes;
      existing.updatedAt = stamp;
    } else if (!existing)
      workspace.watchlist.push({
        symbol: s,
        name: text(body.name ?? s, 200) || s,
        notes,
        updatedAt: stamp,
      });
  } else if (path === '/api/holdings') {
    const s = symbol(body.symbol),
      shares = amount(body.shares, true, 1e9),
      cost = amount(body.cost);
    if (body.currency !== undefined && body.currency !== 'USD')
      throw Error('Holdings are tracked in USD.');
    const holding = {
      symbol: s,
      name: text(body.name ?? s, 200) || s,
      shares,
      cost,
      currency: 'USD',
    };
    if (body.id !== undefined) {
      const old = workspace.holdings.find((h) => h.id === body.id);
      if (!old) throw Error('This holding could not be found.');
      Object.assign(old, holding);
    } else workspace.holdings.push({ ...holding, id: workspace.nextId++ });
  } else if (path === '/api/remove') {
    if (body.kind === 'watch')
      workspace.watchlist = workspace.watchlist.filter(
        (w) => w.symbol !== symbol(body.symbol),
      );
    else if (body.kind === 'holding' && Number.isInteger(body.id))
      workspace.holdings = workspace.holdings.filter((h) => h.id !== body.id);
    else throw Error('Choose a valid item to remove.');
  } else if (path === '/api/manager') {
    const cash = amount(body.cash),
      concentrationLimit = amount(body.concentrationLimit, true, 100),
      driftLimit = amount(body.driftLimit, true, 100);
    if (
      concentrationLimit < 1 ||
      driftLimit < 0.1 ||
      !body.targets ||
      typeof body.targets !== 'object' ||
      Array.isArray(body.targets)
    )
      throw Error('Enter valid allocation targets and alert thresholds.');
    const entries = Object.entries(body.targets);
    if (entries.length > 200) throw Error('Use up to 200 company targets.');
    const targets = Object.fromEntries(
      entries.map(([s, v]) => [symbol(s), amount(v, false, 100)]),
    );
    if (Object.values(targets).reduce((a, b) => a + b, 0) > 100.0000001)
      throw Error('Stock targets cannot add up to more than 100%.');
    workspace.manager = { cash, concentrationLimit, driftLimit, targets };
  } else if (path === '/api/sample-portfolio') {
    if (account.mode !== 'sample' || workspace.holdings.length)
      throw Error(
        'Open an empty sample portfolio to add demonstration holdings.',
      );
    workspace.holdings = [
      {
        id: workspace.nextId++,
        symbol: 'AAPL',
        name: 'Apple Inc.',
        shares: 3,
        cost: 180,
        currency: 'USD',
      },
      {
        id: workspace.nextId++,
        symbol: 'RIVN',
        name: 'Rivian Automotive, Inc.',
        shares: 30,
        cost: 14,
        currency: 'USD',
      },
      {
        id: workspace.nextId++,
        symbol: 'HDRN',
        name: 'Hadron Energy, Inc.',
        shares: 40,
        cost: 10,
        currency: 'USD',
      },
    ];
    workspace.manager = {
      cash: 500,
      targets: { AAPL: 35, RIVN: 35, HDRN: 20 },
      concentrationLimit: 25,
      driftLimit: 5,
    };
  } else if (path === '/api/paper/reset') {
    if (body.confirmation !== 'RESET')
      throw Error('Confirm resetting the practice account first.');
    account.paper = newBrowserAccount().paper;
  } else if (path === '/api/paper/trade') {
    const requestId = text(body.requestId, 80),
      previewId = text(body.previewId, 80),
      ledger = account.paper;
    if (!/^[a-f0-9-]{36}$/i.test(requestId))
      throw Error('Preview the trade before confirming.');
    const previous = ledger.trades.find((t) => t.requestId === requestId);
    if (previous) {
      if (previous.id !== previewId)
        throw Error('That confirmation was already used for another trade.');
      return;
    }
    if (ledger.trades.some((t) => t.id === previewId))
      throw Error(
        'This preview was already filled. No duplicate trade was made.',
      );
    const p = ledger.previews[previewId];
    if (!p || p.expiresAt * 1000 < now)
      throw Error('The preview expired. Get a new price before confirming.');
    const units = shareUnits(p.shares),
      cents = p.amountCents;
    available(account, p.symbol, p.side, units, cents);
    const old = ledger.positions[p.symbol],
      oldUnits = BigInt(old?.units || '0'),
      oldCost = old?.costCents || 0;
    let remaining: bigint,
      basis: number,
      realized = 0;
    if (p.side === 'buy') {
      remaining = oldUnits + units;
      basis = oldCost + cents;
      ledger.cashCents -= cents;
    } else {
      const soldBasis =
        units === oldUnits
          ? oldCost
          : Number(rounded(BigInt(oldCost) * units, oldUnits));
      remaining = oldUnits - units;
      basis = oldCost - soldBasis;
      realized = cents - soldBasis;
      ledger.cashCents += cents;
    }
    if (!Number.isSafeInteger(ledger.cashCents) || !Number.isSafeInteger(basis))
      throw Error('The account exceeds the supported amount range.');
    if (remaining > BigInt(0))
      ledger.positions[p.symbol] = {
        name: p.name,
        units: String(remaining),
        costCents: basis,
      };
    else delete ledger.positions[p.symbol];
    ledger.realizedCents += realized;
    ledger.trades.push({
      ...p,
      requestId,
      tradeId: ledger.trades.length + 1,
      realizedCents: realized,
      filledAt: stamp,
    });
  } else throw Error('This action is not available on the website.');
}
