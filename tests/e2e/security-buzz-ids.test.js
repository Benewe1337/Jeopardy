// Sicherheit: Buzzer-Zeit wird am Host gemessen; Geräte-ID/Raumcode sind zufällig; Plätze sind gebunden
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => {
  env = await startEnv({ JEOP_TIMER_MS: 2500, JEOP_BUZZ_DELAY_MS: 400, JEOP_BUZZ_WINDOW_MS: 1500 });
});
test.after(async () => { await env.stop(); });

const press = (pg) => pg.evaluate(() => document.getElementById('buzzer')
  .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })));

test('Gefälschte Mini-Reaktionszeit gewinnt nicht gegen ehrlich schnelleren Spieler', async () => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben', 'Cem'] });
  const cheat = await joinPlayer(env, code, { pick: 'Anna' });
  const honest = await joinPlayer(env, code, { pick: 'Ben' });
  await joinPlayer(env, code, { pick: 'Cem' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 3);
  await host.locator('.cell.val').first().click();
  await cheat.waitForSelector('#overlay.show');
  await cheat.waitForSelector('#buzzer.wait');
  await honest.waitForSelector('#buzzer.wait');
  // Cem liegt falsch -> neue Buzzer-Runde für Anna und Ben
  await host.locator('.jrow').nth(2).locator('.red').click();
  // Uhren einfrieren: Cheater meldet 1 ms (Frühstart-Prüfung am Handy ausgehebelt), Ben ehrliche 300 ms
  const freeze = (pg) => pg.evaluate(() => {
    const base = performance.now(); let off = 0;
    performance.now = () => base + off;
    window.__react = (ms) => { off = ms; };
  });
  await freeze(cheat); await freeze(honest);
  await cheat.evaluate(() => { window.J.isEarly = () => false; });
  await cheat.waitForSelector('#buzzer.live');
  await honest.waitForSelector('#buzzer.live');
  await host.waitForTimeout(700); // seit dem Öffnen sind am Host > 300 ms vergangen
  await cheat.evaluate(() => window.__react(1));
  await honest.evaluate(() => window.__react(300));
  await press(cheat); // kommt zuerst an
  await press(honest);
  await host.waitForFunction(() => document.querySelector('.jrow.buzzed'));
  assert.equal(await host.textContent('.jrow.buzzed .name'), '⚡ Ben');
  assert.deepEqual(env.errors, []);
});

test('Geräte-ID: 128 Bit zufällig; Raumcode aus dem Alphabet', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  const p = await joinPlayer(env, code, {});
  const id = await p.evaluate(() => localStorage.getItem('jeopardy.device'));
  assert.match(id, /^[0-9a-f]{32}$/);
  await host.context().close();
  await p.context().close();
});

test('Platz eines getrennten Geräts nur für dieselbe ID oder per Host-Freigabe', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  const a = await joinPlayer(env, code, { pick: 'Anna' });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 1);
  const intruder = await joinPlayer(env, code, {});
  // Besitzer weg
  await a.context().close();
  // Fremdes Gerät erzwingt die Wahl von Anna (Knopf ggf. ausgegraut)
  const take = () => intruder.evaluate(() => {
    const btn = [...document.querySelectorAll('.pick')].find((b) => b.textContent === 'Anna');
    btn.disabled = false; btn.click();
  });
  await take();
  await intruder.waitForFunction(() => !document.getElementById('picker').hidden
    && /anderen Gerät/.test(document.getElementById('pickerError').textContent));
  assert.equal(await host.locator('#players .device').count() <= 1, true);
  // Host gibt frei (🔒 bzw. Gerät-Punkt) – danach darf das fremde Gerät
  await host.locator('#players .prow').first().locator('.seatlock, .device').click();
  await intruder.waitForFunction(() => {
    const b = [...document.querySelectorAll('.pick')].find((x) => x.textContent === 'Anna');
    return b && !b.disabled;
  });
  await intruder.click('.pick:text-is("Anna")');
  await intruder.waitForFunction(() => document.getElementById('me').textContent === 'Du: Anna');
  await host.context().close();
  await intruder.context().close();
});
