// Spielstatistik: Erfassen (rein, unit-getestet), Auswerten, Anzeige und Export (CSV/JSON).
// Die Rohdaten liegen in state.stats[spielerId] / state.personStats[id:name] und werden mit dem
// Undo-Snapshot gesichert; hier steht alles, was daraus die Statistik-Ansicht macht.
(function () {
  const J = window.J;
  const MAX_REACTIONS = 300; // pro Spieler/Person, damit der Spielstand klein bleibt
  const JOKER_KEYS = ['double', 'hint', 'pass'];

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // Namen wie „__proto__“ dürfen keine Objekt-Eigenschaften verbiegen
  const dict = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  function entry(stats, pid) {
    if (!own(stats, pid) || !stats[pid] || typeof stats[pid] !== 'object') {
      Object.defineProperty(stats, pid, { value: { right: 0, wrong: 0, buzzWins: 0, steals: 0 }, enumerable: true, writable: true, configurable: true });
    }
    return stats[pid];
  }
  function bump(obj, key, by = 1) {
    obj[key] = num(obj[key]) + by;
  }
  function catEntry(s, cat) {
    if (!s.cats || typeof s.cats !== 'object') s.cats = {};
    if (!own(s.cats, cat) || !s.cats[cat]) {
      Object.defineProperty(s.cats, cat, { value: { right: 0, wrong: 0 }, enumerable: true, writable: true, configurable: true });
    }
    return s.cats[cat];
  }
  function jokerEntry(s, kind) {
    if (!s.jokers || typeof s.jokers !== 'object') s.jokers = {};
    if (!s.jokers[kind]) s.jokers[kind] = { used: 0, won: 0, lost: 0 };
    return s.jokers[kind];
  }

  // Urteil zu einer Frage: verdict 'right' | 'wrong'. opts: { cat (Kategoriename), stolen, jokers (cur.jokers) }
  function recordVerdict(stats, pid, verdict, opts = {}) {
    const s = entry(stats, pid);
    bump(s, verdict === 'right' ? 'right' : 'wrong');
    if (verdict === 'right' && opts.stolen) bump(s, 'steals');
    if (opts.cat) bump(catEntry(s, String(opts.cat)), verdict === 'right' ? 'right' : 'wrong');
    const jk = opts.jokers || {};
    if ((jk.double || []).includes(pid)) bump(jokerEntry(s, 'double'), verdict === 'right' ? 'won' : 'lost');
    // Weitergeben gelingt, wenn der Empfänger richtig liegt
    if (jk.pass && jk.pass.to === pid && jk.pass.from && jk.pass.from !== pid) {
      bump(jokerEntry(entry(stats, jk.pass.from), 'pass'), verdict === 'right' ? 'won' : 'lost');
    }
  }

  function recordJoker(stats, pid, kind) {
    if (JOKER_KEYS.includes(kind)) bump(jokerEntry(entry(stats, pid), kind), 'used');
  }

  function pushReaction(obj, ms) {
    if (!Array.isArray(obj.reactions)) obj.reactions = [];
    obj.reactions.push(ms);
    if (obj.reactions.length > MAX_REACTIONS) obj.reactions.shift();
  }

  // Buzzer-Runde: entries = [[id, ms, name]] aller gültigen Buzzes, winnerId = Gewinner.
  // team = Team-Modus (dann zusätzlich pro Person); teamName(id) liefert den Teamnamen.
  function recordBuzz(stats, persons, entries, winnerId, team, teamName) {
    entries.forEach(([id, ms, name]) => {
      if (!Number.isFinite(ms)) return;
      const s = entry(stats, id);
      pushReaction(s, ms);
      if (id === winnerId) bump(s, 'buzzWins');
      if (team && name) {
        const key = id + ':' + name;
        if (!own(persons, key) || !persons[key]) {
          Object.defineProperty(persons, key, { value: { name, team: teamName(id), buzzWins: 0 }, enumerable: true, writable: true, configurable: true });
        }
        pushReaction(persons[key], ms);
        if (id === winnerId) bump(persons[key], 'buzzWins');
      }
    });
  }

  function recordFinal(stats, pid, result) {
    entry(stats, pid).fj = { wager: num(result.wager), verdict: result.verdict === 'right' ? 'right' : 'wrong', delta: num(result.delta) };
  }

  const rate = (right, wrong) => (right + wrong ? Math.round((right / (right + wrong)) * 1000) / 10 : null);
  function reactionStats(list) {
    const xs = (Array.isArray(list) ? list : []).filter((x) => Number.isFinite(x) && x >= 0);
    if (!xs.length) return { count: 0, avg: null, min: null };
    return { count: xs.length, avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), min: Math.min(...xs) };
  }

  // Normalisierte Auswertung: tolerant gegen fehlende/kaputte Felder (alter Spielstand, Fremddaten)
  function summarize(players, stats, persons, mode) {
    stats = dict(stats);
    persons = dict(persons);
    const team = mode === 'team';
    const catNames = [];
    const rows = (Array.isArray(players) ? players : []).map((p) => {
      const s = dict(stats[p.id]);
      const right = num(s.right);
      const wrong = num(s.wrong);
      const cats = Object.keys(dict(s.cats)).map((name) => {
        const c = dict(s.cats[name]);
        if (!catNames.includes(name)) catNames.push(name);
        return { name, right: num(c.right), wrong: num(c.wrong), rate: rate(num(c.right), num(c.wrong)) };
      });
      const jokers = {};
      JOKER_KEYS.forEach((k) => {
        const j = dict(dict(s.jokers)[k]);
        jokers[k] = { used: num(j.used), won: num(j.won), lost: num(j.lost) };
      });
      const fj = s.fj && typeof s.fj === 'object'
        ? { wager: num(s.fj.wager), verdict: s.fj.verdict === 'right' ? 'right' : 'wrong', delta: num(s.fj.delta) } : null;
      const dd = s.dd && typeof s.dd === 'object' ? { won: num(s.dd.won), lost: num(s.dd.lost) } : null;
      return {
        id: String(p.id), name: String(p.name), score: num(p.score),
        right, wrong, rate: rate(right, wrong), steals: num(s.steals), buzzWins: num(s.buzzWins),
        reaction: reactionStats(s.reactions), cats, jokers, fj, dd,
      };
    });
    const people = team ? Object.keys(persons).map((key) => {
      const x = dict(persons[key]);
      return { name: String(x.name || ''), team: String(x.team || ''), buzzWins: num(x.buzzWins), reaction: reactionStats(x.reactions) };
    }).filter((x) => x.name) : [];
    return { mode: team ? 'team' : 'single', players: rows, persons: people, categories: catNames };
  }

  // ---------- Export ----------
  // CSV-Zelle: Zahlen bleiben Zahlen, Text mit =, +, -, @, Tab oder CR am Anfang bekommt ein ' (Excel/Calc führen
  // sonst Formeln aus); Zellen mit Komma, Anführungszeichen oder Zeilenumbruch werden in "..." gesetzt.
  function csvCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const csvRow = (cells) => cells.map(csvCell).join(',');

  // Lange Form (eine Zeile pro Kennzahl), damit eine einzige gültige CSV alles enthält:
  // Typ, Name, Team, Kategorie, Kennzahl, Wert
  function toCsv(sum) {
    const rows = [['Typ', 'Name', 'Team', 'Kategorie', 'Kennzahl', 'Wert']];
    const unit = sum.mode === 'team' ? 'Team' : 'Spieler';
    sum.players.forEach((p) => {
      const m = (k, v) => rows.push([unit, p.name, '', '', k, v]);
      m('Punkte', p.score); m('Richtig', p.right); m('Falsch', p.wrong); m('Trefferquote %', p.rate);
      m('Geklaut', p.steals); m('Buzzer-Siege', p.buzzWins); m('Reaktion Ø ms', p.reaction.avg);
      m('Reaktion schnellste ms', p.reaction.min); m('Buzzer-Reaktionen', p.reaction.count);
      JOKER_KEYS.forEach((k) => {
        m(`Joker ${k} genutzt`, p.jokers[k].used);
        if (k !== 'hint') { m(`Joker ${k} erfolgreich`, p.jokers[k].won); m(`Joker ${k} fehlgeschlagen`, p.jokers[k].lost); }
      });
      if (p.fj) { m('Final Jeopardy Einsatz', p.fj.wager); m('Final Jeopardy Ergebnis', p.fj.verdict === 'right' ? 'richtig' : 'falsch'); m('Final Jeopardy Punkte', p.fj.delta); }
      if (p.dd) { m('Daily Double gewonnen', p.dd.won); m('Daily Double verloren', p.dd.lost); }
      p.cats.forEach((c) => {
        rows.push([unit, p.name, '', c.name, 'Richtig', c.right]);
        rows.push([unit, p.name, '', c.name, 'Falsch', c.wrong]);
        rows.push([unit, p.name, '', c.name, 'Trefferquote %', c.rate]);
      });
    });
    sum.persons.forEach((x) => {
      rows.push(['Person', x.name, x.team, '', 'Buzzer-Siege', x.buzzWins]);
      rows.push(['Person', x.name, x.team, '', 'Reaktion Ø ms', x.reaction.avg]);
      rows.push(['Person', x.name, x.team, '', 'Reaktion schnellste ms', x.reaction.min]);
      rows.push(['Person', x.name, x.team, '', 'Buzzer-Reaktionen', x.reaction.count]);
    });
    return rows.map(csvRow).join('\r\n') + '\r\n';
  }

  const toJson = (sum, title) => JSON.stringify({ title: title || '', exportedAt: new Date().toISOString(), ...sum }, null, 2);

  // ---------- Anzeige ----------
  const esc = (v) => J.escapeHtml(String(v));
  const fmt = (v, suffix = '') => (v == null ? '–' : String(v).replace('.', ',') + suffix);
  const ms = (v) => (v == null ? '–' : J.fmtMs(v));

  function renderStats(el, sum) {
    const team = sum.mode === 'team';
    const jokerCell = (p) => {
      const d = p.jokers.double;
      const parts = [];
      if (d.used) parts.push(`🎲 ${d.used}× (${d.won} ✓ / ${d.lost} ✗)`);
      if (p.jokers.hint.used) parts.push(`💡 ${p.jokers.hint.used}×`);
      if (p.jokers.pass.used) parts.push(`👉 ${p.jokers.pass.used}× (${p.jokers.pass.won} ✓ / ${p.jokers.pass.lost} ✗)`);
      return parts.join(' · ') || '–';
    };
    const special = (p) => [
      p.fj ? `Final: ${p.fj.verdict === 'right' ? '✓' : '✗'} ${p.fj.delta > 0 ? '+' : ''}${p.fj.delta} (Einsatz ${p.fj.wager})` : '',
      p.dd ? `Daily Double: ${p.dd.won} ✓ / ${p.dd.lost} ✗` : '',
    ].filter(Boolean).join(' · ') || '–';
    const rows = sum.players.map((p) => `<tr>
      <th scope="row">${esc(p.name)}</th><td>${esc(p.score)}</td>
      <td>${esc(p.right)} / ${esc(p.wrong)}</td><td>${esc(fmt(p.rate, ' %'))}</td><td>${esc(p.steals)}</td>
      <td>${esc(p.buzzWins)}</td><td>${esc(ms(p.reaction.avg))}</td><td>${esc(ms(p.reaction.min))}</td>
      <td>${esc(jokerCell(p))}</td><td>${esc(special(p))}</td></tr>`).join('');
    const cats = sum.categories.length ? `<h3>Trefferquote je Kategorie</h3><table class="stats-table stats-cats">
      <thead><tr><th></th>${sum.categories.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${sum.players.map((p) => `<tr><th scope="row">${esc(p.name)}</th>${sum.categories.map((c) => {
        const x = p.cats.find((y) => y.name === c);
        return `<td>${x ? `${esc(fmt(x.rate, ' %'))} <small>(${esc(x.right)}/${esc(x.right + x.wrong)})</small>` : '–'}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table>` : '';
    const people = sum.persons.length ? `<h3>Personen (Buzzer)</h3><table class="stats-table stats-people">
      <thead><tr><th>Person</th><th>Team</th><th>Siege</th><th>Ø Reaktion</th><th>Schnellste</th></tr></thead><tbody>
      ${sum.persons.map((x) => `<tr><th scope="row">${esc(x.name)}</th><td>${esc(x.team)}</td><td>${esc(x.buzzWins)}</td>
        <td>${esc(ms(x.reaction.avg))}</td><td>${esc(ms(x.reaction.min))}</td></tr>`).join('')}</tbody></table>` : '';
    el.innerHTML = `<div class="stats-view"><h2>📊 Statistik</h2><div class="stats-scroll">
      <table class="stats-table stats-main"><thead><tr><th>${team ? 'Team' : 'Spieler'}</th><th>Punkte</th><th>Richtig / Falsch</th>
      <th>Quote</th><th>Geklaut</th><th>Buzzer-Siege</th><th>Ø Reaktion</th><th>Schnellste</th><th>Joker</th><th>Final / Daily Double</th></tr></thead>
      <tbody>${rows}</tbody></table>${cats}${people}</div></div>`;
  }

  J.stats = { recordVerdict, recordJoker, recordBuzz, recordFinal, summarize, csvCell, toCsv, toJson, renderStats, reactionStats };
})();
