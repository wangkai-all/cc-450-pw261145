/* Source Health Monitor - small dependency-free UI. */

const state = {
  overview: null,
  detail: null,
  selectedId: null,
  hours: 168,
  stateFilter: 'all',
  tab: 'trend',
  rules: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

const STATE_COLOR = {
  NORMAL: 'var(--state-normal)',
  REDUCED: 'var(--state-reduced)',
  ISOLATED: 'var(--state-isolated)',
  MANUAL: 'var(--state-manual)',
};
const STATE_LABEL = { NORMAL: 'Normal', REDUCED: 'Reduced', ISOLATED: 'Isolated', MANUAL: 'Manual' };
const STATE_ICON = {
  NORMAL: 'M2 6.2l2.6 2.6L10 3.4',
  REDUCED: 'M6 2.2L10.8 10H1.2z',
  ISOLATED: 'M3 3l6 6M9 3L3 9',
  MANUAL: 'M4 2v8M8 2v8',
};

function chip(stateName) {
  const wrap = el('span', { class: `chip ${stateName}` });
  const svg = svgEl('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' });
  svg.append(
    svgEl('path', {
      d: STATE_ICON[stateName] ?? STATE_ICON.NORMAL,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.6,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    })
  );
  wrap.append(svg, el('span', { text: STATE_LABEL[stateName] ?? stateName }));
  return wrap;
}

function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('err', isError);
  node.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => node.classList.remove('on'), 3200);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

/* ---------------- formatting ---------------- */

const fmtTime = (iso, withDate = false) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, withDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
};
const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
const fmtNum = (n, d = 1) => (n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(d));
const fmtHours = (h) => (h >= 48 ? `${fmtNum(h / 24, 0)}d` : `${fmtNum(h, 0)}h`);
const esc = (s) => String(s ?? '');

function relTime(iso, anchorMs) {
  if (!iso) return '—';
  // Anchor to the server clock the snapshot was generated at, not browser wall
  // time: the demo clock is simulated, and relative labels must agree with the
  // absolute timestamps on the same page.
  const base = anchorMs ?? (Date.parse(state.overview?.generatedAt ?? '') || Date.now());
  const diff = (new Date(iso).getTime() - base) / 60000;
  const abs = Math.abs(diff);
  const amount = abs < 60 ? `${Math.round(abs)}m` : abs < 2880 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  if (diff > 0.75) return `in ${amount}`;
  if (diff < -1) return `${amount} ago`;
  return 'due now';
}

function scoreColor(score) {
  if (score == null) return 'var(--text-muted)';
  if (score < 48) return 'var(--state-isolated)';
  if (score < 72) return 'var(--state-reduced)';
  return 'var(--state-normal)';
}

/* ---------------- overview ---------------- */

function renderOverview() {
  const o = state.overview;
  if (!o) return;
  $('#clock').textContent = fmtTime(o.generatedAt, true);
  $('#rule-label').textContent = `v${o.rule.version} · ${o.rule.label}`;

  const visible = o.sources.filter((s) => state.stateFilter === 'all' || s.state === state.stateFilter);
  $('#source-count').textContent = `${visible.length} of ${o.sources.length} sources`;

  const scores = o.sources.map((s) => s.score).filter((v) => v != null);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  $('#stat-fleet').textContent = mean == null ? '—' : fmtNum(mean);
  $('#stat-fleet').style.color = scoreColor(mean);
  $('#stat-fleet-sub').textContent = `mean smoothed score · ${o.sources.length} sources`;
  $('#stat-normal').textContent = o.counts.NORMAL;
  $('#stat-reduced').textContent = o.counts.REDUCED;
  $('#stat-isolated').textContent = o.counts.ISOLATED;
  $('#stat-manual').textContent = o.counts.MANUAL;

  const tb = $('#source-rows');
  tb.replaceChildren(
    ...visible.map((s) => {
      const tr = el('tr', { 'data-id': s.id, class: s.id === state.selectedId ? 'selected' : '' });
      tr.addEventListener('click', () => selectSource(s.id));

      const name = el('td', {}, [
        el('span', { class: 'src-name', text: s.name }),
        el('span', { class: 'src-meta', text: `${s.tier} · ${s.kind} · ${s.owner}` }),
      ]);

      const chipCell = el('td', {}, [chip(s.state)]);

      const meter = el('td', {}, [
        el('div', { class: 'meter' }, [
          el('div', { class: 'track' }, [
            el('div', {
              class: 'fill',
              style: `width:${Math.max(2, s.score ?? 0)}%;background:${scoreColor(s.score)}`,
            }),
          ]),
          el('span', { class: 'val', text: s.score == null ? '—' : fmtNum(s.score) }),
        ]),
      ]);

      const factors = el('td', {}, [factorMini(s.factors ?? null)]);

      const dwell = el('td', { class: 'num nowrap secondary', text: `${s.dwell} w` });

      const reason = el('td', { class: 'reason-cell', text: s.lastReason ?? '—' });

      const next = el('td', { class: 'nowrap secondary num' }, [
        el('div', { text: relTime(s.nextDueAt) }),
        el('div', { class: 'src-meta', text: `every ${s.intervalMinutes}m` }),
      ]);

      tr.append(name, chipCell, meter, factors, dwell, reason, next);
      return tr;
    })
  );
  if (!visible.length) {
    tb.append(el('tr', {}, [el('td', { colspan: 7, class: 'muted' }, ['No sources match this filter.'])]));
  }

  renderFleetTransitions(o.recentTransitions);
  renderStability(o);
}

function factorMini(factors) {
  if (!factors) return el('span', { class: 'muted', text: '—' });
  const keys = ['success', 'latency', 'empty', 'drift', 'throttle'];
  const wrap = el('div', { class: 'factors-mini' });
  for (const key of keys) {
    const v = Math.max(0, Math.min(1, factors[key] ?? 0));
    const cls = v < 0.5 ? 'low' : v < 0.85 ? 'mid' : '';
    wrap.append(el('span', { class: cls, style: `height:${Math.max(3, v * 22)}px` }));
  }
  wrap.title = keys.map((k) => `${k}: ${Math.round((factors[k] ?? 0) * 100)}%`).join(' · ');
  return wrap;
}

function renderFleetTransitions(list) {
  const host = $('#fleet-transitions');
  if (!list?.length) {
    host.replaceChildren(el('li', {}, [el('span'), el('span', { class: 'muted', text: 'No transitions yet.' })]));
    return;
  }
  host.replaceChildren(
    ...list.map((t) => {
      const source = state.overview.sources.find((s) => s.id === t.sourceId);
      const icon = el('span', { class: 'icon', style: `background:${STATE_COLOR[t.toState] ?? 'var(--axis)'}` });
      const what = el('div', {}, [
        el('div', { class: 'what' }, [
          el('strong', { text: source?.name ?? t.sourceId }),
          ` ${t.fromState.toLowerCase()} → `,
          chip(t.toState),
        ]),
        el('div', { class: 'why', text: t.reason }),
      ]);
      const when = el('div', { class: 'when' }, [
        el('div', { text: fmtTime(t.at, true) }),
        el('div', { text: t.actor }),
      ]);
      return el('li', {}, [icon, what, when]);
    })
  );
}

function renderStability(o) {
  const detail = state.detail;
  // Counted over the current rule's full transition ledger, not "did the last
  // transition happen to be an isolation" - that would read as near-zero.
  const pending = detail
    ? detail.points.filter((p) => p.reasons?.some((r) => r.code === 'confirmation_pending')).length
    : (o.confirmationPending ?? null);
  const flips = o.sources.reduce((sum, s) => sum + s.transitions, 0);
  const kv = $('#stability-kv');
  kv.replaceChildren(
    el('dt', { text: 'Fleet state transfers (current rule)' }),
    el('dd', { text: String(flips) }),
    el('dt', { text: 'Entries into isolation' }),
    el('dd', { text: String(o.isolations ?? 0) }),
    el('dt', {
      text: detail
        ? `Windows held pending confirmation (${detail.source.name})`
        : 'Windows held pending confirmation (fleet)',
    }),
    el('dd', { text: pending == null ? '—' : String(pending) }),
    el('dt', { text: 'Stable sources (never isolated)' }),
    el('dd', {
      text: String(o.sources.filter((s) => (s.isolations ?? 0) === 0).length) + ` / ${o.sources.length}`,
    }),
    el('dt', { text: 'Jitter source currently' }),
    el('dd', {
      text: o.sources
        .filter((s) => s.scenario === 'jitter')
        .map((s) => `${s.name}: ${STATE_LABEL[s.state] ?? s.state}`)
        .join(' · ') || '—',
    })
  );
  const note = $('#stab-pending-note');
  if (note) {
    const jitter = o.sources.find((s) => s.scenario === 'jitter');
    note.textContent = jitter
      ? `${jitter.name} has taken ${jitter.windows} scored windows and ${jitter.transitions} state transfers; it has never been isolated. Its confirmation_pending windows are shown, not hidden.`
      : '';
  }
}

/* ---------------- detail ---------------- */

async function selectSource(id) {
  state.selectedId = id;
  document.querySelectorAll('#source-rows tr').forEach((tr) => {
    tr.classList.toggle('selected', tr.dataset.id === id);
  });
  await loadDetail();
}

function rangeStartIso() {
  // Anchor to the server clock (the demo DB is seeded at a fixed instant), not
  // the browser's wall clock, or the range would miss the seeded history.
  const anchor = Date.parse(state.overview?.generatedAt ?? '') || Date.now();
  return new Date(anchor - state.hours * 3_600_000).toISOString();
}

async function loadDetail() {
  if (!state.selectedId) return;
  let d = await api(`/api/sources/${encodeURIComponent(state.selectedId)}?from=${rangeStartIso()}`);
  let rangeFallback = false;
  if (!d.points.length) {
    // An isolated or held source stops collecting, so a recent range can contain
    // no scored windows at all. Fall back to the full history rather than show
    // an empty chart that reads like "no data exists".
    const full = await api(`/api/sources/${encodeURIComponent(state.selectedId)}`);
    if (full.points.length) {
      rangeFallback = true;
      full.requestedFrom = d.range.from;
      d = full;
    }
  }
  d.rangeFallback = rangeFallback;
  state.detail = d;
  $('#detail-empty').classList.add('hidden');
  $('#detail-content').classList.remove('hidden');
  $('#detail-title').textContent = d.source.name;
  applyTab();
  const detailState = d.state?.state ?? 'NORMAL';
  const chipEl = $('#detail-chip');
  chipEl.className = `chip ${detailState}`;
  chipEl.querySelector('path').setAttribute('d', STATE_ICON[detailState] ?? STATE_ICON.NORMAL);
  $('#detail-chip-text').textContent = STATE_LABEL[detailState] ?? '—';

  renderTrend(d);
  renderCurrent(d);
  renderFactorList(d);
  renderTransitions(d);
  renderProbes(d);
  renderRuns(d);
  renderDetailTable(d);
  renderStability(state.overview);
}

// Switching sources resets nothing; switching tabs must not lose the source.
function applyTab() {
  const trend = state.tab === 'trend';
  [...$('#detail-tabs').children].forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.tab === state.tab))
  );
  for (const sel of ['#trend-host', '#trend-foot', '#state-host', '#state-legend', '#trend-legend', '#state-title']) {
    $(sel).classList.toggle('hidden', !trend);
  }
  $('#detail-table-view').classList.toggle('hidden', trend);
}

function renderCurrent(d) {
  const kv = $('#current-kv');
  const cur = d.current;
  const s = d.state;
  const rows = [
    ['State', s ? `${STATE_LABEL[s.state]} since ${fmtTime(s.since, true)}` : '—'],
    ['Smoothed score', s ? fmtNum(s.score) : '—'],
    ['Raw last window', s ? fmtNum(s.rawScore) : '—'],
    ['Dwell', s ? `${s.dwell} windows` : '—'],
    ['Next run', s ? `${fmtTime(s.nextDueAt, true)} · every ${intervalText(d, s.state)}` : '—'],
    ['Last collection', s?.lastSampleAt ? fmtTime(s.lastSampleAt, true) : '—'],
  ];
  if (cur) {
    rows.push(['Success rate', `${fmtNum(cur.context.successRate * 100)}%`]);
    rows.push(['p95 latency', `${Math.round(cur.context.latencyP95)} ms`]);
    rows.push(['Empty results', `${fmtNum(cur.context.emptyRate * 100)}%`]);
    rows.push(['Field overlap', `${fmtNum(cur.context.jaccard * 100)}%`]);
    rows.push(['Rate limited', `${fmtNum(cur.context.throttleRate * 100)}%`]);
    rows.push(['Confidence', `${Math.round(cur.confidence * 100)}%`]);
  }
  kv.replaceChildren(
    ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])
  );
}

function intervalText(d, s) {
  if (s === 'REDUCED') return `${d.source.baseIntervalMinutes * 3}m`;
  if (s === 'MANUAL') return `${d.source.probeIntervalMinutes}m probe`;
  if (s === 'ISOLATED') return '30m probe';
  return `${d.source.baseIntervalMinutes}m`;
}

const FACTOR_COLOR = {
  success: 'var(--series-1)',
  latency: 'var(--series-3)',
  empty: 'var(--series-4)',
  drift: 'var(--series-7)',
  throttle: 'var(--series-2)',
};

function renderFactorList(d) {
  const host = $('#factor-list');
  const labels = d.factorLabels;
  if (!d.current) {
    host.replaceChildren(el('div', { class: 'empty-note', text: 'No scored windows in this range.' }));
    $('#factor-foot').textContent = '';
    return;
  }
  const factors = d.current.factors;
  host.replaceChildren(
    ...Object.keys(labels).map((key) => {
      const v = Math.max(0, Math.min(1, factors[key] ?? 0));
      const cls = v < 0.5 ? 'bad' : v < 0.85 ? 'warn' : '';
      return el('div', { class: 'factor-row' }, [
        el('span', { text: labels[key] }),
        el('div', { class: 'track' }, [
          el('div', { class: `fill ${cls}`, style: `width:${Math.max(2, v * 100)}%` }),
        ]),
        el('span', { class: 'pct', text: `${Math.round(v * 100)}%` }),
      ]);
    })
  );
  const worst = d.current.weakest;
  const reasonText = d.current.reasons.map((r) => r.detail).join(' ');
  $('#factor-foot').textContent = `Weakest factor: ${labels[worst] ?? worst}. ${reasonText}`;
  void FACTOR_COLOR;
}

function renderTransitions(d) {
  const host = $('#transition-events');
  const all = [...d.transitions].reverse();
  const list = all.slice(0, 8);
  if (!all.length) {
    host.replaceChildren(el('li', {}, [el('span'), el('span', { class: 'muted', text: 'No state transfers in this range.' })]));
  } else {
    host.replaceChildren(
      ...list.map((t) =>
        el('li', {}, [
          el('span', { class: 'icon', style: `background:${STATE_COLOR[t.toState] ?? 'var(--axis)'}` }),
          el('div', {}, [
            el('div', { class: 'what' }, [
              `${STATE_LABEL[t.fromState] ?? t.fromState} → ${STATE_LABEL[t.toState] ?? t.toState}`,
              ' ',
              el('span', { class: 'badge', text: t.reasonCode }),
            ]),
            el('div', { class: 'why', text: t.reason }),
          ]),
          el('div', { class: 'when' }, [el('div', { text: fmtTime(t.at, true) }), el('div', { text: t.actor })]),
        ])
      )
    );
  }
  const foot = $('#transition-foot');
  if (foot) {
    foot.textContent = all.length > list.length
      ? `Newest ${list.length} of ${all.length} transfers in this rule version.`
      : '';
  }
}

function renderProbes(d) {
  const host = $('#probe-events');
  const items = [];
  for (const p of d.probes.slice(0, 5)) {
    items.push(
      el('li', {}, [
        el('span', {
          class: 'icon',
          style: `background:${p.outcome === 'healthy' ? 'var(--state-normal)' : 'var(--state-isolated)'}`,
        }),
        el('div', {}, [
          el('div', { class: 'what', text: `Probe ${p.outcome}` }),
          el('div', { class: 'why', text: p.findings.join(' ') }),
        ]),
        el('div', { class: 'when', text: fmtTime(p.at, true) }),
      ])
    );
  }
  for (const a of [...d.actions].reverse().slice(0, 4)) {
    items.push(
      el('li', {}, [
        el('span', { class: 'icon', style: 'background:var(--state-manual)' }),
        el('div', {}, [
          el('div', { class: 'what' }, [
            `Operator ${a.action}`,
            a.holdHours ? el('span', { class: 'badge', text: `hold ${a.holdHours}h` }) : null,
          ]),
          el('div', { class: 'why', text: a.note }),
        ]),
        el('div', { class: 'when' }, [el('div', { text: fmtTime(a.at, true) }), el('div', { text: a.actor })]),
      ])
    );
  }
  if (!items.length) {
    items.push(el('li', {}, [el('span'), el('div', { class: 'muted', text: 'No probes or operator actions. Healthy sources recover within the normal state machine.' })]));
  }
  host.replaceChildren(...items.slice(0, 14));
}

function renderRuns(d) {
  const host = $('#run-events');
  if (!d.runs.length) {
    host.replaceChildren(el('li', {}, [el('span'), el('span', { class: 'muted', text: 'No scheduler ticks recorded yet. Run a tick from the filter row.' })]));
    return;
  }
  host.replaceChildren(
    ...d.runs.slice(0, 8).map((r) =>
      el('li', {}, [
        el('span', {
          class: 'icon',
          style: `background:${r.action.startsWith('probe') ? 'var(--state-reduced)' : 'var(--series-1)'}`,
        }),
        el('div', {}, [
          el('div', { class: 'what' }, [r.action, ' ', el('span', { class: 'badge', text: r.state })]),
          el('div', { class: 'why', text: r.reason }),
        ]),
        el('div', { class: 'when', text: fmtTime(r.at, true) }),
      ])
    )
  );
}

/* ---------------- charts ---------------- */

function chartSize(host) {
  const width = Math.max(320, host.clientWidth || 640);
  return { width, height: Math.round(Math.min(260, Math.max(170, width * 0.3))) };
}

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step = span / count;
  const mag = 10 ** Math.floor(Math.log10(step));
  const norm = step / mag;
  const nice = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  const s = nice * mag;
  const ticks = [];
  for (let v = Math.ceil(min / s) * s; v <= max + 1e-9; v += s) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

function renderTrend(d) {
  const host = $('#trend-host');
  const points = d.points;
  host.replaceChildren();
  if (!points.length) {
    host.append(el('div', { class: 'chart-empty', text: 'No scored windows in this range.' }));
    $('#trend-foot').textContent = '';
    renderStateStrip(d);
    return;
  }
  const { width, height } = chartSize(host);
  const margin = { top: 14, right: 16, bottom: 26, left: 34 };
  const iw = width - margin.left - margin.right;
  const ih = height - margin.top - margin.bottom;

  const t0 = new Date(d.range?.from ?? points[0].windowEnd).getTime();
  const t1 = new Date(d.range?.to ?? points[points.length - 1].windowEnd).getTime();
  const x = (iso) => margin.left + (t1 === t0 ? 0.5 : (new Date(iso).getTime() - t0) / (t1 - t0)) * iw;
  const y = (v) => margin.top + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `Smoothed health score for ${d.source.name} over the selected range`,
  });

  for (const tick of [0, 25, 50, 75, 100]) {
    svg.append(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: 'grid-line' }));
    const label = svgEl('text', { x: margin.left - 8, y: y(tick) + 3, 'text-anchor': 'end', class: 'axis-label' });
    label.textContent = String(tick);
    svg.append(label);
  }

  // Thresholds are semantic reference lines, labelled at the left edge so they
  // never collide with the endpoint label at the right.
  for (const [value, color, text] of [
    [d.rule.thresholds?.reducedBelow ?? 72, 'var(--state-reduced)', 'reduce'],
    [d.rule.thresholds?.isolatedBelow ?? 48, 'var(--state-isolated)', 'isolate'],
  ]) {
    svg.append(
      svgEl('line', {
        x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value),
        stroke: color, 'stroke-width': 1, opacity: 0.55,
      })
    );
    const t = svgEl('text', { x: margin.left + 4, y: y(value) - 4, 'text-anchor': 'start', class: 'threshold-text' });
    t.textContent = text;
    svg.append(t);
  }

  svg.append(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: margin.top + ih, y2: margin.top + ih, class: 'axis-line' }));

  // x labels: 4 evenly spaced dates
  const labelCount = width > 620 ? 5 : 3;
  for (let i = 0; i < labelCount; i += 1) {
    const t = t0 + ((t1 - t0) * i) / (labelCount - 1);
    const anchor = i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle';
    const node = svgEl('text', { x: x(new Date(t).toISOString()), y: height - 8, 'text-anchor': anchor, class: 'axis-label' });
    node.textContent = fmtDate(new Date(t).toISOString());
    svg.append(node);
  }

  const linePath = (key) =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(p.windowEnd).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');

  // Raw window scores: the honest, unsmoothed evidence behind the line.
  svg.append(
    svgEl('path', {
      d: linePath('rawScore'),
      fill: 'none',
      stroke: 'var(--series-1)',
      'stroke-width': 1,
      opacity: 0.28,
      'stroke-linejoin': 'round',
    })
  );
  svg.append(
    svgEl('path', {
      d: linePath('score'),
      fill: 'none',
      stroke: 'var(--series-1)',
      'stroke-width': 2,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    })
  );

  // End marker with a surface ring.
  const last = points[points.length - 1];
  const lastX = x(last.windowEnd);

  // A trailing gap is evidence, not missing pixels: while isolated (or held)
  // collection has stopped and only probes run. Shade and label that stretch so
  // the blank right side is not read as "healthy and quiet". A merely reduced
  // cadence is not shaded - it still collects.
  // The gap's cause is the *current* state: a source can leave isolation for a
  // manual hold after its last window, and the caption must follow it.
  const gapState = d.state?.state ?? last.state;
  const stopped = gapState === 'ISOLATED' || gapState === 'MANUAL';
  const gapHours = (t1 - new Date(last.windowEnd).getTime()) / 3_600_000;
  if (stopped && gapHours > 1.5 && t1 > t0) {
    svg.append(
      svgEl('rect', {
        x: lastX, y: margin.top, width: width - margin.right - lastX, height: ih,
        fill: gapState === 'ISOLATED' ? 'var(--state-isolated-wash)' : 'var(--state-manual-wash)',
      })
    );
    const note = svgEl('text', {
      x: lastX + 6, y: margin.top + 12, class: 'axis-label',
      style: 'fill:var(--text-secondary)',
    });
    note.textContent = gapState === 'ISOLATED' ? 'isolated · probing only' : 'on hold · probing only';
    // Only label the gap when there is room; a sliver of shaded area needs no
    // caption and the text would collide with the endpoint value.
    if (width - margin.right - lastX > 120) svg.append(note);
  }

  svg.append(
    svgEl('circle', {
      cx: lastX, cy: y(last.score), r: 4.5,
      fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2,
    })
  );

  // Direct label for the endpoint only. Near the top of the scale it flips
  // below the marker so it is never clipped by the plot edge.
  const endAbove = y(last.score) - 14 > margin.top;
  const endLabel = svgEl('text', {
    x: lastX - 8,
    y: endAbove ? y(last.score) - 10 : y(last.score) + 20,
    'text-anchor': 'end',
    class: 'axis-label',
    style: 'fill:var(--text-primary);font-weight:600;font-size:11px',
  });
  endLabel.textContent = fmtNum(last.score);
  svg.append(endLabel);

  // Crosshair + tooltip layer.
  const crosshair = svgEl('line', {
    y1: margin.top, y2: margin.top + ih, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0,
  });
  const focusDot = svgEl('circle', { r: 4, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0 });
  svg.append(crosshair, focusDot);

  const overlay = svgEl('rect', {
    x: margin.left, y: margin.top, width: iw, height: ih, fill: 'transparent', tabindex: 0,
    role: 'application', 'aria-label': 'Score trend. Use arrow keys to inspect windows.',
  });
  svg.append(overlay);
  host.append(svg);

  const tip = el('div', { class: 'tooltip' });
  host.append(tip);

  let index = points.length - 1;
  const showPoint = (i) => {
    index = Math.max(0, Math.min(points.length - 1, i));
    const p = points[index];
    const px = x(p.windowEnd);
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.setAttribute('opacity', '1');
    focusDot.setAttribute('cx', px);
    focusDot.setAttribute('cy', y(p.score));
    focusDot.setAttribute('opacity', '1');
    tip.replaceChildren(
      el('div', { class: 't-head', text: fmtTime(p.windowEnd, true) }),
      el('div', { class: 't-row' }, [
        el('span', { class: 't-key' }, [el('i', { style: 'background:var(--series-1)' }), 'Smoothed']),
        el('span', { class: 't-val', text: fmtNum(p.score) }),
      ]),
      el('div', { class: 't-row' }, [
        el('span', { class: 't-key' }, [el('i', { style: 'background:var(--series-1);opacity:.4' }), 'Raw window']),
        el('span', { class: 't-val', text: fmtNum(p.rawScore) }),
      ]),
      el('div', { class: 't-row' }, [
        el('span', { class: 't-key' }, [el('i', { style: `background:${STATE_COLOR[p.state]}` }), 'State']),
        el('span', { class: 't-val', text: STATE_LABEL[p.state] }),
      ]),
      p.reasons?.[0] ? el('div', { class: 't-head', style: 'margin-top:5px;max-width:220px;white-space:normal', text: p.reasons[0].detail }) : null
    );
    tip.classList.add('on');
    const py = y(p.score);
    // Size the tooltip before placing it. Prefer above the point, drop below
    // when that would spill over the chart title, and if it fits in neither
    // place it beside the crosshair rather than on top of the mark it describes.
    const tipH = tip.offsetHeight;
    const tipW = tip.offsetWidth;
    let top;
    let left;
    const roomAbove = py - 12 - tipH >= 2;
    const roomBelow = py + 16 + tipH <= height - 2;
    if (roomAbove || roomBelow) {
      top = roomAbove ? py - 12 - tipH : py + 16;
      left = px - tipW / 2;
    } else {
      top = py - tipH / 2;
      left = px + 16 + tipW <= width - 2 ? px + 16 : px - 16 - tipW;
    }
    top = Math.max(2, Math.min(top, height - tipH - 2));
    left = Math.max(2, Math.min(left, width - tipW - 2));
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    tip.style.transform = 'none';
  };
  const hide = () => {
    crosshair.setAttribute('opacity', '0');
    focusDot.setAttribute('opacity', '0');
    tip.classList.remove('on');
  };
  const nearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * width;
    // Snap to the closest window in *time*, not in index: an isolated source
    // has unevenly spaced windows and index math would misread the cursor.
    const at = t0 + ((px - margin.left) / iw) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i += 1) {
      const dPrev = Math.abs(new Date(points[best].windowEnd) - at);
      const dNext = Math.abs(new Date(points[i].windowEnd) - at);
      if (dNext < dPrev) best = i;
    }
    return best;
  };
  overlay.addEventListener('pointermove', (ev) => showPoint(nearest(ev.clientX)));
  overlay.addEventListener('pointerleave', hide);
  overlay.addEventListener('focus', () => showPoint(index));
  overlay.addEventListener('blur', hide);
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') showPoint(index - 1);
    else if (ev.key === 'ArrowRight') showPoint(index + 1);
    else return;
    ev.preventDefault();
  });

  const first = points[0];
  const lastT = points[points.length - 1];
  $('#trend-foot').textContent =
    `${points.length} scored windows from ${fmtTime(first.windowEnd, true)} to ${fmtTime(lastT.windowEnd, true)}. ` +
    `Line is causal 3-window EWMA; faint line is each raw window.` +
    (d.rangeFallback
      ? ` No scored windows since ${fmtTime(d.requestedFrom, true)} — showing the last collected history.`
      : '');

  renderStateStrip(d);
}

function renderStateStrip(d) {
  const host = $('#state-host');
  host.replaceChildren();
  // Legend names every state present - identity never rests on colour alone.
  // Include the current state even when no scored window carries it (e.g. a
  // hold applied after the last collection): its band is still drawn.
  const present = [...new Set([...d.points.map((p) => p.state), d.state?.state].filter(Boolean))];
  const legend = $('#state-legend');
  legend.replaceChildren(
    ...present.map((s) =>
      el('span', { class: 'item' }, [el('span', { class: 'swatch box', style: `background:${STATE_COLOR[s]}` }), STATE_LABEL[s]])
    )
  );
  if (!d.points.length) return;

  const { width } = chartSize(host);
  const height = 26;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': 'State over time for the selected range',
  });

  // Group consecutive windows into runs of one state.
  const runs = [];
  for (const p of d.points) {
    const last = runs.at(-1);
    if (last && last.state === p.state) last.to = p.windowEnd;
    else runs.push({ state: p.state, from: p.windowEnd, to: p.windowEnd });
  }
  const lastPoint = d.points.at(-1);
  const t0 = new Date(d.range?.from ?? d.points[0].windowEnd).getTime();
  const t1 = new Date(d.range?.to ?? lastPoint.windowEnd).getTime();
  const span = t1 - t0 || 1;

  runs.forEach((run, i) => {
    const x0 = ((new Date(run.from).getTime() - t0) / span) * width;
    const x1 = ((new Date(run.to).getTime() - t0) / span) * width + width / d.points.length;
    const w = Math.max(1, Math.min(width, x1) - x0);
    const gap = i === 0 ? 0 : 2; // 2px surface gap between adjacent fills
    svg.append(
      svgEl('rect', {
        x: x0 + (gap ? 1 : 0), y: 4, width: Math.max(1, w - (gap ? 1 : 0)), height: 14,
        rx: 3, fill: STATE_COLOR[run.state], opacity: run.state === 'NORMAL' ? 0.9 : 1,
      })
    );
  });

  // The source stayed in its last state after the final sample; drawing that
  // stretch makes the isolation gap legible as a state, not a chart artefact.
  // Use the *current* state for the tail: a later operator hold can supersede
  // the state of the last scored window.
  const tailState = d.state?.state ?? lastPoint.state;
  const tailStart = ((new Date(lastPoint.windowEnd).getTime() - t0) / span) * width;
  if (width - tailStart > 3) {
    svg.append(
      svgEl('rect', {
        x: tailStart + 2, y: 4, width: Math.max(1, width - tailStart - 2), height: 14,
        rx: 3, fill: STATE_COLOR[tailState] ?? STATE_COLOR[lastPoint.state], opacity: 0.35,
      })
    );
  }

  // Start/end dates under the strip.
  const startLbl = svgEl('text', { x: 0, y: height - 1, class: 'axis-label' });
  startLbl.textContent = fmtDate(new Date(t0).toISOString());
  const endLbl = svgEl('text', { x: width, y: height - 1, 'text-anchor': 'end', class: 'axis-label' });
  endLbl.textContent = fmtDate(new Date(t1).toISOString());
  svg.append(startLbl, endLbl);
  host.append(svg);
}

function renderDetailTable(d) {
  const host = $('#detail-table-view');
  if (!d.points.length) {
    host.replaceChildren();
    return;
  }
  const rows = d.points.slice(-80).reverse();
  host.replaceChildren(
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, ['Window', 'Smoothed', 'Raw', 'State', 'Success', 'p95 ms', 'Empty', 'Overlap', '429s'].map((h) => el('th', { text: h }))),
      ]),
      el('tbody', {}, rows.map((p) =>
        el('tr', {}, [
          el('td', { text: fmtTime(p.windowEnd, true) }),
          el('td', { class: 'num', text: fmtNum(p.score) }),
          el('td', { class: 'num', text: fmtNum(p.rawScore) }),
          el('td', { text: STATE_LABEL[p.state] }),
          el('td', { class: 'num', text: `${Math.round(p.context.successRate * 100)}%` }),
          el('td', { class: 'num', text: Math.round(p.context.latencyP95) }),
          el('td', { class: 'num', text: `${fmtNum(p.context.emptyRate * 100)}%` }),
          el('td', { class: 'num', text: `${Math.round(p.context.jaccard * 100)}%` }),
          el('td', { class: 'num', text: `${Math.round(p.context.throttleRate * 100)}%` }),
        ])
      )),
    ])
  );
}

/* ---------------- operator actions ---------------- */

async function doHold() {
  if (!state.selectedId) return;
  try {
    const actor = $('#actor').value.trim();
    const note = $('#action-note').value.trim();
    const holdHours = $('#hold-hours').value.trim();
    if (!actor || !note) return toast('Actor and reason are required.', true);
    await api(`/api/sources/${encodeURIComponent(state.selectedId)}/hold`, {
      method: 'POST',
      body: JSON.stringify({ actor, note, holdHours: holdHours === '' ? null : Number(holdHours) }),
    });
    $('#action-note').value = '';
    toast('Source placed on hold.');
    await reload();
  } catch (e) {
    toast(e.message, true);
  }
}

async function doRelease() {
  if (!state.selectedId) return;
  try {
    const actor = $('#actor').value.trim();
    const note = $('#action-note').value.trim();
    if (!actor || !note) return toast('Actor and reason are required.', true);
    await api(`/api/sources/${encodeURIComponent(state.selectedId)}/release`, {
      method: 'POST',
      body: JSON.stringify({ actor, note }),
    });
    $('#action-note').value = '';
    toast('Released to normal scheduling.');
    await reload();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------- rules ---------------- */

const WEIGHT_KEYS = [
  ['success', 'Success rate'],
  ['latency', 'Latency'],
  ['empty', 'Empty results'],
  ['drift', 'Structural drift'],
  ['throttle', 'Rate limiting'],
];

function renderRuleForm() {
  const rule = state.overview?.rule;
  const config = state.rules?.rules.find((r) => r.version === state.rules.activeVersion)?.config;
  if (!config) return;
  const host = $('#weight-fields');
  host.replaceChildren(
    ...WEIGHT_KEYS.map(([key, label]) => {
      const pct = Math.round((config.weights[key] ?? 0) * 100);
      const out = el('span', { text: `${pct}%` });
      const input = el('input', { type: 'range', min: '0', max: '60', step: '1', value: String(pct), 'data-weight': key });
      input.addEventListener('input', () => {
        out.textContent = `${input.value}%`;
      });
      return el('label', { class: 'field' }, [
        el('span', { class: 'weight-head' }, [el('span', { text: label }), out]),
        input,
      ]);
    })
  );
  $('#reduced-below').value = String(config.thresholds.reducedBelow);
  $('#reduced-out').textContent = String(config.thresholds.reducedBelow);
  $('#isolated-below').value = String(config.thresholds.isolatedBelow);
  $('#isolated-out').textContent = String(config.thresholds.isolatedBelow);
  $('#confirm-windows').value = String(config.thresholds.confirmWindows);
  $('#promote-margin').value = String(config.thresholds.promoteMargin);
  $('#rule-sub').textContent = `Active v${rule.version} · ${rule.label}. Publishing re-scores history; raw monitoring is untouched.`;
  $('#stab-confirm').textContent = String(config.thresholds.confirmWindows);
  $('#stab-dwell').textContent = String(config.thresholds.minWindowsInState);
  $('#stab-critical').textContent = String(config.thresholds.criticalBelow);
}

function collectRuleConfig() {
  const base = state.rules.rules.find((r) => r.version === state.rules.activeVersion).config;
  const weights = {};
  let total = 0;
  document.querySelectorAll('#weight-fields input[data-weight]').forEach((input) => {
    weights[input.dataset.weight] = Number(input.value);
    total += Number(input.value);
  });
  if (total <= 0) throw new Error('At least one weight must be positive.');
  for (const key of Object.keys(weights)) weights[key] = weights[key] / total;
  const reducedBelow = Number($('#reduced-below').value);
  const isolatedBelow = Math.min(Number($('#isolated-below').value), reducedBelow - 1);
  return {
    ...base,
    weights,
    thresholds: {
      ...base.thresholds,
      reducedBelow,
      isolatedBelow,
      confirmWindows: Number($('#confirm-windows').value),
      promoteMargin: Number($('#promote-margin').value),
    },
    label: `v${(state.rules.activeVersion ?? 0) + 1} · adjusted`,
  };
}

async function previewRule() {
  try {
    const config = collectRuleConfig();
    const res = await api(`/api/rules/preview?from=${rangeStartIso()}`, {
      method: 'POST',
      body: JSON.stringify({ config }),
    });
    renderPreview(res.preview, config);
  } catch (e) {
    toast(e.message, true);
  }
}

function renderPreview(preview, config) {
  const host = $('#preview-body');
  const rows = preview.sources
    .filter((s) => s.changedWindows > 0 || s.currentState !== s.previewState)
    .sort((a, b) => b.changedWindows - a.changedWindows);
  if (!rows.length) {
    host.replaceChildren(
      el('div', { class: 'empty-note', text: 'This rule produces identical results on the selected range — no windows or states would change.' })
    );
    return;
  }
  host.replaceChildren(
    el('div', { class: 'footnote', style: 'margin:0 0 8px',
      text: `${preview.totalChanged} windows and ${preview.stateFlips} current states would change. Nothing has been written yet.` }),
    el('table', { class: 'preview-table' }, [
      el('thead', {}, [el('tr', {}, ['Source', 'Now', 'Preview', 'Windows changed'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.map((r) => {
        const current = state.overview.sources.find((s) => s.id === r.sourceId);
        return el('tr', {}, [
          el('td', { text: current?.name ?? r.sourceId }),
          el('td', { text: STATE_LABEL[r.currentState] ?? r.currentState }),
          el('td', { text: STATE_LABEL[r.previewState] ?? r.previewState }),
          el('td', { class: 'num', text: `${r.changedWindows} / ${r.windows}` }),
        ]);
      })),
    ]),
    el('div', { class: 'footnote',
      text: `Candidate: reduce < ${config.thresholds.reducedBelow}, isolate < ${config.thresholds.isolatedBelow}, confirm ${config.thresholds.confirmWindows}w, recovery margin ${config.thresholds.promoteMargin}.` })
  );
}

async function publishRule() {
  try {
    const config = collectRuleConfig();
    const actor = ($('#actor').value || 'operator').trim();
    const note = ($('#rule-note').value || '').trim();
    if (!note) return toast('A change note is required for an auditable rule version.', true);
    const res = await api('/api/rules', {
      method: 'POST',
      body: JSON.stringify({ config, actor, note, label: config.label }),
    });
    const run = res.run;
    toast(
      `Published v${res.version}. Re-scored ${run.points} windows (${run.changedPoints} changed). Raw monitoring ${run.rawUnchanged ? 'unchanged' : 'CHANGED'}.`,
      !run.rawUnchanged
    );
    $('#rule-note').value = '';
    await reloadRules();
    await reload();
  } catch (e) {
    toast(e.message, true);
  }
}

async function reloadRules() {
  state.rules = await api('/api/rules');
  renderRuleForm();
  renderRuleHistory();
}

function ruleTitle(r) {
  // Seed labels already carry their version ("v1 · balanced"); custom ones do
  // too. Only prefix when the label itself is bare.
  return /^v\d+\b/.test(r.label) ? r.label : `v${r.version} · ${r.label}`;
}

function renderRuleHistory() {
  const host = $('#rule-history');
  const { rules, recomputes } = state.rules;
  host.replaceChildren(
    el('div', { class: 'events', style: 'list-style:none' },
      rules.map((r) =>
        el('li', { style: 'grid-template-columns:1fr auto' }, [
          el('div', {}, [
            el('div', { class: 'what' }, [
              `${ruleTitle(r)} `,
              r.active ? el('span', { class: 'badge active', text: 'active' }) : el('span', { class: 'badge', text: 'archived' }),
            ]),
            el('div', { class: 'why', text: r.note }),
          ]),
          el('div', { class: 'when' }, [el('div', { text: fmtTime(r.createdAt, true) }), el('div', { text: r.createdBy })]),
        ])
      )
    ),
    el('div', { class: 'section-title', style: 'margin-top:12px' }, ['Recompute runs']),
    recomputes.length
      ? el('div', { class: 'events', style: 'list-style:none' },
          recomputes.map((r) =>
            el('li', { style: 'grid-template-columns:1fr auto' }, [
              el('div', {}, [
                el('div', { class: 'what' }, [
                  `v${r.ruleVersion} · ${r.changedPoints}/${r.points} windows re-scored `,
                  r.rawUnchanged
                    ? el('span', { class: 'badge good', text: 'raw unchanged' })
                    : el('span', { class: 'badge', text: 'raw changed' }),
                ]),
                el('div', { class: 'why' }, [
                  `digest ${r.digestBefore} → ${r.digestAfter} · ${r.durationMs}ms`,
                ]),
              ]),
              el('div', { class: 'when', text: fmtTime(r.startedAt, true) }),
            ])
          )
        )
      : el('div', { class: 'empty-note', text: 'No recompute recorded yet.' })
  );
}

/* ---------------- boot ---------------- */

async function reload() {
  state.overview = await api('/api/overview');
  renderOverview();
  if (state.selectedId) await loadDetail();
  else $('#detail-empty').classList.remove('hidden');
}

async function tick() {
  const btn = $('#tick');
  btn.disabled = true;
  try {
    const res = await api('/api/scheduler/tick', { method: 'POST', body: JSON.stringify({ advance: true }) });
    const collected = res.actions.filter((a) => a.action.startsWith('collect')).length;
    const probed = res.actions.filter((a) => a.action === 'probe').length;
    toast(`Scheduler ran at ${fmtTime(res.at, true)}: ${collected} collections, ${probed} probes.`);
    await reload();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function wire() {
  $('#range-seg').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-hours]');
    if (!btn) return;
    state.hours = Number(btn.dataset.hours);
    [...$('#range-seg').children].forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    if (state.selectedId) loadDetail().catch((e) => toast(e.message, true));
  });
  $('#state-seg').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-state]');
    if (!btn) return;
    state.stateFilter = btn.dataset.state;
    [...$('#state-seg').children].forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderOverview();
  });
  $('#detail-tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    applyTab();
  });
  $('#btn-hold').addEventListener('click', doHold);
  $('#btn-release').addEventListener('click', doRelease);
  $('#btn-preview').addEventListener('click', previewRule);
  $('#btn-publish').addEventListener('click', publishRule);
  $('#tick').addEventListener('click', tick);
  $('#refresh').addEventListener('click', () => reload().catch((e) => toast(e.message, true)));
  $('#reduced-below').addEventListener('input', (ev) => {
    $('#reduced-out').textContent = ev.target.value;
    const iso = Number($('#isolated-below').value);
    if (iso >= Number(ev.target.value)) {
      $('#isolated-below').value = String(Number(ev.target.value) - 1);
      $('#isolated-out').textContent = String(Number(ev.target.value) - 1);
    }
  });
  $('#isolated-below').addEventListener('input', (ev) => {
    $('#isolated-out').textContent = ev.target.value;
  });
  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.getAttribute('data-theme') === 'dark'
      || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-theme', dark ? 'light' : 'dark');
    if (state.detail) { renderTrend(state.detail); renderStateStrip(state.detail); }
  });

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.detail) { renderTrend(state.detail); renderStateStrip(state.detail); }
    }, 160);
  });

  // Keep the demo clock honest: refresh relative times every minute.
  setInterval(() => {
    if (document.hidden) return;
    renderOverview();
  }, 60_000);
}

async function main() {
  wire();
  await reload();
  await reloadRules();
  if (!state.selectedId) {
    const first = state.overview.sources[0];
    if (first) await selectSource(first.id);
  }
}

main().catch((e) => toast(e.message, true));
