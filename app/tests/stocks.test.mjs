import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleStocks,
  money,
  compact,
  ratio,
  pointsFor,
  priceReturn,
  portfolioTotals,
} from '../lib/stocks.ts';
const map = Object.fromEntries(sampleStocks.map((s) => [s.symbol, s]));
const holding = (symbol, shares, cost) => ({
  id: 1,
  symbol,
  name: symbol,
  shares,
  cost,
  currency: 'USD',
});
test('missing financials and missing currencies never render as zero dollars', () => {
  assert.equal(money(null), 'Not available');
  assert.equal(compact(undefined), 'Not available');
  assert.equal(money(10, ''), 'Not available');
  assert.equal(ratio(null), 'Not available');
  assert.equal(money(0), '$0.00');
});
test('all illustrative fixtures are labeled and chronological', () => {
  for (const s of sampleStocks) {
    assert.equal(s.mode, 'sample');
    assert.equal(s.history.at(-1).close, s.price);
    assert.equal(s.history.at(-1).date, s.priceDate);
    assert.ok(
      s.history.every(
        (p, i) => p.close > 0 && (!i || p.date > s.history[i - 1].date),
      ),
    );
  }
});
test('range selection uses the data date and return uses first and last observations', () => {
  const s = sampleStocks[0],
    p = pointsFor(s, '1M');
  assert.ok(p.length > 15 && p.length < 25);
  assert.equal(p.at(-1).date, s.priceDate);
  assert.equal(priceReturn(s, '1M'), (p.at(-1).close / p[0].close - 1) * 100);
  assert.equal(priceReturn({ ...s, history: [] }, '1Y'), null);
});
test('fractional holdings and multiple lots give correct totals', () => {
  const stocks = { ...map, AAPL: { ...map.AAPL, price: 200 } };
  const t = portfolioTotals(
    [holding('AAPL', 0.5, 150), holding('AAPL', 2, 180)],
    stocks,
  );
  assert.equal(t.costTotal, 435);
  assert.equal(t.marketTotal, 500);
  assert.equal(t.gain, 65);
  assert.equal(t.missing.length, 0);
});
test('a missing quote prevents a partial portfolio from looking complete', () => {
  const t = portfolioTotals(
    [holding('AAPL', 2, 100), holding('UNKNOWN', 3, 50)],
    map,
  );
  assert.equal(t.marketTotal, null);
  assert.equal(t.gain, null);
  assert.equal(t.pricedTotal, 2 * map.AAPL.price);
  assert.equal(t.costTotal, 350);
  assert.equal(t.missing.length, 1);
});
test('foreign currency quotes cannot be mixed into USD totals', () => {
  const t = portfolioTotals([holding('AAPL', 1, 100)], {
    AAPL: { ...map.AAPL, currency: 'EUR' },
  });
  assert.equal(t.marketTotal, null);
  assert.equal(t.pricedTotal, 0);
});
test('an empty portfolio is zero rather than unavailable', () => {
  const t = portfolioTotals([], {});
  assert.equal(t.marketTotal, 0);
  assert.equal(t.costTotal, 0);
  assert.equal(t.gain, 0);
});
