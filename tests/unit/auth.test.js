// Passwortsperre (middleware.js) für Vercel
const test = require('node:test');
const assert = require('node:assert/strict');

let gate, signSession, verifySession, safeNext, COOKIE, memoryThrottle;
test.before(async () => {
  ({ gate, signSession, verifySession, safeNext, COOKIE } = await import('../../middleware.js'));
  ({ memoryThrottle } = await import('../../lib/throttle.mjs'));
});

const PW = 'geheim';
const req = (path, init) => new Request('https://jeopardy.example' + path, init);

test('Ohne Cookie kommt die Passwortseite', async () => {
  const res = await gate(req('/host.html'), PW);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /type="password"/);
  assert.match(html, /name="next" value="\/host.html"/);
});

test('API ohne Cookie antwortet 401 als JSON', async () => {
  const res = await gate(req('/api/relay?op=ping'), PW);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('Styles und Schriften sind ohne Passwort erreichbar', async () => {
  assert.equal(await gate(req('/css/style.css'), PW), undefined);
  assert.equal(await gate(req('/fonts/x.woff2'), PW), undefined);
});

test('Richtiges Passwort setzt Cookie und leitet weiter', async () => {
  const body = new URLSearchParams({ password: PW, next: '/player.html?room=ABC' });
  const res = await gate(req('/__login', { method: 'POST', body }), PW);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/player.html?room=ABC');
  const cookie = res.headers.get('set-cookie');
  const token = cookie.match(new RegExp(`^${COOKIE}=([^;]+);`))[1];
  assert.equal(await verifySession(token, PW), true);
  assert.ok(!token.includes(PW));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});

test('Falsches Passwort zeigt Fehler, kein Cookie', async () => {
  const body = new URLSearchParams({ password: 'falsch', next: '/' });
  const res = await gate(req('/__login', { method: 'POST', body }), PW);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.match(await res.text(), /Falsches Passwort/);
});

test('Weiterleitung nur auf eigene Seiten', async () => {
  for (const next of ['https://evil.example', '//evil.example', '/\\evil.example']) {
    const body = new URLSearchParams({ password: PW, next });
    const res = await gate(req('/__login', { method: 'POST', body }), PW);
    assert.equal(res.headers.get('location'), '/', next);
  }
});

test('Gültiges Cookie lässt durch, falsches nicht', async () => {
  const good = { headers: { cookie: `a=b; ${COOKIE}=${await signSession(PW)}` } };
  assert.equal(await gate(req('/host.html', good), PW), undefined);
  assert.equal(await gate(req('/api/relay?op=ping', good), PW), undefined);
  const old = { headers: { cookie: `${COOKIE}=${await signSession('altes-passwort')}` } };
  assert.equal((await gate(req('/host.html', old), PW)).status, 200);
});

test('Ohne gesetztes Passwort bleibt alles zu', async () => {
  const res = await gate(req('/'), undefined);
  assert.equal(res.status, 500);
});

test('next-Parameter wird im HTML maskiert', async () => {
  const res = await gate(req('/x"><script>alert(1)</script>'), PW);
  const html = await res.text();
  assert.ok(!html.includes('<script>alert(1)'));
});

test('QR-Beitrittslink: nach dem Login landet der Spieler wieder im Raum', async () => {
  const link = '/player.html?room=ABC123';
  const res = await gate(req(link), PW);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /name="next" value="\/player\.html\?room=ABC123"/);

  const body = new URLSearchParams({ password: PW, next: link });
  const login = await gate(req('/__login', { method: 'POST', body }), PW);
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), link);
  assert.ok(!login.headers.get('location').includes(PW), 'Passwort taucht nie im Link auf');
});

test('Login-Weiterleitung lässt keine fremden Ziele zu', async () => {
  for (const next of ['//evil.example/player.html?room=A', 'https://evil.example/', '/\\evil.example']) {
    const body = new URLSearchParams({ password: PW, next });
    const login = await gate(req('/__login', { method: 'POST', body }), PW);
    assert.equal(login.headers.get('location'), '/');
  }
});

test('Session-Token: signieren, prüfen, Ablauf, Manipulation, falsches Passwort', async () => {
  const t0 = 1_700_000_000_000;
  const token = await signSession(PW, t0);
  assert.match(token, /^v1\.\d+\.\d+\.[0-9a-f]{64}$/);
  assert.equal(await verifySession(token, PW, t0 + 1000), true);
  assert.equal(await verifySession(token, PW, t0 + 29 * 86400_000), true);
  assert.equal(await verifySession(token, PW, t0 + 31 * 86400_000), false, 'abgelaufen');
  assert.equal(await verifySession(token, 'anderes', t0 + 1000), false, 'Passwort geändert');
  const [v, iat, exp, sig] = token.split('.');
  const later = `${v}.${iat}.${Number(exp) + 86400 * 365}.${sig}`;
  assert.equal(await verifySession(later, PW, t0 + 1000), false, 'Ablaufdatum manipuliert');
  assert.equal(await verifySession(`${v}.${iat}.${exp}.${sig.replace(/.$/, sig.endsWith('0') ? '1' : '0')}`, PW, t0 + 1000), false, 'Signatur manipuliert');
  assert.equal(await verifySession(token, PW, t0 - 3600_000), false, 'aus der Zukunft');
  for (const bad of [null, '', 'abc', 'v1.1.2.zz', `${token}x`]) assert.equal(await verifySession(bad, PW, t0), false);
  // altes Cookie-Format (SHA-256 des Passworts) ist ungültig
  const old = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('jeopardy-gate:' + PW)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(await verifySession(old, PW), false);
  assert.equal((await gate(req('/host.html', { headers: { cookie: `${COOKIE}=${old}` } }), PW)).status, 200);
});

test('safeNext: nur schlichte eigene Pfade', () => {
  for (const ok of ['/', '/host.html', '/player.html?room=ABC123', '/a/b-c_d.e~f?x=1&y=%20+z']) assert.equal(safeNext(ok), ok);
  for (const bad of [
    '/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\\evil.example', '//evil.example', '/\\/evil.example',
    '///evil.example', 'https://evil.example', 'evil.example', '/%09/evil.example', '/%2F/evil.example', '/ x', '/a b',
    '/a\u0000b', '/a#frag', '/a?x=<b>', '/a?x=1\n', '/x\n', '', null, undefined, 5, '/a?' + 'b'.repeat(3000),
  ]) assert.equal(safeNext(bad), '/', JSON.stringify(bad));
});

test('Login wird pro IP gedrosselt: Sperre nach 5 Fehlversuchen, richtiges Passwort setzt zurück', async () => {
  let t = 0;
  const throttle = memoryThrottle({ now: () => t });
  const post = (password, ip = '1.1.1.1') => gate(req('/__login', {
    method: 'POST', body: new URLSearchParams({ password, next: '/' }), headers: { 'x-forwarded-for': ip },
  }), PW, throttle);
  for (let i = 0; i < 5; i++) assert.equal((await post('falsch')).status, 401);
  const locked = await post('falsch');
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('retry-after'), '60');
  assert.equal(locked.headers.get('set-cookie'), null);
  assert.equal((await post(PW)).status, 429, 'auch das richtige Passwort wird während der Sperre nicht geprüft');
  assert.equal((await post('falsch', '2.2.2.2')).status, 401, 'andere IP unberührt');
  t = 61_000;
  assert.equal((await post(PW)).status, 303, 'nach der Sperre geht es wieder');
  for (let i = 0; i < 5; i++) await post('falsch');
  assert.equal((await post('falsch')).status, 429, 'Zähler nach Erfolg zurückgesetzt, neue Sperre');
});
