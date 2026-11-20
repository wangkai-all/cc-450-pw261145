# Source Health Monitor

A dependency-free demo of **source health monitoring with versioned scoring**:
five raw signals are combined into a score, that score drives collection
scheduling (normal → reduced → isolated), an operator can override any source,
and re-publishing the scoring rule re-scores the entire history **without ever
touching the raw monitoring**.

Node 24+, `node:sqlite`, `node:http`, `node:test`. No packages, no build step.

```bash
npm run seed     # deterministic 14-day demo database in data/health.db
npm start        # http://localhost:3000
npm test         # 15 tests
```

## Model

```
samples ──┐
probes  ──┼─▶ replay (pure) ─▶ score_points / state_transitions / source_state
actions ──┘        ▲
                   │
          scoring_rules (immutable versions)
```

Four physically separate kinds of data:

| Table | Kind | Mutable? |
|---|---|---|
| `samples`, `health_probes` | raw observed facts | append-only (SQLite triggers abort `UPDATE`/`DELETE`) |
| `operator_actions` | human intent | append-only audit trail |
| `scoring_rules` | versioned config | immutable; a change inserts version *n+1* |
| `score_points`, `state_transitions`, `source_state` | derived | freely rebuilt from the three rows above |

Because the derived tables are a pure function of (raw samples, rule version,
operator actions, probes), recomputing history is just a replay. The live
scheduler, the API and a historical recompute all call the same
`buildTimeline()` — live behaviour and recomputed history cannot diverge.

### Score

Five factors, each 0..1 (1 = healthy), combined with versioned weights:

| Factor | Signal | Shape |
|---|---|---|
| success | successes / attempts | linear |
| latency | p95 (0.7) and p50 (0.3) vs budget | free below 1× budget, 0 at 3× |
| empty | empty results / attempts | free to baseline, 0 at 2× baseline |
| drift | Jaccard of returned fields vs expected schema | 0 at the drift floor |
| throttle | rate-limited attempts / attempts | 0 at the rate budget |

The displayed score is a **causal 3-window EWMA** of the raw window score;
the raw score is kept and drawn faintly underneath.

### State machine

```
NORMAL ──score < 72──▶ REDUCED ──score < 48──▶ ISOLATED
   ▲                      │                       │
   └──── score ≥ 94 ──────┘                       │
   └────────── score ≥ 78 after dwell ────────────┘

ISOLATED ──3 consecutive healthy probes──▶ NORMAL
any state ──operator hold──▶ MANUAL ──release/expiry──▶ NORMAL
```

Anti-flap rules, each of which is covered by a test:

- **Confirmation on raw windows.** Demotion needs `confirmWindows` (2)
  *consecutive raw* windows below the floor. Counting smoothed windows would
  let one spike look like two, because the EWMA lags — that bug is explicitly
  guarded against.
- **Critical override.** A window below 25 (near-total outage) bypasses
  confirmation on purpose.
- **Recovery hysteresis.** Promotion needs to clear the threshold by
  `promoteMargin` *and* dwell `minWindowsInState` windows.
- **Probe-only re-entry.** While isolated, collection stops and cheap probes
  run; only consecutive healthy probes re-admit the source.
- **Operator authority.** Holds and releases are replayed events, so a rule
  change never erases a human decision.

### Scheduling

| State | Cadence |
|---|---|
| NORMAL | `base_interval_minutes` |
| REDUCED | 3× base |
| ISOLATED | probe every 30 min, no full collection |
| MANUAL | probe at `probe_interval_minutes`; the operator decides |

## Proving raw data is never rewritten

Every recompute:

1. records `samples` count + SHA-256 prefix before publishing,
2. inserts the new rule version,
3. rebuilds all derived tables,
4. re-fingerprints the raw stream and stores both digests in `recompute_runs`
   together with `raw_unchanged`.

The UI shows `digest before → digest after · raw unchanged` for each run. The
append-only triggers make the alternative impossible even if a future change
tried it.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/overview` | fleet counts, per-source state/score/factors, recent transfers |
| GET | `/api/sources/:id?from&to` | points, transitions, actions, probes, runs, current factors |
| GET | `/api/transitions?limit` | fleet transition feed |
| GET | `/api/rules` | rule versions and recompute runs |
| POST | `/api/rules/preview` | pure impact preview — writes nothing |
| POST | `/api/rules` | publish a version + recompute history |
| POST | `/api/sources/:id/hold` | operator hold (`actor`, `note`, optional `holdHours`) |
| POST | `/api/sources/:id/release` | operator release (`actor`, `note`) |
| POST | `/api/scheduler/tick` | run one scheduler pass (`advance: true` jumps to the next due time) |
| POST | `/api/clock` | demo helper: set the simulated clock |

## The page

- **Sources table** — state chip (icon + label, never colour alone), score
  meter, five-factor mini bars, dwell, last reason, next run.
- **Trend** — smoothed line over the faint raw windows, reduction/isolation
  floors as labelled reference lines, crosshair tooltip, and a trailing shaded
  region labelled *probing only* where an isolated (or held) source stopped
  collecting. If a source has not collected anything inside the selected range,
  the chart falls back to its last collected history and says so in the footnote
  instead of showing an empty plot.
- **State timeline** — one band per window in the reserved state colours.
- **Why it is in this state** — factor bars plus the current window's reasons.
- **Recovery & probes / Recent collection runs** — the degradation and recovery
  trail, including the probe sequence that re-admitted a source.
- **Table tab** — the same windows as a table (relief for the low-contrast
  status colour).
- **Stability check** — fleet transfers, entries into isolation, held
  confirmation windows, and whether the jitter source has ever flapped.
- **Scoring rule** — weight/floor sliders, preview impact, publish with the
  before/after digest, and the version + recompute history.

The seeded fleet covers the cases the design is about: a stable source, a
smoothly degrading one (isolated), a single-window jitter source (never
isolated), a schema drift, a nightly rate-limited source (reduced), one that
degraded and recovered, a flaky one, and a long operator hold.
