// Audio-/Video-Clips zu Fragen: Editor-Feld, Host-Steuerung und TV-Wiedergabe.
// Clips laufen nur auf Host und TV. Handys bekommen nur den Hinweis "Clip läuft am TV" (publicState),
// die Daten selbst gehen als eigene 'media'-Nachricht ausschließlich an TV-Verbindungen.
(function () {
  const J = window.J;

  // ---------- Editor ----------
  function editorControls(clue, persist) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-media';
    function draw() {
      wrap.innerHTML = '';
      if (clue.media) {
        const kind = J.mediaTypeOf(clue);
        const info = document.createElement('span');
        info.className = 'ed-media-info';
        info.textContent = (kind === 'video' ? '🎬 Video' : '🔊 Audio') + (/^data:/i.test(clue.media) ? ' (hochgeladen)' : ' (Link)');
        const el = document.createElement(kind === 'video' ? 'video' : 'audio');
        el.controls = true;
        el.preload = 'none';
        el.src = clue.media;
        const del = document.createElement('button');
        del.className = 'small ghost';
        del.textContent = '✕ Clip entfernen';
        del.addEventListener('click', () => { delete clue.media; delete clue.mediaType; persist(); draw(); });
        wrap.append(info, el, del);
        return;
      }
      const url = document.createElement('input');
      url.placeholder = 'Audio-/Video-Link (optional)';
      url.addEventListener('change', () => {
        const v = J.safeMedia(url.value);
        if (url.value.trim() && !v) {
          url.classList.add('invalid');
          url.title = 'Link muss mit http:// oder https:// beginnen';
          return;
        }
        if (v) { clue.media = v; clue.mediaType = J.mediaTypeOf({ media: v }); persist(); }
        draw();
      });
      const file = document.createElement('input');
      file.type = 'file';
      file.accept = 'audio/*,video/*';
      file.hidden = true;
      const up = document.createElement('button');
      up.className = 'small';
      up.textContent = '🎵';
      up.title = `Clip hochladen (Audio bis ${J.MEDIA_LIMITS.audio / 1e6} MB, Video bis ${J.MEDIA_LIMITS.video / 1e6} MB)`;
      up.addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files[0];
        file.value = '';
        if (!f) return;
        const err = J.mediaFileError(f);
        if (err) { alert(err); return; }
        up.textContent = '…';
        try {
          clue.media = await readDataUrl(f);
          clue.mediaType = f.type.startsWith('video/') ? 'video' : 'audio';
          if (!persist()) {
            delete clue.media; delete clue.mediaType;
            persist();
            alert('Der Clip passt nicht mehr in den Browserspeicher. Nutze lieber einen Link oder entferne andere hochgeladene Dateien.');
          }
        } catch (e) {
          alert('Der Clip konnte nicht gelesen werden.');
        }
        draw();
      });
      wrap.append(url, up, file);
    }
    draw();
    return wrap;
  }

  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        // manche Browser liefern bei unbekanntem Typ application/octet-stream
        const t = file.type || 'audio/mpeg';
        resolve(String(r.result).replace(/^data:[^;,]*/, 'data:' + t));
      };
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  // ---------- Host ----------
  // Der Host hält den Wiedergabezustand und schickt ihn bei jeder Änderung an alle TV-Verbindungen.
  // opts: { $, conns: () => Set/Array der Verbindungen }
  let H = null;
  function host(opts) {
    H = { ...opts, key: null, clue: null, playing: false, n: 0, el: null };
    const $ = opts.$;
    const el = $('hostMedia');
    H.el = el;
    $('mediaPlay').addEventListener('click', () => {
      H.playing = !H.playing;
      applyLocal();
      sendTv(false);
    });
    $('mediaRestart').addEventListener('click', () => {
      H.playing = true;
      H.n++;
      el.currentTime = 0;
      applyLocal();
      sendTv(false);
    });
    $('mediaMute').addEventListener('click', () => {
      el.muted = !el.muted;
      label();
    });
    el.addEventListener('ended', () => { H.playing = false; label(); });
  }

  function label() {
    const $ = H.$;
    $('mediaPlay').textContent = H.playing ? '⏸ Pause' : '▶ Abspielen';
    $('mediaMute').textContent = H.el.muted ? '🔇 Hier stumm' : '🔊 Hier an';
  }

  function applyLocal() {
    if (H.playing) {
      const p = H.el.play();
      if (p && p.catch) p.catch(() => { H.playing = false; label(); });
    } else H.el.pause();
    label();
  }

  function msg(full) {
    const m = { type: 'media', key: H.key, playing: H.playing, n: H.n };
    if (H.clue) {
      m.kind = J.mediaTypeOf(H.clue);
      if (full) m.src = H.clue.media;
    }
    return m;
  }

  function sendTv(full) {
    H.conns().forEach((c) => { if (c.open && c.isTv) c.send(msg(full)); });
  }

  // bei jedem Rendern der Frage aufgerufen (clue = aktuelle Frage oder null)
  function hostClue(clue, key) {
    if (!H) return;
    const m = clue && J.safeMedia(clue.media) ? clue : null;
    const newKey = m ? key : null;
    const box = H.$('mediaBox');
    box.hidden = !m;
    if (newKey === H.key) return;
    H.key = newKey;
    H.clue = m;
    H.playing = false;
    H.n = 0;
    H.el.pause();
    if (m) {
      H.el.hidden = J.mediaTypeOf(m) !== 'video';
      H.el.src = m.media;
      label();
    } else H.el.removeAttribute('src');
    sendTv(true);
  }

  // Ein TV hat sich (neu) verbunden: komplett nachreichen
  function hostTvJoined(conn) {
    if (H && H.key && conn.open) conn.send(msg(true));
  }

  // ---------- TV ----------
  let T = null;
  function tvInit($) {
    T = { key: null, n: 0, el: $('tvMedia'), box: $('tvMediaBox') };
  }

  function tvMessage(m) {
    if (!T || !m || typeof m !== 'object') return;
    if (!m.key) {
      T.key = null;
      T.el.pause();
      T.el.removeAttribute('src');
      T.box.hidden = true;
      return;
    }
    if (m.key !== T.key) {
      if (typeof m.src !== 'string' || !J.safeMedia(m.src)) return; // Daten (noch) nicht da
      T.key = m.key;
      T.n = 0;
      T.el.src = m.src;
      T.box.hidden = false;
      T.el.hidden = m.kind !== 'video';
      T.box.classList.toggle('audio', m.kind !== 'video');
    }
    if (m.n !== T.n) { T.n = m.n; T.el.currentTime = 0; }
    if (m.playing) {
      const p = T.el.play();
      if (p && p.catch) p.catch(() => {});
    } else T.el.pause();
  }

  window.JMedia = { editorControls, host, hostClue, hostTvJoined, tvInit, tvMessage };
})();
