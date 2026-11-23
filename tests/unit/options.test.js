const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCommon } = require('./load-common');

const { J } = loadCommon();
const plain = (v) => JSON.parse(JSON.stringify(v));

function game() {
  const set = J.defaultSet();
  set.final = { category: 'F', q: 'Frage', a: 'Antwort', note: '' };
  set.rounds[0].categories[1].clues[2].dd = true;
  const st = J.defaultState();
  st.players = [{ id: 'a', name: 'A', score: 0 }, { id: 'b', name: 'B', score: 0 }];
  st.turn = 'a';
  return { set, st };
}

test('Standard: ohne Optionen verhält sich alles wie bisher', () => {
  const { set, st } = game();
  const eff = J.effectiveOptions(set, st);
  assert.deepEqual(plain(eff), {
    final: true, dd: true, ddRandom: false, jokerDouble: true, jokerHint: true, jokerPass: true,
    steal: true, stealHalf: true, penalty: 'half', abstainPenalty: false, turn: true,
    pixelRace: true, timer: true, timerSec: '15', intro: true, reactions: true, qrTv: true, media: true,
    stats: true, awards: true, soundDefault: true, backup: true,
    splitScoring: false, turnShare: '100', otherShare: '100', otherPenalty: 'same', estimateRunnerUp: '0', stealShare: '50',
  });
  assert.equal(J.penaltyFor(0, 2), 150);
  assert.equal(J.stealFor(0, 2), 150);
  assert.equal(J.dd.isDd(set, st, 0, 1, 2), true);
  assert.equal(J.fj.finalOn(set, st), true);
});

test('opt: Host-Überschreibung vor Set-Voreinstellung vor Standard', () => {
  const { set, st } = game();
  set.options = { penalty: 'full', steal: false };
  assert.equal(J.opt(set, st, 'penalty'), 'full');
  st.options = { penalty: 'none' };
  assert.equal(J.opt(set, st, 'penalty'), 'none');
  assert.equal(J.opt(set, st, 'steal'), false);
  st.options = { steal: true };
  assert.equal(J.opt(set, st, 'steal'), true);
  assert.equal(J.opt(set, null, 'penalty'), 'full', 'ohne State: nur Set');
  assert.equal(J.opt(null, null, 'penalty'), 'half');
  assert.equal(J.opt(set, st, 'gibtsnicht'), undefined);
});

test('opt: Abhängigkeiten machen Optionen wirkungslos', () => {
  const { set, st } = game();
  set.options = { ddRandom: true, stealHalf: true };
  st.options = { dd: false };
  assert.equal(J.opt(set, st, 'ddRandom'), false, 'ohne Daily Double kein Zufall');
  st.options = { steal: false };
  assert.equal(J.opt(set, st, 'stealHalf'), false);
  st.options = { turn: false };
  assert.equal(J.opt(set, st, 'jokerPass'), false, 'Weitergeben braucht Am Zug');
  assert.equal(J.opt(set, st, 'jokerDouble'), true);
});

test('cleanOptions verwirft Unbekanntes und Ungültiges', () => {
  assert.deepEqual(plain(J.cleanOptions({ steal: false, penalty: 'viel', turn: 'ja', foo: true, final: true })), { steal: false, final: true });
  assert.deepEqual(plain(J.cleanOptions(null)), {});
  assert.deepEqual(plain(J.cleanOptions([true])), {});
});

test('normalizeSet / normalizeState tragen Optionen; ohne Optionen kein options-Feld im Set', () => {
  assert.equal(J.normalizeSet({}).options, undefined);
  const s = J.normalizeSet({ options: { penalty: 'none', x: 1 } });
  assert.deepEqual(plain(s.options), { penalty: 'none' });
  const st = J.normalizeState({ options: { steal: false, penalty: 'zz' } });
  assert.deepEqual(plain(st.options), { steal: false });
  assert.deepEqual(plain(J.normalizeState({}).options), {});
  assert.deepEqual(plain(J.defaultState().options), {});
  // Resume/Export: Optionen überleben
  assert.deepEqual(plain(J.normalizeState(plain(st), { resume: true }).options), { steal: false });
});

test('optionsLocked: ab dem ersten Feld / laufender Frage / Final / Ende', () => {
  const { st } = game();
  assert.equal(J.optionsLocked(st), false);
  st.used[0][0][0] = true;
  assert.equal(J.optionsLocked(st), true);
  st.used[0][0][0] = false;
  st.current = { round: 0, cat: 0, row: 0 };
  assert.equal(J.optionsLocked(st), true);
  st.current = null; st.fj = { phase: 'wager' };
  assert.equal(J.optionsLocked(st), true);
  st.fj = null; st.finished = true;
  assert.equal(J.optionsLocked(st), true);
});

test('Final Jeopardy aus → nicht spielbar, auch mit Frage', () => {
  const { set, st } = game();
  st.options = { final: false };
  assert.equal(J.fj.hasFinal(set), true);
  assert.equal(J.fj.finalOn(set, st), false);
  delete st.options;
  set.final.q = '';
  assert.equal(J.fj.finalOn(set, st), false, 'an, aber keine Frage: weiter nicht spielbar');
});

test('Daily Double aus → markierte und zufällige Felder sind normale Felder', () => {
  const { set, st } = game();
  st.options = { dd: false };
  assert.equal(J.dd.isDd(set, st, 0, 1, 2), false);
  assert.deepEqual(plain(J.dd.cells(set, st, 0)), []);
  st.options = { dd: false, ddRandom: true };
  assert.equal(J.dd.ensureRandom(set, st, 0), false);
  assert.equal(J.dd.isDd(set, st, 0, 1, 2), false);
});

test('Joker einzeln abschaltbar; blockiert im Host und fehlt in activeJokers', () => {
  const { set, st } = game();
  st.current = { round: 0, cat: 0, row: 0, revealed: false, judged: {}, buzz: { open: false }, kind: 'normal' };
  const base = { cur: st.current, players: st.players, turn: 'a', pid: 'a', opts: J.effectiveOptions(set, st) };
  assert.equal(J.jokerBlock('hint', base), null);
  for (const [kind, key] of [['double', 'jokerDouble'], ['hint', 'jokerHint'], ['pass', 'jokerPass']]) {
    st.options = { [key]: false };
    const ctx = { ...base, opts: J.effectiveOptions(set, st), target: kind === 'pass' ? 'b' : undefined };
    assert.match(J.jokerBlock(kind, ctx), /ausgeschaltet/);
    assert.equal(J.activeJokers(ctx.opts).some((j) => j.id === kind), false);
    assert.equal(J.activeJokers(ctx.opts).length, 2);
  }
  st.options = { jokerDouble: false, jokerHint: false, jokerPass: false };
  assert.equal(J.activeJokers(J.effectiveOptions(set, st)).length, 0);
  assert.equal(J.activeJokers(undefined).length, 3, 'ohne Optionen alle Joker');
});

test('Punkte: Abzug half/full/none, Klauen halb/voll', () => {
  assert.equal(J.penaltyFor(1, 4, 'half'), 500);
  assert.equal(J.penaltyFor(1, 4, 'full'), 1000);
  assert.equal(J.penaltyFor(1, 4, 'none'), 0);
  assert.equal(J.stealFor(1, 4, true), 500);
  assert.equal(J.stealFor(1, 4, false), 1000);
  assert.deepEqual(plain(J.judgePoints(0, 1, { stolen: false, double: false, penalty: 'full' })), { gain: 200, penalty: 200 });
  assert.deepEqual(plain(J.judgePoints(0, 1, { stolen: true, double: false, penalty: 'none', stealHalf: false })), { gain: 200, penalty: 0 });
  assert.deepEqual(plain(J.judgePoints(0, 1, { stolen: true, double: false })), { gain: 100, penalty: 100 });
  // Joker „Doppelt oder nichts“ riskiert immer den vollen Wert
  assert.deepEqual(plain(J.judgePoints(0, 1, { stolen: false, double: true, penalty: 'none' })), { gain: 400, penalty: 200 });
});

test('publicState: Am Zug nur mit Option; opts für Spieler/TV', () => {
  const { set, st } = game();
  assert.equal(J.publicState(set, st).turn, 'a');
  assert.equal(J.publicState(set, st).opts.jokerPass, true);
  st.options = { turn: false, jokerHint: false };
  const pub = J.publicState(set, st);
  assert.equal(pub.turn, null);
  assert.equal(pub.opts.jokerPass, false);
  assert.equal(pub.opts.jokerHint, false);
  assert.ok(!/ddRandom|"dd"/.test(JSON.stringify(pub)), 'DD-Optionen bleiben geheim');
});

test('whoIsUp ohne Zug: niemand vor der ersten Antwort', () => {
  const cur = { round: 0, cat: 0, row: 0, judged: {}, buzz: { open: false, winner: null } };
  assert.equal(J.whoIsUp(cur, null), null);
  assert.equal(J.whoIsUp({ ...cur, buzz: { open: false, winner: 'b' } }, null), 'b');
});

// ---------- Teil B: Reaktionen, Intro, Auszeichnungen, Rennen, Timer, QR, Statistik, Clips, Sicherung, Sound ----------
test('Teil B: Standardwerte, Timer-Dauer nur als Auswahl, Timer aus macht Dauer wirkungslos', () => {
  const { set, st } = game();
  assert.equal(J.opt(set, st, 'timerSec'), '15');
  st.options = { timerSec: '30' };
  assert.equal(J.opt(set, st, 'timerSec'), '30');
  st.options = { timerSec: '25' };
  assert.equal(J.opt(set, st, 'timerSec'), '15', 'ungültige Dauer wird verworfen');
  assert.deepEqual(plain(J.cleanOptions({ timerSec: '25', timer: false })), { timer: false });
  st.options = { timer: false, timerSec: '30' };
  assert.equal(J.opt(set, st, 'timerSec'), '15', 'ohne Timer gilt der Standard');
});

test('publicState: Reaktionen, QR, Auszeichnungen, Sound-Standard gehen an Spieler/TV', () => {
  const { set, st } = game();
  const o = J.publicState(set, st).opts;
  assert.deepEqual([o.reactions, o.qrTv, o.awards, o.soundDefault], [true, true, true, true]);
  st.options = { reactions: false, qrTv: false, awards: false, soundDefault: false };
  const o2 = J.publicState(set, st).opts;
  assert.deepEqual([o2.reactions, o2.qrTv, o2.awards, o2.soundDefault], [false, false, false, false]);
  // Host-only-Optionen bleiben geheim
  assert.ok(!('backup' in o2) && !('intro' in o2) && !('timer' in o2) && !('pixelRace' in o2));
});

test('publicState: Statistik und Auszeichnungen steuern, was an die Spieler geht', () => {
  const { set, st } = game();
  st.finished = true; st.statsShown = true;
  st.stats = { a: { right: 2, buzzWins: 1 } };
  assert.equal(J.publicState(set, st).statsShown, true);
  assert.deepEqual(plain(J.publicState(set, st).stats), st.stats);
  st.options = { stats: false };
  assert.equal(J.publicState(set, st).statsShown, false, 'Statistik aus: nie anzeigen');
  assert.deepEqual(plain(J.publicState(set, st).stats), st.stats, 'Auszeichnungen brauchen die Daten noch');
  st.options = { stats: false, awards: false };
  assert.deepEqual(plain(J.publicState(set, st).stats), {}, 'beides aus: keine Daten an Spieler');
  st.options = { awards: false };
  assert.equal(J.publicState(set, st).statsShown, true);
});

test('publicState: Clips aus → kein Hinweis für Handys', () => {
  const { set, st } = game();
  set.rounds[0].categories[0].clues[0].media = 'https://example.com/a.mp3';
  st.current = { round: 0, cat: 0, row: 0, revealed: false, judged: {}, buzz: { open: false }, kind: 'normal' };
  assert.deepEqual(plain(J.publicState(set, st).current.media), { kind: 'audio' });
  st.options = { media: false };
  assert.equal(J.publicState(set, st).current.media, null);
});

test('Teil B: Optionen überleben normalizeState/Resume und Set-Normalisierung', () => {
  const o = { reactions: false, intro: false, awards: false, pixelRace: false, timer: false, timerSec: '20', qrTv: false, stats: false, media: false, backup: false, soundDefault: false };
  assert.deepEqual(plain(J.normalizeState({ options: o }, { resume: true }).options), o);
  assert.deepEqual(plain(J.normalizeSet({ options: o }).options), o);
});

test('awards() liefert weiter Daten (Aus passiert beim Rendern, nicht in der Statistik)', () => {
  const players = [{ id: 'a', name: 'A', score: 0 }];
  assert.ok(J.awards(players, { a: { right: 3 } }).length > 0);
});
