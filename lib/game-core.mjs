// Spielstand auf dem Server (Vercel + Postgres), damit ein Spiel nach einem Absturz oder auf einem
// anderen Gerät fortgesetzt werden kann ("Spiel fortsetzen").
//
// Der gespeicherte Stand enthält Antworten (z. B. die Lösung einer Schätzfrage) und gehört deshalb
// hinter das Host-Passwort (JEOPARDY_HOST_PASSWORD, Header `x-host-password`) – wie die Fragensets.
// Ein Spiel pro Raumcode. `session` ist die ID des Host-Fensters, das gerade schreibt: wer speichert,
// obwohl inzwischen ein anderes Fenster übernommen hat (`claim`), bekommt 409 `superseded`.
// Die Session ist nur Konfliktschutz, keine Autorisierung.

import { passwordOk } from './host-auth.mjs';

export const LIMITS = {
  maxBodyBytes: 4_000_000, // Vercel erlaubt 4,5 MB pro Anfrage
  maxStateBytes: 600_000,
  maxSetBytes: 3_000_000,
  maxGames: 20,
  maxTitleLength: 100,
};

// Aufbewahrung: Spielabend "nächste Woche weiter" → 30 Tage; beendete Spiele nur 3 Tage
export const RETENTION = {
  ms: 30 * 24 * 3600_000,
  finishedMs: 3 * 24 * 3600_000,
  cleanupEveryMs: 60_000,
};

const ROOM_RE = /^[A-Z0-9]{4,12}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SET_ID_RE = /^[a-z0-9]{8,32}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function room(v) {
  const r = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!ROOM_RE.test(r)) throw new HttpError(400, 'invalid room');
  return r;
}

function session(v) {
  if (typeof v !== 'string' || !SESSION_RE.test(v)) throw new HttpError(400, 'invalid session');
  return v;
}

function cleanTitle(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxTitleLength) : '';
}

// Grobe Formprüfung; die genaue Normalisierung macht der Browser beim Fortsetzen (J.normalizeState)
function checkState(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.players) || !Array.isArray(s.used)) {
    throw new HttpError(400, 'invalid state');
  }
  const json = JSON.stringify(s);
  if (json.length > LIMITS.maxStateBytes) throw new HttpError(413, 'state too large');
  return json;
}

function checkSet(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.rounds)) throw new HttpError(400, 'invalid set');
  const json = JSON.stringify(s);
  if (json.length > LIMITS.maxSetBytes) throw new HttpError(413, 'set too large');
  return json;
}

/**
 * @param {{ method: string, query: URLSearchParams, headers: { get(name: string): string|null }, rawBody: string }} req
 * @param {object|null} store memoryGameStore/pgGameStore oder null, wenn keine Datenbank da ist
 * @param {string|undefined} hostPassword Wert von JEOPARDY_HOST_PASSWORD
 */
export async function handleGame(req, store, hostPassword) {
  try {
    const op = req.query.get('op');
    // Ohne Datenbank oder Host-Passwort: der Browser speichert nur lokal
    if (!store || !hostPassword) throw new HttpError(503, 'game not configured');
    if (!(await passwordOk(req.headers.get('x-host-password'), hostPassword))) {
      throw new HttpError(401, 'wrong host password');
    }

    if (op === 'check') return { status: 200, json: { ok: true } };
    if (op === 'list') {
      await store.maybeCleanup?.();
      return { status: 200, json: { games: await store.list() } };
    }
    if (op === 'get') {
      const g = await store.get(room(req.query.get('room')));
      if (!g) throw new HttpError(404, 'game not found');
      const withSet = req.query.get('set') === '1';
      const { setBody, ...meta } = g;
      return { status: 200, json: withSet && setBody ? { ...meta, set: JSON.parse(setBody) } : meta };
    }

    if (req.method !== 'POST') throw new HttpError(405, 'use POST');
    if (req.rawBody.length > LIMITS.maxBodyBytes) throw new HttpError(413, 'body too large');
    let p;
    try { p = JSON.parse(req.rawBody || '{}'); } catch { throw new HttpError(400, 'invalid json'); }
    if (!p || typeof p !== 'object') throw new HttpError(400, 'invalid json');

    if (op === 'save') {
      const r = room(p.room);
      const sess = session(p.session);
      const stateJson = checkState(p.state);
      const fields = {
        title: cleanTitle(p.title),
        round: p.state.round === 1 ? 1 : 0,
        players: p.state.players.length,
        finished: p.state.finished === true,
        state: stateJson,
        app: typeof p.app === 'string' ? p.app.slice(0, 40) : null,
        // `setId` bleibt erhalten, wenn der Client ihn nicht mitschickt
        setId: 'setId' in p ? (typeof p.setId === 'string' && SET_ID_RE.test(p.setId) ? p.setId : null) : undefined,
        // `set` nur, wenn es neu mitgeschickt wird; `set: null` löscht das eingebettete Set
        setBody: 'set' in p ? (p.set == null ? null : checkSet(p.set)) : undefined,
      };
      const current = await store.sessionOf(r);
      if (current == null) {
        if ((await store.count()) >= LIMITS.maxGames) throw new HttpError(409, 'too many games');
      } else if (current !== sess) {
        throw new HttpError(409, 'superseded');
      }
      const rev = await store.save(r, sess, fields, current == null);
      if (rev == null) throw new HttpError(409, 'superseded'); // jemand war schneller
      await store.maybeCleanup?.();
      return { status: 200, json: { ok: true, rev } };
    }
    if (op === 'claim') {
      const rev = await store.claim(room(p.room), session(p.session));
      if (rev == null) throw new HttpError(404, 'game not found');
      return { status: 200, json: { ok: true, rev } };
    }
    if (op === 'delete') {
      await store.remove(room(p.room));
      return { status: 200, json: { ok: true } };
    }
    throw new HttpError(404, 'unknown op');
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, json: { error: err.message } };
    console.error('game error', err);
    return { status: 500, json: { error: 'internal error' } };
  }
}

// ---------- Speicher ----------
// Beide Speicher liefern dieselbe Form:
//   list() → [{ room, title, round, players, finished, rev, updated }]   (ohne State)
//   get(room) → { room, rev, session, updated, title, round, players, finished, app, state, setId, setBody } | null
//   sessionOf(room) → Session-ID oder null;  count();  save(room, session, fields, isNew) → rev | null
//   claim(room, session) → rev | null;  remove(room);  cleanup(); maybeCleanup()

function expired(g, t) {
  const age = t - g.updatedMs;
  return age > RETENTION.ms || (g.finished && age > RETENTION.finishedMs);
}

export function memoryGameStore({ now = () => Date.now() } = {}) {
  const games = new Map(); // room -> { session, rev, updatedMs, ...Spalten }
  let lastCleanup = 0;
  const iso = (g) => new Date(g.updatedMs).toISOString();

  const store = {
    async list() {
      return [...games].map(([r, g]) => ({
        room: r, title: g.title, round: g.round, players: g.players, finished: g.finished, rev: g.rev, updated: iso(g),
      })).sort((a, b) => b.updated.localeCompare(a.updated));
    },
    async get(r) {
      const g = games.get(r);
      if (!g) return null;
      return {
        room: r, rev: g.rev, session: g.session, updated: iso(g), title: g.title, round: g.round,
        players: g.players, finished: g.finished, app: g.app, state: JSON.parse(g.state),
        setId: g.setId, setBody: g.setBody,
      };
    },
    async sessionOf(r) { return games.get(r)?.session ?? null; },
    async count() { return games.size; },
    async save(r, sess, f, isNew) {
      const g = games.get(r);
      if (isNew ? g : !g || g.session !== sess) return null;
      const next = {
        ...(g || { rev: 0, setBody: null, setId: null }),
        session: sess, rev: (g ? g.rev : 0) + 1, updatedMs: now(),
        title: f.title, round: f.round, players: f.players, finished: f.finished,
        state: f.state, app: f.app,
      };
      if (f.setId !== undefined) next.setId = f.setId;
      if (f.setBody !== undefined) next.setBody = f.setBody;
      games.set(r, next);
      return next.rev;
    },
    async claim(r, sess) {
      const g = games.get(r);
      if (!g) return null;
      g.session = sess;
      g.rev += 1;
      g.updatedMs = now();
      return g.rev;
    },
    async remove(r) { games.delete(r); },
    async cleanup() {
      const t = now();
      for (const [r, g] of games) if (expired(g, t)) games.delete(r);
    },
    async maybeCleanup() {
      const t = now();
      if (t - lastCleanup < RETENTION.cleanupEveryMs) return;
      lastCleanup = t;
      await store.cleanup();
    },
  };
  return store;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jeop_games (
     room text PRIMARY KEY,
     session text NOT NULL,
     rev bigint NOT NULL DEFAULT 1,
     title text NOT NULL DEFAULT '',
     round smallint NOT NULL DEFAULT 0,
     players int NOT NULL DEFAULT 0,
     finished boolean NOT NULL DEFAULT false,
     state text NOT NULL,
     set_id text,
     set_body text,
     app text,
     created timestamptz NOT NULL DEFAULT now(),
     updated timestamptz NOT NULL DEFAULT now()
   )`,
  'CREATE INDEX IF NOT EXISTS jeop_games_updated ON jeop_games (updated)',
];

/** Postgres-Speicher. `query(text, params)` liefert Zeilen-Objekte (z. B. neon(url).query). */
export function pgGameStore(query) {
  let ready = null;
  let lastCleanup = 0;
  const init = () => (ready ??= (async () => {
    for (const s of SCHEMA) await query(s, []);
  })().catch((e) => { ready = null; throw e; }));
  const q = async (text, params) => { await init(); return query(text, params); };
  const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

  return {
    async list() {
      const rows = await q(
        'SELECT room, title, round, players, finished, rev, updated FROM jeop_games ORDER BY updated DESC', []);
      return rows.map((r) => ({
        room: r.room, title: r.title, round: Number(r.round), players: Number(r.players),
        finished: r.finished === true, rev: Number(r.rev), updated: iso(r.updated),
      }));
    },
    async get(r) {
      const rows = await q(
        `SELECT room, rev, session, updated, title, round, players, finished, app, state, set_id, set_body
         FROM jeop_games WHERE room = $1`, [r]);
      if (!rows.length) return null;
      const g = rows[0];
      return {
        room: g.room, rev: Number(g.rev), session: g.session, updated: iso(g.updated), title: g.title,
        round: Number(g.round), players: Number(g.players), finished: g.finished === true, app: g.app,
        state: JSON.parse(g.state), setId: g.set_id, setBody: g.set_body,
      };
    },
    async sessionOf(r) {
      const rows = await q('SELECT session FROM jeop_games WHERE room = $1', [r]);
      return rows.length ? rows[0].session : null;
    },
    async count() {
      const rows = await q('SELECT count(*)::int AS n FROM jeop_games', []);
      return rows[0].n;
    },
    // Neu: INSERT … ON CONFLICT DO NOTHING; vorhanden: UPDATE nur mit passender Session.
    // `set_body`/`set_id` bleiben unberührt, wenn der Client sie nicht mitschickt ($10/$12 = false).
    async save(r, sess, f, isNew) {
      const hasSet = f.setBody !== undefined;
      const hasSetId = f.setId !== undefined;
      const args = [r, sess, f.title, f.round, f.players, f.finished, f.state, hasSetId ? f.setId : null, f.app];
      const rows = isNew
        ? await q(
          `INSERT INTO jeop_games (room, session, title, round, players, finished, state, set_id, app, set_body)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (room) DO NOTHING RETURNING rev`, [...args, hasSet ? f.setBody : null])
        : await q(
          `UPDATE jeop_games SET rev = rev + 1, updated = now(), title = $3, round = $4, players = $5,
             finished = $6, state = $7, app = $9,
             set_id = CASE WHEN $12::boolean THEN $8::text ELSE set_id END,
             set_body = CASE WHEN $10::boolean THEN $11::text ELSE set_body END
           WHERE room = $1 AND session = $2 RETURNING rev`, [...args, hasSet, hasSet ? f.setBody : null, hasSetId]);
      return rows.length ? Number(rows[0].rev) : null;
    },
    async claim(r, sess) {
      const rows = await q(
        'UPDATE jeop_games SET session = $2, rev = rev + 1, updated = now() WHERE room = $1 RETURNING rev', [r, sess]);
      return rows.length ? Number(rows[0].rev) : null;
    },
    async remove(r) { await q('DELETE FROM jeop_games WHERE room = $1', [r]); },
    async cleanup() {
      await q(
        `DELETE FROM jeop_games
         WHERE updated < now() - make_interval(secs => $1)
            OR (finished AND updated < now() - make_interval(secs => $2))`,
        [RETENTION.ms / 1000, RETENTION.finishedMs / 1000]);
    },
    async maybeCleanup() {
      if (Date.now() - lastCleanup < RETENTION.cleanupEveryMs) return;
      lastCleanup = Date.now();
      try { await this.cleanup(); } catch (e) { console.error('game cleanup failed', e); }
    },
  };
}
