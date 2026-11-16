// Kategorien-Werkstatt im Editor: kopieren, mischen, Datei-Export/-Import (lokal und übers Relay mit Host-Passwort)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { TRANSPORT, HOST_PASSWORD, startEnv, trackText, textSeen, textMark } = require('./helpers');

const SERVER = TRANSPORT === 'relay';
let env;
test.before(async () => { env = await startEnv(); });
test.after(async () => { await env.stop(); });

const options = (page) => page.$$eval('#setSelect option', (els) => els.map((o) => (o.selected ? '*' : '') + o.textContent));
const cats = (page) => page.$$eval('.ed-cat > input', (els) => els.map((e) => e.value));

async function unlock(page) {
  if (!SERVER) return;
  await page.waitForSelector('#pwForm:not([hidden])');
  await page.fill('#hostPw', HOST_PASSWORD);
  await page.click('#pwForm button');
  await page.waitForSelector('#pwForm', { state: 'hidden' });
}
async function ready(page) {
  await page.waitForFunction(() => !document.getElementById('setSelect').disabled);
}
async function newSet(page, name, firstCat) {
  page.nextDialog = name;
  await page.click('#setNew');
  await page.waitForFunction((n) => document.getElementById('setSelect').selectedOptions[0]?.textContent === n, name);
  await page.fill('.ed-cat input', firstCat);
}
async function openPanel(page, source) {
  if (await page.isHidden('#mixPanel')) await page.click('#setCopy');
  await page.waitForSelector('#mixPanel:not([hidden])');
  await page.selectOption('#mixSource', { label: source });
  await page.waitForSelector('#mixCats label');
}
const tick = (page, round, cat) => page.check(`#mixCats input[data-round="${round}"][data-cat="${cat}"]`);

test('Kategorien kopieren, mischen, exportieren und importieren', async (t) => {
  const ed = await env.page();
  await ed.goto(env.base + '/editor.html');
  await ed.evaluate(() => localStorage.clear());
  await ed.reload();
  await unlock(ed);
  await ready(ed);
  await trackText(ed, '#saved');
  let savedMark = 0;

  // Set „Quelle“ mit Spezialfrage, Notiz und Bild in der ersten Kategorie
  await newSet(ed, 'Quelle', 'Tiere');
  await ed.locator('.ed-clue').nth(1).locator('select.ed-kind').selectOption('choice');
  await ed.locator('.ed-clue').nth(1).locator('input').nth(0).fill('Richtig | A | B | C');
  await ed.locator('.ed-clue').nth(1).locator('.note-field').fill('Notiz-Test');
  await ed.locator('.ed-clue').nth(1).locator('input[placeholder="Bild-Link (optional)"]').fill('https://example.com/t.png');
  await ed.locator('.ed-clue').nth(1).locator('input[placeholder="Bild-Link (optional)"]').dispatchEvent('change');
  await ed.locator('.ed-cat > input').nth(1).fill('Pflanzen');

  await newSet(ed, 'Ziel', 'Eigene');

  await t.test('Kopieren in Runde 2 ab Platz 3 übernimmt alle Felder', async () => {
    await openPanel(ed, 'Quelle');
    await tick(ed, 0, 0);
    await tick(ed, 0, 1);
    await ed.click('#mixAdd');
    await ed.selectOption('#mixRound', '1');
    assert.deepEqual(await ed.$$eval('#mixSlot option', (o) => o.map((x) => x.value)), ['0', '1', '2', '3', '4']);
    await ed.selectOption('#mixSlot', { value: '2' });
    await ed.click('#mixInsert');
    await ed.waitForFunction(() => document.getElementById('mixError').textContent === 'Kopiert ✓');
    await ed.click('.tabs button[data-round="1"]');
    const names = await cats(ed);
    assert.equal(names[2], 'Tiere');
    assert.equal(names[3], 'Pflanzen');
    // zweite Zeile der dritten Spalte
    const col = ed.locator('.ed-cat').nth(2).locator('.ed-clue').nth(1);
    assert.equal(await col.locator('select.ed-kind').inputValue(), 'choice');
    assert.equal(await col.locator('.note-field').inputValue(), 'Notiz-Test');
    assert.equal(await col.locator('.ed-img img').getAttribute('src'), 'https://example.com/t.png');
  });

  await t.test('Mischen legt neues Set aus mehreren Sets an', async () => {
    await openPanel(ed, 'Quelle');
    await tick(ed, 0, 1);
    await ed.click('#mixAdd');
    await openPanel(ed, 'Ziel (dieses Set)');
    await tick(ed, 0, 0);
    await ed.click('#mixAdd');
    assert.equal(await ed.locator('.mix-pick').count(), 2);
    ed.nextDialog = 'Mischung';
    await ed.click('#mixCreate');
    await ed.waitForFunction(() => document.getElementById('setSelect').selectedOptions[0]?.textContent === 'Mischung');
    await ed.click('.tabs button[data-round="0"]');
    assert.deepEqual((await cats(ed)).slice(0, 3), ['Pflanzen', 'Eigene', 'Kategorie 3']);
    assert.deepEqual(await options(ed), ['Mein Fragenset', '*Mischung', 'Quelle', 'Ziel']);
  });

  await t.test('Mischen ohne Auswahl und Überlauf zeigen eine Meldung', async () => {
    await ed.click('#mixAdd');
    assert.match(await ed.textContent('#mixError'), /ankreuzen/);
    await ed.click('#mixCreate');
    assert.match(await ed.textContent('#mixError'), /Keine Kategorie/);
  });

  await t.test('Export als Datei und Import in neues Set', async () => {
    await openPanel(ed, 'Quelle');
    const [download] = await Promise.all([ed.waitForEvent('download'), ed.click('#export')]);
    const file = await download.path();
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(text).rounds[0].categories[0].name, 'Pflanzen');
    await ed.setInputFiles('#importFile', { name: 'mix.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await ed.waitForFunction(() => document.getElementById('setSelect').options.length === 5);
    assert.equal((await cats(ed))[0], 'Pflanzen');
  });

  await t.test('Ungültige und zu große Dateien werden mit deutscher Meldung abgelehnt', async () => {
    const msgs = [];
    ed.on('dialog', (d) => msgs.push(d.message()));
    const before = (await options(ed)).length;
    for (const buffer of [Buffer.from('{kaputt'), Buffer.from('{"foo":1}'), Buffer.alloc(4_100_000, 'a')]) {
      const n = msgs.length;
      await ed.setInputFiles('#importFile', { name: 'x.json', mimeType: 'application/json', buffer });
      while (msgs.length === n) await ed.waitForTimeout(50);
      await ed.waitForFunction((n) => n >= 0, msgs.length);
    }
    await ed.waitForTimeout(300);
    assert.match(msgs[0], /Import fehlgeschlagen: Datei ist kein gültiges JSON/);
    assert.match(msgs[1], /Kein gültiges Fragenset/);
    assert.match(msgs[2], /zu groß/);
    assert.equal((await options(ed)).length, before);
  });

  await t.test('Kategorien aus Datei als Quelle', async () => {
    const data = await ed.evaluate(() => { const s = J.defaultSet(); s.title = 'Fremd'; s.rounds[0].categories[0].name = 'Aus Datei'; return JSON.stringify(s); });
    await ed.click('.tabs button[data-round="0"]');
    if (await ed.isHidden('#mixPanel')) await ed.click('#setCopy');
    await ed.setInputFiles('#mixFileInput', { name: 'fremd.json', mimeType: 'application/json', buffer: Buffer.from(data) });
    await ed.waitForFunction(() => document.getElementById('mixSource').selectedOptions[0]?.textContent.includes('Fremd'));
    await ed.waitForSelector('#mixCats label');
    await tick(ed, 0, 0);
    await ed.click('#mixAdd');
    await ed.selectOption('#mixRound', '0');
    await ed.selectOption('#mixSlot', { value: '4' });
    savedMark = await textMark(ed, '#saved');
    await ed.click('#mixInsert');
    await ed.waitForFunction(() => document.querySelectorAll('.ed-cat > input')[4].value === 'Aus Datei');
  });

  if (SERVER) {
    await t.test('Kopierte Kategorien liegen auf dem Server (anderes Gerät)', async () => {
      // Die Speicherung läuft verzögert im Hintergrund: auf die Bestätigung der Seite warten, nicht raten
      await textSeen(ed, '#saved', /Auf dem Server gespeichert/, savedMark);
      const other = await env.page();
      await other.goto(env.base + '/editor.html');
      await unlock(other);
      await ready(other);
      await other.selectOption('#setSelect', await ed.$eval('#setSelect', (e) => e.value)); // Name nicht eindeutig (Import heißt auch „Mischung“)
      await other.waitForFunction(() => document.querySelector('.ed-cat input').value === 'Pflanzen');
      assert.equal((await cats(other))[4], 'Aus Datei');
    });
  }

  assert.deepEqual(env.errors, []);
});
