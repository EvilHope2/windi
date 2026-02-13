import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSubtotalProducts,
  computeCommission,
  canCreateOrderForCustomer,
  canTransitionOrderStatus
} from '../marketplace-core.js';

test('computeSubtotalProducts sums snapshots correctly', () => {
  const subtotal = computeSubtotalProducts([
    { unitPriceSnapshot: 1000, qty: 2 },
    { unitPriceSnapshot: 550, qty: 3 }
  ]);
  assert.equal(subtotal, 3650);
});

test('computeCommission uses subtotal base by default', () => {
  const result = computeCommission({ subtotalProducts: 20000, total: 22000 });
  assert.equal(result.commissionRate, 0.05);
  assert.equal(result.commissionBase, 'subtotal_products');
  assert.equal(result.commissionAmount, 1000);
});

test('computeCommission can use total base', () => {
  const result = computeCommission({ subtotalProducts: 20000, total: 22000, rate: 0.05, base: 'total' });
  assert.equal(result.commissionAmount, 1100);
});

test('canCreateOrderForCustomer validates owner', () => {
  assert.equal(canCreateOrderForCustomer('uid-a', 'uid-a'), true);
  assert.equal(canCreateOrderForCustomer('uid-a', 'uid-b'), false);
});

test('canTransitionOrderStatus enforces role states', () => {
  assert.equal(canTransitionOrderStatus('merchant', 'ready_for_pickup'), true);
  assert.equal(canTransitionOrderStatus('merchant', 'delivered'), false);
  assert.equal(canTransitionOrderStatus('courier', 'picked_up'), true);
  assert.equal(canTransitionOrderStatus('courier', 'preparing'), false);
  assert.equal(canTransitionOrderStatus('admin', 'anything'), true);
});
