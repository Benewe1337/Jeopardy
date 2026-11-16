// Daily Double: Ablauf mit Einzelspielern + TV, Team-Modus, Joker-Einschränkungen, Spezialfrage, Zufallsoption, Editor
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv({ JEOP_DD_MS: 400, JEOP_BUZZ_DELAY_MS: 100 }); });
test.after(async () => { await env.stop(); });

// Feld (Kategorie c, Reihe row) in Runde 1 = Zelle row*6+c im Board
const cellIdx = (c, row) => row * 6 + c;

async function useSet(host, edit) {
  await host.evaluate((src) => {
    const s = J.defaultSet();
    // eslint-disable-next-line no-new-func
    new Function('s', src)(s);
    localStorage.setItem('jeopardy.set', JSON.stringify(s));
  }, edit);
  await host.reload();
  await host.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online');
}
async function setScore(host, i, v) {
  await host.locator('.pscore').nth(i).fill(String(v));
  await host.locator('.pscore').nth(i).blur();
  await host.waitForFunction(([i, v]) => document.querySelectorAll('.pscore')[i].value === String(v), [i, v]);
}
const hostScores = (host) => host.$$eval('.pscore', (els) => els.map((e) => e.value).join(','));
const text = (page, sel) => page.evaluate((s) => document.querySelector(s).innerText, sel);
const sendRaw = (page, msg) => page.evaluate((m) => J.playerApi.conn().send(m), msg);

test('Daily Double im Einzelmodus: Animation für alle, nur Anfänger setzt, kein Buzzer/Klauen, voller Abzug ins Minus', async (t) => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  await useSet(host, 's.rounds[0].categories[0].clues[2].dd = true; s.rounds[0].categories[1].clues[3].dd = true; s.rounds[0].categories[0].clues[2].q = "DDFRAGE300";');
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  const tv = await joinPlayer(env, code, { viewport: { width: 1280, height: 720 } });
  await tv.click('#tvView');
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  await setScore(host, 0, 100);

  await t.test('Vor dem Öffnen: Host sieht die Markierung, Spieler und TV nicht', async () => {
    assert.equal(await host.locator('.cell.val.dd').count(), 2);
    for (const p of [anna, ben, tv]) {
      assert.equal(await p.locator('.cell.val.dd').count(), 0);
      const pub = await p.evaluate(() => JSON.stringify(J.playerApi.last()));
      assert.ok(!/"dd"|Daily/.test(pub));
    }
  });

  await t.test('Öffnen: Animation für alle, danach setzt nur Anna (am Zug)', async () => {
    await host.locator('.cell.val').nth(cellIdx(0, 2)).click();
    for (const p of [anna, ben, tv]) {
      await p.waitForSelector('#ddBox.show');
      assert.match(await text(p, '#ddTitle'), /Daily Double/i);
    }
    for (const p of [anna, ben, tv]) {
      await p.waitForFunction(() => document.getElementById('ddSub').textContent.includes('setzt'));
    }
    await anna.waitForSelector('#ddWagerInput');
    assert.equal(await ben.locator('#ddWagerInput').count(), 0);
    assert.equal(await tv.locator('#ddWagerInput').count(), 0);
    assert.equal(await anna.getAttribute('#ddWagerInput', 'max'), '500', 'max(100, Rundenmaximum 500)');
    assert.equal(await anna.getAttribute('#ddWagerInput', 'min'), '5');
    for (const p of [ben, tv, anna]) {
      assert.ok(!(await p.content()).includes('DDFRAGE300') || !(await p.locator('#q').textContent()), 'Frage noch verborgen');
      assert.equal(await p.locator('#q').textContent(), '');
    }
  });

  await t.test('Ungültige Einsätze (Handy und roh gesendet) werden abgelehnt, fremde Einsätze ignoriert', async () => {
    for (const v of ['4', '501', '0', '']) {
      await anna.fill('#ddWagerInput', v);
      await anna.click('#ddWagerBtn');
      await anna.waitForSelector('#ddWagerInput.invalid');
    }
    await sendRaw(anna, { type: 'ddwager', value: 2 });      // zu klein, am Host geprüft
    await sendRaw(anna, { type: 'ddwager', value: 99999 });  // zu groß
    await sendRaw(ben, { type: 'ddwager', value: 50 });      // Ben ist nicht dran
    await anna.waitForTimeout(500);
    assert.equal(await host.evaluate(() => J.loadState().current.dd.phase), 'wager');
    // Host-Eingabe prüft ebenfalls
    await host.fill('#ddHostWager', '3');
    await host.click('#ddHostForm button');
    await host.waitForSelector('#ddHostWager.invalid');
    assert.equal(await host.evaluate(() => J.loadState().current.dd.phase), 'wager');
  });

  await t.test('Einsatz 500: Frage nur jetzt sichtbar, kein Buzzer, Joker-Einschränkungen', async () => {
    await anna.fill('#ddWagerInput', '500');
    await anna.click('#ddWagerBtn');
    for (const p of [anna, ben, tv]) {
      await p.waitForFunction(() => document.getElementById('q').textContent === 'DDFRAGE300');
      assert.equal(await p.locator('#ddBox.show').count(), 0);
      assert.match(await text(p, '#meta'), /daily double.*einsatz 500/i);
    }
    assert.ok(await ben.isHidden('#buzzer'), 'kein Buzzer für Ben');
    assert.ok(await anna.isHidden('#buzzer'), 'auch Anna braucht keinen');
    await host.waitForSelector('#ddRight');
    assert.match(await host.textContent('#ddRight'), /\+500/);
    assert.match(await host.textContent('#ddWrong'), /−500/);
    assert.ok(await host.isHidden('#buzzBtn'));
    // Joker: Doppelt und Weitergeben gesperrt (mit Grund), Tipp erlaubt
    await anna.waitForSelector('.joker[data-kind="hint"]:not([disabled])');
    assert.ok(await anna.locator('.joker[data-kind="double"]').isDisabled());
    assert.match(await anna.getAttribute('.joker[data-kind="double"]', 'title'), /Daily Double/);
    assert.ok(await anna.locator('.joker[data-kind="pass"]').isDisabled());
    assert.match(await anna.getAttribute('.joker[data-kind="pass"]', 'title'), /Daily Double/);
    assert.match(await text(anna, '.joker-reason'), /gesperrt/);
    // Host erzwingt es auch bei rohen Nachrichten
    await sendRaw(anna, { type: 'joker', kind: 'double' });
    await sendRaw(anna, { type: 'joker', kind: 'pass', target: 'b' });
    await sendRaw(ben, { type: 'joker', kind: 'hint' });
    await anna.waitForTimeout(500);
    assert.ok(await host.isHidden('#jokerStatus'));
    assert.equal(await host.evaluate(() => JSON.stringify(J.loadState().current.jokers || {})), '{}');
  });

  await t.test('✗: voller Einsatz ab, Punktestand wird negativ, Frage ist vorbei (kein Klauen)', async () => {
    await host.click('#ddWrong');
    await host.waitForFunction(() => document.querySelector('.pscore').value === '-400');
    assert.equal(await hostScores(host), '-400,0');
    await ben.waitForTimeout(400);
    assert.ok(await ben.isHidden('#buzzer'), 'Buzzer bleibt zu');
    assert.equal(await host.evaluate(() => { const b = J.loadState().current.buzz; return b.open || !!b.arming; }), false);
    await tv.waitForFunction(() => document.getElementById('a').textContent !== '');
    await host.click('#close');
    await host.waitForFunction(() => document.querySelector('.cell.val.used'));
    // Ben ist jetzt am Zug
    assert.equal(await host.evaluate(() => J.loadState().turn !== null), true);
  });

  await t.test('Zweites Daily Double: Ben mit Tipp, richtig → +Einsatz', async () => {
    await host.locator('.cell.val').nth(cellIdx(1, 3)).click();
    await ben.waitForSelector('#ddWagerInput');
    assert.equal(await anna.locator('#ddWagerInput').count(), 0);
    await ben.fill('#ddWagerInput', '50');
    await ben.click('#ddWagerBtn');
    await ben.waitForSelector('.joker[data-kind="hint"]:not([disabled])');
    await ben.click('.joker[data-kind="hint"]');
    await ben.click('.joker[data-kind="hint"]');
    await host.waitForSelector('#jokerStatus:not([hidden])');
    assert.match(await host.textContent('#jokerStatus'), /Tipp/);
    await host.click('#ddRight');
    await host.waitForFunction(() => document.querySelectorAll('.pscore')[1].value === '50');
    assert.equal(await hostScores(host), '-400,50');
    await host.click('#undo');
    await host.waitForFunction(() => document.querySelectorAll('.pscore')[1].value === '0');
    await host.click('#ddRight'); // wieder da
    await host.waitForFunction(() => document.querySelectorAll('.pscore')[1].value === '50');
  });
  assert.deepEqual(env.errors, []);
});

test('Daily Double im Team-Modus: nur das Team am Zug setzt, ein Team-Einsatz zählt', async (t) => {
  const { host, code } = await openHost(env, { mode: 'team', teamSize: 2, names: ['Rot', 'Blau'] });
  await useSet(host, 's.rounds[0].categories[2].clues[1].dd = true;');
  const anna = await joinPlayer(env, code, { name: 'Anna', pick: 'Rot' });
  const ben = await joinPlayer(env, code, { name: 'Ben', pick: 'Rot' });
  const cem = await joinPlayer(env, code, { name: 'Cem', pick: 'Blau' });
  await host.waitForFunction(() => document.getElementById('players').textContent.includes('Anna, Ben'));
  await setScore(host, 0, 800);
  await host.locator('.cell.val').nth(cellIdx(2, 1)).click();
  await t.test('Team Rot (am Zug) setzt, Blau sieht nur Wartetext; max = Punktestand 800', async () => {
    for (const p of [anna, ben, cem]) await p.waitForSelector('#ddBox.show');
    await anna.waitForSelector('#ddWagerInput');
    await ben.waitForSelector('#ddWagerInput');
    assert.equal(await cem.locator('#ddWagerInput').count(), 0);
    assert.equal(await anna.getAttribute('#ddWagerInput', 'max'), '800');
    await sendRaw(cem, { type: 'ddwager', value: 100 }); // anderes Team: ignoriert
    await ben.fill('#ddWagerInput', '801');
    await ben.click('#ddWagerBtn');
    await ben.waitForSelector('#ddWagerInput.invalid');
    await ben.fill('#ddWagerInput', '800');
    await ben.click('#ddWagerBtn');
    for (const p of [anna, ben, cem]) await p.waitForFunction(() => document.getElementById('q').textContent !== '' && !document.getElementById('ddBox').classList.contains('show'));
    assert.ok(await cem.isHidden('#buzzer'));
    assert.ok(await anna.locator('.joker[data-kind="double"]').isDisabled());
    assert.ok(await anna.locator('.joker[data-kind="pass"]').isDisabled());
    assert.ok(await cem.locator('.joker[data-kind="hint"]').isDisabled(), 'Blau kann keinen Tipp setzen');
  });
  await t.test('✓: Team Rot +800', async () => {
    await host.click('#ddRight');
    await host.waitForFunction(() => document.querySelector('.pscore').value === '1600');
    assert.equal(await hostScores(host), '1600,0');
  });
  assert.deepEqual(env.errors, []);
});

test('Daily Double ohne Spieler am Zug: Host wählt wer spielt; Spezialfrage (Multiple Choice) wird gewertet', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  await useSet(host, 'Object.assign(s.rounds[0].categories[3].clues[0], { dd: true, kind: "choice", q: "Welche?", a: "Richtig | Falsch eins | Falsch zwei | Falsch drei" });');
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  await host.locator('.turn-btn.on').click(); // Niemand am Zug
  await host.waitForFunction(() => J.loadState().turn === null);
  await host.locator('.cell.val').nth(cellIdx(3, 0)).click();
  for (const p of [anna, ben]) await p.waitForSelector('#ddBox.show');
  await host.waitForSelector('#ddPanel [data-pick]');
  assert.match(await host.textContent('#ddPanel'), /wer spielt/);
  for (const p of [anna, ben]) assert.equal(await p.locator('#ddWagerInput').count(), 0);
  await host.click('#ddPanel [data-pick]:text-is("Ben")');
  await ben.waitForSelector('#ddWagerInput');
  assert.equal(await anna.locator('#ddWagerInput').count(), 0);
  // Host trägt den Einsatz selbst ein
  await host.fill('#ddHostWager', '250');
  await host.click('#ddHostForm button');
  for (const p of [anna, ben]) await p.waitForSelector('.mc-opt');
  assert.equal(await anna.locator('.mc-opt').first().isDisabled(), true, 'Anna darf nicht antworten');
  assert.equal(await ben.locator('.mc-opt').first().isDisabled(), false);
  await ben.click('.mc-opt:has-text("Richtig")');
  await host.waitForFunction(() => document.getElementById('special').textContent.includes('1/1'));
  assert.ok(!(await host.textContent('#special')).includes('Anna'), 'nur der DD-Spieler in der Übersicht');
  await sendRaw(anna, { type: 'choice', pick: 0 }); // Anna ist nicht dran → ignoriert
  await host.click('#resolveBtn');
  await host.waitForFunction(() => document.querySelectorAll('.pscore')[1].value === '250');
  assert.equal(await hostScores(host), '0,250');
  await ben.waitForSelector('.mc-opt.right');
  assert.deepEqual(env.errors, []);
});

test('Zufällige Daily Doubles: 1 in Runde 1, 2 in Runde 2, nie erste Reihe; Host-Schalter', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  await useSet(host, 's.rounds[0].categories[5].clues[4].dd = true;'); // markiert, wird vom Zufall ersetzt
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 1);
  assert.equal(await host.isChecked('#ddRandom'), false);
  assert.equal(await host.locator('.cell.val.dd').count(), 1);
  await host.check('#ddRandom');
  await host.waitForFunction(() => J.loadState().ddAuto[0] && J.loadState().ddAuto[0].length === 1);
  const picked = await host.evaluate(() => J.loadState().ddAuto[0][0]);
  assert.ok(picked.row >= 1, 'nie erste Reihe');
  assert.equal(await host.locator('.cell.val.dd').count(), 1);
  await host.waitForSelector(`.cell.val.dd >> nth=0`);
  assert.equal(await host.locator('.cell.val').nth(cellIdx(picked.cat, picked.row)).getAttribute('class').then((c) => c.includes('dd')), true);
  // Spieler sehen nichts
  assert.equal(await anna.locator('.cell.val.dd').count(), 0);
  // Normales Feld (erste Reihe) öffnet ohne Animation
  await host.locator('.cell.val').nth(cellIdx(0, 0)).click();
  await anna.waitForSelector('#overlay.show');
  assert.equal(await anna.locator('#ddBox.show').count(), 0);
  await host.click('#cancel');
  // Das Zufallsfeld ist ein Daily Double
  await host.locator('.cell.val').nth(cellIdx(picked.cat, picked.row)).click();
  await anna.waitForSelector('#ddBox.show');
  await host.click('#cancel');
  // Runde 2: zwei Felder in verschiedenen Kategorien, ebenfalls nicht in Reihe 1
  await host.click('#r1');
  await host.waitForFunction(() => J.loadState().ddAuto[1] && J.loadState().ddAuto[1].length === 2);
  const r2 = await host.evaluate(() => J.loadState().ddAuto[1]);
  assert.ok(r2.every((c) => c.row >= 1));
  assert.notEqual(r2[0].cat, r2[1].cat);
  assert.equal(await host.locator('.cell.val.dd').count(), 2);
  // Ausschalten: wieder nur die im Set markierten (Runde 1)
  await host.click('#r0');
  await host.uncheck('#ddRandom');
  await host.waitForFunction(() => document.querySelectorAll('.cell.val.dd').length === 1);
  assert.equal(await host.locator('.cell.val').nth(cellIdx(5, 4)).getAttribute('class').then((c) => c.includes('dd')), true);
  assert.deepEqual(env.errors, []);
});

test('Editor: Daily Double markieren und Zufallsoption speichern', async () => {
  const page = await env.page();
  await page.goto(env.base + '/editor.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#ddRandomBox');
  await page.locator('.ed-clue .ed-dd input').nth(6).check();
  await page.check('#ddRandomBox');
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jeopardy.set')));
  assert.equal(saved.ddRandom, true);
  assert.equal(saved.rounds[0].categories[1].clues[1].dd, true, 'Spalte 2, Reihe 2');
  await page.click('.tabs button[data-round="1"]');
  await page.click('.tabs button[data-round="0"]');
  assert.equal(await page.locator('.ed-clue .ed-dd input').nth(6).isChecked(), true);
  assert.equal(await page.isChecked('#ddRandomBox'), true);
  await page.locator('.ed-clue .ed-dd input').nth(6).uncheck();
  await page.uncheck('#ddRandomBox');
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jeopardy.set')));
  assert.equal(saved.ddRandom, undefined);
  assert.equal(saved.rounds[0].categories[1].clues[1].dd, undefined);
  assert.deepEqual(env.errors, []);
});
