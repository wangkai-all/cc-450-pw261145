/**
 * Deterministic synthetic collection. This stands in for real connectors:
 * given (source, simulated hour, run kind) it returns the raw facts one
 * collection window would have observed. Same inputs always produce the same
 * facts, so seeded history, live ticks and tests all agree.
 */

export const EXPECTED_FIELDS = {
  feed: ['guid', 'title', 'link', 'published', 'summary', 'author'],
  api: ['id', 'updated_at', 'status', 'payload', 'cursor'],
  graphql: ['id', 'node', 'edges', 'pageInfo', 'updatedAt'],
  ocr: ['page', 'bbox', 'text', 'confidence', 'language'],
  csv: ['sku', 'price', 'currency', 'stock', 'updated_at'],
  scrape: ['title', 'price', 'availability', 'rating', 'url'],
};

export const EPOCH = '2026-11-06T00:00:00.000Z';

export function hash01(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4_294_967_296;
}

export function hoursSinceEpoch(iso) {
  return Math.floor((new Date(iso).getTime() - new Date(EPOCH).getTime()) / 3_600_000);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Degradation profile per scenario, as a function of hours since epoch.
 * `level` 0..1 scales failure/latency/empty rates. `drift` and `throttle`
 * are structural, not volume, failures.
 */
export function scenarioProfile(source, hour) {
  const wobble = (hash01(`${source.id}:w:${hour}`) - 0.5) * 0.06;
  const base = { level: 0, drift: false, throttle: false };
  switch (source.scenario) {
    case 'jitter':
      // A single ugly window every 29h. One window must never be enough to
      // demote or isolate - it is exactly the transient the design targets.
      return hour % 29 === 7 ? { ...base, level: 0.88 } : { ...base, level: clamp01(wobble * 0.4) };
    case 'flaky':
      // Two consecutive degraded windows every 61h; self-clearing.
      return hour % 61 === 5 || hour % 61 === 6
        ? { ...base, level: 0.83 }
        : { ...base, level: clamp01(wobble * 0.4) };
    case 'degrading': {
      if (hour < 170) return { ...base, level: clamp01(0.03 + wobble * 0.5) };
      if (hour < 205) return { ...base, level: 0.2 + (hour - 170) * 0.013 };
      return { ...base, level: 0.64 };
    }
    case 'recovered': {
      if (hour >= 120 && hour < 176) return { ...base, level: 0.9 };
      return { ...base, level: clamp01(wobble * 0.4) };
    }
    case 'drifted':
      return hour >= 100 ? { ...base, level: 0.44, drift: true } : { ...base, level: clamp01(wobble * 0.4) };
    case 'ratelimited':
      // Nightly bulk exports trip the upstream limiter. Long enough to be real
      // (the score drops into the REDUCED band for hours) but it clears, so the
      // source never deserves isolation.
      return hour % 24 >= 21 || hour % 24 <= 5
        ? { ...base, level: 0.3, throttle: true }
        : { ...base, level: clamp01(wobble * 0.4) };
    case 'held':
      return hour >= 200 ? { ...base, level: 0.68 } : { ...base, level: clamp01(wobble * 0.4) };
    case 'stable':
    default:
      return { ...base, level: clamp01(0.02 + wobble * 0.4) };
  }
}

function fieldsFor(kind, drift, salt) {
  const expected = EXPECTED_FIELDS[kind] ?? EXPECTED_FIELDS.api;
  if (!drift) return { fields: expected, jaccard: 1 };
  // Upstream renamed half the fields and added one blob field.
  const fields = expected.map((field, index) => (index % 2 === 0 ? `${field}_v2` : field));
  fields.push('raw_blob');
  const overlap = expected.filter((f) => fields.includes(f)).length;
  const union = new Set([...expected, ...fields]).size;
  void salt;
  return { fields, jaccard: Number((overlap / union).toFixed(3)) };
}

/**
 * Aggregate one collection window. Attempts inside a window are what damps
 * single-request noise before scoring ever sees it.
 */
export function collectWindow(source, windowEndIso, { runKind = 'scheduled' } = {}) {
  const hour = hoursSinceEpoch(windowEndIso);
  const profile = scenarioProfile(source, hour);
  const salt = `${windowEndIso}:${runKind}`;
  const r = (name) => hash01(`${source.id}:${salt}:${name}`);
  // Window-level noise is deliberately small: single-window variance belongs
  // *inside* the aggregate (attempts), not on top of it, or a healthy source
  // would look degraded for no reason.
  const level = clamp01(profile.level + (r('level') - 0.5) * 0.02);
  const attempts = runKind === 'probe' ? 4 : 24;
  const jitterBad = level < 0.08 && r('spike') < 0.004 ? 1 : 0;
  const effectiveLevel = Math.max(level, jitterBad ? 0.72 : 0);

  const successRate = clamp01(0.999 - effectiveLevel * 0.97 - (r('succ') - 0.5) * 0.008);
  // A healthy window still drops the odd request; without this every stable
  // source would pin at exactly 100 and the dashboard would look synthetic.
  const blip = effectiveLevel < 0.08 && r('blip') < 0.05 ? 1 : 0;
  const successes = Math.max(0, Math.min(attempts, Math.round(successRate * attempts) - blip));
  const failures = attempts - successes;

  const latencyP50 = Math.round(400 + effectiveLevel * 1700 + (r('p50') - 0.5) * 90);
  const latencyP95 = Math.round(
    Math.max(latencyP50, 820 + effectiveLevel * 5400 + (r('p95') - 0.5) * 160)
  );

  const emptyRate = clamp01(0.006 + effectiveLevel * 0.46 + (r('empty') - 0.5) * 0.008);
  const emptyResults = Math.min(successes, Math.round(emptyRate * Math.max(1, successes)));

  const { fields, jaccard } = fieldsFor(source.kind, profile.drift, salt);
  const rateLimited = profile.throttle
    ? Math.round(attempts * clamp01(0.4 + (r('rl') - 0.5) * 0.2))
    : 0;

  const recordsExpected = Math.round(240 + r('vol') * 380);
  const recordsReturned = Math.round(
    recordsExpected * clamp01(0.96 + (r('ret') - 0.5) * 0.06 - effectiveLevel * 0.25)
  );

  return {
    // Canonical DB-shaped names plus camelCase aliases: simulator output is
    // fed both to insertSample and directly to the pure scoring functions.
    window_end: windowEndIso,
    window_start: new Date(new Date(windowEndIso).getTime() - 3_600_000).toISOString(),
    field_jaccard: jaccard,
    latency_p50_ms: latencyP50,
    latency_p95_ms: latencyP95,
    empty_results: emptyResults,
    records_expected: recordsExpected,
    records_returned: recordsReturned,
    rate_limited: rateLimited,
    windowEnd: windowEndIso,
    windowStart: new Date(new Date(windowEndIso).getTime() - 3_600_000).toISOString(),
    collectedAt: windowEndIso,
    attempts,
    successes,
    failures,
    latencyP50,
    latencyP95,
    emptyResults,
    recordsExpected,
    recordsReturned,
    fieldJaccard: jaccard,
    fieldsSeen: fields,
    rateLimited,
    throttledMs: rateLimited * 1500,
    schemaId: profile.drift ? `${source.kind}-v2` : `${source.kind}-v1`,
    runKind,
    note: profile.drift ? 'Upstream schema changed' : profile.throttle ? 'Rate limiter engaged' : null,
  };
}

/** Outcome of a cheap health probe, used while a source is isolated/manual. */
export function probeSource(source, atIso) {
  const window = collectWindow(source, atIso, { runKind: 'probe' });
  const rate = window.successes / window.attempts;
  const findings = [];
  if (window.fieldJaccard < 0.92) findings.push(`Schema overlap ${window.fieldJaccard}; upstream shape change persists.`);
  if (window.rateLimited > 0) findings.push(`${window.rateLimited}/${window.attempts} probe requests were rate limited.`);
  if (rate < 0.9) findings.push(`Reachability ${(rate * 100).toFixed(0)}% of probe requests.`);
  if (window.latencyP95 > 3000) findings.push(`Probe p95 ${window.latencyP95} ms is above the 1800 ms budget.`);
  const outcome = findings.length ? 'degraded' : 'healthy';
  if (!findings.length) findings.push('Probe succeeded; reachability, latency and schema within budget.');
  return { outcome, findings, window, verdict: outcome === 'healthy' ? 'source appears recovered' : 'source still degraded' };
}
