// Katalog im Editor: durchsuchen, filtern, Vorschau, Kategorie einfügen, Spiel automatisch
// zusammenstellen und im Host-Pult laden (lokal und über das Relay mit Host-Passwort).
const test = require('node:test');
const assert = require('node:assert/strict');
const { TRANSPORT, HOST_PASSWORD, startEnv } = require('./helpers');

const SERVER = TRANSPORT === 'relay';
let env;
test.before(async () => { env = await startEnv(); });
test.after(async () => { await env.stop(); });

const settle = (page) => page.waitForTimeout(1200);
const cats = (page) => page.$$eval('.ed-cat > input', (els) => els.map((e) => e.value));

async function unlock(page) {
  if (!SERVER) return;
  await page.waitForSelector('#pwForm:not([hidden])');
  await page.fill('#hostPw', HOST_PASSWORD);
  await page.click('#pwForm button');
  await page.waitForSelector('#pwForm', { state: 'hidden' });
}
const rows = (page) => page.$$eval('#catList .cat-row', (els) => els.map((e) => e.querySelector('strong').textContent));

test('Katalog durchsuchen, einfügen und Spiel automatisch zusammenstellen', async (t) => {
  const ed = await env.page();
  await ed.goto(env.base + '/editor.html');
  await ed.evaluate(() => localStorage.clear());
  await ed.reload();
  await unlock(ed);
  await ed.waitForFunction(() => !document.getElementById('setSelect').disabled);
  await ed.click('#setCatalog');
  await ed.waitForSelector('#catList .cat-row');

  await t.test('Filter nach Runde, Thema, Fragenart und Text', async () => {
    const all = (await rows(ed)).length;
    assert.ok(all >= 36);
    await ed.selectOption('#catLevel', 'runde2');
    const r2 = await rows(ed);
    assert.ok(r2.length >= 16 && r2.length < all);
    await ed.selectOption('#catLevel', '');
    await ed.selectOption('#catType', 'choice');
    const mc = await rows(ed);
    assert.ok(mc.length > 0 && mc.length < all);
    await ed.selectOption('#catType', '');
    await ed.fill('#catText', 'tiere');
    assert.ok((await rows(ed)).includes('Tiere'));
    await ed.fill('#catText', 'gibtesnicht');
    assert.match(await ed.textContent('#catList'), /Keine Kategorie passt/);
    await ed.fill('#catText', '');
    const tag = await ed.$$eval('#catTag option', (o) => o[1].value);
    await ed.selectOption('#catTag', tag);
    assert.ok((await rows(ed)).length < all);
    await ed.selectOption('#catTag', '');
  });

  await t.test('Vorschau zeigt Fragen und Antworten', async () => {
    await ed.fill('#catText', 'tiere');
    await ed.click('#catList .cat-row[data-file="tiere.json"] .cat-view');
    await ed.waitForSelector('#catList .cat-row[data-file="tiere.json"] .cat-preview li');
    assert.equal(await ed.locator('.cat-preview li').count(), 5);
    assert.match(await ed.textContent('.cat-preview li'), /Welpe/);
  });

  await t.test('Kategorie wird in Runde 2 ab Platz 3 eingefügt', async () => {
    await ed.check('#catList .cat-row[data-file="tiere.json"] input[type=checkbox]');
    await ed.selectOption('#catRound', '1');
    await ed.selectOption('#catSlot', { value: '2' });
    await ed.click('#catInsert');
    await ed.waitForFunction(() => document.getElementById('catMsg').textContent.includes('eingefügt'));
    await ed.click('.tabs button[data-round="1"]');
    assert.equal((await cats(ed))[2], 'Tiere');
    assert.match(await ed.locator('.ed-cat').nth(2).locator('textarea').nth(0).inputValue(), /Jungtier/);
    await settle(ed);
  });

  await t.test('Einfügen ohne Auswahl meldet sich', async () => {
    await ed.click('#catInsert');
    assert.match(await ed.textContent('#catMsg'), /ankreuzen/);
  });

  await t.test('Automatisches Spiel: neues Set, 6+6 Kategorien, ohne Wiederholung', async () => {
    await ed.fill('#catText', '');
    ed.nextDialog = 'Auto 1';
    await ed.click('#catAuto');
    await ed.waitForFunction(() => document.getElementById('setSelect').selectedOptions[0]?.textContent === 'Auto 1');
    const r1 = await cats(ed);
    await ed.click('.tabs button[data-round="1"]');
    const r2 = await cats(ed);
    assert.equal(r1.length, 6);
    assert.equal(r2.length, 6);
    assert.equal(new Set([...r1, ...r2]).size, 12);
    const level = await ed.evaluate(async ([a, b]) => {
      const idx = await (await fetch('catalog/index.json')).json();
      const lv = (n) => idx.find((e) => e.name === n).level;
      return [a.map(lv), b.map(lv)];
    }, [r1, r2]);
    assert.ok(level[0].every((l) => l === 'runde1') && level[1].every((l) => l === 'runde2'));
    await settle(ed);

    // Zweites Spiel: kein Treffer aus dem ersten (Katalog hat genug frische Kategorien)
    ed.nextDialog = 'Auto 2';
    await ed.click('#catAuto');
    await ed.waitForFunction(() => document.getElementById('setSelect').selectedOptions[0]?.textContent === 'Auto 2');
    const again = [...(await cats(ed))];
    await ed.click('.tabs button[data-round="1"]');
    again.push(...(await cats(ed)));
    // Runde 1 stand nach dem Wechsel zuerst im Editor
    assert.ok(again.every((n) => ![...r1, ...r2].includes(n)), 'Kategorien wiederholt: ' + again);
    await settle(ed);
  });

  await t.test('Das Spiel lässt sich im Host-Pult laden', async () => {
    const names = await ed.evaluate(() => J.loadSet().rounds[0].categories.map((c) => c.name));
    await ed.click('a.btn.primary[href="host.html"]');
    await ed.waitForSelector('#board .cell.cat');
    assert.deepEqual(await ed.$$eval('#board .cell.cat', (els) => els.map((e) => e.textContent)), names);
    assert.equal(await ed.locator('#board .cell.val').count(), 30);
  });

  await t.test('Fehler beim Laden zeigt eine deutsche Meldung', async () => {
    const p = await env.page();
    await p.route('**/catalog/index.json', (r) => r.fulfill({ status: 500, body: 'x' }));
    await p.goto(env.base + '/editor.html');
    await unlock(p);
    await p.waitForFunction(() => !document.getElementById('setSelect').disabled);
    await p.click('#setCatalog');
    await p.waitForFunction(() => document.getElementById('catMsg').textContent.includes('Fehler 500'));
    assert.match(await p.textContent('#catMsg'), /Katalog konnte nicht geladen werden/);
    await p.unroute('**/catalog/index.json');
    await p.click('#catRetry');
    await p.waitForSelector('#catList .cat-row');
  });

  assert.deepEqual(env.errors, []);
});
