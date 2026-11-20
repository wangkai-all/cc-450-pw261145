import {
  activeRule,
  getSource,
  insertProbe,
  insertSample,
  latestSample,
  listOperatorActions,
  listRules,
  listSamples,
  listScorePoints,
  listSources,
  publishRule,
  sampleDigest,
  sourceState,
} from './repo.js';
import {
  applyEvaluation,
  evaluateTimeline,
  intervalMinutes,
  nextDueFor,
  recordCollectionRun,
  replayInputs,
} from './engine.js';
import { collectWindow, probeSource } from './simulator.js';
import { buildTimeline } from './scoring.js';

/**
 * Advance the live scheduler one tick.
 *
 *   NORMAL   -> full collection every base interval
 *   REDUCED  -> full collection every 3x base interval (fewer, gentler calls)
 *   ISOLATED -> diagnostic probe only, never full collection
 *   MANUAL   -> diagnostic probe only; scheduling is the operator's call
 *
 * Full collections append a raw sample; probes append to health_probes. After
 * appending, the source is re-evaluated from the whole immutable stream under
 * the active rule - the same code path as a historical recompute.
 */
export function tickScheduler(db, { now = new Date().toISOString(), force = false } = {}) {
  const rule = activeRule(db);
  const actions = [];

  for (const source of listSources(db)) {
    const stateRow = sourceState(db, source.id);
    if (!stateRow) continue;
    const state = stateRow.state;
    const dueAt = stateRow.next_due_at ?? now;
    const due = force || dueAt <= now;

    if (!due) {
      actions.push({
        sourceId: source.id,
        state,
        action: 'wait',
        reason: `${state} cadence: next ${describeNext(state)} due at ${dueAt}.`,
        nextDueAt: dueAt,
      });
      continue;
    }

    if (state === 'ISOLATED' || state === 'MANUAL') {
      const probe = probeSource(source, now);
      insertProbe(db, source.id, {
        at: now,
        state,
        score: stateRow.score,
        outcome: probe.outcome,
        findings: probe.findings,
        nextProbeAt: nextDueFor(source, state, now),
      });
      const result = refresh(db, source, rule, now);
      const nextDueAt = sourceState(db, source.id).next_due_at;
      recordCollectionRun(db, source.id, {
        plannedAt: dueAt,
        ranAt: now,
        state,
        action: 'probe',
        reason: `${probe.outcome}: ${probe.findings[0]}`,
      });
      actions.push({
        sourceId: source.id,
        state,
        action: 'probe',
        reason: `${probe.outcome}: ${probe.findings[0]}`,
        outcome: probe.outcome,
        findings: probe.findings,
        stateAfter: result.state,
        nextDueAt,
      });
      continue;
    }

    const latest = latestSample(db, source.id);
    const windowEnd = nextWindowBoundary(now, latest);
    if (!windowEnd) {
      // The hour bucket has not closed yet (or the last sample already covers
      // it). Never invent a window for a period that has not happened.
      actions.push({
        sourceId: source.id,
        state,
        action: 'wait',
        reason: 'Current window has not closed yet; waiting for the next boundary.',
        nextDueAt: dueAt,
      });
      continue;
    }
    const sample = collectWindow(source, windowEnd, { runKind: 'scheduled' });
    const sampleId = insertSample(db, source.id, sample);
    const result = refresh(db, source, rule, now);
    const nextDueAt = sourceState(db, source.id).next_due_at;
    const reason =
      state === 'REDUCED'
        ? `Reduced cadence (every ${intervalMinutes(source, 'REDUCED')} min): collected a full window.`
        : `Normal cadence: full collection every ${source.base_interval_minutes} min.`;
    recordCollectionRun(db, source.id, {
      plannedAt: dueAt,
      ranAt: now,
      state,
      action: state === 'REDUCED' ? 'collect_reduced' : 'collect',
      reason,
      sampleId,
    });
    actions.push({
      sourceId: source.id,
      state,
      action: state === 'REDUCED' ? 'collect_reduced' : 'collect',
      reason,
      windowEnd,
      sampleId,
      stateAfter: result.state,
      nextDueAt,
    });
  }

  return { at: now, ruleVersion: rule.version, actions };
}

function describeNext(state) {
  if (state === 'NORMAL') return 'collection';
  if (state === 'REDUCED') return 'reduced-cadence collection';
  return 'diagnostic probe';
}

function nextWindowBoundary(nowIso, latest) {
  const hour = new Date(nowIso);
  hour.setUTCMinutes(0, 0, 0);
  let candidate = hour.toISOString();
  if (latest && latest.window_end >= candidate) {
    candidate = new Date(new Date(latest.window_end).getTime() + 3_600_000).toISOString();
  }
  // A collection window must have closed before it can be observed.
  return candidate > nowIso ? null : candidate;
}

/** Re-evaluate one source under a rule and persist derived state. */
export function refresh(db, source, rule, now) {
  const evaluation = evaluateTimeline(db, source, rule, { now });
  applyEvaluation(db, source, rule, evaluation, { now });
  const state = sourceState(db, source.id);
  return { state: state.state, nextDueAt: state.next_due_at, timeline: evaluation };
}

/**
 * Publish a new immutable rule version and recompute all history under it.
 * Raw monitoring is fingerprinted before and after; the run records whether it
 * changed. It never should - the append-only triggers would reject it anyway.
 */
export function publishAndRecompute(db, ruleInput, { actor = 'operator', note = '', label, from, to } = {}) {
  const digestBefore = sampleDigest(db, { from, to });
  // Compare the new version against whatever was live *before* switching, so
  // "changedPoints" answers "how much history does this rule change?".
  const previousVersion = activeRule(db).version;
  const version = publishRule(db, ruleInput, { actor, note, label });
  const rule = activeRule(db);
  const run = recomputeAll(db, rule, { from, to, digestBefore, baselineVersion: previousVersion });
  return { version, run, rule, previousVersion };
}

/** Re-score every source's history under a rule version (derived tables only). */
export function recomputeAll(db, rule, { from, to, digestBefore, baselineVersion: baselineVersionArg } = {}) {
  const startedAt = new Date().toISOString();
  const before = digestBefore ?? sampleDigest(db, { from, to });
  const sources = listSources(db);
  let samplesSeen = 0;
  let pointsWritten = 0;
  let transitionsWritten = 0;
  let changedPoints = 0;

  // One transaction for the whole re-score: derived tables are rewritten per
  // source and there is no meaningful partial state in between. On disk (WAL)
  // this is the difference between ~50ms and ~8s of per-row fsyncs.
  db.exec('BEGIN');
  try {
    const replayNow = new Date().toISOString();
    for (const source of sources) {
      // Baseline for the diff is the previously live rule (or the same version
      // on a re-run), never an empty set - otherwise every point looks "changed".
      const baselineVersion = baselineVersionArg ?? rule.version;
      const previous = listScorePoints(db, source.id, baselineVersion, { from, to });
      const previousByWindow = new Map(previous.map((p) => [p.windowEnd, p]));
      const evaluation = evaluateTimeline(db, source, rule, { from, to, now: replayNow });
      samplesSeen += evaluation.samples.length;
      pointsWritten += evaluation.points.length;
      transitionsWritten += evaluation.transitions.length;
      for (const p of evaluation.points) {
        const old = previousByWindow.get(p.windowEnd);
        if (!old || old.state !== p.state || Math.abs(old.score - p.smoothed) > 0.05) changedPoints += 1;
      }
      applyEvaluation(db, source, rule, evaluation, { now: replayNow });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const after = sampleDigest(db, { from, to });
  const finishedAt = new Date().toISOString();
  const rawUnchanged = before.digest === after.digest && before.count === after.count;
  db.prepare(
    `INSERT INTO recompute_runs (rule_version, from_window, to_window, sources, samples, points,
      transitions, changed_points, digest_before, digest_after, raw_unchanged, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rule.version,
    from ?? '',
    to ?? '',
    sources.length,
    samplesSeen,
    pointsWritten,
    transitionsWritten,
    changedPoints,
    before.digest,
    after.digest,
    rawUnchanged ? 1 : 0,
    startedAt,
    finishedAt
  );

  return {
    ruleVersion: rule.version,
    sources: sources.length,
    samples: samplesSeen,
    points: pointsWritten,
    transitions: transitionsWritten,
    changedPoints,
    digestBefore: before.digest,
    digestAfter: after.digest,
    rawUnchanged,
    startedAt,
    finishedAt,
  };
}

/**
 * Pure preview: score the same history under a candidate rule and report what
 * would change, without writing anything.
 */
export function previewRule(db, ruleInput, { from, to } = {}) {
  const sources = listSources(db);
  const results = [];
  for (const source of sources) {
    const { samples, actions, probes } = replayInputs(db, source, { from, to });
    const preview = buildTimeline(samples, ruleInput, actions, { probes, now: new Date().toISOString() });
    const liveVersion = sourceState(db, source.id)?.rule_version;
    const current = liveVersion ? listScorePoints(db, source.id, liveVersion, { from, to }) : [];
    const currentByWindow = new Map(current.map((p) => [p.windowEnd, p]));
    let changed = 0;
    for (const p of preview.points) {
      const old = currentByWindow.get(p.windowEnd);
      if (!old || old.state !== p.state) changed += 1;
    }
    results.push({
      sourceId: source.id,
      currentState: sourceState(db, source.id)?.state ?? 'NORMAL',
      previewState: preview.finalState,
      changedWindows: changed,
      windows: preview.points.length,
      transitions: preview.transitions.length,
      currentTransitions: current.filter((p) => p.changed).length,
    });
  }
  return {
    sources: results,
    totalChanged: results.reduce((sum, r) => sum + r.changedWindows, 0),
    stateFlips: results.filter((r) => r.currentState !== r.previewState).length,
  };
}

/** Operator releases a source back to automatic scheduling. */
export function releaseToNormal(db, sourceId, { actor, note, at = new Date().toISOString() } = {}) {
  const source = getSource(db, sourceId);
  if (!source) return null;
  db.prepare(
    `INSERT INTO operator_actions (source_id, at, action, actor, note, hold_hours)
     VALUES (?, ?, 'release', ?, ?, NULL)
     ON CONFLICT(source_id, at, action, actor) DO NOTHING`
  ).run(sourceId, at, actor, note);
  return refresh(db, source, activeRule(db), at);
}

/** Operator holds a source: automatic scheduling pauses until released. */
export function holdSource(db, sourceId, { actor, note, holdHours = null, at = new Date().toISOString() } = {}) {
  const source = getSource(db, sourceId);
  if (!source) return null;
  db.prepare(
    `INSERT INTO operator_actions (source_id, at, action, actor, note, hold_hours)
     VALUES (?, ?, 'hold', ?, ?, ?)
     ON CONFLICT(source_id, at, action, actor) DO NOTHING`
  ).run(sourceId, at, actor, note, holdHours);
  return refresh(db, source, activeRule(db), at);
}

export { intervalMinutes, nextDueFor, listRules, listOperatorActions };
