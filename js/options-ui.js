// Spielregeln-Oberfläche: wird aus J.OPTION_DEFS gerendert und von Editor (Voreinstellung im Set)
// und Host-Pult (Überschreibung pro Spiel) gemeinsam genutzt. Neue Optionen = nur ein Eintrag in common.js.
(function () {
  const J = window.J;
  const esc = (s) => J.escapeHtml(s);

  // cfg: { value(key), locked, lockedNote, onChange(key, value), onReset?, resetLabel? }
  function render(box, cfg) {
    // Nur neu zeichnen, wenn sich etwas geändert hat – sonst verliert z. B. ein offenes Auswahlfeld den Fokus
    const sig = JSON.stringify([J.OPTION_DEFS.map((d) => cfg.value(d.key)), !!cfg.locked, !!cfg.onReset]);
    if (box.__sig === sig) return;
    box.__sig = sig;
    box.innerHTML = '';
    if (cfg.locked && cfg.lockedNote) {
      const note = document.createElement('p');
      note.className = 'hint opt-locked';
      note.textContent = '🔒 ' + cfg.lockedNote;
      box.appendChild(note);
    }
    let group = null;
    let groupEl = null;
    const matches = (cond) => Object.entries(cond).every(([k, v]) => cfg.value(k) === v);
    for (const d of J.OPTION_DEFS) {
      // showIf/hideIf: Stellschrauben der Punkteverteilung erscheinen nur bei eingeschaltetem Hauptschalter
      if ((d.showIf && !matches(d.showIf)) || (d.hideIf && matches(d.hideIf))) continue;
      if (d.group !== group) {
        group = d.group;
        groupEl = document.createElement('div');
        groupEl.className = 'opt-group';
        groupEl.innerHTML = `<h4>${esc(group)}</h4>`;
        box.appendChild(groupEl);
      }
      const value = cfg.value(d.key);
      const blocked = !!d.requires && Object.entries(d.requires).some(([k, v]) => cfg.value(k) !== v);
      const row = document.createElement('label');
      row.className = 'opt-row' + (blocked ? ' opt-off' : '');
      let input;
      if (d.type === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = value === true;
        input.addEventListener('change', () => cfg.onChange(d.key, input.checked));
        row.append(input, ' ' + d.label);
      } else {
        input = document.createElement('select');
        d.choices.forEach(([v, text]) => {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = text;
          input.appendChild(o);
        });
        input.value = value;
        input.addEventListener('change', () => cfg.onChange(d.key, input.value));
        row.append(d.label + ' ', input);
      }
      input.id = 'opt-' + d.key;
      input.disabled = !!cfg.locked || blocked;
      const hint = blocked ? d.requiresHint : d.hint;
      if (hint) row.title = hint;
      groupEl.appendChild(row);
      if (hint) {
        const h = document.createElement('div');
        h.className = 'opt-hint';
        h.textContent = hint;
        groupEl.appendChild(h);
      }
    }
    if (cfg.onReset) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'small ghost';
      b.id = 'opt-reset';
      b.textContent = cfg.resetLabel || 'Zurücksetzen';
      b.addEventListener('click', cfg.onReset);
      box.appendChild(b);
    }
  }

  J.optionsUI = { render };
})();
