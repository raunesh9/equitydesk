import test from 'node:test';
import assert from 'node:assert/strict';
import { financialRows, normalizeQuote } from '../cloud/normalize.ts';
test('financial statements retain reported zero and never fill missing values or mix currencies', () => {
  const point = (n, currencyCode = 'USD') => ({
    asOfDate: '2025-12-31',
    currencyCode,
    periodType: '12M',
    reportedValue: { raw: n },
  });
  const rows = financialRows({
    timeseries: {
      result: [
        { annualTotalRevenue: [point(0)] },
        { annualNetIncome: [point(-200)] },
        { annualTotalDebt: [point(300, 'CAD')] },
        { annualFreeCashFlow: [point(null)] },
      ],
    },
  });
  const usd = rows.find((r) => r.currency === 'USD');
  assert.equal(usd.revenue, 0);
  assert.equal(usd.earnings, -200);
  assert.equal(usd.debt, null);
  assert.equal(usd.freeCashFlow, null);
  assert.equal(rows.find((r) => r.currency === 'CAD').debt, 300);
  assert.deepEqual(financialRows({}), []);
});
test('quarterly, unknown currency and malformed numbers are not passed off as annual figures', () => {
  const p = {
    asOfDate: '2025-12-31',
    currencyCode: 'USD',
    periodType: '12M',
    reportedValue: { raw: 100 },
  };
  for (const bad of [
    { ...p, periodType: '3M' },
    { ...p, currencyCode: '' },
    { ...p, reportedValue: { raw: '100' } },
    { ...p, reportedValue: { raw: Infinity } },
  ])
    assert.deepEqual(
      financialRows({
        timeseries: { result: [{ annualTotalRevenue: [bad] }] },
      }),
      [],
    );
});
test('quotes require a source timestamp and preserve retrieval time and reported zero change', () => {
  const checkedAt = '2026-09-17T18:01:00Z',
    q = normalizeQuote(
      'HDRN',
      {
        regularMarketPrice: 4,
        regularMarketTime: 1758132000,
        regularMarketChangePercent: 0,
        currency: 'USD',
      },
      checkedAt,
    );
  assert.equal(q.price, 4);
  assert.equal(q.changePercent, 0);
  assert.equal(q.checkedAt, checkedAt);
  assert.equal(
    normalizeQuote('HDRN', { regularMarketPrice: 4 }, checkedAt).price,
    null,
  );
  assert.equal(normalizeQuote('HDRN', {}, checkedAt).currency, '');
});
test('newest session drives estimates and the regular close remains available', () => {
  const quote = normalizeQuote(
    'RIVN',
    {
      regularMarketPrice: 15.4,
      regularMarketTime: '2026-09-17T20:00:00Z',
      postMarketPrice: 15.45,
      postMarketTime: '2026-09-17T23:59:00Z',
      marketState: 'POSTPOST',
      exchangeTimezoneName: 'America/New_York',
    },
    '2026-09-18T01:00:00Z',
  );
  assert.equal(quote.price, 15.45);
  assert.equal(quote.priceSession, 'post');
  assert.equal(quote.sessions.regular.price, 15.4);
  assert.equal(
    quote.sessions.overnight,
    undefined,
    'an 8 PM market state is not an overnight trade',
  );
});
test('an overnight label requires a timestamp within overnight hours, not just a market state', () => {
  const base = {
    regularMarketPrice: 10,
    regularMarketTime: '2026-09-17T20:00:00Z',
    postMarketPrice: 11,
    postMarketTime: '2026-09-18T01:00:00Z',
    marketState: 'POSTPOST',
    exchangeTimezoneName: 'America/New_York',
  };
  assert.equal(
    normalizeQuote('RIVN', base, '2026-09-18T01:01:00Z').priceSession,
    'overnight',
  );
  const newer = {
    ...base,
    preMarketPrice: 12,
    preMarketTime: '2026-09-18T12:00:00Z',
    marketState: 'PRE',
  };
  assert.equal(
    normalizeQuote('RIVN', newer, '2026-09-18T12:01:00Z').priceSession,
    'pre',
  );
  const bad = { ...base, postMarketTime: '2026-09-19T01:00:00Z' };
  assert.equal(normalizeQuote('RIVN', bad, '2026-09-18T01:01:00Z').price, 10);
});
