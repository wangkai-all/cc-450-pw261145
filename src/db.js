import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  tier TEXT NOT NULL,
  owner TEXT NOT NULL,
  notes TEXT,
  scenario TEXT NOT NULL DEFAULT 'stable',
  base_interval_minutes INTEGER NOT NULL DEFAULT 60,
  probe_interval_minutes INTEGER NOT NULL DEFAULT 240,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- Immutable observation stream. Every collection attempt appends exactly one
-- sample; no scoring, recompute or simulation path may update or delete it.
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  successes INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  latency_p50_ms REAL NOT NULL,
  latency_p95_ms REAL NOT NULL,
  empty_results INTEGER NOT NULL,
  records_expected REAL NOT NULL,
  records_returned REAL NOT NULL,
  field_jaccard REAL NOT NULL,
  fields_seen TEXT NOT NULL,
  rate_limited INTEGER NOT NULL,
  throttled_ms INTEGER NOT NULL,
  schema_id TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  note TEXT,
  UNIQUE (source_id, window_end)
);

CREATE INDEX IF NOT EXISTS samples_source_window
  ON samples (source_id, window_end);

CREATE TRIGGER IF NOT EXISTS samples_no_update
BEFORE UPDATE ON samples
BEGIN
  SELECT RAISE(ABORT, 'samples are append-only; scoring must never rewrite raw monitoring');
END;

CREATE TRIGGER IF NOT EXISTS samples_no_delete
BEFORE DELETE ON samples
BEGIN
  SELECT RAISE(ABORT, 'raw monitoring is append-only and cannot be deleted');
END;

-- Operator intent, kept separate from derived state so a historical recompute
-- replays the same human decisions instead of double-counting them.
CREATE TABLE IF NOT EXISTS operator_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL,
  hold_hours REAL,
  UNIQUE (source_id, at, action, actor)
);

CREATE INDEX IF NOT EXISTS operator_actions_source_at
  ON operator_actions (source_id, at);

CREATE TRIGGER IF NOT EXISTS operator_actions_no_update
BEFORE UPDATE ON operator_actions
BEGIN
  SELECT RAISE(ABORT, 'operator actions are an audit trail; record a new action');
END;

CREATE TRIGGER IF NOT EXISTS operator_actions_no_delete
BEFORE DELETE ON operator_actions
BEGIN
  SELECT RAISE(ABORT, 'operator actions are an audit trail and cannot be deleted');
END;

-- A scoring rule is immutable once written. Configuration changes publish a
-- new version; the old version stays readable for historical recomputation.
CREATE TABLE IF NOT EXISTS scoring_rules (
  version INTEGER PRIMARY KEY,
  config TEXT NOT NULL,
  label TEXT NOT NULL,
  change_note TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS scoring_rules_immutable
BEFORE UPDATE OF version, config, label, change_note, created_by, created_at ON scoring_rules
BEGIN
  SELECT RAISE(ABORT, 'scoring rules are immutable; publish a new version');
END;

CREATE TRIGGER IF NOT EXISTS scoring_rules_no_delete
BEFORE DELETE ON scoring_rules
BEGIN
  SELECT RAISE(ABORT, 'scoring rules are immutable; publish a new version');
END;

-- Materialised, per-rule evaluation of the immutable sample stream.
-- Pure function of (samples, rule version, operator actions). Safe to rebuild.
CREATE TABLE IF NOT EXISTS score_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  window_end TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  raw_score REAL NOT NULL,
  score REAL NOT NULL,
  state TEXT NOT NULL,
  previous_state TEXT NOT NULL,
  changed INTEGER NOT NULL DEFAULT 0,
  dwell INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL,
  factors TEXT NOT NULL,
  context TEXT NOT NULL,
  reasons TEXT NOT NULL,
  weakest TEXT,
  counters TEXT NOT NULL,
  built_at TEXT NOT NULL,
  UNIQUE (source_id, window_end, rule_version)
);

CREATE INDEX IF NOT EXISTS score_points_source_window
  ON score_points (source_id, window_end, rule_version);

-- Transition ledger for a rule version. Derived, so it is rebuilt atomically
-- with score_points on recompute. Keeping it exact (rather than reconstructing
-- from points) preserves the real hold/release timestamps.
CREATE TABLE IF NOT EXISTS state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  at TEXT NOT NULL,
  window_end TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  score REAL,
  actor TEXT NOT NULL,
  UNIQUE (source_id, at, from_state, to_state, rule_version)
);

CREATE INDEX IF NOT EXISTS state_transitions_source_at
  ON state_transitions (source_id, at, rule_version);

CREATE TABLE IF NOT EXISTS source_state (
  source_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  since TEXT NOT NULL,
  score REAL NOT NULL,
  raw_score REAL NOT NULL,
  rule_version INTEGER NOT NULL,
  counters TEXT NOT NULL,
  dwell INTEGER NOT NULL DEFAULT 0,
  next_due_at TEXT,
  last_sample_at TEXT,
  last_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  planned_at TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  state TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  sample_id INTEGER
);

CREATE INDEX IF NOT EXISTS collection_runs_source_at
  ON collection_runs (source_id, ran_at);

-- Diagnostic probes are NOT raw monitoring: they never feed scoring, so they
-- cannot rewrite the evidence a rule is evaluated against. They exist to tell
-- an operator (and the scheduler's recovery check) whether an isolated or
-- held source looks healthy again.
CREATE TABLE IF NOT EXISTS health_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  score REAL,
  outcome TEXT NOT NULL,
  findings TEXT NOT NULL,
  next_probe_at TEXT
);

CREATE INDEX IF NOT EXISTS health_probes_source_at
  ON health_probes (source_id, at);

CREATE TABLE IF NOT EXISTS recompute_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_version INTEGER NOT NULL,
  from_window TEXT NOT NULL,
  to_window TEXT NOT NULL,
  sources INTEGER NOT NULL,
  samples INTEGER NOT NULL,
  points INTEGER NOT NULL,
  transitions INTEGER NOT NULL,
  changed_points INTEGER NOT NULL,
  digest_before TEXT NOT NULL,
  digest_after TEXT NOT NULL,
  raw_unchanged INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
`;

export function openDb(filename = process.env.DB_FILE ?? resolve('data/health.db')) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));
  return db;
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}
