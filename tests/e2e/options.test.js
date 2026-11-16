// Spielregeln/Optionen: jede Option an und aus – Host-Pult, Spieler, TV, Editor; Host erzwingt es in der Logik
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv({ JEOP_BUZZ_DELAY_MS: 200, JEOP_DD_MS: 300 }); });
test.after(async () => { await env.stop(); });

const cellIdx = (c, row) => row * 6 + c;
const hostScores = (host) => host.$$eval('.pscore', (els) => els.map((e) => e.value).join(','));
const sendRaw = (page, msg) => page.evaluate((m) => J.playerApi.conn().send(m), msg);
const hostState = (host) => host.evaluate(() => J.loadState());
const openOpts = (p) => p.evaluate(() => { document.getElementById('optionsBox').open = true; });
async function setOpt(p, key, v) {
  await openOpts(p);
  const el = p.locator('#opt-' + key);
  if (typeof v === 'boolean') await (v ? el.check() : el.uncheck());
  else await el.selectOption(v);
}
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
const FINAL = 's.final = { category: "K", q: "FQ", a: "FA", note: "" };';

test('Panel: Standardwerte, Abhängigkeiten, Sperre nach dem ersten Feld, Reset, Neuladen behält', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  await openOpts(host);
  const n = await host.evaluate(() => J.OPTION_DEFS.length);
  assert.equal(await host.locator('#optionsList input, #optionsList select').count(), n);
  for (const k of ['final', 'dd', 'jokerDouble', 'jokerHint', 'jokerPass', 'steal', 'stealHalf', 'turn']) {
    assert.equal(await host.isChecked('#opt-' + k), true, k + ' standardmäßig an');
  }
  assert.equal(await host.isChecked('#opt-ddRandom'), false);
  assert.equal(await host.inputValue('#opt-penalty'), 'half');
  // Abhängigkeit: ohne Klauen keine halben Punkte fürs Klauen
  await setOpt(host, 'steal', false);
  assert.equal(await host.isDisabled('#opt-stealHalf'), true);
  await setOpt(host, 'dd', false);
  assert.equal(await host.isDisabled('#opt-ddRandom'), true);
  await setOpt(host, 'dd', true);
  await setOpt(host, 'steal', true);
  await setOpt(host, 'penalty', 'none');
  assert.deepEqual((await hostState(host)).options, { dd: true, steal: true, penalty: 'none' });
  // Resume: nach dem Neuladen bleiben die Regeln
  await host.reload();
  await host.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online');
  await openOpts(host);
  assert.equal(await host.inputValue('#opt-penalty'), 'none');
  assert.match(await host.textContent('#optionsState'), /geändert/);
  // Reset auf die Voreinstellung des Sets
  await host.click('#opt-reset');
  assert.equal(await host.inputValue('#opt-penalty'), 'half');
  assert.deepEqual((await hostState(host)).options, {});
  // Laufende Frage: gesperrt (Oberfläche UND Host-Logik)
  await host.locator('.cell.val').nth(0).click();
  await host.waitForSelector('#opt-steal:disabled');
  assert.equal(await host.locator('#optionsList .opt-locked').count(), 1);
  await host.evaluate(() => { const c = document.getElementById('opt-turn'); c.disabled = false; c.checked = false; c.dispatchEvent(new Event('change')); });
  await host.waitForTimeout(200);
  assert.deepEqual((await hostState(host)).options, {}, 'Host ignoriert Änderungen bei laufender Frage');
  await host.click('#cancel');
  await host.waitForSelector('#opt-steal:not(:disabled)');
  // Nach dem ersten gespielten Feld gesperrt, „Spielstand zurücksetzen“ gibt wieder frei
  await host.locator('.cell.val').nth(0).click();
  await host.locator('.jrow').nth(0).locator('.green').click();
  await host.click('#close');
  await host.waitForSelector('#opt-steal:disabled');
  await host.click('#resetGame');
  await host.waitForSelector('#opt-steal:not(:disabled)');
  assert.deepEqual(env.errors, []);
});

test('Set-Voreinstellung gilt, Host-Überschreibung geht vor', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  await useSet(host, FINAL + 's.options = { penalty: "full", final: false };');
  await openOpts(host);
  assert.equal(await host.inputValue('#opt-penalty'), 'full');
  assert.equal(await host.isChecked('#opt-final'), false);
  assert.equal(await host.isHidden('#fjBtn'), true, 'Final Jeopardy per Set aus: kein Knopf');
  await setOpt(host, 'final', true);
  await host.waitForSelector('#fjBtn:not([hidden])');
  assert.equal(await host.isDisabled('#fjBtn'), false);
  await setOpt(host, 'penalty', 'half');
  assert.deepEqual((await hostState(host)).options, { final: true, penalty: 'half' });
  assert.deepEqual(env.errors, []);
});

test('Final Jeopardy aus: Knopf und Hinweis weg, Start in der Logik gesperrt', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  await useSet(host, FINAL);
  assert.equal(await host.isHidden('#fjBtn'), false, 'an: Knopf da');
  await setOpt(host, 'final', false);
  await host.waitForSelector('#fjBtn', { state: 'hidden' });
  assert.equal(await host.isHidden('#fjHint'), true);
  // Auch ein direkter Aufruf startet nichts
  await host.evaluate(() => document.getElementById('fjBtn').click());
  assert.equal((await hostState(host)).fj, null);
  await setOpt(host, 'final', true);
  await host.click('#fjBtn');
  await host.waitForFunction(() => J.loadState().fj !== null);
  assert.deepEqual(env.errors, []);
});

test('Daily Double aus: markierte Felder sind normale Felder; an: Ansage', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  await useSet(host, 's.rounds[0].categories[1].clues[2].dd = true;');
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 1);
  assert.equal(await host.locator('.cell.val.dd').count(), 1);
  await setOpt(host, 'dd', false);
  await host.waitForFunction(() => document.querySelectorAll('.cell.val.dd').length === 0);
  await host.locator('.cell.val').nth(cellIdx(1, 2)).click();
  await anna.waitForSelector('#overlay.show');
  assert.equal(await anna.locator('#ddBox.show').count(), 0, 'kein DD-Overlay');
  assert.equal(await host.locator('#ddPanel').isHidden(), true);
  assert.equal((await hostState(host)).current.dd, undefined);
  await host.click('#cancel');
  await setOpt(host, 'dd', true);
  await host.waitForFunction(() => document.querySelectorAll('.cell.val.dd').length === 1);
  await host.locator('.cell.val').nth(cellIdx(1, 2)).click();
  await anna.waitForSelector('#ddBox.show');
  assert.deepEqual(env.errors, []);
});

test('Joker einzeln und alle aus: keine Knöpfe, Host ignoriert Nachrichten', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  // an: alle drei Knöpfe (Standard)
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForSelector('.joker[data-kind="hint"]');
  assert.equal(await anna.locator('.joker').count(), 3);
  await host.click('#cancel');
  // Tipp aus
  await setOpt(host, 'jokerHint', false);
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForSelector('.joker[data-kind="double"]');
  assert.equal(await anna.locator('.joker[data-kind="hint"]').count(), 0);
  assert.equal(await anna.locator('.joker').count(), 2);
  await sendRaw(anna, { type: 'joker', kind: 'hint' });
  await host.waitForTimeout(400);
  let st = await hostState(host);
  assert.deepEqual(st.current.jokers || {}, {}, 'Host setzt den ausgeschalteten Joker nicht');
  assert.ok(!(st.players[0].usedJokers || []).length);
  assert.equal(await host.isHidden('#jokerStatus'), true);
  await host.click('#cancel');
  // Doppelt oder nichts aus, Weitergeben aus → gar keine Leiste
  await setOpt(host, 'jokerDouble', false);
  await setOpt(host, 'jokerPass', false);
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForSelector('#overlay.show');
  await anna.waitForTimeout(300);
  assert.equal(await anna.locator('#jokerBar').isHidden(), true, 'keine Joker-Leiste');
  assert.equal(await anna.locator('.joker').count(), 0);
  await sendRaw(anna, { type: 'joker', kind: 'double' });
  await sendRaw(anna, { type: 'joker', kind: 'pass', target: 'x' });
  await host.waitForTimeout(400);
  st = await hostState(host);
  assert.deepEqual(st.current.jokers || {}, {});
  assert.equal(await ben.locator('#jokerBar').isHidden(), true);
  assert.deepEqual(env.errors, []);
});

test('Klauen aus: nach ✗ öffnet kein Buzzer, Host-Knopf gesperrt, volle Punkte von Hand', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  await setOpt(host, 'steal', false);
  assert.equal(await host.isDisabled('#opt-stealHalf'), true);
  await host.locator('.cell.val').nth(0).click();
  await host.locator('.jrow').nth(0).locator('.red').click();
  await host.waitForFunction(() => J.loadState().players[0].score === -50);
  await host.waitForTimeout(800);
  const cur = (await hostState(host)).current;
  assert.ok(!cur.buzz.open && !cur.buzz.arming, 'Buzzer bleibt zu');
  assert.equal(await host.isDisabled('#buzzBtn'), true);
  assert.equal(await ben.locator('#buzzer.live').count(), 0);
  // Host darf ihn auch nicht per Klick öffnen (Logik, nicht nur Oberfläche)
  await host.evaluate(() => document.getElementById('buzzBtn').click());
  await host.waitForTimeout(300);
  assert.equal((await hostState(host)).current.buzz.open, false);
  // Von Hand zweiter Versuch: voller Feldwert, nicht halb
  assert.match(await host.textContent('.jrow >> nth=1'), /\+100/);
  await host.locator('.jrow').nth(1).locator('.green').click();
  await host.waitForFunction(() => J.loadState().players[1].score === 100);
  assert.deepEqual(env.errors, []);
});

test('Klauen an, halbe Punkte aus: Buzzer öffnet, Klauen bringt den vollen Wert', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  await setOpt(host, 'stealHalf', false);
  await host.locator('.cell.val').nth(0).click();
  await host.locator('.jrow').nth(0).locator('.red').click();
  await ben.waitForSelector('#buzzer.live');
  assert.equal(await ben.textContent('#buzzInfo'), 'Klauen bringt +100');
  assert.equal(await host.isDisabled('#buzzBtn'), false);
  assert.match(await host.textContent('.jrow >> nth=1'), /✓ \+100/);
  await host.locator('.jrow').nth(1).locator('.green').click();
  await host.waitForFunction(() => J.loadState().players[1].score === 100);
  assert.equal(await hostScores(host), '-50,100');
  assert.deepEqual(env.errors, []);
});

test('Klauen an (Standard): halbe Punkte', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  await host.locator('.cell.val').nth(0).click();
  await host.locator('.jrow').nth(0).locator('.red').click();
  await ben.waitForSelector('#buzzer.live');
  assert.equal(await ben.textContent('#buzzInfo'), 'Klauen bringt +50');
  await host.locator('.jrow').nth(1).locator('.green').click();
  await host.waitForFunction(() => J.loadState().players[1].score === 50);
  assert.deepEqual(env.errors, []);
});

test('Abzug bei falscher Antwort: halb, voll, keiner', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  for (const [mode, label, score] of [['half', '✗ −50', -50], ['full', '✗ −100', -100], ['none', '✗ ±0', 0]]) {
    await setOpt(host, 'penalty', mode);
    await host.locator('.cell.val').nth(0).click();
    assert.equal(await host.textContent('.jrow .red'), label, mode);
    await host.locator('.jrow').nth(0).locator('.red').click();
    await host.waitForFunction((s) => J.loadState().players[0].score === s, score);
    await host.click('#close');
    await host.click('#resetGame');
    await host.waitForSelector('#opt-penalty:not(:disabled)');
  }
  assert.deepEqual(env.errors, []);
});

test('Penalty auch für Multiple Choice: Spieler sehen den Abzug', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  await useSet(host, 's.rounds[0].categories[0].clues[0].kind = "choice"; s.rounds[0].categories[0].clues[0].a = "Richtig | Falsch | Falsch2";');
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 1);
  await setOpt(host, 'penalty', 'full');
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForFunction(() => (document.querySelector('.special-status')?.textContent || '').includes('−100'));
  await host.click('#cancel');
  await setOpt(host, 'penalty', 'none');
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForSelector('.special-status');
  await anna.waitForFunction(() => (document.querySelector('.special-status')?.textContent || '').includes('gewählt'));
  assert.ok(!(await anna.textContent('.special-status')).includes('Falsch kostet'));
  assert.deepEqual(env.errors, []);
});

test('Am Zug aus: kein Banner, kein 🎯, Weitergeben weg, Daily Double wählt der Host', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  await useSet(host, 's.rounds[0].categories[0].clues[3].dd = true;');
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  await joinPlayer(env, code, { pick: 'Ben' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  assert.equal(await host.isVisible('#turnBanner'), true, 'an: Anna ist am Zug');
  assert.equal(await host.locator('.turn-btn').count(), 2);
  await anna.waitForSelector('#turnBanner:not([hidden])');
  await setOpt(host, 'turn', false);
  await host.waitForSelector('#turnBanner', { state: 'hidden' });
  assert.equal(await host.locator('.turn-btn').count(), 0);
  assert.equal(await host.isDisabled('#opt-jokerPass'), true);
  assert.equal((await hostState(host)).turn, null);
  await anna.waitForSelector('#turnBanner', { state: 'hidden' });
  // Neuer Spieler bekommt keinen Zug
  await host.fill('#newName', 'Cem');
  await host.click('#addForm button');
  assert.equal((await hostState(host)).turn, null);
  // Joker: Weitergeben fehlt, Doppelt oder nichts ist mangels „Dran“ gesperrt
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForSelector('.joker[data-kind="double"]');
  assert.equal(await anna.locator('.joker[data-kind="pass"]').count(), 0);
  assert.ok(await anna.locator('.joker[data-kind="double"]').isDisabled());
  await sendRaw(anna, { type: 'joker', kind: 'pass', target: 'x' });
  await host.waitForTimeout(300);
  assert.deepEqual((await hostState(host)).current.jokers || {}, {});
  await host.click('#close');
  assert.equal((await hostState(host)).turn, null, 'Schließen reicht den Zug nicht weiter');
  // Daily Double: niemand ist „dran“ – der Host wählt
  await host.locator('.cell.val').nth(cellIdx(0, 3)).click();
  await host.waitForSelector('[data-pick]'); // Ansage läuft kurz, dann Einsatzphase
  assert.match(await host.textContent('#ddPanel'), /Wähle, wer das Daily Double spielt/);
  await host.click('[data-pick] >> nth=1');
  await host.waitForFunction(() => J.loadState().current.dd.pid === J.loadState().players[1].id);
  assert.equal((await hostState(host)).turn, null);
  assert.deepEqual(env.errors, []);
});

test('Editor: Regeln im Set speichern, ausgeschaltete Funktionen verschwinden', async () => {
  const page = await env.page();
  await page.goto(env.base + '/editor.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await openOpts(page);
  await page.waitForSelector('#opt-penalty');
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('jeopardy.set')));
  assert.equal(((await saved()) || {}).options, undefined, 'Standard: nichts gespeichert');
  assert.equal(await page.isVisible('#fjEditor'), true);
  assert.ok(await page.locator('.ed-clue .ed-dd').first().isVisible());
  await setOpt(page, 'penalty', 'full');
  await setOpt(page, 'jokerHint', false);
  assert.deepEqual((await saved()).options, { penalty: 'full', jokerHint: false });
  // Final Jeopardy aus → Bereich weg
  await setOpt(page, 'final', false);
  await page.waitForSelector('#fjEditor', { state: 'hidden' });
  // Daily Double aus → Markierung und Zufallsoption weg/gesperrt
  await setOpt(page, 'dd', false);
  await page.waitForFunction(() => [...document.querySelectorAll('.ed-clue .ed-dd')].every((e) => e.hidden));
  assert.equal(await page.isDisabled('#opt-ddRandom'), true);
  // Neu laden: Auswahl bleibt
  await page.reload();
  await openOpts(page);
  assert.equal(await page.inputValue('#opt-penalty'), 'full');
  assert.equal(await page.isChecked('#opt-final'), false);
  // Zurück auf Standard → Eintrag verschwindet wieder
  for (const [k, v] of [['penalty', 'half'], ['jokerHint', true], ['final', true], ['dd', true]]) await setOpt(page, k, v);
  assert.equal((await saved()).options, undefined);
  assert.equal(await page.isVisible('#fjEditor'), true);
  assert.deepEqual(env.errors, []);
});
