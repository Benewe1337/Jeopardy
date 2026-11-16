// Katalog: reine Logik für die automatische Spielzusammenstellung (ohne DOM, auch in Node testbar).
(function (root) {
  const LEVELS = ['runde1', 'runde2'];

  // Kleiner deterministischer Zufallsgenerator (mulberry32); ohne Seed zufällig
  function rng(seed) {
    let a = (seed === undefined || seed === null ? Math.floor(Math.random() * 2 ** 32) : Number(seed)) >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(list, rand) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const norm = (s) => String(s || '').trim().toLowerCase();

  /** Index prüfen und auf brauchbare Einträge reduzieren; wirft Error mit deutscher Meldung. */
  function parseIndex(json) {
    if (!Array.isArray(json)) throw new Error('Katalog hat ein unerwartetes Format.');
    return json.filter((e) => e && typeof e.file === 'string' && /^[\w\-äöüÄÖÜß.]+\.json$/.test(e.file) && e.file !== 'index.json'
      && typeof e.name === 'string' && LEVELS.includes(e.level))
      .map((e) => ({
        file: e.file, name: e.name, level: e.level,
        tags: Array.isArray(e.tags) ? e.tags.map(norm) : [],
        types: Array.isArray(e.types) ? e.types : [],
      }));
  }

  /** Alle Tags bzw. Fragearten des Katalogs, sortiert. */
  const allTags = (index) => [...new Set(index.flatMap((e) => e.tags))].sort((a, b) => a.localeCompare(b, 'de'));
  const allTypes = (index) => [...new Set(index.flatMap((e) => e.types))].sort();

  /** Filter: level ('' = alle), type ('' = alle, 'normal' = nur ohne Spezialfragen), tag, text. */
  function filterIndex(index, { level = '', type = '', tag = '', text = '' } = {}) {
    const t = norm(text);
    return index.filter((e) => (!level || e.level === level)
      && (!tag || e.tags.includes(norm(tag)))
      && (!type || (type === 'normal' ? e.types.length === 0 : e.types.includes(type)))
      && (!t || norm(e.name).includes(t) || e.tags.some((x) => x.includes(t))));
  }

  /**
   * Wählt 6 Kategorien je Runde (Level runde1 → Runde 1, runde2 → Runde 2).
   * exclude: Kategorienamen, die schon in anderen Sets vorkommen (werden nur genommen, wenn sonst zu wenige da sind).
   * tags: bevorzugte Tags (passende Kategorien zuerst).
   * Gibt { rounds: [[entry×n], [entry×n]], repeated: Anzahl wiederholter Kategorien } zurück.
   */
  function pickGame(index, { seed, tags = [], exclude = [], perRound = 6 } = {}) {
    const rand = rng(seed);
    const used = new Set([...exclude].map(norm));
    const pref = new Set(tags.map(norm).filter(Boolean));
    let repeated = 0;
    const rounds = LEVELS.map((level) => {
      const pool = index.filter((e) => e.level === level);
      if (pool.length < perRound) {
        throw new Error(`Im Katalog gibt es nur ${pool.length} Kategorien für Runde ${LEVELS.indexOf(level) + 1} (gebraucht: ${perRound}).`);
      }
      const rank = (e) => (used.has(norm(e.name)) ? 2 : 0) + (pref.size && !e.tags.some((t) => pref.has(t)) ? 1 : 0);
      // Zuerst mischen, dann stabil nach Rang sortieren: frisch+passend → frisch → wiederholt+passend → wiederholt
      const ordered = shuffled(pool, rand).map((e, i) => ({ e, i }))
        .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e);
      const chosen = ordered.slice(0, perRound);
      repeated += chosen.filter((e) => used.has(norm(e.name))).length;
      return shuffled(chosen, rand);
    });
    return { rounds, repeated };
  }

  /** Set aus geladenen Kategorien bauen: data = [[Kategorie×6], [Kategorie×6]]; J = common.js. */
  function buildSet(J, data, title) {
    const set = J.defaultSet();
    set.title = (title && String(title).trim()) || 'Katalogspiel';
    data.forEach((cats, r) => cats.forEach((c, i) => { set.rounds[r].categories[i] = c; }));
    return J.normalizeSet(set);
  }

  const api = { rng, shuffled, parseIndex, allTags, allTypes, filterIndex, pickGame, buildSet, LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
