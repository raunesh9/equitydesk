import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePortfolio } from '../lib/manager.ts';
import { defaultManager, sampleStocks } from '../lib/stocks.ts';
const now = Date.parse('2026-09-09T15:00:00Z');
const stock = {
  ...sampleStocks[0],
  price: 10,
  currency: 'USD',
  mode: 'sample',
};
const holding = (symbol, shares, id = 1) => ({
  id,
  symbol,
  name: symbol,
  shares,
  cost: 8,
  currency: 'USD',
});
test('rebalance accounts for cash and combines multiple lots without creating money', () => {
  const settings = {
    ...defaultManager,
    cash: 200,
    targets: { RIVN: 40, HDRN: 40 },
  };
  const a = analyzePortfolio(
    [holding('RIVN', 20), holding('RIVN', 40, 2), holding('HDRN', 20)],
    { RIVN: stock, HDRN: stock },
    settings,
    now,
  );
  assert.equal(a.total, 1000);
  assert.equal(a.canRebalance, true);
  assert.equal(a.positions[0].weight, 60);
  assert.equal(a.positions[0].shares, 60);
  assert.equal(a.plan.find((p) => p.symbol === 'RIVN').shareChange, -20);
  assert.equal(a.plan.find((p) => p.symbol === 'HDRN').shareChange, 20);
  const remaining =
    settings.cash - a.plan.reduce((sum, p) => sum + p.difference, 0);
  assert.equal(remaining, (a.total * a.cashTarget) / 100);
});
test('blank target does not imply sell everything', () => {
  const a = analyzePortfolio(
    [holding('RIVN', 10)],
    { RIVN: stock },
    { ...defaultManager, targets: {} },
    now,
  );
  assert.equal(a.canRebalance, false);
  assert.equal(a.plan.length, 0);
  assert.equal(a.unset[0].symbol, 'RIVN');
});
test('explicit zero target produces exit to cash', () => {
  const a = analyzePortfolio(
    [holding('RIVN', 10)],
    { RIVN: stock },
    { ...defaultManager, targets: { RIVN: 0 } },
    now,
  );
  assert.equal(a.plan[0].shareChange, -10);
  assert.equal(a.cashTarget, 100);
});
test('missing price prevents a complete total or executable-looking plan', () => {
  const a = analyzePortfolio(
    [holding('RIVN', 10), holding('HDRN', 10)],
    { RIVN: stock },
    { ...defaultManager, targets: { RIVN: 50, HDRN: 50 } },
    now,
  );
  assert.equal(a.total, null);
  assert.equal(a.canRebalance, false);
  assert.equal(a.plan.length, 0);
});
test('old live quotes and provider failures pause rebalancing', () => {
  for (const quote of [
    { priceAt: '2026-09-09T14:00:00Z', warning: '' },
    { priceAt: '2026-09-09T15:00:00Z', warning: 'Feed error' },
    undefined,
  ]) {
    const a = analyzePortfolio(
      [holding('RIVN', 10)],
      { RIVN: { ...stock, mode: 'live', quote } },
      { ...defaultManager, targets: { RIVN: 50 } },
      now,
    );
    assert.equal(a.canRebalance, false);
    assert.equal(a.plan.length, 0);
    assert.ok(a.risks.some((r) => r.title === 'Recent trade prices needed'));
  }
});
test('recent valid live trades support the review plan', () => {
  const a = analyzePortfolio(
    [holding('RIVN', 10)],
    {
      RIVN: {
        ...stock,
        mode: 'live',
        quote: { priceAt: '2026-09-09T14:59:30Z', warning: '' },
      },
    },
    { ...defaultManager, targets: { RIVN: 50 } },
    now,
  );
  assert.equal(a.canRebalance, true);
  assert.equal(a.plan[0].difference, -50);
});
test('drift threshold avoids unnecessary rebalance suggestions', () => {
  const a = analyzePortfolio(
    [holding('RIVN', 10)],
    { RIVN: stock },
    { ...defaultManager, targets: { RIVN: 98 } },
    now,
  );
  assert.equal(a.canRebalance, true);
  assert.equal(a.needsRebalance, false);
  assert.equal(a.plan.length, 0);
});
test('cash target and concentration use assets including cash', () => {
  const a = analyzePortfolio(
    [holding('RIVN', 10)],
    { RIVN: stock },
    { ...defaultManager, cash: 300, targets: { RIVN: 25 } },
    now,
  );
  assert.equal(a.positions[0].weight, 25);
  assert.equal(a.cashWeight, 75);
  assert.equal(a.risks.length, 0);
});
