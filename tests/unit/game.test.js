// Spielstand auf dem Server (lib/game-core.mjs): Host-Passwort, Speichern, Übernahme (claim),
// Limits, Aufbewahrung – gegen den Speicher-Store; Postgres gegen ein Fake-query.
const test = require('node:test');
const assert = require('node:assert/strict');

let handleGame, memoryGameStore, pgGameStore, LIMITS, RETENTION, handleRelay, memoryStore;
test.before(async () => {
  ({ handleGame, memoryGameStore, pgGameStore, LIMITS, RETENTION } = await import('../../lib/game-core.mjs'));
  ({ handleRelay } = await import('../../lib/relay-core.mjs'));
  ({ memoryStore } = await import('../../lib/relay-stores.mjs'));
});

const PW = 'host-geheim';
const A = 'session-aaaaaaaa';
const B = 'session-bbbbbbbb';
const state = (extra = {}) => ({
  round: 0, used: [[[false]]], players: [{ id: 'p1', name: 'Anna', score: 300 }], turn: 'p1',
  current: { est: { answer: 42 } }, ...extra,
});

function client(store, ...rest) {
  const hostPassword = rest.length ? rest[0] : PW;
  return async (op, { body, query = {}, pw = PW, method } = {}) => {
    const q = new URLSearchParams({ op, ...query });
    const headers = new Headers(pw == null ? {} : { 'x-host-password': pw });
    return handleGame({
      method: method || (body ? 'POST' : 'GET'), query: q, headers,
      rawBody: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
    }, store, hostPassword);
  };
}
const save = (call, room, session, extra = {}) =>
  call('save', { body: { room, session, state: state(), title: 'Quiz', ...extra } });

test('Ohne Datenbank oder Host-Passwort: 503', async () => {
  assert.equal((await client(null)('check')).status, 503);
  assert.equal((await client(memoryGameStore(), '')('check')).status, 503);
  assert.equal((await client(memoryGameStore(), undefined)('check')).status, 503);
});

test('Host-Passwort fehlt oder falsch → 401 bei allen Operationen', async () => {
  const call = client(memoryGameStore());
  for (const [op, opts] of [
    ['check', {}], ['list', {}], ['get', { query: { room: 'ABC234' } }],
    ['save', { body: { room: 'ABC234', session: A, state: state() } }],
    ['claim', { body: { room: 'ABC234', session: A } }], ['delete', { body: { room: 'ABC234' } }],
  ]) {
    assert.equal((await call(op, { ...opts, pw: null })).status, 401, op + ' ohne');
    assert.equal((await call(op, { ...opts, pw: 'falsch' })).status, 401, op + ' falsch');
  }
  assert.equal((await call('check')).status, 200);
});

test('Speichern legt an, aktualisiert (rev+1) und liefert den Stand zurück', async () => {
  const call = client(memoryGameStore());
  const first = await save(call, 'ABC234', A, { set: { title: 'T', rounds: [] }, setId: 'abcdefgh1234' });
  assert.deepEqual(first, { status: 200, json: { ok: true, rev: 1 } });
  const second = await save(call, 'ABC234', A, { title: 'Quiz 2' });
  assert.equal(second.json.rev, 2);
  const got = (await call('get', { query: { room: 'ABC234' } })).json;
  assert.equal(got.rev, 2);
  assert.equal(got.session, A);
  assert.equal(got.title, 'Quiz 2');
  assert.deepEqual(got.state.players, [{ id: 'p1', name: 'Anna', score: 300 }]);
  assert.equal(got.setId, 'abcdefgh1234');
  assert.equal(got.set, undefined, 'Set nur mit set=1');
  const withSet = (await call('get', { query: { room: 'abc234', set: '1' } })).json;
  assert.deepEqual(withSet.set, { title: 'T', rounds: [] }, 'eingebettetes Set bleibt ohne neues `set` erhalten');
  assert.equal((await call('get', { query: { room: 'ZZZZZZ' } })).status, 404);
});

test('Liste enthält Kopfdaten, aber keinen State und keine Antworten', async () => {
  const call = client(memoryGameStore());
  await save(call, 'ABC234', A, { state: state({ round: 1, finished: true }) });
  const { games } = (await call('list')).json;
  assert.equal(games.length, 1);
  assert.deepEqual(Object.keys(games[0]).sort(), ['finished', 'players', 'rev', 'room', 'round', 'title', 'updated']);
  assert.equal(games[0].round, 1);
  assert.equal(games[0].finished, true);
  const dump = JSON.stringify((await call('list')).json) + JSON.stringify((await call('get', { query: { room: 'ABC234' } })).json);
  assert.ok(!dump.includes(PW), 'Host-Passwort taucht nie in Antworten auf');
});

test('Fremde Session → 409 superseded; claim übernimmt, danach ist die alte Session ungültig', async () => {
  const call = client(memoryGameStore());
  await save(call, 'ABC234', A);
  const other = await save(call, 'ABC234', B);
  assert.deepEqual(other, { status: 409, json: { error: 'superseded' } });
  assert.equal((await call('claim', { body: { room: 'ABC234', session: B } })).status, 200);
  assert.equal((await save(call, 'ABC234', A)).status, 409, 'alter Tab verliert');
  assert.equal((await save(call, 'ABC234', B)).status, 200, 'neuer Tab darf schreiben');
  assert.equal((await call('claim', { body: { room: 'NOPE234', session: B } })).status, 404);
});

test('Limits: Raum/Session/State/Set/Body/maxGames', async () => {
  const call = client(memoryGameStore());
  assert.equal((await save(call, 'ab', A)).status, 400, 'Raumcode zu kurz');
  assert.equal((await save(call, 'ABC234', 'kurz')).status, 400, 'Session ungültig');
  assert.equal((await call('save', { body: { room: 'ABC234', session: A, state: { players: 1 } } })).status, 400);
  assert.equal((await call('save', { body: { room: 'ABC234', session: A, state: state({ players: [{ id: 'x'.repeat(LIMITS.maxStateBytes) }] }) } })).status, 413);
  assert.equal((await save(call, 'ABC234', A, { set: { rounds: 'x' } })).status, 400);
  assert.equal((await save(call, 'ABC234', A, { set: { rounds: ['x'.repeat(LIMITS.maxSetBytes)] } })).status, 413);
  assert.equal((await call('save', { body: 'x'.repeat(LIMITS.maxBodyBytes + 1) })).status, 413);
  assert.equal((await call('save', { body: '{kaputt' })).status, 400);
  assert.equal((await call('save', { body: 'x', method: 'GET' })).status, 405);

  const full = memoryGameStore();
  const c2 = client(full);
  for (let i = 0; i < LIMITS.maxGames; i++) assert.equal((await save(c2, 'ROOM' + String(i).padStart(2, '0'), A)).status, 200);
  assert.deepEqual(await save(c2, 'NEWROOM', A), { status: 409, json: { error: 'too many games' } });
  assert.equal((await save(c2, 'ROOM00', A)).status, 200, 'vorhandenes Spiel darf weiter speichern');
  await c2('delete', { body: { room: 'ROOM01' } });
  assert.equal((await save(c2, 'NEWROOM', A)).status, 200, 'nach dem Löschen wieder Platz');
});

test('Löschen entfernt das Spiel', async () => {
  const call = client(memoryGameStore());
  await save(call, 'ABC234', A);
  assert.equal((await call('delete', { body: { room: 'ABC234' } })).status, 200);
  assert.equal((await call('get', { query: { room: 'ABC234' } })).status, 404);
});

test('Aufbewahrung: 30 Tage, beendete Spiele 3 Tage; Aufräumen höchstens 1×/min', async () => {
  let t = Date.parse('2026-11-16T10:00:00Z');
  const store = memoryGameStore({ now: () => t });
  const call = client(store);
  await save(call, 'ACTIVE1', A);
  await save(call, 'OLDONE1', A);
  await save(call, 'DONE001', A, { state: state({ finished: true }) });
  t += 2 * 24 * 3600_000;
  await store.cleanup();
  assert.equal((await store.list()).length, 3, 'nach 2 Tagen ist noch alles da');
  t += 1.5 * 24 * 3600_000; // 3,5 Tage
  await store.cleanup();
  assert.deepEqual((await store.list()).map((g) => g.room).sort(), ['ACTIVE1', 'OLDONE1'], 'fertiges Spiel nach 3 Tagen weg');
  t += 27 * 24 * 3600_000; // 30,5 Tage seit dem Speichern
  await save(call, 'FRESH01', A); // Cleanup läuft beim Speichern mit
  assert.deepEqual((await store.list()).map((g) => g.room), ['FRESH01'], 'alte Spiele nach 30 Tagen weg');
  // Drossel: direkt danach nicht erneut
  t += 40 * 24 * 3600_000;
  await store.maybeCleanup();
  assert.equal((await store.list()).length, 0);
  assert.ok(RETENTION.cleanupEveryMs >= 60_000);
});

test('Postgres-Speicher: legt Tabelle einmal an, nutzt Parameter, UPDATE nur mit Session', async () => {
  const calls = [];
  const store = pgGameStore(async (text, params) => {
    calls.push({ text, params });
    if (text.startsWith('SELECT room, rev, session')) {
      return [{ room: 'ABC234', rev: '3', session: A, updated: new Date(0), title: 'T', round: 1, players: 2,
        finished: false, app: 'v', state: '{"players":[],"used":[]}', set_id: null, set_body: null }];
    }
    if (text.includes('RETURNING rev')) return [{ rev: '4' }];
    return [];
  });
  const f = { title: 'T', round: 1, players: 2, finished: false, state: '{}', app: 'v', setId: null, setBody: undefined };
  assert.equal(await store.save('ABC234', A, f, true), 4);
  assert.equal(await store.save('ABC234', A, f, false), 4);
  const upd = calls.find((c) => c.text.startsWith('UPDATE jeop_games SET rev = rev + 1'));
  assert.ok(upd.text.includes('WHERE room = $1 AND session = $2'));
  assert.equal(upd.params[9], false, 'ohne Set bleibt set_body unberührt');
  assert.equal((await store.get('ABC234')).rev, 3);
  await store.cleanup();
  const del = calls.find((c) => c.text.startsWith('DELETE FROM jeop_games'));
  assert.deepEqual(del.params, [30 * 24 * 3600, 3 * 24 * 3600]);
  assert.equal(calls.filter((c) => c.text.startsWith('CREATE TABLE')).length, 1);
  assert.equal(calls.filter((c) => c.text.startsWith('CREATE INDEX')).length, 1);
  assert.ok(calls.every((c) => !c.text.includes('ABC234')), 'Werte nur als Parameter');
});

// ---------- Relay: Host-Übernahme ----------
const HOST1 = 'hosttoken-aaaaaaaa';
const HOST2 = 'hosttoken-bbbbbbbb';
const relay = (store, op, body, pw) => handleRelay({
  method: 'POST', query: new URLSearchParams({ op }), rawBody: JSON.stringify(body),
  headers: new Headers(pw == null ? {} : { 'x-host-password': pw }),
}, store, PW);

test('Relay-Takeover: ohne Flag wartet der neue Host, mit Host-Passwort übernimmt er sofort', async () => {
  const store = memoryStore();
  assert.equal((await relay(store, 'host', { room: 'ABC234', token: HOST1 })).status, 200);
  assert.equal((await relay(store, 'host', { room: 'ABC234', token: HOST2 })).status, 409, 'Verhalten wie bisher');
  assert.equal((await relay(store, 'host', { room: 'ABC234', token: HOST2, takeover: true })).status, 401, 'ohne Passwort');
  assert.equal((await relay(store, 'host', { room: 'ABC234', token: HOST2, takeover: true }, 'falsch')).status, 401);
  assert.equal((await relay(store, 'host', { room: 'ABC234', token: HOST2, takeover: true }, PW)).status, 200);
  // der alte Host fliegt raus (403) und kann nicht ohne Weiteres zurück
  assert.equal((await relay(store, 'poll', { room: 'ABC234', as: 'host', token: HOST1, after: 0 })).status, 403);
  assert.equal((await relay(store, 'send', { room: 'ABC234', as: 'host', token: HOST1, msgs: [{ body: 1 }] })).status, 403);
  assert.equal((await relay(store, 'host', { room: 'ABC234', token: HOST1 })).status, 409);
  assert.equal((await relay(store, 'poll', { room: 'ABC234', as: 'host', token: HOST2, after: -1 })).status, 200);
});

test('Relay-Takeover ohne konfiguriertes Host-Passwort wird abgelehnt', async () => {
  const res = await handleRelay({
    method: 'POST', query: new URLSearchParams({ op: 'host' }),
    rawBody: JSON.stringify({ room: 'ABC234', token: HOST2, takeover: true }), headers: new Headers({ 'x-host-password': 'x' }),
  }, memoryStore(), undefined);
  assert.equal(res.status, 401);
});
