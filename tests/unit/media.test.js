// Audio-/Video-Clips: Validierung, Upload-Grenzen, öffentlicher Zustand (keine Clip-Daten an Handys)
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCommon } = require('./load-common');

const WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA';

test('safeMedia: nur http(s) mit Host und Audio-/Video-Uploads', () => {
  const { J } = loadCommon();
  assert.equal(J.safeMedia('https://example.com/a.mp3'), 'https://example.com/a.mp3');
  assert.equal(J.safeMedia('  http://example.com/a.mp3 '), 'http://example.com/a.mp3');
  assert.equal(J.safeMedia(WAV), WAV);
  assert.equal(J.safeMedia('data:video/webm;codecs=vp8;base64,AAAA'), 'data:video/webm;codecs=vp8;base64,AAAA');
  for (const bad of ['javascript:alert(1)', 'ftp://x/a.mp3', 'file:///etc/passwd', 'https://', 'data:text/html;base64,AAAA',
    'data:image/png;base64,AAAA', 'data:audio/wav,AAAA', '', null, 5, {}]) {
    assert.equal(J.safeMedia(bad), '', String(bad));
  }
});

test('mediaTypeOf: Angabe, data:-Typ, Dateiendung, Standard Audio', () => {
  const { J } = loadCommon();
  assert.equal(J.mediaTypeOf({ media: WAV }), 'audio');
  assert.equal(J.mediaTypeOf({ media: 'data:video/mp4;base64,AAAA' }), 'video');
  assert.equal(J.mediaTypeOf({ media: 'https://x.de/clip.MP4?x=1' }), 'video');
  assert.equal(J.mediaTypeOf({ media: 'https://x.de/stream' }), 'audio');
  assert.equal(J.mediaTypeOf({ media: 'https://x.de/stream', mediaType: 'video' }), 'video');
  assert.equal(J.mediaTypeOf({ media: 'javascript:1', mediaType: 'video' }), null);
  assert.equal(J.mediaTypeOf({}), null);
});

test('mediaFileError: Typ und Größe mit deutscher Meldung', () => {
  const { J } = loadCommon();
  assert.equal(J.mediaFileError({ type: 'audio/mpeg', size: J.MEDIA_LIMITS.audio }), null);
  assert.equal(J.mediaFileError({ type: 'video/mp4', size: J.MEDIA_LIMITS.video }), null);
  assert.match(J.mediaFileError({ type: 'audio/mpeg', size: J.MEDIA_LIMITS.audio + 1 }), /Audiodatei ist zu groß.*höchstens 1\.5 MB/);
  assert.match(J.mediaFileError({ type: 'video/mp4', size: J.MEDIA_LIMITS.video + 1 }), /Videodatei ist zu groß.*höchstens 2 MB/);
  assert.match(J.mediaFileError({ type: 'application/pdf', size: 10 }), /keine Audio- oder Videodatei/);
  assert.ok(J.mediaFileError(null));
});

test('Limits passen zu Set-Speicher und Relay (Base64 = 4/3)', async () => {
  const { J } = loadCommon();
  const { LIMITS: SETS } = await import('../../lib/sets-core.mjs');
  const { LIMITS: RELAY } = await import('../../lib/relay-core.mjs');
  const b64 = (n) => Math.ceil(n / 3) * 4;
  for (const max of Object.values(J.MEDIA_LIMITS)) {
    assert.ok(b64(max) < SETS.maxBodyBytes - 200_000, 'Set muss mit dem Clip speicherbar bleiben');
    assert.ok(b64(max) < RELAY.maxBodyBytes - 200_000, 'Relay-Nachricht mit Clip muss passen');
  }
});

test('normalizeSet behält gültige Clips und verwirft ungültige', () => {
  const { J } = loadCommon();
  const raw = J.defaultSet();
  raw.rounds[0].categories[0].clues[0] = { q: 'x', a: 'y', media: WAV };
  raw.rounds[0].categories[0].clues[1] = { q: 'x', a: 'y', media: 'https://x.de/v', mediaType: 'video' };
  raw.rounds[0].categories[0].clues[2] = { q: 'x', a: 'y', media: 'javascript:alert(1)', mediaType: 'video' };
  const n = J.normalizeSet(JSON.parse(JSON.stringify(raw)));
  const c = n.rounds[0].categories[0].clues;
  assert.equal(c[0].media, WAV);
  assert.equal(c[0].mediaType, 'audio');
  assert.equal(c[1].mediaType, 'video');
  assert.equal(c[2].media, undefined);
  assert.equal(c[2].mediaType, undefined);
  assert.equal(c[3].media, undefined);
});

test('publicState: nur Typ-Hinweis, nie die Clip-Daten', () => {
  const { J } = loadCommon();
  const set = J.defaultSet();
  const big = 'data:video/mp4;base64,' + 'A'.repeat(100_000);
  set.rounds[0].categories[0].clues[0].media = big;
  set.rounds[0].categories[0].clues[0].mediaType = 'video';
  const state = J.defaultState ? J.defaultState() : J.loadState();
  state.current = { round: 0, cat: 0, row: 0 };
  const pub = J.publicState(set, state);
  assert.equal(pub.current.media.kind, 'video');
  assert.ok(!JSON.stringify(pub).includes('AAAAAAAA'), 'keine Clip-Daten im Zustand');
  state.current = { round: 0, cat: 1, row: 0 };
  assert.equal(J.publicState(set, state).current.media, null);
});
