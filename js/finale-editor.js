// Editor-Bereich „Final Jeopardy“ (Kategorie, Frage, Antwort, Host-Notiz). editor.js ruft render() bei jedem Neuzeichnen.
(function () {
  const FIELDS = [
    ['category', 'Kategorie', 'input', 'z. B. Weltgeschichte'],
    ['q', 'Frage / Hinweis', 'textarea', 'Frage, die alle am Handy beantworten'],
    ['a', 'Antwort (nur Host)', 'input', 'Richtige Antwort'],
    ['note', 'Host-Notiz (optional, nur für dich)', 'input', 'z. B. „auch richtig: …“'],
  ];

  function render(set, persist) {
    const box = document.getElementById('fjEditor');
    if (!box) return;
    box.innerHTML = '<h3>⭐ Final Jeopardy <small>(optional)</small></h3>' +
      '<p class="hint">Nach Runde 2 setzen alle geheim Punkte ein und beantworten eine letzte Frage. Ohne Frage und Antwort bleibt Final Jeopardy im Host-Pult ausgegraut.</p>';
    const grid = document.createElement('div');
    grid.className = 'ed-final-grid';
    FIELDS.forEach(([key, label, tag, ph]) => {
      const wrap = document.createElement('label');
      wrap.className = 'ed-final-' + key;
      wrap.append(label);
      const el = document.createElement(tag);
      el.id = 'fj_' + key;
      el.placeholder = ph;
      el.value = (set.final && set.final[key]) || '';
      el.addEventListener('input', () => {
        if (!set.final) set.final = { category: '', q: '', a: '', note: '' };
        set.final[key] = el.value;
        persist();
      });
      wrap.appendChild(el);
      grid.appendChild(wrap);
    });
    box.appendChild(grid);
  }

  J.fjEditor = { render };
})();
