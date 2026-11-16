// Final Jeopardy im Host-Pult. Wird vor host.js geladen; host.js ruft init() mit J.hostApi auf.
(function () {
  const $ = (id) => document.getElementById(id);
  let api = null;
  const F = () => J.fj;
  const st = () => api.state();
  const timerMs = () => window.JEOP_FJ_TIMER_MS || F().TIMER_MS;
  const esc = (s) => J.escapeHtml(s);

  const PHASE_LABEL = {
    category: '1/4 · Kategorie zeigen', wager: '2/4 · Einsätze', question: '3/4 · Frage & Antworten', reveal: '4/4 · Aufdecken',
  };

  // ---------- Ablauf ----------
  function start() {
    const state = st();
    if (!F().finalOn(api.set(), state) || !state.players.length || state.current || state.fj) return;
    api.mutate('⭐ Final Jeopardy gestartet', () => {
      state.fj = F().newFinal(state.players);
      state.finished = false;
    });
    api.sound('intro');
  }

  function toWager() {
    api.mutate('Final Jeopardy: Einsätze freigegeben', () => { st().fj.phase = 'wager'; });
    api.sound('catreveal');
  }

  function toQuestion() {
    const state = st();
    api.mutate('Final Jeopardy: Frage gezeigt', () => {
      F().fillMissingWagers(state.fj, state.players);
      state.fj.phase = 'question';
      const total = timerMs();
      state.fj.timer = { endsAt: Date.now() + total, total };
    });
    api.sound('open');
  }

  function toReveal() {
    const state = st();
    api.mutate('Final Jeopardy: Antworten eingesammelt', () => {
      state.fj.phase = 'reveal';
      state.fj.timer = null;
      state.fj.order = F().revealOrder(state.players);
      state.fj.pending = null;
      state.fj.done = {};
    });
    api.sound('reveal');
  }

  function revealNext() {
    const state = st();
    const id = F().nextToReveal(state.fj, state.players);
    if (!id || state.fj.pending) return;
    api.mutate(`Final Jeopardy: Antwort von ${api.nameOf(id)} aufgedeckt`, () => { state.fj.pending = id; });
    api.sound('reveal');
  }

  function judge(verdict) {
    const state = st();
    const fj = state.fj;
    const p = state.players.find((x) => x.id === fj.pending);
    if (!p) return;
    const wager = F().effectiveWager(fj, p);
    const delta = F().scoreDelta(wager, verdict);
    api.mutate(`Final Jeopardy: ${p.name} ${verdict === 'right' ? 'richtig' : 'falsch'} (${delta > 0 ? '+' : ''}${delta})`, () => {
      p.score += delta;
      fj.done[p.id] = { answer: fj.answers[p.id] || '', wager, verdict, delta, score: p.score };
      if (!st().stats) st().stats = {};
      J.stats.recordFinal(st().stats, p.id, { wager, verdict, delta });
      fj.pending = null;
    });
    api.sound(verdict === 'right' ? 'right' : 'wrong');
  }

  function close() {
    api.mutate('Final Jeopardy beendet', () => { st().fj = null; });
  }

  function stopTimer() {
    st().fj.timer = null;
    api.commit();
  }

  // ---------- Nachrichten der Spieler ----------
  function onData(conn, msg) {
    const state = st();
    const fj = state.fj;
    const pid = conn.playerId;
    if (!fj || !pid) return;
    const ok = msg.type === 'fjwager'
      ? F().submitWager(fj, state.players, pid, msg.value)
      : F().submitAnswer(fj, state.players, pid, msg.text);
    if (!ok) return;
    api.commit();
    sendMine(pid, conn.memberName);
  }

  // Eigene Abgabe zurück an alle Geräte dieses Spielers/Teams (Team-Modus: alle sehen, was zählt)
  function sendMine(pid, by) {
    const fj = st().fj;
    if (!fj) return;
    const msg = { type: 'fjMine', id: fj.id, wager: fj.wagers[pid] ?? null, answer: fj.answers[pid] ?? null, by: by || null };
    api.conns.forEach((c) => { if (c.open && c.playerId === pid) c.send(msg); });
  }

  // ---------- Anzeige ----------
  function renderStartButton() {
    const state = st();
    const btn = $('fjBtn');
    // Option „Final Jeopardy“ aus: weder Knopf noch Hinweis
    const on = J.opt(api.set(), state, 'final');
    btn.hidden = !on && !state.fj;
    const has = F().hasFinal(api.set());
    const reason = !has ? 'Dieses Set hat keine Final-Jeopardy-Frage. Im Editor unter „Final Jeopardy“ ergänzen.'
      : !state.players.length ? 'Erst Spieler bzw. Teams anlegen.'
        : state.current ? 'Erst die offene Frage schließen.'
          : state.fj ? 'Final Jeopardy läuft schon.' : '';
    btn.disabled = !!reason;
    btn.title = reason || 'Final Jeopardy starten (meist nach Runde 2)';
    // Hinweis nur zeigen, wenn es am Set liegt – sonst wäre der ausgegraute Knopf unerklärlich
    $('fjHint').hidden = has || !on;
    $('fjHint').textContent = has ? '' : 'Final Jeopardy ist für dieses Set nicht angelegt (Editor → „Final Jeopardy“).';
  }

  function playerRows(fj, cols) {
    const state = st();
    return state.players.map((p) => {
      const w = fj.wagers[p.id];
      const a = fj.answers[p.id];
      return `<div class="srow"><span class="name">${esc(p.name)} <small>(${J.safeNum(p.score)})</small></span><span>${cols(p, w, a)}</span></div>`;
    }).join('');
  }

  function renderPanel() {
    const state = st();
    const fj = state.fj;
    const el = $('fjPanel');
    el.classList.toggle('show', !!fj);
    if (!fj) { el.innerHTML = ''; return; }
    const f = api.set().final;
    const n = state.players.length;
    const wagered = state.players.filter((p) => p.id in fj.wagers).length;
    const answered = state.players.filter((p) => p.id in fj.answers).length;
    let body = '';
    let actions = '';
    if (fj.phase === 'category') {
      body = `<div class="hint">Alle sehen jetzt die Kategorie. Danach die Einsätze freigeben.</div>`;
      actions = '<button class="primary" id="fjNext">Einsätze freigeben</button>';
    } else if (fj.phase === 'wager') {
      body = `<div class="special-head">Einsätze – ${wagered}/${n} gesetzt</div>` +
        playerRows(fj, (p, w) => (w == null ? '… wartet' : `✓ ${J.safeNum(w)}`) + (F().maxWager(p.score) === 0 ? ' · nur 0 möglich' : '')) +
        '<div class="hint">Wer nichts setzt, setzt 0. Wer 0 oder weniger Punkte hat, spielt mit, kann aber nur 0 setzen.</div>';
      actions = '<button class="primary" id="fjNext">Frage zeigen &amp; Timer starten</button>';
    } else if (fj.phase === 'question') {
      body = `<div class="special-head">Antworten – ${answered}/${n} abgegeben</div>` +
        playerRows(fj, (p, w, a) => `Einsatz ${J.safeNum(w)} · ${a == null ? '… wartet' : esc(a || '(leer)')}`) +
        '<div class="hint">Antworten sind nur für dich sichtbar. Spieler können bis Zeitende ändern.</div>';
      actions = `<button class="primary" id="fjNext">Antworten einsammeln &amp; Aufdecken starten</button>` +
        (fj.timer ? '<button id="fjTimerStop">Timer stoppen</button>' : '');
    } else {
      const next = F().nextToReveal(fj, state.players);
      const pend = fj.pending && state.players.find((p) => p.id === fj.pending);
      body = `<div class="special-head">Aufdecken – vom niedrigsten zum höchsten Punktestand</div>` +
        (fj.order || []).map((id) => {
          const p = state.players.find((x) => x.id === id);
          if (!p) return '';
          const d = fj.done[id];
          const cur = fj.pending === id;
          const detail = d ? `${esc(d.answer || '(keine Antwort)')} · Einsatz ${J.safeNum(d.wager)} · ${d.verdict === 'right' ? '✓' : '✗'} ${d.delta > 0 ? '+' : ''}${J.safeNum(d.delta)}`
            : cur ? '▶ wird gerade gezeigt' : `Einsatz ${J.safeNum(F().effectiveWager(fj, p))} · ${esc(fj.answers[id] || '(keine Antwort)')}`;
          return `<div class="srow${d ? (d.verdict === 'right' ? ' won' : ' lost') : ''}"><span class="name">${esc(p.name)}</span><span>${detail}</span></div>`;
        }).join('');
      if (pend) {
        const w = F().effectiveWager(fj, pend);
        actions = `<button class="green" id="fjRight">✓ richtig +${w}</button><button class="red" id="fjWrong">✗ falsch −${w}</button>`;
      } else if (next) {
        actions = `<button class="primary" id="fjNext">Antwort von ${esc(api.nameOf(next))} aufdecken</button>`;
      } else {
        actions = '<button class="primary" id="fjPodium">🏆 Zur Siegerehrung</button><button id="fjClose">Final Jeopardy beenden</button>';
      }
    }
    el.innerHTML = `
      <div class="meta">⭐ Final Jeopardy · ${PHASE_LABEL[fj.phase]}</div>
      <div class="q">${esc(f.category || 'Final Jeopardy')}</div>
      <div class="fj-q">${esc(f.q)}</div>
      <div class="a">${esc(f.a)}</div>
      ${f.note ? `<div class="note">${esc(f.note)}</div>` : ''}
      <div class="timer" id="fjTimerBox" hidden><div class="timer-track"><div class="timer-fill"></div></div><span class="timer-num"></span></div>
      <div class="special" id="fjList">${body}</div>
      <div class="clue-actions">${actions}${fj.phase !== 'reveal' || !F().allDone(fj, state.players) ? '<button id="fjClose">Abbrechen</button>' : ''}</div>`;
    const on = (id, fn) => { const b = el.querySelector('#' + id); if (b) b.addEventListener('click', fn); };
    on('fjNext', fj.phase === 'category' ? toWager : fj.phase === 'wager' ? toQuestion : fj.phase === 'question' ? toReveal : revealNext);
    on('fjRight', () => judge('right'));
    on('fjWrong', () => judge('wrong'));
    on('fjTimerStop', stopTimer);
    on('fjClose', () => { if (fj.phase === 'reveal' && Object.keys(fj.done).length && !confirm('Final Jeopardy abbrechen? Bereits gewertete Punkte bleiben (Rückgängig möglich).')) return; close(); });
    on('fjPodium', () => $('finishBtn').click());
    tickTimer();
  }

  // ---------- Timer (Host) ----------
  let musicFor = null;
  function tickTimer() {
    const state = st();
    const t = state && state.fj && state.fj.timer;
    const box = $('fjTimerBox');
    if (!t) {
      if (box) J.renderTimer(box, null);
      if (musicFor) { musicFor = null; J.stopTimerMusic(); }
      return;
    }
    const remaining = t.endsAt - Date.now();
    if (musicFor !== t.endsAt && remaining > 0) {
      musicFor = t.endsAt;
      if (J.soundOn()) J.startTimerMusic(remaining);
    }
    if (remaining <= 0) {
      state.fj.timer = null; // läuft ab, ohne dass die Phase wechselt: du entscheidest, wann aufgedeckt wird
      api.commit();
      api.sound('timeup');
      return;
    }
    if (box) J.renderTimer(box, remaining, t.total);
  }

  function init(hostApi) {
    api = J.hostApi || hostApi;
    $('fjBtn').addEventListener('click', start);
    setInterval(tickTimer, 100);
  }

  function render() {
    if (!api) return;
    renderStartButton();
    renderPanel();
  }

  J.fjHost = { init, render, onData, sendMine, start };
})();
