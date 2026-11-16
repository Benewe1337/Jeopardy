// QR-Einladung: Host-Pult zeigt Link + QR (offline erzeugt), Kopieren geht,
// der QR-Inhalt führt in den Raum, und die TV-Ansicht zeigt ihn bis zum Spielstart.
const test = require('node:test');
const assert = require('node:assert/strict');
const jsQR = require('jsqr');
const { startEnv, openHost, joinPlayer, HOST_PASSWORD, trackText, textSeen } = require('./helpers');

let env;
test.before(async () => { env = await startEnv(); });
test.after(async () => { await env.stop(); });

// SVG im Browser auf ein Canvas zeichnen und mit jsQR lesen (Weg wie bei einer Handy-Kamera)
async function scan(page, sel) {
  await page.waitForSelector(sel + ' svg'); // der QR wird erst nach dem Raumcode gezeichnet
  const img = await page.evaluate(async (s) => {
    const svg = document.querySelector(s + ' svg');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
    const im = new Image();
    await new Promise((r, j) => { im.onload = r; im.onerror = j; im.src = url; });
    const c = document.createElement('canvas');
    c.width = c.height = 400;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(im, 0, 0, 400, 400);
    return { w: 400, data: Array.from(ctx.getImageData(0, 0, 400, 400).data) };
  }, sel);
  const res = jsQR(Uint8ClampedArray.from(img.data), img.w, img.w);
  return res && res.data;
}

test('Host zeigt QR und Link; QR enthält den Link ohne Passwörter', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  const link = await host.textContent('#link');
  assert.equal(link, `${env.base}/player.html?room=${code}`);
  assert.equal(await scan(host, '#qr'), link);
  assert.ok(await host.isVisible('#qr svg'));
  assert.ok(!link.includes(HOST_PASSWORD));
  // Klick vergrößert, bleibt scanbar
  const small = (await host.locator('#qr').boundingBox()).width;
  await host.click('#qr');
  // Die Vergrößerung läuft als CSS-Übergang: auf die neue Breite warten statt sofort zu messen
  await host.waitForFunction((w) => document.getElementById('qr').getBoundingClientRect().width > w, small);
  await host.context().close();
});

test('Kopieren legt den Link in die Zwischenablage', async () => {
  const { host } = await openHost(env);
  await host.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.base });
  await host.bringToFront(); // Zwischenablage-Zugriff braucht den Fokus der Seite
  await trackText(host, '#copy'); // „Kopiert ✓“ ist nur kurz zu sehen
  await host.click('#copy');
  await textSeen(host, '#copy', /Kopiert ✓/);
  assert.equal(await host.evaluate(() => navigator.clipboard.readText()), await host.textContent('#link'));
  await host.context().close();
});

test('Gescannter Link öffnet die Spielerseite mit Raumcode – nur noch Namen wählen', async () => {
  const { host } = await openHost(env, { names: ['Anna'] });
  const scanned = await scan(host, '#qr');
  const p = await env.page({ viewport: { width: 390, height: 844 } });
  await p.goto(scanned);
  await p.waitForSelector('#picker:not([hidden])');
  await p.click('.pick:has-text("Anna")');
  await host.waitForFunction(() => document.getElementById('viewers').textContent.startsWith('1 '));
  await host.context().close();
  await p.context().close();
});

test('TV zeigt großen QR bis zum Spielstart, QR-Taste blendet ein und aus', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  const tv = await joinPlayer(env, code, { sfx: false });
  await tv.click('#tvView');
  await tv.waitForSelector('#invite:not([hidden])');
  assert.equal(await scan(tv, '#inviteQr'), `${env.base}/player.html?room=${code}`);
  assert.equal(await tv.textContent('#inviteCode'), code);

  await tv.click('#qrBtn'); // Taste liegt über dem Overlay (topright)
  await tv.waitForSelector('#invite', { state: 'hidden' });
  await tv.click('#qrBtn');
  await tv.waitForSelector('#invite:not([hidden])');

  // Erstes Feld öffnen: QR verschwindet von allein und kommt nicht wieder
  await tv.click('#qrBtn');
  await host.click('#board .cell.val >> nth=0');
  await tv.waitForSelector('#overlay.show');
  await tv.waitForSelector('#invite', { state: 'hidden' });
  await host.context().close();
  await tv.context().close();
});

test('Spieler (kein TV) sieht keinen QR-Overlay', async () => {
  const { host, code } = await openHost(env, { names: ['Anna'] });
  const p = await joinPlayer(env, code, { pick: 'Anna', sfx: false });
  await p.waitForSelector('#board:not([hidden])');
  assert.ok(await p.isHidden('#invite'));
  assert.ok(await p.isHidden('#qrBtn'));
  await host.context().close();
  await p.context().close();
});
