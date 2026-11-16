// Spielstand sichern und fortsetzen (nur Relay/Vercel, api/game, geschützt durch das Host-Passwort).
// Der Browser (localStorage) bleibt der Primärspeicher – das Spiel hängt nie vom Server ab. Der Server
// bekommt nach jedem Zug (gebündelt) eine Kopie, damit ein anderes Gerät das Spiel fortsetzen kann.
// Welches Fenster schreiben darf, regelt die Session-ID: Übernimmt ein anderes Fenster (claim),
// bekommt dieses beim nächsten Speichern 409 und wird zur reinen Ansicht („readonly“).
(function () {
  const API = 'api/game';
  const SETS_API = 'api/sets';
  const PW_KEY = 'jeopardy.hostPw'; // gleiches Passwort wie bei den Fragensets
  const SESSION_KEY = 'jeopardy.session'; // sessionStorage: Reload im selben Tab bleibt Schreiber
  const TAKEOVER_KEY = 'jeopardy.takeover'; // sessionStorage: nächster Host-Start übernimmt den Raum
  const REV_KEY = 'jeopardy.syncRev'; // localStorage: { room, rev } der letzten bestätigten Sicherung
  const DEBOUNCE_MS = window.JEOP_SYNC_MS || 1500;
  const RETRY_MS = window.JEOP_SYNC_RETRY_MS || 10000;
  const HISTORY_KEEP = 30;
  const STATE_MAX = 550000; // Server erlaubt 600 KB
  const SET_MAX = 3000000;

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} },
  };
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} },
  };
  const randomId = (n = 24) => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return [...a].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  };

  let sessionId = ss.get(SESSION_KEY);
  if (!sessionId) { sessionId = randomId(); ss.set(SESSION_KEY, sessionId); }

  // ---------- Status ----------
  // kind: off (kein Server) | needpw | ok | offline | readonly
  const listeners = [];
  const sync = {
    status: { kind: 'off', wrong: false, savedAt: null },
    get readonly() { return sync.status.kind === 'readonly'; },
    session: () => sessionId,
    onStatus(fn) { listeners.push(fn); },
  };
  function setStatus(kind, extra = {}) {
    if (sync.readonly && kind !== 'readonly') return; // Nur-Lese-Modus ist endgültig bis zur Übernahme
    sync.status = { ...sync.status, kind, wrong: false, ...extra };
    listeners.forEach((fn) => { try { fn(sync.status); } catch (e) { console.error(e); } });
  }

  // ---------- Server ----------
  async function call(op, { query, body, keepalive } = {}) {
    const q = new URLSearchParams({ op, ...(query || {}) });
    const res = await fetch(`${API}?${q}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-host-password': ls.get(PW_KEY) || '' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'same-origin',
      keepalive: !!keepalive,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error || 'HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /** Passwort prüfen und Status setzen. Ohne Server/Datenbank (404/503) → 'off'. */
  async function connect(password = ls.get(PW_KEY) || '') {
    let res;
    try {
      res = await fetch(`${API}?op=check`, {
        headers: { 'x-host-password': password }, cache: 'no-store', credentials: 'same-origin',
      });
    } catch (e) { setStatus('off'); return 'off'; }
    if (res.ok) {
      ls.set(PW_KEY, password);
      setStatus('ok');
      return 'ok';
    }
    const json = await res.json().catch(() => null);
    if (res.status === 401 && json && json.error === 'wrong host password') {
      if (password) ls.set(PW_KEY, null);
      setStatus('needpw', { wrong: !!password });
      return 'needpw';
    }
    setStatus('off');
    return 'off';
  }

  const list = async () => (await call('list')).games;
  const get = (room, withSet) => call('get', { query: { room, ...(withSet ? { set: '1' } : {}) } });
  const remove = (room) => call('delete', { body: { room } });

  const readRev = () => { try { return JSON.parse(ls.get(REV_KEY)) || {}; } catch (e) { return {}; } };
  const rememberRev = (room, rev) => ls.set(REV_KEY, JSON.stringify({ room, rev }));

  // ---------- Speichern (Debounce) ----------
  let provider = null; // () => { room, state, set, setId?, title }
  let timer = null;
  let retryTimer = null;
  let busy = false;
  let dirty = false;
  let lastSetSha = null;

  async function sha(text) {
    try {
      const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return text.length + ':' + text.slice(0, 64); }
  }

  // State für den Server: History kürzen, bis er unter dem Limit liegt
  function trimState(state, keepHistory = true) {
    const st = { ...state, history: keepHistory ? (state.history || []).slice(-HISTORY_KEEP) : [] };
    while (st.history.length && JSON.stringify(st).length > STATE_MAX) st.history = st.history.slice(Math.ceil(st.history.length / 2));
    return st;
  }

  async function buildBody(slim) {
    const snap = provider();
    const body = {
      room: snap.room, session: sessionId, app: J.APP_VERSION,
      title: (snap.set && snap.set.title) || '', state: trimState(snap.state, !slim),
    };
    const setId = ls.get('jeopardy.activeSet');
    if (setId) body.setId = setId;
    let setSha = null;
    if (!slim && snap.set) {
      const json = JSON.stringify(snap.set);
      if (json.length <= SET_MAX) {
        setSha = await sha(json);
        if (setSha !== lastSetSha) body.set = snap.set; // nur mitsenden, wenn es sich geändert hat
      }
    }
    return { body, room: snap.room, setSha };
  }

  async function saveNow({ keepalive = false } = {}) {
    if (!provider || sync.readonly || (sync.status.kind !== 'ok' && sync.status.kind !== 'offline')) return;
    if (busy) { dirty = true; return; }
    busy = true;
    dirty = false;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    try {
      const { body, room, setSha } = await buildBody(keepalive); // keepalive: Limit 64 KB → schlank
      const res = await call('save', { body, keepalive });
      if (setSha) lastSetSha = setSha;
      rememberRev(room, res.rev);
      setStatus('ok', { savedAt: Date.now() });
    } catch (e) {
      if (e.status === 409 && e.message === 'superseded') {
        setStatus('readonly');
      } else if (e.status === 401) {
        ls.set(PW_KEY, null);
        setStatus('needpw', { wrong: true });
      } else {
        dirty = true;
        setStatus('offline');
        retryTimer = setTimeout(() => schedule(0), RETRY_MS);
      }
    } finally {
      busy = false;
      if (dirty && sync.status.kind === 'ok') schedule();
    }
  }

  function schedule(ms = DEBOUNCE_MS) {
    clearTimeout(timer);
    timer = setTimeout(() => saveNow(), ms);
  }

  /** Nach jedem commit() des Hosts aufrufen. */
  sync.touch = () => {
    if (!provider || sync.readonly) return;
    dirty = true;
    if (sync.status.kind === 'ok' || sync.status.kind === 'offline') schedule();
  };
  sync.attach = (fn) => { provider = fn; };
  // Tab geht in den Hintergrund/zu: ausstehende Änderung sofort (ohne History) abschicken
  const flush = () => { if (dirty && !busy) saveNow({ keepalive: true }); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);

  // ---------- Start / Fortsetzen / Übernehmen ----------
  /**
   * Beim Start des Hosts (vor dem Verbinden): Passwort prüfen und klären, wem das Spiel gehört.
   * → { conflict } wenn der Server einen neueren Stand von einem anderen Fenster hat; sonst {}
   * Übernimmt dieses Fenster ein Spiel, wird der Raum beim Relay mit Host-Passwort „erzwungen“.
   */
  async function init(room) {
    const kind = await connect();
    if (kind !== 'ok') return {};
    let mine = null;
    try { mine = await get(room); } catch (e) { if (e.status !== 404) setStatus('offline'); }
    if (mine && mine.session !== sessionId) {
      const known = readRev();
      if (known.room === room && mine.rev > known.rev) return { conflict: mine };
      await claimHere(room);
    }
    return {};
  }

  async function claimHere(room) {
    try {
      const res = await call('claim', { body: { room, session: sessionId } });
      rememberRev(room, res.rev);
      ss.set(TAKEOVER_KEY, '1');
    } catch (e) { /* kein Spiel auf dem Server oder offline: lokal weiterspielen */ }
  }

  /** Server-Stand laden, lokal ablegen und dieses Fenster zum Schreiber machen. Danach neu laden. */
  async function resume(room) {
    const g = await get(room, true);
    let set = g.set || null;
    if (!set && g.setId) {
      try {
        const res = await fetch(`${SETS_API}?op=get&id=${encodeURIComponent(g.setId)}`, {
          headers: { 'x-host-password': ls.get(PW_KEY) || '' }, cache: 'no-store', credentials: 'same-origin',
        });
        if (res.ok) set = (await res.json()).data;
      } catch (e) { /* ohne Set weiterspielen: das lokale bleibt */ }
    }
    J.saveState(J.normalizeState(g.state, { resume: true }));
    if (set) J.saveSet(J.normalizeSet(set));
    ls.set(J.ROOM_KEY, g.room);
    const res = await call('claim', { body: { room: g.room, session: sessionId } });
    rememberRev(g.room, res.rev);
    ss.set(TAKEOVER_KEY, '1');
    return g;
  }

  /** Eigenes Fenster als Schreiber behalten (lokalen Stand gegen den Server durchsetzen). */
  sync.keepLocal = async (room) => { await claimHere(room); };

  /** Vom Relay gemeldet: ein anderes Fenster hat den Raum übernommen. */
  sync.markReadonly = () => setStatus('readonly');
  /** Nächster Host-Start soll den Raum erzwingen (einmalig). */
  sync.takeover = () => { const t = ss.get(TAKEOVER_KEY) === '1'; return t; };
  sync.clearTakeover = () => ss.set(TAKEOVER_KEY, null);

  Object.assign(sync, { connect, init, list, get, remove, resume, PW_KEY });
  J.gameSync = sync;
})();
