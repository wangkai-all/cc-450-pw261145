import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { getSource } from './repo.js';
import { overview, sourceDetail, transitionFeed, rulesWithRuns } from './views.js';
import {
  holdSource,
  previewRule,
  publishAndRecompute,
  releaseToNormal,
  tickScheduler,
} from './scheduler.js';
import { normalizeRule } from './scoring.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error('payload too large');
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

function parseRange(url) {
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  return { from, to };
}

export function createApp({ dbFile } = {}) {
  const db = openDb(dbFile ?? process.env.DB_FILE);
  const clock = { now: () => new Date().toISOString() };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(db, clock, req, res, url);
        return;
      }
      await serveStatic(res, url.pathname);
    } catch (error) {
      json(res, 400, { error: error.message });
    }
  });

  return { server, db, clock };
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const file = join(PUBLIC_DIR, rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

async function handleApi(db, clock, req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method ?? 'GET';

  // GET /api/overview
  if (parts[1] === 'overview' && method === 'GET') {
    return json(res, 200, overview(db, clock.now()));
  }

  // GET /api/transitions
  if (parts[1] === 'transitions' && method === 'GET') {
    return json(res, 200, { transitions: transitionFeed(db, Number(url.searchParams.get('limit') ?? 60)) });
  }

  // GET /api/sources/:id
  if (parts[1] === 'sources' && parts[2] && parts.length === 3 && method === 'GET') {
    const detail = sourceDetail(db, parts[2], { ...parseRange(url), now: clock.now() });
    if (!detail) return json(res, 404, { error: `unknown source ${parts[2]}` });
    return json(res, 200, detail);
  }

  // POST /api/sources/:id/hold  |  /release
  if (parts[1] === 'sources' && parts[2] && parts[3] && method === 'POST') {
    const body = await readBody(req);
    const at = clock.now();
    if (parts[3] === 'hold') {
      if (!body.actor || !body.note) return json(res, 422, { error: 'actor and note are required' });
      const holdHours = body.holdHours === '' || body.holdHours == null ? null : Number(body.holdHours);
      if (holdHours != null && !(holdHours > 0)) return json(res, 422, { error: 'holdHours must be positive or empty' });
      const result = holdSource(db, parts[2], { actor: body.actor, note: body.note, holdHours, at });
      if (!result) return json(res, 404, { error: 'unknown source' });
      return json(res, 200, { sourceId: parts[2], state: result.state, action: 'hold' });
    }
    if (parts[3] === 'release') {
      if (!body.actor || !body.note) return json(res, 422, { error: 'actor and note are required' });
      const result = releaseToNormal(db, parts[2], { actor: body.actor, note: body.note, at });
      if (!result) return json(res, 404, { error: 'unknown source' });
      return json(res, 200, { sourceId: parts[2], state: result.state, action: 'release' });
    }
  }

  // GET /api/rules
  if (parts[1] === 'rules' && method === 'GET') {
    return json(res, 200, rulesWithRuns(db));
  }

  // POST /api/rules/preview  (pure: writes nothing)
  if (parts[1] === 'rules' && parts[2] === 'preview' && method === 'POST') {
    const body = await readBody(req);
    const config = normalizeRule({ ...body.config });
    return json(res, 200, {
      preview: previewRule(db, config, parseRange(url)),
      rule: { weights: config.weights, thresholds: config.thresholds, smoothing: config.smoothing },
    });
  }

  // POST /api/rules  (publish + recompute history)
  if (parts[1] === 'rules' && parts.length === 2 && method === 'POST') {
    const body = await readBody(req);
    if (!body.actor || !body.note) return json(res, 422, { error: 'actor and note are required' });
    const config = normalizeRule({ ...(body.config ?? {}) });
    const result = publishAndRecompute(db, config, {
      actor: body.actor,
      note: body.note,
      label: body.label,
      ...parseRange(url),
    });
    return json(res, 200, {
      version: result.version,
      previousVersion: result.previousVersion,
      run: result.run,
    });
  }

  // POST /api/scheduler/tick  (manual tick for the demo; normally a cron)
  if (parts[1] === 'scheduler' && parts[2] === 'tick' && method === 'POST') {
    const body = await readBody(req);
    let now = body.now ?? clock.now();
    if (body.advance) {
      // Demo convenience: fire at the point where every source is due, instead
      // of waiting for it. This is what a cron would do after enough elapsed
      // ticks; nextWindowBoundary still refuses a window that has not closed.
      const row = db.prepare('SELECT MAX(next_due_at) AS at FROM source_state').get();
      if (row?.at && row.at > now) {
        now = row.at;
        clock.now = () => now;
      }
    }
    return json(res, 200, tickScheduler(db, { now, force: Boolean(body.force) }));
  }

  // POST /api/clock  (test/demo helper to advance the simulated clock)
  if (parts[1] === 'clock' && method === 'POST') {
    const body = await readBody(req);
    if (!body.now || Number.isNaN(Date.parse(body.now))) return json(res, 422, { error: 'now must be ISO' });
    clock.now = () => body.now;
    return json(res, 200, { now: clock.now() });
  }

  if (parts[1] === 'health' && method === 'GET') {
    const source = parts[2] ? getSource(db, parts[2]) : null;
    return json(res, 200, { ok: true, at: clock.now(), knownSource: Boolean(source) });
  }

  return json(res, 404, { error: 'unknown endpoint' });
}

const isEntry = process.argv[1] && new URL(`file://${resolve(process.argv[1])}`).href === import.meta.url;
if (isEntry) {
  const { db, server } = createApp();
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    const count = db.prepare('SELECT COUNT(*) c FROM samples').get().c;
    console.log(`source-health listening on http://localhost:${port} (${count} raw samples)`);
  });
}
