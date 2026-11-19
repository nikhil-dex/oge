import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { discoverPublicPlaylist, PlaylistDiscoveryError } from '../lib/youtube-playlist-discovery.js';
import { buildDailyLessons } from '../lib/learning-tracks.js';

const id = 'PL0123456789example';
const apiKey = 'AIzA0123456789example12345678901234567890';
const video = (position) => ({ snippet: {
  position, title: 'Lesson ' + (position + 1), resourceId: { videoId: 'abc12345678' },
} });
const page = (items, totalResults, nextPageToken) =>
  ({ ok: true, json: async () => ({ items, pageInfo: { totalResults }, nextPageToken }) });

test('M98 fetches only the fixed Google endpoint with server-key pagination and no content writes', async () => {
  const seen = [];
  const mock = async (url, options) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://www.googleapis.com');
    assert.equal(u.pathname, '/youtube/v3/playlistItems');
    assert.equal(u.searchParams.get('key'), apiKey);
    assert.equal(u.searchParams.get('playlistId'), id);
    assert.equal(u.searchParams.get('part'), 'snippet');
    assert.equal(options.redirect, 'error');
    seen.push(u.searchParams.get('pageToken'));
    if (!u.searchParams.get('pageToken')) return page(Array.from({ length: 50 }, (_, n) => video(n)), 52, 'cursor2');
    return page([video(50), video(51)], 52, null);
  };
  const result = await discoverPublicPlaylist(id, apiKey, mock);
  assert.equal(result.totalVideos, 52);
  assert.equal(result.videos[51].position, 51);
  assert.equal(result.videos[51].url, 'https://www.youtube.com/watch?v=abc12345678&list=' + id);
  assert.deepEqual(seen, [null, 'cursor2']);
  assert.ok(!('description' in result.videos[0]));
});

test('M98 fails closed on partial, reordered, unavailable or malicious metadata', async () => {
  const cases = [
    page([video(3)], 1, null),
    page([video(0)], 2, null),
    page([{ snippet: { position: 0, title: 'Private video', resourceId: { videoId: 'abc12345678' } } }], 1, null),
    page([{ snippet: { position: 0, title: 'Link', resourceId: { videoId: 'javascript:' } } }], 1, null),
    page([video(0)], 501, null),
    page([], 1, 'cursor2'),
  ];
  for (const response of cases)
    await assert.rejects(discoverPublicPlaylist(id, apiKey, async () => response), PlaylistDiscoveryError);
  await assert.rejects(discoverPublicPlaylist('https://evil.example/', apiKey, async () => page([], 0)), PlaylistDiscoveryError);
  await assert.rejects(discoverPublicPlaylist(id, 'invalid', async () => page([], 0)), PlaylistDiscoveryError);
  await assert.rejects(discoverPublicPlaylist(id, apiKey, async () => ({ ok: false, status: 403 })), PlaylistDiscoveryError);
  await assert.rejects(discoverPublicPlaylist(id, apiKey, async () => { throw new Error('key=secret'); }), PlaylistDiscoveryError);
});
test('M98 rejects looped page tokens and inconsistent provider totals', async () => {
  let calls = 0;
  await assert.rejects(discoverPublicPlaylist(id, apiKey, async () => {
    calls += 1;
    return page([video(calls - 1)], 3, 'repeat');
  }), PlaylistDiscoveryError);
  assert.equal(calls, 2);
  await assert.rejects(discoverPublicPlaylist(id, apiKey, async () => {
    return page([video(0)], 2, null);
  }), PlaylistDiscoveryError);
});
test('M98 date schedule remains deterministic across month/leap boundaries', () => {
  const lessons = buildDailyLessons(Array.from({ length: 5 }, (_, n) => ({
    position: n, title: 'Video ' + n, videoId: 'abc12345678',
  })), 2, 3, '2028-02-28');
  assert.deepEqual(lessons.map((day) => day.date), ['2028-02-28','2028-02-29','2028-03-01']);
  assert.deepEqual(lessons.map((day) => day.videos.map((v) => v.completed)), [[true,true],[true,false],[false]]);
  assert.equal(buildDailyLessons([], 2, 0).length, 0);
  for (const invalid of ['2027-02-29', '2028-13-01', 'tomorrow'])
    assert.throws(() => buildDailyLessons([], 2, 0, invalid), TypeError);
  assert.throws(() => buildDailyLessons([{ position: 0 }], 0, 0), TypeError);
  assert.throws(() => buildDailyLessons([{ position: 0 }], 2, 2), TypeError);
});
test('M98 server-only credentials, authenticated owner scope, default-off preview, no GitHub write', async () => {
  const route = await readFile(new URL('../app/api/learning-tracks/discover/route.js', import.meta.url), 'utf8');
  const pageSource = await readFile(new URL('../app/learning-tracks/page.js', import.meta.url), 'utf8');
  const env = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(route, /OGE_LEARNING_TRACKS_PREVIEW/);
  assert.match(route, /session\.user\.id/);
  assert.match(route, /ownerId: session\.user\.id/);
  assert.match(route, /scope: 'learning-track-discover'/);
  assert.match(route, /OGE_YOUTUBE_DATA_API_KEY/);
  assert.doesNotMatch(route + pageSource, /collection\(['"]notes['"]\)/);
  assert.doesNotMatch(pageSource, /OGE_YOUTUBE_DATA_API_KEY/);
  assert.match(env, /OGE_YOUTUBE_DATA_API_KEY=/);
  assert.match(pageSource, /Discover lessons/);
});
