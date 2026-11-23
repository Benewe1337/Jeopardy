// Host-Pult: Spielstand-Sicherung bedienen („Spiel fortsetzen“, Passwort, Status, Nur-Lese-Ansicht).
// Die Logik steckt in gamesync.js; hier nur DOM.
(function () {
  const $ = (id) => document.getElementById(id);
  const box = $('gameBox');
  const sync = J.gameSync;
  if (!box || !sync) return;

  box.innerHTML = `
    <summary>💾 Spiel sichern &amp; fortsetzen <span class="turn-state" id="gameState"></span></summary>
    <p class="hint opt-locked" id="gameOffNote" hidden>🚫 Server-Sicherung ist für dieses Spiel ausgeschaltet (Spielregel „Spielstand auf dem Server sichern“). Es wird nichts gesichert; der Datei-Export funktioniert weiter.</p>
    <p class="hint">Der Spielstand wird nach jedem Zug auf dem Server gesichert. Nach einem Absturz oder auf einem anderen Gerät
      kannst du hier weiterspielen – Spieler verbinden sich über denselben Link von selbst wieder.</p>
    <form id="gamePwForm" hidden>
      <label>Host-Passwort <input id="gamePw" type="password" autocomplete="off"></label>
      <p class="hint" id="gamePwMsg"></p>
      <button class="small primary">Entsperren</button>
    </form>
    <div id="gameFound" class="hint" hidden><strong>Laufendes Spiel gefunden.</strong> Fortsetzen oder ignorieren.</div>
    <div id="gameList"></div>`;

  const overlay = document.createElement('div');
  overlay.className = 'readonly-overlay';
  overlay.id = 'roOverlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="ro-card" role="alertdialog" aria-labelledby="roTitle">
      <h2 id="roTitle">Dieses Spiel läuft jetzt auf einem anderen Gerät</h2>
      <p>Hier lässt sich nichts mehr ändern. Du kannst das Spiel wieder hierher holen – dann übernimmt dieses Fenster und das andere wird zur Ansicht.</p>
      <div class="btn-row">
        <button class="primary" id="roTake">Hier wieder übernehmen</button>
        <button class="ghost" id="roClose">Schließen</button>
      </div>
      <p class="hint" id="roMsg"></p>
    </div>`;
  const bar = document.createElement('div');
  bar.className = 'readonly-bar';
  bar.id = 'roBar';
  bar.hidden = true;
  bar.innerHTML = '<span>Nur Ansicht – das Spiel läuft auf einem anderen Gerät.</span> <button class="small primary" id="roBarTake">Hier übernehmen</button>';
  document.body.append(overlay, bar);

  const ago = (iso) => {
    const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (min < 1) return 'gerade eben';
    if (min < 60) return `vor ${min} Min.`;
    if (min < 1440) return `vor ${Math.round(min / 60)} Std.`;
    return `vor ${Math.round(min / 1440)} Tg.`;
  };
  const localEmpty = () => {
    const st = J.loadState();
    return !st.players.length && !st.used.some((r) => r.some((c) => c.some(Boolean)));
  };
  let currentRoom = null;

  function renderStatus(s) {
    const el = $('saveStatus');
    const off = sync.enabled === false && s.kind !== 'off' && s.kind !== 'readonly';
    $('gameOffNote').hidden = !off;
    const label = off ? 'Sicherung aus' : { ok: 'Gesichert ✓', offline: 'Sicherung offline', readonly: 'Nur Ansicht' }[s.kind];
    el.hidden = !label;
    el.textContent = label || '';
    el.className = 'status-inline ' + (off ? '' : s.kind === 'ok' ? 'ok' : 'bad');
    el.title = s.savedAt ? 'Zuletzt gesichert: ' + new Date(s.savedAt).toLocaleTimeString('de-DE') : '';
    box.hidden = s.kind === 'off';
    $('gameState').textContent = off ? 'aus' : { ok: '✓ aktiv', offline: 'offline', needpw: 'gesperrt', readonly: 'Nur Ansicht' }[s.kind] || '';
    $('gameState').className = 'turn-state ' + (s.kind === 'ok' && !off ? 'on' : '');
    $('gamePwForm').hidden = s.kind !== 'needpw';
    $('gamePwMsg').textContent = s.wrong ? 'Falsches Passwort.' : 'Ohne Passwort wird nur in diesem Browser gespeichert.';
    $('gameList').hidden = s.kind === 'needpw';
    const ro = s.kind === 'readonly';
    document.body.classList.toggle('readonly', ro);
    const page = document.querySelector('.host-page');
    if (page) page.inert = ro;
    if (ro && !overlay.dataset.closed) overlay.hidden = false;
    bar.hidden = !ro || !overlay.hidden;
    if (s.kind === 'ok') refreshList();
  }
  sync.onStatus(renderStatus);

  async function refreshList() {
    let games;
    try { games = await sync.list(); } catch (e) { return; }
    const wrap = $('gameList');
    if (!games.length) { wrap.innerHTML = '<p class="hint">Kein gesichertes Spiel.</p>'; return; }
    wrap.innerHTML = games.map((g) => `
      <div class="game-item" data-room="${J.escapeHtml(g.room)}">
        <div><strong>${J.escapeHtml(g.title || 'Ohne Titel')}</strong>${g.finished ? ' · beendet' : ''}<br>
          <small>Raum ${J.escapeHtml(g.room)} · Runde ${J.safeNum(g.round) + 1} · ${J.safeNum(g.players)} Spieler · ${ago(g.updated)}${g.room === currentRoom ? ' · läuft hier' : ''}</small></div>
        <div class="btn-row">
          ${g.room === currentRoom ? '' : '<button class="small primary" data-act="resume">Fortsetzen</button>'}
          <button class="small ghost" data-act="drop">Verwerfen</button>
        </div>
      </div>`).join('');
    $('gameFound').hidden = !(localEmpty() && games.some((g) => g.room !== currentRoom));
    if (!$('gameFound').hidden) box.open = true;
  }

  async function doResume(room) {
    try {
      await sync.resume(room);
      location.reload();
    } catch (e) {
      alert('Spiel konnte nicht geladen werden: ' + e.message);
    }
  }

  $('gameList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const room = btn.closest('.game-item').dataset.room;
    if (btn.dataset.act === 'resume') {
      if (!localEmpty() && !confirm(`Den aktuellen Spielstand in diesem Browser durch das gesicherte Spiel (Raum ${room}) ersetzen?`)) return;
      doResume(room);
    } else if (confirm(`Gesichertes Spiel (Raum ${room}) endgültig verwerfen?`)) {
      try { await sync.remove(room); } catch (err) { alert('Löschen fehlgeschlagen: ' + err.message); }
      refreshList();
    }
  });

  $('gamePwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await sync.connect($('gamePw').value);
    $('gamePw').value = '';
    if (sync.status.kind === 'ok') sync.touch();
  });

  // Nur-Lese-Ansicht: Stand vom Server holen und hier weiterspielen
  const takeBack = async () => {
    $('roMsg').textContent = 'Lade Spielstand…';
    try {
      await sync.resume(currentRoom);
      location.reload();
    } catch (e) {
      $('roMsg').textContent = 'Übernehmen fehlgeschlagen: ' + e.message;
    }
  };
  $('roTake').addEventListener('click', takeBack);
  $('roBarTake').addEventListener('click', takeBack);
  $('roClose').addEventListener('click', () => {
    overlay.dataset.closed = '1';
    overlay.hidden = true;
    bar.hidden = false;
  });

  /** Beim Start des Hosts (relay): Server prüfen, ggf. Konflikt klären. */
  async function start(room) {
    currentRoom = room;
    const res = await sync.init(room);
    if (res.conflict) {
      const g = res.conflict;
      const load = confirm(`Auf einem anderen Gerät wurde dieses Spiel zuletzt gesichert (${ago(g.updated)}, Runde ${g.round + 1}, ${g.players} Spieler).\n\n` +
        'OK: Stand vom Server laden und hier weiterspielen.\nAbbrechen: lokalen Stand behalten und das Spiel hierher holen.');
      if (load) { await sync.resume(room); location.reload(); return new Promise(() => {}); }
      await sync.keepLocal(room);
      sync.touch();
    }
    if (sync.status.kind === 'ok') refreshList();
  }

  J.gameUI = { start };
})();
