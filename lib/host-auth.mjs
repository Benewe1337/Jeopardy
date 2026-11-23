// Host-Passwort (JEOPARDY_HOST_PASSWORD): gemeinsam genutzt von api/sets, api/game und dem
// Relay-Takeover. Nur der Host kennt es; Spieler kennen höchstens das Seiten-Passwort.

import { clientKey } from './throttle.cjs';

export async function sha256(text) {
  const data = new TextEncoder().encode('jeopardy-host:' + text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Vergleich über Hashes gleicher Länge, Laufzeit unabhängig vom Inhalt
export async function passwordOk(given, expected) {
  if (typeof given !== 'string' || !given || typeof expected !== 'string' || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Host-password check with per-IP throttling. Resolves to { ok: true } or
 * { ok: false, status: 401 | 429, retryAfter? }. An empty header is no guess and not counted.
 * Throttle store errors fail open to the plain check (the password itself is still verified).
 */
export async function checkHostPassword(headers, expected, throttle) {
  const given = headers?.get?.('x-host-password');
  if (!given || !expected) return { ok: false, status: 401 };
  let key = null;
  if (throttle) {
    try {
      key = await clientKey('host', headers);
      const a = await throttle.attempt(key);
      if (!a.allowed) return { ok: false, status: 429, retryAfter: a.retryAfter };
    } catch (e) {
      console.error('throttle error', e);
      key = null;
    }
  }
  if (!(await passwordOk(given, expected))) return { ok: false, status: 401 };
  if (key) await throttle.reset(key).catch(() => {});
  return { ok: true };
}
