import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcSubtotal,
  calcCommission,
  enforceSingleMerchant
} from '../../frontend/js/marketplace-common.js';

test('calcSubtotal computes cart subtotal', () => {
  const subtotal = calcSubtotal([
    { unitPriceSnapshot: 1200, qty: 2 },
    { unitPriceSnapshot: 850, qty: 1 }
  ]);
  assert.equal(subtotal, 3250);
});

test('calcCommission uses configured base', () => {
  const fromSubtotal = calcCommission(10000, 12000, { rate: 0.05, base: 'subtotal_products' });
  const fromTotal = calcCommission(10000, 12000, { rate: 0.05, base: 'total' });
  assert.equal(fromSubtotal.commissionAmount, 500);
  assert.equal(fromTotal.commissionAmount, 600);
});

test('enforceSingleMerchant prevents mixed-cart merchants', () => {
  const cart = { merchantId: 'a', merchantName: 'A', items: [] };
  const keep = enforceSingleMerchant(cart, 'a', 'A');
  const reject = enforceSingleMerchant(cart, 'b', 'B');
  assert.equal(keep.ok, true);
  assert.equal(reject.ok, false);
});
