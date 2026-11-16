// Daily Double: reine Spiellogik (unit-getestet), geteilt von Host und Spieleransicht.
// Markierte Felder stehen im Set (clue.dd), zufällige Felder in state.ddAuto[Runde]; aufgedeckt wird
// erst beim Öffnen des Feldes. Der Ablauf liegt in state.current.dd = { phase, pid, wager }:
// reveal (Animation für alle) → wager (nur wer am Zug ist setzt) → play (Frage, nur dieser Spieler antwortet).
(function () {
  const J = window.J;
  const MIN_WAGER = 5;
  const PHASES = ['reveal', 'wager', 'play'];

  // Höchster Feldwert der Runde (500 bzw. 1000)
  const roundTop = (round) => J.pointsFor(round, J.ROWS - 1);

  // Erlaubter Höchsteinsatz: der eigene Punktestand, mindestens aber der höchste Feldwert der Runde
  // (wer wenig oder Minuspunkte hat, darf trotzdem bis zum Rundenmaximum setzen)
  const maxWager = (score, round) => Math.max(Math.floor(Number(score) || 0), roundTop(round));

  // Gültiger Einsatz (ganze Zahl MIN..Höchsteinsatz) → Zahl, sonst null
  function validWager(v, score, round) {
    const n = J.fj.parseWager(v);
    return n != null && n >= MIN_WAGER && n <= maxWager(score, round) ? n : null;
  }

  // Punkteänderung: richtig +Einsatz, falsch −Einsatz (voll, nicht halbiert)
  const scoreDelta = (wager, verdict) => (verdict === 'right' ? wager : -wager);

  // Gilt „zufällig“? Option ddRandom (Host vor Set vor Standard); ohne Daily Double nie
  const randomOn = (set, state) => J.opt(set, state, 'ddRandom');
  // Daily Double überhaupt an? (Option dd) Aus = markierte/zufällige Felder sind normale Felder
  const enabled = (set, state) => J.opt(set, state, 'dd');

  // Zufällige Felder: 1 in Runde 1, 2 in Runde 2, nie in der ersten Reihe, verschiedene Kategorien
  function pickRandom(round, rnd = Math.random) {
    const count = round === 0 ? 1 : 2;
    const cats = Array.from({ length: J.CATS }, (_, i) => i);
    const out = [];
    while (out.length < count && cats.length) {
      const cat = cats.splice(Math.floor(rnd() * cats.length), 1)[0];
      out.push({ cat, row: 1 + Math.floor(rnd() * (J.ROWS - 1)) });
    }
    return out;
  }

  // Alle Daily-Double-Felder einer Runde: [{cat, row}]
  function cells(set, state, round) {
    if (!enabled(set, state)) return [];
    if (randomOn(set, state)) return (state.ddAuto && state.ddAuto[round]) || [];
    const out = [];
    set.rounds[round].categories.forEach((cat, c) => cat.clues.forEach((cl, row) => {
      if (cl.dd) out.push({ cat: c, row });
    }));
    return out;
  }
  const isDd = (set, state, round, cat, row) => cells(set, state, round).some((x) => x.cat === cat && x.row === row);

  // Beim Rundenstart/Einschalten von „zufällig“: Felder der Runde festlegen (nur wenn noch keine da sind)
  function ensureRandom(set, state, round, rnd = Math.random) {
    if (!randomOn(set, state)) return false;
    if (!Array.isArray(state.ddAuto)) state.ddAuto = [];
    if (state.ddAuto[round]) return false;
    state.ddAuto[round] = pickRandom(round, rnd);
    return true;
  }

  const newDd = (pid) => ({ phase: 'reveal', pid: pid || null, wager: null });

  // Was Spieler sehen dürfen (nur für ein geöffnetes Feld): Phase, wer spielt, Grenzen, Einsatz erst nach dem Setzen
  function publicDd(cur, state) {
    const dd = cur.dd;
    const p = state.players.find((x) => x.id === dd.pid);
    return {
      phase: PHASES.includes(dd.phase) ? dd.phase : 'reveal',
      pid: p ? p.id : null,
      wager: dd.wager,
      min: MIN_WAGER,
      max: p ? maxWager(p.score, cur.round) : roundTop(cur.round),
    };
  }

  J.dd = { MIN_WAGER, roundTop, maxWager, validWager, scoreDelta, enabled, randomOn, pickRandom, cells, isDd, ensureRandom, newDd, publicDd };
})();
