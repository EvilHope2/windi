import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDeliveryFee, canMarkDeliveredByProximity, haversineKm } from '../marketplace-core.js';

test('haversineKm returns near zero for equal points', () => {
  const km = haversineKm(
    { lat: -53.787, lng: -67.7095 },
    { lat: -53.787, lng: -67.7095 }
  );
  assert.ok(km >= 0);
  assert.ok(km < 0.001);
});

test('computeDeliveryFee returns deterministic rounded fee', () => {
  const result = computeDeliveryFee({
    origin: { lat: -53.787, lng: -67.7095 },
    destination: { lat: -53.795, lng: -67.72 },
    baseFee: 1500,
    perKm: 500
  });
  assert.ok(Number.isFinite(result.distanceKm));
  assert.ok(result.distanceKm > 0);
  assert.equal(result.fee, Math.round(1500 + result.distanceKm * 500));
});

test('canMarkDeliveredByProximity enforces distance and accuracy', () => {
  assert.equal(
    canMarkDeliveredByProximity({ distanceMeters: 45, accuracyMeters: 20 }),
    true
  );
  assert.equal(
    canMarkDeliveredByProximity({ distanceMeters: 51, accuracyMeters: 20 }),
    false
  );
  assert.equal(
    canMarkDeliveredByProximity({ distanceMeters: 30, accuracyMeters: 80 }),
    false
  );
});
