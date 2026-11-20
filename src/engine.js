import {
  listOperatorActions,
  listProbes,
  listSamples,
  listScorePoints,
  replaceScorePoints,
  replaceTransitions,
  sourceState,
  upsertSourceState,
} from './repo.js';
import { buildTimeline } from './scoring.js';

/** Minutes until the next collection for a state. */
export function intervalMinutes(source, state) {
  if (state === 'NORMAL') return source.base_interval_minutes;
  if (state === 'REDUCED') return source.base_interval_minutes * 3;
  // Isolation recovers through cheap probes, so they run more often than the
  // regular probe cadence. A held source is the operator's call: probe slowly.
  if (state === 'ISOLATED') return 30;
  return source.probe_interval_minutes; // MANUAL: probe only
}

export function nextDueFor(source, state, fromIso) {
  return new Date(new Date(fromIso).getTime() + intervalMinutes(source, state) * 60_000).toISOString();
}

/**
 * Immutable replay inputs for one source: raw samples, operator actions and
 * diagnostic probes. Nothing here is derived, so the same triple always
 * produces the same timeline - which is what makes recompute trustworthy.
 */
export function replayInputs(db, source, { from, to } = {}) {
  const samples = listSamples(db, source.id, { from, to });
  const actions = listOperatorActions(db, source.id, { from, to }).map((a) => ({
    at: a.at,
    action: a.action,
    note: a.note,
    actor: a.actor,
    holdHours: a.hold_hours,
  }));
  const probes = listProbes(db, source.id, 100_000)
    .reverse() // listProbes is newest-first
    .filter((p) => (!from || p.at >= from) && (!to || p.at <= to))
    .map((p) => ({ at: p.at, outcome: p.outcome }));
  return { samples, actions, probes };
}

/**
 * The single evaluation path used by the scheduler, history recompute and the
 * API. Live behaviour and a rule replay therefore cannot drift apart.
 */
export function evaluateTimeline(db, source, rule, range) {
  const inputs = replayInputs(db, source, range);
  const timeline = buildTimeline(inputs.samples, rule, inputs.actions, {
    probes: inputs.probes,
    now: range?.now ?? null,
  });
  return { ...inputs, ...timeline };
}

/** Dwell = how many consecutive windows the applied state has persisted. */
function withDwell(points) {
  let dwell = 0;
  return points.map((p, i) => {
    if (i === 0 || p.changed) dwell = 0;
    else dwell += 1;
    return { ...p, dwell };
  });
}

/**
 * Persist an evaluation for a rule version and optionally make it the live
 * scheduling state. score_points and state_transitions are derived data and
 * may be freely replaced; samples, probes and operator_actions are never
 * touched.
 */
export function applyEvaluation(
  db,
  source,
  rule,
  timeline,
  { makeLive = true, now = new Date().toISOString() } = {}
) {
  // A rebuild deletes and re-inserts every derived row for the source. Batching
  // it matters on disk (WAL autocommit fsyncs per statement); callers that
  // already hold a transaction keep theirs.
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN');
  try {
    const points = writeEvaluation(db, source, rule, timeline, { makeLive, now });
    if (own) db.exec('COMMIT');
    return points;
  } catch (error) {
    if (own) db.exec('ROLLBACK');
    throw error;
  }
}

function writeEvaluation(db, source, rule, timeline, { makeLive, now }) {
  const points = withDwell(timeline.points);
  replaceScorePoints(db, source.id, rule.version, points);
  replaceTransitions(db, source.id, rule.version, timeline.transitions);

  if (makeLive) {
    const previous = sourceState(db, source.id);
    const last = points.at(-1);
    const stateChanged = !previous || previous.state !== timeline.finalState;
    const sinceTransition = [...timeline.transitions].reverse().find((t) => t.toState === timeline.finalState);
    const since = stateChanged ? sinceTransition?.at ?? last?.windowEnd ?? now : previous.since;
    upsertSourceState(db, source.id, {
      state: timeline.finalState,
      since,
      score: last?.smoothed ?? 0,
      rawScore: last?.rawScore ?? 0,
      ruleVersion: rule.version,
      counters: last?.counters ?? {},
      dwell: last?.dwell ?? 0,
      lastSampleAt: last?.windowEnd ?? previous?.last_sample_at ?? null,
      lastReason: previous && previous.state === timeline.finalState ? previous.last_reason : lastReason(timeline),
      nextDueAt: nextDueFor(source, timeline.finalState, now),
    });
  }

  return points;
}

function lastReason(timeline) {
  const last = timeline.transitions.at(-1);
  if (last) return `${last.reason}`;
  return timeline.points.at(-1)?.reasons?.[0]?.detail ?? null;
}

export function loadPoints(db, sourceId, ruleVersion, range) {
  return listScorePoints(db, sourceId, ruleVersion, range);
}

export function recordCollectionRun(db, sourceId, run) {
  const info = db
    .prepare(
      `INSERT INTO collection_runs (source_id, planned_at, ran_at, state, action, reason, sample_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sourceId, run.plannedAt, run.ranAt, run.state, run.action, run.reason, run.sampleId ?? null);
  return Number(info.lastInsertRowid);
}

export function listCollectionRuns(db, sourceId, limit = 40) {
  return db
    .prepare('SELECT * FROM collection_runs WHERE source_id = ? ORDER BY ran_at DESC, id DESC LIMIT ?')
    .all(sourceId, limit);
}

export { buildTimeline };
