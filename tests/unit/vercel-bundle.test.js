// Loads middleware.js the way the Vercel runtime does: compiled to CommonJS file by file
// (esbuild, no bundling; relative imports stay require() calls) and then require()d by plain
// Node with require(esm) switched off. Regression test for T-32: a static import of an ES module
// (lib/throttle.mjs) made every request fail with ERR_REQUIRE_ESM on Vercel.
// Also checks that the ESM api functions still load with everything they import.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '../..');

function stage(entry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeop-vercel-'));
  const out = esbuild.transformSync(fs.readFileSync(path.join(root, entry), 'utf8'), { format: 'cjs', target: 'node20' });
  fs.writeFileSync(path.join(dir, entry), out.code);
  fs.cpSync(path.join(root, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

const DRIVER = `
const mw = require('./middleware.js');
const handler = mw.default || mw;
(async () => {
  const get = await handler(new Request('https://example.test/'));
  const bad = await handler(new Request('https://example.test/__login', { method: 'POST', body: new URLSearchParams({ password: 'nope' }) }));
  const ok = await handler(new Request('https://example.test/__login', { method: 'POST', body: new URLSearchParams({ password: 'pw', next: '/host.html' }) }));
  console.log(JSON.stringify({
    get: get.status, csp: !!get.headers.get('content-security-policy'), html: (await get.text()).includes('type="password"'),
    bad: bad.status, ok: ok.status, loc: ok.headers.get('location'), cookie: /jeop_auth=v1\\./.test(ok.headers.get('set-cookie') || ''),
  }));
})().catch((e) => { console.error(e); process.exit(1); });
`;

test('middleware.js loads as CommonJS (no require() of an ES module) and serves the login', () => {
  const dir = stage('middleware.js');
  try {
    fs.writeFileSync(path.join(dir, 'driver.js'), DRIVER);
    const r = spawnSync(process.execPath, ['--no-experimental-require-module', 'driver.js'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, JEOPARDY_PASSWORD: 'pw', DATABASE_URL: '', POSTGRES_URL: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()),
      { get: 200, csp: true, html: true, bad: 401, ok: 303, loc: '/host.html', cookie: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('middleware.js only imports CommonJS-compatible local files', () => {
  const src = fs.readFileSync(path.join(root, 'middleware.js'), 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    assert.ok(!m[1].endsWith('.mjs'), `middleware.js imports ES module ${m[1]}`);
  }
});

for (const f of fs.readdirSync(path.join(root, 'api')).filter((n) => n.endsWith('.mjs'))) {
  test(`api/${f} loads as an ES module`, () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(path.join(root, 'api', f))})`], {
      cwd: root, encoding: 'utf8', env: { ...process.env, DATABASE_URL: '', POSTGRES_URL: '' },
    });
    assert.equal(r.status, 0, r.stderr);
  });
}
