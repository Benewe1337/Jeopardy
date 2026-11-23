// HTTP-Relay (lib/relay-core.mjs) mit Speicher-Backend
const test = require('node:test');
const assert = require('node:assert/strict');

let handleRelay, memoryStore;
test.before(async () => {
  ({ handleRelay } = await import('../../lib/relay-core.mjs'));
  ({ memoryStore } = await import('../../lib/relay-stores.mjs'));
});

const HOST = 'hosttoken-aaaaaaaa';
// A player's connection: id = first 32 hex chars of SHA-256(key) (see ownedConnection in relay-core)
const conn = (key) => ({ as: require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0, 32), key });
const P1 = conn('player1-key-aaaaaaaaaaaa');
const P2 = conn('player2-key-bbbbbbbbbbbb');

function client(store, throttle, ip = '1.1.1.1') {
  return async (op, body, method = 'POST') => {
    const res = await handleRelay({
      method, query: new URLSearchParams({ op }), rawBody: body ? JSON.stringify(body) : '',
      headers: { get: (n) => (n.toLowerCase() === 'x-real-ip' ? ip : null) },
    }, store, undefined, throttle);
    return res;
  };
}

test('ping meldet das Relay', async () => {
  const call = client(memoryStore());
  const res = await call('ping', null, 'GET');
  assert.deepEqual(res, { status: 200, json: { ok: true, relay: true } });
});

test('Host belegt Raum, fremder Token wird abgewiesen, gleicher Token darf neu anmelden', async () => {
  const call = client(memoryStore());
  assert.equal((await call('host', { room: 'ABC123', token: HOST })).status, 200);
  assert.equal((await call('host', { room: 'ABC123', token: 'other-token-xxxxx' })).status, 409);
  assert.equal((await call('host', { room: 'abc123', token: HOST })).status, 200, 'Reload des Hosts');
});

test('Stiller Raum bleibt gesperrt: fremder Token bekommt nie den Raum, der Host schon', async () => {
  let t = 0;
  const call = client(memoryStore({ now: () => t }));
  await call('host', { room: 'ABC123', token: HOST });
  for (const wait of [61_000, 3600_000, 24 * 3600_000]) {
    t = wait;
    assert.equal((await call('host', { room: 'ABC123', token: 'other-token-xxxxx' })).status, 409, `nach ${wait} ms`);
    assert.equal((await call('poll', { room: 'ABC123', as: 'host', token: 'other-token-xxxxx', after: 0 })).status, 403);
  }
  assert.equal((await call('host', { room: 'ABC123', token: HOST })).status, 200, 'Host kehrt nach langer Pause zurück');
});

test('Nachrichten laufen gezielt und als Rundsendung, Cursor überspringt nichts', async () => {
  const call = client(memoryStore());
  await call('host', { room: 'ROOM42', token: HOST });
  const start1 = (await call('poll', { room: 'ROOM42', ...P1, after: -1 })).json;
  const start2 = (await call('poll', { room: 'ROOM42', ...P2, after: -1 })).json;
  assert.equal(start1.host, true);

  await call('send', { room: 'ROOM42', ...P1, msgs: [{ body: { t: 'open' } }] });
  const h = (await call('poll', { room: 'ROOM42', as: 'host', token: HOST, after: 0 })).json;
  assert.deepEqual(h.msgs.map((m) => [m.peer, m.body.t]), [[P1.as, 'open']]);

  await call('send', {
    room: 'ROOM42', as: 'host', token: HOST,
    msgs: [{ to: P1.as, body: { t: 'data', d: 'nur P1' } }, { to: null, body: { t: 'data', d: 'alle' } }],
  });
  const r1 = (await call('poll', { room: 'ROOM42', ...P1, after: start1.seq })).json;
  const r2 = (await call('poll', { room: 'ROOM42', ...P2, after: start2.seq })).json;
  assert.deepEqual(r1.msgs.map((m) => m.body.d), ['nur P1', 'alle']);
  assert.deepEqual(r2.msgs.map((m) => m.body.d), ['alle']);
  assert.equal(r1.seq, r2.seq);

  // Spieler sehen keine Nachrichten an den Host
  assert.ok(!r1.msgs.some((m) => m.body.t === 'open'));
});

test('Long-Poll wartet auf neue Nachrichten', async () => {
  const call = client(memoryStore());
  await call('host', { room: 'WAIT01', token: HOST });
  const { seq } = (await call('poll', { room: 'WAIT01', ...P1, after: -1 })).json;
  const started = Date.now();
  const pending = call('poll', { room: 'WAIT01', ...P1, after: seq, wait: 3000 });
  setTimeout(() => call('send', { room: 'WAIT01', as: 'host', token: HOST, msgs: [{ to: null, body: 'hi' }] }), 300);
  const res = (await pending).json;
  assert.deepEqual(res.msgs.map((m) => m.body), ['hi']);
  const took = Date.now() - started;
  assert.ok(took >= 250 && took < 2000, `dauerte ${took} ms`);
});

test('Long-Poll endet ohne Nachrichten nach der Wartezeit', async () => {
  const call = client(memoryStore());
  await call('host', { room: 'WAIT02', token: HOST });
  const res = (await call('poll', { room: 'WAIT02', ...P1, after: 0, wait: 300 })).json;
  assert.deepEqual(res.msgs, []);
});

test('Nur der Host darf an Spieler senden und Host-Nachrichten lesen', async () => {
  const call = client(memoryStore());
  await call('host', { room: 'SAFE01', token: HOST });
  assert.equal((await call('send', { room: 'SAFE01', as: 'host', token: 'wrong-token-xxxxx', msgs: [{ body: 1 }] })).status, 403);
  assert.equal((await call('poll', { room: 'SAFE01', as: 'host', token: 'wrong-token-xxxxx', after: 0 })).status, 403);
});

test('Ungültige Eingaben werden abgewiesen', async () => {
  const call = client(memoryStore());
  assert.equal((await call('host', { room: 'x', token: HOST })).status, 400);
  assert.equal((await call('host', { room: 'ABC123', token: 'kurz' })).status, 400);
  assert.equal((await call('send', { room: 'NOROOM', ...P1, msgs: [{ body: 1 }] })).status, 404);
  assert.equal((await call('nope', {})).status, 404);
  assert.equal((await call('poll', null, 'GET')).status, 405);
  const bad = await handleRelay({ method: 'POST', query: new URLSearchParams({ op: 'poll' }), rawBody: '{kaputt' }, memoryStore());
  assert.equal(bad.status, 400);
  const many = Array.from({ length: 51 }, () => ({ body: 1 }));
  await call('host', { room: 'MANY01', token: HOST });
  assert.equal((await call('send', { room: 'MANY01', ...P1, msgs: many })).status, 413);
});

test('Spieler ohne Host im Raum sieht host=false', async () => {
  const call = client(memoryStore());
  const res = (await call('poll', { room: 'EMPTY1', ...P1, after: -1 })).json;
  assert.equal(res.host, false);
});

// ---------- DoS caps (security audit #4) ----------

test('Spieler kann nicht als fremde Verbindung senden oder lesen', async () => {
  const call = client(memoryStore());
  await call('host', { room: 'OWN001', token: HOST });
  const fake = { as: P1.as, key: 'attacker-key-cccccccccccc' };
  assert.equal((await call('send', { room: 'OWN001', ...fake, msgs: [{ body: { t: 'close' } }] })).status, 403, 'falscher Schlüssel');
  assert.equal((await call('send', { room: 'OWN001', as: P1.as, msgs: [{ body: 1 }] })).status, 403, 'ohne Schlüssel');
  assert.equal((await call('poll', { room: 'OWN001', ...fake, after: -1 })).status, 403, 'Lesen fremder Nachrichten');
  assert.equal((await call('send', { room: 'OWN001', ...P1, msgs: [{ body: { t: 'hb' } }] })).status, 200);
});

test('Räume pro IP begrenzt, Reload eines bestehenden Raums zählt nicht, andere IP unberührt', async () => {
  const { memoryThrottle } = await import('../../lib/throttle.cjs');
  const { LIMITS } = await import('../../lib/relay-core.mjs');
  let t = 0;
  const store = memoryStore();
  const th = memoryThrottle({ now: () => t });
  const call = client(store, th, '9.9.9.9');
  for (let i = 0; i < LIMITS.roomsPerWindow; i++) {
    assert.equal((await call('host', { room: 'RM' + String(i).padStart(4, '0'), token: HOST })).status, 200);
  }
  const over = await call('host', { room: 'RMOVER', token: HOST });
  assert.equal(over.status, 429);
  assert.equal((await call('host', { room: 'RM0000', token: HOST })).status, 200, 'Reload eigener Raum');
  assert.equal((await client(store, th, '8.8.8.8')('host', { room: 'RMOTHR', token: HOST })).status, 200, 'andere IP');
  t = LIMITS.roomWindowMs + 1;
  assert.equal((await call('host', { room: 'RMOVER', token: HOST })).status, 200, 'nach dem Fenster wieder frei');
});

test('Nachrichten pro Verbindung und pro IP begrenzt (429), Host nie', async () => {
  const { memoryThrottle } = await import('../../lib/throttle.cjs');
  const { LIMITS } = await import('../../lib/relay-core.mjs');
  const th = memoryThrottle({ now: () => 0 });
  const call = client(memoryStore(), th);
  await call('host', { room: 'FLD001', token: HOST });
  const batch = Array.from({ length: 50 }, () => ({ body: { t: 'hb' } }));
  const status = [];
  for (let i = 0; i < 3; i++) status.push((await call('send', { room: 'FLD001', ...P1, msgs: batch })).status);
  assert.deepEqual(status, [200, 200, 429], `${LIMITS.playerMsgsPerWindow} Nachrichten pro Fenster`);
  assert.equal((await call('send', { room: 'FLD001', ...P2, msgs: batch.slice(0, 5) })).status, 200, 'andere Verbindung weiter möglich');
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('send', { room: 'FLD001', as: 'host', token: HOST, msgs: batch })).status, 200, 'Host wird nicht gedrosselt');
  }
  const ip = memoryThrottle({ now: () => 0 });
  const call2 = client(memoryStore(), ip);
  await call2('host', { room: 'FLD002', token: HOST });
  let blocked = false;
  for (let i = 0; i < 20 && !blocked; i++) {
    const c = conn('flooder-key-' + String(i).padStart(12, 'x'));
    blocked = (await call2('send', { room: 'FLD002', ...c, msgs: batch })).status === 429;
  }
  assert.ok(blocked, 'viele Verbindungen derselben IP werden gemeinsam gedrosselt');
});

test('Spieler-Anfragen sind klein, Host darf große Medien-Nachrichten senden', async () => {
  const { LIMITS } = await import('../../lib/relay-core.mjs');
  const call = client(memoryStore());
  await call('host', { room: 'BIG001', token: HOST });
  const big = 'x'.repeat(LIMITS.maxPlayerBodyBytes + 1);
  assert.equal((await call('send', { room: 'BIG001', ...P1, msgs: [{ body: big }] })).status, 413);
  assert.equal((await call('send', { room: 'BIG001', as: 'host', token: HOST, msgs: [{ to: null, body: big }] })).status, 200);
  const huge = 'x'.repeat(LIMITS.maxBodyBytes + 1);
  assert.equal((await call('send', { room: 'BIG001', as: 'host', token: HOST, msgs: [{ to: null, body: huge }] })).status, 413);
});

test('Zeilen pro Raum begrenzt: die ältesten fallen weg, seq läuft weiter', async () => {
  const { MAX_ROOM_MSGS } = await import('../../lib/relay-stores.mjs');
  const store = memoryStore();
  const call = client(store);
  await call('host', { room: 'CAP001', token: HOST });
  const batch = Array.from({ length: 50 }, (_, i) => ({ to: null, body: i }));
  for (let i = 0; i < MAX_ROOM_MSGS / 50 + 4; i++) await call('send', { room: 'CAP001', as: 'host', token: HOST, msgs: batch });
  assert.equal(store._rooms.get('CAP001').msgs.length, MAX_ROOM_MSGS);
  assert.equal(store._rooms.get('CAP001').seq, MAX_ROOM_MSGS + 200);
});

test('Leere und abgelaufene Räume werden früh aufgeräumt', async () => {
  let t = 0;
  const store = memoryStore({ now: () => t });
  const call = client(store);
  await call('host', { room: 'OLD001', token: HOST });  // nie benutzt
  await call('host', { room: 'USED01', token: HOST });
  await call('send', { room: 'USED01', as: 'host', token: HOST, msgs: [{ to: null, body: 1 }] });
  t = 31 * 60_000;
  store.maybeCleanup();
  assert.equal(store._rooms.has('OLD001'), false, 'leerer Raum nach 30 min weg');
  assert.equal(store._rooms.has('USED01'), true);
  t = 13 * 3600_000;
  store.maybeCleanup();
  assert.equal(store._rooms.has('USED01'), false, 'stiller Raum nach 12 h weg');
});
