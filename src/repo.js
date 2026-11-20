import { createHash } from 'node:crypto';
import { DEFAULT_RULE, normalizeRule } from './scoring.js';

export function listSources(db) {
  return db.prepare('SELECT * FROM sources ORDER BY tier DESC, id').all().map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
  }));
}

export function getSource(db, id) {
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  return row ? { ...row, enabled: Boolean(row.enabled) } : null;
}

export function insertSource(db, source) {
  db.prepare(
    `INSERT INTO sources (id, name, kind, url, tier, owner, notes, scenario, base_interval_minutes, probe_interval_minutes, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    source.id,
    source.name,
    source.kind,
    source.url,
    source.tier,
    source.owner,
    source.notes ?? null,
    source.scenario ?? 'stable',
    source.baseIntervalMinutes ?? 60,
    source.probeIntervalMinutes ?? 240
  );
}

export function listSamples(db, sourceId, { from, to } = {}) {
  const clauses = ['source_id = ?'];
  const params = [sourceId];
  if (from) {
    clauses.push('window_end >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('window_end <= ?');
    params.push(to);
  }
  return db
    .prepare(`SELECT * FROM samples WHERE ${clauses.join(' AND ')} ORDER BY window_end ASC`)
    .all(...params);
}

export function latestSample(db, sourceId) {
  return db
    .prepare('SELECT * FROM samples WHERE source_id = ? ORDER BY window_end DESC LIMIT 1')
    .get(sourceId) ?? null;
}

export function insertSample(db, sourceId, sample) {
  const info = db
    .prepare(
      `INSERT INTO samples (
        source_id, window_start, window_end, collected_at, attempts, successes, failures,
        latency_p50_ms, latency_p95_ms, empty_results, records_expected, records_returned,
        field_jaccard, fields_seen, rate_limited, throttled_ms, schema_id, run_kind, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, window_end) DO NOTHING`
    )
    .run(
      sourceId,
      sample.windowStart,
      sample.windowEnd,
      sample.collectedAt,
      sample.attempts,
      sample.successes,
      sample.failures,
      sample.latencyP50,
      sample.latencyP95,
      sample.emptyResults,
      sample.recordsExpected,
      sample.recordsReturned,
      sample.fieldJaccard,
      JSON.stringify(sample.fieldsSeen ?? []),
      sample.rateLimited,
      sample.throttledMs,
      sample.schemaId,
      sample.runKind ?? 'scheduled',
      sample.note ?? null
    );
  return Number(info.lastInsertRowid);
}

/**
 * Fingerprint of the raw monitoring in a window. Every recompute records this
 * before and after, so "history was re-scored, raw data was not rewritten" is
 * a verifiable fact rather than a claim.
 */
export function sampleDigest(db, { sourceId, from, to } = {}) {
  const clauses = [];
  const params = [];
  if (sourceId) {
    clauses.push('source_id = ?');
    params.push(sourceId);
  }
  if (from) {
    clauses.push('window_end >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('window_end <= ?');
    params.push(to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM samples ${where} ORDER BY source_id, window_end`).all(...params);
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row));
  return { count: rows.length, digest: `${rows.length}:${hash.digest('hex').slice(0, 16)}` };
}

export function listRules(db) {
  return db.prepare('SELECT * FROM scoring_rules ORDER BY version DESC').all().map((row) => ({
    ...row,
    config: JSON.parse(row.config),
    active: Boolean(row.active),
  }));
}

export function activeRule(db) {
  const row = db.prepare('SELECT * FROM scoring_rules WHERE active = 1 ORDER BY version DESC LIMIT 1').get();
  if (!row) return { ...normalizeRule(DEFAULT_RULE), version: 0 };
  return normalizeRule({ ...JSON.parse(row.config), version: row.version, label: row.label });
}

export function getRule(db, version) {
  const row = db.prepare('SELECT * FROM scoring_rules WHERE version = ?').get(version);
  if (!row) return null;
  return normalizeRule({ ...JSON.parse(row.config), version: row.version, label: row.label });
}

export function publishRule(db, input, { actor = 'operator', note = '', label } = {}) {
  const normalized = normalizeRule(input);
  const next = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM scoring_rules').get().v;
  const { version, label: ruleLabel, ...config } = normalized;
  void version;
  db.prepare(
    `INSERT INTO scoring_rules (version, config, label, change_note, created_by, created_at, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  ).run(
    next,
    JSON.stringify(config),
    label ?? (ruleLabel && !ruleLabel.startsWith('v1 ') ? ruleLabel : `v${next} · custom`),
    note,
    actor,
    new Date().toISOString()
  );
  db.prepare('UPDATE scoring_rules SET active = 0 WHERE version != ?').run(next);
  return next;
}

export function listOperatorActions(db, sourceId, { from, to } = {}) {
  const clauses = ['source_id = ?'];
  const params = [sourceId];
  if (from) {
    clauses.push('at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('at <= ?');
    params.push(to);
  }
  return db
    .prepare(`SELECT * FROM operator_actions WHERE ${clauses.join(' AND ')} ORDER BY at ASC, id ASC`)
    .all(...params);
}

export function listAllOperatorActions(db, { from, to } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('at <= ?');
    params.push(to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM operator_actions ${where} ORDER BY at ASC, id ASC`).all(...params);
}

export function insertOperatorAction(db, sourceId, action) {
  db.prepare(
    `INSERT INTO operator_actions (source_id, at, action, actor, note, hold_hours)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, at, action, actor) DO NOTHING`
  ).run(sourceId, action.at, action.action, action.actor, action.note, action.holdHours ?? null);
}

export function sourceState(db, sourceId) {
  return db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(sourceId) ?? null;
}

export function listSourceStates(db) {
  return db.prepare('SELECT * FROM source_state').all();
}

export function upsertSourceState(db, sourceId, patch) {
  const existing = sourceState(db, sourceId);
  const now = new Date().toISOString();
  if (!existing) {
    db.prepare(
      `INSERT INTO source_state (source_id, state, since, score, raw_score, rule_version,
        counters, dwell, next_due_at, last_sample_at, last_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sourceId,
      patch.state ?? 'NORMAL',
      patch.since ?? now,
      patch.score ?? 0,
      patch.rawScore ?? 0,
      patch.ruleVersion ?? 0,
      JSON.stringify(patch.counters ?? {}),
      patch.dwell ?? 0,
      patch.nextDueAt ?? null,
      patch.lastSampleAt ?? null,
      patch.lastReason ?? null,
      now
    );
    return;
  }
  const next = {
    state: patch.state ?? existing.state,
    since: patch.since ?? existing.since,
    score: patch.score ?? existing.score,
    raw_score: patch.rawScore ?? existing.raw_score,
    rule_version: patch.ruleVersion ?? existing.rule_version,
    counters: patch.counters === undefined ? existing.counters : JSON.stringify(patch.counters),
    dwell: patch.dwell ?? existing.dwell,
    next_due_at: patch.nextDueAt === undefined ? existing.next_due_at : patch.nextDueAt,
    last_sample_at: patch.lastSampleAt === undefined ? existing.last_sample_at : patch.lastSampleAt,
    last_reason: patch.lastReason === undefined ? existing.last_reason : patch.lastReason,
  };
  db.prepare(
    `UPDATE source_state SET state = ?, since = ?, score = ?, raw_score = ?, rule_version = ?,
      counters = ?, dwell = ?, next_due_at = ?, last_sample_at = ?, last_reason = ?, updated_at = ?
     WHERE source_id = ?`
  ).run(
    next.state,
    next.since,
    next.score,
    next.raw_score,
    next.rule_version,
    next.counters,
    next.dwell,
    next.next_due_at,
    next.last_sample_at,
    next.last_reason,
    now,
    sourceId
  );
}

export function deserializePoint(row) {
  return {
    windowEnd: row.window_end,
    ruleVersion: row.rule_version,
    rawScore: row.raw_score,
    score: row.score,
    smoothed: row.score,
    state: row.state,
    previousState: row.previous_state,
    changed: Boolean(row.changed),
    dwell: row.dwell,
    confidence: row.confidence,
    factors: JSON.parse(row.factors),
    context: JSON.parse(row.context),
    reasons: JSON.parse(row.reasons),
    weakest: row.weakest,
    counters: row.counters ? JSON.parse(row.counters) : {},
  };
}

export function listScorePoints(db, sourceId, ruleVersion, { from, to } = {}) {
  const clauses = ['source_id = ?', 'rule_version = ?'];
  const params = [sourceId, ruleVersion];
  if (from) {
    clauses.push('window_end >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('window_end <= ?');
    params.push(to);
  }
  return db
    .prepare(`SELECT * FROM score_points WHERE ${clauses.join(' AND ')} ORDER BY window_end ASC`)
    .all(...params)
    .map(deserializePoint);
}

export function replaceScorePoints(db, sourceId, ruleVersion, points) {
  const del = db.prepare('DELETE FROM score_points WHERE source_id = ? AND rule_version = ?');
  const ins = db.prepare(
    `INSERT INTO score_points (source_id, window_end, rule_version, raw_score, score, state,
      previous_state, changed, dwell, confidence, factors, context, reasons, weakest, counters, built_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const builtAt = new Date().toISOString();
  del.run(sourceId, ruleVersion);
  for (const p of points) {
    ins.run(
      sourceId,
      p.windowEnd,
      ruleVersion,
      p.rawScore,
      p.smoothed,
      p.state,
      p.previousState,
      p.changed ? 1 : 0,
      p.dwell ?? 0,
      p.confidence,
      JSON.stringify(p.factors),
      JSON.stringify(p.context),
      JSON.stringify(p.reasons),
      p.weakest ?? null,
      JSON.stringify(p.counters ?? {}),
      builtAt
    );
  }
}

export function replaceTransitions(db, sourceId, ruleVersion, transitions) {
  const del = db.prepare('DELETE FROM state_transitions WHERE source_id = ? AND rule_version = ?');
  const ins = db.prepare(
    `INSERT OR IGNORE INTO state_transitions
      (source_id, at, window_end, rule_version, from_state, to_state, reason_code, reason, score, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  del.run(sourceId, ruleVersion);
  for (const t of transitions) {
    ins.run(
      sourceId,
      t.at,
      t.windowEnd ?? t.at,
      ruleVersion,
      t.fromState,
      t.toState,
      t.reasonCode,
      t.reason,
      t.score ?? null,
      t.actor ?? 'scheduler'
    );
  }
}

export function listTransitions(db, sourceId, ruleVersion, { from, to } = {}) {
  const clauses = ['source_id = ?', 'rule_version = ?'];
  const params = [sourceId, ruleVersion];
  if (from) {
    clauses.push('at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('at <= ?');
    params.push(to);
  }
  return db
    .prepare(`SELECT * FROM state_transitions WHERE ${clauses.join(' AND ')} ORDER BY at ASC, id ASC`)
    .all(...params)
    .map((row) => ({
      at: row.at,
      windowEnd: row.window_end,
      fromState: row.from_state,
      toState: row.to_state,
      reasonCode: row.reason_code,
      reason: row.reason,
      score: row.score,
      actor: row.actor,
      ruleVersion: row.rule_version,
    }));
}

export function listAllCollectionRuns(db, limit = 100) {
  return db.prepare('SELECT * FROM collection_runs ORDER BY ran_at DESC, id DESC LIMIT ?').all(limit);
}

export function insertProbe(db, sourceId, probe) {
  db.prepare(
    `INSERT INTO health_probes (source_id, at, state, score, outcome, findings, next_probe_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sourceId,
    probe.at,
    probe.state,
    probe.score ?? null,
    probe.outcome,
    JSON.stringify(probe.findings ?? []),
    probe.nextProbeAt ?? null
  );
}

export function listProbes(db, sourceId, limit = 30) {
  return db
    .prepare('SELECT * FROM health_probes WHERE source_id = ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(sourceId, limit)
    .map((row) => ({ ...row, findings: JSON.parse(row.findings) }));
}

export function listRecomputeRuns(db, limit = 20) {
  return db
    .prepare('SELECT * FROM recompute_runs ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((row) => ({ ...row, raw_unchanged: Boolean(row.raw_unchanged) }));
}
