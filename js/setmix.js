// Kategorien-Werkstatt im Editor: Kategorien aus anderen Sets (oder einer Datei) ins aktuelle Set
// kopieren oder daraus ein neues Set mischen. Die Logik steckt in J.copyCategories / J.mixSets.
(function () {
  const $ = (id) => document.getElementById(id);
  const panel = $('mixPanel');
  const cache = new Map();   // Quelle (Set-ID) -> Set
  let fileSet = null;        // aus Datei geladenes Set
  let picks = [];            // [{ label, set, round, cat }]

  const ed = () => J.editor;
  const error = (msg) => { $('mixError').textContent = msg || ''; };
  const FILE = '__file__';

  async function sourceSet(id) {
    if (id === FILE) return fileSet;
    if (!cache.has(id)) {
      // Aktives Set aus dem Editor (ungespeicherte Änderungen), andere aus der Bibliothek
      const data = id === ed().activeId ? ed().set : J.normalizeSet((await ed().lib.get(id)).data);
      cache.set(id, data);
    }
    return cache.get(id);
  }

  async function renderCats() {
    const box = $('mixCats');
    box.textContent = '';
    error('');
    const id = $('mixSource').value;
    if (!id) return;
    if (id === ed().activeId) cache.delete(id);
    let set;
    try { set = await sourceSet(id); } catch (e) { return error('Set konnte nicht geladen werden: ' + e.message); }
    set.rounds.forEach((r, ri) => {
      const h = document.createElement('div');
      h.className = 'mix-round';
      h.textContent = `Runde ${ri + 1}`;
      box.append(h);
      r.categories.forEach((c, ci) => {
        const l = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.round = ri;
        cb.dataset.cat = ci;
        l.append(cb, c.name);
        box.append(l);
      });
    });
  }

  function renderPicks() {
    const box = $('mixPicks');
    box.textContent = '';
    picks.forEach((p, i) => {
      const chip = document.createElement('span');
      chip.className = 'mix-pick';
      const del = document.createElement('button');
      del.className = 'small ghost';
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Entfernen';
      del.addEventListener('click', () => { picks.splice(i, 1); renderPicks(); });
      chip.append(`${i + 1}. ${p.label}`, del);
      box.append(chip);
    });
    renderSlots();
  }

  function renderSlots() {
    const slot = $('mixSlot');
    const keep = slot.value;
    slot.textContent = '';
    const free = J.CATS - Math.max(1, picks.length);
    for (let s = 0; s <= free; s++) slot.add(new Option(String(s + 1), String(s)));
    if (keep && Number(keep) <= free) slot.value = keep;
  }

  async function refreshSources() {
    const sel = $('mixSource');
    const keep = sel.value;
    sel.textContent = '';
    if (!ed().lib) return;
    const list = await ed().lib.list();
    list.forEach((s) => sel.add(new Option(s.id === ed().activeId ? s.name + ' (dieses Set)' : s.name, s.id)));
    if (fileSet) sel.add(new Option('📄 ' + fileSet.title + ' (Datei)', FILE));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    await renderCats();
  }

  $('setCopy').addEventListener('click', () => ed().guard(async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { cache.clear(); renderPicks(); await refreshSources(); }
  }));
  $('mixClose').addEventListener('click', () => { panel.hidden = true; });
  $('mixSource').addEventListener('change', () => ed().guard(renderCats));

  $('mixFile').addEventListener('click', () => $('mixFileInput').click());
  $('mixFileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      fileSet = J.parseSetFile(await f.text(), f.size);
      if (!fileSet.title || fileSet.title === 'Jeopardy') fileSet.title = f.name.replace(/\.json$/i, '');
      await refreshSources();
      $('mixSource').value = FILE;
      await renderCats();
    } catch (err) { error('Datei nicht geladen: ' + err.message); }
    e.target.value = '';
  });

  $('mixAdd').addEventListener('click', () => ed().guard(async () => {
    const id = $('mixSource').value;
    const set = await sourceSet(id);
    const checked = [...$('mixCats').querySelectorAll('input:checked')];
    if (!checked.length) return error('Bitte erst Kategorien ankreuzen.');
    if (picks.length + checked.length > J.CATS * J.ROUNDS) return error(`Höchstens ${J.CATS * J.ROUNDS} Kategorien möglich.`);
    error('');
    checked.forEach((cb) => {
      const round = Number(cb.dataset.round), cat = Number(cb.dataset.cat);
      const name = set.rounds[round].categories[cat].name;
      picks.push({ label: name, set: id === ed().activeId ? JSON.parse(JSON.stringify(set)) : set, round, cat });
      cb.checked = false;
    });
    renderPicks();
  }));

  $('mixInsert').addEventListener('click', () => {
    try {
      const next = J.copyCategories(ed().set, picks, Number($('mixRound').value), Number($('mixSlot').value));
      ed().replaceSet(next);
      picks = [];
      renderPicks();
      error('Kopiert ✓');
    } catch (e) { error(e.message); }
  });

  $('mixCreate').addEventListener('click', () => ed().guard(async () => {
    let mixed;
    try { mixed = J.mixSets(picks, 'Mix'); } catch (e) { return error(e.message); }
    const name = prompt('Name des gemischten Sets:', 'Mix');
    if (!name || !name.trim()) return;
    mixed.title = name.trim().slice(0, 60);
    await ed().createSet(mixed.title, mixed);
    picks = [];
    cache.clear();
    renderPicks();
    await refreshSources();
    error('Neues Set angelegt ✓');
  }));
})();
