import { openDb } from './db.js';
import {
  insertSample,
  insertSource,
  insertOperatorAction,
  insertProbe,
  listRules,
  listSamples,
  publishRule,
  getSource,
  activeRule,
} from './repo.js';
import { DEFAULT_RULE, buildTimeline } from './scoring.js';
import { collectWindow, probeSource } from './simulator.js';
import { addHours } from './util.js';
import { evaluateTimeline, applyEvaluation, intervalMinutes, recordCollectionRun } from './engine.js';

export const SOURCES = [
  {
    id: 'srch-news-wire',
    name: 'Global News Wire',
    kind: 'feed',
    url: 'https://feeds.example.com/global/rss',
    tier: 'P1',
    owner: 'news-platform',
    scenario: 'stable',
    baseIntervalMinutes: 60,
    probeIntervalMinutes: 240,
    notes: 'Primary headline feed; consumer cache TTL is 15 minutes.',
  },
  {
    id: 'srch-price-api',
    name: 'Retail Price API',
    kind: 'api',
    url: 'https://api.example.com/v3/prices',
    tier: 'P1',
    owner: 'pricing',
    scenario: 'degrading',
    baseIntervalMinutes: 60,
    probeIntervalMinutes: 240,
    notes: 'Slow upstream database; latency climbed steadily through the window.',
  },
  {
    id: 'srch-jobs-feed',
    name: 'Job Board Feed',
    kind: 'feed',
    url: 'https://jobs.example.com/feed.xml',
    tier: 'P2',
    owner: 'marketplace',
    scenario: 'jitter',
    baseIntervalMinutes: 60,
    probeIntervalMinutes: 240,
    notes: 'Occasional single-window spikes; historically misread as outages.',
  },
  {
    id: 'srch-catalog-graphql',
    name: 'Catalog GraphQL',
    kind: 'graphql',
    url: 'https://catalog.example.com/graphql',
    tier: 'P1',
    owner: 'catalog',
    scenario: 'drifted',
    baseIntervalMinutes: 60,
    probeIntervalMinutes: 240,
    notes: 'Vendor renamed fields mid-window; mapping fix is pending.',
  },
  {
    id: 'srch-deals-scrape',
    name: 'Deals Scraper',
    kind: 'scrape',
    url: 'https://deals.example.com/today',
    tier: 'P3',
    owner: 'growth',
    scenario: 'ratelimited',
    baseIntervalMinutes: 60,
    probeIntervalMinutes: 240,
    notes: 'Politely rate limited; must back off hard when 429s appear.',
  },
  {
    id: 'srch-inventory-csv',
    name: 'Inventory CSV Drop',
    kind: 'csv',
    url: 's3://partner-drops/inventory/',
    tier: 'P2',
    owner: 'supply-chain',
    scenario: 'recovered',
    baseIntervalMinutes: 60,
    probeIntervalMinutes: 240,
    notes: 'Partner outage mid-window; recovered without intervention.',
  },
  {
    id: 'srch-ocr-invoices',
    name: 'Invoice OCR Stream',
    kind: 'ocr',
    url: 'https://ocr.example.com/v1/extract',
    tier: 'P3',
    owner: 'finance-ops',
    scenario: 'flaky',
    baseIntervalMinutes: 60,
    probeIntervalMinutes: 240,
    notes: 'Batch jobs; short bursts of failures are normal.',
  },
  {
    id: 'srch-crm-sync',
    name: 'CRM Sync',
    kind: 'api',
    url: 'https://crm.example.com/api/sync',
    tier: 'P2',
    owner: 'revops',
    scenario: 'held',
    baseIntervalMinutes: 60,
    probeIntervalMinutes: 240,
    notes: 'Scheduled vendor maintenance late in the window.',
  },
];

export const HISTORY_HOURS = 336; // 14 days

const OPERATOR_ACTIONS = [
  {
    sourceId: 'srch-crm-sync',
    atHour: 290,
    action: 'hold',
    actor: 'oncall:li.wei',
    note: 'Vendor maintenance window — pausing automatic collection.',
    holdHours: 24,
  },
  {
    sourceId: 'srch-catalog-graphql',
    atHour: 200,
    action: 'hold',
    actor: 'oncall:chen.yu',
    note: 'Held while the upstream field-mapping fix is verified.',
    holdHours: null,
  },
];

/**
 * Replay the scheduler over a synthetic 14-day history.
 *
 * The history is *grown by the scheduler itself*: at each hour we ask the same
 * pure timeline what state the source is in, then either collect a full sample
 * (NORMAL / REDUCED cadence) or take a diagnostic probe (ISOLATED / MANUAL).
 * That is why an isolated source has a gap in raw samples - isolation means we
 * stopped collecting - and why the seeded data contains no contradictions
 * between raw evidence and recorded state.
 */
function simulateHistory(source, rule, { epoch, hours, operatorActions }) {
  const samples = [];
  const probes = [];
  const actions = [];
  const runs = [];
  let lastRunAt = epoch;

  for (let hour = 1; hour <= hours; hour += 1) {
    const at = addHours(epoch, hour);
    for (const action of operatorActions) {
      if (action.atHour === hour) {
        actions.push({
          at,
          action: action.action,
          note: action.note,
          actor: action.actor,
          holdHours: action.holdHours,
        });
      }
    }

    const state = buildTimeline(samples, rule, actions, { probes, now: at }).finalState;
    const intervalMin = intervalMinutes(source, state);
    const dueAt = new Date(new Date(lastRunAt).getTime() + intervalMin * 60_000).toISOString();
    if (at < dueAt) continue;

    if (state === 'ISOLATED' || state === 'MANUAL') {
      const probe = probeSource(source, at);
      probes.push({ at, state, outcome: probe.outcome, findings: probe.findings });
      runs.push({
        plannedAt: dueAt,
        ranAt: at,
        state,
        action: 'probe',
        reason: `${state === 'MANUAL' ? 'Operator hold' : 'Isolated'}: ${probe.findings[0]}`,
      });
    } else {
      samples.push(collectWindow(source, at));
      runs.push({
        plannedAt: dueAt,
        ranAt: at,
        state,
        action: state === 'REDUCED' ? 'collect_reduced' : 'collect',
        reason:
          state === 'REDUCED'
            ? `Reduced cadence (every ${intervalMin} min): collected a full window.`
            : `Normal cadence: full collection every ${intervalMin} min.`,
      });
    }
    lastRunAt = at;
  }

  return { samples, probes, actions, runs };
}

/**
 * Seed a deterministic demo database. The same wall-clock anchor always yields
 * the same raw monitoring, rule version and operator history.
 */
export function seedDemo({ dbFile, historyHours = HISTORY_HOURS, now = new Date() } = {}) {
  const db = openDb(dbFile ?? process.env.DB_FILE);
  const anchor = new Date(now);
  anchor.setUTCMinutes(0, 0, 0);
  const nowIso = anchor.toISOString();
  const epoch = addHours(nowIso, -historyHours);

  if (!listRules(db).length) {
    publishRule(db, DEFAULT_RULE, {
      actor: 'system',
      note: 'Initial baseline: balanced weights, 3-window EWMA, 2-window confirmation, probe recovery.',
      label: 'v1 · balanced',
    });
  }
  const rule = activeRule(db);

  // One transaction for the whole seed: ~5k inserts plus eight evaluations. In
  // WAL autocommit each statement is its own fsync, which turns a two-second
  // seed into a minute.
  db.exec('BEGIN');
  try {
    for (const spec of SOURCES) {
      insertSource(db, { ...spec, epoch });
      const source = getSource(db, spec.id);
      if (listSamples(db, spec.id).length) continue;

      const operatorActions = OPERATOR_ACTIONS.filter((a) => a.sourceId === spec.id);
      const history = simulateHistory(source, rule, { epoch, hours: historyHours, operatorActions });

      for (const sample of history.samples) insertSample(db, spec.id, sample);
      for (const probe of history.probes) {
        insertProbe(db, spec.id, {
          at: probe.at,
          state: probe.state,
          score: null,
          outcome: probe.outcome,
          findings: probe.findings,
          nextProbeAt: null,
        });
      }
      for (const action of history.actions) {
        insertOperatorAction(db, spec.id, action);
      }
      for (const run of history.runs) recordCollectionRun(db, spec.id, run);
    }

    // Evaluate every source under the active rule and make it the live state.
    for (const spec of SOURCES) {
      const source = getSource(db, spec.id);
      const evaluation = evaluateTimeline(db, source, rule, { now: nowIso });
      applyEvaluation(db, source, rule, evaluation, { now: nowIso });
      // Randomise the first due time so a live demo does not collect everything
      // at once.
      const row = db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(spec.id);
      const offset = (hashOffset(spec.id) % 45) * 60_000;
      db.prepare('UPDATE source_state SET next_due_at = ? WHERE source_id = ?').run(
        new Date(new Date(row.next_due_at).getTime() + offset).toISOString(),
        spec.id
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { db, nowIso, epoch, rule };
}

function hashOffset(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

const invokedDirectly =
  process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;

if (invokedDirectly) {
  const { rmSync, existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const file = resolve(process.env.DB_FILE ?? 'data/health.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(file + suffix)) rmSync(file + suffix);
  }
  const { nowIso } = seedDemo({ dbFile: file });
  console.log(`Seeded ${SOURCES.length} sources with ${HISTORY_HOURS}h of monitoring at ${nowIso} -> ${file}`);
}
