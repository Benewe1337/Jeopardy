// Spielstand als Datei: exportGame / parseGame (Round-Trip, fremde/kaputte/zu große Dateien, nie dem Inhalt trauen)
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCommon } = require('./load-common');

const { J } = loadCommon();
const plain = (x) => JSON.parse(JSON.stringify(x));

function sampleState() {
  const st = plain(J.defaultState());
  st.players = [{ id: 'a1', name: 'Anna', score: 300 }, { id: 'b2', name: 'Ben', score: -100, usedJokers: ['x'] }];
  st.used[0][1][2] = true;
  st.round = 1;
  st.turn = 'b2';
  st.stats = { a1: { right: 2 } };
  st.current = { round: 0, cat: 0, row: 0, est: { answer: 42, guesses: { a1: 40 } }, timer: { start: 1, ms: 15000 }, buzz: { open: true, winner: null } };
  st.history = Array.from({ length: 50 }, (_, i) => ({ label: 'x' + i, round: 0 }));
  return st;
}
const sampleSet = () => { const s = plain(J.defaultSet()); s.title = 'Mein Quiz'; s.rounds[0].categories[0].clues[0].kind = 'estimate'; s.rounds[0].categories[0].clues[0].answer = 42; return s; };
const file = (obj) => JSON.stringify(obj);

test('Round-Trip: Stand, Raum und Set bleiben erhalten; Laufzeitdinge werden verworfen', () => {
  const snap = J.exportGame(sampleState(), sampleSet(), { room: 'ABC234' });
  assert.equal(snap.format, 'jeopardy-game');
  assert.equal(snap.v, 1);
  assert.equal(snap.history, undefined);
  const res = J.parseGame(file(snap));
  assert.equal(res.ok, true);
  const s = plain(res.snapshot);
  assert.equal(s.room, 'ABC234');
  assert.equal(s.set.title, 'Mein Quiz');
  assert.deepEqual(s.state.players.map((p) => p.id + ':' + p.score), ['a1:300', 'b2:-100']);
  assert.equal(s.state.used[0][1][2], true);
  assert.equal(s.state.round, 1);
  assert.equal(s.state.turn, 'b2');
  assert.equal(s.state.current.timer, null);
  assert.deepEqual(s.state.current.buzz, { open: false, winner: null });
  assert.equal(s.state.current.est.answer, 42);
  assert.equal(s.state.history.length, 30);
});

test('Export ohne Set / mit Set-Verweis', () => {
  const snap = J.exportGame(sampleState(), sampleSet(), { room: 'ABC234', includeSet: false, setRef: { id: 'set1', updated: '2026-11-16' } });
  assert.equal(snap.set, null);
  assert.equal(snap.setRef.id, 'set1');
  const res = J.parseGame(file(snap));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.set, null);
  assert.equal(res.snapshot.setRef.id, 'set1');
});

test('Export ändert den übergebenen Stand nicht', () => {
  const st = sampleState();
  const before = JSON.stringify(st);
  J.exportGame(st, sampleSet(), { room: 'ABC234' });
  assert.equal(JSON.stringify(st), before);
});

test('Ungültiger Raumcode im Export/Import wird zu null (nie übernehmen)', () => {
  assert.equal(J.exportGame(sampleState(), null, { room: '../x' }).room, null);
  const snap = J.exportGame(sampleState(), null, { room: 'ABC234' });
  snap.room = '<script>';
  assert.equal(J.parseGame(file(snap)).snapshot.room, null);
});

test('lehnt kaputte, fremde und zu große Dateien mit deutscher Meldung ab', () => {
  const bad = (x, size) => J.parseGame(typeof x === 'string' ? x : file(x), size);
  assert.match(bad('{kaputt').error, /kein gültiges JSON/);
  assert.match(bad([1, 2]).error, /keine Jeopardy-Spielstand/);
  assert.match(bad({ title: 'x', rounds: [] }).error, /keine Jeopardy-Spielstand/);
  assert.match(bad({ format: 'anderes', v: 1 }).error, /keine Jeopardy-Spielstand/);
  assert.match(bad({ format: 'jeopardy-game' }).error, /Version/);
  assert.match(bad({ format: 'jeopardy-game', v: '1', state: {} }).error, /Version/);
  assert.match(bad({ format: 'jeopardy-game', v: 2, state: {} }).error, /neueren Version/);
  assert.match(bad({ format: 'jeopardy-game', v: 1 }).error, /unvollständig/);
  assert.match(bad({ format: 'jeopardy-game', v: 1, state: { players: 'x', used: [] } }).error, /unvollständig/);
  assert.match(bad('{}', 8_000_001).error, /zu groß/);
  assert.match(J.parseGame('x'.repeat(8_000_001)).error, /zu groß/);
});

test('lehnt ein ungültiges oder zu neues Set in der Datei ab', () => {
  const snap = J.exportGame(sampleState(), null, { room: 'ABC234' });
  snap.set = { rounds: [{ categories: [{ name: 'X', clues: [{ q: 'a', a: 'b', kind: 'zukunft' }] }] }] };
  assert.match(J.parseGame(file(snap)).error, /Fragenset in der Datei ist ungültig/);
  snap.set = { kein: 'set' };
  assert.match(J.parseGame(file(snap)).error, /Fragenset in der Datei ist ungültig/);
});

test('traut dem Inhalt nicht: Typen werden bereinigt, fremde Felder fallen weg', () => {
  const snap = J.exportGame(sampleState(), null, { room: 'ABC234' });
  snap.state.players = [{ id: 7, name: 5, score: 'abc' }, { id: '', name: 'x' }, null, 'str'];
  snap.state.used = [1];
  snap.state.round = 99;
  snap.state.mode = 'hack';
  snap.state.evil = '<img onerror=x>';
  snap.state.teamSize = 9999;
  snap.extra = { __proto__: 1 };
  const res = J.parseGame(file(snap));
  assert.equal(res.ok, true);
  const st = plain(res.snapshot.state);
  assert.deepEqual(st.players, [{ id: '7', name: '5', score: 0 }]);
  assert.equal(st.used.length, 2);
  assert.equal(st.used[0].length, 6);
  assert.equal(st.used[0][0].length, 5);
  assert.equal(st.round, 0);
  assert.equal(st.mode, 'single');
  assert.equal(st.evil, undefined);
  assert.ok(st.teamSize <= 20);
  assert.equal(res.snapshot.extra, undefined);
});

test('Prototype-Pollution über __proto__ in der Datei wirkt nicht', () => {
  const text = '{"format":"jeopardy-game","v":1,"state":{"players":[{"id":"a","name":"A","score":1,"__proto__":{"polluted":true}}],"used":[],"__proto__":{"polluted":true}}}';
  const res = J.parseGame(text);
  assert.equal(res.ok, true);
  assert.equal(({}).polluted, undefined);
  assert.equal(res.snapshot.state.players[0].polluted, undefined);
});

test('Spieleransicht aus geladenem Stand verrät keine Schätzantwort', () => {
  const snap = J.parseGame(file(J.exportGame(sampleState(), sampleSet(), { room: 'ABC234' }))).snapshot;
  const pub = J.publicState(snap.set, snap.state);
  assert.equal(pub.current.est.answer, null);
  assert.equal(pub.current.est.guesses, null);
  assert.equal(JSON.stringify(pub).includes('42'), false);
});
