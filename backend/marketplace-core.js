export const DEFAULT_COMMISSION_RATE = 0.05;
export const DEFAULT_COMMISSION_BASE = 'subtotal_products';

export function computeSubtotalProducts(items = []) {
  return items.reduce((acc, item) => {
    const qty = Number(item.qty || 0);
    const unitPrice = Number(item.unitPriceSnapshot || item.price || 0);
    return acc + unitPrice * qty;
  }, 0);
}

export function computeCommission({
  subtotalProducts,
  total,
  rate = DEFAULT_COMMISSION_RATE,
  base = DEFAULT_COMMISSION_BASE
}) {
  const sourceAmount = base === 'total' ? Number(total || 0) : Number(subtotalProducts || 0);
  const commissionAmount = Math.round(sourceAmount * Number(rate || 0));
  return {
    commissionRate: Number(rate || 0),
    commissionBase: base,
    commissionAmount
  };
}

export function canCreateOrderForCustomer(authUid, payloadCustomerId) {
  return !!authUid && authUid === payloadCustomerId;
}

export function canTransitionOrderStatus(actorRole, nextStatus) {
  const merchantStatuses = new Set(['confirmed', 'preparing', 'ready_for_pickup', 'cancelled']);
  const courierStatuses = new Set(['assigned', 'picked_up', 'delivered', 'cancelled']);
  if (actorRole === 'merchant') return merchantStatuses.has(nextStatus);
  if (actorRole === 'courier') return courierStatuses.has(nextStatus);
  if (actorRole === 'admin') return true;
  return false;
}

export function haversineKm(a, b) {
  const toRad = (v) => (Number(v) * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return 6371 * c;
}

export function computeDeliveryFee({ origin, destination, baseFee = 1500, perKm = 500 }) {
  const km = haversineKm(origin, destination);
  const roundedKm = Math.round(km * 10) / 10;
  const fee = Math.round(Number(baseFee || 0) + roundedKm * Number(perKm || 0));
  return { distanceKm: roundedKm, fee };
}

export function canMarkDeliveredByProximity({ distanceMeters, accuracyMeters, radiusMeters = 50, maxAccuracyMeters = 50 }) {
  const distance = Number(distanceMeters);
  const accuracy = Number(accuracyMeters);
  if (!Number.isFinite(distance) || !Number.isFinite(accuracy)) return false;
  return distance <= Number(radiusMeters) && accuracy <= Number(maxAccuracyMeters);
}
