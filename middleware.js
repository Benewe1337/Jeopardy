// Vercel Routing Middleware: simple shared-password gate in front of the whole site.
// Imports lib/throttle.mjs and @neondatabase/serverless (Vercel bundles them with the middleware).
// The password comes from the JEOPARDY_PASSWORD environment variable; the cookie holds an
// HMAC-signed session token (key derived from the password), so changing the password logs
// everyone out. Login attempts are throttled per IP (lib/throttle.mjs).

import { neon } from '@neondatabase/serverless';
import { clientKey, memoryThrottle, pgThrottle } from './lib/throttle.mjs';

export const COOKIE = 'jeop_auth';
export const LOGIN_PATH = '/__login';
const MAX_AGE = 60 * 60 * 24 * 30;
// Styles and fonts are needed by the login page itself and contain nothing secret.
const PUBLIC_PREFIXES = ['/css/', '/fonts/', '/favicon', '/js/theme.js'];
// Same policy as vercel.json (middleware responses don't get the static headers).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src 'self'; connect-src 'self' https://0.peerjs.com wss://0.peerjs.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SESSION_VERSION = 'v1';
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// HMAC key derived from the site password: changing the password invalidates every session.
async function sessionKey(password) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('jeopardy-session-key:' + password));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(password, payload) {
  return hex(await crypto.subtle.sign('HMAC', await sessionKey(password), enc.encode(payload)));
}

/** Signed session token `v1.<issuedAt>.<expiresAt>.<hmac>` (times in seconds). */
export async function signSession(password, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const payload = `${SESSION_VERSION}.${iat}.${iat + MAX_AGE}`;
  return `${payload}.${await sign(password, payload)}`;
}

export async function verifySession(token, password, now = Date.now()) {
  if (typeof token !== 'string' || !password) return false;
  const m = /^(v1)\.(\d{1,12})\.(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const [, , iat, exp, sig] = m;
  const good = safeEqual(await sign(password, `${SESSION_VERSION}.${iat}.${exp}`), sig);
  const t = Math.floor(now / 1000);
  return good && Number(exp) > t && Number(iat) <= t + 60 && Number(exp) - Number(iat) <= MAX_AGE;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}

// Only plain same-site paths (no control chars, spaces, backslashes, "//"), so the login
// form can't be abused as an open redirect; anything else becomes "/".
const SAFE_NEXT = /^\/(?!\/)[A-Za-z0-9._~\/-]*(\?[A-Za-z0-9._~=&%+-]*)?$/;
export function safeNext(v) {
  return typeof v === 'string' && v.length <= 2000 && SAFE_NEXT.test(v) ? v : '/';
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(next, failed, retryAfter) {
  const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Jeopardy – Passwort</title>
  <script src="/js/theme.js"></script>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <main class="home">
    <h1 class="logo">JEOPARDY<span>!</span></h1>
    <p class="tagline">Privates Spiel – bitte Passwort eingeben.</p>
    <div class="card">
      <h2>Passwort</h2>
      <form class="row" method="post" action="${LOGIN_PATH}">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <input id="password" name="password" type="password" placeholder="Passwort" autocomplete="current-password" required autofocus>
        <button class="primary" type="submit">Weiter</button>
      </form>
      ${retryAfter ? `<p class="hint" role="alert">Zu viele Versuche. Bitte in ${Math.ceil(retryAfter / 60)} Min. erneut versuchen.</p>` : failed ? '<p class="hint" role="alert">Falsches Passwort.</p>' : ''}
    </div>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: retryAfter ? 429 : failed ? 401 : 200,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex',
      'content-security-policy': CSP,
      ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}),
    },
  });
}

/**
 * Returns a Response to short-circuit the request, or undefined to let it through.
 * @param {Request} request
 * @param {string | undefined} password
 * @param {{ attempt(key: string): Promise<{allowed: boolean, retryAfter?: number}>, reset(key: string): Promise<void> }} [throttle]
 */
export async function gate(request, password, throttle) {
  const url = new URL(request.url);
  if (PUBLIC_PREFIXES.some((p) => url.pathname.startsWith(p))) return undefined;
  if (!password) return new Response('JEOPARDY_PASSWORD ist nicht gesetzt.', { status: 500 });

  if (url.pathname === LOGIN_PATH && request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const given = form ? String(form.get('password') || '') : '';
    const next = safeNext(form ? String(form.get('next') || '/') : '/');
    // Count the attempt before checking it, so parallel guesses can't slip past the limit.
    const key = throttle ? await clientKey('site', request.headers) : null;
    if (key) {
      const a = await throttle.attempt(key);
      if (!a.allowed) return loginPage(next, true, a.retryAfter);
    }
    const [g, w] = await Promise.all([sign(given, 'login-check'), sign(password, 'login-check')]);
    if (!safeEqual(g, w)) return loginPage(next, true);
    if (key) await throttle.reset(key).catch(() => {});
    return new Response(null, {
      status: 303,
      headers: {
        location: next,
        'set-cookie': `${COOKIE}=${await signSession(password)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store',
      },
    });
  }

  if (await verifySession(readCookie(request, COOKIE), password)) return undefined;
  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return loginPage(safeNext(url.pathname + url.search), false);
}

// One throttle per runtime instance: Neon when configured, otherwise (or if the database is
// unreachable) in memory, so the login stays throttled and never locks the host out.
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sql = dbUrl ? neon(dbUrl) : null;
const memory = memoryThrottle();
const pg = sql ? pgThrottle((text, params) => sql.query(text, params)) : null;
const throttle = {
  attempt: async (key) => (pg ? pg.attempt(key).catch(() => memory.attempt(key)) : memory.attempt(key)),
  reset: async (key) => { memory.reset(key); if (pg) await pg.reset(key).catch(() => {}); },
};

export default function middleware(request) {
  return gate(request, process.env.JEOPARDY_PASSWORD, throttle);
}
