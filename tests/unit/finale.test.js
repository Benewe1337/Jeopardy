// Final Jeopardy: Einsatzregeln, Wertung, Aufdeck-Reihenfolge und – vor allem – nichts verraten
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCommon } = require('./load-common');

const { J } = loadCommon();
const plain = (x) => JSON.parse(JSON.stringify(x));

const FINAL = { category: 'Weltgeschichte', q: 'FRAGETEXT', a: 'GEHEIMELOESUNG', note: 'NOTIZ' };
function setWithFinal() {
  const s = J.defaultSet();
  s.final = { ...FINAL };
  return s;
}
function stateWith(phase, extra = {}) {
  const st = J.defaultState();
  st.players = [{ id: 'a', name: 'Anna', score: 500 }, { id: 'b', name: 'Ben', score: 0 }, { id: 'c', name: 'Cem', score: -100 }, { id: 'd', name: 'Dora', score: 200 }];
  st.fj = Object.assign(J.fj.newFinal(st.players), { phase }, extra);
  return st;
}

test('Set ohne Final Jeopardy: hasFinal false, alte Sets laden weiter', () => {
  const old = J.normalizeSet({ title: 'Alt', rounds: [] });
  assert.equal(J.fj.hasFinal(old), false);
  assert.deepEqual(plain(old.final), { category: '', q: '', a: '', note: '' });
  assert.equal(J.fj.hasFinal(setWithFinal()), true);
  const half = J.defaultSet();
  half.final.q = 'nur Frage';
  assert.equal(J.fj.hasFinal(half), false, 'ohne Antwort nicht spielbar');
});

test('normalizeSet übernimmt Final Jeopardy und ignoriert Fremdes', () => {
  const s = J.normalizeSet({ final: { category: 'K', q: 'Q', a: 'A', note: 'N', evil: 1 } });
  assert.deepEqual(plain(s.final), { category: 'K', q: 'Q', a: 'A', note: 'N' });
  assert.deepEqual(plain(J.normalizeSet({ final: 'x' }).final), plain(J.defaultSet().final));
  assert.equal(J.normalizeSet({ final: { q: 5 } }).final.q, '');
  // Export → Import überlebt
  assert.deepEqual(plain(J.parseSetFile(JSON.stringify(setWithFinal())).final), FINAL);
});

test('Einsatz: 0 bis eigener Punktestand, nur ganze Zahlen; wer ≤ 0 hat, kann nur 0 setzen', () => {
  assert.equal(J.fj.validWager(0, 500), 0);
  assert.equal(J.fj.validWager(500, 500), 500);
  assert.equal(J.fj.validWager('250', 500), 250);
  assert.equal(J.fj.validWager(501, 500), null);
  assert.equal(J.fj.validWager(-1, 500), null);
  assert.equal(J.fj.validWager(1.5, 500), null);
  assert.equal(J.fj.validWager('', 500), null);
  assert.equal(J.fj.validWager('abc', 500), null);
  assert.equal(J.fj.validWager(null, 500), null);
  assert.equal(J.fj.validWager(0, 0), 0);
  assert.equal(J.fj.validWager(1, 0), null);
  assert.equal(J.fj.validWager(0, -100), 0);
  assert.equal(J.fj.validWager(1, -100), null);
  assert.equal(J.fj.maxWager(-100), 0);
});

test('Einsätze und Antworten nur in der passenden Phase und nur von Mitspielern', () => {
  const st = stateWith('category');
  assert.equal(J.fj.submitWager(st.fj, st.players, 'a', 100), false, 'noch nicht freigegeben');
  st.fj.phase = 'wager';
  assert.equal(J.fj.submitWager(st.fj, st.players, 'a', 100), true);
  assert.equal(J.fj.submitWager(st.fj, st.players, 'a', 9999), false);
  assert.equal(J.fj.submitWager(st.fj, st.players, 'zzz', 0), false);
  assert.equal(J.fj.submitWager(st.fj, st.players, 'c', 50), false, 'Minuspunkte: nur 0');
  assert.equal(J.fj.submitWager(st.fj, st.players, 'c', 0), true);
  assert.equal(st.fj.wagers.a, 100);
  assert.equal(J.fj.submitAnswer(st.fj, st.players, 'a', 'x'), false, 'Antworten erst in der Fragephase');
  st.fj.phase = 'question';
  assert.equal(J.fj.submitWager(st.fj, st.players, 'a', 5), false, 'Einsätze sind gesperrt');
  assert.equal(st.fj.wagers.a, 100);
  assert.equal(J.fj.submitAnswer(st.fj, st.players, 'a', '  Rom   Italien '), true);
  assert.equal(st.fj.answers.a, 'Rom Italien');
  assert.equal(J.fj.submitAnswer(st.fj, st.players, 'a', 42), false);
  J.fj.submitAnswer(st.fj, st.players, 'a', 'x'.repeat(500));
  assert.equal(st.fj.answers.a.length, J.fj.MAX_ANSWER_LEN);
  st.fj.timer = { endsAt: 1000, total: 30000 };
  assert.equal(J.fj.submitAnswer(st.fj, st.players, 'a', 'zu spät', 1000 + 1500), true, 'kleine Netz-Toleranz');
  assert.equal(J.fj.submitAnswer(st.fj, st.players, 'a', 'zu spät', 1000 + 1501), false);
  assert.equal(st.fj.answers.a, 'zu spät');
});

test('fehlende Einsätze zählen als 0', () => {
  const st = stateWith('wager');
  st.fj.wagers.a = 300;
  J.fj.fillMissingWagers(st.fj, st.players);
  assert.deepEqual(plain(st.fj.wagers), { a: 300, b: 0, c: 0, d: 0 });
});

test('Wertung: richtig +Einsatz, falsch −Einsatz; Einsatz wird auf den aktuellen Stand gekappt', () => {
  assert.equal(J.fj.scoreDelta(300, 'right'), 300);
  assert.equal(J.fj.scoreDelta(300, 'wrong'), -300);
  assert.equal(J.fj.scoreDelta(0, 'wrong'), 0);
  const st = stateWith('reveal');
  st.fj.wagers = { a: 500, b: 0, c: 0, d: 200 };
  assert.equal(J.fj.effectiveWager(st.fj, st.players[0]), 500);
  st.players[0].score = 100; // Host hat Punkte von Hand gesenkt
  assert.equal(J.fj.effectiveWager(st.fj, st.players[0]), 100);
});

test('Aufdeck-Reihenfolge: niedrigster Punktestand zuerst, Gleichstand nach Listenreihenfolge', () => {
  const st = stateWith('reveal');
  assert.deepEqual(plain(J.fj.revealOrder(st.players)), ['c', 'b', 'd', 'a']);
  const tie = [{ id: 'x', score: 100 }, { id: 'y', score: 100 }, { id: 'z', score: 50 }];
  assert.deepEqual(plain(J.fj.revealOrder(tie)), ['z', 'x', 'y']);
  st.fj.order = J.fj.revealOrder(st.players);
  assert.equal(J.fj.nextToReveal(st.fj, st.players), 'c');
  st.fj.done = { c: {}, b: {} };
  assert.equal(J.fj.nextToReveal(st.fj, st.players), 'd');
  st.fj.done = { c: {}, b: {}, d: {}, a: {} };
  assert.equal(J.fj.nextToReveal(st.fj, st.players), null);
  assert.equal(J.fj.allDone(st.fj, st.players), true);
});

test('publicState: Kategorie früh, Frage erst später, Lösung erst beim Aufdecken – nie Einsätze/Antworten vorab', () => {
  const set = setWithFinal();
  const secret = { wagers: { a: 123456, b: 0, c: 0, d: 98765 }, answers: { a: 'GEHEIMEANTWORT_A', d: 'GEHEIMEANTWORT_D' } };
  const check = (phase, expectQ, expectA) => {
    const st = stateWith(phase, JSON.parse(JSON.stringify(secret)));
    const pub = J.publicState(set, st);
    const json = JSON.stringify(pub);
    assert.equal(pub.final.phase, phase);
    assert.equal(pub.final.category, 'Weltgeschichte');
    assert.equal(json.includes('FRAGETEXT'), expectQ, phase + ': Frage');
    assert.equal(json.includes('GEHEIMELOESUNG'), expectA, phase + ': Lösung');
    assert.ok(!json.includes('NOTIZ'), 'Host-Notiz nie öffentlich');
    return { pub, json };
  };
  for (const phase of ['category', 'wager', 'question']) {
    const { json } = check(phase, phase === 'question', false);
    assert.ok(!json.includes('123456') && !json.includes('98765'), phase + ': Einsätze dürfen nicht im öffentlichen Zustand stehen');
    assert.ok(!json.includes('GEHEIMEANTWORT'), phase + ': Antworten dürfen nicht im öffentlichen Zustand stehen');
  }
  const wager = J.publicState(set, stateWith('wager', JSON.parse(JSON.stringify(secret)))).final;
  assert.deepEqual(plain(wager.wagered).sort(), ['a', 'b', 'c', 'd'], 'sichtbar ist nur, WER gesetzt hat');
  const q = J.publicState(set, stateWith('question', JSON.parse(JSON.stringify(secret)))).final;
  assert.deepEqual(plain(q.answered).sort(), ['a', 'd']);
  // Aufdecken: Lösung ja, aber nur bereits aufgedeckte Antworten/Einsätze
  const st = stateWith('reveal', JSON.parse(JSON.stringify(secret)));
  st.fj.order = J.fj.revealOrder(st.players);
  let pub = J.publicState(set, st).final;
  assert.equal(pub.a, 'GEHEIMELOESUNG');
  assert.ok(!JSON.stringify(pub).includes('GEHEIMEANTWORT') && !JSON.stringify(pub).includes('98765'));
  st.fj.pending = 'd';
  pub = J.publicState(set, st).final;
  assert.equal(pub.pending.answer, 'GEHEIMEANTWORT_D');
  assert.ok(!JSON.stringify(pub).includes('GEHEIMEANTWORT_A'), 'Antwort von Anna noch nicht dran');
  assert.ok(!JSON.stringify(pub).includes('98765'), 'Einsatz erst mit der Wertung');
  st.fj.done = { d: { answer: 'GEHEIMEANTWORT_D', wager: 98765, verdict: 'right', delta: 98765, score: 1 } };
  st.fj.pending = null;
  pub = J.publicState(set, st).final;
  assert.equal(pub.done.d.wager, 98765);
  assert.ok(!JSON.stringify(pub).includes('123456'), 'Annas Einsatz bleibt geheim');
});

test('publicState: kein Final Jeopardy ohne Ablauf, nicht in der Siegerehrung, entfernte Spieler fallen raus', () => {
  const set = setWithFinal();
  const st = J.defaultState();
  assert.equal(J.publicState(set, st).final, null);
  const st2 = stateWith('question');
  st2.fj.answers.a = 'x';
  st2.players = st2.players.filter((p) => p.id !== 'a');
  assert.deepEqual(plain(J.publicState(set, st2).final.answered), []);
  st2.finished = true;
  assert.equal(J.publicState(set, st2).final, null);
});
