// Sicherheit: HTML in Namen, Kategorien und Fragen wird überall nur als Text angezeigt
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv(); });
test.after(async () => { await env.stop(); });

const EVIL = '<img src=x onerror=window.__xss=1>';
const xss = (page) => page.evaluate(() => window.__xss);

test('HTML in Spielername, Kategorie und Frage bleibt Text (Host, Spieler, TV)', async (t) => {
  const { host, code } = await openHost(env, { names: [EVIL, 'Anna'] });
  await host.evaluate((evil) => {
    const s = J.loadSet();
    s.rounds[0].categories[0].name = evil;
    s.rounds[0].categories[0].clues[0] = { q: evil, a: evil, img: '', note: evil };
    J.saveSet(s);
  }, EVIL);
  await host.reload();
  await host.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online');

  const player = await joinPlayer(env, code, { pick: 'Anna' });
  const tv = await joinPlayer(env, code, {});
  await tv.click('#tvView');
  const views = [host, player, tv];
  await player.waitForFunction((e) => document.querySelector('#board').textContent.includes(e), EVIL);
  await tv.waitForFunction((e) => document.querySelector('#board').textContent.includes(e), EVIL);

  await t.test('Namen und Kategorie erscheinen als Text', async () => {
    for (const pg of [player, tv]) {
      await pg.waitForFunction((e) => document.getElementById('scores').textContent.includes(e), EVIL);
      assert.equal(await pg.locator('#scores img').count(), 0);
    }
    assert.equal(await host.locator('#players .pname').first().textContent(), EVIL);
    for (const pg of [player, tv]) assert.equal(await pg.locator('#board img').count(), 0);
    assert.equal(await host.locator('#players img, #board img').count(), 0);
  });

  await t.test('Frage und „am Zug“-Banner bleiben Text', async () => {
    await player.waitForFunction(() => document.getElementById('turnBanner').textContent.includes('wählt'));
    assert.equal(await player.locator('#turnBanner img').count(), 0);
    await host.locator('.cell.val').first().click();
    for (const pg of [player, tv]) {
      await pg.waitForSelector('#overlay.show');
      assert.equal(await pg.textContent('#q'), EVIL);
      assert.equal(await pg.locator('#overlay img:not([hidden])').count(), 0);
    }
    assert.equal(await host.textContent('#clueA'), EVIL);
    assert.equal(await host.textContent('#clueNote'), EVIL);
    await host.locator('.jrow').nth(0).locator('.green').click();
    await host.waitForSelector('#log div');
    assert.equal(await host.locator('#log img, #judge img').count(), 0);
  });

  await t.test('Nirgends wurde Skript ausgeführt', async () => {
    for (const pg of views) assert.equal(await xss(pg), undefined);
    assert.deepEqual(env.errors, []);
  });
  for (const pg of views) await pg.context().close();
});
