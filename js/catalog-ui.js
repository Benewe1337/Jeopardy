// Katalog-Panel im Editor: Kategorien aus catalog/ durchsuchen, ansehen, ins aktuelle Set einfügen
// und ein ganzes Spiel automatisch zusammenstellen. Nutzt J.copyCategories aus common.js.
(function () {
  const $ = (id) => document.getElementById(id);
  const panel = $('catPanel');
  const G = window.JCatalog;
  const KIND_LABEL = { estimate: '🔢 Schätzfrage', order: '↕️ Reihenfolge', choice: '🅰️ Multiple Choice' };
  const LEVEL_LABEL = { runde1: 'Runde 1', runde2: 'Runde 2' };

  let index = null;               // geladener Katalog
  const loaded = new Map();       // Dateiname -> Kategorie
  const selected = new Set();     // Dateinamen
  const open = new Set();         // Dateien mit offener Vorschau

  const ed = () => J.editor;
  const msg = (t, err) => { const el = $('catMsg'); el.textContent = t || ''; el.classList.toggle('error', !!err); };

  async function fetchJson(url) {
    let res;
    try { res = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' }); }
    catch (e) { throw new Error('Katalog konnte nicht geladen werden – bitte Internetverbindung prüfen.'); }
    if (res.status === 401 || res.status === 403) throw new Error('Katalog nicht erreichbar – bitte neu anmelden (Seite neu laden).');
    if (!res.ok) throw new Error(`Katalog konnte nicht geladen werden (Fehler ${res.status}).`);
    try { return await res.json(); }
    catch (e) { throw new Error('Katalog ist beschädigt (kein gültiges JSON).'); }
  }

  async function loadIndex() {
    if (index) return index;
    index = G.parseIndex(await fetchJson('catalog/index.json'));
    const tagSel = $('catTag'), typeSel = $('catType'), autoTag = $('catAutoTag');
    G.allTags(index).forEach((t) => { tagSel.add(new Option(t, t)); autoTag.add(new Option(t, t)); });
    G.allTypes(index).forEach((k) => typeSel.add(new Option(KIND_LABEL[k] || k, k)));
    return index;
  }

  async function loadCategory(entry) {
    if (!loaded.has(entry.file)) {
      const data = await fetchJson('catalog/' + encodeURIComponent(entry.file));
      if (!data || !Array.isArray(data.clues)) throw new Error(`Kategorie „${entry.name}“ ist beschädigt.`);
      loaded.set(entry.file, data);
    }
    return loaded.get(entry.file);
  }

  const asSet = (cat) => ({ rounds: [{ categories: [cat] }] });

  function preview(cat) {
    const ol = document.createElement('ol');
    ol.className = 'cat-preview';
    cat.clues.forEach((c) => {
      const li = document.createElement('li');
      const kind = c.kind ? ` [${KIND_LABEL[c.kind] || c.kind}]` : '';
      li.append(`${c.q}${kind} → `);
      const b = document.createElement('b');
      b.textContent = c.a;
      li.append(b);
      ol.append(li);
    });
    return ol;
  }

  function renderList() {
    const box = $('catList');
    box.textContent = '';
    const list = G.filterIndex(index, {
      level: $('catLevel').value, type: $('catType').value, tag: $('catTag').value, text: $('catText').value,
    });
    $('catCount').textContent = `${list.length} von ${index.length} Kategorien`;
    if (!list.length) { box.textContent = 'Keine Kategorie passt zu diesem Filter.'; return; }
    list.forEach((e) => {
      const row = document.createElement('div');
      row.className = 'cat-row';
      row.dataset.file = e.file;
      const head = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(e.file);
      cb.addEventListener('change', () => { if (cb.checked) selected.add(e.file); else selected.delete(e.file); });
      const meta = document.createElement('span');
      meta.className = 'cat-meta';
      meta.textContent = `${LEVEL_LABEL[e.level]} · ${e.tags.join(', ')}${e.types.length ? ' · ' + e.types.map((k) => KIND_LABEL[k] || k).join(', ') : ''}`;
      const name = document.createElement('strong');
      name.textContent = e.name;
      head.append(cb, name, meta);
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'small ghost cat-view';
      view.textContent = open.has(e.file) ? 'Vorschau ▲' : 'Vorschau ▼';
      const body = document.createElement('div');
      const show = async () => {
        body.textContent = '';
        if (!open.has(e.file)) return;
        try { body.append(preview(await loadCategory(e))); } catch (err) { msg(err.message, true); open.delete(e.file); }
        view.textContent = open.has(e.file) ? 'Vorschau ▲' : 'Vorschau ▼';
      };
      view.addEventListener('click', () => { if (open.has(e.file)) open.delete(e.file); else open.add(e.file); view.textContent = open.has(e.file) ? 'Vorschau ▲' : 'Vorschau ▼'; show(); });
      row.append(head, view, body);
      box.append(row);
      show();
    });
  }

  function renderSlots() {
    const n = Math.max(1, selected.size);
    const slot = $('catSlot'), keep = slot.value;
    slot.textContent = '';
    for (let s = 0; s <= J.CATS - n; s++) slot.add(new Option(String(s + 1), String(s)));
    if (keep && Number(keep) <= J.CATS - n) slot.value = keep;
  }

  async function ensure() {
    msg('Lade Katalog…');
    try { await loadIndex(); msg(''); renderList(); renderSlots(); }
    catch (e) { index = null; msg(e.message, true); $('catList').textContent = ''; }
  }

  $('setCatalog').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) ensure();
  });
  $('catClose').addEventListener('click', () => { panel.hidden = true; });
  ['catLevel', 'catType', 'catTag'].forEach((id) => $(id).addEventListener('change', () => index && renderList()));
  $('catText').addEventListener('input', () => index && renderList());
  $('catList').addEventListener('change', renderSlots);
  $('catRetry').addEventListener('click', ensure);

  $('catInsert').addEventListener('click', async () => {
    if (!index) return msg('Katalog ist nicht geladen.', true);
    const entries = index.filter((e) => selected.has(e.file));
    if (!entries.length) return msg('Bitte erst Kategorien ankreuzen.', true);
    try {
      const picks = (await Promise.all(entries.map(loadCategory))).map((c) => ({ set: asSet(c), round: 0, cat: 0 }));
      const next = J.copyCategories(ed().set, picks, Number($('catRound').value), Number($('catSlot').value));
      ed().replaceSet(next);
      selected.clear();
      renderList();
      renderSlots();
      msg(`${picks.length === 1 ? 'Kategorie' : picks.length + ' Kategorien'} eingefügt ✓`);
    } catch (e) { msg(e.message, true); }
  });

  // Namen aller Kategorien in den vorhandenen Sets (Bibliothek) – um Wiederholungen zu vermeiden
  async function usedNames() {
    const names = new Set();
    const addSet = (s) => J.normalizeSet(s).rounds.forEach((r) => r.categories.forEach((c) => names.add(c.name.trim().toLowerCase())));
    if (ed().lib) {
      for (const s of await ed().lib.list()) {
        try { addSet(s.id === ed().activeId ? ed().set : (await ed().lib.get(s.id)).data); } catch (e) { /* Set nicht lesbar → ignorieren */ }
      }
    } else addSet(ed().set);
    return names;
  }

  $('catAuto').addEventListener('click', () => ed().guard(async () => {
    if (!index) await ensure();
    if (!index) return;
    msg('Stelle Spiel zusammen…');
    try {
      const tag = $('catAutoTag').value;
      const picked = G.pickGame(index, { tags: tag ? [tag] : [], exclude: [...await usedNames()] });
      const data = await Promise.all(picked.rounds.map((r) => Promise.all(r.map(loadCategory))));
      const title = prompt('Name des neuen Spiels:', 'Katalogspiel');
      if (!title || !title.trim()) return msg('');
      const set = G.buildSet(J, data, title.trim().slice(0, 60));
      await ed().createSet(set.title, set);
      msg(picked.repeated ? `Neues Spiel angelegt ✓ (${picked.repeated} Kategorie${picked.repeated === 1 ? '' : 'n'} kamen schon in anderen Sets vor – der Katalog hat nicht mehr neue)`
        : 'Neues Spiel angelegt ✓');
    } catch (e) { msg(e.message, true); }
  }));
})();
