// Bullseye Links leaderboard API (Cloudflare Worker + D1)
//   POST /api/round   {mode}                      -> {roundId}        start a round, get a one-time ticket
//   POST /api/scores  {roundId, initials, holes}  -> {rank, top}      submit a finished round
//   GET  /api/scores?mode=9|18                    -> {top}            top 10 for a mode
// The server never trusts the browser's total: it recomputes the score from the per-hole strokes
// using its own copy of the course pars, and checks every hole is physically possible.

const PARS = [3, 4, 5, 3, 4, 5, 4, 3, 5, 4, 3, 5, 3, 4, 3, 5, 4, 4]; // must match the game
const MIN_STROKES = { 3: 1, 4: 2, 5: 3 };   // longest shot is ~380 units, so par 4s/5s can't be aced
const MAX_OVER_PAR = 4;                      // the game picks you up at par + 4
const MIN_SECONDS_PER_STROKE = 1;            // swing delay + ball flight is always > 1s
const ROUND_TTL_MS = 6 * 60 * 60 * 1000;     // a round ticket expires after 6 hours
const ALLOWED_ORIGINS = ['https://bullseye-links.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (data, status, origin) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });

async function ipHash(req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bullseye-links:' + ip));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function readJson(req) {
  if (Number(req.headers.get('Content-Length') || 0) > 2000) return null;
  try { const t = await req.text(); return t.length > 2000 ? null : JSON.parse(t); } catch { return null; }
}

async function topTen(db, mode) {
  const { results } = await db.prepare(
    'SELECT id, initials, strokes, rel, created_at FROM scores WHERE mode = ? ORDER BY rel ASC, created_at ASC LIMIT 10'
  ).bind(mode).all();
  return results;
}

async function startRound(req, env, origin) {
  const body = await readJson(req);
  const mode = body && body.mode;
  if (mode !== 9 && mode !== 18) return json({ error: 'mode must be 9 or 18' }, 400, origin);
  const ip = await ipHash(req), now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM rounds WHERE ip_hash = ? AND started_at > ?')
    .bind(ip, now - 60 * 60 * 1000).first();
  if (recent.n >= 60) return json({ error: 'Too many rounds started. Take a breather!' }, 429, origin);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO rounds (id, mode, started_at, ip_hash) VALUES (?, ?, ?, ?)').bind(id, mode, now, ip).run();
  // tidy up old unused tickets now and then
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM rounds WHERE started_at < ?').bind(now - 2 * ROUND_TTL_MS).run();
  return json({ roundId: id }, 200, origin);
}

async function submitScore(req, env, origin) {
  const body = await readJson(req);
  if (!body) return json({ error: 'Bad request' }, 400, origin);
  const { roundId, initials, holes } = body;

  if (typeof initials !== 'string' || !/^[A-Z]{3}$/.test(initials))
    return json({ error: 'Initials must be exactly 3 letters (A-Z)' }, 400, origin);
  if (typeof roundId !== 'string' || roundId.length > 64) return json({ error: 'Missing round ticket' }, 400, origin);

  const round = await env.DB.prepare('SELECT * FROM rounds WHERE id = ?').bind(roundId).first();
  if (!round) return json({ error: 'Unknown round' }, 400, origin);
  if (round.used) return json({ error: 'This round was already submitted' }, 409, origin);
  const now = Date.now();
  if (now - round.started_at > ROUND_TTL_MS) return json({ error: 'Round expired' }, 400, origin);

  const mode = round.mode; // trust the server's record of the mode, not the browser
  if (!Array.isArray(holes) || holes.length !== mode) return json({ error: `Expected ${mode} hole scores` }, 400, origin);
  let strokes = 0, par = 0;
  for (let i = 0; i < mode; i++) {
    const s = holes[i], p = PARS[i];
    if (!Number.isInteger(s) || s < MIN_STROKES[p] || s > p + MAX_OVER_PAR)
      return json({ error: `Impossible score on hole ${i + 1}` }, 400, origin);
    strokes += s; par += p;
  }
  if ((now - round.started_at) / 1000 < strokes * MIN_SECONDS_PER_STROKE)
    return json({ error: 'That round was impossibly fast' }, 400, origin);

  const ip = await ipHash(req);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE ip_hash = ? AND created_at > ?')
    .bind(ip, now - 60 * 60 * 1000).first();
  if (recent.n >= 20) return json({ error: 'Too many submissions. Try again later.' }, 429, origin);

  // mark the ticket used first, only if it is still unused (stops double submits racing each other)
  const claim = await env.DB.prepare('UPDATE rounds SET used = 1 WHERE id = ? AND used = 0').bind(roundId).run();
  if (!claim.meta.changes) return json({ error: 'This round was already submitted' }, 409, origin);

  const rel = strokes - par;
  const ins = await env.DB.prepare(
    'INSERT INTO scores (initials, mode, strokes, rel, holes, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(initials, mode, strokes, rel, JSON.stringify(holes), now, ip).run();
  const better = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE mode = ? AND (rel < ? OR (rel = ? AND created_at < ?))')
    .bind(mode, rel, rel, now).first();
  return json({ id: ins.meta.last_row_id, rank: better.n + 1, rel, strokes, top: await topTen(env.DB, mode) }, 200, origin);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    // browsers on other sites can't use the API
    if (req.method === 'POST' && !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Forbidden' }, 403, origin);
    try {
      if (url.pathname === '/api/round' && req.method === 'POST') return await startRound(req, env, origin);
      if (url.pathname === '/api/scores' && req.method === 'POST') return await submitScore(req, env, origin);
      if (url.pathname === '/api/scores' && req.method === 'GET') {
        const mode = Number(url.searchParams.get('mode'));
        if (mode !== 9 && mode !== 18) return json({ error: 'mode must be 9 or 18' }, 400, origin);
        return json({ top: await topTen(env.DB, mode) }, 200, origin);
      }
      return json({ error: 'Not found' }, 404, origin);
    } catch (e) {
      return json({ error: 'Server error' }, 500, origin);
    }
  },
};
