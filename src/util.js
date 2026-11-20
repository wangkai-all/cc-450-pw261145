const HOUR_MS = 3_600_000;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function addHours(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * HOUR_MS).toISOString();
}

export function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export function hourFloor(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function isoAtHourOffset(anchorIso, offsetHours) {
  return new Date(new Date(anchorIso).getTime() + offsetHours * HOUR_MS).toISOString();
}

export function jaccard(a, b) {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function pct(value) {
  return `${round(value * 100, 1)}%`;
}

export function severity(state) {
  return state === 'ISOLATED' ? 2 : state === 'REDUCED' ? 1 : 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
