// Final Jeopardy: reine Spiellogik (unit-getestet), geteilt von Host und Spieleransicht.
// Der Ablauf liegt in state.fj; publicState() nimmt nur publicFinal() davon mit.
(function () {
  const J = window.J;
  const TIMER_MS = 30000;
  const MAX_ANSWER_LEN = 80;
  const PHASES = ['category', 'wager', 'question', 'reveal'];

  // Hat das Set eine Final-Jeopardy-Frage (Frage und Antwort ausgefüllt)?
  function hasFinal(set) {
    const f = set && set.final;
    return !!(f && typeof f.q === 'string' && f.q.trim() && typeof f.a === 'string' && f.a.trim());
  }

  // Final Jeopardy spielbar? Option „final“ (Host vor Set vor Standard) UND Frage + Antwort im Set
  const finalOn = (set, state) => J.opt(set, state, 'final') && hasFinal(set);

  // Höchster erlaubter Einsatz: der eigene Punktestand; wer 0 oder weniger hat, spielt mit, darf aber nur 0 setzen
  const maxWager = (score) => Math.max(0, Math.floor(Number(score) || 0));

  // Gültiger Einsatz (ganze Zahl 0..Punktestand) → Zahl, sonst null
  function parseWager(v) {
    if (typeof v === 'string' && v.trim() !== '') v = Number(v);
    return typeof v === 'number' && Number.isInteger(v) ? v : null;
  }
  function validWager(v, score) {
    const n = parseWager(v);
    return n != null && n >= 0 && n <= maxWager(score) ? n : null;
  }

  function cleanAnswer(v) {
    return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER_LEN) : null;
  }

  // Aufdeck-Reihenfolge: vom niedrigsten zum höchsten Punktestand (Gleichstand: Listenreihenfolge)
  function revealOrder(players) {
    return players.map((p, i) => ({ id: p.id, score: p.score, i }))
      .sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.id);
  }

  // Punkteänderung: richtig +Einsatz, falsch −Einsatz
  const scoreDelta = (wager, verdict) => (verdict === 'right' ? wager : wager ? -wager : 0);

  function newFinal(players) {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      phase: 'category', wagers: {}, answers: {}, timer: null,
      order: null, pending: null, done: {},
    };
  }

  // Wetten/Antworten sind nur in der jeweiligen Phase änderbar. Gibt true zurück, wenn etwas übernommen wurde.
  function submitWager(fj, players, pid, value) {
    const p = players.find((x) => x.id === pid);
    if (!fj || fj.phase !== 'wager' || !p) return false;
    const w = validWager(value, p.score);
    if (w == null) return false;
    fj.wagers[pid] = w;
    return true;
  }
  function submitAnswer(fj, players, pid, text, now = Date.now()) {
    if (!fj || fj.phase !== 'question' || !players.some((x) => x.id === pid)) return false;
    // Nach Ablauf der Zeit (mit etwas Netz-Toleranz) zählen keine Abgaben mehr
    if (fj.timer && now > fj.timer.endsAt + 1500) return false;
    const a = cleanAnswer(text);
    if (a == null) return false;
    fj.answers[pid] = a;
    return true;
  }

  // Wer hat noch nichts gesetzt? Beim Weitergehen zählt das als Einsatz 0.
  function fillMissingWagers(fj, players) {
    players.forEach((p) => { if (!(p.id in fj.wagers)) fj.wagers[p.id] = 0; });
  }

  // Einsatz, wie er beim Werten zählt (falls Punkte inzwischen von Hand geändert wurden, gekappt)
  function effectiveWager(fj, player) {
    return Math.min(maxWager(player.score), Math.max(0, Math.floor(Number(fj.wagers[player.id]) || 0)));
  }

  // Wer ist als Nächstes dran mit Aufdecken? null, wenn alle fertig
  function nextToReveal(fj, players) {
    return (fj.order || []).find((id) => !(id in fj.done) && players.some((p) => p.id === id)) || null;
  }
  const allDone = (fj, players) => !!fj.order && nextToReveal(fj, players) == null;

  // Was die Spieler sehen dürfen. Einsätze und Antworten bleiben bis zum Aufdecken beim Host;
  // vorher ist nur sichtbar, WER schon gesetzt/geantwortet hat. Die Lösung kommt erst mit der Aufdeck-Phase.
  function publicFinal(set, state) {
    const fj = state.fj;
    if (!fj || !PHASES.includes(fj.phase)) return null;
    const f = set.final || {};
    const phase = fj.phase;
    const live = (id) => state.players.some((p) => p.id === id);
    const showQ = phase === 'question' || phase === 'reveal';
    return {
      id: fj.id,
      phase,
      category: f.category || 'Final Jeopardy',
      q: showQ ? f.q || '' : null,
      a: phase === 'reveal' ? f.a || '' : null,
      wagered: phase === 'category' ? [] : Object.keys(fj.wagers).filter(live),
      answered: showQ ? Object.keys(fj.answers).filter(live) : [],
      timer: fj.timer ? { remaining: Math.max(0, fj.timer.endsAt - Date.now()), total: fj.timer.total } : null,
      order: phase === 'reveal' ? (fj.order || []).filter(live) : null,
      pending: phase === 'reveal' && fj.pending && live(fj.pending)
        ? { id: fj.pending, answer: fj.answers[fj.pending] || '' } : null,
      done: phase === 'reveal' ? Object.fromEntries(Object.entries(fj.done).filter(([id]) => live(id))) : {},
    };
  }

  J.fj = {
    TIMER_MS, MAX_ANSWER_LEN, hasFinal, finalOn, maxWager, parseWager, validWager, cleanAnswer, revealOrder, scoreDelta,
    newFinal, submitWager, submitAnswer, fillMissingWagers, effectiveWager, nextToReveal, allDone, publicFinal,
  };
})();
