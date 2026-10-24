// Stable FNV-1a hash over a flat list of numbers/strings (numbers rounded to 1e-4).
export function hashValues(values) {
  let h = 0x811c9dc5;
  const mixInt = (n) => { h = Math.imul(h ^ (n | 0), 0x01000193) >>> 0; };
  for (const v of values) {
    if (typeof v === 'string') {
      for (let i = 0; i < v.length; i++) mixInt(v.charCodeAt(i));
      mixInt(0x7f);
    } else {
      mixInt(Math.round((Number.isFinite(v) ? v : 0) * 1e4));
    }
  }
  return h.toString(16).padStart(8, '0');
}
