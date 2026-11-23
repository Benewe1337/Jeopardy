// Per-client throttling for password checks (site login, host password).
// attempt() is called BEFORE the password is verified and counts atomically, so a burst of
// parallel guesses can't slip through; a correct password calls reset().
// After LIMIT attempts within WINDOW_MS the key is locked (429 + Retry-After); every further
// lockout doubles the wait (60 s, 120 s, … up to 15 min). Idle keys are forgotten after 1 h.

export const THROTTLE = {
  limit: 5,
  windowMs: 60_000,
  lockBaseMs: 60_000,
  lockMaxMs: 15 * 60_000,
  forgetMs: 60 * 60_000,
};

export const lockMs = (level) => Math.min(THROTTLE.lockMaxMs, THROTTLE.lockBaseMs * 2 ** Math.max(0, level - 1));

/** Pseudonymised client key: scope + truncated SHA-256 of the IP (no raw IPs in the database). */
export async function clientKey(scope, headers) {
  const h = (n) => headers?.get?.(n) || '';
  const ip = (h('x-real-ip') || h('x-forwarded-for').split(',')[0] || 'unknown').trim();
  const data = new TextEncoder().encode('jeopardy-throttle:' + ip);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return scope + ':' + [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function memoryThrottle({ now = () => Date.now() } = {}) {
  const rows = new Map(); // key -> { count, start, lockedUntil, level, last }
  const hits = new Map(); // key -> { count, start } (rate caps)
  return {
    async attempt(key) {
      const t = now();
      let r = rows.get(key);
      if (r && t - r.last > THROTTLE.forgetMs) r = null;
      if (!r) r = { count: 0, start: t, lockedUntil: 0, level: 0, last: t };
      rows.set(key, r);
      if (r.lockedUntil > t) return { allowed: false, retryAfter: Math.ceil((r.lockedUntil - t) / 1000) };
      if (t - r.start > THROTTLE.windowMs) { r.count = 0; r.start = t; }
      r.count++;
      r.last = t;
      if (r.count > THROTTLE.limit) {
        r.level++;
        r.count = 0;
        r.lockedUntil = t + lockMs(r.level);
        return { allowed: false, retryAfter: Math.ceil(lockMs(r.level) / 1000) };
      }
      return { allowed: true };
    },
    // Fixed-window counter for rate caps (not a lockout): `weight` events per call.
    async hit(key, { limit, windowMs, weight = 1 }) {
      const t = now();
      let r = hits.get(key);
      if (!r || t - r.start >= windowMs) { r = { count: 0, start: t }; hits.set(key, r); }
      r.count += weight;
      if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      if (r.count > limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((r.start + windowMs - t) / 1000)) };
      return { allowed: true };
    },
    async reset(key) { rows.delete(key); },
    _rows: rows,
  };
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS jeop_throttle (
  key text PRIMARY KEY,
  count int NOT NULL DEFAULT 0,
  start timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  level int NOT NULL DEFAULT 0,
  last timestamptz NOT NULL DEFAULT now()
)`;

/** Postgres throttle; `query(text, params)` returns an array of rows (like pgStore). */
export function pgThrottle(query) {
  let ready = null;
  let lastCleanup = 0;
  const q = async (text, params) => {
    await (ready ??= query(SCHEMA, []).catch((e) => { ready = null; throw e; }));
    return query(text, params);
  };
  const { limit, windowMs, lockBaseMs, lockMaxMs, forgetMs } = THROTTLE;
  return {
    // One atomic upsert; the row lock serialises parallel guesses per key.
    async attempt(key) {
      // $2 limit, $3 window s, $4 lock base s, $5 forget s, $6 lock max s. All right-hand sides
      // see the OLD row, so the three conditions below are evaluated against the previous state.
      const idle = 't.last < now() - make_interval(secs => $5)';
      const expired = `(${idle} OR t.start < now() - make_interval(secs => $3))`;
      const locked = 'COALESCE(t.locked_until > now(), false)';
      const trip = `(NOT ${locked} AND NOT ${expired} AND t.count + 1 > $2)`;
      const rows = await q(
        `INSERT INTO jeop_throttle AS t (key, count, start, level, last) VALUES ($1, 1, now(), 0, now())
         ON CONFLICT (key) DO UPDATE SET
           level = CASE WHEN ${idle} THEN 0 WHEN ${trip} THEN t.level + 1 ELSE t.level END,
           start = CASE WHEN NOT ${locked} AND ${expired} THEN now() ELSE t.start END,
           count = CASE WHEN ${locked} THEN t.count WHEN ${expired} THEN 1 WHEN ${trip} THEN 0 ELSE t.count + 1 END,
           locked_until = CASE WHEN ${locked} THEN t.locked_until
             WHEN ${trip} THEN now() + make_interval(secs => LEAST($6::float8, $4::float8 * power(2, t.level)))
             ELSE NULL END,
           last = CASE WHEN ${locked} THEN t.last ELSE now() END
         RETURNING GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - now())))) AS retry`,
        [key, limit, windowMs / 1000, lockBaseMs / 1000, forgetMs / 1000, lockMaxMs / 1000]);
      const retry = Number(rows[0]?.retry ?? 0);
      if (retry > 0) return { allowed: false, retryAfter: retry };
      if (Date.now() - lastCleanup > 10 * 60_000) {
        lastCleanup = Date.now();
        q('DELETE FROM jeop_throttle WHERE last < now() - make_interval(secs => $1)', [forgetMs / 1000]).catch(() => {});
      }
      return { allowed: true };
    },
    // Fixed-window counter for rate caps, same table (count/start; never locks).
    async hit(key, { limit, windowMs, weight = 1 }) {
      const rows = await q(
        `INSERT INTO jeop_throttle AS t (key, count, start, level, last) VALUES ($1, $2, now(), 0, now())
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN t.start < now() - make_interval(secs => $3) THEN $2 ELSE t.count + $2 END,
           start = CASE WHEN t.start < now() - make_interval(secs => $3) THEN now() ELSE t.start END,
           last = now()
         RETURNING count, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (start + make_interval(secs => $3) - now())))) AS retry`,
        [key, weight, windowMs / 1000]);
      if (Number(rows[0]?.count ?? 0) > limit) return { allowed: false, retryAfter: Number(rows[0].retry) };
      return { allowed: true };
    },
    async reset(key) { await q('DELETE FROM jeop_throttle WHERE key = $1', [key]); },
  };
}
