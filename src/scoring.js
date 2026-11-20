/**
 * Pure scoring engine. No I/O, no clock reads - callers supply samples and the
 * rule. Determinism here is what makes "recompute history under a new rule
 * without touching raw monitoring" possible.
 */

export const FACTOR_KEYS = ['success', 'latency', 'empty', 'drift', 'throttle'];

export const DEFAULT_RULE = Object.freeze({
  version: 1,
  weights: { success: 0.34, latency: 0.22, empty: 0.18, drift: 0.18, throttle: 0.08 },
  thresholds: {
    reducedBelow: 72,
    isolatedBelow: 48,
    // A single noisy window is evidence, not a verdict. Degradation must be
    // confirmed over consecutive windows before the schedule changes; only
    // catastrophic scores (near-total outage) bypass confirmation.
    confirmWindows: 2,
    criticalBelow: 25,
    // Recovery hysteresis: clear the threshold by this margin and hold the
    // state for minWindowsInState windows before promotion.
    promoteMargin: 6,
    minWindowsInState: 2,
    // An isolated source is probed rather than collected. Consecutive healthy
    // probes are required before the scheduler half-opens it again.
    probeRecovery: 3,
  },
  smoothing: { points: 3, alpha: 0.6, confidenceRamp: 6 },
  latencyBudgetMs: { p95: 1800, p50: 700 },
  emptyBaseline: 0.03,
  driftFloor: 0.92,
  throttleRateBudget: 0.15,
  label: 'v1 · balanced',
  change_note: 'Initial baseline: balanced weights, 3-window EWMA, dwell 2.',
});

export function normalizeRule(rule = {}) {
  const weightsIn = { ...DEFAULT_RULE.weights, ...(rule.weights ?? {}) };
  const total = FACTOR_KEYS.reduce((sum, key) => sum + Math.max(0, weightsIn[key] ?? 0), 0);
  if (total <= 0) throw new Error('scoring weights must contain at least one positive value');
  const weights = {};
  for (const key of FACTOR_KEYS) weights[key] = Math.max(0, weightsIn[key] ?? 0) / total;

  const merged = {
    ...DEFAULT_RULE,
    ...rule,
    weights,
    thresholds: { ...DEFAULT_RULE.thresholds, ...(rule.thresholds ?? {}) },
    smoothing: { ...DEFAULT_RULE.smoothing, ...(rule.smoothing ?? {}) },
    latencyBudgetMs: { ...DEFAULT_RULE.latencyBudgetMs, ...(rule.latencyBudgetMs ?? {}) },
  };
  const t = merged.thresholds;
  if (!(t.isolatedBelow > 0 && t.isolatedBelow < t.reducedBelow && t.reducedBelow < 100)) {
    throw new Error('thresholds must satisfy 0 < isolatedBelow < reducedBelow < 100');
  }
  if (!(t.promoteMargin < 100 - t.reducedBelow)) {
    throw new Error('promoteMargin must leave room below 100 on the reduced threshold');
  }
  if (!(t.promoteMargin >= 0)) throw new Error('promoteMargin must be >= 0');
  if (!(t.confirmWindows >= 1)) throw new Error('confirmWindows must be >= 1');
  if (!(t.criticalBelow > 0 && t.criticalBelow <= t.isolatedBelow)) {
    throw new Error('criticalBelow must be in (0, isolatedBelow]');
  }
  if (!(merged.smoothing.alpha > 0 && merged.smoothing.alpha <= 1)) {
    throw new Error('smoothing.alpha must be in (0, 1]');
  }
  if (!(merged.smoothing.points >= 1)) throw new Error('smoothing.points must be >= 1');
  if (!(merged.smoothing.confidenceRamp >= 1)) throw new Error('smoothing.confidenceRamp must be >= 1');
  if (!(merged.emptyBaseline > 0)) throw new Error('emptyBaseline must be > 0');
  if (!(merged.driftFloor >= 0 && merged.driftFloor < 1)) throw new Error('driftFloor must be in [0, 1)');
  if (!(merged.throttleRateBudget > 0 && merged.throttleRateBudget <= 1)) {
    throw new Error('throttleRateBudget must be in (0, 1]');
  }
  for (const key of ['p95', 'p50']) {
    if (!(merged.latencyBudgetMs[key] > 0)) throw new Error(`latencyBudgetMs.${key} must be > 0`);
  }
  return merged;
}

export function ruleFromRow(row) {
  if (!row) return null;
  return normalizeRule({ ...JSON.parse(row.config), version: row.version });
}

export function ruleConfigForStorage(rule) {
  const { version, ...rest } = normalizeRule(rule);
  void version;
  return rest;
}

// Raw samples arrive snake_case from SQLite and camelCase from the simulator,
// so every read tolerates both spellings.
function pick(sample, snake, camel, fallback) {
  const value = sample[snake] ?? sample[camel];
  return value === undefined || value === null ? fallback : value;
}

/** Each factor is 0..1 where 1 is healthy. */
export function computeFactors(sample, ruleInput) {
  const rule = normalizeRule(ruleInput);
  const attempts = Math.max(1, pick(sample, 'attempts', 'attempts', 1));
  const successRate = Math.max(0, Math.min(1, pick(sample, 'successes', 'successes', 0) / attempts));
  const emptyRate = pick(sample, 'empty_results', 'emptyResults', 0) / attempts;
  const throttleRate = pick(sample, 'rate_limited', 'rateLimited', 0) / attempts;
  const jaccard = pick(sample, 'field_jaccard', 'fieldJaccard', 1);

  // Latency: free below budget, linearly collapsing to zero at 3x budget.
  const { p95: p95Budget, p50: p50Budget } = rule.latencyBudgetMs;
  const over = (ratio) => (ratio <= 1 ? 0 : Math.min(1, (ratio - 1) / 2));
  const p95Excess = over(pick(sample, 'latency_p95_ms', 'latencyP95', 0) / p95Budget);
  const p50Excess = over(pick(sample, 'latency_p50_ms', 'latencyP50', 0) / p50Budget);
  const latency = Math.max(0, 1 - (0.7 * p95Excess + 0.3 * p50Excess));

  // Empty results: baseline noise is free; twice baseline is zero.
  const base = Math.max(0.005, rule.emptyBaseline);
  const empty = Math.max(0, 1 - Math.max(0, emptyRate - base) / (base * 2));

  // Structural drift: Jaccard of returned field set vs expected schema.
  const drift = Math.max(0, Math.min(1, (jaccard - rule.driftFloor) / (1 - rule.driftFloor)));

  // Throttling: rate limiting is a hard signal, it means the source is
  // actively pushing back and deeper collection will only make it worse.
  const throttle = Math.max(0, 1 - Math.min(1, throttleRate / rule.throttleRateBudget));

  return {
    factors: { success: successRate, latency, empty, drift, throttle },
    context: {
      successRate,
      failureRate: 1 - successRate,
      latencyP95: pick(sample, 'latency_p95_ms', 'latencyP95', 0),
      latencyP50: pick(sample, 'latency_p50_ms', 'latencyP50', 0),
      emptyRate,
      jaccard,
      throttleRate,
      attempts,
      recordsReturned: pick(sample, 'records_returned', 'recordsReturned', 0),
      recordsExpected: pick(sample, 'records_expected', 'recordsExpected', 0),
    },
  };
}

export function scoreFromFactors(factors, ruleInput) {
  const rule = normalizeRule(ruleInput);
  let score = 0;
  for (const key of FACTOR_KEYS) score += rule.weights[key] * (factors[key] ?? 0) * 100;
  return Math.max(0, Math.min(100, score));
}

/** Exponentially weighted mean, oldest-first. Causal: never looks ahead. */
export function ewma(values, alpha) {
  if (!values.length) return null;
  let acc = values[0];
  for (let i = 1; i < values.length; i += 1) acc = alpha * values[i] + (1 - alpha) * acc;
  return acc;
}

/**
 * Hysteresis + dwell state machine.
 *
 *   NORMAL --score<threshold--> REDUCED --score<threshold--> ISOLATED
 *   NORMAL <--score>=100-margin, dwell-- REDUCED <--score>=reduced+margin, dwell-- ISOLATED
 *
 * Degradation applies immediately (protecting consumers beats smoothing the
 * entry); promotion requires clearing the recovery threshold *and* dwell.
 */
export function decideState({
  score,
  rawScore,
  previousState = 'NORMAL',
  dwell = 0,
  counters = {},
  rule: ruleInput,
  sample,
}) {
  const rule = normalizeRule(ruleInput);
  const { reducedBelow, isolatedBelow, promoteMargin, minWindowsInState, confirmWindows, criticalBelow } =
    rule.thresholds;
  const raw = rawScore ?? score;

  // Confirmation streaks count *raw* windows, not smoothed ones. Smoothing
  // intentionally lags, so counting smoothed windows would let a single
  // spike look like two consecutive bad windows and defeat the transient
  // guard entirely. Raw evidence is the honest measure of "sustained".
  const nextCounters = {
    isolated_windows: counters.isolated_windows ?? 0,
    reduced_windows: counters.reduced_windows ?? 0,
    drift_windows: counters.drift_windows ?? 0,
    throttle_windows: counters.throttle_windows ?? 0,
    total_windows: (counters.total_windows ?? 0) + 1,
    reduced_streak: raw < reducedBelow ? (counters.reduced_streak ?? 0) + 1 : 0,
    isolated_streak: raw < isolatedBelow ? (counters.isolated_streak ?? 0) + 1 : 0,
  };
  if (score < isolatedBelow) nextCounters.isolated_windows += 1;
  else if (score < reducedBelow) nextCounters.reduced_windows += 1;
  if (pick(sample, 'field_jaccard', 'fieldJaccard', 1) < rule.driftFloor) nextCounters.drift_windows += 1;
  if (pick(sample, 'rate_limited', 'rateLimited', 0) > 0) nextCounters.throttle_windows += 1;

  if (previousState === 'MANUAL') {
    return {
      state: 'MANUAL',
      changed: false,
      reasons: [{ code: 'manual_hold', detail: 'Operator hold is active; automatic scheduling is paused.' }],
      counters: nextCounters,
    };
  }

  const targetSeverity = score < isolatedBelow ? 2 : score < reducedBelow ? 1 : 0;
  const currentSeverity = previousState === 'ISOLATED' ? 2 : previousState === 'REDUCED' ? 1 : 0;
  let state = previousState;
  const reasons = [];

  if (targetSeverity > currentSeverity) {
    // Confirmation gate: sustained evidence before acting, unless the window is
    // catastrophic (a near-total outage should isolate without waiting).
    const streak = targetSeverity === 2 ? nextCounters.isolated_streak : nextCounters.reduced_streak;
    const confirmed = streak >= confirmWindows || raw < criticalBelow;
    if (!confirmed) {
      const needed = targetSeverity === 2 ? 'isolation' : 'reduction';
      reasons.push({
        code: 'confirmation_pending',
        detail: `Raw score ${raw.toFixed(1)} suggests ${needed} (${streak}/${confirmWindows} confirming windows); holding ${previousState}.`,
      });
    } else {
      state = targetSeverity === 2 ? 'ISOLATED' : 'REDUCED';
      reasons.push({
        code: state === 'ISOLATED' ? 'isolated_low_score' : 'reduced_low_score',
        detail: `Score fell below the ${state === 'ISOLATED' ? 'isolation' : 'reduction'} floor for ${streak} consecutive window${streak === 1 ? '' : 's'}.`,
      });
    }
  } else if (targetSeverity < currentSeverity) {
    const recoveryThreshold = currentSeverity === 2 ? reducedBelow + promoteMargin : 100 - promoteMargin;
    const recovered = score >= recoveryThreshold;
    if (recovered && dwell >= minWindowsInState) {
      state = targetSeverity === 0 ? 'NORMAL' : 'REDUCED';
      reasons.push({
        code: 'promoted',
        detail: `Score ${score.toFixed(1)} cleared recovery threshold ${recoveryThreshold} after ${dwell} windows in state.`,
      });
    } else {
      reasons.push({
        code: recovered ? 'dwell_guard' : 'recovery_hold',
        detail: recovered
          ? `Healthy but dwell ${dwell}/${minWindowsInState}; promotion deferred.`
          : `Score ${score.toFixed(1)} below recovery threshold ${recoveryThreshold}; holding ${previousState}.`,
      });
    }
  }

  if (!reasons.length) {
    if (score < isolatedBelow) {
      reasons.push({ code: 'isolated_low_score', detail: `Score ${score.toFixed(1)} remains below the isolation floor.` });
    } else if (score < reducedBelow) {
      reasons.push({ code: 'reduced_low_score', detail: `Score ${score.toFixed(1)} remains below the reduction floor.` });
    } else if (previousState !== 'NORMAL') {
      reasons.push({ code: 'recovery_hold', detail: `Score ${score.toFixed(1)} is healthy; recovery hysteresis is pending.` });
    } else {
      reasons.push({ code: 'healthy', detail: `Score ${score.toFixed(1)} is within the normal band.` });
    }
  }

  return { state, changed: state !== previousState, reasons, counters: nextCounters };
}

/** Score every window; smoothed score is causal EWMA over raw scores. */
export function scoreSamples(samples, ruleInput) {
  const rule = normalizeRule(ruleInput);
  const { points: windowSize, alpha, confidenceRamp } = rule.smoothing;
  const window = Math.max(1, Math.round(windowSize));
  const rawScores = [];

  return samples.map((sample, index) => {
    const { factors, context } = computeFactors(sample, rule);
    const rawScore = scoreFromFactors(factors, rule);
    rawScores.push(rawScore);

    const slice = rawScores.slice(Math.max(0, rawScores.length - window));
    const smoothed = ewma(slice, alpha);
    const confidence = Math.min(1, (index + 1) / confidenceRamp);

    // Weakest factor by lost points, used for the "why" column.
    let weakest = FACTOR_KEYS[0];
    let worstLoss = Infinity;
    for (const key of FACTOR_KEYS) {
      const loss = (1 - factors[key]) * rule.weights[key];
      if (loss > worstLoss) {
        worstLoss = loss;
        weakest = key;
      }
    }

    const reasons = [];
    if (context.successRate < 0.95) {
      reasons.push({
        code: 'success_rate',
        detail: `${(context.successRate * 100).toFixed(1)}% success across ${context.attempts} attempts.`,
      });
    }
    if (factors.latency < 0.95) {
      reasons.push({
        code: 'latency',
        detail: `p95 ${Math.round(context.latencyP95)} ms against a ${rule.latencyBudgetMs.p95} ms budget.`,
      });
    }
    if (factors.empty < 0.95) {
      reasons.push({
        code: 'empty_results',
        detail: `${(context.emptyRate * 100).toFixed(1)}% empty windows vs ${(rule.emptyBaseline * 100).toFixed(1)}% baseline.`,
      });
    }
    if (factors.drift < 0.95) {
      reasons.push({
        code: 'structural_drift',
        detail: `Field overlap ${(context.jaccard * 100).toFixed(1)}% vs drift floor ${(rule.driftFloor * 100).toFixed(0)}%.`,
      });
    }
    if (factors.throttle < 0.95) {
      reasons.push({
        code: 'rate_limited',
        detail: `${(context.throttleRate * 100).toFixed(1)}% of attempts were rate limited.`,
      });
    }

    return {
      sample,
      windowEnd: pick(sample, 'window_end', 'windowEnd', null),
      rawScore,
      smoothed,
      confidence,
      factors,
      context,
      weakest,
      reasons,
    };
  });
}

/**
 * Full evaluated timeline.
 *
 * Three kinds of immutable events are replayed in time order:
 *   - operator actions (hold / release)   -> MANUAL
 *   - collected sample windows            -> scoring + automatic state machine
 *   - diagnostic probes                   -> recovery of ISOLATED sources
 *
 * One point is emitted per collected sample (so it maps 1:1 onto score_points);
 * transitions may also occur at probe timestamps, which is why they are kept in
 * their own ledger rather than inferred from points.
 *
 * @param samples  oldest-first raw samples
 * @param rule     scoring rule
 * @param actions  [{ at, action: 'hold'|'release', note, holdHours, actor }]
 * @param options  { probes: [{ at, outcome }], startState }
 */
export function buildTimeline(samples, ruleInput, actions = [], options = {}) {
  const rule = normalizeRule(ruleInput);
  const scored = scoreSamples(samples, rule);
  const probeRecoveryTarget = rule.thresholds.probeRecovery;
  // "Now" bounds a replay. A hold that has not yet expired must stay in force
  // when the caller is reconstructing history up to an earlier instant.
  const now = options.now ?? null;

  const PRIORITY = { action: 0, sample: 1, probe: 2 };
  const events = [];
  scored.forEach((point, index) => events.push({ at: point.windowEnd, kind: 'sample', index, point }));
  for (const probe of options.probes ?? []) events.push({ at: probe.at, kind: 'probe', probe });
  for (const action of actions) events.push({ at: action.at, kind: 'action', action });
  events.sort((a, b) => (a.at === b.at ? PRIORITY[a.kind] - PRIORITY[b.kind] : a.at < b.at ? -1 : 1));

  let state = options.startState ?? 'NORMAL';
  let dwell = 0;
  let counters = {};
  let holdUntil = null;
  let healthyProbeStreak = 0;
  let lastScore = null;
  const points = [];
  const transitions = [];

  const moveTo = (at, toState, reasonCode, reason, actor, type) => {
    transitions.push({
      at,
      windowEnd: at,
      fromState: state,
      toState,
      reasonCode,
      reason,
      actor,
      type,
      ruleVersion: rule.version,
      score: lastScore,
    });
    state = toState;
    dwell = 0;
    if (toState !== 'ISOLATED') healthyProbeStreak = 0;
    // Entering NORMAL clears confirmation streaks: evidence gathered before an
    // isolation or a hold is stale and must not re-isolate on the first window.
    if (toState === 'NORMAL') {
      counters = { ...counters, reduced_streak: 0, isolated_streak: 0 };
    }
  };

  const expireHold = (at) => {
    if (state === 'MANUAL' && holdUntil && at >= holdUntil) {
      const atIso = holdUntil;
      holdUntil = null;
      // No ISO timestamp in the sentence: the transition table already shows
      // the time, and an inline "2026-11-11T08:00:00.000Z" reads as a bug.
      moveTo(atIso, 'NORMAL', 'manual_hold_expired', 'The operator hold expired; automatic scheduling resumed.', 'system', 'operator');
    }
  };

  for (const event of events) {
    expireHold(event.at);

    if (event.kind === 'action') {
      const action = event.action;
      if (action.action === 'hold') {
        if (state !== 'MANUAL') {
          moveTo(
            action.at,
            'MANUAL',
            'manual_hold',
            action.note ?? 'Operator placed the source on hold.',
            action.actor ?? 'operator',
            'operator'
          );
        }
        holdUntil = action.holdHours
          ? new Date(new Date(action.at).getTime() + action.holdHours * 3_600_000).toISOString()
          : null;
      } else if (action.action === 'release' && state !== 'NORMAL') {
        // Manual recovery is a human decision and is replayed like any other
        // event: it lifts a hold *and* overrides an isolation or a reduction.
        // The state machine resumes on the next window, so a source that is
        // still broken will be caught again after the normal confirmation.
        holdUntil = null;
        moveTo(
          action.at,
          'NORMAL',
          'manual_release',
          action.note ?? 'Operator released the source; resuming automatic scheduling.',
          action.actor ?? 'operator',
          'operator'
        );
      }
      continue;
    }

    if (event.kind === 'probe') {
      // Probes only matter while isolated: they are the evidence that lets a
      // source back in. A hold is the operator's call, so probes are inert there.
      if (state !== 'ISOLATED') continue;
      if (event.probe.outcome === 'healthy') healthyProbeStreak += 1;
      else healthyProbeStreak = 0;
      if (healthyProbeStreak >= probeRecoveryTarget) {
        const streak = healthyProbeStreak;
        healthyProbeStreak = 0;
        moveTo(
          event.at,
          'NORMAL',
          'probe_recovery',
          `${streak} consecutive healthy probes; resuming normal collection.`,
          'scheduler',
          'probe'
        );
        counters = { ...counters, reduced_streak: 0, isolated_streak: 0 };
      }
      continue;
    }

    // Sample window: the only place raw evidence enters the state machine.
    const point = event.point;
    lastScore = point.smoothed;

    if (state === 'MANUAL') {
      points.push({
        ...point,
        type: 'manual',
        previousState: 'MANUAL',
        state: 'MANUAL',
        changed: false,
        reasons: [{ code: 'manual_hold', detail: 'Operator hold is active; automatic scheduling is paused.' }],
        counters: { ...counters },
      });
      continue;
    }

    // While ISOLATED, collection has stopped: a stray sample (e.g. historical
    // data or a manual backfill) records evidence but cannot un-isolate the
    // source. Only consecutive healthy probes may do that.
    if (state === 'ISOLATED') {
      points.push({
        ...point,
        type: 'isolated',
        previousState: 'ISOLATED',
        state: 'ISOLATED',
        changed: false,
        reasons: [
          {
            code: 'isolated_probing',
            detail: `Isolated; probing for recovery (${healthyProbeStreak}/${probeRecoveryTarget} healthy probes).`,
          },
        ],
        counters: { ...counters },
      });
      continue;
    }

    const previousState = state;
    const decision = decideState({
      score: point.smoothed,
      rawScore: point.rawScore,
      previousState,
      dwell,
      counters,
      rule,
      sample: samples[event.index],
    });

    points.push({
      ...point,
      type: 'auto',
      previousState,
      state: decision.state,
      changed: decision.changed,
      reasons: decision.reasons,
      counters: decision.counters,
    });

    if (decision.changed) {
      moveTo(
        point.windowEnd,
        decision.state,
        decision.reasons[0].code,
        decision.reasons[0].detail,
        'scheduler',
        'auto'
      );
      if (decision.state === 'ISOLATED') healthyProbeStreak = 0;
    } else {
      dwell += 1;
    }
    state = decision.state;
    counters = decision.counters;
  }

  // A hold whose expiry has already passed still needs to be reflected in the
  // final state (nothing else may have happened since).
  if (state === 'MANUAL' && holdUntil && (!now || holdUntil <= now)) {
    expireHold(holdUntil);
  }

  return { points, transitions, finalState: state };
}

/** Human-readable single-line summary of a state decision's reasons. */
export function summarizeReasons(reasons) {
  return (reasons ?? []).map((r) => r.detail).join(' ');
}
