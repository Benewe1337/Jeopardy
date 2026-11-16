// Statistik nach der Siegerehrung: Ansicht auf Host und TV, Undo/Reload, CSV- und JSON-Export
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv({ JEOP_BUZZ_DELAY_MS: 200, JEOP_BUZZ_WINDOW_MS: 600, JEOP_DD_MS: 300 }); });
test.after(async () => { await env.stop(); });

async function download(page, sel) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
  const chunks = [];
  for await (const c of await dl.createReadStream()) chunks.push(c);
  return { name: dl.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') };
}
const rowCells = (page, scope, name) => page.$$eval(`${scope} tbody tr`, (trs, n) => {
  const tr = trs.find((x) => x.querySelector('th').textContent === n);
  return tr ? [...tr.children].map((c) => c.textContent.trim()) : null;
}, name);

test('Statistik im Einzelmodus: Zahlen, Undo, Reload, Export', async (t) => {
  const evil = '=SUM(1,2)';
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben', evil] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const tv = await joinPlayer(env, code, { viewport: { width: 1280, height: 720 } });
  await tv.click('#tvView');
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 1);
  let cat1; let cat2;

  await t.test('Frage 1: Anna buzzert zuerst und liegt richtig', async () => {
    await host.locator('.cell.val:not(.used)').first().click();
    cat1 = (await host.textContent('#clueMeta')).split(' – ')[0];
    await host.click('#buzzBtn');
    await anna.waitForSelector('#buzzer.live');
    await anna.waitForTimeout(250);
    await anna.click('#buzzer');
    await host.waitForSelector('.jrow.buzzed');
    await host.locator('.jrow').nth(0).locator('.green').click();
    await host.click('#close');
  });

  await t.test('Frage 2: Ben falsch (Undo zählt nicht doppelt), Anna klaut', async () => {
    await host.locator('.cell.val:not(.used)').first().click();
    cat2 = (await host.textContent('#clueMeta')).split(' – ')[0];
    await host.locator('.jrow').nth(1).locator('.red').click();
    await host.click('#undo');
    await host.locator('.jrow').nth(1).locator('.red').click();
    await host.locator('.jrow').nth(0).locator('.green').click();
    await host.click('#close');
  });

  await t.test('Statistik-Ansicht auf Host und TV', async () => {
    await host.click('#finishBtn');
    await host.click('#statsToggle');
    for (const page of [host, tv]) {
      await page.waitForSelector('#statsBox:not([hidden]) .stats-main');
      const a = await rowCells(page, '#statsBox .stats-main', 'Anna');
      // Name, Punkte, Richtig/Falsch, Quote, Geklaut, Siege, Ø, schnellste, Joker, Final
      assert.equal(a[2], '2 / 0');
      assert.equal(a[3], '100 %');
      assert.equal(a[4], '1');
      assert.equal(a[5], '1');
      assert.match(a[6], /\d,\d\d s/);
      const b = await rowCells(page, '#statsBox .stats-main', 'Ben');
      assert.equal(b[2], '0 / 1');
      assert.equal(b[3], '0 %');
      assert.ok((await page.textContent('#statsBox .stats-cats')).includes(cat1));
    }
    assert.equal(await host.isHidden('#podium'), true);
    if (cat1 !== cat2) assert.ok((await tv.textContent('#statsBox .stats-cats')).includes(cat2));
  });

  await t.test('Reload: Statistik bleibt erhalten', async () => {
    await host.reload();
    await host.waitForSelector('#statsBox:not([hidden]) .stats-main');
    assert.equal((await rowCells(host, '#statsBox .stats-main', 'Anna'))[2], '2 / 0');
  });

  await t.test('CSV-Export: gültig, Formel im Namen neutralisiert', async () => {
    const { name, text } = await download(host, '#exportCsv');
    assert.match(name, /^jeopardy-statistik-\d{4}-\d\d-\d\d\.csv$/);
    const lines = text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], 'Typ,Name,Team,Kategorie,Kennzahl,Wert');
    assert.ok(lines.includes('Spieler,Anna,,,Richtig,2'));
    assert.ok(lines.includes('Spieler,Anna,,,Geklaut,1'));
    assert.ok(lines.includes('Spieler,Ben,,,Falsch,1'));
    assert.ok(lines.includes('Spieler,Ben,,,Trefferquote %,0'));
    assert.ok(lines.every((l) => !l.startsWith('Spieler,=')), 'keine Zelle beginnt mit =');
    assert.ok(lines.some((l) => l.startsWith(`Spieler,"'${evil}"`)), lines.join('\n'));
  });

  await t.test('JSON-Export: parsebar', async () => {
    const { name, text } = await download(host, '#exportJson');
    assert.match(name, /\.json$/);
    const j = JSON.parse(text);
    assert.equal(j.mode, 'single');
    const a = j.players.find((p) => p.name === 'Anna');
    assert.equal(a.right, 2);
    assert.equal(a.steals, 1);
    assert.equal(a.reaction.count, 1);
    assert.equal(j.players.find((p) => p.name === evil).name, evil);
  });

  await t.test('Zurück zur Siegerehrung und ins Spiel', async () => {
    await host.click('#statsToggle');
    await tv.waitForSelector('#podium:not([hidden])');
    assert.ok(await tv.isHidden('#statsBox'));
    await host.click('#finishBack');
  });

  assert.deepEqual(env.errors, []);
});

test('Statistik im Team-Modus: Team plus Person für Buzzer-Zeiten', async (t) => {
  const { host, code } = await openHost(env, { mode: 'team', teamSize: 2, names: ['Rot', 'Blau'] });
  const anna = await joinPlayer(env, code, { name: 'Anna', pick: 'Rot' });
  const ben = await joinPlayer(env, code, { name: 'Ben', pick: 'Rot' });
  await host.waitForFunction(() => document.getElementById('players').textContent.includes('Anna, Ben · 2/2'));

  await host.locator('.cell.val:not(.used)').first().click();
  await host.locator('.jrow').nth(1).locator('.red').click(); // Blau falsch
  await ben.waitForSelector('#buzzer.live');
  await ben.waitForTimeout(250);
  await ben.click('#buzzer');
  await host.waitForSelector('.jrow.buzzed');
  await host.locator('.jrow.buzzed .green').click();
  await host.click('#close');
  await anna.waitForFunction(() => [...document.querySelectorAll('#scores .score-value')].length === 2);

  await host.click('#finishBtn');
  await host.click('#statsToggle');
  await t.test('Teams und Personen in der Ansicht', async () => {
    await host.waitForSelector('#statsBox .stats-main');
    const rot = await rowCells(host, '#statsBox .stats-main', 'Rot');
    assert.equal(rot[2], '1 / 0');
    assert.equal(rot[4], '1'); // geklaut
    assert.equal(rot[5], '1'); // Buzzer-Siege
    assert.equal((await rowCells(host, '#statsBox .stats-main', 'Blau'))[2], '0 / 1');
    const p = await rowCells(host, '#statsBox .stats-people', 'Ben');
    assert.equal(p[1], 'Rot');
    assert.equal(p[2], '1');
    assert.match(p[3], /\d,\d\d s/);
  });

  await t.test('Export enthält Personen', async () => {
    const { text } = await download(host, '#exportCsv');
    assert.ok(text.includes('Team,Rot,,,Richtig,1'));
    assert.ok(text.includes('Person,Ben,Rot,,Buzzer-Siege,1'));
    const j = JSON.parse((await download(host, '#exportJson')).text);
    assert.equal(j.mode, 'team');
    assert.equal(j.persons[0].name, 'Ben');
    assert.equal(j.persons[0].team, 'Rot');
  });

  assert.deepEqual(env.errors, []);
});

test('Statistik: Daily Double (Undo zählt nicht doppelt) in Ansicht und Export', async (t) => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  await host.evaluate(() => {
    const s = J.defaultSet();
    s.rounds[0].categories[0].clues[0].dd = true;
    localStorage.setItem('jeopardy.set', JSON.stringify(s));
  });
  await host.reload();
  await host.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online');
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 1);

  await host.locator('.cell.val').nth(0).click();
  await anna.waitForSelector('#ddWagerInput');
  await anna.fill('#ddWagerInput', '100');
  await anna.click('#ddWagerBtn');
  await host.waitForSelector('#ddRight');
  await host.click('#ddRight');
  await host.waitForFunction(() => J.loadState().stats[Object.keys(J.loadState().stats)[0]].dd.won === 1);
  await host.click('#undo');
  await host.waitForFunction(() => Object.values(J.loadState().stats || {}).every((x) => !x.dd));
  await host.click('#ddWrong');
  await host.waitForFunction(() => Object.values(J.loadState().stats).some((x) => x.dd && x.dd.lost === 1));
  await host.click('#close');

  await host.click('#finishBtn');
  await host.click('#statsToggle');
  await host.waitForSelector('#statsBox .stats-main');
  const a = await rowCells(host, '#statsBox .stats-main', 'Anna');
  assert.match(a[9], /Daily Double: 0 ✓ \/ 1 ✗ \(\+0 \/ −100\)/);
  const { text } = await download(host, '#exportCsv');
  assert.ok(text.includes('Spieler,Anna,,,Daily Double gewonnen,0'));
  assert.ok(text.includes('Spieler,Anna,,,Daily Double verloren,1'));
  assert.ok(text.includes('Spieler,Anna,,,Daily Double Punkte verloren,100'));
  const j = JSON.parse((await download(host, '#exportJson')).text);
  assert.deepEqual(j.players.find((p) => p.name === 'Anna').dd, { won: 0, lost: 1, wonPoints: 0, lostPoints: 100 });
  assert.equal(j.players.find((p) => p.name === 'Ben').dd, null);
  assert.deepEqual(env.errors, []);
});
