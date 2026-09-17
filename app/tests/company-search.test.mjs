import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCompanies } from '../lib/company-search.ts';
import { sampleStocks } from '../lib/stocks.ts';

test('sample company names match without tickers, punctuation, or exact word order', () => {
  for (const [query, ticker] of [
    ['rivian', 'RIVN'],
    ['hadron energy inc', 'HDRN'],
    [' ENERGY  Hadron ', 'HDRN'],
    ['micro', 'MSFT'],
    ['rivi auto', 'RIVN'],
  ]) {
    assert.equal(searchCompanies(sampleStocks, query)[0].symbol, ticker);
  }
});
test('familiar brand names point at companies actually present in the workspace', () => {
  assert.equal(searchCompanies(sampleStocks, 'Google')[0].symbol, 'GOOGL');
  assert.deepEqual(searchCompanies(sampleStocks, 'Facebook'), []);
});
test('tickers continue to work and unknown names do not create results', () => {
  assert.equal(searchCompanies(sampleStocks, 'aapl')[0].symbol, 'AAPL');
  assert.deepEqual(
    searchCompanies(sampleStocks, 'no matching company exists'),
    [],
  );
});
