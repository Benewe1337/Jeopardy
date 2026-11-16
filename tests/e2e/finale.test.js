// Final Jeopardy: Ablauf mit Einzelspielern + TV, Team-Modus, Set ohne Final Jeopardy, Editor
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv(); });
test.after(async () => { await env.stop(); });

const FINAL = { category: 'Weltgeschichte', q: 'Wer war der erste Kaiser Roms?', a: 'LOESUNGXYZ', note: 'Auch richtig: Octavian' };

async function useSet(host, withFinal) {
  await host.evaluate(([f]) => {
    const s = J.defaultSet();
    if (f) s.final = f;
    localStorage.setItem('jeopardy.set', JSON.stringify(s));
  }, [withFinal ? FINAL : null]);
  await host.reload();
  await host.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online');
}
async function setScore(host, i, v) {
  await host.locator('.pscore').nth(i).fill(String(v));
  await host.locator('.pscore').nth(i).blur();
  await host.waitForFunction(([i, v]) => document.querySelectorAll('.pscore')[i].value === String(v), [i, v]);
}
const text = (page, sel) => page.evaluate((s) => document.querySelector(s).innerText, sel);
const hostScores = (host) => host.$$eval('.pscore', (els) => els.map((e) => e.value).join(','));

test('Final Jeopardy mit zwei Spielern und TV: Einsätze geheim, Aufdecken von unten nach oben, Siegerehrung', async (t) => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  await useSet(host, true);
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  const tv = await joinPlayer(env, code, { viewport: { width: 1280, height: 720 } });
  await tv.click('#tvView');
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  await setScore(host, 0, 500);
  await setScore(host, 1, 200);

  await t.test('Knopf ist aktiv und startet mit der Kategorie für alle', async () => {
    assert.equal(await host.isDisabled('#fjBtn'), false);
    assert.equal(await host.isHidden('#fjHint'), true);
    await host.click('#fjBtn');
    for (const p of [anna, ben, tv]) {
      await p.waitForSelector('#finalBox.show');
      assert.match(await text(p, '#fjCategory'), /Weltgeschichte/);
      assert.equal(await p.isHidden('#fjQ'), true, 'Frage noch nicht sichtbar');
    }
    await host.waitForSelector('#fjPanel.show');
    assert.ok(!(await text(tv, '#finalBox')).includes('LOESUNGXYZ'));
    // Board ist gesperrt, solange Final Jeopardy läuft
    await host.locator('.cell.val').first().click();
    assert.equal(await host.isHidden('#clue.show'), true);
  });

  await t.test('Einsätze: ungültige werden abgelehnt, gültige bleiben für andere geheim', async () => {
    await host.click('#fjNext');
    await anna.waitForSelector('#fjWagerInput');
    await ben.waitForSelector('#fjWagerInput');
    assert.equal(await anna.getAttribute('#fjWagerInput', 'max'), '500');
    // Ben (200) versucht 1000 → abgelehnt, nichts wird gesendet
    await ben.fill('#fjWagerInput', '1000');
    await ben.click('#fjWagerBtn');
    await ben.waitForSelector('#fjWagerInput.invalid');
    await anna.fill('#fjWagerInput', '350');
    await anna.click('#fjWagerBtn');
    await host.waitForFunction(() => document.getElementById('fjList').textContent.includes('✓ 350'));
    await ben.fill('#fjWagerInput', '120');
    await ben.click('#fjWagerBtn');
    await host.waitForFunction(() => document.getElementById('fjList').textContent.includes('2/2 gesetzt'));
    for (const p of [ben, tv]) {
      await p.waitForFunction(() => document.getElementById('fjStatus').textContent.includes('2/2 haben gesetzt'));
      assert.ok(!(await text(p, '#finalBox')).includes('350'), 'Annas Einsatz ist nicht zu sehen');
    }
    assert.ok(!(await text(anna, '#finalBox')).includes('120'), 'Bens Einsatz ist bei Anna nicht zu sehen');
    await anna.waitForFunction(() => document.getElementById('fjStatus').textContent.includes('Dein Einsatz: 350'));
  });

  await t.test('Frage, Timer, Antworten: nur der Host sieht sie', async () => {
    await host.click('#fjNext');
    for (const p of [anna, ben, tv]) {
      await p.waitForFunction(() => document.getElementById('fjQ').textContent.includes('erste Kaiser Roms'));
    }
    await tv.waitForSelector('#fjTimerBox:not([hidden])');
    await host.waitForSelector('#fjTimerBox:not([hidden])');
    // Einsätze sind jetzt gesperrt (Formular weg, Antwortfeld da)
    await anna.waitForSelector('#fjAnswerInput');
    assert.equal(await anna.locator('#fjWagerInput').count(), 0);
    await anna.fill('#fjAnswerInput', 'ANTWORTANNA');
    await anna.click('#fjAnswerBtn');
    await ben.fill('#fjAnswerInput', 'ANTWORTBEN');
    await ben.click('#fjAnswerBtn');
    await host.waitForFunction(() => {
      const t = document.getElementById('fjList').textContent;
      return t.includes('ANTWORTANNA') && t.includes('ANTWORTBEN') && t.includes('Einsatz 350');
    });
    await tv.waitForFunction(() => document.getElementById('fjStatus').textContent.includes('2/2 haben geantwortet'));
    for (const [p, other] of [[tv, 'ANTWORT'], [ben, 'ANTWORTANNA'], [anna, 'ANTWORTBEN']]) {
      const body = await text(p, '#finalBox');
      assert.ok(!body.includes(other), 'fremde Antwort sichtbar');
      assert.ok(!body.includes('LOESUNGXYZ'), 'Lösung vor dem Aufdecken sichtbar');
    }
    // Joker gibt es hier nicht
    assert.equal(await anna.isHidden('#jokerBar'), true);
  });

  await t.test('Aufdecken: Ben (niedrigster Stand) zuerst, dann Anna; Undo funktioniert', async () => {
    await host.click('#fjNext'); // Antworten einsammeln
    await host.waitForFunction(() => document.getElementById('fjNext').textContent.includes('Ben'));
    await tv.waitForFunction(() => document.getElementById('fjBody').textContent.includes('LOESUNGXYZ'));
    await host.click('#fjNext');
    await tv.waitForSelector('.fj-card.pending');
    assert.match(await text(tv, '.fj-card.pending'), /Ben[\s\S]*ANTWORTBEN/);
    assert.ok(!(await text(tv, '#finalBox')).includes('ANTWORTANNA'));
    assert.ok(!(await text(tv, '.fj-card.pending')).includes('120'), 'Einsatz erst mit der Wertung');
    await host.click('#fjWrong');
    await tv.waitForSelector('.fj-card.wrong');
    assert.match(await text(tv, '.fj-card.wrong'), /falsch[\s\S]*120[\s\S]*−120/);
    assert.equal(await hostScores(host), '500,80');
    await host.click('#fjNext');
    await tv.waitForSelector('.fj-card.pending');
    await host.click('#fjRight');
    await tv.waitForSelector('.fj-card.right');
    assert.equal(await hostScores(host), '850,80');
    assert.deepEqual(await tv.$$eval('.fj-card .fj-card-name', (e) => e.map((x) => x.textContent)), ['Ben', 'Anna'], 'Reihenfolge');
    await tv.waitForFunction(() => document.querySelector('#fjScores').textContent.includes('850'));
    const sfx = await tv.evaluate(() => window.__sfx);
    assert.ok(sfx.includes('wrong') && sfx.includes('right') && sfx.includes('reveal'), 'Sounds: ' + sfx);
    // Undo nimmt Annas Wertung zurück
    await host.click('#undo');
    await host.waitForSelector('#fjRight');
    assert.equal(await hostScores(host), '500,80');
    await tv.waitForFunction(() => !document.querySelector('.fj-card.right') && document.querySelector('.fj-card.pending'));
    await host.click('#fjRight');
    await host.waitForSelector('#fjPodium');
    assert.equal(await hostScores(host), '850,80');
  });

  await t.test('Danach die Siegerehrung', async () => {
    await host.click('#fjPodium');
    await tv.waitForSelector('#finish.show');
    assert.match(await text(tv, '#podium'), /🏆 Anna/);
    assert.equal(await tv.locator('#finalBox.show').count(), 0, 'Final-Overlay weicht dem Podium');
  });
  assert.deepEqual(env.errors, []);
});

test('Final Jeopardy im Team-Modus: eine Abgabe pro Team, Team ohne Punkte setzt nur 0', async (t) => {
  const { host, code } = await openHost(env, { mode: 'team', teamSize: 2, names: ['Rot', 'Blau'] });
  await useSet(host, true);
  const anna = await joinPlayer(env, code, { name: 'Anna', pick: 'Rot' });
  const ben = await joinPlayer(env, code, { name: 'Ben', pick: 'Rot' });
  const cem = await joinPlayer(env, code, { name: 'Cem', pick: 'Blau' });
  await host.waitForFunction(() => document.getElementById('players').textContent.includes('Anna, Ben'));
  await setScore(host, 1, 300); // Rot bleibt bei 0
  await host.click('#fjBtn');
  await host.click('#fjNext');

  await t.test('Team ohne Punkte: Hinweis, nur 0', async () => {
    await anna.waitForSelector('#fjZero');
    assert.match(await text(anna, '#fjZero'), /keine Punkte.*nur 0/);
    assert.equal(await anna.isDisabled('#fjWagerInput'), true);
    await anna.click('#fjWagerBtn');
    await ben.waitForFunction(() => document.getElementById('fjStatus').textContent.includes('Euer Einsatz: 0 ✓ (Anna hat gesetzt)'));
    await cem.waitForSelector('#fjWagerInput');
    assert.equal(await cem.getAttribute('#fjWagerInput', 'max'), '300');
    await cem.fill('#fjWagerInput', '300');
    await cem.click('#fjWagerBtn');
    await host.waitForFunction(() => document.getElementById('fjList').textContent.includes('2/2 gesetzt'));
  });

  await t.test('Eine gemeinsame Antwort pro Team: letzte Abgabe zählt, alle sehen sie', async () => {
    await host.click('#fjNext');
    await anna.waitForSelector('#fjAnswerInput');
    await ben.waitForSelector('#fjAnswerInput');
    await anna.fill('#fjAnswerInput', 'ERSTE');
    await anna.click('#fjAnswerBtn');
    await ben.waitForFunction(() => document.getElementById('fjAnswerInput').value === 'ERSTE');
    await ben.fill('#fjAnswerInput', 'ZWEITE');
    await ben.click('#fjAnswerBtn');
    await anna.waitForFunction(() => document.getElementById('fjAnswerInput').value === 'ZWEITE');
    await anna.waitForFunction(() => document.getElementById('fjStatus').textContent.includes('Ben hat abgegeben'));
    await cem.fill('#fjAnswerInput', 'BLAUANTWORT');
    await cem.click('#fjAnswerBtn');
    await host.waitForFunction(() => {
      const t = document.getElementById('fjList').textContent;
      return t.includes('ZWEITE') && !t.includes('ERSTE') && t.includes('BLAUANTWORT');
    });
  });

  await t.test('Aufdecken: Rot (0) zuerst, Einsatz 0 kostet nichts; Blau gewinnt', async () => {
    await host.click('#fjNext');
    await host.click('#fjNext'); // Rot aufdecken
    await host.click('#fjWrong');
    assert.equal(await hostScores(host), '0,300');
    await host.click('#fjNext');
    await host.click('#fjRight');
    assert.equal(await hostScores(host), '0,600');
    await anna.waitForFunction(() => document.querySelectorAll('.fj-card').length === 2);
    await host.click('#fjPodium');
    await anna.waitForSelector('#finish.show');
    assert.match(await text(anna, '#podium'), /🏆 Blau/);
  });
  assert.deepEqual(env.errors, []);
});

test('Set ohne Final Jeopardy: Knopf ausgegraut mit Hinweis; altes Set ohne final-Feld lädt', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  assert.equal(await host.isDisabled('#fjBtn'), true);
  await host.waitForSelector('#fjHint:not([hidden])');
  assert.match(await text(host, '#fjHint'), /nicht angelegt/);
  // Altes Set (vor Final Jeopardy gespeichert): kein final-Feld
  await host.evaluate(() => {
    const s = J.defaultSet();
    delete s.final;
    localStorage.setItem('jeopardy.set', JSON.stringify(s));
  });
  await host.reload();
  await host.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online');
  assert.equal(await host.isDisabled('#fjBtn'), true);
  // Normale Siegerehrung geht weiter
  await host.click('#finishBtn');
  await host.waitForSelector('#finish.show');
  // Final Jeopardy ohne Spieler: ebenfalls nicht startbar
  const h2 = (await openHost(env)).host;
  await useSet(h2, true);
  assert.equal(await h2.isDisabled('#fjBtn'), true);
  assert.deepEqual(env.errors, []);
});

test('Editor: Final Jeopardy bearbeiten, speichern und exportieren', async () => {
  const page = await env.page();
  await page.goto(env.base + '/editor.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#fj_category');
  await page.fill('#fj_category', 'Weltgeschichte');
  await page.fill('#fj_q', 'Frage?');
  await page.fill('#fj_a', 'Antwort!');
  await page.fill('#fj_note', 'Notiz');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jeopardy.set')).final);
  assert.deepEqual(saved, { category: 'Weltgeschichte', q: 'Frage?', a: 'Antwort!', note: 'Notiz' });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const exported = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
  assert.equal(exported.final.a, 'Antwort!');
  // Tab-Wechsel zeichnet neu, Werte bleiben
  await page.click('.tabs button[data-round="1"]');
  assert.equal(await page.inputValue('#fj_q'), 'Frage?');
  assert.deepEqual(env.errors, []);
});
