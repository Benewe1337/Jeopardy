// Final Jeopardy in der Spieleransicht (Handy und TV). player.js ruft render(s) bei jedem Zustand
// und onMine(msg) bei privaten Rückmeldungen; die Schnittstelle dazu ist J.playerApi.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => J.escapeHtml(s);
  const api = () => J.playerApi;

  let mine = { id: null, wager: null, answer: null, by: null }; // eigene (Team-)Abgabe
  let builtKey = null;   // für welche Phase die Eingabe gebaut ist (Eingabefelder bleiben beim Tippen stehen)
  let lastFinal = null;
  let timerEnd = null;
  let timerTotal = 0;
  let wasFinal = false;
  let shownDone = {};    // bereits animierte Wertungen

  function resetMine(id) {
    if (mine.id !== id) mine = { id, wager: null, answer: null, by: null };
  }

  function onMine(msg) {
    if (typeof msg.id !== 'string') return;
    mine = { id: msg.id, wager: msg.wager, answer: msg.answer, by: msg.by };
    builtKey = null; // Eingabefelder mit dem Teamstand neu aufbauen
    if (lastFinal) render(api().last());
  }

  const isPlayer = () => !!api().myPlayer();

  function status(text) { const el = $('fjStatus'); el.textContent = text; el.hidden = !text; }

  function wagerInput(f, me) {
    const max = J.fj.maxWager(me.score);
    const team = api().isTeam();
    const f2 = document.createElement('form');
    f2.className = 'fj-form';
    f2.noValidate = true; // eigene Prüfung (max-Attribut würde das Absenden stumm blockieren)
    f2.innerHTML = `<label>${team ? 'Euer' : 'Dein'} Einsatz (0–${max})
      <input id="fjWagerInput" type="number" inputmode="numeric" min="0" max="${max}" step="1" autocomplete="off" value="${mine.wager != null ? J.safeNum(mine.wager) : ''}" placeholder="0–${max}"${max === 0 ? ' disabled' : ''}></label>
      <button class="primary" type="submit" id="fjWagerBtn">${max === 0 ? 'Mit 0 mitspielen' : 'Einsatz setzen'}</button>
      ${max === 0 ? `<p class="fj-note" id="fjZero">${team ? 'Ihr habt' : 'Du hast'} keine Punkte – ${team ? 'ihr spielt' : 'du spielst'} mit, ${team ? 'könnt' : 'kannst'} aber nur 0 setzen.</p>` : ''}`;
    f2.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = f2.querySelector('input');
      const v = max === 0 ? 0 : J.fj.validWager(input.value, me.score);
      const conn = api().conn();
      if (v == null || !conn || !conn.open) { input.classList.add('invalid'); return; }
      input.classList.remove('invalid');
      mine.wager = v;
      conn.send({ type: 'fjwager', value: v });
      update(api().last());
    });
    return f2;
  }

  function answerInput() {
    const team = api().isTeam();
    const f2 = document.createElement('form');
    f2.className = 'fj-form';
    f2.innerHTML = `<label>${team ? 'Eure' : 'Deine'} Antwort
      <input id="fjAnswerInput" maxlength="${J.fj.MAX_ANSWER_LEN}" autocomplete="off" value="${esc(mine.answer || '')}" placeholder="Antwort eintippen"></label>
      <button class="primary" type="submit" id="fjAnswerBtn">Antwort abgeben</button>`;
    f2.addEventListener('submit', (e) => {
      e.preventDefault();
      const conn = api().conn();
      if (!conn || !conn.open) return;
      mine.answer = J.fj.cleanAnswer(f2.querySelector('input').value) || '';
      conn.send({ type: 'fjanswer', text: mine.answer });
      update(api().last());
    });
    return f2;
  }

  // Wertungskarten beim Aufdecken: Name, Antwort, ✓/✗, Einsatz, Änderung – die neueste wirkt dramatisch
  function revealView(s, f) {
    const nameOf = (id) => (s.players.find((p) => p.id === id) || {}).name || '?';
    const wrap = document.createElement('div');
    wrap.className = 'fj-reveal';
    wrap.innerHTML = `<div class="fj-solution">Richtig ist: <b>${esc(f.a)}</b></div>`;
    const cards = document.createElement('div');
    cards.className = 'fj-cards';
    (f.order || []).forEach((id) => {
      const d = f.done[id];
      const pend = f.pending && f.pending.id === id;
      if (!d && !pend) return;
      const card = document.createElement('div');
      card.className = 'fj-card ' + (d ? (d.verdict === 'right' ? 'right' : 'wrong') : 'pending');
      card.dataset.id = id;
      const fresh = d ? !(id in shownDone) : false;
      const answer = d ? d.answer : f.pending.answer;
      card.innerHTML = `<div class="fj-card-name">${esc(nameOf(id))}</div>
        <div class="fj-card-answer">${answer ? esc(answer) : '<i>keine Antwort</i>'}</div>` +
        (d ? `<div class="fj-card-verdict">${d.verdict === 'right' ? '✓ richtig' : '✗ falsch'}</div>
          <div class="fj-card-wager">Einsatz ${J.safeNum(d.wager)}</div>
          <div class="fj-card-delta">${d.delta > 0 ? '+' : '−'}${Math.abs(J.safeNum(d.delta))}</div>` : '');
      if (fresh) card.classList.add('fresh');
      cards.appendChild(card);
    });
    wrap.appendChild(cards);
    return wrap;
  }

  function render(s) {
    const f = s.final;
    const ov = $('finalBox');
    lastFinal = f;
    ov.classList.toggle('show', !!f);
    if (!f) { wasFinal = false; builtKey = null; shownDone = {}; timerEnd = null; $('fjTimerBox').hidden = true; return; }
    if (!wasFinal) { ov.classList.add('entering'); clearTimeout(ov.__enter); ov.__enter = setTimeout(() => ov.classList.remove('entering'), 400); }
    wasFinal = true;
    resetMine(f.id);
    if (f.phase !== 'reveal') shownDone = {};
    $('fjCategory').textContent = f.category;
    $('fjQ').textContent = f.q || '';
    $('fjQ').hidden = !f.q;
    syncTimer(f.timer);
    J.renderScores($('fjScores'), s.players, null);
    update(s);
    if (f.phase === 'reveal') Object.keys(f.done).forEach((id) => { shownDone[id] = true; });
  }

  // Eingabefeld nur neu bauen, wenn sich die Phase ändert (sonst springt es beim Tippen)
  function update(s) {
    const f = s.final;
    if (!f) return;
    const me = api().myPlayer();
    const box = $('fjBody');
    const total = s.players.length;
    const key = f.phase + ':' + (me ? me.id : 'view') + ':' + f.id + ':' + (me ? J.fj.maxWager(me.score) : 0) + ':' + (f.phase === 'reveal' ? JSON.stringify([f.pending, Object.keys(f.done)]) : '');
    if (key !== builtKey) {
      builtKey = key;
      box.innerHTML = '';
      if (f.phase === 'category') {
        const k = document.createElement('div');
        k.className = 'fj-teaser';
        k.textContent = 'Gleich geht es um die Wetten …';
        box.appendChild(k);
      } else if (f.phase === 'wager' && me) box.appendChild(wagerInput(f, me));
      else if (f.phase === 'question' && me) box.appendChild(answerInput());
      else if (f.phase === 'reveal') box.appendChild(revealView(s, f));
    }
    const team = api().isTeam();
    const iHave = me && f.wagered.includes(me.id);
    const iAns = me && f.answered.includes(me.id);
    if (f.phase === 'category') status('');
    else if (f.phase === 'wager') {
      status(`${f.wagered.length}/${total} haben gesetzt` + (me && mine.wager != null && iHave
        ? ` · ${team ? 'Euer' : 'Dein'} Einsatz: ${mine.wager} ✓${team && mine.by && mine.by !== api().myName() ? ` (${mine.by} hat gesetzt)` : ''}` : '')
        + (me ? '' : ' · Einsätze bleiben geheim'));
    } else if (f.phase === 'question') {
      status(`${f.answered.length}/${total} haben geantwortet` + (me && iAns && mine.answer != null
        ? ` · ${team ? 'Eure' : 'Deine'} Antwort: „${mine.answer}“ ✓${team && mine.by && mine.by !== api().myName() ? ` (${mine.by} hat abgegeben)` : ''}` : ''));
    } else status('');
  }

  // ---------- Timer ----------
  function syncTimer(t) {
    const box = $('fjTimerBox');
    if (!t) {
      timerEnd = null;
      J.renderTimer(box, null);
      if (J.timerMusicOn() && api().me() === 'tv') J.stopTimerMusic();
      return;
    }
    const end = Date.now() + t.remaining;
    const restarted = timerEnd == null || end > timerEnd + 1000;
    timerEnd = end;
    timerTotal = t.total;
    if (api().me() === 'tv' && restarted && J.soundOn()) J.startTimerMusic(t.remaining);
  }
  setInterval(() => {
    if (timerEnd == null) return;
    J.renderTimer($('fjTimerBox'), Math.max(0, timerEnd - Date.now()), timerTotal);
  }, 100);

  J.fjPlayer = { render, onMine };
})();
