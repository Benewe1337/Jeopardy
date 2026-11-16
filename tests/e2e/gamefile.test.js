// Spielstand als Datei exportieren/importieren (beide Transporte): Stand und Spieleransicht danach identisch
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startEnv, openHost, joinPlayer, scoresOf } = require('./helpers');

let env;
test.before(async () => { env = await startEnv({ JEOP_SYNC_MS: 150, JEOP_BUZZ_DELAY_MS: 150 }); });
test.after(async () => { await env.stop(); });

const stateOf = (page) => page.evaluate(() => JSON.stringify({ s: J.loadState(), room: J.roomCode() }));
const online = (page) => page.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online', null, { timeout: 30000 });

async function playCell(host, index) {
  await host.locator('.cell.val').nth(index).click();
  await host.locator('.jrow').nth(0).locator('.green').click();
  await host.click('#close');
}

async function exportFile(host, dir) {
  const [dl] = await Promise.all([host.waitForEvent('download'), host.click('#exportGame')]);
  assert.match(dl.suggestedFilename(), /^jeopardy-[A-Z0-9]+-\d{8}-\d{4}\.json$/);
  const path = `${dir}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  return path;
}

test('Export mitten im Spiel, Zurücksetzen, Import: Stand und Spieleransicht identisch', async (t) => {
  const dir = fs.mkdtempSync(require('node:os').tmpdir() + '/jeop-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  await anna.waitForSelector('#board:not([hidden])');
  await playCell(host, 0);
  await playCell(host, 1);
  await host.waitForFunction(() => J.loadState().players[0].score === 200);
  const before = await stateOf(host);
  const playerBefore = await scoresOf(anna);
  const file = await exportFile(host, dir);

  await host.click('#resetGame'); // Dialog wird automatisch bestätigt
  await host.waitForFunction(() => JSON.parse(JSON.stringify(J.loadState())).players.every((p) => p.score === 0));
  assert.notEqual(await stateOf(host), before);

  await host.setInputFiles('#importFile', file);
  await host.waitForFunction(() => document.getElementById('fileMsg').textContent.includes('lädt neu'));
  await host.waitForLoadState('load');
  await online(host);
  await host.waitForFunction((c) => document.getElementById('code').textContent === c, code);

  const after = JSON.parse(await stateOf(host));
  const was = JSON.parse(before);
  assert.deepEqual(after.s.used, was.s.used);
  assert.deepEqual(after.s.players, was.s.players);
  assert.equal(after.s.turn, was.s.turn);
  assert.equal(after.s.round, was.s.round);
  assert.equal(after.room, was.room);
  // Spieler hängt sich von selbst wieder an und sieht dieselben Punkte
  await anna.waitForFunction(() => !document.getElementById('board').hidden, null, { timeout: 30000 });
  await anna.waitForFunction((s) => [...document.querySelectorAll('#scores .score-value')].map((e) => e.textContent).join(',') === s, playerBefore, { timeout: 30000 });
});

test('Ungültige und fremde Dateien: Fehlermeldung, Stand unverändert', async (t) => {
  const dir = fs.mkdtempSync(require('node:os').tmpdir() + '/jeop-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { host } = await openHost(env, { names: ['Anna'] });
  await playCell(host, 0);
  const before = await stateOf(host);
  const cases = [
    ['kaputt.json', '{nope', /kein gültiges JSON/],
    ['set.json', JSON.stringify({ title: 'x', rounds: [] }), /keine Jeopardy-Spielstand/],
    ['neu.json', JSON.stringify({ format: 'jeopardy-game', v: 99, state: {} }), /neueren Version/],
  ];
  for (const [name, body, re] of cases) {
    await host.setInputFiles('#importFile', { name, mimeType: 'application/json', buffer: Buffer.from(body) });
    await host.waitForFunction((src) => new RegExp(src).test(document.getElementById('fileMsg').textContent), re.source);
    assert.match(await host.textContent('#fileMsg'), re);
  }
  // zu große Datei (> 8 MB)
  await host.setInputFiles('#importFile', { name: 'gross.json', mimeType: 'application/json', buffer: Buffer.alloc(8_100_000, 32) });
  await host.waitForFunction(() => /zu groß/.test(document.getElementById('fileMsg').textContent));
  assert.equal(await stateOf(host), before);
});

test('Import überschreibt ein laufendes Spiel nur nach Bestätigung', async (t) => {
  const dir = fs.mkdtempSync(require('node:os').tmpdir() + '/jeop-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { host } = await openHost(env, { names: ['Anna'] });
  const file = await exportFile(host, dir);
  await playCell(host, 0);
  const before = await stateOf(host);
  host.removeAllListeners('dialog');
  let msg = '';
  host.once('dialog', (d) => { msg = d.message(); d.dismiss(); });
  await host.setInputFiles('#importFile', file);
  await host.waitForFunction(() => /abgebrochen/.test(document.getElementById('fileMsg').textContent));
  assert.match(msg, /überschrieben/);
  assert.equal(await stateOf(host), before);
});
