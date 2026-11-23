// Punkteverteilung (⚖️ splitScoring): mit Hauptschalter aus – und an mit Standardwerten – gilt exakt die alte Formel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCommon } = require('./load-common');

const { J } = loadCommon();
const plain = (v) => JSON.parse(JSON.stringify(v));

// Eingefrorene Kopie der Formel vor der Punkteverteilung (js/common.js bis 2026-11-23.1)
const old = {
  points: (round, row) => (row + 1) * 100 * (round + 1),
  penalty(round, row, mode) { const v = this.points(round, row); return mode === 'full' ? v : mode === 'none' ? 0 : v / 2; },
  steal(round, row, half) { const v = this.points(round, row); return half === false ? v : v / 2; },
  judge(round, row, { stolen, double, penalty, stealHalf }) {
    const value = this.points(round, row);
    const gain = stolen ? this.steal(round, row, stealHalf) : value;
    return double ? { gain: gain * 2, penalty: value } : { gain, penalty: this.penalty(round, row, penalty) };
  },
};

const baseOpts = (o = {}) => ({ penalty: 'half', stealHalf: true, turn: true, abstainPenalty: false, splitScoring: false, turnShare: '100', otherShare: '100', otherPenalty: 'same', estimateRunnerUp: '0', stealShare: '50', ...o });
const eff = (options, extra) => {
  const set = J.defaultSet();
  set.options = options;
  return J.effectiveOptions(set, extra || null);
};

test('splitPoints = alte Formel: Schalter aus UND an mit Standardwerten, 0 Abweichungen', () => {
  let n = 0;
  for (const split of [false, true]) for (const round of [0, 1]) for (let row = 0; row < 5; row++) {
    for (const penalty of ['half', 'full', 'none']) for (const stealHalf of [true, false]) {
      for (const stolen of [false, true]) for (const double of [false, true]) for (const active of [false, true]) for (const turn of [true, false]) {
        const opts = eff({ splitScoring: split, penalty, stealHalf, turn }); // stealShare folgt stealHalf
        const got = J.splitPoints(round, row, { opts, active, stolen, double });
        const want = old.judge(round, row, { stolen, double, penalty, stealHalf });
        assert.deepEqual({ gain: got.gain, penalty: got.penalty }, want, JSON.stringify({ split, round, row, penalty, stealHalf, stolen, double, active, turn }));
        assert.deepEqual(plain(J.judgePoints(round, row, { stolen, double, penalty, stealHalf })), want, 'judgePoints ohne opts');
        n++;
      }
    }
  }
  assert.equal(n, 2 * 2 * 5 * 3 * 2 * 2 * 2 * 2 * 2);
});

test('Schalter aus: gespeicherte Stellschrauben im Set = Standardwerte, stealHalf wirkt weiter', () => {
  const opts = eff({ turnShare: '25', otherShare: '0', otherPenalty: 'none', estimateRunnerUp: '50', stealShare: '25', stealHalf: false });
  assert.equal(opts.splitScoring, false);
  assert.deepEqual([opts.turnShare, opts.otherShare, opts.otherPenalty, opts.estimateRunnerUp], ['100', '100', 'same', '0']);
  assert.equal(opts.stealShare, '100', 'Standard folgt stealHalf (aus → 100 %)');
  for (const active of [true, false]) {
    assert.deepEqual(plain(J.splitPoints(0, 2, { opts, active })), { gain: 300, penalty: 150, runnerUp: 0 });
    assert.equal(J.splitPoints(0, 2, { opts, active, stolen: true }).gain, 300, 'stealHalf false = voller Wert');
  }
  assert.equal(J.splitLine(opts, 0, 2, 'estimate'), '');
});

test('stealShare: Standard aus stealHalf, gespeicherter Wert gilt nur bei eingeschaltetem Schalter', () => {
  assert.equal(eff({ splitScoring: true }).stealShare, '50');
  assert.equal(eff({ splitScoring: true, stealHalf: false }).stealShare, '100');
  assert.equal(eff({ splitScoring: true, stealShare: '75' }).stealShare, '75');
  assert.equal(eff({ splitScoring: true, stealShare: '75', steal: false }).stealShare, '50', 'Klauen aus → Standard');
  for (const [share, want] of [['100', 500], ['75', 375], ['50', 250], ['25', 125]]) {
    const o = eff({ splitScoring: true, stealShare: share });
    assert.equal(J.splitPoints(0, 4, { opts: o, stolen: true }).gain, want);
    assert.equal(J.splitPoints(0, 4, { opts: o, stolen: true, double: true }).gain, want * 2, 'Doppelt: Klau-Anteil ×2');
  }
  // stealHalf bleibt bei eingeschaltetem Schalter unwirksam
  assert.equal(J.splitPoints(0, 0, { opts: eff({ splitScoring: true, stealShare: '25', stealHalf: false }), stolen: true }).gain, 25);
});

test('turnShare / otherShare: am Zug vs. alle anderen; Rundung auf ganze Punkte', () => {
  const opts = eff({ splitScoring: true, turnShare: '75', otherShare: '25' });
  assert.equal(J.splitPoints(0, 0, { opts, active: true }).gain, 75);
  assert.equal(J.splitPoints(0, 0, { opts, active: false }).gain, 25);
  assert.equal(J.splitPoints(1, 4, { opts, active: false }).gain, 250);
  assert.equal(J.splitPoints(0, 0, { opts: eff({ splitScoring: true, otherShare: '0' }), active: false }).gain, 0);
  for (const round of [0, 1]) for (let row = 0; row < 5; row++) for (const s of ['100', '75', '50', '25', '0']) {
    const g = J.splitPoints(round, row, { opts: eff({ splitScoring: true, otherShare: s }) }).gain;
    assert.ok(Number.isInteger(g), `${round}/${row}/${s} → ${g}`);
  }
});

test('Am Zug aus: alle bekommen otherShare, turnShare ist wirkungslos', () => {
  const opts = eff({ splitScoring: true, turn: false, turnShare: '0', otherShare: '50' });
  assert.equal(opts.turnShare, '100', 'braucht Am Zug');
  assert.equal(J.splitPoints(0, 3, { opts, active: true }).gain, 200);
  assert.equal(J.splitPoints(0, 3, { opts, active: false }).gain, 200);
});

test('otherPenalty × abstainPenalty: Am Zug behält den normalen Abzug, alle anderen nach Stufe', () => {
  for (const abstain of [false, true]) for (const penalty of ['half', 'full', 'none']) {
    const base = old.penalty(1, 2, penalty);
    const mk = (otherPenalty) => eff({ splitScoring: true, abstainPenalty: abstain, penalty, otherPenalty });
    // abstainPenalty wählt nur, WER Abzug bekommt (Host); die Höhe kommt immer aus splitPoints
    assert.equal(J.splitPoints(1, 2, { opts: mk('same'), active: false }).penalty, base);
    assert.equal(J.splitPoints(1, 2, { opts: mk('half'), active: false }).penalty, base / 2);
    assert.equal(J.splitPoints(1, 2, { opts: mk('none'), active: false }).penalty, 0);
    for (const o of ['same', 'half', 'none']) assert.equal(J.splitPoints(1, 2, { opts: mk(o), active: true }).penalty, base, 'am Zug unverändert');
  }
});

test('Doppelt oder nichts bleibt unberührt (nur Klau-Anteil gilt)', () => {
  const opts = eff({ splitScoring: true, turnShare: '25', otherShare: '0', otherPenalty: 'none' });
  for (const active of [true, false]) assert.deepEqual(plain(J.splitPoints(0, 1, { opts, active, double: true })), { gain: 400, penalty: 200, runnerUp: 0 });
});

test('Schätzfrage: Zweitnächster nur bei genau einem Gewinner', () => {
  assert.deepEqual(plain(J.estimateRunnerUps({ a: 10, b: 12, c: 20 }, 10)), ['b']);
  assert.deepEqual(plain(J.estimateRunnerUps({ a: 10, b: 12, c: 8 }, 10)), ['b', 'c'], 'Gleichstand auf Platz 2: beide');
  assert.deepEqual(plain(J.estimateRunnerUps({ a: 10, b: 10, c: 20 }, 10)), [], 'Gleichstand auf Platz 1: keiner');
  assert.deepEqual(plain(J.estimateRunnerUps({ a: 10 }, 10)), []);
  assert.deepEqual(plain(J.estimateRunnerUps({ a: 10, b: 12 }, NaN)), []);
  for (const [v, want] of [['0', 0], ['25', 125], ['50', 250]]) {
    assert.equal(J.splitPoints(0, 4, { opts: eff({ splitScoring: true, estimateRunnerUp: v }) }).runnerUp, want);
  }
  assert.equal(J.splitPoints(0, 4, { opts: eff({ estimateRunnerUp: '50' }) }).runnerUp, 0, 'Schalter aus');
});

test('Teams: jedes Team einzeln nach „am Zug“', () => {
  const opts = eff({ splitScoring: true, turnShare: '100', otherShare: '50' });
  const teams = ['t1', 't2', 't3'];
  const turn = 't2';
  const gains = teams.map((id) => J.splitPoints(0, 2, { opts, active: id === turn }).gain);
  assert.deepEqual(gains, [150, 300, 150]);
});

test('publicState().opts: Teilwerte, Standardwerte bei ausgeschaltetem Schalter', () => {
  const set = J.defaultSet();
  const st = J.defaultState();
  st.players = [{ id: 'a', name: 'A', score: 0 }];
  set.options = { turnShare: '50', stealHalf: false };
  const off = J.publicState(set, st).opts;
  assert.deepEqual([off.splitScoring, off.turnShare, off.otherShare, off.otherPenalty, off.estimateRunnerUp, off.stealShare], [false, '100', '100', 'same', '0', '100']);
  set.options = { splitScoring: true, turnShare: '50', otherPenalty: 'half', estimateRunnerUp: '25' };
  const on = J.publicState(set, st).opts;
  assert.deepEqual([on.splitScoring, on.turnShare, on.otherShare, on.otherPenalty, on.estimateRunnerUp, on.stealShare], [true, '50', '100', 'half', '25', '50']);
});

test('splitLine: nur bei Schalter an UND Abweichung vom Standard', () => {
  assert.equal(J.splitLine(eff({ splitScoring: true }), 0, 2, 'normal'), '');
  assert.equal(J.splitLine(eff({ splitScoring: true, stealShare: '25' }), 0, 2, 'normal'), '', 'Klau-Anteil steht im Klau-Hinweis');
  assert.equal(J.splitLine(eff({ splitScoring: true, otherShare: '50', otherPenalty: 'half' }), 0, 4, 'normal'),
    'Am Zug: volle Punkte · alle anderen: 50 % · Falsch: am Zug −250, andere −125');
  assert.equal(J.splitLine(eff({ splitScoring: true, otherShare: '50', otherPenalty: 'half', turn: false }), 0, 4, 'normal'),
    'Richtige: 50 % · Falsch kostet −125');
  assert.equal(J.splitLine(eff({ splitScoring: true, estimateRunnerUp: '25' }), 0, 0, 'normal'), '');
  assert.equal(J.splitLine(eff({ splitScoring: true, estimateRunnerUp: '25' }), 0, 0, 'estimate'), 'Zweitnächster: 25 %');
  assert.equal(J.splitLine(eff({ turnShare: '50' }), 0, 0, 'normal'), '');
});

test('Optionen: Schalter und Stellschrauben gültig; Sichtbarkeitsregeln', () => {
  const sub = ['turnShare', 'otherShare', 'otherPenalty', 'estimateRunnerUp', 'stealShare'];
  for (const k of sub) assert.deepEqual(plain(J.OPTION_DEFS.find((d) => d.key === k).showIf), { splitScoring: true });
  assert.deepEqual(plain(J.OPTION_DEFS.find((d) => d.key === 'stealHalf').hideIf), { splitScoring: true });
  assert.deepEqual(plain(J.cleanOptions({ turnShare: '75', otherShare: '33', stealShare: '25', otherPenalty: 'half', estimateRunnerUp: '50', splitScoring: true })),
    { turnShare: '75', stealShare: '25', otherPenalty: 'half', estimateRunnerUp: '50', splitScoring: true });
});
