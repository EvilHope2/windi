export function generateToken(bytes = 12) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

export function qs(id) {
  return document.getElementById(id);
}

export function fmtMoney(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return '-';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0
  }).format(num);
}

export function fmtTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  return d.toLocaleString('es-AR');
}
