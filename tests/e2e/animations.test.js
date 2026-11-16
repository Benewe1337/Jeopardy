// Animationen: Zoom aus dem Feld, Richtig/Falsch-Effekt, Punkte zählen hoch,
// Buzz-Einblendung und Timer-Sound auf der TV-Ansicht
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer, trackUi, uiSeen } = require('./helpers');

let env;
test.before(async () => { env = await startEnv({ JEOP_BUZZ_DELAY_MS: 200, JEOP_TIMER_MS: 3000 }); });
test.after(async () => { await env.stop(); });

const hasClass = (page, sel, cls) => page.$eval(sel, (e, c) => e.classList.contains(c), cls);

test('Animationen auf Handy und TV', async (t) => {
  const { host, code } = await openHost(env, { names: ['Anna', 'Ben'] });
  const anna = await env.page({ viewport: { width: 1280, height: 800 }, extraInit: { JEOP_COUNT_MS: 600 } });
  await anna.goto(env.base + '/player.html?room=' + code);
  await anna.waitForSelector('#picker:not([hidden])');
  await anna.click('.pick:has-text("Anna")');
  const ben = await joinPlayer(env, code, { pick: 'Ben' });
  const tv = await joinPlayer(env, code, { viewport: { width: 1280, height: 720 } });
  await tv.click('#tvView');
  await tv.evaluate(() => {
    window.__music = [];
    let on = false;
    J.startTimerMusic = (ms) => { on = true; window.__music.push('start:' + Math.round(ms / 1000)); };
    J.stopTimerMusic = () => { on = false; window.__music.push('stop'); };
    J.timerMusicOn = () => on;
  });
  await host.waitForFunction(() => document.querySelectorAll('#players .device').length === 2);
  // Kurzlebige Effekte werden aufgezeichnet statt per Polling erhascht (siehe helpers.trackUi)
  for (const pg of [anna, tv, ben]) await trackUi(pg);

  await t.test('Anzeige-Texte sind nicht markierbar, Eingabefelder schon', async () => {
    const sel = (page, q) => page.$eval(q, (e) => getComputedStyle(e).userSelect || getComputedStyle(e).webkitUserSelect);
    for (const q of ['.intro-title', '#board', '#q', '#scores']) assert.equal(await sel(tv, q), 'none', q);
    assert.equal(await sel(host, '#board'), 'none');
    assert.notEqual(await sel(anna, '#pickerName'), 'none');
  });

  await t.test('Frage zoomt aus dem Feld', async () => {
    // Die Inline-Transition steht nur während des Zooms am Element: mitschreiben
    await anna.evaluate(() => {
      const ov = document.getElementById('overlay');
      window.__transitions = [];
      new MutationObserver(() => window.__transitions.push(ov.style.transition))
        .observe(ov, { attributes: true, attributeFilter: ['style'] });
    });
    await host.locator('.cell.val').nth(3).click();
    await uiSeen(anna, '#overlay.zoom-in');
    assert.ok((await anna.evaluate(() => window.__transitions)).some((x) => /transform/.test(x)), 'Zoom nutzt transform');
    await anna.waitForSelector('#overlay.show:not(.zoom-in)'); // Endzustand, nicht der Moment
    assert.equal(await anna.$eval('#overlay', (o) => o.style.transform), '', 'Zoom räumt auf');
  });

  await t.test('Falsch: roter Wackler, Kachel rot, verschwindet wieder', async () => {
    await host.locator('.jrow').nth(1).locator('.red').click(); // Ben falsch
    await uiSeen(anna, '#overlay.fx-wrong');
    await uiSeen(anna, '#overlayScores .fx-down');
    await anna.waitForSelector('#overlay:not(.fx-wrong)');
  });

  await t.test('Buzz-Einblendung nur auf dem TV', async () => {
    await anna.waitForSelector('#buzzer.live');
    await anna.waitForTimeout(250); // Untergrenze: erst nach der Mindest-Reaktionszeit drücken (länger schadet nicht)
    await anna.click('#buzzer');
    await uiSeen(tv, '#buzzShow.go');
    assert.equal(await tv.textContent('.buzz-show-name'), '⚡ Anna');
    assert.ok(!(await hasClass(anna, '#buzzShow', 'go')), 'nicht am Handy');
  });

  await t.test('Richtig: grüner Puls, Punkte zählen hoch', async () => {
    // Die Zählanimation läuft auf Echtzeit (rAF) und ließe sich unter Last nicht fest beobachten:
    // Uhr und rAF der Seite werden für diesen Schritt von Hand getaktet.
    await anna.evaluate(() => {
      const real = { raf: window.requestAnimationFrame, now: performance.now.bind(performance) };
      const queue = [];
      let t = real.now();
      window.__clock = {
        queue,
        advance(ms) { t += ms; queue.splice(0).forEach((cb) => cb(t)); },
        restore() { window.requestAnimationFrame = real.raf; performance.now = real.now; },
      };
      window.requestAnimationFrame = (cb) => queue.push(cb);
      performance.now = () => t;
    });
    await host.locator('.jrow.buzzed .green').click();
    await uiSeen(anna, '#overlay.fx-right');
    // Der Zähler startet beim alten Wert und wartet auf den nächsten Frame
    await anna.waitForFunction(() => window.__clock.queue.length > 0, null, { polling: 50 });
    const at = (ms) => anna.evaluate((d) => {
      window.__clock.advance(d);
      return document.querySelector('#overlayScores .score-value').textContent;
    }, ms);
    // Klauen: 100 / 2 = 50 (Dauer 600 ms)
    const mid = await at(150);
    assert.ok(mid !== '0' && mid !== '50' && +mid > 0 && +mid < 50, 'Zwischenwert: ' + mid);
    assert.equal(await at(1000), '50');
    await anna.evaluate(() => window.__clock.restore());
  });

  await t.test('Timer-Sound läuft auf dem TV und stoppt', async () => {
    await host.click('#timerBtn');
    await uiSeen(anna, '#timerBox:shown');
    await tv.waitForFunction(() => window.__music.some((m) => m.startsWith('start:')));
    await host.click('#timerStop');
    await tv.waitForFunction(() => window.__music.at(-1) === 'stop');
    assert.equal((await tv.evaluate(() => window.__music)).filter((m) => m.startsWith('start')).length, 1);
    // Handys spielen keinen Timer-Sound
    assert.ok(!(await ben.evaluate(() => J.timerMusicOn())));
  });

  assert.deepEqual(env.errors, []);
});

