// Gemeinsame Logik für Editor, Host und Spieleransicht.
(function () {
  const CATS = 6;
  const ROWS = 5;
  const ROUNDS = 2;
  const SET_KEY = 'jeopardy.set';
  // Bei jeder Änderung am Spiel-Code hochzählen: Handys mit anderem Stand laden sich dann neu,
  // statt z. B. neue Fragearten falsch anzuzeigen.
  const APP_VERSION = '2026-11-23.2';
  const STATE_KEY = 'jeopardy.state';
  const ROOM_KEY = 'jeopardy.room';
  const PEER_PREFIX = 'jeop-ghostly-';

  // Runde 1: 100–500, Runde 2: 200–1000
  function pointsFor(round, row) {
    return (row + 1) * 100 * (round + 1);
  }

  // Falsche Antwort kostet standardmäßig die Hälfte des Feldwerts; Option „penalty“: half | full | none
  function penaltyFor(round, row, mode) {
    const v = pointsFor(round, row);
    return mode === 'full' ? v : mode === 'none' ? 0 : v / 2;
  }

  // Geklaute Frage (nach einer falschen Antwort) bringt standardmäßig nur die Hälfte (Option „stealHalf“)
  function stealFor(round, row, half) {
    const v = pointsFor(round, row);
    return half === false ? v : v / 2;
  }

  // ---------- Spielregeln / Optionen ----------
  // EINE Liste für Editor (Voreinstellung im Set: set.options) und Host-Pult (Überschreibung pro Spiel:
  // state.options). Auflösung: Host > Set > default (opt()). Neue Optionen = nur ein Eintrag hier.
  // requires: wird nur wirksam, wenn die genannten Optionen den Wert haben (sonst gilt „aus“ bzw. default).
  const SHARE_CHOICES = [['100', '100 %'], ['75', '75 %'], ['50', '50 %'], ['25', '25 %'], ['0', '0 %']];
  const OPTION_DEFS = [
    { key: 'final', group: 'Finale & Daily Double', label: '⭐ Final Jeopardy', type: 'bool', default: true,
      hint: 'Aus: kein Final-Jeopardy-Knopf, kein Ablauf.' },
    { key: 'dd', group: 'Finale & Daily Double', label: '⭐ Daily Double', type: 'bool', default: true,
      hint: 'Aus: markierte Felder werden wie normale Felder gespielt.' },
    { key: 'ddRandom', group: 'Finale & Daily Double', label: '🎲 Daily Doubles zufällig', type: 'bool', default: false,
      requires: { dd: true }, requiresHint: 'Braucht „Daily Double“.',
      hint: '1 in Runde 1, 2 in Runde 2 (nie in der ersten Reihe) – statt der markierten Felder.' },
    { key: 'jokerDouble', group: 'Joker', label: '🎲 Joker „Doppelt oder nichts“', type: 'bool', default: true },
    { key: 'jokerHint', group: 'Joker', label: '💡 Joker „Tipp“', type: 'bool', default: true },
    { key: 'jokerPass', group: 'Joker', label: '👉 Joker „Weitergeben“', type: 'bool', default: true,
      requires: { turn: true }, requiresHint: 'Braucht „Am Zug“.' },
    { key: 'steal', group: 'Punkte & Klauen', label: '🔔 Klauen per Buzzer nach falscher Antwort', type: 'bool', default: true,
      hint: 'Aus: nach ✗ öffnet der Buzzer nicht automatisch, der Host kann ihn auch nicht mehr für Klau-Versuche öffnen.' },
    { key: 'stealHalf', group: 'Punkte & Klauen', label: '½ Halbe Punkte für geklaute Fragen', type: 'bool', default: true,
      requires: { steal: true }, requiresHint: 'Braucht „Klauen“.', hint: 'Aus: Geklaut zählt der volle Feldwert.',
      hideIf: { splitScoring: true } },
    // Punkteverteilung: Hauptschalter + Stellschrauben (nur sichtbar, wenn der Schalter an ist). Aus = wie bisher.
    // stealHalf ist bei eingeschalteter Punkteverteilung ausgeblendet; stealShare übernimmt (Standard aus stealHalf).
    { key: 'splitScoring', group: 'Punkte & Klauen', label: '⚖️ Punkteverteilung anpassen', type: 'bool', default: false,
      hint: 'Aus: alle Punkte wie bisher.' },
    { key: 'turnShare', group: 'Punkte & Klauen', label: '🎯 Punkte für den, der am Zug ist', type: 'choice', default: '100',
      choices: SHARE_CHOICES, showIf: { splitScoring: true }, requires: { splitScoring: true, turn: true }, requiresHint: 'Braucht „Am Zug“.',
      hint: 'Anteil des Feldwerts für richtige Antworten des Spielers/Teams, das am Zug ist.' },
    { key: 'otherShare', group: 'Punkte & Klauen', label: '👥 Punkte für alle anderen Richtigen', type: 'choice', default: '100',
      choices: SHARE_CHOICES, showIf: { splitScoring: true }, requires: { splitScoring: true },
      hint: 'Anteil des Feldwerts für richtige Antworten aller anderen (ohne „Am Zug“: für alle).' },
    { key: 'otherPenalty', group: 'Punkte & Klauen', label: '➖ Abzug für alle anderen bei falsch', type: 'choice', default: 'same',
      choices: [['same', 'Wie bei „Abzug bei falscher Antwort“'], ['half', 'Die Hälfte davon'], ['none', 'Kein Abzug']],
      showIf: { splitScoring: true }, requires: { splitScoring: true },
      hint: 'Wer am Zug ist, behält den normalen Abzug (auch bei „Keine Abgabe zählt wie falsch“).' },
    { key: 'estimateRunnerUp', group: 'Punkte & Klauen', label: '🔢 Schätzfrage: Zweitnächster bekommt', type: 'choice', default: '0',
      choices: [['0', 'Nichts'], ['25', '25 % des Feldwerts'], ['50', '50 % des Feldwerts']],
      showIf: { splitScoring: true }, requires: { splitScoring: true },
      hint: 'Nur wenn es genau einen Gewinner gibt; bei Gleichstand auf Platz 1 gibt es keinen Zweitnächsten.' },
    { key: 'stealShare', group: 'Punkte & Klauen', label: '🔔 Punkte für geklaute Fragen', type: 'choice', default: '100', derivedDefault: true,
      choices: [['100', '100 % (voller Feldwert)'], ['75', '75 %'], ['50', '50 % (halber Feldwert)'], ['25', '25 %']],
      showIf: { splitScoring: true }, requires: { splitScoring: true, steal: true }, requiresHint: 'Braucht „Klauen“.',
      hint: 'Ersetzt „Halbe Punkte für geklaute Fragen“; vorbelegt mit dessen Wert.' },
    { key: 'penalty', group: 'Punkte & Klauen', label: '➖ Abzug bei falscher Antwort', type: 'choice', default: 'half',
      choices: [['half', 'Halber Feldwert'], ['full', 'Voller Feldwert'], ['none', 'Kein Abzug']],
      hint: 'Gilt nicht für Daily Double, Final Jeopardy und den Joker „Doppelt oder nichts“ (dort steht der Einsatz auf dem Spiel).' },
    { key: 'abstainPenalty', group: 'Punkte & Klauen', label: '🅰️ Keine Abgabe zählt wie falsch (Multiple Choice / Reihenfolge)', type: 'bool', default: false,
      hint: 'An: wer bei Multiple Choice oder Reihenfolge nichts abgibt, verliert wie bei einer falschen Abgabe (Höhe nach „Abzug bei falscher Antwort“). Aus: keine Abgabe = 0. Schätzfragen bleiben ohne Abzug.' },
    { key: 'turn', group: 'Spielablauf', label: '🎯 „Am Zug“ / Reihenfolge', type: 'bool', default: true,
      hint: 'Aus: niemand ist am Zug, kein Banner. Joker „Weitergeben“ entfällt; „Doppelt oder nichts“ und „Tipp“ gehen dann nur noch für den Buzzer-Gewinner; beim Daily Double wählt der Host den Spieler.' },
    { key: 'pixelRace', group: 'Spielablauf', label: '🖼️ Buzzer-Rennen bei Verpixeln/Zoom', type: 'bool', default: true,
      hint: 'Aus: Bilder werden weiter per Host-Klick schärfer, aber der Buzzer öffnet nicht von allein für alle.' },
    { key: 'timer', group: 'Spielablauf', label: '⏱ Frage-Timer', type: 'bool', default: true,
      hint: 'Aus: keine Timer-Knöpfe, kein Timer-Sound. Der Final-Jeopardy-Timer (30 s) ist eine eigene feste Zeit und bleibt davon unberührt.' },
    { key: 'timerSec', group: 'Spielablauf', label: '⏱ Dauer des Frage-Timers', type: 'choice', default: '15',
      choices: [['10', '10 Sekunden'], ['15', '15 Sekunden'], ['20', '20 Sekunden'], ['30', '30 Sekunden']],
      requires: { timer: true }, requiresHint: 'Braucht „Frage-Timer“.' },
    { key: 'intro', group: 'Anzeige & Auswertung', label: '✨ Runden-Intro', type: 'bool', default: true,
      hint: 'Aus: kein automatisches Intro beim Rundenwechsel, kein Intro-Knopf.' },
    { key: 'reactions', group: 'Anzeige & Auswertung', label: '😂 Live-Reaktionen', type: 'bool', default: true,
      hint: 'Aus: keine Emoji-Leiste auf den Handys; der Host verwirft Reaktionen.' },
    { key: 'qrTv', group: 'Anzeige & Auswertung', label: '📺 QR-Code auf dem TV', type: 'bool', default: true,
      hint: 'Aus: der TV zeigt keinen Beitritts-QR. Der QR im Host-Pult bleibt.' },
    { key: 'media', group: 'Anzeige & Auswertung', label: '🎵 Audio-/Video-Clips', type: 'bool', default: true,
      hint: 'Aus: Clips werden nicht geladen oder abgespielt, Handys bekommen keinen Hinweis; im Editor ausgeblendet (Clips bleiben im Set gespeichert).' },
    { key: 'stats', group: 'Anzeige & Auswertung', label: '📊 Statistik am Spielende', type: 'bool', default: true,
      hint: 'Aus: keine Statistik-Ansicht und keine CSV/JSON-Exporte (Erfassung läuft im Hintergrund weiter).' },
    { key: 'awards', group: 'Anzeige & Auswertung', label: '🏅 Auszeichnungen bei der Siegerehrung', type: 'bool', default: true,
      hint: 'Aus: Treppchen ohne Buzzer-König, Meisterdieb & Co.' },
    { key: 'soundDefault', group: 'Anzeige & Auswertung', label: '🔊 Sounds bei Spielern standardmäßig an', type: 'bool', default: true,
      hint: 'Gilt nur für Geräte, die noch nie umgeschaltet wurden; der Ton-Schalter am Gerät funktioniert weiter.' },
    { key: 'backup', group: 'Sicherung', label: '💾 Spielstand auf dem Server sichern', type: 'bool', default: true,
      hint: 'Nur mit Relay und Host-Passwort wirksam. Aus: nichts wird auf den Server geschrieben; Datei-Export bleibt.' },
  ];
  const OPTION_BY_KEY = Object.fromEntries(OPTION_DEFS.map((d) => [d.key, d]));

  function validOptionValue(def, v) {
    if (!def) return false;
    if (def.type === 'bool') return typeof v === 'boolean';
    return def.choices.some((c) => c[0] === v);
  }

  // Beliebiges Objekt → nur bekannte Schlüssel mit gültigem Wert
  function cleanOptions(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const d of OPTION_DEFS) if (validOptionValue(d, raw[d.key])) out[d.key] = raw[d.key];
    return out;
  }

  // Wirksamer Wert: Host-Überschreibung (state.options) > Set-Voreinstellung (set.options) > Standard.
  // Eine nicht erfüllte Abhängigkeit (requires) macht die Option wirkungslos (bool → false).
  function opt(set, state, key) {
    const def = OPTION_BY_KEY[key];
    if (!def) return undefined;
    for (const [k, v] of Object.entries(def.requires || {})) {
      if (opt(set, state, k) !== v) return def.type === 'bool' ? false : optDefault(set, state, def);
    }
    const so = state && state.options;
    if (so && validOptionValue(def, so[key])) return so[key];
    const se = set && set.options;
    if (se && validOptionValue(def, se[key])) return se[key];
    return optDefault(set, state, def);
  }
  // Standard einer Option; stealShare folgt dem (ggf. überschriebenen) stealHalf
  function optDefault(set, state, def) {
    if (def.key === 'stealShare') return rawBool(set, state, 'stealHalf') === false ? '100' : '50';
    return def.default;
  }
  function rawBool(set, state, key) {
    const so = state && state.options;
    if (so && typeof so[key] === 'boolean') return so[key];
    const se = set && set.options;
    if (se && typeof se[key] === 'boolean') return se[key];
    return OPTION_BY_KEY[key].default;
  }
  const effectiveOptions = (set, state) => Object.fromEntries(OPTION_DEFS.map((d) => [d.key, opt(set, state, d.key)]));

  // Nach dem ersten gespielten Feld (oder bei laufender Frage / Final / Ende) sind Regeln gesperrt
  function optionsLocked(state) {
    if (!state) return false;
    return !!(state.current || state.fj || state.finished ||
      (state.used || []).some((r) => r.some((c) => c.some(Boolean))));
  }

  function defaultSet() {
    return {
      title: 'Jeopardy',
      rounds: Array.from({ length: ROUNDS }, (_, r) => ({
        categories: Array.from({ length: CATS }, (_, c) => ({
          name: `Kategorie ${r * CATS + c + 1}`,
          clues: Array.from({ length: ROWS }, (_, row) => ({
            q: `Frage für ${pointsFor(r, row)}`,
            a: 'Antwort',
            img: '',
            note: '',
          })),
        })),
      })),
      // Final Jeopardy (optional): erst mit Frage und Antwort spielbar
      final: { category: '', q: '', a: '', note: '' },
    };
  }

  // Bringt beliebiges (z. B. importiertes) JSON in die erwartete Form.
  function normalizeSet(raw) {
    const base = defaultSet();
    if (!raw || typeof raw !== 'object') return base;
    base.title = typeof raw.title === 'string' ? raw.title : base.title;
    for (let r = 0; r < ROUNDS; r++) {
      const rr = raw.rounds && raw.rounds[r];
      for (let c = 0; c < CATS; c++) {
        const cc = rr && rr.categories && rr.categories[c];
        if (!cc) continue;
        const cat = base.rounds[r].categories[c];
        if (typeof cc.name === 'string') cat.name = cc.name;
        for (let row = 0; row < ROWS; row++) {
          const cl = cc.clues && cc.clues[row];
          if (!cl) continue;
          if (typeof cl.q === 'string') cat.clues[row].q = cl.q;
          if (typeof cl.a === 'string') cat.clues[row].a = cl.a;
          const img = safeImg(cl.img);
          if (img) cat.clues[row].img = img;
          if (typeof cl.note === 'string') cat.clues[row].note = cl.note;
          const media = safeMedia(cl.media);
          if (media) {
            cat.clues[row].media = media;
            cat.clues[row].mediaType = mediaTypeOf({ media, mediaType: cl.mediaType });
          }
          if (cl.pixel === true && img) cat.clues[row].pixel = true;
          else if (cl.zoom === true && img) {
            cat.clues[row].zoom = true;
            const at = cl.zoomAt;
            if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
              cat.clues[row].zoomAt = { x: Math.min(1, Math.max(0, at.x)), y: Math.min(1, Math.max(0, at.y)) };
            }
          }
          if (CLUE_KINDS.includes(cl.kind)) cat.clues[row].kind = cl.kind;
          if (cl.dd === true) cat.clues[row].dd = true;
        }
      }
    }
    // Optionen (Voreinstellung); altes set.ddRandom wandert in set.options.ddRandom
    const setOpts = cleanOptions(raw.options);
    if (raw.ddRandom === true && setOpts.ddRandom === undefined) setOpts.ddRandom = true;
    if (Object.keys(setOpts).length) base.options = setOpts;
    if (raw.final && typeof raw.final === 'object') {
      for (const k of Object.keys(base.final)) if (typeof raw.final[k] === 'string') base.final[k] = raw.final[k];
    }
    return base;
  }

  // Nur Web-Adressen oder hochgeladene Bilder zulassen (kein javascript: o. ä.)
  function safeImg(v) {
    if (typeof v !== 'string') return '';
    v = v.trim();
    return /^https?:\/\//i.test(v) || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v) ? v : '';
  }

  // ---------- Audio-/Video-Clips ----------
  // Upload-Grenzen (Datei in Bytes): als Base64 ~4/3 so groß; Set-Speicher (4 MB Body) und
  // Relay (3 MB pro Nachricht) müssen den Clip noch tragen.
  const MEDIA_LIMITS = { audio: 1_500_000, video: 2_000_000 };
  const MEDIA_DATA_RE = /^data:(audio|video)\/[a-z0-9.+-]+(;codecs=[^;,]+)?;base64,/i;
  const MEDIA_VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;

  // Nur Web-Adressen (http/https mit Host) oder hochgeladene Clips zulassen
  function safeMedia(v) {
    if (typeof v !== 'string') return '';
    v = v.trim();
    if (MEDIA_DATA_RE.test(v)) return v;
    if (!/^https?:\/\//i.test(v)) return '';
    try { return new URL(v).hostname ? v : ''; } catch (e) { return ''; }
  }

  // 'audio' oder 'video': aus der Frage, sonst aus data:-Typ bzw. Dateiendung, sonst Audio
  function mediaTypeOf(clue) {
    if (!clue || !safeMedia(clue.media)) return null;
    if (clue.mediaType === 'audio' || clue.mediaType === 'video') return clue.mediaType;
    const m = /^data:(audio|video)\//i.exec(clue.media.trim());
    if (m) return m[1].toLowerCase();
    try { return MEDIA_VIDEO_EXT.test(new URL(clue.media.trim()).pathname) ? 'video' : 'audio'; } catch (e) { return 'audio'; }
  }

  // Upload prüfen → Fehlertext (Deutsch) oder null
  function mediaFileError(file) {
    if (!file) return 'Keine Datei gewählt.';
    const type = file.type && file.type.split('/')[0];
    if (type !== 'audio' && type !== 'video') return 'Das ist keine Audio- oder Videodatei.';
    const max = MEDIA_LIMITS[type];
    if (file.size > max) {
      return `Die ${type === 'audio' ? 'Audiodatei' : 'Videodatei'} ist zu groß (${(file.size / 1e6).toFixed(1)} MB). ` +
        `Erlaubt sind höchstens ${(max / 1e6).toFixed(1).replace('.0', '')} MB – kürze den Clip oder nutze einen Link.`;
    }
    return null;
  }

  // Hochgeladenes Bild verkleinern (max. 1000 px, JPEG), damit es in den Browserspeicher
  // passt und schnell an die Spieler übertragen wird.
  function compressImage(file, max = 1000, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // transparente PNGs nicht schwarz werden lassen
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
      img.src = url;
    });
  }

  // ---------- Joker ----------
  // Jeder Spieler bzw. jedes Team hat jeden Joker einmal pro Spiel (über beide Runden). Einsetzen
  // darf nur, wer gerade dran ist, und pro Frage höchstens einen Joker.
  const JOKERS = [
    { id: 'double', icon: '🎲', name: 'Doppelt oder nichts', desc: 'Richtig: doppelte Punkte · Falsch: voller Abzug' },
    { id: 'hint', icon: '💡', name: 'Tipp', desc: 'Anfangsbuchstaben und Länge der Antwort – nur für dich' },
    { id: 'pass', icon: '👉', name: 'Weitergeben', desc: 'Wer am Zug ist, gibt die Frage an jemand anderen weiter' },
  ];
  const jokerInfo = (id) => JOKERS.find((j) => j.id === id) || null;
  const JOKER_OPTION = { double: 'jokerDouble', hint: 'jokerHint', pass: 'jokerPass' };
  // opts = wirksame Optionen (effectiveOptions / publicState.opts); ohne opts sind alle Joker an
  const jokerEnabled = (id, opts) => !opts || opts[JOKER_OPTION[id]] !== false;
  const activeJokers = (opts) => JOKERS.filter((j) => jokerEnabled(j.id, opts));

  // Darf pid den Joker jetzt einsetzen? → null wenn ja, sonst ein kurzer Grund.
  // cur: aktuelle Frage (Host-Zustand oder öffentlicher Zustand), players: [{id, usedJokers}]
  function jokerBlock(kind, { cur, players, turn, pid, target, opts }) {
    if (!jokerInfo(kind)) return 'Unbekannter Joker';
    if (!jokerEnabled(kind, opts)) return 'Joker ist in diesem Spiel ausgeschaltet';
    const p = players.find((x) => x.id === pid);
    if (!p) return 'Nur für Spieler';
    if ((p.usedJokers || []).includes(kind)) return 'Schon benutzt';
    if (!cur) return 'Erst wenn eine Frage offen ist';
    // Daily Double: der Einsatz steht schon (kein Doppelt oder nichts), Weitergeben gibt es nicht
    if (cur.dd) {
      if (kind === 'double') return 'Nicht beim Daily Double – du hast schon einen Einsatz';
      if (kind === 'pass') return 'Nicht beim Daily Double – nur du antwortest';
      if (cur.dd.phase !== 'play') return 'Erst nach dem Einsatz';
    }
    if (cur.kind && cur.kind !== 'normal') return 'Nicht bei dieser Frageart';
    const judged = cur.judged || {};
    const buzz = cur.buzz || {};
    const jk = cur.jokers || {};
    if (cur.revealed || Object.values(judged).includes('right')) return 'Frage ist schon gelöst';
    if (judged[pid]) return 'Du hast schon geantwortet';
    // Höchstens ein Joker pro Person/Team und Frage
    if ((jk.double || []).includes(pid) || (jk.hint || []).includes(pid) || (jk.pass && jk.pass.from === pid)) {
      return 'Nur ein Joker pro Frage';
    }
    if (whoIsUp(cur, turn) !== pid) return 'Nur wenn du dran bist';
    if (kind === 'pass') {
      if (pid !== turn || jk.pass || buzz.winner) return 'Nur wer am Zug ist, vor der ersten Antwort';
      if (target === undefined) return null; // Ziel wird gleich gewählt
      if (target === pid || !players.some((x) => x.id === target)) return 'Ungültiges Ziel';
      return null;
    }
    return null;
  }

  // Wer muss gerade antworten? Gebuzzert → der Buzzer-Gewinner; weitergegeben → das Ziel;
  // sonst vor der ersten Antwort, wer am Zug ist. Bei offenem Buzzer ist niemand dran.
  function whoIsUp(cur, turn) {
    if (!cur || cur.revealed) return null;
    const judged = cur.judged || {};
    const buzz = cur.buzz || {};
    const jk = cur.jokers || {};
    if (cur.dd) return cur.dd.phase === 'play' && cur.dd.pid && !judged[cur.dd.pid] ? cur.dd.pid : null;
    if (Object.values(judged).includes('right')) return null;
    if (buzz.winner && !judged[buzz.winner]) return buzz.winner;
    if (buzz.open || buzz.arming) return null;
    if (jk.pass && !judged[jk.pass.to]) return jk.pass.to;
    if (!Object.keys(judged).length) return turn || null;
    return null;
  }

  // Tipp: „Mona Lisa“ → „M _ _ _   L _ _ _“. Ziffern werden nie verraten (sonst wäre „6“ die Antwort).
  function hintPattern(answer) {
    return String(answer || '').trim().split(/\s+/).filter(Boolean).map((word) => [...word].map((ch, i) => {
      if (/\p{L}/u.test(ch)) return i === 0 ? ch.toUpperCase() : '_';
      if (/\p{N}/u.test(ch)) return '_';
      return ch;
    }).join(' ')).join('   ');
  }

  // Punkteverteilung: die EINE Stelle, an der Gewinn/Abzug eines Spielers/Teams berechnet wird.
  // o: { opts (wirksame Optionen), active (ist am Zug), stolen, double }
  // → { gain (richtig), penalty (falsch/keine Abgabe), runnerUp (Zweitnächster bei Schätzfragen) }
  // Ohne Hauptschalter splitScoring gilt exakt die alte Formel (stealHalf, penalty).
  // Doppelt oder nichts bleibt unberührt: Gewinn doppelt (bei Klauen mit dem Klau-Anteil), Verlust = Feldwert.
  const pct = (value, p) => Math.round((value * p) / 100);
  function splitPoints(round, row, o) {
    const opts = o.opts || {};
    const value = pointsFor(round, row);
    const split = opts.splitScoring === true;
    const stealPct = split ? Number(opts.stealShare) : opts.stealHalf === false ? 100 : 50;
    let gain = o.stolen ? pct(value, stealPct) : value;
    let penalty = penaltyFor(round, row, opts.penalty);
    let runnerUp = 0;
    if (split) {
      const turnOn = opts.turn !== false;
      const active = !!o.active && turnOn;
      if (!o.stolen) gain = pct(value, Number(active ? opts.turnShare : opts.otherShare));
      if (!active) penalty = opts.otherPenalty === 'none' ? 0 : opts.otherPenalty === 'half' ? pct(penalty, 50) : penalty;
      runnerUp = pct(value, Number(opts.estimateRunnerUp) || 0);
    }
    if (o.double) return { gain: (o.stolen ? pct(value, stealPct) : value) * 2, penalty: value, runnerUp };
    return { gain, penalty, runnerUp };
  }

  // Punkte unter Berücksichtigung von „Doppelt oder nichts“ (Kurzform von splitPoints)
  // rules: { stolen, double, penalty: half|full|none, stealHalf: bool } – oder { opts, active } für die Punkteverteilung
  function judgePoints(round, row, rules) {
    const { stolen, double, penalty, stealHalf, active } = rules;
    const { gain, penalty: pen } = splitPoints(round, row, { opts: rules.opts || { penalty, stealHalf }, active, stolen, double });
    return { gain, penalty: pen };
  }

  // Eine Zeile für Handy/TV, wenn die Punkteverteilung vom Standard abweicht (sonst ''); kind = Fragenart
  function splitLine(opts, round, row, kind) {
    if (!opts || opts.splitScoring !== true) return '';
    const share = (v) => (Number(v) === 100 ? 'volle Punkte' : `${Number(v)} %`);
    const turnOn = opts.turn !== false;
    const parts = [];
    if (turnOn && (Number(opts.turnShare) !== 100 || Number(opts.otherShare) !== 100)) {
      parts.push(`Am Zug: ${share(opts.turnShare)}`, `alle anderen: ${share(opts.otherShare)}`);
    } else if (!turnOn && Number(opts.otherShare) !== 100) {
      parts.push(`Richtige: ${share(opts.otherShare)}`);
    }
    if (opts.otherPenalty && opts.otherPenalty !== 'same') {
      const act = splitPoints(round, row, { opts, active: true }).penalty;
      const oth = splitPoints(round, row, { opts, active: false }).penalty;
      const fmt = (n) => (n ? `−${n}` : 'nichts');
      parts.push(turnOn && act !== oth ? `Falsch: am Zug ${fmt(act)}, andere ${fmt(oth)}` : `Falsch kostet ${fmt(oth)}`);
    }
    if (kind === 'estimate' && Number(opts.estimateRunnerUp) > 0) parts.push(`Zweitnächster: ${Number(opts.estimateRunnerUp)} %`);
    return parts.join(' · ');
  }

  // ---------- Verpixelte Bilder ----------
  // Bild startet grob verpixelt und wird per Knopf schärfer. Werte = Pixel an der längeren Seite;
  // nach der letzten Stufe (oder beim Aufdecken) sieht man das echte Bild.
  const PIXEL_STEPS = [6, 10, 16, 28];

  // Aktuelle Pixelstufe oder null, wenn das echte Bild gezeigt werden darf
  // Zoom-Bild: Vergrößerungsfaktor je Stufe (12 = nur ein Zwölftel der Breite sichtbar)
  const ZOOM_STEPS = [12, 6, 3, 1.6];
  const imgSteps = (clue) => (clue && clue.pixel ? PIXEL_STEPS : clue && clue.zoom ? ZOOM_STEPS : null);
  const imgMode = (clue) => (clue && clue.pixel ? 'pixel' : clue && clue.zoom ? 'zoom' : null);

  // Aktuelle Stufe (verpixelt oder gezoomt) oder null, wenn das echte Bild gezeigt werden darf
  function pixelLevel(clue, cur) {
    const steps = imgSteps(clue);
    if (!steps || !safeImg(clue.img) || !cur || cur.revealed) return null;
    const lvl = Math.max(0, Math.floor(cur.pixel || 0));
    return lvl < steps.length ? lvl : null;
  }

  // Zoom: Ausschnitt um den Fokuspunkt (0–1, Standard Bildmitte), auf 480 px Breite gebracht.
  // Wie beim Verpixeln bekommen die Spieler nur diesen Ausschnitt, nie das ganze Bild.
  function zoomCrop(src, factor, at) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (!/^data:/i.test(src)) img.crossOrigin = 'anonymous';
      img.onload = () => {
        const W = img.naturalWidth, H = img.naturalHeight;
        const w = W / factor, h = H / factor;
        const cx = (at && at.x != null ? at.x : 0.5) * W, cy = (at && at.y != null ? at.y : 0.5) * H;
        const x = Math.min(W - w, Math.max(0, cx - w / 2)), y = Math.min(H - h, Math.max(0, cy - h / 2));
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = Math.max(1, Math.round(480 * h / w));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch (e) {
          reject(new Error('Bild lässt sich nicht zoomen – bitte hochladen statt verlinken'));
        }
      };
      img.onerror = () => reject(new Error('Bild lässt sich nicht zoomen – bitte hochladen statt verlinken'));
      img.src = src;
    });
  }

  // ---------- Schätzfrage und Reihenfolge ----------
  const CLUE_KINDS = ['estimate', 'order', 'choice'];
  const isSpecialKind = (k) => CLUE_KINDS.includes(k);

  // „330 m“, „1.234,5“, „384 400 km“, „-12“ → Zahl (deutsches und englisches Format)
  function parseNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v || '').replace(/[\s\u00a0']/g, '');
    const m = s.match(/-?[\d.,]+/);
    if (!m) return null;
    s = m[0];
    if (s.includes(',') && s.includes('.')) {
      s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (s.includes(',')) {
      s = s.replace(',', '.'); // nur Komma: Dezimalkomma (deutsch)
    } else if (/^-?[1-9]\d{0,2}(\.\d{3})+$/.test(s)) { // 1.234 / 384.400: Tausenderpunkte
      s = s.replace(/\./g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // Wer liegt am nächsten? (Gleichstand: alle) → ids
  function estimateWinners(guesses, answer) {
    const ids = Object.keys(guesses).filter((id) => Number.isFinite(guesses[id]));
    if (!ids.length || !Number.isFinite(answer)) return [];
    const best = Math.min(...ids.map((id) => Math.abs(guesses[id] - answer)));
    return ids.filter((id) => Math.abs(guesses[id] - answer) === best);
  }

  // Zweitnächster Tipp: nur bei genau einem Gewinner; bei Gleichstand auf Platz 2 alle Gleichplatzierten
  function estimateRunnerUps(guesses, answer) {
    const ids = Object.keys(guesses).filter((id) => Number.isFinite(guesses[id]));
    if (!Number.isFinite(answer) || estimateWinners(guesses, answer).length !== 1) return [];
    const d = (id) => Math.abs(guesses[id] - answer);
    const rest = ids.filter((id) => d(id) > Math.min(...ids.map(d)));
    if (!rest.length) return [];
    const second = Math.min(...rest.map(d));
    return rest.filter((id) => d(id) === second);
  }

  // Reihenfolge: Antwort „A | B | C | D“ in richtiger Reihenfolge
  const orderItems = (answer) => String(answer || '').split('|').map((x) => x.trim()).filter(Boolean);
  // Gemischte Reihenfolge, die nie zufällig schon stimmt
  function shufflePerm(n, rnd = Math.random) {
    const p = [...Array(n).keys()];
    if (n < 2) return p;
    do {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
      }
    } while (p.every((v, i) => v === i));
    return p;
  }
  // Echte Zufallsmischung (darf auch unverändert bleiben) – für Multiple Choice. shufflePerm passt nicht:
  // Bei zwei Optionen (Fakt/Fake) bliebe nur das Vertauschen, die Lösung stünde immer an Position B.
  function randomPerm(n, rnd = Math.random) {
    const p = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    return p;
  }
  // Gültige Abgabe: eine Permutation von 0..n-1 (Indizes der Original-Reihenfolge)
  const isPerm = (a, n) => Array.isArray(a) && a.length === n && [...a].sort((x, y) => x - y).every((v, i) => v === i);
  const orderCorrect = (a) => Array.isArray(a) && a.every((v, i) => v === i);

  // Bild auf wenige Pixel verkleinern (nur im Browser des Hosts). Die Spieler bekommen nur
  // dieses Mini-Bild und vergrößern es per CSS – das echte Bild erreicht sie erst beim Aufdecken.
  function pixelate(src, blocks) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (!/^data:/i.test(src)) img.crossOrigin = 'anonymous';
      img.onload = () => {
        const scale = blocks / Math.max(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch (e) {
          reject(new Error('Bild lässt sich nicht verpixeln – bitte hochladen statt verlinken'));
        }
      };
      img.onerror = () => reject(new Error('Bild lässt sich nicht verpixeln – bitte hochladen statt verlinken'));
      img.src = src;
    });
  }

  // ---------- Verbindungshilfe (TURN) ----------
  // Standard-Server von PeerJS. Ihr TURN-Server läuft auf Port 3478, den Uni-/Firmennetze oft
  // sperren. Ein eigener TURN-Zugang über Port 443 kommt durch fast jede Firewall.
  const DEFAULT_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  ];
  const TURN_KEY = 'jeopardy.turn';

  // Prüft und vereinheitlicht einen TURN-Zugang { urls: [...], username, credential }
  function parseTurn(t) {
    if (!t || typeof t !== 'object') return null;
    const list = (Array.isArray(t.urls) ? t.urls : String(t.urls || '').split(/[\s,]+/))
      .map((u) => String(u).trim())
      .filter((u) => /^turns?:[^\s]+$/i.test(u));
    if (!list.length) return null;
    return { urls: list, username: String(t.username || ''), credential: String(t.credential || '') };
  }
  function iceConfig(turn, forceRelay) {
    const servers = DEFAULT_ICE.slice();
    const t = parseTurn(turn);
    if (t) servers.unshift(t); // eigener Server zuerst
    const config = { iceServers: servers };
    if (forceRelay) config.iceTransportPolicy = 'relay';
    return config;
  }
  // Beitrittslink (Link, QR-Code): immer nur Raumcode (+ TURN-Zugang im #-Teil). Nie ein Passwort –
  // Host- und Seitenpasswort bleiben beim Host bzw. in Cookie/Header.
  function joinUrl(base, room, turn) {
    return new URL('player.html?room=' + encodeURIComponent(room), base).href + (turn ? '#t=' + encodeTurn(turn) : '');
  }
  // Für den Beitrittslink: kompakt, URL-sicher, Unicode-fest
  function encodeTurn(t) {
    t = parseTurn(t);
    if (!t) return '';
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify([t.urls, t.username, t.credential]))));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeTurn(s) {
    try {
      const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
      const [urls, username, credential] = JSON.parse(decodeURIComponent(escape(atob(b64))));
      return parseTurn({ urls, username, credential });
    } catch (e) {
      return null;
    }
  }
  function loadTurn(key = TURN_KEY) {
    try { return parseTurn(JSON.parse(localStorage.getItem(key))); } catch (e) { return null; }
  }
  function saveTurn(t, key = TURN_KEY) {
    try {
      const p = parseTurn(t);
      if (p) localStorage.setItem(key, JSON.stringify(p)); else localStorage.removeItem(key);
      return p;
    } catch (e) { return null; }
  }

  // ---------- Spielregeln (reine Funktionen, unit-getestet) ----------
  // „Am Zug“ geht reihum in Listenreihenfolge.
  function nextTurn(ids, current) {
    if (!ids.length) return null;
    const i = ids.indexOf(current);
    return ids[(i + 1) % ids.length]; // unbekannt/null → erster (i = -1)
  }
  // Wer bekommt den Zug, wenn ein Spieler entfernt wird?
  function turnAfterRemoval(ids, current, removedId) {
    if (current !== removedId) return current;
    const rest = ids.filter((id) => id !== removedId);
    if (!rest.length) return null;
    const i = ids.indexOf(removedId);
    return ids.slice(i + 1).find((id) => id !== removedId) || rest[0];
  }

  // Anti-Spam: Wer zu früh drückt, wird gesperrt; Reaktionen unter MIN_REACTION_MS gelten als Frühstart.
  const LOCK_MS = 1000;
  const MIN_REACTION_MS = 100;
  const isEarly = (reactionMs) => !(reactionMs >= MIN_REACTION_MS);

  // Schnellste gültige Reaktion gewinnt. entries: [[id, ms, name?], ...]
  function pickBuzzWinner(entries) {
    let best = null;
    for (const [id, ms, name] of entries) {
      if (!Number.isFinite(ms) || isEarly(ms)) continue;
      if (!best || ms < best.ms) best = { id, ms, name: name || null };
    }
    return best;
  }

  // Team-Modus
  function clampTeamSize(n) {
    n = parseInt(n, 10);
    return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 3;
  }
  const teamIsFull = (members, teamSize) => members >= clampTeamSize(teamSize);
  const TEAM_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#14b8a6', '#ec4899'];
  const teamColor = (index) => TEAM_COLORS[index % TEAM_COLORS.length];
  function cleanName(n) {
    return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  }

  function emptyUsed() {
    return Array.from({ length: ROUNDS }, () =>
      Array.from({ length: CATS }, () => Array(ROWS).fill(false))
    );
  }

  function defaultState() {
    return {
      round: 0, used: emptyUsed(), players: [], current: null, turn: null, finished: false,
      stats: {}, personStats: {}, statsShown: false, mode: 'single', teamSize: 3, history: [],
      fj: null, ddAuto: [], options: {},
    };
  }

  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback();
    } catch (e) {
      return fallback();
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('Speichern fehlgeschlagen', e);
      return false;
    }
  }

  const loadSet = () => normalizeSet(load(SET_KEY, defaultSet));
  const saveSet = (s) => save(SET_KEY, s);

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  // Rohdaten (localStorage, Server-Spielstand) → gültiger State. Rein, ohne Seiteneffekte.
  // `resume`: nicht wiederbelebbare Laufzeit-Dinge verwerfen (Timer, offenes Buzzer-Fenster, Intro).
  function normalizeState(raw, { resume = false } = {}) {
    const s = isObj(raw) ? raw : {};
    const players = (Array.isArray(s.players) ? s.players : [])
      .filter((p) => isObj(p) && (typeof p.id === 'string' || typeof p.id === 'number') && p.id !== '')
      .map((p) => ({ ...p, id: String(p.id), name: String(p.name ?? ''), score: Number.isFinite(Number(p.score)) ? Number(p.score) : 0 }));
    const used = Array.isArray(s.used) && s.used.length === ROUNDS
      ? Array.from({ length: ROUNDS }, (_, r) => Array.from({ length: CATS }, (_, c) =>
        Array.from({ length: ROWS }, (_, w) => !!(s.used[r] && s.used[r][c] && s.used[r][c][w]))))
      : emptyUsed();
    const history = (Array.isArray(s.history) ? s.history : []).filter(isObj);
    const out = {
      round: s.round === 1 ? 1 : 0,
      used,
      players,
      current: isObj(s.current) ? s.current : null,
      turn: typeof s.turn === 'string' ? s.turn : null,
      stats: isObj(s.stats) ? s.stats : {},
      personStats: isObj(s.personStats) ? s.personStats : {},
      statsShown: !!s.statsShown,
      mode: s.mode === 'team' ? 'team' : 'single',
      teamSize: clampTeamSize(s.teamSize),
      finished: !!s.finished,
      history,
      fj: s.fj && typeof s.fj === 'object' ? s.fj : null,
      ddAuto: Array.isArray(s.ddAuto) ? s.ddAuto : [],
      // Host-Überschreibungen der Spielregeln; altes state.ddRandom wandert hierher
      options: cleanOptions({ ...(typeof s.ddRandom === 'boolean' ? { ddRandom: s.ddRandom } : {}), ...(isObj(s.options) ? s.options : {}) }),
    };
    if (resume) {
      out.history = history.map((h) => (isObj(h.current) ? { ...h, current: stripLive(h.current) } : h));
      if (out.current) out.current = stripLive(out.current);
    }
    return out;
  }
  // Timer und Buzzer-Fenster überleben keinen Neustart: Gewinner bleibt, offen/„scharf“ wird geschlossen
  function stripLive(cur) {
    const c = { ...cur, timer: null };
    if (isObj(c.buzz)) c.buzz = { open: false, winner: c.buzz.winner || null };
    return c;
  }
  const loadState = () => normalizeState(load(STATE_KEY, defaultState));
  const saveState = (s) => save(STATE_KEY, s);

  function roomCode() {
    let code = localStorage.getItem(ROOM_KEY);
    if (!code) {
      code = newRoomCode();
    }
    return code;
  }
  function newRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    try { localStorage.setItem(ROOM_KEY, code); } catch (e) {}
    return code;
  }
  const peerId = (code) => PEER_PREFIX + code.toUpperCase();

  // Schätzfrage: vor dem Auflösen nur, WER getippt hat – nicht was
  function publicEstimate(cur) {
    const e = cur.est || {};
    const guesses = e.guesses || {};
    return {
      submitted: Object.keys(guesses),
      revealed: !!cur.revealed,
      guesses: cur.revealed ? guesses : null,
      answer: cur.revealed ? (e.answer != null ? e.answer : null) : null,
      winners: cur.revealed ? e.winners || [] : [],
      runnerUps: cur.revealed ? e.runnerUps || [] : [],
    };
  }
  // Reihenfolge: gemischte Begriffe; Lösung und Abgaben erst nach dem Auflösen
  function publicOrder(clue, cur) {
    const o = cur.ord || {};
    const items = orderItems(clue.a);
    const perm = isPerm(o.perm, items.length) ? o.perm : items.map((_, i) => i);
    return {
      items: perm.map((i) => items[i]),
      perm: null, // bleibt geheim, sonst wäre die Lösung ablesbar
      submitted: Object.keys(o.answers || {}),
      revealed: !!cur.revealed,
      correct: cur.revealed ? items : null,
      results: cur.revealed ? Object.fromEntries(Object.entries(o.answers || {}).map(([id, a]) => [id, orderCorrect(a)])) : null,
    };
  }

  // Multiple Choice: Antwort „Richtig | Falsch | Falsch | Falsch“ (richtige zuerst), gemischt angezeigt
  function publicChoice(clue, cur) {
    const m = cur.mc || {};
    const items = orderItems(clue.a);
    const perm = isPerm(m.perm, items.length) ? m.perm : items.map((_, i) => i);
    const answers = m.answers || {};
    return {
      options: perm.map((i) => items[i]),
      submitted: Object.keys(answers),
      revealed: !!cur.revealed,
      // erst nach dem Auflösen: welche angezeigte Option richtig war, wer was gewählt hat
      correct: cur.revealed ? perm.indexOf(0) : null,
      picks: cur.revealed ? Object.fromEntries(Object.entries(answers).map(([id, orig]) => [id, perm.indexOf(orig)])) : null,
    };
  }

  // Was die Spieler sehen dürfen: keine Antworten, außer der aktuellen nach dem Aufdecken.
  function publicState(set, state) {
    const r = state.round;
    const cur = state.current;
    let current = null;
    if (cur) {
      const clue = set.rounds[cur.round].categories[cur.cat].clues[cur.row];
      // Daily Double: bis der Einsatz steht, bekommen die Spieler weder Frage noch Bild noch Antworten
      const ddHide = !!cur.dd && cur.dd.phase !== 'play';
      current = {
        cat: cur.cat,
        row: cur.row,
        category: set.rounds[cur.round].categories[cur.cat].name,
        value: cur.dd && cur.dd.wager != null ? cur.dd.wager : pointsFor(cur.round, cur.row),
        dd: cur.dd ? window.J.dd.publicDd(cur, state) : null,
        q: ddHide ? '' : clue.q,
        // Clip nur als Hinweis: abgespielt wird er auf Host und TV, die Daten gehen nie an Handys
        media: !ddHide && opt(set, state, 'media') && safeMedia(clue.media) ? { kind: mediaTypeOf(clue) } : null,
        // Verpixelte Bilder: echtes Bild erst nach der letzten Stufe; das Mini-Bild setzt der Host ein
        img: ddHide || pixelLevel(clue, cur) != null ? null : safeImg(clue.img) || null,
        pixel: ddHide || pixelLevel(clue, cur) == null ? null : { step: pixelLevel(clue, cur), steps: imgSteps(clue).length, mode: imgMode(clue) },
        kind: !ddHide && CLUE_KINDS.includes(clue.kind) ? clue.kind : 'normal',
        est: !ddHide && clue.kind === 'estimate' ? publicEstimate(cur) : null,
        ord: !ddHide && clue.kind === 'order' ? publicOrder(clue, cur) : null,
        mc: !ddHide && clue.kind === 'choice' ? publicChoice(clue, cur) : null,
        a: cur.revealed ? clue.a : null,
        revealed: !!cur.revealed,
        // Joker: wer was gesetzt hat (der Tipp-Inhalt geht nur privat an den Spieler)
        jokers: {
          double: (cur.jokers && cur.jokers.double) || [],
          hint: (cur.jokers && cur.jokers.hint) || [],
          pass: (cur.jokers && cur.jokers.pass) || null,
        },
        judged: cur.judged || {},
        buzz: cur.buzz || { open: false, winner: null },
        // Restzeit statt Uhrzeit, damit abweichende Geräteuhren egal sind
        timer: cur.timer
          ? { remaining: Math.max(0, cur.timer.endsAt - Date.now()), total: cur.timer.total }
          : null,
      };
    }
    // Runden-Intro: noch nicht aufgedeckte Kategorien bleiben leer
    const intro = state.intro && state.intro.round === r ? state.intro : null;
    const names = set.rounds[r].categories.map((c) => c.name);
    return {
      title: set.title,
      theme: getTheme(),
      round: r,
      categories: names.map((n, i) => (intro && i >= intro.step ? '' : n)),
      intro: intro ? { step: intro.step, name: intro.step > 0 ? names[intro.step - 1] : null } : null,
      values: Array.from({ length: ROWS }, (_, row) => pointsFor(r, row)),
      used: state.used[r],
      players: state.players.map((p, i) => ({
        id: p.id, name: p.name, score: p.score,
        usedJokers: Array.isArray(p.usedJokers) ? p.usedJokers : [],
        color: state.mode === 'team' ? teamColor(i) : null,
      })),
      mode: state.mode === 'team' ? 'team' : 'single',
      teamSize: clampTeamSize(state.teamSize),
      turn: opt(set, state, 'turn') ? state.turn || null : null,
      // Spielregeln, die Spieler/TV kennen müssen (Joker-Leiste, „Am Zug“)
      opts: Object.fromEntries(['jokerDouble', 'jokerHint', 'jokerPass', 'turn', 'penalty', 'abstainPenalty', 'stealHalf', 'splitScoring', 'turnShare', 'otherShare', 'otherPenalty', 'estimateRunnerUp', 'stealShare', 'reactions', 'qrTv', 'awards', 'soundDefault'].map((k) => [k, opt(set, state, k)])),
      finished: !!state.finished,
      // Statistik-Daten gehen nur raus, wenn Statistik oder Auszeichnungen sie anzeigen dürfen
      statsShown: !!state.statsShown && !!state.finished && opt(set, state, 'stats'),
      stats: opt(set, state, 'stats') || opt(set, state, 'awards') ? state.stats || {} : {},
      personStats: state.mode === 'team' && (opt(set, state, 'stats') || opt(set, state, 'awards')) ? state.personStats || {} : {},
      current,
      // Final Jeopardy (js/finale.js): ohne Einsätze, Antworten und Lösung vor dem Aufdecken
      final: window.J && window.J.fj && !state.finished ? window.J.fj.publicFinal(set, state) : null,
    };
  }

  // Farbthemen (Werte nur für die Vorschau im Host; das eigentliche Styling steckt in style.css)
  const THEMES = [
    { id: 'graphit', name: 'Graphit', sw: ['#1d1e22', '#34d399'] },
    { id: 'hell', name: 'Hell', sw: ['#ffffff', '#18181b'] },
    { id: 'nacht', name: 'Nacht', sw: ['#5b21b6', '#f472b6'] },
    { id: 'wald', name: 'Wald', sw: ['#1b5e3b', '#e9d8a6'] },
    { id: 'klassisch', name: 'Klassisch', sw: ['#2f55f0', '#ffc940'] },
  ];
  const THEME_KEY = 'jeopardy.theme';
  function getTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (THEMES.some((x) => x.id === t)) return t;
    } catch (e) {}
    return 'graphit';
  }
  function applyTheme(id) {
    if (!THEMES.some((x) => x.id === id)) id = 'graphit';
    document.documentElement.dataset.theme = id;
  }
  function setTheme(id) {
    try { localStorage.setItem(THEME_KEY, id); } catch (e) {}
    applyTheme(id);
  }

  // ---------- Sounds (per Web Audio erzeugt, keine Dateien nötig) ----------
  const SOUND_KEY = 'jeopardy.sound';
  let audio = null;
  // Standard für Geräte ohne eigene Wahl (Spielregel „soundDefault“, setzt die Spieler-Seite)
  let soundDefault = true;
  const setSoundDefault = (on) => { soundDefault = on !== false; };
  function soundOn() {
    try {
      const v = localStorage.getItem(SOUND_KEY);
      return v === null ? soundDefault : v !== 'off';
    } catch (e) { return soundDefault; }
  }
  function setSoundOn(on) {
    try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch (e) {}
  }
  function audioCtx() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audio = new AC();
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  // Browser erlauben Ton erst nach einer Nutzeraktion → beim ersten Tippen freischalten.
  function unlockAudio() {
    const ctx = audioCtx();
    return !!ctx && ctx.state === 'running';
  }
  function audioUnlocked() {
    return !!audio && audio.state === 'running';
  }

  function tone(ctx, { freq, to, start = 0, dur = 0.15, type = 'sine', vol = 0.2, filter, dest }) {
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      osc.connect(f);
      node = f;
    }
    node.connect(gain).connect(dest || ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  const SOUNDS = {
    // Aufsteigender Dreiklang
    right(ctx) {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(ctx, { freq: f, start: i * 0.08, dur: i === 3 ? 0.45 : 0.18, type: 'triangle', vol: 0.22 })
      );
    },
    // Dumpfer „Bonk“
    wrong(ctx) {
      tone(ctx, { freq: 160, to: 60, dur: 0.3, type: 'sine', vol: 0.45 });
    },
    // Kurzes „Swoosh“ beim Öffnen einer Frage
    open(ctx) {
      tone(ctx, { freq: 380, to: 900, dur: 0.18, type: 'sine', vol: 0.14 });
      tone(ctx, { freq: 760, start: 0.12, dur: 0.25, type: 'triangle', vol: 0.08 });
    },
    // Jemand hat gebuzzert
    buzz(ctx) {
      tone(ctx, { freq: 1046.5, dur: 0.12, type: 'square', vol: 0.12, filter: 3000 });
      tone(ctx, { freq: 1568, start: 0.1, dur: 0.3, type: 'square', vol: 0.1, filter: 3000 });
    },
    // Buzzer ist offen
    buzzopen(ctx) {
      tone(ctx, { freq: 660, dur: 0.1, type: 'triangle', vol: 0.18 });
      tone(ctx, { freq: 660, start: 0.16, dur: 0.1, type: 'triangle', vol: 0.18 });
    },
    // Zeit abgelaufen
    timeup(ctx) {
      tone(ctx, { freq: 330, dur: 0.35, type: 'square', vol: 0.12, filter: 1200 });
      tone(ctx, { freq: 247, start: 0.4, dur: 0.6, type: 'square', vol: 0.12, filter: 1200 });
    },
    // Sekunden-Tick in den letzten 5 Sekunden
    tick(ctx) {
      tone(ctx, { freq: 1200, dur: 0.05, type: 'sine', vol: 0.12 });
    },
    // Rundenstart: aufsteigender Akkord
    intro(ctx) {
      [261.63, 329.63, 392, 523.25, 659.25].forEach((f, i) =>
        tone(ctx, { freq: f, start: i * 0.11, dur: 1.2 - i * 0.1, type: 'triangle', vol: 0.12 })
      );
      tone(ctx, { freq: 130.81, dur: 1.4, type: 'sine', vol: 0.15 });
    },
    // Kategorie wird aufgedeckt: Wusch + heller Ton
    catreveal(ctx) {
      tone(ctx, { freq: 200, to: 1200, dur: 0.25, type: 'sine', vol: 0.08 });
      tone(ctx, { freq: 987.77, start: 0.2, dur: 0.5, type: 'triangle', vol: 0.12 });
      tone(ctx, { freq: 1479.98, start: 0.24, dur: 0.45, type: 'sine', vol: 0.06 });
    },
    // Fanfare zur Siegerehrung
    fanfare(ctx) {
      const notes = [[523.25, 0, 0.14], [523.25, 0.16, 0.14], [523.25, 0.32, 0.14], [659.25, 0.48, 0.5],
        [587.33, 1.0, 0.14], [659.25, 1.16, 0.14], [783.99, 1.32, 0.9]];
      notes.forEach(([f, s, d]) => {
        tone(ctx, { freq: f, start: s, dur: d, type: 'sawtooth', vol: 0.1, filter: 2200 });
        tone(ctx, { freq: f * 2, start: s, dur: d, type: 'triangle', vol: 0.06 });
      });
    },
    // Joker eingesetzt: kurzes Glitzern
    joker(ctx) {
      [1318.5, 1568, 2093].forEach((f, i) => tone(ctx, { freq: f, start: i * 0.06, dur: 0.25, type: 'sine', vol: 0.1 }));
    },
    // Heller Glockenton beim Aufdecken
    reveal(ctx) {
      tone(ctx, { freq: 880, dur: 0.5, type: 'sine', vol: 0.16 });
      tone(ctx, { freq: 1320, start: 0.04, dur: 0.45, type: 'sine', vol: 0.08 });
    },
  };

  // Timer-Sound (nur TV-Ansicht und Host-Pult): Uhr-Ticken jede Sekunde, tiefer Herzschlag
  // alle 2,5 s (am Ende etwas kräftiger), leise Piepser bei 3-2-1. Alles wird beim Start
  // vorausgeplant und hängt an einem eigenen Regler, damit Stopp sofort alles verstummen lässt.
  // Musik-Spuren: jede hat einen eigenen Lautstärkeregler, damit Stopp sofort alles verstummen lässt
  const tracks = {};
  function startTrack(name, schedule) {
    stopTrack(name);
    const ctx = audioCtx();
    if (!ctx) return;
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    schedule((o) => tone(ctx, { ...o, dest: bus }));
    tracks[name] = { ctx, bus };
  }
  function stopTrack(name) {
    const tr = tracks[name];
    if (!tr) return;
    delete tracks[name];
    tr.bus.gain.setTargetAtTime(0.0001, tr.ctx.currentTime, 0.08);
    setTimeout(() => tr.bus.disconnect(), 600);
  }

  function startTimerMusic(remainingMs) {
    startTrack('timer', (T) => {
      const R = remainingMs / 1000;
      for (let t = R % 1, k = 0; t < R - 0.05; t += 1, k++) {
        T({ freq: k % 2 ? 1400 : 1800, start: t, dur: 0.025, type: 'square', vol: 0.02 });
      }
      for (let t = 0.5; t < R; t += 2.5) {
        const v = R - t <= 5 ? 0.32 : 0.22;
        T({ freq: 55, start: t, dur: 0.22, vol: v });
        T({ freq: 52, start: t + 0.24, dur: 0.26, vol: v * 0.7 });
      }
      [3, 2, 1].forEach((s) => { if (R - s > 0.05) T({ freq: 880, start: R - s, dur: 0.1, vol: 0.08 }); });
    });
  }
  const stopTimerMusic = () => stopTrack('timer');
  const timerMusicOn = () => !!tracks.timer;

  function sfx(name) {
    const ctx = audioCtx();
    if (!ctx || !SOUNDS[name]) return;
    try { SOUNDS[name](ctx); } catch (e) { console.warn('Sound fehlgeschlagen', e); }
  }

  // Timer-Anzeige (Host und Spieler): Balken + Sekunden
  function renderTimer(el, remaining, total) {
    if (remaining == null) { el.hidden = true; return; }
    el.hidden = false;
    const secs = Math.ceil(remaining / 1000);
    el.classList.toggle('urgent', secs <= 5);
    el.querySelector('.timer-num').textContent = secs;
    el.querySelector('.timer-fill').style.width = (100 * remaining / total) + '%';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  // Farbe für style-Attribute: nur #hex (aus der Teampalette); alles andere fällt weg
  function safeColor(c) {
    return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '';
  }
  // Zahl für innerHTML: Netzwerkdaten können Strings sein → immer endliche Zahl
  function safeNum(n) {
    n = Number(n);
    return Number.isFinite(n) ? n : 0;
  }

  function renderScores(el, players, turnId) {
    if (!players.length) {
      el.innerHTML = '<div class="score-empty">Noch keine Spieler</div>';
      el.__prev = null;
      return;
    }
    const prev = el.__prev || null;
    el.__prev = Object.fromEntries(players.map((p) => [p.id, p.score]));
    el.innerHTML = players.map((p) => `
      <div class="score${p.id && p.id === turnId ? ' turn' : ''}"${safeColor(p.color) ? ` style="--team:${safeColor(p.color)}"` : ''}>
        <div class="score-name">${safeColor(p.color) ? '<i class="team-dot"></i>' : ''}${escapeHtml(p.name)}</div>
        <div class="score-value ${p.score < 0 ? 'neg' : ''}">${safeNum(p.score)}</div>
        ${scoreDelta(prev, p)}
      </div>`).join('');
    // Geänderte Punkte: Kachel leuchtet grün/rot auf, Zahl rollt vom alten zum neuen Wert
    if (!prev) return;
    el.querySelectorAll('.score').forEach((tile, i) => {
      const p = players[i];
      if (!(p.id in prev) || prev[p.id] === p.score) return;
      tile.classList.add(p.score > prev[p.id] ? 'fx-up' : 'fx-down');
      countUp(tile.querySelector('.score-value'), prev[p.id], p.score);
    });
  }
  function countUp(node, from, to) {
    const dur = window.JEOP_COUNT_MS != null ? window.JEOP_COUNT_MS : 700;
    if (!dur || typeof requestAnimationFrame !== 'function') return;
    const t0 = performance.now();
    node.textContent = from;
    (function step(now) {
      if (!node.isConnected) return; // inzwischen neu gezeichnet
      const k = Math.min(1, (now - t0) / dur);
      node.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }
  // „+500“ / „−250“ fliegt kurz über die Kachel, wenn sich die Punkte geändert haben
  function scoreDelta(prev, p) {
    if (!prev || !(p.id in prev)) return '';
    const d = safeNum(p.score) - prev[p.id];
    if (!d) return '';
    return `<span class="delta ${d > 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>`;
  }

  // ---------- Runden-Intro ----------
  // Großes Overlay: erst „Runde X“, dann jede Kategorie einzeln
  function renderIntro(el, intro, round, values) {
    el.classList.toggle('show', !!intro);
    if (!intro) { el.dataset.step = ''; return; }
    const key = round + ':' + intro.step;
    if (el.dataset.step === key) return; // Animation nicht bei jedem Update neu starten
    el.dataset.step = key;
    const kicker = el.querySelector('.intro-kicker');
    const title = el.querySelector('.intro-title');
    const sub = el.querySelector('.intro-sub');
    if (intro.step === 0) {
      kicker.textContent = 'Jeopardy';
      title.textContent = 'Runde ' + (round + 1);
      sub.textContent = values[0] + ' – ' + values[values.length - 1] + ' Punkte';
    } else {
      kicker.textContent = `Kategorie ${intro.step} von ${CATS}`;
      title.textContent = intro.name || '';
      sub.textContent = '';
    }
    const inner = el.querySelector('.intro-inner');
    inner.classList.remove('anim');
    void inner.offsetWidth; // Reflow, damit die Animation neu startet
    inner.classList.add('anim');
  }

  // Klassen für Board-Zellen während/nach dem Intro
  function introCellClass(intro, catIndex) {
    if (!intro) return '';
    if (catIndex >= intro.step) return ' hidden-cat';
    return catIndex === intro.step - 1 ? ' flip' : '';
  }

  // Banner „Anna wählt“
  function renderTurn(el, players, turnId) {
    const p = players.find((x) => x.id === turnId);
    el.hidden = !p;
    if (p) el.innerHTML = `<span class="turn-label">Am Zug</span> ${escapeHtml(p.name)} wählt`;
  }

  // ---------- Siegerehrung ----------
  // Platzierung mit Gleichstand (1, 1, 3 …)
  function ranking(players) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    let place = 0;
    return sorted.map((p, i) => {
      if (i === 0 || p.score !== sorted[i - 1].score) place = i + 1;
      return { ...p, place };
    });
  }

  // 420 → „0,42 s“
  function fmtMs(ms) {
    return (ms / 1000).toFixed(2).replace('.', ',') + ' s';
  }

  // Auszeichnungen aus der Spielstatistik (nur vergeben, wenn es etwas zu zeigen gibt)
  const AWARDS = [
    { icon: '⚡', title: 'Buzzer-König', key: 'buzzWins', best: 'max', fmt: (v) => v + '× zuerst gebuzzert' },
    { icon: '🦝', title: 'Meisterdieb', key: 'steals', best: 'max', fmt: (v) => v + '× geklaut' },
    { icon: '🎯', title: 'Treffsicher', key: 'right', best: 'max', fmt: (v) => v + ' richtig' },
    { icon: '🙈', title: 'Meiste Fehlversuche', key: 'wrong', best: 'max', fmt: (v) => v + ' falsch' },
  ];
  // persons (nur Team-Modus): { key: { name, team, buzzWins } } – Buzzer-König geht dann an eine Person
  function awards(players, stats, persons) {
    stats = stats || {};
    const personList = persons && Object.keys(persons).length
      ? Object.values(persons).map((x) => ({ p: { name: `${x.name} (${x.team})` }, s: x }))
      : null;
    const out = [];
    AWARDS.forEach((a) => {
      const source = a.key === 'buzzWins' && personList
        ? personList
        : players.map((p) => ({ p, s: stats[p.id] || {} }));
      const vals = source
        .map(({ p, s }) => ({ p, v: s[a.key] }))
        .filter((x) => typeof x.v === 'number' && (a.best === 'min' || x.v > 0));
      if (!vals.length) return;
      const best = a.best === 'min' ? Math.min(...vals.map((x) => x.v)) : Math.max(...vals.map((x) => x.v));
      const who = vals.filter((x) => x.v === best).map((x) => x.p.name);
      out.push({ ...a, names: who, value: a.fmt(best) });
    });
    return out;
  }

  function renderPodium(el, players, title, stats, persons) {
    const ranked = ranking(players);
    const top = ranked.filter((p) => p.place <= 3);
    const rest = ranked.filter((p) => p.place > 3);
    // Reihenfolge auf dem Treppchen: 2 – 1 – 3
    const slot = (place) => top.filter((p) => p.place === place);
    const col = (place) => {
      const ps = slot(place);
      if (!ps.length) return '<div class="pod-col empty"></div>';
      return `<div class="pod-col p${place}">
        <div class="pod-names">${ps.map((p) => `<div class="pod-name">${escapeHtml(p.name)}</div>`).join('')}</div>
        <div class="pod-score${ps[0].score < 0 ? ' neg' : ''}">${safeNum(ps[0].score)}</div>
        <div class="pod-block"><span>${place}</span></div>
      </div>`;
    };
    const winners = slot(1).map((p) => escapeHtml(p.name)).join(' & ');
    el.innerHTML = `
      <div class="pod-title">${escapeHtml(title || 'Endstand')}</div>
      <div class="pod-winner">${winners ? '🏆 ' + winners : 'Keine Spieler'}</div>
      <div class="podium">${col(2)}${col(1)}${col(3)}</div>
      ${rest.length ? `<div class="pod-rest">${rest.map((p) =>
        `<div><span>${safeNum(p.place)}.</span> ${escapeHtml(p.name)} <b>${safeNum(p.score)}</b></div>`).join('')}</div>` : ''}
      ${(() => {
        const list = awards(players, stats, persons);
        return list.length ? `<div class="awards">${list.map((a, i) => `
          <div class="award" style="--d:${1.2 + i * 0.25}s">
            <div class="award-icon">${escapeHtml(a.icon)}</div>
            <div class="award-title">${escapeHtml(a.title)}</div>
            <div class="award-name">${a.names.map(escapeHtml).join(' & ')}</div>
            <div class="award-value">${escapeHtml(a.value)}</div>
          </div>`).join('')}</div>` : '';
      })()}`;
  }

  // ---------- Live-Reaktionen ----------
  const REACTIONS = ['😂', '👏', '😱', '🔥', '🤔'];
  function showReaction(emoji, name) {
    if (!REACTIONS.includes(emoji)) return;
    let layer = document.getElementById('reactLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'reactLayer';
      layer.className = 'react-layer';
      document.body.appendChild(layer);
    }
    if (layer.childElementCount > 40) layer.firstElementChild.remove(); // bei Spam begrenzen
    const el = document.createElement('div');
    el.className = 'react-float';
    el.style.left = (8 + Math.random() * 84) + '%';
    el.style.setProperty('--sway', (Math.random() * 80 - 40).toFixed(0) + 'px');
    el.innerHTML = `<span class="react-emoji">${escapeHtml(emoji)}</span>${name ? `<span class="react-name">${escapeHtml(name)}</span>` : ''}`;
    el.addEventListener('animationend', () => el.remove());
    layer.appendChild(el);
  }

  // Konfetti als DOM-Elemente (keine Bibliothek nötig)
  function confetti(el, count = 140) {
    el.querySelectorAll('.confetti').forEach((c) => c.remove());
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['var(--accent)', 'var(--accent-2)', '#f87171', '#60a5fa', '#fbbf24', '#a78bfa', '#ffffff'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const c = document.createElement('i');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + '%';
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = (Math.random() * 2.5).toFixed(2) + 's';
      c.style.animationDuration = (3 + Math.random() * 3).toFixed(2) + 's';
      c.style.setProperty('--drift', (Math.random() * 200 - 100).toFixed(0) + 'px');
      c.style.setProperty('--spin', (Math.random() * 1080 - 540).toFixed(0) + 'deg');
      if (i % 3 === 0) c.style.borderRadius = '50%';
      frag.appendChild(c);
    }
    el.appendChild(frag);
  }

  // ---------- Fragenset-Bibliothek: Kategorien kopieren/mischen, Dateien prüfen ----------
  const MAX_SET_FILE_BYTES = 4_000_000; // wie das Server-Limit für ein Set (api/sets)

  const cloneJson = (x) => JSON.parse(JSON.stringify(x));

  // Kategorie (mit allen Feldern: Fragearten, Bilder, Notizen) aus einem Set holen; null, wenn es sie nicht gibt
  function pickCategory(set, round, cat) {
    const c = set && set.rounds && set.rounds[round] && set.rounds[round].categories[cat];
    return c ? cloneJson(c) : null;
  }

  /**
   * Kopiert Kategorien in ein Set: `picks` = [{ set, round, cat }], eingefügt ab Platz `slot`
   * der Runde `round` (bestehende Kategorien dort werden ersetzt). Gibt ein neues Set zurück.
   */
  function copyCategories(target, picks, round, slot) {
    if (!Array.isArray(picks) || !picks.length) throw new Error('Keine Kategorie ausgewählt.');
    if (!Number.isInteger(round) || round < 0 || round >= ROUNDS) throw new Error('Ungültige Runde.');
    if (!Number.isInteger(slot) || slot < 0 || slot + picks.length > CATS) {
      throw new Error(`Ab diesem Platz ist nur Platz für ${Math.max(0, CATS - slot)} Kategorien (${picks.length} ausgewählt).`);
    }
    const out = normalizeSet(cloneJson(target));
    picks.forEach((p, i) => {
      const c = pickCategory(normalizeSet(p.set), p.round, p.cat);
      if (!c) throw new Error('Kategorie nicht gefunden.');
      out.rounds[round].categories[slot + i] = c;
    });
    return normalizeSet(out);
  }

  /** Neues Set aus Kategorien verschiedener Sets: die ersten 6 füllen Runde 1, die nächsten 6 Runde 2. */
  function mixSets(picks, title) {
    if (!Array.isArray(picks) || !picks.length) throw new Error('Keine Kategorie ausgewählt.');
    if (picks.length > CATS * ROUNDS) throw new Error(`Höchstens ${CATS * ROUNDS} Kategorien möglich.`);
    const out = defaultSet();
    out.title = typeof title === 'string' && title.trim() ? title.trim() : 'Mix';
    picks.forEach((p, i) => {
      const c = pickCategory(normalizeSet(p.set), p.round, p.cat);
      if (!c) throw new Error('Kategorie nicht gefunden.');
      out.rounds[Math.floor(i / CATS)].categories[i % CATS] = c;
    });
    return normalizeSet(out);
  }

  /** Set-Datei prüfen und normalisieren; wirft Error mit deutscher Meldung. `size` = Dateigröße in Bytes (optional). */
  function parseSetFile(text, size = String(text).length) {
    if (size > MAX_SET_FILE_BYTES) throw new Error('Datei ist zu groß (maximal 4 MB).');
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Datei ist kein gültiges JSON.'); }
    if (!data || !Array.isArray(data.rounds)) throw new Error('Kein gültiges Fragenset.');
    // Unbekannte Fragearten (Datei ist neuer als diese Seite) nicht still verwerfen
    const unknown = data.rounds.flatMap((r) => (r && r.categories) || []).flatMap((c) => (c && c.clues) || [])
      .some((cl) => cl && cl.kind && !CLUE_KINDS.includes(cl.kind));
    if (unknown) throw new Error('Das Set nutzt Fragearten, die diese Seite noch nicht kennt. Bitte die Seite neu laden (Strg+Shift+R) und nochmal importieren.');
    return normalizeSet(data);
  }


  // ---------- Spielstand als Datei (Export/Import) ----------
  const GAME_FORMAT = 'jeopardy-game';
  const GAME_VERSION = 1;
  const MAX_GAME_FILE_BYTES = 8_000_000;
  const GAME_HISTORY_KEEP = 30;
  const ROOM_RE = /^[A-Z0-9]{4,12}$/;

  /** Spielstand (+ Set oder Set-Verweis) als Datei-Objekt. Rein; Antworten stecken drin → Host-only. */
  function exportGame(state, set, { room, includeSet = true, setRef = null, now = new Date() } = {}) {
    const st = normalizeState(state);
    st.history = st.history.slice(-GAME_HISTORY_KEEP);
    const ref = isObj(setRef) && typeof setRef.id === 'string' ? { id: String(setRef.id).slice(0, 80), updated: String(setRef.updated || '').slice(0, 40) } : null;
    return {
      format: GAME_FORMAT, v: GAME_VERSION, app: APP_VERSION,
      room: ROOM_RE.test(String(room || '')) ? String(room) : null,
      savedAt: now.toISOString(),
      state: st,
      set: includeSet && set ? normalizeSet(set) : null,
      setRef: ref,
    };
  }

  /** Spielstand-Datei prüfen (nie dem Inhalt trauen). → { ok:true, snapshot } | { ok:false, error } (deutsche Meldung). */
  function parseGame(text, size = typeof text === 'string' ? text.length : 0) {
    if (size > MAX_GAME_FILE_BYTES) return { ok: false, error: 'Datei ist zu groß (maximal 8 MB).' };
    let data = text;
    if (typeof text === 'string') {
      try { data = JSON.parse(text); } catch (e) { return { ok: false, error: 'Datei ist kein gültiges JSON.' }; }
    }
    if (!isObj(data) || data.format !== GAME_FORMAT) return { ok: false, error: 'Das ist keine Jeopardy-Spielstand-Datei.' };
    if (!Number.isInteger(data.v) || data.v < 1) return { ok: false, error: 'Spielstand-Datei ohne gültige Version.' };
    if (data.v > GAME_VERSION) return { ok: false, error: 'Der Spielstand wurde mit einer neueren Version erstellt. Bitte die Seite neu laden (Strg+Shift+R).' };
    if (!isObj(data.state) || !Array.isArray(data.state.players) || !Array.isArray(data.state.used)) return { ok: false, error: 'Der Spielstand in der Datei ist unvollständig.' };
    let set = null;
    if (data.set != null) {
      try { set = parseSetFile(JSON.stringify(data.set)); } catch (e) { return { ok: false, error: 'Das Fragenset in der Datei ist ungültig: ' + e.message }; }
    }
    const state = normalizeState(data.state, { resume: true });
    state.history = state.history.slice(-GAME_HISTORY_KEEP);
    const ref = isObj(data.setRef) && typeof data.setRef.id === 'string' && data.setRef.id.length <= 80
      ? { id: data.setRef.id, updated: String(data.setRef.updated || '').slice(0, 40) } : null;
    const room = typeof data.room === 'string' && ROOM_RE.test(data.room) ? data.room : null;
    const savedAt = typeof data.savedAt === 'string' && !Number.isNaN(Date.parse(data.savedAt)) ? data.savedAt : null;
    return { ok: true, snapshot: { format: GAME_FORMAT, v: GAME_VERSION, app: String(data.app || '').slice(0, 40), room, savedAt, state, set, setRef: ref } };
  }

  window.J = {
    copyCategories, mixSets, parseSetFile, pickCategory, MAX_SET_FILE_BYTES,
    safeMedia, mediaTypeOf, mediaFileError, MEDIA_LIMITS,
    PIXEL_STEPS, ZOOM_STEPS, imgSteps, imgMode, pixelLevel, pixelate, zoomCrop,
    CLUE_KINDS, isSpecialKind, parseNumber, estimateWinners, estimateRunnerUps, orderItems, shufflePerm, randomPerm, isPerm, orderCorrect, JOKERS, jokerInfo, jokerEnabled, activeJokers, jokerBlock, OPTION_DEFS, opt, effectiveOptions, cleanOptions, optionsLocked, whoIsUp, hintPattern, judgePoints, splitPoints, splitLine, optDefault,
    APP_VERSION, CATS, ROWS, ROUNDS, SET_KEY,
    pointsFor, defaultSet, normalizeSet, defaultState,
    loadSet, saveSet, loadState, normalizeState, saveState,
    exportGame, parseGame, MAX_GAME_FILE_BYTES,
    roomCode, newRoomCode, ROOM_KEY, peerId, publicState, escapeHtml, safeColor, safeNum, renderScores,
    THEMES, getTheme, applyTheme, setTheme,
    penaltyFor, stealFor, sfx, startTimerMusic, stopTimerMusic, timerMusicOn, soundOn, setSoundOn, setSoundDefault, unlockAudio, audioUnlocked, renderTimer,
    TIMER_MS: 15000,
    safeImg, compressImage, renderTurn, renderPodium, confetti, ranking,
    renderIntro, introCellClass,
    nextTurn, turnAfterRemoval, LOCK_MS, MIN_REACTION_MS, isEarly, pickBuzzWinner,
    clampTeamSize, teamIsFull, teamColor, cleanName,
    DEFAULT_ICE, parseTurn, iceConfig, encodeTurn, decodeTurn, joinUrl, loadTurn, saveTurn, scoreDelta,
    fmtMs, awards, REACTIONS, showReaction, BUZZ_WINDOW_MS: 400,
    // Übers Relay kommen Buzzes ungleichmäßiger an (HTTP statt Direktverbindung) → länger sammeln
    BUZZ_WINDOW_RELAY_MS: 900,
  };
})();
