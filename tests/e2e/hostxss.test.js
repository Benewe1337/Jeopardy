// Sicherheit: Der Host ist nicht vertrauenswürdig. Ein manipulierter Host schickt HTML/Skript in
// Zahlen- und Textfeldern des Spielstands – Spieler und TV dürfen nichts davon ausführen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv(); });
test.after(async () => { await env.stop(); });

const EVIL = '<img src=x onerror=window.__xss=1>';
const xss = (page) => page.evaluate(() => window.__xss);

test('manipulierter Host: kein Skript auf Spieler und TV (Werte, Daily Double, Namen, Team-Felder)', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  await host.evaluate((evil) => {
    // Alles, was der Host an Spieler/TV schickt, wird nach dem Aufbau des Spielstands manipuliert
    const orig = J.publicState;
    J.publicState = (...args) => {
      const s = orig.apply(J, args);
      s.values = s.values.map(() => evil);
      s.teamSize = evil;
      s.players = s.players.map((p) => ({ ...p, score: evil }));
      if (s.current) {
        s.current.value = evil;
        if (s.current.dd) s.current.dd = { ...s.current.dd, min: evil, max: evil };
      }
      return s;
    };
  }, EVIL);
  const player = await joinPlayer(env, code, { pick: 'Anna' });
  const tv = await joinPlayer(env, code, {});
  await tv.click('#tvView');
  // Board kommt mit manipulierten Werten an; es darf nur Text/0 sein
  await host.locator('.cell.val').first().click();
  for (const pg of [player, tv]) {
    await pg.waitForSelector('#overlay.show');
    assert.equal(await pg.locator('#board img, #scores img, #overlay img:not([hidden]), #overlayScores img').count(), 0);
  }
  assert.equal(await player.locator('#board .cell.val').first().textContent(), '0');
  for (const pg of [player, tv]) assert.equal(await xss(pg), undefined);
  assert.deepEqual(env.errors, []);
  for (const pg of [player, tv, host]) await pg.context().close();
});

test('manipulierter Host: Daily-Double-Einsatzfeld bleibt Text', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  const player = await joinPlayer(env, code, { pick: 'Anna' });
  await host.evaluate((evil) => {
    const orig = J.publicState;
    J.publicState = (...args) => {
      const s = orig.apply(J, args);
      if (s.current) {
        s.current.dd = { phase: 'wager', pid: s.players[0].id, min: evil, max: evil, wager: null };
      }
      return s;
    };
  }, EVIL);
  await host.locator('.cell.val').first().click();
  await player.waitForTimeout(800);
  assert.equal(await player.locator('#ddBox img, #ddBody img, #ddStatus img').count(), 0);
  assert.equal(await xss(player), undefined);
  assert.deepEqual(env.errors, []);
  for (const pg of [player, host]) await pg.context().close();
});
