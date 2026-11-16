// Buzzer: Timer, Wartezustand, Frühstart-Sperre, Anti-Spam, fairer Buzzer, Klauen
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer, scoresOf, trackUi, uiSeen, uiReset, uiSeq, uiText, trackText, textSeen } = require('./helpers');

let env;
test.before(async () => {
  env = await startEnv({ JEOP_TIMER_MS: 2500, JEOP_BUZZ_DELAY_MS: 400, JEOP_BUZZ_WINDOW_MS: 1200 });
});
test.after(async () => { await env.stop(); });

// Warten bis der Buzzer scharf ist, dann „menschlich“ drücken
async function buzzCalmly(page, delay = 250) {
  await page.waitForSelector('#buzzer.live');
  await page.waitForTimeout(delay);
  await page.click('#buzzer');
}

test('Buzzer-Ablauf mit drei Spielern', async (t) => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben', 'Cem'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  const cem = await joinPlayer(env, code, { pick: 'Cem' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 3);
  // Kurzlebige Zustände werden aufgezeichnet statt per Polling erhascht (siehe helpers.trackUi)
  for (const pg of [anna, ben, cem]) await trackUi(pg);
  await trackText(host, '#buzzStatus');

  await host.locator('.cell.val').first().click();
  await anna.waitForSelector('#overlay.show');

  await t.test('Buzzer ist sofort sichtbar, aber grau', async () => {
    await anna.waitForSelector('#buzzer.wait');
    assert.equal(await anna.textContent('#buzzer'), 'Noch nicht');
  });

  await t.test('Buzzer-Text ist nicht markierbar', async () => {
    const sel = await anna.$eval('#buzzer', (b) => getComputedStyle(b).userSelect || getComputedStyle(b).webkitUserSelect);
    assert.equal(sel, 'none');
  });

  await t.test('Drücken auf den grauen Buzzer sperrt kurz', async () => {
    await anna.click('#buzzer');
    await uiSeen(anna, '#buzzer.locked');
    assert.equal(await uiText(anna, '#buzzer.locked'), 'Zu früh!');
    await anna.waitForSelector('#buzzer.wait'); // Sperre läuft von selbst ab
  });

  await t.test('Timer läuft bei allen und meldet das Ende', async () => {
    await host.click('#timerBtn');
    await uiSeen(anna, '#timerBox:shown');
    await anna.waitForFunction(() => window.__sfx.includes('timeup'));
    await anna.waitForSelector('#timerBox', { state: 'hidden' });
  });

  await t.test('Nach „falsch“ öffnet der Buzzer erst nach einer Pause', async () => {
    await uiReset(anna);
    await host.locator('.jrow').nth(1).locator('.red').click(); // Ben falsch
    await textSeen(host, '#buzzStatus', /gleich/);
    // Reihenfolge statt Momentaufnahme: erst grau (Pause), dann scharf – nie sofort scharf
    await uiSeen(anna, '#buzzer.live');
    const seq = (await uiSeq(anna)).filter((k) => k === '#buzzer.wait' || k === '#buzzer.live');
    assert.equal(seq[0], '#buzzer.wait', 'direkt nach ✗ noch grau: ' + seq.join(','));
    assert.ok(await ben.isHidden('#buzzer'), 'Ben lag falsch und darf nicht mehr');
    assert.equal(await anna.textContent('#buzzInfo'), 'Klauen bringt +50');
  });

  await t.test('Wer vorher hämmert, verliert gegen ruhiges Drücken', async () => {
    // Zurück vor die Öffnung: Ben falsch rückgängig und erneut falsch → neue Buzzer-Runde
    await host.click('#undo');
    // Erst abwarten, dass der Buzzer nach dem Rückgängig wieder zu ist – sonst sieht man über das
    // langsamere Relay kurz noch den alten offenen Buzzer und buzzert in eine beendete Runde
    await anna.waitForSelector('#buzzer.wait');
    // Cem hämmert ununterbrochen – und zwar schon BEVOR die neue Runde startet. Würde er erst danach
    // anfangen, könnte die Pause unter Last schon vorbei sein, und sein erster Druck wäre ein gültiger.
    await cem.waitForSelector('#buzzer.wait');
    await cem.evaluate(() => {
      window.__spam = setInterval(() => {
        document.getElementById('buzzer').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      }, 60);
    });
    await host.locator('.jrow').nth(1).locator('.red').click();
    await buzzCalmly(anna, 300);
    await host.waitForFunction(() => document.querySelector('.jrow.buzzed'));
    await cem.evaluate(() => clearInterval(window.__spam));
    assert.equal(await host.textContent('.jrow.buzzed .name'), '⚡ Anna');
    await cem.waitForFunction(() => document.getElementById('buzzInfo').textContent.includes('Anna'));
  });

  await t.test('Fairer Buzzer: schnellere Reaktion schlägt frühere Ankunft', async () => {
    await host.click('#undo'); // Buzz rückgängig → Buzzer wieder offen
    await host.click('#undo'); // Ben falsch rückgängig
    await anna.waitForSelector('#buzzer.wait'); // Buzzer zu abwarten (siehe oben)
    await cem.waitForSelector('#buzzer.wait');
    await host.locator('.jrow').nth(1).locator('.red').click();
    // Reaktionszeiten fest vorgeben statt echte Zeit zu messen: die Uhr jeder Seite steht still und
    // springt erst nach dem Scharfwerden auf den gewünschten Abstand (Anna 900 ms, Cem 300 ms).
    const freeze = (pg) => pg.evaluate(() => {
      const base = performance.now(); let off = 0;
      performance.now = () => base + off;
      window.__react = (ms) => { off = ms; };
    });
    await freeze(anna);
    await freeze(cem);
    await anna.waitForSelector('#buzzer.live');
    await cem.waitForSelector('#buzzer.live');
    await anna.evaluate(() => window.__react(900));
    await cem.evaluate(() => window.__react(300));
    // Beide Drücke direkt hintereinander (ohne Playwrights Klick-Prüfungen, die unter Last lange dauern
    // und Cem aus dem Zeitfenster des Hosts fallen ließen): Anna kommt zuerst an, reagiert aber langsamer
    const press = (pg) => pg.evaluate(() => document.getElementById('buzzer')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })));
    await press(anna);
    await press(cem);
    await host.waitForFunction(() => document.querySelector('.jrow.buzzed'));
    assert.equal(await host.textContent('.jrow.buzzed .name'), '⚡ Cem');
    assert.match(await host.textContent('#buzzStatus'), /Cem hat gebuzzert.*danach: Anna/);
    await anna.waitForFunction(() => document.getElementById('buzzInfo').textContent.startsWith('⚡ Cem war schneller'));
  });

  await t.test('Cem klaut: halbe Punkte, Buzzer danach zu', async () => {
    await host.locator('.jrow.buzzed .green').click();
    await anna.waitForFunction(() => document.getElementById('a').textContent === 'Antwort');
    assert.equal(await scoresOf(anna, '#overlayScores'), '0,-50,50');
    assert.ok(await anna.isHidden('#buzzer'));
    const sfx = await anna.evaluate(() => window.__sfx);
    for (const s of ['open', 'tick', 'timeup', 'wrong', 'buzzopen', 'buzz', 'right']) assert.ok(sfx.includes(s), 'Sound fehlt: ' + s);
  });

  assert.deepEqual(env.errors, []);
});
