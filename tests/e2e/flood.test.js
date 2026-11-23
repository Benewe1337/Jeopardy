// DoS-Schutz: ein flutender Client wird gedrosselt, das normale Spiel läuft weiter, der Host bleibt ansprechbar.
// Gilt für WebRTC und Relay (beim Relay zusätzlich mit echter Rate-Drosselung auf dem Server).
const test = require('node:test');
const assert = require('node:assert/strict');
const { TRANSPORT, startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv({}, { throttle: true }); });
test.after(async () => { await env.stop(); });

test('Flut von hello/Müll-Nachrichten: Spiel läuft weiter, Host bleibt ansprechbar', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 1);

  // Angreifer: eigene Verbindung zum Host, dann hunderte Nachrichten
  const evil = await env.page();
  const throttled = [];
  evil.on('response', (r) => { if (r.url().includes('api/relay') && r.status() === 429) throttled.push(r.url()); });
  await evil.goto(env.base + '/player.html?room=' + code);
  await evil.waitForSelector('#picker:not([hidden])');
  await evil.evaluate(async (code) => {
    await J.net.ready;
    const peer = J.net.createPeer();
    await new Promise((r) => peer.on('open', r));
    const conn = peer.connect(J.peerId(code), { reliable: true });
    await new Promise((r) => conn.on('open', r));
    window.__evil = { conn, closed: false };
    conn.on('close', () => { window.__evil.closed = true; });
    let n = 0;
    const burst = () => {
      if (n++ > 600 || window.__evil.closed) return;
      for (let i = 0; i < 5; i++) {
        conn.send({ type: 'hello', playerId: 'nobody', deviceId: 'x' + n });
        conn.send({ type: 'junk' + i, data: 'y'.repeat(200) });
        conn.send({ type: 'buzz', id: n, reaction: 300 });
      }
      setTimeout(burst, 5);
    };
    burst();
  }, code);

  // Währenddessen: Host reagiert und ein normaler Spielzug klappt
  const t0 = Date.now();
  assert.equal(await host.evaluate(() => 1 + 1), 2);
  assert.ok(Date.now() - t0 < 3000, 'Host bleibt ansprechbar');
  await host.locator('.cell.val').first().click();
  await anna.waitForSelector('#overlay.show', { timeout: 15000 });

  // Der Angreifer wird verworfen: Verbindung geschlossen (Host) oder, beim Relay, vom Server gedrosselt
  await evil.waitForFunction(() => window.__evil.closed, null, { timeout: 8000 }).catch(() => {});
  const closed = await evil.evaluate(() => window.__evil.closed);
  assert.ok(closed || (TRANSPORT === 'relay' && throttled.length > 0), 'Angreifer geschlossen oder gedrosselt');
  if (TRANSPORT === 'relay') assert.ok(throttled.length > 0, 'Relay antwortet mit 429');

  // Nach der Flut weiter spielbar: Host zeigt Anna weiterhin verbunden, kein Fremd-Platz belegt
  assert.equal(await host.locator('#players .device').count(), 1);
  assert.deepEqual(env.errors, []);
  for (const p of [host, anna, evil]) await p.context().close();
});

test('Raum-Erzeugung pro IP begrenzt (nur Relay)', { skip: TRANSPORT !== 'relay' }, async () => {
  const page = await env.page();
  await page.goto(env.base + '/player.html');
  const codes = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 14; i++) {
      const r = await fetch('api/relay?op=host', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: 'FLOOD' + String(i).padStart(2, '0'), token: 'flood-token-' + 'z'.repeat(20) }) });
      out.push(r.status);
    }
    return out;
  });
  assert.ok(codes.includes(429), 'irgendwann 429: ' + codes);
  await page.context().close();
});
