// Passwort-Drosselung (lib/throttle.mjs) und ihre Anbindung an die Host-Passwort-Prüfung
const test = require('node:test');
const assert = require('node:assert/strict');

let memoryThrottle, pgThrottle, clientKey, THROTTLE, checkHostPassword, handleSets, memorySetStore, handleGame, memoryGameStore, handleRelay, memoryStore;
test.before(async () => {
  ({ memoryThrottle, pgThrottle, clientKey, THROTTLE } = await import('../../lib/throttle.mjs'));
  ({ checkHostPassword } = await import('../../lib/host-auth.mjs'));
  ({ handleSets, memorySetStore } = await import('../../lib/sets-core.mjs'));
  ({ handleGame, memoryGameStore } = await import('../../lib/game-core.mjs'));
  ({ handleRelay } = await import('../../lib/relay-core.mjs'));
  ({ memoryStore } = await import('../../lib/relay-stores.mjs'));
});

const PW = 'host-pw';

test('Sperre nach 5 Versuchen, Backoff verdoppelt sich, Erfolg setzt zurück', async () => {
  let t = 0;
  const th = memoryThrottle({ now: () => t });
  for (let i = 0; i < 5; i++) assert.equal((await th.attempt('k')).allowed, true);
  assert.deepEqual(await th.attempt('k'), { allowed: false, retryAfter: 60 });
  t = 30_000;
  assert.deepEqual(await th.attempt('k'), { allowed: false, retryAfter: 30 });
  t = 61_000;
  for (let i = 0; i < 5; i++) assert.equal((await th.attempt('k')).allowed, true);
  assert.deepEqual(await th.attempt('k'), { allowed: false, retryAfter: 120 }, 'zweite Sperre doppelt so lang');
  t += 121_000;
  assert.equal((await th.attempt('k')).allowed, true);
  await th.reset('k');
  for (let i = 0; i < 5; i++) assert.equal((await th.attempt('k')).allowed, true, 'nach reset wieder 5 Versuche');
  assert.equal((await th.attempt('k')).retryAfter, 60, 'Stufe wurde zurückgesetzt');
});

test('Zähler läuft nach dem Zeitfenster ab, Schlüssel sind unabhängig', async () => {
  let t = 0;
  const th = memoryThrottle({ now: () => t });
  for (let i = 0; i < 5; i++) await th.attempt('a');
  t = THROTTLE.windowMs + 1;
  for (let i = 0; i < 5; i++) assert.equal((await th.attempt('a')).allowed, true);
  assert.equal((await th.attempt('b')).allowed, true);
});

test('Backoff ist begrenzt (max. 15 Minuten)', async () => {
  let t = 0;
  const th = memoryThrottle({ now: () => t });
  let last;
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < 6; i++) last = await th.attempt('k');
    t += (last.retryAfter + 1) * 1000;
  }
  assert.ok(last.retryAfter <= 900);
});

test('clientKey: pseudonymisiert, pro Scope, IP aus x-real-ip / x-forwarded-for', async () => {
  const h = (o) => new Headers(o);
  const a = await clientKey('host', h({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }));
  assert.match(a, /^host:[0-9a-f]{32}$/);
  assert.ok(!a.includes('9.9.9.9'));
  assert.equal(a, await clientKey('host', h({ 'x-real-ip': '9.9.9.9' })));
  assert.notEqual(a, await clientKey('site', h({ 'x-real-ip': '9.9.9.9' })));
  assert.notEqual(a, await clientKey('host', h({ 'x-real-ip': '9.9.9.8' })));
});

test('checkHostPassword: 429 nach 5 falschen, leerer Header zählt nicht, richtiges Passwort setzt zurück', async () => {
  const th = memoryThrottle();
  const hd = (pw) => new Headers({ 'x-host-password': pw, 'x-real-ip': '3.3.3.3' });
  for (let i = 0; i < 20; i++) assert.equal((await checkHostPassword(new Headers({ 'x-real-ip': '3.3.3.3' }), PW, th)).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await checkHostPassword(hd('falsch'), PW, th)).status, 401);
  const r = await checkHostPassword(hd('falsch'), PW, th);
  assert.equal(r.status, 429);
  assert.ok(r.retryAfter > 0);
  assert.equal((await checkHostPassword(hd(PW), PW, th)).status, 429, 'auch das richtige während der Sperre');
  const ok = memoryThrottle();
  for (let i = 0; i < 4; i++) await checkHostPassword(hd('falsch'), PW, ok);
  assert.equal((await checkHostPassword(hd(PW), PW, ok)).ok, true);
  for (let i = 0; i < 5; i++) assert.equal((await checkHostPassword(hd('falsch'), PW, ok)).status, 401);
});

test('Sets, Spiel und Relay-Takeover: 429 mit Retry-After', async () => {
  const th = memoryThrottle();
  const headers = () => new Headers({ 'x-host-password': 'falsch', 'x-real-ip': '4.4.4.4' });
  const sets = () => handleSets({ method: 'GET', query: new URLSearchParams({ op: 'check' }), headers: headers(), rawBody: '' }, memorySetStore(), PW, th);
  const game = () => handleGame({ method: 'GET', query: new URLSearchParams({ op: 'check' }), headers: headers(), rawBody: '' }, memoryGameStore(), PW, th);
  const store = memoryStore();
  await handleRelay({ method: 'POST', query: new URLSearchParams({ op: 'host' }), rawBody: JSON.stringify({ room: 'ABC234', token: 'hosttoken-aaaaaaaa' }), headers: new Headers() }, store, PW, th);
  const takeover = () => handleRelay({
    method: 'POST', query: new URLSearchParams({ op: 'host' }),
    rawBody: JSON.stringify({ room: 'ABC234', token: 'hosttoken-bbbbbbbb', takeover: true }), headers: headers(),
  }, store, PW, th);
  // gemeinsamer Zähler pro IP über alle drei Endpunkte
  for (const f of [sets, game, takeover, sets, game]) assert.equal((await f()).status, 401);
  for (const f of [sets, game, takeover]) {
    const res = await f();
    assert.equal(res.status, 429);
    assert.equal(res.json.error, 'too many attempts');
    assert.ok(Number(res.headers['retry-after']) > 0);
  }
  const good = await handleSets({ method: 'GET', query: new URLSearchParams({ op: 'check' }), headers: new Headers({ 'x-host-password': PW, 'x-real-ip': '5.5.5.5' }), rawBody: '' }, memorySetStore(), PW, th);
  assert.equal(good.status, 200, 'andere IP unberührt');
});

test('pgThrottle: Schema lazy, Parameter statt Werte, Sperre aus Antwortzeile', async () => {
  const calls = [];
  const th = pgThrottle(async (text, params) => {
    calls.push({ text, params });
    return text.startsWith('INSERT') ? [{ retry: calls.filter((c) => c.text.startsWith('INSERT')).length > 5 ? '60' : '0' }] : [];
  });
  assert.equal(calls.length, 0);
  for (let i = 0; i < 5; i++) assert.equal((await th.attempt('host:abc')).allowed, true);
  assert.deepEqual(await th.attempt('host:abc'), { allowed: false, retryAfter: 60 });
  await th.reset('host:abc');
  assert.equal(calls.filter((c) => c.text.startsWith('CREATE TABLE IF NOT EXISTS jeop_throttle')).length, 1);
  assert.ok(calls.every((c) => !c.text.includes('host:abc')));
});

test('hit(): Zähler pro Fenster mit Gewicht, kein Lockout', async () => {
  let t = 0;
  const th = memoryThrottle({ now: () => t });
  assert.equal((await th.hit('k', { limit: 10, windowMs: 1000, weight: 6 })).allowed, true);
  assert.equal((await th.hit('k', { limit: 10, windowMs: 1000, weight: 4 })).allowed, true);
  const over = await th.hit('k', { limit: 10, windowMs: 1000 });
  assert.equal(over.allowed, false);
  assert.equal(over.retryAfter, 1);
  t = 1000;
  assert.equal((await th.hit('k', { limit: 10, windowMs: 1000 })).allowed, true, 'neues Fenster');
});
