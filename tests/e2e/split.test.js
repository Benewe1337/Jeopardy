// Punkteverteilung (⚖️ splitScoring): jede Stellschraube an/aus mit 2 Spielern (am Zug vs. andere),
// Punktestand + Anzeigetext auf Handy und TV, Klauen 25/75 %, Stellschrauben ausgeblendet, wenn aus
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv({ JEOP_BUZZ_DELAY_MS: 200 }); });
test.after(async () => { await env.stop(); });

const SUB = ['turnShare', 'otherShare', 'otherPenalty', 'estimateRunnerUp', 'stealShare'];
const scores = (host) => host.evaluate(() => J.loadState().players.map((p) => p.score).join(','));
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
async function table(opts = {}, src = '') {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  if (src) await useSet(host, src);
  const anna = await joinPlayer(env, code, { pick: 'Anna' });
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  const tv = await joinPlayer(env, code, { viewport: { width: 1280, height: 720 } });
  await tv.click('#tvView');
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  for (const [k, v] of Object.entries(opts)) await setOpt(host, k, v);
  return { host, anna, ben, tv };
}
const splitText = (p) => p.textContent('#splitInfo');
const visible = (p) => p.isVisible('#splitInfo');
// Anna ist am Zug (erster Spieler); Zeile 0 = Anna, Zeile 1 = Ben
const judgeBtn = (host, row, cls) => host.locator('.jrow').nth(row).locator(cls);

test('Hauptschalter aus: Stellschrauben im Host-Pult und Editor ausgeblendet, stealHalf sichtbar; an: umgekehrt', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  await openOpts(host);
  assert.equal(await host.isChecked('#opt-splitScoring'), false);
  for (const k of SUB) assert.equal(await host.locator('#opt-' + k).count(), 0, k + ' ausgeblendet');
  assert.equal(await host.locator('#opt-stealHalf').count(), 1);
  await setOpt(host, 'splitScoring', true);
  for (const k of SUB) assert.equal(await host.locator('#opt-' + k).count(), 1, k + ' sichtbar');
  assert.equal(await host.locator('#opt-stealHalf').count(), 0, 'stealHalf ausgeblendet');
  assert.equal(await host.inputValue('#opt-stealShare'), '50', 'vorbelegt aus stealHalf (an)');
  assert.equal(await host.inputValue('#opt-turnShare'), '100');
  await setOpt(host, 'splitScoring', false);
  for (const k of SUB) assert.equal(await host.locator('#opt-' + k).count(), 0);

  const ed = await env.page();
  await ed.goto(env.base + '/editor.html');
  await ed.evaluate(() => localStorage.clear());
  await ed.reload();
  await openOpts(ed);
  await ed.waitForSelector('#opt-splitScoring');
  for (const k of SUB) assert.equal(await ed.locator('#opt-' + k).count(), 0, k + ' im Editor ausgeblendet');
  assert.equal(await ed.locator('#opt-stealHalf').count(), 1);
  await setOpt(ed, 'splitScoring', true);
  for (const k of SUB) assert.equal(await ed.locator('#opt-' + k).count(), 1);
  await setOpt(ed, 'stealShare', '100'); // gleich dem Vorgabewert, wird trotzdem gespeichert (Standard folgt stealHalf)
  assert.deepEqual((await ed.evaluate(() => JSON.parse(localStorage.getItem('jeopardy.set')))).options, { splitScoring: true, stealShare: '100' });
  assert.deepEqual(env.errors, []);
});

test('Schalter aus, Stellschrauben im Set gespeichert: alles wie bisher, keine Zeile', async () => {
  const { host, anna, ben, tv } = await table({}, 's.options = { turnShare: "0", otherShare: "0", otherPenalty: "none", estimateRunnerUp: "50", stealShare: "25" };');
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForSelector('#buzzer');
  assert.equal(await judgeBtn(host, 0, '.green').textContent(), '✓ +100');
  assert.equal(await judgeBtn(host, 1, '.green').textContent(), '✓ +100');
  assert.equal(await judgeBtn(host, 1, '.red').textContent(), '✗ −50');
  for (const p of [anna, ben, tv]) assert.equal(await visible(p), false);
  await judgeBtn(host, 0, '.red').click();
  await ben.waitForSelector('#buzzer.live');
  assert.equal(await ben.textContent('#buzzInfo'), 'Klauen bringt +50');
  assert.deepEqual(env.errors, []);
});

test('Hauptschalter an mit Standardwerten: wie bisher, keine Zeile', async () => {
  const { host, anna, ben, tv } = await table({ splitScoring: true });
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForSelector('#buzzer');
  assert.equal(await judgeBtn(host, 1, '.green').textContent(), '✓ +100');
  assert.equal(await judgeBtn(host, 1, '.red').textContent(), '✗ −50');
  for (const p of [anna, ben, tv]) assert.equal(await visible(p), false);
  await judgeBtn(host, 1, '.green').click();
  await host.waitForFunction(() => J.loadState().players[1].score === 100);
  assert.deepEqual(env.errors, []);
});

test('turnShare 50 %: am Zug halb, Zeile auf Handy und TV, 🎯 im Host-Pult', async () => {
  const { host, anna, ben, tv } = await table({ splitScoring: true, turnShare: '50' });
  await host.locator('.cell.val').nth(12).click(); // Zeile 3 (300)
  const want = 'Am Zug: 50 % · alle anderen: volle Punkte';
  for (const p of [anna, ben, tv]) await p.waitForFunction((t) => document.getElementById('splitInfo').textContent === t && !document.getElementById('splitInfo').hidden, want);
  assert.match(await host.textContent('.jrow >> nth=0'), /🎯/);
  assert.doesNotMatch(await host.textContent('.jrow >> nth=1'), /🎯/);
  assert.equal(await judgeBtn(host, 0, '.green').textContent(), '✓ +150');
  assert.equal(await judgeBtn(host, 1, '.green').textContent(), '✓ +300');
  await judgeBtn(host, 0, '.green').click();
  await host.waitForFunction(() => J.loadState().players[0].score === 150);
  assert.equal(await scores(host), '150,0');
  assert.deepEqual(env.errors, []);
});

test('otherShare 50 %: die anderen bekommen halb; ohne Zug (turn aus) bekommen alle den Anteil', async () => {
  const { host, anna, tv } = await table({ splitScoring: true, otherShare: '50' });
  await host.locator('.cell.val').nth(0).click();
  await tv.waitForFunction(() => document.getElementById('splitInfo').textContent === 'Am Zug: volle Punkte · alle anderen: 50 %');
  assert.equal(await judgeBtn(host, 0, '.green').textContent(), '✓ +100');
  assert.equal(await judgeBtn(host, 1, '.green').textContent(), '✓ +50');
  await judgeBtn(host, 1, '.green').click();
  await host.waitForFunction(() => J.loadState().players[1].score === 50);
  assert.equal(await scores(host), '0,50');
  await host.click('#close');
  await host.click('#resetGame');
  await host.waitForSelector('#opt-turn:not(:disabled)', { state: 'attached' });
  await setOpt(host, 'turn', false);
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForFunction(() => document.getElementById('splitInfo').textContent === 'Richtige: 50 %');
  assert.equal(await judgeBtn(host, 0, '.green').textContent(), '✓ +50', 'ohne Am Zug: alle bekommen otherShare');
  assert.equal(await judgeBtn(host, 1, '.green').textContent(), '✓ +50');
  assert.equal(await host.locator('#opt-turnShare').isDisabled(), true, 'turnShare braucht Am Zug');
  assert.deepEqual(env.errors, []);
});

test('otherPenalty: wie sonst / halb / keiner – wer am Zug ist, behält den normalen Abzug', async () => {
  const { host, anna, ben } = await table({ splitScoring: true });
  for (const [mode, active, other, line] of [
    ['half', '✗ −50', '✗ −25', 'Falsch: am Zug −50, andere −25'],
    ['none', '✗ −50', '✗ ±0', 'Falsch: am Zug −50, andere nichts'],
    ['same', '✗ −50', '✗ −50', null],
  ]) {
    await setOpt(host, 'otherPenalty', mode);
    await host.locator('.cell.val').nth(0).click();
    assert.equal(await judgeBtn(host, 0, '.red').textContent(), active, mode + ' am Zug');
    assert.equal(await judgeBtn(host, 1, '.red').textContent(), other, mode + ' andere');
    if (line) await ben.waitForFunction((t) => document.getElementById('splitInfo').textContent === t, line);
    else await ben.waitForFunction(() => document.getElementById('splitInfo').hidden);
    await host.click('#close');
    await host.click('#resetGame');
    await host.waitForSelector('#opt-otherPenalty:not(:disabled)');
  }
  // tatsächlich abziehen: Ben falsch bei „halb“ = −25
  await setOpt(host, 'otherPenalty', 'half');
  await host.locator('.cell.val').nth(0).click();
  await judgeBtn(host, 1, '.red').click();
  await host.waitForFunction(() => J.loadState().players[1].score === -25);
  assert.equal(await scores(host), '0,-25');
  assert.ok(anna);
  assert.deepEqual(env.errors, []);
});

test('Multiple Choice: otherPenalty × Keine Abgabe zählt wie falsch, Anteile beim Auflösen', async () => {
  const { host, anna } = await table({ splitScoring: true, otherShare: '50', otherPenalty: 'half', abstainPenalty: true },
    'Object.assign(s.rounds[0].categories[0].clues[0], { kind: "choice", a: "Richtig | Falsch | Falsch2" });');
  await host.locator('.cell.val').nth(0).click();
  await anna.waitForSelector('.mc-opt');
  await anna.click('.mc-opt:has-text("Richtig")');
  await host.waitForFunction(() => document.getElementById('special').textContent.includes('Anna') && document.getElementById('special').textContent.includes('✓ Richtig'));
  assert.match(await host.textContent('#special .srow >> nth=0'), /🎯/);
  await host.click('#resolveBtn');
  await host.waitForFunction(() => J.loadState().current.revealed);
  // Anna am Zug richtig +100, Ben ohne Abgabe: andere halber Abzug −25
  assert.equal(await scores(host), '100,-25');
  assert.match(await host.textContent('#special'), /\+100/);
  assert.match(await host.textContent('#special'), /−25/);
  assert.deepEqual(env.errors, []);
});

test('Multiple Choice: Richtige, die nicht am Zug sind, bekommen otherShare', async () => {
  const { host, anna, ben } = await table({ splitScoring: true, turnShare: '25', otherShare: '75' },
    'Object.assign(s.rounds[0].categories[0].clues[0], { kind: "choice", a: "Richtig | Falsch | Falsch2" });');
  await host.locator('.cell.val').nth(0).click();
  for (const p of [anna, ben]) { await p.waitForSelector('.mc-opt'); await p.click('.mc-opt:has-text("Richtig")'); }
  await host.waitForFunction(() => document.querySelectorAll('#special .srow').length === 2 && !document.getElementById('special').textContent.includes('wartet'));
  await host.click('#resolveBtn');
  await host.waitForFunction(() => J.loadState().current.revealed);
  assert.equal(await scores(host), '25,75');
  assert.deepEqual(env.errors, []);
});

test('Schätzfrage: Zweitnächster bekommt 25 % (Anzeige auf dem TV)', async () => {
  const src = 'Object.assign(s.rounds[0].categories[0].clues[0], { kind: "estimate", a: "42" });';
  const { host, anna, ben, tv } = await table({ splitScoring: true, estimateRunnerUp: '25' }, src);
  await host.locator('.cell.val').nth(0).click();
  for (const [p, v] of [[anna, '42'], [ben, '40']]) { await p.fill('#estInput', v); await p.press('#estInput', 'Enter'); }
  await tv.waitForFunction(() => document.querySelector('.special-status').textContent === '🔢 2/2 haben getippt');
  await tv.waitForFunction(() => document.getElementById('splitInfo').textContent === 'Zweitnächster: 25 %');
  await host.click('#resolveBtn');
  await host.waitForFunction(() => J.loadState().current.revealed);
  assert.equal(await scores(host), '100,25');
  assert.deepEqual(env.errors, []);
});

test('Schätzfrage ohne Hauptschalter: Zweitnächster bekommt nichts', async () => {
  const src = 'Object.assign(s.rounds[0].categories[0].clues[0], { kind: "estimate", a: "42" }); s.options = { estimateRunnerUp: "50" };';
  const { host, anna, ben } = await table({}, src);
  await host.locator('.cell.val').nth(0).click();
  for (const [p, v] of [[anna, '42'], [ben, '40']]) { await p.fill('#estInput', v); await p.press('#estInput', 'Enter'); }
  await host.waitForFunction(() => document.getElementById('special').textContent.includes('40'));
  await host.click('#resolveBtn');
  await host.waitForFunction(() => J.loadState().current.revealed);
  assert.equal(await scores(host), '100,0');
  assert.deepEqual(env.errors, []);
});

test('Klauen 25 % und 75 %: Handy-Hinweis, Host-Knopf, Punktestand', async () => {
  for (const [share, gain] of [['25', 25], ['75', 75]]) {
    const { host, ben } = await table({ splitScoring: true, stealShare: share });
    await host.locator('.cell.val').nth(0).click();
    await judgeBtn(host, 0, '.red').click();
    await ben.waitForSelector('#buzzer.live');
    assert.equal(await ben.textContent('#buzzInfo'), `Klauen bringt +${gain}`, share);
    assert.equal(await judgeBtn(host, 1, '.green').textContent(), `✓ +${gain}`);
    await judgeBtn(host, 1, '.green').click();
    await host.waitForFunction((g) => J.loadState().players[1].score === g, gain);
    assert.equal(await scores(host), `-50,${gain}`);
  }
  assert.deepEqual(env.errors, []);
});

test('stealHalf aus ohne Hauptschalter: Klauen bringt den vollen Wert; Schalter an übernimmt 100 % als Vorgabe', async () => {
  const { host, ben } = await table({ stealHalf: false });
  await host.locator('.cell.val').nth(0).click();
  await judgeBtn(host, 0, '.red').click();
  await ben.waitForSelector('#buzzer.live');
  assert.equal(await ben.textContent('#buzzInfo'), 'Klauen bringt +100');
  await host.click('#cancel');
  await setOpt(host, 'splitScoring', true);
  assert.equal(await host.inputValue('#opt-stealShare'), '100');
  assert.deepEqual(env.errors, []);
});

test('Host erzwingt: Regeln sind nach dem ersten Feld gesperrt, Teilwerte ändern nichts mehr', async () => {
  const { host } = await table({ splitScoring: true, otherShare: '50' });
  await host.locator('.cell.val').nth(0).click();
  await judgeBtn(host, 0, '.green').click();
  await host.waitForFunction(() => J.loadState().players[0].score === 100);
  await host.click('#close');
  assert.equal(await host.locator('#opt-otherShare').isDisabled(), true);
  await host.evaluate(() => { document.getElementById('opt-otherShare').disabled = false; });
  await host.selectOption('#opt-otherShare', '0');
  assert.equal(await host.evaluate(() => J.loadState().options.otherShare), '50');
  assert.deepEqual(env.errors, []);
});
