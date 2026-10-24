// Deterministic PRNG (mulberry32). Never uses Math.random.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function range(rng, min, max) {
  return min + (max - min) * rng();
}

export function pick(rng, items) {
  if (!items || items.length === 0) throw new Error('pick: empty array');
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}
