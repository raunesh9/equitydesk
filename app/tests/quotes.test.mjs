import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeQuoteUpdates } from '../lib/quote-updates.ts';

test('one missing company does not mark successful quotes as failed', () => {
  const old = {
    RIVN: { price: 10, checkedAt: 'original', warning: '' },
    HDRN: { price: 2, checkedAt: 'original', warning: '' },
  };
  const fresh = { RIVN: { price: 11, checkedAt: 'new', warning: '' } };
  const next = mergeQuoteUpdates(old, fresh, { HDRN: 'Offline' });
  assert.equal(next.RIVN.warning, '');
  assert.equal(next.HDRN.warning, 'Offline');
  assert.equal(next.HDRN.checkedAt, 'original');
  assert.equal(next.HDRN.price, 2);
  assert.equal(old.HDRN.warning, '');
  const recovered = mergeQuoteUpdates(
    next,
    { HDRN: { price: 3, checkedAt: 'recovered', warning: '' } },
    {},
  );
  assert.equal(recovered.HDRN.warning, '');
});
