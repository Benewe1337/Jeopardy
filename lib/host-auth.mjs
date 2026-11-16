// Host-Passwort (JEOPARDY_HOST_PASSWORD): gemeinsam genutzt von api/sets, api/game und dem
// Relay-Takeover. Nur der Host kennt es; Spieler kennen höchstens das Seiten-Passwort.

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
