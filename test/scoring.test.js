import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  insertSample,
  insertSource,
  insertOperatorAction,
  insertProbe,
  listSamples,
  sampleDigest,
  sourceState,
} from '../src/repo.js';
import { DEFAULT_RULE, buildTimeline, computeFactors, decideState } from '../src/scoring.js';
import { seedDemo, SOURCES } from '../src/seed.js';
import { previewRule, publishAndRecompute, tickScheduler } from '../src/scheduler.js';

function memDb() {
  return openDb(':memory:');
}

function baseSample(overrides = {}) {
  return {
    windowStart: '2026-11-01T00:00:00.000Z',
    windowEnd: '2026-11-01T01:00:00.000Z',
    collectedAt: '2026-11-01T01:00:00.000Z',
    attempts: 24,
    successes: 24,
    failures: 0,
    latencyP50: 400,
    latencyP95: 820,
    emptyResults: 0,
    recordsExpected: 300,
    recordsReturned: 300,
    fieldJaccard: 1,
    fieldsSeen: ['id', 'status'],
    rateLimited: 0,
    throttledMs: 0,
    schemaId: 'api-v1',
    runKind: 'scheduled',
    ...overrides,
  };
}

function series(specs, startHour = 0) {
  return specs.map((overrides, index) => {
    const h = startHour + index;
    const iso = new Date(Date.UTC(2026, 10, 1, h + 1)).toISOString();
    return baseSample({
      windowStart: new Date(Date.UTC(2026, 10, 1, h)).toISOString(),
      windowEnd: iso,
      collectedAt: iso,
      ...overrides,
    });
  });
}

test('healthy window scores ~100 and isolates only on sustained evidence', () => {
  const timeline = buildTimeline(series([{}, {}, {}]), { ...DEFAULT_RULE, version: 1 });
  for (const p of timeline.points) {
    assert.ok(p.rawScore > 97, `expected healthy score, got ${p.rawScore}`);
    assert.equal(p.state, 'NORMAL');
  }
  assert.equal(timeline.transitions.length, 0);
});

test('a single degraded window does not change scheduling state', () => {
  const bad = { successes: 2, latencyP95: 6000, latencyP50: 3000, emptyResults: 8 };
  const timeline = buildTimeline(series([{}, bad, {}]), { ...DEFAULT_RULE, version: 1 });
  assert.equal(timeline.finalState, 'NORMAL', 'one bad window must not isolate a source');
  assert.equal(timeline.transitions.length, 0);
});

test('two consecutive degraded windows reduce cadence, then isolate', () => {
  // Land in the reduced band (~72 > score > 48), not straight into isolation.
  const bad = { successes: 20, latencyP95: 3200, latencyP50: 1500, emptyResults: 2 };
  const veryBad = { successes: 0, latencyP95: 12000, latencyP50: 6000, emptyResults: 24, fieldJaccard: 0.3 };
  const timeline = buildTimeline(series([{}, bad, bad, bad, veryBad, veryBad]), { ...DEFAULT_RULE, version: 1 });
  const states = timeline.points.map((p) => p.state);
  assert.equal(states[0], 'NORMAL');
  assert.equal(states[3], 'REDUCED', 'sustained degradation should reduce cadence');
  assert.ok(states.includes('ISOLATED'), 'continued failure should isolate');
  const codes = timeline.transitions.map((t) => t.reasonCode);
  assert.ok(codes.includes('reduced_low_score'));
  assert.ok(codes.includes('isolated_low_score'));
});

test('recovery requires clearing the margin and the dwell window', () => {
  const bad = { successes: 20, latencyP95: 3200, latencyP50: 1500, emptyResults: 2 };
  const timeline = buildTimeline(series([bad, bad, {}, {}, {}, {}]), { ...DEFAULT_RULE, version: 1 });
  assert.ok(timeline.points[1].state === 'REDUCED');
  // Should not jump back on the first healthy window.
  assert.notEqual(timeline.points[2].state, 'NORMAL');
  assert.ok(timeline.points.some((p) => p.state === 'NORMAL'), 'should eventually recover');
  const promote = timeline.transitions.find((t) => t.reasonCode === 'promoted');
  assert.ok(promote, 'expected a promotion transition');
});

test('isolated sources recover only through consecutive healthy probes', () => {
  const bad = { successes: 0, latencyP95: 9000, latencyP50: 4500, emptyResults: 12 };
  const samples = series([{}, bad, bad]);
  const probes = [
    { at: '2026-11-01T04:00:00.000Z', outcome: 'healthy' },
    { at: '2026-11-01T05:00:00.000Z', outcome: 'degraded' },
    { at: '2026-11-01T06:00:00.000Z', outcome: 'healthy' },
    { at: '2026-11-01T07:00:00.000Z', outcome: 'healthy' },
    { at: '2026-11-01T08:00:00.000Z', outcome: 'healthy' },
  ];
  const timeline = buildTimeline(samples, { ...DEFAULT_RULE, version: 1 }, [], { probes });
  assert.equal(timeline.points.at(-1).state, 'ISOLATED');
  const recovery = timeline.transitions.find((t) => t.reasonCode === 'probe_recovery');
  assert.ok(recovery, 'three consecutive healthy probes should recover the source');
  assert.equal(recovery.at, '2026-11-01T08:00:00.000Z');
});

test('manual hold pins state and release hands control back', () => {
  const bad = { successes: 1, latencyP95: 8000, latencyP50: 4000, emptyResults: 10 };
  const samples = series([bad, bad, {}, {}]);
  const actions = [
    { at: '2026-11-01T03:00:00.000Z', action: 'hold', note: 'investigating', actor: 'oncall' },
    { at: '2026-11-01T05:00:00.000Z', action: 'release', note: 'fixed', actor: 'oncall' },
  ];
  const timeline = buildTimeline(samples, { ...DEFAULT_RULE, version: 1 }, actions);
  const manualPoints = timeline.points.filter((p) => p.state === 'MANUAL');
  assert.ok(manualPoints.length > 0);
  assert.equal(timeline.finalState, 'NORMAL');
  assert.ok(timeline.transitions.some((t) => t.reasonCode === 'manual_hold'));
  assert.ok(timeline.transitions.some((t) => t.reasonCode === 'manual_release'));
});

test('every factor responds to its own signal', () => {
  const rule = DEFAULT_RULE;
  const healthy = computeFactors(baseSample(), rule).factors;
  assert.ok(healthy.success > 0.99 && healthy.latency > 0.99 && healthy.drift > 0.99);

  const slow = computeFactors(baseSample({ latencyP95: 5400, latencyP50: 2100 }), rule).factors;
  assert.ok(slow.latency < 0.5, 'latency factor should collapse when far over budget');

  const empty = computeFactors(baseSample({ emptyResults: 6 }), rule).factors;
  assert.ok(empty.empty < 0.5, 'empty factor should drop when empty rate exceeds baseline');

  const drifted = computeFactors(baseSample({ fieldJaccard: 0.5 }), rule).factors;
  assert.ok(drifted.drift < 0.2, 'drift factor should collapse on schema change');

  const throttled = computeFactors(baseSample({ rateLimited: 8 }), rule).factors;
  assert.ok(throttled.throttle < 0.5, 'throttle factor should drop on rate limiting');

  const failed = computeFactors(baseSample({ successes: 12 }), rule).factors;
  assert.ok(failed.success < 0.6, 'success factor tracks the success rate');
});

test('decideState blocks isolation during confirmation and honours manual', () => {
  const rule = normalize({ thresholds: { confirmWindows: 3 } });
  const sample = baseSample();
  const first = decideState({ score: 40, rawScore: 40, previousState: 'NORMAL', counters: {}, rule, sample });
  assert.equal(first.state, 'NORMAL');
  assert.equal(first.reasons[0].code, 'confirmation_pending');

  const manual = decideState({ score: 5, rawScore: 5, previousState: 'MANUAL', counters: {}, rule, sample });
  assert.equal(manual.state, 'MANUAL');

  const catastrophic = decideState({ score: 10, rawScore: 10, previousState: 'NORMAL', counters: {}, rule, sample });
  assert.equal(catastrophic.state, 'ISOLATED', 'near-total outage bypasses confirmation');
});

function normalize(overrides) {
  return {
    ...DEFAULT_RULE,
    ...overrides,
    thresholds: { ...DEFAULT_RULE.thresholds, ...(overrides.thresholds ?? {}) },
  };
}

test('raw monitoring is append-only at the database level', () => {
  const db = memDb();
  insertSource(db, { id: 's1', name: 'S', kind: 'api', url: 'u', tier: 'P1', owner: 'o' });
  insertSample(db, 's1', baseSample());
  assert.throws(() => db.prepare("UPDATE samples SET attempts = 99").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM samples').run(), /cannot be deleted/);
});

test('scoring rules are immutable; publishing creates a new version', () => {
  const db = memDb();
  insertSource(db, { id: 's1', name: 'S', kind: 'api', url: 'u', tier: 'P1', owner: 'o' });
  const first = publishAndRecompute(db, DEFAULT_RULE, { actor: 'a', note: 'baseline' }).version;
  db.prepare('UPDATE scoring_rules SET active = 0 WHERE version = ?').run(first);
  const second = publishAndRecompute(db, { ...DEFAULT_RULE, thresholds: { ...DEFAULT_RULE.thresholds, reducedBelow: 80 } }, {
    actor: 'a',
    note: 'stricter',
  }).version;
  assert.equal(second, first + 1);
  assert.throws(() => db.prepare("UPDATE scoring_rules SET config = '{}' WHERE version = ?").run(first), /immutable/);
});

test('seeded database: recompute reproduces the live state and never edits raw data', () => {
  const { db, rule } = seedDemo({ dbFile: ':memory:', now: new Date('2026-11-20T05:00:00.000Z') });
  const before = sampleDigest(db);
  const preview = previewRule(db, rule);
  assert.equal(preview.totalChanged, 0, 'preview under the same rule must be a no-op');
  assert.equal(preview.stateFlips, 0);

  const readLive = () =>
    db.prepare('SELECT source_id, state, ROUND(score, 6) AS score FROM source_state ORDER BY source_id').all();
  const liveBefore = readLive();
  const { run } = publishAndRecompute(db, rule, { actor: 'test', note: 're-run' });
  const after = sampleDigest(db);
  assert.equal(run.rawUnchanged, true);
  assert.equal(after.digest, before.digest, 'raw monitoring digest must be unchanged');
  const liveAfter = readLive();
  assert.deepEqual(liveAfter, liveBefore, 'recomputing the same rule must not move state');
});

test('seeded database: isolating a source stops collection but keeps probing', () => {
  const { db } = seedDemo({ dbFile: ':memory:', now: new Date('2026-11-20T05:00:00.000Z') });
  const isolated = db.prepare("SELECT * FROM source_state WHERE state = 'ISOLATED' LIMIT 1").get();
  assert.ok(isolated, 'seed should contain at least one isolated source');
  const samplesBefore = listSamples(db, isolated.source_id).length;
  const probesBefore = db.prepare('SELECT COUNT(*) c FROM health_probes WHERE source_id = ?').get(isolated.source_id).c;

  tickScheduler(db, { now: '2026-11-20T12:00:00.000Z', force: true });

  const samplesAfter = listSamples(db, isolated.source_id).length;
  const probesAfter = db.prepare('SELECT COUNT(*) c FROM health_probes WHERE source_id = ?').get(isolated.source_id).c;
  assert.equal(samplesAfter, samplesBefore, 'isolated source must not be collected');
  assert.ok(probesAfter > probesBefore, 'isolated source should be probed instead');
});

test('changing scoring rules requires recompute and reports impact without touching raw data', () => {
  const { db, rule } = seedDemo({ dbFile: ':memory:', now: new Date('2026-11-20T05:00:00.000Z') });
  const before = sampleDigest(db);
  const candidate = { ...rule, weights: { success: 0.5, latency: 0.1, empty: 0.2, drift: 0.15, throttle: 0.05 } };
  const preview = previewRule(db, candidate);
  const { run } = publishAndRecompute(db, candidate, { actor: 'test', note: 'weight shift' });
  assert.ok(run.changedPoints > 0, 'weight change should alter some historical windows');
  assert.equal(run.digestBefore, before.digest);
  assert.equal(run.rawUnchanged, true);
  assert.ok(preview.totalChanged > 0);
});

test('seeded jitter source is never isolated by its transient spikes', () => {
  const { db } = seedDemo({ dbFile: ':memory:', now: new Date('2026-11-20T05:00:00.000Z') });
  const transitions = db
    .prepare("SELECT * FROM state_transitions WHERE source_id = 'srch-jobs-feed' AND to_state = 'ISOLATED'")
    .all();
  assert.equal(transitions.length, 0, 'single-window spikes must not isolate the source');
  const held = db
    .prepare(
      `SELECT COUNT(*) AS c FROM score_points
       WHERE source_id = 'srch-jobs-feed' AND reasons LIKE '%confirmation_pending%'`
    )
    .get().c;
  assert.ok(held > 0, 'the spike must be visible as a held, unconfirmed window - not silently ignored');
});

test('operator release overrides an isolation and records it as a manual recovery', () => {
  const bad = { successes: 2, latencyP95: 6000, latencyP50: 3000, emptyResults: 8 };
  const samples = series([{}, bad, bad, bad]);
  const releaseAt = '2026-11-01T04:30:00.000Z';
  const without = buildTimeline(samples, { ...DEFAULT_RULE, version: 1 });
  assert.equal(without.finalState, 'ISOLATED', 'sustained evidence should isolate');

  const withRelease = buildTimeline(samples, { ...DEFAULT_RULE, version: 1 }, [
    { at: releaseAt, action: 'release', actor: 'oncall:test', note: 'Backfill verified.' },
  ]);
  assert.equal(withRelease.finalState, 'NORMAL');
  const last = withRelease.transitions.at(-1);
  assert.equal(last.reasonCode, 'manual_release');
  assert.equal(last.actor, 'oncall:test');

  // The override is replayed from the event log, so recomputing does not lose it.
  const replay = buildTimeline(samples, { ...DEFAULT_RULE, version: 9 }, [
    { at: releaseAt, action: 'release', actor: 'oncall:test', note: 'Backfill verified.' },
  ]);
  assert.equal(replay.finalState, 'NORMAL');
  assert.equal(replay.transitions.at(-1).ruleVersion, 9);
});
