import { listSources, listSourceStates, listRules, activeRule, getSource } from './repo.js';

const STATE_ORDER = { ISOLATED: 0, MANUAL: 1, REDUCED: 2, NORMAL: 3 };

export function overview(db, nowIso = new Date().toISOString()) {
  const sources = listSources(db);
  const states = new Map(listSourceStates(db).map((s) => [s.source_id, s]));
  const rule = activeRule(db);

  const rows = sources.map((source) => {
    const state = states.get(source.id);
    const transitions = db
      .prepare(
        'SELECT * FROM state_transitions WHERE source_id = ? AND rule_version = ? ORDER BY at ASC'
      )
      .all(source.id, rule.version);
    const latestPoint = db
      .prepare(
        'SELECT factors FROM score_points WHERE source_id = ? AND rule_version = ? ORDER BY window_end DESC LIMIT 1'
      )
      .get(source.id, rule.version);
    const windows = db
      .prepare('SELECT COUNT(*) AS c FROM score_points WHERE source_id = ? AND rule_version = ?')
      .get(source.id, rule.version).c;
    return {
      id: source.id,
      name: source.name,
      kind: source.kind,
      tier: source.tier,
      owner: source.owner,
      url: source.url,
      notes: source.notes,
      scenario: source.scenario,
      state: state?.state ?? 'UNKNOWN',
      since: state?.since ?? null,
      dwell: state?.dwell ?? 0,
      score: state?.score ?? null,
      rawScore: state?.raw_score ?? null,
      factors: latestPoint ? JSON.parse(latestPoint.factors) : null,
      windows,
      lastReason: state?.last_reason ?? null,
      lastSampleAt: state?.last_sample_at ?? null,
      nextDueAt: state?.next_due_at ?? null,
      intervalMinutes:
        state?.state === 'REDUCED'
          ? source.base_interval_minutes * 3
          : state?.state === 'ISOLATED'
            ? 30
            : state?.state === 'MANUAL'
              ? source.probe_interval_minutes
              : source.base_interval_minutes,
      transitions: transitions.length,
      isolations: transitions.filter((t) => t.to_state === 'ISOLATED').length,
      lastTransition: transitions.at(-1) ?? null,
    };
  });

  rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.tier.localeCompare(b.tier) || a.id.localeCompare(b.id));

  const counts = { NORMAL: 0, REDUCED: 0, ISOLATED: 0, MANUAL: 0 };
  for (const row of rows) if (counts[row.state] !== undefined) counts[row.state] += 1;

  return {
    generatedAt: nowIso,
    rule: { version: rule.version, label: rule.label },
    counts,
    isolations: db
      .prepare(
        "SELECT COUNT(*) AS c FROM state_transitions WHERE rule_version = ? AND to_state = 'ISOLATED'"
      )
      .get(rule.version).c,
    // Fleet-wide count of windows where evidence was held back for confirmation.
    // This is the number that proves transients are buffered, not acted on.
    confirmationPending: db
      .prepare(
        `SELECT COUNT(*) AS c FROM score_points
         WHERE rule_version = ? AND reasons LIKE '%confirmation_pending%'`
      )
      .get(rule.version).c,    sources: rows,
    recentTransitions: recentTransitions(db, rule.version, 14),
  };
}

/**
 * Newest transitions, capped per source so one chatty source cannot crowd the
 * fleet log - the log is for spotting patterns across the fleet.
 */
function recentTransitions(db, ruleVersion, limit) {
  const rows = db
    .prepare('SELECT * FROM state_transitions WHERE rule_version = ? ORDER BY at DESC, id DESC LIMIT 400')
    .all(ruleVersion);
  const perSource = new Map();
  const out = [];
  for (const row of rows) {
    const seen = perSource.get(row.source_id) ?? 0;
    if (seen >= 3) continue;
    perSource.set(row.source_id, seen + 1);
    out.push(shapeTransition(row));
    if (out.length >= limit) break;
  }
  return out;
}

export function transitionFeed(db, limit = 60) {
  const rule = activeRule(db);
  return db
    .prepare('SELECT * FROM state_transitions WHERE rule_version = ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(rule.version, limit)
    .map(shapeTransition);
}

function shapeTransition(row) {
  return {
    sourceId: row.source_id,
    at: row.at,
    fromState: row.from_state,
    toState: row.to_state,
    reasonCode: row.reason_code,
    reason: row.reason,
    actor: row.actor,
    score: row.score,
  };
}

const FACTOR_LABEL = {
  success: 'Success rate',
  latency: 'Latency',
  empty: 'Empty results',
  drift: 'Structural drift',
  throttle: 'Rate limiting',
};

export function sourceDetail(db, sourceId, { from, to, now } = {}) {
  const source = getSource(db, sourceId);
  if (!source) return null;
  const rule = activeRule(db);
  const state = listSourceStates(db).find((s) => s.source_id === sourceId);

  const points = db
    .prepare(
      `SELECT * FROM score_points WHERE source_id = ? AND rule_version = ?
       ${from ? 'AND window_end >= ?' : ''} ${to ? 'AND window_end <= ?' : ''}
       ORDER BY window_end ASC`
    )
    .all(sourceId, rule.version, ...(from ? [from] : []), ...(to ? [to] : []))
    .map(shapePoint);

  const transitions = db
    .prepare('SELECT * FROM state_transitions WHERE source_id = ? AND rule_version = ? ORDER BY at ASC')
    .all(sourceId, rule.version)
    .map(shapeTransition);

  const actions = db
    .prepare('SELECT * FROM operator_actions WHERE source_id = ? ORDER BY at ASC')
    .all(sourceId)
    .map((a) => ({
      at: a.at,
      action: a.action,
      actor: a.actor,
      note: a.note,
      holdHours: a.hold_hours,
    }));

  const probes = db
    .prepare('SELECT * FROM health_probes WHERE source_id = ? ORDER BY at DESC LIMIT 25')
    .all(sourceId)
    .map((p) => ({
      at: p.at,
      state: p.state,
      outcome: p.outcome,
      findings: JSON.parse(p.findings),
      score: p.score,
    }));

  const runs = db
    .prepare('SELECT * FROM collection_runs WHERE source_id = ? ORDER BY ran_at DESC, id DESC LIMIT 25')
    .all(sourceId)
    .map((r) => ({
      at: r.ran_at,
      plannedAt: r.planned_at,
      state: r.state,
      action: r.action,
      reason: r.reason,
    }));

  const latest = points.at(-1);
  const reasonCounts = {};
  for (const t of transitions) reasonCounts[t.reasonCode] = (reasonCounts[t.reasonCode] ?? 0) + 1;

  return {
    source: {
      id: source.id,
      name: source.name,
      kind: source.kind,
      url: source.url,
      tier: source.tier,
      owner: source.owner,
      notes: source.notes,
      scenario: source.scenario,
      baseIntervalMinutes: source.base_interval_minutes,
      probeIntervalMinutes: source.probe_interval_minutes,
    },
    rule: { version: rule.version, label: rule.label, thresholds: rule.thresholds, smoothing: rule.smoothing },
    state: state
      ? {
          state: state.state,
          since: state.since,
          score: state.score,
          rawScore: state.raw_score,
          dwell: state.dwell,
          nextDueAt: state.next_due_at,
          lastSampleAt: state.last_sample_at,
          lastReason: state.last_reason,
        }
      : null,
    factorLabels: FACTOR_LABEL,
    // The requested range, echoed back with "now" so the client can draw the
    // full window - an isolated source's chart must show the collection gap,
    // not silently end at its last sample.
    range: {
      from: from ?? points[0]?.windowEnd ?? null,
      to: to ?? now ?? new Date().toISOString(),
    },
    points,
    transitions,
    actions,
    probes,
    runs,
    current: latest
      ? {
          factors: latest.factors,
          context: latest.context,
          reasons: latest.reasons,
          confidence: latest.confidence,
          weakest: latest.weakest,
        }
      : null,
    reasonCounts,
    stateDurations: stateDurations(transitions, points.at(-1)?.windowEnd ?? new Date().toISOString()),
  };
}

function shapePoint(row) {
  return {
    windowEnd: row.window_end,
    rawScore: row.raw_score,
    score: row.score,
    state: row.state,
    previousState: row.previous_state,
    changed: Boolean(row.changed),
    dwell: row.dwell,
    confidence: row.confidence,
    factors: JSON.parse(row.factors),
    context: JSON.parse(row.context),
    reasons: JSON.parse(row.reasons),
    weakest: row.weakest,
  };
}

function stateDurations(transitions, untilIso) {
  if (!transitions.length) return [];
  const out = [];
  for (let i = 0; i < transitions.length; i += 1) {
    const t = transitions[i];
    const next = transitions[i + 1];
    const end = next ? next.at : untilIso;
    out.push({
      state: t.toState,
      from: t.at,
      to: end,
      hours: Math.max(0, (new Date(end) - new Date(t.at)) / 3_600_000),
    });
  }
  return out;
}

export function rulesWithRuns(db) {
  return {
    rules: listRules(db).map((r) => ({
      version: r.version,
      label: r.label,
      active: r.active,
      note: r.change_note,
      createdBy: r.created_by,
      createdAt: r.created_at,
      config: r.config,
    })),
    recomputes: db
      .prepare('SELECT * FROM recompute_runs ORDER BY id DESC LIMIT 12')
      .all()
      .map((r) => ({
        id: r.id,
        ruleVersion: r.rule_version,
        from: r.from_window || null,
        to: r.to_window || null,
        sources: r.sources,
        samples: r.samples,
        points: r.points,
        transitions: r.transitions,
        changedPoints: r.changed_points,
        digestBefore: r.digest_before,
        digestAfter: r.digest_after,
        rawUnchanged: Boolean(r.raw_unchanged),
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        durationMs: new Date(r.finished_at) - new Date(r.started_at),
      })),
    activeVersion: activeRule(db).version,
  };
}
