import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newBrowserAccount,
  makePreview,
  changeAccount,
  accountState,
} from '../lib/browser-account.ts';
const now = Date.parse('2026-09-17T18:00:00Z');
const quote = (price = 10, overrides = {}) => ({
  symbol: 'RIVN',
  name: 'Rivian',
  price,
  priceAt: new Date(now - 60000).toISOString(),
  checkedAt: new Date(now).toISOString(),
  currency: 'USD',
  source: 'Yahoo Finance',
  warning: '',
  ...overrides,
});
function trade(a, side, shares, price = 10) {
  const p = makePreview(a, { symbol: 'RIVN', side, shares }, quote(price), now);
  const confirmation = { previewId: p.id, requestId: crypto.randomUUID() };
  changeAccount(a, '/api/paper/trade', confirmation, now);
  return confirmation;
}
test('browser ledger tracks fractional purchases, partial cost basis, and full sales in cents', () => {
  const a = newBrowserAccount();
  trade(a, 'buy', '2.5', 10);
  trade(a, 'buy', '2.5', 20);
  assert.equal(a.paper.cashCents, 9992500);
  trade(a, 'sell', 1, 20);
  assert.equal(a.paper.positions.RIVN.costCents, 6000);
  assert.equal(a.paper.realizedCents, 500);
  trade(a, 'sell', 4, 20);
  assert.equal(a.paper.cashCents, 10002500);
  assert.equal(a.paper.realizedCents, 2500);
  assert.deepEqual(a.paper.positions, {});
});
test('confirmations are idempotent and previews cannot be spent twice', () => {
  const a = newBrowserAccount(),
    c = trade(a, 'buy', 1);
  changeAccount(a, '/api/paper/trade', c, now);
  assert.equal(a.paper.trades.length, 1);
  assert.throws(
    () =>
      changeAccount(
        a,
        '/api/paper/trade',
        { ...c, requestId: crypto.randomUUID() },
        now,
      ),
    /already filled/,
  );
});
test('cash and shares are rechecked when confirming previews from competing tabs', () => {
  const a = newBrowserAccount();
  const p = makePreview(
    a,
    { symbol: 'RIVN', side: 'buy', shares: 6000 },
    quote(),
    now,
  );
  trade(a, 'buy', 6000);
  assert.throws(
    () =>
      changeAccount(
        a,
        '/api/paper/trade',
        { previewId: p.id, requestId: crypto.randomUUID() },
        now,
      ),
    /Not enough/,
  );
  assert.throws(
    () =>
      makePreview(
        a,
        { symbol: 'RIVN', side: 'sell', shares: 6001 },
        quote(),
        now,
      ),
    /more practice shares/,
  );
});
test('stale, missing, mismatched, non-USD and failed quotes cannot be traded', () => {
  for (const bad of [
    { price: null },
    { price: NaN },
    { price: 0 },
    { symbol: 'HDRN' },
    { currency: 'CAD' },
    { warning: 'Failed' },
    { priceAt: null },
    { checkedAt: '2026-01-01' },
    { priceAt: '2026-01-01' },
  ]) {
    assert.throws(() =>
      makePreview(
        newBrowserAccount(),
        { symbol: 'RIVN', side: 'buy', shares: 1 },
        quote(10, bad),
        now,
      ),
    );
  }
  const a = newBrowserAccount(),
    p = makePreview(
      a,
      { symbol: 'RIVN', side: 'buy', shares: 1 },
      quote(),
      now,
    );
  assert.throws(
    () =>
      changeAccount(
        a,
        '/api/paper/trade',
        { previewId: p.id, requestId: crypto.randomUUID() },
        now + 61000,
      ),
    /expired/,
  );
});
test('personal and sample workspaces stay separate from practice money and other accounts', () => {
  const a = newBrowserAccount();
  changeAccount(
    a,
    '/api/watchlist',
    { mode: 'live', symbol: 'HDRN', name: 'Hadron', notes: 'My research' },
    now,
  );
  changeAccount(
    a,
    '/api/holdings',
    { mode: 'live', symbol: 'HDRN', name: 'Hadron', shares: 2, cost: 3 },
    now,
  );
  trade(a, 'buy', 10);
  changeAccount(a, '/api/paper/reset', { confirmation: 'RESET' }, now);
  assert.equal(a.workspaces.live.holdings.length, 1);
  assert.equal(a.workspaces.live.watchlist[0].notes, 'My research');
  changeAccount(a, '/api/mode', { mode: 'sample' }, now);
  assert.equal(accountState(a, {}).holdings.length, 0);
  assert.throws(
    () =>
      changeAccount(a, '/api/watchlist', { mode: 'live', symbol: 'RIVN' }, now),
    /workspace changed/,
  );
  assert.equal(newBrowserAccount().workspaces.live.holdings.length, 0);
});
test('sub-cent and excessive precision trades are rejected without rounding share ownership', () => {
  for (const shares of ['0.000000001', 0, -2, Infinity, 'no', 1000000001]) {
    assert.throws(() =>
      makePreview(
        newBrowserAccount(),
        { symbol: 'RIVN', side: 'buy', shares },
        quote(),
        now,
      ),
    );
  }
  assert.throws(
    () =>
      makePreview(
        newBrowserAccount(),
        { symbol: 'RIVN', side: 'buy', shares: '0.00000001' },
        quote(),
        now,
      ),
    /one cent/,
  );
});
