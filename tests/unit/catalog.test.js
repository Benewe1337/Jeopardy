// Öffentlicher Fragenkatalog (catalog/): Form, Quellen, Eindeutigkeit und Index.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadCommon } = require('./load-common');
const { J } = loadCommon();

const DIR = path.resolve(__dirname, '../../catalog');
const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const cats = index.map((e) => ({ e, data: JSON.parse(fs.readFileSync(path.join(DIR, e.file), 'utf8')) }));
const LEVELS = ['runde1', 'runde2'];

test('Katalog hat mindestens 36 Kategorien, etwa je zur Hälfte pro Level', () => {
  assert.ok(cats.length >= 36);
  const r1 = cats.filter((c) => c.data.level === 'runde1').length;
  assert.ok(r1 >= 16 && cats.length - r1 >= 16, `Verteilung ${r1}/${cats.length - r1}`);
});

test('index.json passt zu den Dateien im Ordner', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
  assert.deepEqual(index.map((e) => e.file).sort(), files);
  for (const { e, data } of cats) {
    assert.equal(e.name, data.name);
    assert.equal(e.level, data.level);
    assert.deepEqual(e.tags, data.tags);
    assert.deepEqual(e.types, [...new Set(data.clues.map((c) => c.kind).filter(Boolean))].sort(), `types ${e.file}`);
  }
});

test('jede Kategorie hat Name, Level, Tags und 5 vollständige Fragen mit Quelle', () => {
  const names = new Set();
  for (const { e, data } of cats) {
    assert.ok(data.name && !names.has(data.name), `Name fehlt/doppelt: ${e.file}`);
    names.add(data.name);
    assert.ok(LEVELS.includes(data.level), `Level: ${e.file}`);
    assert.ok(Array.isArray(data.tags) && data.tags.length > 0 && data.tags.every((t) => t === t.toLowerCase()));
    assert.equal(data.clues.length, 5, e.file);
    for (const c of data.clues) {
      assert.ok(c.q.trim() && c.a.trim(), `leer in ${e.file}`);
      assert.equal(c.img, '', 'Katalog enthält keine Bilder');
      assert.match(c.note, /Quelle: https?:\/\/\S+/, `Quelle fehlt in ${e.file}: ${c.q}`);
      if (c.kind) assert.ok(J.CLUE_KINDS.includes(c.kind), `Frageart ${c.kind}`);
      if (c.kind === 'estimate') assert.ok(Number.isFinite(J.parseNumber(c.a)), `Schätzwert: ${c.a}`);
      if (c.kind === 'order' || c.kind === 'choice') {
        const parts = c.a.split('|').map((s) => s.trim());
        assert.ok(parts.length >= 3 && parts.every(Boolean), `Optionen: ${c.a}`);
        assert.equal(new Set(parts).size, parts.length);
      }
    }
  }
});

test('keine Antwort kommt im ganzen Katalog zweimal vor', () => {
  const seen = new Map();
  for (const { e, data } of cats) {
    for (const c of data.clues) {
      const key = c.a.trim().toLowerCase();
      assert.ok(!seen.has(key), `doppelte Antwort "${c.a}" in ${e.file} und ${seen.get(key)}`);
      seen.set(key, e.file);
    }
  }
});

test('Kategorien passen in ein normalizeSet-Spiel (Name, Fragen, Fragenart bleiben erhalten)', () => {
  const set = { title: 't', rounds: [{ categories: cats.slice(0, 6).map((c) => c.data) }, { categories: [] }] };
  const out = J.normalizeSet(set);
  out.rounds[0].categories.forEach((cat, i) => {
    const src = cats[i].data;
    assert.equal(cat.name, src.name);
    src.clues.forEach((cl, r) => {
      assert.equal(cat.clues[r].q, cl.q);
      assert.equal(cat.clues[r].a, cl.a);
      assert.equal(cat.clues[r].kind, cl.kind);
    });
  });
});
