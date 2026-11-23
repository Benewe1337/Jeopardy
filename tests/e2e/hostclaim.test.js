// Relay: Raum-Übernahme nur mit Host-Geheimnis oder Host-Passwort; Login-Sperre über echtes HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TRANSPORT, HOST_PASSWORD, startEnv, openHost } = require('./helpers');

const skip = TRANSPORT !== 'relay';
let env;
test.before(async () => { if (!skip) env = await startEnv(); });
test.after(async () => { if (!skip) await env.stop(); });

const STRANGER = 'stranger-token-0123456789';
const relay = (page, op, body, headers = {}) => page.evaluate(async ([op, body, headers]) => {
  const r = await fetch('api/relay?op=' + op, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return r.status;
}, [op, body, headers]);

test('Fremder mit Raumcode kommt nie an einen stillen Raum, der Host kehrt per Reload zurück', { skip }, async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  const token = await host.evaluate((c) => localStorage.getItem('jeopardy.hostToken.' + c), code);
  assert.ok(token && token.length >= 32, 'Host-Geheimnis liegt pro Raum im eigenen Speicher');
  const link = await host.evaluate(() => document.documentElement.outerHTML);
  assert.ok(!link.includes(token), 'Geheimnis steht nicht in der Seite (Link/QR)');

  // Zweite, fremde Seite (ohne das Geheimnis) – nur Raumcode bekannt
  const other = await env.page();
  await other.goto(env.base + '/player.html');
  // Host-Seite ruhig stellen: Reload, während der Fremde versucht zu übernehmen
  assert.equal(await relay(other, 'host', { room: code, token: STRANGER }), 409);
  assert.equal(await relay(other, 'host', { room: code, token: STRANGER, takeover: true }), 401, 'ohne Host-Passwort');
  assert.equal(await relay(other, 'host', { room: code, token: STRANGER, takeover: true }, { 'x-host-password': 'falsch' }), 401);
  assert.equal(await relay(other, 'poll', { room: code, as: 'host', token: STRANGER, after: 0 }), 403);

  await host.reload();
  await host.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online');
  assert.equal(await host.textContent('#code'), code, 'gleicher Raum nach Reload');
  assert.equal(await host.evaluate((c) => localStorage.getItem('jeopardy.hostToken.' + c), code), token, 'gleiches Geheimnis');
  assert.equal(await relay(other, 'host', { room: code, token: STRANGER }), 409, 'Fremder weiterhin draußen');
  await host.context().close();
  await other.context().close();
});

test('Übernahme mit Host-Passwort klappt, das alte Fenster zeigt „Raum wurde übernommen“', { skip }, async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  const other = await env.page();
  await other.goto(env.base + '/player.html');
  assert.equal(await relay(other, 'host', { room: code, token: STRANGER, takeover: true }, { 'x-host-password': HOST_PASSWORD }), 200);
  await host.waitForSelector('#roOverlay:not([hidden])', { timeout: 20000 });
  assert.match(await host.textContent('#roTitle'), /Raum wurde übernommen/);
  await host.context().close();
  await other.context().close();
});

test('Login: richtiges Passwort geht, nach 5 Fehlversuchen kommt 429 mit Retry-After', async () => {
  const { gate, verifySession, COOKIE } = await import('../../middleware.js');
  const { memoryThrottle } = await import('../../lib/throttle.mjs');
  const throttle = memoryThrottle();
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request('http://localhost' + req.url, {
      method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    });
    const out = (await gate(request, 'site-pw', throttle)) || new Response('durchgelassen');
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(await out.text());
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = (password) => fetch(base + '/__login', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ password, next: '/host.html' }),
  });
  try {
    const ok = await login('site-pw');
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/host.html');
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal(await verifySession(cookie.slice(COOKIE.length + 1), 'site-pw'), true);
    assert.equal(await (await fetch(base + '/host.html', { headers: { cookie } })).text(), 'durchgelassen');
    assert.match(await (await fetch(base + '/host.html')).text(), /type="password"/);

    for (let i = 0; i < 5; i++) assert.equal((await login('falsch')).status, 401);
    const locked = await login('site-pw');
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});
