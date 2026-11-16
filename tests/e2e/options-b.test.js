// Spielregeln Teil B: Reaktionen, Intro, Auszeichnungen, Statistik, Buzzer-Rennen, Timer, QR, Clips,
// Sound-Standard, Server-Sicherung – jeweils an und aus; der Host erzwingt es in der Logik
const test = require('node:test');
const assert = require('node:assert/strict');
const { TRANSPORT, HOST_PASSWORD, startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv({ JEOP_BUZZ_DELAY_MS: 200, JEOP_INTRO_MS: 1200, JEOP_SYNC_MS: 150 }); });
test.after(async () => { await env.stop(); });

const hostState = (host) => host.evaluate(() => J.loadState());
const openOpts = (p) => p.evaluate(() => { document.getElementById('optionsBox').open = true; });
async function setOpt(p, key, v) {
  await openOpts(p);
  const el = p.locator('#opt-' + key);
  if (typeof v === 'boolean') await (v ? el.check() : el.uncheck());
  else await el.selectOption(v);
}
async function useSet(host, src) {
  await host.evaluate((code) => {
    const s = J.defaultSet();
    // eslint-disable-next-line no-new-func
    new Function('s', code)(s);
    localStorage.setItem('jeopardy.set', JSON.stringify(s));
  }, src);
  await host.reload();
  await host.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online');
}
const sleep = (p, ms) => p.waitForTimeout(ms);
const PIXEL = `const c = document.createElement('canvas'); c.width = 200; c.height = 120;
  const g = c.getContext('2d'); g.fillStyle = '#e11'; g.fillRect(0, 0, 100, 120); g.fillStyle = '#11e'; g.fillRect(100, 0, 100, 120);
  Object.assign(s.rounds[0].categories[0].clues[0], { img: c.toDataURL('image/png'), pixel: true, a: 'Flagge' });`;
function wavDataUrl() {
  const n = 16000;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return 'data:audio/wav;base64,' + b.toString('base64');
}
async function playCell(host, i = 0) {
  await host.locator('.cell.val').nth(i).click();
  await host.locator('.jrow').nth(0).locator('.green').click();
  await host.click('#close');
}
async function openTv(code, viewport = { width: 1280, height: 720 }) {
  const tv = await env.page({ viewport });
  await tv.goto(env.base + '/player.html?room=' + code);
  await tv.waitForSelector('#picker:not([hidden])');
  await tv.click('#tvView');
  return tv;
}

test('Panel Teil B: alle Optionen standardmäßig an, Dauer 15 s', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  await openOpts(host);
  for (const k of ['pixelRace', 'timer', 'intro', 'reactions', 'qrTv', 'media', 'stats', 'awards', 'soundDefault', 'backup']) {
    assert.equal(await host.isChecked('#opt-' + k), true, k + ' standardmäßig an');
  }
  assert.equal(await host.inputValue('#opt-timerSec'), '15');
  await setOpt(host, 'timer', false);
  assert.equal(await host.isDisabled('#opt-timerSec'), true, 'Dauer braucht Timer');
  assert.deepEqual(env.errors, []);
});

test('Live-Reaktionen an: Leiste da, Reaktion fliegt; aus: Leiste weg, Host verwirft', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const tv = await openTv(code);
  await anna.waitForSelector('#board:not([hidden])');
  assert.equal(await anna.isHidden('#reactBar'), false);
  await anna.click('.react-toggle');
  await anna.click('.react-btn:text-is("😂")');
  await host.waitForSelector('.react-float');
  await tv.waitForSelector('.react-float');
  // aus
  await setOpt(host, 'reactions', false);
  await anna.waitForSelector('#reactBar', { state: 'hidden' });
  await host.waitForFunction(() => !document.querySelector('.react-float'));
  await tv.waitForFunction(() => !document.querySelector('.react-float'));
  await anna.evaluate(() => J.playerApi.conn().send({ type: 'react', emoji: '🔥' }));
  await sleep(host, 700);
  assert.equal(await host.locator('.react-float').count(), 0, 'Host verwirft die Nachricht');
  assert.equal(await tv.locator('.react-float').count(), 0, 'nichts an den TV verteilt');
  assert.deepEqual(env.errors, []);
});

test('Runden-Intro an: startet beim Rundenwechsel und per Knopf; aus: weder noch', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  await host.click('#r1');
  await host.waitForSelector('#intro.show');
  await host.click('#introSkip');
  await host.waitForSelector('#intro:not(.show)', { state: 'attached' });
  assert.equal(await host.isHidden('#introBtn'), false);
  await host.click('#r0');
  await host.click('#introSkip');
  await host.waitForSelector('#intro:not(.show)', { state: 'attached' });
  await setOpt(host, 'intro', false);
  await host.waitForSelector('#introBtn', { state: 'hidden' });
  await host.click('#r1');
  await sleep(host, 500);
  assert.equal(await host.evaluate(() => document.getElementById('intro').classList.contains('show')), false, 'kein Intro beim Rundenwechsel');
  await host.evaluate(() => document.getElementById('introBtn').click());
  await sleep(host, 300);
  assert.equal(await host.evaluate(() => document.getElementById('intro').classList.contains('show')), false, 'auch per Aufruf nicht');
  assert.equal(await host.evaluate(() => document.getElementById('intro').classList.contains('show')), false);
  assert.deepEqual(env.errors, []);
});

test('Auszeichnungen und Statistik: an → sichtbar/exportierbar; aus → weg, Logik sperrt', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const tv = await openTv(code);
  await anna.waitForSelector('#board:not([hidden])');
  await playCell(host, 0);
  await host.click('#finishBtn');
  await host.waitForSelector('#podium .award');
  await tv.waitForSelector('#podium .award');
  await anna.waitForSelector('#podium .award');
  assert.equal(await host.isHidden('#statsToggle'), false);
  assert.equal(await host.isHidden('#exportCsv'), false);
  await host.click('#statsToggle');
  await tv.waitForSelector('#statsBox:not([hidden]) .stats-main');
  await host.click('#statsToggle');
  await host.click('#finishBack');
  // Nur Auszeichnungen aus (vor dem ersten Feld wäre gesperrt → Stand zurücksetzen nicht nötig: neues Spiel)
  const h2 = await openHost(env, { names: ['Anna', 'Ben'] });
  const tv2 = await openTv(h2.code);
  await setOpt(h2.host, 'awards', false);
  await playCell(h2.host, 0);
  await h2.host.click('#finishBtn');
  await h2.host.waitForSelector('#podium .pod-winner');
  await tv2.waitForSelector('#podium .pod-winner');
  await sleep(h2.host, 300);
  assert.equal(await h2.host.locator('#podium .award').count(), 0);
  assert.equal(await tv2.locator('#podium .award').count(), 0);
  assert.equal(await h2.host.isHidden('#statsToggle'), false, 'Statistik bleibt an');
  // Statistik aus
  const h3 = await openHost(env, { names: ['Anna', 'Ben'] });
  const tv3 = await openTv(h3.code);
  await setOpt(h3.host, 'stats', false);
  await playCell(h3.host, 0);
  await h3.host.click('#finishBtn');
  await h3.host.waitForSelector('#podium .award', { state: 'attached' });
  assert.equal(await h3.host.isHidden('#statsToggle'), true);
  assert.equal(await h3.host.isHidden('#exportCsv'), true);
  assert.equal(await h3.host.isHidden('#exportJson'), true);
  await h3.host.evaluate(() => document.getElementById('statsToggle').click());
  await sleep(h3.host, 400);
  assert.equal((await hostState(h3.host)).statsShown, false, 'Host schaltet nicht um');
  assert.equal(await h3.host.isHidden('#statsBox'), true);
  assert.equal(await tv3.isHidden('#statsBox'), true);
  assert.ok((await hostState(h3.host)).stats[(await hostState(h3.host)).players[0].id], 'Erfassung läuft weiter');
  assert.deepEqual(env.errors, []);
});

test('Buzzer-Rennen an: Buzzer öffnet für alle; aus: Bild wird weiter schärfer, kein Rennen', async () => {
  for (const race of [true, false]) {
    const { host } = await openHost(env, { names: ['Anna', 'Ben'] });
    await useSet(host, PIXEL);
    if (!race) await setOpt(host, 'pixelRace', false);
    const anna = await joinPlayer(env, await host.textContent('#code'), { pick: 'Anna' });
    await anna.waitForSelector('#board:not([hidden])');
    await host.locator('.cell.val').nth(0).click();
    await host.waitForSelector('#clue.show');
    if (race) {
      await host.waitForFunction(() => J.loadState().current.buzz.open);
    } else {
      await sleep(host, 900);
      const buzz = (await hostState(host)).current.buzz;
      assert.ok(!buzz.open && !buzz.arming, 'kein Rennen');
      assert.equal(await anna.locator('#buzzer.live').count(), 0);
    }
    // Schärfer per Host-Klick geht in beiden Fällen
    await host.waitForSelector('#pixelBtn:not([hidden])');
    const w0 = await host.$eval('#clueImg', (i) => i.naturalWidth);
    await host.click('#pixelBtn');
    await host.waitForFunction((w) => document.getElementById('clueImg').naturalWidth > w, w0);
    assert.deepEqual(env.errors, []);
  }
});

test('Frage-Timer: Dauer 15 (Standard) / 20 s, aus: Knöpfe weg und Start gesperrt', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  await host.locator('.cell.val').nth(0).click();
  assert.match(await host.textContent('#timerBtn'), /15 s/);
  await host.click('#timerBtn');
  await host.waitForFunction(() => !!J.loadState().current.timer);
  assert.equal((await hostState(host)).current.timer.total, 15000);
  await host.click('#timerStop');
  await host.click('#close');
  await host.evaluate(() => { document.getElementById('r0').click(); });
  const h2 = await openHost(env, { names: ['Anna'] });
  await setOpt(h2.host, 'timerSec', '20');
  await h2.host.locator('.cell.val').nth(0).click();
  assert.match(await h2.host.textContent('#timerBtn'), /20 s/);
  await h2.host.click('#timerBtn');
  await h2.host.waitForFunction(() => !!J.loadState().current.timer);
  assert.equal((await hostState(h2.host)).current.timer.total, 20000);
  const h3 = await openHost(env, { names: ['Anna'] });
  await setOpt(h3.host, 'timer', false);
  await h3.host.locator('.cell.val').nth(0).click();
  await h3.host.waitForSelector('#clue.show');
  assert.equal(await h3.host.isHidden('#timerBtn'), true);
  assert.equal(await h3.host.isHidden('#timerStop'), true);
  await h3.host.evaluate(() => document.getElementById('timerBtn').click());
  await sleep(h3.host, 300);
  assert.equal((await hostState(h3.host)).current.timer, null, 'Host startet keinen Timer');
  assert.deepEqual(env.errors, []);
});

test('QR auf dem TV: an → sichtbar; aus → weder QR noch Taste; Host-QR bleibt', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  const tv = await openTv(code);
  await tv.waitForSelector('#invite:not([hidden])');
  assert.equal(await tv.isHidden('#qrBtn'), false);
  await setOpt(host, 'qrTv', false);
  await tv.waitForSelector('#invite', { state: 'hidden' });
  await tv.waitForSelector('#qrBtn', { state: 'hidden' });
  assert.equal(await host.locator('#qr svg').count() > 0, true, 'Host-QR bleibt');
  const tv2 = await openTv(code);
  await sleep(tv2, 500);
  assert.equal(await tv2.isHidden('#invite'), true);
  assert.deepEqual(env.errors, []);
});

test('Clips aus: Host spielt nichts, TV lädt nichts, Handy ohne Hinweis, Editor ohne Clip-Feld', async () => {
  const wav = wavDataUrl();
  const src = `Object.assign(s.rounds[0].categories[0].clues[0], { media: ${JSON.stringify(wav)}, mediaType: 'audio' });`;
  const run = async (off) => {
    const { host } = await openHost(env, { names: ['Anna'] });
    await useSet(host, src);
    if (off) await setOpt(host, 'media', false);
    const code = await host.textContent('#code');
    const tv = await openTv(code);
    const phone = await joinPlayer(env, code, { pick: 'Anna' });
    await phone.waitForSelector('#board:not([hidden])');
    await host.locator('.cell.val').nth(0).click();
    await host.waitForSelector('#clue.show');
    if (!off) {
      await host.waitForSelector('#mediaBox:not([hidden])');
      await tv.waitForFunction(() => !!document.getElementById('tvMedia').getAttribute('src'));
      await phone.waitForSelector('#mediaHint:not([hidden])');
    } else {
      await sleep(host, 700);
      assert.equal(await host.isHidden('#mediaBox'), true);
      assert.equal(await host.evaluate(() => !!document.getElementById('hostMedia').getAttribute('src')), false, 'nicht geladen');
      assert.equal(await tv.evaluate(() => !!document.getElementById('tvMedia').getAttribute('src')), false);
      assert.equal(await phone.isHidden('#mediaHint'), true);
    }
  };
  await run(false);
  await run(true);
  // Editor
  const ed = await env.page();
  await ed.goto(env.base + '/editor.html');
  await ed.evaluate(() => localStorage.clear());
  await ed.reload();
  await openOpts(ed);
  assert.ok(await ed.locator('.ed-media').count() > 0);
  await setOpt(ed, 'media', false);
  await ed.waitForFunction(() => document.querySelectorAll('.ed-media').length === 0);
  await setOpt(ed, 'media', true);
  await ed.waitForFunction(() => document.querySelectorAll('.ed-media').length > 0);
  assert.deepEqual(env.errors, []);
});

test('Sounds standardmäßig: an (Standard) / aus für Geräte ohne eigene Wahl; Schalter geht weiter', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  await anna.waitForSelector('#board:not([hidden])');
  assert.equal(await anna.evaluate(() => J.soundOn()), true);
  const h2 = await openHost(env, { names: ['Anna', 'Ben'] });
  await setOpt(h2.host, 'soundDefault', false);
  const p = await joinPlayer(env, h2.code, { pick: 'Anna' });
  await p.waitForSelector('#board:not([hidden])');
  await p.waitForFunction(() => J.soundOn() === false);
  await p.evaluate(() => J.setSoundOn(true));
  assert.equal(await p.evaluate(() => J.soundOn()), true, 'Gerät kann einschalten');
  await p.reload();
  await p.waitForSelector('#board:not([hidden])');
  assert.equal(await p.evaluate(() => J.soundOn()), true, 'eigene Wahl bleibt');
  assert.deepEqual(env.errors, []);
});

test('Server-Sicherung: Option steuert gameSync (beide Transporte); Panel sagt „aus“', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  assert.equal(await host.evaluate(() => J.gameSync.enabled), true);
  await setOpt(host, 'backup', false);
  await host.waitForFunction(() => J.gameSync.enabled === false);
  await setOpt(host, 'backup', true);
  await host.waitForFunction(() => J.gameSync.enabled === true);
  assert.deepEqual(env.errors, []);
});

test('Server-Sicherung aus (Relay): nichts landet auf dem Server, Statusanzeige sagt „aus“', { skip: TRANSPORT !== 'relay' }, async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  await host.waitForSelector('#gameBox:not([hidden])');
  await setOpt(host, 'backup', false);
  if (await host.isHidden('#gamePw')) await host.click('#gameBox summary');
  await host.fill('#gamePw', HOST_PASSWORD);
  await host.click('#gamePwForm button');
  await host.waitForFunction(() => J.gameSync.status.kind === 'ok');
  await playCell(host, 0);
  await sleep(host, 1200);
  const games = await host.evaluate(async () => (await J.gameSync.list()).filter((g) => g.room === J.roomCode()));
  assert.equal(games.length, 0, 'kein Schreibzugriff');
  assert.equal(await host.isHidden('#gameOffNote'), false);
  assert.equal(await host.textContent('#saveStatus'), 'Sicherung aus');
  assert.deepEqual(env.errors, []);
});
