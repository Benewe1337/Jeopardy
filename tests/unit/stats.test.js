// Statistik: Erfassen, Auswerten und Export (inkl. CSV-Injection-Schutz)
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCommon } = require('./load-common');

const { J } = loadCommon();
const S = J.stats;
const plain = (x) => JSON.parse(JSON.stringify(x));
const eq = (x, y) => assert.deepEqual(plain(x), plain(y));

test('recordVerdict: Treffer je Kategorie, Klauen, Doppelt-oder-nichts', () => {
  const stats = {};
  S.recordVerdict(stats, 'a', 'right', { cat: 'Film' });
  S.recordVerdict(stats, 'a', 'wrong', { cat: 'Film' });
  S.recordVerdict(stats, 'a', 'right', { cat: 'Musik', stolen: true });
  S.recordVerdict(stats, 'a', 'right', { cat: 'Musik', jokers: { double: ['a'] } });
  S.recordVerdict(stats, 'a', 'wrong', { cat: 'Film', jokers: { double: ['a'] } });
  assert.equal(stats.a.right, 3);
  assert.equal(stats.a.wrong, 2);
  assert.equal(stats.a.steals, 1);
  eq(plain(stats.a.cats), { Film: { right: 1, wrong: 2 }, Musik: { right: 2, wrong: 0 } });
  eq(plain(stats.a.jokers.double), { used: 0, won: 1, lost: 1 });
});

test('Weitergeben zählt für den, der weitergibt, je nach Antwort des Empfängers', () => {
  const stats = {};
  const jokers = { pass: { from: 'a', to: 'b' } };
  S.recordVerdict(stats, 'b', 'right', { cat: 'X', jokers });
  S.recordVerdict(stats, 'b', 'wrong', { cat: 'X', jokers });
  eq(plain(stats.a.jokers.pass), { used: 0, won: 1, lost: 1 });
});

test('recordJoker zählt Nutzung, unbekannte Joker werden ignoriert', () => {
  const stats = {};
  S.recordJoker(stats, 'a', 'hint');
  S.recordJoker(stats, 'a', 'hint');
  S.recordJoker(stats, 'a', 'bogus');
  assert.equal(stats.a.jokers.hint.used, 2);
  assert.equal(stats.a.jokers.bogus, undefined);
});

test('recordBuzz: Reaktionszeiten aller Teilnehmer, Sieg nur beim Gewinner, Personen im Team-Modus', () => {
  const stats = {}; const persons = {};
  S.recordBuzz(stats, persons, [['t1', 300, 'Anna'], ['t2', 450, 'Ben']], 't1', true, (id) => (id === 't1' ? 'Rot' : 'Blau'));
  S.recordBuzz(stats, persons, [['t1', 500, 'Cem'], ['t2', 250, 'Ben']], 't2', true, (id) => (id === 't1' ? 'Rot' : 'Blau'));
  eq(plain(stats.t1.reactions), [300, 500]);
  assert.equal(stats.t1.buzzWins, 1);
  assert.equal(stats.t2.buzzWins, 1);
  eq(plain(persons['t2:Ben']), { name: 'Ben', team: 'Blau', buzzWins: 1, reactions: [450, 250] });
  assert.equal(persons['t1:Cem'].buzzWins, 0);
});

test('recordBuzz im Einzelmodus legt keine Personen an; Reaktionsliste ist begrenzt', () => {
  const stats = {}; const persons = {};
  for (let i = 0; i < 400; i++) S.recordBuzz(stats, persons, [['a', 300 + i, null]], 'a', false, () => '');
  eq(persons, {});
  assert.equal(stats.a.reactions.length, 300);
  assert.equal(stats.a.reactions[299], 699);
});

test('summarize: Quote, Ø/schnellste Reaktion, Joker, Final', () => {
  const players = [{ id: 'a', name: 'Anna', score: 500 }, { id: 'b', name: 'Ben', score: -100 }];
  const stats = {};
  S.recordVerdict(stats, 'a', 'right', { cat: 'Film' });
  S.recordVerdict(stats, 'a', 'right', { cat: 'Film' });
  S.recordVerdict(stats, 'a', 'wrong', { cat: 'Musik', jokers: { double: ['a'] } });
  S.recordJoker(stats, 'a', 'double');
  S.recordBuzz(stats, {}, [['a', 300, null], ['b', 500, null]], 'a', false, () => '');
  S.recordBuzz(stats, {}, [['a', 500, null]], 'a', false, () => '');
  S.recordFinal(stats, 'b', { wager: 0, verdict: 'wrong', delta: 0 });
  const sum = S.summarize(players, stats, {}, 'single');
  const a = sum.players[0]; const b = sum.players[1];
  assert.equal(a.rate, 66.7);
  eq(a.reaction, { count: 2, avg: 400, min: 300 });
  eq(a.jokers.double, { used: 1, won: 0, lost: 1 });
  assert.equal(a.buzzWins, 2);
  eq(a.cats.map((c) => [c.name, c.rate]), [['Film', 100], ['Musik', 0]]);
  assert.equal(b.rate, null);
  eq(b.reaction, { count: 1, avg: 500, min: 500 });
  eq(plain(b.fj), { wager: 0, verdict: 'wrong', delta: 0 });
  eq(sum.categories, ['Film', 'Musik']);
  eq(sum.persons, []);
});

test('summarize übersteht alte/kaputte Spielstände', () => {
  const players = [{ id: 'a', name: 'Anna', score: 'x' }];
  const sum = S.summarize(players, { a: { right: 'viel', reactions: [300, 'NaN', null, -5], cats: 5, jokers: [] } }, null, 'single');
  assert.equal(sum.players[0].right, 0);
  assert.equal(sum.players[0].score, 0);
  eq(sum.players[0].reaction, { count: 1, avg: 300, min: 300 });
  eq(plain(S.summarize([], undefined, undefined, 'team')), { mode: 'team', players: [], persons: [], categories: [] });
  assert.doesNotThrow(() => S.toCsv(sum));
});

test('Team-Modus: Personen erscheinen in der Auswertung', () => {
  const players = [{ id: 't1', name: 'Rot', score: 0 }];
  const persons = { 't1:Anna': { name: 'Anna', team: 'Rot', buzzWins: 2, reactions: [200, 400] } };
  const sum = S.summarize(players, {}, persons, 'team');
  eq(plain(sum.persons), [{ name: 'Anna', team: 'Rot', buzzWins: 2, reaction: { count: 2, avg: 300, min: 200 } }]);
});

test('csvCell: Quoting und Neutralisierung von Formeln', () => {
  assert.equal(S.csvCell('Anna'), 'Anna');
  assert.equal(S.csvCell('a,b'), '"a,b"');
  assert.equal(S.csvCell('sagt "hi"'), '"sagt ""hi"""');
  assert.equal(S.csvCell('zwei\nZeilen'), '"zwei\nZeilen"');
  assert.equal(S.csvCell(-100), '-100');
  assert.equal(S.csvCell(null), '');
  assert.equal(S.csvCell(NaN), '');
  for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '=HYPERLINK("http://x","y")']) {
    const out = S.csvCell(evil);
    assert.ok(out.startsWith("'") || out.startsWith('"\''), `${JSON.stringify(evil)} → ${out}`);
  }
  assert.equal(S.csvCell('=1,2'), '"\'=1,2"');
});

test('toCsv: gültige Zeilen, Namen mit Sonderzeichen sind neutralisiert', () => {
  const players = [{ id: 'a', name: '=cmd|\' /C calc\'!A0', score: 100 }, { id: 'b', name: 'Müller, "Max"', score: -50 }];
  const stats = {};
  S.recordVerdict(stats, 'a', 'right', { cat: '+Film, "neu"' });
  const csv = S.toCsv(S.summarize(players, stats, {}, 'single'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Typ,Name,Team,Kategorie,Kennzahl,Wert');
  assert.ok(lines.every((l) => !/^(Spieler|Team|Person),[=+\-@]/.test(l)), 'kein Namensfeld beginnt mit Formelzeichen');
  assert.ok(lines.some((l) => l.startsWith(`Spieler,'=cmd`)));
  assert.ok(lines.some((l) => l.startsWith('Spieler,"Müller, ""Max""",,,Punkte,-50')));
  assert.ok(lines.some((l) => l.includes(`"'+Film, ""neu"""`)));
  // Jede Zeile hat genau 6 Felder (nach CSV-Regeln)
  for (const l of lines) {
    let n = 1; let q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) n++; }
    assert.equal(n, 6, l);
  }
});

test('toJson: parsebar und enthält die Auswertung', () => {
  const sum = S.summarize([{ id: 'a', name: 'Anna', score: 1 }], {}, {}, 'single');
  const j = JSON.parse(S.toJson(sum, 'Titel'));
  assert.equal(j.title, 'Titel');
  assert.equal(j.players[0].name, 'Anna');
  assert.ok(j.exportedAt);
});

test('loadState: statsShown wird normalisiert; publicState zeigt Statistik nur nach der Siegerehrung', () => {
  const { J: K, localStorage } = loadCommon();
  localStorage.setItem('jeopardy.state', JSON.stringify({ statsShown: 'ja', finished: false }));
  const st = K.loadState();
  assert.equal(st.statsShown, true);
  assert.equal(K.publicState(K.defaultSet(), st).statsShown, false);
  assert.equal(K.publicState(K.defaultSet(), { ...st, finished: true }).statsShown, true);
});
