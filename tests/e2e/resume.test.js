// Spiel fortsetzen (nur Relay/Vercel): Spielstand liegt nach jedem Zug auf dem Server, ein neues
// Fenster oder Gerät kann ihn laden und das Spiel übernehmen; das alte Fenster wird zur Ansicht.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TRANSPORT, HOST_PASSWORD, startEnv, openHost, joinPlayer, scoresOf } = require('./helpers');

const skip = TRANSPORT !== 'relay';
let env;
test.before(async () => { if (!skip) env = await startEnv({ JEOP_SYNC_MS: 150, JEOP_BUZZ_DELAY_MS: 150 }); });
test.after(async () => { if (!skip) await env.stop(); });

async function unlock(page, pw = HOST_PASSWORD) {
  await page.waitForSelector('#gameBox:not([hidden])');
  if (await page.isHidden('#gamePw')) await page.click('#gameBox summary');
  await page.fill('#gamePw', pw);
  await page.click('#gamePwForm button');
}

// Nach „Fortsetzen“ lädt die Seite neu: erst auf den fortgesetzten Raum warten, dann auf „online“
const resumed = async (page, code) => {
  await page.waitForFunction((c) => document.getElementById('code').textContent === c && document.getElementById('peerStatus').textContent === 'online',
    code, { timeout: 30000 });
};

const snapshot = (page) => page.evaluate(() => {
  const s = J.loadState();
  return { scores: s.players.map((p) => p.name + ':' + p.score).join(','), ids: s.players.map((p) => p.id).join(), used: JSON.stringify(s.used), turn: s.turn, round: s.round, room: J.roomCode() };
});

// Wartet, bis der Server denselben Stand hat wie dieser Host
const serverCaughtUp = async (page) => {
  const same = () => page.evaluate(async () => {
    try {
      const g = await J.gameSync.get(J.roomCode());
      const l = J.loadState();
      return JSON.stringify(g.state.used) === JSON.stringify(l.used) && g.state.turn === l.turn && !g.state.current === !l.current
        && g.state.players.map((p) => p.score).join() === l.players.map((p) => p.score).join();
    } catch (e) { return false; }
  });
  for (let i = 0; i < 100; i++) {
    if (await same()) return;
    await page.waitForTimeout(150);
  }
  throw new Error('Server hat den Stand nicht übernommen');
};

// Erste freie Zelle spielen: Anna richtig → +100, dann schließen
async function playCell(host, index = 0) {
  await host.locator('.cell.val').nth(index).click();
  await host.locator('.jrow').nth(0).locator('.green').click();
  await host.click('#close');
}

test('Spiel fortsetzen auf einem neuen Gerät: Stand identisch, Spieler verbinden sich selbst', { skip }, async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  await unlock(host);
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  await anna.waitForSelector('#board:not([hidden])');
  await playCell(host, 0);
  await playCell(host, 1);
  await serverCaughtUp(host);
  const before = await snapshot(host);
  assert.match(before.scores, /Anna:\d+/);
  assert.notEqual(before.scores, 'Anna:0,Ben:0');

  await host.context().close(); // Gerät "kaputt"

  await t_resume();
  async function t_resume() {
    const host2 = await env.page();
    await host2.goto(env.base + '/host.html');
    await unlock(host2);
    await host2.waitForSelector(`#gameList [data-room="${code}"] [data-act="resume"]`);
    assert.match(await host2.textContent(`#gameList [data-room="${code}"]`), /Runde 1/);
    await host2.click(`#gameList [data-room="${code}"] [data-act="resume"]`);
    await resumed(host2, code);
    assert.deepEqual(await snapshot(host2), before, 'Punkte, Felder, Runde, Zug und Raumcode identisch');
    await host2.waitForFunction(() => document.getElementById('viewers').textContent === '1 verbunden', null, { timeout: 40000 });
    // Der Stand kommt nach dem Wiederverbinden per Nachricht beim Handy an: darauf warten, nicht einmalig lesen
    const oldScores = before.scores.split(',').map((x) => x.split(':')[1]).join(',');
    await anna.waitForFunction((want) => [...document.querySelectorAll('#scores .score-value')].map((e) => e.textContent).join(',') === want, oldScores);
    assert.equal(await scoresOf(anna), oldScores, 'Spieler sieht die alten Punkte');
    // Spiel geht normal weiter
    await playCell(host2, 2);
    await anna.waitForFunction((n) => document.querySelectorAll('#scores .score-value')[0].textContent !== n, before.scores.split(',')[0].split(':')[1]);
    await host2.context().close();
  }
  await anna.context().close();
  assert.deepEqual(env.errors, []);
});

test('Übernahme bei offenem alten Tab: alter Tab wird zur Ansicht, kein Kampf, Rückholen lädt den neuen Stand', { skip }, async () => {
  const { host: hostA, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  await unlock(hostA);
  await playCell(hostA, 0);
  await serverCaughtUp(hostA);
  const relayHostCalls = [];
  hostA.on('request', (r) => { if (r.url().includes('api/relay?op=host')) relayHostCalls.push(Date.now()); });

  // zweites Gerät übernimmt
  const hostB = await env.page();
  await hostB.goto(env.base + '/host.html');
  await unlock(hostB);
  await hostB.click(`#gameList [data-room="${code}"] [data-act="resume"]`);
  await resumed(hostB, code);
  await playCell(hostB, 3); // B spielt weiter
  await serverCaughtUp(hostB);

  await hostA.waitForSelector('#roOverlay:not([hidden])', { timeout: 30000 });
  assert.equal(await hostA.evaluate(() => document.querySelector('.host-page').inert), true, 'Bedienelemente gesperrt');
  const frozen = await snapshot(hostA);
  await hostA.evaluate(() => document.querySelector('.cell.val:not(.used)')?.click());
  await hostA.waitForTimeout(500);
  assert.deepEqual(await snapshot(hostA), frozen, 'alter Tab ändert nichts mehr');
  assert.equal(await hostA.evaluate(() => J.loadState().current), null);
  // Schließen lässt die Ansicht stehen
  await hostA.click('#roClose');
  assert.ok(await hostA.isVisible('#roBar'));
  const calls = relayHostCalls.length;
  await hostA.waitForTimeout(6000);
  assert.equal(relayHostCalls.length, calls, 'alter Tab versucht den Raum nicht erneut zu übernehmen');
  assert.equal(await hostA.textContent('#saveStatus'), 'Nur Ansicht');

  // Zurückholen: A lädt den neueren Stand von B
  await hostA.click('#roBarTake');
  await hostA.waitForFunction(() => document.getElementById('roBar') && document.getElementById('roBar').hidden && !document.body.classList.contains('readonly')
    && document.getElementById('peerStatus').textContent === 'online', null, { timeout: 30000 });
  assert.deepEqual(await snapshot(hostA), await snapshot(hostB));
  await hostB.waitForSelector('#roOverlay:not([hidden])', { timeout: 30000 });
  await hostA.context().close();
  await hostB.context().close();
  assert.deepEqual(env.errors, []);
});

test('Falsches Passwort: Spiel läuft lokal weiter, keine Sicherung', { skip }, async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  await unlock(host, 'falsch');
  await host.waitForFunction(() => document.getElementById('gamePwMsg').textContent === 'Falsches Passwort.');
  assert.ok(await host.isHidden('#saveStatus'));
  await playCell(host, 0);
  assert.equal(await host.evaluate(() => J.loadState().players[0].score), 100);
  const games = await host.evaluate(async () => {
    const r = await fetch('api/game?op=list', { headers: { 'x-host-password': 'falsch' } });
    return r.status;
  });
  assert.equal(games, 401);
  await host.context().close();
});
