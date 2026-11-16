// Automatische Spielzusammenstellung aus dem Katalog (js/catalog-gen.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('../../js/catalog-gen.js');
const { loadCommon } = require('./load-common');
const { J } = loadCommon();

const DIR = path.resolve(__dirname, '../../catalog');
const index = G.parseIndex(JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')));
const names = (p) => p.rounds.map((r) => r.map((e) => e.name));

test('parseIndex verwirft kaputte Einträge und normalisiert Tags', () => {
  const out = G.parseIndex([{ file: 'a.json', name: 'A', level: 'runde1', tags: ['Natur'] }, { file: '../x.json', name: 'X', level: 'runde1' },
    { file: 'b.json', name: 'B', level: 'egal' }, null]);
  assert.deepEqual(out.map((e) => e.name), ['A']);
  assert.deepEqual(out[0].tags, ['natur']);
  assert.throws(() => G.parseIndex({}), /unerwartetes Format/);
});

test('pickGame: 6 Kategorien je Runde, richtiges Level, keine Doppelten', () => {
  const p = G.pickGame(index, { seed: 1 });
  assert.equal(p.rounds.length, 2);
  p.rounds.forEach((r, i) => {
    assert.equal(r.length, 6);
    assert.ok(r.every((e) => e.level === G.LEVELS[i]));
  });
  const all = p.rounds.flat().map((e) => e.file);
  assert.equal(new Set(all).size, 12);
  assert.equal(p.repeated, 0);
});

test('pickGame ist mit gleichem Seed deterministisch, mit anderem Seed anders', () => {
  assert.deepEqual(names(G.pickGame(index, { seed: 42 })), names(G.pickGame(index, { seed: 42 })));
  const seeds = [1, 2, 3, 4].map((s) => JSON.stringify(names(G.pickGame(index, { seed: s }))));
  assert.ok(new Set(seeds).size > 1);
});

test('pickGame meidet bereits benutzte Kategorien, solange genug andere da sind', () => {
  const first = G.pickGame(index, { seed: 7 });
  const exclude = first.rounds.flat().map((e) => e.name.toUpperCase());
  const second = G.pickGame(index, { seed: 7, exclude });
  assert.equal(second.repeated, 0);
  const used = new Set(exclude.map((n) => n.toLowerCase()));
  assert.ok(second.rounds.flat().every((e) => !used.has(e.name.toLowerCase())));
});

test('pickGame nimmt Wiederholungen nur als Auffüller und meldet sie', () => {
  const r1 = index.filter((e) => e.level === 'runde1');
  const exclude = r1.slice(0, r1.length - 4).map((e) => e.name); // nur 4 frische in Runde 1
  const p = G.pickGame(index, { seed: 3, exclude });
  assert.equal(p.rounds[0].length, 6);
  assert.equal(p.repeated, 2);
  assert.equal(p.rounds[0].filter((e) => !exclude.includes(e.name)).length, 4);
});

test('pickGame bevorzugt Kategorien mit dem Wunsch-Tag', () => {
  const tag = 'film';
  const matching = (lvl) => index.filter((e) => e.level === lvl && e.tags.includes(tag)).length;
  const p = G.pickGame(index, { seed: 5, tags: [tag] });
  p.rounds.forEach((r, i) => {
    const want = Math.min(6, matching(G.LEVELS[i]));
    assert.ok(r.filter((e) => e.tags.includes(tag)).length >= want);
  });
});

test('pickGame meldet zu kleinen Katalog auf Deutsch', () => {
  assert.throws(() => G.pickGame(index.slice(0, 3), { seed: 1 }), /nur \d+ Kategorien für Runde/);
});

test('filterIndex: Level, Tag, Fragenart und Text', () => {
  assert.ok(G.filterIndex(index, { level: 'runde2' }).every((e) => e.level === 'runde2'));
  const tag = G.allTags(index)[0];
  assert.ok(G.filterIndex(index, { tag }).every((e) => e.tags.includes(tag)));
  assert.ok(G.filterIndex(index, { type: 'choice' }).every((e) => e.types.includes('choice')));
  assert.ok(G.filterIndex(index, { type: 'normal' }).every((e) => e.types.length === 0));
  assert.deepEqual(G.filterIndex(index, { text: 'tiere' }).map((e) => e.name).includes('Tiere'), true);
  assert.deepEqual(G.filterIndex(index, { text: 'gibtesnicht' }), []);
});

test('buildSet ergibt ein gültiges Set mit allen Fragen', () => {
  const p = G.pickGame(index, { seed: 9 });
  const data = p.rounds.map((r) => r.map((e) => JSON.parse(fs.readFileSync(path.join(DIR, e.file), 'utf8'))));
  const set = G.buildSet(J, data, '  Test  ');
  assert.equal(set.title, 'Test');
  set.rounds.forEach((r, ri) => r.categories.forEach((c, ci) => {
    assert.equal(c.name, data[ri][ci].name);
    assert.equal(c.clues.length, J.ROWS);
    c.clues.forEach((cl, row) => assert.equal(cl.a, data[ri][ci].clues[row].a));
  }));
});
