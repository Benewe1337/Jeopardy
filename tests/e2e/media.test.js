// Audio-/Video-Clips: Host steuert, TV spielt, Handys sehen nur den Hinweis
const test = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, openHost, joinPlayer } = require('./helpers');

let env;
test.before(async () => { env = await startEnv({ JEOP_BUZZ_DELAY_MS: 150 }); });
test.after(async () => { await env.stop(); });

// 30 s Stille als 8-kHz-WAV (lang genug, dass der Clip unter Last nie von selbst endet)
function wavDataUrl() {
  const n = 240000;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return 'data:audio/wav;base64,' + b.toString('base64');
}

for (const mode of ['single', 'team']) {
  test(`Clip: Host spielt, TV bekommt die Befehle, Handy zeigt nur den Hinweis (${mode})`, async (t) => {
    const wav = wavDataUrl();
    const { host, code } = await openHost(env, { mode, teamSize: mode === 'team' ? 2 : undefined, names: ['Anna', 'Ben'] });
    await host.evaluate((src) => {
      const s = JSON.parse(localStorage.getItem('jeopardy.set') || 'null') || J.defaultSet();
      s.rounds[0].categories[0].clues[0].media = src;
      s.rounds[0].categories[0].clues[0].mediaType = 'audio';
      localStorage.setItem('jeopardy.set', JSON.stringify(s));
    }, wav);
    await host.reload();
    await host.waitForFunction(() => document.getElementById('peerStatus').textContent === 'online');
    const code2 = await host.textContent('#code');

    const tv = await env.page({ viewport: { width: 1280, height: 720 } });
    await tv.goto(env.base + '/player.html?room=' + code2);
    await tv.waitForSelector('#picker:not([hidden])');
    await tv.click('#tvView');
    const phone = await joinPlayer(env, code2, mode === 'team' ? { pick: 'Anna', name: 'Maxi' } : { pick: 'Anna' });

    await host.locator('.cell.val').nth(0).click();
    await t.test('Host zeigt Steuerung, TV lädt Clip, Handy nur Hinweis', async () => {
      await host.waitForSelector('#mediaBox:not([hidden])');
      await tv.waitForFunction(() => !!document.getElementById('tvMedia').getAttribute('src'));
      await phone.waitForSelector('#mediaHint:not([hidden])');
      assert.match(await phone.textContent('#mediaHint'), /Clip läuft am TV/);
      assert.equal(await phone.locator('audio[src], video[src]').count(), 0, 'Handy rendert keine Medien');
      assert.ok(await phone.evaluate(() => !document.documentElement.innerHTML.includes('data:audio')));
      assert.ok(await tv.evaluate(() => document.getElementById('tvMedia').paused), 'kein Autoplay');
    });
    await t.test('Play, Pause und Neustart wirken auf dem TV', async () => {
      // Medien-Ereignisse mitschreiben: der Test wartet auf 'play'/'pause'/'seeked' selbst, nicht auf Momentwerte
      await tv.evaluate(() => {
        const el = document.getElementById('tvMedia');
        const log = window.__mediaLog = [];
        ['play', 'playing', 'pause', 'seeked'].forEach((type) => el.addEventListener(type, () => log.push(type)));
      });
      const seen = (type, from) => tv.waitForFunction(([ty, n]) => window.__mediaLog.slice(n).includes(ty), [type, from]);
      const mark = () => tv.evaluate(() => window.__mediaLog.length);
      let m = await mark();
      await host.click('#mediaPlay');
      await seen('playing', m);
      assert.equal(await tv.evaluate(() => document.getElementById('tvMedia').paused), false);
      m = await mark();
      await host.click('#mediaPlay');
      await seen('pause', m);
      assert.equal(await tv.evaluate(() => document.getElementById('tvMedia').paused), true);
      m = await mark();
      await host.click('#mediaPlay');
      await seen('playing', m);
      await tv.waitForFunction(() => document.getElementById('tvMedia').currentTime > 0.2);
      m = await mark();
      await host.click('#mediaRestart');
      await seen('seeked', m); // Sprung auf 0 kam an
      await tv.waitForFunction(() => !document.getElementById('tvMedia').paused);
      await host.click('#mediaMute');
      assert.ok(await host.evaluate(() => document.getElementById('hostMedia').muted));
    });
    await t.test('Frage schließen stoppt den Clip, Antwort erscheint nie im Handy-Clip', async () => {
      await host.click('#cancel');
      await tv.waitForFunction(() => !document.getElementById('tvMedia').getAttribute('src') && document.getElementById('tvMediaBox').hidden);
      await phone.waitForSelector('#mediaHint', { state: 'hidden' });
    });
    await t.test('TV, der später beitritt, bekommt den laufenden Clip nachgereicht', async () => {
      await host.locator('.cell.val').nth(0).click();
      await host.waitForSelector('#mediaBox:not([hidden])');
      const tv2 = await env.page({ viewport: { width: 1280, height: 720 } });
      await tv2.goto(env.base + '/player.html?room=' + code2);
      await tv2.waitForSelector('#picker:not([hidden])');
      await tv2.click('#tvView');
      await tv2.waitForFunction(() => !!document.getElementById('tvMedia').getAttribute('src'));
    });
    assert.deepEqual(env.errors, []);
  });
}
