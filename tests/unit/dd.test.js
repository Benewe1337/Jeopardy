// Daily Double: Einsatzgrenzen, Wertung (auch ins Minus), Joker-Regeln, nichts vorab verraten, Zufallswahl
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCommon } = require('./load-common');

const { J } = loadCommon();
const plain = (x) => JSON.parse(JSON.stringify(x));

function game({ round = 0, scores = [300, 0], turn = 'a' } = {}) {
  const set = J.defaultSet();
  const st = J.defaultState();
  st.round = round;
  st.players = scores.map((score, i) => ({ id: 'abcd'[i], name: 'PLAYER' + i, score }));
  st.turn = turn;
  return { set, st };
}
function openDd(g, { cat = 2, row = 3, phase = 'wager', pid = g.st.turn, wager = null } = {}) {
  g.st.current = { round: g.st.round, cat, row, revealed: false, judged: {}, kind: 'normal', buzz: { open: false, winner: null }, timer: null,
    dd: Object.assign(J.dd.newDd(pid), { phase, wager }) };
  return g.st.current;
}

test('Einsatz: mindestens 5, höchstens max(Punktestand, höchster Feldwert der Runde)', () => {
  assert.equal(J.dd.MIN_WAGER, 5);
  assert.equal(J.dd.roundTop(0), 500);
  assert.equal(J.dd.roundTop(1), 1000);
  // wenig Punkte → Rundenmaximum
  assert.equal(J.dd.maxWager(300, 0), 500);
  assert.equal(J.dd.maxWager(0, 1), 1000);
  assert.equal(J.dd.maxWager(-400, 0), 500, 'Minuspunkte: trotzdem bis zum Rundenmaximum');
  // viele Punkte → eigener Stand
  assert.equal(J.dd.maxWager(2300, 0), 2300);
  assert.equal(J.dd.validWager(5, 300, 0), 5);
  assert.equal(J.dd.validWager(4, 300, 0), null);
  assert.equal(J.dd.validWager(0, 300, 0), null, '0 ist kein gültiger Einsatz');
  assert.equal(J.dd.validWager(500, 300, 0), 500);
  assert.equal(J.dd.validWager(501, 300, 0), null);
  assert.equal(J.dd.validWager(2300, 2300, 0), 2300);
  assert.equal(J.dd.validWager(2301, 2300, 0), null);
  assert.equal(J.dd.validWager('250', 300, 0), 250, 'Text aus dem Eingabefeld');
  assert.equal(J.dd.validWager('12.5', 300, 0), null);
  assert.equal(J.dd.validWager('', 300, 0), null);
  assert.equal(J.dd.validWager('abc', 300, 0), null);
  assert.equal(J.dd.validWager(null, 300, 0), null);
  assert.equal(J.dd.validWager(NaN, 300, 0), null);
  assert.equal(J.dd.validWager(-50, 300, 0), null);
});

test('Wertung: richtig +Einsatz, falsch −voller Einsatz, auch ins Minus', () => {
  assert.equal(J.dd.scoreDelta(400, 'right'), 400);
  assert.equal(J.dd.scoreDelta(400, 'wrong'), -400, 'voll, nicht halbiert');
  assert.equal(100 + J.dd.scoreDelta(500, 'wrong'), -400, 'Punktestand darf negativ werden');
  assert.equal(-400 + J.dd.scoreDelta(500, 'right'), 100);
});

test('Joker: Doppelt oder nichts und Weitergeben gesperrt, Tipp erlaubt (nur dem Spieler, nach dem Einsatz)', () => {
  const g = game();
  const cur = openDd(g, { phase: 'play', wager: 200 });
  const ctx = (pid, target) => ({ cur, players: g.st.players, turn: g.st.turn, pid, target });
  assert.match(J.jokerBlock('double', ctx('a')), /Daily Double/);
  assert.match(J.jokerBlock('pass', ctx('a', 'b')), /Daily Double/);
  assert.equal(J.jokerBlock('hint', ctx('a')), null);
  assert.ok(J.jokerBlock('hint', ctx('b')), 'andere Spieler dürfen keinen Tipp');
  assert.equal(J.whoIsUp(cur, 'a'), 'a');
  // vor dem Einsatz noch kein Joker
  cur.dd.phase = 'wager';
  assert.equal(J.whoIsUp(cur, 'a'), null);
  assert.match(J.jokerBlock('hint', ctx('a')), /Einsatz/);
  // nach der Wertung nichts mehr
  cur.dd.phase = 'play';
  cur.judged.a = 'wrong';
  assert.ok(J.jokerBlock('hint', ctx('a')));
  // normale Frage ist unverändert
  const normal = { round: 0, cat: 0, row: 0, revealed: false, judged: {}, kind: 'normal', buzz: { open: false, winner: null } };
  assert.equal(J.jokerBlock('double', { cur: normal, players: g.st.players, turn: 'a', pid: 'a' }), null);
  assert.equal(J.jokerBlock('pass', { cur: normal, players: g.st.players, turn: 'a', pid: 'a', target: 'b' }), null);
});

test('publicState: Daily-Double-Felder sind vor dem Öffnen nicht zu erkennen', () => {
  const g = game();
  g.set.rounds[0].categories[1].clues[2].dd = true;
  g.set.ddRandom = false;
  g.st.ddAuto = [[{ cat: 3, row: 4 }]];
  const pub = J.publicState(g.set, g.st);
  const json = JSON.stringify(pub);
  assert.ok(!/"dd"|ddAuto|ddRandom|Daily/.test(json), 'kein Hinweis im öffentlichen Zustand: ' + json.slice(0, 200));
  assert.equal(pub.current, null);
});

test('publicState: geöffnetes Daily Double verbirgt Frage, Bild und Antwort bis zum Einsatz', () => {
  const g = game();
  g.set.rounds[0].categories[2].clues[3].q = 'GEHEIMEFRAGE';
  g.set.rounds[0].categories[2].clues[3].a = 'GEHEIMEANTWORT';
  g.set.rounds[0].categories[2].clues[3].img = 'https://img.example.com/x.png';
  for (const phase of ['reveal', 'wager']) {
    openDd(g, { phase });
    const pub = J.publicState(g.set, g.st);
    assert.equal(pub.current.q, '');
    assert.equal(pub.current.img, null);
    assert.equal(pub.current.a, null);
    assert.equal(pub.current.dd.phase, phase);
    assert.equal(pub.current.dd.pid, 'a');
    assert.equal(pub.current.dd.wager, null);
    assert.equal(pub.current.dd.min, 5);
    assert.equal(pub.current.dd.max, 500);
    assert.ok(!JSON.stringify(pub).includes('GEHEIME'));
  }
  openDd(g, { phase: 'play', wager: 250 });
  const pub = J.publicState(g.set, g.st);
  assert.equal(pub.current.q, 'GEHEIMEFRAGE');
  assert.equal(pub.current.value, 250, 'angezeigt wird der Einsatz');
  assert.equal(pub.current.dd.wager, 250);
  assert.equal(pub.current.a, null, 'Lösung erst nach dem Aufdecken');
});

test('publicState: Spezialfragen geben vor dem Einsatz weder Optionen noch Reihenfolge preis', () => {
  const g = game();
  const clue = g.set.rounds[0].categories[2].clues[3];
  clue.kind = 'choice';
  clue.a = 'RICHTIGX | FALSCHY | FALSCHZ | FALSCHW';
  const cur = openDd(g, { phase: 'wager' });
  cur.kind = 'choice';
  cur.mc = { perm: [0, 1, 2, 3], answers: {} };
  let pub = J.publicState(g.set, g.st);
  assert.equal(pub.current.mc, null);
  assert.equal(pub.current.kind, 'normal');
  assert.ok(!JSON.stringify(pub).includes('RICHTIGX'));
  cur.dd.phase = 'play';
  cur.dd.wager = 100;
  pub = J.publicState(g.set, g.st);
  assert.equal(pub.current.kind, 'choice');
  assert.equal(pub.current.mc.options.length, 4);
});

test('Zufallswahl: 1 Feld in Runde 1, 2 in Runde 2, nie erste Reihe, verschiedene Kategorien', () => {
  for (let i = 0; i < 300; i++) {
    const r1 = J.dd.pickRandom(0);
    const r2 = J.dd.pickRandom(1);
    assert.equal(r1.length, 1);
    assert.equal(r2.length, 2);
    for (const c of [...r1, ...r2]) {
      assert.ok(c.row >= 1 && c.row < J.ROWS, 'Reihe ' + c.row);
      assert.ok(c.cat >= 0 && c.cat < J.CATS);
    }
    assert.notEqual(r2[0].cat, r2[1].cat);
  }
  // Grenzen des Zufallsgenerators
  assert.deepEqual(plain(J.dd.pickRandom(0, () => 0)), [{ cat: 0, row: 1 }]);
  assert.deepEqual(plain(J.dd.pickRandom(0, () => 0.999999)), [{ cat: J.CATS - 1, row: J.ROWS - 1 }]);
});

test('Zufall: Host-Einstellung geht vor dem Set; Felder bleiben pro Runde stabil; markierte Felder sonst', () => {
  const g = game();
  g.set.rounds[0].categories[1].clues[2].dd = true;
  // aus: nur markierte Felder
  assert.equal(J.dd.randomOn(g.set, g.st), false);
  assert.deepEqual(plain(J.dd.cells(g.set, g.st, 0)), [{ cat: 1, row: 2 }]);
  assert.equal(J.dd.isDd(g.set, g.st, 0, 1, 2), true);
  assert.equal(J.dd.isDd(g.set, g.st, 0, 1, 3), false);
  assert.equal(J.dd.ensureRandom(g.set, g.st, 0), false, 'ohne Zufall wird nichts gelost');
  // Set-Voreinstellung
  g.set.options = { ddRandom: true };
  assert.equal(J.dd.randomOn(g.set, g.st), true);
  assert.equal(J.dd.ensureRandom(g.set, g.st, 0), true);
  const first = plain(J.dd.cells(g.set, g.st, 0));
  assert.equal(first.length, 1);
  assert.equal(J.dd.ensureRandom(g.set, g.st, 0), false, 'schon gelost');
  assert.deepEqual(plain(J.dd.cells(g.set, g.st, 0)), first);
  // Die Losung darf zufällig dasselbe Feld treffen (1 von 24); sonst darf das markierte nicht mehr zählen
  if (first[0].cat !== 1 || first[0].row !== 2) assert.equal(J.dd.isDd(g.set, g.st, 0, 1, 2), false, 'Zufall ersetzt markierte Felder');
  assert.equal(J.dd.ensureRandom(g.set, g.st, 1), true);
  assert.equal(J.dd.cells(g.set, g.st, 1).length, 2);
  // Host schaltet aus
  g.st.options = { ddRandom: false };
  assert.equal(J.dd.randomOn(g.set, g.st), false);
  assert.deepEqual(plain(J.dd.cells(g.set, g.st, 0)), [{ cat: 1, row: 2 }]);
});

test('Set und Spielstand: dd-Markierung und Zufallsoption bleiben erhalten, Altbestand lädt weiter', () => {
  const s = J.defaultSet();
  s.rounds[1].categories[4].clues[3].dd = true;
  s.options = { ddRandom: true };
  const n = J.normalizeSet(plain(s));
  assert.equal(n.rounds[1].categories[4].clues[3].dd, true);
  assert.equal(n.rounds[1].categories[4].clues[2].dd, undefined);
  assert.equal(n.options.ddRandom, true);
  // Altbestand: set.ddRandom wandert in set.options
  const old = J.normalizeSet({ ddRandom: true });
  assert.deepEqual(plain(old.options), { ddRandom: true });
  assert.equal(old.ddRandom, undefined);
  const junk = J.normalizeSet({ ddRandom: 'ja', rounds: [{ categories: [{ name: 'X', clues: [{ q: 'q', dd: 'ja' }] }] }] });
  assert.equal(junk.options, undefined);
  assert.equal(junk.rounds[0].categories[0].clues[0].dd, undefined);
  const copy = J.copyCategories(J.defaultSet(), [{ set: s, round: 1, cat: 4 }], 0, 0);
  assert.equal(copy.rounds[0].categories[0].clues[3].dd, true, 'Kopieren behält die Markierung');
});
