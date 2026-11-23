// Veröffentlichung: PeerJS kommt aus vendor/ (kein CDN), und GitHub Pages bekommt nur Laufzeitdateien.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const PAGES = ['index.html', 'host.html', 'player.html', 'editor.html'];

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p)];
  });
}

test('keine HTML-Seite lädt Skripte oder Styles von fremden Servern', () => {
  for (const f of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const external = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(https?:)?\/\/[^"]+"/g)];
    assert.deepEqual(external.map((m) => m[0]), [], `${f} lädt extern`);
  }
});

test('vendor/peerjs.min.js entspricht dem peerjs-Paket und hat eine Lizenz', () => {
  const pkg = require('peerjs/package.json');
  const declared = require('../../package.json').devDependencies.peerjs;
  assert.equal(pkg.version, declared);
  assert.ok(fs.readFileSync(path.join(ROOT, 'vendor/peerjs.min.js')).equals(
    fs.readFileSync(require.resolve('peerjs/dist/peerjs.min.js'))));
  assert.match(fs.readFileSync(path.join(ROOT, 'vendor/LICENSE-peerjs'), 'utf8'), /MIT/);
  for (const f of ['host.html', 'player.html']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /<script src="vendor\/peerjs\.min\.js"><\/script>/);
  }
});

test('build-pages.sh veröffentlicht nur die Erlaubnisliste', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jeop-pages-'));
  try {
    execFileSync(path.join(ROOT, 'scripts/build-pages.sh'), [out], { stdio: 'pipe' });
    const files = walk(out);
    for (const f of files) {
      assert.ok(PAGES.includes(f) || /^(css|js|fonts|vendor|catalog)\//.test(f), `unerwartet veröffentlicht: ${f}`);
    }
    // Alles, was zur Laufzeit gebraucht wird, ist dabei
    for (const f of [...PAGES, 'css/style.css', 'js/common.js', 'js/net.js', 'js/host.js', 'js/player.js',
      'js/editor.js', 'js/sets.js', 'fonts/inter.woff2', 'vendor/peerjs.min.js', 'catalog/index.json']) {
      assert.ok(files.includes(f), `fehlt: ${f}`);
    }
    // Interne Dateien nie
    for (const bad of ['tests', 'api', 'lib', 'CLAUDE.md', 'package.json', 'package-lock.json', 'middleware.js',
      'vercel.json', '.crew', '.github', 'node_modules', '.vercelignore']) {
      assert.ok(!fs.existsSync(path.join(out, bad)), `darf nicht veröffentlicht werden: ${bad}`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('jede lokal referenzierte Datei der Seiten liegt im Pages-Ordner', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jeop-pages-'));
  try {
    execFileSync(path.join(ROOT, 'scripts/build-pages.sh'), [out], { stdio: 'pipe' });
    const refs = new Set();
    for (const f of PAGES) {
      const html = fs.readFileSync(path.join(out, f), 'utf8');
      for (const m of html.matchAll(/\b(?:src|href)="([^"#?]+)"/g)) if (!/^(https?:|\/\/|mailto:)/.test(m[1])) refs.add(m[1]);
    }
    const css = fs.readFileSync(path.join(out, 'css/style.css'), 'utf8');
    for (const m of css.matchAll(/url\("?\.\.\/([^")]+)"?\)/g)) refs.add(m[1]);
    assert.ok(refs.size > 10);
    for (const r of refs) assert.ok(fs.existsSync(path.join(out, r)), `fehlt im Pages-Ordner: ${r}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('jede Seite hat die CSP per <meta>, identisch zu vercel.json (plus frame-ancestors dort)', () => {
  const header = require('../../vercel.json').headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(header, /frame-ancestors 'none'/);
  const base = header.replace('; frame-ancestors \'none\'', '');
  for (const f of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    assert.ok(m, `${f} ohne CSP-Meta`);
    assert.equal(m[1], base, `${f}: CSP weicht von vercel.json ab`);
  }
  for (const d of ["script-src 'self'", "object-src 'none'", "base-uri 'none'"]) assert.ok(base.includes(d), d);
  assert.ok(!/script-src[^;]*unsafe/.test(base));
});

test('keine Inline-Skripte und keine Inline-Event-Handler im HTML', () => {
  for (const f of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(m[1], /\bsrc=/, `${f}: Inline-Skript`);
      assert.equal(m[2].trim(), '', `${f}: Skript mit src und Inhalt`);
    }
    assert.deepEqual([...html.matchAll(/\son[a-z]+\s*=/gi)].map((m) => m[0]), [], `${f}: Inline-Handler`);
    assert.ok(!/href="javascript:/i.test(html), `${f}: javascript:-Link`);
  }
});

test('Login-Seite der Middleware: kein Inline-Skript, CSP-Header gesetzt', async () => {
  const { gate } = await import('../../middleware.js');
  const res = await gate(new Request('https://x.test/'), 'pw');
  const html = await res.text();
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html));
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  // das eingebundene Theme-Skript muss ohne Login erreichbar sein
  assert.equal(await gate(new Request('https://x.test/js/theme.js'), 'pw'), undefined);
});
